import { logger } from '../utils/logger';
import { atmStrike, calcBreakEvens, totalQty } from '../utils/instrumentUtils';
import { lastTuesdayOfMonth, firstMondayAfter, daysUntilExpiry } from '../utils/dateUtils';
import { config } from '../config';
import { addDays, getDay, startOfDay, isBefore, isAfter } from 'date-fns';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface HistoricalBar {
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface OptionPriceFn {
  (underlying: number, strike: number, daysToExpiry: number, type: 'CE' | 'PE'): number;
}

export interface BacktestConfig {
  bars: HistoricalBar[];
  optionPriceFn: OptionPriceFn;
  capitalPerSpread?: number;
  maxSpreads?: number;
  lotSize?: number;
  lotsPerSpread?: number;
  profitTargetPct?: number;
  maxLossPct?: number;
  maxHoldDays?: number;
  adjustmentBuffer?: number;
  strikeGap?: number;
}

export interface BacktestSpread {
  strike: number;
  spreadType: 'CALL' | 'PUT';
  entryShortPremium: number;
  entryLongPremium: number;
  breakEvenUpper: number;
  breakEvenLower: number;
}

export interface BacktestTrade {
  entryDate: Date;
  exitDate: Date;
  entrySpot: number;
  baseStrike: number;
  spreads: BacktestSpread[];
  pnl: number;
  capitalDeployed: number;
  pnlPct: number;
  exitReason: string;
  holdDays: number;
}

export interface BacktestResult {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalPnL: number;
  totalCapitalDeployed: number;
  roi: number;
  maxDrawdown: number;
  avgHoldDays: number;
  trades: BacktestTrade[];
  equityCurve: { date: Date; equity: number }[];
}

// ── Engine ────────────────────────────────────────────────────────────────────

export class BacktestEngine {
  private cfg: Required<BacktestConfig>;

  constructor(input: BacktestConfig) {
    this.cfg = {
      bars: input.bars,
      optionPriceFn: input.optionPriceFn,
      capitalPerSpread: input.capitalPerSpread ?? config.strategy.capitalPerSpread,
      maxSpreads: input.maxSpreads ?? config.strategy.maxSpreads,
      lotSize: input.lotSize ?? config.strategy.lotSize,
      lotsPerSpread: input.lotsPerSpread ?? config.strategy.lotsPerSpread,
      profitTargetPct: input.profitTargetPct ?? config.risk.profitTargetPct,
      maxLossPct: input.maxLossPct ?? config.risk.maxLossPct,
      maxHoldDays: input.maxHoldDays ?? config.risk.maxHoldDays,
      adjustmentBuffer: input.adjustmentBuffer ?? config.strategy.adjustmentBuffer,
      strikeGap: input.strikeGap ?? config.strategy.strikeGap,
    };
  }

  run(): BacktestResult {
    const { bars } = this.cfg;
    const trades: BacktestTrade[] = [];
    const equityCurve: { date: Date; equity: number }[] = [];
    let cumulativeEquity = 0;
    let maxEquity = 0;
    let maxDrawdown = 0;
    let i = 0;

    while (i < bars.length) {
      const bar = bars[i];

      if (!this.isEntryBar(bar)) {
        equityCurve.push({ date: bar.date, equity: cumulativeEquity });
        i++;
        continue;
      }

      // Open a new trade
      const trade = this.simulateTrade(bars, i);
      if (!trade) { i++; continue; }

      trades.push(trade);
      cumulativeEquity += trade.pnl;

      // Track drawdown
      if (cumulativeEquity > maxEquity) maxEquity = cumulativeEquity;
      const dd = maxEquity - cumulativeEquity;
      if (dd > maxDrawdown) maxDrawdown = dd;

      equityCurve.push({ date: trade.exitDate, equity: cumulativeEquity });

      // Advance past trade exit
      const exitIdx = bars.findIndex((b) => !isBefore(b.date, trade.exitDate));
      i = exitIdx === -1 ? bars.length : exitIdx + 1;
    }

    const winners = trades.filter((t) => t.pnl > 0);
    const losers = trades.filter((t) => t.pnl <= 0);
    const totalCapital = trades.reduce((s, t) => s + t.capitalDeployed, 0);
    const totalPnL = trades.reduce((s, t) => s + t.pnl, 0);
    const avgHoldDays = trades.length > 0
      ? trades.reduce((s, t) => s + t.holdDays, 0) / trades.length
      : 0;

    return {
      totalTrades: trades.length,
      winningTrades: winners.length,
      losingTrades: losers.length,
      winRate: trades.length > 0 ? (winners.length / trades.length) * 100 : 0,
      totalPnL,
      totalCapitalDeployed: totalCapital,
      roi: totalCapital > 0 ? (totalPnL / totalCapital) * 100 : 0,
      maxDrawdown,
      avgHoldDays,
      trades,
      equityCurve,
    };
  }

  private simulateTrade(bars: HistoricalBar[], entryIdx: number): BacktestTrade | null {
    const entryBar = bars[entryIdx];
    const entrySpot = entryBar.close;
    const strike = atmStrike(entrySpot, this.cfg.strikeGap);
    const qty = totalQty(this.cfg.lotsPerSpread, this.cfg.lotSize);

    // Compute expiries from bar date
    const year = entryBar.date.getFullYear();
    const month = entryBar.date.getMonth();
    const nearExpiry = lastTuesdayOfMonth(year, month);
    const farExpiry = month < 11
      ? lastTuesdayOfMonth(year, month + 1)
      : lastTuesdayOfMonth(year + 1, 0);

    const nearDTE = Math.max(1, Math.round((nearExpiry.getTime() - entryBar.date.getTime()) / 86400000));
    const farDTE = Math.max(1, Math.round((farExpiry.getTime() - entryBar.date.getTime()) / 86400000));

    const shortPremium = this.cfg.optionPriceFn(entrySpot, strike, nearDTE, 'CE');
    const longPremium = this.cfg.optionPriceFn(entrySpot, strike, farDTE, 'CE');

    if (shortPremium <= 0 || longPremium <= 0) return null;

    const be = calcBreakEvens(strike, shortPremium, longPremium);
    const spreads: BacktestSpread[] = [{
      strike,
      spreadType: 'CALL',
      entryShortPremium: shortPremium,
      entryLongPremium: longPremium,
      breakEvenUpper: be.upper,
      breakEvenLower: be.lower,
    }];

    let capitalDeployed = Math.max(0, longPremium - shortPremium) * qty;

    // Simulate day by day
    for (let j = entryIdx + 1; j < bars.length; j++) {
      const bar = bars[j];
      const holdDays = Math.round((bar.date.getTime() - entryBar.date.getTime()) / 86400000);
      const spot = bar.close;

      // Check adjustments
      if (spreads.length < this.cfg.maxSpreads) {
        const tightest = this.tightestBE(spreads);
        if (spot >= tightest.upper - this.cfg.adjustmentBuffer) {
          const newStrike = strike + this.cfg.strikeGap;
          const newDTE = Math.max(1, Math.round((nearExpiry.getTime() - bar.date.getTime()) / 86400000));
          const sp = this.cfg.optionPriceFn(spot, newStrike, newDTE, 'CE');
          const lp = this.cfg.optionPriceFn(spot, newStrike, nearDTE + 30, 'CE');
          const newBE = calcBreakEvens(newStrike, sp, lp);
          spreads.push({ strike: newStrike, spreadType: 'CALL', entryShortPremium: sp, entryLongPremium: lp, ...newBE });
          capitalDeployed += Math.max(0, lp - sp) * qty;
        } else if (spot <= tightest.lower + this.cfg.adjustmentBuffer) {
          const newStrike = strike - this.cfg.strikeGap;
          const newDTE = Math.max(1, Math.round((nearExpiry.getTime() - bar.date.getTime()) / 86400000));
          const sp = this.cfg.optionPriceFn(spot, newStrike, newDTE, 'PE');
          const lp = this.cfg.optionPriceFn(spot, newStrike, nearDTE + 30, 'PE');
          const newBE = calcBreakEvens(newStrike, sp, lp);
          spreads.push({ strike: newStrike, spreadType: 'PUT', entryShortPremium: sp, entryLongPremium: lp, ...newBE });
          capitalDeployed += Math.max(0, lp - sp) * qty;
        }
      }

      // Compute PnL
      const pnl = this.computePnL(spreads, spot, bar, nearExpiry, farExpiry, qty);
      const pnlPct = capitalDeployed > 0 ? (pnl / capitalDeployed) * 100 : 0;

      // Check exit
      let exitReason = '';
      if (pnlPct >= this.cfg.profitTargetPct) exitReason = 'PROFIT_TARGET';
      else if (pnlPct <= -this.cfg.maxLossPct) exitReason = 'MAX_LOSS';
      else if (holdDays >= this.cfg.maxHoldDays) exitReason = 'HOLD_DAYS_EXCEEDED';
      else if (daysUntilExpiry(nearExpiry) <= 3) exitReason = 'NEAR_EXPIRY';

      if (exitReason) {
        return {
          entryDate: entryBar.date,
          exitDate: bar.date,
          entrySpot,
          baseStrike: strike,
          spreads,
          pnl,
          capitalDeployed,
          pnlPct,
          exitReason,
          holdDays,
        };
      }
    }

    // Ran out of data — force exit at last bar
    const lastBar = bars[bars.length - 1];
    const holdDays = Math.round((lastBar.date.getTime() - entryBar.date.getTime()) / 86400000);
    const pnl = this.computePnL(spreads, lastBar.close, lastBar, nearExpiry, farExpiry, qty);
    const pnlPct = capitalDeployed > 0 ? (pnl / capitalDeployed) * 100 : 0;
    return { entryDate: entryBar.date, exitDate: lastBar.date, entrySpot, baseStrike: strike, spreads, pnl, capitalDeployed, pnlPct, exitReason: 'END_OF_DATA', holdDays };
  }

  private computePnL(
    spreads: BacktestSpread[],
    spot: number,
    bar: HistoricalBar,
    nearExpiry: Date,
    farExpiry: Date,
    qty: number,
  ): number {
    let pnl = 0;
    const nearDTE = Math.max(0, Math.round((nearExpiry.getTime() - bar.date.getTime()) / 86400000));
    const farDTE = Math.max(0, Math.round((farExpiry.getTime() - bar.date.getTime()) / 86400000));
    const optType: 'CE' | 'PE' = 'CE';

    for (const spread of spreads) {
      const currentShort = this.cfg.optionPriceFn(spot, spread.strike, nearDTE, optType);
      const currentLong = this.cfg.optionPriceFn(spot, spread.strike, farDTE, optType);
      const shortPnL = (spread.entryShortPremium - currentShort) * qty;
      const longPnL = (currentLong - spread.entryLongPremium) * qty;
      pnl += shortPnL + longPnL;
    }

    return pnl;
  }

  private tightestBE(spreads: BacktestSpread[]): { upper: number; lower: number } {
    let upper = Infinity, lower = -Infinity;
    for (const s of spreads) {
      if (s.breakEvenUpper < upper) upper = s.breakEvenUpper;
      if (s.breakEvenLower > lower) lower = s.breakEvenLower;
    }
    return { upper, lower };
  }

  private isEntryBar(bar: HistoricalBar): boolean {
    const d = bar.date;
    const year = d.getFullYear();
    const month = d.getMonth();
    const expiry = lastTuesdayOfMonth(year, month);
    const entryDay = firstMondayAfter(expiry);
    return startOfDay(d).getTime() === startOfDay(entryDay).getTime();
  }
}

// ── Simple Black-Scholes approximation for backtesting ───────────────────────

export function blackScholesApprox(
  S: number,
  K: number,
  T: number, // days to expiry
  sigma = 0.18,
  r = 0.065,
): { call: number; put: number } {
  const t = T / 365;
  if (t <= 0) {
    const call = Math.max(0, S - K);
    const put = Math.max(0, K - S);
    return { call, put };
  }
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma ** 2) * t) / (sigma * Math.sqrt(t));
  const d2 = d1 - sigma * Math.sqrt(t);
  const N = normalCDF;
  const call = S * N(d1) - K * Math.exp(-r * t) * N(d2);
  const put = K * Math.exp(-r * t) * N(-d2) - S * N(-d1);
  return { call, put };
}

function normalCDF(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1.0 + sign * y);
}

/** Convenience option price function using B-S approximation. */
export const defaultOptionPriceFn: OptionPriceFn = (underlying, strike, daysToExpiry, type) => {
  const { call, put } = blackScholesApprox(underlying, strike, daysToExpiry);
  return type === 'CE' ? Math.max(0.05, call) : Math.max(0.05, put);
};
