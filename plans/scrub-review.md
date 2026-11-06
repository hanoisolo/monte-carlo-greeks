### Answers to Your Questions

#### 1. Is `debounceMs = 250` right given a 100k-path run takes ~1–2s?
**Yes — keep `debounceMs = 250`.** Arguing from the actual cost model in this codebase:
- **Main-thread cost is ~2 µs, and MC runs off-thread in chunks:** Analytic pricing (`bs_greeks` / `merton_greeks`) runs on the main thread in microseconds, while Monte Carlo runs in `sim.worker.js`, which slices `nPaths` into chunks and yields to the worker event loop between chunks so `CANCEL_SIM` can preempt an in-flight run at the next chunk boundary.
- **The debounce threshold measures input cadence, not job duration:** While dragging a slider or spinning a number input, DOM `input` events fire every 8–16 ms (60–120 Hz) or ~50–150 ms on key-repeat. A 250 ms window prevents any worker job from spawning during active scrubbing.
- **Preemption handles false pauses cheaply:** If a user pauses for 300 ms (starting a worker job) and then resumes scrubbing, `scrubController.scrub()` immediately runs `abortInFlightForScrub()`, which posts `CANCEL_SIM` and bumps `state.jobId`. The worker aborts at the end of its current chunk (tens of milliseconds) with zero main-thread jank.
- **Longer debounce (e.g., 750–1000 ms) hurts perceived responsiveness:** Because `<input type="number">` edits rely on the debounce timer to start MC after typing stops, a 1 s debounce would introduce a full second of dead air before the `SIMULATING` badge and progress bar even start. (Slider release on `#paths` and dropdown changes on `#strategy`/`#model` use `flush()`, so they bypass the timer with 0 ms delay.)

#### 2. Does clearing `state.lastResult` and `state.convergence` in `updateAnalyticView()` break `renderConvergenceChart`?
**No — `NaN` and empty arrays are already guarded in `src/lib/canvas_renderer.js`.**
In `src/lib/canvas_renderer.js` (lines 275–279):
```js
if (!estimates || estimates.length < 2 || !Number.isFinite(analytic)) {
  label(ctx, 'no convergence data', box.left + 8, box.top + 18);
  drawFrame(ctx, box);
  return;
}
```
- Both `estimates.length < 2` (when `state.convergence = []`) and `!Number.isFinite(analytic)` (when `analytic` is `NaN`) hit the early return and render the `'no convergence data'` placeholder cleanly without computing `min`/`max` or drawing `NaN` coordinates.
- *Optional enhancement in `drawConvergence()`:* Passing `analytic: state.lastResult ? state.lastResult.bs.price : (state.lastBs ? state.lastBs.price : NaN)` is even better: when `state.convergence` is empty (`estimates.length < 2`), it still renders `'no convergence data'`, and once 2+ `SIM_PROGRESS` chunks arrive during an active run, the convergence chart will render live against the analytic line while simulating instead of waiting for `SIM_COMPLETE`. Either way, nothing breaks.

#### 3. Do any of the four modifications break a segment's file budget or ordering?
**No.**
- **M1 (Segment 1):** Touches 1 file (`index.html`). Both `grep -c European index.html` and `npx vite build` are plain CLI commands and verify the actual HTML change and bundle validity.
- **M2 (Segment 2):** `nPaths >= 1` and `Number.isFinite(params.r)` (allowing negative rates down to `-0.05`) match the `index.html` input constraints and Rust domain checks.
- **M3 (Segment 2):** Creating `src/lib/scrub.js`, `tests/test_scrub.js`, and updating `package.json` touches 3 files (within the ≤3 file limit), keeps `tests/test_strategies.js` completely untouched, and ensures `npm test` automatically runs `test_scrub.js` at the final gate.
- **M4 (Segment 3 & 4):** Touches 1 file each (`src/main.js` in Segment 3, `tests/test_integration.js` in Segment 4) in dependency order after Segment 2.

---

### Verdict

APPROVED