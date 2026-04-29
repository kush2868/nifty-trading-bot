import {
  lastThursdayOfMonth,
  firstMondayAfter,
  daysUntilExpiry,
  daysSince,
  formatKiteExpiry,
} from '../utils/dateUtils';

describe('lastThursdayOfMonth', () => {
  it('finds last Thursday correctly for known months', () => {
    // June 2024: last Thursday = June 27
    const jun2024 = lastThursdayOfMonth(2024, 5); // month is 0-indexed
    expect(jun2024.getDate()).toBe(27);
    expect(jun2024.getMonth()).toBe(5);
    expect(jun2024.getDay()).toBe(4); // 4 = Thursday

    // July 2024: last Thursday = July 25
    const jul2024 = lastThursdayOfMonth(2024, 6);
    expect(jul2024.getDate()).toBe(25);
    expect(jul2024.getDay()).toBe(4);
  });

  it('always returns a Thursday', () => {
    for (let month = 0; month < 12; month++) {
      const d = lastThursdayOfMonth(2024, month);
      expect(d.getDay()).toBe(4);
    }
  });
});

describe('firstMondayAfter', () => {
  it('returns the Monday immediately after given date', () => {
    // June 27, 2024 (Thursday) → next Monday = July 1, 2024
    const thursday = new Date(2024, 5, 27);
    const monday = firstMondayAfter(thursday);
    expect(monday.getDay()).toBe(1);
    expect(monday.getDate()).toBe(1);
    expect(monday.getMonth()).toBe(6); // July
  });

  it('skips to next Monday when given a Friday', () => {
    const friday = new Date(2024, 5, 28);
    const monday = firstMondayAfter(friday);
    expect(monday.getDay()).toBe(1);
  });
});

describe('formatKiteExpiry', () => {
  it('formats date in DDMMMYY format', () => {
    // June 27, 2024
    const d = new Date(2024, 5, 27, 12, 0, 0); // UTC noon to avoid TZ issues
    const result = formatKiteExpiry(d);
    expect(result).toMatch(/^27JUN24$/);
  });
});

describe('daysSince', () => {
  it('returns 0 for today', () => {
    expect(daysSince(new Date())).toBe(0);
  });

  it('returns positive for past date', () => {
    const pastDate = new Date(Date.now() - 2 * 86400000);
    expect(daysSince(pastDate)).toBe(2);
  });
});
