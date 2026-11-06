// Engine gate: validates the Rust/WASM engine against an independent JS
// Black-Scholes reference and against analytic values.
//
// Run with: node tests/test_monte_carlo.js

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import init, {
  bs_price,
  bs_greeks,
  mc_european,
  mc_greeks,
  mc_paths_sample,
  merton_price,
  merton_greeks,
  mc_merton_european,
  mc_merton_greeks,
  mc_merton_paths_sample,
} from '../src/wasm/engine.js';
import {
  bsGreeks,
  bsPrice,
  mertonGreeks,
  mertonPrice,
  normCdf,
} from '../src/lib/bs_benchmark.js';

const wasmBytes = readFileSync(new URL('../src/wasm/engine_bg.wasm', import.meta.url));
await init({ module_or_path: wasmBytes });

const S = 100;
const K = 100;
const T = 1;
const R = 0.05;
const Q = 0;
const SIGMA = 0.2;
const SEED = 42n;
const PATHS = 100_000;

let checks = 0;
function ok(label, fn) {
  fn();
  checks += 1;
  console.log(`  ok ${checks} - ${label}`);
}

console.log('test_monte_carlo.js');

// --- Normal CDF sanity -----------------------------------------------------
ok('JS normCdf matches known values', () => {
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-15);
  assert.ok(Math.abs(normCdf(1) - 0.8413447460685429) < 1e-12);
  assert.ok(Math.abs(normCdf(-1) - 0.15865525393145707) < 1e-12);
  assert.ok(Math.abs(normCdf(1.96) - 0.9750021048517795) < 1e-12);
});

// --- WASM vs JS reference --------------------------------------------------
ok('WASM bs_price matches JS reference within 1e-9', () => {
  for (const isCall of [true, false]) {
    for (const [s, k, t, r, q, sigma] of [
      [100, 100, 1, 0.05, 0, 0.2],
      [100, 120, 0.5, 0.03, 0.01, 0.35],
      [50, 45, 2, 0.07, 0.02, 0.15],
      [100, 80, 0.25, 0.01, 0.0, 0.6],
    ]) {
      const wasm = bs_price(s, k, t, r, q, sigma, isCall);
      const js = bsPrice(s, k, t, r, q, sigma, isCall);
      assert.ok(
        Math.abs(wasm - js) < 1e-9,
        `price mismatch s=${s} k=${k} call=${isCall}: ${wasm} vs ${js}`,
      );
    }
  }
});

ok('WASM bs_greeks matches JS reference within 1e-9', () => {
  for (const isCall of [true, false]) {
    const wasm = bs_greeks(S, K, T, R, Q, SIGMA, isCall);
    const js = bsGreeks(S, K, T, R, Q, SIGMA, isCall);
    assert.equal(wasm.length, 6);
    const names = ['price', 'delta', 'gamma', 'vega', 'theta', 'rho'];
    names.forEach((name, i) => {
      assert.ok(
        Math.abs(wasm[i] - js[name]) < 1e-9,
        `${name} mismatch (call=${isCall}): ${wasm[i]} vs ${js[name]}`,
      );
    });
  }
});

ok('WASM analytic Greeks match textbook values', () => {
  const g = bs_greeks(S, K, T, R, Q, SIGMA, true);
  assert.ok(Math.abs(g[0] - 10.4505836) < 1e-6, `price ${g[0]}`);
  assert.ok(Math.abs(g[1] - 0.6368307) < 1e-6, `delta ${g[1]}`);
  assert.ok(Math.abs(g[2] - 0.0187620) < 1e-6, `gamma ${g[2]}`);
  assert.ok(Math.abs(g[3] - 37.5240345) < 1e-5, `vega ${g[3]}`);
  assert.ok(Math.abs(g[4] - -6.4140275) < 1e-5, `theta ${g[4]}`);
  assert.ok(Math.abs(g[5] - 53.2324818) < 1e-5, `rho ${g[5]}`);
});

ok('put-call parity holds in the WASM engine', () => {
  const call = bs_price(S, K, T, R, Q, SIGMA, true);
  const put = bs_price(S, K, T, R, Q, SIGMA, false);
  const forwardDiff = S * Math.exp(-Q * T) - K * Math.exp(-R * T);
  assert.ok(Math.abs(call - put - forwardDiff) < 1e-10);
});

