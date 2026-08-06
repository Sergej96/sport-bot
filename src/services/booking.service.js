/**
 * Booking API calls + the waitlist/auto-booking queue that the background
 * watcher drains. `processQueueItem` is the single place that knows how to
 * take one queue entry from PENDING to COMPLETED/FAILED — both the watcher
 * and (if ever needed) a manual "retry now" action can call it.
 */

import { apiClient } from './api.service.js';
import { BOOKINGS_API_URL } from '../config.js';
import * as auth from './auth.service.js';
import * as storage from './storage.service.js';
import { formatDateEuro } from '../utils/dates.js';
import * as logger from '../utils/logger.js';

/** HTTP statuses that mean "this will never succeed, stop retrying". */
const UNRECOVERABLE_STATUSES = new Set([404, 410]);

// Confirmed: GET /api/v1/bookings?page_size=100 returns the caller's active
// bookings. 100 comfortably covers one user's realistic booking count in a
// single page — revisit if the API ever needs real pagination here.
const BOOKINGS_PAGE_SIZE = 100;

async function postBooking(accessToken, eventId) {
  const response = await apiClient.post(
    BOOKINGS_API_URL,
    { event_id: eventId },
    auth.withAuth(accessToken)
  );
  return response.data;
}

async function getBookings(accessToken) {
  const response = await apiClient.get(
    BOOKINGS_API_URL,
    auth.withAuth(accessToken, { params: { page_size: BOOKINGS_PAGE_SIZE } })
  );
  return response.data;
}

async function deleteBooking(accessToken, bookingId) {
  const response = await apiClient.delete(`${BOOKINGS_API_URL}/${bookingId}`, auth.withAuth(accessToken));
  return response.data;
}

/**
 * Runs `requestFn(accessToken)` with this user's current token, retrying
 * once with a freshly renewed token if the first attempt 401s (access token
 * looked valid but wasn't — clock skew, revoked token, etc.). Shared by
 * every authenticated booking-API call so the retry logic lives in one place.
 */
async function withAuthRetry(telegramId, requestFn) {
  const accessToken = await auth.getValidAccessToken(telegramId);

  try {
    return await requestFn(accessToken);
  } catch (err) {
    if (err.normalized?.status === 401) {
      const freshToken = await auth.renewSession(telegramId);
      return await requestFn(freshToken);
    }
    throw err;
  }
}

/** Books a single event for a Telegram user. */
export async function bookEvent(telegramId, eventId) {
  return withAuthRetry(telegramId, accessToken => postBooking(accessToken, eventId));
}

/**
 * Fetches this user's active bookings from спортдлявсех.бел directly (not
 * the local auto-booking queue — see storage.service.getQueue for that).
 * Confirmed: GET /bookings?page_size=100 returns the caller's own bookings.
 * The exact envelope around the array isn't confirmed, so this accepts a
 * bare array or any of the common paginated-list wrapper keys.
 */
export async function getUserBookings(telegramId) {
  const data = await withAuthRetry(telegramId, accessToken => getBookings(accessToken));
  if (Array.isArray(data)) return data;
  return data?.bookings ?? data?.items ?? data?.data ?? data?.results ?? [];
}

/**
 * Cancels a confirmed booking via the API. Does NOT touch the local
 * auto-booking queue — callers that also need to stop a related PENDING
 * queue item should call storage.cancelQueueItem separately (see
 * booking.handler.js, which does both for a queue-originated booking).
 */
export async function cancelBooking(telegramId, bookingId) {
  return withAuthRetry(telegramId, accessToken => deleteBooking(accessToken, bookingId));
}

/** Adds an event to a user's auto-booking waitlist, unless already queued. */
export async function addToQueue(telegramId, eventId, meta = {}) {
  const alreadyQueued = await storage.hasPendingQueueItem(telegramId, eventId);
  if (alreadyQueued) return null;

  return storage.addQueueItem({
    userId: telegramId,
    eventId,
    activityName: meta.activityName,
    dateStr: meta.dateStr,
    startTime: meta.startTime,
    endTime: meta.endTime,
    venueName: meta.venueName,
  });
}

/**
 * Normalizes one booking API object into the flat fields the bot displays.
 * Shared by the auto-booking success message and the /my_bookings list so
 * there's one place that knows the booking response shape.
 */
