# Stage 6 — Final Architectural Audit

Merton jump-diffusion is implemented across all six segments. Audit the result
against the original blueprint (`plans/merton-blueprint.md`) and the approved
plan (`plans/merton-plan.md`).

## Final state

| Gate | Result |
| --- | --- |
| `cargo test --manifest-path crates/engine/Cargo.toml` | 23 passed, 0 failed (13 original + 10 new) |
| `npm test` | 63 checks across 4 suites (was 54) |
| `npx vite build` | clean, 8 modules, 244ms |
| `npm run build:wasm` | clean, 11 exports in `engine.d.ts` |

Diff: 12 files, +1321 / -26.

```
crates/engine/src/lib.rs     +719   next_poisson, merton_core, merton_price,
                                    merton_greeks, discounted_payoff_merton,
                                    mc_merton_european, mc_merton_greeks,
                                    paths_sample_core, mc_merton_paths_sample
index.html                    +24   model select, jump parameter grid
src/lib/bs_benchmark.js       +97   mertonGreeks, mertonPrice, benchmarkEngine dispatch
src/lib/strategies.js         +29   model dispatch in both aggregators
src/main.js                   +32   els, readParams, syncModelControls, benchmark wiring
src/workers/sim.worker.js     +55   model dispatch via three closures
tests/test_monte_carlo.js    +153   7 new blocks
tests/test_integration.js     +59   2 new blocks
src/wasm/*                   regenerated
```

## Assertion Integrity disclosure

Two changes need explicit audit. Neither weakens an existing assertion.

**1. Tolerance rescaling in a NEW test (not an existing one).**
`tests/test_monte_carlo.js`, block `mc_merton converges to the analytic series
for call and put`. I wrote it with the plan's tolerances, it failed on vega
(29.515 vs 29.061, bound 0.25), and I measured rather than loosened:

| Greek | measured sd @100k, 8 seeds | plan bound | in sigma | new bound | in sigma |
| --- | --- | --- | --- | --- | --- |
| price | 0.0373 | 0.08 | 2.1 | 0.15 | 4.0 |
| delta | 0.0008 | 0.008 | 10.0 | 0.008 | 10.0 |
| gamma | 0.0006 | 0.003 | 5.0 | 0.003 | 5.0 |
| vega | 0.2182 | 0.25 | **1.15** | 0.90 | 4.1 |
| theta | 0.0209 | 0.18 | 8.6 | 0.10 | 4.8 |
| rho | 0.0638 | 0.18 | 2.8 | 0.30 | 4.7 |

Evidence the estimator is unbiased, not merely noisy: mean error over 8 seeds
was -0.014 / +0.027 / +0.039 at 100k / 400k / 1.6M paths, and sd scaled
0.239 / 0.106 / 0.049 — consistent with 1/sqrt(n) and zero bias.

The plan's bounds were derived from a 400k-path run but applied to a 100k-path
test, which is why vega landed at 1.15 sigma and failed ~25% of the time. The
new bounds still catch the two bugs they exist for: omitting the sigma/sigma_n
chain rule moves vega by 5.9 (6.5x the bound), and omitting the Poisson
generator shift moves theta by 3.42 (34x the bound). Theta was also *tightened*
from 0.18 to 0.10.

**2. No existing assertion was modified.** All 13 original Rust tests and all 54
original JS checks are byte-identical and pass unmodified.

## Corrections to your blueprint and review

Three numeric claims in your outputs were wrong. All were caught by independent
derivation, not by a failing gate:

1. **Case C price `~12.95`** (blueprint). Correct value `12.761288593628759`,
   confirmed three ways: textbook r_n series, conditional-expectation series
   (agree to 1.8e-15), and 200k-path MC at 1.5 sigma.
2. **Naive weighted vega `32.228547`** (review). Correct value at lambda=1.0 is
   `34.95315834084752` (20.3% error vs 29.0615). At lambda=0.5 it is
   `36.02832491308339` (10.0% error vs 32.7532).
3. **Case C analytic delta `0.6515678916789112`** (review). That is the *Monte
   Carlo* delta. The analytic delta is `0.6496595499945675`. The two differ by
   0.0019, inside the 0.008 MC bound, so no gate would have failed — but it
   would have been written into a test comment as a false anchor.

Also: the review claimed `Xoshiro256::next_normal()` has a cached
`spare: Option<f64>` slot that a Poisson fallback would disturb. There is no
such field (`lib.rs:173` is a plain two-uniform Box-Muller). The conclusion to
drop the normal approximation still holds on bias and cost grounds.

## Verification beyond the gates

- **Theta correction has teeth.** I zeroed the correction term and re-ran:
  theta read -11.066 against a true -7.615, bias -3.45, matching the predicted
  -11.034. Test failed as designed. Restored and re-ran clean.
- **Path sampler refactor preserved values.** `mc_paths_sample` was folded into
  `paths_sample_core`. The existing tests only check shape and reproducibility,
  so I replicated the pre-refactor loop from `git show HEAD` in TypeScript and
  compared: maxAbsDiff 0. Those eight values are now pinned in
  `mc_paths_sample_pins_pre_refactor_values`.
- **WASM boundary.** All five new exports exercised through the boundary:
  Float64Array returns, u64 seeds, and `mc_merton_greeks(lambda=0)` bit-identical
  to `mc_greeks` across the FFI.
- **Worker dispatch.** Merton pipeline: mc 12.7950 vs analytic 12.7613, se
  0.0614. lambda=0 pipeline bit-identical to Black-Scholes for mc, bs and
  samplePaths.
- **Strategy dispatch.** Merton price 12.7613 and vega 29.0615 through
  `aggregateStrategy`; a mock engine lacking the Merton functions falls back to
  Black-Scholes rather than throwing.

## Two self-inflicted test bugs, for the record

Both were my assertions, not the implementation, and both were fixed by
correcting the assertion rather than the code:

1. Asserted `e[0] instanceof Float64Array` where `e` was the array and `e[0]`
   the price.
2. Asserted a long/short call at the same strike should show different vega
   between models. It nets to zero in both.

## Questions for sign-off

1. Is the tolerance rescaling in Amendment 1 sound, or should the test instead
   run at 400k paths to keep the tighter bounds?
2. Is there any invariant from the blueprint that the final implementation
   dropped?
3. The `next_poisson` cap panics above `lambda * t = 50`. In WASM a panic is an
   unreachable trap, which surfaces in the UI as a dead worker rather than a
   message. Should Segment 3 validate `lambda * t` before calling, or is the
   panic acceptable given the UI's input range caps lambda at 5 and maturity at
   10 (so lambda*t can reach 50 exactly at the boundary)?

Return `SIGNED OFF` or `REJECTED` with reasons.
