// Strategy gate: multi-leg aggregation, payoff geometry, breakevens.
//
// Run with: node tests/test_strategies.js

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import init, { bs_greeks, mc_greeks } from '../src/wasm/engine.js';
import {
  STRATEGY_PRESETS,
  aggregateStrategy,
  aggregateStrategyMonteCarlo,
  buildLegs,
  computePayoffCurve,
  findBreakevens,
  getPreset,
  legPayoffAtExpiry,
  maxProfitLoss,
} from '../src/lib/strategies.js';

const wasmBytes = readFileSync(new URL('../src/wasm/engine_bg.wasm', import.meta.url));
await init({ module_or_path: wasmBytes });

const engine = { bs_greeks, mc_greeks };

const PARAMS = { s: 100, t: 1, r: 0.05, q: 0, sigma: 0.2 };
const SEED = 42n;
const PATHS = 100_000;

let checks = 0;
function ok(label, fn) {
  fn();
  checks += 1;
  console.log(`  ok ${checks} - ${label}`);
}

console.log('test_strategies.js');

// --- Presets ---------------------------------------------------------------
ok('all seven presets are present and well formed', () => {
  assert.equal(STRATEGY_PRESETS.length, 7);
  const ids = STRATEGY_PRESETS.map((p) => p.id);
  assert.deepEqual(ids, [
    'single-call',
    'single-put',
    'straddle',
    'strangle',
    'bull-call-spread',
    'iron-condor',
    'butterfly',
  ]);
  for (const preset of STRATEGY_PRESETS) {
    assert.ok(preset.name.length > 0);
    assert.ok(preset.legs.length > 0);
    for (const leg of preset.legs) {
      assert.ok(leg.type === 'call' || leg.type === 'put');
      assert.ok(leg.side === 1 || leg.side === -1);
      assert.ok(leg.qty > 0);
      assert.ok(leg.strikeFactor > 0);
    }
  }
});

ok('getPreset rejects unknown ids', () => {
  assert.throws(() => getPreset('nope'), /Unknown strategy preset/);
});

ok('buildLegs resolves strike factors against spot', () => {
  const legs = buildLegs(getPreset('strangle'), 100);
  assert.equal(legs.length, 2);
  assert.equal(legs[0].strike, 105);
  assert.equal(legs[1].strike, 95);
  assert.equal(legs[0].type, 'call');
  assert.equal(legs[1].type, 'put');
});

// --- Greek linearity -------------------------------------------------------
ok('net Greeks are exactly linear in the legs (1e-12)', () => {
  const legs = buildLegs(getPreset('iron-condor'), PARAMS.s);
  const net = aggregateStrategy(engine, PARAMS, legs);

  let delta = 0;
  let gamma = 0;
  let vega = 0;
  let theta = 0;
  let rho = 0;
  let price = 0;
  for (const leg of legs) {
    const g = bs_greeks(
      PARAMS.s,
      leg.strike,
      PARAMS.t,
      PARAMS.r,
      PARAMS.q,
      PARAMS.sigma,
      leg.type === 'call',
    );
    const w = leg.side * leg.qty;
    price += w * g[0];
    delta += w * g[1];
    gamma += w * g[2];
    vega += w * g[3];
    theta += w * g[4];
    rho += w * g[5];
  }

  assert.ok(Math.abs(net.price - price) < 1e-12, `price ${net.price} vs ${price}`);
  assert.ok(Math.abs(net.delta - delta) < 1e-12, `delta ${net.delta} vs ${delta}`);
  assert.ok(Math.abs(net.gamma - gamma) < 1e-12, `gamma ${net.gamma} vs ${gamma}`);
  assert.ok(Math.abs(net.vega - vega) < 1e-12, `vega ${net.vega} vs ${vega}`);
  assert.ok(Math.abs(net.theta - theta) < 1e-12, `theta ${net.theta} vs ${theta}`);
  assert.ok(Math.abs(net.rho - rho) < 1e-12, `rho ${net.rho} vs ${rho}`);
});

