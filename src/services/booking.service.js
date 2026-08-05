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
import * as logger from '../utils/logger.js';

/** HTTP statuses that mean "this will never succeed, stop retrying". */
const UNRECOVERABLE_STATUSES = new Set([404, 410]);

async function postBooking(accessToken, eventId) {
  const response = await apiClient.post(
    BOOKINGS_API_URL,
    { event_id: eventId },
    auth.withAuth(accessToken)
  );
  return response.data;
}

/**
 * Books a single event for a Telegram user. Handles one transparent retry
 * if the first attempt 401s with an access token that looked valid but
 * wasn't (clock skew, revoked token, etc.).
 */
export async function bookEvent(telegramId, eventId) {
  let accessToken = await auth.getValidAccessToken(telegramId);

  try {
    return await postBooking(accessToken, eventId);
  } catch (err) {
    if (err.normalized?.status === 401) {
      accessToken = await auth.renewSession(telegramId);
      return await postBooking(accessToken, eventId);
    }
    throw err;
  }
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

/** Builds the 🎾 success notification, preferring live API fields with the cached queue-item as fallback. */
function buildSuccessMessage(item, booking) {
  const event = booking?.event ?? {};
  const activityName = event.activity?.name ?? item.activityName ?? 'тренировка';
  const venueName = event.venue_name ?? item.venueName ?? '—';
  const dateStr = event.event_date ?? item.dateStr ?? '—';
  const startTime = (event.start_time ?? item.startTime ?? '').slice(0, 5);
  const endTime = (event.end_time ?? item.endTime ?? '').slice(0, 5);

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
    await storage.updateQueueItem(item.id, {
      status: 'COMPLETED',
      attempts: item.attempts + 1,
      lastAttemptAt: now,
      lastError: null,
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

async function notifySafely(bot, chatId, message) {
  try {
    await bot.telegram.sendMessage(chatId, message, { parse_mode: 'HTML' });
  } catch (err) {
    logger.error('watcher', 'Failed to notify user', { chatId, error: err.message });
  }
}
