// Application controller: DOM wiring, worker lifecycle, rendering.
//
// The heavy numerics live in the worker; this module only reads inputs, posts
// jobs, and paints results. Every WASM call it makes directly (the analytic
// benchmark) is cheap enough to run on the main thread.

import './styles.css';
import init, { bs_greeks, merton_greeks } from './wasm/engine.js';
import { benchmarkEngine } from './lib/bs_benchmark.js';
import {
  STRATEGY_PRESETS,
  buildLegs,
  computePayoffCurve,
  findBreakevens,
  getPreset,
  maxProfitLoss,
} from './lib/strategies.js';
import {
  renderConvergenceChart,
  renderPathFan,
  renderPayoffAndGreeks,
  setupHiDPI,
} from './lib/canvas_renderer.js';

const $ = (id) => document.getElementById(id);

const els = {
  strategy: $('strategy'),
  strategyDescription: $('strategy-description'),
  spot: $('spot'),
  strike: $('strike'),
  time: $('time'),
  rate: $('rate'),
  dividend: $('dividend'),
  volatility: $('volatility'),
  model: $('model'),
  modelDescription: $('model-description'),
  jumpParams: $('jump-params'),
  lambda: $('lambda'),
  muJ: $('mu-j'),
  deltaJ: $('delta-j'),
  paths: $('paths'),
  pathsReadout: $('paths-readout'),
  seed: $('seed'),
  run: $('run'),
  cancel: $('cancel'),
  progressWrap: $('progress-wrap'),
  progressFill: $('progress-fill'),
  progressLabel: $('progress-label'),
  elapsed: $('elapsed'),
  stdError: $('std-error'),
  benchmark: $('benchmark'),
  greeksBody: $('greeks-body'),
  engineBadge: $('engine-badge'),
  engineStatus: $('engine-status'),
  footerStatus: $('footer-status'),
  canvasPaths: $('canvas-paths'),
  canvasPayoff: $('canvas-payoff'),
  canvasConvergence: $('canvas-convergence'),
};

const GREEK_ROWS = [
  { key: 'price', label: 'Price' },
  { key: 'delta', label: 'Delta' },
  { key: 'gamma', label: 'Gamma' },
  { key: 'vega', label: 'Vega' },
  { key: 'theta', label: 'Theta' },
  { key: 'rho', label: 'Rho' },
];

const state = {
  jobId: 0,
  running: false,
  worker: null,
  lastResult: null,
  convergence: [],
  activeView: 'paths',
};

// --- Formatting ------------------------------------------------------------

const fmt = (value, digits = 4) =>
  Number.isFinite(value) ? value.toFixed(digits) : '—';

function diffClass(absDiff, scale) {
  const ratio = Math.abs(absDiff) / (Math.abs(scale) || 1);
  if (ratio < 0.01) return 'diff-good';
  if (ratio < 0.05) return 'diff-warn';
  return 'diff-bad';
}

// --- Parameter reading -----------------------------------------------------

function readParams() {
  const preset = getPreset(els.strategy.value);
  const spot = Number(els.spot.value);
  const strike = Number(els.strike.value);
  return {
    s: spot,
    k: strike,
    t: Number(els.time.value),
    r: Number(els.rate.value),
    q: Number(els.dividend.value),
    sigma: Number(els.volatility.value),
    nPaths: Number(els.paths.value),
    seed: Number(els.seed.value),
    legs: buildLegs(preset, strike),
    nSamplePaths: 64,
    nSteps: 50,
    model: els.model.value,
    lambda: Number(els.lambda.value),
    muJ: Number(els.muJ.value),
    deltaJ: Number(els.deltaJ.value),
  };
}

// --- Rendering -------------------------------------------------------------

function renderGreeksTable(mc, bs) {
  els.greeksBody.replaceChildren();
  for (const row of GREEK_ROWS) {
    const mcValue = mc[row.key];
    const bsValue = bs[row.key];
    const absDiff = mcValue - bsValue;
    const relDiff = bsValue === 0 ? 0 : absDiff / Math.abs(bsValue);

    const tr = document.createElement('tr');
    const cells = [
      { text: row.label, className: 'greek-name' },
      { text: fmt(mcValue) },
      { text: fmt(bsValue) },
      { text: fmt(absDiff), className: diffClass(absDiff, bsValue) },
      { text: `${(relDiff * 100).toFixed(2)}%`, className: diffClass(absDiff, bsValue) },
    ];
    for (const cell of cells) {
      const td = document.createElement('td');
      td.textContent = cell.text;
      if (cell.className) td.className = cell.className;
      tr.append(td);
    }
    els.greeksBody.append(tr);
  }
}

