import { toZonedTime, fromZonedTime } from 'date-fns-tz';
import { addDays, setHours, setMinutes, setSeconds, setMilliseconds, getDay, lastDayOfMonth, isBefore, startOfDay } from 'date-fns';

export const IST_TZ = 'Asia/Kolkata';

/** Return current time in IST. */
export function nowIST(): Date {
  return toZonedTime(new Date(), IST_TZ);
}

/** Convert a UTC Date to IST. */
export function toIST(date: Date): Date {
  return toZonedTime(date, IST_TZ);
}

/** Convert an IST wall-clock date to a UTC Date. */
export function fromIST(date: Date): Date {
  return fromZonedTime(date, IST_TZ);
}

/** Build an IST time for today at HH:MM:SS. */
export function todayAtIST(hours: number, minutes: number, seconds = 0): Date {
  const ist = nowIST();
  const d = setMilliseconds(setSeconds(setMinutes(setHours(ist, hours), minutes), seconds), 0);
  return fromZonedTime(d, IST_TZ); // back to UTC for comparison
}

/**
 * Find the last Tuesday of a given month/year.
 * NIFTY monthly options expire on the last Tuesday of the month.
 */
export function lastTuesdayOfMonth(year: number, month: number): Date {
  // month is 0-indexed (JS Date convention)
  const lastDay = lastDayOfMonth(new Date(year, month, 1));
  let d = lastDay;
  while (getDay(d) !== 2) {
    // 2 = Tuesday
    d = addDays(d, -1);
  }
  return d;
}

/**
 * Find the first Monday strictly after the given date.
 */
export function firstMondayAfter(date: Date): Date {
  let d = addDays(date, 1);
  while (getDay(d) !== 1) {
    // 1 = Monday
    d = addDays(d, 1);
  }
  return d;
}

/**
 * Return true if the current time is within NSE market hours (Mon–Fri, 9:15–15:30 IST).
 */
export function isMarketOpen(): boolean {
  const ist = nowIST();
  const day = getDay(ist);
  if (day === 0 || day === 6) return false; // Sunday or Saturday
  const open = todayAtIST(9, 15);
  const close = todayAtIST(15, 30);
  const now = new Date();
  return !isBefore(now, open) && isBefore(now, close);
}

/**
 * Return true if today (IST) falls within the monthly entry window
 * AND current time is after 15:20 IST.
 *
 * Entry window:
 *   Start — first Monday after previous month's expiry
 *   End   — 7 days before current month's expiry (inclusive)
 */
export function isEntryDay(): boolean {
  const ist = nowIST();
  const year = ist.getFullYear();
  const month = ist.getMonth();

  // Window start: first Monday after previous month's expiry
  const prevMonth = month === 0 ? 11 : month - 1;
  const prevYear = month === 0 ? year - 1 : year;
  const prevExpiry = lastTuesdayOfMonth(prevYear, prevMonth);
  const windowStart = firstMondayAfter(prevExpiry);

  // Window end: 7 days before current month's expiry (inclusive)
  const currentExpiry = lastTuesdayOfMonth(year, month);
  const windowEnd = addDays(currentExpiry, -7);

  const todayIST = startOfDay(ist);
  const windowStartIST = startOfDay(toIST(windowStart));
  const windowEndIST = startOfDay(toIST(windowEnd));

  const inWindow =
    !isBefore(todayIST, windowStartIST) &&
    !isBefore(windowEndIST, todayIST);

  if (!inWindow) return false;

  const entryTime = todayAtIST(15, 20);
  return !isBefore(new Date(), entryTime);
}

/**
 * Days until expiry (from today in IST).
 * Returns a negative number if expiry is in the past.
 */
export function daysUntilExpiry(expiryDate: Date): number {
  const ist = nowIST();
  const expiryIST = toIST(expiryDate);
  const diff = startOfDay(expiryIST).getTime() - startOfDay(ist).getTime();
  return Math.round(diff / (1000 * 60 * 60 * 24));
}

/**
 * Calendar days elapsed since a given date (from IST perspective).
 */
export function daysSince(date: Date): number {
  const ist = nowIST();
  const from = startOfDay(toIST(date));
  const to = startOfDay(ist);
  return Math.round((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Return the next N monthly expiry dates from now.
 */
export function upcomingExpiries(count: number): Date[] {
  const ist = nowIST();
  const expiries: Date[] = [];
  let year = ist.getFullYear();
  let month = ist.getMonth();

  while (expiries.length < count) {
    const exp = lastTuesdayOfMonth(year, month);
    if (!isBefore(exp, startOfDay(ist))) {
      expiries.push(exp);
    }
    month++;
    if (month > 11) {
      month = 0;
      year++;
    }
  }
  return expiries;
}

/** Format a date as DDMMMYY (e.g. 27JUN24) for Kite instrument symbols. */
export function formatKiteExpiry(date: Date): string {
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const ist = toIST(date);
  const dd = String(ist.getDate()).padStart(2, '0');
  const mon = months[ist.getMonth()];
  const yy = String(ist.getFullYear()).slice(-2);
  return `${dd}${mon}${yy}`;
}
