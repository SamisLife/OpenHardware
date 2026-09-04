/* ============================================================================
   webmcp.mjs — the page as a toolbelt.

       node frontend/tests/webmcp.mjs

   Most of what is checked is what the tools refuse to do and what they admit
   to. A write tool that exists while no board is linked is a lever with
   nothing on the end. A result that does not say whether it came from a
   simulation is a number the model will believe. A gate an agent can pass on
   its own is not a gate. And an experiment that reports figures for a frame
   size the board never ran is the one lie the whole project is built to
   refuse — so run_experiment is driven against the simulated board, through
   the real feed, with a real cfg round trip.
   ========================================================================== */

import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const JS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'js');
const load = rel => import(pathToFileURL(path.join(JS, rel)).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  — ' + extra : ''}`); }
};

globalThis.requestAnimationFrame = fn => setTimeout(() => fn(0), 0);
const wait = ms => new Promise(r => setTimeout(r, ms));

const st = await load('state.js');
const { mountTools, summarize, configEffector, flashBuild } = await load('webmcp.js');
const { approvePending, holdPending, pendingGate } = await load('builder/gate.js');
const { SimBoard } = await load('link/sim.js');
const { createFeed } = await load('link/feed.js');
const startBuild = null;

/**
 * document.modelContext, as the standard describes it and as the tests need
 * it: registerTool with an unregistering signal, getTools, and a toolchange
 * event whenever the list moves.
 */
function fakeModelContext() {
  const tools = new Map();
  const listeners = new Set();
  const fire = () => { for (const fn of listeners) fn({ type: 'toolchange' }); };
  return {
    changes: 0,
    registerTool(tool, { signal } = {}) {
      tools.set(tool.name, tool);
      this.changes++; fire();
      signal?.addEventListener('abort', () => { tools.delete(tool.name); this.changes++; fire(); });
    },
    getTools() { return [...tools.values()]; },
    addEventListener(type, fn) { if (type === 'toolchange') listeners.add(fn); },
    get(name) { return tools.get(name); },
    names() { return [...tools.keys()].sort(); },
  };
}

/* ------------------------------------------------------------------------ */
/* the telemetry summary — numbers, never samples                            */
/* ------------------------------------------------------------------------ */

{
  const t0 = 1_000_000;
  const buf = [];
  for (let i = 0; i < 10; i++) {
    /* tempC climbs exactly 0.5 °C per second; fps is absent throughout. */
    buf.push({ t: t0 + i * 250, tempC: 40 + i * 0.125, heapFree: 200000 - i * 10, psramLargestBlock: 3e6 });
  }
  buf.push({ t: t0 + 2600, gap: true, label: 'NO TELEMETRY' });

  const s = summarize(buf, { windowMs: 10000, now: t0 + 3000 });
  ok('samples are counted, and gaps are counted separately', s.samples === 10 && s.gaps === 1,
     `${s.samples} samples, ${s.gaps} gaps`);
  /* The mean is rounded to three places on the way out, so a model is not
     handed fifteen digits of false precision from a sensor that steps in
     tenths. The comparison allows for that. */
  ok('min, max and mean are what the samples say',
     s.fields.tempC.min === 40 && s.fields.tempC.max === 41.125 && Math.abs(s.fields.tempC.mean - 40.5625) < 1e-3,
     JSON.stringify(s.fields.tempC));
  ok('slope is in units per second', Math.abs(s.fields.tempC.slopePerS - 0.5) < 1e-6, s.fields.tempC.slopePerS);
  ok('a field never measured is null, not zero', s.fields.fps === null);
  ok('raw samples are not in the result', !('samples' in s.fields) && !Array.isArray(s.fields.tempC));

  const narrow = summarize(buf, { windowMs: 600, now: t0 + 2250 });
  ok('the window is honoured', narrow.samples === 3, `${narrow.samples} in a 600 ms window`);
  ok('a single sample has no slope', summarize(buf.slice(0, 1), { windowMs: 10000, now: t0 + 1 }).fields.tempC.slopePerS === null);
}

