## A. Engine API

All functions are exported via `#[wasm_bindgen]` in `crates/engine/src/lib.rs`:

1. `bs_price(s: f64, k: f64, t: f64, r: f64, q: f64, sigma: f64, is_call: bool) -> f64`
   - Closed-form Black-Scholes-Merton European option price with continuous dividend yield `q`. Handles edge cases (`t <= 0.0` or `sigma <= 0.0` returns intrinsic value discounted appropriately).
2. `bs_greeks(s: f64, k: f64, t: f64, r: f64, q: f64, sigma: f64, is_call: bool) -> Vec<f64>`
   - Returns 6-element `Float64Array`: `[price, delta, gamma, vega, theta, rho]`.
3. `mc_european(s: f64, k: f64, t: f64, r: f64, q: f64, sigma: f64, is_call: bool, n_paths: u32, seed: u64) -> Vec<f64>`
   - Antithetic variate GBM terminal simulation (`n_paths` total paths, paired as `n_paths / 2` draws of `(Z, -Z)`). Returns `[price, std_err]`.
4. `mc_greeks(s: f64, k: f64, t: f64, r: f64, q: f64, sigma: f64, is_call: bool, n_paths: u32, seed: u64) -> Vec<f64>`
   - Returns 7-element `Float64Array`: `[price, std_err, delta, gamma, vega, theta, rho]`.
5. `mc_paths_sample(s: f64, t: f64, r: f64, q: f64, sigma: f64, n_paths: u32, n_steps: u32, seed: u64) -> Vec<f64>`
   - Returns flattened row-major `Float64Array` of length `n_paths * (n_steps + 1)` for Canvas 2D fan-chart trajectories.

- **Greek Estimation Method:** **Common Random Numbers (CRN) Central Finite Differences (bump-and-reprice)** with antithetic variates. Every bumped evaluation reuses the exact same normal stream `Z_i`:
  - `ds = s * 1e-3`: $\Delta = \frac{V(s+ds) - V(s-ds)}{2\,ds}$, $\Gamma = \frac{V(s+ds) - 2V(s) + V(s-ds)}{ds^2}$ (single pass accumulating shifted payoffs for $s-ds, s, s+ds$ simultaneously).
  - `d_sigma = 1e-4`: $\text{Vega} = \frac{V(\sigma+d\sigma) - V(\sigma-d\sigma)}{2\,d\sigma}$.
  - `dr = 1e-4`: $\text{Rho} = \frac{V(r+dr) - V(r-dr)}{2\,dr}$.
  - `dt = (1.0 / 3650.0_f64).min(t * 0.5)`: $\Theta = \frac{V(t-dt) - V(t)}{dt}$ (calendar decay as $T$ shrinks).
- **RNG & Determinism:** Inline **SplitMix64** seeder + **Xoshiro256\*\*** PRNG + **Box-Muller** normal generator inside `lib.rs` (zero external RNG crate variance across platforms). Same `seed: u64` guarantees bit-identical results in Rust, Node, and Browser.
- **Units:**
  - **Vega:** Raw $\partial V / \partial \sigma$ per **1.0 (100%) volatility unit** (e.g., ATM $S=100,K=100,T=1,r=0.05,q=0,\sigma=0.2 \implies 37.5240$).
  - **Theta:** Annualized $\partial V / \partial t = -\partial V / \partial T$ **per 1.0 year** (e.g., ATM Call $\implies -6.4140$).
  - **Rho:** Raw $\partial V / \partial r$ per **1.0 (100%) rate unit**.

---

## B. WASM Boundary

- **Target:** `--target web` for **both** Vite and Node 24 tests (eliminates dual-target build overwrites).
- **Exact Build Command:**
  `wasm-pack build crates/engine --target web --out-dir ../../src/wasm`
- **Vite / Browser / Worker Consumer (`src/workers/sim.worker.js`, `src/main.js`):**
  ```js
  import init, { bs_price, bs_greeks, mc_european, mc_greeks, mc_paths_sample } from '../wasm/engine.js';
  await init(); // Resolves engine_bg.wasm via import.meta.url natively in Vite
  ```
- **Node 24 Test Consumer (`tests/*.js`):**
  ```js
  import { readFileSync } from 'node:fs';
  import init, { bs_price, bs_greeks, mc_european, mc_greeks, mc_paths_sample } from '../src/wasm/engine.js';
  const wasmBytes = readFileSync(new URL('../src/wasm/engine_bg.wasm', import.meta.url));
  await init({ module_or_path: wasmBytes });
  ```

---

## C. Worker Contract

- **Vite Worker Instantiation (`src/main.js`):**
  `const worker = new Worker(new URL('./workers/sim.worker.js', import.meta.url), { type: 'module' });`
- **Request Message (`main -> worker`):**
  - Run simulation: `{ type: 'RUN_SIM', jobId: number, params: { s, k, t, r, q, sigma, isCall, nPaths, seed, strategy, legs, nSamplePaths, nSteps } }`
  - Cancel simulation: `{ type: 'CANCEL_SIM', jobId: number }`
