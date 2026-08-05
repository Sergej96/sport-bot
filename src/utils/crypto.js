/**
 * AES-256-GCM helpers for encrypting the fallback password we keep so the
 * watcher can silently re-login when a refresh_token has also expired.
 *
 * ENCRYPTION_KEY must be a 64-char hex string (32 bytes) — generate one with:
 *   openssl rand -hex 32
 *
 * Only required once a user actually runs /login; the rest of the bot works
 * fine without it configured.
 */

import crypto from 'crypto';
import { ENCRYPTION_KEY } from '../config.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // recommended IV size for GCM

function getKey() {
  if (!ENCRYPTION_KEY) {
    throw new Error(
      'ENCRYPTION_KEY environment variable is required to store/read a login password. ' +
      'Generate one with `openssl rand -hex 32` and add it to your .env file.'
    );
  }
  const key = Buffer.from(ENCRYPTION_KEY, 'hex');
  if (key.length !== 32) {
    throw new Error('ENCRYPTION_KEY must be a 64-character hex string (32 bytes).');
  }
  return key;
}

/** Encrypts a plaintext string. Returns a JSON-serializable { iv, tag, data } object. */
export function encrypt(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    data: encrypted.toString('hex'),
  };
}

/** Decrypts a { iv, tag, data } object produced by encrypt() back to plaintext. */
export function decrypt(payload) {
  const key = getKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(payload.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.data, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString('utf-8');
}