/* ------------------------------------------------------------------------ */
/* a simulated board on the real feed                                        */
/* ------------------------------------------------------------------------ */

const board = new SimBoard('');
const feed = createFeed({ source: 'sim' });
const link = board.attach({ onFrame: f => feed.handleFrame(f), onText: () => {} });

let flashed = 0;
const fx = {
  setCamera: on => link.send({ t: 'cam', on }),
  setConfig: configEffector(obj => link.send(obj)),
  flash: async () => { flashed++; return { flashDone: true, phase: 'done', fault: null }; },
  build: {
    get: async id => ({ ok: true, id, status: 'built', app: { name: 'test', version: '1.0' }, image: { artifact: `/firmware/artifacts/${id}/`, activation_protocol: 2 } }),
    baseline: async () => ({ ok: true, version: '0.14.0', app: { name: 'default', version: '1.0' } }),
    artifactBase: id => `/firmware/artifacts/${id}/`,
    baselineBase: '/firmware/baseline/',
    source: async id => (id === 'gone'
      ? { ok: false, error: 'artifact source not found' }
      : { ok: true, files: { 'app.c': `/* ${id} */ void app_setup(void) {}` } }),
  },
  manifest: async () => ({ version: '0.12.0', project: 'openhardware_harness', elf_sha8: 'abc', total_bytes: 880384, parts: [] }),
  source: () => 'sim',
  /* The page's scan: ask the board, wait for the feed to fold the answer in. */
  scan: async opts => {
    const before = st.state.wiring.scan;
    await link.send({ t: 'scan', ...(opts || {}) });
    const answered = await st.waitForState(s => s.wiring.scan !== before, { timeoutMs: 2000 });
    return answered ? st.state.wiring.scan : { ok: false, error: 'no answer' };
  },
  /* A stand-in for the session's guide: one phase, one next step. */
  bringUp: () => ({ phase: 'idle', next: 'Press "Connect a board" and choose the port.',
                    waitingOn: { who: 'person', what: 'Press "Connect a board" and choose the port.', options: [] },
                    rungs: [], board: {}, fault: null, howItWorks: ['one'] }),
};

const mc = fakeModelContext();
const mounted = mountTools({ fx, modelContext: mc, quietMs: 200 });
const call = async (name, input = {}, signal) => {
  const tool = mc.get(name);
  if (!tool) throw new Error(`no tool named ${name}`);
  return tool.execute(input, { signal });
};

const READ = ['get_wiring', 'scan_bus', 'capture_frame', 'get_app_source', 'get_board', 'get_bring_up', 'get_build', 'get_images', 'get_learned_limits', 'get_telemetry_summary', 'get_wire_tail', 'get_work_order'];
const PAGE = ['build_firmware', 'record_attempt'];
const WRITE = ['flash_image', 'record_limit', 'restore_baseline', 'run_experiment', 'set_camera', 'set_camera_config', 'watch_for'];

/* ------------------------------------------------------------------------ */
/* registration follows the link                                             */
/* ------------------------------------------------------------------------ */

