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
    ['rail', 'id'], ['rail', 'board'], ['rail', 'fw'],
    ['rail', 'sha'], ['rail', 'slot'], ['rail', 'link'], ['rail', 'link-text'],
    ['rail', 'uptime']);
  mountRail(root);

  S.resetAll();
  renderRail(S.state);
  const get = v => find(root, `[data-rail=${v}]`);

  ok('an unreported device reads as absent everywhere',
     [get('id'), get('board'), get('fw'), get('slot'), get('uptime')]
       .every(n => n.textContent === NIL));
  ok('and the lamp says offline rather than nothing',
     get('link').dataset.state === 'offline' && get('link-text').textContent === 'OFFLINE');

  S.applyDevice({ id: 'board-01', board: 'a board', link: 'linked',
                  firmware: { version: '0.4.0', sha: 'abcdef1234', slot: 'factory' } });
  S.pushTelemetry({ t: Date.now(), uptimeS: 3661 });
  renderRail(S.state);

  ok('a reported identity is shown', get('id').textContent === 'board-01');
  ok('the firmware hash is truncated, not invented',
     get('sha').textContent === 'abcdef1', get('sha').textContent);
  ok('uptime comes from the sample', get('uptime').textContent === '01:01:01');
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
    psramFree: 6.1 * MB, cpuMhz: 240, fps: 8.3,
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
  const root = tree(['periph', 'list'], ['periph', 'empty'], ['periph', 'ask'], ['periph', 'status']);
  mountPeripherals(root, {});
  const list = find(root, '[data-periph=list]');
  const empty = find(root, '[data-periph=empty]');
  const ask = find(root, '[data-periph=ask]');
  const status = find(root, '[data-periph=status]');

  S.resetAll();
  renderPeripherals(S.state);
  ok('nothing is listed before the board has reported', list.innerHTML === '');
  ok('and the empty state says it is waiting rather than claiming nothing exists',
     /waiting/i.test(empty.textContent));

  S.applyPeripherals({ known: true, camera: { state: 'ok', sensor: 'OV2640' }, streaming: false, streamWanted: true });
  S.state.ui.cameraShown = false;
  renderPeripherals(S.state);

  ok('an identified sensor is listed plainly', /OV2640/.test(list.innerHTML));
  ok('with a glyph beside it', /periph__icon/.test(list.innerHTML));
  ok('and a detected badge', /data-how="detected"/.test(list.innerHTML));
  ok('and, with the picture hidden, a Show control', /data-periph="toggle" data-on="true"[^>]*>Show</.test(list.innerHTML));
  S.state.ui.cameraShown = true;
  renderPeripherals(S.state);
  ok('once the picture is wanted the control reads Hide', /data-on="false"[^>]*>Hide</.test(list.innerHTML));
  S.state.ui.cameraShown = false;
  S.applyPeripherals({ streaming: true });
  renderPeripherals(S.state);
  ok('a hidden picture keeps streaming, and the control still reads Show', /Show</.test(list.innerHTML) && /streaming/.test(list.innerHTML));
  S.state.ui.cameraShown = true;
  S.applyPeripherals({ streaming: false });

  /* A scan answers with addresses. One is a bare address: the page guesses
     and asks. One the silicon named: a fact, listed as such. */
  S.applyScan({ ok: true, bus: 'i2c0', sda: 5, scl: 6, ms: 140, found: [{ addr: 0x3c }, { addr: 0x76, id: 'BME280' }], at: 1000 });
  renderPeripherals(S.state);
  ok('an acknowledged address is listed as an address, with its pins',
     /0x3c/.test(list.innerHTML) && /D4 \(GPIO5\)/.test(list.innerHTML));
  ok('and its candidate part is marked as a guess',
     /probably SSD1306 OLED, or SH1106 OLED/.test(list.innerHTML) && /data-tone="guess"/.test(list.innerHTML));
  ok('a part the silicon named is listed by name and not guessed at',
     /BME280/.test(list.innerHTML) && !/probably BME280/.test(list.innerHTML));
  ok('the person is asked about the unnamed one only',
     S.state.wiring.asks.length === 1 && ask.hidden === false
       && /Found <strong>0x3c<\/strong>/.test(ask.innerHTML) && /Is this <strong>SSD1306 OLED<\/strong>\?/.test(ask.innerHTML));

  S.confirmPart('i2c:0x3c', 'SH1106 OLED');
  renderPeripherals(S.state);
  ok('a confirmed name replaces the guess and the question goes',
     /SH1106 OLED/.test(list.innerHTML) && !/probably/.test(list.innerHTML) && ask.hidden === true);

  S.applyScan({ ok: true, bus: 'i2c0', sda: 5, scl: 6, ms: 140, found: [{ addr: 0x76, id: 'BME280' }], at: 2000 });
  renderPeripherals(S.state);
  ok('a part that stopped answering is kept, marked, and asked about',
     /not seen on the last scan/.test(list.innerHTML) && S.state.wiring.asks[0]?.kind === 'missing'
       && /did not answer on the last scan/.test(ask.innerHTML));
  S.keepPart('i2c:0x3c');
  ok('keeping it closes the question and leaves it listed', S.state.wiring.asks.length === 0 && S.state.wiring.parts.length === 2);

  S.addPart({ name: 'WS2812 strip', bus: 'gpio', addr: null, pins: ['D2'], note: '30 LEDs' });
  renderPeripherals(S.state);
  ok('a declared part is listed with its badge, its pins and a way off the list',
     /WS2812 strip/.test(list.innerHTML) && /data-how="declared"/.test(list.innerHTML)
       && /D2 · 30 LEDs/.test(list.innerHTML) && /data-periph="remove"/.test(list.innerHTML));

  S.applyScan({ ok: false, err: 'bus_stuck', line: 'sda', bus: 'i2c0', sda: 5, scl: 6, at: 3000 });
  renderPeripherals(S.state);
  ok('a stuck bus is recorded as a failed scan, not as an empty bus',
     S.state.wiring.scan.ok === false && S.state.wiring.parts.length === 3 && /SDA is held low/.test(status.textContent));
  S.applyScan({ ok: false, err: 'no_answer', at: 3500 });
  renderPeripherals(S.state);
  ok('a missing reply is said without assigning a cause, with the discriminator to read',
     /no scan reply arrived/i.test(status.textContent) && /rxBytes/.test(status.textContent));

  S.resetAll();
  S.applyPeripherals({ known: true, camera: { state: 'absent', sensor: null } });
  renderPeripherals(S.state);
  ok('an empty bus does not imply the list is complete',
     /cannot be discovered/i.test(empty.textContent) && /\+ add/.test(empty.textContent));

  S.applyScan({ ok: true, bus: 'i2c0', sda: 5, scl: 6, ms: 100, found: [{ addr: 0x11 }], at: 4000 });
  renderPeripherals(S.state);
  ok('an address with no candidate is not given an invented name',
     /0x11/.test(list.innerHTML) && !/probably/.test(list.innerHTML) && /Nothing in the table/.test(ask.innerHTML));
  S.resetAll();
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