- **Response Messages (`worker -> main`):**
  - Progress stream (batched in chunks of `Math.min(50000, nPaths / 10)` paths, checking cancellation between chunks):
    `{ type: 'SIM_PROGRESS', jobId: number, completedPaths: number, totalPaths: number, partialEstimate: number, partialStdErr: number }`
  - Completion payload:
    `{ type: 'SIM_COMPLETE', jobId: number, elapsedMs: number, mc: { price, stdErr, delta, gamma, vega, theta, rho }, bs: { price, delta, gamma, vega, theta, rho }, samplePaths: Float64Array, nSamplePaths: number, nSteps: number }`
  - Error payload:
    `{ type: 'SIM_ERROR', jobId: number, message: string }`

---

## D. Segments

### Phase 1 — Rust WASM Engine & Benchmark Math

- **Segment P1-S1: Project Scaffold & Build Config**
  - **Files:** `package.json`, `vite.config.js`, `.gitignore`
  - **Goal:** Configure ES module package (`"type": "module"`), Vite 6 static build supporting `.wasm` assets and ES module workers, and git ignore rules (`node_modules`, `dist`, `crates/engine/target`, `src/wasm/.gitignore`).
  - **Verification Gate:** `npm install` — exits 0 with Vite installed and `node --version` compatible `package.json` scripts (`build:wasm`, `build`, `test`).

- **Segment P1-S2: Rust Option Pricing & Monte Carlo Engine**
  - **Files:** `crates/engine/Cargo.toml`, `crates/engine/src/lib.rs`
  - **Goal:** Implement `bs_price`, `bs_greeks`, `mc_european`, `mc_greeks`, and `mc_paths_sample` in Rust with SplitMix64/Xoshiro256\*\* + Box-Muller antithetic CRN central differences, plus unit tests in `lib.rs`.
  - **Verification Gate:** `cargo test --manifest-path crates/engine/Cargo.toml` — passes Rust unit tests for Call/Put parity, analytical Greeks vs textbook values, and MC convergence.

- **Segment P1-S3: WASM Compilation, JS Benchmark & Engine Test Suite**
  - **Files:** `src/lib/bs_benchmark.js`, `tests/test_monte_carlo.js`
  - **Goal:** Compile WASM to `src/wasm` via `wasm-pack`, implement pure-JS analytical Black-Scholes reference in `src/lib/bs_benchmark.js`, and verify WASM exports against JS reference in `tests/test_monte_carlo.js`.
  - **Verification Gate:** `node tests/test_monte_carlo.js` — asserts WASM `bs_greeks` matches JS benchmark within `1e-9` and `mc_greeks` (100k paths) converges within tolerances in Section F.

### Phase 2 — Multi-Leg Strategies, Canvas Renderer & Terminal UI

- **Segment P2-S1: Multi-Leg Strategy Engine & Tests**
  - **Files:** `src/lib/strategies.js`, `tests/test_strategies.js`
  - **Goal:** Implement preset templates (`Single Call`, `Single Put`, `Straddle`, `Strangle`, `Bull Call Spread`, `Iron Condor`, `Butterfly`) and multi-leg net price, Greeks, payoff-at-expiry curve, and breakeven solver (`aggregateStrategy`, `computePayoffCurve`).
  - **Verification Gate:** `node tests/test_strategies.js` — verifies multi-leg Greek linearity, payoff curve shapes, and Put-Call parity across all 7 strategy presets.

- **Segment P2-S2: Canvas 2D Visualization & Visual Assets**
  - **Files:** `src/lib/canvas_renderer.js`, `assets/banner_terminal.jpg`, `assets/favicon.ico`
  - **Goal:** Generate `banner_terminal.jpg` and `favicon.ico` via `generate_image.py`, and implement DPI-aware Canvas 2D rendering (`renderPathFan`, `renderPayoffAndGreeks`, `renderConvergenceChart`) in `src/lib/canvas_renderer.js`.
  - **Verification Gate:** `node --check src/lib/canvas_renderer.js` — syntax check passes and asset files exist on disk with non-zero byte size.

- **Segment P2-S3: Quantitative Terminal DOM & Styling**
  - **Files:** `index.html`, `src/styles.css`
  - **Goal:** Build responsive Bloomberg-style institutional dark UI with parameter sliders/inputs, strategy selector, Greek comparison table (MC vs BS + StdErr + % Diff), progress bar, and multi-tab Canvas viewports.
  - **Verification Gate:** `npx vite build` — compiles HTML/CSS/assets cleanly without unresolved references.

### Phase 3 — Web Worker Pipeline, Integration & Deployment

- **Segment P3-S1: Web Worker & Main UI Controller**
  - **Files:** `src/workers/sim.worker.js`, `src/main.js`
  - **Goal:** Wire chunked WASM Monte Carlo execution and cancellation in `sim.worker.js`, and connect DOM controls, live readouts, worker messaging, and Canvas redraw loops in `src/main.js`.
  - **Verification Gate:** `npx vite build` — bundles main bundle, module worker, and WASM asset into `dist/` with exit code 0.

