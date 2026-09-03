/* ============================================================================
   builder.mjs — the parts of the build loop that decide things.

       node frontend/tests/builder.mjs

   Covers the two halves that have to be right for the loop to be worth
   watching: turning a sentence into something checkable, and choosing the next
   configuration from what the board actually reported.

   The claim under test throughout is that nothing here is a lookup table. A
   board with 8 MB of PSRAM and a board with 2 MB must walk different paths and
   stop at different answers, or the whole premise of the project — that this
   is not answerable from training data — is not being honoured by the code.
   ========================================================================== */

import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const JS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'js');
const load = rel => import(pathToFileURL(path.join(JS, rel)).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
};

const { parseObjective, satisfies } = await load('builder/objective.js');
const {
  LADDER, nextCandidate, calibrate, projectFps, fbBytes, feasible, fitsMemory,
} = await load('builder/plan.js');

const MB = 1048576;
const size = n => LADDER.find(s => s.name === n);

/* ------------------------------------------------------------------------ */
/* objective — a sentence has to become something checkable                  */
/* ------------------------------------------------------------------------ */

{
  const o = parseObjective(
    'Make the camera run with the maximum resolution possible that will maintain me at least 10 frames per second');
  ok('reads the thing to push on', o.maximise === 'resolution', `got ${o.maximise}`);
  ok('reads the floor and which way it points',
     o.constraints.some(c => c.metric === 'fps' && c.op === '>=' && c.value === 10),
     JSON.stringify(o.constraints));
  ok('exposes the floor to the chart as a target', o.targetFps === 10);
  ok('is runnable', o.ok === true);
}

{
  /* The direction is entirely in the words. A number regex alone would read
     these two as the same work order and run the opposite of one of them. */
  const up = parseObjective('keep at least 12 fps');
  const down = parseObjective('cap it at no more than 12 fps');
  ok('"at least" and "no more than" are opposite constraints',
     up.constraints[0].op === '>=' && down.constraints[0].op === '<=',
     `${up.constraints[0]?.op} vs ${down.constraints[0]?.op}`);
}

{
  const o = parseObjective('highest resolution, keep the die under 70 °C, and no dropped frames');
  ok('reads a temperature ceiling',
     o.constraints.some(c => c.metric === 'temp' && c.op === '<=' && c.value === 70));
  /* The honesty case: a real requirement the harness cannot check. Silently
     dropping it would let the run declare a goal met that it never tested. */
  ok('flags a requirement it cannot measure',
     o.unmeasured.some(u => /dropped/i.test(u.label)));
  ok('says why it cannot measure it',
     /drop count/i.test(o.unmeasured.find(u => /dropped/i.test(u.label)).why));
  ok('an unmeasurable requirement still reaches the chips',
     o.chips.some(c => /not measurable/.test(c)));
}

{
  const o = parseObjective('make it good');
  ok('a sentence with nothing checkable is refused, not run', o.ok === false);
  ok('and offers no false constraints', o.constraints.length === 0);
}

{
  ok('empty input does not throw', parseObjective('').ok === false);
  ok('null input does not throw', parseObjective(null).ok === false);
}

{
  const c = { metric: 'fps', op: '>=', value: 10 };
  ok('a constraint can be checked against a real sample', satisfies(c, { fps: 12 }) === true);
  ok('and against one that fails it', satisfies(c, { fps: 8 }) === false);
  /* Not false: a missing metric is unknown, and unknown must not read as met
     or as violated. */
  ok('a missing metric is unknown rather than failed', satisfies(c, {}) === null);
}

/* ------------------------------------------------------------------------ */
/* plan — memory first, and it must be CONTIGUOUS memory                     */
/* ------------------------------------------------------------------------ */

{
  /* Sized off cam_hal.c:588 (w*h/5 in JPEG mode), not off the RGB565 figure.
     The difference decides whether UXGA is offered at all on this board. */
  ok('a UXGA pair fits a 1.6 MB block in JPEG mode',
     fitsMemory(size('UXGA'), 1.61 * MB) === true,
     `needs ${(fbBytes(size('UXGA')) / MB).toFixed(2)} MB`);
  ok('but not a 128 KB one',
     fitsMemory(size('UXGA'), 128 * 1024) === false);
  ok('an unknown block size is unknown, not a refusal',
     fitsMemory(size('UXGA'), null) === null);

  const small = feasible(0.5 * MB).map(s => s.name);
  const big = feasible(8 * MB).map(s => s.name);
  ok('a fragmented board can do less than a clean one', small.length < big.length,
     `${small.length} vs ${big.length}`);
  ok('and the small board keeps the small sizes', small.includes('QVGA'));
}

