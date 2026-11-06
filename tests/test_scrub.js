// Scrub gate: Greeks-table view-models, parameter validation, debounce control.
//
// Run with: node tests/test_scrub.js

import assert from 'node:assert/strict';
import {
  GREEK_ROWS,
  buildGreeksRows,
  createScrubController,
  diffClass,
  fmt,
  isValidParams,
} from '../src/lib/scrub.js';

let checks = 0;

function ok(label, fn) {
  fn();
  checks += 1;
  console.log(`  ok ${checks} - ${label}`);
}

console.log('test_scrub.js');

// --- Formatting ------------------------------------------------------------

ok('fmt renders finite values and dashes the rest', () => {
  assert.equal(fmt(12.34567), '12.3457');
  assert.equal(fmt(1.5, 2), '1.50');
  assert.equal(fmt(NaN), '—');
  assert.equal(fmt(Infinity), '—');
  assert.equal(fmt(undefined), '—');
});

ok('diffClass bands at 1% and 5%', () => {
  assert.equal(diffClass(0.5, 100), 'diff-good');
  assert.equal(diffClass(2, 100), 'diff-warn');
  assert.equal(diffClass(9, 100), 'diff-bad');
  // A zero analytic value must not divide by zero.
  assert.equal(diffClass(0, 0), 'diff-good');
});

// --- Greeks table rows -----------------------------------------------------

const BS = { price: 10.4506, delta: 0.6368, gamma: 0.0188, vega: 37.524, theta: -6.414, rho: 53.2325 };
const MC = { price: 10.44, delta: 0.6361, gamma: 0.0187, vega: 37.41, theta: -6.402, rho: 53.11 };

ok('buildGreeksRows emits one row per Greek', () => {
  const rows = buildGreeksRows(MC, BS);
  assert.equal(rows.length, 6);
  assert.deepEqual(
    rows.map((r) => r.key),
    GREEK_ROWS.map((r) => r.key),
  );
  assert.deepEqual(
    rows.map((r) => r.label),
    ['Price', 'Delta', 'Gamma', 'Vega', 'Theta', 'Rho'],
  );
});

ok('buildGreeksRows populates every column when both estimates exist', () => {
  const rows = buildGreeksRows(MC, BS);
  const price = rows[0];
  assert.equal(price.mcText, '10.4400');
  assert.equal(price.bsText, '10.4506');
  assert.equal(price.absDiffText, '-0.0106');
  assert.equal(price.relDiffText, '-0.10%');
  assert.equal(price.diffClassName, 'diff-good');
  for (const row of rows) {
    assert.notEqual(row.mcText, '—');
    assert.notEqual(row.bsText, '—');
    assert.notEqual(row.absDiffText, '—');
    assert.notEqual(row.relDiffText, '—');
    assert.notEqual(row.diffClassName, '');
  }
});

ok('buildGreeksRows blanks the diff columns when the Monte Carlo is absent', () => {
  const rows = buildGreeksRows(null, BS);
  for (const row of rows) {
    assert.equal(row.mcText, '—');
    assert.equal(row.absDiffText, '—');
    assert.equal(row.relDiffText, '—');
    assert.equal(row.diffClassName, '', 'a stale/absent MC must not paint a diff colour');
    assert.notEqual(row.bsText, '—', 'the analytic column stays live while scrubbing');
  }
  assert.equal(rows[0].bsText, '10.4506');
});

ok('buildGreeksRows dashes the analytic column when bs is absent', () => {
  const rows = buildGreeksRows(MC, null);
  for (const row of rows) {
    assert.equal(row.bsText, '—');
    assert.equal(row.absDiffText, '—');
    assert.equal(row.diffClassName, '');
  }
});

ok('buildGreeksRows treats a non-finite MC entry as absent', () => {
  const rows = buildGreeksRows({ ...MC, vega: NaN }, BS);
  const vega = rows.find((r) => r.key === 'vega');
  assert.equal(vega.mcText, '—');
  assert.equal(vega.absDiffText, '—');
  assert.equal(vega.diffClassName, '');
  assert.equal(vega.bsText, '37.5240');
});

// --- Parameter validation --------------------------------------------------

const VALID = {
  s: 100,
  k: 100,
  t: 1,
  r: 0.05,
  q: 0,
  sigma: 0.2,
  nPaths: 100000,
  seed: 42,
  model: 'bs',
  legs: [{ strike: 100, type: 'call', side: 1, qty: 1 }],
};

ok('isValidParams accepts a well-formed parameter set', () => {
  assert.equal(isValidParams(VALID), true);
});

ok('isValidParams rejects mid-keystroke and out-of-domain values', () => {
  assert.equal(isValidParams(null), false);
  assert.equal(isValidParams({ ...VALID, s: NaN }), false);
  assert.equal(isValidParams({ ...VALID, s: 0 }), false);
  assert.equal(isValidParams({ ...VALID, k: -1 }), false);
  assert.equal(isValidParams({ ...VALID, t: 0 }), false);
  assert.equal(isValidParams({ ...VALID, sigma: 0 }), false);
  assert.equal(isValidParams({ ...VALID, q: -0.01 }), false);
  assert.equal(isValidParams({ ...VALID, nPaths: 0 }), false);
  assert.equal(isValidParams({ ...VALID, seed: -1 }), false);
  assert.equal(isValidParams({ ...VALID, legs: [] }), false);
});

