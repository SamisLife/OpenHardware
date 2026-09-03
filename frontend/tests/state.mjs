/* ============================================================================
   state.mjs — the write path.

       node frontend/tests/state.mjs

   No dependencies and no runner, for the same reason the frontend has no build
   step: a test somebody has to install something to run is a test that stops
   being run.

   Everything the instrument shows passes through this module, so a defect here
   is a defect in every panel at once. The properties worth pinning down are the
   ones that are invisible until they are wrong: that a partial write does not
   blank what it did not mention, that a burst of writes causes one render pass
   rather than five, and that a value which is not a measurement never reaches
   a readout looking like one.
   ========================================================================== */

import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const JS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'js');
const S = await import(pathToFileURL(path.join(JS, 'state.js')).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  — ' + extra : ''}`); }
};

/** Let the coalescing scheduler fire. */
const tick = () => new Promise(r => setTimeout(r, 5));

const sample = (t, extra = {}) => ({
  t, uptimeS: t / 1000, tempC: 38.2, heapFree: 190000, heapTotal: 327680,
  psramFree: 6.2e6, psramLargestBlock: 3.1e6, rssi: -57, cpuMhz: 240,
  fps: 8.3, ...extra,
});

/* ------------------------------------------------------------------------ */
/* nothing is claimed before something says so                               */
/* ------------------------------------------------------------------------ */

{
  const L = S.state.telemetry.limits;
  /* The regression this guards: a hardcoded 320 KB heap total is right for one
     chip and wrong for the next, and a headroom bar over an invented
     denominator looks exactly like one over a real number. */
  ok('no board constant is guessed at startup',
     L.heapTotal === null && L.psramTotal === null && L.tempCritC === null,
     JSON.stringify(L));
  ok('no ceiling is declared before a work order declares one', L.tempC === null);
  ok('no source is claimed before one is driving', S.state.ui.source === null);
  ok('nothing is claimed about attached hardware', S.state.peripherals.known === false);
  ok('the link starts offline, not linked', S.state.device.link === 'offline');
}

/* ------------------------------------------------------------------------ */
/* subscription and coalescing                                               */
/* ------------------------------------------------------------------------ */

{
  let calls = 0;
  let seen = null;
  const off = S.subscribe((_s, changed) => { calls++; seen = changed; });

  S.applyDevice({ id: 'bench-01' });
  S.pushTelemetry(sample(1000));
  S.applyFrame({ seq: 1 });
  await tick();

  ok('a burst of writes causes exactly one render pass', calls === 1, `got ${calls}`);
  ok('and reports every slice that changed',
     seen.has('device') && seen.has('telemetry') && seen.has('frame'),
     [...seen].join(','));

  calls = 0;
  off();
  S.applyDevice({ id: 'bench-02' });
  await tick();
  ok('unsubscribe actually unsubscribes', calls === 0, `got ${calls}`);
}

{
  /* One bad listener must not stop the rest of the page painting. */
  const order = [];
  const offA = S.subscribe(() => { order.push('a'); throw new Error('boom'); });
  const offB = S.subscribe(() => order.push('b'));

  const err = console.error;
  console.error = () => {};
  S.applyDevice({ id: 'bench-03' });
  await tick();
  console.error = err;

  ok('a listener that throws does not stop the others', order.includes('b'));
  offA(); offB();
}

/* ------------------------------------------------------------------------ */
/* patches are patches                                                       */
/* ------------------------------------------------------------------------ */

{
  S.applyDevice({ id: 'bench-04', board: 'a board', mac: 'AA:BB' });
  S.applyDevice({ link: 'linked' });
  ok('a partial write does not blank what it did not mention',
     S.state.device.board === 'a board' && S.state.device.mac === 'AA:BB');
  ok('and applies what it did', S.state.device.link === 'linked');

  S.applyDevice({ firmware: { version: '0.1.0' } });
  S.applyDevice({ firmware: { sha: 'abc1234' } });
  ok('nested firmware merges rather than replacing',
     S.state.device.firmware.version === '0.1.0'
     && S.state.device.firmware.sha === 'abc1234',
     JSON.stringify(S.state.device.firmware));
}

/* ------------------------------------------------------------------------ */
/* telemetry                                                                 */
/* ------------------------------------------------------------------------ */

{
  S.resetAll();
  S.pushTelemetry(sample(1000));
  S.pushTelemetry(sample(1250));
  ok('samples in order are kept', S.state.telemetry.buffer.length === 2);

  S.pushTelemetry(sample(1100));
  ok('an out-of-order sample is dropped, not sorted in',
     S.state.telemetry.buffer.length === 2, 'a chart that rewrites history is a lie');
  S.pushTelemetry(sample(1250));
  ok('and so is a duplicate timestamp', S.state.telemetry.buffer.length === 2);

  ok('the latest sample is the newest one', S.state.telemetry.latest.t === 1250);
  ok('lastSeen follows the newest sample', S.state.device.lastSeen === 1250);

  S.pushTelemetry({ uptimeS: 5 });
  ok('a sample with no timestamp is refused', S.state.telemetry.buffer.length === 2);
  ok('and so is nothing at all', (S.pushTelemetry(null), S.state.telemetry.buffer.length === 2));
}

{
  S.resetAll();
  for (let i = 0; i < S.BUFFER_LEN + 40; i++) S.pushTelemetry(sample(1000 + i * 250));
  ok('the ring is bounded', S.state.telemetry.buffer.length === S.BUFFER_LEN,
     String(S.state.telemetry.buffer.length));
  ok('and it drops the oldest, not the newest',
     S.state.telemetry.buffer[S.BUFFER_LEN - 1].t === 1000 + (S.BUFFER_LEN + 39) * 250);
}

