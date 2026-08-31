/* ============================================================================
   sim.mjs — the simulated board, and the feed it drives.

       node frontend/tests/sim.mjs

   The claim under test is the one that makes a simulator worth having at all:
   that it is a fake board behind the REAL interface rather than a mock of the
   interface. Concretely — its frames go through the real encoder and the real
   reader, its link satisfies the same contract a serial port does, and the
   model it produces is indistinguishable from one a board produced.

   A simulator held to a weaker contract keeps passing after the real path has
   broken, at which point it has stopped being evidence and started being
   decoration.
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
/* No DOM: the board still reports, it just cannot draw a picture. */
globalThis.URL.createObjectURL ??= () => 'blob:test';
globalThis.URL.revokeObjectURL ??= () => {};

const { SimBoard } = await load('link/sim.js');
const { createFeed } = await load('link/feed.js');
const { decodeLine, encodeFrame, IMG_CHUNK_RAW } = await load('link/protocol.js');
const S = await load('state.js');

const wait = ms => new Promise(r => setTimeout(r, ms));

/** Attach a board and collect everything it puts on the wire. */
function listen(scene = '') {
  const frames = [], texts = [];
  const board = new SimBoard(scene);
  const link = board.attach({
    onFrame: f => frames.push(f),
    onText: (t, bad) => texts.push({ t, bad }),
  });
  return { board, link, frames, texts };
}

/* ------------------------------------------------------------------------ */
/* the link contract                                                         */
/* ------------------------------------------------------------------------ */

{
  const { link, board } = listen();

  /* Bug 16 in the previous project: a simulated link with no `open` property
     worked everywhere except against the code that checked it first. */
  ok('the link exposes open, as a real port does', typeof link.open === 'boolean');
  ok('and reports itself open while attached', link.open === true);
  ok('send resolves like a real write', (await link.send({ t: 'ping' })) === true);

  await link.stop();
  ok('and reports itself closed after stopping', link.open === false);
  ok('stopping clears its timers', board.timers.size === 0);
}

/* ------------------------------------------------------------------------ */
/* it speaks the protocol, rather than bypassing it                          */
/* ------------------------------------------------------------------------ */

{
  const { link, frames, texts } = listen();
  await wait(300);
  await link.stop();

  ok('the board announces itself', frames.some(f => f.t === 'hello'));
  ok('and heartbeats', frames.some(f => f.t === 'beat'));

  /* Every frame above arrived by being encoded, CRC'd, split on newlines and
     parsed. A break in any of that shows up here rather than only on
     hardware. */
  const hello = frames.find(f => f.t === 'hello');
  const line = encodeFrame({ ...hello });
  ok('what it emits is a decodable OHW1 frame',
     decodeLine(line.trimEnd()).frame?.t === 'hello');

  ok('boot chatter reaches the log path', texts.length > 0);
  ok('and is not mistaken for a broken frame', texts.every(x => !x.bad),
     'the pass-through path is exercised, not stubbed');
  ok('the log is verbatim', texts.some(x => /esp_psram/.test(x.t)));
}

/* ------------------------------------------------------------------------ */
/* it answers                                                                */
/* ------------------------------------------------------------------------ */

{
  const { link, frames } = listen();
  await wait(60);
  const before = frames.length;

  await link.send({ t: 'ping' });
  ok('a ping is answered with an identity frame',
     frames.slice(before).some(f => f.t === 'hello'));

  await link.send({ t: 'caps' });
  ok('a capability request is answered',
     frames.some(f => f.t === 'caps'));

  /* Streaming before the camera is up must be refused rather than silently
     accepted, or the console would show a frame rate for a sensor that has
     not been probed. */
  const early = frames.length;
  await link.send({ t: 'cam', on: true });
  const ack = frames.slice(early).find(f => f.t === 'cam_ack');
  ok('capture is refused before the camera has been probed',
     ack && ack.on === false && /no camera/i.test(ack.err || ''), JSON.stringify(ack));

  await wait(2300);
  ok('the camera comes up after the board is already reporting',
     frames.some(f => f.t === 'status' && f.stage === 'camera_ok'),
     'the one step that can take a board down runs last');

  const later = frames.length;
  await link.send({ t: 'cam', on: true });
  ok('and capture is accepted once it is',
     frames.slice(later).some(f => f.t === 'cam_ack' && f.on === true));

  await link.stop();
}

/* ------------------------------------------------------------------------ */
/* through the feed, into the model                                          */
/* ------------------------------------------------------------------------ */

{
  S.resetAll();
  const feed = createFeed({ source: 'sim' });
  const board = new SimBoard('');
  const link = board.attach({ onFrame: feed.handleFrame, onText: feed.handleText });

  await wait(400);

  ok('the model learns the board identity', S.state.device.id === 'board-0001',
     S.state.device.id);
  ok('and that it is linked', S.state.device.link === 'linked');
  ok('and collects telemetry', S.state.telemetry.buffer.length > 0,
     `${S.state.telemetry.buffer.length} samples`);

  /* Board constants arrive over the wire; the panels refuse to draw a
     proportion until they do. */
  ok('board totals are reported rather than assumed',
     S.state.telemetry.limits.psramTotal === 8 * 1024 * 1024
     && S.state.telemetry.limits.heapTotal === 327680,
     JSON.stringify(S.state.telemetry.limits));

  /* A cable-tethered board has no association, and reporting a plausible
     signal strength would be inventing one. */
  ok('no signal strength is invented for a board with no radio',
     S.state.telemetry.latest.rssi === 0);

  await wait(1700);
  ok('what is attached is discovered, not assumed',
     S.state.peripherals.known === true);
  ok('and the sensor is named by the board',
     S.state.peripherals.camera?.sensor === 'OV2640',
     JSON.stringify(S.state.peripherals.camera));

  feed.stop();
  await link.stop();
}