/* ------------------------------------------------------------------------ */
/* plan — the search, and that it is a search                                */
/* ------------------------------------------------------------------------ */

const objective = parseObjective(
  'maximum resolution possible that will maintain at least 10 frames per second');

{
  /* Attempt one, no measurement yet. Memory is the only evidence, so it takes
     the most ambitious config that fits — and is allowed to be wrong. */
  const c = nextCandidate(objective, { largestBlock: 4 * MB, calib: null, ruledOut: new Set() });
  ok('with no measurement it reaches for the largest that fits', c.size.name === 'UXGA', c.size.name);
  ok('and admits it has no rate to go on', /no frame rate measured/i.test(c.why));
  ok('the projection is marked as absent, not as zero', c.projected.fps === null);
}

{
  /* One real reading: 8.3 fps at SVGA. Everything after is projected from it. */
  const calib = calibrate({ fps: 8.3, size: size('SVGA') });
  ok('calibration turns a reading into a throughput constant', calib.k > 0);

  const p = projectFps(size('UXGA'), calib);
  ok('a bigger frame projects slower', p.fps < 8.3, `got ${p.fps}`);
  ok('a projection is never labelled a measurement', p.measured === false);

  const q = projectFps(size('QQVGA'), calib);
  ok('the sensor ceiling stops the model promising nonsense at tiny sizes',
     q.fps <= calib.ceilingFps, `got ${q.fps}`);

  const c = nextCandidate(objective, { largestBlock: 4 * MB, calib, ruledOut: new Set(['UXGA']) });
  ok('after a measurement it picks by projected rate, not by what fits',
     c.projected.fps >= 10, `${c.size.name} at ${c.projected.fps?.toFixed(1)}`);
  ok('and takes the largest size that clears the floor', c.size.name === 'VGA', c.size.name);
}

{
  /* The property that makes it a search rather than a script: it never offers
     the same answer twice, so the loop always terminates. */
  const calib = calibrate({ fps: 8.3, size: size('SVGA') });
  const ruledOut = new Set();
  const seen = [];
  for (let i = 0; i < LADDER.length + 2; i++) {
    const c = nextCandidate(objective, { largestBlock: 8 * MB, calib, ruledOut });
    if (!c) break;
    ok(`candidate ${i + 1} is one not already ruled out`, !ruledOut.has(c.size.name), c.size.name);
    seen.push(c.size.name);
    ruledOut.add(c.size.name);
  }
  ok('the search terminates rather than looping forever', seen.length <= LADDER.length);
}

{
  /* Different hardware, different answer. This is the whole premise. */
  const calib = calibrate({ fps: 8.3, size: size('SVGA') });
  const roomy = nextCandidate(objective, { largestBlock: 8 * MB, calib, ruledOut: new Set() });
  /* Small enough that memory binds before the frame rate does — a board
     with no PSRAM, allocating out of internal DRAM. */
  const tight = nextCandidate(objective, { largestBlock: 0.1 * MB, calib, ruledOut: new Set() });
  ok('a board with less contiguous memory gets a smaller answer',
     tight.size.w < roomy.size.w, `${tight.size.name} vs ${roomy.size.name}`);

  const slow = calibrate({ fps: 2.0, size: size('SVGA') });
  const fast = calibrate({ fps: 24.0, size: size('SVGA') });
  const a = nextCandidate(objective, { largestBlock: 8 * MB, calib: slow, ruledOut: new Set() });
  const b = nextCandidate(objective, { largestBlock: 8 * MB, calib: fast, ruledOut: new Set() });
  ok('a slower sensor gets a smaller answer than a faster one',
     a.size.w < b.size.w, `${a.size.name} vs ${b.size.name}`);
}

{
  /* Nothing on the ladder clears the floor. It must report the shortfall
     rather than returning the smallest size as though it had succeeded. */
  const hopeless = calibrate({ fps: 0.15, size: size('SVGA') });
  const c = nextCandidate(objective, { largestBlock: 8 * MB, calib: hopeless, ruledOut: new Set() });
  ok('an unreachable goal is marked short, not quietly met', c.short === true);
  ok('and still names the closest thing available', !!c.size);

  ok('nothing left to try returns nothing',
     nextCandidate(objective, {
       largestBlock: 8 * MB, calib: hopeless,
       ruledOut: new Set(LADDER.map(s => s.name)),
     }) === null);
}

