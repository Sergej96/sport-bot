/** Assembles the Telegraf bot instance and wires up all handler modules. */

import { Telegraf } from 'telegraf';
import { BOT_TOKEN } from '../config.js';
import { registerAuthHandlers } from './handlers/auth.handler.js';
import { registerSubscriptionHandlers } from './handlers/subscription.handler.js';
import { registerScheduleHandlers } from './handlers/schedule.handler.js';
import { registerBookingHandlers } from './handlers/booking.handler.js';
import { registerMyBookingsHandlers } from './handlers/mybookings.handler.js';
import { registerSubscriptionPresetHandlers } from './handlers/subscription-preset.handler.js';
import * as logger from '../utils/logger.js';

export function createBot() {
  const bot = new Telegraf(BOT_TOKEN);

  // Registered first: its bot.on('text') middleware needs first look at
  // every text message so it can capture the /login email/password steps
  // and next() through to everything else otherwise.
  registerAuthHandlers(bot);
  registerSubscriptionHandlers(bot);
  registerScheduleHandlers(bot);
  registerBookingHandlers(bot);
  registerMyBookingsHandlers(bot);
  registerSubscriptionPresetHandlers(bot);

  // Populates Telegram's "/" command menu button.
  bot.telegram.setMyCommands([
    { command: 'start', description: 'Подписаться на уведомления' },
    { command: 'stop', description: 'Отписаться от уведомлений' },
    { command: 'schedule', description: 'Расписание тренировок' },
    { command: 'my_subscriptions', description: '⚙️ Мои подписки на авто-бронирование' },
    { command: 'my_bookings', description: 'Мои записи' },
    { command: 'login', description: 'Войти в спортдлявсех.бел' },
    { command: 'logout', description: 'Выйти из аккаунта' },
  ]).catch(err => logger.error('bot', 'Failed to set command menu', { error: err.message }));

  // Backstop: catches anything a handler's own try/catch missed so one bad
  // update can't crash the whole bot process.
  bot.catch((err, ctx) => {
    logger.error('bot', 'Unhandled error in Telegraf context', {
      updateType: ctx?.updateType,
      chatId: ctx?.chat?.id,
      error: err.message,
    });
  });

  return bot;
}
