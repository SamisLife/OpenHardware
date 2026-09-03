/* ============================================================================
   panels.mjs — the renderers, and the claim that absence is drawn.

       node frontend/tests/panels.mjs

   Mounted on a small DOM stand-in rather than a real browser. That is enough
   for the property this file exists to pin down, which is not how anything
   looks: it is that a board which has not reported and a board reporting zeros
   never render the same.

   That claim is easy to state, easy to believe, and easy to break by adding
   one readout that falls back to 0. Only a test notices.
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

/* ------------------------------------------------------------------------ */
/* a DOM small enough to reason about                                        */
/* ------------------------------------------------------------------------ */

function node(tag = 'div', attrs = {}) {
  const el = {
    tagName: tag.toUpperCase(),
    children: [],
    dataset: {},
    style: { setProperty() {} },
    className: '',
    _text: '',
    _html: '',
    _classes: new Set(),
    _attrs: {},
    _listeners: {},
    get textContent() { return el._text; },
    set textContent(v) { el._text = String(v); },
    get innerHTML() { return el._html; },
    set innerHTML(v) { el._html = String(v); el.children = []; },
    get hidden() { return !!el._attrs.hidden; },
    set hidden(v) { el._attrs.hidden = !!v; },
    classList: {
      add: c => el._classes.add(c),
      remove: (...c) => c.forEach(x => el._classes.delete(x)),
      contains: c => el._classes.has(c),
      toggle: (c, on) => (on ? el._classes.add(c) : el._classes.delete(c)),
    },
    setAttribute(k, v) { el._attrs[k] = String(v); },
    getAttribute(k) { return el._attrs[k]; },
    appendChild(child) { el.children.push(child); return child; },
    addEventListener(type, fn) { (el._listeners[type] ||= []).push(fn); },
    getContext: () => canvasStub(),
    querySelector(sel) { return find(el, sel); },
  };
  for (const [k, v] of Object.entries(attrs)) el.dataset[k] = v;
  return el;
}

function canvasStub() {
  return new Proxy({}, {
    get: (_t, k) => (k === 'canvas' ? { width: 0, height: 0 } : () => {}),
    set: () => true,
  });
}

/** Supports only `[data-key=value]`, which is every selector these use. */
function find(root, sel) {
  const m = /^\[data-([a-z-]+)=([a-z-]+)\]$/i.exec(sel.trim());
  if (!m) return null;
  const key = m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  const walk = el => {
    for (const c of el.children) {
      if (c.dataset[key] === m[2]) return c;
      const hit = walk(c);
      if (hit) return hit;
    }
    return null;
  };
  return walk(root);
}

globalThis.document = {
  createElement: tag => node(tag),
  hidden: false,
};

const tree = (...pairs) => {
  const root = node();
  for (const [k, v] of pairs) root.appendChild(node('div', { [k]: v }));
  return root;
};

/* ------------------------------------------------------------------------ */

const S = await load('state.js');
const F = await load('format.js');

const NIL = F.NIL;
const MB = 1024 * 1024;

/* ------------------------------------------------------------------------ */
/* format                                                                    */
/* ------------------------------------------------------------------------ */

{
  ok('an absent number is an em-dash pair, not a zero', F.num(null) === NIL);
  ok('and so is an absent byte count', F.bytes(undefined)[0] === NIL);
  ok('and an absent uptime', F.uptime(NaN) === NIL);
  ok('and an absent clock', F.clock(0) === NIL);

  ok('bytes pick their unit by magnitude',
     F.bytes(2 * MB)[1] === 'MB' && F.bytes(2048)[1] === 'KB' && F.bytes(12)[1] === 'B');
  ok('uptime past a day carries the day', F.uptime(93158) === '1d 01:52:38',
     F.uptime(93158));
  ok('uptime under a day does not', F.uptime(3661) === '01:01:01', F.uptime(3661));

  ok('signal bands are not linear',
     F.rssiBars(-55) === 4 && F.rssiBars(-67) === 2 && F.rssiBars(-95) === 0);
  ok('and an absent RSSI is no bars, not full bars', F.rssiBars(null) === 0);

  /* A future timestamp is a clock disagreement, not a fresh frame. */
  ok('a frame from the future is not reported as brand new',
     F.ago(Date.now() + 60000) === NIL);
}