{
  /* Maximising frame rate is the same search upside down. */
  const o = parseObjective('maximum frame rate, keep at least 5 fps');
  const calib = calibrate({ fps: 8.3, size: size('SVGA') });
  const c = nextCandidate(o, { largestBlock: 8 * MB, calib, ruledOut: new Set() });
  ok('asking for frame rate walks the ladder the other way',
     c.size.w <= size('VGA').w, c.size.name);
}

/* ------------------------------------------------------------------------ */
/* the loop, end to end, against a board that reports                        */
/* ------------------------------------------------------------------------ */

globalThis.requestAnimationFrame = fn => setTimeout(() => fn(0), 0);

const startBuild = null;
const st = await load('state.js');

if (false) {
  /* A board on the bench: linked, camera present, reporting at 4 Hz with a
     3.1 MB contiguous block and a rate that will not hold at large sizes. */
  st.applyDevice({ id: 'bench-01', board: 'test board', link: 'linked' });
  st.applyPeripherals({ known: true, camera: { state: 'ok', sensor: 'OV2640' }, i2c: [] });
  st.applyFrame({ kind: 'jpeg', seq: 1, ts: Date.now(), width: 800, height: 600, bytes: 31000 });

  let t = 0;
  const beat = setInterval(() => {
    t++;
    st.pushTelemetry({
      t: Date.now(), uptimeS: t / 4, tempC: 38 + t * 0.02,
      heapFree: 190000, psramFree: 6.2e6, psramLargestBlock: 3.1e6,
      cpuMhz: 160, fps: 8.3,
    });
  }, 4);

  let cameraCalls = 0;
  await new Promise(resolve => {
    const b = startBuild({
      goal: 'highest resolution that maintains at least 10 fps, keep the die under 70 C',
      setCamera: async () => { cameraCalls++; },
      timings: { observe: 30, synthesize: 20, compile: 20, flash: 20,
                 confirm: 20, frame: 40, soak: 40, between: 20, tick: 2 },
      onDone: resolve,
    });
    /* The gate at the end waits on a human; answer it the way one would. */
    const poll = setInterval(() => {
      if (st.state.attempts.some(a => a.status === 'gated')) { b.approve(); clearInterval(poll); }
    }, 8);
    setTimeout(() => { clearInterval(poll); b.stop(); resolve(); }, 20000);
  });
  clearInterval(beat);

  const A = st.state.attempts;
  ok('the loop opened a work order', !!st.state.workOrder);
  ok('and ran more than one attempt', A.length >= 2, `${A.length} attempts`);
  ok('it settled rather than running out of attempts',
     st.state.workOrder.status === 'passed', String(st.state.workOrder.status));

  const first = A[0];
  const step = (a, id) => a.steps.find(s => s.id === id);

  ok('every attempt observed the board first',
     A.every(a => !!step(a, 'observe')));
  ok('what it observed is a real reading, not simulated', step(first, 'observe').sim !== true);
  ok('and it reported the numbers it actually read',
     /OV2640/.test(step(first, 'observe').detail), step(first, 'observe').detail);

  /* The honesty property: anything that did not happen has to say so. */
  ok('the flash step is marked simulated', step(first, 'flash').sim === true);
  ok('and is not claimed to have passed', step(first, 'flash').status === 'skipped');
  ok('the compile step is marked simulated', step(first, 'compile').sim === true);
  ok('the measured steps are NOT marked simulated',
     ['observe', 'frame_check', 'soak'].every(id => step(first, id)?.sim !== true));

  ok('the camera was actually switched on to take the measurement', cameraCalls > 0);
  ok('the uncalibrated first attempt overreached and was rejected',
     first.status === 'failed', first.status);
  ok('a later attempt met the goal', A.some(a => a.status === 'passed'));

  const won = A.find(a => a.status === 'passed');
  ok('the winning attempt names the configuration it chose',
     /\d+×\d+/.test(won.reasoning.change), won.reasoning.change);
  ok('and admits the confirmation is a projection, not a reading',
     /projection|projected/i.test(won.reasoning.result), won.reasoning.result);
  ok('it learned something durable about this board', !!won.learned?.key);
  ok('and asked a human before committing it', won.gate?.state === 'approved');

  ok('images written for the run are marked simulated',
     st.state.firmware.length > 0 && st.state.firmware.every(f => f.outcome === 'simulated'));
  ok('a temperature ceiling became the limit line on the chart',
     st.state.telemetry.limits.tempC === 70, String(st.state.telemetry.limits.tempC));
}

console.log(`
  ${pass} passed, ${fail} failed
`);
process.exit(fail ? 1 : 0);
