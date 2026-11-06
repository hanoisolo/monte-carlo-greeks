# Stage 3 — Plan Review Response

> **SUPERSEDED — historical record only. Do not use the numbers in this file.**
>
> The authoritative, corrected plan is [`merton-plan.md`](./merton-plan.md). This
> review contains reference values that were later proven wrong during
> implementation:
>
> - Vega stated here as `32.228547`; the correct analytic value is
>   `29.061466214323875` (`34.95315834084752` is the *naive* value that omits the
>   `sigma/sigma_n` chain rule — it is the wrong answer, not a variant).
> - Delta stated here as `0.6515678916789112`; that is the Monte Carlo estimate.
>   The analytic delta is `0.6496595499945675`.
> - This review also describes a `spare: Option<f64>` cache in `next_normal()`.
>   No such field exists (`crates/engine/src/lib.rs:173`).
>
> Kept for the audit trail of how the design was reached, not as a source of
> truth. See `merton-plan.md` §"Corrections" for the full list.

All six amendments are mathematically sound and improve the fault isolation and gate strength of the blueprint. Below are direct answers to your three questions, a review of each amendment with two minor implementation guardrails, and the locked segment execution schedule.

---

## 1. Answers to Your Three Questions

### Q1: Is Amendment 3 (drop the normal approximation, cap at $\lambda T \le 50$, error above) correct, or is there a reason the biased fallback is acceptable here?
**Amendment 3 is 100% correct — drop the normal approximation.** There are three independent reasons why the normal fallback is the wrong choice here:
1. **Distribution & Convergence Bias:** A rounded normal $(m + \sqrt{m}Z).\text{round}()$ has skewness $0$ instead of the true Poisson skewness $1/\sqrt{m}$ and introduces continuity/rounding bias. Its expectation under the nonlinear option payoff does not converge to the Merton series as $N_{\text{paths}} \to \infty$.
2. **RNG Stream Hygiene (`Xoshiro256` Box-Muller Cache):** In `crates/engine/src/lib.rs`, `Xoshiro256::next_normal()` reads and writes the cached `spare: Option<f64>` slot, whereas Knuth's algorithm only calls `self.next_f64()`. Switching to `next_normal()` above a threshold would alter the Box-Muller pairing of the diffusion draw `z` and jump normal `z_j`.
3. **Numerical Safety & Speed at $\lambda T \le 50$:** In IEEE-754 `f64`, $e^{-50} \approx 1.9287 \times 10^{-22} \gg \text{f64::MIN\_POSITIVE}$ ($2.225 \times 10^{-308}$). Because Knuth's loop terminates on the exact iteration where `p <= (-mean).exp()`, `p` never approaches subnormal range for $m \le 50$, and 50 uniform draws cost ~100 ns per path. PTRS is unnecessary complexity for a parameter regime ($\lambda T > 50$) that never occurs in equity or FX jump-diffusion.
- **Implementation specification for $\lambda T > 50$:** Enforce `assert!(mean <= 50.0, "Poisson mean lambda * t exceeds maximum supported value of 50.0")` (and equivalently in `merton_core` / JS `mertonGreeks` if `lambda * t > 50.0`, throw a `RangeError('lambda * t exceeds maximum supported value of 50.0')`).

### Q2: Does splitting Segment 1 into 1a / 1b / 1c break any dependency you relied on?
**No.** The internal call graph in `crates/engine/src/lib.rs` is strictly acyclic along `1a -> 1b -> 1c`, provided the originally planned test `merton_zero_lambda_matches_bs_analytic_and_mc_bit_for_bit` is split so 1a only tests the analytic series and 1b tests the MC functions:
- **Segment 1a (`next_poisson`, `merton_core`, `merton_price`, `merton_greeks`):** Calls only existing `bs_core` and `Xoshiro256::next_f64`. Includes 4 analytic unit tests (`merton_zero_lambda_matches_bs_analytic`, `merton_zero_jump_size_reduces_to_bs_across_series`, `merton_put_call_parity_and_greek_symmetries_hold`, `merton_analytic_greeks_match_series_finite_differences`). Note: include a `#![allow(dead_code)]` or a tiny unit test on `next_poisson(0.0) == 0` in 1a so `rustc` does not emit an unused-method warning on `next_poisson` before 1b lands.
- **Segment 1b (`discounted_payoff_merton`, `mc_merton_european`, `mc_merton_greeks`):** Calls `next_poisson` and `merton_greeks` from 1a. Includes 2 MC unit tests (`merton_zero_lambda_mc_matches_bs_mc_bit_for_bit`, `mc_merton_price_and_greeks_converge_to_series`).
- **Segment 1c (`paths_sample_core` refactor, `mc_merton_paths_sample`):** Calls `next_poisson` from 1a. Includes 1 path-sampling unit test (`mc_merton_paths_sample_shape_and_zero_lambda_equivalence`).

