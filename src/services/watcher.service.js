/**
 * All background interval-driven jobs live here:
 *   - startSchedulePolling: the original "new/updated Saturday schedule"
 *     broadcast + one-shot "slot opened" notifications (moved from bot.js).
 *   - startBookingWatcher: the new auto-booking waitlist drain — every 60s,
 *     walks PENDING booking_queue items FIFO and retries each one via
 *     booking.service, so a slow/failing item never blocks the rest of the
 *     queue and a bad tick never crashes the process.
 */

import * as storage from './storage.service.js';
import * as scheduleService from './schedule.service.js';
import * as bookingService from './booking.service.js';
import { Markup } from 'telegraf';
import {
  ADMIN_CHAT_ID,
  BOOKING_URL,
  POLL_INTERVAL_MS,
  MAX_NOTIFICATIONS,
  MAX_CONSECUTIVE_FAILURES,
} from '../config.js';
import { getNextSaturday, dayOfWeekFor, hasEventStarted } from '../utils/dates.js';
import * as logger from '../utils/logger.js';

let consecutiveFailures = 0;

/**
 * Sends a message to all given chat IDs concurrently.
 * Uses Promise.allSettled so one failed delivery doesn't block the rest.
 */
async function broadcast(bot, message, chatIds, extra = {}) {
  if (chatIds.length === 0) {
    logger.info('broadcast', 'No subscribers, nothing to send.');
    return;
  }

  const results = await Promise.allSettled(
    chatIds.map(id => bot.telegram.sendMessage(id, message, { parse_mode: 'HTML', ...extra }))
  );

  const failed = results.filter(r => r.status === 'rejected');
  logger.info('broadcast', `Sent to ${chatIds.length - failed.length}/${chatIds.length} subscribers.`);
  failed.forEach(r => logger.error('broadcast', 'Delivery error', { error: r.reason?.message }));
}

// ─── Schedule poll tick ─────────────────────────────────────────────────────

async function pollSchedule(bot) {
  const dateParam = getNextSaturday();
  let data;

  try {
    data = await scheduleService.fetchSchedule(dateParam);
    consecutiveFailures = 0;
  } catch (err) {
    consecutiveFailures++;
    const statusCode = err.normalized?.status ?? 'N/A';
    logger.error('poll', `API error #${consecutiveFailures} (HTTP ${statusCode})`, { error: err.message });

    if (consecutiveFailures === MAX_CONSECUTIVE_FAILURES) {
      try {
        await bot.telegram.sendMessage(
          ADMIN_CHAT_ID,
          `⚠️ <b>Алерт!</b> API недоступен уже <b>${MAX_CONSECUTIVE_FAILURES}</b> раз подряд.\n\n` +
          `Последняя ошибка (HTTP ${statusCode}):\n<code>${err.message}</code>`,
          { parse_mode: 'HTML' }
        );
        logger.info('poll', 'Admin alerted.');
      } catch (alertErr) {
        logger.error('poll', 'Failed to alert admin', { error: alertErr.message });
      }
    }
    return;
  }

  const { total_events, activities } = data;
  logger.info('poll', `date=${dateParam} total_events=${total_events}`);

  if (total_events === 0) {
    logger.info('poll', 'Schedule not published yet, skipping.');
    return;
  }

  const db = await storage.readDb();

  // Purge state for any date that is no longer the target Saturday — this
  // naturally resets the notification cap when the week rolls over.
  for (const storedDate of Object.keys(db.schedule_state)) {
    if (storedDate !== dateParam) {
      delete db.schedule_state[storedDate];
    }
  }

  if (!db.schedule_state[dateParam]) {
    db.schedule_state[dateParam] = { notifications_sent: 0, last_total_events: 0 };
  }

  const state = db.schedule_state[dateParam];
  const isNew = state.notifications_sent === 0;
  const isUpdated = !isNew && total_events !== state.last_total_events;
  const underCap = state.notifications_sent < MAX_NOTIFICATIONS;

  if ((isNew || isUpdated) && underCap) {
    const message = scheduleService.buildNotificationMessage(dateParam, activities, total_events, !isNew);
    logger.info('poll', `Firing notification #${state.notifications_sent + 1} for ${dateParam}…`);
    await broadcast(bot, message, db.chat_ids);
    state.notifications_sent++;
    state.last_total_events = total_events;
    await storage.writeDb(db);
  } else if (!underCap) {
    if (total_events !== state.last_total_events) {
      state.last_total_events = total_events;
      await storage.writeDb(db);
    }
    logger.info('poll', `Notification cap (${MAX_NOTIFICATIONS}) reached for ${dateParam}, skipping.`);
  } else {
    logger.info('poll', `No change detected for ${dateParam}, skipping.`);
  }
}