{
  ok('the registry was found', mounted.available === true);

  /* Asked before the first beat has marked the link, so the answer is the
     one a caller gets on a page nobody has connected yet. */
  const early = await call('get_board');
  ok('an unlinked get_board says which step the page waits on and what to do',
     early.link === 'offline' && early.bringUp?.phase === 'idle' && /Connect a board/.test(early.bringUp?.next || ''),
     JSON.stringify(early.bringUp));
  const refused = await call('capture_frame');
  ok('and a refusal for want of a board says what a person must press',
     refused.ok === false && refused.error === 'no board is linked' && /Connect a board/.test(refused.next || ''),
     JSON.stringify(refused));
  const g = await call('get_bring_up');
  ok('get_bring_up hands over the whole guide', g.ok === true && g.phase === 'idle' && g.waitingOn?.who === 'person' && Array.isArray(g.howItWorks));
  ok('read tools are registered before any board is linked',
     READ.every(n => mc.names().includes(n)), mc.names().join(','));
  ok('page-only tools are also registered without a board', PAGE.every(n => mc.names().includes(n)), mc.names().join(','));
  ok('and no board write tool is', !WRITE.some(n => mc.names().includes(n)), mc.names().join(','));
  ok('every read tool says so', READ.every(n => mc.get(n).annotations?.readOnlyHint === true));
  ok('page-only tools admit they mutate local state', PAGE.every(n => !mc.get(n).annotations?.readOnlyHint));

  /* The board announces itself; the feed marks the link; the writes appear. */
  await wait(400);
  st.flushNow();
  ok('once a board is linked the write tools appear', WRITE.every(n => mc.names().includes(n)),
     mc.names().join(','));
  ok('and none of them claims to be read-only', WRITE.every(n => !mc.get(n).annotations?.readOnlyHint));
  ok('every tool carries a short title for the panel',
     [...READ, ...PAGE, ...WRITE].every(n => typeof mc.get(n).title === 'string' && mc.get(n).title.length > 0));
  ok('and the page records what is registered, for the panel',
     st.state.ui.agent.tools.filter(t => t.registered).length === READ.length + PAGE.length + WRITE.length,
     JSON.stringify(st.state.ui.agent.tools.map(t => `${t.name}:${t.registered}`)));
  ok('the registry was told each time the list moved', mc.changes >= READ.length + WRITE.length, mc.changes);

  const before = mc.changes;
  st.applyDevice({ link: 'lost' });
  st.flushNow();
  await wait(10);
  ok('losing the link withdraws every write tool', !WRITE.some(n => mc.names().includes(n)), mc.names().join(','));
  ok('and leaves the read and page tools', [...READ, ...PAGE].every(n => mc.names().includes(n)));
  ok('and the panel is told the writes are withdrawn',
     st.state.ui.agent.tools.filter(t => t.registered).length === READ.length + PAGE.length);
  ok('which the registry was told about', mc.changes > before);

  st.applyDevice({ link: 'linked' });
  st.flushNow();
  await wait(10);
  ok('relinking registers them again', WRITE.every(n => mc.names().includes(n)));
}

/* ------------------------------------------------------------------------ */
/* every result says where it came from                                     */
/* ------------------------------------------------------------------------ */

{
  const r = await call('get_board');
  ok('a result is an object for the registry to serialise once, not a string it would serialise twice',
     r !== null && typeof r === 'object', typeof r);
  ok('a result carries the source', r.source === 'sim', r.source);
  ok('and the link state', r.link === 'linked', r.link);
  ok('the board is identified from what it reported', r.device.board === 'Simulated board', r.device.board);
  ok('and the bootloader\'s view of the image travels with it', r.device.ota === 'factory' && r.device.aborted === null,
     JSON.stringify([r.device.ota, r.device.aborted]));
  ok('a linked board has no bring-up left to describe', r.bringUp === null);
  ok('and the ladder is in the reply with the cost of each size',
     r.ladder.length === 10 && r.ladder.every(s => s.framebufferBytes > 0));

  const s = await call('get_telemetry_summary', { windowMs: 2000 });
  ok('the summary tool reports the window it used', s.windowMs === 2000 && s.samples > 0, `${s.samples} samples`);
  ok('and is labelled simulated', s.source === 'sim');
}

/* ------------------------------------------------------------------------ */
/* run_experiment, for real, against the sim                                 */
/* ------------------------------------------------------------------------ */

