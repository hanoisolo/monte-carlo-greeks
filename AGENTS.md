# AGENTS.md — Monte Carlo Greeks

Production: `https://options.inguyen.ca`
Repository: `hanoisolo/monte-carlo-greeks`

## What this is

A Monte Carlo option pricing and Greeks engine written in Rust, compiled to
WebAssembly, driven by a vanilla ES6 + Canvas 2D terminal UI. The Monte Carlo
estimates are always shown next to the closed-form Black-Scholes values so the
convergence is visible rather than asserted.

## Architecture

```
crates/engine/src/lib.rs   Rust engine -> wasm32-unknown-unknown
src/wasm/                  wasm-pack output (COMMITTED, see below)
src/lib/bs_benchmark.js    independent JS Black-Scholes reference
src/lib/strategies.js      multi-leg strategy aggregation and payoff geometry
src/lib/canvas_renderer.js Canvas 2D renderers (DOM-free, mock-testable)
src/workers/sim.worker.js  chunked simulation worker
src/main.js                DOM controller
tests/                     headless node:assert/strict gates
```

### Engine API (`crates/engine/src/lib.rs`)

| Export | Returns |
| --- | --- |
| `bs_price(s,k,t,r,q,sigma,is_call)` | `f64` |
| `bs_greeks(s,k,t,r,q,sigma,is_call)` | `[price, delta, gamma, vega, theta, rho]` |
| `mc_european(...,n_paths,seed)` | `[price, std_err]` |
| `mc_greeks(...,n_paths,seed)` | `[price, std_err, delta, gamma, vega, theta, rho]` |
| `mc_paths_sample(s,t,r,q,sigma,n_paths,n_steps,seed)` | flat row-major `n_paths * (n_steps + 1)` |

Units: **vega per 1.00 of volatility**, **theta per 1.00 year of calendar
decay**, **rho per 1.00 of the risk-free rate**. These are raw partial
derivatives, not the per-1%-vol or per-day conventions some vendors use.

### Determinism

The RNG is implemented inline — SplitMix64 seeding into a Xoshiro256** stream,
Box-Muller normals with a `1e-15` clamp on the uniform to prevent `ln(0)` from
poisoning every path with NaN. No external RNG crate, so the stream cannot
change under a dependency bump. A given seed produces bit-identical results in
Rust, Node, and the browser. This is what makes the test gates non-flaky.

### Greeks method

Central finite differences with **common random numbers**: each bumped
revaluation reuses the same normal draws, so the bump difference is not
contaminated by sampling noise. Bumps are `ds = s*1e-3`, `dsigma = 1e-4`,
`dr = 1e-4`, `dt = min(1/3650, t/2)`. Pathwise derivatives are deliberately
avoided for gamma, which is discontinuous at the strike.

Standard errors are computed over **antithetic pair means**, not individual
paths, because the pair mean is the independent unit.

### Worker contract

`RUN_SIM { jobId, params }` → `SIM_PROGRESS*` → `SIM_COMPLETE { mc, bs, samplePaths, ... }`,
or `SIM_CANCELLED` / `SIM_ERROR`. The job is split into 8 chunks so progress can
stream and cancellation can land between chunks; chunk estimates are averaged
with variance-weighted standard errors.

`runSimulationJob` and `handleMessage` are exported and the `self.onmessage`
binding is guarded by `typeof self !== 'undefined'`, so the integration test
drives the real worker code path in Node.

## Build and test

```bash
npm install
npm run build:wasm     # wasm-pack -> src/wasm, then removes the generated .gitignore
npm test               # 54 assertions across 4 headless suites
npm run test:rust      # 13 cargo tests
npx vite build         # production bundle
```

## Deployment

`src/wasm/` is **committed on purpose**. Vercel's build image has no Rust
toolchain, so the build command is `npx vite build` only — it consumes the
prebuilt artifacts. If you change `crates/engine/src/lib.rs`, you must run
`npm run build:wasm` and commit the regenerated `src/wasm/` before deploying.

`vercel.json` sets `Content-Type: application/wasm` on the wasm asset (without
it, `WebAssembly.instantiateStreaming` fails) and immutable caching on hashed
assets.

## Known limitations

- **Net standard error ignores inter-leg covariance.** `aggregateStrategyMonteCarlo`
  and the worker combine per-leg standard errors in quadrature, which assumes
  the legs are uncorrelated. They are not — they share paths. The point
  estimates are exact; the reported net standard error is an approximation that
  overstates error on hedged spreads. Fixing it properly needs a portfolio-level
  WASM entry point that returns the covariance matrix.
- **Breakeven solver** interpolates zero crossings on a 4001-point grid. It is
  exact for piecewise-linear payoffs except where a root is tangential (touches
  zero without crossing) or where two strikes are closer than the grid step.
- **Theta** is a one-sided difference against a shorter maturity, so it carries
  first-order truncation error rather than the second-order error of the other
  Greeks.

## Conventions

- Tests are strictly additive. Never weaken, delete, or broaden an assertion to
  make a gate pass. If a test expectation is genuinely wrong, fix it and
  document the old value, the new value, and the reason.
- Shell commands in gates must be single plain commands: no `>`, no `2>`, no
  `$?`, no variable assignments.
- Never commit `.env` files or credentials.
