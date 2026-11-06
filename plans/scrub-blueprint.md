# Architectural Blueprint: European Option Copy + Analytic-on-Scrub / MC-on-Release

## 1. Architectural Decisions & Design Answers

### 1.1 Copy: Explicit "European" Wording
- **Placement:** `index.html` needs to state both above the fold (in the masthead `.tagline` and `<meta name="description">`) and in the Greeks table `.legend` that all contracts are European-style.
- **Exact wording:**
  - **Masthead `.tagline` (`index.html` line 21):**
    ```html
    <p class="tagline">
      European option pricing in Rust &rarr; WebAssembly &middot; antithetic variates &middot;
      common-random-number finite differences
    </p>
    ```
  - **Meta description (`index.html` line 8):**
    ```html
    <meta
      name="description"
      content="Monte Carlo European option pricing and Greeks computed in Rust/WebAssembly, benchmarked against closed-form Black-Scholes."
    />
    ```
  - **Greeks table `.legend` (`index.html` line 139):**
    ```html
    <p class="legend">
      European-style exercise (cash-settled at maturity; no early exercise). Vega is per 1.00 of
      volatility, theta per 1.00 year of calendar decay, rho per 1.00 of the risk-free rate.
    </p>
    ```
- **Why here:** The masthead tagline immediately frames the entire tool before a reader touches a control, while the table legend clarifies why closed-form Black-Scholes/Merton is the exact benchmark (American early-exercise premia do not apply).

---

### 1.2 Testability: Pure Module Extraction (`src/lib/scrub.js`)
- **Problem:** `src/main.js` imports `./styles.css`, queries `document.getElementById` at module top level, and invokes `boot()` immediately. It cannot be imported into the DOM-free Node test suite (`tests/*.js`).
- **Solution:** Extract all DOM-free scrub state coordination, parameter validation, and Greek table row formatting into a new pure ES module `src/lib/scrub.js`:
  1. `GREEK_ROWS`, `fmt(value, digits)`, `diffClass(absDiff, scale)` — moved from `src/main.js`.
  2. `buildGreeksRows(mc, bs)` — pure function returning an array of 6 row view-models `{ key, label, mcText, bsText, absDiffText, relDiffText, diffClassName }`. Supports both full comparison (`mc` and `bs` present) and analytic-only preview (`mc === null`).
  3. `isValidParams(params)` — pure guard checking that all numeric inputs (`s`, `k`, `t`, `r`, `q`, `sigma`, `nPaths`, `seed`, and `lambda`, `muJ`, `deltaJ` when `model === 'merton'`) are finite and within valid mathematical domains (`s > 0`, `k > 0`, `t > 0`, `sigma > 0`, `q >= 0`, `nPaths >= 100`, `seed >= 0`, `lambda >= 0`, `deltaJ >= 0`, non-empty `legs`) so mid-keystroke states in `<input type="number">` never pass `NaN` or `0` into WASM.
  4. `createScrubController({ onAnalytic, onRunMc, onCancelMc, debounceMs = 250, setTimer = setTimeout, clearTimer = clearTimeout })` — pure controller encapsulating immediate analytic execution + cancellation on scrub and debounced/flushed MC execution. Injecting `setTimer`/`clearTimer` allows deterministic headless unit and integration testing in Node without DOM dependencies.

---

### 1.3 Stale-State Semantics
- **Problem:** When the user scrubs a parameter, the Analytic column (`bs`) updates in microseconds, whereas Monte Carlo (`mc`) belongs to the previous parameter set until the new simulation completes.
  - Comparing an old `mc` against a new `bs` would produce bogus `Abs. diff` and `Rel. diff` values (e.g., `diff-bad` red highlights caused by parameter change rather than Monte Carlo sampling error).
  - Conversely, `runSimulation()` in `src/main.js` currently wipes `#greeks-body` to `<td colspan="5" class="empty">Simulating…</td>`, which would erase the live Analytic column the moment the debounce timer fires.