{
  /* The camera comes up ~2 s after attach; wait for it, then leave it
     streaming so the experiment does not have to wait for a first frame. */
  await st.waitForState(s => s.peripherals.camera?.state === 'ok', { timeoutMs: 6000 });
  const on = await call('set_camera', { on: true });
  ok('the camera is switched on and the board confirms it', on.ok && on.streaming === true, JSON.stringify(on));

  const b = await call('get_board');
  ok('the simulated board advertises runtime config', b.peripherals.cfgSupported === true);
  ok('and says what it is running', b.peripherals.config?.size === 'VGA', JSON.stringify(b.peripherals.config));

  const small = await call('run_experiment', { size: 'QVGA', quality: 12, soakMs: 700 });
  ok('an experiment on a supported board applies the config', small.ok && small.applied === true, JSON.stringify(small));
  ok('and the board confirmed the size that was asked for', st.state.peripherals.config?.size === 'QVGA');
  ok('the frame rate measured is the small size\'s, not the old one\'s',
     small.fps && small.fps.mean > 20, `${small.fps?.mean} fps at ${small.measuredSize}`);
  ok('it recorded an attempt in the same log as the loop',
     st.state.attempts.length === 1 && st.state.attempts[0].by === 'agent');
  const A1 = st.state.attempts[0];
  const step = (a, id) => a.steps.find(s => s.id === id);
  ok('the apply step is real, not simulated', step(A1, 'apply')?.status === 'pass' && step(A1, 'apply')?.sim !== true,
     JSON.stringify(step(A1, 'apply')));
  ok('and the work order it opened says who is driving', /agent/i.test(st.state.workOrder?.rehearsal || ''));

  const big = await call('run_experiment', { size: 'UXGA', soakMs: 700 });
  ok('a large size measures a lower rate', big.ok && big.fps && big.fps.mean < 3, `${big.fps?.mean} fps`);
  ok('and less contiguous PSRAM than the small one',
     big.psramLargestBlock.mean < small.psramLargestBlock.mean,
     `${big.psramLargestBlock.mean} vs ${small.psramLargestBlock.mean}`);

  /* The abort path. Cancelled mid-soak, it says so and leaves an abandoned
     attempt rather than a passed one. */
  const ctl = new AbortController();
  const p = call('run_experiment', { size: 'VGA', soakMs: 5000 }, ctl.signal);
  await wait(150);
  ctl.abort();
  const cancelled = await p;
  ok('cancelling an experiment returns aborted', cancelled.ok === false && cancelled.aborted === true, JSON.stringify(cancelled));
  ok('and the attempt is recorded as abandoned, not passed',
     st.state.attempts.find(a => a.n === cancelled.attempt)?.status === 'abandoned');

  /* A board that cannot take a config. The numbers must describe what it is
     running — VGA, which the cancelled experiment applied before it was cut
     short, exactly as its reply said — and the reply must say the config was
     not applied. QQVGA would have measured at the 30 fps ceiling. */
  const runningBefore = st.state.peripherals.config?.size;
  st.applyPeripherals({ cfg: false });
  const noCfg = await call('run_experiment', { size: 'QQVGA', soakMs: 600 });
  ok('without cfg support the config is reported as not applied', noCfg.ok && noCfg.applied === false, JSON.stringify(noCfg));
  ok('and the numbers are the running configuration\'s, not the requested one\'s',
     noCfg.fps && noCfg.fps.mean < 15 && st.state.peripherals.config?.size === runningBefore,
     `${noCfg.fps?.mean} fps, board still on ${st.state.peripherals.config?.size}`);
  const An = st.state.attempts.find(a => a.n === noCfg.attempt);
  ok('the apply step is marked as not having happened',
     step(An, 'apply')?.sim === true && step(An, 'apply')?.status === 'skipped');
  st.applyPeripherals({ cfg: true });

  const bad = await call('set_camera_config', { size: 'HUGE' });
  ok('an unknown size is refused with the ladder', bad.ok === false && /ladder/.test(bad.error), bad.error);
}

/* ------------------------------------------------------------------------ */
/* watch_for                                                                 */
/* ------------------------------------------------------------------------ */

