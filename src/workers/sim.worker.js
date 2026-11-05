// Simulation worker.
//
// The WASM engine is synchronous, so a single 1,000,000-path call would block
// the worker's message queue and make cancellation impossible. Instead the job
// is split into chunks: each chunk is an independent Monte Carlo estimate with
// its own deterministic seed, and the chunk estimates are combined by an
// equal-weighted average with standard errors pooled in quadrature. That keeps
// the result deterministic while letting progress stream and cancellation land
// between chunks.
//
// `runSimulationJob` is exported so the headless integration test can drive the
// exact same code path without a Worker global.

import init, { bs_greeks, mc_greeks, mc_paths_sample } from '../wasm/engine.js';

export const CHUNK_COUNT = 8;

export class CancelledError extends Error {
  constructor(jobId) {
    super(`Simulation ${jobId} cancelled`);
    this.name = 'CancelledError';
  }
}

let engineReady = null;

/** Initialise the WASM module once per worker. */
export function ensureEngine() {
  if (!engineReady) {
    engineReady = init();
  }
  return engineReady;
}

function yieldToEventLoop() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Run one simulation job.
 *
 * @param engine  { mc_greeks, mc_paths_sample, bs_greeks }
 * @param params  { s, k, t, r, q, sigma, legs, nPaths, seed, nSamplePaths, nSteps }
 * @param hooks   { onProgress, shouldCancel }
 */
export async function runSimulationJob(engine, params, hooks = {}) {
  const started = Date.now();
  const {
    s,
    t,
    r,
    q,
    sigma,
    legs,
    nPaths,
    seed,
    nSamplePaths = 64,
    nSteps = 50,
  } = params;

  if (!Array.isArray(legs) || legs.length === 0) {
    throw new Error('runSimulationJob requires at least one leg');
  }
  if (!Number.isFinite(nPaths) || nPaths < 2) {
    throw new Error(`runSimulationJob requires nPaths >= 2, got ${nPaths}`);
  }

  const seedBig = BigInt(seed);
  const chunkCount = Math.min(CHUNK_COUNT, Math.max(1, Math.floor(nPaths / 2)));
  const perChunk = Math.max(2, Math.floor(nPaths / chunkCount));
  const totalPaths = perChunk * chunkCount;

  // Accumulators for the combined estimate.
  let priceSum = 0;
  let varianceSum = 0;
  let deltaSum = 0;
  let gammaSum = 0;
  let vegaSum = 0;
  let thetaSum = 0;
  let rhoSum = 0;

  for (let chunk = 0; chunk < chunkCount; chunk += 1) {
    if (hooks.shouldCancel && hooks.shouldCancel()) {
      throw new CancelledError(params.jobId);
    }

    // Distinct but deterministic seed per chunk; identical across legs so the
    // legs share their random stream (portfolio common random numbers).
    const chunkSeed = seedBig + BigInt(chunk) * 1_000_003n;

    for (const leg of legs) {
      const isCall = leg.type === 'call';
      const weight = leg.side * leg.qty;
      const g = engine.mc_greeks(s, leg.strike, t, r, q, sigma, isCall, perChunk, chunkSeed);
      priceSum += weight * g[0];
      varianceSum += (weight * g[1]) ** 2;
      deltaSum += weight * g[2];
      gammaSum += weight * g[3];
      vegaSum += weight * g[4];
      thetaSum += weight * g[5];
      rhoSum += weight * g[6];
    }

    const completed = (chunk + 1) * perChunk;
    if (hooks.onProgress) {
      hooks.onProgress({
        completedPaths: completed,
        totalPaths,
        partialEstimate: priceSum / (chunk + 1),
        partialStdErr: Math.sqrt(varianceSum) / (chunk + 1),
      });
    }

    await yieldToEventLoop();
  }

  const mc = {
    price: priceSum / chunkCount,
    stdErr: Math.sqrt(varianceSum) / chunkCount,
    delta: deltaSum / chunkCount,
    gamma: gammaSum / chunkCount,
    vega: vegaSum / chunkCount,
    theta: thetaSum / chunkCount,
    rho: rhoSum / chunkCount,
  };

  // Analytic benchmark for the same portfolio.
  let bsPrice = 0;
  let bsDelta = 0;
  let bsGamma = 0;
  let bsVega = 0;
  let bsTheta = 0;
  let bsRho = 0;
  for (const leg of legs) {
    const weight = leg.side * leg.qty;
    const g = engine.bs_greeks(s, leg.strike, t, r, q, sigma, leg.type === 'call');
    bsPrice += weight * g[0];
    bsDelta += weight * g[1];
    bsGamma += weight * g[2];
    bsVega += weight * g[3];
    bsTheta += weight * g[4];
    bsRho += weight * g[5];
  }
  const bs = {
    price: bsPrice,
    delta: bsDelta,
    gamma: bsGamma,
    vega: bsVega,
    theta: bsTheta,
    rho: bsRho,
  };

  const samplePaths = engine.mc_paths_sample(
    s,
    t,
    r,
    q,
    sigma,
    nSamplePaths,
    nSteps,
    seedBig,
  );

  return {
    elapsedMs: Date.now() - started,
    mc,
    bs,
    samplePaths,
    nSamplePaths,
    nSteps,
    legs,
    totalPaths,
  };
}

/**
 * Route one inbound worker message. Exported so tests can exercise the exact
 * dispatch logic without a Worker global.
 */
export async function handleMessage(engine, message, post, state) {
  const { type, jobId } = message;

  if (type === 'CANCEL_SIM') {
    if (state.currentJobId === jobId) {
      state.cancelled = true;
    }
    return;
  }

  if (type !== 'RUN_SIM') {
    post({ type: 'SIM_ERROR', jobId, message: `Unknown message type: ${type}` });
    return;
  }

  state.currentJobId = jobId;
  state.cancelled = false;

  try {
    const result = await runSimulationJob(
      engine,
      { ...message.params, jobId },
      {
        shouldCancel: () => state.cancelled,
        onProgress: (progress) => post({ type: 'SIM_PROGRESS', jobId, ...progress }),
      },
    );
    post({ type: 'SIM_COMPLETE', jobId, ...result });
  } catch (error) {
    if (error instanceof CancelledError) {
      post({ type: 'SIM_CANCELLED', jobId });
    } else {
      post({ type: 'SIM_ERROR', jobId, message: error.message });
    }
  } finally {
    if (state.currentJobId === jobId) {
      state.currentJobId = null;
    }
  }
}

// --- Worker global binding ------------------------------------------------
// Guarded so importing this module in Node (for tests) does not explode.

if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
  const state = { currentJobId: null, cancelled: false };

  self.onmessage = async (event) => {
    const post = (payload) => self.postMessage(payload);
    try {
      await ensureEngine();
      await handleMessage(
        { mc_greeks, mc_paths_sample, bs_greeks },
        event.data,
        post,
        state,
      );
    } catch (error) {
      post({
        type: 'SIM_ERROR',
        jobId: event.data && event.data.jobId,
        message: error.message,
      });
    }
  };
}
