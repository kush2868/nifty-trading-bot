import { atmStrike, buildOptionSymbol, parseOptionSymbol, calcBreakEvens, totalQty } from '../utils/instrumentUtils';

describe('atmStrike', () => {
  it('rounds to nearest 50 correctly', () => {
    expect(atmStrike(22480)).toBe(22500);
    expect(atmStrike(22524)).toBe(22500);
    expect(atmStrike(22526)).toBe(22550);
    expect(atmStrike(22550)).toBe(22550);
    expect(atmStrike(22501)).toBe(22500);
    expect(atmStrike(22575)).toBe(22600);
  });

  it('handles exact strikes', () => {
    expect(atmStrike(22000)).toBe(22000);
    expect(atmStrike(23000)).toBe(23000);
  });
});

describe('buildOptionSymbol', () => {
  it('builds NIFTY call symbol correctly', () => {
    // expiryDateStr = DDMMMYY → e.g., '27JUN24'
    expect(buildOptionSymbol('27JUN24', 22500, 'CE')).toBe('NIFTY24JUN22500CE');
    expect(buildOptionSymbol('25JUL24', 23000, 'PE')).toBe('NIFTY24JUL23000PE');
  });
});

describe('parseOptionSymbol', () => {
  it('parses valid NIFTY symbol', () => {
    const result = parseOptionSymbol('NIFTY24JUN22500CE');
    expect(result).toEqual({ underlying: 'NIFTY', year: '24', month: 'JUN', strike: 22500, type: 'CE' });
  });

  it('parses PUT symbol', () => {
    const result = parseOptionSymbol('NIFTY24DEC21000PE');
    expect(result).toEqual({ underlying: 'NIFTY', year: '24', month: 'DEC', strike: 21000, type: 'PE' });
  });

  it('returns null for invalid symbol', () => {
    expect(parseOptionSymbol('INVALID')).toBeNull();
    expect(parseOptionSymbol('NIFTY24XXX22500CE')).toBeNull();
  });
});

describe('calcBreakEvens', () => {
  it('computes asymmetric break-evens: upper = strike + longPremium, lower = strike - shortPremium', () => {
    const { upper, lower } = calcBreakEvens(22500, 150, 200);
    expect(upper).toBe(22700); // 22500 + 200 (far leg)
    expect(lower).toBe(22350); // 22500 - 150 (near leg)
  });

  it('handles zero premiums', () => {
    const { upper, lower } = calcBreakEvens(22500, 0, 0);
    expect(upper).toBe(22500);
    expect(lower).toBe(22500);
  });
});

describe('totalQty', () => {
  it('computes total quantity from lots', () => {
    expect(totalQty(1, 75)).toBe(75);
    expect(totalQty(2, 75)).toBe(150);
    expect(totalQty(3, 50)).toBe(150);
  });
});
