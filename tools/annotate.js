// Canteen / stall annotation tool (team-internal, not part of the public site).
// Starts from the food places already in OpenStreetMap; the team confirms, fixes and adds places,
// then exports a JSON file. Work is autosaved to localStorage.

const STORE_KEY = 'campusmaps-annotations-v1';
const SVG_NS = 'http://www.w3.org/2000/svg';
const KIND_LABEL = { canteen: '食堂', stall: '摊位' };
const STATUS_LABEL = { pending: '待确认', ok: '已确认', removed: '已删除' };

const state = {
  places: [],
  selectedId: null,
  draft: null,      // a clicked spot that is not a place yet: {lat, lon, building_id, building_name}
  moving: false,
  filter: 'all',
  query: '',
};
let svg, stage, proj, panzoom, markersLayer, W, H;
const $ = (s) => document.querySelector(s);

// ---------- projection (inverse of tools/build_map.py:project) ----------
const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
function toXY(lat, lon) {
  return { x: ((lon - proj.west) * Math.PI / 180) * proj.k, y: (mercY(proj.north) - mercY(lat)) * proj.k };
}
function toLatLon(x, y) {
  const lon = proj.west + (x / proj.k) * 180 / Math.PI;
  const lat = (2 * Math.atan(Math.exp(mercY(proj.north) - y / proj.k)) - Math.PI / 2) * 180 / Math.PI;
  return { lat: +lat.toFixed(7), lon: +lon.toFixed(7) };
}
function distM(a, b) {
  const dy = (a.lat - b.lat) * 111320;
  const dx = (a.lon - b.lon) * 111320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

// ---------- storage ----------
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state.places)); } catch (e) { /* private mode: keep working in memory */ }
}
function load() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)); } catch (e) { return null; }
}
function fromOsm(list) {
  const places = list.map((f) => ({
    id: 'osm-' + f.osm_id,
    source: 'osm',
    status: 'pending',
    kind: ['food_court', 'canteen'].includes(f.amenity) ? 'canteen' : 'stall',
    name_zh: f.name_zh || '',
    name_en: f.name_en || '',
    lat: f.lat,
    lon: f.lon,
    building_id: f.building_id,
    canteen_id: null,
    note: '',
  }));
  for (const p of places) {
    if (p.kind === 'stall' && p.building_id) {
      p.canteen_id = places.find((c) => c.kind === 'canteen' && c.building_id === p.building_id)?.id ?? null;
    }
  }
  return places;
}

// ---------- helpers ----------
const byId = (id) => state.places.find((p) => p.id === id);
const canteens = () => state.places.filter((p) => p.kind === 'canteen' && p.status !== 'removed');
const displayName = (p) => [p.name_zh, p.name_en].filter(Boolean).join(' · ') || '（未命名）';
function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...children.filter((c) => c != null));
  return el;
}
function buildingName(id) {
  if (!id) return null;
  const b = svg.querySelector('#' + CSS.escape(id));
  return b ? b.dataset.name || '（无名建筑）' : null;
}

// ---------- map ----------
function svgPoint(evt) {
  const r = svg.getBoundingClientRect();
  return { x: ((evt.clientX - r.left) / r.width) * W, y: ((evt.clientY - r.top) / r.height) * H };
}

// Center map point (x, y) in the viewport. Stage uses Panzoom's default 50% 50% origin
// and transform `scale(s) translate(tx, ty)`, so: screen = O + s * (p - O + t).
function panFor(x, y, s) {
  const box = $('#map').getBoundingClientRect();
  return { x: (box.width / 2 - W / 2) / s - x + W / 2, y: (box.height / 2 - H / 2) / s - y + H / 2 };
}
function centerOn(x, y, scale, animate = true) {
  const s = scale ?? panzoom.getScale();
  const t = panFor(x, y, s);
  panzoom.zoom(s, { animate });
  panzoom.pan(t.x, t.y, { animate, force: true });
}
function fitScale() {
  const box = $('#map').getBoundingClientRect();
  return Math.min(box.width / W, box.height / H) * 0.98;
}
function fit() {
  centerOn(W / 2, H / 2, fitScale());
}

function scaleMarkers() {
  const inv = 1 / panzoom.getScale();
  for (const g of markersLayer.children) g.setAttribute('transform', `translate(${g.dataset.x},${g.dataset.y}) scale(${inv})`);
}

