# Blueprint & Segmentation: Merton Jump-Diffusion for `monte-carlo-greeks`

> **SUPERSEDED — historical record only. Do not use the numbers in this file.**
>
> The authoritative, corrected plan is [`merton-plan.md`](./merton-plan.md). This
> blueprint was the first draft and contains at least one reference value that
> was later proven wrong during implementation:
>
> - Case C call price stated here as `~12.95`; the correct value is
>   `12.761288593628759` (pinned in `crates/engine/src/lib.rs` tests).
>
> Kept for the audit trail of how the design was reached, not as a source of
> truth. See `merton-plan.md` §"Corrections" for the full list.

## 1. Architecture Decisions & Trap Resolutions

### 1.1 Where the Merton Series Lives (Trap 6: Architecture Separation)
- **Decision:** Implement the Merton (1976) semi-closed-form series in **both** `crates/engine/src/lib.rs` (`merton_core`, `merton_price`, `merton_greeks`) **and** `src/lib/bs_benchmark.js` (`mertonGreeks`, `mertonPrice`).
- **Reasoning:** `src/lib/bs_benchmark.js` exists specifically as an independent pure-JavaScript oracle to validate the Rust/WASM engine across the FFI boundary (argument order, float encoding, array unpacking, and mathematical equivalence). Putting the Merton series only in Rust would mean testing the engine against itself and losing the cross-implementation invariant (`|wasm - js| < 1e-9`) that anchors `tests/test_monte_carlo.js`. Reusing `bsGreeks` and `lnGamma` already in `src/lib/bs_benchmark.js` keeps the JS reference implementation concise (~65 lines).

---

### 1.2 Engine Export Surface
- **Decision:** Leave all 5 existing `#[wasm_bindgen]` exports (`bs_price`, `bs_greeks`, `mc_european`, `mc_greeks`, `mc_paths_sample`) **100% unchanged** in signature and behavior, and add **5 additive exports**:
  ```rust
  #[wasm_bindgen]
  pub fn merton_price(
      s: f64, k: f64, t: f64, r: f64, q: f64, sigma: f64, is_call: bool,
      lambda: f64, mu_j: f64, delta_j: f64,
  ) -> f64

  #[wasm_bindgen]
  pub fn merton_greeks(
      s: f64, k: f64, t: f64, r: f64, q: f64, sigma: f64, is_call: bool,
      lambda: f64, mu_j: f64, delta_j: f64,
  ) -> Vec<f64> // [price, delta, gamma, vega, theta, rho]

  #[wasm_bindgen]
  pub fn mc_merton_european(
      s: f64, k: f64, t: f64, r: f64, q: f64, sigma: f64, is_call: bool,
      lambda: f64, mu_j: f64, delta_j: f64, n_paths: u32, seed: u64,
  ) -> Vec<f64> // [price, std_err]

  #[wasm_bindgen]
  pub fn mc_merton_greeks(
      s: f64, k: f64, t: f64, r: f64, q: f64, sigma: f64, is_call: bool,
      lambda: f64, mu_j: f64, delta_j: f64, n_paths: u32, seed: u64,
  ) -> Vec<f64> // [price, std_err, delta, gamma, vega, theta, rho]

  #[wasm_bindgen]
  pub fn mc_merton_paths_sample(
      s: f64, t: f64, r: f64, q: f64, sigma: f64,
      lambda: f64, mu_j: f64, delta_j: f64, n_paths: u32, n_steps: u32, seed: u64,
  ) -> Vec<f64> // flat row-major n_paths * (n_steps + 1)
  ```
