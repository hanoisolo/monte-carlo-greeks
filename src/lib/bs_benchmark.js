// Pure-JavaScript Black-Scholes-Merton reference implementation.
//
// This exists to validate the Rust/WASM engine from the outside: it is an
// independent implementation of the same mathematics, so agreement between
// the two is evidence that the WASM boundary (argument order, bool encoding,
// Float64Array returns) is wired correctly.
//
// The normal CDF uses the regularized incomplete gamma function rather than a
// polynomial approximation, which keeps it accurate to roughly machine
// precision and lets the tests assert agreement at 1e-9.

const GAMMA_EPS = 1e-16;
const GAMMA_FPMIN = 1e-300;
const SQRT_2PI = Math.sqrt(2 * Math.PI);

const LANCZOS = [
  0.99999999999980993,
  676.5203681218851,
  -1259.1392167224028,
  771.32342877765313,
  -176.61502916214059,
  12.507343278686905,
  -0.13857109526572012,
  9.9843695780195716e-6,
  1.5056327351493116e-7,
];

export function lnGamma(x) {
  if (x < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  }
  const z = x - 1;
  let a = LANCZOS[0];
  const t = z + 7.5;
  for (let i = 1; i < LANCZOS.length; i += 1) {
    a += LANCZOS[i] / (z + i);
  }
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

function gammaSeries(a, x) {
  if (x <= 0) return 0;
  const gln = lnGamma(a);
  let ap = a;
  let del = 1 / a;
  let sum = del;
  for (let i = 0; i < 1000; i += 1) {
    ap += 1;
    del *= x / ap;
    sum += del;
    if (Math.abs(del) < Math.abs(sum) * GAMMA_EPS) break;
  }
  return sum * Math.exp(-x + a * Math.log(x) - gln);
}

function gammaCf(a, x) {
  const gln = lnGamma(a);
  let b = x + 1 - a;
  let c = 1 / GAMMA_FPMIN;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 1000; i += 1) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < GAMMA_FPMIN) d = GAMMA_FPMIN;
    c = b + an / c;
    if (Math.abs(c) < GAMMA_FPMIN) c = GAMMA_FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < GAMMA_EPS) break;
  }
  return Math.exp(-x + a * Math.log(x) - gln) * h;
}

export function normCdf(x) {
  if (x === 0) return 0.5;
  const a = 0.5;
  const z = (x * x) / 2;
  if (x > 0) {
    return z < a + 1 ? 0.5 + 0.5 * gammaSeries(a, z) : 1 - 0.5 * gammaCf(a, z);
  }
  return z < a + 1 ? 0.5 - 0.5 * gammaSeries(a, z) : 0.5 * gammaCf(a, z);
}

export function normPdf(x) {
  return Math.exp(-0.5 * x * x) / SQRT_2PI;
}

/**
 * Analytic Black-Scholes-Merton price and Greeks.
 *
 * Units match the Rust engine: vega per 1.0 of volatility, theta per 1.0 year
 * of calendar decay, rho per 1.0 of the risk-free rate.
 */
export function bsGreeks(s, k, t, r, q, sigma, isCall) {
  if (t <= 0 || sigma <= 0 || s <= 0 || k <= 0) {
    const intrinsic = isCall ? Math.max(s - k, 0) : Math.max(k - s, 0);
    let delta = 0;
    if (isCall) delta = s > k ? 1 : 0;
    else delta = s < k ? -1 : 0;
    return { price: intrinsic, delta, gamma: 0, vega: 0, theta: 0, rho: 0 };
  }

  const sqrtT = Math.sqrt(t);
  const d1 = (Math.log(s / k) + (r - q + 0.5 * sigma * sigma) * t) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;

  const dfQ = Math.exp(-q * t);
  const dfR = Math.exp(-r * t);
  const nd1 = normCdf(d1);
  const nd2 = normCdf(d2);
  const pdfD1 = normPdf(d1);

  let price;
  let delta;
  let rho;
  if (isCall) {
    price = s * dfQ * nd1 - k * dfR * nd2;
    delta = dfQ * nd1;
    rho = k * t * dfR * nd2;
  } else {
    price = k * dfR * (1 - nd2) - s * dfQ * (1 - nd1);
    delta = -dfQ * (1 - nd1);
    rho = -k * t * dfR * (1 - nd2);
  }

  const gamma = (dfQ * pdfD1) / (s * sigma * sqrtT);
  const vega = s * dfQ * pdfD1 * sqrtT;
  const decay = (-s * dfQ * pdfD1 * sigma) / (2 * sqrtT);
  const theta = isCall
    ? decay - r * k * dfR * nd2 + q * s * dfQ * nd1
    : decay + r * k * dfR * (1 - nd2) - q * s * dfQ * (1 - nd1);

  return { price, delta, gamma, vega, theta, rho };
}

export function bsPrice(s, k, t, r, q, sigma, isCall) {
  return bsGreeks(s, k, t, r, q, sigma, isCall).price;
}

/**
 * Times the WASM engine against this JS reference over `iterations` calls.
 * Returns per-call microsecond timings and the max absolute price difference,
 * so the UI can show that the WASM path is both faster and correct.
 */
export function benchmarkEngine(engine, params, iterations = 2000) {
  const { s, k, t, r, q, sigma, isCall } = params;

  const wasmStart = performance.now();
  let wasmPrice = 0;
  for (let i = 0; i < iterations; i += 1) {
    wasmPrice = engine.bs_price(s, k, t, r, q, sigma, isCall);
  }
  const wasmMs = performance.now() - wasmStart;

  const jsStart = performance.now();
  let jsPrice = 0;
  for (let i = 0; i < iterations; i += 1) {
    jsPrice = bsPrice(s, k, t, r, q, sigma, isCall);
  }
  const jsMs = performance.now() - jsStart;

  return {
    iterations,
    wasmUsPerCall: (wasmMs * 1000) / iterations,
    jsUsPerCall: (jsMs * 1000) / iterations,
    speedup: jsMs / wasmMs,
    maxAbsDiff: Math.abs(wasmPrice - jsPrice),
  };
}
