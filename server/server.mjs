// Story Animation Machine server: serves the site and turns paintings into worlds on request.
// Zero dependencies (Node 22+). Run with:  node --env-file-if-exists=.env server/server.mjs
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAtlas } from './atlas.mjs';
import { createWorlds } from './worlds.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(ROOT, 'site');
const WORLDS = path.resolve(ROOT, process.env.WORLDS_DIR ?? 'worlds');
const PORT = Number(process.env.PORT ?? 8787);
const POLICY = (process.env.WORLD_GENERATION ?? 'local').toLowerCase();       // open | local | off
const QUALITY = (process.env.WORLD_QUALITY ?? 'draft').toLowerCase();         // draft | refined
const SPLATS = (process.env.WORLD_SPLATS ?? 'off').toLowerCase() === 'on';
// Opening a book starts its world without a second click (within the limits below).
const AUTOSTART = (process.env.WORLD_AUTOSTART ?? 'on').toLowerCase() !== 'off';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webp': 'image/webp', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.exr': 'application/octet-stream',
  '.spz': 'application/octet-stream', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

let library;
try {
  library = JSON.parse(await readFile(path.join(SITE, 'data', 'library.json'), 'utf8'));
} catch {
  console.error('site/data/library.json is missing. Build it first:  python scripts/build_data.py');
  process.exit(1);
}
await mkdir(WORLDS, { recursive: true });

const atlas = process.env.WLT_API_KEY
  ? createAtlas({ apiKey: process.env.WLT_API_KEY, baseUrl: process.env.WLT_API_BASE_URL || undefined })
  : null;
const worlds = atlas ? createWorlds({
  atlas, root: WORLDS, siteRoot: SITE, library, quality: QUALITY === 'refined' ? 'refined' : 'draft',
  views: process.env.WORLD_VIEWS === 'front' ? 'front' : 'surround',
  dailyLimit: Number(process.env.WORLD_DAILY_LIMIT ?? 20), concurrency: Number(process.env.WORLD_CONCURRENCY ?? 2),
}) : null;
await worlds?.resume();

const isLocal = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) && !req.headers['x-forwarded-for'];
const mayGenerate = req => Boolean(worlds) && (POLICY === 'open' || (POLICY === 'local' && isLocal(req)));

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(payload);
}

async function serveFile(req, res, base, relative, cache) {
  const file = path.resolve(base, '.' + path.posix.normalize('/' + relative));
  if (file !== base && !file.startsWith(base + path.sep)) return send(res, 403, { error: 'Forbidden' });
  let info;
  try { info = await stat(file); } catch { info = null; }
  if (info?.isDirectory()) return serveFile(req, res, base, path.posix.join(relative, 'index.html'), cache);
  if (!info) return send(res, 404, { error: 'Not found' });
  const etag = `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  const headers = {
    'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': info.size, 'ETag': etag, 'Cache-Control': cache,
  };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);

    if (pathname === '/api/config') {
      return send(res, 200, { worlds: Boolean(worlds), canGenerate: mayGenerate(req), autostart: AUTOSTART && mayGenerate(req), splats: SPLATS && mayGenerate(req), quality: QUALITY });
    }
    if (pathname === '/api/worlds') return send(res, 200, { worlds: worlds ? await worlds.list() : [] });
    const match = pathname.match(/^\/api\/worlds\/([a-z0-9-]+)\/([a-z0-9-]+)(\/splat)?$/);
    if (match) {
      const [, slug, scene, splat] = match;
      if (!worlds) {
        return send(res, req.method === 'GET' ? 200 : 503, req.method === 'GET'
          ? { slug, scene, stage: 'none', frames: [] } : { error: 'No World Labs key is configured on this server.' });
      }
      if (req.method === 'GET' && !splat) {
        const world = await worlds.status(slug, scene);
        return world ? send(res, 200, world) : send(res, 404, { error: 'No such scene.' });
      }
      if (req.method === 'POST') {
        // A cross-site page must not be able to spend credits through a visitor's browser.
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) return send(res, 403, { error: 'Cross-site requests are not allowed.' });
        if (!mayGenerate(req)) return send(res, 403, { error: 'Creating worlds is switched off here.' });
        if (splat && !SPLATS) return send(res, 403, { error: 'Splat worlds are switched off here.' });
        const result = await worlds.start(slug, scene, { splat: Boolean(splat) });
        if (result.error) return send(res, result.status ?? 400, { error: result.error });
        return send(res, 202, worlds.present(result.world, slug, scene));
      }
      return send(res, 405, { error: 'Method not allowed' });
    }
    if (pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });

    if (pathname.startsWith('/worlds/')) {
      const relative = pathname.slice('/worlds/'.length);
      if (relative.startsWith('_') || relative.endsWith('.tmp')) return send(res, 404, { error: 'Not found' });
      // world.json holds operation and asset ids; the browser gets the API's public view instead.
      if (relative.endsWith('world.json')) return send(res, 404, { error: 'Not found' });
      return serveFile(req, res, WORLDS, relative, 'public, max-age=3600');
    }
    const cache = pathname.startsWith('/media/') || pathname.startsWith('/vendor/') ? 'public, max-age=3600' : 'no-cache';
    return serveFile(req, res, SITE, pathname, cache);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) send(res, 500, { error: 'Something went wrong on the server.' });
    else res.destroy();
  }
});

server.listen(PORT, () => {
  const mode = !worlds ? 'no WLT_API_KEY: existing worlds only' : `generation ${POLICY}, ${QUALITY}${SPLATS ? ', splats on' : ''}`;
  console.log(`Story Animation Machine  http://localhost:${PORT}/   (${library.stories.length} stories; ${mode})`);
});
