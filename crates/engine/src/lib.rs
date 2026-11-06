//! Monte Carlo option pricing and Greeks engine.
//!
//! Everything here is deterministic: a given `seed` produces bit-identical
//! results in Rust, in Node, and in the browser. That property is what makes
//! the test gates non-flaky, so the RNG is implemented inline rather than
//! pulled from a crate whose stream could change between versions.

use std::f64::consts::PI;
use wasm_bindgen::prelude::*;

// ---------------------------------------------------------------------------
// Normal distribution
// ---------------------------------------------------------------------------

const GAMMA_EPS: f64 = 1e-16;
const GAMMA_FPMIN: f64 = 1e-300;

/// Lanczos approximation of ln(Gamma(x)), g = 7, n = 9.
fn ln_gamma(x: f64) -> f64 {
    const COF: [f64; 9] = [
        0.999_999_999_999_809_93,
        676.520_368_121_885_1,
        -1259.139_216_722_402_8,
        771.323_428_777_653_13,
        -176.615_029_162_140_59,
        12.507_343_278_686_905,
        -0.138_571_095_265_720_12,
        9.984_369_578_019_571_6e-6,
        1.505_632_735_149_311_6e-7,
    ];

    if x < 0.5 {
        return (PI / (PI * x).sin()).ln() - ln_gamma(1.0 - x);
    }

    let x = x - 1.0;
    let mut a = COF[0];
    let t = x + 7.5;
    for (i, &c) in COF.iter().enumerate().skip(1) {
        a += c / (x + i as f64);
    }
    0.5 * (2.0 * PI).ln() + (x + 0.5) * t.ln() - t + a.ln()
}

/// Regularized lower incomplete gamma P(a, x) by series expansion.
fn gamma_series(a: f64, x: f64) -> f64 {
    if x <= 0.0 {
        return 0.0;
    }
    let gln = ln_gamma(a);
    let mut ap = a;
    let mut del = 1.0 / a;
    let mut sum = del;
    for _ in 0..1000 {
        ap += 1.0;
        del *= x / ap;
        sum += del;
        if del.abs() < sum.abs() * GAMMA_EPS {
            break;
        }
    }
    sum * (-x + a * x.ln() - gln).exp()
}

/// Regularized upper incomplete gamma Q(a, x) by continued fraction.
fn gamma_cf(a: f64, x: f64) -> f64 {
    let gln = ln_gamma(a);
    let mut b = x + 1.0 - a;
    let mut c = 1.0 / GAMMA_FPMIN;
    let mut d = 1.0 / b;
    let mut h = d;
    for i in 1..1000 {
        let an = -(i as f64) * (i as f64 - a);
        b += 2.0;
        d = an * d + b;
        if d.abs() < GAMMA_FPMIN {
            d = GAMMA_FPMIN;
        }
        c = b + an / c;
        if c.abs() < GAMMA_FPMIN {
            c = GAMMA_FPMIN;
        }
        d = 1.0 / d;
        let del = d * c;
        h *= del;
        if (del - 1.0).abs() < GAMMA_EPS {
            break;
        }
    }
    (-x + a * x.ln() - gln).exp() * h
}

/// Standard normal cumulative distribution, accurate to roughly machine
/// precision. Uses Phi(x) = 1/2 + 1/2 * P(1/2, x^2/2) for x > 0.
fn norm_cdf(x: f64) -> f64 {
    if x == 0.0 {
        return 0.5;
    }
    let a = 0.5;
    let z = x * x / 2.0;
    if x > 0.0 {
        if z < a + 1.0 {
            0.5 + 0.5 * gamma_series(a, z)
        } else {
            1.0 - 0.5 * gamma_cf(a, z)
        }
    } else if z < a + 1.0 {
        0.5 - 0.5 * gamma_series(a, z)
    } else {
        0.5 * gamma_cf(a, z)
    }
}

fn norm_pdf(x: f64) -> f64 {
    (-0.5 * x * x).exp() / (2.0 * PI).sqrt()
}

// ---------------------------------------------------------------------------
// Deterministic RNG: SplitMix64 seeding + Xoshiro256** stream
// ---------------------------------------------------------------------------

struct SplitMix64 {
    state: u64,
}

impl SplitMix64 {
    fn new(seed: u64) -> Self {
        Self { state: seed }
    }

    fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
}

struct Xoshiro256 {
    s: [u64; 4],
}

impl Xoshiro256 {
    fn new(seed: u64) -> Self {
        let mut sm = SplitMix64::new(seed);
        let mut s = [0u64; 4];
        for slot in s.iter_mut() {
            *slot = sm.next_u64();
        }
        Self { s }
    }

    fn next_u64(&mut self) -> u64 {
        let result = self.s[1].wrapping_mul(5).rotate_left(7).wrapping_mul(9);
        let t = self.s[1] << 17;
        self.s[2] ^= self.s[0];
        self.s[3] ^= self.s[1];
        self.s[1] ^= self.s[2];
        self.s[0] ^= self.s[3];
        self.s[2] ^= t;
        self.s[3] = self.s[3].rotate_left(45);
        result
    }

    /// Uniform in [0, 1) with a 53-bit mantissa.
    fn next_f64(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 * (1.0 / 9_007_199_254_740_992.0)
    }

    /// Box-Muller. The clamp on u1 prevents ln(0) from poisoning every path
    /// with NaN if the stream ever emits an exact zero.
    fn next_normal(&mut self) -> f64 {
        let u1 = self.next_f64().max(1e-15);
        let u2 = self.next_f64();
        (-2.0 * u1.ln()).sqrt() * (2.0 * PI * u2).cos()
    }