function renderMap() {
  markersLayer.replaceChildren();
  svg.querySelectorAll('.building.is-canteen, .building.is-target').forEach((b) => b.classList.remove('is-canteen', 'is-target'));

  for (const p of state.places) {
    if (p.status === 'removed' && state.filter !== 'removed') continue;
    if (p.kind === 'canteen' && p.building_id && p.status !== 'removed') {
      svg.querySelector('#' + CSS.escape(p.building_id))?.classList.add('is-canteen');
    }
    const { x, y } = toXY(p.lat, p.lon);
    const g = svgEl('g', { class: `marker ${p.kind} ${p.status}${p.id === state.selectedId ? ' selected' : ''}`, 'data-id': p.id });
    g.dataset.x = x;
    g.dataset.y = y;
    g.append(svgEl('circle', { r: p.kind === 'canteen' ? 9 : 6 }));
    const title = svgEl('title');
    title.textContent = displayName(p);
    g.append(title);
    markersLayer.append(g);
  }
  const sel = byId(state.selectedId);
  if (sel?.building_id) svg.querySelector('#' + CSS.escape(sel.building_id))?.classList.add('is-target');
  if (state.draft) {
    const { x, y } = toXY(state.draft.lat, state.draft.lon);
    const g = svgEl('g', { class: 'marker pending-point' });
    g.dataset.x = x;
    g.dataset.y = y;
    g.append(svgEl('circle', { r: 8 }));
    markersLayer.append(g);
    if (state.draft.building_id) svg.querySelector('#' + CSS.escape(state.draft.building_id))?.classList.add('is-target');
  }
  // selected marker on top
  const selG = markersLayer.querySelector('.selected');
  if (selG) markersLayer.append(selG);
  scaleMarkers();
}

function onMapClick(evt) {
  const pt = svgPoint(evt);
  const ll = toLatLon(pt.x, pt.y);
  const marker = evt.target.closest('.marker');
  const building = evt.target.closest('.building');

  if (state.moving) {
    const p = byId(state.selectedId);
    Object.assign(p, ll);
    if (building) p.building_id = building.id;
    state.moving = false;
    $('#map').classList.remove('moving');
    commit();
    return;
  }
  if (marker?.dataset.id) return select(marker.dataset.id);
  state.selectedId = null;
  state.draft = { ...ll, building_id: building?.id ?? null };
  renderAll();
}

// ---------- actions ----------
function commit() {
  save();
  renderAll();
}
function select(id, fly = false) {
  state.selectedId = id;
  state.draft = null;
  state.moving = false;
  $('#map').classList.remove('moving');
  renderAll();
  if (fly) {
    const p = byId(id);
    const { x, y } = toXY(p.lat, p.lon);
    centerOn(x, y, Math.max(panzoom.getScale(), 2));
  }
}
function createFromDraft(kind) {
  const d = state.draft;
  const p = {
    id: 'm-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    source: 'manual',
    status: 'ok',
    kind,
    name_zh: kind === 'canteen' && d.building_id ? (buildingName(d.building_id) || '').replace('（无名建筑）', '') : '',
    name_en: '',
    lat: d.lat,
    lon: d.lon,
    building_id: d.building_id,
    canteen_id: null,
    note: '',
  };
  if (kind === 'stall') p.canteen_id = nearestCanteen(p)?.id ?? null;
  state.places.push(p);
  state.draft = null;
  state.selectedId = p.id;
  commit();
  $('#f-name-zh')?.focus();
}
function nearestCanteen(p) {
  const list = canteens().map((c) => ({ c, d: distM(c, p) })).sort((a, b) => a.d - b.d);
  const same = list.find(({ c }) => p.building_id && c.building_id === p.building_id);
  if (same) return same.c;
  return list[0] && list[0].d < 60 ? list[0].c : null;
}

