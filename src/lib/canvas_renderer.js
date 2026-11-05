// Canvas 2D renderers for the quantitative terminal.
//
// Every renderer takes an explicit width/height and a plain data object, and
// touches only the standard CanvasRenderingContext2D surface. That keeps them
// testable in Node against a mock context (tests/check_renderer.js) and keeps
// them independent of the DOM.
//
// Device-pixel-ratio handling lives in `setupHiDPI`, which the caller invokes
// once per resize; the renderers themselves always draw in CSS pixels.

export const PALETTE = {
  background: '#0b0e13',
  grid: '#1b2230',
  axis: '#2c3648',
  text: '#8b98ad',
  textBright: '#e6edf7',
  path: 'rgba(56, 189, 248, 0.16)',
  pathMean: '#38bdf8',
  strike: '#f59e0b',
  payoff: '#22d3ee',
  pnl: '#a78bfa',
  zero: '#475569',
  breakeven: '#f472b6',
  band: 'rgba(56, 189, 248, 0.12)',
  analytic: '#f59e0b',
  estimate: '#22d3ee',
};

/**
 * Size a canvas for the current device pixel ratio and return the CSS-pixel
 * drawing box. The context is scaled so renderers can work in CSS pixels.
 */
export function setupHiDPI(canvas, cssWidth, cssHeight, dpr = 1) {
  const ratio = Math.max(1, dpr);
  canvas.width = Math.round(cssWidth * ratio);
  canvas.height = Math.round(cssHeight * ratio);
  const ctx = canvas.getContext('2d');
  if (ctx && typeof ctx.setTransform === 'function') {
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  }
  return { width: cssWidth, height: cssHeight, dpr: ratio };
}

function drawGrid(ctx, box, rows = 4, cols = 6) {
  ctx.strokeStyle = PALETTE.grid;
  ctx.lineWidth = 1;
  for (let i = 0; i <= rows; i += 1) {
    const y = box.top + (box.height * i) / rows;
    ctx.beginPath();
    ctx.moveTo(box.left, y);
    ctx.lineTo(box.left + box.width, y);
    ctx.stroke();
  }
  for (let i = 0; i <= cols; i += 1) {
    const x = box.left + (box.width * i) / cols;
    ctx.beginPath();
    ctx.moveTo(x, box.top);
    ctx.lineTo(x, box.top + box.height);
    ctx.stroke();
  }
}

function drawFrame(ctx, box) {
  ctx.strokeStyle = PALETTE.axis;
  ctx.lineWidth = 1;
  ctx.strokeRect(box.left, box.top, box.width, box.height);
}

function label(ctx, text, x, y, color = PALETTE.text, align = 'left') {
  ctx.fillStyle = color;
  ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = align;
  ctx.fillText(text, x, y);
}

function makeBox(width, height, pad) {
  return {
    left: pad.left,
    top: pad.top,
    width: Math.max(1, width - pad.left - pad.right),
    height: Math.max(1, height - pad.top - pad.bottom),
  };
}

/**
 * Fan chart of simulated price paths.
 *
 * `paths` is the flat row-major Float64Array from `mc_paths_sample`, laid out
 * as nPaths rows of (nSteps + 1) points.
 */
