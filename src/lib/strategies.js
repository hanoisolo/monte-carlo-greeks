// Multi-leg option strategy engine.
//
// A strategy is a list of legs. Each leg carries a side (+1 long, -1 short),
// a quantity, an option type, and a strike. Everything downstream — net
// premium, net Greeks, expiry payoff, breakevens — is a linear combination of
// the per-leg values, which is what makes the linearity assertions in
// tests/test_strategies.js meaningful.
//
// The engine is injected rather than imported so the same code runs against
// the WASM module in the browser and against the WASM module in Node tests.

export const STRATEGY_PRESETS = [
  {
    id: 'single-call',
    name: 'Single Call',
    description: 'Long one at-the-money call. Directional upside, defined risk.',
    legs: [{ type: 'call', side: 1, qty: 1, strikeFactor: 1.0 }],
  },
  {
    id: 'single-put',
    name: 'Single Put',
    description: 'Long one at-the-money put. Directional downside, defined risk.',
    legs: [{ type: 'put', side: 1, qty: 1, strikeFactor: 1.0 }],
  },
  {
    id: 'straddle',
    name: 'Long Straddle',
    description: 'Long call and put at the same strike. Long volatility, no direction.',
    legs: [
      { type: 'call', side: 1, qty: 1, strikeFactor: 1.0 },
      { type: 'put', side: 1, qty: 1, strikeFactor: 1.0 },
    ],
  },
  {
    id: 'strangle',
    name: 'Long Strangle',
    description: 'Long out-of-the-money call and put. Cheaper long volatility.',
    legs: [
      { type: 'call', side: 1, qty: 1, strikeFactor: 1.05 },
      { type: 'put', side: 1, qty: 1, strikeFactor: 0.95 },
    ],
  },
  {
    id: 'bull-call-spread',
    name: 'Bull Call Spread',
    description: 'Long lower call, short higher call. Capped upside, reduced cost.',
    legs: [
      { type: 'call', side: 1, qty: 1, strikeFactor: 1.0 },
      { type: 'call', side: -1, qty: 1, strikeFactor: 1.1 },
    ],
  },
  {
    id: 'iron-condor',
    name: 'Iron Condor',
    description: 'Short put spread plus short call spread. Range-bound, defined risk.',
    legs: [
      { type: 'put', side: 1, qty: 1, strikeFactor: 0.85 },
      { type: 'put', side: -1, qty: 1, strikeFactor: 0.95 },
      { type: 'call', side: -1, qty: 1, strikeFactor: 1.05 },
      { type: 'call', side: 1, qty: 1, strikeFactor: 1.15 },
    ],
  },
  {
    id: 'butterfly',
    name: 'Long Call Butterfly',
    description: 'Long low call, short two middle calls, long high call. Pinned payoff.',
    legs: [
      { type: 'call', side: 1, qty: 1, strikeFactor: 0.9 },
      { type: 'call', side: -1, qty: 2, strikeFactor: 1.0 },
      { type: 'call', side: 1, qty: 1, strikeFactor: 1.1 },
    ],
  },
];

export function getPreset(id) {
  const preset = STRATEGY_PRESETS.find((p) => p.id === id);
  if (!preset) throw new Error(`Unknown strategy preset: ${id}`);
  return preset;
}

/**
 * Resolve a preset's strike factors into concrete strikes against a base
 * strike (the user's strike input, not the spot). Returns fresh leg objects so
 * callers can mutate them safely.
 */
export function buildLegs(preset, baseStrike) {
  return preset.legs.map((leg) => ({
    type: leg.type,
    side: leg.side,
    qty: leg.qty,
    strike: roundStrike(baseStrike * leg.strikeFactor),
  }));
}

