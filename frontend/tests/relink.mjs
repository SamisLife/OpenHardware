/* ============================================================================
   relink.mjs — surviving the cable coming out.

       node frontend/tests/relink.mjs

   Automatic reconnection is the one feature here that can do harm by working
   too eagerly. A serial port is exclusive across the whole machine, so a
   console that reclaims a board the instant it appears will take it from
   whoever is actually using it — and the tab that loses the race reports a
   board that is sitting right there on the bus as unreachable.

   So most of what is checked below is restraint: that a background tab defers,
   that a disposed session lets go, that bring-up keeps the port while it is
   running, and that nothing is ever opened speculatively to find out whether a
   board is there.
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

/* A document whose visibility the test controls, and a bus that can be told a
   board arrived. Both are the real interfaces the code listens on. */
const listeners = { doc: {}, bus: {}, win: {} };
globalThis.document = {
  hidden: false,
  addEventListener: (t, fn) => { listeners.doc[t] = fn; },
  removeEventListener: t => { delete listeners.doc[t]; },
};
/* Node defines navigator as a getter-only property, so it is redefined rather
   than assigned. The code under test reads navigator.serial directly, and a
   stub anywhere else would not exercise the path that matters. */
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    serial: {
      addEventListener: (t, fn) => { listeners.bus[t] = fn; },
      removeEventListener: t => { delete listeners.bus[t]; },
    },
  },
});
globalThis.addEventListener = (t, fn) => { listeners.win[t] = fn; };
globalThis.removeEventListener = t => { delete listeners.win[t]; };

const { Session } = await load('onboard/session.js');
const { simulatedDriver } = await load('link/drivers.js');
const { state } = await load('state.js');

const wait = ms => new Promise(r => setTimeout(r, ms));

/**
 * A driver that behaves like the cable: it reports which ports are present,
 * counts how many times a port is opened, and can be told the board went away.
 */
function cableDriver() {
  const base = simulatedDriver('');
  let present = true;
  const counts = { opened: 0 };

  return {
    ...base,
    /* Not simulated, so relink arms. The transport underneath is still the
       simulated board, which is the point: the reconnection logic is what is
       under test, not the wire. */
    simulated: false,
    blockedReason: () => null,
    async portsLike() { return present ? [{ id: 'port-a' }] : []; },
    async openPort(port, handlers) {
      counts.opened++;
      if (!present) throw new Error('device gone');
      return base.openPort(port, handlers);
    },
    unplug() { present = false; },
    replug() { present = true; },
    counts,
  };
}

/** Drive a session to the point where the instrument has taken over. */
async function live(driver) {
  const s = new Session(driver, () => {});
  await s.connect();
  await s.continueWithBoard();
  await s.skipNetwork();
  await wait(500);
  return s;
}

/* ------------------------------------------------------------------------ */

{
  const d = cableDriver();
  const s = await live(d);

  ok('bring-up reaches telemetry', s.state.phase === 'done', s.state.phase);
  ok('and reconnection is armed only once it has', s._relinkArmed === true);
  ok('by listening on the bus rather than polling it',
     typeof listeners.bus.connect === 'function');
  ok('and it releases the port if the document goes away',
     typeof listeners.win.pagehide === 'function');

  await s.dispose();
  ok('a disposed session stops listening', listeners.bus.connect === undefined,
     'otherwise it grabs the port out from under its successor');
  ok('and disarms itself', s._relinkArmed === false);
}

/* ------------------------------------------------------------------------ */

{
  const d = cableDriver();
  const s = await live(d);
  const before = d.counts.opened;

  /* The board leaves. What must NOT happen is a hunt for it. */
  d.unplug();
  await s.closeLink();
  await s.relink('the port closed');

  ok('a board that is not on the bus is not chased',
     d.counts.opened === before,
     `${d.counts.opened - before} opens against a bus reporting no ports`);
  ok('and the attempt is on the record',
     s.monitor.some(l => /no permitted serial port matches/.test(l.text)));

  /* It comes back, and the bus says so. */
  d.replug();
  const ok2 = await s.relink('a board appeared on the bus');
  ok('a board that is back is picked up again', ok2 === true);
  ok('the link is open once more', s.link?.open === true);
  ok('and the telemetry rung says so', s.state.rungs.telemetry.state === 'done');

  /* What the previous boot said about what is attached does not survive. A
     board that just re-enumerated has rediscovered its own hardware. */
  ok('what was attached is asked again rather than assumed',
     state.peripherals.known === false || state.peripherals.streaming === false,
     JSON.stringify(state.peripherals));

  await s.dispose();
}

/* ------------------------------------------------------------------------ */

{
  /* The restraint that matters most. */
  const d = cableDriver();
  const s = await live(d);
  await s.closeLink();

  globalThis.document.hidden = true;
  const took = await s.relink('a board appeared on the bus');
  globalThis.document.hidden = false;

  ok('a background tab does not take the port', took === false);
  ok('and says why, rather than failing silently',
     s.monitor.some(l => /this tab is in the background/.test(l.text)));

  /* Deferred, not dropped: coming back to the tab retries. */
  ok('returning to the tab is what retries it',
     typeof listeners.doc.visibilitychange === 'function');

  await s.dispose();
}

/* ------------------------------------------------------------------------ */

{
  /* Bring-up owns the port while it runs, or a reconnect would fight the
     flow that is deliberately holding the board. */
  const d = cableDriver();
  const s = new Session(d, () => {});
  await s.connect();

  const took = await s.relink('a board appeared on the bus');
  ok('reconnection does not interfere with bring-up in progress', took === false,
     `phase was ${s.state.phase}`);

  await s.dispose();
}

/* ------------------------------------------------------------------------ */

{
  /* A simulated board has no bus to reappear on, and a real one plugged in
     during ?sim must not be adopted by a simulated session. */
  const s = await live(simulatedDriver(''));
  ok('a simulated session never arms reconnection', s._relinkArmed === false);
  await s.dispose();
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