- **Reasoning:**
  1. `#[wasm_bindgen]` does not support default arguments cleanly without changing JS call signatures, and all 4 existing test suites call the 5 existing exports positionally.
  2. Returning the exact same positional 6-tuple `[price, delta, gamma, vega, theta, rho]` from `merton_greeks` and 7-tuple `[price, std_err, delta, gamma, vega, theta, rho]` from `mc_merton_greeks` allows downstream consumers (`sim.worker.js`, `strategies.js`, `main.js`) to destructure results identically without branching on tuple layout.
  3. Internally, `mc_paths_sample` and `mc_merton_paths_sample` share a single helper `paths_sample_core(...)` so no simulation logic is duplicated.

---

### 1.3 Worker & Strategy Parameter Contract (`params`)
- **Decision:** Extend `params` in `src/workers/sim.worker.js` (and `aggregateStrategy` in `src/lib/strategies.js`) with defaulted fields:
  ```js
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
    model = 'bs',
    lambda = 0,
    muJ = 0,
    deltaJ = 0,
  } = params;
  ```
- **Reasoning:**
  - When `model === 'bs'` (or omitted, as in all existing tests), `runSimulationJob` calls `engine.mc_greeks`, `engine.bs_greeks`, and `engine.mc_paths_sample` — preserving compatibility with `tests/test_integration.js`, which passes a hand-constructed `const engine = { mc_greeks, mc_paths_sample, bs_greeks }` object.
  - When `model === 'merton'`, `runSimulationJob` dispatches to `engine.mc_merton_greeks`, `engine.merton_greeks`, and `engine.mc_merton_paths_sample`, populating the same `{ mc, bs, samplePaths, ... }` response shape so the convergence comparison contract (`mc` vs closed-form `bs`) remains intact.

---

### 1.4 Fan Chart (`mc_paths_sample` vs `mc_merton_paths_sample`)
- **Decision:** Include compound Poisson jumps in the fan chart when `model === 'merton'` via `mc_merton_paths_sample`, backed by a unified internal function `paths_sample_core(s, t, r, q, sigma, lambda, mu_j, delta_j, n_paths, n_steps, seed)`.
- **Reasoning:**
  - Over each time step $\Delta t = T / n_{\text{steps}}$, the log-return is:
    $$\Delta \ln S = \left(r - q - \lambda \kappa - \frac{1}{2}\sigma^2\right)\Delta t + \sigma \sqrt{\Delta t}\,Z + N_{\Delta t}\mu_J + \sqrt{N_{\Delta t}}\,\delta_J Z_J, \quad N_{\Delta t} \sim \text{Poisson}(\lambda \Delta t).$$
  - When `lambda <= 0.0`, `paths_sample_core` skips both `next_poisson` and `z_j` draws, so `mc_paths_sample` (which calls `paths_sample_core(..., 0.0, 0.0, 0.0, ...)`) and `mc_merton_paths_sample(..., 0.0, mu_j, delta_j, ...)` are **bit-for-bit identical**.

---

### 1.5 Definition of Vega Under Merton (Trap 3)
- **Decision:** Define `vega` under Merton as **diffusion-volatility vega**: the partial derivative $\frac{\partial P}{\partial \sigma}$ with respect to the continuous diffusion volatility $\sigma$ (per `1.00` of $\sigma$), holding jump parameters $(\lambda, \mu_J, \delta_J)$ fixed.
- **Mathematical Derivation (Trap 3 — Vega Chain Rule):**
  In the Merton series:
  $$P = \sum_{n=0}^{\infty} w_n\,\text{BS}(S, K, T, r_n, q, \sigma_n), \quad \sigma_n = \sqrt{\sigma^2 + \frac{n\delta_J^2}{T}}.$$
  Because $w_n$ and $r_n$ are independent of $\sigma$, and $\frac{\partial \sigma_n}{\partial \sigma} = \frac{\sigma}{\sigma_n}$:
  $$\mathcal{V}_{\text{Merton}} = \frac{\partial P}{\partial \sigma} = \sum_{n=0}^{\infty} w_n\,\mathcal{V}_{\text{BS}}(S, K, T, r_n, q, \sigma_n)\cdot\frac{\sigma}{\sigma_n}$$
  (with $\frac{\sigma}{\sigma_n} = 0$ if $\sigma = 0$ and $\sigma_n = 0$).
  This matches the central finite-difference bump `sigma ± d_sigma` in `mc_merton_greeks`. Both Rust and JS doc comments will state explicitly that `vega` is sensitivity to the diffusion component $\sigma$ with jump parameters held fixed.

