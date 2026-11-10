// Make worlds ahead of time, without opening the site.
//
//   node --env-file-if-exists=.env scripts/make-worlds.mjs the-upward-rain          first place of that story
//   node --env-file-if-exists=.env scripts/make-worlds.mjs the-upward-rain/04-two-directions-of-rain not-today/whale-city
//   node --env-file-if-exists=.env scripts/make-worlds.mjs --next 5                 the 5 newest stories with no world yet
//   node --env-file-if-exists=.env scripts/make-worlds.mjs --list                   what has been made
//   add --dry-run to see what would be made without spending anything
//   (`npm run worlds -- <the same arguments>` is the short form)
//
// Uses the same pipeline and the same worlds/ folder as the server, so anything made here opens
// instantly in the site, and anything already made is skipped (never billed twice).
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAtlas } from '../server/atlas.mjs';
import { createWorlds } from '../server/worlds.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = name => args.includes(name);
const value = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let library;
try { library = JSON.parse(await readFile(path.join(ROOT, 'site', 'data', 'library.json'), 'utf8')); }
catch { console.error('site/data/library.json is missing. Build it first:  python scripts/build_data.py'); process.exit(1); }

const worldsRoot = path.resolve(ROOT, process.env.WORLDS_DIR ?? 'worlds');
const haveKey = Boolean(process.env.WLT_API_KEY);
const atlas = haveKey ? createAtlas({ apiKey: process.env.WLT_API_KEY, baseUrl: process.env.WLT_API_BASE_URL || undefined }) : null;
const worlds = createWorlds({
  atlas, root: worldsRoot, siteRoot: path.join(ROOT, 'site'), library,
  quality: (process.env.WORLD_QUALITY ?? 'draft').toLowerCase() === 'refined' ? 'refined' : 'draft',
  dailyLimit: Number.MAX_SAFE_INTEGER, concurrency: Number.MAX_SAFE_INTEGER,   // this command is its own limit
  log: () => {},
});
const made = await worlds.list();
const has = (slug, scene) => made.some(w => w.slug === slug && w.scene === scene);

if (flag('--list')) {
  for (const w of made) {
    const story = library.stories.find(s => s.slug === w.slug);
    console.log(`${w.slug}/${w.scene}   ${story?.title ?? ''}`);
  }
  console.log(`${made.length} worlds made, ${library.stories.filter(s => s.scenes.some(sc => has(s.slug, sc.id))).length} of ${library.stories.length} stories have one.`);
  process.exit(0);
}

// Work out what to make.
const jobs = [];
const unknown = [];
const next = Number(value('--next') ?? 0);
const skip = new Set(['--next', '--dry-run', '--list']);
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--next') { i += 1; continue; }
  if (skip.has(args[i])) continue;
  const [slug, sceneId] = args[i].split('/');
  const story = library.stories.find(s => s.slug === slug);
  // A story named without a place means its first place, unless one of its places is already made.
  const scene = sceneId ? story?.scenes.find(s => s.id === sceneId) : (story?.scenes.find(s => has(slug, s.id)) ?? story?.scenes[0]);
  if (!story || !scene) unknown.push(args[i]); else jobs.push({ story, scene });
}
if (next > 0) {
  const newestFirst = [...library.stories].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  for (const story of newestFirst) {
    if (jobs.length >= next) break;
    if (!story.scenes.length || story.scenes.some(sc => has(story.slug, sc.id))) continue;
    if (!jobs.some(j => j.story.slug === story.slug)) jobs.push({ story, scene: story.scenes[0] });
  }
}
if (unknown.length) { console.error(`No such story or place: ${unknown.join(', ')}\nPlaces are listed per story in site/data/library.json (scenes[].id).`); process.exit(1); }
if (!jobs.length) { console.log('Nothing to make. Name a story by its slug, or use --next 5. Examples are at the top of scripts/make-worlds.mjs.'); process.exit(0); }

const todo = jobs.filter(j => !has(j.story.slug, j.scene.id));
for (const j of jobs) console.log(`${has(j.story.slug, j.scene.id) ? 'already made' : 'to make     '}  ${j.story.slug}/${j.scene.id}   “${j.story.title}”: ${j.scene.title}`);
if (!todo.length) process.exit(0);
console.log(`\n${todo.length} new world${todo.length === 1 ? '' : 's'}. On 10 Nov 2026 a world cost roughly 300 credits (about $0.30); check your World Labs usage page for the current rate.`);
if (flag('--dry-run')) process.exit(0);
if (!haveKey) { console.error('WLT_API_KEY is not set. Put it in .env (see .env.example).'); process.exit(1); }

// Make them, two at a time.
const queue = [...todo];
let failed = 0;
async function worker() {
  for (let job = queue.shift(); job; job = queue.shift()) {
    const name = `${job.story.slug}/${job.scene.id}`;
    const began = Date.now();
    const result = await worlds.start(job.story.slug, job.scene.id);
    if (result.error) { console.log(`✗ ${name}: ${result.error}`); failed += 1; continue; }
    let stage = '';
    for (;;) {
      const world = await worlds.status(job.story.slug, job.scene.id);
      if (world.stage !== stage) {
        stage = world.stage;
        const note = { pose: 'reading the painting’s depth', views: 'painting the surrounding views', splat: 'fusing splats', ready: `ready, ${world.frames.length} views`, failed: `failed: ${world.error}` }[stage] ?? stage;
        console.log(`${stage === 'ready' ? '✓' : stage === 'failed' ? '✗' : '…'} ${name}: ${note} (${Math.round((Date.now() - began) / 1000)} s)`);
      }
      if (stage === 'ready') break;
      if (stage === 'failed') { failed += 1; break; }
      await sleep(4000);
    }
  }
}
await Promise.all([worker(), worker()]);
console.log(failed ? `Done, ${failed} failed. Run the same command again to retry them.` : 'Done. Open the site and step inside.');
process.exit(failed ? 1 : 0);
