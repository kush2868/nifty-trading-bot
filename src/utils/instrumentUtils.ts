import { config } from '../config';

export type OptionType = 'CE' | 'PE';
export type ExchangeSegment = 'NFO' | 'NSE' | 'BSE';

/**
 * Round a price to the nearest valid NIFTY strike.
 */
export function atmStrike(spotPrice: number, strikeGap = config.strategy.strikeGap): number {
  return Math.round(spotPrice / strikeGap) * strikeGap;
}

/**
 * Build a NIFTY monthly option trading symbol.
 *
 * Format: NIFTY{YY}{MON}{STRIKE}{CE|PE}
 * Example: NIFTY24JUN22500CE
 *
 * @param expiryDateStr  DDMMMYY formatted expiry (e.g. "27JUN24")
 * @param strike         Integer strike price (e.g. 22500)
 * @param type           CE or PE
 */
export function buildOptionSymbol(
  expiryDateStr: string,
  strike: number,
  type: OptionType,
): string {
  // expiryDateStr is already in DDMMMYY form from formatKiteExpiry()
  // Kite NFO symbols use: NIFTY + YY + MON (3 chars) + STRIKE + TYPE
  // Extract YYMM from DDMMMYY: chars [2..7]
  const yy = expiryDateStr.slice(5, 7);   // last 2 chars = year
  const mon = expiryDateStr.slice(2, 5);  // chars 2-4 = month abbreviation
  return `NIFTY${yy}${mon}${strike}${type}`;
}

/**
 * Parse a Kite NFO option symbol back to its components.
 * Returns null if the symbol does not match the expected pattern.
 */
export function parseOptionSymbol(symbol: string): {
  underlying: string;
  year: string;
  month: string;
  strike: number;
  type: OptionType;
} | null {
  const match = symbol.match(/^(NIFTY|BANKNIFTY)(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d+)(CE|PE)$/);
  if (!match) return null;
  return {
    underlying: match[1],
    year: match[2],
    month: match[3],
    strike: parseInt(match[4], 10),
    type: match[5] as OptionType,
  };
}

/** Compute total quantity from lots. */
export function totalQty(lots: number, lotSize = config.strategy.lotSize): number {
  return lots * lotSize;
}

/** Compute capital required for a spread given premiums. */
export function spreadCapitalRequired(
  shortPremium: number,
  longPremium: number,
  lots: number,
  lotSize = config.strategy.lotSize,
): number {
  const netDebit = longPremium - shortPremium;
  const qty = lots * lotSize;
  return netDebit > 0 ? netDebit * qty : 0;
}

/**
 * Calculate upper and lower break-even levels for a calendar spread.
 *
 * For a long calendar spread (buy far, sell near) centered at ATM:
 *   - The short premium defines how far the spot can move before loss.
 *   - Simplified: BE levels = strike ± short_leg_premium
 */
export function calcBreakEvens(
  atmStrikePrice: number,
  shortLegPremium: number,
): { upper: number; lower: number } {
  return {
    upper: atmStrikePrice + shortLegPremium,
    lower: atmStrikePrice - shortLegPremium,
  };
}
