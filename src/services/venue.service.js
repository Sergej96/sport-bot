/**
 * Venue directory: fetches the list of bookable venues from
 * `GET /api/v1/venues` and caches it in memory (see VENUE_CACHE_TTL_MS) so
 * the venue picker and every schedule/booking call that needs to resolve a
 * venue_id don't hit the API on every single interaction.
 *
 * Kept separate from schedule.service.js — venues are their own resource
 * (fetched once, reused everywhere) rather than something scoped to a single
 * schedule request.
 */

import { apiClient } from './api.service.js';
import { VENUES_API_URL, VENUE_CACHE_TTL_MS } from '../config.js';
import * as logger from '../utils/logger.js';

/**
 * @typedef {Object} Venue
 * @property {string} id           - Unique venue id (UUID), as returned by the API.
 * @property {string} name         - Display name. The API has been observed to key this as
 *                                    either `title` or `name` — normalized here so every
 *                                    caller only ever deals with `name`.
 * @property {string|null} address - Street address / location description, if the API
 *                                    provided one (as `address` or `location`).
 * @property {Object} raw          - The untouched API object, for any metadata a caller
 *                                    needs that isn't lifted onto the normalized shape.
 */

/** Thrown when the venues list can't be fetched or the response is unusable. */
export class VenueFetchError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'VenueFetchError';
    this.cause = cause;
  }
}

/** @type {{ data: Venue[], expiresAt: number } | null} */
let cache = null;

/** @param {Object} raw @returns {Venue} */
function normalizeVenue(raw) {
  return {
    id: raw.id,
    name: raw.title ?? raw.name ?? 'Без названия',
    address: raw.address ?? raw.location ?? null,
    raw,
  };
}

/** @returns {Promise<Venue[]>} */
async function fetchVenuesFromApi() {
  let response;
  try {
    response = await apiClient.get(VENUES_API_URL);
  } catch (err) {
    const { isTimeout, isNetworkError, status, message } = err.normalized ?? {};
    logger.error('venue', 'Failed to fetch venues', { isTimeout, isNetworkError, status, message });
    throw new VenueFetchError(
      isTimeout
        ? 'Venue directory request timed out.'
        : isNetworkError
        ? 'Could not reach the venue directory (network error).'
        : status !== null && status >= 500
        ? 'Venue directory is temporarily unavailable (server error).'
        : `Venue directory request failed: ${message ?? err.message}`,
      err
    );
  }

  const list = Array.isArray(response.data)
    ? response.data
    : response.data?.venues ?? response.data?.items ?? null;

  if (!Array.isArray(list) || list.length === 0) {
    throw new VenueFetchError('Venue directory returned no venues.');
  }

  return list.map(normalizeVenue);
}

/**
 * Returns the cached venues list, refetching if the cache is missing or
 * expired. Pass `{ force: true }` to bypass the cache (e.g. an explicit
 * "refresh" action).
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<Venue[]>}
 */
export async function getVenues({ force = false } = {}) {
  const isFresh = cache && cache.expiresAt > Date.now();
  if (!force && isFresh) return cache.data;

  try {
    const data = await fetchVenuesFromApi();
    cache = { data, expiresAt: Date.now() + VENUE_CACHE_TTL_MS };
    return data;
  } catch (err) {
    // Serve a stale cache rather than fail outright if we have one — a
    // transient API hiccup shouldn't block someone who just wants to rebook.
    if (cache) {
      logger.warn('venue', 'Serving stale venue cache after fetch failure', { error: err.message });
      return cache.data;
    }
    throw err;
  }
}

/**
 * Looks up a single venue by id out of the (cached) directory.
 * @param {string} venueId
 * @returns {Promise<Venue|null>}
 */
export async function getVenueById(venueId) {
  const venues = await getVenues();
  return venues.find(v => v.id === venueId) ?? null;
}

/** Drops the in-memory cache. Ops/testing use only — not part of the normal request path. */
export function clearVenueCache() {
  cache = null;
}
