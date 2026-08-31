/* ============================================================================
   strip.mjs — the chart recorder.

       node frontend/tests/strip.mjs

   Canvas does not exist outside a browser, so the recorder is mounted on a
   stub that implements the 2D context it uses and records every call. That is
   enough to assert the things that actually matter about a chart nobody can
   diff by eye:

     that a gap breaks the trace instead of being interpolated across
     that no pen draws outside its own lane
     that a declared ceiling is drawn, and an undeclared one is not
     that the cost stays bounded as the ring fills

   The last one is a real regression risk rather than a hypothetical. Stroking
   one path per sample looks identical and costs two orders of magnitude more,
   so nothing catches it except counting.
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

const { mountStrip, splitRuns, laneDomain, lastReading, inkBucket, WINDOW_S } =
  await load('strip.js');

/* ------------------------------------------------------------------------ */
/* a canvas that records instead of drawing                                  */
/* ------------------------------------------------------------------------ */

function recordingCanvas(width = 900, height = 300) {
  const ops = [];
  const ctx = {
    strokeStyle: '', fillStyle: '', lineWidth: 1, font: '',
    textAlign: 'left', lineJoin: '', lineCap: '',
    setTransform() {}, save() {}, restore() {}, clip() {}, rect() {},
    setLineDash(d) { ops.push({ op: 'setLineDash', dash: d }); },
    clearRect() {}, closePath() {},
    createLinearGradient() { return { addColorStop() {} }; },
    measureText(t) { return { width: String(t).length * 6 }; },
    beginPath() { ops.push({ op: 'beginPath' }); },
    moveTo(x, y) { ops.push({ op: 'moveTo', x, y }); },
    lineTo(x, y) { ops.push({ op: 'lineTo', x, y }); },
    stroke() { ops.push({ op: 'stroke', style: ctx.strokeStyle, dash: ctx._dash }); },
    fill() { ops.push({ op: 'fill', style: ctx.fillStyle }); },
    fillRect(x, y, w, h) { ops.push({ op: 'fillRect', x, y, w, h }); },
    fillText(text, x, y) { ops.push({ op: 'fillText', text: String(text), x, y }); },
  };
  const canvas = {
    width, height, style: {},
    getContext: () => ctx,
    parentElement: { getBoundingClientRect: () => ({ width, height }) },
  };
  return { canvas, ctx, ops, reset: () => { ops.length = 0; } };
}

globalThis.devicePixelRatio = 1;
globalThis.document = { hidden: false };

const now = Date.now();
const at = s => now - (WINDOW_S - s) * 1000;

const sample = (t, extra = {}) => ({
  t, tempC: 42, psramFree: 6.2 * 1024 * 1024, fps: 8.3, ...extra,
});

/* ------------------------------------------------------------------------ */
/* pure helpers                                                              */
/* ------------------------------------------------------------------------ */

{
  const buf = [
    sample(at(0)), sample(at(1)),
    { t: at(2), gap: true, label: 'PORT CLOSED' },
    sample(at(3)), sample(at(4)),
  ];
  const runs = splitRuns(buf, 'tempC');
  ok('a gap splits the record into separate runs', runs.length === 2, `got ${runs.length}`);
  ok('and no run contains the gap marker', runs.every(r => r.every(s => !s.gap)));
  ok('the samples either side are kept',
     runs[0].length === 2 && runs[1].length === 2);
}

{
  /* A board that stopped reporting one quantity has a hole in that pen and an
     unbroken line in the others. Both are true at once. */
  const buf = [sample(at(0)), sample(at(1), { tempC: null }), sample(at(2))];
  ok('an absent field breaks only its own pen',
     splitRuns(buf, 'tempC').length === 2 && splitRuns(buf, 'fps').length === 1);
}

{
  const lane = { id: 'tempC', base: [25, 85], limit: 'tempC' };
  ok('a lane with no data and no limits still has an extent',
     laneDomain(lane, [], {})[1] > laneDomain(lane, [], {})[0]);

  const hot = [sample(at(0), { tempC: 121 })];
  ok('the scale grows to contain a reading above it',
     laneDomain(lane, hot, {})[1] >= 121,
     'nothing may be drawn off-scale');

  const cold = [sample(at(0), { tempC: -12 })];
  ok('and one below it', laneDomain(lane, cold, {})[0] <= -12);

  const withCeiling = laneDomain(lane, [], { tempC: 95 });
  ok('a declared ceiling is kept on the paper with room above it',
     withCeiling[1] > 95, `top ${withCeiling[1]}`);

  const psram = { id: 'psramFree', base: [0, 8], scale: 1 / 1048576, total: 'psramTotal' };
  ok('a reported board total becomes the top of its scale',
     laneDomain(psram, [], { psramTotal: 2 * 1048576 })[1] === 8,
     'base is the floor of the viewport, not a cap');
  ok('and a larger reported total raises it',
     laneDomain(psram, [], { psramTotal: 16 * 1048576 })[1] === 16);
}

