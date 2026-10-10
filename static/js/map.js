// The sketch map: loads static/map/campus.svg, pans/zooms it with d3-zoom, keeps HTML
// markers on top of it, folds markers that would overlap into one, and flies to places.
/* global d3 */
import { h, icon, prefersReducedMotion } from './util.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const K_MAX = 6;
const K_FOCUS = 2.6;          // zoom level used when opening a place
const LABEL_K = 1.5;          // building names appear from this zoom
const STALL_LABEL_K = 2.4;    // standalone stall names appear from this zoom
const STALL_MERGE_PX = 26;

const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));

export async function createMap({ stage, markersEl, canteens, stalls, onPick }) {
  const res = await fetch('/static/map/campus.svg');
  if (!res.ok) throw new Error('map svg failed to load');
  const src = new DOMParser().parseFromString(await res.text(), 'image/svg+xml').documentElement;
  const W = src.viewBox.baseVal.width;
  const H = src.viewBox.baseVal.height;
  const west = +src.getAttribute('data-west');
  const north = +src.getAttribute('data-north');
  const k0 = +src.getAttribute('data-k');
  const toXY = (lat, lon) => ({ x: ((lon - west) * Math.PI / 180) * k0, y: (mercY(north) - mercY(lat)) * k0 });

  // Rebuild the SVG so its user units are screen pixels and all drawing sits in one <g> we transform.
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'map-svg campus-map');
  svg.setAttribute('aria-hidden', 'true');
  const viewport = document.createElementNS(SVG_NS, 'g');
  for (const node of [...src.childNodes]) {
    if (node.nodeType !== 1) continue;
    (node.localName === 'defs' ? svg : viewport).append(document.importNode(node, true));
  }
  svg.append(viewport);
  stage.append(svg);

  const building = (id) => (id ? viewport.querySelector(`#${CSS.escape(id)}`) : null);

  // ---------- entities: canteens + stalls that don't belong to a canteen ----------
  const stallCount = new Map();
  for (const s of stalls) if (s.canteen_id) stallCount.set(s.canteen_id, (stallCount.get(s.canteen_id) || 0) + 1);

  const entities = [
    ...canteens.map((c) => ({ id: c.id, type: 'canteen', place: c, ...toXY(c.lat, c.lon), priority: 1000 + (stallCount.get(c.id) || 0) })),
    ...stalls.filter((s) => !s.canteen_id).map((s) => ({ id: s.id, type: 'stall', place: s, ...toXY(s.lat, s.lon), priority: s.count || 0 })),
  ];
  const byId = new Map(entities.map((e) => [e.id, e]));
  let activeId = null;

  entities.forEach((e, i) => {
    e.el = e.type === 'canteen' ? canteenMarker(e.place, i) : stallMarker(e.place, i);
    e.el.addEventListener('click', () => {
      // a pin standing in for several stalls opens a list of all of them
      if (e.type === 'stall' && e.members?.length) onPick('cluster', e.id, [e, ...e.members].map((m) => m.id));
      else onPick(e.type, e.id);
    });
    const b = e.type === 'canteen' ? building(e.place.building_id) : null;
    if (b) {
      b.classList.add('is-canteen');
      e.el.addEventListener('pointerenter', () => b.classList.add('is-hover'));
      e.el.addEventListener('pointerleave', () => b.classList.remove('is-hover'));
    }
    markersEl.append(e.el);
  });

  function scoreEl(place) {
    const empty = place.avg == null;
    return h('span', { class: `mk-score${empty ? ' is-empty' : ''}` },
      empty ? '暂无评分' : [icon('star', ''), place.avg.toFixed(1)]);
  }

  function canteenMarker(c, i) {
    const n = stallCount.get(c.id) || 0;
    return h('button', {
      class: 'mk mk-canteen', type: 'button', style: `--i:${i}`,
      'aria-label': `${c.name_zh} ${c.name_en}，${n} 个摊位 · ${n} stalls`,
    }, h('span', { class: 'mk-inner' },
      h('span', { class: 'mk-stem' }), h('span', { class: 'mk-dot' }),
      h('span', { class: 'mk-tag' },
        h('span', { class: 'mk-zh' }, c.name_zh),
        h('span', { class: 'mk-en' }, c.name_en),
        scoreEl(c),
        h('span', { class: 'mk-count' }))));
  }

  function stallMarker(s, i) {
    return h('button', {
      class: 'mk mk-stall', type: 'button', style: `--i:${i}`,
      'aria-label': `${s.name_zh} ${s.name_en}`,
    }, h('span', { class: 'mk-inner' },
      h('span', { class: 'mk-pin' }, icon(s.category)),
      h('span', { class: 'mk-label' }, s.name_zh),
      h('span', { class: 'mk-count' })));
  }

  // ---------- zoom ----------
  let transform = d3.zoomIdentity;
  const size = () => ({ w: svg.clientWidth, h: svg.clientHeight });
  const listeners = new Set();
  const zoom = d3.zoom()
    .extent(() => [[0, 0], [size().w, size().h]])
    .scaleExtent([minK(), K_MAX])
    .translateExtent([[0, 0], [W, H]])
    .on('zoom', (ev) => {
      transform = ev.transform;
      viewport.setAttribute('transform', transform.toString());
      update();
    });
  const sel = d3.select(svg).call(zoom);

  function minK() {
    const { w, h: hh } = size();
    return Math.max(w / W, hh / H) * 0.98;
  }

  function update() {
    for (const e of entities) {
      const [sx, sy] = transform.apply([e.x, e.y]);
      e.sx = sx;
      e.sy = sy;
      e.el.style.transform = `translate3d(${sx.toFixed(1)}px, ${sy.toFixed(1)}px, 0)`;
    }
    recluster();
    svg.classList.toggle('show-labels', transform.k >= LABEL_K);
    markersEl.classList.toggle('show-stall-labels', transform.k >= STALL_LABEL_K);
    listeners.forEach((fn) => fn());
  }

  // ---------- folding overlapping markers ----------
  function tagRect(e) {
    if (!e.size) {
      const tag = e.el.querySelector('.mk-tag');
      e.size = { w: tag.offsetWidth, h: tag.offsetHeight };
    }
    const pad = 4;
    // the tag sits 12px above the anchor; include the dot below it too
    return { x0: e.sx - e.size.w / 2 - pad, x1: e.sx + e.size.w / 2 + pad, y0: e.sy - 12 - e.size.h - pad, y1: e.sy + 16 };
  }
  const overlaps = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
  const inside = (r, x, y) => x > r.x0 && x < r.x1 && y > r.y0 && y < r.y1;
  const order = () => [...entities].sort((a, b) => (b.id === activeId) - (a.id === activeId) || b.priority - a.priority);

  function recluster() {
    const canteenLeaders = [];
    const stallLeaders = [];
    for (const e of entities) { e.members = []; e.hidden = false; }
    for (const e of order()) {
      if (e.type === 'canteen') {
        e.rect = tagRect(e);
        const hit = canteenLeaders.find((l) => overlaps(l.rect, e.rect));
        if (hit) { hit.members.push(e); e.hidden = true; } else canteenLeaders.push(e);
      } else {
        if (e.id !== activeId && canteenLeaders.some((l) => inside(l.rect, e.sx, e.sy))) { e.hidden = true; continue; }
        const near = stallLeaders.find((l) => Math.hypot(l.sx - e.sx, l.sy - e.sy) < STALL_MERGE_PX);
        if (near) { near.members.push(e); e.hidden = true; } else stallLeaders.push(e);
      }
    }
    for (const e of entities) {
      e.el.classList.toggle('is-hidden', e.hidden);
      e.el.tabIndex = e.hidden ? -1 : 0;
      e.el.classList.toggle('has-cluster', e.members.length > 0);
      if (e.members.length) e.el.querySelector('.mk-count').textContent = `+${e.members.length}`;
    }
  }

  // ---------- camera ----------
  function go(t, duration = 750) {
    if (prefersReducedMotion()) {
      sel.interrupt().call(zoom.transform, t);
      return Promise.resolve();
    }
    return sel.transition().duration(duration).ease(d3.easeCubicInOut).call(zoom.transform, t).end().catch(() => {});
  }

  function boundsTransform(points, pad) {
    const { w, h: hh } = size();
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const k = Math.min(K_MAX * 0.8,
      (w - pad.left - pad.right) / Math.max(x1 - x0, 1),
      (hh - pad.top - pad.bottom) / Math.max(y1 - y0, 1));
    const cx = pad.left + (w - pad.left - pad.right) / 2;
    const cy = pad.top + (hh - pad.top - pad.bottom) / 2;
    return d3.zoomIdentity.translate(cx - ((x0 + x1) / 2) * k, cy - ((y0 + y1) / 2) * k).scale(k);
  }

  function chromePad() {
    const bar = document.querySelector('.map-bar');
    // leave room for the top bar plus a canteen tag (they hang ~70px above their point)
    return { top: (bar ? bar.offsetHeight : 0) + 100, right: 90, bottom: 50, left: 90 };
  }

  function fitAll(animate = true) {
    const t = boundsTransform(entities, chromePad());
    if (!animate) { sel.call(zoom.transform, t); return Promise.resolve(); }
    return go(t);
  }

  /** Move the camera so the place lands at (fx, fy) of the viewport. */
  function flyTo(id, { fx = 0.5, fy = 0.5, k } = {}) {
    const e = byId.get(id);
    if (!e) return Promise.resolve();
    const { w, h: hh } = size();
    const kk = k ?? Math.max(transform.k, K_FOCUS);
    return go(d3.zoomIdentity.translate(w * fx - e.x * kk, hh * fy - e.y * kk).scale(kk));
  }

  function setActive(id) {
    const prev = byId.get(activeId);
    if (prev) {
      prev.el.classList.remove('is-active');
      building(prev.place.building_id)?.classList.remove('is-active');
    }
    activeId = byId.has(id) ? id : null;
    const next = byId.get(activeId);
    if (next) {
      next.el.classList.add('is-active');
      if (next.type === 'canteen') building(next.place.building_id)?.classList.add('is-active');
    }
    recluster();
  }

  /** Where a panel should point: the middle of the marker's tag (or pin) and its half width. */
  function screenOf(id) {
    const e = byId.get(id);
    if (!e) return null;
    if (e.type === 'canteen') {
      tagRect(e);
      return { x: e.sx, y: e.sy - 12 - e.size.h / 2, halfW: e.size.w / 2 };
    }
    return { x: e.sx, y: e.sy, halfW: 15 };
  }

  function updateScores(placesById) {
    for (const e of entities) {
      const p = placesById.get(e.id);
      if (!p) continue;
      e.place = p;
      if (e.type === 'canteen') {
        e.el.querySelector('.mk-score').replaceWith(scoreEl(p));
        e.size = null;
      }
      if (e.type === 'stall') e.priority = p.count || 0;
    }
    recluster();
  }

  window.addEventListener('resize', () => {
    zoom.scaleExtent([minK(), K_MAX]);
    sel.call(zoom.transform, transform); // re-apply limits for the new size
  });
  document.fonts?.ready.then(() => { entities.forEach((e) => { e.size = null; }); recluster(); });

  fitAll(false);
  svg.classList.add('is-ready');

  return {
    flyTo,
    fitAll,
    setActive,
    screenOf,
    updateScores,
    zoomBy: (f) => (prefersReducedMotion() ? sel.call(zoom.scaleBy, f)
      : sel.transition().duration(300).ease(d3.easeCubicOut).call(zoom.scaleBy, f)),
    onMove: (fn) => listeners.add(fn),
  };
}
