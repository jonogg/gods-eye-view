import * as Cesium from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';
import {
  registerPickOwner,
  unregisterPickOwner,
} from '../../data/pickRegistry.js';
import {
  NSW_HAZARD_ID_PREFIX,
  hazardCard,
  hazardColour,
  hazardLabel,
  hazardPixelSize,
} from './model.js';

export * from './model.js';
export { createNswHazardSource } from './source.js';

const LAYER_ID = 'nsw-hazards';
/** Labels only when zoomed in enough to read a street, so the state view stays clean. */
const LABEL_RANGE_M = 9_000;
/** Point markers stay visible out to a whole-of-NSW view. */
const POINT_RANGE_M = 2_500_000;

/** Build the floating detail card (textContent only: feed text is untrusted). */
function createCard() {
  const card = document.createElement('div');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'NSW traffic hazard');
  Object.assign(card.style, {
    position: 'fixed',
    left: '16px',
    bottom: '120px',
    width: 'min(340px, calc(100vw - 32px))',
    maxHeight: '45vh',
    overflowY: 'auto',
    zIndex: '2000',
    padding: '12px 14px',
    background: 'rgba(6, 14, 20, 0.92)',
    border: '1px solid rgba(80, 200, 255, 0.45)',
    borderRadius: '6px',
    color: '#d8f3ff',
    font: '12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace',
    boxShadow: '0 6px 24px rgba(0,0,0,0.5)',
    display: 'none',
  });
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Close');
  Object.assign(close.style, {
    position: 'absolute',
    top: '4px',
    right: '8px',
    background: 'none',
    border: 'none',
    color: '#d8f3ff',
    font: '18px/1 sans-serif',
    cursor: 'pointer',
  });
  const title = document.createElement('div');
  Object.assign(title.style, { fontWeight: '700', paddingRight: '18px' });
  const subtitle = document.createElement('div');
  Object.assign(subtitle.style, { opacity: '0.75', margin: '2px 0 8px' });
  const body = document.createElement('div');
  const link = document.createElement('a');
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = 'Live Traffic NSW ↗';
  Object.assign(link.style, {
    display: 'inline-block',
    marginTop: '8px',
    color: '#6fd3ff',
  });
  const credit = document.createElement('div');
  credit.textContent = '© Transport for NSW, CC BY 4.0';
  Object.assign(credit.style, {
    opacity: '0.5',
    fontSize: '10px',
    marginTop: '6px',
  });
  card.append(close, title, subtitle, body, link, credit);
  close.addEventListener('click', () => {
    card.style.display = 'none';
  });
  return {
    element: card,
    show(row, colour) {
      const content = hazardCard(row);
      title.textContent = content.title;
      title.style.color = colour;
      subtitle.textContent = content.subtitle;
      body.replaceChildren(
        ...content.lines.map((line) => {
          const p = document.createElement('div');
          p.textContent = line;
          p.style.marginTop = '3px';
          return p;
        }),
      );
      link.href = content.link;
      card.style.display = 'block';
    },
    hide() {
      card.style.display = 'none';
    },
  };
}

/**
 * Live Traffic NSW hazards: incidents, closures, roadworks, floods, fires,
 * alpine conditions and major events, with affected road sections drawn on
 * the ground and a click-for-detail card.
 * @param {{source: {getSnapshot: Function}}} options
 */