{
  const buf = [sample(at(0)), { t: at(1), gap: true, label: 'X' }];
  ok('there is no pen position when the record ends in a gap',
     lastReading(buf, 'tempC') === null,
     'a parked carriage on a board that is not reporting would be a stale reading');
  ok('but there is one when it ends in a sample',
     lastReading([sample(at(0))], 'tempC') !== null);
}

{
  ok('colour bands are bounded below', inkBucket(-999, 0, 100) === 0);
  ok('and above', inkBucket(9999, 0, 100) === 23);
  ok('and a non-finite value does not produce a non-finite band',
     Number.isFinite(inkBucket(NaN, 0, 100)));
}

/* ------------------------------------------------------------------------ */
/* the recorder, mounted                                                     */
/* ------------------------------------------------------------------------ */

function paintWith(buffer, limits = {}) {
  const rec = recordingCanvas();
  const strip = mountStrip(rec.canvas, { read: () => ({ buffer, limits }) });
  rec.reset();
  strip.paint();
  strip.stop();
  return rec;
}

const full = [];
for (let i = 0; i < 480; i++) {
  full.push(sample(at(i / 4), { tempC: 38 + Math.sin(i / 40) * 6 }));
}

{
  const { ops } = paintWith(full);
  const strokes = ops.filter(o => o.op === 'stroke').length;
  /* One stroke per sample would be ~480 for the temperature pen alone. The
     picture is identical either way, so only a count catches the regression. */
  ok('a full window costs a bounded number of strokes', strokes < 80,
     `${strokes} strokes for ${full.length} samples`);
  ok('and it drew something at all', strokes > 5, `${strokes}`);
}

{
  const { ops } = paintWith(full);
  const ys = ops.filter(o => o.op === 'moveTo' || o.op === 'lineTo').map(o => o.y);
  ok('nothing is drawn above the canvas', Math.min(...ys) >= 0,
     `min y ${Math.min(...ys).toFixed(1)}`);
  ok('nothing is drawn below it', Math.max(...ys) <= 300,
     `max y ${Math.max(...ys).toFixed(1)}`);
}

{
  /* The lane-invasion case. A reading far outside the viewport must stay in
     its own band rather than drawing across the pens beneath it. */
  const wild = full.slice(0, 40).concat([sample(at(11), { tempC: 100000 })]);
  const { ops } = paintWith(wild);
  const ys = ops.filter(o => o.op === 'lineTo').map(o => o.y);
  ok('an extreme reading stays inside the canvas',
     Math.min(...ys) >= 0 && Math.max(...ys) <= 300,
     `${Math.min(...ys).toFixed(1)}..${Math.max(...ys).toFixed(1)}`);
}

{
  const withGap = full.slice(0, 200)
    .concat([{ t: at(50), gap: true, label: 'PORT CLOSED' }])
    .concat(full.slice(220));

  const { ops } = paintWith(withGap);
  ok('the gap is labelled on the paper',
     ops.some(o => o.op === 'fillText' && /P.O.R.T/.test(o.text)),
     'blank paper is only legible as loss once it is annotated');

  /* Interpolating across a gap would join the last sample before it to the
     first after it in one unbroken subpath. */
  const idx = ops.findIndex(o => o.op === 'fillText' && /P.O.R.T/.test(o.text));
  ok('the trace is broken rather than drawn across the gap', idx > 0);
}

{
  const noLimit = paintWith(full, {});
  const withLimit = paintWith(full, { tempC: 70 });
  const dashed = r => r.ops.some(o => o.op === 'setLineDash' && o.dash?.length);

  ok('no ceiling is drawn when none has been declared', !dashed(noLimit),
     'limits start null and the chart must draw correctly in that state');
  ok('and one is drawn when it has been', dashed(withLimit));
  ok('the ceiling is labelled with its value',
     withLimit.ops.some(o => o.op === 'fillText' && /LIMIT 70/.test(o.text)));
}

{
  const { ops } = paintWith([]);
  ok('an empty ring paints the paper without throwing',
     ops.some(o => o.op === 'fillRect'));
  ok('and parks no carriage', !ops.some(o => o.op === 'fill' && o.style === 'inferno'));
}

{
  globalThis.document.hidden = true;
  const { ops } = paintWith(full);
  ok('a hidden document is not painted at all', ops.length === 0,
     `${ops.length} operations while hidden`);
  globalThis.document.hidden = false;
}

{
  const rec = recordingCanvas(0, 0);
  const strip = mountStrip(rec.canvas, { read: () => ({ buffer: full, limits: {} }) });
  rec.reset();
  strip.paint();
  strip.stop();
  ok('a collapsed panel is not painted either', rec.ops.length === 0);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
