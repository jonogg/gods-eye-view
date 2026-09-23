/**
 * Live Traffic NSW hazards proxy: incidents, roadworks, floods, fires, alpine
 * conditions and major events from Transport for NSW's public Live Traffic
 * feeds, merged into one compact snapshot at `/api/nsw-hazards`.
 *
 * The server does the heavy lifting once per refresh window for every viewer:
 * six upstream fetches, validation, HTML stripping and decoding of the
 * affected-road polylines. Browsers receive only display-ready records.
 * Keyless; data is Transport for NSW, CC BY 4.0.
 */
import { readResponseTextCapped } from './common/http.js';

const FEED_ORIGIN = 'https://data.livetraffic.com/traffic/hazards/';
const FEEDS = Object.freeze([
  'incident',
  'roadwork',
  'flood',
  'fire',
  'alpine',
  'majorevent',
]);
const FRESH_MS = 90_000;
const STALE_MS = 30 * 60_000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_FEED_BYTES = 8 * 1024 * 1024;
const MAX_RECORDS_PER_FEED = 1500;
const MAX_LINE_POINTS = 2000;
const MAX_LINES = 8;
// NSW plus a margin (Jervis Bay, the ACT, border towns on both sides).
const NSW_BOUNDS = Object.freeze({ s: -38.5, w: 140, n: -27.5, e: 154.5 });

/** Collapse whitespace and cap length; non-strings become ''. */
function clean(value, max = 200) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text || text === 'null') return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Strip markup from the feed's HTML advice fields and decode common entities. */
function plainText(value, max = 600) {
  if (typeof value !== 'string') return '';
  const text = value
    .replace(/<\s*br\s*\/?>/gi, ' ')
    .replace(/<\/p>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  return clean(text, max);
}

function epochMs(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function inBounds(lat, lon) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= NSW_BOUNDS.s &&
    lat <= NSW_BOUNDS.n &&
    lon >= NSW_BOUNDS.w &&
    lon <= NSW_BOUNDS.e
  );
}

/**
 * Decode a Google encoded polyline (precision 5) into [lon, lat] pairs.
 * Returns [] for malformed input rather than throwing.
 * @param {string} encoded
 * @returns {Array<[number, number]>}
 */
export function decodeNswPolyline(encoded) {
  if (typeof encoded !== 'string' || !encoded) return [];
  const points = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  const next = () => {
    let result = 0;
    let shift = 0;
    let byte;
    do {
      if (index >= encoded.length) return null;
      byte = encoded.charCodeAt(index++) - 63;
      if (byte < 0 || byte > 63) return null;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && shift < 35);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < encoded.length && points.length < MAX_LINE_POINTS) {
    const dLat = next();
    const dLon = next();
    if (dLat === null || dLon === null) return [];
    lat += dLat;
    lon += dLon;
    const pLat = lat / 1e5;
    const pLon = lon / 1e5;
    if (!inBounds(pLat, pLon)) return [];
    points.push([pLon, pLat]);
  }
  return points;
}

/** Whether any period or lane entry marks the road as fully closed. */
function isClosure(props) {
  const periods = Array.isArray(props.periods) ? props.periods : [];
  if (
    periods.some(
      (p) =>
        p?.closureType === 'ROAD_CLOSURE' ||
        String(p?.roadextent || '').toLowerCase() === 'closed',
    )
  )
    return true;
  const roads = Array.isArray(props.roads) ? props.roads : [];
  return roads.some((r) =>
    (Array.isArray(r?.impactedLanes) ? r.impactedLanes : []).some(
      (l) => String(l?.extent || '').toLowerCase() === 'closed',
    ),
  );
}

/** Human location line, e.g. "Putty Road between Colo Heights and Mellong, Colo Heights". */
function locationText(road) {
  if (!road || typeof road !== 'object') return '';
  const main = clean(road.mainStreet, 80);
  const qualifier = clean(road.locationQualifier, 20);
  const cross = clean(road.crossStreet, 80);
  const second = clean(road.secondLocation, 80);
  const suburb = clean(road.suburb, 80);
  let text = main;
  if (cross) {
    text += ` ${qualifier || 'at'} ${cross}`;
    if (second && qualifier === 'between') text += ` and ${second}`;
  }
  if (suburb) text += text ? `, ${suburb}` : suburb;
  return clean(text, 220);
}

/**
 * Normalize one Live Traffic GeoJSON feature into a display record, or null
 * when it is ended, unlocated or outside NSW.
 * @param {object} feature GeoJSON feature from a hazards feed.
 * @param {string} feed Feed name (incident, roadwork, ...).
 * @returns {object|null}
 */