### Q3: Is there a gate missing that would catch a wrong $\sigma/\sigma_n$ vega factor?
**No gate is missing — two independent gates catch it by huge margins:**
1. **Analytic vs. Central Finite-Difference Gate (Segment 1a & Segment 4):**
   For Case C ($S=100, K=100, T=1, r=0.05, q=0, \sigma=0.2, \lambda=1.0, \mu_J=-0.1, \delta_J=0.15$), true analytic vega is `29.061466214323875`. Omitting the $\sigma/\sigma_n$ chain-rule factor yields $\sum w_n \mathcal{V}_{\text{BS}}(\sigma_n) = 32.228547$, an error of **`+3.167`** ($10.9\%$). With the gate tolerance of `1e-6` against central finite differences of `merton_price(sigma ± 1e-5)`, a missing $\sigma/\sigma_n$ factor fails by **$3.17 \times 10^6\times$**.
2. **MC vs. Analytic Series Gate (Segment 1b & Segment 4):**
   Because `mc_merton_greeks` bumps $\sigma \pm d_\sigma$ directly while holding $\delta_J$ fixed, MC estimates the true partial derivative ($\approx 29.06$). Against the `0.25` MC vega tolerance, an unscaled analytic vega (`32.23`) fails by **$12.7\times$**.

---

## 2. Review of Proposed Amendments 1–6

- **Amendment 1 (Exact Case C Reference Values): ACCEPTED.**
  Adopt the exact Case C benchmark values in the plan and test comments:
  - `price = 12.761288593628759`
  - `delta = 0.6515836690997123` (MC 400k paths; analytic `0.6515678916789112`)
  - `vega  = 29.061466214323875`
  - `theta = -7.614736638530337`
  Also include the doc comment in `merton_core` and `mertonGreeks` explaining why the risk-neutral Poisson weight $p_n(\lambda(1+\kappa)T)$ paired with $r_n = r - \lambda\kappa + n\ln(1+\kappa)/T$ is algebraically identical term-by-term to the physical Poisson weight $p_n(\lambda T)$ paired with $(1+\kappa)^n e^{-\lambda\kappa T}$.
- **Amendment 2 (Split Segment 1 into 1a, 1b, 1c): ACCEPTED.**
  Keeps every step focused on a single layer (analytic series $\to$ terminal MC pricing/Greeks $\to$ multi-step path sampling).
- **Amendment 3 (Exact Knuth Poisson Sampler for $\lambda T \le 50$, Error Above): ACCEPTED.**
  Eliminates approximation bias and preserves `Xoshiro256` Box-Muller state isolation.
- **Amendment 4 (Strengthen Segment 2 Gate with Export & Cross-Check Assertions): ACCEPTED.**
  Note for the CLI gate command: avoid bash redirection (`>`) or `$` variable expansion inside `node -e "..."` so the command remains a pure single-line CLI command. Use `Math.abs(a - b) < 1e-9` with `assert` (see locked Segment 2 gate below).
- **Amendment 5 (Defer `benchmarkEngine` Update to Optional Segment 5): ACCEPTED.**
  Keeps Segment 2 strictly scoped to `mertonPrice` and `mertonGreeks` in `src/lib/bs_benchmark.js` and the regenerated WASM package.
- **Amendment 6 (Explicitly Document the MC Theta Correction Gate): ACCEPTED.**
  Both the Rust test in Segment 1b and Test 7 in `tests/test_monte_carlo.js` (Segment 4) must include a comment stating that omitting the $-\lambda(\text{n\_up} - \text{base\_sum})/n$ generator-shift correction produces a **$-3.42$ bias** on Case C's true theta of $-7.6147$, which the `0.18` tolerance catches by $19\times$.

---

## 3. Locked Segment Execution Plan

