import {
  OVERPASS_MAX_RESPONSE_BYTES,
  OVERPASS_UPSTREAMS,
  OVERPASS_USER_AGENT,
  OVERPASS_TIMEOUT_MS,
} from './constants.js';
import { readResponseTextCapped } from '../common/http.js';
import { simplifyOverpassPayloadBody } from './geometry.js';

/**
 * Detect whether an Overpass API response body indicates rate-limiting.
 *
 * Checks for known rate-limit phrases in the body text regardless of
 * HTTP status code, since some mirrors return 200 with an error payload.
 *
 * @param {string} bodyText - Upstream response body.
 * @returns {boolean} True if the body looks rate-limited.
 */
function overpassLooksRateLimited(bodyText) {
  const text = String(bodyText || '').toLowerCase();
  return (
    text.includes('rate_limited') ||
    text.includes('quota of your ip address') ||
    text.includes('dispatcher_client::request_read_and_idx::rate_limited') ||
    text.includes('too many requests')
  );
}

/**
 * Detect an Overpass HTTP-200 body that is actually a runtime FAILURE (server-side
 * timeout / out-of-memory) via its `remark`. These are transient upstream failures,
 * not authoritative empty results, so they must not be returned or cached.
 */
function overpassLooksRuntimeError(bodyText) {
  const text = String(bodyText || '').toLowerCase();
  return (
    text.includes('runtime error') ||
    text.includes('timed out') ||
    text.includes('out of memory')
  );
}

/**
 * True only for an upstream response that is actually Overpass data.
 *
 * The proxy caches on this and serves stale on its negation, so the two
 * decisions cannot drift apart: a payload that is not data must never be
 * written to the cache and must always be eligible for a stale replacement.
 * @param {{status: number, rateLimited?: boolean, runtimeError?: boolean}} payload
 * @returns {boolean}
 */
function overpassPayloadIsData(payload) {
  const status = Number(payload?.status);
  return (
    Number.isFinite(status) &&
    status >= 200 &&
    status < 300 &&
    !payload.rateLimited &&
    !payload.runtimeError
  );
}

/**
 * Try each mirror once, retaining response-size and per-mirror timeout caps.
 * Refusals and body-level failures rotate; total failure returns the last
 * rate-limit payload, otherwise the first refusal, or throws a network error.
 * @param {string} body URL-encoded Overpass QL query body.
 * @param {number} [maxResponseBytes] Endpoint-specific response cap.
 * @param {object} [options] Server-only endpoint and I/O overrides for tests.
 * @returns {Promise<{status:number,body:string,contentType:string,endpoint:string,rateLimited:boolean}>}
 */
async function fetchOverpassPayload(
  body,
  maxResponseBytes = OVERPASS_MAX_RESPONSE_BYTES,
  {
    endpoints = OVERPASS_UPSTREAMS,
    fetchImpl = fetch,
    readBody = readResponseTextCapped,
    simplify = simplifyOverpassPayloadBody,
  } = {},
) {
  let lastError = null;
  let lastRateLimitPayload = null;
  let lastRefusalPayload = null;

  for (const endpoint of endpoints) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), OVERPASS_TIMEOUT_MS);

    try {
      const upstream = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': OVERPASS_USER_AGENT,
        },
        body,
        signal: controller.signal,
      });

      const responseBody = await readBody(upstream, maxResponseBytes);
      const contentType =
        upstream.headers.get('content-type') || 'application/json';
      const status = upstream.status;
      const rateLimited =
        status === 429 || overpassLooksRateLimited(responseBody);
      const runtimeError = overpassLooksRuntimeError(responseBody);
      const payload = {
        status,
        body: responseBody,
        contentType,
        endpoint,
        rateLimited,
        runtimeError,
      };

      if (rateLimited) {
        lastRateLimitPayload = payload;
        continue;
      }
      // A 200 body carrying a runtime error / timeout is a transient upstream
      // failure — skip to the next mirror rather than returning or caching it.
      if (runtimeError) {
        lastError = new Error(`Overpass runtime error (${endpoint})`);
        continue;
      }
      // Anything but 2xx is this mirror declining, not an answer. Only 5xx used
      // to rotate, so a 4xx ended the fan-out and was returned — and cached —
      // as data: a mirror refusing this client answers 406 while the others
      // answer 200 to the very same request, so every Overpass-backed layer
      // failed on an error page with healthy mirrors untried. The first
      // refusal is kept so a genuinely bad query still reports what upstream
      // said, but only after every mirror has had the chance to answer it.
      if (status < 200 || status >= 300) {
        if (!lastRefusalPayload) lastRefusalPayload = payload;
        lastError = new Error(
          `Overpass upstream returned ${status} (${endpoint})`,
        );
        continue;
      }

      // Success: decimate giant boundary geometry before it reaches the cache,
      // the disk, or the client (what makes the 32 MB read cap safe to hold).
      payload.body = simplify(payload.body);
      return payload;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  if (lastRateLimitPayload) return lastRateLimitPayload;
  if (lastRefusalPayload) return lastRefusalPayload;
  throw lastError || new Error('All Overpass upstreams failed');
}