export function createNswHazardsLayer({ source } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('NSW hazards require a snapshot source');
  let viewer = null;
  let dataSource = null;
  let request = null;
  let enabled = false;
  let clickHandler = null;
  let card = null;
  let rows = new Map();
  let count = 0;
  let lastUpdate = null;
  let lastError = null;

  function installClick() {
    if (clickHandler || !viewer) return;
    clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    clickHandler.setInputAction((click) => {
      if (!enabled || !isPointerFree()) return;
      const picked = viewer.scene.pick(click.position);
      const id = picked?.id?.id;
      if (typeof id === 'string' && id.startsWith(NSW_HAZARD_ID_PREFIX)) {
        const key = id
          .slice(NSW_HAZARD_ID_PREFIX.length)
          .replace(/:line\d+$/, '');
        const row = rows.get(key);
        if (row) card?.show(row, hazardColour(row));
      } else if (!picked) {
        card?.hide();
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function removeClick() {
    if (clickHandler && !clickHandler.isDestroyed()) clickHandler.destroy();
    clickHandler = null;
  }

  function render(hazards) {
    const next = new Map();
    dataSource.entities.suspendEvents();
    dataSource.entities.removeAll();
    for (const row of hazards) {
      if (!Number.isFinite(row?.lat) || !Number.isFinite(row?.lon)) continue;
      next.set(row.id, row);
      const colour = Cesium.Color.fromCssColorString(hazardColour(row));
      dataSource.entities.add({
        id: `${NSW_HAZARD_ID_PREFIX}${row.id}`,
        position: Cesium.Cartesian3.fromDegrees(row.lon, row.lat),
        point: {
          pixelSize: hazardPixelSize(row),
          color: colour,
          outlineColor: Cesium.Color.BLACK.withAlpha(0.85),
          outlineWidth: 2,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
            0,
            POINT_RANGE_M,
          ),
        },
        label: {
          text: hazardLabel(row),
          font: '600 12px ui-monospace, SFMono-Regular, Menlo, monospace',
          fillColor: colour,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -18),
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
            0,
            LABEL_RANGE_M,
          ),
        },
      });
      (row.lines || []).forEach((line, i) => {
        const flat = line.flat();
        if (flat.length < 4) return;
        dataSource.entities.add({
          id: `${NSW_HAZARD_ID_PREFIX}${row.id}:line${i}`,
          polyline: {
            positions: Cesium.Cartesian3.fromDegreesArray(flat),
            width: row.closure ? 7 : 5,
            material: row.closure
              ? new Cesium.PolylineDashMaterialProperty({
                  color: colour,
                  gapColor: Cesium.Color.BLACK.withAlpha(0.6),
                  dashLength: 16,
                })
              : colour.withAlpha(0.85),
            clampToGround: true,
          },
        });
      });
    }
    dataSource.entities.resumeEvents();
    rows = next;
    count = next.size;
  }

  return {
    id: LAYER_ID,
    name: 'NSW Live Traffic',
    icon: '⚠',
    source: 'Live Traffic NSW',
    updateInterval: 90_000,

    init(nextViewer) {
      if (viewer) throw new Error('NSW hazards layer is already initialized');
      viewer = nextViewer;
      dataSource = new Cesium.CustomDataSource(LAYER_ID);
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
      if (typeof document !== 'undefined') {
        card = createCard();
        document.body.append(card.element);
      }
    },

    enable() {
      enabled = true;
      if (dataSource) dataSource.show = true;
      registerPickOwner(
        LAYER_ID,
        (id) => enabled && String(id).startsWith(NSW_HAZARD_ID_PREFIX),
      );
      installClick();
    },

    disable() {
      enabled = false;
      request?.abort();
      request = null;
      if (dataSource) dataSource.show = false;
      unregisterPickOwner(LAYER_ID);
      removeClick();
      card?.hide();
    },

    async update() {
      if (!enabled || !dataSource) return false;
      request?.abort();
      const current = new AbortController();
      request = current;
      try {
        const snapshot = await source.getSnapshot({ signal: current.signal });
        if (current.signal.aborted || request !== current || !enabled)
          return false;
        render(snapshot.hazards);
        lastUpdate = Date.now();
        lastError = snapshot.degraded.length
          ? `Partial: ${snapshot.degraded.join(', ')} unavailable`
          : null;
        return true;
      } catch (error) {
        if (current.signal.aborted || request !== current || !enabled)
          return false;
        lastError = error?.message || 'NSW hazards unavailable';
        return false;
      } finally {
        if (request === current) request = null;
      }
    },

    destroy(nextViewer = viewer) {
      enabled = false;
      request?.abort();
      request = null;
      unregisterPickOwner(LAYER_ID);
      removeClick();
      card?.element.remove();
      card = null;
      if (dataSource && nextViewer) {
        nextViewer.dataSources.remove(dataSource, true);
      }
      dataSource = null;
      viewer = null;
      rows = new Map();
      count = 0;
    },

    getStats() {
      return { count, lastUpdate, error: lastError };
    },
  };
}
