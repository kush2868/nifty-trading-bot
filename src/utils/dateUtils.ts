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
 * Find the last Thursday of a given month/year.
 * Kite typically uses last Thursday as monthly expiry.
 */
export function lastThursdayOfMonth(year: number, month: number): Date {
  // month is 0-indexed (JS Date convention)
  const lastDay = lastDayOfMonth(new Date(year, month, 1));
  let d = lastDay;
  while (getDay(d) !== 4) {
    // 4 = Thursday
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
 * Return true if today (IST) is the first Monday after this month's expiry
 * AND current time is after 15:20 IST.
 */
export function isEntryDay(): boolean {
  const ist = nowIST();
  const year = ist.getFullYear();
  const month = ist.getMonth();

  const expiry = lastThursdayOfMonth(year, month);
  const entryDay = firstMondayAfter(expiry);

  const todayIST = startOfDay(ist);
  const entryDayIST = startOfDay(toIST(entryDay));

  if (todayIST.getTime() !== entryDayIST.getTime()) return false;

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
    const exp = lastThursdayOfMonth(year, month);
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