/**
 * Parse an `s,w,n,e` bounding-box string into numbers, or null when malformed.
 * @param {string|undefined} value Comma-separated south,west,north,east degrees.
 * @returns {{s:number,w:number,n:number,e:number}|null}
 */
function parseOverpassLocalBbox(value) {
  const parts = String(value || '')
    .split(',')
    .map((part) => Number(part.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [s, w, n, e] = parts;
  if (s >= n || w >= e) return null;
  return { s, w, n, e };
}

/**
 * Every coordinate a query is spatially bounded by: bbox corners, `around`
 * centres and `is_in` points, as [lat, lon] pairs.
 * @param {string} query Decoded Overpass QL.
 * @returns {Array<[number, number]>}
 */
function overpassQueryPoints(query) {
  const points = [];
  const num = '(-?\\d+(?:\\.\\d+)?)';
  const sep = '\\s*,\\s*';
  for (const m of query.matchAll(
    new RegExp(`\\(\\s*${num}${sep}${num}${sep}${num}${sep}${num}\\s*\\)`, 'g'),
  )) {
    points.push([Number(m[1]), Number(m[2])], [Number(m[3]), Number(m[4])]);
  }
  for (const m of query.matchAll(
    new RegExp(`around:\\s*[\\d.]+${sep}${num}${sep}${num}`, 'g'),
  )) {
    points.push([Number(m[1]), Number(m[2])]);
  }
  for (const m of query.matchAll(
    new RegExp(`is_in\\s*\\(\\s*${num}${sep}${num}\\s*\\)`, 'g'),
  )) {
    points.push([Number(m[1]), Number(m[2])]);
  }
  return points;
}

/**
 * Upstream order for one query. A self-hosted regional instance
 * (`OVERPASS_LOCAL_URL`, covering `OVERPASS_LOCAL_BBOX` = `s,w,n,e`) is tried
 * first only when every coordinate the query is bounded by lies inside that
 * region: a regional extract answers an out-of-region query with an empty
 * success, which would never fall through to the public mirrors. Queries with
 * no parseable coordinate keep the public order. The public mirrors always
 * remain as fallbacks.
 * @param {string} body URL-encoded `data=` Overpass request body.
 * @param {object} [env] Environment to read (defaults to process.env).
 * @returns {string[]} Ordered endpoint list.
 */
function resolveOverpassEndpoints(body, env = process.env) {
  const localUrl = String(env.OVERPASS_LOCAL_URL || '').trim();
  const bbox = parseOverpassLocalBbox(env.OVERPASS_LOCAL_BBOX);
  if (!localUrl || !bbox) return OVERPASS_UPSTREAMS;
  let query = '';
  try {
    query = new URLSearchParams(body).get('data') || '';
  } catch {
    return OVERPASS_UPSTREAMS;
  }
  const points = overpassQueryPoints(query);
  const inside =
    points.length > 0 &&
    points.every(
      ([lat, lon]) =>
        lat >= bbox.s && lat <= bbox.n && lon >= bbox.w && lon <= bbox.e,
    );
  return inside ? [localUrl, ...OVERPASS_UPSTREAMS] : OVERPASS_UPSTREAMS;
}

export {
  overpassPayloadIsData,
  fetchOverpassPayload,
  resolveOverpassEndpoints,
};
