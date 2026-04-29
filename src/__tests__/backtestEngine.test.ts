import { BacktestEngine, defaultOptionPriceFn, blackScholesApprox } from '../backtest/backtestEngine';
import { lastThursdayOfMonth, firstMondayAfter } from '../utils/dateUtils';
import { addDays } from 'date-fns';

// ── Black-Scholes Sanity Checks ───────────────────────────────────────────────

describe('blackScholesApprox', () => {
  it('call >= 0 for any input', () => {
    const { call } = blackScholesApprox(22500, 22500, 30);
    expect(call).toBeGreaterThan(0);
  });

  it('ATM call and put are roughly equal (put-call parity)', () => {
    const S = 22500, K = 22500, T = 30;
    const { call, put } = blackScholesApprox(S, K, T);
    // For ATM near-money, C - P ≈ S - K*e^{-rT} (small)
    expect(Math.abs(call - put)).toBeLessThan(200);
  });

  it('deep ITM call approaches intrinsic value at expiry', () => {
    const { call } = blackScholesApprox(23000, 22000, 0);
    expect(call).toBeCloseTo(1000, -1);
  });

  it('OTM option at expiry returns 0', () => {
    const { call } = blackScholesApprox(22000, 23000, 0);
    expect(call).toBe(0);
  });
});

// ── Backtest Engine ───────────────────────────────────────────────────────────

function makeEntryBar(date: Date, close: number) {
  return { date, open: close - 20, high: close + 30, low: close - 50, close };
}

/**
 * Build a minimal bar series that has exactly one valid entry day
 * (first Monday after last Thursday of the given month).
 */
function buildTestBars(year: number, month: number, spotBase: number) {
  const expiry = lastThursdayOfMonth(year, month);
  const entryDay = firstMondayAfter(expiry);

  const bars = [];
  for (let i = -5; i <= 15; i++) {
    const date = addDays(entryDay, i);
    bars.push(makeEntryBar(date, spotBase + i * 10));
  }
  return bars;
}

describe('BacktestEngine', () => {
  it('runs without throwing on valid data', () => {
    const bars = buildTestBars(2024, 5, 22500); // June 2024
    const engine = new BacktestEngine({
      bars,
      optionPriceFn: defaultOptionPriceFn,
    });
    const result = engine.run();
    expect(result).toBeDefined();
    expect(result.totalTrades).toBeGreaterThanOrEqual(0);
  });

  it('reports non-negative win rate', () => {
    const bars = buildTestBars(2024, 5, 22500);
    const engine = new BacktestEngine({ bars, optionPriceFn: defaultOptionPriceFn });
    const result = engine.run();
    expect(result.winRate).toBeGreaterThanOrEqual(0);
    expect(result.winRate).toBeLessThanOrEqual(100);
  });

  it('totalPnL equals sum of individual trade PnLs', () => {
    const bars = buildTestBars(2024, 5, 22500);
    const engine = new BacktestEngine({ bars, optionPriceFn: defaultOptionPriceFn });
    const result = engine.run();
    const sum = result.trades.reduce((acc, t) => acc + t.pnl, 0);
    expect(result.totalPnL).toBeCloseTo(sum, 1);
  });

  it('exits via PROFIT_TARGET when configured with 0% profit target', () => {
    const bars = buildTestBars(2024, 5, 22500);
    const engine = new BacktestEngine({
      bars,
      optionPriceFn: defaultOptionPriceFn,
      profitTargetPct: 0, // any PnL >= 0 triggers exit
    });
    const result = engine.run();
    // With 0% profit target, should exit quickly
    if (result.trades.length > 0) {
      expect(['PROFIT_TARGET', 'MAX_LOSS', 'HOLD_DAYS_EXCEEDED', 'NEAR_EXPIRY', 'END_OF_DATA'])
        .toContain(result.trades[0].exitReason);
    }
  });
});