- **Design:**
  1. **When scrubbing invalidates MC (or on initial WASM boot before MC runs, or while MC is actively simulating):**
     - `renderGreeksTable(null, bs)` is called.
     - `buildGreeksRows(null, bs)` populates all 6 rows with:
       - `Greek`: row label (`Price`, `Delta`, `Gamma`, `Vega`, `Theta`, `Rho`)
       - `Monte Carlo`: `'—'`
       - `Analytic`: `fmt(bs[key])` (live, exact closed-form value)
       - `Abs. diff`: `'—'` (with `diffClassName: ''` — no false red/green badge)
       - `Rel. diff`: `'—'` (with `diffClassName: ''`)
     - `#std-error` and `#elapsed` are reset to `'—'`.
     - `state.lastResult` is set to `null` and `state.convergence` is cleared to `[]`.
  2. **During active MC simulation (`runSimulation()`):**
     - Keep the Analytic column populated via `renderGreeksTable(null, bs)` instead of replacing the table body with a `colSpan = 5` placeholder. Progress is already clearly communicated by `#progress-wrap`, `#engine-badge` (`SIMULATING`), and `#cancel` button state.
  3. **Live Payoff & P&L chart on scrub:**
     - `drawPayoff` depends only on `params.legs` and `bs.price` (not on MC paths). Storing `state.lastBs = bs` allows `redrawActive()` to live-update the Payoff & P&L chart and breakeven footer at 60fps while scrubbing whenever `state.activeView === 'payoff'`.

---

### 1.4 Debounce vs. Release (DOM Events & Timing)
- **Event mapping:**
  1. **Numeric inputs (`#spot`, `#strike`, `#time`, `#rate`, `#dividend`, `#volatility`, `#lambda`, `#mu-j`, `#delta-j`, `#seed`):**
     - Listen to `input`. On every keystroke or spinner step:
       - If `!isValidParams(readParams())`, ignore (user is mid-typing, e.g., empty box).
       - Call `scrubController.scrub()`: immediately cancels any in-flight worker job, synchronously updates the Analytic column (and Payoff chart if active), and resets a **250 ms** debounce timer for `runSimulation()`.
     - Why `input` + 250 ms debounce instead of `change`: On `<input type="number">`, `change` often does not fire until the input loses focus (`blur`). A 250 ms debounce on `input` coalesces rapid spinner clicks or multi-digit typing into a single MC run roughly a quarter-second after the user pauses, without requiring them to click outside the field.
  2. **Range slider (`#paths`):**
     - On `input`: call `syncPathsReadout()` and `scrubController.scrub()`. While the user continuously drags the slider, the 250 ms debounce timer keeps resetting so zero worker jobs are spawned mid-drag; if the user pauses dragging for >250 ms, MC runs.
     - On `change` (pointer release): call `scrubController.flush()`, which clears the debounce timer and fires `runSimulation()` immediately on release.
  3. **Select dropdowns (`#strategy`, `#model`):**
     - On `change`: sync descriptions/controls (`syncStrategyDescription()` / `syncModelControls()`), then call `scrubController.flush()` so both the Analytic column and the new MC simulation start immediately upon selection.

---

### 1.5 Cancellation & `jobId` Protocol
- **Current flaw in `src/main.js`:**
  - `runSimulation()` starts with `if (state.running) return;`.
  - `cancelSimulation()` posts `{ type: 'CANCEL_SIM', jobId: state.jobId }`, but `state.running` stays `true` until the worker finishes its current chunk and replies with `SIM_CANCELLED`.
  - If a scrub attempts to cancel an in-flight job and start a new one before `SIM_CANCELLED` arrives, `if (state.running) return;` silently drops the new run. And when `SIM_CANCELLED` arrives later, it sets `els.footerStatus.textContent = 'cancelled'`.
- **Fix (`abortInFlightForScrub()`):**
  - When a scrub occurs while `state.running === true`:
    1. Post `{ type: 'CANCEL_SIM', jobId: state.jobId }` to `state.worker` so the worker aborts at the next chunk boundary.
    2. Immediately increment `state.jobId += 1`. Because `onWorkerMessage` checks `if (message.jobId !== state.jobId) return;`, any late `SIM_PROGRESS`, `SIM_COMPLETE`, or `SIM_CANCELLED` from the aborted job is ignored.
    3. Call `setRunning(false)` immediately so the UI exits the running state and `runSimulation()` will not be blocked when the debounce timer fires.
  - When the user clicks the **Cancel** button (`cancelSimulation()`):
    1. Call `scrubController.cancelPending()` so any ticking debounce timer is cleared and cannot surprise-start a simulation after Cancel was clicked.
    2. Post `CANCEL_SIM` for the current `state.jobId` as before.
  - When the user clicks the **Run** button (`runSimulation()`):
    1. Call `scrubController.cancelPending()` so a pending debounce timer does not double-fire.
    2. If `state.running`, call `abortInFlightForScrub()` before starting the new job.

