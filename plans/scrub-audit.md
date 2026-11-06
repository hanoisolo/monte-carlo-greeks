# Stage 6 — Final Architectural Audit

## 1. Blueprint & Scope Verification

| Segment | Target Files | Blueprint Deliverable | Status |
| :--- | :--- | :--- | :--- |
| **Segment 1** | `index.html` | Explicitly state European exercise in `<meta name="description">`, `.tagline`, and `.legend`. | **Verified** (`grep -c European index.html` = 3, clean build) |
| **Segment 2** | `src/lib/scrub.js`, `tests/test_scrub.js`, `package.json` | Pure DOM-free module exporting `GREEK_ROWS`, `fmt`, `diffClass`, `buildGreeksRows`, `isValidParams`, and `createScrubController` with injected timers; unit test suite wired into `npm test`. | **Verified** (17/17 checks in `test_scrub.js`) |
| **Segment 3** | `src/main.js` | Wire `scrub.js` into DOM controller, maintain `state.lastBs` and `state.wasmReady`, render live analytic Greeks and payoff curve on scrub, debounce MC runs, abort in-flight worker jobs on scrub. | **Verified** (clean integration, single-sourced helpers) |
| **Segment 4** | `tests/test_integration.js` | Add headless integration checks (18–23) for main-thread vs. worker analytic parity, scrub table masking, Merton dispatch, mid-keystroke validation, burst coalescing, and pending cancellation. | **Verified** (23/23 checks in `test_integration.js`) |

No out-of-segment scope crept in, and the bundle size growth (`20.84 kB` → `23.48 kB`) is minimal and strictly attributable to `src/lib/scrub.js` and the controller wiring in `src/main.js`.

---

## 2. Assertion Integrity Audit

- **Pre-existing suites:** All 63 original JS checks (`test_monte_carlo.js`: 19, `test_strategies.js`: 17, `check_renderer.js`: 10, `test_integration.js`: 1–17) and all 23 Rust `cargo test` unit tests remain untouched and pass.
- **Disclosed fixture change:** Adding `k: 100` to the new `scrubParams()` test helper in `tests/test_integration.js` (line 299) is a legitimate fixture completion on a newly introduced helper so that it matches the object shape produced by `readParams()` in `src/main.js`. No existing test or assertion was weakened, broadened, or removed.

---

## 3. Responses to Audit Questions

### 1. Is the stale-MC masking (`state.lastResult = null` in `updateAnalyticView()`) correct?
**Yes.** Once any option or model parameter changes, the previous Monte Carlo result belongs to a different contract or market state. Retaining `state.lastResult` during a scrub would compare fresh analytic Greeks against stale Monte Carlo Greeks, turning genuine parameter drift into false `diff-warn` / `diff-bad` error badges. Clearing `lastResult` and `convergence` while keeping `state.lastBs` live preserves the exact invariant we want:
- The **Analytic** column updates at 60 fps.
- The **Payoff & P&L** canvas updates at 60 fps (since it depends only on `legs` and `lastBs.price`).
- The **MC** and **Diff** columns show `'—'` with no error coloring until the debounced simulation completes for the new parameter set.

### 2. Is `abortInFlightForScrub()` free of race conditions against late `SIM_CANCELLED` messages?
**Yes.** `abortInFlightForScrub()` posts `{ type: 'CANCEL_SIM', jobId: state.jobId }`, immediately increments `state.jobId += 1`, and calls `setRunning(false)`. When the worker finishes its current chunk and emits `SIM_CANCELLED` (or a final `SIM_PROGRESS` / `SIM_COMPLETE`) tagged with the old `jobId`, the first line of `onWorkerMessage` (`if (message.jobId !== state.jobId) return;`) drops it before it can touch `setRunning` or `els.footerStatus`.

### 3. Is the double-cancel path across `flush()` and `runSimulation()` harmless?
**Yes, it is completely idempotent.**
- When `flush()` runs:
  1. `clear()` cancels any pending timer and sets `pending = false`.
  2. `onCancelMc()` (`abortInFlightForScrub()`) checks `if (!state.running) return;`. If a job was running, it posts `CANCEL_SIM`, increments `state.jobId`, and sets `state.running = false`.
  3. `onAnalytic()` (`updateAnalyticView()`) refreshes the analytic state.
  4. `onRunMc()` (`runSimulation()`) calls `scrubController.cancelPending()` (a no-op because `timer` is already `null`) and checks `if (state.running) abortInFlightForScrub()` (skipped because `state.running` is already `false`).
- Consequently, `CANCEL_SIM` is posted at most once per active worker job.

### 4. Is `debounceMs = 250` defensible given a 100k-path run takes ~1–2 s?
**Yes.** The debounce window measures user input pause duration (the gap between consecutive slider ticks or keystrokes), not worker execution time. A 250 ms threshold is long enough to coalesce continuous slider drags or multi-digit typing into zero worker launches, and short enough that pausing on a value feels immediate. If the user resumes scrubbing while the 1–2 s worker job is in flight, `abortInFlightForScrub()` aborts the worker at the next chunk boundary (~50–100 ms).

### 5. Does anything in the implementation contradict the approved blueprint?
**No.** Every module boundary, exported symbol, state transition, and verification gate adheres strictly to the approved blueprint.

---

AUDIT PASSED