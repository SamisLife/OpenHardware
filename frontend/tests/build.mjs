/* ============================================================================
   build.mjs — the loopback build client contract.

       node frontend/tests/build.mjs
   ========================================================================== */

import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const JS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'js');
const { createBuildClient } = await import(pathToFileURL(path.join(JS, 'link/build.js')).href);

let pass = 0, fail = 0;
const ok = (name, condition, detail = '') => {
  if (condition) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const calls = [];
let polls = 0;
const response = (value, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => value,
});
const fetchImpl = async (url, options = {}) => {
  calls.push({ url, options });
  const pathname = new URL(url).pathname;
  if (pathname === '/health') return response({ busy: false, docker: true });
  if (pathname === '/app') return response({ api: 'header', files: { 'app.c': 'source' } });
  if (pathname === '/build' && options.method === 'POST') return response({ id: 'b1', status: 'building' }, 202);
  if (pathname === '/builds') return response({ builds: [{ id: 'b1', status: 'built' }] });
  if (pathname === '/build/b1') {
    polls++;
    return response(polls < 2
      ? { id: 'b1', status: 'building' }
      : { id: 'b1', status: 'built', image: { elf_sha8: '1234abcd' } });
  }
  return response({ error: 'missing' }, 404);
};

const client = createBuildClient({ base: 'http://127.0.0.1:8001/', fetchImpl });
ok('the base URL is normalised', client.base === 'http://127.0.0.1:8001');
ok('health is returned as data', (await client.health()).docker === true);
ok('the application source set is returned', (await client.app()).files['app.c'] === 'source');

const started = await client.start({ 'app.c': 'source' }, 'candidate');
ok('a build starts with the complete source object', started.id === 'b1');
const posted = JSON.parse(calls.find(call => new URL(call.url).pathname === '/build').options.body);
ok('the note and source set cross the boundary', posted.note === 'candidate' && posted.files['app.c'] === 'source');

const built = await client.waitFor('b1', { untilMs: 2500 });
ok('polling stops when the daemon finishes', built.status === 'built' && built.image.elf_sha8 === '1234abcd');
ok('omitting an id returns the latest build', (await client.get()).id === 'b1');

const offline = createBuildClient({ fetchImpl: async () => { throw new Error('offline'); } });
const failure = await offline.health();
ok('network failures stay structured', failure.ok === false && failure.error === 'offline');

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