function roundStrike(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Net premium and net Greeks for a set of legs, using the analytic engine.
 * Greeks are linear in the legs, so they simply sum with the side/qty weight.
 */
export function aggregateStrategy(engine, params, legs) {
  const { s, t, r, q, sigma } = params;
  const useMerton = params.model === 'merton' && typeof engine.merton_greeks === 'function';
  const lambda = params.lambda ?? 0;
  const muJ = params.muJ ?? 0;
  const deltaJ = params.deltaJ ?? 0;
  let price = 0;
  let delta = 0;
  let gamma = 0;
  let vega = 0;
  let theta = 0;
  let rho = 0;

  const legDetails = legs.map((leg) => {
    const isCall = leg.type === 'call';
    const g = useMerton
      ? engine.merton_greeks(s, leg.strike, t, r, q, sigma, isCall, lambda, muJ, deltaJ)
      : engine.bs_greeks(s, leg.strike, t, r, q, sigma, isCall);
    const weight = leg.side * leg.qty;
    price += weight * g[0];
    delta += weight * g[1];
    gamma += weight * g[2];
    vega += weight * g[3];
    theta += weight * g[4];
    rho += weight * g[5];
    return {
      ...leg,
      isCall,
      price: g[0],
      delta: g[1],
      gamma: g[2],
      vega: g[3],
      theta: g[4],
      rho: g[5],
      weightedPrice: weight * g[0],
    };
  });

  return { price, delta, gamma, vega, theta, rho, legDetails };
}

/**
 * Monte Carlo net premium and Greeks. Every leg is priced with the same seed,
 * so the legs share their random stream — the correct treatment for a
 * portfolio, because it cancels the sampling noise that is common to all legs.
 */
export function aggregateStrategyMonteCarlo(engine, params, legs, nPaths, seed) {
  const { s, t, r, q, sigma } = params;
  const useMerton = params.model === 'merton' && typeof engine.mc_merton_greeks === 'function';
  const lambda = params.lambda ?? 0;
  const muJ = params.muJ ?? 0;
  const deltaJ = params.deltaJ ?? 0;
  const seedBig = BigInt(seed);
  let price = 0;
  let delta = 0;
  let gamma = 0;
  let vega = 0;
  let theta = 0;
  let rho = 0;
  let variance = 0;

  for (const leg of legs) {
    const isCall = leg.type === 'call';
    const weight = leg.side * leg.qty;
    const g = useMerton
      ? engine.mc_merton_greeks(
          s,
          leg.strike,
          t,
          r,
          q,
          sigma,
          isCall,
          lambda,
          muJ,
          deltaJ,
          nPaths,
          seedBig,
        )
      : engine.mc_greeks(s, leg.strike, t, r, q, sigma, isCall, nPaths, seedBig);
    price += weight * g[0];
    delta += weight * g[2];
    gamma += weight * g[3];
    vega += weight * g[4];
    theta += weight * g[5];
    rho += weight * g[6];
    variance += (weight * g[1]) ** 2;
  }

  return { price, stdErr: Math.sqrt(variance), delta, gamma, vega, theta, rho };
}

/** Intrinsic value of one leg at expiry for a given terminal spot. */
export function legPayoffAtExpiry(leg, terminalSpot) {
  const intrinsic =
    leg.type === 'call'
      ? Math.max(terminalSpot - leg.strike, 0)
      : Math.max(leg.strike - terminalSpot, 0);
  return leg.side * leg.qty * intrinsic;
}

/**
 * Expiry payoff curve across a spot range.
 * `pnl` subtracts the net premium, so its zero crossings are the breakevens.
 */
export function computePayoffCurve(legs, netPremium, sMin, sMax, points = 241) {
  const spots = new Float64Array(points);
  const payoff = new Float64Array(points);
  const pnl = new Float64Array(points);
  const step = (sMax - sMin) / (points - 1);

  for (let i = 0; i < points; i += 1) {
    const spot = sMin + step * i;
    let total = 0;
    for (const leg of legs) {
      total += legPayoffAtExpiry(leg, spot);
    }
    spots[i] = spot;
    payoff[i] = total;
    pnl[i] = total - netPremium;
  }

  return { spots, payoff, pnl, netPremium };
}

/**
 * Breakevens by linear interpolation of the pnl curve's zero crossings.
 * A leg set that is profitable everywhere (or nowhere) has none.
 */
export function findBreakevens(legs, netPremium, sMin, sMax, points = 4001) {
  const { spots, pnl } = computePayoffCurve(legs, netPremium, sMin, sMax, points);
  const roots = [];
  for (let i = 1; i < pnl.length; i += 1) {
    const prev = pnl[i - 1];
    const curr = pnl[i];
    if (prev === 0) {
      roots.push(spots[i - 1]);
    } else if (prev * curr < 0) {
      const t = prev / (prev - curr);
      roots.push(spots[i - 1] + t * (spots[i] - spots[i - 1]));
    }
  }
  // The loop only inspects each point as the right end of an interval, so an
  // exact root sitting on the final grid point would otherwise be dropped.
  const last = pnl.length - 1;
  if (pnl[last] === 0 && (roots.length === 0 || roots[roots.length - 1] !== spots[last])) {
    roots.push(spots[last]);
  }
  return roots;
}

/** Max profit and max loss over the sampled spot range. */
export function maxProfitLoss(legs, netPremium, sMin, sMax, points = 4001) {
  const { pnl } = computePayoffCurve(legs, netPremium, sMin, sMax, points);
  let maxProfit = -Infinity;
  let maxLoss = Infinity;
  for (const v of pnl) {
    if (v > maxProfit) maxProfit = v;
    if (v < maxLoss) maxLoss = v;
  }
  return { maxProfit, maxLoss };
}