export function renderPathFan(ctx, data) {
  const {
    paths,
    nPaths,
    nSteps,
    width,
    height,
    strike = null,
    s0 = null,
    title = 'SIMULATED PRICE PATHS',
  } = data;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = PALETTE.background;
  ctx.fillRect(0, 0, width, height);

  const box = makeBox(width, height, { left: 52, right: 16, top: 28, bottom: 30 });
  drawGrid(ctx, box);

  const points = nSteps + 1;
  if (!paths || paths.length < points || nPaths < 1) {
    label(ctx, 'no path data', box.left + 8, box.top + 18);
    drawFrame(ctx, box);
    return;
  }

  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < paths.length; i += 1) {
    const v = paths[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (strike !== null) {
    min = Math.min(min, strike);
    max = Math.max(max, strike);
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || max - min < 1e-9) {
    min -= 1;
    max += 1;
  }
  const span = max - min;

  const xAt = (step) => box.left + (box.width * step) / (points - 1);
  const yAt = (value) => box.top + box.height - ((value - min) / span) * box.height;

  // Individual paths.
  ctx.strokeStyle = PALETTE.path;
  ctx.lineWidth = 1;
  for (let p = 0; p < nPaths; p += 1) {
    const base = p * points;
    ctx.beginPath();
    ctx.moveTo(xAt(0), yAt(paths[base]));
    for (let step = 1; step < points; step += 1) {
      ctx.lineTo(xAt(step), yAt(paths[base + step]));
    }
    ctx.stroke();
  }

  // Mean path across the sample.
  ctx.strokeStyle = PALETTE.pathMean;
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let step = 0; step < points; step += 1) {
    let sum = 0;
    for (let p = 0; p < nPaths; p += 1) {
      sum += paths[p * points + step];
    }
    const mean = sum / nPaths;
    if (step === 0) ctx.moveTo(xAt(step), yAt(mean));
    else ctx.lineTo(xAt(step), yAt(mean));
  }
  ctx.stroke();

  // Strike reference.
  if (strike !== null) {
    ctx.strokeStyle = PALETTE.strike;
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(box.left, yAt(strike));
    ctx.lineTo(box.left + box.width, yAt(strike));
    ctx.stroke();
    ctx.setLineDash([]);
    label(ctx, `K ${strike.toFixed(2)}`, box.left + box.width - 4, yAt(strike) - 5, PALETTE.strike, 'right');
  }

  if (s0 !== null) {
    label(ctx, `S0 ${s0.toFixed(2)}`, box.left + 4, yAt(s0) - 5, PALETTE.textBright);
  }

  label(ctx, title, box.left, 16, PALETTE.textBright);
  label(ctx, max.toFixed(2), box.left - 6, box.top + 4, PALETTE.text, 'right');
  label(ctx, min.toFixed(2), box.left - 6, box.top + box.height, PALETTE.text, 'right');
  label(ctx, 't=0', box.left, box.top + box.height + 16, PALETTE.text);
  label(ctx, `t=${nSteps}`, box.left + box.width, box.top + box.height + 16, PALETTE.text, 'right');

  drawFrame(ctx, box);
}

/**
 * Expiry payoff and profit/loss curves, with strike and breakeven markers.
 */
export function renderPayoffAndGreeks(ctx, data) {
  const {
    spots,
    payoff,
    pnl,
    breakevens = [],
    strikes = [],
    width,
    height,
    title = 'EXPIRY PAYOFF / P&L',
  } = data;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = PALETTE.background;
  ctx.fillRect(0, 0, width, height);

  const box = makeBox(width, height, { left: 52, right: 16, top: 28, bottom: 30 });
  drawGrid(ctx, box);

  if (!spots || spots.length < 2 || !payoff || !pnl) {
    label(ctx, 'no payoff data', box.left + 8, box.top + 18);
    drawFrame(ctx, box);
    return;
  }

  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < pnl.length; i += 1) {
    min = Math.min(min, pnl[i], payoff[i]);
    max = Math.max(max, pnl[i], payoff[i]);
  }
  min = Math.min(min, 0);
  max = Math.max(max, 0);
  if (max - min < 1e-9) {
    min -= 1;
    max += 1;
  }
  const span = max - min;
  const sMin = spots[0];
  const sMax = spots[spots.length - 1];

  const xAt = (spot) => box.left + ((spot - sMin) / (sMax - sMin)) * box.width;
  const yAt = (value) => box.top + box.height - ((value - min) / span) * box.height;

  // Zero line.
  ctx.strokeStyle = PALETTE.zero;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(box.left, yAt(0));
  ctx.lineTo(box.left + box.width, yAt(0));
  ctx.stroke();

  const plot = (series, color, lineWidth) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    for (let i = 0; i < series.length; i += 1) {
      const x = xAt(spots[i]);
      const y = yAt(series[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  };

  plot(payoff, PALETTE.payoff, 1.5);
  plot(pnl, PALETTE.pnl, 2);

  // Strike markers.
  ctx.strokeStyle = PALETTE.strike;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 4]);
  for (const strike of strikes) {
    if (strike < sMin || strike > sMax) continue;
    const x = xAt(strike);
    ctx.beginPath();
    ctx.moveTo(x, box.top);
    ctx.lineTo(x, box.top + box.height);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // Breakeven markers.
  ctx.fillStyle = PALETTE.breakeven;
  for (const root of breakevens) {
    if (root < sMin || root > sMax) continue;
    const x = xAt(root);
    const y = yAt(0);
    ctx.beginPath();
    ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.fill();
    label(ctx, root.toFixed(2), x, y - 8, PALETTE.breakeven, 'center');
  }

  label(ctx, title, box.left, 16, PALETTE.textBright);
  label(ctx, 'P&L', box.left + box.width - 60, 16, PALETTE.pnl);
  label(ctx, 'PAYOFF', box.left + box.width - 4, 16, PALETTE.payoff, 'right');
  label(ctx, max.toFixed(2), box.left - 6, box.top + 4, PALETTE.text, 'right');
  label(ctx, min.toFixed(2), box.left - 6, box.top + box.height, PALETTE.text, 'right');
  label(ctx, sMin.toFixed(0), box.left, box.top + box.height + 16, PALETTE.text);
  label(ctx, sMax.toFixed(0), box.left + box.width, box.top + box.height + 16, PALETTE.text, 'right');

  drawFrame(ctx, box);
}