export function describeBooking(booking) {
  const event = booking?.event ?? {};
  return {
    id: booking?.id ?? booking?.booking_id ?? null,
    activityName: event.activity?.name ?? null,
    venueName: event.venue_name ?? null,
    dateStr: event.event_date ?? null,
    startTime: event.start_time ?? null,
    endTime: event.end_time ?? null,
  };
}

/** Builds the 🎾 success notification, preferring live API fields with the cached queue-item as fallback. */
function buildSuccessMessage(item, booking) {
  const desc = describeBooking(booking);
  const activityName = desc.activityName ?? item.activityName ?? 'тренировка';
  const venueName = desc.venueName ?? item.venueName ?? '—';
  const dateStr = formatDateEuro(desc.dateStr ?? item.dateStr ?? '—');
  const startTime = (desc.startTime ?? item.startTime ?? '').slice(0, 5);
  const endTime = (desc.endTime ?? item.endTime ?? '').slice(0, 5);

  return (
    `🎾 <b>Successful Auto-Booking!</b>\n` +
    `<b>Event:</b> ${activityName}\n` +
    `<b>Venue:</b> ${venueName}\n` +
    `<b>Date:</b> ${dateStr} (${startTime} - ${endTime})`
  );
}

/**
 * Attempts to book one queue item. Always resolves (never throws) — the
 * watcher loop depends on that to keep processing the rest of the FIFO
 * queue even if this item fails outright.
 */
export async function processQueueItem(item, bot) {
  const now = new Date().toISOString();

  try {
    const booking = await bookEvent(item.userId, item.eventId);
    console.log(booking)
    await storage.updateQueueItem(item.id, {
      status: 'COMPLETED',
      attempts: item.attempts + 1,
      lastAttemptAt: now,
      lastError: null,
      bookingId: describeBooking(booking).id,
    });

    logger.info('watcher', 'Auto-booking succeeded', { userId: item.userId, eventId: item.eventId });
    await bot.telegram.sendMessage(item.userId, buildSuccessMessage(item, booking), { parse_mode: 'HTML' });
  } catch (err) {
    await handleFailure(item, err, bot, now);
  }
}

async function handleFailure(item, err, bot, now) {
  if (err instanceof auth.ReauthRequiredError) {
    // Recoverable in principle (user can /login again) — keep it PENDING,
    // but only nag the user once per re-auth episode, not every tick.
    if (item.lastError !== 'reauth_required') {
      await notifySafely(bot, item.userId,
        '⚠️ Не удалось продолжить авто-бронирование — сессия истекла.\n' +
        'Отправь /login, чтобы войти снова. Запись в очереди сохранена.'
      );
    }
    await storage.updateQueueItem(item.id, {
      attempts: item.attempts + 1,
      lastAttemptAt: now,
      lastError: 'reauth_required',
    });
    return;
  }

  const status = err.normalized?.status ?? err.response?.status ?? null;

  if (status !== null && UNRECOVERABLE_STATUSES.has(status)) {
    await storage.updateQueueItem(item.id, {
      status: 'FAILED',
      attempts: item.attempts + 1,
      lastAttemptAt: now,
      lastError: `unrecoverable_http_${status}`,
    });
    logger.warn('watcher', 'Queue item marked FAILED (unrecoverable)', { id: item.id, status });
    await notifySafely(bot, item.userId,
      `❌ Бронирование отменено — занятие больше не доступно (${item.activityName ?? 'событие'}).`
    );
    return;
  }

  // Still full, 5xx, timeout, network error, etc. — just retry next tick.
  await storage.updateQueueItem(item.id, {
    attempts: item.attempts + 1,
    lastAttemptAt: now,
    lastError: err.normalized?.message ?? err.message,
  });
  logger.info('watcher', 'Auto-booking attempt failed, will retry', {
    id: item.id,
    status,
    attempts: item.attempts + 1,
  });
}

/**
 * Finds this user's already-confirmed booking for this exact training (same
 * activity + date + start time), if any — matched on those fields rather
 * than an event id since the booking API's response shape for that isn't
 * confirmed (see describeBooking). Used to keep an auto-subscription from
 * firing a duplicate booking request when the user already signed up for it
 * some other way (manually via /schedule, the venue's own site, etc.).
 */
