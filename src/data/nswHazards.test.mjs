// Live Traffic NSW hazards proxy: pure normalization + polyline decoding.
// No network.
//
// Run with: npm test   (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeNswPolyline,
  normalizeNswHazard,
  normalizeNswHazardFeed,
} from '../../vite.config.js';

/** Reference Google polyline encoder (precision 5), for round-trip fixtures. */
function encode(points) {
  let out = '';
  let pLat = 0;
  let pLon = 0;
  const enc = (v) => {
    let n = v < 0 ? ~(v << 1) : v << 1;
    let s = '';
    while (n >= 0x20) {
      s += String.fromCharCode((0x20 | (n & 0x1f)) + 63);
      n >>= 5;
    }
    return s + String.fromCharCode(n + 63);
  };
  for (const [lon, lat] of points) {
    const la = Math.round(lat * 1e5);
    const lo = Math.round(lon * 1e5);
    out += enc(la - pLat) + enc(lo - pLon);
    pLat = la;
    pLon = lo;
  }
  return out;
}

const SYDNEY_LINE = [
  [151.2093, -33.8688],
  [151.2101, -33.8702],
  [151.2154, -33.8731],
];

function feature(overrides = {}, props = {}) {
  return {
    type: 'Feature',
    id: 4242,
    geometry: { type: 'Point', coordinates: [151.2093, -33.8688] },
    properties: {
      mainCategory: 'CRASH',
      displayName: 'CRASH',
      headline: '',
      incidentKind: 'Unplanned',
      ended: false,
      isMajor: true,
      adviceA: 'Exercise caution',
      adviceB: 'null',
      adviceC: ' ',
      otherAdvice: '<p><strong>Two lanes</strong> closed&nbsp;&amp; delays</p>',
      expectedDelay: 15,
      created: 1790000000000,
      lastUpdated: 1790000600000,
      periods: [],
      roads: [
        {
          mainStreet: 'George Street',
          locationQualifier: 'between',
          crossStreet: 'Market Street',
          secondLocation: 'King Street',
          suburb: 'Sydney',
          region: 'Sydney',
          impactedLanes: [],
        },
      ],
      encodedPolylines: [{ coords: encode(SYDNEY_LINE) }],
      ...props,
    },
    ...overrides,
  };
}

test('decodes an encoded polyline to [lon, lat] pairs within 1e-5', () => {
  const decoded = decodeNswPolyline(encode(SYDNEY_LINE));
  assert.equal(decoded.length, SYDNEY_LINE.length);
  decoded.forEach(([lon, lat], i) => {
    assert.ok(Math.abs(lon - SYDNEY_LINE[i][0]) < 1e-5);
    assert.ok(Math.abs(lat - SYDNEY_LINE[i][1]) < 1e-5);
  });
});

test('malformed or out-of-NSW polylines decode to nothing', () => {
  assert.deepEqual(decodeNswPolyline(''), []);
  assert.deepEqual(decodeNswPolyline(null), []);
  assert.deepEqual(decodeNswPolyline('\u0001\u0002'), []);
  // The canonical Google example is in California.
  assert.deepEqual(decodeNswPolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@'), []);
});

test('normalizes a feature into a display record', () => {
  const row = normalizeNswHazard(feature(), 'incident');
  assert.equal(row.id, 'incident:4242');
  assert.equal(row.category, 'CRASH');
  assert.equal(row.title, 'CRASH');
  assert.equal(
    row.location,
    'George Street between Market Street and King Street, Sydney',
  );
  assert.equal(row.region, 'Sydney');
  assert.deepEqual(row.advice, ['Exercise caution']);
  assert.equal(row.detail, 'Two lanes closed & delays');
  assert.equal(row.delayMin, 15);
  assert.equal(row.major, true);
  assert.equal(row.planned, false);
  assert.equal(row.closure, false);
  assert.equal(row.lines.length, 1);
  assert.equal(row.lines[0].length, 3);
});

test('closures are detected from periods or closed lanes', () => {
  // closureType is ROAD_CLOSURE on every period, so it alone means nothing.
  const affected = normalizeNswHazard(
    feature({}, { periods: [{ closureType: 'ROAD_CLOSURE', roadextent: 'Affected' }] }),
    'roadwork',
  );
  assert.equal(affected.closure, false);
  const byPeriod = normalizeNswHazard(
    feature(
      {},
      {
        periods: [
          {
            closureType: 'ROAD_CLOSURE',
            roadextent: 'Closed',
            direction: 'Both directions',
            fromDay: 'Mon',
            toDay: 'Fri',
            startTime: '8pm',
            finishTime: '5am',
          },
        ],
      },
    ),
    'roadwork',
  );
  assert.equal(byPeriod.closure, true);
  assert.deepEqual(byPeriod.schedule, ['Mon to Fri 8pm to 5am: Closed (Both directions)']);
  const byLane = normalizeNswHazard(
    feature(
      {},
      {
        roads: [
          { mainStreet: 'Border Downs Road', impactedLanes: [{ extent: 'Closed' }] },
        ],
      },
    ),
    'flood',
  );
  assert.equal(byLane.closure, true);
});

test('ended, unlocated, non-point or out-of-NSW features are dropped', () => {
  assert.equal(normalizeNswHazard(feature({}, { ended: true }), 'incident'), null);
  assert.equal(
    normalizeNswHazard(feature({ geometry: { type: 'Point', coordinates: [0, 0] } }), 'incident'),
    null,
  );
  assert.equal(
    normalizeNswHazard(feature({ geometry: { type: 'LineString', coordinates: [] } }), 'incident'),
    null,
  );
  assert.equal(normalizeNswHazard(feature({ id: undefined }), 'incident'), null);
});

test('a malformed feed never replaces good data', () => {
  assert.equal(normalizeNswHazardFeed({ features: [] }, 'incident'), null);
  assert.equal(normalizeNswHazardFeed(null, 'incident'), null);
  const rows = normalizeNswHazardFeed(
    { type: 'FeatureCollection', features: [feature(), feature({}, { ended: true })] },
    'incident',
  );
  assert.equal(rows.length, 1);
});

test('map labels, colours and cards read the record', async () => {
  const { hazardLabel, hazardColour, hazardCard } = await import(
    '../layers/nswHazards/model.js'
  );
  const crash = normalizeNswHazard(feature(), 'incident');
  assert.equal(hazardLabel(crash), 'CRASH · George Street');
  assert.equal(hazardColour(crash), '#ff3b3b');
  const card = hazardCard(crash, 1790000600000 + 5 * 60_000);
  assert.equal(card.title, 'CRASH');
  assert.ok(card.lines.includes('Expected delay: 15 min'));
  assert.ok(card.lines.some((l) => l.includes('updated 5 min ago')));
  const works = { ...crash, feed: 'roadwork', closure: true };
  assert.equal(hazardLabel(works), 'CLOSED · ROADWORK · George Street');
  assert.ok(hazardCard(works).lines.includes('Road closed at scheduled times'));
});