/* ------------------------------------------------------------------------ */
/* rail                                                                      */
/* ------------------------------------------------------------------------ */

const { mountRail, renderRail } = await load('render/rail.js');

{
  const root = tree(
    ['rail', 'id'], ['rail', 'board'], ['rail', 'net'], ['rail', 'fw'],
    ['rail', 'sha'], ['rail', 'slot'], ['rail', 'link'], ['rail', 'link-text'],
    ['rail', 'bars'], ['rail', 'uptime']);
  mountRail(root);

  S.resetAll();
  renderRail(S.state);
  const get = v => find(root, `[data-rail=${v}]`);

  ok('an unreported device reads as absent everywhere',
     [get('id'), get('board'), get('net'), get('fw'), get('slot'), get('uptime')]
       .every(n => n.textContent === NIL));
  ok('and the lamp says offline rather than nothing',
     get('link').dataset.state === 'offline' && get('link-text').textContent === 'OFFLINE');
  ok('with no signal bars', get('bars').dataset.bars === '0');

  S.applyDevice({ id: 'board-01', board: 'a board', link: 'linked',
                  firmware: { version: '0.4.0', sha: 'abcdef1234', slot: 'factory' } });
  S.pushTelemetry({ t: Date.now(), uptimeS: 3661, rssi: -57 });
  renderRail(S.state);

  ok('a reported identity is shown', get('id').textContent === 'board-01');
  ok('the firmware hash is truncated, not invented',
     get('sha').textContent === 'abcdef1', get('sha').textContent);
  ok('uptime comes from the sample', get('uptime').textContent === '01:01:01');
  ok('signal bars follow the reading', get('bars').dataset.bars === '3');

  /* An SSID with no address is an association that has not produced a route,
     which is a different state from being on a network. */
  S.applyDevice({ ssid: 'bench', ip: null });
  renderRail(S.state);
  ok('an SSID without an address does not claim a network',
     get('net').textContent === 'bench', get('net').textContent);
  S.applyDevice({ ip: '10.0.0.4' });
  renderRail(S.state);
  ok('and both together read as one', get('net').textContent === 'bench · 10.0.0.4');
}

/* ------------------------------------------------------------------------ */
/* vitals                                                                    */
/* ------------------------------------------------------------------------ */

const { mountVitals, renderVitals } = await load('render/vitals.js');

{
  const root = tree(['vitals', 'grid'], ['vitals', 'rate']);
  mountVitals(root);
  const grid = find(root, '[data-vitals=grid]');
  const valueOf = i => grid.children[i].children[1].children[0].textContent;

  S.resetAll();
  S.applyDevice({ link: 'linked' });
  S.pushTelemetry({
    t: Date.now(), uptimeS: 120, tempC: 44.2, heapFree: 190000,
    psramFree: 6.1 * MB, rssi: -57, cpuMhz: 240, fps: 8.3,
  });
  renderVitals(S.state);
  ok('a reported temperature is shown', valueOf(0) === '44.2', valueOf(0));

  /* The claim this file exists for. */
  S.applyDevice({ link: 'lost' });
  renderVitals(S.state);
  ok('every readout goes absent when the link drops',
     grid.children.every((_, i) => valueOf(i) === NIL),
     'a stale number presented as live is the failure this instrument prevents');
  ok('and each cell is marked absent rather than merely blank',
     grid.children.every(c => c.classList.contains('is-absent')));
}

