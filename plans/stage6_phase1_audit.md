# STAGE 6 — PHASE 1 ARCHITECTURAL AUDIT

## Assertion Integrity Audit

- **Disclosed Change**: `crates/engine/src/lib.rs` (`analytic_put_matches_textbook`), changing expected Put $\rho$ from `-46.767_518_2` to `-41.890_460_9` at unchanged tolerance `1e-5`.
- **Verification**: For $S=100, K=100, T=1, r=0.05, q=0, \sigma=0.2$, $d_2 = 0.15$ and $\Phi(-d_2) \approx 0.4403823076$. Exact BSM Put $\rho = -K T e^{-rT}\Phi(-d_2) = -100 \times 1 \times e^{-0.05} \times 0.4403823076 = -41.8904609047$. The original value (`-46.7675182`) resulted from subtracting undiscounted $K T = 100$ instead of $K T e^{-rT} = 95.1229425$ from Call $\rho$ ($53.2324818$).
- **Ruling**: **Legitimate test-bug fix.** The tolerance (`1e-5`) was preserved and the assertion was aligned with exact BSM mathematics.

---

## Audit Questions

### 1. Greek Method & Bump Sizes
`mc_greeks` (`crates/engine/src/lib.rs:287-360`) implements central finite differences with antithetic variates and Common Random Numbers (CRN) for $\Delta, \Gamma, \mathcal{V}, \rho$, and a backward-$T$ (forward calendar time) difference for $\Theta$:
- **`ds = s * 1e-3`**: Defensible. Because the payoff kink makes pathwise second differences discontinuous, a very small bump ($<10^{-5} S$) starves the $[K-ds, K+ds]$ strike band of paths and explodes $\Gamma$ variance, whereas $10^{-3} S$ balances bias ($O(ds^2)$) against estimator variance and avoids floating-point cancellation in `s_up - 2.0 * base_sum + s_dn`.
- **`d_sigma = 1e-4` & `d_r = 1e-4`**: Safe for all normal inputs ($\sigma > 10^{-4}$). Truncation error is $O(10^{-8})$ while losing only ~4 of 16 `f64` mantissa digits.
- **`d_t = (1.0 / 3650.0_f64).min(t * 0.5)`**: Numerically safe; clamping at `0.5 * t` prevents `t - d_t` from reaching zero or going negative for small maturities.

### 2. Standard Error Independence Unit
Correctly implemented (`crates/engine/src/lib.rs:263-273, 334-349`). Each iteration averages the negatively correlated antithetic pair `0.5 * (up + down)` first, then accumulates `sum` and `sum_sq` across `n = pairs` independent pair means with Bessel's correction `n / (n - 1.0)`.

### 3. `norm_cdf` Accuracy & WASM-vs-JS Circularity
Both Rust and JS use the Lanczos ($g=7, n=9$) regularized incomplete gamma expansion (`GAMMA_EPS = 1e-16`), achieving near machine precision ($\sim 10^{-15}$). While sharing the same algorithm would be circular in isolation, both implementations are independently anchored against external ground-truth constants in `normal_cdf_matches_known_values` (`1e-12`), textbook BSM values (`1e-6`/`1e-5`), and put-call parity (`1e-10`). Thus, the `1e-9` WASM-vs-JS test validly verifies the WASM ABI boundary (parameter ordering, boolean encoding, and typed-array returns).

### 4. True Common Random Numbers (CRN)
Verified (`crates/engine/src/lib.rs:307-329`). `rng.next_normal()` is invoked **once** per pair iteration, and the identical `(z, -z)` draw drives `base`, `s_up`, `s_dn`, `sig_up`, `sig_dn`, `r_up`, `r_dn`, and `t_dn`.

### 5. Unit Conventions & Edge Cases
- **Units**: Fully consistent across `bs_core`, `mc_greeks`, and `bs_benchmark.js` — Vega per $1.0$ vol ($\partial V / \partial \sigma$), Theta per $1.0$ calendar year ($-\partial V / \partial T$), and Rho per $1.0$ rate ($\partial V / \partial r$).
- **Non-blocking edge cases**:
  1. If `n_paths <= 3`, `pairs = 1`, causing division by zero (`n - 1.0 == 0.0`) in `variance` (`std_err = NaN`).
  2. `mc_european` and `mc_greeks` assume `t > 0.0 && sigma > 0.0`; non-positive values are handled in `bs_core` and constrained by UI inputs.

### 6. Scope Creep
None. Deliverables strictly match P1-S1, P1-S2, and P1-S3 in `plans/PLAN.md`.

AUDIT PASSED — All Phase 1 verification gates passed (12/12 Rust unit tests, 12/12 Node WASM-vs-JS benchmark and MC convergence checks), CRN antithetic finite-difference Greeks and pair-level standard errors are mathematically sound, and the disclosed Put rho test update is a verified arithmetic fix to the test expectation.