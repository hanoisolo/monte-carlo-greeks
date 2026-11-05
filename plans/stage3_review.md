### Adversarial Review of `plans/PLAN.md`

#### 1. Segment Ordering & Gate Executability
- **P2-S3 Gate (`npx vite build`) will fail as written:** In P2-S3 you create `index.html` and `src/styles.css`, while `src/main.js` is deferred to P3-S1. If `index.html` includes `<script type="module" src="/src/main.js"></script>`, `npx vite build` in P2-S3 will fail with an unresolved Rollup entry error because `src/main.js` does not exist yet. Either create a minimal entry stub `src/main.js` in P2-S3 (3 files: `index.html`, `src/styles.css`, `src/main.js`) or add the `<script>` tag to `index.html` in P3-S1 (3 files: `index.html`, `src/workers/sim.worker.js`, `src/main.js`).

#### 2. Gate Strength (P1-S1, P2-S2, P3-S1)
- **P1-S1:** Acceptable with `node --check vite.config.js`, though importing `vite.config.js` via `node -e` is stronger.
- **P2-S2:** `node --check src/lib/canvas_renderer.js` only validates syntax; it does not verify that `renderPathFan`, `renderPayoffAndGreeks`, and `renderConvergenceChart` are exported or execute without runtime errors. Use a `node -e` gate that imports the module, verifies the 3 exported functions, runs them against a minimal mock 2D context, and asserts `fs.statSync` size > 0 for both assets.
- **P3-S1:** `npx vite build` proves bundling, but **P3-S2 will break** if `src/workers/sim.worker.js` unconditionally binds `self.onmessage` at top-level import time. Guard worker global binding with `if (typeof self !== 'undefined')` and export the message/simulation handler function so `tests/test_integration.js` can invoke it directly in Node.

#### 3. R2 (`src/wasm/` Committed to Git)
- Committing `src/wasm/` is the right call for Vercel, **but** `wasm-pack build` regenerates `src/wasm/.gitignore` (containing `*`) on **every** run. Make `build:wasm` in `package.json` automatically delete `src/wasm/.gitignore` after `wasm-pack` runs, and ensure root `.gitignore` does not ignore `src/wasm/` or `*.wasm`.

#### 4. R1 (GitHub Connector vs `gh` CLI)
- **Binary corruption risk:** `src/wasm/engine_bg.wasm`, `assets/banner_terminal.jpg`, and `assets/favicon.ico` are binary files. Pushing binary files as UTF-8 strings through `push_files` will corrupt the `\0asm` magic bytes and image headers, breaking production WASM instantiation on Vercel (`WebAssembly.instantiate(): expected magic word 00 61 73 6d`). After creating the repo with `create_repository`, push via local `git push` if authentication permits, or ensure binary files are base64-encoded via the Git Data/Contents API rather than UTF-8 text.

#### 5. Edge Cases (`--target web` + `u64` BigInt + `Float64Array`)
- **`u64` Seed `BigInt` Trap:** `#[wasm_bindgen]` maps Rust `u64` (`seed`) to JS `BigInt`. Passing a JS `Number` (e.g., from `<input type="number">` or JSON worker payloads) into `mc_european`, `mc_greeks`, or `mc_paths_sample` throws `TypeError: Cannot convert <n> to a BigInt`. Coerce `BigInt(seed)` at every WASM call site in `sim.worker.js`, `strategies.js`, and tests.
- **`mc_paths_sample` Memory Sizing:** `Vec<f64>` safely copies out of WASM linear memory into a detached JS `Float64Array`, but `sim.worker.js` must pass `nSamplePaths` (e.g., `64`), never `nPaths` (`100_000`), into `mc_paths_sample`.

---

APPROVED WITH CHANGES

1. **Fix P2-S3 / P3-S1 Entry Resolution:** Include a minimal stub `src/main.js` in P2-S3 (touching `index.html`, `src/styles.css`, `src/main.js`) so `npx vite build` succeeds in P2-S3, then flesh out `src/main.js` and `src/workers/sim.worker.js` in P3-S1.
2. **Guard Worker Global & Export Handler in P3-S1:** In `src/workers/sim.worker.js`, export ` runSimulationJob` (or message handler) and guard `self.onmessage` with `if (typeof self !== 'undefined')` so Node integration tests in P3-S2 can import it cleanly.
3. **Coerce `BigInt(seed)` Across WASM Boundary:** Explicitly convert `seed` via `BigInt(seed)` before calling `mc_european`, `mc_greeks`, and `mc_paths_sample` in JS/worker code.
4. **Automate `src/wasm/.gitignore` Removal:** Include `src/wasm/.gitignore` deletion inside `package.json`'s `build:wasm` script so re-running `npm run build:wasm` never re-ignores `src/wasm/`.
5. **Protect Binary Files in P3-S3 Push:** Verify `src/wasm/engine_bg.wasm` starts with `\0asm` (`0x00 0x61 0x73 0x6d`) after pushing to GitHub so text-only connector calls do not corrupt the WASM binary.
6. **Strengthen P2-S2 Gate:** Verify `canvas_renderer.js` exports (`renderPathFan`, `renderPayoffAndGreeks`, `renderConvergenceChart`) and non-zero asset byte sizes via a single `node -e` assertion command.