---

### 1.6 Resolution of Remaining Traps (Traps 1, 2, 4, 5)

#### Trap 1 & Trap 4: CRN Jump Draws and Unbiased Theta in Both Series and MC
1. **Analytic Series Theta ($\Theta_{\text{Merton}} = -\frac{dP}{dT}$) — Trap 4:**
   In $P(T) = \sum_{n=0}^{\infty} w_n(T)\,\text{BS}(S, K, T, r_n(T), q, \sigma_n(T))$, maturity $T$ enters in four places:
   - Poisson weight $w_n(T) = e^{-L} L^n / n!$ where $L(T) = \lambda(1 + \kappa)T \implies \frac{dw_n}{dT} = w_n \frac{n - L}{T}$
   - Explicit maturity $T$ in $\text{BS}_n \implies \frac{\partial \text{BS}_n}{\partial T} = -\theta_n$
   - Effective rate $r_n(T) = r - \lambda\kappa + \frac{n\ln(1+\kappa)}{T} \implies \frac{dr_n}{dT} = -\frac{n\ln(1+\kappa)}{T^2}$
   - Effective volatility $\sigma_n(T) = \sqrt{\sigma^2 + \frac{n\delta_J^2}{T}} \implies \frac{d\sigma_n}{dT} = -\frac{n\delta_J^2}{2 T^2 \sigma_n}$

   By the chain and product rules, the exact total derivative $-\frac{dP}{dT}$ is computed in a **single pass** using the `[price_n, delta_n, gamma_n, vega_n, theta_n, rho_n]` tuple already returned by `bs_core`:
   $$\Theta_{\text{Merton}} = -\frac{dP}{dT} = \sum_{n=0}^{\infty} w_n \left[ \theta_n - \frac{n - L}{T}\text{price}_n + \frac{n\ln(1+\kappa)}{T^2}\rho_n + \frac{n\delta_J^2}{2 T^2 \sigma_n}\text{vega}_n \right].$$
   When $\lambda = 0$, $L = 0$ and only $n = 0$ is non-zero, so the three extra terms vanish identically (`0.0`) and $\Theta_{\text{Merton}}$ equals $\Theta_{\text{BS}}$ to 0 ULPs.

2. **Monte Carlo CRN & Theta — Trap 1 & Trap 4 Combined:**
   - Per path pair, when `lambda > 0.0`, draw `(z, n_jumps, z_j)` **once**:
     - `z = rng.next_normal()`
     - `n_jumps = rng.next_poisson(lambda * t)`
     - `z_j = rng.next_normal()`
   - Reuse `(zz, n_jumps, zz_j)` for the antithetic pair `(z, n_jumps, z_j)` and `(-z, n_jumps, -z_j)` across all bumped revaluations (`s ± ds`, `sigma ± d_sigma`, `r ± d_r`, `t - d_t`).
   - **Critical Theta subtlety:** Holding $N \sim \text{Poisson}(\lambda T)$ fixed at `t - d_t` differentiates $g_n(T) = e^{-\lambda\kappa T}(1+\kappa)^n \text{BS}_n(T)$ with respect to $T$ (capturing explicit $T$, $r_n(T)$, and $\sigma_n(T)$), **except** it holds the Poisson distribution $p_n(T) = e^{-\lambda T}(\lambda T)^n / n!$ fixed at $T$.
   - Because $\frac{dp_n(T)}{dT} = \lambda\big(p_{n-1}(T) - p_n(T)\big)$, the missing Poisson-intensity time derivative is identically:
     $$\sum_{n=0}^{\infty} p_n'(T)\,g_n(T) = \lambda\,\mathbb{E}_{N \sim \text{Poisson}(\lambda T)}\Big[g_{N+1}(T) - g_N(T)\Big].$$
   - Therefore, in `mc_merton_greeks`, we also accumulate one additional CRN evaluation `n_up` at `(t, n_jumps + 1)` using the **same** `(zz, zz_j)` and compute:
     $$\Theta_{\text{MC}} = \frac{\text{t\_dn} - \text{base\_sum}}{d_t \cdot n} - \lambda\,\frac{\text{n\_up} - \text{base\_sum}}{n}.$$
   - This estimator is **100% unbiased** for the full $-\frac{dP}{dT}$ of the Merton series, introduces **zero $1/d_t$ jump-count variance**, and vanishes identically when $\lambda = 0$.

