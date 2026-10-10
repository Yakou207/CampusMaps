// Small DOM and formatting helpers shared by the page scripts.

/** Create an element: h('div', {class: 'x', onclick: fn}, child, 'text', ...). Text is never parsed as HTML. */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value == null) continue;
    if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** <svg class="ico"><use href="#i-name"/></svg> */
export function icon(name, cls = 'ico') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

/** Read-only star meter. avg may be null (no ratings). */
export function stars(avg, label) {
  const row = () => Array.from({ length: 5 }, () => icon('star', ''));
  const fill = h('span', { class: 'stars-fill', style: `width:${((avg || 0) / 5) * 100}%` }, row());
  return h('span', { class: 'stars', role: 'img', 'aria-label': label || starLabel(avg) }, row(), fill);
}

export function starLabel(avg, count) {
  if (avg == null) return '暂无评分 · No ratings yet';
  const n = count != null ? `，${count} 条 · ${count} rating${count === 1 ? '' : 's'}` : '';
  return `${avg.toFixed(1)} 星 · ${avg.toFixed(1)} stars${n}`;
}

export const STAR_WORDS = {
  1: ['不推荐', 'Skip it'],
  2: ['一般', 'Meh'],
  3: ['还行', 'Okay'],
  4: ['好吃', 'Good'],
  5: ['必吃', 'Must-try'],
};

/** "3 天前 · 3 days ago" */
export function timeAgo(iso) {
  const sec = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  const units = [
    [60, '秒', 'second'], [60, '分钟', 'minute'], [24, '小时', 'hour'],
    [30, '天', 'day'], [12, '个月', 'month'], [Infinity, '年', 'year'],
  ];
  let value = sec;
  for (const [step, zh, en] of units) {
    if (value < step) {
      const n = Math.floor(value);
      if (zh === '秒') return '刚刚 · just now';
      return `${n} ${zh}前 · ${n} ${en}${n === 1 ? '' : 's'} ago`;
    }
    value /= step;
  }
  return '';
}

export const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
export const isDesktop = () => window.matchMedia('(min-width: 60rem)').matches;
