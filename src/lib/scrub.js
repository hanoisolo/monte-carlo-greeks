// Pure, DOM-free helpers for the analytic-on-scrub path.
//
// main.js imports styles.css and queries the DOM at module scope, so the
// headless suites cannot import it. The Greeks-table formatting, parameter
// validation, and debounce coordination therefore live here, where they can be
// exercised directly. Timers are injected so tests run deterministically.

export const GREEK_ROWS = [
  { key: 'price', label: 'Price' },
  { key: 'delta', label: 'Delta' },
  { key: 'gamma', label: 'Gamma' },
  { key: 'vega', label: 'Vega' },
  { key: 'theta', label: 'Theta' },
  { key: 'rho', label: 'Rho' },
];

const DASH = '—';

export function fmt(value, digits = 4) {
  return Number.isFinite(value) ? value.toFixed(digits) : DASH;
}

export function diffClass(absDiff, scale) {
  const ratio = Math.abs(absDiff) / (Math.abs(scale) || 1);
  if (ratio < 0.01) return 'diff-good';
  if (ratio < 0.05) return 'diff-warn';
  return 'diff-bad';
}

// Builds the six row view-models for the Greeks table.
//
// `mc` may be null: while scrubbing, the analytic column is fresh but the Monte
// Carlo belongs to a previous parameter set. Comparing the two would paint
// sampling noise and parameter drift the same colour, so the diff columns are
// blanked instead of computed against a stale estimate.
export function buildGreeksRows(mc, bs) {
  return GREEK_ROWS.map((row) => {
    const bsValue = bs ? bs[row.key] : NaN;
    const mcValue = mc ? mc[row.key] : NaN;
    const hasBs = Number.isFinite(bsValue);
    const hasMc = Number.isFinite(mcValue);
    const comparable = hasMc && hasBs;
    const absDiff = mcValue - bsValue;
    const relDiff = bsValue === 0 ? 0 : absDiff / Math.abs(bsValue);

    return {
      key: row.key,
      label: row.label,
      mcText: hasMc ? fmt(mcValue) : DASH,
      bsText: hasBs ? fmt(bsValue) : DASH,
      absDiffText: comparable ? fmt(absDiff) : DASH,
      relDiffText: comparable ? `${(relDiff * 100).toFixed(2)}%` : DASH,
      diffClassName: comparable ? diffClass(absDiff, bsValue) : '',
    };
  });
}

// Guards the scrub path against mid-keystroke states: an emptied number input
// reads as NaN, and a half-typed "0" would divide by zero inside the engine.
//
// Note `r` is allowed to be negative — the rate input spans -0.05 to 0.5.
export function isValidParams(params) {
  if (!params || typeof params !== 'object') return false;
  const { s, k, t, r, q, sigma, nPaths, seed, legs } = params;

  if (!Number.isFinite(s) || s <= 0) return false;
  if (!Number.isFinite(k) || k <= 0) return false;
  if (!Number.isFinite(t) || t <= 0) return false;
  if (!Number.isFinite(r)) return false;
  if (!Number.isFinite(q) || q < 0) return false;
  if (!Number.isFinite(sigma) || sigma <= 0) return false;
  if (!Number.isFinite(nPaths) || nPaths < 1) return false;
  if (!Number.isFinite(seed) || seed < 0) return false;
  if (!Array.isArray(legs) || legs.length === 0) return false;

  if (params.model === 'merton') {
    if (!Number.isFinite(params.lambda) || params.lambda < 0) return false;
    if (!Number.isFinite(params.muJ)) return false;
    if (!Number.isFinite(params.deltaJ) || params.deltaJ < 0) return false;
  }

  return true;
}

// Coordinates the two speeds of the UI: the analytic column updates on every
// scrub step, the Monte Carlo only after the user pauses.
//
// `setTimer` / `clearTimer` are injected so the tests can drive the debounce
// without real time passing.
export function createScrubController({
  onAnalytic,
  onRunMc,
  onCancelMc,
  debounceMs = 250,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let timer = null;
  let pending = false;

  function clear() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    pending = false;
  }

  function fire() {
    timer = null;
    pending = false;
    if (onRunMc) onRunMc();
  }

  return {
    // Every scrub step: drop any in-flight job, refresh the analytic column,
    // and restart the countdown to the Monte Carlo.
    scrub() {
      clear();
      if (onCancelMc) onCancelMc();
      if (onAnalytic) onAnalytic();
      pending = true;
      timer = setTimer(fire, debounceMs);
    },

    // Slider drag: refresh the analytic column and drop any in-flight job, but
    // never schedule a run. A drag produces input events faster than any
    // debounce, and a pause between steps would otherwise launch a Monte Carlo
    // mid-drag and repaint the columns under the user's hand. The run waits for
    // release (flush).
    preview() {
      clear();
      if (onCancelMc) onCancelMc();
      if (onAnalytic) onAnalytic();
    },

    // Release (slider up, dropdown chosen): same as scrub but runs the Monte
    // Carlo immediately instead of waiting out the debounce.
    flush() {
      clear();
      if (onCancelMc) onCancelMc();
      if (onAnalytic) onAnalytic();
      if (onRunMc) onRunMc();
    },

    // Cancel button: a pending timer must not resurrect a run the user stopped.
    cancelPending() {
      clear();
    },

    isPending() {
      return pending;
    },
  };
}
