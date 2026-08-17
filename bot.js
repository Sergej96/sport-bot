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
import { POLL_INTERVAL_MS, DEFAULT_VENUE_ID, DEFAULT_VENUE_NAME } from './src/config.js';
import * as storage from './src/services/storage.service.js';
import * as venueService from './src/services/venue.service.js';
import * as logger from './src/utils/logger.js';

/**
 * One-time migration (see storage.backfillDefaultVenue): gives every user
 * who was already known to the bot before venue selection existed a default
 * active venue, so they're never interrupted by the picker. Only genuinely
 * new subscribers go through SELECT_VENUE (see subscription.handler's
 * /start). Prefers the live name from the venue directory API, falling back
 * to the config constant if that's unreachable at startup — either way the
 * migration itself must never block/crash startup.
 */
async function backfillDefaultVenue() {
  let venueName = DEFAULT_VENUE_NAME;
  try {
    const venue = await venueService.getVenueById(DEFAULT_VENUE_ID);
    if (venue?.name) venueName = venue.name;
  } catch (err) {
    logger.warn('bot', 'Could not resolve default venue name from API, using fallback', { error: err.message });
  }

  try {
    const { applied, count } = await storage.backfillDefaultVenue({ id: DEFAULT_VENUE_ID, name: venueName });
    if (applied) logger.info('bot', `Default venue backfill: set for ${count} existing user(s).`);
  } catch (err) {
    logger.error('bot', 'Default venue backfill failed', { error: err.message });
  }
}

const bot = createBot();

await backfillDefaultVenue();

bot.launch();
logger.info('bot', `Bot started. Polling every ${POLL_INTERVAL_MS / 1000} seconds.`);

startSchedulePolling(bot);
startBookingWatcher(bot);

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