### Segment 1a: Rust Engine — Poisson Sampler & Merton Analytic Series
- **Files to Modify (1 file):** `crates/engine/src/lib.rs`
- **Functions & Tests to Create:**
  - `Xoshiro256::next_poisson(&mut self, mean: f64) -> u32` (returns `0` for `mean <= 0.0` with 0 uniform draws; panics if `mean > 50.0`; exact Knuth algorithm for `0.0 < mean <= 50.0`)
  - `merton_core`, `#[wasm_bindgen] pub fn merton_price`, `#[wasm_bindgen] pub fn merton_greeks` (with doc comment on $p_n(\lambda(1+\kappa)T)$ vs $p_n(\lambda T)$ equivalence and diffusion-vega definition)
  - Unit tests: `next_poisson_zero_and_moments_are_exact`, `merton_zero_lambda_matches_bs_analytic`, `merton_zero_jump_size_reduces_to_bs_across_series`, `merton_put_call_parity_and_greek_symmetries_hold`, `merton_analytic_greeks_match_series_finite_differences`
- **Verification Gate:**
  ```
  cargo test --manifest-path crates/engine/Cargo.toml
  ```

### Segment 1b: Rust Engine — Merton Monte Carlo Price & CRN Greeks
- **Ordering Constraint:** Must land after Segment 1a.
- **Files to Modify (1 file):** `crates/engine/src/lib.rs`
- **Functions & Tests to Create:**
  - `discounted_payoff_merton`
  - `#[wasm_bindgen] pub fn mc_merton_european`
  - `#[wasm_bindgen] pub fn mc_merton_greeks` (including the unbiased CRN Poisson generator shift $-\lambda(\text{n\_up} - \text{base\_sum})/n$ for theta)
  - Unit tests: `merton_zero_lambda_mc_matches_bs_mc_bit_for_bit`, `mc_merton_price_and_greeks_converge_to_series` (with explicit comment documenting the $-3.42$ naive theta bias caught by the `0.18` gate)
- **Verification Gate:**
  ```
  cargo test --manifest-path crates/engine/Cargo.toml
  ```

### Segment 1c: Rust Engine — Merton Path Sampling (`paths_sample_core`)
- **Ordering Constraint:** Must land after Segment 1b.
- **Files to Modify (1 file):** `crates/engine/src/lib.rs`
- **Functions & Tests to Create:**
  - `paths_sample_core` (refactoring `mc_paths_sample` to delegate with `lambda = 0.0`)
  - `#[wasm_bindgen] pub fn mc_merton_paths_sample`
  - Unit test: `mc_merton_paths_sample_shape_and_zero_lambda_equivalence`
- **Verification Gate:**
  ```
  cargo test --manifest-path crates/engine/Cargo.toml
  ```

### Segment 2: WASM Build & Independent JS Merton Reference
- **Ordering Constraint:** Must land after Segment 1c.
- **Files to Modify (3 files):** `src/lib/bs_benchmark.js`, `src/wasm/engine.js`, `src/wasm/engine_bg.wasm` (and generated `.d.ts` files via `npm run build:wasm`)
- **Functions to Create:**
  - `export function mertonGreeks(s, k, t, r, q, sigma, isCall, lambda, muJ, deltaJ)` in `src/lib/bs_benchmark.js`
  - `export function mertonPrice(s, k, t, r, q, sigma, isCall, lambda, muJ, deltaJ)` in `src/lib/bs_benchmark.js`
- **Verification Gate:**
  ```
  npm run build:wasm
  ```
  followed by:
  ```
  node -e "Promise.all([import('./src/wasm/engine.js'), import('./src/lib/bs_benchmark.js'), import('node:assert/strict')]).then(async ([w, js, { default: assert }]) => { await w.default(); for (const k of ['merton_price','merton_greeks','mc_merton_european','mc_merton_greeks','mc_merton_paths_sample']) assert.equal(typeof w[k], 'function', k); const wp = w.merton_price(100,100,1,0.05,0,0.2,true,1,-0.1,0.15); const jp = js.mertonPrice(100,100,1,0.05,0,0.2,true,1,-0.1,0.15); assert.ok(Math.abs(wp - jp) < 1e-9); console.log('ok', wp); })"
  ```
  followed by:
  ```
  node tests/test_monte_carlo.js
  ```

### Segment 3: Worker & Strategy Merton Dispatch
- **Ordering Constraint:** Must land after Segment 2.
- **Files to Modify (2 files):** `src/workers/sim.worker.js`, `src/lib/strategies.js`
- **Verification Gate:**
  ```
  node tests/test_integration.js
  ```

### Segment 4: Additive Merton Engine & Integration Test Gates
- **Ordering Constraint:** Must land after Segment 3.
- **Files to Modify (2 files):** `tests/test_monte_carlo.js`, `tests/test_integration.js`
- **Verification Gate:**
  ```
  npm test
  ```

---

APPROVED