#### Trap 2: `lambda = 0` Bit-for-Bit Reduction
- When `lambda <= 0.0`:
  - `Xoshiro256::next_poisson(mean)` returns `0` immediately without calling `next_f64()`.
  - `mc_merton_european`, `mc_merton_greeks`, and `paths_sample_core` do not draw `z_j` when `lambda <= 0.0`.
  - Consequently, for `lambda = 0.0` (and any `mu_j`, `delta_j`), `mc_merton_european`, `mc_merton_greeks`, and `mc_merton_paths_sample` consume the **exact same `Xoshiro256` normal stream** and perform the exact same floating-point operations as `mc_european`, `mc_greeks`, and `mc_paths_sample`, guaranteeing bit-for-bit equality (`assert_eq!`).

#### Trap 5: Poisson Sampling Cost & Series Truncation
- **In `Xoshiro256::next_poisson(&mut self, mean: f64) -> u32`:**
  1. If `mean <= 0.0 || !mean.is_finite()`, return `0` (0 uniforms consumed).
  2. Cap `let m = mean.min(1000.0);`.
  3. For `m <= 30.0`, use Knuth's exact multiplicative algorithm (`p *= self.next_f64().max(1e-15)` until `p <= (-m).exp()`, with hard loop guard `k >= 500`).
  4. For `m > 30.0`, use an $O(1)$ normal-approximation fallback `(m + m.sqrt() * self.next_normal()).round().max(0.0) as u32` so path simulation stays $O(1)$ per path even for large $\lambda T$.
- **In `merton_core` series summation:**
  - If `lambda <= 0.0`, return `bs_core(s, k, t, r, q, sigma, is_call)` immediately.
  - Otherwise, compute $L = \lambda T (1 + \kappa)$ (capped at `500.0`) and sum $n = 0 \dots 500$.
  - For $L \le 50$, update weights via $w_0 = e^{-L}, w_n = w_{n-1} \cdot (L / n)$; for $L > 50$, compute $w_n = \exp(-L + n\ln L - \ln\Gamma(n+1))$ via `ln_gamma` to avoid $e^{-L}$ underflow.
  - Break when `n as f64 > l && w_n < 1e-15` (waiting until `n > L` ensures the loop never terminates before reaching the Poisson mode $n \approx L$).

---

## 2. Ordered Segment Plan

### Segment 1: Rust Engine — Merton Analytic Series & Monte Carlo Jump-Diffusion
- **Files to Modify (1 file):**
  - `crates/engine/src/lib.rs`