{
  const t0 = Date.now();
  const r = await call('watch_for', { field: 'tempC', op: '>', value: 999, timeoutMs: 200 });
  ok('a condition that never comes true times out', r.matched === false && r.reason === 'timeout', JSON.stringify(r));
  ok('after about as long as it was told to wait', Date.now() - t0 >= 190 && Date.now() - t0 < 1500);
  ok('and reports the value it last saw', Number.isFinite(r.value));

  const ctl = new AbortController();
  const p = call('watch_for', { field: 'tempC', op: '>', value: 999, timeoutMs: 5000 }, ctl.signal);
  await wait(60);
  ctl.abort();
  const a = await p;
  ok('cancelling a wait returns aborted, not timeout', a.reason === 'aborted' && a.matched === false, JSON.stringify(a));

  const now = await call('watch_for', { link: 'linked', timeoutMs: 500 });
  ok('a condition already true returns at once', now.matched === true && now.waitedMs < 100, JSON.stringify(now));

  const nonsense = await call('watch_for', { field: 'tempC', timeoutMs: 100 });
  ok('an incomplete condition is refused', nonsense.ok === false);
}

/* ------------------------------------------------------------------------ */
/* the gate — nothing is written until a person says so                      */
/* ------------------------------------------------------------------------ */

{
  const p = call('flash_image', { buildId: 'b1' });
  await wait(20);
  ok('flash_image waits on a gate', pendingGate() !== null && st.state.gate?.state === 'pending');
  ok('and names the agent as the one asking', st.state.gate?.requestedBy === 'agent');
  ok('nothing has been written while it waits', flashed === 0);

  holdPending();
  const held = await p;
  ok('Hold refuses it', held.ok === false && held.refused === 'held', JSON.stringify(held));
  ok('and still nothing was written', flashed === 0);
  ok('the gate is cleared', pendingGate() === null && st.state.gate === null);

  const p2 = call('flash_image', { buildId: 'b1' });
  await wait(20);
  const p3 = call('restore_baseline', {});
  const busy = await p3;
  ok('a second write while one is pending is refused as busy', busy.ok === false && busy.refused === 'busy', JSON.stringify(busy));

  approvePending();
  const done = await p2;
  ok('Approve lets it through', done.ok === true && done.approvedBy === 'operator', JSON.stringify(done));
  ok('and the board was written exactly once', flashed === 1);

  const ctl = new AbortController();
  const before = flashed;
  const p4 = call('restore_baseline', {}, ctl.signal);
  await wait(20);
  ctl.abort();
  const gone = await p4;
  ok('an agent that cancels while waiting gets cancelled, not approval',
     gone.ok === false && gone.refused === 'cancelled' && flashed === before, JSON.stringify(gone));

  ok('approve and hold are not tools', !mc.names().some(n => /approve|hold/i.test(n)));
}

/* ------------------------------------------------------------------------ */
/* the Flash button and the tool are one path                               */
/* ------------------------------------------------------------------------ */

{
  /* The Images-panel Flash button calls flashBuild with requestedBy operator.
     It must reach the same gate, mark the same in-flight flag, and leave an
     attempt in the same build log — so a human flash is as visible and as
     safe as an agent's. */
  st.state.attempts = [];
  const before = flashed;
  const p = flashBuild(fx, 'human1', { requestedBy: 'operator' });
  await wait(20);
  ok('a human flash still waits on the gate', pendingGate() !== null && st.state.gate?.state === 'pending');
  ok('and the gate names the operator, not an agent', st.state.gate?.requestedBy === 'operator');
  ok('the flash is marked in flight while it waits', st.state.ui.flashing?.buildId === 'human1');
  ok('an attempt is opened in the build log for it',
     st.state.attempts.some(a => a.buildId === 'human1' && a.by === 'operator'));
  ok('nothing is written before approval', flashed === before);

  approvePending();
  const done = await p;
  ok('approve writes it through the same flash path', done.ok === true && flashed === before + 1, JSON.stringify(done));
  ok('the in-flight flag is cleared afterwards', st.state.ui.flashing === null);
  ok('and the attempt records the outcome', st.state.attempts.find(a => a.buildId === 'human1')?.status === 'passed');
}

