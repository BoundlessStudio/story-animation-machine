// On-demand worlds: one painting in, a look-around 3D scene out.
//
//   pose    images2PosedRGBD   the painting gets a camera and a depth map      (seconds)
//   views   atlasGenerate      Atlas paints the rest of the place around it    (about a minute)
//   splat   posedImages2Splats optional: fuse the views into Gaussian splats   (minutes)
//
// Every world is a small state machine persisted as worlds/<slug>/<scene>/world.json. `advance`
// moves it one step and is safe to call as often as you like: Atlas operations are submitted with
// idempotency keys derived from the world, so a crash, a restart or two impatient visitors can
// never start (or bill) the same step twice.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AtlasError } from './atlas.mjs';
import { depthStats } from './exr.mjs';
import { describeCamera, planRig } from './rig.mjs';

const GRID = [1280, 720];
const STYLE = 'Oil painting in the manner of the Canadian Group of Seven: broad rhythmic colour shapes, visible directional brushstrokes, selective impasto, simplified forms.';
const SAFE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

let sharp = null;                                   // optional: shrinks stored views about 6x
try { sharp = (await import('sharp')).default; } catch { /* PNGs are stored as delivered */ }

export function createWorlds({ atlas, root, siteRoot, library, quality = 'draft', views = 'surround', dailyLimit = 20, concurrency = 2, log = console.log }) {
  const locks = new Map();
  const ledgerPath = path.join(root, '_ledger.json');
  const dirOf = (slug, scene) => path.join(root, slug, scene);
  const fileOf = (slug, scene) => path.join(dirOf(slug, scene), 'world.json');

  const readJson = async file => { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; } };
  const writeJson = async (file, value) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file + '.tmp', JSON.stringify(value, null, 1));
    await rename(file + '.tmp', file);                // never leave a half-written state file
  };
  const save = world => { world.updatedAt = new Date().toISOString(); return writeJson(fileOf(world.slug, world.scene), world); };
  // The nonce is minted once per attempt and saved with the world, so retries of that attempt repeat
  // the key while a deliberately new attempt (or a deleted and remade world) gets a fresh one.
  const idem = (world, stage) => createHash('sha256').update(`${world.nonce}/${world.slug}/${world.scene}/${stage}`).digest('hex').slice(0, 40);
  const active = () => [...running.values()];
  const running = new Map();                          // key -> world, for every world mid-pipeline

  function find(slug, sceneId) {
    if (!SAFE.test(slug) || !SAFE.test(sceneId)) return null;
    const story = library.stories.find(s => s.slug === slug);
    const scene = story?.scenes.find(s => s.id === sceneId);
    return scene ? { story, scene } : null;
  }

  const serial = (key, work) => {                     // one step at a time per world
    const next = (locks.get(key) ?? Promise.resolve()).then(work, work);
    locks.set(key, next.catch(() => {}));
    return next;
  };

  async function storeFrame(world, index, frame, label, extra = {}) {
    const dir = dirOf(world.slug, world.scene);
    const stem = `f${String(index).padStart(2, '0')}`;
    const [image, depth] = await Promise.all([atlas.download(frame.imageAsset), atlas.download(frame.depth.depthAsset)]);
    let imageName = `${stem}.png`, bytes = image;
    if (image[0] === 0xff && image[1] === 0xd8) imageName = `${stem}.jpg`;
    if (sharp) { bytes = await sharp(image).webp({ quality: 88 }).toBuffer(); imageName = `${stem}.webp`; }
    await Promise.all([writeFile(path.join(dir, imageName), bytes), writeFile(path.join(dir, `${stem}.exr`), depth)]);
    return {
      label, image: imageName, depth: `${stem}.exr`, camera: frame.camera, ...extra,
      near: index === 0 ? depthStats(depth)?.near ?? null : undefined,      // how close the painting's nearest things are
      // Asset ids let a later step (the splat) reuse these frames without uploading them again.
      assets: { image: frame.imageAsset.assetId, depth: frame.depth.depthAsset.assetId },
    };
  }

  async function step(world) {
    const dir = dirOf(world.slug, world.scene);
    await mkdir(dir, { recursive: true });
    const { story, scene } = find(world.slug, world.scene);

    if (world.stage === 'pose') {
      if (!world.ops.pose) {
        const painting = await readFile(path.join(siteRoot, scene.src));
        const op = await atlas.submit('images2PosedRGBD', {
          frames: [{ imageAsset: { base64: painting.toString('base64') } }], targetResolution: GRID,
        }, { idempotencyKey: idem(world, 'pose') });
        world.ops.pose = op.id;
        return save(world);
      }
      const op = await atlas.getOperation(world.ops.pose);
      if (!op.done) return;
      if (op.error) throw new Error(op.error.message ?? 'Atlas could not read the painting');
      const frame = op.response.frames[0];
      world.frames = [await storeFrame(world, 0, frame, 'origin', { yaw: 0, pitch: 0 })];
      world.home = describeCamera(frame.camera);
      world.stage = 'views';
      log(`[world] ${world.slug}/${world.scene}: depth ready`);
      return save(world);
    }

    if (world.stage === 'views') {
      const origin = world.frames[0];
      if (!world.ops.views) {
        // The ring the cameras stand on is sized to the painting: small where things are close.
        const rig = planRig(origin.camera, { near: origin.near ?? 2, ...(views === 'front' ? { sweep: 80, up: false } : {}) });
        world.rig = rig.map(({ label, yaw, pitch }) => ({ label, yaw, pitch }));
        const op = await atlas.submit('atlasGenerate', {
          contextFrames: [{ imageAsset: { assetId: origin.assets.image }, depth: { depthAsset: { assetId: origin.assets.depth } }, camera: origin.camera }],
          targetCameras: rig.map(view => view.camera),
          prompt: `${scene.title}, a place in the story “${story.title}”. ${STYLE}`,
          returnDepth: true,
        }, { idempotencyKey: idem(world, 'views') });
        world.ops.views = op.id;
        return save(world);
      }
      const op = await atlas.getOperation(world.ops.views);
      if (!op.done) return;
      if (op.error) throw new Error(op.error.message ?? 'Atlas could not paint the surrounding views');
      const generated = op.response.frames ?? [];
      const stored = await Promise.all(generated.map((frame, i) =>
        frame.depth?.depthAsset ? storeFrame(world, i + 1, frame, world.rig[i].label, { yaw: world.rig[i].yaw, pitch: world.rig[i].pitch }) : null));
      world.frames = [world.frames[0], ...stored.filter(Boolean)];
      world.prompt = op.response.promptUsed ?? null;
      world.stage = world.wantSplat ? 'splat' : 'ready';
      log(`[world] ${world.slug}/${world.scene}: ${world.frames.length} views ready`);
      return save(world);
    }

    if (world.stage === 'splat') {
      if (!world.ops.splat) {
        const op = await atlas.submit('posedImages2Splats', {
          posedFrames: world.frames.map(f => ({ imageAsset: { assetId: f.assets.image }, camera: f.camera, depth: { depthAsset: { assetId: f.assets.depth } } })),
          refine: quality === 'refined',
          ...(world.prompt ? { prompt: world.prompt, enhancePrompt: false } : {}),
        }, { idempotencyKey: idem(world, 'splat') });
        world.ops.splat = op.id;
        return save(world);
      }
      const op = await atlas.getOperation(world.ops.splat);
      if (!op.done) return;
      if (op.error) {                                 // the views are still good; only the upgrade failed
        world.splatError = op.error.message ?? 'Splat reconstruction failed';
      } else {
        const asset = op.response.draftSplat ?? Object.values(op.response.refinedSplats ?? {})[0];
        await writeFile(path.join(dir, 'splat.spz'), await atlas.download(asset));
        world.splat = { file: 'splat.spz', quality };
        log(`[world] ${world.slug}/${world.scene}: splat ready`);
      }
      world.wantSplat = false;
      world.stage = 'ready';
      return save(world);
    }
  }

  async function advance(slug, sceneId) {
    const key = `${slug}/${sceneId}`;
    return serial(key, async () => {
      const world = await readJson(fileOf(slug, sceneId));
      if (!world || world.stage === 'ready' || world.stage === 'failed') { running.delete(key); return world; }
      running.set(key, world);
      try {
        await step(world);
      } catch (error) {
        const transient = error instanceof AtlasError && (error.status === 0 || error.status === 429 || error.status >= 500);
        world.retries = (world.retries ?? 0) + 1;
        if (transient && world.retries < 40) {
          log(`[world] ${key}: ${error.message} (will retry)`);
        } else {
          world.failedStage = world.stage;
          world.stage = 'failed';
          world.error = error instanceof AtlasError && error.status === 402
            ? 'The World Labs account is out of credits or has reached its spend limit.'
            : error instanceof AtlasError && error.status === 404
              ? 'This World Labs account does not have access to that Atlas task yet.'
              : String(error.message ?? error).slice(0, 300);
          log(`[world] ${key}: failed at ${world.failedStage}: ${error.message}`);
        }
        await save(world);
      }
      if (world.stage === 'ready' || world.stage === 'failed') running.delete(key);
      return world;
    });
  }

  async function spend() {                            // the only gate between a click and a bill
    const today = new Date().toISOString().slice(0, 10);
    const ledger = (await readJson(ledgerPath)) ?? {};
    if ((ledger[today] ?? 0) >= dailyLimit) return 'Today’s limit for new worlds has been reached. Try again tomorrow.';
    if (active().length >= concurrency) return 'Other worlds are being made right now. Try again in a minute.';
    ledger[today] = (ledger[today] ?? 0) + 1;
    await writeJson(ledgerPath, ledger);
    return null;
  }

  async function start(slug, sceneId, { splat = false } = {}) {
    if (!find(slug, sceneId)) return { error: 'No such scene.', status: 404 };
    const key = `${slug}/${sceneId}`;
    return serial(key, async () => {
      let world = await readJson(fileOf(slug, sceneId));
      const busy = world && !['ready', 'failed'].includes(world.stage);
      if (busy) return { world };
      if (world?.stage === 'ready' && (!splat || world.splat)) return { world };
      const refusal = await spend();
      if (refusal) return { error: refusal, status: 429 };
      if (world?.stage === 'ready' && splat) {
        world.stage = 'splat'; world.wantSplat = true; world.splatError = null; delete world.ops.splat;
        world.attempt = (world.attempt ?? 0) + 1; world.nonce = randomUUID();
      } else {
        const resumeViews = world?.stage === 'failed' && world.failedStage !== 'pose' && world.frames?.length;
        world = {
          version: 1, slug, scene: sceneId, attempt: (world?.attempt ?? 0) + 1, nonce: randomUUID(), createdAt: new Date().toISOString(),
          stage: resumeViews ? 'views' : 'pose', wantSplat: splat, ops: resumeViews ? { pose: world.ops.pose } : {},
          frames: resumeViews ? world.frames.slice(0, 1) : [], home: resumeViews ? world.home : null, splat: null, error: null,
        };
      }
      await save(world);
      running.set(key, world);
      log(`[world] ${key}: started (${world.stage})`);
      return { world, started: true };
    }).then(result => { if (result.started) advance(slug, sceneId); return result; });
  }

  // What the browser is allowed to know about a world.
  function present(world, slug, sceneId) {
    if (!world) return { slug, scene: sceneId, stage: 'none', frames: [] };
    const base = `worlds/${slug}/${sceneId}/`;
    return {
      slug, scene: sceneId, stage: world.stage, error: world.error ?? null, updatedAt: world.updatedAt,
      home: world.home, splat: world.splat ? { src: base + world.splat.file, quality: world.splat.quality } : null,
      splatError: world.splatError ?? null,
      frames: (world.frames ?? []).map(f => ({ label: f.label, yaw: f.yaw, pitch: f.pitch, image: base + f.image, depth: base + f.depth, camera: f.camera })),
    };
  }

  async function status(slug, sceneId) {
    if (!find(slug, sceneId)) return null;
    let world = await readJson(fileOf(slug, sceneId));
    if (world && !['ready', 'failed'].includes(world.stage)) world = await advance(slug, sceneId);
    return present(world, slug, sceneId);
  }

  // Keep unfinished worlds moving even if the visitor who asked has left (and resume after a restart).
  async function resume() {
    const { readdir } = await import('node:fs/promises');
    for (const slug of await readdir(root).catch(() => [])) {
      if (!SAFE.test(slug)) continue;
      for (const scene of await readdir(path.join(root, slug)).catch(() => [])) {
        const world = await readJson(fileOf(slug, scene));
        if (world && !['ready', 'failed'].includes(world.stage)) running.set(`${slug}/${scene}`, world);
      }
    }
    const timer = setInterval(() => { for (const world of active()) advance(world.slug, world.scene); }, 4000);
    timer.unref();
  }

  // Every finished world, so the library can mark the books that have one.
  async function list() {
    const { readdir } = await import('node:fs/promises');
    const out = [];
    for (const slug of await readdir(root).catch(() => [])) {
      if (!SAFE.test(slug)) continue;
      for (const scene of await readdir(path.join(root, slug)).catch(() => [])) {
        const world = await readJson(fileOf(slug, scene));
        if (world?.stage === 'ready' && world.frames?.length > 1) out.push({ slug, scene, splat: Boolean(world.splat) });
      }
    }
    return out;
  }

  return { start, status, resume, present, find, active, list };
}