- **Functions to Create / Modify:**
  - `Xoshiro256::next_poisson(&mut self, mean: f64) -> u32`
  - `merton_core(s: f64, k: f64, t: f64, r: f64, q: f64, sigma: f64, is_call: bool, lambda: f64, mu_j: f64, delta_j: f64) -> [f64; 6]`
  - `#[wasm_bindgen] pub fn merton_price(...) -> f64`
  - `#[wasm_bindgen] pub fn merton_greeks(...) -> Vec<f64>`
  - `discounted_payoff_merton(s: f64, k: f64, t: f64, r: f64, q: f64, sigma: f64, is_call: bool, lambda: f64, kappa: f64, mu_j: f64, delta_j: f64, z: f64, n_jumps: u32, z_j: f64) -> f64`
  - `#[wasm_bindgen] pub fn mc_merton_european(...) -> Vec<f64>`
  - `#[wasm_bindgen] pub fn mc_merton_greeks(...) -> Vec<f64>`
  - `paths_sample_core(...) -> Vec<f64>` and `#[wasm_bindgen] pub fn mc_merton_paths_sample(...) -> Vec<f64>` (refactoring `mc_paths_sample` to delegate to `paths_sample_core` with `lambda = 0.0`)
  - Additive `#[test]` functions in `mod tests`:
    - `merton_zero_lambda_matches_bs_analytic_and_mc_bit_for_bit`
    - `merton_zero_jump_size_reduces_to_bs_across_series`
    - `merton_put_call_parity_and_greek_symmetries_hold`
    - `merton_analytic_greeks_match_series_finite_differences`
    - `mc_merton_price_and_greeks_converge_to_series`
    - `mc_merton_paths_sample_shape_and_zero_lambda_equivalence`
- **Concrete Goal:** Implement the complete deterministic Merton jump-diffusion engine (semi-closed-form series and CRN Monte Carlo) in Rust and prove all mathematical invariants via `cargo test`.
- **Verification Gate:**
  ```
  cargo test --manifest-path crates/engine/Cargo.toml
  ```
  **Expected Gate Assertion:** All 13 original Rust tests plus the 6 new Merton tests (19 total) compile and pass with 0 failures.

---

### Segment 2: WASM Artifact Build & Independent JS Merton Reference
- **Ordering Constraint:** Must land after Segment 1 (`crates/engine/src/lib.rs`).
- **Files to Modify (3 files):**
  - `src/lib/bs_benchmark.js`
  - `src/wasm/engine.js` (generated by `npm run build:wasm`)
  - `src/wasm/engine_bg.wasm` (generated by `npm run build:wasm`, along with `.d.ts` files in `src/wasm/`)
- **Functions to Create / Modify:**
  - In `src/lib/bs_benchmark.js`:
    - `export function mertonGreeks(s, k, t, r, q, sigma, isCall, lambda, muJ, deltaJ)` -> returns `{ price, delta, gamma, vega, theta, rho }`
    - `export function mertonPrice(s, k, t, r, q, sigma, isCall, lambda, muJ, deltaJ)` -> returns `number`
    - Update `export function benchmarkEngine(engine, params, iterations = 2000)` so if `params.model === 'merton'`, it benchmarks `engine.merton_price` vs `mertonPrice`.
  - Regenerate `src/wasm/` via `npm run build:wasm`.
- **Concrete Goal:** Expose the new Merton WASM exports to JS and provide an independent pure-JS Merton series reference in `src/lib/bs_benchmark.js`.
- **Verification Gate:**
  ```
  npm run build:wasm
  ```
  followed by:
  ```
  node tests/test_monte_carlo.js
  ```
  **Expected Gate Assertion:** `wasm-pack` succeeds, `src/wasm/engine.js` exports `merton_price`, `merton_greeks`, `mc_merton_european`, `mc_merton_greeks`, `mc_merton_paths_sample`, and all existing checks in `tests/test_monte_carlo.js` pass unmodified.

---

### Segment 3: Worker & Strategy Merton Dispatch
- **Ordering Constraint:** Must land after Segment 2 (`src/wasm/engine.js` exports).
- **Files to Modify (2 files):**
  - `src/workers/sim.worker.js`
  - `src/lib/strategies.js`