ok('a single-leg strategy reproduces the raw engine Greeks', () => {
  const legs = buildLegs(getPreset('single-call'), PARAMS.s);
  const net = aggregateStrategy(engine, PARAMS, legs);
  const raw = bs_greeks(PARAMS.s, 100, PARAMS.t, PARAMS.r, PARAMS.q, PARAMS.sigma, true);
  assert.ok(Math.abs(net.price - raw[0]) < 1e-12);
  assert.ok(Math.abs(net.delta - raw[1]) < 1e-12);
  assert.ok(Math.abs(net.gamma - raw[2]) < 1e-12);
  assert.ok(Math.abs(net.vega - raw[3]) < 1e-12);
  assert.ok(Math.abs(net.theta - raw[4]) < 1e-12);
  assert.ok(Math.abs(net.rho - raw[5]) < 1e-12);
});

// --- Put-call parity across presets ---------------------------------------
ok('put-call parity holds for the single-leg presets', () => {
  const call = aggregateStrategy(engine, PARAMS, buildLegs(getPreset('single-call'), PARAMS.s));
  const put = aggregateStrategy(engine, PARAMS, buildLegs(getPreset('single-put'), PARAMS.s));
  const forwardDiff =
    PARAMS.s * Math.exp(-PARAMS.q * PARAMS.t) - 100 * Math.exp(-PARAMS.r * PARAMS.t);
  assert.ok(Math.abs(call.price - put.price - forwardDiff) < 1e-10);
});

ok('straddle equals call plus put, and equals 2C - S + K e^-rT', () => {
  const call = aggregateStrategy(engine, PARAMS, buildLegs(getPreset('single-call'), PARAMS.s));
  const put = aggregateStrategy(engine, PARAMS, buildLegs(getPreset('single-put'), PARAMS.s));
  const straddle = aggregateStrategy(engine, PARAMS, buildLegs(getPreset('straddle'), PARAMS.s));
  assert.ok(Math.abs(straddle.price - (call.price + put.price)) < 1e-12);
  const identity =
    2 * call.price -
    PARAMS.s * Math.exp(-PARAMS.q * PARAMS.t) +
    100 * Math.exp(-PARAMS.r * PARAMS.t);
  assert.ok(Math.abs(straddle.price - identity) < 1e-10);
});

ok('every preset produces finite net Greeks', () => {
  for (const preset of STRATEGY_PRESETS) {
    const net = aggregateStrategy(engine, PARAMS, buildLegs(preset, PARAMS.s));
    for (const key of ['price', 'delta', 'gamma', 'vega', 'theta', 'rho']) {
      assert.ok(Number.isFinite(net[key]), `${preset.id}.${key} not finite`);
    }
  }
});

// --- Payoff geometry -------------------------------------------------------
ok('straddle payoff is V-shaped and zero at the strike', () => {
  const legs = buildLegs(getPreset('straddle'), 100);
  assert.ok(Math.abs(legPayoffAtExpiry(legs[0], 100) + legPayoffAtExpiry(legs[1], 100)) < 1e-12);
  const up = legs.reduce((acc, leg) => acc + legPayoffAtExpiry(leg, 110), 0);
  const down = legs.reduce((acc, leg) => acc + legPayoffAtExpiry(leg, 90), 0);
  assert.ok(Math.abs(up - 10) < 1e-12, `up ${up}`);
  assert.ok(Math.abs(down - 10) < 1e-12, `down ${down}`);
});

ok('bull call spread payoff is capped at the strike width', () => {
  const legs = buildLegs(getPreset('bull-call-spread'), 100);
  const atHigh = legs.reduce((acc, leg) => acc + legPayoffAtExpiry(leg, 200), 0);
  const atLow = legs.reduce((acc, leg) => acc + legPayoffAtExpiry(leg, 50), 0);
  assert.ok(Math.abs(atHigh - 10) < 1e-12, `capped payoff ${atHigh}`);
  assert.ok(Math.abs(atLow) < 1e-12, `floor payoff ${atLow}`);
});

