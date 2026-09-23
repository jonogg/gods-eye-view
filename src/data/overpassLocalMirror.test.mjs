// Self-hosted regional Overpass instance (OVERPASS_LOCAL_URL + OVERPASS_LOCAL_BBOX):
// tried first only for queries wholly inside its region, since a regional extract
// answers an out-of-region query with an empty success that never falls through.
// Pure-function tests, no network.
//
// Run with: npm test   (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveOverpassEndpoints } from '../../vite.config.js';

const LOCAL = 'http://overpass/api/interpreter';
const AU = { OVERPASS_LOCAL_URL: LOCAL, OVERPASS_LOCAL_BBOX: '-44,112,-9,154' };
const body = (q) => `data=${encodeURIComponent(q)}`;

test('unset or malformed configuration keeps the public mirror order', () => {
  const q = body('[out:json];way["highway"](-33.9,151.1,-33.8,151.3);out geom;');
  const publicOrder = resolveOverpassEndpoints(q, {});
  assert.ok(publicOrder.length > 0);
  assert.ok(!publicOrder.includes(LOCAL));
  assert.deepEqual(
    resolveOverpassEndpoints(q, { OVERPASS_LOCAL_URL: LOCAL, OVERPASS_LOCAL_BBOX: 'nope' }),
    publicOrder,
  );
  assert.deepEqual(
    resolveOverpassEndpoints(q, { OVERPASS_LOCAL_URL: LOCAL, OVERPASS_LOCAL_BBOX: '10,0,5,1' }),
    publicOrder,
  );
});

test('a bbox query inside the region goes local-first with public fallbacks', () => {
  const q = body('[out:json];way["highway"](-33.9,151.1,-33.8,151.3);out geom;');
  const order = resolveOverpassEndpoints(q, AU);
  assert.equal(order[0], LOCAL);
  assert.deepEqual(order.slice(1), resolveOverpassEndpoints(q, {}));
});

test('around and is_in points count as the query region', () => {
  assert.equal(resolveOverpassEndpoints(body('node(around:500,-33.87,151.21);out;'), AU)[0], LOCAL);
  assert.equal(resolveOverpassEndpoints(body('is_in(-33.87,151.21)->.a;area.a[admin_level];out;'), AU)[0], LOCAL);
});

test('queries outside or straddling the region, or without coordinates, stay public', () => {
  const london = body('way["highway"](51.49,-0.15,51.52,-0.10);out geom;');
  const straddle = body('way["highway"](-12,150,-5,156);out geom;');
  const pivot = body('area(3600080500)->.x;rel(pivot.x);out geom;');
  for (const q of [london, straddle, pivot]) {
    assert.notEqual(resolveOverpassEndpoints(q, AU)[0], LOCAL);
  }
});
