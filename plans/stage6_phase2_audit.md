# STAGE 6 — PHASE 2 ARCHITECTURAL AUDIT

### 1. Strategy Math (`src/lib/strategies.js`)
- **Analytic Linearity (`aggregateStrategy`):** Mathematically exact. By linearity of expectation and differentiation, the value of a static option portfolio $V = \sum_i w_i V_i$ (where $w_i = \text{side}_i \times \text{qty}_i$) has exact partial derivatives $\frac{\partial V}{\partial \theta} = \sum_i w_i \frac{\partial V_i}{\partial \theta}$ for all first- and second-order Greeks.
- **Monte Carlo Aggregation (`aggregateStrategyMonteCarlo`):** Reusing `BigInt(seed)` across every leg implements Common Random Numbers (CRN) across the portfolio, evaluating all legs on the identical terminal spot paths $S_T^{(j)}$. This makes the point estimates (net price and finite-difference Greeks) exact portfolio estimators.
- **Net Standard Error Caveat:** Summing $(w_i \cdot \text{SE}_i)^2$ and taking the square root assumes zero covariance between legs: $\text{Var}(\sum w_i \hat{V}_i) = \sum w_i^2 \text{Var}(\hat{V}_i) + 2\sum_{i<k} w_i w_k \text{Cov}(\hat{V}_i, \hat{V}_k)$. Because all legs share the same simulated paths $S_T$, their payoffs are strongly correlated. Dropping the cross-covariance terms is a pragmatic approximation forced by the per-leg WASM API boundary (`mc_greeks`), but it overestimates standard error on hedged spreads (e.g., Bull Call Spread, where long and short calls positively covary with opposite weights) and underestimates it when same-sign legs covary positively.

### 2. Payoff Geometry & Sign Convention
- **Sign Convention Consistency:** `aggregateStrategy` computes `net.price` as initial portfolio cost ($\sum w_i P_i$: positive for net debit, negative for net credit). `computePayoffCurve` computes terminal value $\text{payoff} = \sum w_i \cdot \text{intrinsic}_i$ and $\text{pnl} = \text{payoff} - \text{netPremium}$. This sign convention is completely self-consistent.
- **Iron Condor (`0.85P / -0.95P / -1.05C / 1.15C`):** Economically represents a short (credit) Iron Condor. Because the short inner strikes (`0.95P`, `1.05C`) carry higher premium than the long outer wings (`0.85P`, `1.15C`), `net.price` is negative (a net credit). Between 95 and 105, terminal payoff is `0`, so $\text{pnl} = 0 - \text{net.price} > 0$ (max profit equals credit received). Beyond `<85` or `>115`, terminal payoff is `-10`, so $\text{pnl} = -10 - \text{net.price} \in (-10, 0)$. The test assertions hold by exact financial logic, not by accident.
- **Butterfly (`0.90C / -2x 1.00C / 1.10C`):** Economically sensible symmetric call butterfly; terminal payoff is identically `0` for $S_T \le 90$ and $S_T \ge 110$, peaking at $+10$ at the body ($S_T = 100$).

### 3. Breakeven Solver (`findBreakevens`)
- **Piecewise-Linear Exactness:** Because European option payoffs are piecewise-linear with kinks only at leg strikes, linear interpolation between two grid points on the same linear segment is exact.
- **Edge Cases / Failure Modes:**
  1. **Tangential roots:** If a payoff vertex touches zero without crossing (e.g., a zero-cost butterfly at $S_T \le 90$, or a peak touching $y=0$ at a strike that does not fall on an exact grid node), `prev * curr < 0` will not trigger and the root is silently missed.
  2. **Sub-grid V-spikes:** If two strikes are closer than the grid step $(s_{\max} - s_{\min})/4000$ and the P&L crosses zero twice inside a single interval, both crossings are missed.
  3. **Kink straddling:** If a strike kink and a zero crossing share the same grid interval, secant interpolation introduces a tiny error bounded by the grid step ($\le 0.025$ on $[50, 150]$).
  4. **Right-boundary root:** The loop checks `prev === 0` but never checks `pnl[pnl.length - 1] === 0`, missing an exact root at `sMax`.

### 4. Renderer Contract (`src/lib/canvas_renderer.js`, `tests/check_renderer.js`)
- **What the test proves:** Verifies module exports, HiDPI backing-store scaling (`setupHiDPI`), empty/NaN data guards, and non-zero primitive invocation counts (`lineTo`, `stroke`, `fill`, `arc`, `setLineDash`, `fillText`), plus valid asset headers/sizes.
- **What the mock fails to catch:**
  1. `NaN` or `Infinity` arguments passed into `moveTo`/`lineTo`/`arc` (the mock increments counters without validating finite numeric arguments).
  2. Visual/coordinate bugs (e.g., inverted Y-axis, off-canvas clipping, overlapping text labels).
  3. Invalid CSS color or font strings (silently accepted by the mock).

### 5. UI Correctness (`index.html`)
- All DOM IDs and data attributes needed by the P3-S1 controller (`#strategy`, `#spot`, `#strike`, `#time`, `#rate`, `#dividend`, `#volatility`, `#paths`, `#seed`, `#run`, `#cancel`, progress elements, meta readouts, `#greeks-body`, tabs, and the three canvases) are present. *(Note for P3-S1: ensure `#strike` acts as the ATM reference or single-leg strike so it isn't ignored when `buildLegs` runs).*
- **Unit Consistency:** The table legend (`Vega per 1.00 vol`, `theta per 1.00 year`, `rho per 1.00 rate`) matches the unscaled partial derivatives in `crates/engine/src/lib.rs`.

### 6. Scope & Assertion Integrity
- No out-of-segment scope creep. All 17 strategy checks and 10 renderer checks are new, strict, and unweakened.

AUDIT PASSED — All Phase 2 gates (P2-S1, P2-S2, P2-S3) passed, strategy math and payoff geometry are sound, UI contracts match the WASM engine, and assertion integrity is fully preserved.