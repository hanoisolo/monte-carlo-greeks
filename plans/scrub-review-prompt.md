# Revised plan for review — European copy + analytic-on-scrub

I am adopting your blueprint with four modifications. Please review and issue an
explicit APPROVED or REJECTED verdict. Do not write code until approved.

## Modifications

### M1 — Segment 1's verification gate was not a real gate

Your Segment 1 gate was `node tests/test_strategies.js`. That suite tests
strategy aggregation; it never reads `index.html`, so it cannot fail when the
copy is wrong. A gate that cannot fail is not a gate.

Replacement gate (two plain commands, both must pass):

```
grep -c European index.html
npx vite build
```

`grep -c` must report at least 3 (meta description, tagline, table legend).
`npx vite build` proves the edited HTML still bundles.

I am deliberately **not** adding a test suite for a copy change. The repo's four
suites are all numeric; a fifth suite that greps HTML would be machinery out of
proportion to a three-line copy edit.

### M2 — `isValidParams` bounds were wrong

Your spec said `nPaths >= 100`. The actual slider is
`<input id="paths" type="range" min="10000" max="1000000" step="10000">`, so
100 is a bound the UI can never produce. Corrected to `nPaths >= 1` — a pure
sanity floor against `NaN`/`0`, leaving the real range to the slider.

Also confirmed from `index.html`: `rate` has `min="-0.05"`, so **`r` may be
negative**. Validation must require `r` finite, never `r > 0`. Your spec already
said "r finite"; I am flagging it so it does not drift into a positivity check.

Verified bounds: `s` 1..10000, `k` 1..10000, `t` 0.01..10, `r` -0.05..0.5,
`q` 0..0.3, `sigma` 0.01..2, `lambda` 0..5, `muJ` -1..1, `deltaJ` 0..1,
`nPaths` 10000..1000000, `seed` 0.. .

### M3 — Scrub tests get their own suite, not `test_strategies.js`

You proposed appending scrub unit tests to `tests/test_strategies.js`. Scrub
debounce logic is not strategy logic, and the repo's convention is one
domain-named suite per concern (`test_monte_carlo`, `test_strategies`,
`check_renderer`, `test_integration`).

Segment 2 therefore touches three files:

1. `src/lib/scrub.js` (create)
2. `tests/test_scrub.js` (create)
3. `package.json` (modify — add `node tests/test_scrub.js` to the `test` script)

Gate: `node tests/test_scrub.js`.

### M4 — Segment 3 keeps the analytic column during a run, and I verified why

Confirmed in the current code:

- `redrawActive()` begins `if (!state.lastResult) return;` — so the payoff chart
  cannot update during a scrub without a change. Your `state.lastBs` proposal is
  required, not optional.
- `drawPayoff(result, params)` reads only `result.legs` and `result.bs.price`,
  so passing `{ legs: params.legs, bs: state.lastBs }` is sufficient.

I am also confirming your diagnosis of the `state.running` guard:

```js
function runSimulation() {
  if (state.running) return;   // <-- drops a run requested right after Cancel
  ...
}
function cancelSimulation() {
  if (!state.running || !state.worker) return;
  state.worker.postMessage({ type: 'CANCEL_SIM', jobId: state.jobId });
  // state.running stays true until SIM_CANCELLED arrives
}
```

So Cancel-then-Run silently drops the Run. Your `abortInFlightForScrub()`
(bump `jobId`, `setRunning(false)`, post `CANCEL_SIM`) fixes it. Adopted as-is.

## Locked segment schedule

| # | Files (≤3) | Goal | Gate |
|---|---|---|---|
| 1 | `index.html` | State "European" in meta description, tagline, table legend | `grep -c European index.html` (>=3) and `npx vite build` |
| 2 | `src/lib/scrub.js`, `tests/test_scrub.js`, `package.json` | Pure `GREEK_ROWS`, `fmt`, `diffClass`, `buildGreeksRows`, `isValidParams`, `createScrubController` with injected timers | `node tests/test_scrub.js` |
| 3 | `src/main.js` | Wire scrub -> analytic, debounce -> MC, `abortInFlightForScrub`, keep analytic column during runs | `node tests/test_integration.js` |
| 4 | `tests/test_integration.js` | End-to-end: analytic parity with worker BS path, debounce coalescing, cancel kills pending | `node tests/test_integration.js` |

Full-suite gate after Segment 4: `npm test` (63 existing checks + new) and
`npx vite build`.

## Constraints I am holding you to

- Tests strictly additive. No existing assertion weakened, deleted, or
  broadened. The 63 existing JS checks and 23 cargo tests must stay green.
- No Rust/WASM changes. `bs_greeks` and `merton_greeks` are already exported.
- Run and Cancel buttons keep working.
- No worker-job storm while dragging a slider.

## Questions

1. Is `debounceMs = 250` right, or should the MC debounce be longer given a
   100k-path run takes ~1-2s? Argue from the actual cost, not convention.
2. In Segment 3, `updateAnalyticView()` clears `state.lastResult` and
   `state.convergence`. Does that break the convergence chart's
   `analytic: state.lastResult ? state.lastResult.bs.price : NaN` line, or is
   `NaN` already handled by `renderConvergenceChart`?
3. Anything in the four modifications that breaks a segment's file budget or
   ordering?
