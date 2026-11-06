# Task: Blueprint & Segmentation — Merton jump-diffusion for monte-carlo-greeks

You are designing the architecture for adding **Merton jump-diffusion** as a
selectable model alongside the existing Black-Scholes path, in an existing
production repo. Produce a blueprint and an ordered Segment plan.

## Repo

`C:\Users\fboy2\VibeProjects\monte-carlo-greeks` — Rust engine compiled to WASM,
driven by a vanilla ES6 + Canvas 2D terminal. Production at
`https://options.inguyen.ca`, deployed by GitHub Pages on push to `main`.

The repo's thesis: **Monte Carlo estimates are always shown next to closed-form
values so convergence is visible rather than asserted.** That thesis is the
constraint that matters most. Do not propose anything that weakens it.

## Current architecture

```
crates/engine/src/lib.rs   Rust engine -> wasm32-unknown-unknown (607 lines, 13 cargo tests)
src/wasm/                  wasm-pack output, COMMITTED on purpose (no Rust on CI runner)
src/lib/bs_benchmark.js    independent JS Black-Scholes reference (172 lines)
src/lib/strategies.js      multi-leg aggregation, payoff geometry (239 lines)
src/lib/canvas_renderer.js Canvas 2D renderers, DOM-free (389 lines)
src/workers/sim.worker.js  chunked simulation worker (245 lines)
src/main.js                DOM controller (369 lines)
tests/                     4 headless node:assert/strict suites, 54 assertions
```

Engine exports today:

| Export | Returns |
| --- | --- |
| `bs_price(s,k,t,r,q,sigma,is_call)` | `f64` |
| `bs_greeks(s,k,t,r,q,sigma,is_call)` | `[price, delta, gamma, vega, theta, rho]` |
| `mc_european(...,n_paths,seed)` | `[price, std_err]` |
| `mc_greeks(...,n_paths,seed)` | `[price, std_err, delta, gamma, vega, theta, rho]` |
| `mc_paths_sample(s,t,r,q,sigma,n_paths,n_steps,seed)` | flat row-major `n_paths*(n_steps+1)` |

Units: vega per 1.00 of vol, theta per 1.00 year, rho per 1.00 of rate. Raw
partials, not per-1%-vol or per-day.

## The choke point

```rust
fn discounted_payoff(s, k, t, r, q, sigma, is_call, z) -> f64 {
    let sqrt_t = t.sqrt();
    let st = s * ((r - q - 0.5 * sigma * sigma) * t + sigma * sqrt_t * z).exp();
    let payoff = if is_call { (st - k).max(0.0) } else { (k - st).max(0.0) };
    (-r * t).exp() * payoff
}
```

One normal draw in, one terminal payoff out. `mc_european` and `mc_greeks` both
call it. `mc_greeks` runs a 7-way bump loop (`s±`, `sigma±`, `r±`, `t-`) reusing
the same `z` per path — common random numbers — accumulating antithetic pair
means, with the standard error computed over pair means (the pair mean is the
independent unit, not the individual path).

Bumps: `ds = s*1e-3`, `dsigma = 1e-4`, `dr = 1e-4`, `dt = min(1/3650, t/2)`.

## RNG

`SplitMix64` seeding into a `Xoshiro256**` stream, inline, no external crate, so
the stream cannot change under a dependency bump. `next_f64()` is a 53-bit
mantissa uniform. `next_normal()` is Box-Muller with a `1e-15` clamp on `u1` to
prevent `ln(0)` poisoning every path with NaN. A given seed is bit-identical in
Rust, Node, and the browser. This is what makes the gates non-flaky.

## Worker contract

`RUN_SIM { jobId, params }` -> `SIM_PROGRESS*` -> `SIM_COMPLETE { mc, bs, samplePaths, ... }`,
or `SIM_CANCELLED` / `SIM_ERROR`.

`params = { s, k, t, r, q, sigma, legs, nPaths, seed, nSamplePaths, nSteps }`

8 equal chunks. Per-chunk seed is `seed + chunk * 1_000_003`, identical across
legs so legs share their random stream (portfolio common random numbers). Chunk
estimates combine by equal-weighted mean with standard errors pooled in
quadrature: `sqrt(sum(se_i^2)) / chunkCount`. The `bs` benchmark block currently
calls `engine.bs_greeks` per leg.

`runSimulationJob` and `handleMessage` are exported and the `self.onmessage`
binding is guarded by `typeof self !== 'undefined'`, so the integration test
drives the real worker code path in Node.

## Merton math (the target)

