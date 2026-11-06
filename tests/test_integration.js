// Integration gate: drives the real worker code path headlessly.
//
// This imports `src/workers/sim.worker.js` directly. The module guards its
// `self.onmessage` binding behind `typeof self !== 'undefined'`, so Node can
// import it and call `runSimulationJob` / `handleMessage` without a Worker.
//
// Run with: node tests/test_integration.js

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import init, {
  bs_greeks,
  mc_greeks,
  mc_paths_sample,
  merton_greeks,
  mc_merton_greeks,
  mc_merton_paths_sample,
} from '../src/wasm/engine.js';
import {
  CHUNK_COUNT,
  CancelledError,
  handleMessage,
  runSimulationJob,
} from '../src/workers/sim.worker.js';
import {
  aggregateStrategy,
  buildLegs,
  computePayoffCurve,
  findBreakevens,
  getPreset,
} from '../src/lib/strategies.js';
import { bsPrice } from '../src/lib/bs_benchmark.js';

const wasmBytes = readFileSync(new URL('../src/wasm/engine_bg.wasm', import.meta.url));
await init({ module_or_path: wasmBytes });

const engine = { mc_greeks, mc_paths_sample, bs_greeks };

const PARAMS = {
  s: 100,
  t: 1,
  r: 0.05,
  q: 0,
  sigma: 0.2,
  nPaths: 100_000,
  seed: 1337,
  nSamplePaths: 64,
  nSteps: 50,
};

let checks = 0;
function ok(label, fn) {
  fn();
  checks += 1;
  console.log(`  ok ${checks} - ${label}`);
}

async function okAsync(label, fn) {
  await fn();
  checks += 1;
  console.log(`  ok ${checks} - ${label}`);
}

console.log('test_integration.js');

const straddleLegs = buildLegs(getPreset('straddle'), 100);

// --- Full pipeline ---------------------------------------------------------
let pipelineResult = null;

await okAsync('the full strategy -> worker -> WASM pipeline completes', async () => {
  const progress = [];
  pipelineResult = await runSimulationJob(
    engine,
    { ...PARAMS, legs: straddleLegs },
    { onProgress: (p) => progress.push(p) },
  );

  assert.ok(pipelineResult.elapsedMs >= 0, 'elapsedMs must be non-negative');
  assert.equal(progress.length, CHUNK_COUNT, `expected ${CHUNK_COUNT} progress events`);
  assert.equal(pipelineResult.totalPaths, PARAMS.nPaths);

  // Progress must be monotonic and end at 100%.
  for (let i = 1; i < progress.length; i += 1) {
    assert.ok(
      progress[i].completedPaths > progress[i - 1].completedPaths,
      'progress must advance monotonically',
    );
  }
  assert.equal(progress[progress.length - 1].completedPaths, PARAMS.nPaths);
});

ok('MC net price agrees with the analytic net price within 3 standard errors', () => {
  const { mc, bs } = pipelineResult;
  const tolerance = 3 * mc.stdErr;
  assert.ok(mc.stdErr > 0, `stdErr must be positive, got ${mc.stdErr}`);
  assert.ok(
    Math.abs(mc.price - bs.price) <= tolerance,
    `price ${mc.price} vs ${bs.price}, tolerance ${tolerance}`,
  );
});

ok('MC net Greeks agree with the analytic net Greeks', () => {
  const { mc, bs } = pipelineResult;
  // Relative bounds, not absolute ones: a two-leg portfolio's Greeks are twice
  // the size of a single leg's, so a fixed absolute bound would be arbitrary.
  // These limits are roughly twice the error measured at 100k paths, and that
  // error was confirmed to shrink with path count (price 0.49% -> 0.12% from
  // 100k to 1.6M paths), so the estimator is unbiased and this is sampling
  // noise rather than a tolerance hiding a bug. Gamma and rho converge slowest
  // (second difference, and a small magnitude respectively), hence their wider
  // bounds. Per-leg Greek precision is asserted tightly in test_monte_carlo.js.
  const bounds = {
    delta: 0.03,
    gamma: 0.06,
    vega: 0.02,
    theta: 0.015,
    rho: 0.07,
  };
  for (const [key, bound] of Object.entries(bounds)) {
    const relErr = Math.abs(mc[key] - bs[key]) / Math.abs(bs[key]);
    assert.ok(
      relErr <= bound,
      `${key}: mc ${mc[key]} vs bs ${bs[key]} (rel err ${(relErr * 100).toFixed(2)}% > ${(bound * 100).toFixed(1)}%)`,
    );
  }
});

