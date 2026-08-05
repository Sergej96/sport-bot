/**
 * Shared axios instance for all спортдлявсех.бел API calls. Centralizes the
 * base URL, timeout, and error normalization so callers deal with a
 * consistent shape instead of raw axios errors.
 */

import axios from 'axios';
import { API_BASE_URL, API_TIMEOUT_MS } from '../config.js';

export const apiClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: API_TIMEOUT_MS,
  headers: { 'Content-Type': 'application/json' },
});

/**
 * Normalizes any axios failure (network error, timeout, 4xx/5xx) into a
 * plain `{ status, message, isNetworkError, isTimeout }` shape attached to
 * the error as `err.normalized`, then rethrows so callers still get a real
 * Error/stack but can branch on `err.normalized` without repeating
 * `err.response?.status` boilerplate everywhere.
 */
apiClient.interceptors.response.use(
  response => response,
  error => {
    const isTimeout = error.code === 'ECONNABORTED';
    const isNetworkError = !error.response && !isTimeout;

    error.normalized = {
      status: error.response?.status ?? null,
      // This API returns errors as { detail: "..." } (confirmed, e.g. 400
      // "Нет доступных мест на мероприятии" for a full event), not
      // { message: "..." } — check both so nothing falls back to axios's
      // generic "Request failed with status code N" when a real reason
      // was actually in the response body.
      message: error.response?.data?.detail ?? error.response?.data?.message ?? error.message,
      isNetworkError,
      isTimeout,
    };

    return Promise.reject(error);
  }
);

/** Builds an Authorization header object for an authenticated request. */
export function authHeader(accessToken) {
  return { Authorization: `Bearer ${accessToken}` };
}