ok('isValidParams allows a negative rate', () => {
  // The rate input spans -0.05 to 0.5; a positivity check here would reject
  // a legitimate configuration.
  assert.equal(isValidParams({ ...VALID, r: -0.05 }), true);
  assert.equal(isValidParams({ ...VALID, r: NaN }), false);
});

ok('isValidParams enforces the Merton jump domain only for Merton', () => {
  assert.equal(isValidParams({ ...VALID, model: 'merton', lambda: 1, muJ: -0.1, deltaJ: 0.15 }), true);
  assert.equal(isValidParams({ ...VALID, model: 'merton', lambda: -1, muJ: -0.1, deltaJ: 0.15 }), false);
  assert.equal(isValidParams({ ...VALID, model: 'merton', lambda: 1, muJ: NaN, deltaJ: 0.15 }), false);
  assert.equal(isValidParams({ ...VALID, model: 'merton', lambda: 1, muJ: -0.1, deltaJ: -0.1 }), false);
  // The same values are ignored under Black-Scholes.
  assert.equal(isValidParams({ ...VALID, model: 'bs', lambda: -1, muJ: NaN, deltaJ: -1 }), true);
});

// --- Scrub controller ------------------------------------------------------

function fakeTimers() {
  let nextId = 1;
  let lastMs = null;
  const timers = new Map();
  return {
    setTimer(fn, ms) {
      const id = nextId++;
      lastMs = ms;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    runAll() {
      const due = [...timers.values()];
      timers.clear();
      for (const t of due) t.fn();
    },
    count() {
      return timers.size;
    },
    lastMs() {
      return lastMs;
    },
  };
}

function harness(debounceMs = 250) {
  const calls = { analytic: 0, run: 0, cancel: 0 };
  const timers = fakeTimers();
  const controller = createScrubController({
    onAnalytic: () => {
      calls.analytic += 1;
    },
    onRunMc: () => {
      calls.run += 1;
    },
    onCancelMc: () => {
      calls.cancel += 1;
    },
    debounceMs,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  return { calls, timers, controller };
}

ok('scrub updates the analytic column immediately and defers the Monte Carlo', () => {
  const { calls, timers, controller } = harness();
  controller.scrub();
  assert.equal(calls.analytic, 1, 'analytic must update on the scrub step itself');
  assert.equal(calls.cancel, 1, 'an in-flight job is dropped before recomputing');
  assert.equal(calls.run, 0, 'the Monte Carlo must not start mid-scrub');
  assert.equal(controller.isPending(), true);
  assert.equal(timers.count(), 1);
  timers.runAll();
  assert.equal(calls.run, 1);
  assert.equal(controller.isPending(), false);
});

ok('a burst of scrubs coalesces into exactly one Monte Carlo run', () => {
  const { calls, timers, controller } = harness();
  for (let i = 0; i < 5; i += 1) controller.scrub();
  assert.equal(calls.analytic, 5, 'every scrub step refreshes the analytic column');
  assert.equal(calls.run, 0, 'no worker job during the burst');
  assert.equal(timers.count(), 1, 'only the last timer survives');
  timers.runAll();
  assert.equal(calls.run, 1, 'the burst produces a single run');
});

ok('flush runs the Monte Carlo immediately without waiting', () => {
  const { calls, timers, controller } = harness();
  controller.flush();
  assert.equal(calls.analytic, 1);
  assert.equal(calls.run, 1);
  assert.equal(timers.count(), 0, 'flush leaves no timer behind');
  assert.equal(controller.isPending(), false);
});

ok('cancelPending stops a scheduled run from firing', () => {
  const { calls, timers, controller } = harness();
  controller.scrub();
  assert.equal(controller.isPending(), true);
  controller.cancelPending();
  assert.equal(controller.isPending(), false);
  assert.equal(timers.count(), 0);
  timers.runAll();
  assert.equal(calls.run, 0, 'a cancelled scrub must not resurrect a run');
});

ok('scrub after flush restarts the debounce cleanly', () => {
  const { calls, timers, controller } = harness();
  controller.flush();
  assert.equal(calls.run, 1);
  controller.scrub();
  assert.equal(calls.run, 1, 'still one run until the new timer fires');
  timers.runAll();
  assert.equal(calls.run, 2);
});

ok('the controller honours a custom debounce interval', () => {
  const { timers, controller } = harness(750);
  controller.scrub();
  assert.equal(timers.count(), 1);
  assert.equal(timers.lastMs(), 750, 'the configured interval reaches the timer');
});

console.log(`\ntest_scrub.js: ${checks} checks passed`);