// --- Monte Carlo -----------------------------------------------------------
ok('mc_european converges to analytic within 0.05', () => {
  const analytic = bsPrice(S, K, T, R, Q, SIGMA, true);
  const [price, stdErr] = mc_european(S, K, T, R, Q, SIGMA, true, PATHS, SEED);
  assert.ok(Math.abs(price - analytic) < 0.05, `price ${price} vs ${analytic}`);
  assert.ok(stdErr > 0 && stdErr < 0.1, `stdErr ${stdErr}`);
});

ok('mc_european is deterministic for a fixed seed', () => {
  const a = mc_european(S, K, T, R, Q, SIGMA, true, 10_000, SEED);
  const b = mc_european(S, K, T, R, Q, SIGMA, true, 10_000, SEED);
  assert.deepEqual(a, b);
  const c = mc_european(S, K, T, R, Q, SIGMA, true, 10_000, 43n);
  assert.notDeepEqual(a, c);
});

ok('mc_greeks converges to analytic within blueprint tolerances', () => {
  const analytic = bsGreeks(S, K, T, R, Q, SIGMA, true);
  const mc = mc_greeks(S, K, T, R, Q, SIGMA, true, PATHS, SEED);
  assert.equal(mc.length, 7);
  const [price, stdErr, delta, gamma, vega, theta, rho] = mc;
  assert.ok(Math.abs(price - analytic.price) < 0.05, `price ${price} vs ${analytic.price}`);
  assert.ok(stdErr > 0, `stdErr ${stdErr}`);
  assert.ok(Math.abs(delta - analytic.delta) < 0.005, `delta ${delta} vs ${analytic.delta}`);
  assert.ok(Math.abs(gamma - analytic.gamma) < 0.002, `gamma ${gamma} vs ${analytic.gamma}`);
  assert.ok(Math.abs(vega - analytic.vega) < 0.15, `vega ${vega} vs ${analytic.vega}`);
  assert.ok(Math.abs(theta - analytic.theta) < 0.08, `theta ${theta} vs ${analytic.theta}`);
  assert.ok(Math.abs(rho - analytic.rho) < 0.1, `rho ${rho} vs ${analytic.rho}`);
});

ok('mc_greeks put converges to analytic', () => {
  const analytic = bsGreeks(S, K, T, R, Q, SIGMA, false);
  const mc = mc_greeks(S, K, T, R, Q, SIGMA, false, PATHS, SEED);
  assert.ok(Math.abs(mc[0] - analytic.price) < 0.05, `price ${mc[0]} vs ${analytic.price}`);
  assert.ok(Math.abs(mc[2] - analytic.delta) < 0.005, `delta ${mc[2]} vs ${analytic.delta}`);
  assert.ok(Math.abs(mc[3] - analytic.gamma) < 0.002, `gamma ${mc[3]} vs ${analytic.gamma}`);
});

ok('mc_greeks is deterministic for a fixed seed', () => {
  const a = mc_greeks(S, K, T, R, Q, SIGMA, true, 20_000, SEED);
  const b = mc_greeks(S, K, T, R, Q, SIGMA, true, 20_000, SEED);
  assert.deepEqual(a, b);
});

// --- Path sampling ---------------------------------------------------------
ok('mc_paths_sample returns the expected flat dimensions', () => {
  const nPaths = 64;
  const nSteps = 50;
  const flat = mc_paths_sample(S, T, R, Q, SIGMA, nPaths, nSteps, 1337n);
  assert.ok(flat instanceof Float64Array, 'expected Float64Array');
  assert.equal(flat.length, nPaths * (nSteps + 1));
  for (let p = 0; p < nPaths; p += 1) {
    const base = p * (nSteps + 1);
    assert.ok(Math.abs(flat[base] - S) < 1e-12, `path ${p} must start at S0`);
    for (let step = 0; step <= nSteps; step += 1) {
      assert.ok(Number.isFinite(flat[base + step]), 'path value must be finite');
      assert.ok(flat[base + step] > 0, 'path value must be positive');
    }
  }
});

ok('mc_paths_sample is reproducible for a fixed seed', () => {
  const a = mc_paths_sample(S, T, R, Q, SIGMA, 8, 10, 1337n);
  const b = mc_paths_sample(S, T, R, Q, SIGMA, 8, 10, 1337n);
  assert.deepEqual(a, b);
});