async function findExistingBooking(telegramId, { activityName, dateStr, startTime }) {
  const bookings = await getUserBookings(telegramId);
  return (
    bookings.find(b => {
      const desc = describeBooking(b);
      return desc.activityName === activityName && desc.dateStr === dateStr && desc.startTime === startTime;
    }) ?? null
  );
}

/**
 * Handles one (preset, matched event) pair discovered by the watcher's
 * pollAutoSubscriptionPresets tick: attempts to book immediately, falling
 * back to the waitlist queue on failure/full — the spec's "Fallback &
 * Waitlist Delegation". Idempotent across ticks via
 * storage.hasAnyQueueItemForEvent, so a match that's already been handled
 * once (booked, queued, or given up on) is skipped on subsequent polls.
 */
export async function processAutoSubscriptionMatch({ userId, event, activity, dateStr }, bot) {
  const alreadyHandled = await storage.hasAnyQueueItemForEvent(userId, event.event_id);
  if (alreadyHandled) return;

  const meta = {
    activityName: activity.activity_name,
    dateStr,
    startTime: event.start_time,
    endTime: event.end_time,
    venueName: event.venue_name,
  };

  // Already signed up for this training some other way — no need to send a
  // booking request at all, just record it so future ticks skip it too.
  // Any failure here (reauth, API hiccup) just falls through to the normal
  // attempt below, which handles/reports the same failure modes anyway.
  try {
    const existingBooking = await findExistingBooking(userId, meta);
    if (existingBooking) {
      logger.info('watcher', 'Auto-subscription skipped — already booked', { userId, eventId: event.event_id });
      await storage.addCompletedQueueItem({
        userId,
        eventId: event.event_id,
        ...meta,
        bookingId: describeBooking(existingBooking).id,
      });
      return;
    }
  } catch (err) {
    logger.warn('watcher', 'Could not check existing bookings before auto-subscription attempt, proceeding anyway', {
      userId,
      eventId: event.event_id,
      error: err.message,
    });
  }

  try {
    const booking = await bookEvent(userId, event.event_id);
    await storage.addCompletedQueueItem({
      userId,
      eventId: event.event_id,
      ...meta,
      bookingId: describeBooking(booking).id,
    });

    logger.info('watcher', 'Auto-subscription booking succeeded', { userId, eventId: event.event_id });
    await notifySafely(bot, userId,
      `⚡ <b>Auto-Booking Executed!</b>\n` +
      `<b>Activity:</b> ${meta.activityName}\n` +
      `<b>Date &amp; Time:</b> ${formatDateEuro(dateStr)} at ${event.start_time.slice(0, 5)}`
    );
  } catch (err) {
    if (err instanceof auth.ReauthRequiredError) {
      logger.warn('watcher', 'Auto-subscription skipped — reauth required', { userId, eventId: event.event_id });
      await notifySafely(bot, userId,
        `⚠️ Не удалось выполнить авто-подписку на «${meta.activityName}» — сессия истекла.\n` +
        `Отправь /login, чтобы войти снова.`
      );
      return;
    }

    const status = err.normalized?.status ?? err.response?.status ?? null;
    if (status !== null && UNRECOVERABLE_STATUSES.has(status)) {
      // Event vanished/expired — nothing to fall back to.
      logger.warn('watcher', 'Auto-subscription booking unrecoverable, skipping', { userId, eventId: event.event_id, status });
      return;
    }

    // Full / 5xx / timeout — don't discard, hand it to the waitlist watcher.
    logger.info('watcher', 'Auto-subscription slot full, deferring to waitlist queue', { userId, eventId: event.event_id });
    await storage.addQueueItem({ userId, eventId: event.event_id, ...meta });
    await notifySafely(bot, userId,
      `⏳ <b>Slots Full for Auto-Subscription:</b> ${meta.activityName} (${event.start_time.slice(0, 5)}). ` +
      `Added to automatic waitlist queue — will book as soon as a spot opens!`
    );
  }
}

async function notifySafely(bot, chatId, message) {
  try {
    await bot.telegram.sendMessage(chatId, message, { parse_mode: 'HTML' });
  } catch (err) {
    logger.error('watcher', 'Failed to notify user', { chatId, error: err.message });
  }
}
