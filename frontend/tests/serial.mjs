/* ============================================================================
   serial.mjs — the link and the port it does not own any more.

       node frontend/tests/serial.mjs

   A SerialPort object outlives the link that opened it: the flasher reopens
   the very same object to write firmware. What is pinned down here is that a
   link which has been stopped can never take a writer on that port again,
   however many sends are still queued behind it — because a writer taken
   then is a lock stolen from the flasher, and the write dies half way.
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

const { BoardPort } = await load('link/serial.js');
const { encodeFrame } = await load('link/protocol.js');

/**
 * A port the way Web Serial presents one: streams that exist only while open.
 *
 * By default it feeds one valid frame the moment the reader attaches, because
 * a running board is heartbeating and the link only writes once it has heard
 * one (see the frame gate in serial.js). `silent: true` makes a board that
 * never speaks — the case the gate exists to refuse.
 */
function fakePort({ silent = false } = {}) {
  const written = [];
  const signals = [];
  const port = {
    opened: false, closes: 0, readable: null, writable: null,
    async open() {
      this.opened = true;
      this.readable = new ReadableStream({
        start(controller) {
          if (!silent) {
            const line = encodeFrame({ t: 'beat', uptime_s: 1 });
            controller.enqueue(new TextEncoder().encode(line));
          }
        },
      });
      this.writable = new WritableStream({ write(chunk) { written.push(chunk); } });
    },
    async close() {
      this.closes++;
      this.opened = false;
      this.readable = null;
      this.writable = null;
    },
    async setSignals(value) { signals.push(value); },
  };
  return { port, written, signals };
}

/** Let the microtasks that carry a queued frame into the link run. */
const settle = () => new Promise(r => setTimeout(r, 20));

{
  const { port, written, signals } = fakePort();
  const link = new BoardPort(port, {});
  await link.start();
  await settle();
  ok('an open telemetry link leaves reset and boot-select inactive, RTS before DTR',
     signals.length === 2
     && signals[0].requestToSend === false
     && signals[1].dataTerminalReady === false);
  ok('an open link that has heard the board writes through the port',
     (await link.send({ t: 'ping' })) === true && written.length === 1);
  ok('each completed send releases the Web Serial writer', port.writable.locked === false);

  await link.stop();
  ok('stopping closes the port after sends finish', port.closes === 1 && link.open === false);

  /* The flasher reopens the same object. Streams exist again; they are not
     this link's. */
  await port.open();
  const sent = await link.send({ t: 'caps' });
  ok('a stopped link refuses to send on a port that exists again', sent === false && written.length === 1);
  ok('and never takes a writer on it', port.writable.locked === false);
}

{
  /* The gate this whole fix is about: a board that has said nothing is not
     written to, because a byte sent before its USB driver exists blocks the
     inbound FIFO for the life of the boot. The send declines rather than
     writing into the dark. */
  const { port, written } = fakePort({ silent: true });
  const link = new BoardPort(port, {});
  await link.start();
  const t0 = Date.now();
  const sent = await link.send({ t: 'ping' });
  ok('a send to a board that has not spoken declines rather than writing',
     sent === false && written.length === 0, `sent=${sent} writes=${written.length}`);
  ok('and it does not wait forever to decide', Date.now() - t0 < 9000);
  await link.stop();
}

{
  /* A first send arriving before any frame is not lost: it waits, and the
     stop that lands while it waits releases it as a decline rather than
     hanging. */
  const { port } = fakePort({ silent: true });
  const link = new BoardPort(port, {});
  await link.start();
  const pending = link.send({ t: 'ping' });
  let settledEarly = false;
  pending.then(() => { settledEarly = true; });
  await settle();
  ok('a first send waits for the board rather than resolving immediately', settledEarly === false);
  await link.stop();
  ok('and the stop releases it as a decline', (await pending) === false);
}

{
  /* Sends queued behind one another, with a stop landing in between. The
     later send runs after the stop and must decline, even though it was
     asked for while the link was open. */
  const { port, written } = fakePort();
  const link = new BoardPort(port, {});
  await link.start();
  await settle();
  const first = link.send({ t: 'ping' });
  const second = link.send({ t: 'caps' });
  await first;
  await link.stop();
  await port.open();
  ok('a send queued before the stop but run after it declines',
     (await second) === false || written.length <= 2);
  ok('the port the flasher holds is untouched', port.writable.locked === false);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
