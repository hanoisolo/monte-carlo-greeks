# PLAN OF RECORD — MonteCarlo Greeks

Derived from `plans/stage2_blueprint.md` (Gemini 4 Argon) with the revisions listed in section R.

## Revisions to the blueprint (section R)

- **R1 — No `gh` / `vercel` CLI on this machine.** Blueprint P3-S3 assumed CLI deploy. Revised: repo creation and code push go through the GitHub connector (`create_repository`, `push_files`). Vercel deployment is attempted via the Vercel REST API only if a token exists; otherwise it is reported as a hard external blocker with exact manual steps. No segment gate may depend on a CLI that is not installed.
- **R2 — Vercel build image has no Rust toolchain.** Therefore `src/wasm/` build artifacts MUST be committed to git, and `vercel.json` build command must be `npx vite build` only (no `wasm-pack`). `src/wasm/.gitignore` (which contains `*`) must be deleted after the wasm-pack build. `package.json` keeps `build:wasm` as a local convenience script, not part of the Vercel build.
- **R3 — P1-S1 gate strengthened.** `npm install` alone proves nothing about config. Gate becomes `npm install` followed by `node --check vite.config.js`.
- **R4 — Roadmap inventory compliance.** `plans/MASTER_ROADMAP.md` must exist (copy of root roadmap), plus `plans/prompt_stage6_phase1.txt`, `plans/stage6_phase1_audit.md`, `plans/prompt_stage6_phase2.txt`, `plans/stage6_phase2_audit.md`. These are produced by the phase audits, not hand-written.
- **R5 — `assets/` generation.** `generate_image.py` requires a Gemini image model; if it fails, `assets/banner_terminal.jpg` and `assets/favicon.ico` are generated deterministically by a small Node script instead, so the gate never depends on a network call. Gate asserts non-zero byte size either way.
- **R6 — Test runner.** All Node gates use plain `node tests/<file>.js` with `node:assert/strict` and top-level await, matching the roadmap harness. `npm test` runs all three sequentially.

## Stage 3 review changes (incorporated, verdict: APPROVED WITH CHANGES)

- **C1** — P2-S3 also creates a minimal stub `src/main.js` so `npx vite build` resolves the entry; P3-S1 fleshes it out.
- **C2** — `src/workers/sim.worker.js` exports its job handler and guards `self.onmessage` behind `typeof self !== 'undefined'` so Node can import it.
- **C3** — Every WASM call site coerces the seed with `BigInt(seed)`; `u64` maps to JS `BigInt`.
- **C4** — `build:wasm` deletes `src/wasm/.gitignore` after `wasm-pack` runs, so re-builds never re-ignore the artifacts.
- **C5** — After pushing, verify `src/wasm/engine_bg.wasm` still begins with the `\0asm` magic bytes; never push binaries as UTF-8 text.
- **C6** — P2-S2 gate imports the module, asserts the three exports exist, runs them against a mock 2D context, and asserts non-zero asset sizes.

## Segments

### Phase 1 — Rust WASM Engine

**P1-S1 — Scaffold & build config**
- Files: `package.json`, `vite.config.js`, `.gitignore`
- Goal: ESM package (`"type":"module"`), Vite static build that emits `.wasm` as an asset and supports module workers, gitignore for `node_modules`, `dist`, `crates/engine/target`, `.env*`, `__pycache__`.
- Gate: `npm install` exits 0, then `node --check vite.config.js` exits 0.

**P1-S2 — Rust engine core**
- Files: `crates/engine/Cargo.toml`, `crates/engine/src/lib.rs`
- Goal: `bs_price`, `bs_greeks`, `mc_european`, `mc_greeks`, `mc_paths_sample` per blueprint section A. SplitMix64 + Xoshiro256** + Box-Muller with `u1.max(1e-15)` clamp; antithetic pairs; CRN central finite differences for Greeks; `#[cfg(test)]` unit tests in the same file.
- Gate: `cargo test --manifest-path crates/engine/Cargo.toml` — all tests pass, including put-call parity, analytic Greek values, and MC convergence.

**P1-S3 — WASM build, JS benchmark, engine tests**
- Files: `src/lib/bs_benchmark.js`, `tests/test_monte_carlo.js`
- Goal: `wasm-pack build crates/engine --target web --out-dir ../../src/wasm`, delete `src/wasm/.gitignore`, pure-JS Black-Scholes reference, and the WASM-vs-JS + MC-vs-analytic test suite.
- Gate: `node tests/test_monte_carlo.js` — BS vs JS within 1e-9; MC price ±0.05, delta ±0.005, gamma ±0.002, vega ±0.15, theta ±0.08, rho ±0.10 at 100k paths, seed 42.

### Phase 2 — Quantitative UI

**P2-S1 — Strategy engine**
- Files: `src/lib/strategies.js`, `tests/test_strategies.js`
- Goal: 7 presets (Single Call, Single Put, Straddle, Strangle, Bull Call Spread, Iron Condor, Butterfly); `aggregateStrategy`, `computePayoffCurve`, breakeven solver.
- Gate: `node tests/test_strategies.js` — Greek linearity within 1e-12, payoff shapes, put-call parity, Iron Condor bounded max loss/gain.

**P2-S2 — Canvas renderer & assets**
- Files: `src/lib/canvas_renderer.js`, `assets/banner_terminal.jpg`, `assets/favicon.ico`
- Goal: DPI-aware `renderPathFan`, `renderPayoffAndGreeks`, `renderConvergenceChart`; assets present.
- Gate: `node tests/check_renderer.js` — imports the module, asserts the three exports are functions, executes each against a mock 2D context, and asserts both assets exist with non-zero size.

**P2-S3 — Terminal DOM & styling**
- Files: `index.html`, `src/styles.css`, `src/main.js` (stub entry)
- Goal: institutional dark terminal UI — parameter inputs, strategy selector, MC-vs-BS Greek table with std err and % diff, progress bar, tabbed canvas viewports. Stub `main.js` so the Vite entry resolves.
- Gate: `npx vite build` exits 0.

### Phase 3 — Worker, Integration, Release

**P3-S1 — Worker & controller**
- Files: `src/workers/sim.worker.js`, `src/main.js`
- Goal: chunked WASM MC with progress streaming and cancellation; DOM wiring and canvas redraw. Worker exports `runSimulationJob` and guards `self.onmessage` behind `typeof self !== 'undefined'`. All seeds coerced with `BigInt(seed)`.
- Gate: `npx vite build` exits 0 and `dist/` contains the worker chunk and a `.wasm` asset.

**P3-S2 — Integration suite**
- Files: `tests/test_integration.js`
- Goal: end-to-end pipeline — strategy → worker handler → WASM → path sampling dimensions → seed reproducibility.
- Gate: `node tests/test_integration.js` exits 0; then `npm test` runs all three suites green.

**P3-S3 — Release config, git, GitHub, Vercel**
- Files: `vercel.json`, `AGENTS.md`
- Goal: `vercel.json` with `application/wasm` MIME + immutable caching; `AGENTS.md` architecture doc; git init, secret scan, commit, create `hanoisolo/monte-carlo-greeks`, push, configure Vercel for `options.inguyen.ca`.
- Gate: `npm test` green; `git status` clean; secret scan clean; remote repo contains the pushed tree; deployment verification per R1.

## Assertion integrity

No test assertion is ever weakened. All test files are new files in this greenfield repo, so there are no pre-existing assertions to preserve; every gate assertion is additive from the start.