- **Functions to Create / Modify:**
  - In `src/workers/sim.worker.js`:
    - Import `merton_greeks`, `mc_merton_greeks`, `mc_merton_paths_sample` from `../wasm/engine.js`.
    - In `runSimulationJob(engine, params, hooks)`: extract `model = 'bs', lambda = 0, muJ = 0, deltaJ = 0` from `params`. When `model === 'merton'`, call `engine.mc_merton_greeks(...)`, `engine.merton_greeks(...)`, and `engine.mc_merton_paths_sample(...)`; otherwise call the existing Black-Scholes methods. Include `model` in the returned result object.
    - In `self.onmessage`: pass `{ mc_greeks, mc_paths_sample, bs_greeks, merton_greeks, mc_merton_greeks, mc_merton_paths_sample }` to `handleMessage`.
  - In `src/lib/strategies.js`:
    - In `aggregateStrategy(engine, params, legs)`: when `params.model === 'merton'` and `typeof engine.merton_greeks === 'function'`, call `engine.merton_greeks(s, leg.strike, t, r, q, sigma, leg.type === 'call', params.lambda ?? 0, params.muJ ?? 0, params.deltaJ ?? 0)`; otherwise call `engine.bs_greeks(...)`.
- **Concrete Goal:** Enable multi-leg Merton simulations and analytic benchmarks in the worker and strategy aggregator without breaking existing Black-Scholes callers or mock engine objects.
- **Verification Gate:**
  ```
  node tests/test_integration.js
  ```
  **Expected Gate Assertion:** All existing integration checks in `tests/test_integration.js` pass without modification.

---

### Segment 4: Additive Merton Engine & Integration Test Gates
- **Ordering Constraint:** Must land after Segments 1, 2, and 3.
- **Files to Modify (2 files):**
  - `tests/test_monte_carlo.js`
  - `tests/test_integration.js`
- **Functions / Test Blocks to Add:**
  - In `tests/test_monte_carlo.js` (strictly additive `ok(...)` blocks at the end of the file):
    1. `WASM merton_price matches JS mertonPrice within 1e-9` across call/put and 4 parameter sets.
    2. `WASM merton_greeks matches JS mertonGreeks within 1e-9` for call and put (`[price, delta, gamma, vega, theta, rho]`).
    3. `Merton lambda=0 reproduces BS analytic and MC bit-for-bit` (`assert.deepEqual` on `mc_merton_european` vs `mc_european`, `mc_merton_greeks` vs `mc_greeks`, and `mc_merton_paths_sample` vs `mc_paths_sample`).
    4. `Merton muJ=0, deltaJ=0 with lambda>0 reduces to textbook BS price and Greeks within 1e-12`.
    5. `Merton analytic Greeks match central finite differences of merton_price` (validating Vega chain rule $\sigma/\sigma_n$ and Theta $-dP/dT$).
    6. `Merton put-call parity holds in WASM and JS within 1e-10`.
    7. `mc_merton_european and mc_merton_greeks converge to mertonGreeks for call and put` (`PATHS = 100_000`, `SEED = 42n`).
  - In `tests/test_integration.js` (strictly additive `ok` / `okAsync` blocks at the end of the file):
    1. `Merton strategy -> worker -> WASM pipeline completes and converges` (straddle with `model: 'merton', lambda: 1.0, muJ: -0.1, deltaJ: 0.15`, asserting `|mc.price - bs.price| <= 3 * mc.stdErr`, relative Greek convergence, and matching `aggregateStrategy`).
    2. `Merton worker pipeline with lambda=0 reproduces Black-Scholes pipeline bit-for-bit` (`assert.deepEqual(mertonZero.mc, bsResult.mc)` and `assert.deepEqual(mertonZero.samplePaths, bsResult.samplePaths)`).
- **Concrete Goal:** Lock in all Merton numerical, architectural, and worker-contract invariants in the automated Node test suite.
- **Verification Gate:**
  ```
  npm test
  ```
  **Expected Gate Assertion:** All 4 Node test suites (`test_monte_carlo.js`, `test_strategies.js`, `test_canvas_renderer.js`, `test_integration.js`) pass with 0 failures.