ok('the analytic leg of the pipeline matches the strategy module', () => {
  const direct = aggregateStrategy(engine, PARAMS, straddleLegs);
  assert.ok(Math.abs(pipelineResult.bs.price - direct.price) < 1e-12);
  assert.ok(Math.abs(pipelineResult.bs.delta - direct.delta) < 1e-12);
  assert.ok(Math.abs(pipelineResult.bs.vega - direct.vega) < 1e-12);
});

ok('sample paths have the exact expected dimensions', () => {
  const { samplePaths, nSamplePaths, nSteps } = pipelineResult;
  assert.ok(samplePaths instanceof Float64Array, 'samplePaths must be a Float64Array');
  assert.equal(samplePaths.length, nSamplePaths * (nSteps + 1));
  assert.equal(samplePaths.length, 64 * 51);
});

ok('every sample path starts at S0 and stays finite and positive', () => {
  const { samplePaths, nSamplePaths, nSteps } = pipelineResult;
  const points = nSteps + 1;
  for (let p = 0; p < nSamplePaths; p += 1) {
    const base = p * points;
    assert.ok(Math.abs(samplePaths[base] - PARAMS.s) < 1e-12, `path ${p} must start at S0`);
    for (let step = 0; step <= nSteps; step += 1) {
      const v = samplePaths[base + step];
      assert.ok(Number.isFinite(v), `path ${p} step ${step} must be finite`);
      assert.ok(v > 0, `path ${p} step ${step} must be positive`);
    }
  }
});

await okAsync('the pipeline is reproducible for a fixed seed', async () => {
  const a = await runSimulationJob(engine, { ...PARAMS, legs: straddleLegs });
  const b = await runSimulationJob(engine, { ...PARAMS, legs: straddleLegs });
  assert.deepEqual(a.mc, b.mc);
  assert.deepEqual(a.bs, b.bs);
  assert.deepEqual(a.samplePaths, b.samplePaths);
});

await okAsync('a different seed produces a different estimate', async () => {
  const a = await runSimulationJob(engine, { ...PARAMS, legs: straddleLegs });
  const b = await runSimulationJob(engine, { ...PARAMS, legs: straddleLegs, seed: 1338 });
  assert.notDeepEqual(a.mc, b.mc);
});

// --- Payoff pipeline -------------------------------------------------------
ok('payoff curve and breakevens are consistent with the analytic premium', () => {
  const net = aggregateStrategy(engine, PARAMS, straddleLegs);
  const curve = computePayoffCurve(straddleLegs, net.price, 50, 150, 241);
  assert.equal(curve.spots.length, 241);
  assert.equal(curve.payoff.length, 241);
  assert.equal(curve.pnl.length, 241);
  const roots = findBreakevens(straddleLegs, net.price, 50, 150);
  assert.equal(roots.length, 2, `straddle must have two breakevens, got ${roots.length}`);
  // P&L must be negative between the breakevens and positive outside them.
  const mid = (roots[0] + roots[1]) / 2;
  const midIndex = Math.round(((mid - 50) / 100) * 240);
  assert.ok(curve.pnl[midIndex] < 0, 'P&L must be negative between breakevens');
});

// --- Worker message dispatch ----------------------------------------------
await okAsync('handleMessage emits SIM_PROGRESS then SIM_COMPLETE', async () => {
  const posted = [];
  const state = { currentJobId: null, cancelled: false };
  await handleMessage(
    engine,
    { type: 'RUN_SIM', jobId: 7, params: { ...PARAMS, nPaths: 20_000, legs: straddleLegs } },
    (msg) => posted.push(msg),
    state,
  );

  const types = posted.map((m) => m.type);
  assert.ok(types.includes('SIM_PROGRESS'), 'expected progress messages');
  assert.equal(types[types.length - 1], 'SIM_COMPLETE', 'last message must be SIM_COMPLETE');
  const complete = posted[posted.length - 1];
  assert.equal(complete.jobId, 7);
  assert.ok(complete.mc && complete.bs && complete.samplePaths);
  assert.equal(state.currentJobId, null, 'job id must be cleared when finished');
});

await okAsync('handleMessage reports unknown message types as SIM_ERROR', async () => {
  const posted = [];
  const state = { currentJobId: null, cancelled: false };
  await handleMessage(engine, { type: 'NOPE', jobId: 9 }, (msg) => posted.push(msg), state);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].type, 'SIM_ERROR');
  assert.match(posted[0].message, /Unknown message type/);
});

await okAsync('handleMessage reports a bad job as SIM_ERROR', async () => {
  const posted = [];
  const state = { currentJobId: null, cancelled: false };
  await handleMessage(
    engine,
    { type: 'RUN_SIM', jobId: 11, params: { ...PARAMS, legs: [] } },
    (msg) => posted.push(msg),
    state,
  );
  assert.equal(posted.length, 1);
  assert.equal(posted[0].type, 'SIM_ERROR');
  assert.match(posted[0].message, /at least one leg/);
});

