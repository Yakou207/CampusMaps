// Search box: matches canteens and stalls by Chinese name, English name, food category
// or canteen name. Arrow keys move through results, Enter opens, Esc clears.
import { h, icon } from './util.js';

const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, '');
const MAX_RESULTS = 8;

export function createSearch({ input, list, store, onSelect }) {
  const entries = [
    ...[...store.canteens.values()].map((c) => ({
      type: 'canteen', id: c.id, place: c, names: norm(c.name_zh + c.name_en),
      extra: '', sub: `食堂 Canteen · ${store.stallsOf(c.id).length} 个摊位`,
    })),
    ...[...store.stalls.values()].map((s) => {
      const cat = store.categories.get(s.category);
      const canteen = s.canteen_id ? store.canteens.get(s.canteen_id) : null;
      return {
        type: 'stall', id: s.id, place: s, names: norm(s.name_zh + s.name_en),
        extra: norm(cat.zh + cat.en + (canteen ? canteen.name_zh + canteen.name_en : '')),
        sub: canteen ? canteen.name_zh : '独立门店 Standalone',
      };
    }),
  ];
  let results = [];
  let active = -1;

  function find(q) {
    const query = norm(q);
    if (!query) return [];
    return entries
      .map((e) => ({ e, score: e.names.startsWith(query) ? 0 : e.names.includes(query) ? 1 : e.extra.includes(query) ? 2 : -1 }))
      .filter((r) => r.score >= 0)
      .sort((a, b) => a.score - b.score || (a.e.type === 'canteen' ? -1 : 0) - (b.e.type === 'canteen' ? -1 : 0)
        || (b.e.place.avg ?? -1) - (a.e.place.avg ?? -1))
      .slice(0, MAX_RESULTS)
      .map((r) => r.e);
  }

  function open(isOpen) {
    list.hidden = !isOpen;
    input.setAttribute('aria-expanded', String(isOpen));
    if (!isOpen) input.removeAttribute('aria-activedescendant');
  }

  function render() {
    const q = input.value.trim();
    results = find(q);
    active = results.length ? 0 : -1;
    if (!q) { open(false); return; }
    if (!results.length) {
      list.replaceChildren(h('li', { class: 'search-empty', role: 'presentation' },
        `没找到“${q}” · Nothing matches. `,
        h('a', { href: `/about?kind=new_stall&stall=${encodeURIComponent(q)}#suggest` }, '补充这个摊位 Suggest it')));
      open(true);
      return;
    }
    list.replaceChildren(...results.map((e, i) => h('li', {
      class: 'search-option', role: 'option', id: `search-opt-${i}`, 'aria-selected': String(i === active),
      onmousedown: (ev) => ev.preventDefault(), // keep focus in the input
      onclick: () => choose(i),
    },
    icon(e.type === 'canteen' ? 'meals' : e.place.category),
    h('span', { class: 'search-option-name' }, e.place.name_zh, e.place.name_en ? h('span', { class: 'en' }, ` ${e.place.name_en}`) : null),
    h('span', { class: 'search-option-sub' }, e.sub))));
    highlight();
    open(true);
  }

  function highlight() {
    list.querySelectorAll('.search-option').forEach((li, i) => li.setAttribute('aria-selected', String(i === active)));
    if (active >= 0) {
      input.setAttribute('aria-activedescendant', `search-opt-${active}`);
      list.querySelector(`#search-opt-${active}`)?.scrollIntoView({ block: 'nearest' });
    }
  }

  function choose(i) {
    const e = results[i];
    if (!e) return;
    open(false);
    input.blur();
    onSelect(e.type, e.id);
  }

  input.addEventListener('input', render);
  input.addEventListener('focus', () => { if (input.value.trim()) render(); });
  input.addEventListener('blur', () => setTimeout(() => open(false), 120));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!results.length) return;
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
      highlight();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(active);
    } else if (e.key === 'Escape') {
      input.value = '';
      open(false);
    }
  });
}