`dS/S = (r - q - lambda*kappa)dt + sigma dW + (J-1)dN`, `N ~ Poisson(lambda*T)`,
`ln J ~ N(muJ, deltaJ^2)`, `kappa = exp(muJ + deltaJ^2/2) - 1`.

Semi-closed form:

```
P = sum_{n>=0} w_n * BS(S, K, T, r_n, sigma_n)
w_n     = e^{-L} L^n / n!,   L = lambda*T*(1+kappa)
sigma_n = sqrt(sigma^2 + n*deltaJ^2/T)
r_n     = r - lambda*kappa + n*ln(1+kappa)/T
```

MC terminal value:

```
S_T = S * exp((r - q - lambda*kappa - 0.5*sigma^2)*T + sigma*sqrt(T)*Z + N*muJ + sqrt(N)*deltaJ*ZJ)
```

## Traps I have already identified — your plan must address each

1. **CRN vs the Poisson draw.** The jump count `N` must be drawn once per path
   and reused across all 7 bumped revaluations. If each bump redraws `N`, the
   bump difference is contaminated by jump-count noise and the Greeks are junk.
2. **`lambda = 0` reduction.** Knuth's Poisson sampler always consumes at least
   one uniform, so `lambda = 0` would not reproduce `mc_european` bit-for-bit.
   An explicit early return consuming zero uniforms makes the `lambda = 0` gate
   an exact equality rather than a statistical tolerance. Decide and justify.
3. **Vega chain rule.** `sigma_n^2 = sigma^2 + n*deltaJ^2/T` implies
   `d sigma_n / d sigma = sigma / sigma_n`. The series vega is
   `sum w_n * vega_n * (sigma/sigma_n)`, not a naive weighted sum. Getting this
   wrong produces a few-percent disagreement with MC that is painful to trace.
4. **Theta.** `T` appears in `w_n` (through `L`), in `sigma_n`, and in `r_n`.
   A naive weighted sum of BS thetas is wrong. Needs `d/dT` of the whole series,
   or a documented finite difference on the series itself.
5. **Poisson sampling cost.** Knuth is `O(lambda*T)` uniforms per path. Needs a
   documented cap, a fallback, or a better sampler for large `lambda*T`.
6. **Architecture separation.** `src/lib/bs_benchmark.js` exists to validate the
   WASM boundary from the outside — an independent implementation of the same
   mathematics. Putting the Merton series only in Rust would collapse that
   separation and lose the property that makes the existing gates meaningful.

## Scope

In scope: **engine, benchmark, worker, test gates.** The user named these four.

The UI toggle in `src/main.js` / `index.html` is a follow-on — include it only as
a clearly-marked final optional Segment, kept small.

Out of scope: Heston, calibration, path-dependent payoffs, AAD, American exercise.

## What I need from you

1. **Architecture decisions**, with reasoning, on:
   - Where the Merton series lives (Rust vs JS vs both) given trap 6.
   - The engine export surface: new functions vs a `model` parameter on the
     existing ones. Consider that `mc_greeks` returns a fixed 7-tuple and the
     worker, strategies module, and UI all destructure it positionally.
   - How `lambda`, `muJ`, `deltaJ` enter `params` without breaking the existing
     `RUN_SIM` contract or the 4 existing test suites.
   - Whether the fan chart (`mc_paths_sample`) should show jumps, and if so how
     without a fourth near-duplicate export.
   - What "vega" means under Merton (diffusion-vol vega only, or total), and how
     to document that so it is not silently misleading.
2. **An ordered Segment plan**, 3 to 6 Segments, each:
   - touching **at most 3 files**
   - naming the exact files and functions to create or modify
   - stating the concrete goal
   - stating an explicit **Verification Gate** — the exact command and assertion
     that proves the Segment works before the next one starts
3. **The specific numeric test values** you expect the gates to assert, where you
   can derive them. For example: a Merton price for a known parameter set, or the
   tolerance at which MC should agree with the series for a given path count.
   Flag any value you are not confident in rather than inventing precision.

Constraints on the plan:
- Tests are strictly additive. No existing assertion may be weakened, deleted,
  or broadened. New gates go in new files or new `ok(...)` blocks.
- Shell commands in gates must be single plain commands: no `>`, no `2>`, no `$?`,
  no variable assignments.
- `src/wasm/` is committed; any engine change requires `npm run build:wasm` and
  committing the regenerated artifacts.
- Match existing style: no external crates, inline RNG, doc comments explaining
  the numerical reasoning rather than restating the code.

Return the blueprint as markdown. Be concrete about function signatures.