function canvasSize(canvas) {
  const rect = canvas.getBoundingClientRect();
  const width = rect.width || canvas.parentElement.clientWidth || 640;
  return { width, height: 360 };
}

function drawPaths(result, params) {
  const { width, height } = canvasSize(els.canvasPaths);
  const box = setupHiDPI(els.canvasPaths, width, height, window.devicePixelRatio || 1);
  const ctx = els.canvasPaths.getContext('2d');
  renderPathFan(ctx, {
    paths: result.samplePaths,
    nPaths: result.nSamplePaths,
    nSteps: result.nSteps,
    width: box.width,
    height: box.height,
    strike: params.k,
    s0: params.s,
  });
}

function drawPayoff(result, params) {
  const { width, height } = canvasSize(els.canvasPayoff);
  const box = setupHiDPI(els.canvasPayoff, width, height, window.devicePixelRatio || 1);
  const ctx = els.canvasPayoff.getContext('2d');
  const sMin = params.s * 0.5;
  const sMax = params.s * 1.5;
  const curve = computePayoffCurve(result.legs, result.bs.price, sMin, sMax, 241);
  const breakevens = findBreakevens(result.legs, result.bs.price, sMin, sMax);
  const strikes = [...new Set(result.legs.map((leg) => leg.strike))];
  renderPayoffAndGreeks(ctx, {
    spots: curve.spots,
    payoff: curve.payoff,
    pnl: curve.pnl,
    breakevens,
    strikes,
    width: box.width,
    height: box.height,
  });

  const { maxProfit, maxLoss } = maxProfitLoss(result.legs, result.bs.price, sMin, sMax);
  els.footerStatus.textContent = `max profit ${fmt(maxProfit, 2)} · max loss ${fmt(maxLoss, 2)} · breakevens ${
    breakevens.length ? breakevens.map((b) => b.toFixed(2)).join(', ') : 'none'
  }`;
}

function drawConvergence() {
  const { width, height } = canvasSize(els.canvasConvergence);
  const box = setupHiDPI(els.canvasConvergence, width, height, window.devicePixelRatio || 1);
  const ctx = els.canvasConvergence.getContext('2d');
  const estimates = state.convergence.map((p) => p.partialEstimate);
  const stdErrors = state.convergence.map((p) => p.partialStdErr);
  renderConvergenceChart(ctx, {
    estimates,
    stdErrors,
    analytic: state.lastResult ? state.lastResult.bs.price : NaN,
    width: box.width,
    height: box.height,
  });
}

function redrawActive() {
  if (!state.lastResult) return;
  const params = readParams();
  if (state.activeView === 'paths') drawPaths(state.lastResult, params);
  else if (state.activeView === 'payoff') drawPayoff(state.lastResult, params);
  else drawConvergence();
}

// --- Worker lifecycle ------------------------------------------------------

function setBadge(stateName, text) {
  els.engineBadge.dataset.state = stateName;
  els.engineStatus.textContent = text;
}

function setRunning(running) {
  state.running = running;
  els.run.disabled = running;
  els.cancel.disabled = !running;
  els.progressWrap.hidden = !running;
  setBadge(running ? 'running' : 'ready', running ? 'SIMULATING' : 'ENGINE READY');
}

function ensureWorker() {
  if (state.worker) return state.worker;
  state.worker = new Worker(new URL('./workers/sim.worker.js', import.meta.url), {
    type: 'module',
  });
  state.worker.onmessage = onWorkerMessage;
  state.worker.onerror = (event) => {
    setRunning(false);
    setBadge('error', 'WORKER ERROR');
    els.footerStatus.textContent = event.message || 'worker error';
  };
  return state.worker;
}

