/**
 * Browser source for the Live Traffic NSW hazards snapshot served by the
 * local `/api/nsw-hazards` proxy (the proxy owns upstream fetching, caching
 * and polyline decoding).
 */
export function createNswHazardSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  url = '/api/nsw-hazards',
} = {}) {
  return {
    /** @returns {Promise<{hazards: object[], degraded: string[], fetchedAt: number}>} */
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(url, { signal });
      if (!response.ok) throw new Error(`NSW hazards HTTP ${response.status}`);
      const payload = await response.json();
      signal?.throwIfAborted();
      if (!Array.isArray(payload?.hazards))
        throw new Error('Malformed NSW hazards response');
      return {
        hazards: payload.hazards,
        degraded: Array.isArray(payload.degraded) ? payload.degraded : [],
        fetchedAt: Number(payload.fetchedAt) || Date.now(),
      };
    },
  };
}