---

### Segment 5 (Optional Follow-On): Terminal UI Model Toggle
- **Ordering Constraint:** Must land after Segment 4.
- **Files to Modify (2 files):**
  - `index.html`
  - `src/main.js`
- **Functions / Elements to Create / Modify:**
  - In `index.html`: Add a `<select id="param-model">` (`bs` = "Black-Scholes", `merton` = "Merton Jump-Diffusion") and jump parameter inputs (`#param-lambda`, `#param-mu-j`, `#param-delta-j`, hidden or disabled when `model === 'bs'`).
  - In `src/main.js`: Read `model`, `lambda`, `muJ`, `deltaJ` in `readParams()`, toggle jump input visibility on model change, and pass them in `RUN_SIM` worker messages and `aggregateStrategy` calls.
- **Concrete Goal:** Expose the Merton model and jump parameters in the browser UI while keeping all headless tests green.
- **Verification Gate:**
  ```
  npm test
  ```
  **Expected Gate Assertion:** All 4 Node test suites pass with 0 failures.

---

## 3. Specific Numeric Test Values & Tolerances

### 3.1 Exact / Machine-Precision Identities
1. **Case A — Zero-Jump Intensity Reduction ($\lambda = 0$):**
   - Inputs: $S = 100, K = 100, T = 1.0, r = 0.05, q = 0.0, \sigma = 0.20, \lambda = 0.0, \mu_J = -0.10, \delta_J = 0.15$.
   - Expected Analytic Call `[price, delta, gamma, vega, theta, rho]`:
     - `price`: `10.4505836` (tolerance `1e-6` vs textbook, `0.0` exact equality vs `bs_greeks`)
     - `delta`: `0.6368307` (tolerance `1e-6`)
     - `gamma`: `0.0187620` (tolerance `1e-6`)
     - `vega`: `37.5240345` (tolerance `1e-5`)
     - `theta`: `-6.4140275` (tolerance `1e-5`)
     - `rho`: `53.2324818` (tolerance `1e-5`)
   - Expected Monte Carlo (`n_paths = 20_000, seed = 42`):
     - `mc_merton_european` == `mc_european` (**exact bit-for-bit equality**, `0` tolerance)
     - `mc_merton_greeks` == `mc_greeks` (**exact bit-for-bit equality**, `0` tolerance)
     - `mc_merton_paths_sample` == `mc_paths_sample` (**exact bit-for-bit equality**, `0` tolerance)

2. **Case B — Zero-Size Jumps with Non-Zero Poisson Intensity ($\lambda = 1.5, \mu_J = 0.0, \delta_J = 0.0$):**
   - Inputs: $S = 100, K = 100, T = 1.0, r = 0.05, q = 0.0, \sigma = 0.20, \lambda = 1.5, \mu_J = 0.0, \delta_J = 0.0$.
   - Here $\kappa = 0, L = 1.5, r_n = r, \sigma_n = \sigma$, so all ~20 active Poisson weights $w_n = e^{-1.5} 1.5^n / n!$ are exercised and sum to `1.0`, while $\sum w_n (n - L) = 0$.
   - Expected Analytic Call & Put `[price, delta, gamma, vega, theta, rho]`: matches `bs_greeks(100, 100, 1, 0.05, 0, 0.2, is_call)` within **`1e-12`**.