/* ------------------------------------------------------------------------ */
/* the Images panel Flash button                                             */
/* ------------------------------------------------------------------------ */

const { mountFirmware, renderFirmware } = await load('render/firmware.js');

{
  const root = tree(['fw', 'body'], ['fw', 'empty'], ['fw', 'memory'], ['fw', 'mem-empty']);
  let asked = null;
  mountFirmware(root, { onFlash: id => { asked = id; } });
  const body = find(root, '[data-fw=body]');

  const built = { buildId: 'b1', version: '0.14.1', sha: 'abc1234def', bytes: 880384, builtAt: Date.now(), outcome: 'built' };
  const failedBuild = { buildId: 'b2', version: '0.14.1', sha: null, bytes: null, builtAt: Date.now(), outcome: 'failed' };

  const flashBtn = id => new RegExp(`data-fwact="flash" data-build="${id}"`);
  const disabledFlash = id => new RegExp(`data-fwact="flash" data-build="${id}"[^>]*disabled`);

  /* Linked and idle: a built image offers a Flash button; a failed build,
     with no image behind it, offers none. */
  renderFirmware({ firmware: [built, failedBuild], device: { link: 'linked' }, ui: { flashing: null } });
  ok('a built image shows an enabled Flash button',
     flashBtn('b1').test(body.innerHTML) && !disabledFlash('b1').test(body.innerHTML));
  ok('a failed build offers nothing to flash', !flashBtn('b2').test(body.innerHTML));

  /* No board: the button is present but disabled. */
  renderFirmware({ firmware: [built], device: { link: 'offline' }, ui: { flashing: null } });
  ok('with no board linked the Flash button is disabled', disabledFlash('b1').test(body.innerHTML));

  /* A flash in flight: other rows are disabled, the one being written reports
     its own progress in place of the button. */
  renderFirmware({
    firmware: [built], device: { link: 'linked' },
    ui: { flashing: { buildId: 'b1', written: 440192, total: 880384 } },
  });
  ok('the row being flashed shows how far it has got, not a button',
     /47%|50%/.test(body.innerHTML) && !flashBtn('b1').test(body.innerHTML), body.innerHTML.slice(0, 200));

  renderFirmware({
    firmware: [built], device: { link: 'linked' },
    ui: { flashing: { buildId: 'b1', written: 880384, total: 880384 } },
  });
  ok('and it reaches 100 rather than stopping short', /100%/.test(body.innerHTML));

  /* The parts of a flash with no byte count say what they are doing. A
     percentage there would be a number nobody measured. */
  renderFirmware({
    firmware: [built], device: { link: 'linked' },
    ui: { flashing: { buildId: 'b1', written: null, total: null, stage: 'booting' } },
  });
  ok('a stage with nothing to count is named, never given a percentage',
     /booting/.test(body.innerHTML) && !/%/.test(body.innerHTML));

  /* How the last flash ended, on the row it was written to. */
  renderFirmware({
    firmware: [built], device: { link: 'linked' },
    ui: { flashing: null, lastFlash: { buildId: 'b1', ok: true } },
  });
  ok('a finished flash says SUCCESS on its own row',
     /SUCCESS/.test(body.innerHTML) && !/FAIL/.test(body.innerHTML));
  ok('and the button comes back so it can be written again',
     flashBtn('b1').test(body.innerHTML) && />Flash</.test(body.innerHTML));

  renderFirmware({
    firmware: [built], device: { link: 'linked' },
    ui: { flashing: null, lastFlash: { buildId: 'b1', ok: false, reason: 'the candidate was abandoned by the bootloader' } },
  });
  ok('a failed flash says FAIL and carries its reason',
     /FAIL/.test(body.innerHTML) && /abandoned by the bootloader/.test(body.innerHTML));
  ok('and the button offers to try again rather than repeating Flash',
     />Retry</.test(body.innerHTML));

  const sibling = { buildId: 'b4', version: '0.14.1', sha: 'aaaa1111', bytes: 880384, builtAt: Date.now(), outcome: 'built' };
  renderFirmware({
    firmware: [built, sibling], device: { link: 'linked' },
    ui: { flashing: null, lastFlash: { buildId: 'b1', ok: true } },
  });
  ok('a verdict belongs to the row it was written to, and no other',
     (body.innerHTML.match(/SUCCESS/g) || []).length === 1);

  const other = { buildId: 'b3', version: '0.14.1', sha: 'ffff0000', bytes: 880384, builtAt: Date.now(), outcome: 'built' };
  renderFirmware({ firmware: [other], device: { link: 'linked' }, ui: { flashing: { buildId: 'b1' } } });
  ok('and every other Flash button is disabled while one runs', disabledFlash('b3').test(body.innerHTML));

  /* Clicks route through one delegated listener, by action and build id. */
  const click = (fwact, build) => body._listeners.click?.[0]?.({
    target: { dataset: { fwact, build }, disabled: false, closest(sel) { return sel === '[data-fwact]' ? this : null; } },
  });

  renderFirmware({ firmware: [built], device: { link: 'linked' }, ui: { flashing: null } });
  click('flash', 'b1');
  ok('clicking Flash asks to flash that build', asked === 'b1');

  /* ---- the row menu, review and delete --------------------------------- */

  ok('every build carries an overflow menu button, including a failed one',
     /data-fwact="menu" data-build="b1"/.test(body.innerHTML));
  renderFirmware({ firmware: [built, failedBuild], device: { link: 'linked' }, ui: {} });
  ok('a build that failed to compile can still be opened',
     /data-fwact="menu" data-build="b2"/.test(body.innerHTML));
  ok('but the menu is closed until it is asked for', !/fwmenu/.test(body.innerHTML));

  renderFirmware({ firmware: [built], device: { link: 'linked' }, ui: { menuFor: 'b1' } });
  ok('an open menu offers Review and Delete',
     /data-fwact="review" data-build="b1"/.test(body.innerHTML)
     && /data-fwact="delete" data-build="b1"/.test(body.innerHTML));
  ok('and Delete does not delete on the first press',
     !/delete-confirm/.test(body.innerHTML));

  renderFirmware({ firmware: [built], device: { link: 'linked' }, ui: { menuFor: 'b1', confirmDelete: 'b1' } });
  ok('the second press is the one that says what it does',
     /data-fwact="delete-confirm" data-build="b1"/.test(body.innerHTML)
     && /Delete for good/.test(body.innerHTML));

  let menued = null, reviewed = null, deleted = null, confirmed = null, closed = 0;
  mountFirmware(root, {
    onFlash: () => {}, onMenu: id => { menued = id; }, onReview: id => { reviewed = id; },
    onDelete: id => { deleted = id; }, onDeleteConfirm: id => { confirmed = id; },
    onCloseReview: () => { closed++; },
  });
  const body2 = find(root, '[data-fw=body]');
  renderFirmware({ firmware: [built], device: { link: 'linked' }, ui: { menuFor: 'b1' } });
  const click2 = (fwact, build) => body2._listeners.click?.at(-1)?.({
    target: { dataset: { fwact, build }, disabled: false, closest(sel) { return sel === '[data-fwact]' ? this : null; } },
  });
  click2('menu', 'b1'); click2('review', 'b1'); click2('delete', 'b1');
  click2('delete-confirm', 'b1'); click2('close-review');
  ok('each menu action reaches its own handler with the build id',
     menued === 'b1' && reviewed === 'b1' && deleted === 'b1' && confirmed === 'b1' && closed === 1,
     JSON.stringify({ menued, reviewed, deleted, confirmed, closed }));

  /* ---- the source listing ---------------------------------------------- */

  renderFirmware({
    firmware: [built], device: { link: 'linked' },
    ui: { review: { buildId: 'b1', from: 'row', loading: true } },
  });
  ok('a review that is still fetching says so, and claims no code',
     /reading the stored source/.test(body2.innerHTML));

  renderFirmware({
    firmware: [built], device: { link: 'linked' },
    ui: { review: { buildId: 'b1', from: 'row', files: { 'app.c': 'void app_setup(void) { /* <b>x</b> */ }' }, app: { name: 'oled_hello', version: '1.0.1' } } },
  });
  ok('the source is shown under the row it belongs to',
     /app\.c/.test(body2.innerHTML) && /void app_setup/.test(body2.innerHTML));
  ok('and the code is escaped, never interpreted as markup',
     !/<b>x<\/b>/.test(body2.innerHTML) && /&lt;b&gt;/.test(body2.innerHTML));
  ok('the listing names the build it came from', /build b1/.test(body2.innerHTML));

  renderFirmware({
    firmware: [built], device: { link: 'linked' },
    ui: { review: { buildId: 'b1', from: 'gate', files: { 'app.c': 'x' } } },
  });
  ok('a review opened from the gate is not also drawn in the table',
     !/src__code/.test(body2.innerHTML));

  renderFirmware({
    firmware: [built], device: { link: 'linked' },
    ui: { review: { buildId: 'b1', from: 'row', files: null, error: 'no stored source for build b1' } },
  });
  ok('a build with no stored source says so rather than showing nothing',
     /no stored source/.test(body2.innerHTML));

  /* ---- the table is not rebuilt when nothing about it changed ----------- */

  /* This is what makes an open source listing scrollable. The panel repaints
     on every heartbeat, and replacing the rows would send the code block back
     to its first line each time — which is exactly what it did while the
     comparison was made against innerHTML read back out of the DOM, where a
     bare `disabled` returns as `disabled=""` and never matches what was
     written. The stub below re-serialises the same way a browser does. */
  const open = {
    firmware: [built, other], device: { link: 'offline' },
    ui: { review: { buildId: 'b1', from: 'row', files: { 'app.c': 'void app_setup(void) {}' } } },
  };
  renderFirmware(open);
  let writes = 0;
  const realBody = body2;
  Object.defineProperty(realBody, 'innerHTML', {
    configurable: true,
    get() { return realBody._html.replace(/ disabled(?=[ >])/g, ' disabled=""'); },
    set(v) { writes++; realBody._html = String(v); realBody.children = []; },
  });

  /* Ten heartbeats' worth of repaints with identical content. */
  for (let i = 0; i < 10; i++) renderFirmware(open);
  ok('repainting with nothing changed does not rebuild the rows', writes === 0, `${writes} rebuilds`);

  renderFirmware({ ...open, device: { link: 'linked' } });
  ok('but a real change still repaints', writes === 1, `${writes} rebuilds`);
}