{
  /* The row has to be able to say how it ended, so the flash records that
     rather than leaving somebody to read it off a tag that describes an
     image. A success and a failure are both recorded, and the failure keeps
     its reason. */
  st.state.attempts = [];
  st.applyUi({ lastFlash: null });
  const good = { ...fx, flash: async () => ({ flashDone: true, phase: 'done', fault: null }) };
  const p = flashBuild(good, 'ok1', { requestedBy: 'operator' });
  await wait(20);
  ok('a flash in flight is marked before anything is written',
     st.state.ui.flashing?.buildId === 'ok1' && st.state.ui.lastFlash === null);
  approvePending();
  await p;
  ok('a flash that lands records SUCCESS for that build',
     st.state.ui.lastFlash?.buildId === 'ok1' && st.state.ui.lastFlash?.ok === true,
     JSON.stringify(st.state.ui.lastFlash));

  const bad = { ...fx, flash: async () => ({ flashDone: true, phase: 'fault',
    fault: { code: 'rolled_back', raw: 'ota_0 was abandoned by the bootloader' } }) };
  const p2 = flashBuild(bad, 'bad1', { requestedBy: 'operator' });
  await wait(20);
  ok('and the previous verdict is cleared while the next one runs',
     st.state.ui.lastFlash === null, JSON.stringify(st.state.ui.lastFlash));
  approvePending();
  await p2;
  ok('a flash that fails records FAIL with what went wrong',
     st.state.ui.lastFlash?.ok === false && /abandoned/.test(st.state.ui.lastFlash?.reason || ''),
     JSON.stringify(st.state.ui.lastFlash));
  ok('and nothing is left marked in flight afterwards', st.state.ui.flashing === null);
}

{
  /* Only one flash at a time, whichever asked: a second while one is in flight
     is refused as busy without touching the board. */
  st.applyUi({ flashing: { buildId: 'other' } });
  const busy = await flashBuild(fx, 'human2', { requestedBy: 'operator' });
  ok('a flash while one is already running is refused as busy',
     busy.ok === false && busy.refused === 'busy', JSON.stringify(busy));
  const agentBusy = await call('flash_image', { buildId: 'human2' });
  ok('and the tool refuses it too, one path for both', agentBusy.refused === 'busy');
  st.applyUi({ flashing: null });
}

{
  /* Reading the code before approving it. The agent gets the exact source the
     candidate was compiled from, addressed by build id — not the draft, which
     has moved on since. */
  const src = await call('get_app_source', { buildId: 'b7' });
  ok('a build id reads that build’s stored source',
     src.ok === true && src.buildId === 'b7' && /b7/.test(src.files['app.c']), JSON.stringify(src));
  ok('and it is that source alone, with no draft beside it to quote by mistake',
     src.files !== undefined && src.baseline === undefined && src.api === undefined);

  const missing = await call('get_app_source', { buildId: 'gone' });
  ok('a build with no stored source is an error, never an empty listing',
     missing.ok === false && !!missing.error, JSON.stringify(missing));

  ok('flash_image tells the model to read the code first',
     /get_app_source/.test(mc.get('flash_image').description)
     && /Review source/.test(mc.get('flash_image').description));

  /* The gate carries the build id, which is what lets the page put that
     build’s source under the button that writes it. */
  st.state.attempts = [];
  const p = flashBuild(fx, 'b7', { requestedBy: 'agent' });
  await wait(20);
  ok('the pending gate names the build it would write', st.state.gate?.buildId === 'b7');
  ok('and its reason points at the source', /Review source/.test(st.state.gate?.rationale || ''));
  holdPending();
  await p;
}

