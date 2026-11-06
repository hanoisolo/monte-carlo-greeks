# Blueprint request: European copy + analytic-on-scrub

Design the implementation plan for a two-part change to a Monte Carlo options
pricing web app (Rust/WASM engine + vanilla ES6 DOM UI, no framework).

## Task

Two items, both approved by the user:

1. **Copy fix (trivial).** The site never states in plain words that it prices
   *European* options. A critic read it as being about US equity options (which
   are American-style) and called the European restriction a flaw. Add explicit
   "European" wording to the page copy. One line.

2. **Analytic-on-scrub, MC-on-release (the real work).** Today the UI only
   recomputes on an explicit Run button click. The analytic Black-Scholes /
   Merton Greeks are closed-form and take microseconds; the Monte Carlo takes
   100k paths across 6 Greek bumps. Goal: scrubbing any parameter updates the
   analytic column live, while the Monte Carlo is debounced and runs after the
   user stops moving.

## Current architecture (verified by reading the code)

### `src/main.js` (397 lines) — DOM controller

- Imports `init, { bs_greeks, merton_greeks }` from `./wasm/engine.js`.
- Imports from `./lib/strategies.js`: `STRATEGY_PRESETS, buildLegs,
  computePayoffCurve, findBreakevens, getPreset, maxProfitLoss`.
  **It does NOT currently import `aggregateStrategy`.**
- `els` object maps ~35 element ids.
- `state = { jobId, running, worker, lastResult, convergence, activeView }`.
- `readParams()` reads all inputs into a params object including
  `model`, `lambda`, `muJ`, `deltaJ`, `nPaths`, `seed`, `legs`.
- `renderGreeksTable(mc, bs)` builds the 6-row table (Price, Delta, Gamma,
  Vega, Theta, Rho) with columns: label, MC, analytic, abs diff, rel diff.
  It assumes both `mc` and `bs` are present.
- `runSimulation()` guards on `state.running`, increments `state.jobId`,
  clears the table to a "Simulating…" placeholder, calls `setRunning(true)`,
  and posts `RUN_SIM` to the worker.
- `onWorkerMessage(event)` ignores messages whose `jobId !== state.jobId`.
  Handles `SIM_PROGRESS` (progress bar + convergence series), `SIM_COMPLETE`
  (stores `state.lastResult`, renders table from `message.mc` and
  `message.bs`), `SIM_CANCELLED`, `SIM_ERROR`.
- `cancelSimulation()` posts `CANCEL_SIM`.
- `wireEvents()` currently wires:
  - `els.strategy` change -> `syncStrategyDescription`
  - `els.model` change -> `syncModelControls`
  - `els.paths` input -> `syncPathsReadout` (readout only, no simulation)
  - `els.run` click -> `runSimulation`
  - `els.cancel` click -> `cancelSimulation`
  - tab clicks, window resize (debounced 120ms via `setTimeout`)
- `boot()` awaits `init()`, then calls `benchmarkEngine(...)` with
  `bs_greeks` / `merton_greeks` wrappers to measure µs/call.

### `src/lib/strategies.js` — already has what the scrub path needs

```js
export function aggregateStrategy(engine, params, legs) {
  const { s, t, r, q, sigma } = params;
  const useMerton = params.model === 'merton' && typeof engine.merton_greeks === 'function';
  // ... sums weight * greeks across legs, returns { price, delta, gamma, vega, theta, rho }
}
```

It takes an `engine` object, so `main.js` can call it synchronously with
`{ bs_greeks, merton_greeks }`. This is the exact analytic path the worker
uses, so scrub results will match the worker's `bs` column.

### `src/workers/sim.worker.js` — computes both columns

Builds `analyticLeg` / `mcLeg` closures dispatching on `params.model`, then
returns `SIM_COMPLETE { mc, bs, samplePaths, elapsedMs, totalPaths, ... }`.
The worker is chunked (8 chunks) and cancellable between chunks.

### `index.html` (175 lines)

Inputs: `#spot #strike #time #rate #dividend #volatility #model #lambda
#mu-j #delta-j #paths #seed`. Buttons: `#run #cancel`. Table body:
`#greeks-body`. Also `#model-description`, `#jump-params` (hidden unless
Merton), `#paths-readout`, `#benchmark`, `#elapsed`, `#std-error`.

### Tests (headless, `node:assert/strict`, DOM-free)

`tests/test_monte_carlo.js` (19 checks), `tests/test_strategies.js` (17),
`tests/check_renderer.js` (10), `tests/test_integration.js` (17).
Total 63 checks. Plus 23 cargo tests. All must stay green.

## Constraints

- **Tests are strictly additive.** Never weaken, delete, skip, or broaden an
  existing assertion to make a gate pass.
- Gate commands must be single plain commands (no `>`, no `2>`, no `$?`, no
  variable assignments).
- `src/wasm/` is committed on purpose; no Rust changes are expected for this
  task. Do not propose engine changes.
- The existing Run and Cancel buttons must keep working.
- A new scrub must not queue stale worker jobs or fight the `jobId` protocol.
- Dragging a slider must not cause a worker-job storm.

## What I need from you

A segmented plan: 3 to 6 segments, each touching **at most 3 files**, each
stating explicitly:

1. The exact files and functions to create or modify.
2. The concrete goal of the segment.
3. An explicit Verification Gate — the exact command or assertion proving it
   works before the next segment starts.

Address these design questions directly:

- **Testability.** `main.js` is DOM-coupled and the test suites are DOM-free.
  How should the analytic-on-scrub logic be structured so it can be verified
  headlessly? Consider extracting a pure function into `src/lib/`.
- **Stale-state semantics.** What should the Greeks table show when the
  analytic column is fresh but the Monte Carlo is stale (from a previous
  parameter set) or absent? How is staleness signalled without lying about
  convergence?
- **Debounce vs release.** Which DOM events (`input` vs `change`) should drive
  the analytic update and the MC run, and what debounce interval? Justify.
- **Cancellation.** How does a scrub interact with an in-flight job and the
  existing `jobId` guard?
- **Copy.** Where exactly should "European" appear so it is unambiguous but not
  clumsy? Give the exact wording.
