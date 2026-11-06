# Merton Jump-Diffusion — Locked Segment Plan

Status: **APPROVED** (Stage 3, `plans/merton-review.md`), with two numeric
corrections applied by Mistral after verification. Blueprint:
`plans/merton-blueprint.md`. Verification record: scratchpad `merton/verification.md`.

## Scope

In: Rust engine, JS benchmark, worker, test gates.
Out: Heston, calibration, path-dependent payoffs, AAD, American exercise.
Optional follow-on: UI toggle (Segment 5).

## Architecture decisions

1. **Series lives in both Rust and JS.** `src/lib/bs_benchmark.js` is the
   independent oracle that validates the WASM boundary. A Rust-only series would
   test the engine against itself and lose the `|wasm - js| < 1e-9` invariant.
2. **Additive exports only.** The five existing exports keep their signatures.
   New: `merton_price`, `merton_greeks`, `mc_merton_european`, `mc_merton_greeks`,
   `mc_merton_paths_sample`. The 6-tuple and 7-tuple layouts are unchanged so
   `sim.worker.js`, `strategies.js` and `main.js` destructure identically.
3. **`params` gains defaulted fields** `model = 'bs'`, `lambda = 0`, `muJ = 0`,
   `deltaJ = 0`. Existing callers and the hand-built engine mock in
   `tests/test_integration.js` are untouched.
4. **Vega is diffusion-vol vega**: `dP/dsigma` holding `(lambda, muJ, deltaJ)`
   fixed. Documented in both implementations, because a desk would report vega
   against total implied vol and the difference is not obvious.
5. **Poisson sampler is exact Knuth, capped at `lambda*t <= 50`, error above.**
   No normal approximation: it is biased, and a biased sampler makes the
   MC-vs-series gate fail for large `lambda*t` with no obvious cause.

## Verified reference values

`S=100 K=100 T=1 r=0.05 q=0 sigma=0.2`

| Case | lambda | muJ | deltaJ | call price | theta | vega |
|---|---|---|---|---|---|---|
| BS baseline | - | - | - | 10.450583572185565 | -6.414027546438197 | 37.52403469169379 |
| A: lambda=0 | 0 | -0.1 | 0.15 | 10.450583572185565 (exact) | -6.414027546438197 | 37.52403469169379 |
| B: zero-size jumps | 1.5 | 0 | 0 | 10.450583572185563 (1.8e-15) | -6.414027546438132 | 37.524034691693785 |
| C: benchmark | 1.0 | -0.1 | 0.15 | **12.761288593628759** | **-7.614736638530337** | **29.061466214323875** |

Case C delta 0.6515836690997123 (MC 400k), gamma 0.014060665977420284,
rho 52.35752271785168.

Case C analytic Greeks, pinned by `merton_case_c_matches_verified_reference`:
delta 0.6496595499945675, gamma 0.014530733107161934,
vega 29.061466214323875, theta -7.614736638530337, rho 52.20466640582798.

Case C price confirmed three ways: textbook `r_n` series (12.761288593628763),
conditional-expectation series (12.76128859362876), 200k-path MC
(12.79893780995496, se 0.0245, 1.5 sigma). Routes 1 and 2 agree to 1.8e-15.

## The five traps, with measured consequences

| Trap | Consequence if missed |
|---|---|
| Jump count must be drawn once per path, reused across all 7 bumps | Greeks contaminated by jump-count noise |
| Poisson sampler must consume zero uniforms at `lambda=0` | No bit-for-bit reduction to `mc_european` |
| Vega needs the `sigma/sigma_n` chain rule | **20.3% error** at lambda=1.0 (34.953 vs 29.061); 10.0% at lambda=0.5 |
| Theta: `T` enters `w_n`, `sigma_n`, `r_n` | Naive weighted sum of BS thetas is wrong |
| MC theta needs the Poisson generator shift `-lambda*(f(T,N+1)-f(T,N))` | **-3.42 bias** on a true theta of -7.6147 (45% error) |

The MC theta correction is verified unbiased: residual `+1.5e-4`, scaling
linearly with `dt` (1.5e-4 -> 1.5e-5 -> 1.5e-6), i.e. pure first-order
truncation, no missing term.

