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
 * Flattened row-major sample paths of length `n_paths * (n_steps + 1)` for
 * the Canvas fan chart. Each row starts at `s`.
 */
export function mc_paths_sample(s: number, t: number, r: number, q: number, sigma: number, n_paths: number, n_steps: number, seed: bigint): Float64Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly bs_greeks: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
    readonly bs_price: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => number;
    readonly mc_european: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: bigint) => [number, number];
    readonly mc_greeks: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: bigint) => [number, number];
    readonly mc_paths_sample: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: bigint) => [number, number];
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
