/**
 * /my_bookings — lists a logged-in user's confirmed bookings (fetched live
 * from спортдлявсех.бел) alongside their PENDING auto-booking waitlist
 * entries (local only, not yet confirmed by the API), each with a cancel
 * button.
 *
 * Two distinct cancel flows, since they're canceling two different things:
 *   - cb:<booking_id>  → DELETE /bookings/{booking_id} via the API
 *   - cq:<queue_item_id> → removes our own local waitlist entry only (no
 *     API call — there's no real booking yet, just our watcher's to-do item)
 */

import { Markup } from 'telegraf';
import * as bookingService from '../../services/booking.service.js';
import * as storage from '../../services/storage.service.js';
import * as auth from '../../services/auth.service.js';
import { formatDateEuro } from '../../utils/dates.js';
import * as logger from '../../utils/logger.js';

// Ephemeral cache so cancellation can confirm "✅ Запись на {activity_name}
// отменена" without an extra API round trip. Keyed by chatId, then
// booking_id → label. Lost on restart — worst case a cancel confirmation
// falls back to a generic label, never a hard failure.
const bookingLabelCache = new Map();

function cacheLabel(chatId, bookingId, label) {
  if (!bookingId) return;
  if (!bookingLabelCache.has(chatId)) bookingLabelCache.set(chatId, new Map());
  bookingLabelCache.get(chatId).set(bookingId, label);
}

function getCachedLabel(chatId, bookingId) {
  return bookingLabelCache.get(chatId)?.get(bookingId) ?? null;
}

function formatWhen(dateStr, startTime, endTime) {
  const time = startTime && endTime ? `${startTime.slice(0, 5)}–${endTime.slice(0, 5)}` : '';
  return [formatDateEuro(dateStr) ?? '—', time].filter(Boolean).join(' · ');
}

/** Fetches + renders the combined list. Populates the label cache as a side effect. */
async function renderMyBookings(ctx) {
  const chatId = String(ctx.chat.id);
  const user = await storage.getUser(chatId);

  if (!user?.access_token) {
    await ctx.reply('Ты не вошёл(ла) в аккаунт спортдлявсех.бел. Отправь /login, чтобы войти.');
    return;
  }

  let realBookings = [];
  try {
    realBookings = await bookingService.getUserBookings(chatId);
  } catch (err) {
    if (err instanceof auth.ReauthRequiredError) {
      await ctx.reply('Сессия истекла. Отправь /login, чтобы войти снова.');
      return;
    }
    logger.error('bot', 'Failed to fetch bookings', { chatId, error: err.message });
    await ctx.reply('Не удалось загрузить твои записи. Попробуй позже.');
    return;
  }

  const queueItems = await storage.getPendingQueueItemsForUser(chatId);

  if (realBookings.length === 0 && queueItems.length === 0) {
    await ctx.reply('У тебя пока нет активных записей и заявок на авто-бронирование.');
    return;
  }

  const lines = ['📋 <b>Мои записи</b>', ''];
  const keyboardRows = [];

  for (const booking of realBookings) {
    const desc = bookingService.describeBooking(booking);
    if (!desc.id) continue; // Can't build a cancel button without an id — skip rather than show a dead button.

    const label = desc.activityName ?? 'Тренировка';
    cacheLabel(chatId, desc.id, label);

    lines.push(`🏋️ <b>${label}</b>`);
    if (desc.venueName) lines.push(`📍 ${desc.venueName}`);
    lines.push(`🗓 ${formatWhen(desc.dateStr, desc.startTime, desc.endTime)}`, '');

    keyboardRows.push([Markup.button.callback(`❌ Отменить: ${label}`, `cb:${desc.id}`)]);
  }

  for (const item of queueItems) {
    const label = item.activityName ?? 'Тренировка';

    lines.push(`⏳ <b>${label}</b> (в очереди на авто-бронирование)`);
    if (item.venueName) lines.push(`📍 ${item.venueName}`);
    lines.push(`🗓 ${formatWhen(item.dateStr, item.startTime, item.endTime)}`, '');

    keyboardRows.push([Markup.button.callback(`❌ Убрать из очереди: ${label}`, `cq:${item.id}`)]);
  }

  await ctx.replyWithHTML(lines.join('\n'), Markup.inlineKeyboard(keyboardRows));
}

export function registerMyBookingsHandlers(bot) {
  bot.command('my_bookings', async ctx => {
    try {
      await renderMyBookings(ctx);
    } catch (err) {
      logger.error('bot', '/my_bookings error', { error: err.message });
      await ctx.reply('Произошла ошибка. Попробуй снова позже.');
    }
  });

  // Cancel a confirmed booking via the API.
  bot.action(/^cb:([0-9a-fA-F-]{36})$/, async ctx => {
    const bookingId = ctx.match[1];
    const chatId = String(ctx.chat.id);
    const label = getCachedLabel(chatId, bookingId) ?? 'занятие';

    try {
      await bookingService.cancelBooking(chatId, bookingId);
      logger.info('bot', `Cancelled booking ${bookingId} for ${chatId}`);
      await ctx.answerCbQuery('Отменено ✅');
      await ctx.editMessageText(`✅ Запись на ${label} успешно отменена!`);
    } catch (err) {
      if (err instanceof auth.ReauthRequiredError) {
        await ctx.answerCbQuery('Сессия истекла. Отправь /login.', { show_alert: true });
        return;
      }
      logger.error('bot', 'Cancel booking error', { bookingId, error: err.message });
      await ctx.answerCbQuery('Не удалось отменить запись. Попробуй позже.', { show_alert: true });
    }
  });

  // Remove a local (not-yet-confirmed) auto-booking waitlist entry.
  bot.action(/^cq:([0-9a-fA-F-]{36})$/, async ctx => {
    const queueItemId = ctx.match[1];
    const chatId = String(ctx.chat.id);

    try {
      const item = await storage.cancelQueueItem(queueItemId, chatId);
      if (!item) {
        await ctx.answerCbQuery('Эта заявка уже неактуальна.', { show_alert: true });
        return;
      }

      logger.info('bot', `Removed queue item ${queueItemId} for ${chatId}`);
      await ctx.answerCbQuery('Убрано из очереди ✅');
      await ctx.editMessageText(`✅ Запись на ${item.activityName ?? 'занятие'} успешно отменена!`);
    } catch (err) {
      logger.error('bot', 'Cancel queue item error', { queueItemId, error: err.message });
      await ctx.answerCbQuery('Не удалось убрать из очереди. Попробуй позже.', { show_alert: true });
    }
  });
}