// ---------- editor ----------
function renderEditor() {
  const box = $('#editor');
  box.replaceChildren();

  if (state.draft) {
    const bname = buildingName(state.draft.building_id);
    box.append(
      h('div', {}, h('b', {}, bname ? `你点了建筑：${bname}` : '你点了空地')),
      h('div', { class: 'meta' }, `${state.draft.lat}, ${state.draft.lon}`),
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: () => createFromDraft('canteen') }, bname ? '把这栋楼标为食堂' : '在这里标食堂'),
        h('button', { class: 'primary', onclick: () => createFromDraft('stall') }, '在这里加摊位'),
        h('button', { onclick: () => { state.draft = null; renderAll(); } }, '取消')),
    );
    return;
  }

  const p = byId(state.selectedId);
  if (!p) return;
  const update = (field) => (e) => { p[field] = e.target.value; save(); renderList(); };

  const kindToggle = h('div', { class: 'kind-toggle' },
    ...['canteen', 'stall'].map((k) => h('button', {
      class: p.kind === k ? 'on' : '',
      onclick: () => { p.kind = k; if (k === 'canteen') p.canteen_id = null; commit(); },
    }, KIND_LABEL[k])));

  box.append(
    h('div', { class: 'row', style: 'margin-top:0' }, kindToggle,
      h('span', { class: `badge ${p.status}` }, STATUS_LABEL[p.status]),
      h('span', { class: 'badge' }, p.source === 'osm' ? '来自 OSM' : '手动添加')),
    h('label', { for: 'f-name-zh' }, '中文名'),
    h('input', { id: 'f-name-zh', type: 'text', value: p.name_zh, oninput: update('name_zh') }),
    h('label', { for: 'f-name-en' }, '英文名'),
    h('input', { id: 'f-name-en', type: 'text', value: p.name_en, oninput: update('name_en') }),
  );

  if (p.kind === 'stall') {
    const options = canteens()
      .map((c) => ({ c, d: distM(c, p) }))
      .sort((a, b) => a.d - b.d)
      .map(({ c, d }) => h('option', { value: c.id, selected: c.id === p.canteen_id }, `${displayName(c)}（${Math.round(d)} m）`));
    box.append(
      h('label', { for: 'f-canteen' }, '所属食堂（按距离排序）'),
      h('select', { id: 'f-canteen', onchange: (e) => { p.canteen_id = e.target.value || null; commit(); } },
        h('option', { value: '', selected: !p.canteen_id }, '— 独立摊位 / 不属于食堂 —'), ...options),
    );
  } else {
    const nearby = state.places
      .filter((s) => s.kind === 'stall' && s.status !== 'removed' && !s.canteen_id)
      .map((s) => ({ s, d: distM(s, p) }))
      .filter(({ d }) => d < 80)
      .sort((a, b) => a.d - b.d);
    const inside = state.places.filter((s) => s.canteen_id === p.id && s.status !== 'removed').length;
    box.append(
      h('div', { class: 'meta' }, `所在建筑：${buildingName(p.building_id) || '未绑定'} · 已归入 ${inside} 个摊位`),
      h('label', {}, `附近 80 m 内未归属的摊位（${nearby.length}）`),
      h('div', { class: 'nearby' }, ...nearby.map(({ s, d }) => h('div', {},
        h('span', {}, `${displayName(s)} · ${Math.round(d)} m`),
        h('button', { onclick: () => { s.canteen_id = p.id; commit(); } }, '+ 归入')))),
    );
    if (nearby.length > 1) {
      box.append(h('div', { class: 'row' }, h('button', {
        onclick: () => { nearby.forEach(({ s }) => (s.canteen_id = p.id)); commit(); },
      }, '全部归入')));
    }
  }

  box.append(
    h('label', { for: 'f-note' }, '备注（营业时间、价格、拍照情况等，可选）'),
    h('textarea', { id: 'f-note', oninput: update('note') }, p.note || ''),
    h('div', { class: 'row' },
      p.status !== 'ok' && p.status !== 'removed' ? h('button', { class: 'primary', onclick: () => { p.status = 'ok'; commit(); } }, '✓ 确认无误') : null,
      h('button', { onclick: () => { state.moving = true; $('#map').classList.add('moving'); } }, '移动位置'),
      p.status === 'removed'
        ? h('button', { onclick: () => { p.status = 'pending'; commit(); } }, '恢复')
        : h('button', { class: 'danger', onclick: () => { p.status = 'removed'; commit(); } }, '删除（已不存在 / 不是吃饭的地方）')),
    h('div', { class: 'meta' }, `${p.lat}, ${p.lon}`),
  );
}

// ---------- list ----------
function renderTabs() {
  const count = (f) => state.places.filter((p) => (f === 'all' ? p.status !== 'removed' : p.status === f)).length;
  $('#tabs').replaceChildren(...['all', 'pending', 'ok', 'removed'].map((f) => h('button', {
    class: state.filter === f ? 'on' : '',
    onclick: () => { state.filter = f; renderAll(); },
  }, `${f === 'all' ? '全部' : STATUS_LABEL[f]} ${count(f)}`)));
}

