/**
 * Authentication against спортдлявсех.бел: login, token refresh, and the
 * 401-aware "give me a valid access token for this user" helper the
 * booking service and watcher both depend on.
 */

import { apiClient, authHeader } from './api.service.js';
import { LOGIN_API_URL, REFRESH_API_URL } from '../config.js';
import * as storage from './storage.service.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import * as logger from '../utils/logger.js';

/** Thrown when no automatic path to a valid token exists — the user must run /login again. */
export class ReauthRequiredError extends Error {
  constructor(message = 'Re-authentication required') {
    super(message);
    this.name = 'ReauthRequiredError';
  }
}

/** Decodes a JWT's payload (no signature verification — we trust our own API) to read `exp`. */
function decodeJwtExpiry(token) {
  try {
    const payload = token.split('.')[1];
    const json = Buffer.from(payload, 'base64url').toString('utf-8');
    const { exp } = JSON.parse(json);
    return exp ? new Date(exp * 1000).toISOString() : null;
  } catch {
    return null; // Not a decodable JWT — treat expiry as unknown, rely on 401s instead.
  }
}

/**
 * Logs in with email/password. Returns { access_token, refresh_token, user }.
 * Never logs the password — only the email, on failure, for diagnostics.
 */
export async function login(email, password) {
  try {
    const response = await apiClient.post(LOGIN_API_URL, { email, password });
    const { access_token, refresh_token, ...rest } = response.data;
    if (!access_token) {
      throw new Error('Login response did not include an access_token.');
    }
    return { access_token, refresh_token: refresh_token ?? null, user: rest.user ?? rest };
  } catch (err) {
    logger.warn('auth', 'Login failed', { email, status: err.normalized?.status ?? err.response?.status });
    throw err;
  }
}

/** Exchanges a refresh_token for a new access_token (and possibly a new refresh_token). */
export async function refreshAccessToken(refreshToken) {
  const response = await apiClient.post(REFRESH_API_URL, { refresh_token: refreshToken });
  const { access_token, refresh_token } = response.data;
  if (!access_token) {
    throw new Error('Refresh response did not include an access_token.');
  }
  return { access_token, refresh_token: refresh_token ?? refreshToken };
}

/** Persists a fresh set of tokens (and, on first login, the encrypted password) for a user. */
export async function persistSession(telegramId, { email, access_token, refresh_token, password }) {
  const fields = {
    email,
    access_token,
    refresh_token,
    access_token_expires_at: decodeJwtExpiry(access_token),
  };
  if (password !== undefined) {
    fields.encrypted_password = password ? encrypt(password) : null;
  }
  return storage.upsertUser(telegramId, fields);
}

/**
 * Returns a valid access_token for this user, refreshing or transparently
 * re-logging-in as needed. Throws ReauthRequiredError if no automatic path
 * works — callers should catch this and prompt the user to /login again.
 */
export async function getValidAccessToken(telegramId) {
  const user = await storage.getUser(telegramId);
  if (!user || !user.access_token) {
    throw new ReauthRequiredError('No stored session for this user.');
  }

  const expiresAt = user.access_token_expires_at ? new Date(user.access_token_expires_at).getTime() : null;
  const stillValid = expiresAt === null || expiresAt - Date.now() > 30_000; // 30s safety buffer
  if (stillValid) {
    return user.access_token;
  }

  return renewSession(telegramId, user);
}

/**
 * Attempts refresh_token → then stored-password re-login, in that order.
 * Exported separately so callers that already know a token just 401'd
 * (rather than looking merely expired) can force renewal without re-checking
 * the cached expiry.
 */
export async function renewSession(telegramId, userOverride = null) {
  const user = userOverride ?? (await storage.getUser(telegramId));
  if (!user) throw new ReauthRequiredError('No stored session for this user.');

  if (user.refresh_token) {
    try {
      const { access_token, refresh_token } = await refreshAccessToken(user.refresh_token);
      await persistSession(telegramId, { email: user.email, access_token, refresh_token });
      logger.info('auth', 'Refreshed access token', { telegramId });
      return access_token;
    } catch (err) {
      logger.warn('auth', 'Token refresh failed, will try stored-password re-login', {
        telegramId,
        status: err.normalized?.status ?? err.response?.status,
      });
    }
  }

  if (user.encrypted_password && user.email) {
    try {
      const password = decrypt(user.encrypted_password);
      const { access_token, refresh_token } = await login(user.email, password);
      await persistSession(telegramId, { email: user.email, access_token, refresh_token });
      logger.info('auth', 'Re-logged in using stored credentials', { telegramId });
      return access_token;
    } catch (err) {
      logger.warn('auth', 'Stored-password re-login failed', {
        telegramId,
        status: err.normalized?.status ?? err.response?.status,
      });
    }
  }

  throw new ReauthRequiredError('Refresh and stored-password re-login both failed.');
}

export function withAuth(accessToken, config = {}) {
  return { ...config, headers: { ...config.headers, ...authHeader(accessToken) } };
}
