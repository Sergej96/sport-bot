/**
 * Thread-safe(ish) JSON storage layer. All reads/writes to db.json go
 * through here — nothing else in the codebase touches the filesystem for
 * persistence.
 *
 * Safety measures:
 *  - Writes are serialized through an in-process promise chain (`writeChain`)
 *    so two concurrent handlers (or the watcher tick + a handler) never
 *    interleave writes to the same file.
 *  - Each write goes to a temp file and is then renamed into place — a
 *    rename is atomic on POSIX filesystems, so a crash mid-write can never
 *    leave db.json truncated/corrupted.
 *
 * Schema:
 *   chat_ids:       string[]   — subscribed Telegram chat IDs
 *   schedule_state: Record<dateStr, {
 *     notifications_sent: number,
 *     last_total_events:  number,
 *   }>
 *   notification_subscriptions: Array<{
 *     user_id, event_id, date, activity_name, start_time, end_time,
 *     venue_name, created_at,
 *   }>
 *   users: Record<telegram_id, {
 *     telegram_id, email, access_token, refresh_token,
 *     access_token_expires_at: string|null,   — ISO timestamp, if decodable from the JWT
 *     encrypted_password: { iv, tag, data } | null,
 *     venue_id: string|null,    — the user's active venue (see venue.service.js), independent of auth
 *     venue_name: string|null,  — cached label, avoids a venue-directory lookup just to render it
 *     created_at, updated_at,
 *   }>
 *   booking_queue: Array<{
 *     id, userId, eventId,
 *     activityName, dateStr, startTime, endTime, venueName,  — cached for the success notification
 *     addedAt, status: 'PENDING'|'COMPLETED'|'FAILED'|'CANCELLED',
 *     attempts, lastAttemptAt, lastError,
 *     bookingId: string|null,  — the real API booking id, set once COMPLETED (see /my_bookings cancel flow)
 *   }>
 *   auto_subscriptions: Array<{
 *     id, userId, dayOfWeek: 'Saturday'|'Sunday', activityName, startTime: 'HH:mm:ss',
 *     createdAt, isActive: boolean, removedAt?: string,
 *   }>  — weekend auto-booking presets (see watcher.service pollAutoSubscriptionPresets
 *        and bot/handlers/subscription-preset.handler.js)
 *   migrations: {
 *     defaultVenueBackfill: boolean,  — true once backfillDefaultVenue has run; see bot.js
 *   }
 */

import { readFile, writeFile, rename } from 'fs/promises';
import crypto from 'crypto';
import { DB_PATH } from '../config.js';
import * as logger from '../utils/logger.js';

const DEFAULT_DB = {
  chat_ids: [],
  schedule_state: {},
  notification_subscriptions: [],
  users: {},
  booking_queue: [],
  auto_subscriptions: [],
  migrations: { defaultVenueBackfill: false },
};

// Serializes writes so concurrent callers can't interleave.
let writeChain = Promise.resolve();

/** Reads the JSON database from disk. Returns a safe default if missing/malformed. */
export async function readDb() {
  try {
    const raw = await readFile(DB_PATH, 'utf-8');
    const db = JSON.parse(raw);
    // Backward-compatible migration: fill in any keys older db.json files lack.
    for (const [key, defaultValue] of Object.entries(DEFAULT_DB)) {
      if (db[key] === undefined) {
        db[key] = Array.isArray(defaultValue) ? [] : { ...defaultValue };
      }
    }
    return db;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      logger.error('storage', 'Failed to read/parse db.json, falling back to defaults', { error: err.message });
    }
    return structuredClone(DEFAULT_DB);
  }
}

/** Atomically writes the full database object to disk. */
export async function writeDb(data) {
  writeChain = writeChain.then(() => atomicWrite(data)).catch(err => {
    logger.error('storage', 'Write failed', { error: err.message });
    throw err;
  });
  return writeChain;
}

