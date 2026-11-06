/* @ts-self-types="./engine.d.ts" */

/**
 * Black-Scholes-Merton analytic Greeks as [price, delta, gamma, vega, theta, rho].
 * @param {number} s
 * @param {number} k
 * @param {number} t
 * @param {number} r
 * @param {number} q
 * @param {number} sigma
 * @param {boolean} is_call
 * @returns {Float64Array}
 */
export function bs_greeks(s, k, t, r, q, sigma, is_call) {
    const ret = wasm.bs_greeks(s, k, t, r, q, sigma, is_call);
    var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v1;
}

/**
 * Black-Scholes-Merton European option price.
 * @param {number} s
 * @param {number} k
 * @param {number} t
 * @param {number} r
 * @param {number} q
 * @param {number} sigma
 * @param {boolean} is_call
 * @returns {number}
 */
export function bs_price(s, k, t, r, q, sigma, is_call) {
    const ret = wasm.bs_price(s, k, t, r, q, sigma, is_call);
    return ret;
}

/**
 * Antithetic-variate Monte Carlo European price as [price, std_err].
 * @param {number} s
 * @param {number} k
 * @param {number} t
 * @param {number} r
 * @param {number} q
 * @param {number} sigma
 * @param {boolean} is_call
 * @param {number} n_paths
 * @param {bigint} seed
 * @returns {Float64Array}
 */
export function mc_european(s, k, t, r, q, sigma, is_call, n_paths, seed) {
    const ret = wasm.mc_european(s, k, t, r, q, sigma, is_call, n_paths, seed);
    var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v1;
}

/**
 * Monte Carlo Greeks by central finite differences with common random
 * numbers: every bumped revaluation reuses the same normal stream, so the
 * bump differences are not contaminated by sampling noise.
 *
 * Returns [price, std_err, delta, gamma, vega, theta, rho].
 * @param {number} s
 * @param {number} k
 * @param {number} t
 * @param {number} r
 * @param {number} q
 * @param {number} sigma
 * @param {boolean} is_call
 * @param {number} n_paths
 * @param {bigint} seed
 * @returns {Float64Array}
 */
export function mc_greeks(s, k, t, r, q, sigma, is_call, n_paths, seed) {
    const ret = wasm.mc_greeks(s, k, t, r, q, sigma, is_call, n_paths, seed);
    var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v1;
}

/**
 * Antithetic-variate Monte Carlo Merton price as [price, std_err].
 * @param {number} s
 * @param {number} k
 * @param {number} t
 * @param {number} r
 * @param {number} q
 * @param {number} sigma
 * @param {boolean} is_call
 * @param {number} lambda
 * @param {number} mu_j
 * @param {number} delta_j
 * @param {number} n_paths
 * @param {bigint} seed
 * @returns {Float64Array}
 */
export function mc_merton_european(s, k, t, r, q, sigma, is_call, lambda, mu_j, delta_j, n_paths, seed) {
    const ret = wasm.mc_merton_european(s, k, t, r, q, sigma, is_call, lambda, mu_j, delta_j, n_paths, seed);
    var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v1;
}

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
 * @param {number} s
 * @param {number} k
 * @param {number} t
 * @param {number} r
 * @param {number} q
 * @param {number} sigma
 * @param {boolean} is_call
 * @param {number} lambda
 * @param {number} mu_j
 * @param {number} delta_j
 * @param {number} n_paths
 * @param {bigint} seed
 * @returns {Float64Array}
 */
export function mc_merton_greeks(s, k, t, r, q, sigma, is_call, lambda, mu_j, delta_j, n_paths, seed) {
    const ret = wasm.mc_merton_greeks(s, k, t, r, q, sigma, is_call, lambda, mu_j, delta_j, n_paths, seed);
    var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v1;
}

/**
 * Flattened row-major Merton sample paths, including compound Poisson jumps,
 * of length `n_paths * (n_steps + 1)`. Each row starts at `s`.
 * @param {number} s
 * @param {number} t
 * @param {number} r
 * @param {number} q
 * @param {number} sigma
 * @param {number} lambda
 * @param {number} mu_j
 * @param {number} delta_j
 * @param {number} n_paths
 * @param {number} n_steps
 * @param {bigint} seed
 * @returns {Float64Array}
 */
export function mc_merton_paths_sample(s, t, r, q, sigma, lambda, mu_j, delta_j, n_paths, n_steps, seed) {
    const ret = wasm.mc_merton_paths_sample(s, t, r, q, sigma, lambda, mu_j, delta_j, n_paths, n_steps, seed);
    var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v1;
}

/**
 * Flattened row-major sample paths of length `n_paths * (n_steps + 1)` for
 * the Canvas fan chart. Each row starts at `s`.
 * @param {number} s
 * @param {number} t
 * @param {number} r
 * @param {number} q
 * @param {number} sigma
 * @param {number} n_paths
 * @param {number} n_steps
 * @param {bigint} seed
 * @returns {Float64Array}
 */
export function mc_paths_sample(s, t, r, q, sigma, n_paths, n_steps, seed) {
    const ret = wasm.mc_paths_sample(s, t, r, q, sigma, n_paths, n_steps, seed);
    var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v1;
}

/**
 * Merton jump-diffusion analytic Greeks as
 * [price, delta, gamma, vega, theta, rho].
 *
 * Units match `bs_greeks`: vega per 1.00 of the diffusion volatility with the
 * jump parameters held fixed, theta per 1.00 year of calendar decay, rho per
 * 1.00 of the risk-free rate.
 * @param {number} s
 * @param {number} k
 * @param {number} t
 * @param {number} r
 * @param {number} q
 * @param {number} sigma
 * @param {boolean} is_call
 * @param {number} lambda
 * @param {number} mu_j
 * @param {number} delta_j
 * @returns {Float64Array}
 */
export function merton_greeks(s, k, t, r, q, sigma, is_call, lambda, mu_j, delta_j) {
    const ret = wasm.merton_greeks(s, k, t, r, q, sigma, is_call, lambda, mu_j, delta_j);
    var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v1;
}

/**
 * Merton jump-diffusion European option price.
 * @param {number} s
 * @param {number} k
 * @param {number} t
 * @param {number} r
 * @param {number} q
 * @param {number} sigma
 * @param {boolean} is_call
 * @param {number} lambda
 * @param {number} mu_j
 * @param {number} delta_j
 * @returns {number}
 */
export function merton_price(s, k, t, r, q, sigma, is_call, lambda, mu_j, delta_j) {
    const ret = wasm.merton_price(s, k, t, r, q, sigma, is_call, lambda, mu_j, delta_j);
    return ret;
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            table.set(0, undefined);
            table.set(1024, undefined);
            table.set(1025, null);
            table.set(1026, true);
            table.set(1027, false);
        },
    };
    return {
        __proto__: null,
        "./engine_bg.js": import0,
    };
}

function getArrayF64FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
}

let cachedFloat64ArrayMemory0 = null;
function getFloat64ArrayMemory0() {
    if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
        cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64ArrayMemory0;
}

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedFloat64ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (!module.ok) {
            throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
        }

        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

let __wbg_init_promise;
async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;
    if (__wbg_init_promise === undefined) {
        __wbg_init_promise = __wbg_init_once(module_or_path);
        __wbg_init_promise.catch(() => { __wbg_init_promise = undefined; });
    }
    return __wbg_init_promise;
}

async function __wbg_init_once(module_or_path) {

    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('engine_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