// --- Cancellation ----------------------------------------------------------
await okAsync('cancellation aborts the job between chunks', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      runSimulationJob(
        engine,
        { ...PARAMS, legs: straddleLegs },
        {
          shouldCancel: () => {
            calls += 1;
            return calls > 2;
          },
        },
      ),
    (error) => {
      assert.ok(error instanceof CancelledError, 'expected a CancelledError');
      return true;
    },
  );
  assert.ok(calls > 2, 'cancellation must be polled between chunks');
});

await okAsync('handleMessage emits SIM_CANCELLED when the job is cancelled', async () => {
  const posted = [];
  const state = { currentJobId: null, cancelled: false };
  const promise = handleMessage(
    engine,
    { type: 'RUN_SIM', jobId: 13, params: { ...PARAMS, legs: straddleLegs } },
    (msg) => {
      posted.push(msg);
      // Cancel as soon as the first progress message arrives.
      if (msg.type === 'SIM_PROGRESS') {
        state.cancelled = true;
      }
    },
    state,
  );
  await promise;
  const types = posted.map((m) => m.type);
  assert.ok(types.includes('SIM_CANCELLED'), `expected SIM_CANCELLED, got ${types.join(',')}`);
});

// --- Cross-checks against the JS reference --------------------------------
ok('WASM analytic price matches the JS reference inside the pipeline', () => {
  for (const leg of straddleLegs) {
    const wasm = bs_greeks(PARAMS.s, leg.strike, PARAMS.t, PARAMS.r, PARAMS.q, PARAMS.sigma, leg.type === 'call')[0];
    const js = bsPrice(PARAMS.s, leg.strike, PARAMS.t, PARAMS.r, PARAMS.q, PARAMS.sigma, leg.type === 'call');
    assert.ok(Math.abs(wasm - js) < 1e-9, `leg ${leg.type} ${leg.strike}: ${wasm} vs ${js}`);
  }
});

// --- Merton jump-diffusion pipeline ---------------------------------------
// A separate engine object rather than adding to the shared one, so the
// Black-Scholes tests above keep exercising exactly the mock they always did.
const mertonEngine = {
  ...engine,
  merton_greeks,
  mc_merton_greeks,
  mc_merton_paths_sample,
};
const MERTON_PARAMS = { ...PARAMS, model: 'merton', lambda: 1.0, muJ: -0.1, deltaJ: 0.15 };

await okAsync('the Merton strategy -> worker -> WASM pipeline completes and converges', async () => {
  const result = await runSimulationJob(mertonEngine, { ...MERTON_PARAMS, legs: straddleLegs });
  assert.equal(result.model, 'merton');
  assert.ok(result.mc.stdErr > 0, 'stdErr must be positive');
  assert.ok(
    Math.abs(result.mc.price - result.bs.price) <= 3 * result.mc.stdErr,
    `price ${result.mc.price} vs ${result.bs.price}, tolerance ${3 * result.mc.stdErr}`,
  );

  // The analytic leg must agree with the strategy module's own Merton path.
  const direct = aggregateStrategy(mertonEngine, MERTON_PARAMS, straddleLegs);
  assert.ok(
    Math.abs(result.bs.price - direct.price) < 1e-12,
    'analytic leg must match strategies.js',
  );

  // Jumps must actually change the answer. A Merton straddle is worth more than
  // a Black-Scholes one at these parameters, so a dispatch bug that silently
  // fell back to Black-Scholes would be caught here rather than passing as a
  // plausible-looking number.
  const bsResult = await runSimulationJob(engine, { ...PARAMS, legs: straddleLegs });
  assert.ok(
    result.bs.price > bsResult.bs.price,
    `Merton straddle ${result.bs.price} must exceed Black-Scholes ${bsResult.bs.price}`,
  );
});

await okAsync('the Merton pipeline with lambda=0 reproduces Black-Scholes bit-for-bit', async () => {
  const bsResult = await runSimulationJob(engine, { ...PARAMS, legs: straddleLegs });
  const zero = await runSimulationJob(mertonEngine, {
    ...MERTON_PARAMS,
    lambda: 0,
    legs: straddleLegs,
  });
  assert.deepEqual(zero.mc, bsResult.mc);
  assert.deepEqual(zero.bs, bsResult.bs);
  assert.deepEqual(Array.from(zero.samplePaths), Array.from(bsResult.samplePaths));
});

console.log(`\ntest_integration.js: ${checks} checks passed`);
