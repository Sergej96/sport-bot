/** /start, /stop, and the "❌ Отписаться" inline button — moved from bot.js. */

import { Markup } from 'telegraf';
import * as storage from '../../services/storage.service.js';
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

      if (!db.chat_ids.includes(chatId)) {
        db.chat_ids.push(chatId);
        await storage.writeDb(db);
        logger.info('bot', `New subscriber: ${chatId}`);
      }

      await ctx.replyWithHTML(
        `👋 <b>Привет!</b>\n\n` +
        `Я слежу за расписанием бесплатных тренировок в <b>Парке 50-летия В.Октября</b> (Минск).\n\n` +
        `Как только на ближайшую субботу появится расписание — ты получишь уведомление.\n` +
        `Если расписание изменится, я пришлю обновление ещё раз.\n\n` +
        `Отправь /schedule, чтобы посмотреть расписание на любой день и подписаться на уведомления о свободных местах.\n` +
        `Отправь /login, чтобы войти в аккаунт спортдлявсех.бел и бронировать/вставать в лист ожидания прямо здесь.\n\n` +
        `Ты подписан(а)! ✅`,
        Markup.inlineKeyboard([
          Markup.button.callback('❌ Отписаться', 'unsubscribe'),
        ])
      );
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