{
  /* Deleting a build is a person’s doing, never a tool’s: an agent that
     could delete what it just built could erase what it flashed. */
  ok('no tool deletes a build', !mc.names().some(n => /delete|remove|discard/i.test(n)));
}

{
  /* A build that is not a flashable success is refused before any gate. */
  const bad = { ...fx, build: { ...fx.build, get: async id => ({ ok: true, id, status: 'failed' }) } };
  const r = await flashBuild(bad, 'nope', { requestedBy: 'operator' });
  ok('an unbuilt or failed build is refused, no gate raised',
     r.ok === false && pendingGate() === null, JSON.stringify(r));
}

/* ------------------------------------------------------------------------ */
/* the rest of the belt                                                      */
/* ------------------------------------------------------------------------ */

{
  const r = await call('record_limit', { key: 'camera.max_size_at_10fps', value: 'VGA 640×480', note: 'measured on attempt 2' });
  ok('a recorded limit lands in memory', r.ok && st.state.memory.length === 1);
  const lim = await call('get_learned_limits');
  ok('and is read back as recorded by an agent, uncommitted',
     lim.limits.some(l => l.key === 'camera.max_size_at_10fps' && l.by === 'agent' && l.committed === false));

  const imgs = await call('get_images');
  ok('the baseline image is reported', imgs.ok && imgs.baseline?.version === '0.12.0');

  const recorded = await call('record_attempt', {
    observed: 'VGA held 10 fps', hypothesis: 'VGA fits the link budget',
    change: 'kept VGA', result: 'stable', verdict: 'passed',
  });
  ok('an agent can append its observed reasoning', recorded.ok === true && recorded.status === 'passed');

  const wo = await call('get_work_order');
  ok('the work order tool returns the same attempts the human sees',
     wo.attempts.length === st.state.attempts.length && wo.attempts.every(a => 'sim' in a.steps[0]));
}

/* ------------------------------------------------------------------------ */
/* the wiring list                                                          */
/* ------------------------------------------------------------------------ */

{
  const scan = await call('scan_bus', {});
  ok('a scan answers with what acknowledged on the header',
     scan.ok === true && scan.scan?.found?.length === 2, JSON.stringify(scan.scan));
  const w = await call('get_wiring');
  ok('the wiring list carries each part with how it is known',
     w.parts.some(p => p.addr === 0x3c && p.how === 'detected' && p.confirmed === false && p.candidates.length > 0)
       && w.parts.some(p => p.name === 'BME280' && p.confirmed === true && p.confirmedBy === 'chip'),
     JSON.stringify(w.parts));
  ok('and says a person still has a question to answer', w.asks === 1);
  ok('the board report carries the same list', (await call('get_board')).wiring.parts.length === 2);
  ok('adding or confirming a part is not a tool', !mc.names().some(n => /confirm|add_part|declare|ignore/i.test(n)));
}

/* ------------------------------------------------------------------------ */
/* presence, inferred from calls                                             */
/* ------------------------------------------------------------------------ */

{
  /* A fresh mount, so nothing above has already been seen. */
  mounted.dispose();
  st.applyAgent({ seen: false, tool: null, calls: 0, lastAt: 0, quiet: false });
  const mc2 = fakeModelContext();
  /* A wide margin between the call's own timeout and the quiet timer, because
     timer jitter on a busy machine is not what this block is about. */
  const m2 = mountTools({ fx, modelContext: mc2, quietMs: 400 });

  ok('before any call, no agent has been seen', st.state.ui.agent.seen === false);

  const running = mc2.get('watch_for').execute({ field: 'tempC', op: '>', value: 999, timeoutMs: 120 }, {});
  await wait(20);
  ok('during a call the page knows which tool is running', st.state.ui.agent.tool === 'watch_for', st.state.ui.agent.tool);
  ok('and that an agent has been seen', st.state.ui.agent.seen === true);
  await running;
  ok('after the call the tool is cleared', st.state.ui.agent.tool === null);
  ok('but the agent is still known to be there', st.state.ui.agent.seen === true && st.state.ui.agent.quiet === false,
     JSON.stringify(st.state.ui.agent));
  ok('calls are counted', st.state.ui.agent.calls === 1, st.state.ui.agent.calls);

  await wait(600);
  ok('silence for long enough is reported as quiet', st.state.ui.agent.quiet === true);

  await mc2.get('get_board').execute({}, {});
  ok('and the next call wakes it', st.state.ui.agent.quiet === false);

  m2.dispose();
  ok('disposing withdraws everything', mc2.names().length === 0, mc2.names().join(','));
}

