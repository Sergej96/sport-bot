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
 *     created_at, updated_at,
 *   }>
 *   booking_queue: Array<{
 *     id, userId, eventId,
 *     activityName, dateStr, startTime, endTime, venueName,  — cached for the success notification
 *     addedAt, status: 'PENDING'|'COMPLETED'|'FAILED',
 *     attempts, lastAttemptAt, lastError,
 *   }>
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

export async function upsertUser(telegramId, fields) {
  return updateDb(db => {
    const id = String(telegramId);
    const now = new Date().toISOString();
    const existing = db.users[id];
    db.users[id] = {
      telegram_id: id,
      email: existing?.email ?? null,
      access_token: existing?.access_token ?? null,
      refresh_token: existing?.refresh_token ?? null,
      access_token_expires_at: existing?.access_token_expires_at ?? null,
      encrypted_password: existing?.encrypted_password ?? null,
      created_at: existing?.created_at ?? now,
      ...fields,
      updated_at: now,
    };
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

// ─── Booking queue accessors ───────────────────────────────────────────────

export async function getQueue() {
  const db = await readDb();
  return db.booking_queue;
}

export async function getPendingQueueItems() {
  const db = await readDb();
  return db.booking_queue.filter(item => item.status === 'PENDING');
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
