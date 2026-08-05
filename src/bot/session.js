/**
 * Minimal in-memory per-chat step tracker for the /login dialogue. Deliberately
 * not persisted — a restart mid-login just means the user types /login again,
 * and it avoids ever writing an in-progress plaintext password to disk.
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
