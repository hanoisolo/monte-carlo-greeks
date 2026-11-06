# Stage 6 — Final architectural audit

All four segments are implemented and every gate passed. Audit the result
against the approved blueprint and issue a verdict.

## What was built

### Segment 1 — `index.html` (copy)

Three edits, all stating European exercise explicitly:

- `<meta name="description">`: "Monte Carlo **European** option pricing and
  Greeks computed in Rust/WebAssembly, benchmarked against closed-form
  Black-Scholes."
- `.tagline`: "**European** option pricing in Rust → WebAssembly · antithetic
  variates · common-random-number finite differences"
- `.legend`: "**European**-style exercise: cash-settled at maturity, no early
  exercise. Vega is per 1.00 of volatility, theta per 1.00 year of calendar
  decay, rho per 1.00 of the risk-free rate."

Gate: `grep -c European index.html` → 3. `npx vite build` → clean.

### Segment 2 — `src/lib/scrub.js` (new), `tests/test_scrub.js` (new), `package.json`

`src/lib/scrub.js` exports:

- `GREEK_ROWS` — the six row descriptors.
- `fmt(value, digits = 4)` — `toFixed` or `'—'`.
- `diffClass(absDiff, scale)` — `diff-good` < 1%, `diff-warn` < 5%, else
  `diff-bad`.
- `buildGreeksRows(mc, bs)` — six view-models
  `{ key, label, mcText, bsText, absDiffText, relDiffText, diffClassName }`.
  When `mc` is null or a value is non-finite, the MC and both diff columns are
  `'—'` and `diffClassName` is `''`; `bsText` stays live.
- `isValidParams(params)` — requires finite `s>0, k>0, t>0, r, q>=0, sigma>0,
  nPaths>=1, seed>=0`, non-empty `legs`, and for `model === 'merton'` also
  `lambda>=0, muJ` finite, `deltaJ>=0`. **`r` may be negative** (input spans
  -0.05..0.5).
- `createScrubController({ onAnalytic, onRunMc, onCancelMc, debounceMs = 250,
  setTimer, clearTimer })` → `{ scrub, flush, cancelPending, isPending }`.
  `scrub()` clears the timer, calls `onCancelMc`, calls `onAnalytic`, then
  schedules `onRunMc`. `flush()` does the same but calls `onRunMc` immediately.
  `cancelPending()` clears without firing.

`package.json` test script now runs `test_scrub.js` between `test_strategies.js`
and `check_renderer.js`.

Gate: `node tests/test_scrub.js` → 17 checks.

### Segment 3 — `src/main.js`

- Imports `aggregateStrategy` from `strategies.js`; imports
  `buildGreeksRows, createScrubController, fmt, isValidParams` from `scrub.js`.
- Deleted the local `GREEK_ROWS`, `fmt`, `diffClass` (now single-sourced).
- `state` gained `lastBs: null` and `wasmReady: false`.
- `renderGreeksTable(mc, bs)` now iterates `buildGreeksRows(mc, bs)`.
- New `computeAnalytic(params)` → `aggregateStrategy({ bs_greeks,
  merton_greeks }, params, params.legs)`.
- New `updateAnalyticView()` — guards on `wasmReady` and `isValidParams`,
  stores `state.lastBs`, clears `lastResult`/`convergence`, resets the
  std-error and elapsed readouts to `'—'`, renders `(null, bs)`, redraws.
- `redrawActive()` no longer bails on `!state.lastResult`; when there is no MC
  but `state.lastBs` exists and the payoff tab is active, it draws the payoff
  from `{ legs, bs: state.lastBs }`.
- New `abortInFlightForScrub()` — posts `CANCEL_SIM`, bumps `state.jobId`,
  calls `setRunning(false)`.
- `runSimulation()` — calls `scrubController.cancelPending()`, aborts any
  in-flight job, validates params, keeps the analytic column visible during the
  run instead of blanking the table.
- `cancelSimulation()` — calls `scrubController.cancelPending()` first.
- `scrubController` instance: `debounceMs: 250`, `onCancelMc:
  abortInFlightForScrub`, `onAnalytic: updateAnalyticView`, `onRunMc:
  runSimulation`.
- `wireEvents()` — `input` on the ten numeric inputs → `scrub()`; `#paths`
  `input` → `syncPathsReadout()` + `scrub()`, `#paths` `change` → `flush()`;
  `#strategy` and `#model` `change` → sync + `flush()`.
- `boot()` — sets `state.wasmReady = true` and calls `updateAnalyticView()`.

Gate: `node tests/test_integration.js` → 17 existing checks still pass.

### Segment 4 — `tests/test_integration.js`

Six new checks (18–23):

18. Scrub analytic path matches the worker's analytic column, all six Greeks,
    tolerance `1e-12 * max(1, |expected|)`.
19. Scrubbing spot {95,100,105} × sigma {0.15,0.25} keeps `bsText` finite and
    blanks MC/diff columns with no diff colour.
20. Scrub path dispatches to Merton; price and vega diverge from Black-Scholes.
21. `isValidParams` accepts a good set and rejects `s: NaN`, `sigma: 0`,
    `legs: []`.
22. A five-step scrub burst → 5 analytic calls, 5 cancel calls, 0 runs, then
    exactly 1 run when the timer fires.
23. `cancelPending()` after a scrub → 0 runs.

## Final gate results

```
test_monte_carlo.js: 19 checks passed
test_strategies.js: 17 checks passed
test_scrub.js: 17 checks passed
check_renderer.js: 10 checks passed
test_integration.js: 23 checks passed
```

86 JS checks across 5 suites (was 63 across 4). `cargo test` → 23 passed.
`npx vite build` → clean, bundle 20.84 kB → 23.48 kB.

## Assertion Integrity disclosure

**No existing assertion was weakened, deleted, skipped, or broadened.** All 63
pre-existing JS checks and all 23 cargo tests pass unmodified.

One test-fixture correction, disclosed for your audit:

- **File:** `tests/test_integration.js`
- **What:** the new `scrubParams()` helper initially omitted `k`. Test 21
  failed because `isValidParams` requires `k > 0`.
- **Change:** added `k: 100` to the helper's defaults.
- **Why:** `readParams()` in `main.js` always supplies `k` from the strike
  input, so the fixture was unrepresentative of real params, not the validator
  being wrong. `k` is genuinely used (`drawPaths` reads `params.k`).
- **Not affected:** no pre-existing test or assertion; this is a new fixture
  used only by the six new checks.

## Questions for the audit

1. Is the stale-MC masking correct? `updateAnalyticView()` sets
   `state.lastResult = null` on every scrub step, so the diff columns blank
   rather than compare a new analytic value against an old Monte Carlo. Does
   that lose anything a user needs?
2. `abortInFlightForScrub()` bumps `state.jobId` and calls `setRunning(false)`
   synchronously. Is there a race where the worker's `SIM_CANCELLED` for the
   old job could still be processed? (The guard in `onWorkerMessage` compares
   `message.jobId !== state.jobId`.)
3. `runSimulation()` now calls `scrubController.cancelPending()` and then
   possibly `abortInFlightForScrub()`. `flush()` also calls `onCancelMc` before
   `onRunMc`. Is the double-cancel path harmless?
4. Is `debounceMs = 250` defensible given a 100k-path run takes ~1–2 s?
5. Anything in the implementation that contradicts the approved blueprint?
