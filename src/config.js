/**
 * Central config module — all environment variables and constants live
 * here so nothing else in the codebase reads `process.env` directly.
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import 'dotenv/config';

// This file lives at <project>/src/config.js, so the repo root is one level up.
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, '..');

export const BOT_TOKEN = process.env.BOT_TOKEN;
export const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
// Used to encrypt the fallback password stored for auto-relogin. Optional —
// only required once a user actually runs /login. See utils/crypto.js.
export const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

if (!BOT_TOKEN) throw new Error('BOT_TOKEN environment variable is required');
if (!ADMIN_CHAT_ID) throw new Error('ADMIN_CHAT_ID environment variable is required');

export const DB_PATH = join(ROOT_DIR, 'db.json');

export const API_BASE_URL = 'https://xn--b1adewnfifgg2b6h.xn--90ais/api/v1';
export const SCHEDULE_API_URL = `${API_BASE_URL}/schedule`;
export const LOGIN_API_URL = `${API_BASE_URL}/auth/login`;
export const REFRESH_API_URL = `${API_BASE_URL}/auth/refresh`;
export const BOOKINGS_API_URL = `${API_BASE_URL}/bookings`;
export const VENUES_API_URL = `${API_BASE_URL}/venues`;

// Historically the only venue the bot ever booked against — now just the
// fallback used by the non-interactive broadcast/poll paths in
// watcher.service.js (which aren't tied to one user) and by venue.service.js
// if a caller ever needs *some* venue before the directory has loaded.
// Interactive flows (/schedule, /book, /venue) use the user's own selection
// instead — see storage.service getUserVenue/setUserVenue.
export const DEFAULT_VENUE_ID = '55d51f65-d18c-4a49-bf3d-d5ed17b72c3a';
// Display fallback for the above, used by the one-time existing-user
// backfill (see storage.backfillDefaultVenue) if the venue directory API
// can't be reached at startup to resolve the live name.
export const DEFAULT_VENUE_NAME = '1. Парк 50-летия В.Октября';

// How long the fetched venues list is cached in memory before venue.service
// refetches it (see venue.service.js getVenues). 10–15 min balances "don't
// hammer /api/v1/venues on every /schedule tap" against "a newly added venue
// shows up reasonably soon". Overridable for ops/testing.
export const VENUE_CACHE_TTL_MS = Number(process.env.VENUE_CACHE_TTL_MS) || 12 * 60 * 1000;

// No general booking API existed when this bot was first built, so
// "Book"/"Quick Book" buttons for logged-out users still just deep-link to
// the venue's site (спортдлявсех.бел) instead of reserving a slot directly.
export const BOOKING_URL = 'https://xn--b1adewnfifgg2b6h.xn--90ais';

export const POLL_INTERVAL_MS = 60_000;       // 1 minute
export const MAX_NOTIFICATIONS = 2;           // per Saturday date
export const MAX_CONSECUTIVE_FAILURES = 5;
export const API_TIMEOUT_MS = 10_000;

export const MONTHS_RU = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];
export const WEEKDAYS_EN = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

// Weekend auto-subscription presets (see storage.service auto_subscriptions
// + bot/handlers/subscription-preset.handler.js). Exact strings the API uses
// for activity names — matching is a strict equality check, so this list
// must stay in sync with what the schedule API actually returns.
export const ACTIVITIES = [
  'Dance mix',
  'Power Body',
  'ProJumping',
  'Беговая тренировка',
  'Волейбол',
  'Воркаут',
  'Здоровая спина',
  'Зумба',
  'Йога',
  'Кроссфит',
  'Пилатес',
  'Сайклинг',
  'Скандинавская ходьба',
  'Соло-латина',
  'Стретчинг',
  'Стритбол',
];

export const TIME_SLOTS = ['10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00'];

export const WEEKEND_DAYS_RU = { Saturday: 'Суббота', Sunday: 'Воскресенье' };
