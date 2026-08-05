/** Date/time helpers shared by the schedule and subscription/booking flows. */

import { MONTHS_RU, WEEKDAYS_EN } from '../config.js';

export function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Returns YYYY-MM-DD for the upcoming Saturday (or today if today IS Saturday).
 * Uses local wall-clock time so the date matches the user's timezone expectations.
 */
export function getNextSaturday() {
  const now = new Date();
  const daysUntilSat = now.getDay() === 6 ? 0 : 6 - now.getDay();
  const sat = new Date(now);
  sat.setDate(now.getDate() + daysUntilSat);
  return toDateStr(sat);
}

/**
 * Returns the nearest upcoming Saturday and Sunday (today counts if it IS
 * that day) as { dateStr, label } pairs — the only two days users may pick.
 */
export function getNextWeekendDates() {
  const now = new Date();
  const day = now.getDay(); // 0 = Sunday … 6 = Saturday
  const daysUntilSat = (6 - day + 7) % 7;
  const daysUntilSun = (7 - day) % 7;

  const sat = new Date(now);
  sat.setDate(now.getDate() + daysUntilSat);
  const sun = new Date(now);
  sun.setDate(now.getDate() + daysUntilSun);

  return {
    saturday: { dateStr: toDateStr(sat), label: `Суббота, ${sat.getDate()} ${MONTHS_RU[sat.getMonth()]}` },
    sunday: { dateStr: toDateStr(sun), label: `Воскресенье, ${sun.getDate()} ${MONTHS_RU[sun.getMonth()]}` },
  };
}

/** Converts "2026-06-27" → "27 июня 2026" */
export function formatDateRu(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${d} ${MONTHS_RU[m - 1]} ${y}`;
}

/** Computes the English lowercase weekday name the API expects for a given YYYY-MM-DD. */
export function dayOfWeekFor(dateStr) {
  const date = new Date(`${dateStr}T00:00:00`);
  return WEEKDAYS_EN[date.getDay()];
}

/** True once an event's date+start_time is in the past. */
export function hasEventStarted(dateStr, startTime) {
  return Date.now() >= new Date(`${dateStr}T${startTime}`).getTime();
}