/* ------------------------------------------------------------------------ */
/* the approval gate offers the code it is about to write                    */
/* ------------------------------------------------------------------------ */

const { mountAgent, renderGate } = await load('render/agent.js');

{
  const root = tree(['agent', 'gate'], ['agent', 'status'], ['agent', 'order'],
                    ['agent', 'attempts'], ['agent', 'empty'], ['agent', 'count']);
  let reviewedGate = null, approved = 0, held = 0;
  mountAgent(root, {
    onApprove: () => { approved++; },
    onHold: () => { held++; },
    onReviewGate: g => { reviewedGate = g; },
    onCloseReview: () => {},
  });
  const slot = find(root, '[data-agent=gate]');

  const flashGate = {
    state: 'pending', requestedBy: 'agent', buildId: 'b7',
    action: 'Write build b7 to the inactive OTA slot',
    rationale: 'An agent asked. Review source shows the exact code this image was compiled from.',
    policy: 'waits for the operator',
  };

  renderGate({ gate: flashGate, ui: { review: null } });
  ok('a flash gate offers the source beside Approve and Hold',
     /data-gate="approve"/.test(slot.innerHTML)
     && /data-gate="hold"/.test(slot.innerHTML)
     && /data-gate="review"/.test(slot.innerHTML));
  ok('and reviewing is offered as reading, not as a third answer',
     /Review source/.test(slot.innerHTML));

  /* A gate that writes no build — credentials, say — has nothing to read. */
  renderGate({ gate: { ...flashGate, buildId: null }, ui: { review: null } });
  ok('a gate with no build behind it offers no source to read',
     !/data-gate="review"/.test(slot.innerHTML));

  renderGate({ gate: flashGate, ui: { review: { buildId: 'b7', from: 'gate', files: { 'app.c': 'void app_setup(void) {}' } } } });
  ok('the source opens inside the gate itself, above nothing else',
     /void app_setup/.test(slot.innerHTML) && /src__code/.test(slot.innerHTML));
  ok('and the button then offers to put it away', /Hide source/.test(slot.innerHTML));

  /* A listing opened from an image row does not appear in the gate. */
  renderGate({ gate: flashGate, ui: { review: { buildId: 'b7', from: 'row', files: { 'app.c': 'x' } } } });
  ok('a listing opened from the images list is not duplicated into the gate',
     !/src__code/.test(slot.innerHTML));

  /* Drawing a gate, opening a listing and closing it again answers nothing:
     the only things that resolve a gate are its two buttons. */
  renderGate({ gate: flashGate, ui: { review: null } });
  ok('drawing and reviewing never answers the gate on its own',
     approved === 0 && held === 0 && reviewedGate === null);
  ok('an answered gate stops offering the source at all',
     (renderGate({ gate: { ...flashGate, state: 'held', answeredAt: Date.now() }, ui: { review: null } }),
      !/data-gate="review"/.test(slot.innerHTML) && /HELD/.test(slot.innerHTML)));
}

