# Stage 6 — Final Architectural Audit

## 1. Blueprint & Plan Compliance

All six segments (1a, 1b, 1c, 2, 3, 4, plus Segment 5 UI integration) landed within scope and passed their respective Verification Gates:

- **Rust Engine (`crates/engine/src/lib.rs`)**: 23 passed, 0 failed (13 original + 10 new).
- **WASM Boundary (`src/wasm/*`)**: Clean build; 11 exports in `engine.d.ts` (6 original preserved with identical signatures + 5 additive Merton exports).
- **JS Test Suite (`npm test`)**: 63 checks passed across 4 suites (54 original + 9 new blocks across `tests/test_monte_carlo.js` and `tests/test_integration.js`).
- **Production Bundle (`npx vite build`)**: Clean build (8 modules).

## 2. Assertion Integrity Audit

- **Original Tests**: All 13 original Rust unit tests and all 54 original JS assertions remain byte-identical and pass without modification.
- **Refactor Pinning**: Folding `mc_paths_sample` into `paths_sample_core` was verified against pre-refactor output (`maxAbsDiff === 0`) and pinned via `mc_paths_sample_pins_pre_refactor_values`.
- **Amendment 1 (100k-Path MC Tolerance Rescaling)**: **Approved.** The plan's initial bounds were calibrated from a 400k-path run (`1.15 sigma` for vega at 100k paths, causing a ~25% false-rejection rate). Rescaling the 100k-path bounds to `4.0–4.8 sigma` (`price: 0.15`, `vega: 0.90`, `rho: 0.30`) while *tightening* `theta` from `0.18` to `0.10` (`4.8 sigma`) and empirically verifying `1/sqrt(n)` variance scaling across 100k / 400k / 1.6M paths is the right engineering call. Both structural traps remain decisively gated (`6.5x` the bound for naive vega without `sigma / sigma_n`; `34x` the bound for naive MC theta without the Poisson generator shift).
- **Corrections to Blueprint/Review Reference Anchors**: Acknowledged and verified. Catching the blueprint's Case C price estimate (`12.761288593628759` vs `~12.95`), the naive vega figure (`34.953158` at `lambda = 1.0`), the analytic vs MC delta anchor (`0.64965955` vs `0.65156789`), and the stateless Box-Muller implementation in `Xoshiro256::next_normal` prevented false anchors from entering the test suite.

## 3. Answers to Sign-Off Questions

1. **Tolerance rescaling vs. 400k paths in `test_monte_carlo.js`**:
   Keeping the test at 100k paths with `4–5 sigma` bounds is preferable to quadrupling the path count. Fast test execution matters, and the purpose of the convergence gate is to separate structural estimator bias (`27 sigma` for naive vega, `163 sigma` for naive theta) from Monte Carlo sampling noise.
2. **Blueprint invariants**:
   Zero invariants were dropped. Dual Rust/JS series oracles (`< 1e-9`), bit-for-bit reduction at `lambda = 0` across price/Greeks/paths, exact series reduction at `mu_j = 0, delta_j = 0` (`1.8e-15`), `sigma / sigma_n` vega chain rule, full `T`-derivative analytic theta, CRN pathwise + Poisson generator shift MC theta, and graceful mock-engine fallback in `strategies.js` are all intact and tested.
3. **`next_poisson` panic cap at `lambda * t > 50`**:
   Acceptable as implemented. Because both `5.0` and `10.0` are exact in IEEE-754 binary64, the UI maximum `lambda = 5, T = 10` evaluates to `50.0` exactly, satisfying `mean <= 50.0` without trapping (and `mc_merton_greeks` bumps maturity downward `t - dt`, while `mc_merton_paths_sample` uses `lambda * dt`). No extra worker guard is required.

AUDIT PASSED
SIGNED OFF