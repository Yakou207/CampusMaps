// Admin panel helpers: confirmation before destructive actions, and the map picker for standalone shops.

document.querySelectorAll('form[data-confirm]').forEach((form) => {
  form.addEventListener('submit', (e) => {
    if (!window.confirm(form.dataset.confirm)) e.preventDefault();
  });
});

const picker = document.getElementById('picker');
if (picker) setUpPicker(picker);

async function setUpPicker(box) {
  const lat = document.getElementById('lat');
  const lon = document.getElementById('lon');
  const coords = document.getElementById('coords');
  const canteen = document.getElementById('canteen');
  const locator = document.getElementById('locator');
  const text = await fetch('/static/map/campus.svg').then((r) => r.text());
  box.innerHTML = text;
  const svg = box.querySelector('svg');
  svg.classList.add('campus-map', 'show-labels');
  const W = svg.viewBox.baseVal.width;
  const H = svg.viewBox.baseVal.height;
  const west = +svg.dataset.west;
  const north = +svg.dataset.north;
  const k = +svg.dataset.k;
  const mercY = (d) => Math.log(Math.tan(Math.PI / 4 + (d * Math.PI) / 360));
  const toXY = (la, lo) => ({ x: ((lo - west) * Math.PI / 180) * k, y: (mercY(north) - mercY(la)) * k });
  const toLatLon = (x, y) => ({
    lon: west + (x / k) * 180 / Math.PI,
    lat: (2 * Math.atan(Math.exp(mercY(north) - y / k)) - Math.PI / 2) * 180 / Math.PI,
  });

  let scale = 0.5;
  const marker = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  marker.setAttribute('r', '9');
  marker.setAttribute('class', 'pick-marker');
  svg.append(marker);

  const size = () => { svg.setAttribute('width', W * scale); svg.setAttribute('height', H * scale); };
  const show = () => {
    if (!lat.value || !lon.value) { marker.style.display = 'none'; coords.textContent = '尚未选择位置'; return; }
    const { x, y } = toXY(+lat.value, +lon.value);
    marker.style.display = '';
    marker.setAttribute('cx', x);
    marker.setAttribute('cy', y);
    coords.textContent = `${(+lat.value).toFixed(6)}, ${(+lon.value).toFixed(6)}`;
  };
  const centre = () => {
    if (!lat.value) return;
    const { x, y } = toXY(+lat.value, +lon.value);
    box.scrollLeft = x * scale - box.clientWidth / 2;
    box.scrollTop = y * scale - box.clientHeight / 2;
  };
  const sync = () => locator.classList.toggle('is-off', !!canteen.value);

  svg.addEventListener('click', (e) => {
    const r = svg.getBoundingClientRect();
    const p = toLatLon(((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H);
    lat.value = p.lat.toFixed(7);
    lon.value = p.lon.toFixed(7);
    show();
  });
  document.querySelectorAll('[data-zoom]').forEach((b) => b.addEventListener('click', () => {
    scale = Math.min(2, Math.max(0.25, scale * +b.dataset.zoom));
    size();
    centre();
  }));
  canteen.addEventListener('change', sync);
  size();
  show();
  sync();
  if (lat.value) centre(); else { box.scrollLeft = W * scale * 0.45; box.scrollTop = H * scale * 0.5; }
}