// ─── Subscription poll tick ────────────────────────────────────────────────

/**
 * For every active one-shot "Notify Me" subscription: purges it if its event
 * has already started, otherwise checks whether a slot has opened up and, if
 * so, broadcasts to all subscribers of that event_id and clears them.
 */
async function pollSubscriptions(bot) {
  const db = await storage.readDb();
  if (db.notification_subscriptions.length === 0) return;

  const beforeCount = db.notification_subscriptions.length;
  db.notification_subscriptions = db.notification_subscriptions.filter(
    s => !hasEventStarted(s.date, s.start_time)
  );
  const staleRemoved = beforeCount - db.notification_subscriptions.length;
  if (staleRemoved > 0) {
    logger.info('subscriptions', `Purged ${staleRemoved} expired subscription(s).`);
  }
  let changed = staleRemoved > 0;

  if (db.notification_subscriptions.length === 0) {
    if (changed) await storage.writeDb(db);
    return;
  }

  const dates = [...new Set(db.notification_subscriptions.map(s => s.date))];
  const fetched = await Promise.allSettled(
    dates.map(async date => ({ date, data: await scheduleService.fetchSchedule(date, dayOfWeekFor(date)) }))
  );

  for (const result of fetched) {
    if (result.status !== 'fulfilled') {
      logger.error('subscriptions', 'Schedule fetch failed', { error: result.reason?.message });
      continue;
    }

    const { date, data } = result.value;
    const eventsById = new Map();
    for (const activity of data.activities ?? []) {
      for (const event of activity.events ?? []) {
        eventsById.set(event.event_id, event);
      }
    }

    const eventIdsForDate = [
      ...new Set(
        db.notification_subscriptions.filter(s => s.date === date).map(s => s.event_id)
      ),
    ];

    for (const eventId of eventIdsForDate) {
      const event = eventsById.get(eventId);
      if (!event || event.is_full || event.is_unlimited) continue;

      const subs = db.notification_subscriptions.filter(s => s.event_id === eventId);
      const message = scheduleService.buildSlotOpenedMessage(subs[0], event);
      logger.info('subscriptions', `Slot opened for event ${eventId}, notifying ${subs.length} subscriber(s).`);

      await broadcast(bot, message, subs.map(s => s.user_id), {
        reply_markup: Markup.inlineKeyboard([
          Markup.button.url('⚡ Забронировать', BOOKING_URL),
        ]).reply_markup,
      });

      db.notification_subscriptions = db.notification_subscriptions.filter(s => s.event_id !== eventId);
      changed = true;
    }
  }

  if (changed) await storage.writeDb(db);
}

/** Starts the Saturday-schedule + one-shot-notify polling loops. */
export function startSchedulePolling(bot) {
  setTimeout(async () => {
    await pollSchedule(bot);
    await pollSubscriptions(bot);
    setInterval(() => pollSchedule(bot), POLL_INTERVAL_MS);
    setInterval(() => pollSubscriptions(bot), POLL_INTERVAL_MS);
  }, 3_000);
}

// ─── Booking queue watcher ──────────────────────────────────────────────────

/**
 * Drains the auto-booking waitlist: fetches all PENDING queue items and
 * processes them sequentially (FIFO, no strict per-user limits — matches
 * the spec). Each item's failure is fully contained inside
 * booking.service.processQueueItem, so one bad item never stops the rest
 * of the queue or crashes this tick.
 */
async function runBookingWatcherTick(bot) {
  let pending;
  try {
    pending = await storage.getPendingQueueItems();
  } catch (err) {
    logger.error('watcher', 'Failed to read booking queue, skipping this tick', { error: err.message });
    return;
  }

  if (pending.length === 0) return;

  logger.info('watcher', `Processing ${pending.length} pending auto-booking item(s)…`);
  for (const item of pending) {
    try {
      await bookingService.processQueueItem(item, bot);
    } catch (err) {
      // processQueueItem is designed to never throw, but guard anyway so a
      // surprise error can't take down the whole polling service.
      logger.error('watcher', 'Unexpected error processing queue item', { id: item.id, error: err.message });
    }
  }
}

/** Starts the 60s auto-booking watcher. */
export function startBookingWatcher(bot) {
  setTimeout(async () => {
    await runBookingWatcherTick(bot);
    setInterval(() => runBookingWatcherTick(bot), POLL_INTERVAL_MS);
  }, 3_000);
}
