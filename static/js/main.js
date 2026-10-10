// Map page entry point: loads the data, then wires the map, panel, search and URL together.
import * as api from './api.js';
import { createMap } from './map.js';
import { createPanel } from './panel.js';
import { createSearch } from './search.js';
import { h } from './util.js';

const status = document.getElementById('map-status');

function makeStore(data) {
  const canteens = new Map(data.canteens.map((c) => [c.id, c]));
  const stalls = new Map(data.stalls.map((s) => [s.id, s]));
  const categories = new Map(data.categories.map((c) => [c.id, c]));
  const byCanteen = new Map();
  for (const s of stalls.values()) {
    if (!s.canteen_id) continue;
    if (!byCanteen.has(s.canteen_id)) byCanteen.set(s.canteen_id, []);
    byCanteen.get(s.canteen_id).push(s);
  }
  const listeners = new Set();
  return {
    canteens,
    stalls,
    categories,
    stallsOf: (id) => byCanteen.get(id) || [],
    onScores: (fn) => listeners.add(fn),
    /** After a rating is saved: update the stall and recompute its canteen's average. */
    applySummary(stallId, summary) {
      const s = stalls.get(stallId);
      s.avg = summary.avg;
      s.count = summary.count;
      if (s.canteen_id) {
        const c = canteens.get(s.canteen_id);
        let total = 0;
        let n = 0;
        for (const x of byCanteen.get(c.id)) if (x.count) { total += x.avg * x.count; n += x.count; }
        c.avg = n ? Math.round((total / n) * 100) / 100 : null;
        c.count = n;
      }
      listeners.forEach((fn) => fn());
    },
  };
}

// URL fragment <-> open view, so a stall can be shared as a link: /#/stall/s044
function viewToHash(view) {
  if (!view || view.type === 'cluster') return '';
  return view.id ? `#/${view.type}/${view.id}` : `#/${view.type}`;
}
function route(panel) {
  const [, type, id] = location.hash.split('/');
  if (type === 'canteen') panel.openCanteen(id);
  else if (type === 'stall') panel.openStall(id);
  else if (type === 'top' || type === 'picks') panel.openList(type);
}

async function boot() {
  let data;
  try {
    data = await api.getPlaces();
  } catch (err) {
    status.replaceChildren(h('span', {}, err.message), h('br'),
      h('button', { class: 'btn', type: 'button', onclick: () => location.reload() }, '重新加载 Reload'));
    return;
  }
  const store = makeStore(data);
  let panel;
  const map = await createMap({
    stage: document.getElementById('map-stage'),
    markersEl: document.getElementById('map-markers'),
    canteens: data.canteens,
    stalls: data.stalls,
    onPick: (type, id, ids) => {
      if (type === 'canteen') panel.openCanteen(id);
      else if (type === 'cluster') panel.openCluster(id, ids);
      else panel.openStall(id);
    },
  });
  status.hidden = true;

  const chips = document.querySelectorAll('[data-open-list]');
  panel = createPanel({
    root: document.getElementById('panel'),
    map,
    store,
    onChange: (view) => {
      history.replaceState(null, '', viewToHash(view) || location.pathname + location.search);
      chips.forEach((c) => c.setAttribute('aria-pressed', String(view?.type === c.dataset.openList)));
    },
  });
  store.onScores(() => map.updateScores(new Map([...store.canteens, ...store.stalls])));

  createSearch({
    input: document.getElementById('search-input'),
    list: document.getElementById('search-results'),
    store,
    onSelect: (type, id) => (type === 'canteen' ? panel.openCanteen(id) : panel.openStall(id)),
  });

  chips.forEach((chip) => chip.addEventListener('click', () => {
    if (panel.current()?.type === chip.dataset.openList) panel.close();
    else panel.openList(chip.dataset.openList);
  }));

  document.querySelectorAll('[data-zoom]').forEach((btn) => btn.addEventListener('click', () => {
    const z = btn.dataset.zoom;
    if (z === 'reset') map.fitAll();
    else map.zoomBy(z === 'in' ? 1.6 : 1 / 1.6);
  }));

  window.addEventListener('hashchange', () => route(panel));
  route(panel);
}

boot().catch((err) => {
  console.error(err);
  status.hidden = false;
  status.textContent = '地图加载失败，请刷新页面 · The map failed to load. Please refresh.';
});
