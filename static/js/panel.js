// The place panel. Shows a canteen's stalls, a stall's details + reviews + rating form,
// and the "Top rated" / "Picks" lists. On desktop it floats beside the marker it belongs
// to; on phones it is a bottom sheet that can be dragged between half and full height.
import * as api from './api.js';
import { h, icon, isDesktop, starLabel, stars, STAR_WORDS, timeAgo } from './util.js';

const COMMENT_MAX = 200;
const AREA = { phase1: ['一期', 'Phase 1'], phase2: ['二期', 'Phase 2'] };
const SORTS = [
  ['default', '默认', 'Default'],
  ['rating', '高分', 'Score'],
  ['count', '人气', 'Popular'],
];

export function createPanel({ root, map, store, onChange }) {
  const card = root.querySelector('.panel-card');
  const body = root.querySelector('.panel-body');
  const grip = root.querySelector('.panel-grip');
  let stack = [];       // view history: [{type, id}]
  let anchorId = null;  // map entity the panel points at (desktop)
  let sort = 'default';
  let ratingRequest = 0;

  root.querySelector('.panel-close').addEventListener('click', () => close());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !root.hidden && !e.target.closest?.('.search')) close();
  });
  map.onMove(place);
  window.addEventListener('resize', place);

  // ---------- open / close ----------
  function show(view, { push = false, back = false } = {}) {
    stack = push ? [...stack, view] : back ? stack : [view];
    const el = render(view);
    el.classList.add(back ? 'enter-back' : stack.length > 1 ? 'enter-fwd' : 'enter');
    body.replaceChildren(el);
    body.scrollTop = 0;

    const wasHidden = root.hidden;
    root.hidden = false;
    if (wasHidden) {
      root.classList.remove('is-open');
      void root.offsetWidth; // restart the open animation
      root.classList.add('is-open');
    }
    const entity = anchorFor(view);
    anchorId = entity;
    map.setActive(entity);
    if (entity && view.fly !== false) {
      map.flyTo(entity, isDesktop() ? { fx: 0.3, fy: 0.55 } : { fx: 0.5, fy: phoneFocusY() });
    }
    if (!isDesktop()) {
      if (wasHidden) {
        // start below the screen so the sheet slides up
        root.classList.add('is-dragging');
        setSheet('closed');
        void root.offsetWidth;
        root.classList.remove('is-dragging');
      }
      setSheet(wasHidden || sheetState === 'closed' ? 'half' : sheetState);
    }
    place();
    onChange?.(view);
    if (wasHidden) root.querySelector('.panel-close').focus({ preventScroll: true });
  }

  let closeTimer = null;
  function close() {
    if (root.hidden) return;
    stack = [];
    anchorId = null;
    map.setActive(null);
    onChange?.(null);
    const hide = () => {
      if (stack.length) return; // reopened meanwhile
      root.hidden = true;
      root.classList.remove('is-open');
    };
    if (isDesktop()) hide();
    else {
      setSheet('closed');
      clearTimeout(closeTimer);
      closeTimer = setTimeout(hide, 320);
    }
  }

  const back = () => {
    stack = stack.slice(0, -1);
    const prev = stack[stack.length - 1];
    if (prev) show({ ...prev, fly: false }, { back: true });
  };

  function anchorFor(view) {
    if (view.type === 'canteen') return view.id;
    if (view.type === 'cluster') return view.id;
    if (view.type === 'stall') {
      const s = store.stalls.get(view.id);
      return s?.canteen_id || s?.id || null;
    }
    return null;
  }

  // ---------- positioning ----------
  function place() {
    if (root.hidden) return;
    if (!isDesktop()) {
      root.style.removeProperty('left');
      root.style.transform = '';
      delete root.dataset.side;
      return;
    }
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = root.offsetWidth;
    const ph = card.offsetHeight;
    const barBottom = document.querySelector('.map-bar')?.getBoundingClientRect().bottom ?? 0;
    const topMin = barBottom + 12;
    const p = anchorId ? map.screenOf(anchorId) : null;
    let left;
    let top;
    let side = 'none';
    if (p) {
      const gap = p.halfW + 14;
      side = 'right';
      left = p.x + gap;
      if (left + w > vw - 16) { side = 'left'; left = p.x - gap - w; }
      if (left < 16) { side = 'none'; left = Math.min(Math.max(16, left), vw - w - 16); }
      top = Math.min(Math.max(p.y - 80, topMin), vh - ph - 16);
      const offscreen = p.x < 0 || p.x > vw || p.y < topMin || p.y > vh;
      if (offscreen) side = 'none';
      card.style.setProperty('--arrow-y', `${Math.min(Math.max(p.y - top, 24), ph - 24)}px`);
    } else {
      left = vw - w - 16;   // lists dock to the right
      top = topMin;
    }
    root.dataset.side = side;
    root.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(Math.max(top, topMin))}px, 0)`;
  }

  // ---------- phone sheet ----------
  // On phones the visible map is the strip between the top bar and the half-open sheet;
  // put the marker's point in the middle of that strip (its tag hangs ~70px above it).
  function phoneFocusY() {
    const barBottom = document.querySelector('.map-bar')?.getBoundingClientRect().bottom ?? 0;
    const vh = window.innerHeight;
    return ((barBottom + vh * 0.5) / 2 + 35) / vh;
  }

  let sheetState = 'half';
  function sheetY(state) {
    const hgt = card.offsetHeight;
    if (state === 'full') return 0;
    if (state === 'closed') return hgt;
    return Math.max(0, hgt - window.innerHeight * 0.5);
  }
  function setSheet(state) {
    sheetState = state;
    root.dataset.sheet = state;
    root.style.setProperty('--sheet-y', `${sheetY(state)}px`);
  }

  // Drag the sheet between half height and full height (pinned to the top of the screen).
  // The handle always drags. The content drags too while the sheet is half open, and when
  // it is full but already scrolled to the top and pulled down; otherwise it just scrolls.
  {
    let drag = null;
    const start = (e) => {
      if (isDesktop() || e.touches.length !== 1) return;
      drag = { y0: e.touches[0].clientY, base: sheetY(sheetState), t0: performance.now(), active: false,
        onContent: body.contains(e.target) };
    };
    const move = (e) => {
      if (!drag) return;
      const dy = e.touches[0].clientY - drag.y0;
      if (!drag.active) {
        if (drag.onContent && sheetState === 'full' && body.scrollTop <= 0 && dy > 0) e.preventDefault();
        if (Math.abs(dy) < 6) return; // still a tap
        const scrollsInstead = drag.onContent && sheetState === 'full' && !(dy > 0 && body.scrollTop <= 0);
        if (scrollsInstead) { drag = null; return; }
        drag.active = true;
        drag.y0 += dy; // start moving from here, so the sheet doesn't jump
        drag.t0 = performance.now();
        root.classList.add('is-dragging');
        return;
      }
      e.preventDefault();
      root.style.setProperty('--sheet-y', `${Math.max(0, drag.base + dy)}px`);
    };
    const end = (e) => {
      const d = drag;
      drag = null;
      if (!d?.active) return;
      root.classList.remove('is-dragging');
      const dy = (e.changedTouches[0]?.clientY ?? d.y0) - d.y0;
      const speed = dy / Math.max(1, performance.now() - d.t0); // px per ms, + is downwards
      const y = d.base + dy;
      const half = sheetY('half');
      let target;
      if (speed > 0.5) target = sheetState === 'full' ? 'half' : 'closed';
      else if (speed < -0.5 || y < half / 2) target = 'full';
      else if (y > half + (sheetY('closed') - half) / 2) target = 'closed';
      else target = 'half';
      if (target === 'closed') close();
      else setSheet(target);
    };
    card.addEventListener('touchstart', start, { passive: true });
    card.addEventListener('touchmove', move, { passive: false });
    card.addEventListener('touchend', end);
    card.addEventListener('touchcancel', end);
    grip.addEventListener('click', () => { if (!isDesktop()) setSheet(sheetState === 'full' ? 'half' : 'full'); });
  }

  // ---------- views ----------
  function render(view) {
    if (view.type === 'canteen') return canteenView(store.canteens.get(view.id));
    if (view.type === 'stall') return stallView(store.stalls.get(view.id));
    if (view.type === 'cluster') return clusterView(view.ids.map((id) => store.stalls.get(id)));
    return listView(view.type);
  }

  function backButton() {
    const prev = stack[stack.length - 2];
    if (!prev) return null;
    const label = prev.type === 'canteen' ? store.canteens.get(prev.id).name_zh
      : prev.type === 'top' ? '评分榜' : prev.type === 'picks' ? '新生推荐'
        : prev.type === 'cluster' ? `这里的 ${prev.ids.length} 家店` : '返回';
    return h('button', { class: 'pv-back', type: 'button', onclick: back }, icon('back', ''), label);
  }

  function scoreLine(p) {
    if (p.avg == null) return h('p', { class: 'score-line' }, stars(null), '暂无评分 · No ratings yet');
    return h('p', { class: 'score-line' }, stars(p.avg, starLabel(p.avg, p.count)),
      h('strong', {}, p.avg.toFixed(1)), `${p.count} 条评分 · ${p.count} rating${p.count === 1 ? '' : 's'}`);
  }

  function stallRow(s, { rank, showCanteen } = {}) {
    const cat = store.categories.get(s.category);
    const canteen = s.canteen_id ? store.canteens.get(s.canteen_id) : null;
    const sub = showCanteen
      ? (canteen ? canteen.name_zh : '独立门店 · Standalone')
      : [cat.zh, s.price].filter(Boolean).join(' · ');
    return h('li', {}, h('button', {
      class: 'stall-row', type: 'button',
      onclick: () => show({ type: 'stall', id: s.id, fly: showCanteen ? undefined : false }, { push: true }),
    },
    rank ? h('span', { class: 'stall-rank', 'aria-label': `第 ${rank} 名` }, rank) : h('span', { class: 'stall-ico' }, icon(s.category)),
    h('span', { class: 'stall-text' },
      h('span', { class: 'stall-name' }, s.name_zh, s.pick ? ' ' : null, s.pick ? h('span', { class: 'tag tag-pick' }, '推荐 Pick') : null),
      s.name_en ? h('span', { class: 'stall-en' }, s.name_en) : null,
      h('span', { class: 'stall-sub' }, sub)),
    h('span', { class: 'stall-score' },
      s.avg == null ? h('span', {}, '暂无评分') : [h('strong', {}, s.avg.toFixed(1)), stars(s.avg, starLabel(s.avg, s.count)), `${s.count} 条`])));
  }

  function sortStalls(list) {
    const byName = (a, b) => a.name_zh.localeCompare(b.name_zh, 'zh');
    const copy = [...list];
    if (sort === 'rating') return copy.sort((a, b) => (b.avg ?? -1) - (a.avg ?? -1) || b.count - a.count || byName(a, b));
    if (sort === 'count') return copy.sort((a, b) => b.count - a.count || (b.avg ?? -1) - (a.avg ?? -1) || byName(a, b));
    return copy.sort((a, b) => b.pick - a.pick || a.category.localeCompare(b.category) || byName(a, b));
  }

  function canteenView(c) {
    const list = store.stallsOf(c.id);
    const listEl = h('ul', { class: 'stall-list', 'aria-label': '摊位列表 Stalls' });
    const fill = () => listEl.replaceChildren(...sortStalls(list).map((s) => stallRow(s)));
    fill();
    const seg = h('div', { class: 'seg', role: 'group', 'aria-label': '排序 Sort' }, SORTS.map(([key, zh, en]) => h('button', {
      type: 'button', 'aria-pressed': String(sort === key),
      onclick: (e) => {
        sort = key;
        seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget)));
        fill();
      },
    }, `${zh} ${en}`)));
    const area = AREA[c.area];
    const suggest = `/about?canteen=${encodeURIComponent(c.id)}#suggest`;

    return h('div', { class: 'pv' },
      backButton(),
      h('header', { class: 'pv-head' },
        h('h2', { class: 'pv-title', id: 'panel-title' }, c.name_zh),
        c.name_en ? h('p', { class: 'pv-title-en' }, c.name_en) : null),
      h('div', { class: 'pv-meta' },
        area ? h('span', { class: 'tag' }, `${area[0]} ${area[1]}`) : null,
        h('span', {}, `${list.length} 个摊位 · ${list.length} stall${list.length === 1 ? '' : 's'}`),
        c.hours ? h('span', {}, `营业 Hours ${c.hours}`) : null),
      scoreLine(c),
      c.note_zh || c.note_en ? h('p', { class: 'pv-note' }, [c.note_zh, c.note_en].filter(Boolean).join(' · ')) : null,
      list.length
        ? [seg, listEl, h('p', { class: 'pv-foot' }, '少了哪家？', h('a', { href: suggest }, '补充摊位 · Tell us about a missing stall'))]
        : h('div', { class: 'empty' },
          icon('other'),
          h('p', { class: 'empty-title' }, '这里的摊位还没收录'),
          h('p', {}, 'No stalls listed here yet. Know one? Add it and it will appear after a quick check.'),
          h('a', { class: 'btn', href: suggest }, '补充一个摊位 Add a stall')));
  }

  function stallView(s) {
    const cat = store.categories.get(s.category);
    const canteen = s.canteen_id ? store.canteens.get(s.canteen_id) : null;
    const reviewsBox = h('div', { class: 'pv-section' }, h('p', { class: 'loading' }, '正在加载评价… Loading reviews…'));
    const summaryBox = h('div', { class: 'summary' });
    const form = rateForm(s, { summaryBox, reviewsBox });
    loadRatings(s, { summaryBox, reviewsBox, form });

    return h('div', { class: 'pv' },
      backButton(),
      h('figure', { class: 'photo' }, s.photo
        ? h('img', { src: `/static/photos/${s.photo}`, alt: `${s.name_zh} 的照片 · Photo of ${s.name_en || s.name_zh}`, loading: 'lazy', width: 800, height: 600 })
        : h('div', { class: 'photo-empty' }, icon(s.category), '照片待拍摄 · Photo coming soon')),
      h('header', { class: 'pv-head' },
        h('h2', { class: 'pv-title', id: 'panel-title' }, s.name_zh),
        s.name_en ? h('p', { class: 'pv-title-en' }, s.name_en) : null),
      h('div', { class: 'pv-meta' },
        h('span', { class: 'tag' }, icon(s.category), `${cat.zh} ${cat.en}`),
        s.pick ? h('span', { class: 'tag tag-pick' }, '新生推荐 Pick') : null,
        canteen ? h('span', {}, `位于 ${canteen.name_zh} · in ${canteen.name_en}`) : null),
      h('div', { class: 'pv-meta' },
        h('span', {}, s.price ? `人均 ${s.price}` : '价格待补充 · Price TBC'),
        h('span', {}, s.hours ? `营业 ${s.hours}` : '营业时间待补充 · Hours TBC')),
      s.desc_zh || s.desc_en ? h('p', { class: 'pv-desc' }, [s.desc_zh, s.desc_en].filter(Boolean).join(' · ')) : null,
      h('section', { class: 'pv-section', 'aria-labelledby': 'rate-title' },
        h('h3', { class: 'pv-section-title', id: 'rate-title' }, '评分', h('span', { class: 'en' }, 'Ratings')),
        summaryBox,
        form),
      reviewsBox,
      h('p', { class: 'pv-foot' }, '信息有误？',
        h('a', { href: `/about?canteen=${encodeURIComponent(s.canteen_id || '')}&stall=${encodeURIComponent(s.name_zh)}&kind=correction#suggest` },
          '告诉我们 · Report a mistake')));
  }

  function renderSummary(box, summary) {
    const { avg, count, distribution } = summary;
    const max = Math.max(1, ...Object.values(distribution));
    box.replaceChildren(
      h('div', { class: 'summary-avg' },
        h('strong', {}, avg == null ? '–' : avg.toFixed(1)),
        stars(avg, starLabel(avg, count)),
        h('span', { class: 'summary-count' }, `${count} 条评分 · ${count} rating${count === 1 ? '' : 's'}`)),
      h('ul', { class: 'dist', 'aria-label': '评分分布 Rating breakdown' }, [5, 4, 3, 2, 1].map((n) => h('li', {},
        h('span', {}, `${n}★`),
        h('span', { class: 'dist-bar' }, h('span', { style: `transform:scaleX(${distribution[n] / max})` })),
        h('span', {}, distribution[n])))));
  }

  function renderReviews(box, ratings) {
    const items = ratings.map((r) => h('li', { class: 'review' },
      h('div', { class: 'review-head' },
        stars(r.stars, `${r.stars} 星 · ${r.stars} stars`),
        h('span', {}, timeAgo(r.updated_at)),
        r.mine ? h('span', { class: 'review-me' }, '我 · You') : null),
      r.comment
        ? h('p', { class: 'review-text' }, r.comment)
        : h('p', { class: 'review-text is-blank' }, '只打了分 · Stars only')));
    box.replaceChildren(
      h('h3', { class: 'pv-section-title' }, '大家怎么说', h('span', { class: 'en' }, 'Reviews')),
      items.length ? h('ul', { class: 'reviews' }, items)
        : h('p', { class: 'loading' }, '还没有评价，来写第一条吧 · No reviews yet — be the first.'));
  }

  async function loadRatings(s, { summaryBox, reviewsBox, form }) {
    const req = ++ratingRequest;
    renderSummary(summaryBox, { avg: s.avg, count: s.count, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } });
    try {
      const data = await api.getStallRatings(s.id);
      if (req !== ratingRequest) return; // the visitor already moved on
      renderSummary(summaryBox, data.summary);
      renderReviews(reviewsBox, data.ratings);
      form.prefill(data.mine);
    } catch (err) {
      if (req !== ratingRequest) return;
      reviewsBox.replaceChildren(
        h('p', { class: 'form-status is-error', role: 'alert' }, err.message),
        h('button', { class: 'btn', type: 'button', onclick: () => loadRatings(s, { summaryBox, reviewsBox, form }) }, '重试 Retry'));
    }
  }

  function rateForm(s, { summaryBox, reviewsBox }) {
    const uid = `r-${s.id}`;
    const caption = h('span', { class: 'star-caption', 'aria-live': 'polite' });
    const starsError = h('p', { class: 'field-error', id: `${uid}-err` });
    const row = h('div', { class: 'stars-row' }, [5, 4, 3, 2, 1].flatMap((n) => [
      h('input', { type: 'radio', name: `${uid}-stars`, id: `${uid}-${n}`, value: n }),
      h('label', { for: `${uid}-${n}`, title: `${n} 星 · ${STAR_WORDS[n][1]}` },
        icon('star', ''), h('span', { class: 'visually-hidden' }, `${n} 星 · ${n} star${n > 1 ? 's' : ''}`)),
    ]));
    const fieldset = h('fieldset', { class: 'stars-input', 'aria-describedby': `${uid}-err` },
      h('legend', {}, '你的评分 · Your rating'),
      h('div', { class: 'stars-pick' }, row, caption),
      starsError);
    const counter = h('span', { class: 'counter' }, `0 / ${COMMENT_MAX}`);
    const commentError = h('p', { class: 'field-error', id: `${uid}-cerr` });
    const textarea = h('textarea', {
      class: 'textarea', id: `${uid}-comment`, maxlength: COMMENT_MAX, rows: 3,
      placeholder: '比如：分量足，中午排队约 10 分钟 · e.g. Big portions, ~10 min queue at noon',
      'aria-describedby': `${uid}-cerr`,
    });
    const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, '提交评分 Submit');
    const mineNote = h('p', { class: 'rate-mine' });
    const status = h('p', { class: 'form-status', role: 'status', 'aria-live': 'polite' });
    const form = h('form', { class: 'rate-form', novalidate: true },
      fieldset,
      h('div', { class: 'field' },
        h('label', { class: 'field-label', for: `${uid}-comment` }, '一句话评价（可选）· Comment (optional)'),
        textarea, commentError),
      h('div', { class: 'rate-foot' }, counter, submit),
      mineNote, status);

    const selected = () => Number(row.querySelector('input:checked')?.value || 0);
    const showCaption = () => {
      const n = selected();
      caption.textContent = n ? `${STAR_WORDS[n][0]} · ${STAR_WORDS[n][1]}` : '';
    };
    const updateCounter = () => {
      const len = textarea.value.length;
      counter.textContent = `${len} / ${COMMENT_MAX}`;
      counter.classList.toggle('is-near', len > COMMENT_MAX - 20);
    };
    row.addEventListener('change', () => {
      showCaption();
      fieldset.removeAttribute('aria-invalid');
      starsError.textContent = '';
      status.textContent = '';
    });
    textarea.addEventListener('input', () => {
      updateCounter();
      textarea.removeAttribute('aria-invalid');
      commentError.textContent = '';
    });

    form.prefill = (mine) => {
      if (!mine) return;
      const input = row.querySelector(`input[value="${mine.stars}"]`);
      if (input) input.checked = true;
      textarea.value = mine.comment || '';
      updateCounter();
      showCaption();
      submit.textContent = '更新评分 Update';
      mineNote.textContent = `你 ${timeAgo(mine.updated_at).split(' · ')[0]}评过，可以随时修改 · You rated this ${timeAgo(mine.updated_at).split(' · ')[1]}. You can change it any time.`;
    };

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      status.className = 'form-status';
      status.textContent = '';
      const n = selected();
      if (!n) {
        fieldset.setAttribute('aria-invalid', 'true');
        starsError.textContent = '请先点选星级 · Pick a star rating first.';
        row.querySelector('input[value="1"]').focus();
        return;
      }
      if (textarea.value.trim().length > COMMENT_MAX) {
        textarea.setAttribute('aria-invalid', 'true');
        commentError.textContent = `评论最多 ${COMMENT_MAX} 字 · Keep comments under ${COMMENT_MAX} characters.`;
        textarea.focus();
        return;
      }
      submit.disabled = true;
      submit.classList.add('is-loading');
      try {
        const res = await api.saveRating(s.id, n, textarea.value.trim());
        status.className = 'form-status is-ok';
        status.textContent = res.created ? '已保存，谢谢！· Saved — thanks!' : '已更新你的评分 · Your rating was updated.';
        submit.textContent = '更新评分 Update';
        renderSummary(summaryBox, res.summary);
        form.prefill(res.mine);
        store.applySummary(s.id, res.summary);
        const data = await api.getStallRatings(s.id).catch(() => null);
        if (data) renderReviews(reviewsBox, data.ratings);
      } catch (err) {
        status.className = 'form-status is-error';
        status.textContent = err.errors?.stars || err.errors?.comment || err.errors?.client || err.message;
        if (err.errors?.comment) { textarea.setAttribute('aria-invalid', 'true'); commentError.textContent = err.errors.comment; }
      } finally {
        submit.disabled = false;
        submit.classList.remove('is-loading');
      }
    });
    return form;
  }

  function clusterView(list) {
    return h('div', { class: 'pv' },
      h('header', { class: 'pv-head' },
        h('h2', { class: 'pv-title', id: 'panel-title' }, `这里有 ${list.length} 家店`),
        h('p', { class: 'pv-title-en' }, `${list.length} places right next to each other`)),
      h('ul', { class: 'stall-list' }, sortStalls(list).map((s) => stallRow(s))));
  }

  function listView(type) {
    let title, titleEn, items, empty;
    if (type === 'top') {
      title = '评分榜';
      titleEn = 'Top rated stalls';
      items = [...store.stalls.values()].filter((s) => s.count > 0)
        .sort((a, b) => b.avg - a.avg || b.count - a.count).slice(0, 20);
      empty = ['还没有人评分', 'Nobody has rated a stall yet. Open any stall on the map and be the first.'];
    } else {
      title = '新生推荐';
      titleEn = 'Picks for freshers';
      items = [...store.stalls.values()].filter((s) => s.pick);
      empty = ['推荐清单整理中', 'Our list of picks is on its way. Meanwhile, check the top rated stalls.'];
    }
    return h('div', { class: 'pv' },
      h('header', { class: 'pv-head' },
        h('h2', { class: 'pv-title', id: 'panel-title' }, title),
        h('p', { class: 'pv-title-en' }, titleEn)),
      type === 'picks' && items.length ? h('p', { class: 'pv-note' }, '学长学姐挑的第一周可以放心去吃的摊位 · Safe bets for your first week, chosen by older students.') : null,
      items.length
        ? h('ul', { class: 'stall-list' }, items.map((s, i) => stallRow(s, { rank: type === 'top' ? i + 1 : null, showCanteen: true })))
        : h('div', { class: 'empty' },
          icon(type === 'top' ? 'star' : 'other'),
          h('p', { class: 'empty-title' }, empty[0]),
          h('p', {}, empty[1]),
          type === 'picks' ? h('button', { class: 'btn', type: 'button', onclick: () => show({ type: 'top' }) }, '看评分榜 Top rated') : null));
  }

  return {
    openCanteen: (id, opts = {}) => store.canteens.has(id) && show({ type: 'canteen', id, ...opts }),
    openStall: (id, opts = {}) => {
      const s = store.stalls.get(id);
      if (!s) return;
      // a stall inside a canteen opens on top of its canteen, so "back" leads there
      if (s.canteen_id && !opts.push) {
        stack = [{ type: 'canteen', id: s.canteen_id }];
        show({ type: 'stall', id, ...opts }, { push: true });
      } else show({ type: 'stall', id, ...opts }, { push: !!opts.push });
    },
    openList: (type) => show({ type }),
    openCluster: (id, ids) => show({ type: 'cluster', id, ids }),
    refresh: () => { if (!root.hidden && stack.length) show({ ...stack[stack.length - 1], fly: false }, { back: true }); },
    close,
    current: () => stack[stack.length - 1] || null,
  };
}
