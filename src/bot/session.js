/**
 * Minimal in-memory per-chat step tracker for short multi-step dialogues.
 * Deliberately not persisted — a restart mid-flow just means the user starts
 * that command again (e.g. /login), and for /login specifically it also
 * avoids ever writing an in-progress plaintext password to disk.
 *
 * Steps in use:
 *   - 'awaiting_email' / 'awaiting_password' — the /login dialogue (see auth.handler.js)
 *   - 'SELECT_VENUE' — waiting for a venue picker tap; `resume` says what to
 *     continue into afterwards ('schedule', 'welcome', or null). See venue.handler.js.
 */

const sessions = new Map();

export function getSession(chatId) {
  return sessions.get(String(chatId)) ?? null;
}

export function setSession(chatId, session) {
  sessions.set(String(chatId), session);
}

export function clearSession(chatId) {
  sessions.delete(String(chatId));
}