/* ------------------------------------------------------------------------ */
/* the scenes                                                                */
/* ------------------------------------------------------------------------ */

{
  S.resetAll();
  const feed = createFeed({ source: 'sim' });
  const board = new SimBoard('nocam');
  const link = board.attach({ onFrame: feed.handleFrame, onText: feed.handleText });

  await wait(2100);
  ok('a board with no camera says so rather than staying silent',
     S.state.peripherals.known === true
     && S.state.peripherals.camera?.state === 'absent',
     JSON.stringify(S.state.peripherals.camera));

  feed.stop();
  await link.stop();
}

{
  S.resetAll();
  const feed = createFeed({ source: 'sim' });
  const board = new SimBoard('');
  const link = board.attach({ onFrame: feed.handleFrame, onText: feed.handleText });

  await wait(400);
  ok('the board is linked before it vanishes', S.state.device.link === 'linked');

  /* Silence is the only way a board reports that it stopped. */
  board.vanish();
  await wait(1800);

  ok('a board that stops reporting is marked lost', S.state.device.link === 'lost');
  ok('and the outage is written onto the record',
     S.state.telemetry.buffer.some(s => s.gap),
     'without a gap the last sample sits on every readout looking current');
  ok('with nothing left claiming to be current', S.state.telemetry.latest === null);

  feed.stop();
  await link.stop();
}

/* ------------------------------------------------------------------------ */
/* image reassembly                                                          */
/* ------------------------------------------------------------------------ */

{
  /* Driven directly rather than through the board: there is no canvas here, so
     the picture is synthetic, but the chunking and the length check are the
     parts that matter and they are the real ones. */
  S.resetAll();
  const feed = createFeed({});
  const bytes = new Uint8Array(1100).map((_, i) => i % 251);
  const b64 = Buffer.from(bytes).toString('base64');
  const chunks = Math.ceil(bytes.length / IMG_CHUNK_RAW);
  const part = i => Buffer.from(
    bytes.subarray(i * IMG_CHUNK_RAW, (i + 1) * IMG_CHUNK_RAW)).toString('base64');

  feed.handleFrame({ t: 'img', seq: 1, w: 640, h: 480, q: 12, bytes: bytes.length, chunks });
  for (let i = 0; i < chunks - 1; i++) feed.handleFrame({ t: 'imgd', seq: 1, i, d: part(i) });

  ok('an incomplete image is not painted', S.state.frame.kind === null,
     'a half-received frame would show tearing indistinguishable from a sensor fault');

  feed.handleFrame({ t: 'imgd', seq: 1, i: chunks - 1, d: part(chunks - 1) });
  ok('a complete one is', S.state.frame.kind === 'jpeg');
  ok('and it carries the header it was announced with',
     S.state.frame.bytes === bytes.length && S.state.frame.width === 640);

  /* Chunks are indexed rather than assumed to be in order. */
  S.resetAll();
  feed.handleFrame({ t: 'img', seq: 2, w: 64, h: 48, q: 12, bytes: bytes.length, chunks });
  for (let i = chunks - 1; i >= 0; i--) feed.handleFrame({ t: 'imgd', seq: 2, i, d: part(i) });
  ok('chunks arriving out of order still assemble', S.state.frame.kind === 'jpeg');

  /* A short image must be refused, not stretched over. */
  S.resetAll();
  feed.handleFrame({ t: 'img', seq: 3, w: 64, h: 48, q: 12, bytes: bytes.length + 99, chunks });
  for (let i = 0; i < chunks; i++) feed.handleFrame({ t: 'imgd', seq: 3, i, d: part(i) });
  ok('an image that does not match its announced length is refused',
     S.state.frame.kind === null);

  /* Chunks from an abandoned image must not contaminate the next one. */
  S.resetAll();
  feed.handleFrame({ t: 'img', seq: 4, w: 64, h: 48, q: 12, bytes: bytes.length, chunks });
  feed.handleFrame({ t: 'imgd', seq: 4, i: 0, d: part(0) });
  feed.handleFrame({ t: 'img', seq: 5, w: 64, h: 48, q: 12, bytes: bytes.length, chunks });
  feed.handleFrame({ t: 'imgd', seq: 4, i: 1, d: part(1) });
  for (let i = 0; i < chunks; i++) feed.handleFrame({ t: 'imgd', seq: 5, i, d: part(i) });
  ok('a stale chunk from an abandoned image is ignored',
     S.state.frame.kind === 'jpeg' && S.state.frame.seq === 5);

  feed.stop();
}

{
  /* A camera that leaves takes the picture with it. */
  S.resetAll();
  const feed = createFeed({});
  feed.handleFrame({ t: 'caps', camera: { state: 'ok', sensor: 'OV2640' }, i2c: [] });
  S.applyFrame({ kind: 'jpeg', seq: 7, url: 'blob:test', bytes: 100 });

  feed.handleFrame({ t: 'caps', camera: { state: 'absent', sensor: null }, i2c: [] });
  ok('a removed camera drops the frame rather than holding a stale one',
     S.state.frame.kind === null && S.state.frame.url === null);
  ok('and says why', /removed/i.test(S.state.frame.verdict || ''));
  feed.stop();
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