---

## 2. Segmented Implementation Plan

### Ordering Constraints
- **Segment 1** (`index.html`) is independent and lands first.
- **Segment 2** (`src/lib/scrub.js` + unit tests in `tests/test_strategies.js`) must land before **Segment 3** (`src/main.js`) and **Segment 4** (`tests/test_integration.js`), because both import from `src/lib/scrub.js`.
- **Segment 3** wires `src/main.js` to `src/lib/scrub.js` and `aggregateStrategy`.
- **Segment 4** adds headless end-to-end integration tests in `tests/test_integration.js` combining WASM Greeks, `aggregateStrategy`, `buildGreeksRows`, and `createScrubController`.

---

### Segment 1: Explicit European Option Copy in `index.html`

- **Files to Modify (1):**
  1. `index.html`
- **Concrete Goal:**
  Update the page copy in `index.html` so it states unambiguously that the application prices European-style options:
  - In `<meta name="description">`: `"Monte Carlo European option pricing and Greeks computed in Rust/WebAssembly, benchmarked against closed-form Black-Scholes."`
  - In `.masthead-text .tagline`: `"European option pricing in Rust &rarr; WebAssembly &middot; antithetic variates &middot; common-random-number finite differences"`
  - In `.results .legend`: `"European-style exercise (cash-settled at maturity; no early exercise). Vega is per 1.00 of volatility, theta per 1.00 year of calendar decay, rho per 1.00 of the risk-free rate."`
- **Verification Gate:**
  ```
  node tests/test_strategies.js
  ```

---

### Segment 2: Extract Pure Scrub & Greeks Table Module (`src/lib/scrub.js`) + Unit Tests

- **Files to Create / Modify (2):**
  1. `src/lib/scrub.js` (create)
  2. `tests/test_strategies.js` (modify — strictly additive assertions at the end of the file)
- **Exact Functions to Create in `src/lib/scrub.js`:**
  - `GREEK_ROWS` — constant array of the 6 Greek row metadata objects (`price`, `delta`, `gamma`, `vega`, `theta`, `rho`).
  - `fmt(value, digits = 4)` — formats finite numbers with `toFixed(digits)` or returns `'—'`.
  - `diffClass(absDiff, scale)` — returns `'diff-good'` (`< 1%`), `'diff-warn'` (`< 5%`), or `'diff-bad'` (`>= 5%`).
  - `buildGreeksRows(mc, bs)` — returns 6 row objects `{ key, label, mcText, bsText, absDiffText, relDiffText, diffClassName }`. When `mc` is `null` or `undefined` (or `mc[row.key]` is not finite), `mcText`, `absDiffText`, and `relDiffText` are `'—'` and `diffClassName` is `''`, while `bsText` is `fmt(bs[row.key])`.
  - `isValidParams(params)` — validates that `params` has finite `s > 0`, `k > 0`, `t > 0`, `sigma > 0`, `q >= 0`, `r` finite, `nPaths >= 100`, `seed >= 0`, valid Merton jump parameters (`lambda >= 0`, `deltaJ >= 0`, `muJ` finite) when `params.model === 'merton'`, and a non-empty `legs` array.
  - `createScrubController({ onAnalytic, onRunMc, onCancelMc, debounceMs = 250, setTimer = setTimeout, clearTimer = clearTimeout })` — returns `{ scrub, flush, cancelPending, isPending }`.
    - `scrub()`: clears any active timer, invokes `onCancelMc?.()`, invokes `onAnalytic?.()`, and schedules `onRunMc?.()` via `setTimer` after `debounceMs`.
    - `flush()`: clears any active timer, invokes `onCancelMc?.()`, invokes `onAnalytic?.()`, and immediately invokes `onRunMc?.()`.
    - `cancelPending()`: clears any active timer and marks pending false without invoking `onRunMc`.
    - `isPending()`: returns `true` when a timer is scheduled and has not yet fired or been cancelled.
- **Concrete Goal:**
  Establish the pure, testable logic for stale-vs-fresh Greek table formatting, input parameter validation, and scrub/release debounce control, and verify all behaviors with new unit tests in `tests/test_strategies.js`.
