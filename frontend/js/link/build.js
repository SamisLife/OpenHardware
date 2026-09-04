/* ============================================================================
   build.js — the loopback application compiler.
   ----------------------------------------------------------------------------
   The daemon is deliberately not an MCP server. WebMCP calls execute inside
   the tab that already owns the board, and this client gives that tab one
   narrow path to the developer's local compiler. Every failure is returned as
   data so an agent receives the build id and diagnostics instead of a rejected
   tool call with no recovery path.
   ========================================================================== */

const DEFAULT_BASE = 'http://127.0.0.1:8001';

export function createBuildClient({ base = DEFAULT_BASE, fetchImpl = fetch } = {}) {
  const root = String(base).replace(/\/+$/, '');

  async function request(path, options = {}) {
    const url = `${root}${path}`;
    try {
      const response = await fetchImpl(url, {
        cache: 'no-store',
        ...options,
        headers: {
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          ...(options.headers || {}),
        },
      });
      let value;
      try { value = await response.json(); }
      catch { value = null; }
      if (!response.ok) {
        return { ok: false, error: value?.error || `HTTP ${response.status}`, status: response.status };
      }
      return value && typeof value === 'object' ? { ok: true, ...value } : { ok: true, value };
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  }

  const client = {
    base: root,
    artifactBase: id => `/firmware/artifacts/${encodeURIComponent(id)}/`,
    baselineBase: '/firmware/baseline/',
    health: () => request('/health'),
    app: () => request('/app'),
    baseline: () => request('/baseline'),
    list: () => request('/builds'),
    source: id => request(`/source/${encodeURIComponent(id)}`),
    /* Deleting a candidate destroys the only copy of it. Offered to a person
       through the page's own menu and to nothing else; there is no tool for
       it. */
    remove: id => request(`/build/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    start(files, note = '', clean = false) {
      return request('/build', {
        method: 'POST',
        body: JSON.stringify({ files, note, clean }),
      });
    },
    async get(id) {
      if (id) return request(`/build/${encodeURIComponent(id)}`);
      const result = await request('/builds');
      if (!result.ok) return result;
      const latest = Array.isArray(result.builds) ? result.builds[0] : null;
      return latest ? { ok: true, ...latest } : { ok: false, error: 'no builds yet' };
    },
    async waitFor(id, { untilMs = 60000, signal } = {}) {
      const deadline = Date.now() + Math.max(0, untilMs);
      let last = await client.get(id);
      while (last.ok && last.status === 'building' && Date.now() < deadline) {
        const remaining = deadline - Date.now();
        const waited = await delay(Math.min(2000, Math.max(0, remaining)), signal);
        if (!waited) return { ok: false, error: 'build wait cancelled', id };
        last = await client.get(id);
      }
      return last;
    },
  };

  return client;
}

function delay(ms, signal) {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve(true);
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve(false);
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}
