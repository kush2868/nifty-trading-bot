/**
 * Backtest CLI Runner
 * Usage: npx ts-node src/backtest/run.ts
 *
 * Loads historical NIFTY data from a CSV file and runs the backtest engine.
 * CSV format (header row): date,open,high,low,close
 * date format: YYYY-MM-DD
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { BacktestEngine, defaultOptionPriceFn, HistoricalBar, BacktestResult } from './backtestEngine';

async function loadCSV(filePath: string): Promise<HistoricalBar[]> {
  const bars: HistoricalBar[] = [];
  const rl = readline.createInterface({ input: fs.createReadStream(filePath) });
  let header = true;

  for await (const line of rl) {
    if (header) { header = false; continue; }
    const [date, open, high, low, close] = line.split(',');
    if (!date || !close) continue;
    bars.push({
      date: new Date(date.trim()),
      open: parseFloat(open),
      high: parseFloat(high),
      low: parseFloat(low),
      close: parseFloat(close),
    });
  }
  return bars.sort((a, b) => a.date.getTime() - b.date.getTime());
}

function printResult(result: BacktestResult): void {
  console.log('\n==============================');
  console.log('       BACKTEST RESULTS        ');
  console.log('==============================');
  console.log(`Total Trades       : ${result.totalTrades}`);
  console.log(`Winning Trades     : ${result.winningTrades}`);
  console.log(`Losing Trades      : ${result.losingTrades}`);
  console.log(`Win Rate           : ${result.winRate.toFixed(2)}%`);
  console.log(`Total PnL          : ₹${result.totalPnL.toFixed(2)}`);
  console.log(`Capital Deployed   : ₹${result.totalCapitalDeployed.toFixed(2)}`);
  console.log(`ROI                : ${result.roi.toFixed(2)}%`);
  console.log(`Max Drawdown       : ₹${result.maxDrawdown.toFixed(2)}`);
  console.log(`Avg Hold Days      : ${result.avgHoldDays.toFixed(1)}`);
  console.log('==============================\n');

  if (result.trades.length > 0) {
    console.log('Individual Trades:');
    console.log('-'.repeat(90));
    console.log(
      'Entry'.padEnd(14) + 'Exit'.padEnd(14) + 'Strike'.padEnd(10) +
      'PnL'.padEnd(14) + 'PnL%'.padEnd(10) + 'Days'.padEnd(8) + 'Reason'
    );
    console.log('-'.repeat(90));
    for (const t of result.trades) {
      console.log(
        t.entryDate.toISOString().slice(0, 10).padEnd(14) +
        t.exitDate.toISOString().slice(0, 10).padEnd(14) +
        String(t.baseStrike).padEnd(10) +
        `₹${t.pnl.toFixed(0)}`.padEnd(14) +
        `${t.pnlPct.toFixed(1)}%`.padEnd(10) +
        String(t.holdDays).padEnd(8) +
        t.exitReason
      );
    }
    console.log('-'.repeat(90));
  }
}

async function main(): Promise<void> {
  const dataFile = process.argv[2] ?? path.resolve(process.cwd(), 'data', 'nifty_daily.csv');

  if (!fs.existsSync(dataFile)) {
    console.error(`Data file not found: ${dataFile}`);
    console.error('Usage: npx ts-node src/backtest/run.ts [path/to/nifty_daily.csv]');
    console.error('CSV format: date,open,high,low,close (header row required)');
    process.exit(1);
  }

  console.log(`Loading historical data from: ${dataFile}`);
  const bars = await loadCSV(dataFile);
  console.log(`Loaded ${bars.length} bars (${bars[0]?.date.toISOString().slice(0, 10)} → ${bars[bars.length - 1]?.date.toISOString().slice(0, 10)})`);

  const engine = new BacktestEngine({
    bars,
    optionPriceFn: defaultOptionPriceFn,
  });

  console.log('Running backtest...');
  const result = engine.run();
  printResult(result);

  // Optional: write equity curve to file
  const outFile = path.resolve(process.cwd(), 'backtest_result.json');
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
  console.log(`Full results written to: ${outFile}`);
}

main().catch((err) => {
  console.error('Backtest failed:', err);
  process.exit(1);
});
