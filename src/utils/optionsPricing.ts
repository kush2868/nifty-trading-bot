/**
 * Black-Scholes options pricing, IV solver, and calendar spread breakeven calculator.
 *
 * Approach:
 *   1. Back-calculate IV from both near and far leg market prices (Newton-Raphson)
 *   2. Blend IVs (40% near, 60% far) to capture the term structure used by brokers
 *   3. Project far leg's value at near expiry using that blended IV (Black-Scholes)
 *   4. Bisection search to find exact upper/lower breakeven NIFTY levels
 *
 * This matches broker-level accuracy without requiring a live IV feed.
 */

const RISK_FREE_RATE = 0.065; // ~6.5% Indian risk-free rate

// ── Normal CDF (Abramowitz & Stegun approximation, max error 7.5e-8) ──────────

function normalCDF(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + p * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t
    * Math.exp(-(x * x) / 2);
  return 0.5 * (1 + sign * y);
}

// ── Black-Scholes pricing ─────────────────────────────────────────────────────

export function blackScholesCall(
  S: number, K: number, T: number, sigma: number, r = RISK_FREE_RATE,
): number {
  if (T <= 0) return Math.max(S - K, 0);
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  return S * normalCDF(d1) - K * Math.exp(-r * T) * normalCDF(d2);
}

export function blackScholesPut(
  S: number, K: number, T: number, sigma: number, r = RISK_FREE_RATE,
): number {
  if (T <= 0) return Math.max(K - S, 0);
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  return K * Math.exp(-r * T) * normalCDF(-d2) - S * normalCDF(-d1);
}

function bsVega(S: number, K: number, T: number, sigma: number, r = RISK_FREE_RATE): number {
  if (T <= 0) return 0;
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  return S * Math.sqrt(T) * Math.exp(-0.5 * d1 * d1) / Math.sqrt(2 * Math.PI);
}

// ── IV Solver (Newton-Raphson) ────────────────────────────────────────────────

export function impliedVolatility(
  marketPrice: number,
  S: number,
  K: number,
  T: number,
  optionType: 'CE' | 'PE' = 'CE',
  r = RISK_FREE_RATE,
): number {
  const bsFn = optionType === 'CE' ? blackScholesCall : blackScholesPut;
  let sigma = 0.20;

  for (let i = 0; i < 200; i++) {
    const diff = bsFn(S, K, T, sigma, r) - marketPrice;
    if (Math.abs(diff) < 0.001) break;
    const v = bsVega(S, K, T, sigma, r);
    if (v < 1e-8) break;
    sigma = Math.max(0.001, Math.min(sigma - diff / v, 10));
  }
  return sigma;
}

// ── Calendar Spread Breakeven Calculator ──────────────────────────────────────

export interface CalendarBreakevenParams {
  spot: number;
  strike: number;
  shortPremium: number;   // near leg fill price (SELL)
  longPremium: number;    // far leg fill price (BUY)
  nearDTE: number;        // days to near expiry from today
  farDTE: number;         // days to far expiry from today
  optionType?: 'CE' | 'PE';
  r?: number;
}

/**
 * Calculate calendar spread breakevens using Black-Scholes pricing.
 *
 * At near expiry, for a given NIFTY level S:
 *   Spread value = far_leg_BS_value(S) − near_leg_intrinsic(S)
 *   Break-even  : spread value = net_debit_paid
 *
 * Uses bisection search on both sides of the strike to find exact BEs.
 * Falls back to the simple premium approximation if BS inputs are invalid.
 */
export function calcCalendarBreakevens(params: CalendarBreakevenParams): { upper: number; lower: number } {
  const {
    spot, strike, shortPremium, longPremium,
    nearDTE, farDTE, optionType = 'CE', r = RISK_FREE_RATE,
  } = params;

  const netDebit = longPremium - shortPremium;
  const T_near = nearDTE / 365;
  const T_rem  = Math.max((farDTE - nearDTE) / 365, 1 / 365); // far leg remaining after near expires

  // Back-calculate IV from both legs; far-leg IV projects far-leg value more accurately.
  // Weighted average (60% far, 40% near) closely matches broker breakeven calculations.
  const T_far = farDTE / 365;
  const ivNear = T_near > 0
    ? impliedVolatility(shortPremium, spot, strike, T_near, optionType, r)
    : 0.20;
  const ivFar = T_far > 0
    ? impliedVolatility(longPremium, spot, strike, T_far, optionType, r)
    : ivNear;
  const sigma = 0.4 * ivNear + 0.6 * ivFar;

  const bsFn = optionType === 'CE' ? blackScholesCall : blackScholesPut;
  const intrinsic = (S: number) =>
    optionType === 'CE' ? Math.max(S - strike, 0) : Math.max(strike - S, 0);

  // f(S) = far_leg_value_at_near_expiry(S) − near_leg_intrinsic(S) − net_debit
  // Break-even when f(S) = 0; profitable when f(S) > 0
  const f = (S: number) => bsFn(S, strike, T_rem, sigma, r) - intrinsic(S) - netDebit;

  const fAtStrike = f(strike);
  // If spread isn't profitable even at strike, fall back to simple approximation
  if (fAtStrike <= 0) {
    return { upper: strike + longPremium, lower: strike - shortPremium };
  }

  // ── Upper breakeven (above strike) ──────────────────────────────────────────
  let upper = strike + longPremium; // fallback
  {
    const hi = strike * 1.8;
    if (f(hi) < 0) {
      let lo = strike, hiB = hi;
      for (let i = 0; i < 200; i++) {
        const mid = (lo + hiB) / 2;
        if (f(mid) > 0) lo = mid; else hiB = mid;
        if (hiB - lo < 0.5) break;
      }
      upper = Math.round((lo + hiB) / 2);
    }
  }

  // ── Lower breakeven (below strike) ──────────────────────────────────────────
  let lower = strike - shortPremium; // fallback
  {
    const lo = strike * 0.4;
    if (f(lo) < 0) {
      let loB = lo, hi = strike;
      for (let i = 0; i < 200; i++) {
        const mid = (loB + hi) / 2;
        if (f(mid) > 0) hi = mid; else loB = mid;
        if (hi - loB < 0.5) break;
      }
      lower = Math.round((loB + hi) / 2);
    }
  }

  return { upper, lower };
}