{
  const root = tree(['vitals', 'grid'], ['vitals', 'rate']);
  mountVitals(root);
  const grid = find(root, '[data-vitals=grid]');
  const heap = grid.children[1];

  S.resetAll();
  S.applyDevice({ link: 'linked' });
  S.pushTelemetry({ t: Date.now(), heapFree: 190000, psramFree: 6.1 * MB, tempC: 40 });
  renderVitals(S.state);

  /* A bar needs a denominator. Until a board reports its total there is
     nothing to be a fraction of. */
  ok('a headroom bar is not drawn without a reported total',
     heap.children[2].dataset.known === 'false');
  ok('and the value itself is still shown',
     heap.children[1].children[0].textContent === '186',
     heap.children[1].children[0].textContent);

  S.applyLimits({ heapTotal: 327680 });
  renderVitals(S.state);
  ok('once the board reports a total the bar appears',
     heap.children[2].dataset.known === 'true');
  ok('and it drains rather than fills',
     parseFloat(heap.children[2].children[0].style.width) > 50,
     heap.children[2].children[0].style.width);
}

{
  const root = tree(['vitals', 'grid'], ['vitals', 'rate']);
  mountVitals(root);
  const grid = find(root, '[data-vitals=grid]');
  const rssi = grid.children[3];

  S.resetAll();
  S.applyDevice({ link: 'linked' });
  S.pushTelemetry({ t: Date.now(), tempC: 40, rssi: 0 });
  renderVitals(S.state);
  /* Zero dBm is not a weak signal, it is the absence of one. */
  ok('a cable-tethered board shows no RSSI rather than zero',
     rssi.children[1].children[0].textContent === NIL);
  ok('and says why', rssi.children[2].textContent === 'no association');
}

/* ------------------------------------------------------------------------ */
/* camera                                                                    */
/* ------------------------------------------------------------------------ */

const { mountCamera, renderCamera } = await load('render/camera.js');

{
  const root = tree(
    ['cam', 'canvas'], ['cam', 'sensor'], ['cam', 'res'], ['cam', 'quality'],
    ['cam', 'seq'], ['cam', 'bytes'], ['cam', 'stamp'], ['cam', 'chip'],
    ['cam', 'verdict'], ['cam', 'well']);
  mountCamera(root);
  const get = v => find(root, `[data-cam=${v}]`);

  S.resetAll();
  renderCamera(S.state);
  ok('no sensor is named before the board names one', get('sensor').textContent === NIL,
     'a model number in the markup is right on one desk and wrong on every other');

  S.applyDevice({ link: 'linked' });
  S.applyPeripherals({ known: true, camera: { state: 'ok', sensor: 'OV5640' } });
  renderCamera(S.state);
  ok('the sensor shown is the one the board reported',
     get('sensor').textContent === 'OV5640', get('sensor').textContent);

  S.applyDevice({ link: 'lost' });
  renderCamera(S.state);
  ok('a lost link says there is no heartbeat rather than showing a frame',
     /no heartbeat/i.test(get('verdict').textContent));
  ok('and the well is marked so the dead raster is drawn',
     get('well').dataset.link === 'lost');

  S.applyDevice({ link: 'linked' });
  S.applyFrame({ verdict: 'The camera was removed.' });
  renderCamera(S.state);
  /* A verdict with no frame is a real thing to say. */
  ok('a verdict survives having no image behind it',
     get('verdict').textContent === 'The camera was removed.');
}

/* ------------------------------------------------------------------------ */
/* peripherals                                                               */
/* ------------------------------------------------------------------------ */

const { mountPeripherals, renderPeripherals } = await load('render/peripherals.js');

