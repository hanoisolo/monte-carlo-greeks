# Stage 3 — Plan Review Request

You produced a blueprint for adding Merton jump-diffusion to `monte-carlo-greeks`.
I have independently verified your mathematics and I am proposing six amendments.
Review the amendments and issue an explicit verdict: `APPROVED` or `REJECTED`
with reasons.

## What I verified (all confirmed correct — no change needed)

1. **Your analytic theta formula is correct.** I implemented
   `theta_n - ((n-L)/T)price_n + (n ln(1+k)/T^2)rho_n + (n dJ^2/(2 T^2 sN))vega_n`
   and compared against a central finite difference of the series price in T.
   Agreement to 5e-10 across three parameter sets. This is better than the
   finite-difference approach I had drafted; adopt it.

2. **Your MC theta correction is correct and unbiased.** I computed the exact
   expectation of the estimator from the series rather than trusting MC noise:
   - naive (N held fixed, no correction): bias **-3.4188** on a true theta of
     -7.6147 — a 45% error. Your trap identification was right and critical.
   - corrected: bias **+1.5e-4**, and it scales linearly with `dt`
     (1.5e-4 -> 1.5e-5 -> 1.5e-6 as dt shrinks 10x), confirming the residual is
     pure first-order truncation, not a missing term. Adopt as specified.

3. **The vega chain rule matters by 10%.** Naive weighted sum gives 36.028 vs
   the correct 32.753. Your `sigma/sigma_n` factor is right.

4. **`lambda = 0` reduction is exact.** Case B (lambda=1.5, muJ=0, deltaJ=0)
   reproduces BS to 1.8e-15, confirming the weights sum correctly and the
   `(n-L)` theta term vanishes.

5. **The textbook `r_n` form and the true conditional expectation are
   identical.** I confirmed `sum p_n(lambda*T*(1+k)) * BS(r_n, sigma_n)` equals
   `sum p_n(lambda*T) * BS(r, q + lambda*k - n ln(1+k)/T, sigma_n)` to 1.8e-15.
   Worth a doc comment, because the two weightings look like they should differ
   and a future maintainer will otherwise "fix" one of them.

## Amendment 1 — Case C price is wrong; use the exact value

Your Case C price of `~12.95` is off by 0.19. The exact value, confirmed by
three independent routes (textbook `r_n` series, conditional-expectation series,
and a 200k-path MC at 1.5 sigma), is:

```
S=100 K=100 T=1 r=0.05 q=0 sigma=0.2 lambda=1.0 muJ=-0.1 deltaJ=0.15
call price = 12.761288593628759
delta      = 0.6515836690997123   (MC, 400k paths)
vega       = 29.061466214323875   (analytic)
theta      = -7.614736638530337   (analytic)
```

Do not hardcode a 7th decimal in the gate; assert `|wasm - js| < 1e-9` and
`|mc - series| < 3*se`. But the plan should state the correct value so a
reviewer can sanity-check a failure.

## Amendment 2 — Segment 1 is not bite-sized; split it

Segment 1 currently contains: the Poisson sampler, `merton_core`, five new
`#[wasm_bindgen]` exports, `discounted_payoff_merton`, the `paths_sample_core`
refactor, `mc_merton_european`, `mc_merton_greeks`, and six new tests. That is
one file but it is not one segment. Split into three:

- **1a** — `next_poisson` + `merton_core` + `merton_price`/`merton_greeks`.
  Gate: `cargo test`, with the lambda=0 and Case B reduction tests only.
- **1b** — `discounted_payoff_merton` + `mc_merton_european` + `mc_merton_greeks`.
  Gate: `cargo test`, with the MC-converges-to-series and bit-for-bit lambda=0
  tests.
- **1c** — `paths_sample_core` refactor + `mc_merton_paths_sample`.
  Gate: `cargo test`, with the shape and lambda=0 path-equality tests.

Each still touches one file. This keeps the failure surface small: if 1b's
Greeks are wrong, 1a's series is already proven.

## Amendment 3 — Drop the normal-approximation Poisson fallback

Your trap-5 mitigation uses `(m + sqrt(m)*Z).round()` for `m > 30`. That is a
biased sampler that silently changes the distribution. In a repo whose entire
thesis is "convergence is visible rather than asserted," a sampler that does not
converge to the series is the wrong trade — it would make the MC-vs-series gate
fail for large `lambda*T` with no obvious cause.

Replace with: Knuth's exact algorithm for `lambda*T <= 50`, and above that
return a documented error rather than a biased draw. `lambda*T = 50` costs ~50
uniforms per path, which is acceptable for a UI whose realistic range is
`lambda` in [0.1, 2.0] and `T` in [0.1, 2.0]. If you believe PTRS is worth the
code, say so and justify it; otherwise the cap is the honest choice.

## Amendment 4 — Segment 2's gate is too weak

`npm run build:wasm` followed by the existing `test_monte_carlo.js` only proves
non-regression, because that file is not modified until Segment 4. Add a direct
assertion in Segment 2 that the new exports exist and are callable:

```
node -e "import('./src/wasm/engine.js').then(m => { const need = ['merton_price','merton_greeks','mc_merton_european','mc_merton_greeks','mc_merton_paths_sample']; const missing = need.filter(k => typeof m[k] !== 'function'); if (missing.length) { console.error('missing', missing); process.exit(1); } console.log('ok'); })"
```

Also assert `merton_price(...) === mertonPrice(...)` from the JS reference at
1e-9 inside Segment 2, not deferred to Segment 4. The whole point of the JS
reference is to catch a WASM boundary error at the moment the boundary changes.

## Amendment 5 — Defer the `benchmarkEngine` change

Your Segment 2 modifies `benchmarkEngine` to branch on `params.model`. That is
UI-adjacent and not one of the four named deliverables (engine, benchmark,
worker, test gates). Defer it to the optional Segment 5. Keep Segment 2 to the
JS reference functions plus the regenerated WASM artifacts.

## Amendment 6 — Name the gate that protects the theta correction

Your test list has "Merton analytic Greeks match central finite differences of
merton_price," which validates the *series* theta. It does not protect the *MC*
theta correction. The gate that does is test 7
(`|mc_theta - series.theta| < 0.18`), because the naive estimator's bias is
-3.42 and would blow through that tolerance by 19x.

State this explicitly in the plan so nobody later loosens that tolerance to
0.5 "because theta is noisy" and silently deletes the correction. Add a comment
in the test naming the -3.42 figure.

## Questions I need answered

1. Is Amendment 3 (drop the normal approximation, cap at 50, error above)
   correct, or is there a reason the biased fallback is acceptable here?
2. Does splitting Segment 1 into 1a/1b/1c break any dependency you relied on?
3. Is there a gate I am missing that would catch a wrong `sigma/sigma_n` vega
   factor? The FD-vs-analytic test should, but confirm the tolerance is tight
   enough: the error is 10%, so any tolerance below 3.2 on a vega of 32.75
   catches it.

Return `APPROVED` or `REJECTED` with reasons, and any further amendments.
