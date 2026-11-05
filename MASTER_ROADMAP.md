# MASTER ROADMAP: MonteCarlo Greeks (options.inguyen.ca)
**Target Production Domain:** `https://options.inguyen.ca`  
**GitHub Repository:** `hanoisolo/monte-carlo-greeks`  
**Deployment Platform:** GitHub Pages (Static WASM Bundle)  
**Primary Engine:** Rust (compiled to `wasm32-unknown-unknown` via `wasm-pack`)  
**Frontend Framework:** Vanilla ES6+ & HTML5 Canvas 2D bundled with Vite  
**Test Harness:** Headless Node.js `node:assert/strict` + `cargo test`  
**Architect & Auditor:** Google Gemini 4 Argon (`python ..\ask_gemini.py`)  
**Visual Asset Generator:** Google Gemini Nano Banana 2.1 (`python ..\generate_image.py`)  

---

## 0. AUTONOMOUS AGENT OPERATING DIRECTIVE
You are Mistral Vibe CLI operating in non-elevated autonomous mode (`--auto-approve`).
You have full access to file read/write tools and terminal command execution.
Execute this roadmap sequentially from Phase 1 Segment 1 to Phase 3 Segment 3.

### Strict Execution Invariants
1. **Zero-Popup Shell Hygiene:**
   - NEVER use bash redirects (`>` or `2>`) or shell variables (`$?`, `$VAR`) in any terminal command.
   - Write files using native CLI flags (e.g. `--out <path>`) or direct file-writing tools.
   - Use relative parent paths with Windows backslashes or MSYS forward slashes (`python ..\ask_gemini.py` or `python ../ask_gemini.py`).
2. **Assertion Integrity:**
   - NEVER weaken, edit, loosen, or delete any existing test assertion to make a test suite pass.
   - All test suite additions must be strictly additive.
   - Every segment must pass its verification test gate with 100% green assertions before proceeding to the next segment.
3. **Dual Audit Gate:**
   - At the conclusion of every phase, invoke Gemini 4 Argon to audit the codebase and verify that assertion integrity was maintained.
   - Run a cached secret scan before every Git commit.
4. **Autonomous Pacing:**
   - When a segment verification gate passes, immediately proceed to the next segment without prompting the user.

---

## 1. PROJECT DIRECTORY & FILE INVENTORY

```text
monte-carlo-greeks\
├── .gitignore
├── AGENTS.md
├── package.json
├── vite.config.js
├── index.html
├── plans\
│   ├── MASTER_ROADMAP.md
│   ├── prompt_stage6_phase1.txt
│   ├── stage6_phase1_audit.md
│   ├── prompt_stage6_phase2.txt
│   └── stage6_phase2_audit.md
├── assets\
│   ├── favicon.ico
│   └── banner_terminal.jpg
├── crates\
│   └── engine\
│       ├── Cargo.toml
│       └── src\
│           └── lib.rs
├── src\
│   ├── styles.css
│   ├── main.js
│   ├── lib\
│   │   ├── bs_benchmark.js
│   │   ├── canvas_renderer.js
│   │   └── strategies.js
│   └── workers\
│       └── sim.worker.js
└── tests\
    ├── test_monte_carlo.js
    ├── test_strategies.js
    └── test_integration.js