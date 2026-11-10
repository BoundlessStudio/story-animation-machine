// Story Animation Machine: the Living Library, and the worlds inside its books.
//
//   room.js   the library (ported from the Story Computing Machine website and extended)
//   world.js  a story's place, given depth and surroundings by World Labs Atlas
//   this file joins them: data, search, the way in and out of a book, the reader, the server.
import { openLibrary } from './room.js';
import { renderProse } from './reader.js';

const $ = id => document.getElementById(id);
const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
const coarse = matchMedia('(pointer: coarse)').matches;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const json = async (url, options) => {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body;
};
const dateText = iso => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const escapeHtml = text => String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fail = message => { window.dispatchEvent(new CustomEvent('library-failed', { detail: message })); };

// ---------------------------------------------------------------- data

let data;
try {
  data = await json('data/library.json');
  if (!data.atlas) throw new Error('The cover atlas has not been built yet.');
} catch (error) {
  fail(`${error.message} Run scripts/build_data.py, then reload.`);
  throw error;
}
// The room shows the newest story first, as the existing website does; the date rule on the desk
// runs the other way, oldest on the left.
const stories = data.stories.slice().reverse();
const bySlug = new Map(stories.map((story, index) => [story.slug, index]));
const roomData = {
  total: stories.length,
  atlasSrc: data.atlas.src,
  atlas: { cols: data.atlas.cols, rows: data.atlas.rows },
  stories: stories.map(story => {
    const places = story.scenes.slice(0, 3);
    return {
      slug: story.slug, title: story.title, rating: story.rating, prompt: story.prompt ?? '', created: story.created,
      meta: `${dateText(story.created)} · ${story.rating}`,
      url: `?story=${story.slug}&in=1`, cover: story.cover ?? '', slot: story.tile,
      references: [
        ...places.map(scene => ({ src: scene.src, full: scene.src, title: scene.title, scene: scene.id })),
        ...story.characters.slice(0, 6 - places.length).map(person => ({ src: person.src, full: person.src, title: person.title })),
      ],
    };
  }),
};
$('site-counts').textContent = `${stories.length} stories · ${data.totals.scenes.toLocaleString()} places`;

// ---------------------------------------------------------------- the room

const veil = $('veil');
const room = openLibrary(roomData, {
  open: (index, sceneId) => enterWorld({ index, sceneId }),
  read: index => enterWorld({ index, read: true }),
  opening: flood => { if (mode === 'library') veil.style.opacity = String(flood * flood); },
});
let mode = 'library';

// ---------------------------------------------------------------- server

const config = await json('api/config').catch(() => ({ worlds: false, canGenerate: false, autostart: false, splats: false }));
const alive = new Map();                                  // slug -> Set of scene ids with a finished world
async function refreshAlive() {
  const list = await json('api/worlds').catch(() => ({ worlds: [] }));
  alive.clear();
  for (const item of list.worlds) (alive.get(item.slug) ?? alive.set(item.slug, new Set()).get(item.slug)).add(item.scene);
  room.setAlive([...alive.keys()].map(slug => bySlug.get(slug)).filter(index => index !== undefined));
}

// ---------------------------------------------------------------- search

{
  const input = $('search-input'), list = $('search-results');
  let matches = [], active = 0;
  const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); };
  const paint = () => {
    list.replaceChildren(...matches.map((index, i) => {
      const story = stories[index], item = document.createElement('li');
      item.setAttribute('role', 'option'); item.setAttribute('aria-selected', i === active);
      item.innerHTML = `<img src="${escapeHtml(story.cover ?? '')}" alt="" loading="lazy"><span><b>${escapeHtml(story.title)}</b><small>${dateText(story.created)} · ${escapeHtml(story.rating)}</small></span>`;
      item.addEventListener('pointerdown', event => { event.preventDefault(); choose(index); });
      return item;
    }));
    list.hidden = !matches.length; input.setAttribute('aria-expanded', String(Boolean(matches.length)));
  };
  const choose = index => { room.choose(index); input.value = ''; matches = []; close(); input.blur(); };
  input.addEventListener('input', () => {
    const query = input.value.trim().toLowerCase();
    if (!query) { matches = []; return close(); }
    const inTitle = [], inPrompt = [];
    stories.forEach((story, index) => {
      if (story.title.toLowerCase().includes(query)) inTitle.push(index);
      else if ((story.prompt ?? '').toLowerCase().includes(query)) inPrompt.push(index);
    });
    matches = [...inTitle, ...inPrompt].slice(0, 8); active = 0; paint();
  });
  input.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { active = (active + (event.key === 'ArrowDown' ? 1 : matches.length - 1)) % Math.max(1, matches.length); paint(); event.preventDefault(); }
    else if (event.key === 'Enter' && matches.length) choose(matches[active]);
    else if (event.key === 'Escape') { input.value = ''; matches = []; close(); input.blur(); }
  });
  input.addEventListener('blur', () => setTimeout(close, 120));
  addEventListener('keydown', event => {
    if (event.key === '/' && mode === 'library' && !event.target.matches?.('input, textarea')) { input.focus(); event.preventDefault(); }
  });
}

