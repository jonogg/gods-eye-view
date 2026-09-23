/**
 * Pure presentation rules for Live Traffic NSW hazards: colours, labels and
 * the detail-card text. No Cesium, no DOM, so it is unit-testable under node.
 * @module layers/nswHazards/model
 */

/** Entity-id prefix every hazard entity carries (pick ownership). */
export const NSW_HAZARD_ID_PREFIX = 'nswhaz:';

/** CSS colours per feed; incidents split by severity of the category. */
const FEED_COLOURS = Object.freeze({
  incident: '#ff8a3d',
  roadwork: '#ffd23f',
  flood: '#3fa7ff',
  fire: '#ff3b3b',
  alpine: '#e8f1ff',
  majorevent: '#b57bff',
});
const CRASH_COLOUR = '#ff3b3b';
const CLOSURE_COLOUR = '#ff2d55';

/** Short tag shown on the map label for each feed. */
const FEED_TAGS = Object.freeze({
  incident: 'INCIDENT',
  roadwork: 'ROADWORK',
  flood: 'FLOOD',
  fire: 'FIRE',
  alpine: 'ALPINE',
  majorevent: 'EVENT',
});

/**
 * Display colour (CSS hex) for a hazard record.
 * @param {{feed:string, category?:string, closure?:boolean}} row
 * @returns {string}
 */
export function hazardColour(row) {
  if (row?.closure) return CLOSURE_COLOUR;
  if (row?.feed === 'incident' && /CRASH|COLLISION/i.test(row.category || ''))
    return CRASH_COLOUR;
  return FEED_COLOURS[row?.feed] || '#ffffff';
}

/**
 * One-line map label, e.g. "CRASH · George Street".
 * @param {{feed:string, category?:string, title?:string, location?:string, closure?:boolean}} row
 * @returns {string}
 */
export function hazardLabel(row) {
  const tag =
    row?.feed === 'incident' && row.category
      ? row.category
      : FEED_TAGS[row?.feed] || 'HAZARD';
  const road = String(row?.location || '').split(/ (?:at|between|near) |,/)[0];
  const prefix = row?.closure ? `CLOSED · ${tag}` : tag;
  return road ? `${prefix} · ${road}` : prefix;
}

/** Point size in pixels: major and closure events read larger. */
export function hazardPixelSize(row) {
  if (row?.closure || row?.major) return 13;
  return row?.feed === 'roadwork' ? 8 : 10;
}

function ago(ms, now) {
  if (!Number.isFinite(ms)) return '';
  const min = Math.max(0, Math.round((now - ms) / 60_000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/**
 * Detail-card content as plain strings (the renderer sets textContent only).
 * @param {object} row Normalized hazard record from /api/nsw-hazards.
 * @param {number} [now]
 * @returns {{title:string, subtitle:string, lines:string[], link:string}}
 */
export function hazardCard(row, now = Date.now()) {
  const lines = [];
  if (row?.closure)
    lines.push(
      row.feed === 'roadwork'
        ? 'Road closed at scheduled times'
        : 'Road closed',
    );
  if (Number.isFinite(row?.delayMin))
    lines.push(`Expected delay: ${row.delayMin} min`);
  for (const advice of row?.advice || []) lines.push(advice);
  for (const period of row?.schedule || []) lines.push(`• ${period}`);
  if (row?.detail) lines.push(row.detail);
  const stamps = [];
  if (row?.planned) stamps.push('Planned');
  if (row?.created) stamps.push(`Reported ${ago(row.created, now)}`);
  if (row?.updated) stamps.push(`updated ${ago(row.updated, now)}`);
  if (stamps.length) lines.push(stamps.join(' · '));
  return {
    title: row?.title || row?.category || 'Hazard',
    subtitle: [row?.location, row?.region].filter(Boolean).join(' · '),
    lines,
    link: 'https://www.livetraffic.com/',
  };
}