async function atomicWrite(data) {
  const tmpPath = `${DB_PATH}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  await rename(tmpPath, DB_PATH);
}

/**
 * Runs `mutator(db)` with the current db, then persists the (possibly
 * mutated) result. Use this instead of manual readDb()/writeDb() pairs when
 * a handler needs to read-modify-write — it still serializes through the
 * same write chain, so it's safe under concurrent calls.
 */
export async function updateDb(mutator) {
  const db = await readDb();
  const result = await mutator(db);
  await writeDb(db);
  return result;
}

// ─── User (auth session) accessors ────────────────────────────────────────

export async function getUser(telegramId) {
  const db = await readDb();
  return db.users[String(telegramId)] ?? null;
}

/**
 * Merges `fields` onto `existing` (if any), filling every other known field
 * with its current value or a safe default. Shared by upsertUser and
 * backfillDefaultVenue so the user-record shape only needs to be listed in
 * one place.
 */
function buildUserRecord(existing, fields, now) {
  return {
    telegram_id: existing?.telegram_id ?? null,
    email: existing?.email ?? null,
    access_token: existing?.access_token ?? null,
    refresh_token: existing?.refresh_token ?? null,
    access_token_expires_at: existing?.access_token_expires_at ?? null,
    encrypted_password: existing?.encrypted_password ?? null,
    venue_id: existing?.venue_id ?? null,
    venue_name: existing?.venue_name ?? null,
    created_at: existing?.created_at ?? now,
    ...fields,
    updated_at: now,
  };
}

export async function upsertUser(telegramId, fields) {
  return updateDb(db => {
    const id = String(telegramId);
    const now = new Date().toISOString();
    db.users[id] = buildUserRecord(db.users[id], { telegram_id: id, ...fields }, now);
    return db.users[id];
  });
}

export async function deleteUser(telegramId) {
  return updateDb(db => {
    const id = String(telegramId);
    const existed = id in db.users;
    delete db.users[id];
    return existed;
  });
}

// ─── Venue preference accessors ────────────────────────────────────────────

/**
 * The user's active/default venue, if they've picked one via the
 * SELECT_VENUE flow or /venue. Independent of login — picking a venue
 * doesn't require a спортдлявсех.бел account. Returns null if never set.
 */
export async function getUserVenue(telegramId) {
  const user = await getUser(telegramId);
  if (!user?.venue_id) return null;
  return { id: user.venue_id, name: user.venue_name ?? null };
}

/** Persists the user's active venue choice. See bot/handlers/venue.handler.js. */
export async function setUserVenue(telegramId, { id, name }) {
  return upsertUser(telegramId, { venue_id: id, venue_name: name ?? null });
}

/**
 * One-time migration: gives every user known to the bot *before* venue
 * selection existed (anyone already in chat_ids or users) a default active
 * venue, so they're never interrupted by the SELECT_VENUE picker on their
 * next /schedule|/book — only genuinely new subscribers (see
 * subscription.handler's /start) go through that. Guarded by
 * migrations.defaultVenueBackfill so it only ever runs once, no matter how
 * many times the bot restarts — a user who deliberately clears their venue
 * later isn't "re-defaulted" by a later restart.
 *
 * Never overwrites a venue a user already has (e.g. someone who'd already
 * picked one via an earlier build of this feature).
 *
 * @returns {Promise<{ applied: boolean, count: number }>} applied=false means
 *   this had already run before; count is how many user records were touched.
 */
export async function backfillDefaultVenue({ id: venueId, name: venueName }) {
  return updateDb(db => {
    if (db.migrations?.defaultVenueBackfill) return { applied: false, count: 0 };

    const now = new Date().toISOString();
    const knownIds = new Set([...db.chat_ids, ...Object.keys(db.users)]);
    let count = 0;

    for (const id of knownIds) {
      const existing = db.users[id];
      if (existing?.venue_id) continue;
      db.users[id] = buildUserRecord(existing, { telegram_id: id, venue_id: venueId, venue_name: venueName }, now);
      count++;
    }

    db.migrations = { ...db.migrations, defaultVenueBackfill: true };
    return { applied: true, count };
  });
}

// ─── Booking queue accessors ───────────────────────────────────────────────

export async function getQueue() {
  const db = await readDb();
  return db.booking_queue;
}

export async function getPendingQueueItems() {
  const db = await readDb();
  return db.booking_queue.filter(item => item.status === 'PENDING');
}

/** All PENDING waitlist entries belonging to one user — used to render /my_bookings. */
export async function getPendingQueueItemsForUser(userId) {
  const db = await readDb();
  return db.booking_queue.filter(item => item.status === 'PENDING' && item.userId === String(userId));
}

export async function addQueueItem({ userId, eventId, activityName, dateStr, startTime, endTime, venueName }) {
  return updateDb(db => {
    const item = {
      id: crypto.randomUUID(),
      userId: String(userId),
      eventId,
      activityName: activityName ?? null,
      dateStr: dateStr ?? null,
      startTime: startTime ?? null,
      endTime: endTime ?? null,
      venueName: venueName ?? null,
      addedAt: new Date().toISOString(),
      status: 'PENDING',
      attempts: 0,
      lastAttemptAt: null,
      lastError: null,
      bookingId: null,
    };
    db.booking_queue.push(item);
    return item;
  });
}

/** True if this user already has a PENDING queue entry for this event. */
export async function hasPendingQueueItem(userId, eventId) {
  const db = await readDb();
  return db.booking_queue.some(
    item => item.status === 'PENDING' && item.userId === String(userId) && item.eventId === eventId
  );
}

/** Applies a partial update to a single queue item by id and persists it. */
export async function updateQueueItem(id, fields) {
  return updateDb(db => {
    const item = db.booking_queue.find(i => i.id === id);
    if (!item) return null;
    Object.assign(item, fields);
    return item;
  });
}

/**
 * Cancels a user's own PENDING queue item. Setting status away from
 * 'PENDING' is what excludes it from getPendingQueueItems() — the watcher
 * naturally stops considering it starting with its very next tick.
 * Returns null if the item doesn't exist, isn't owned by this user, or is
 * no longer PENDING (already completed/failed/cancelled).
 */
export async function cancelQueueItem(id, userId) {
  return updateDb(db => {
    const item = db.booking_queue.find(i => i.id === id && i.userId === String(userId));
    if (!item || item.status !== 'PENDING') return null;
    item.status = 'CANCELLED';
    item.cancelledAt = new Date().toISOString();
    return item;
  });
}

/**
 * True if this user has ANY queue entry (any status — PENDING, COMPLETED,
 * FAILED, or CANCELLED) for this event. Used by the auto-subscription
 * trigger to stay idempotent across polling ticks: once a match has been
 * handled once (booked, queued, or given up on), later ticks skip it
 * instead of re-attempting the same booking every minute.
 */
export async function hasAnyQueueItemForEvent(userId, eventId) {
  const db = await readDb();
  return db.booking_queue.some(item => item.userId === String(userId) && item.eventId === eventId);
}

/**
 * Adds a queue item that's already resolved — used by the auto-subscription
 * trigger's immediate-success path (booked directly, never actually waited
 * in the queue) so it still shows up for the idempotency check above and,
 * incidentally, in any future queue-history view.
 */
export async function addCompletedQueueItem({ userId, eventId, activityName, dateStr, startTime, endTime, venueName, bookingId }) {
  return updateDb(db => {
    const now = new Date().toISOString();
    const item = {
      id: crypto.randomUUID(),
      userId: String(userId),
      eventId,
      activityName: activityName ?? null,
      dateStr: dateStr ?? null,
      startTime: startTime ?? null,
      endTime: endTime ?? null,
      venueName: venueName ?? null,
      addedAt: now,
      status: 'COMPLETED',
      attempts: 1,
      lastAttemptAt: now,
      lastError: null,
      bookingId: bookingId ?? null,
    };
    db.booking_queue.push(item);
    return item;
  });
}

// ─── Auto-subscription (weekend preset) accessors ─────────────────────────

/** All active auto-booking presets, across all users — the watcher matches these against freshly-polled weekend schedules. */
export async function getActiveAutoSubscriptions() {
  const db = await readDb();
  return db.auto_subscriptions.filter(s => s.isActive);
}

/** One user's active presets — powers the "⚙️ Мои подписки" list. */
export async function getAutoSubscriptionsForUser(userId) {
  const db = await readDb();
  return db.auto_subscriptions.filter(s => s.isActive && s.userId === String(userId));
}

/**
 * The Time Conflict Guard: finds this user's existing active preset (if
 * any) for this exact day+time slot, regardless of activity. The caller
 * decides whether it's a true conflict (different activity) or just a
 * repeat of the same preset.
 */
export async function findConflictingAutoSubscription(userId, dayOfWeek, startTime) {
  const db = await readDb();
  return (
    db.auto_subscriptions.find(
      s => s.isActive && s.userId === String(userId) && s.dayOfWeek === dayOfWeek && s.startTime === startTime
    ) ?? null
  );
}

export async function addAutoSubscription({ userId, dayOfWeek, activityName, startTime }) {
  return updateDb(db => {
    const item = {
      id: crypto.randomUUID(),
      userId: String(userId),
      dayOfWeek,
      activityName,
      startTime,
      createdAt: new Date().toISOString(),
      isActive: true,
    };
    db.auto_subscriptions.push(item);
    return item;
  });
}

/** Deactivates a user's own preset. Returns null if it doesn't exist, isn't theirs, or is already inactive. */
export async function removeAutoSubscription(id, userId) {
  return updateDb(db => {
    const item = db.auto_subscriptions.find(s => s.id === id && s.userId === String(userId));
    if (!item || !item.isActive) return null;
    item.isActive = false;
    item.removedAt = new Date().toISOString();
    return item;
  });
}