function onWorkerMessage(event) {
  const message = event.data;
  if (message.jobId !== state.jobId) return;

  if (message.type === 'SIM_PROGRESS') {
    const pct = Math.round((message.completedPaths / message.totalPaths) * 100);
    els.progressFill.style.width = `${pct}%`;
    els.progressLabel.textContent = `${pct}%`;
    state.convergence.push(message);
    if (state.activeView === 'convergence') drawConvergence();
    return;
  }

  if (message.type === 'SIM_COMPLETE') {
    state.lastResult = message;
    setRunning(false);
    els.progressFill.style.width = '100%';
    els.progressLabel.textContent = '100%';
    els.elapsed.textContent = `${message.elapsedMs} ms`;
    els.stdError.textContent = fmt(message.mc.stdErr, 5);
    renderGreeksTable(message.mc, message.bs);
    redrawActive();
    els.footerStatus.textContent = `${message.totalPaths.toLocaleString()} paths · seed ${els.seed.value}`;
    return;
  }

  if (message.type === 'SIM_CANCELLED') {
    setRunning(false);
    els.footerStatus.textContent = 'cancelled';
    return;
  }

  if (message.type === 'SIM_ERROR') {
    setRunning(false);
    setBadge('error', 'ENGINE ERROR');
    els.footerStatus.textContent = message.message;
  }
}

function runSimulation() {
  if (state.running) return;
  const params = readParams();
  state.jobId += 1;
  state.convergence = [];
  state.lastResult = null;
  els.greeksBody.replaceChildren();
  const placeholder = document.createElement('tr');
  const td = document.createElement('td');
  td.colSpan = 5;
  td.className = 'empty';
  td.textContent = 'Simulating…';
  placeholder.append(td);
  els.greeksBody.append(placeholder);

  setRunning(true);
  els.progressFill.style.width = '0%';
  els.progressLabel.textContent = '0%';
  ensureWorker().postMessage({ type: 'RUN_SIM', jobId: state.jobId, params });
}

function cancelSimulation() {
  if (!state.running || !state.worker) return;
  state.worker.postMessage({ type: 'CANCEL_SIM', jobId: state.jobId });
}

// --- Boot ------------------------------------------------------------------

function populateStrategies() {
  for (const preset of STRATEGY_PRESETS) {
    const option = document.createElement('option');
    option.value = preset.id;
    option.textContent = preset.name;
    els.strategy.append(option);
  }
  syncStrategyDescription();
}

function syncStrategyDescription() {
  els.strategyDescription.textContent = getPreset(els.strategy.value).description;
}

const MODEL_DESCRIPTIONS = {
  bs: 'Constant volatility, no jumps. The closed form is exact.',
  merton:
    'Poisson jumps with lognormal size. The series is exact; the Monte Carlo shows convergence.',
};

function syncModelControls() {
  const isMerton = els.model.value === 'merton';
  els.jumpParams.hidden = !isMerton;
  els.modelDescription.textContent = MODEL_DESCRIPTIONS[els.model.value] ?? '';
}

function syncPathsReadout() {
  els.pathsReadout.textContent = Number(els.paths.value).toLocaleString();
}

function wireEvents() {
  els.strategy.addEventListener('change', syncStrategyDescription);
  els.model.addEventListener('change', syncModelControls);
  els.paths.addEventListener('input', syncPathsReadout);
  els.run.addEventListener('click', runSimulation);
  els.cancel.addEventListener('click', cancelSimulation);

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      state.activeView = tab.dataset.view;
      for (const other of document.querySelectorAll('.tab')) {
        const active = other === tab;
        other.classList.toggle('active', active);
        other.setAttribute('aria-selected', String(active));
      }
      for (const canvas of document.querySelectorAll('.viewport')) {
        canvas.classList.toggle('active', canvas.id === `canvas-${state.activeView}`);
      }
      redrawActive();
    });
  }

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(redrawActive, 120);
  });
}

async function boot() {
  populateStrategies();
  syncPathsReadout();
  syncModelControls();
  wireEvents();

  try {
    await init();
    setBadge('ready', 'ENGINE READY');
    els.footerStatus.textContent = 'engine ready';

    const params = readParams();
    const bench = benchmarkEngine(
      {
        bs_price: (s, k, t, r, q, sigma, isCall) => bs_greeks(s, k, t, r, q, sigma, isCall)[0],
        merton_price: (s, k, t, r, q, sigma, isCall, lambda, muJ, deltaJ) =>
          merton_greeks(s, k, t, r, q, sigma, isCall, lambda, muJ, deltaJ)[0],
      },
      params,
      2000,
    );
    els.benchmark.textContent = `${bench.wasmUsPerCall.toFixed(2)} µs/call`;
  } catch (error) {
    setBadge('error', 'WASM FAILED');
    els.footerStatus.textContent = error.message;
  }
}

boot();
