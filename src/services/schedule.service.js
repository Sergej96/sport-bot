/**
 * Schedule API access + the HTML message builders used by both the polling
 * broadcast and the interactive /schedule browser. Moved verbatim out of
 * the old monolithic bot.js.
 */

import { Markup } from 'telegraf';
import { apiClient } from './api.service.js';
import { SCHEDULE_API_URL, DEFAULT_VENUE_ID, BOOKING_URL } from '../config.js';
import { formatDateRu, getNextWeekendDates } from '../utils/dates.js';

/**
 * Fetches the schedule for one venue. `venueId` defaults to
 * DEFAULT_VENUE_ID so the non-interactive broadcast/poll paths in
 * watcher.service.js (not tied to any one user) keep working unchanged;
 * every interactive per-user flow (schedule.handler, booking.handler) passes
 * the caller's own active venue explicitly (see storage.getUserVenue).
 */
export async function fetchSchedule(dateParam, dayOfWeek = 'saturday', entryType = 'limited', venueId = DEFAULT_VENUE_ID) {
  const response = await apiClient.get(SCHEDULE_API_URL, {
    params: {
      date_param: dateParam,
      day_of_week: dayOfWeek,
      entry_type: entryType,
      venue_ids: venueId,
    },
  });
  return response.data;
}

/**
 * Builds the Saturday-or-Sunday date-picker message + keyboard — the first
 * screen of the schedule browser. Pulled out as a pure builder (rather than
 * living only in schedule.handler's sendDatePicker) so venue.handler can
 * render the exact same screen right after a venue is picked, without a
 * handler-to-handler import.
 */
export function buildDatePickerMessage() {
  const { saturday, sunday } = getNextWeekendDates();
  const text = '📅 Выбери день:';
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback(saturday.label, `d:${saturday.dateStr}`)],
    [Markup.button.callback(sunday.label, `d:${sunday.dateStr}`)],
  ]);
  return { text, keyboard };
}

/**
 * Builds the HTML notification message.
 * Shows 🟢 for open slots and 🔴 for full/waitlist sessions.
 */
export function buildNotificationMessage(dateStr, activities, totalEvents, isUpdate) {
  const dateRu = formatDateRu(dateStr);
  const header = isUpdate
    ? `🔄 Расписание тренировок на <b>${dateRu}</b> обновилось!`
    : `🔔 Появилось новое расписание тренировок на <b>${dateRu}</b>!`;

  const lines = [header, ''];

  for (const activity of activities) {
    if (!activity.events?.length) continue;

    lines.push(`<b>${activity.activity_name}:</b>`);

    for (const event of activity.events) {
      const freeSlots = event.is_unlimited
        ? '∞'
        : event.max_participants - event.occupied_slots;
      const statusIcon = event.is_full ? '🔴' : '🟢';
      const slotsLabel = event.is_full
        ? ' (лист ожидания)'
        : event.is_unlimited
        ? ''
        : ` (мест: ${freeSlots})`;

      lines.push(`  ${statusIcon} ${event.start_time} – ${event.end_time}${slotsLabel}`);
    }

    lines.push('');
  }

  lines.push(`<i>Всего мероприятий: ${totalEvents}</i>`);
  return lines.join('\n');
}

/**
 * Builds the time-slot message + inline keyboard for a single activity on a
 * single date.
 *
 * Buttons depend on the event state and whether the caller has an
 * authenticated спортдлявсех.бел session (`isLoggedIn`):
 *   - Full, logged in    → "🔔 Notify Me" (one-shot) + "🤖 Auto-book" (waitlist queue)
 *   - Full, logged out   → "🔔 Notify Me" only (existing behavior)
 *   - Open, logged in    → "✅ Book now" (calls the booking API directly)
 *   - Open, logged out   → "✅ Book" deep-link to the venue's site (existing behavior)
 * Ends with a "◀️ Назад" button back to the activity list.
 */
export function buildEventListMessage(dateStr, activity, isLoggedIn = false) {
  const dateRu = formatDateRu(dateStr);
  const lines = [`📅 <b>${dateRu}</b>`, `<b>${activity.activity_name}</b>`, ''];
  const keyboardRows = [];

  for (const event of activity.events) {
    const timeLabel = `${event.start_time.slice(0, 5)}–${event.end_time.slice(0, 5)}`;
    const statusIcon = event.is_full ? '🔴' : '🟢';
    const slotsLabel = event.is_unlimited
      ? 'без ограничений'
      : event.is_full
      ? 'мест нет'
      : `мест: ${event.max_participants - event.occupied_slots}`;

    lines.push(`  ${statusIcon} ${timeLabel} · ${event.venue_name} · ${slotsLabel}`);

    if (event.is_unlimited) continue;

    if (event.is_full) {
      const row = [Markup.button.callback(`🔔 Уведомить ${timeLabel}`, `n:${dateStr}:${event.event_id}`)];
      if (isLoggedIn) {
        row.push(Markup.button.callback(`🤖 Авто-бронь ${timeLabel}`, `q:${dateStr}:${event.event_id}`));
      }
      keyboardRows.push(row);
    } else if (isLoggedIn) {
      keyboardRows.push([
        Markup.button.callback(`✅ Забронировать ${timeLabel}`, `bk:${dateStr}:${event.event_id}`),
      ]);
    } else {
      keyboardRows.push([
        Markup.button.url(`✅ Записаться ${timeLabel}`, BOOKING_URL),
      ]);
    }
  }

  keyboardRows.push([Markup.button.callback('◀️ Назад', `b:acts:${dateStr}`)]);

  return { text: lines.join('\n'), keyboard: Markup.inlineKeyboard(keyboardRows) };
}

/** Builds the "slot just opened" alert message for a one-shot subscription. */
export function buildSlotOpenedMessage(sub, event) {
  return (
    `🔥 <b>Освободилось место!</b>\n` +
    `🏋️ Тренировка: <b>${sub.activity_name}</b>\n` +
    `⏰ Время: ${event.start_time.slice(0, 5)}–${event.end_time.slice(0, 5)}\n` +
    `📍 Место: ${sub.venue_name}\n\n` +
    `Успей записаться, пока не заняли!`
  );
}
