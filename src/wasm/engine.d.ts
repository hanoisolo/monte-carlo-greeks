/* tslint:disable */
/* eslint-disable */

/**
 * Black-Scholes-Merton analytic Greeks as [price, delta, gamma, vega, theta, rho].
 */
export function bs_greeks(s: number, k: number, t: number, r: number, q: number, sigma: number, is_call: boolean): Float64Array;

/**
 * Black-Scholes-Merton European option price.
 */
export function bs_price(s: number, k: number, t: number, r: number, q: number, sigma: number, is_call: boolean): number;

/**
 * Antithetic-variate Monte Carlo European price as [price, std_err].
 */
export function mc_european(s: number, k: number, t: number, r: number, q: number, sigma: number, is_call: boolean, n_paths: number, seed: bigint): Float64Array;

/**
 * Monte Carlo Greeks by central finite differences with common random
 * numbers: every bumped revaluation reuses the same normal stream, so the
 * bump differences are not contaminated by sampling noise.
 *
 * Returns [price, std_err, delta, gamma, vega, theta, rho].
 */
export function mc_greeks(s: number, k: number, t: number, r: number, q: number, sigma: number, is_call: boolean, n_paths: number, seed: bigint): Float64Array;

/**
 * Antithetic-variate Monte Carlo Merton price as [price, std_err].
 */
export function mc_merton_european(s: number, k: number, t: number, r: number, q: number, sigma: number, is_call: boolean, lambda: number, mu_j: number, delta_j: number, n_paths: number, seed: bigint): Float64Array;

/**
 * Monte Carlo Merton Greeks by central finite differences with common random
 * numbers, as [price, std_err, delta, gamma, vega, theta, rho].
 *
 * The jump count is drawn once per path and held fixed across every bumped
 * revaluation. Redrawing it per bump would contaminate the bump difference
 * with jump-count noise and make the Greeks meaningless.
 *
 * Theta needs one extra term. Holding the jump count fixed differentiates the
 * payoff with respect to maturity but leaves the Poisson intensity frozen, so
 * the estimator misses `d/dT` of the jump-count distribution. That missing
 * piece is exactly `lambda * E[f(T, N+1) - f(T, N)]`, which the `n_up`
 * accumulator evaluates with the same random draws. Without it theta is biased
 * by about -3.42 at the benchmark parameters, a 45% error.
 */
export function mc_merton_greeks(s: number, k: number, t: number, r: number, q: number, sigma: number, is_call: boolean, lambda: number, mu_j: number, delta_j: number, n_paths: number, seed: bigint): Float64Array;

/**
 * Flattened row-major Merton sample paths, including compound Poisson jumps,
 * of length `n_paths * (n_steps + 1)`. Each row starts at `s`.
 */
export function mc_merton_paths_sample(s: number, t: number, r: number, q: number, sigma: number, lambda: number, mu_j: number, delta_j: number, n_paths: number, n_steps: number, seed: bigint): Float64Array;

/**
 * Flattened row-major sample paths of length `n_paths * (n_steps + 1)` for
 * the Canvas fan chart. Each row starts at `s`.
 */
export function mc_paths_sample(s: number, t: number, r: number, q: number, sigma: number, n_paths: number, n_steps: number, seed: bigint): Float64Array;

/**
 * Merton jump-diffusion analytic Greeks as
 * [price, delta, gamma, vega, theta, rho].
 *
 * Units match `bs_greeks`: vega per 1.00 of the diffusion volatility with the
 * jump parameters held fixed, theta per 1.00 year of calendar decay, rho per
 * 1.00 of the risk-free rate.
 */
export function merton_greeks(s: number, k: number, t: number, r: number, q: number, sigma: number, is_call: boolean, lambda: number, mu_j: number, delta_j: number): Float64Array;

/**
 * Merton jump-diffusion European option price.
 */
export function merton_price(s: number, k: number, t: number, r: number, q: number, sigma: number, is_call: boolean, lambda: number, mu_j: number, delta_j: number): number;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly bs_greeks: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
    readonly bs_price: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => number;
    readonly mc_european: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: bigint) => [number, number];
    readonly mc_greeks: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: bigint) => [number, number];
    readonly mc_merton_european: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: bigint) => [number, number];
    readonly mc_merton_greeks: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: bigint) => [number, number];
    readonly mc_merton_paths_sample: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: bigint) => [number, number];
    readonly mc_paths_sample: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: bigint) => [number, number];
    readonly merton_greeks: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number];
    readonly merton_price: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