- **Verification Gate:**
  ```
  node tests/test_strategies.js
  ```

---

### Segment 3: Wire Analytic-on-Scrub & Debounced MC-on-Release in `src/main.js`

- **Files to Modify (1):**
  1. `src/main.js`
- **Exact Functions to Create / Modify in `src/main.js`:**
  - **Imports:**
    - Add `aggregateStrategy` to the import from `./lib/strategies.js`.
    - Import `{ buildGreeksRows, createScrubController, diffClass, fmt, isValidParams }` from `./lib/scrub.js` (removing the duplicate local `GREEK_ROWS`, `fmt`, `diffClass` definitions).
  - **`state`:**
    - Add `wasmReady: false` and `lastBs: null`.
  - **`renderGreeksTable(mc, bs)`:**
    - Refactor to iterate over `buildGreeksRows(mc, bs)` and build the `<tr>`/`<td>` elements. Safely supports `renderGreeksTable(null, bs)` when MC is absent, stale, or currently simulating.
  - **`computeAnalytic(params)` (new):**
    - Calls `aggregateStrategy({ bs_greeks, merton_greeks }, params, params.legs)`.
  - **`updateAnalyticView()` (new):**
    - Guards on `state.wasmReady`. Reads `params = readParams()` and guards on `isValidParams(params)`.
    - Computes `const bs = computeAnalytic(params)` and stores `state.lastBs = bs`.
    - Clears stale MC state: `state.lastResult = null`, `state.convergence = []`, `els.stdError.textContent = '—'`, `els.elapsed.textContent = '—'`.
    - Calls `renderGreeksTable(null, bs)`.
    - Calls `redrawActive()` (which redraws the Payoff chart live when `state.activeView === 'payoff'`).
  - **`redrawActive()`:**
    - When `state.lastResult` is present, behaves as before.
    - When `!state.lastResult && state.lastBs && state.activeView === 'payoff'`, calls `drawPayoff({ legs: params.legs, bs: state.lastBs }, params)` so the Payoff & P&L chart and breakevens update live during parameter scrubbing even before MC completes.
  - **`abortInFlightForScrub()` (new):**
    - If `state.running`: posts `{ type: 'CANCEL_SIM', jobId: state.jobId }` to `state.worker` (if initialized), increments `state.jobId += 1` so late messages from the aborted job are ignored, and calls `setRunning(false)`.
  - **`scrubController` (new instance of `createScrubController`):**
    - Configured with `debounceMs: 250`, `onCancelMc: abortInFlightForScrub`, `onAnalytic: updateAnalyticView`, `onRunMc: runSimulation`.
  - **`runSimulation()`:**
    - Calls `scrubController.cancelPending()`.
    - If `state.running`, calls `abortInFlightForScrub()`.
    - Reads `params = readParams()` and guards on `isValidParams(params)`.
    - Increments `state.jobId += 1`, resets `state.convergence = []`, `state.lastResult = null`.
    - If `state.wasmReady`, computes `const bs = computeAnalytic(params)`, sets `state.lastBs = bs`, and calls `renderGreeksTable(null, bs)` so the Analytic column stays visible while the worker runs (falling back to the `'Simulating…'` row only if `!state.wasmReady`).
    - Sets progress bar to `0%`, calls `setRunning(true)`, and posts `RUN_SIM` to the worker.
  - **`cancelSimulation()`:**
    - Calls `scrubController.cancelPending()` before posting `CANCEL_SIM` for `state.jobId`.
  - **`wireEvents()`:**
    - Wire `input` on `[els.spot, els.strike, els.time, els.rate, els.dividend, els.volatility, els.lambda, els.muJ, els.deltaJ, els.seed]` to call `if (isValidParams(readParams())) scrubController.scrub()`.
    - Wire `els.paths`: on `input`, call `syncPathsReadout()` and `if (isValidParams(readParams())) scrubController.scrub()`; on `change` (slider release), call `if (isValidParams(readParams())) scrubController.flush()`.
    - Wire `els.strategy` `change`: `syncStrategyDescription()` then `if (isValidParams(readParams())) scrubController.flush()`.
    - Wire `els.model` `change`: `syncModelControls()` then `if (isValidParams(readParams())) scrubController.flush()`.
  - **`boot()`:**
    - After `await init()`, set `state.wasmReady = true` and call `updateAnalyticView()` so the Analytic column is populated immediately on initial load.