// ---------------------------------------------------------------- the world view (made on first use)

const stage = $('stage');
let world = null, renderer = null, THREE = null;
async function ensureWorld() {
  if (world) return world;
  if (world === false) return null;
  try {
    const [three, { WorldView }] = await Promise.all([import('three'), import('./world.js')]);
    THREE = three;
    const lowPower = coarse || (navigator.deviceMemory && navigator.deviceMemory <= 4);
    const quality = new URLSearchParams(location.search).get('quality') ?? (lowPower ? 'balanced' : 'full');
    renderer = new THREE.WebGLRenderer({ canvas: stage, antialias: !coarse, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, quality === 'full' ? 2 : 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    world = new WorldView(renderer, { quality });
    resize();
    return world;
  } catch (error) {
    console.warn('World view unavailable:', error);
    world = false;                                        // no WebGL: the painting is shown flat instead
    return null;
  }
}
function resize() {
  if (!world) return;
  renderer.setSize(innerWidth, innerHeight, false);
  world.resize(innerWidth, innerHeight);
}
addEventListener('resize', resize);

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  world.update(dt, { still });
  world.render();
}
const startLoop = () => { last = performance.now(); renderer?.setAnimationLoop(now => { if (!document.hidden && mode === 'world') frame(now); }); };
const stopLoop = () => renderer?.setAnimationLoop(null);

// ---------------------------------------------------------------- inside a book

const view = { story: null, scene: null, key: '', timer: 0, state: null, shown: '', reader: false, prose: '', started: 0, asked: new Set() };

function setLife(text, { working = false, make = false, walk = false } = {}) {
  $('life-text').textContent = text;
  $('life-text').classList.toggle('is-working', working);
  $('make').hidden = !make;
  $('walk').hidden = !walk;
}

function paintScenes() {
  const { story, scene } = view;
  $('scenes').replaceChildren(...story.scenes.map(item => {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'scene' + (alive.get(story.slug)?.has(item.id) ? ' is-alive' : '');
    button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', item.id === scene?.id); button.title = item.title;
    button.innerHTML = `<img src="${escapeHtml(item.src)}" alt="${escapeHtml(item.title)}" loading="lazy">`;
    button.addEventListener('click', () => showScene(item));
    return button;
  }));
  $('scenes').hidden = story.scenes.length < 2;
}

async function showScene(scene) {
  const story = view.story;
  clearTimeout(view.timer);
  view.scene = scene; view.key = `${story.slug}/${scene?.id}`; view.state = null; view.shown = ''; view.started = 0;
  $('world-story').textContent = story.title;
  $('world-scene').textContent = scene?.title ?? 'No painting of this place yet';
  paintScenes();
  route();
  stage.style.backgroundImage = scene && !world ? `url("${scene.src}")` : '';
  if (!scene) {
    world?.clear(); world?.setPalette({ sky: story.colour ?? '#222', ground: '#000' });
    return setLife('This story has no location painting yet, so there is no place to step into. You can still read it here.');
  }
  setLife('');
  if (!world) return setLife(config.worlds ? 'This device cannot show the place in depth, so the painting is shown as it was made.' : '');
  world.setPalette({ sky: scene.sky, ground: scene.ground, light: scene.mid });
  const key = view.key;
  await world.showPainting(scene).catch(() => {});
  if (key === view.key) poll();
}

const STAGES = {
  pose: 'Atlas is reading the painting’s depth…',
  views: 'Atlas is painting the rest of the place around you. About a minute…',
  splat: 'Atlas is fusing the views into a walkable world. This takes several minutes…',
};

async function start() {
  const { story, scene } = view, key = view.key;
  $('make').disabled = true;
  try {
    await json(`api/worlds/${story.slug}/${scene.id}`, { method: 'POST' });
    if (key !== view.key) return;
    view.started = performance.now();
    setLife(STAGES.pose, { working: true });
    view.timer = setTimeout(poll, 1500);
  } catch (error) {
    if (key === view.key) setLife(error.message, { make: config.canGenerate });
  } finally { $('make').disabled = false; }
}

async function poll() {
  const key = view.key, { story, scene } = view;
  let state;
  try { state = await json(`api/worlds/${story.slug}/${scene.id}`); } catch { state = { stage: 'none', frames: [] }; }
  if (key !== view.key || mode !== 'world') return;
  view.state = state;
  const busy = ['pose', 'views', 'splat'].includes(state.stage);
  // Show the deepest thing that exists: depth alone first, then the whole surround.
  const tier = state.frames.length > 1 ? 'world' : state.frames.length === 1 ? 'depth' : '';
  if (tier && tier !== view.shown) {
    const fresh = Boolean(view.started);
    view.shown = tier;
    world.showWorld(state, { fresh }).catch(error => console.warn(error));
  }
  if (state.stage === 'ready') {
    if (!alive.get(story.slug)?.has(scene.id)) { await refreshAlive(); paintScenes(); }
    const canWalk = config.splats && !state.splat;
    setLife(state.splat ? 'Drag to look around. This place can also be walked through.' : coarse ? 'Drag to look around.' : 'Drag to look around · scroll to zoom · move the pointer to lean',
      { walk: Boolean(state.splat) || canWalk });
    $('walk').textContent = state.splat ? (world.splat ? 'Back to the painting' : 'Walk through it') : 'Make it walkable';
  } else if (busy) {
    const seconds = view.started ? Math.round((performance.now() - view.started) / 1000) : 0;
    setLife(STAGES[state.stage] + (seconds ? ` ${seconds}s` : ''), { working: true });
    view.timer = setTimeout(poll, 2500);
  } else if (state.stage === 'failed') {
    setLife(`Atlas could not make this place: ${state.error}`, { make: config.canGenerate });
    $('make').textContent = 'Try again';
  } else if (config.canGenerate && config.autostart && !view.asked.has(key)) {
    // Opening a book is the request: bring its place to life without another click.
    view.asked.add(key);
    start();
  } else {
    setLife(config.canGenerate
      ? 'This is the painting as it was made. Atlas can give it depth and paint the rest of the place around you; it takes about a minute.'
      : config.worlds ? 'This place has not been brought to life yet.' : '', { make: config.canGenerate });
    $('make').textContent = 'Bring this place to life';
  }
}

$('make').addEventListener('click', start);
$('walk').addEventListener('click', async () => {
  const { story, scene, state } = view;
  if (state?.splat) {
    if (world.splat) world.hideSplat(); else await world.showSplat(state.splat.src).catch(error => setLife(`The walkable world could not load: ${error.message}`));
    return poll();
  }
  try {
    await json(`api/worlds/${story.slug}/${scene.id}/splat`, { method: 'POST' });
    view.started = performance.now(); poll();
  } catch (error) { setLife(error.message); }
});

// ---------------------------------------------------------------- the reader

const EXPLICIT_KEY = 'story-library-explicit-acknowledged';       // shared with the existing website
const acknowledged = () => { try { return localStorage.getItem(EXPLICIT_KEY) === 'true'; } catch { return false; } };
let acknowledgedHere = false;

async function loadProse(story) {
  $('reader-gate').hidden = true; $('fin').hidden = false;
  try {
    const text = await json(`data/stories/${story.slug}.json`);
    if (view.story === story) { $('prose').replaceChildren(renderProse(text.body)); view.prose = story.slug; }
  } catch { $('prose').textContent = 'The story could not be loaded.'; }
}

async function setReader(open) {
  view.reader = open;
  $('reader').hidden = !open;
  $('world').classList.toggle('has-reader', open);
  $('toggle-reader').setAttribute('aria-expanded', String(open));
  $('toggle-reader').textContent = open ? 'Close the book' : 'Read';
  if (!open) return;
  const story = view.story;
  $('reader-meta').textContent = `${dateText(story.created)} · ${story.rating} · ${Math.max(1, Math.round(story.words / 240))} min read`;
  $('reader-title').textContent = story.title;
  if (view.prose !== story.slug) {
    $('prose').replaceChildren(); $('reader-scroll').scrollTop = 0; $('reader-progress').style.width = '0';
    if (story.rating === 'Explicit' && !acknowledged() && !acknowledgedHere) {
      $('reader-gate-text').textContent = `This story is rated Explicit and contains adult material.${story.notes ? ` ${story.notes}` : ''}`;
      $('reader-gate').hidden = false; $('fin').hidden = true;
    } else await loadProse(story);
  }
  $('reader-scroll').focus({ preventScroll: true });
}
$('reader-gate-ok').addEventListener('click', () => {
  acknowledgedHere = true;
  try { localStorage.setItem(EXPLICIT_KEY, 'true'); } catch { /* Acknowledged for this visit only. */ }
  loadProse(view.story);
});
$('toggle-reader').addEventListener('click', async () => { await setReader(!view.reader); route(); });
$('reader-scroll').addEventListener('scroll', event => {
  const el = event.currentTarget;
  $('reader-progress').style.width = `${(el.scrollTop / Math.max(1, el.scrollHeight - el.clientHeight)) * 100}%`;
}, { passive: true });
$('leave').addEventListener('click', () => leaveWorld());

// ---------------------------------------------------------------- in and out of a book

let busy = false;
async function enterWorld({ index = room.index, read = false, sceneId = null, instant = false } = {}) {
  if (busy || mode === 'world') return;
  busy = true;
  const story = stories[index];
  view.story = story;
  const loading = ensureWorld();
  veil.classList.remove('is-fading');
  if (!instant) await room.open();                      // the book opens and light fills its page
  veil.style.opacity = '1';
  await loading;
  mode = 'world'; document.body.dataset.mode = 'world';
  room.suspend();
  stage.hidden = false; $('world').hidden = false;
  resize(); startLoop();
  await setReader(read);
  await Promise.race([showScene(story.scenes.find(scene => scene.id === sceneId) ?? story.scenes[0] ?? null), sleep(2500)]);
  veil.classList.add('is-fading'); veil.style.opacity = '0';
  busy = false;
}

async function leaveWorld({ instant = false } = {}) {
  if (busy || mode !== 'world') return;
  busy = true;
  clearTimeout(view.timer);
  if (!instant && !still) { veil.classList.add('is-fading'); veil.style.opacity = '1'; await sleep(520); }
  mode = 'library'; document.body.dataset.mode = 'library';
  stage.hidden = true; $('world').hidden = true; view.key = '';
  stopLoop(); world?.clear?.();
  route();
  room.resume();
  veil.classList.add('is-fading'); veil.style.opacity = '0';
  busy = false;
}

// The address always says where you are, so a link opens the same book, place and page.
function route() {
  const url = new URL(location.href);
  for (const key of ['in', 'scene', 'read']) url.searchParams.delete(key);
  if (mode === 'world') {
    url.searchParams.set('story', view.story.slug);
    url.searchParams.set('in', '1');
    if (view.scene) url.searchParams.set('scene', view.scene.id);
    if (view.reader) url.searchParams.set('read', '1');
  }
  history.replaceState(history.state, '', url);
}

// ---------------------------------------------------------------- pointer, wheel, keys in the world

const press = { id: null, x: 0, y: 0, moved: 0 };
stage.addEventListener('pointerdown', event => {
  stage.setPointerCapture(event.pointerId);
  Object.assign(press, { id: event.pointerId, x: event.clientX, y: event.clientY, moved: 0 });
});
stage.addEventListener('pointermove', event => {
  if (!world) return;
  if (press.id === event.pointerId) {
    const dx = event.clientX - press.x, dy = event.clientY - press.y;
    press.moved += Math.abs(dx) + Math.abs(dy); press.x = event.clientX; press.y = event.clientY;
    if (press.moved > 5) { stage.classList.add('is-dragging'); world.drag(dx, dy); }
  }
  world.point((event.clientX / innerWidth) * 2 - 1, -((event.clientY / innerHeight) * 2 - 1));
});
const release = event => { if (press.id === event.pointerId) { press.id = null; stage.classList.remove('is-dragging'); } };
stage.addEventListener('pointerup', release);
stage.addEventListener('pointercancel', release);
stage.addEventListener('wheel', event => { event.preventDefault(); world?.zoom(event.deltaY); }, { passive: false });

addEventListener('keydown', event => {
  if (mode !== 'world' || event.target.matches?.('input, textarea')) return;
  if (event.key === 'Escape') return view.reader ? (setReader(false), route()) : leaveWorld();
  if (event.target.closest?.('.reader')) return;
  if (event.key.toLowerCase() === 'r') { setReader(!view.reader).then(route); }
  else if (event.key === '0') world?.recentre();
  else world?.key(event.code, true);
});
addEventListener('keyup', event => world?.key(event.code, false));
addEventListener('popstate', () => {
  const params = new URLSearchParams(location.search);
  if (mode === 'world' && !params.get('in')) leaveWorld({ instant: true });
});

// ---------------------------------------------------------------- open

refreshAlive();
await room.whenReady();
{
  const params = new URLSearchParams(location.search);
  const index = bySlug.get(params.get('story'));
  if (params.get('in') && index !== undefined) await enterWorld({ index, instant: true, read: Boolean(params.get('read')), sceneId: params.get('scene') });
}

// A handle for automated checks.
window.__app = {
  room, view, stories, enterWorld, leaveWorld,
  get world() { return world; }, get mode() { return mode; }, get busy() { return busy; },
  pause: () => stopLoop(),
  snap(steps = 0) {
    if (mode !== 'world') return room.snapshot(steps);
    for (let i = 0; i < steps; i += 1) frame(last + 50);
    frame(last + 1);
    return stage.toDataURL('image/jpeg', 0.9);
  },
};