3. **Case C — Non-Trivial Jump-Diffusion Benchmark ($S = 100, K = 100, T = 1.0, r = 0.05, q = 0.0, \sigma = 0.20, \lambda = 1.0, \mu_J = -0.10, \delta_J = 0.15$):**
   - Intermediate constants (exact):
     - $\ln(1 + \kappa) = \mu_J + \frac{1}{2}\delta_J^2 = -0.08875$
     - $\kappa = e^{-0.08875} - 1 \approx -0.0849256464$
     - $L = \lambda T (1 + \kappa) \approx 0.9150743536$
   - Expected Call Price: **~`12.95`** *(flagged as 2-decimal hand-summed estimate across $n = 0\dots 5$; the test gates will assert exact cross-implementation agreement `|wasm - js| < 1e-9`, Put-Call parity `< 1e-10`, finite-difference Greek agreement `< 1e-6`, and `merton_price > bs_price` rather than hardcoding an unverified 7th decimal digit).*
   - Analytic Series Greeks vs Central Finite Differences of `merton_price` ($h_S = 10^{-4}, h_\sigma = 10^{-5}, h_r = 10^{-5}, h_T = 10^{-5}$):
     - `|delta - FD_S| < 1e-7`
     - `|gamma - FD_SS| < 1e-5`
     - `|vega - FD_sigma| < 1e-6`
     - `|theta - (-FD_T)| < 1e-6`
     - `|rho - FD_r| < 1e-6`

4. **Monte Carlo vs Analytic Series Convergence Tolerances (Case C, `seed = 42`, `100,000`–`200,000` paths):**
   - `price`: `|mc_price - series.price| < 3 * std_err` and `< 0.08`
   - `delta`: `|mc_delta - series.delta| < 0.008`
   - `gamma`: `|mc_gamma - series.gamma| < 0.003`
   - `vega`: `|mc_vega - series.vega| < 0.25`
   - `theta`: `|mc_theta - series.theta| < 0.18`
   - `rho`: `|mc_rho - series.rho| < 0.18`

---

## 4. Assumptions, Risks & Verification Summary

### Assumptions Made
1. `wasm-pack` and `cargo` are available in the local development environment so `npm run build:wasm` can regenerate `src/wasm/` when `crates/engine/src/lib.rs` is updated.
2. All 4 existing test files (`tests/test_monte_carlo.js`, `tests/test_strategies.js`, `tests/test_canvas_renderer.js`, `tests/test_integration.js`) are run via `npm test`.
3. Under Merton, `vega` in the 6-tuple/7-tuple represents diffusion-volatility vega ($\partial P / \partial \sigma$ with $\lambda, \mu_J, \delta_J$ fixed).

### Risks & Mitigations
1. **Risk — MC Theta bias under fixed jump count $N$:** Holding $N \sim \text{Poisson}(\lambda T)$ fixed at $T - d_t$ misses the Poisson weight derivative $\frac{dp_n}{dT}$.
   - **Mitigation:** Include the exact CRN Poisson generator shift $-\lambda (f(T, N+1) - f(T, N))$ alongside the continuous bump $(f(T - d_t, N) - f(T, N)) / d_t$, eliminating bias without adding $1/d_t$ jump-count variance.
2. **Risk — Premature series termination for large $\lambda T$:** Stopping when $w_n < 10^{-15}$ without checking $n > L$ would terminate at $n = 0$ if $e^{-L} < 10^{-15}$.
   - **Mitigation:** Only check `w_n < 1e-15` after passing the mode (`n as f64 > l`), and use `ln_gamma` when $L > 50$.
3. **Risk — Breaking existing tests that pass a minimal `engine` mock:** `tests/test_integration.js` passes `{ mc_greeks, mc_paths_sample, bs_greeks }`.
   - **Mitigation:** Default `model = 'bs'` in `sim.worker.js` and `strategies.js` so Merton exports are only invoked when `model === 'merton'`.

### Verification Steps per Deliverable
- **Deliverable 1 (Rust Engine):** `cargo test --manifest-path crates/engine/Cargo.toml`
- **Deliverable 2 (WASM Build & JS Benchmark):** `npm run build:wasm` and `node tests/test_monte_carlo.js`
- **Deliverable 3 (Worker & Strategy Integration):** `node tests/test_integration.js`
- **Deliverable 4 (Full Additive Test Suite):** `npm test`