/**
 * Running Monte Carlo estimate against the analytic price, with a +/-2 sigma
 * band that narrows as paths accumulate.
 */
export function renderConvergenceChart(ctx, data) {
  const {
    estimates,
    analytic,
    stdErrors = null,
    width,
    height,
    title = 'CONVERGENCE: MC ESTIMATE vs ANALYTIC',
  } = data;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = PALETTE.background;
  ctx.fillRect(0, 0, width, height);

  const box = makeBox(width, height, { left: 52, right: 16, top: 28, bottom: 30 });
  drawGrid(ctx, box);

  if (!estimates || estimates.length < 2 || !Number.isFinite(analytic)) {
    label(ctx, 'no convergence data', box.left + 8, box.top + 18);
    drawFrame(ctx, box);
    return;
  }

  let min = analytic;
  let max = analytic;
  for (let i = 0; i < estimates.length; i += 1) {
    const band = stdErrors ? 2 * stdErrors[i] : 0;
    min = Math.min(min, estimates[i] - band);
    max = Math.max(max, estimates[i] + band);
  }
  if (max - min < 1e-9) {
    min -= 1;
    max += 1;
  }
  const span = max - min;

  const xAt = (i) => box.left + (box.width * i) / (estimates.length - 1);
  const yAt = (v) => box.top + box.height - ((v - min) / span) * box.height;

  // Analytic reference.
  ctx.strokeStyle = PALETTE.analytic;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(box.left, yAt(analytic));
  ctx.lineTo(box.left + box.width, yAt(analytic));
  ctx.stroke();
  ctx.setLineDash([]);

  // Confidence band.
  if (stdErrors) {
    ctx.fillStyle = PALETTE.band;
    ctx.beginPath();
    for (let i = 0; i < estimates.length; i += 1) {
      const x = xAt(i);
      const y = yAt(estimates[i] + 2 * stdErrors[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    for (let i = estimates.length - 1; i >= 0; i -= 1) {
      ctx.lineTo(xAt(i), yAt(estimates[i] - 2 * stdErrors[i]));
    }
    ctx.closePath();
    ctx.fill();
  }

  // Estimate line.
  ctx.strokeStyle = PALETTE.estimate;
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i < estimates.length; i += 1) {
    const x = xAt(i);
    const y = yAt(estimates[i]);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  label(ctx, title, box.left, 16, PALETTE.textBright);
  label(ctx, `analytic ${analytic.toFixed(4)}`, box.left + box.width, 16, PALETTE.analytic, 'right');
  label(ctx, max.toFixed(3), box.left - 6, box.top + 4, PALETTE.text, 'right');
  label(ctx, min.toFixed(3), box.left - 6, box.top + box.height, PALETTE.text, 'right');
  label(ctx, 'paths', box.left, box.top + box.height + 16, PALETTE.text);
  label(ctx, `${estimates.length}`, box.left + box.width, box.top + box.height + 16, PALETTE.text, 'right');

  drawFrame(ctx, box);
}