## Segments

### 1a — Poisson sampler + analytic series
`crates/engine/src/lib.rs`
`Xoshiro256::next_poisson(mean) -> u32` (0 uniforms at `mean <= 0`, panic above
50), `merton_core`, `merton_price`, `merton_greeks`.
Tests: `next_poisson_zero_and_moments_are_exact`,
`merton_zero_lambda_matches_bs_analytic`,
`merton_zero_jump_size_reduces_to_bs_across_series`,
`merton_put_call_parity_and_greek_symmetries_hold`,
`merton_analytic_greeks_match_series_finite_differences`.
**Gate:** `cargo test --manifest-path crates/engine/Cargo.toml`

### 1b — MC price + CRN Greeks
`crates/engine/src/lib.rs`
`discounted_payoff_merton`, `mc_merton_european`, `mc_merton_greeks` (with the
Poisson generator shift for theta).
Tests: `merton_zero_lambda_mc_matches_bs_mc_bit_for_bit`,
`mc_merton_price_and_greeks_converge_to_series` — comment must record the -3.42
naive-theta bias and that the 0.18 tolerance catches it by 19x.
**Gate:** `cargo test --manifest-path crates/engine/Cargo.toml`

### 1c — Path sampling
`crates/engine/src/lib.rs`
`paths_sample_core` (refactor `mc_paths_sample` to delegate with `lambda=0`),
`mc_merton_paths_sample`.
Test: `mc_merton_paths_sample_shape_and_zero_lambda_equivalence`.
**Gate:** `cargo test --manifest-path crates/engine/Cargo.toml`

### 2 — WASM build + independent JS reference
`src/lib/bs_benchmark.js`, `src/wasm/*` (regenerated)
`mertonGreeks`, `mertonPrice`. `benchmarkEngine` deferred to Segment 5.
**Gate:** `npm run build:wasm`, then a single-line `node -e` asserting the five
new exports exist and `merton_price(...) === mertonPrice(...)` within 1e-9, then
`node tests/test_monte_carlo.js`.

### 3 — Worker + strategy dispatch
`src/workers/sim.worker.js`, `src/lib/strategies.js`
Model dispatch on `params.model`, defaulting to `'bs'`.
**Gate:** `node tests/test_integration.js`

### 4 — Additive test gates
`tests/test_monte_carlo.js`, `tests/test_integration.js`
Seven engine blocks + two integration blocks, all additive.
**Gate:** `npm test`

### 5 — UI toggle (optional, deferred)
`index.html`, `src/main.js`, plus the deferred `benchmarkEngine` branch.
**Gate:** `npm test`

## Constraints

- Tests strictly additive. No existing assertion weakened, deleted, or broadened.
- Gate commands are single plain commands: no `>`, no `2>`, no `$?`, no variable
  assignments.
- `src/wasm/` is committed; any engine change requires `npm run build:wasm` and
  committing the regenerated artifacts.
- No external crates. Inline RNG. Doc comments explain numerical reasoning, not
  restate the code.

## Corrections applied to the Stage 3 review

The review response contained two factual errors. Neither changes the APPROVED
verdict; both are corrected here so they do not reach the gates:

1. It claimed `Xoshiro256::next_normal()` has a cached `spare: Option<f64>` slot
   that a Poisson fallback would disturb. There is no such field — `lib.rs:173`
   is a plain two-uniform Box-Muller. The conclusion (drop the normal
   approximation) still holds on bias and cost grounds alone.
2. It gave the naive weighted vega as `32.228547`. The correct value at
   lambda=1.0 is `34.95315834084752` (20.3% error vs 29.0615). At lambda=0.5 it
   is `36.02832491308339` (10.0% error vs 32.7532).
3. It gave the Case C analytic delta as `0.6515678916789112`. That is close to
   the *Monte Carlo* delta (0.6515836690997123), not the analytic one. The
   analytic delta is `0.6496595499945675`. The two differ by 0.0019, which is
   inside the 0.008 MC tolerance, so the mistake would not have failed a gate —
   but it would have been baked into a test comment as a false anchor.
