/**
 * /start, /stop, and the "❌ Отписаться" inline button — moved from bot.js.
 *
 * /start also runs the SELECT_VENUE gate right away (Step 1 of the booking
 * flow) instead of waiting for the first /schedule|/book — see
 * venue.handler.ensureActiveVenue. Called on every /start, not just for
 * brand-new subscribers: ensureActiveVenue is a no-op for anyone who already
 * has an active venue (picked one before, or covered by
 * storage.backfillDefaultVenue at startup), so this only ever actually shows
 * the picker to someone who genuinely doesn't have one yet.
 */

import { Markup } from 'telegraf';
import * as storage from '../../services/storage.service.js';
import { ensureActiveVenue } from './venue.handler.js';
import * as logger from '../../utils/logger.js';

async function handleUnsubscribe(ctx) {
  const chatId = String(ctx.chat.id);
  const db = await storage.readDb();
  const index = db.chat_ids.indexOf(chatId);

  if (index !== -1) {
    db.chat_ids.splice(index, 1);
    await storage.writeDb(db);
    logger.info('bot', `Unsubscribed: ${chatId}`);
    await ctx.reply(
      'Ты отписан(а) — уведомления больше не будут приходить.\n' +
      'Чтобы подписаться снова, отправь /start.'
    );
  } else {
    await ctx.reply(
      'Ты не подписан(а).\nОтправь /start, чтобы подписаться.'
    );
  }
}

export function registerSubscriptionHandlers(bot) {
  bot.start(async ctx => {
    const chatId = String(ctx.chat.id);

    try {
      const db = await storage.readDb();
      const isNewSubscriber = !db.chat_ids.includes(chatId);

      if (isNewSubscriber) {
        db.chat_ids.push(chatId);
        await storage.writeDb(db);
        logger.info('bot', `New subscriber: ${chatId}`);
      }

      await ctx.replyWithHTML(
        `👋 <b>Привет!</b> Слежу за бесплатными тренировками в <b>Минске</b> ` +
        `и пришлю уведомление, как только появится расписание на субботу (и ещё раз, если оно изменится).\n\n` +
        `📅 /schedule — расписание и запись на тренировку\n` +
        `🔑 /login — войти в спортдлявсех.бел и бронировать прямо тут\n` +
        `📋 /my_bookings — твои записи и лист ожидания\n` +
        `⚙️ /my_subscriptions — авто-бронирование по выходным\n` +
        `📍 /venue — сменить площадку\n\n` +
        `Ты подписан(а)! ✅`,
        Markup.inlineKeyboard([
          Markup.button.callback('❌ Отписаться', 'unsubscribe'),
        ])
      );

      // Step 1 of the booking flow, shown immediately after subscribing.
      // No-ops (returns without sending anything) if this chat already has
      // an active venue.
      await ensureActiveVenue(ctx, { resume: 'welcome' });
    } catch (err) {
      logger.error('bot', '/start error', { error: err.message });
      await ctx.reply('Произошла ошибка. Попробуй снова позже.');
    }
  });

  bot.command('stop', async ctx => {
    try {
      await handleUnsubscribe(ctx);
    } catch (err) {
      logger.error('bot', '/stop error', { error: err.message });
      await ctx.reply('Произошла ошибка. Попробуй снова позже.');
    }
  });

  bot.action('unsubscribe', async ctx => {
    try {
      await ctx.answerCbQuery();
      await handleUnsubscribe(ctx);
    } catch (err) {
      logger.error('bot', 'unsubscribe action error', { error: err.message });
    }
  });
}