{
  const root = tree(['periph', 'list'], ['periph', 'empty'], ['periph', 'prompt']);
  mountPeripherals(root, {});
  const list = find(root, '[data-periph=list]');
  const empty = find(root, '[data-periph=empty]');

  S.resetAll();
  renderPeripherals(S.state);
  ok('nothing is listed before the board has reported', list.innerHTML === '');
  ok('and the empty state says it is waiting rather than claiming nothing exists',
     /waiting/i.test(empty.textContent));

  S.applyPeripherals({ known: true, camera: { state: 'ok', sensor: 'OV2640' }, i2c: [0x76] });
  renderPeripherals(S.state);

  ok('an identified sensor is listed plainly', /OV2640/.test(list.innerHTML));
  /* An address is an observation; a part number beside it is inference. */
  ok('an observed address is listed as an address', /0x76/.test(list.innerHTML));
  ok('and its candidate part is marked as a guess',
     /probably BME280/.test(list.innerHTML) && /data-tone="guess"/.test(list.innerHTML));

  S.applyPeripherals({ camera: { state: 'absent', sensor: null }, i2c: [] });
  renderPeripherals(S.state);
  ok('an empty bus does not imply the list is complete',
     /cannot be discovered/i.test(empty.textContent));

  S.applyPeripherals({ i2c: [0x11] });
  renderPeripherals(S.state);
  ok('an address with no candidate is not given an invented name',
     /unidentified device/.test(list.innerHTML));
}

/* ------------------------------------------------------------------------ */
/* belt — the agent panel at rest                                            */
/* ------------------------------------------------------------------------ */

const { mountBelt, renderBelt } = await load('render/belt.js');

{
  const root = tree(['belt', 'avail'], ['belt', 'presence'], ['belt', 'hint'], ['belt', 'tools'], ['belt', 'examples']);
  mountBelt(root);
  const q = k => root.querySelector(`[data-belt=${k}]`);
  const read = { name: 'get_board', title: 'identity', readOnly: true, registered: false };
  const write = { name: 'set_camera', title: 'stream', readOnly: false, registered: false };

  S.state.ui.agent = { available: null, seen: false, tool: null, calls: 0, lastAt: 0, quiet: false, tools: [] };
  renderBelt(S.state);
  ok('before the page has looked for a registry, the belt claims nothing',
     /––/.test(q('avail').textContent) && q('presence').textContent === '' && q('hint').hidden);

  S.state.ui.agent = { ...S.state.ui.agent, available: false, tools: [read, write] };
  renderBelt(S.state);
  ok('with no registry the belt says so, and says where one is found',
     q('avail').textContent === 'NO REGISTRY' && !q('hint').hidden
       && /ChatGPT/.test(q('hint').textContent) && /chrome:\/\/flags/.test(q('hint').textContent));
  ok('and still lists every tool, none of it registered',
     /get_board/.test(q('tools').innerHTML) && /set_camera/.test(q('tools').innerHTML)
       && !/data-registered="true"/.test(q('tools').innerHTML));

  S.state.ui.agent = { ...S.state.ui.agent, available: true, tools: [{ ...read, registered: true }, write] };
  renderBelt(S.state);
  ok('with a registry and no caller yet, the tools are ready',
     q('avail').textContent === 'TOOLS READY' && /1 registered/.test(q('presence').textContent) && q('hint').hidden);
  ok('a write tool withdrawn for want of a board says so',
     /withdrawn until a board is linked/.test(q('tools').innerHTML));

  S.state.ui.agent = { ...S.state.ui.agent, seen: true, tool: 'watch_for', calls: 3 };
  renderBelt(S.state);
  ok('a running tool is named', q('avail').textContent === 'AGENT' && /running watch_for/.test(q('presence').textContent));

  S.state.ui.agent = { ...S.state.ui.agent, tool: null, quiet: true, lastAt: Date.now() };
  renderBelt(S.state);
  ok('silence is reported with the count of calls', /quiet since/.test(q('presence').textContent) && /3 calls/.test(q('presence').textContent));

  S.state.workOrder = { id: 'wo_1', goal: 'g', status: 'running' };
  renderBelt(S.state);
  ok('a work order takes the slot', root.hidden === true);
  S.state.workOrder = null;
  renderBelt(S.state);
  ok('and clearing it gives the slot back', root.hidden === false);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