/* ------------------------------------------------------------------------ */
/* hidden means hidden, at every width                                       */
/* ------------------------------------------------------------------------ */

/* Not a renderer, but the same claim the rest of this file makes: what the
   page says about the board must not depend on the size of the window. The
   rule that hides the camera panel once lived inside the ≥1100px block, so a
   picture turned off deliberately came back in a narrow window and in the
   half-screen browser panel an agent opens the page in — the two places with
   the least room for it. Nothing else here can catch that, because it is a
   stylesheet and not a function. */
{
  const { readFileSync } = await import('node:fs');
  const cssPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'styles', 'layout.css');
  const css = readFileSync(cssPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  const needle = 'body[data-camera="off"] .panel--camera';
  const at = css.indexOf(needle);
  ok('the camera panel has a rule that hides it', at >= 0);

  const before = css.slice(0, at);
  const depth = (before.match(/\{/g) || []).length - (before.match(/\}/g) || []).length;
  ok('and it is not nested inside a breakpoint, so it holds at every width',
     depth === 0, `nested ${depth} level(s) deep`);

  /* And no media block quietly turns it back on. */
  let revived = null;
  for (const m of css.matchAll(/@media[^{]*\{/g)) {
    let d = 1, j = m.index + m[0].length;
    while (j < css.length && d) { if (css[j] === '{') d++; else if (css[j] === '}') d--; j++; }
    const body = css.slice(m.index + m[0].length, j);
    if (/\.panel--camera[^{}]*\{[^{}]*display\s*:/.test(body)) revived = m[0].trim();
  }
  ok('and no breakpoint overrides the camera panel back into view', revived === null, revived || '');
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