/* ------------------------------------------------------------------------ */
/* no registry at all                                                        */
/* ------------------------------------------------------------------------ */

{
  const none = mountTools({ fx, modelContext: null });
  ok('without document.modelContext nothing is registered', none.available === false && none.names().length === 0);
  ok('and the page records that tools are unavailable, for the hint', st.state.ui.agent.available === false);
  ok('and still publishes the catalogue, none of it registered',
     st.state.ui.agent.tools.length === READ.length + PAGE.length + WRITE.length && st.state.ui.agent.tools.every(t => t.registered === false),
     JSON.stringify(st.state.ui.agent.tools.map(t => t.registered)));
}

/* ------------------------------------------------------------------------ */
/* the registry where the standard first hung it                            */
/* ------------------------------------------------------------------------ */

{
  const mcN = fakeModelContext();
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { modelContext: mcN }, configurable: true, writable: true });
  const m = mountTools({ fx });
  ok('a registry on navigator, where the standard first put it, is found',
     m.available === true && READ.every(n => mcN.names().includes(n)), mcN.names().join(','));
  m.dispose();
  if (desc) Object.defineProperty(globalThis, 'navigator', desc); else delete globalThis.navigator;
}

/* ------------------------------------------------------------------------ */
/* the loop with a real effector                                             */
/* ------------------------------------------------------------------------ */

/* Retained as historical coverage for the removed browser-side search loop. */
if (false) {
  st.applyWorkOrder(null);
  st.resetAttempts();
  st.applyPeripherals({ cfg: true });

  await new Promise(resolve => {
    const b = startBuild({
      goal: 'highest resolution that holds at least 10 fps',
      setCamera: on => link.send({ t: 'cam', on }),
      setConfig: fx.setConfig,
      timings: { observe: 300, synthesize: 20, compile: 20, flash: 20, confirm: 20, frame: 300, soak: 300, between: 20, tick: 2 },
      onDone: resolve,
    });
    /* One attempt is enough to see the shape; stop once it has closed. */
    const poll = setInterval(() => {
      const a = st.state.attempts[0];
      if (a && a.status !== 'running' && a.status !== 'gated') { clearInterval(poll); b.stop(); resolve(); }
      if (st.state.attempts.some(a => a.status === 'gated')) b.approve();
    }, 20);
    setTimeout(() => { clearInterval(poll); b.stop(); resolve(); }, 15000);
  });

  const a = st.state.attempts[0];
  const step = id => a?.steps.find(s => s.id === id);
  ok('with a cfg-capable board the loop applies the config for real',
     step('apply')?.status === 'pass' && step('apply')?.sim !== true, JSON.stringify(step('apply')));
  ok('and does not pretend to compile or flash', !step('compile') && !step('flash') && !step('boot_confirm'));
  ok('so no image is invented for the history', st.state.firmware.length === 0);
  ok('the banner says the local search is driving and nothing is flashed',
     /local search/.test(st.state.workOrder?.rehearsal || '') && /nothing is compiled or flashed/.test(st.state.workOrder?.rehearsal || ''));
  ok('the synthesize step still says the decision was the fallback\'s', step('synthesize')?.sim === true);
}

board.detach();
console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