function renderList() {
  const q = state.query.trim().toLowerCase();
  const visible = (p) =>
    (state.filter === 'all' ? p.status !== 'removed' : p.status === state.filter) &&
    (!q || `${p.name_zh} ${p.name_en} ${p.note}`.toLowerCase().includes(q));
  const item = (p, child = false) => h('div', {
    class: `item ${p.kind} ${p.status}${child ? ' child' : ''}${p.id === state.selectedId ? ' selected' : ''}`,
    onclick: () => select(p.id, true),
  }, h('span', { class: 'dot' }), h('span', { class: 'name' }, displayName(p)),
  p.kind === 'canteen' ? h('span', { class: 'badge' }, KIND_LABEL.canteen) : null);

  const groups = [];
  for (const c of state.places.filter((p) => p.kind === 'canteen')) {
    const kids = state.places.filter((s) => s.canteen_id === c.id && visible(s));
    if (!visible(c) && !kids.length) continue;
    groups.push(h('div', { class: 'group' }, item(c), ...kids.map((s) => item(s, true))));
  }
  const loose = state.places.filter((s) => s.kind === 'stall' && !byId(s.canteen_id) && visible(s));
  if (loose.length) {
    groups.push(h('div', { class: 'group' }, h('div', { class: 'group-title' }, `未归属食堂的摊位（${loose.length}）`), ...loose.map((s) => item(s))));
  }
  $('#list').replaceChildren(...groups);
  $('#list').querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
}

function renderAll() {
  renderMap();
  renderEditor();
  renderTabs();
  renderList();
}

// ---------- import / export ----------
function exportJson() {
  const data = { version: 1, exported_at: new Date().toISOString(), places: state.places };
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `annotations-${new Date().toISOString().slice(0, 10)}.json` });
  a.click();
  URL.revokeObjectURL(a.href);
}
async function importJson(file) {
  try {
    const data = JSON.parse(await file.text());
    const places = Array.isArray(data) ? data : data.places;
    if (!Array.isArray(places) || !places.every((p) => p.id && typeof p.lat === 'number' && typeof p.lon === 'number')) {
      throw new Error('文件里没有有效的 places 列表');
    }
    state.places = places;
    state.selectedId = null;
    state.draft = null;
    commit();
    alert(`已导入 ${places.length} 个地点`);
  } catch (e) {
    alert('导入失败：' + e.message);
  }
}

// ---------- boot ----------
async function init() {
  const [svgText, osmFood] = await Promise.all([
    fetch('../static/map/campus.svg').then((r) => r.text()),
    fetch('../static/map/osm_food.json').then((r) => r.json()),
  ]);
  stage = $('#stage');
  stage.innerHTML = svgText;
  svg = stage.querySelector('svg');
  W = svg.viewBox.baseVal.width;
  H = svg.viewBox.baseVal.height;
  svg.setAttribute('width', W);
  svg.setAttribute('height', H);
  svg.classList.add('campus-map', 'show-labels');
  proj = { west: +svg.dataset.west, north: +svg.dataset.north, k: +svg.dataset.k };
  markersLayer = svgEl('g', { id: 'markers' });
  svg.append(markersLayer);

  state.places = load() || fromOsm(osmFood);
  save();

  // Panzoom applies startX/startY in a setTimeout after init, so the initial fit must go in as start options.
  const s0 = fitScale();
  const t0 = panFor(W / 2, H / 2, s0);
  panzoom = Panzoom(stage, { canvas: true, maxScale: 8, minScale: 0.1, cursor: 'grab', startScale: s0, startX: t0.x, startY: t0.y });
  const map = $('#map');
  map.addEventListener('wheel', (e) => panzoom.zoomWithWheel(e));
  stage.addEventListener('panzoomzoom', scaleMarkers);

  let down = null;
  map.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
  map.addEventListener('click', (e) => {
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 6) onMapClick(e);
  });

  $('#search').addEventListener('input', (e) => { state.query = e.target.value; renderList(); });
  $('#btn-export').addEventListener('click', exportJson);
  $('#file-import').addEventListener('change', (e) => { if (e.target.files[0]) importJson(e.target.files[0]); e.target.value = ''; });
  $('#btn-fit').addEventListener('click', fit);
  $('#btn-reset').addEventListener('click', () => {
    if (!confirm('清空所有标注，恢复成 OSM 原始数据？建议先导出备份。')) return;
    state.places = fromOsm(osmFood);
    state.selectedId = null;
    state.draft = null;
    commit();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    state.moving = false;
    map.classList.remove('moving');
    state.selectedId = null;
    state.draft = null;
    renderAll();
  });

  renderAll();
}

init();