// --- Merton jump-diffusion -------------------------------------------------
const LAMBDA = 1.0;
const MU_J = -0.1;
const DELTA_J = 0.15;

ok('WASM merton_price matches the JS reference within 1e-9', () => {
  for (const isCall of [true, false]) {
    for (const [s, k, t, r, q, sigma, lambda, muJ, deltaJ] of [
      [100, 100, 1, 0.05, 0, 0.2, 1.0, -0.1, 0.15],
      [100, 120, 0.5, 0.03, 0.01, 0.35, 0.5, -0.05, 0.2],
      [50, 45, 2, 0.07, 0.02, 0.15, 2.0, 0.0, 0.1],
      [100, 80, 0.25, 0.01, 0.0, 0.6, 0.25, -0.2, 0.3],
    ]) {
      const wasm = merton_price(s, k, t, r, q, sigma, isCall, lambda, muJ, deltaJ);
      const js = mertonPrice(s, k, t, r, q, sigma, isCall, lambda, muJ, deltaJ);
      assert.ok(
        Math.abs(wasm - js) < 1e-9,
        `price mismatch s=${s} k=${k} call=${isCall}: ${wasm} vs ${js}`,
      );
    }
  }
});

ok('WASM merton_greeks matches the JS reference within 1e-9', () => {
  for (const isCall of [true, false]) {
    const wasm = merton_greeks(S, K, T, R, Q, SIGMA, isCall, LAMBDA, MU_J, DELTA_J);
    const js = mertonGreeks(S, K, T, R, Q, SIGMA, isCall, LAMBDA, MU_J, DELTA_J);
    assert.equal(wasm.length, 6);
    const names = ['price', 'delta', 'gamma', 'vega', 'theta', 'rho'];
    names.forEach((name, i) => {
      assert.ok(
        Math.abs(wasm[i] - js[name]) < 1e-9,
        `${name} mismatch (call=${isCall}): ${wasm[i]} vs ${js[name]}`,
      );
    });
  }
});

ok('Merton lambda=0 reproduces Black-Scholes bit-for-bit', () => {
  const bs = bs_greeks(S, K, T, R, Q, SIGMA, true);
  const m = merton_greeks(S, K, T, R, Q, SIGMA, true, 0, MU_J, DELTA_J);
  assert.deepEqual(Array.from(m), Array.from(bs));

  const bsMc = mc_greeks(S, K, T, R, Q, SIGMA, true, 20_000, SEED);
  const mMc = mc_merton_greeks(S, K, T, R, Q, SIGMA, true, 0, MU_J, DELTA_J, 20_000, SEED);
  assert.deepEqual(Array.from(mMc), Array.from(bsMc));

  const bsPaths = mc_paths_sample(S, T, R, Q, SIGMA, 8, 10, SEED);
  const mPaths = mc_merton_paths_sample(S, T, R, Q, SIGMA, 0, MU_J, DELTA_J, 8, 10, SEED);
  assert.deepEqual(Array.from(mPaths), Array.from(bsPaths));
});

ok('Merton with zero-size jumps reduces to Black-Scholes within 1e-12', () => {
  // kappa = 0, so r_n = r and sigma_n = sigma. The weights still sum to 1 and
  // sum w_n (n - L) = 0, so the series collapses onto Black-Scholes even though
  // roughly twenty terms are active.
  const bs = bsGreeks(S, K, T, R, Q, SIGMA, true);
  const m = mertonGreeks(S, K, T, R, Q, SIGMA, true, 1.5, 0, 0);
  for (const name of ['price', 'delta', 'gamma', 'vega', 'theta', 'rho']) {
    assert.ok(Math.abs(m[name] - bs[name]) < 1e-12, `${name}: ${m[name]} vs ${bs[name]}`);
  }
});

