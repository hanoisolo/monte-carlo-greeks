// Renderer gate: proves the Canvas renderers are importable, exported, and
// actually execute against a 2D context, and that the visual assets exist.
//
// Run with: node tests/check_renderer.js

import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import {
  PALETTE,
  renderConvergenceChart,
  renderPathFan,
  renderPayoffAndGreeks,
  setupHiDPI,
} from '../src/lib/canvas_renderer.js';

let checks = 0;
function ok(label, fn) {
  fn();
  checks += 1;
  console.log(`  ok ${checks} - ${label}`);
}

/** Minimal recording 2D context: implements exactly what the renderers use. */
function makeMockContext() {
  const calls = { moveTo: 0, lineTo: 0, stroke: 0, fill: 0, fillText: 0, arc: 0, setLineDash: 0 };
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    clearRect() {},
    fillRect() {},
    strokeRect() {},
    beginPath() {},
    closePath() {},
    moveTo() {
      calls.moveTo += 1;
    },
    lineTo() {
      calls.lineTo += 1;
    },
    stroke() {
      calls.stroke += 1;
    },
    fill() {
      calls.fill += 1;
    },
    arc() {
      calls.arc += 1;
    },
    setLineDash() {
      calls.setLineDash += 1;
    },
    fillText() {
      calls.fillText += 1;
    },
    setTransform() {},
    save() {},
    restore() {},
  };
  return { ctx, calls };
}

console.log('check_renderer.js');

ok('the three renderers are exported functions', () => {
  assert.equal(typeof renderPathFan, 'function');
  assert.equal(typeof renderPayoffAndGreeks, 'function');
  assert.equal(typeof renderConvergenceChart, 'function');
  assert.equal(typeof setupHiDPI, 'function');
  assert.equal(typeof PALETTE, 'object');
});

ok('setupHiDPI scales the backing store by the device pixel ratio', () => {
  const canvas = { width: 0, height: 0, getContext: () => makeMockContext().ctx };
  const box = setupHiDPI(canvas, 400, 200, 2);
  assert.equal(canvas.width, 800);
  assert.equal(canvas.height, 400);
  assert.equal(box.width, 400);
  assert.equal(box.height, 200);
  assert.equal(box.dpr, 2);
});

ok('renderPathFan draws a fan of paths', () => {
  const { ctx, calls } = makeMockContext();
  const nPaths = 6;
  const nSteps = 10;
  const paths = new Float64Array(nPaths * (nSteps + 1));
  for (let p = 0; p < nPaths; p += 1) {
    for (let step = 0; step <= nSteps; step += 1) {
      paths[p * (nSteps + 1) + step] = 100 + p + step * 0.5;
    }
  }
  renderPathFan(ctx, { paths, nPaths, nSteps, width: 640, height: 320, strike: 105, s0: 100 });
  assert.ok(calls.lineTo > nPaths * nSteps, `expected many lineTo calls, got ${calls.lineTo}`);
  assert.ok(calls.stroke > 0, 'expected stroke calls');
  assert.ok(calls.fillText > 0, 'expected labels');
});

ok('renderPathFan survives empty data without throwing', () => {
  const { ctx, calls } = makeMockContext();
  renderPathFan(ctx, { paths: null, nPaths: 0, nSteps: 0, width: 320, height: 200 });
  assert.ok(calls.fillText > 0, 'expected a placeholder label');
});

ok('renderPayoffAndGreeks draws payoff, pnl, strikes and breakevens', () => {
  const { ctx, calls } = makeMockContext();
  const points = 41;
  const spots = new Float64Array(points);
  const payoff = new Float64Array(points);
  const pnl = new Float64Array(points);
  for (let i = 0; i < points; i += 1) {
    const spot = 80 + i;
    spots[i] = spot;
    payoff[i] = Math.max(spot - 100, 0);
    pnl[i] = payoff[i] - 5;
  }
  renderPayoffAndGreeks(ctx, {
    spots,
    payoff,
    pnl,
    breakevens: [105],
    strikes: [100],
    width: 640,
    height: 320,
  });
  assert.ok(calls.lineTo >= points * 2, `expected two plotted series, got ${calls.lineTo}`);
  assert.ok(calls.arc >= 1, 'expected a breakeven marker');
  assert.ok(calls.setLineDash >= 2, 'expected dashed strike markers');
});

ok('renderPayoffAndGreeks survives empty data without throwing', () => {
  const { ctx, calls } = makeMockContext();
  renderPayoffAndGreeks(ctx, { spots: null, payoff: null, pnl: null, width: 320, height: 200 });
  assert.ok(calls.fillText > 0, 'expected a placeholder label');
});

ok('renderConvergenceChart draws the estimate, band and analytic line', () => {
  const { ctx, calls } = makeMockContext();
  const estimates = new Float64Array([12.1, 11.4, 10.9, 10.6, 10.5]);
  const stdErrors = new Float64Array([0.9, 0.6, 0.4, 0.3, 0.2]);
  renderConvergenceChart(ctx, {
    estimates,
    analytic: 10.4506,
    stdErrors,
    width: 640,
    height: 320,
  });
  assert.ok(calls.lineTo >= estimates.length, `expected estimate line, got ${calls.lineTo}`);
  assert.ok(calls.fill >= 1, 'expected the confidence band to be filled');
});

ok('renderConvergenceChart survives empty data without throwing', () => {
  const { ctx, calls } = makeMockContext();
  renderConvergenceChart(ctx, { estimates: null, analytic: NaN, width: 320, height: 200 });
  assert.ok(calls.fillText > 0, 'expected a placeholder label');
});

ok('banner asset exists with non-zero size', () => {
  const stat = statSync(new URL('../assets/banner_terminal.jpg', import.meta.url));
  assert.ok(stat.size > 1024, `banner too small: ${stat.size} bytes`);
});

ok('favicon asset exists and is a valid ICO container', () => {
  const url = new URL('../assets/favicon.ico', import.meta.url);
  const stat = statSync(url);
  assert.ok(stat.size > 1024, `favicon too small: ${stat.size} bytes`);
  const head = readFileSync(url).subarray(0, 6);
  assert.equal(head[0], 0x00, 'ICO reserved byte');
  assert.equal(head[1], 0x00, 'ICO reserved byte');
  assert.equal(head[2], 0x01, 'ICO type must be 1');
  assert.equal(head[3], 0x00, 'ICO type must be 1');
  assert.equal(head[4], 0x01, 'ICO must declare one image');
  assert.equal(head[5], 0x00, 'ICO must declare one image');
});

console.log(`\ncheck_renderer.js: ${checks} checks passed`);