ok('butterfly payoff is non-negative everywhere and peaks at the body', () => {
  const legs = buildLegs(getPreset('butterfly'), 100);
  const curve = computePayoffCurve(legs, 0, 50, 150, 401);
  for (const v of curve.payoff) {
    assert.ok(v >= -1e-12, `butterfly payoff went negative: ${v}`);
  }
  const atBody = legs.reduce((acc, leg) => acc + legPayoffAtExpiry(leg, 100), 0);
  assert.ok(Math.abs(atBody - 10) < 1e-12, `body payoff ${atBody}`);
});

ok('iron condor has bounded max profit and max loss', () => {
  const legs = buildLegs(getPreset('iron-condor'), 100);
  const net = aggregateStrategy(engine, PARAMS, legs);
  const { maxProfit, maxLoss } = maxProfitLoss(legs, net.price, 50, 150);
  assert.ok(Number.isFinite(maxProfit), 'maxProfit must be finite');
  assert.ok(Number.isFinite(maxLoss), 'maxLoss must be finite');
  assert.ok(maxProfit > 0, `iron condor should collect a credit, got ${maxProfit}`);
  assert.ok(maxLoss < 0, `iron condor must have downside, got ${maxLoss}`);
  // Wings are 10 wide, so the loss cannot exceed the wing width.
  assert.ok(Math.abs(maxLoss) < 10, `maxLoss ${maxLoss} exceeds wing width`);
});

// --- Breakevens ------------------------------------------------------------
ok('straddle breakevens sit at strike plus/minus the premium', () => {
  const legs = buildLegs(getPreset('straddle'), 100);
  const net = aggregateStrategy(engine, PARAMS, legs);
  const roots = findBreakevens(legs, net.price, 50, 150);
  assert.equal(roots.length, 2, `expected 2 breakevens, got ${roots.length}`);
  assert.ok(Math.abs(roots[0] - (100 - net.price)) < 0.05, `lower ${roots[0]}`);
  assert.ok(Math.abs(roots[1] - (100 + net.price)) < 0.05, `upper ${roots[1]}`);
});

ok('bull call spread breakeven sits at lower strike plus debit', () => {
  const legs = buildLegs(getPreset('bull-call-spread'), 100);
  const net = aggregateStrategy(engine, PARAMS, legs);
  const roots = findBreakevens(legs, net.price, 50, 150);
  assert.equal(roots.length, 1, `expected 1 breakeven, got ${roots.length}`);
  assert.ok(Math.abs(roots[0] - (100 + net.price)) < 0.05, `breakeven ${roots[0]}`);
});

// --- Monte Carlo aggregation ----------------------------------------------
ok('MC net strategy price converges to the analytic net price', () => {
  const legs = buildLegs(getPreset('straddle'), 100);
  const analytic = aggregateStrategy(engine, PARAMS, legs);
  const mc = aggregateStrategyMonteCarlo(engine, PARAMS, legs, PATHS, SEED);
  assert.ok(
    Math.abs(mc.price - analytic.price) < 0.08,
    `mc ${mc.price} vs analytic ${analytic.price}`,
  );
  assert.ok(mc.stdErr > 0 && Number.isFinite(mc.stdErr), `stdErr ${mc.stdErr}`);
});

ok('MC net delta converges to the analytic net delta', () => {
  const legs = buildLegs(getPreset('straddle'), 100);
  const analytic = aggregateStrategy(engine, PARAMS, legs);
  const mc = aggregateStrategyMonteCarlo(engine, PARAMS, legs, PATHS, SEED);
  assert.ok(
    Math.abs(mc.delta - analytic.delta) < 0.008,
    `mc delta ${mc.delta} vs analytic ${analytic.delta}`,
  );
});

ok('MC aggregation is deterministic for a fixed seed', () => {
  const legs = buildLegs(getPreset('bull-call-spread'), 100);
  const a = aggregateStrategyMonteCarlo(engine, PARAMS, legs, 20_000, SEED);
  const b = aggregateStrategyMonteCarlo(engine, PARAMS, legs, 20_000, SEED);
  assert.deepEqual(a, b);
});

console.log(`\ntest_strategies.js: ${checks} checks passed`);
