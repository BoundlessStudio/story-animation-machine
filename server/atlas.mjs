// Minimal client for the World Labs Atlas (Marble 2 beta) Developer API.
// Zero dependencies; uses global fetch (Node 22+). The key never leaves the server.
import { randomUUID } from 'node:crypto';

export class AtlasError extends Error {
  constructor(message, { status = 0, code = null, body = null, retryAfter = null } = {}) {
    super(message);
    this.name = 'AtlasError';
    this.status = status; this.code = code; this.body = body; this.retryAfter = retryAfter;
  }
}

export function createAtlas({ apiKey, baseUrl = 'https://api.atlas-beta.worldlabs.ai/api/v2', userAgent = 'story-animation-machine/0.1' } = {}) {
  if (!apiKey) throw new AtlasError('WLT_API_KEY is not set');
  const root = baseUrl.replace(/\/+$/, '');

  async function call(method, path, { body, idempotencyKey, timeoutMs = 60_000 } = {}) {
    const headers = { 'WLT-Api-Key': apiKey, 'User-Agent': userAgent };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    let res;
    try {
      res = await fetch(root + path, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      throw new AtlasError(`Atlas network error: ${cause?.message ?? cause}`, { status: 0 });
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
    if (!res.ok) {
      const detail = json?.message ?? json?.detail ?? json?.error?.message ?? text.slice(0, 400);
      throw new AtlasError(`Atlas ${method} ${path} -> ${res.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`, {
        status: res.status, code: json?.code ?? json?.error?.code ?? null, body: json ?? text,
        retryAfter: Number(res.headers.get('retry-after')) || null,
      });
    }
    return json;
  }

  // Submit a task. Network failures, 429 and 5xx are retried with the SAME idempotency key so a
  // retry can never start (and bill) a second task.
  async function submit(task, body, { idempotencyKey = randomUUID() } = {}) {
    let lastError;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        return await call('POST', `/tasks:${task}`, { body, idempotencyKey, timeoutMs: 120_000 });
      } catch (error) {
        lastError = error;
        const retryable = error instanceof AtlasError && (error.status === 0 || error.status === 429 || error.status >= 502);
        if (!retryable || (error.retryAfter && error.retryAfter > 10)) throw error;
        await new Promise(r => setTimeout(r, Math.max((error.retryAfter ?? 0) * 1000, 800 * 2 ** attempt + Math.random() * 400)));
      }
    }
    throw lastError;
  }

  return {
    submit,
    health: () => fetch(root + '/health', { signal: AbortSignal.timeout(15_000) }).then(r => r.ok),
    getOperation: id => call('GET', `/operations/${encodeURIComponent(id)}`),
    listOperations: (pageSize = 20) => call('GET', `/operations?pageSize=${pageSize}`),
    cancelOperation: (id, reason) => call('POST', `/operations/${encodeURIComponent(id)}:cancel`, { body: { reason } }),
    createReadUrl: assetId => call('POST', `/assets/${encodeURIComponent(assetId)}:createReadUrl`, { body: {} }),
    // Output URLs expire after 24h; an assetId can always mint a fresh one.
    async download(asset) {
      const tryFetch = async url => {
        const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
        if (!res.ok) throw new AtlasError(`Asset download failed: ${res.status}`, { status: res.status });
        return Buffer.from(await res.arrayBuffer());
      };
      if (asset.url) {
        try { return await tryFetch(asset.url); } catch (error) { if (!asset.assetId) throw error; }
      }
      const fresh = await call('POST', `/assets/${encodeURIComponent(asset.assetId)}:createReadUrl`, { body: {} });
      return tryFetch(fresh.readUrl ?? fresh.url);
    },
  };
}
