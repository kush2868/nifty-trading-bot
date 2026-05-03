/**
 * Zerodha F&O transaction cost breakdown (per leg):
 *   Brokerage    : ₹20 flat per order
 *   STT          : 0.1% of turnover on SELL side only
 *   NSE charges  : 0.053% of turnover (both sides)
 *   GST          : 18% on (brokerage + NSE charges)
 *   Stamp duty   : 0.015% of turnover on BUY side only
 */
export function calculateTransactionCost(
  transactionType: 'BUY' | 'SELL',
  avgFillPrice: number,
  quantity: number,
): number {
  const turnover = avgFillPrice * quantity;
  const brokerage = 20;
  const stt = transactionType === 'SELL' ? turnover * 0.001 : 0;
  const nseCharges = turnover * 0.00053;
  const gst = (brokerage + nseCharges) * 0.18;
  const stampDuty = transactionType === 'BUY' ? turnover * 0.00015 : 0;
  return Math.round((brokerage + stt + nseCharges + gst + stampDuty) * 100) / 100;
}

/** Total cost for both legs of a spread (entry or exit). */
export function spreadTransactionCost(
  shortLegPrice: number,
  longLegPrice: number,
  quantity: number,
): number {
  const sellCost = calculateTransactionCost('SELL', shortLegPrice, quantity);
  const buyCost = calculateTransactionCost('BUY', longLegPrice, quantity);
  return sellCost + buyCost;
}