export function normalizeNswHazard(feature, feed) {
  const props = feature?.properties;
  const coords = feature?.geometry?.coordinates;
  if (!props || typeof props !== 'object' || props.ended === true) return null;
  if (feature?.geometry?.type !== 'Point' || !Array.isArray(coords))
    return null;
  const lon = Number(coords[0]);
  const lat = Number(coords[1]);
  if (!inBounds(lat, lon)) return null;
  const id = feature.id;
  if (!(typeof id === 'number' || typeof id === 'string')) return null;

  const roads = Array.isArray(props.roads) ? props.roads : [];
  const lines = (
    Array.isArray(props.encodedPolylines) ? props.encodedPolylines : []
  )
    .slice(0, MAX_LINES)
    .map((p) => decodeNswPolyline(p?.coords))
    .filter((line) => line.length >= 2);
  const delay = Number(props.expectedDelay);

  return {
    id: `${feed}:${id}`,
    feed,
    category: clean(props.mainCategory, 60) || feed.toUpperCase(),
    title:
      clean(props.headline, 160) ||
      clean(props.displayName, 160) ||
      clean(props.mainCategory, 60),
    location: locationText(roads[0]),
    region: clean(roads[0]?.region, 60),
    lat,
    lon,
    lines,
    closure: isClosure(props),
    major: props.isMajor === true,
    planned: clean(props.incidentKind, 20) === 'Planned',
    advice: [props.adviceA, props.adviceB, props.adviceC]
      .map((a) => clean(a, 80))
      .filter(Boolean),
    detail: plainText(props.otherAdvice),
    delayMin: Number.isFinite(delay) && delay > 0 ? delay : null,
    created: epochMs(props.created),
    updated: epochMs(props.lastUpdated),
    ends: epochMs(props.end),
  };
}

/**
 * Normalize a full feed payload. Returns null when the payload is not a
 * GeoJSON FeatureCollection, so a malformed feed never replaces good data.
 */
export function normalizeNswHazardFeed(payload, feed) {
  if (payload?.type !== 'FeatureCollection' || !Array.isArray(payload.features))
    return null;
  const rows = [];
  for (const feature of payload.features.slice(0, MAX_RECORDS_PER_FEED)) {
    const row = normalizeNswHazard(feature, feed);
    if (row) rows.push(row);
  }
  return rows;
}

async function fetchFeed(feed, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${FEED_ORIGIN}${feed}.json`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await readResponseTextCapped(response, MAX_FEED_BYTES);
    const rows = normalizeNswHazardFeed(JSON.parse(text), feed);
    if (!rows) throw new Error('malformed feed');
    return rows;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the proxy. Feeds refresh at most every 90 s, shared by all viewers;
 * a feed that fails keeps its last good rows for up to 30 min and is reported
 * in `degraded`.
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {() => number} [options.now]
 */
export function nswHazardsProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  /** @type {Map<string, {rows: object[], at: number}>} */
  const lastGood = new Map();
  let snapshot = null;
  let pending = null;

  async function refresh() {
    const degraded = [];
    await Promise.all(
      FEEDS.map(async (feed) => {
        try {
          lastGood.set(feed, {
            rows: await fetchFeed(feed, fetchImpl),
            at: now(),
          });
        } catch (error) {
          degraded.push(feed);
          console.warn(
            `[NSW Hazards] ${feed} feed failed: ${error?.message || error}`,
          );
        }
      }),
    );
    const t = now();
    const hazards = [];
    for (const feed of FEEDS) {
      const entry = lastGood.get(feed);
      if (entry && t - entry.at <= STALE_MS) hazards.push(...entry.rows);
    }
    snapshot = {
      at: t,
      body: JSON.stringify({
        fetchedAt: t,
        source: 'Live Traffic NSW (Transport for NSW)',
        attribution: '© Transport for NSW, CC BY 4.0',
        degraded,
        hazards,
      }),
    };
    return snapshot;
  }

  function current() {
    if (snapshot && now() - snapshot.at < FRESH_MS)
      return Promise.resolve(snapshot);
    if (!pending) pending = refresh().finally(() => (pending = null));
    return pending;
  }

  function install({ middlewares }) {
    middlewares.use('/api/nsw-hazards', async (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'method_not_allowed' }));
        return;
      }
      try {
        const snap = await current();
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(snap.body);
      } catch {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'nsw_hazards_unavailable' }));
      }
    });
  }

  return {
    name: 'nsw-hazards-proxy',
    configureServer: install,
    configurePreviewServer: install,
  };
}