{
  /* The sentinel case. Firmware signals "no temperature sensor" with an
     absolute-zero reading; unguarded it renders as a confident -273.0 °C with
     343 degrees of headroom, which is worse than showing nothing. */
  S.resetAll();
  S.pushTelemetry(sample(1000, { tempC: -273 }));
  ok('an impossible temperature is nulled, not shown',
     S.state.telemetry.latest.tempC === null);
  ok('but the rest of that sample survives',
     S.state.telemetry.latest.fps === 8.3 && S.state.telemetry.latest.heapFree === 190000);

  S.pushTelemetry(sample(1250, { rssi: 0 }));
  ok('a zero RSSI is kept — it is out of range, so it is not a reading',
     S.state.telemetry.latest.rssi === 0,
     'zero dBm is within the plausible band; the renderer decides how to show it');

  S.pushTelemetry(sample(1500, { fps: NaN, cpuMhz: undefined }));
  ok('NaN becomes absent', S.state.telemetry.latest.fps === null);
  ok('undefined becomes absent', S.state.telemetry.latest.cpuMhz === null);
}

/* ------------------------------------------------------------------------ */
/* gaps                                                                      */
/* ------------------------------------------------------------------------ */

{
  S.resetAll();
  S.pushTelemetry(sample(1000));
  S.pushGap(1500, 'PORT CLOSED');

  ok('a gap is recorded in the buffer', S.state.telemetry.buffer.length === 2);
  ok('and it carries its label', S.state.telemetry.buffer[1].label === 'PORT CLOSED');
  /* Holding the last sample across a gap is what makes a readout show a stale
     number as though it were current. */
  ok('nothing is live across a gap', S.state.telemetry.latest === null);

  S.pushGap(1600, 'STILL GONE');
  S.pushGap(1700, 'STILL GONE');
  ok('consecutive gaps collapse into one outage',
     S.state.telemetry.buffer.filter(s => s.gap).length === 1);

  S.pushTelemetry(sample(2000));
  S.pushGap(2500, 'AGAIN');
  ok('but a later outage is its own gap',
     S.state.telemetry.buffer.filter(s => s.gap).length === 2);
  ok('and telemetry resumes after one', S.state.telemetry.buffer[2].t === 2000);
}

/* ------------------------------------------------------------------------ */
/* attempts                                                                  */
/* ------------------------------------------------------------------------ */

{
  S.resetAll();
  S.upsertAttempt({ n: 2, status: 'running' });
  S.upsertAttempt({ n: 1, status: 'failed' });
  ok('attempts sort ascending however they arrive',
     S.state.attempts.map(a => a.n).join(',') === '1,2');
  ok('a new attempt gets somewhere to put steps',
     Array.isArray(S.state.attempts[0].steps));

  S.upsertAttempt({ n: 1, steps: [{ id: 'observe', status: 'running' }] });
  S.upsertAttempt({ n: 1, steps: [{ id: 'compile', status: 'running' }] });
  ok('a second step is added, not swapped in',
     S.state.attempts[0].steps.length === 2);

  S.upsertAttempt({ n: 1, steps: [{ id: 'observe', status: 'pass', ms: 900 }] });
  const observe = S.state.attempts[0].steps.find(s => s.id === 'observe');
  ok('an existing step is updated in place by id', observe.status === 'pass');
  ok('and keeps the fields the update did not mention', observe.ms === 900);
  ok('without disturbing its neighbours',
     S.state.attempts[0].steps.find(s => s.id === 'compile').status === 'running');

  S.upsertAttempt({ n: 1, reasoning: { observed: 'x' } });
  S.upsertAttempt({ n: 1, reasoning: { result: 'y' } });
  ok('reasoning fields merge rather than replace',
     S.state.attempts[0].reasoning.observed === 'x'
     && S.state.attempts[0].reasoning.result === 'y');

  S.upsertAttempt({ status: 'running' });
  ok('an attempt with no number is refused', S.state.attempts.length === 2);
}

/* ------------------------------------------------------------------------ */
/* resets                                                                    */
/* ------------------------------------------------------------------------ */

{
  S.resetAll();
  S.pushTelemetry(sample(1000));
  S.applyPeripherals({ known: true, camera: { state: 'ok', sensor: 'OV2640' } });
  S.upsertAttempt({ n: 1, status: 'passed' });
  S.applyFirmware([{ version: '0.1.0' }]);

  S.resetAttempts();
  ok('abandoning a work order forgets the attempts', S.state.attempts.length === 0);
  ok('but keeps the independently built image history', S.state.firmware.length === 1);
  /* The board is still doing whatever it was doing. */
  ok('but says nothing about the hardware', S.state.peripherals.known === true);
  ok('and leaves the record of it intact', S.state.telemetry.buffer.length === 1);

  S.resetAll();
  ok('a full reset clears telemetry', S.state.telemetry.buffer.length === 0);
  ok('and forgets what was attached', S.state.peripherals.known === false);
  ok('and returns the limits to unknown',
     S.state.telemetry.limits.psramTotal === null);
  ok('and stops claiming a link', S.state.device.link === 'offline');
}

{
  S.applyLimits({ psramTotal: 8388608 });
  ok('a reported board constant is recorded',
     S.state.telemetry.limits.psramTotal === 8388608);
  S.applyLimits({ tempC: 70 });
  ok('and a declared ceiling does not disturb it',
     S.state.telemetry.limits.psramTotal === 8388608
     && S.state.telemetry.limits.tempC === 70);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
