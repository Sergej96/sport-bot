/** Assembles the Telegraf bot instance and wires up all handler modules. */

import { Telegraf } from 'telegraf';
import { BOT_TOKEN } from '../config.js';
import { registerAuthHandlers } from './handlers/auth.handler.js';
import { registerSubscriptionHandlers } from './handlers/subscription.handler.js';
import { registerScheduleHandlers } from './handlers/schedule.handler.js';
import { registerBookingHandlers } from './handlers/booking.handler.js';
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
