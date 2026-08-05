/**
 * sport-bot — Telegram notifier for free Saturday workouts at Парк 50-летия
 * В.Октября (Minsk), plus optional login-based booking / auto-booking.
 *
 * This file is intentionally thin: it wires up the bot, starts the two
 * background watchers, launches, and handles shutdown. All real logic lives
 * under src/.
 */

import { createBot } from './src/bot/index.js';
import { startSchedulePolling, startBookingWatcher } from './src/services/watcher.service.js';
import { POLL_INTERVAL_MS } from './src/config.js';
import * as logger from './src/utils/logger.js';

const bot = createBot();

bot.launch();
logger.info('bot', `Bot started. Polling every ${POLL_INTERVAL_MS / 1000} seconds.`);

startSchedulePolling(bot);
startBookingWatcher(bot);

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