ok('Merton analytic Greeks match central finite differences of merton_price', () => {
  const g = mertonGreeks(S, K, T, R, Q, SIGMA, true, LAMBDA, MU_J, DELTA_J);
  const price = (s, t, r, sigma) =>
    mertonPrice(s, K, t, r, Q, sigma, true, LAMBDA, MU_J, DELTA_J);

  const hs = 1e-4;
  const delta = (price(S + hs, T, R, SIGMA) - price(S - hs, T, R, SIGMA)) / (2 * hs);
  const gamma =
    (price(S + hs, T, R, SIGMA) - 2 * g.price + price(S - hs, T, R, SIGMA)) / (hs * hs);
  const hsig = 1e-5;
  const vega = (price(S, T, R, SIGMA + hsig) - price(S, T, R, SIGMA - hsig)) / (2 * hsig);
  const hr = 1e-5;
  const rho = (price(S, T, R + hr, SIGMA) - price(S, T, R - hr, SIGMA)) / (2 * hr);
  const ht = 1e-5;
  const theta = -(price(S, T + ht, R, SIGMA) - price(S, T - ht, R, SIGMA)) / (2 * ht);

  assert.ok(Math.abs(g.delta - delta) < 1e-7, `delta ${g.delta} vs ${delta}`);
  assert.ok(Math.abs(g.gamma - gamma) < 1e-5, `gamma ${g.gamma} vs ${gamma}`);
  // A missing sigma/sigma_n chain-rule factor moves vega by about 5.9 here, so
  // this tolerance catches it by six orders of magnitude.
  assert.ok(Math.abs(g.vega - vega) < 1e-6, `vega ${g.vega} vs ${vega}`);
  assert.ok(Math.abs(g.theta - theta) < 1e-6, `theta ${g.theta} vs ${theta}`);
  assert.ok(Math.abs(g.rho - rho) < 1e-6, `rho ${g.rho} vs ${rho}`);
});

ok('Merton put-call parity holds in WASM and JS within 1e-10', () => {
  const forwardDiff = S * Math.exp(-Q * T) - K * Math.exp(-R * T);
  const wasmCall = merton_price(S, K, T, R, Q, SIGMA, true, LAMBDA, MU_J, DELTA_J);
  const wasmPut = merton_price(S, K, T, R, Q, SIGMA, false, LAMBDA, MU_J, DELTA_J);
  assert.ok(Math.abs(wasmCall - wasmPut - forwardDiff) < 1e-10, 'WASM parity');
  const jsCall = mertonPrice(S, K, T, R, Q, SIGMA, true, LAMBDA, MU_J, DELTA_J);
  const jsPut = mertonPrice(S, K, T, R, Q, SIGMA, false, LAMBDA, MU_J, DELTA_J);
  assert.ok(Math.abs(jsCall - jsPut - forwardDiff) < 1e-10, 'JS parity');
});

ok('mc_merton converges to the analytic series for call and put', () => {
  // Tolerances are set at roughly 4 standard deviations of the estimator at
  // PATHS = 100k, measured over eight seeds. The call's vega is the noisiest
  // Greek (sd 0.218) because the volatility bump interacts with the jump
  // mixture; the put's is three times tighter (sd 0.082). Do not widen these
  // without re-measuring: they still have to catch the two bugs they exist for.
  //   - omitting the sigma/sigma_n chain rule moves vega by 5.9 (6.5x the bound)
  //   - omitting the Poisson generator shift moves theta by 3.42 (34x the bound)
  const bounds = {
    price: 0.15,
    delta: 0.008,
    gamma: 0.003,
    vega: 0.9,
    theta: 0.1,
    rho: 0.3,
  };

  for (const isCall of [true, false]) {
    const series = mertonGreeks(S, K, T, R, Q, SIGMA, isCall, LAMBDA, MU_J, DELTA_J);
    const mc = mc_merton_greeks(S, K, T, R, Q, SIGMA, isCall, LAMBDA, MU_J, DELTA_J, PATHS, SEED);
    assert.equal(mc.length, 7);
    const [price, stdErr, delta, gamma, vega, theta, rho] = mc;
    assert.ok(stdErr > 0, `stdErr ${stdErr}`);
    const got = { price, delta, gamma, vega, theta, rho };
    for (const [name, bound] of Object.entries(bounds)) {
      assert.ok(
        Math.abs(got[name] - series[name]) < bound,
        `${name} (call=${isCall}): ${got[name]} vs ${series[name]}, bound ${bound}`,
      );
    }

    const e = mc_merton_european(
      S, K, T, R, Q, SIGMA, isCall, LAMBDA, MU_J, DELTA_J, PATHS, SEED,
    );
    assert.equal(e.length, 2);
    assert.ok(
      Math.abs(e[0] - series.price) < bounds.price,
      `european price ${e[0]} vs ${series.price}`,
    );
  }
});

console.log(`\ntest_monte_carlo.js: ${checks} checks passed`);