- **Concrete Goal:**
  Connect the DOM inputs and worker lifecycle in `src/main.js` so scrubbing any parameter updates the Analytic column (and Payoff chart) immediately, cancels any stale in-flight MC worker job without `jobId` races, and triggers a single debounced MC simulation after the user stops scrubbing or releases a slider.
- **Verification Gate:**
  ```
  node tests/test_integration.js
  ```

---

### Segment 4: End-to-End Headless Integration Tests & Full Suite Gate

- **Files to Modify (1):**
  1. `tests/test_integration.js` (strictly additive tests appended to existing 17 checks)
- **Exact Tests to Add in `tests/test_integration.js`:**
  - Import `buildGreeksRows, createScrubController, isValidParams` from `../src/lib/scrub.js`.
  - **Test 1 (Analytic-on-scrub parity with worker BS path):** Across a sequence of scrubbed parameters (Spot `95 -> 100 -> 105`, Volatility `0.15 -> 0.25`, and switching `model` from `'bs'` to `'merton'` on an Iron Condor preset), verify that synchronous `aggregateStrategy({ bs_greeks, merton_greeks }, params, legs)` passed into `buildGreeksRows(null, bs)` produces exact finite `bsText` values matching the analytic engine while `mcText`, `absDiffText`, and `relDiffText` are all `'—'` and `diffClassName` is `''`.
  - **Test 2 (Debounce coalescing & cancellation):** Simulate a 5-step scrub burst through `createScrubController` with a fake timer harness: verify `onAnalytic` and `onCancelMc` fire 5 times synchronously (updating analytic Greeks on every scrub step), `onRunMc` fires 0 times during the burst, and `onRunMc` fires exactly once when the debounce timer fires (at which point `buildGreeksRows(mc, bs)` populates all 5 columns and diff classes).
  - **Test 3 (Cancel button kills pending debounce):** Verify that calling `cancelPending()` after a scrub prevents `onRunMc` from firing when the timer elapses.
- **Concrete Goal:**
  Prove headlessly against the real WASM module that the analytic-on-scrub pipeline, stale-MC masking, and debounce/flush/cancel lifecycle work end-to-end without regressions in any existing test suite.
- **Verification Gate:**
  ```
  node tests/test_integration.js
  ```

---

## 3. Assumptions, Risks & Deliverable Verification

### Assumptions Made
1. `src/wasm/engine.js` and `src/wasm/engine_bg.wasm` are already built and committed; no Rust/WASM changes are needed because `bs_greeks` and `merton_greeks` are already exported and imported by `src/main.js`.
2. In `src/main.js`, keeping the Analytic column populated on initial WASM boot (`updateAnalyticView()`) and during active MC runs (`renderGreeksTable(null, bs)`) is preferred over blanking the entire table with `"Simulating…"`, because blanking the table on MC start would erase the live analytic numbers 250 ms after every scrub.

### Risks & Mitigations
1. **Risk: Mid-keystroke `NaN` or `0` in `<input type="number">` inputs.**
   - *Mitigation:* `isValidParams(params)` validates positivity (`s > 0`, `k > 0`, `t > 0`, `sigma > 0`, `nPaths >= 100`) and finiteness before calling WASM or scheduling a worker job.
2. **Risk: Late `SIM_CANCELLED` message from an aborted worker job resetting UI state during a new scrub.**
   - *Mitigation:* `abortInFlightForScrub()` increments `state.jobId` immediately upon posting `CANCEL_SIM`. Because `onWorkerMessage` filters on `message.jobId === state.jobId`, the delayed `SIM_CANCELLED` from the old job is ignored.
3. **Risk: Clicking Cancel while a scrub debounce timer is pending.**
   - *Mitigation:* `cancelSimulation()` calls `scrubController.cancelPending()` so a pending timer cannot launch a new worker job after the user clicked Cancel.

### Final Verification Steps Across Deliverables
1. `node tests/test_monte_carlo.js` — all 19 checks pass.
2. `node tests/test_strategies.js` — all original 17 checks + new `scrub.js` unit checks pass.
3. `node tests/check_renderer.js` — all 10 checks pass.
4. `node tests/test_integration.js` — all original 17 checks + new analytic-on-scrub integration checks pass.
5. `npx vite build` — production bundle compiles cleanly with zero errors.