    /// Exact Poisson draw by Knuth's multiplicative method.
    ///
    /// A non-positive mean returns 0 without consuming a single uniform. That
    /// is what lets a jump-diffusion run with `lambda = 0` reproduce the pure
    /// diffusion stream bit-for-bit, so the reduction to Black-Scholes can be
    /// asserted with `assert_eq!` rather than a statistical tolerance.
    ///
    /// The loop costs O(mean) uniforms, so the mean is capped at 50. A normal
    /// approximation above the cap would be biased, and a biased sampler makes
    /// the Monte-Carlo-converges-to-series gate fail for large `lambda * t`
    /// with no obvious cause. Failing loudly is the honest option.
    fn next_poisson(&mut self, mean: f64) -> u32 {
        if mean <= 0.0 {
            return 0;
        }
        assert!(
            mean <= 50.0,
            "Poisson mean lambda * t exceeds the supported maximum of 50.0"
        );
        let limit = (-mean).exp();
        let mut k = 0u32;
        let mut p = 1.0;
        loop {
            k += 1;
            p *= self.next_f64();
            if p <= limit {
                return k - 1;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Black-Scholes-Merton analytic pricing
// ---------------------------------------------------------------------------

/// Returns [price, delta, gamma, vega, theta, rho].
///
/// Units: vega is per 1.0 of volatility, theta is per 1.0 year of calendar
/// decay, rho is per 1.0 of the risk-free rate.
fn bs_core(s: f64, k: f64, t: f64, r: f64, q: f64, sigma: f64, is_call: bool) -> [f64; 6] {
    if t <= 0.0 || sigma <= 0.0 || s <= 0.0 || k <= 0.0 {
        let intrinsic = if is_call {
            (s - k).max(0.0)
        } else {
            (k - s).max(0.0)
        };
        let delta = if is_call {
            if s > k {
                1.0
            } else {
                0.0
            }
        } else if s < k {
            -1.0
        } else {
            0.0
        };
        return [intrinsic, delta, 0.0, 0.0, 0.0, 0.0];
    }

    let sqrt_t = t.sqrt();
    let d1 = ((s / k).ln() + (r - q + 0.5 * sigma * sigma) * t) / (sigma * sqrt_t);
    let d2 = d1 - sigma * sqrt_t;

    let df_q = (-q * t).exp();
    let df_r = (-r * t).exp();
    let nd1 = norm_cdf(d1);
    let nd2 = norm_cdf(d2);
    let pdf_d1 = norm_pdf(d1);

    let (price, delta, rho) = if is_call {
        (
            s * df_q * nd1 - k * df_r * nd2,
            df_q * nd1,
            k * t * df_r * nd2,
        )
    } else {
        (
            k * df_r * (1.0 - nd2) - s * df_q * (1.0 - nd1),
            -df_q * (1.0 - nd1),
            -k * t * df_r * (1.0 - nd2),
        )
    };

    let gamma = df_q * pdf_d1 / (s * sigma * sqrt_t);
    let vega = s * df_q * pdf_d1 * sqrt_t;
    let decay = -s * df_q * pdf_d1 * sigma / (2.0 * sqrt_t);
    let theta = if is_call {
        decay - r * k * df_r * nd2 + q * s * df_q * nd1
    } else {
        decay + r * k * df_r * (1.0 - nd2) - q * s * df_q * (1.0 - nd1)
    };

    [price, delta, gamma, vega, theta, rho]
}

/// Black-Scholes-Merton European option price.
#[wasm_bindgen]
pub fn bs_price(s: f64, k: f64, t: f64, r: f64, q: f64, sigma: f64, is_call: bool) -> f64 {
    bs_core(s, k, t, r, q, sigma, is_call)[0]
}

/// Black-Scholes-Merton analytic Greeks as [price, delta, gamma, vega, theta, rho].
#[wasm_bindgen]
pub fn bs_greeks(s: f64, k: f64, t: f64, r: f64, q: f64, sigma: f64, is_call: bool) -> Vec<f64> {
    bs_core(s, k, t, r, q, sigma, is_call).to_vec()
}

// ---------------------------------------------------------------------------
// Merton jump-diffusion (1976)
// ---------------------------------------------------------------------------

/// Merton jump-diffusion semi-closed form.
///
/// The terminal law is a Poisson mixture of lognormals, so the price is a
/// weighted sum of Black-Scholes prices at a shifted rate and volatility:
///
/// ```text
/// P       = sum_n w_n * BS(S, K, T, r_n, sigma_n)
/// w_n     = e^{-L} L^n / n!,   L = lambda * T * (1 + kappa)
/// sigma_n = sqrt(sigma^2 + n * delta_j^2 / T)
/// r_n     = r - lambda * kappa + n * ln(1 + kappa) / T
/// kappa   = exp(mu_j + delta_j^2 / 2) - 1
/// ```
///
/// The weight `p_n(lambda * T * (1 + kappa))` paired with `r_n` is
/// algebraically identical to `p_n(lambda * T)` paired with a dividend yield of
/// `q + lambda * kappa - n * ln(1 + kappa) / T`. Both give the same price to
/// machine precision; this form is used because it reuses `bs_core` unchanged.
/// Do not "fix" one of the two into the other.
///
/// Vega is the sensitivity to the diffusion volatility with the jump parameters
/// held fixed, so each term carries the chain-rule factor
/// `d sigma_n / d sigma = sigma / sigma_n`. Omitting it overstates vega by
/// about 20% at `lambda = 1`.
///
/// Theta is the exact total derivative `-dP/dT`. Maturity enters the weights,
/// the shifted volatility and the shifted rate, so a weighted sum of the
/// Black-Scholes thetas would be wrong. The three trailing terms account for
/// `dw_n/dT`, `dr_n/dT` and `d sigma_n/dT` respectively.
fn merton_core(
    s: f64,
    k: f64,
    t: f64,
    r: f64,
    q: f64,
    sigma: f64,
    is_call: bool,
    lambda: f64,
    mu_j: f64,
    delta_j: f64,
) -> [f64; 6] {
    if lambda <= 0.0 || t <= 0.0 || sigma <= 0.0 || s <= 0.0 || k <= 0.0 {
        return bs_core(s, k, t, r, q, sigma, is_call);
    }

    let kappa = (mu_j + 0.5 * delta_j * delta_j).exp() - 1.0;
    let ln_1pk = (1.0 + kappa).ln();
    let l = lambda * t * (1.0 + kappa);

    let mut out = [0.0f64; 6];
    let mut w = (-l).exp();
    let mut n = 0usize;
    loop {
        if n > 0 {
            w *= l / n as f64;
        }
        // Only test for convergence past the Poisson mode. Testing earlier
        // would terminate at n = 0 whenever e^{-L} is itself below the
        // threshold, which happens for L above about 35.
        if (n as f64) > l && w < 1e-15 {
            break;
        }

        let nf = n as f64;
        let sigma_n = (sigma * sigma + nf * delta_j * delta_j / t).sqrt();
        let r_n = r - lambda * kappa + nf * ln_1pk / t;
        let g = bs_core(s, k, t, r_n, q, sigma_n, is_call);

        out[0] += w * g[0];
        out[1] += w * g[1];
        out[2] += w * g[2];
        out[3] += w * g[3] * (sigma / sigma_n);
        out[4] += w * (g[4] - ((nf - l) / t) * g[0]
            + (nf * ln_1pk / (t * t)) * g[5]
            + (nf * delta_j * delta_j / (2.0 * t * t * sigma_n)) * g[3]);
        out[5] += w * g[5];

        n += 1;
        if n > 500 {
            break;
        }
    }
    out
}

/// Merton jump-diffusion European option price.
#[wasm_bindgen]
pub fn merton_price(
    s: f64,
    k: f64,
    t: f64,
    r: f64,
    q: f64,
    sigma: f64,
    is_call: bool,
    lambda: f64,
    mu_j: f64,
    delta_j: f64,
) -> f64 {
    merton_core(s, k, t, r, q, sigma, is_call, lambda, mu_j, delta_j)[0]
}

/// Merton jump-diffusion analytic Greeks as
/// [price, delta, gamma, vega, theta, rho].
///
/// Units match `bs_greeks`: vega per 1.00 of the diffusion volatility with the
/// jump parameters held fixed, theta per 1.00 year of calendar decay, rho per
/// 1.00 of the risk-free rate.
#[wasm_bindgen]
pub fn merton_greeks(
    s: f64,
    k: f64,
    t: f64,
    r: f64,
    q: f64,
    sigma: f64,
    is_call: bool,
    lambda: f64,
    mu_j: f64,
    delta_j: f64,
) -> Vec<f64> {
    merton_core(s, k, t, r, q, sigma, is_call, lambda, mu_j, delta_j).to_vec()
}

// ---------------------------------------------------------------------------
// Monte Carlo
// ---------------------------------------------------------------------------

fn discounted_payoff(
    s: f64,
    k: f64,
    t: f64,
    r: f64,
    q: f64,
    sigma: f64,
    is_call: bool,
    z: f64,
) -> f64 {
    let sqrt_t = t.sqrt();
    let st = s * ((r - q - 0.5 * sigma * sigma) * t + sigma * sqrt_t * z).exp();
    let payoff = if is_call {
        (st - k).max(0.0)
    } else {
        (k - st).max(0.0)
    };
    (-r * t).exp() * payoff
}

/// Antithetic-variate Monte Carlo European price as [price, std_err].
#[wasm_bindgen]
pub fn mc_european(
    s: f64,
    k: f64,
    t: f64,
    r: f64,
    q: f64,
    sigma: f64,
    is_call: bool,
    n_paths: u32,
    seed: u64,
) -> Vec<f64> {
    let pairs = (n_paths / 2).max(1);
    let mut rng = Xoshiro256::new(seed);
    let mut sum = 0.0;
    let mut sum_sq = 0.0;

    for _ in 0..pairs {
        let z = rng.next_normal();
        let up = discounted_payoff(s, k, t, r, q, sigma, is_call, z);
        let down = discounted_payoff(s, k, t, r, q, sigma, is_call, -z);
        let pair_mean = 0.5 * (up + down);
        sum += pair_mean;
        sum_sq += pair_mean * pair_mean;
    }

    let n = pairs as f64;
    let mean = sum / n;
    let variance = if n > 1.0 {
        ((sum_sq / n) - mean * mean).max(0.0) * n / (n - 1.0)
    } else {
        0.0
    };
    vec![mean, (variance / n).sqrt()]
}

/// Monte Carlo Greeks by central finite differences with common random
/// numbers: every bumped revaluation reuses the same normal stream, so the
/// bump differences are not contaminated by sampling noise.
///
/// Returns [price, std_err, delta, gamma, vega, theta, rho].
#[wasm_bindgen]
pub fn mc_greeks(
    s: f64,
    k: f64,
    t: f64,
    r: f64,
    q: f64,
    sigma: f64,
    is_call: bool,
    n_paths: u32,
    seed: u64,
) -> Vec<f64> {
    let pairs = (n_paths / 2).max(1);
    let mut rng = Xoshiro256::new(seed);

    let ds = s * 1e-3;
    let d_sigma = 1e-4;
    let d_r = 1e-4;
    let d_t = (1.0 / 3650.0_f64).min(t * 0.5);

    let mut base_sum = 0.0;
    let mut base_sq = 0.0;
    let mut s_up = 0.0;
    let mut s_dn = 0.0;
    let mut sig_up = 0.0;
    let mut sig_dn = 0.0;
    let mut r_up = 0.0;
    let mut r_dn = 0.0;
    let mut t_dn = 0.0;

    for _ in 0..pairs {
        let z = rng.next_normal();

        let mut base = 0.0;
        let mut acc_s_up = 0.0;
        let mut acc_s_dn = 0.0;
        let mut acc_sig_up = 0.0;
        let mut acc_sig_dn = 0.0;
        let mut acc_r_up = 0.0;
        let mut acc_r_dn = 0.0;
        let mut acc_t_dn = 0.0;

        for &zz in &[z, -z] {
            base += discounted_payoff(s, k, t, r, q, sigma, is_call, zz);
            acc_s_up += discounted_payoff(s + ds, k, t, r, q, sigma, is_call, zz);
            acc_s_dn += discounted_payoff(s - ds, k, t, r, q, sigma, is_call, zz);
            acc_sig_up += discounted_payoff(s, k, t, r, q, sigma + d_sigma, is_call, zz);
            acc_sig_dn += discounted_payoff(s, k, t, r, q, sigma - d_sigma, is_call, zz);
            acc_r_up += discounted_payoff(s, k, t, r + d_r, q, sigma, is_call, zz);
            acc_r_dn += discounted_payoff(s, k, t, r - d_r, q, sigma, is_call, zz);
            acc_t_dn += discounted_payoff(s, k, t - d_t, r, q, sigma, is_call, zz);
        }

        let pair_base = 0.5 * base;
        base_sum += pair_base;
        base_sq += pair_base * pair_base;
        s_up += 0.5 * acc_s_up;
        s_dn += 0.5 * acc_s_dn;
        sig_up += 0.5 * acc_sig_up;
        sig_dn += 0.5 * acc_sig_dn;
        r_up += 0.5 * acc_r_up;
        r_dn += 0.5 * acc_r_dn;
        t_dn += 0.5 * acc_t_dn;
    }

    let n = pairs as f64;
    let price = base_sum / n;
    let variance = if n > 1.0 {
        ((base_sq / n) - price * price).max(0.0) * n / (n - 1.0)
    } else {
        0.0
    };
    let std_err = (variance / n).sqrt();

    let delta = (s_up - s_dn) / (2.0 * ds) / n;
    let gamma = (s_up - 2.0 * base_sum + s_dn) / (ds * ds) / n;
    let vega = (sig_up - sig_dn) / (2.0 * d_sigma) / n;
    let rho = (r_up - r_dn) / (2.0 * d_r) / n;
    let theta = (t_dn - base_sum) / d_t / n;

    vec![price, std_err, delta, gamma, vega, theta, rho]
}

/// Discounted terminal payoff under Merton jump-diffusion for one path.
///
/// `n_jumps` is the number of jumps over the whole life and `z_j` the normal
/// driving their aggregate size. With `lambda = 0` and `n_jumps = 0` every
/// added term is an exact zero, so this reproduces `discounted_payoff`
/// bit-for-bit and the reduction to Black-Scholes can be asserted with
/// `assert_eq!`.
#[allow(clippy::too_many_arguments)]
fn discounted_payoff_merton(
    s: f64,
    k: f64,
    t: f64,
    r: f64,
    q: f64,
    sigma: f64,
    is_call: bool,
    lambda: f64,
    kappa: f64,
    mu_j: f64,
    delta_j: f64,
    z: f64,
    n_jumps: u32,
    z_j: f64,
) -> f64 {
    let sqrt_t = t.sqrt();
    let n = n_jumps as f64;
    let st = s
        * ((r - q - lambda * kappa - 0.5 * sigma * sigma) * t
            + sigma * sqrt_t * z
            + n * mu_j
            + n.sqrt() * delta_j * z_j)
            .exp();
    let payoff = if is_call {
        (st - k).max(0.0)
    } else {
        (k - st).max(0.0)
    };
    (-r * t).exp() * payoff
}

/// Antithetic-variate Monte Carlo Merton price as [price, std_err].
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn mc_merton_european(
    s: f64,
    k: f64,
    t: f64,
    r: f64,
    q: f64,
    sigma: f64,
    is_call: bool,
    lambda: f64,
    mu_j: f64,
    delta_j: f64,
    n_paths: u32,
    seed: u64,
) -> Vec<f64> {
    let pairs = (n_paths / 2).max(1);
    let mut rng = Xoshiro256::new(seed);
    let kappa = (mu_j + 0.5 * delta_j * delta_j).exp() - 1.0;
    let lam_t = lambda * t;
    let mut sum = 0.0;
    let mut sum_sq = 0.0;

    for _ in 0..pairs {
        let z = rng.next_normal();
        // The jump count is drawn once per path and reused by both antithetic
        // legs. Drawing it per leg would break the antithetic pairing.
        let (n_jumps, z_j) = if lambda > 0.0 {
            (rng.next_poisson(lam_t), rng.next_normal())
        } else {
            (0u32, 0.0)
        };

        let up = discounted_payoff_merton(
            s, k, t, r, q, sigma, is_call, lambda, kappa, mu_j, delta_j, z, n_jumps, z_j,
        );
        let down = discounted_payoff_merton(
            s, k, t, r, q, sigma, is_call, lambda, kappa, mu_j, delta_j, -z, n_jumps, -z_j,
        );
        let pair_mean = 0.5 * (up + down);
        sum += pair_mean;
        sum_sq += pair_mean * pair_mean;
    }

    let n = pairs as f64;
    let mean = sum / n;
    let variance = if n > 1.0 {
        ((sum_sq / n) - mean * mean).max(0.0) * n / (n - 1.0)
    } else {
        0.0
    };
    vec![mean, (variance / n).sqrt()]
}

/// Monte Carlo Merton Greeks by central finite differences with common random
/// numbers, as [price, std_err, delta, gamma, vega, theta, rho].
///
/// The jump count is drawn once per path and held fixed across every bumped
/// revaluation. Redrawing it per bump would contaminate the bump difference
/// with jump-count noise and make the Greeks meaningless.
///
/// Theta needs one extra term. Holding the jump count fixed differentiates the
/// payoff with respect to maturity but leaves the Poisson intensity frozen, so
/// the estimator misses `d/dT` of the jump-count distribution. That missing
/// piece is exactly `lambda * E[f(T, N+1) - f(T, N)]`, which the `n_up`
/// accumulator evaluates with the same random draws. Without it theta is biased
/// by about -3.42 at the benchmark parameters, a 45% error.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn mc_merton_greeks(
    s: f64,
    k: f64,
    t: f64,
    r: f64,
    q: f64,
    sigma: f64,
    is_call: bool,
    lambda: f64,
    mu_j: f64,
    delta_j: f64,
    n_paths: u32,
    seed: u64,
) -> Vec<f64> {
    let pairs = (n_paths / 2).max(1);
    let mut rng = Xoshiro256::new(seed);
    let kappa = (mu_j + 0.5 * delta_j * delta_j).exp() - 1.0;
    let lam_t = lambda * t;

    let ds = s * 1e-3;
    let d_sigma = 1e-4;
    let d_r = 1e-4;
    let d_t = (1.0 / 3650.0_f64).min(t * 0.5);

    let mut base_sum = 0.0;
    let mut base_sq = 0.0;
    let mut s_up = 0.0;
    let mut s_dn = 0.0;
    let mut sig_up = 0.0;
    let mut sig_dn = 0.0;
    let mut r_up = 0.0;
    let mut r_dn = 0.0;
    let mut t_dn = 0.0;
    let mut n_up = 0.0;

    for _ in 0..pairs {
        let z = rng.next_normal();
        let (n_jumps, z_j) = if lambda > 0.0 {
            (rng.next_poisson(lam_t), rng.next_normal())
        } else {
            (0u32, 0.0)
        };

        let mut base = 0.0;
        let mut acc_s_up = 0.0;
        let mut acc_s_dn = 0.0;
        let mut acc_sig_up = 0.0;
        let mut acc_sig_dn = 0.0;
        let mut acc_r_up = 0.0;
        let mut acc_r_dn = 0.0;
        let mut acc_t_dn = 0.0;
        let mut acc_n_up = 0.0;

        for &(zz, zzj) in &[(z, z_j), (-z, -z_j)] {
            base += discounted_payoff_merton(
                s, k, t, r, q, sigma, is_call, lambda, kappa, mu_j, delta_j, zz, n_jumps, zzj,
            );
            acc_s_up += discounted_payoff_merton(
                s + ds, k, t, r, q, sigma, is_call, lambda, kappa, mu_j, delta_j, zz, n_jumps, zzj,
            );
            acc_s_dn += discounted_payoff_merton(
                s - ds, k, t, r, q, sigma, is_call, lambda, kappa, mu_j, delta_j, zz, n_jumps, zzj,
            );
            acc_sig_up += discounted_payoff_merton(
                s,
                k,
                t,
                r,
                q,
                sigma + d_sigma,
                is_call,
                lambda,
                kappa,
                mu_j,
                delta_j,
                zz,
                n_jumps,
                zzj,
            );
            acc_sig_dn += discounted_payoff_merton(
                s,
                k,
                t,
                r,
                q,
                sigma - d_sigma,
                is_call,
                lambda,
                kappa,
                mu_j,
                delta_j,
                zz,
                n_jumps,
                zzj,
            );
            acc_r_up += discounted_payoff_merton(
                s,
                k,
                t,
                r + d_r,
                q,
                sigma,
                is_call,
                lambda,
                kappa,
                mu_j,
                delta_j,
                zz,
                n_jumps,
                zzj,
            );
            acc_r_dn += discounted_payoff_merton(
                s,
                k,
                t,
                r - d_r,
                q,
                sigma,
                is_call,
                lambda,
                kappa,
                mu_j,
                delta_j,
                zz,
                n_jumps,
                zzj,
            );
            acc_t_dn += discounted_payoff_merton(
                s,
                k,
                t - d_t,
                r,
                q,
                sigma,
                is_call,
                lambda,
                kappa,
                mu_j,
                delta_j,
                zz,
                n_jumps,
                zzj,
            );
            acc_n_up += discounted_payoff_merton(
                s,
                k,
                t,
                r,
                q,
                sigma,
                is_call,
                lambda,
                kappa,
                mu_j,
                delta_j,
                zz,
                n_jumps + 1,
                zzj,
            );
        }

        let pair_base = 0.5 * base;
        base_sum += pair_base;
        base_sq += pair_base * pair_base;
        s_up += 0.5 * acc_s_up;
        s_dn += 0.5 * acc_s_dn;
        sig_up += 0.5 * acc_sig_up;
        sig_dn += 0.5 * acc_sig_dn;
        r_up += 0.5 * acc_r_up;
        r_dn += 0.5 * acc_r_dn;
        t_dn += 0.5 * acc_t_dn;
        n_up += 0.5 * acc_n_up;
    }

    let n = pairs as f64;
    let price = base_sum / n;
    let variance = if n > 1.0 {
        ((base_sq / n) - price * price).max(0.0) * n / (n - 1.0)
    } else {
        0.0
    };
    let std_err = (variance / n).sqrt();

    let delta = (s_up - s_dn) / (2.0 * ds) / n;
    let gamma = (s_up - 2.0 * base_sum + s_dn) / (ds * ds) / n;
    let vega = (sig_up - sig_dn) / (2.0 * d_sigma) / n;
    let rho = (r_up - r_dn) / (2.0 * d_r) / n;
    let theta = (t_dn - base_sum) / d_t / n - lambda * (n_up - base_sum) / n;

    vec![price, std_err, delta, gamma, vega, theta, rho]
}

/// Flattened row-major sample paths of length `n_paths * (n_steps + 1)` for
/// the Canvas fan chart. Each row starts at `s`.
///
/// Over each step the log-return is
/// `(r - q - lambda*kappa - sigma^2/2) dt + sigma sqrt(dt) Z + N mu_j + sqrt(N) delta_j Z_j`
/// with `N ~ Poisson(lambda dt)`. At `lambda = 0` the jump draws are skipped
/// entirely, so this reproduces the pure-diffusion fan chart bit-for-bit.
#[allow(clippy::too_many_arguments)]
fn paths_sample_core(
    s: f64,
    t: f64,
    r: f64,
    q: f64,
    sigma: f64,
    lambda: f64,
    mu_j: f64,
    delta_j: f64,
    n_paths: u32,
    n_steps: u32,
    seed: u64,
) -> Vec<f64> {
    let np = n_paths.max(1) as usize;
    let ns = n_steps.max(1) as usize;
    let mut out = Vec::with_capacity(np * (ns + 1));
    let mut rng = Xoshiro256::new(seed);

    let dt = t / ns as f64;
    let kappa = (mu_j + 0.5 * delta_j * delta_j).exp() - 1.0;
    let drift = (r - q - lambda * kappa - 0.5 * sigma * sigma) * dt;
    let vol = sigma * dt.sqrt();
    let lam_dt = lambda * dt;

    for _ in 0..np {
        let mut price = s;
        out.push(price);
        for _ in 0..ns {
            let z = rng.next_normal();
            let mut log_step = drift + vol * z;
            if lambda > 0.0 {
                let n_jumps = rng.next_poisson(lam_dt);
                let z_j = rng.next_normal();
                let n = n_jumps as f64;
                log_step += n * mu_j + n.sqrt() * delta_j * z_j;
            }
            price *= log_step.exp();
            out.push(price);
        }
    }
    out
}

/// Flattened row-major sample paths of length `n_paths * (n_steps + 1)` for
/// the Canvas fan chart. Each row starts at `s`.
#[wasm_bindgen]
pub fn mc_paths_sample(
    s: f64,
    t: f64,
    r: f64,
    q: f64,
    sigma: f64,
    n_paths: u32,
    n_steps: u32,
    seed: u64,
) -> Vec<f64> {
    paths_sample_core(s, t, r, q, sigma, 0.0, 0.0, 0.0, n_paths, n_steps, seed)
}

/// Flattened row-major Merton sample paths, including compound Poisson jumps,
/// of length `n_paths * (n_steps + 1)`. Each row starts at `s`.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn mc_merton_paths_sample(
    s: f64,
    t: f64,
    r: f64,
    q: f64,
    sigma: f64,
    lambda: f64,
    mu_j: f64,
    delta_j: f64,
    n_paths: u32,
    n_steps: u32,
    seed: u64,
) -> Vec<f64> {
    paths_sample_core(
        s, t, r, q, sigma, lambda, mu_j, delta_j, n_paths, n_steps, seed,
    )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const S: f64 = 100.0;
    const K: f64 = 100.0;
    const T: f64 = 1.0;
    const R: f64 = 0.05;
    const Q: f64 = 0.0;
    const SIGMA: f64 = 0.2;

    fn close(a: f64, b: f64, tol: f64) -> bool {
        (a - b).abs() < tol
    }

    #[test]
    fn normal_cdf_matches_known_values() {
        assert!(close(norm_cdf(0.0), 0.5, 1e-15));
        assert!(close(norm_cdf(1.0), 0.841_344_746_068_542_9, 1e-12));
        assert!(close(norm_cdf(-1.0), 0.158_655_253_931_457_05, 1e-12));
        assert!(close(norm_cdf(1.96), 0.975_002_104_851_779_5, 1e-12));
        assert!(close(norm_cdf(-1.96), 0.024_997_895_148_220_5, 1e-12));
        assert!(close(norm_cdf(3.0), 0.998_650_101_968_320_8, 1e-12));
        assert!(close(norm_cdf(-3.0), 0.001_349_898_031_679_2, 1e-12));
        // Symmetry must hold to machine precision.
        for x in [0.1, 0.5, 1.5, 2.5, 4.0, 6.0] {
            assert!(close(norm_cdf(x) + norm_cdf(-x), 1.0, 1e-14));
        }
    }

    #[test]
    fn analytic_call_matches_textbook() {
        let g = bs_core(S, K, T, R, Q, SIGMA, true);
        assert!(close(g[0], 10.450_583_6, 1e-6), "price {}", g[0]);
        assert!(close(g[1], 0.636_830_7, 1e-6), "delta {}", g[1]);
        assert!(close(g[2], 0.018_762_0, 1e-6), "gamma {}", g[2]);
        assert!(close(g[3], 37.524_034_5, 1e-5), "vega {}", g[3]);
        assert!(close(g[4], -6.414_027_5, 1e-5), "theta {}", g[4]);
        assert!(close(g[5], 53.232_481_8, 1e-5), "rho {}", g[5]);
    }

    #[test]
    fn analytic_put_matches_textbook() {
        let g = bs_core(S, K, T, R, Q, SIGMA, false);
        assert!(close(g[0], 5.573_526_1, 1e-6), "price {}", g[0]);
        assert!(close(g[1], -0.363_169_3, 1e-6), "delta {}", g[1]);
        assert!(close(g[2], 0.018_762_0, 1e-6), "gamma {}", g[2]);
        assert!(close(g[3], 37.524_034_5, 1e-5), "vega {}", g[3]);
        assert!(close(g[5], -41.890_460_9, 1e-5), "rho {}", g[5]);
    }

    #[test]
    fn put_call_parity_holds() {
        for &(s, k, t, r, q, sigma) in &[
            (100.0, 100.0, 1.0, 0.05, 0.0, 0.2),
            (100.0, 120.0, 0.5, 0.03, 0.01, 0.35),
            (50.0, 45.0, 2.0, 0.07, 0.02, 0.15),
        ] {
            let call = bs_core(s, k, t, r, q, sigma, true)[0];
            let put = bs_core(s, k, t, r, q, sigma, false)[0];
            let forward_diff = s * (-q * t).exp() - k * (-r * t).exp();
            assert!(
                close(call - put, forward_diff, 1e-10),
                "parity broken: {} vs {}",
                call - put,
                forward_diff
            );
        }
    }

    #[test]
    fn gamma_and_vega_are_identical_for_call_and_put() {
        let c = bs_core(S, K, T, R, Q, SIGMA, true);
        let p = bs_core(S, K, T, R, Q, SIGMA, false);
        assert!(close(c[2], p[2], 1e-12));
        assert!(close(c[3], p[3], 1e-12));
    }

    #[test]
    fn expired_and_zero_vol_options_return_intrinsic() {
        assert!(close(bs_price(110.0, 100.0, 0.0, 0.05, 0.0, 0.2, true), 10.0, 1e-12));
        assert!(close(bs_price(90.0, 100.0, 0.0, 0.05, 0.0, 0.2, true), 0.0, 1e-12));
        assert!(close(bs_price(90.0, 100.0, 1.0, 0.05, 0.0, 0.0, false), 10.0, 1e-12));
    }

    #[test]
    fn rng_is_deterministic_for_a_fixed_seed() {
        let a = mc_european(S, K, T, R, Q, SIGMA, true, 10_000, 42);
        let b = mc_european(S, K, T, R, Q, SIGMA, true, 10_000, 42);
        assert_eq!(a, b);
        let c = mc_european(S, K, T, R, Q, SIGMA, true, 10_000, 43);
        assert_ne!(a, c);
    }

    #[test]
    fn mc_price_converges_to_analytic() {
        let analytic = bs_core(S, K, T, R, Q, SIGMA, true)[0];
        let mc = mc_european(S, K, T, R, Q, SIGMA, true, 200_000, 42);
        assert!(
            close(mc[0], analytic, 0.05),
            "mc {} vs analytic {}",
            mc[0],
            analytic
        );
        assert!(mc[1] > 0.0 && mc[1] < 0.1, "std_err {}", mc[1]);
    }

    #[test]
    fn mc_greeks_converge_to_analytic() {
        let analytic = bs_core(S, K, T, R, Q, SIGMA, true);
        let mc = mc_greeks(S, K, T, R, Q, SIGMA, true, 200_000, 42);
        assert!(close(mc[0], analytic[0], 0.05), "price {} vs {}", mc[0], analytic[0]);
        assert!(close(mc[2], analytic[1], 0.005), "delta {} vs {}", mc[2], analytic[1]);
        assert!(close(mc[3], analytic[2], 0.002), "gamma {} vs {}", mc[3], analytic[2]);
        assert!(close(mc[4], analytic[3], 0.15), "vega {} vs {}", mc[4], analytic[3]);
        assert!(close(mc[5], analytic[4], 0.08), "theta {} vs {}", mc[5], analytic[4]);
        assert!(close(mc[6], analytic[5], 0.10), "rho {} vs {}", mc[6], analytic[5]);
    }

    #[test]
    fn mc_put_greeks_converge_to_analytic() {
        let analytic = bs_core(S, K, T, R, Q, SIGMA, false);
        let mc = mc_greeks(S, K, T, R, Q, SIGMA, false, 200_000, 42);
        assert!(close(mc[0], analytic[0], 0.05), "price {} vs {}", mc[0], analytic[0]);
        assert!(close(mc[2], analytic[1], 0.005), "delta {} vs {}", mc[2], analytic[1]);
        assert!(close(mc[3], analytic[2], 0.002), "gamma {} vs {}", mc[3], analytic[2]);
    }

    #[test]
    fn sample_paths_have_expected_shape_and_start() {
        let n_paths = 8u32;
        let n_steps = 12u32;
        let flat = mc_paths_sample(S, T, R, Q, SIGMA, n_paths, n_steps, 7);
        assert_eq!(flat.len(), (n_paths * (n_steps + 1)) as usize);
        for p in 0..n_paths as usize {
            let start = p * (n_steps as usize + 1);
            assert!(close(flat[start], S, 1e-12));
            for step in 0..n_steps as usize {
                assert!(flat[start + step].is_finite());
                assert!(flat[start + step] > 0.0);
            }
        }
    }

    #[test]
    fn sample_paths_are_reproducible() {
        let a = mc_paths_sample(S, T, R, Q, SIGMA, 4, 6, 99);
        let b = mc_paths_sample(S, T, R, Q, SIGMA, 4, 6, 99);
        assert_eq!(a, b);
    }

    #[test]
    fn tiny_path_counts_never_produce_nan() {
        for n in [1u32, 2, 3, 4, 5] {
            let e = mc_european(S, K, T, R, Q, SIGMA, true, n, 42);
            assert!(e[0].is_finite(), "price not finite at n_paths={}", n);
            assert!(e[1].is_finite(), "std_err not finite at n_paths={}", n);
            let g = mc_greeks(S, K, T, R, Q, SIGMA, true, n, 42);
            for (i, v) in g.iter().enumerate() {
                assert!(v.is_finite(), "greek {} not finite at n_paths={}", i, n);
            }
        }
    }

    // --- Merton jump-diffusion ---------------------------------------------

    const LAMBDA: f64 = 1.0;
    const MU_J: f64 = -0.1;
    const DELTA_J: f64 = 0.15;

    #[test]
    fn next_poisson_zero_and_moments_are_exact() {
        // A non-positive mean must consume no uniforms, so a lambda = 0 run
        // reproduces the pure-diffusion stream bit-for-bit.
        let mut a = Xoshiro256::new(42);
        let mut b = Xoshiro256::new(42);
        assert_eq!(a.next_poisson(0.0), 0);
        assert_eq!(a.next_poisson(-1.0), 0);
        assert_eq!(a.next_normal(), b.next_normal());

        // Mean and variance of a Poisson(3) sample.
        let mut rng = Xoshiro256::new(7);
        let draws = 200_000u32;
        let mut sum = 0.0;
        let mut sum_sq = 0.0;
        for _ in 0..draws {
            let x = rng.next_poisson(3.0) as f64;
            sum += x;
            sum_sq += x * x;
        }
        let mean = sum / draws as f64;
        let var = sum_sq / draws as f64 - mean * mean;
        assert!(close(mean, 3.0, 0.02), "mean {}", mean);
        assert!(close(var, 3.0, 0.05), "var {}", var);
    }

    #[test]
    fn merton_zero_lambda_matches_bs_analytic() {
        let bs = bs_core(S, K, T, R, Q, SIGMA, true);
        let m = merton_core(S, K, T, R, Q, SIGMA, true, 0.0, MU_J, DELTA_J);
        for i in 0..6 {
            assert_eq!(m[i], bs[i], "greek {} differs at lambda = 0", i);
        }
    }

    #[test]
    fn merton_zero_jump_size_reduces_to_bs_across_series() {
        // mu_j = delta_j = 0 makes every jump a no-op, so kappa = 0, r_n = r and
        // sigma_n = sigma. The weights still sum to 1 and sum w_n (n - L) = 0,
        // so the series must collapse onto Black-Scholes even though roughly
        // twenty terms are active.
        let bs = bs_core(S, K, T, R, Q, SIGMA, true);
        let m = merton_core(S, K, T, R, Q, SIGMA, true, 1.5, 0.0, 0.0);
        for i in 0..6 {
            assert!(close(m[i], bs[i], 1e-12), "greek {}: {} vs {}", i, m[i], bs[i]);
        }
    }

    #[test]
    fn merton_put_call_parity_and_greek_symmetries_hold() {
        let c = merton_core(S, K, T, R, Q, SIGMA, true, LAMBDA, MU_J, DELTA_J);
        let p = merton_core(S, K, T, R, Q, SIGMA, false, LAMBDA, MU_J, DELTA_J);
        let forward_diff = S * (-Q * T).exp() - K * (-R * T).exp();
        assert!(
            close(c[0] - p[0], forward_diff, 1e-10),
            "parity {} vs {}",
            c[0] - p[0],
            forward_diff
        );
        assert!(close(c[2], p[2], 1e-12), "gamma differs");
        assert!(close(c[3], p[3], 1e-12), "vega differs");
    }

    #[test]
    fn merton_case_c_matches_verified_reference() {
        // Independently derived reference values for the benchmark case, so a
        // systematic error in both the series and its finite differences cannot
        // pass unnoticed. The price was confirmed three ways: this series, the
        // equivalent conditional-expectation series, and a 200k-path Monte
        // Carlo run.
        let g = merton_core(S, K, T, R, Q, SIGMA, true, LAMBDA, MU_J, DELTA_J);
        assert!(close(g[0], 12.761_288_593_628_759, 1e-9), "price {}", g[0]);
        assert!(close(g[1], 0.649_659_549_994_567_5, 1e-9), "delta {}", g[1]);
        assert!(close(g[2], 0.014_530_733_107_161_934, 1e-9), "gamma {}", g[2]);
        assert!(close(g[3], 29.061_466_214_323_875, 1e-9), "vega {}", g[3]);
        assert!(close(g[4], -7.614_736_638_530_337, 1e-9), "theta {}", g[4]);
        assert!(close(g[5], 52.204_666_405_827_98, 1e-9), "rho {}", g[5]);
    }

    #[test]
    fn merton_analytic_greeks_match_series_finite_differences() {
        let g = merton_core(S, K, T, R, Q, SIGMA, true, LAMBDA, MU_J, DELTA_J);
        let price = |s: f64, t: f64, r: f64, sigma: f64| {
            merton_core(s, K, t, r, Q, sigma, true, LAMBDA, MU_J, DELTA_J)[0]
        };

        let hs = 1e-4;
        let delta = (price(S + hs, T, R, SIGMA) - price(S - hs, T, R, SIGMA)) / (2.0 * hs);
        let gamma =
            (price(S + hs, T, R, SIGMA) - 2.0 * g[0] + price(S - hs, T, R, SIGMA)) / (hs * hs);
        let hsig = 1e-5;
        let vega = (price(S, T, R, SIGMA + hsig) - price(S, T, R, SIGMA - hsig)) / (2.0 * hsig);
        let hr = 1e-5;
        let rho = (price(S, T, R + hr, SIGMA) - price(S, T, R - hr, SIGMA)) / (2.0 * hr);
        let ht = 1e-5;
        let theta = -(price(S, T + ht, R, SIGMA) - price(S, T - ht, R, SIGMA)) / (2.0 * ht);

        assert!(close(g[1], delta, 1e-7), "delta {} vs {}", g[1], delta);
        assert!(close(g[2], gamma, 1e-5), "gamma {} vs {}", g[2], gamma);
        // A missing sigma / sigma_n chain-rule factor moves vega by about 5.9
        // at these parameters, so this tolerance catches it by six orders.
        assert!(close(g[3], vega, 1e-6), "vega {} vs {}", g[3], vega);
        assert!(close(g[4], theta, 1e-6), "theta {} vs {}", g[4], theta);
        assert!(close(g[5], rho, 1e-6), "rho {} vs {}", g[5], rho);
    }

    #[test]
    fn merton_zero_lambda_mc_matches_bs_mc_bit_for_bit() {
        // The Poisson sampler consumes no uniforms at lambda = 0 and the jump
        // normal is never drawn, so the stream and every floating-point
        // operation match the pure-diffusion path exactly.
        let bs_e = mc_european(S, K, T, R, Q, SIGMA, true, 20_000, 42);
        let m_e = mc_merton_european(S, K, T, R, Q, SIGMA, true, 0.0, MU_J, DELTA_J, 20_000, 42);
        assert_eq!(bs_e, m_e, "price path differs at lambda = 0");

        let bs_g = mc_greeks(S, K, T, R, Q, SIGMA, true, 20_000, 42);
        let m_g = mc_merton_greeks(S, K, T, R, Q, SIGMA, true, 0.0, MU_J, DELTA_J, 20_000, 42);
        assert_eq!(bs_g, m_g, "greek path differs at lambda = 0");
    }

    #[test]
    fn mc_merton_price_and_greeks_converge_to_series() {
        let series = merton_core(S, K, T, R, Q, SIGMA, true, LAMBDA, MU_J, DELTA_J);
        let mc = mc_merton_greeks(S, K, T, R, Q, SIGMA, true, LAMBDA, MU_J, DELTA_J, 200_000, 42);
        assert!(close(mc[0], series[0], 0.08), "price {} vs {}", mc[0], series[0]);
        assert!(mc[1] > 0.0, "std_err {}", mc[1]);
        assert!(close(mc[2], series[1], 0.008), "delta {} vs {}", mc[2], series[1]);
        assert!(close(mc[3], series[2], 0.003), "gamma {} vs {}", mc[3], series[2]);
        assert!(close(mc[4], series[3], 0.25), "vega {} vs {}", mc[4], series[3]);
        // The naive estimator, which holds the jump count fixed with no Poisson
        // generator shift, is biased by about -3.42 at these parameters. This
        // tolerance catches a missing correction by roughly 19x, so do not
        // loosen it to "theta is noisy".
        assert!(close(mc[5], series[4], 0.18), "theta {} vs {}", mc[5], series[4]);
        assert!(close(mc[6], series[5], 0.18), "rho {} vs {}", mc[6], series[5]);
    }

    #[test]
    fn mc_merton_paths_sample_shape_and_zero_lambda_equivalence() {
        let n_paths = 8u32;
        let n_steps = 12u32;

        // lambda = 0 must reproduce the pure-diffusion fan chart bit-for-bit.
        let bs = mc_paths_sample(S, T, R, Q, SIGMA, n_paths, n_steps, 7);
        let m0 = mc_merton_paths_sample(S, T, R, Q, SIGMA, 0.0, MU_J, DELTA_J, n_paths, n_steps, 7);
        assert_eq!(bs, m0, "path sample differs at lambda = 0");

        // Shape, start value and positivity with jumps active.
        let flat =
            mc_merton_paths_sample(S, T, R, Q, SIGMA, LAMBDA, MU_J, DELTA_J, n_paths, n_steps, 7);
        assert_eq!(flat.len(), (n_paths * (n_steps + 1)) as usize);
        for p in 0..n_paths as usize {
            let start = p * (n_steps as usize + 1);
            assert!(close(flat[start], S, 1e-12), "path {} must start at S0", p);
            for step in 0..=n_steps as usize {
                assert!(flat[start + step].is_finite(), "path value must be finite");
                assert!(flat[start + step] > 0.0, "path value must be positive");
            }
        }

        // Reproducible for a fixed seed.
        let a = mc_merton_paths_sample(S, T, R, Q, SIGMA, LAMBDA, MU_J, DELTA_J, 4, 6, 99);
        let b = mc_merton_paths_sample(S, T, R, Q, SIGMA, LAMBDA, MU_J, DELTA_J, 4, 6, 99);
        assert_eq!(a, b);
    }

    #[test]
    fn mc_paths_sample_pins_pre_refactor_values() {
        // These are the values the original standalone mc_paths_sample produced
        // before it was folded into paths_sample_core. The existing shape and
        // reproducibility tests would not notice a change in the arithmetic, so
        // this pins the actual output.
        let flat = mc_paths_sample(100.0, 1.0, 0.05, 0.0, 0.2, 2, 3, 7);
        let expected = [
            100.0,
            99.252_595_752_957_23,
            107.281_958_320_636_32,
            109.548_696_137_355_14,
            100.0,
            125.425_364_542_340_93,
            138.612_920_817_840_63,
            137.983_649_369_732_86,
        ];
        assert_eq!(flat.len(), expected.len());
        for (i, want) in expected.iter().enumerate() {
            assert_eq!(flat[i], *want, "path value {} changed", i);
        }
    }
}