- **Segment P3-S2: End-to-End Integration Test Suite**
  - **Files:** `tests/test_integration.js`
  - **Goal:** Verify end-to-end pipeline combining WASM `mc_greeks`, `mc_paths_sample`, `bs_benchmark.js`, `strategies.js` multi-leg aggregation, and worker message handler logic in headless Node.
  - **Verification Gate:** `node tests/test_integration.js` — all integration assertions and existing test files (`npm test`) pass 100%.

- **Segment P3-S3: Vercel Config, Documentation & Release**
  - **Files:** `vercel.json`, `AGENTS.md`
  - **Goal:** Configure `vercel.json` (`application/wasm` MIME headers, immutable caching), document architecture in `AGENTS.md`, run secret scan, commit, push to `hanoisolo/monte-carlo-greeks`, and deploy to `options.inguyen.ca`.
  - **Verification Gate:** `npm test` — executes all three test suites (`test_monte_carlo.js`, `test_strategies.js`, `test_integration.js`) and `cargo test` with 0 failures.

---

## E. Top 5 Traps

1. **Discontinuous Pathwise Gamma Explosion:** Using pathwise derivatives for Gamma fails at $S_T = K$; **neutralized in P1-S2** by using CRN central finite differences with shared antithetic normal draws $(Z, -Z)$ for $S-ds, S, S+ds$ in a single pass.
2. **Box-Muller $\ln(0)$ NaN Poisoning:** If uniform PRNG draws exact `0.0`, ` (-2.0 * u1.ln()).sqrt()` produces `NaN` across all paths; **neutralized in P1-S2** by clamping `u1 = u1.max(1e-15)`.
3. **WASM Dual-Target Overwrite (`bundler` vs `nodejs`):** Building for Vite breaks Node tests if using incompatible targets; **neutralized in P1-S3** by using `--target web` everywhere and passing `readFileSync` bytes to `init()` in Node.
4. **Theta Sign & Horizon Collapse (`t - dt <= 0`):** Flipping $\partial V / \partial T$ vs $\partial V / \partial t$ or bumping $t - dt \le 0$ near expiry; **neutralized in P1-S2** by defining $\Theta = (V(t - dt) - V(t)) / dt$ with `dt = (1.0/3650.0).min(t * 0.5)`.
5. **`wasm-pack` Nested `.gitignore` Hiding `src/wasm`:** `wasm-pack` writes `src/wasm/.gitignore` containing `*`, preventing Vite/Vercel or Git from tracking built glue if needed; **neutralized in P1-S3** by removing `src/wasm/.gitignore` or running `wasm-pack` in `prebuild`/`pretest`.

---

## F. Test Tolerances

All Monte Carlo tests use fixed seed `42n` (`u64`) and `n_paths = 100_000` (antithetic + CRN) for 100% deterministic, zero-flake execution:

| Test File | Assertions | Path Count & Seed | Tolerance vs Analytical BS | Determinism Guarantee |
| :--- | :--- | :--- | :--- | :--- |
| `tests/test_monte_carlo.js` | WASM `bs_price`/`bs_greeks` vs JS BS; Put-Call parity; `mc_european` & `mc_greeks` vs `bs_greeks` ($S=100, K=100, T=1, r=0.05, q=0.02, \sigma=0.20$) | `100_000` paths, `seed = 42n` | BS vs JS: `1e-9`; MC Price: `±0.05`; Delta: `±0.005`; Gamma: `±0.002`; Vega: `±0.15`; Theta: `±0.08`; Rho: `±0.10` | Fixed Xoshiro256\*\* seed `42n` produces identical IEEE-754 floats on every run |
| `tests/test_strategies.js` | 7 strategy presets net BS & MC Greeks, Straddle/Butterfly symmetry, Iron Condor bounded max loss/gain, breakeven accuracy | `100_000` paths, `seed = 42n` per leg | Multi-leg linearity exact within `1e-12`; MC net strategy price within `±0.08`, net Delta `±0.008` | Deterministic seed + closed-form payoff verification |
| `tests/test_integration.js` | Full pipeline: strategy -> worker simulation -> path sampling dimensions (`nSamplePaths * (nSteps + 1)`), positive prices, finite values, seed reproducibility | `100_000` paths (`seed = 1337n`), `64` sample paths × `50` steps | Exact array length `64 * 51 = 3264`, `path[i][0] === S0`, MC vs BS within `3 * stdErr` | Fixed seeds `1337n` and `42n` |

---

## Assumptions & Risks

- **Assumptions:** Rust `1.94` with `wasm32-unknown-unknown` and `wasm-pack 0.15.1` are installed on PATH; Node `24.21` supports top-level `await` and `init({ module_or_path: wasmBytes })`.
- **Risks:** `wasm-pack` versions >=0.13 emit a deprecation warning if `init(bytes)` is passed raw bytes instead of `{ module_or_path: bytes }`—mitigated by passing `{ module_or_path: wasmBytes }` or using `initSync(wasmBytes)` in Node tests.