/* ============================================================================
   strip.js — the chart recorder.
   ----------------------------------------------------------------------------
   A paper chart recorder, drawn honestly: three pens on a shared time axis,
   paper moving right to left at a constant rate driven by the WALL CLOCK rather
   than by sample arrival.

   That distinction is the whole design. When a board reboots, samples stop but
   the paper keeps moving, so the loss of signal becomes a widening band of
   blank paper that can be watched growing. A chart that only advanced on new
   data would compress an outage into nothing and hide the exact event this
   instrument exists to make visible. Gaps are never interpolated across.

   ----------------------------------------------------------------------------
   COST

   Paper moves about 8 px per second. Repainting at display refresh rate
   therefore redraws a pixel-identical image roughly seven times out of eight,
   and doing it by stroking one path per sample costs tens of thousands of
   canvas operations a second for no visible difference. Three things keep that
   down, and they are in the first version rather than added later:

     paced        painting is capped well below refresh rate, skipped entirely
                  while the document is hidden or the canvas has no size
     bucketed     the temperature pen quantises its colour into a small number
                  of bands and strokes one path per band-run, so a smooth trace
                  costs a handful of strokes instead of one per sample
     memoised     splitting the ring into contiguous runs is recomputed only
                  when the ring actually changes

   ----------------------------------------------------------------------------
   SCALES

   A lane's vertical extent is a viewport, not a claim. It starts at a sensible
   range for the quantity, grows to contain whatever the board actually
   reported, and grows again to keep a declared limit on the paper. Nothing is
   ever drawn off-scale, and no reading is ever silently outside the frame.

   `telemetry.limits` may be entirely null — no board has reported its totals
   and no work order has declared a ceiling — and every lane draws correctly in
   that state, without a limit line and without inventing a denominator.
   ========================================================================== */

import { inferno, num } from './format.js';

/** Seconds of paper visible at once. Matches BUFFER_LEN at 4 Hz. */
export const WINDOW_S = 120;

const MB = 1024 * 1024;

/** Painting cadence. Paper moves ~8 px/s, so 20 Hz is already generous. */
const FRAME_MS = 50;
/** Under reduced motion the paper still advances, at the sample rate. */
const FRAME_MS_REDUCED = 250;

/** Colour bands for the graded pen. Fewer bands, fewer stroke calls. */
const INK_STEPS = 24;
const INFERNO_LUT = Array.from({ length: INK_STEPS },
  (_, i) => inferno(i / (INK_STEPS - 1)));

/**
 * The pens.
 *
 * `base` is the starting viewport. `total` names a board constant in
 * telemetry.limits that, when reported, becomes the top of the scale. `limit`
 * names a declared ceiling to draw as a line — absent means no line.
 */
const LANES = [
  {
    id: 'tempC', label: 'DIE TEMP', unit: '°C', weight: 1.55,
    decimals: 1, ink: 'inferno', base: [25, 85], limit: 'tempC',
  },
  {
    id: 'psramFree', label: 'PSRAM FREE', unit: 'MB', weight: 1.15,
    decimals: 2, ink: '#8fb0b8', scale: 1 / MB, base: [0, 8],
    total: 'psramTotal',
  },
  {
    id: 'fps', label: 'FRAME RATE', unit: 'fps', weight: 1,
    decimals: 1, ink: '#a89f93', step: true, base: [0, 30],
  },
];

/** The first finite application metric in the retained window, if any. */
export function appLane(buffer) {
  for (const sample of buffer || []) {
    if (sample?.gap) continue;
    for (const key of Object.keys(sample || {})) {
      if (key.startsWith('app.') && Number.isFinite(sample[key])) {
        return {
          id: key, label: `APP ${key.slice(4)}`, unit: '', weight: 1,
          decimals: 2, ink: '#d8a657', base: [0, 1], auto: true,
        };
      }
    }
  }
  return null;
}

const PAPER = '#0f0e0d';
const RULE = '#191715';
const RULE_MINUTE = '#161413';
const SEAM = '#221f1d';
const AXIS_BG = '#0c0b0a';
const INK_LABEL = '#6e675e';
const INK_VALUE = '#ece6dd';
const INK_DIM = '#494340';
const INK_SCALE = '#3d3835';
const AMBER = '255,176,0';
const RED = '255,75,62';

/* ------------------------------------------------------------------------ */
/* pure helpers, shared with the tests                                       */
/* ------------------------------------------------------------------------ */

/**
 * Split a ring into contiguous runs of drawable samples.
 *
 * A run ends at an explicit gap marker and also at any sample where the field
 * is absent — a board that stopped reporting one quantity has a hole in that
 * pen and a continuous line in the others, which is the truth about what
 * arrived.
 */
export function splitRuns(buffer, key) {
  const runs = [];
  let cur = null;
  for (const s of buffer) {
    if (s.gap || !Number.isFinite(s[key])) {
      if (cur) { runs.push(cur); cur = null; }
    } else {
      if (!cur) cur = [];
      cur.push(s);
    }
  }
  if (cur) runs.push(cur);
  return runs;
}

/**
 * The vertical extent for one lane: a viewport wide enough to contain the
 * data, the reported total and any declared ceiling.
 */
export function laneDomain(lane, buffer, limits = {}) {
  const scale = lane.scale || 1;
  let [lo, hi] = lane.auto ? [Infinity, -Infinity] : lane.base;

  const total = lane.total ? limits[lane.total] : null;
  if (Number.isFinite(total) && total > 0) hi = Math.max(hi, total * scale);

  const ceiling = lane.limit ? limits[lane.limit] : null;
  /* A ceiling sitting exactly on the top edge is a ceiling nobody can see
     the trace approach, so the scale is opened a little past it. */
  if (Number.isFinite(ceiling)) hi = Math.max(hi, ceiling * scale * 1.08);

  for (const s of buffer) {
    if (s.gap) continue;
    const v = s[lane.id];
    if (!Number.isFinite(v)) continue;
    const x = v * scale;
    if (x < lo) lo = x;
    if (x > hi) hi = x;
  }

  if (!Number.isFinite(lo) || !Number.isFinite(hi)) [lo, hi] = lane.base;
  if (!(hi > lo)) {
    const pad = Math.max(1, Math.abs(lo) * 0.05);
    lo -= pad;
    hi += pad;
  } else if (lane.auto) {
    const pad = (hi - lo) * 0.08;
    lo -= pad;
    hi += pad;
  }
  return [lo, hi];
}

/** Which colour band a value falls in. */
export function inkBucket(value, lo, hi) {
  const t = (value - lo) / (hi - lo);
  const i = Math.round(Math.max(0, Math.min(1, t)) * (INK_STEPS - 1));
  return Number.isFinite(i) ? i : 0;
}

/** The most recent drawable sample, or null when the record ends in a gap. */
export function lastReading(buffer, key) {
  for (let i = buffer.length - 1; i >= 0; i--) {
    if (buffer[i].gap) return null;
    if (Number.isFinite(buffer[i][key])) return buffer[i];
  }
  return null;
}

/* ------------------------------------------------------------------------ */

/**
 * Mount the recorder on a canvas.
 *
 * @param {HTMLCanvasElement} el
 * @param {{ read: () => object }} opts  `read` returns the telemetry slice:
 *        { buffer, limits }. Injected rather than imported so the recorder has
 *        no opinion about where the model lives.
 * @returns {{ stop: () => void, paint: () => void }}
 */
export function mountStrip(el, { read } = {}) {
  const canvas = el;
  const ctx = canvas.getContext('2d');
  const getState = read || (() => ({ buffer: [], limits: {} }));

  let dpr = 1;
  let raf = 0;
  let reduced = false;
  let lastPaint = -Infinity;
  let stopped = false;

  /** lane id -> { sig, runs, domain } */
  const prepared = new Map();

  const mq = typeof matchMedia === 'function'
    ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  if (mq) {
    reduced = !!mq.matches;
    mq.addEventListener?.('change', e => { reduced = e.matches; });
  }

  const ro = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => resize()) : null;
  if (ro && canvas.parentElement) ro.observe(canvas.parentElement);

  resize();

  if (typeof requestAnimationFrame === 'function') {
    const loop = now => {
      if (stopped) return;
      raf = requestAnimationFrame(loop);
      const budget = reduced ? FRAME_MS_REDUCED : FRAME_MS;
      if (now - lastPaint < budget) return;
      lastPaint = now;
      paint();
    };
    raf = requestAnimationFrame(loop);
  }

  function resize() {
    const box = canvas.parentElement?.getBoundingClientRect?.()
      || { width: canvas.width || 0, height: canvas.height || 0 };
    dpr = Math.min(2, (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1) || 1);
    canvas.width = Math.max(0, Math.round(box.width * dpr));
    canvas.height = Math.max(0, Math.round(box.height * dpr));
    if (canvas.style) {
      canvas.style.width = `${box.width}px`;
      canvas.style.height = `${box.height}px`;
    }
    prepared.clear();
    paint();
  }

  function paint() {
    /* A hidden document and a collapsed panel both cost the same to draw as a
       visible one, and neither can be seen. */
    if (!ctx || !canvas.width || !canvas.height) return;
    if (typeof document !== 'undefined' && document.hidden) return;

    const { buffer = [], limits = {} } = getState() || {};

    const W = canvas.width / dpr;
    const H = canvas.height / dpr;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const gutter = W < 620 ? 72 : 116;
    const plotX = gutter;
    const plotW = Math.max(10, W - gutter - 10);
    const axisH = 16;
    const plotH = Math.max(10, H - axisH);

    const now = Date.now();
    const t0 = now - WINDOW_S * 1000;
    const xOf = t => plotX + ((t - t0) / (WINDOW_S * 1000)) * plotW;

    ctx.fillStyle = PAPER;
    ctx.fillRect(plotX, 0, plotW, plotH);

    const dynamic = appLane(buffer);
    const lanes = dynamic ? [...LANES, dynamic] : LANES;
    const totalWeight = lanes.reduce((s, l) => s + l.weight, 0);
    let y = 0;
    for (const lane of lanes) {
      const lh = (plotH * lane.weight) / totalWeight;
      drawLane(lane, buffer, limits, plotX, y, plotW, lh, gutter, xOf, now,
               lane === lanes[lanes.length - 1]);
      y += lh;

      ctx.strokeStyle = SEAM;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(W, Math.round(y) + 0.5);
      ctx.stroke();
    }

    drawTimeAxis(plotX, plotH, plotW, axisH);
    drawGaps(buffer, xOf, plotX, plotW, plotH, now);
  }

  /** Runs and domain for a lane, recomputed only when the ring changed. */
  function prepare(lane, buffer, limits) {
    const first = buffer[0];
    const last = buffer[buffer.length - 1];
    const sig = `${buffer.length}|${first ? first.t : 0}|${last ? last.t : 0}`
              + `|${limits[lane.total] ?? ''}|${limits[lane.limit] ?? ''}`;

    let rec = prepared.get(lane.id);
    if (!rec || rec.sig !== sig) {
      rec = {
        sig,
        runs: splitRuns(buffer, lane.id),
        domain: laneDomain(lane, buffer, limits),
        last: lastReading(buffer, lane.id),
      };
      prepared.set(lane.id, rec);
    }
    return rec;
  }

  function drawLane(lane, buffer, limits, px, py, pw, ph, gutter, xOf, now, isLast) {
    const narrow = gutter < 100;
    const scale = lane.scale || 1;
    const { runs, domain, last } = prepare(lane, buffer, limits);
    const [lo, hi] = domain;

    /* Clamped to the lane. A reading outside the viewport is still a reading
       and still belongs to this pen — letting it draw where it lands would
       take it across the lanes below, which would read as their data. */
    const top = py + 4;
    const bottom = py + ph - 4;
    const yOf = v => {
      const raw = bottom - ((v * scale - lo) / (hi - lo)) * (bottom - top);
      return raw < top ? top : raw > bottom ? bottom : raw;
    };

    ctx.strokeStyle = RULE;
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const gy = Math.round(py + (ph * i) / 4) + 0.5;
      ctx.beginPath(); ctx.moveTo(px, gy); ctx.lineTo(px + pw, gy); ctx.stroke();
    }

    ctx.strokeStyle = RULE_MINUTE;
    for (let s = 0; s <= WINDOW_S; s += 15) {
      const gx = Math.round(xOf(now - s * 1000)) + 0.5;
      if (gx < px) continue;
      ctx.beginPath(); ctx.moveTo(gx, py); ctx.lineTo(gx, py + ph); ctx.stroke();
    }

    /* A declared ceiling, and only when one has been declared. */
    const ceiling = lane.limit ? limits[lane.limit] : null;
    if (Number.isFinite(ceiling)) {
      const ly = Math.round(yOf(ceiling)) + 0.5;
      ctx.save();
      ctx.strokeStyle = `rgba(${RED},0.55)`;
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(px, ly); ctx.lineTo(px + pw, ly); ctx.stroke();
      ctx.restore();
      ctx.fillStyle = `rgba(${RED},0.72)`;
      ctx.font = '9px "IBM Plex Mono", ui-monospace, monospace';
      ctx.textAlign = 'left';
      ctx.fillText(`LIMIT ${num(ceiling, 0)}`, px + 6, ly - 4);
    }

    for (const run of runs) {
      if (!run.length) continue;

      if (run.length > 1) {
        ctx.beginPath();
        ctx.moveTo(xOf(run[0].t), py + ph);
        traceInto(run, lane, xOf, yOf);
        ctx.lineTo(xOf(run[run.length - 1].t), py + ph);
        ctx.closePath();
        if (lane.ink === 'inferno') {
          const g = ctx.createLinearGradient(0, py, 0, py + ph);
          g.addColorStop(0, `rgba(251,224,138,0.30)`);
          g.addColorStop(0.45, `rgba(234,107,38,0.20)`);
          g.addColorStop(1, `rgba(77,16,105,0.05)`);
          ctx.fillStyle = g;
        } else {
          ctx.fillStyle = 'rgba(143,176,184,0.055)';
        }
        ctx.fill();
      }

      ctx.lineWidth = lane.ink === 'inferno' ? 1.6 : 1.2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';

      if (lane.ink === 'inferno') strokeGraded(run, lane, xOf, yOf, lo, hi, scale);
      else {
        ctx.strokeStyle = lane.ink;
        ctx.beginPath();
        ctx.moveTo(xOf(run[0].t), yOf(run[0][lane.id]));
        traceInto(run, lane, xOf, yOf);
        ctx.stroke();
      }
    }

    /* The carriage, parked at the last reading. Absent when the record ends in
       a gap: there is no pen position for a board that is not reporting. */
    if (last) {
      const cy = yOf(last[lane.id]);
      const cx = xOf(last.t);
      ctx.fillStyle = lane.ink === 'inferno'
        ? INFERNO_LUT[inkBucket(last[lane.id] * scale, lo, hi)]
        : lane.ink;
      ctx.beginPath();
      ctx.moveTo(cx + 1, cy);
      ctx.lineTo(cx + 7, cy - 3.4);
      ctx.lineTo(cx + 7, cy + 3.4);
      ctx.closePath();
      ctx.fill();
    }

    ctx.textAlign = 'left';
    ctx.fillStyle = INK_LABEL;
    ctx.font = '9px "IBM Plex Sans Condensed", system-ui, sans-serif';
    ctx.fillText(spaced(lane.label), 10, py + 13);

    const shown = last ? last[lane.id] * scale : NaN;
    ctx.fillStyle = last
      ? (lane.ink === 'inferno'
          ? INFERNO_LUT[inkBucket(shown, lo, hi)]
          : INK_VALUE)
      : INK_DIM;
    ctx.font = `${narrow ? 15 : 18}px "IBM Plex Mono", ui-monospace, monospace`;
    const text = num(shown, lane.decimals);
    ctx.fillText(text, 10, py + (narrow ? 31 : 34));

    if (!narrow) {
      const tw = ctx.measureText(text).width;
      ctx.fillStyle = INK_DIM;
      ctx.font = '10px "IBM Plex Sans Condensed", system-ui, sans-serif';
      ctx.fillText(lane.unit, 10 + tw + 4, py + 34);

      /* Only the top of each lane, plus the very bottom of the last. At a seam
         the low mark of one pen and the high mark of the next land within a
         few pixels and read as one number. */
      ctx.textAlign = 'right';
      ctx.fillStyle = INK_SCALE;
      ctx.font = '9px "IBM Plex Mono", ui-monospace, monospace';
      ctx.fillText(String(Math.round(hi)), px - 6, py + 10);
      if (isLast) ctx.fillText(String(Math.round(lo)), px - 6, py + ph - 3);
      ctx.textAlign = 'left';
    }
  }

  /**
   * Stroke a graded run as one path per colour band.
   *
   * A smooth temperature trace crosses only a handful of bands across a whole
   * window, so this is a few strokes rather than one per sample — which is the
   * difference between a few hundred canvas operations a second and tens of
   * thousands, for an identical picture.
   */
  function strokeGraded(run, lane, xOf, yOf, lo, hi, scale) {
    let i = 1;
    while (i < run.length) {
      const band = inkBucket(run[i][lane.id] * scale, lo, hi);
      ctx.strokeStyle = INFERNO_LUT[band];
      ctx.beginPath();
      ctx.moveTo(xOf(run[i - 1].t), yOf(run[i - 1][lane.id]));
      let j = i;
      while (j < run.length && inkBucket(run[j][lane.id] * scale, lo, hi) === band) {
        ctx.lineTo(xOf(run[j].t), yOf(run[j][lane.id]));
        j++;
      }
      ctx.stroke();
      i = j;
    }
  }

  /**
   * Extend the current path along a run. A step trace holds its value until
   * the next sample, which is how a frame rate actually behaves: a count over
   * an interval rather than a continuous quantity.
   */
  function traceInto(run, lane, xOf, yOf) {
    let prevY = yOf(run[0][lane.id]);
    ctx.lineTo(xOf(run[0].t), prevY);
    for (let i = 1; i < run.length; i++) {
      const x = xOf(run[i].t);
      const yy = yOf(run[i][lane.id]);
      if (lane.step) ctx.lineTo(x, prevY);
      ctx.lineTo(x, yy);
      prevY = yy;
    }
  }

  /**
   * Blank paper is only legible as loss once it is annotated. Every gap gets a
   * hairline where it began, a hatched band, and the label naming what was
   * observed.
   */
  function drawGaps(buffer, xOf, px, pw, ph, now) {
    for (let i = 0; i < buffer.length; i++) {
      if (!buffer[i].gap) continue;

      let end = now;
      for (let j = i + 1; j < buffer.length; j++) {
        if (!buffer[j].gap) { end = buffer[j].t; break; }
      }

      const x1 = Math.max(px, xOf(buffer[i].t));
      const x2 = Math.min(px + pw, xOf(end));
      if (x2 <= px || x1 >= px + pw || x2 <= x1) continue;

      const band = x2 - x1;
      /* Hatch spacing opens up on a very wide band so the stroke count stays
         bounded — an outage lasting the whole window is still obviously
         hatched, and it must not cost more to draw than everything else. */
      const step = band > 220 ? Math.ceil(band / 30) : 7;

      ctx.save();
      ctx.beginPath();
      ctx.rect(x1, 0, band, ph);
      ctx.clip();
      ctx.strokeStyle = `rgba(${AMBER},0.10)`;
      ctx.lineWidth = 1;
      for (let d = -ph; d < band + ph; d += step) {
        ctx.beginPath();
        ctx.moveTo(x1 + d, ph);
        ctx.lineTo(x1 + d + ph, 0);
        ctx.stroke();
      }
      ctx.restore();

      ctx.strokeStyle = `rgba(${AMBER},0.60)`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x1) + 0.5, 0);
      ctx.lineTo(Math.round(x1) + 0.5, ph);
      ctx.stroke();

      /* The label may overhang its band. A four-second reboot is only ~27 px
         wide, and suppressing the annotation there would hide the very event
         it exists to name. */
      if (band > 14 && buffer[i].label) {
        ctx.fillStyle = `rgba(${AMBER},0.85)`;
        ctx.font = '9px "IBM Plex Sans Condensed", system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(spaced(buffer[i].label), x1 + 5, 12);
      }
    }
  }

  function drawTimeAxis(px, py, pw, h) {
    ctx.fillStyle = AXIS_BG;
    ctx.fillRect(px, py, pw, h);
    ctx.font = '9px "IBM Plex Mono", ui-monospace, monospace';
    ctx.textAlign = 'center';

    for (let s = 0; s <= WINDOW_S; s += 15) {
      const x = px + pw - (s / WINDOW_S) * pw;
      ctx.fillStyle = '#26231f';
      ctx.fillRect(Math.round(x), py, 1, 4);
      if (s === 0) continue;
      ctx.fillStyle = INK_DIM;
      ctx.fillText(`-${s}s`, x, py + 12);
    }
    ctx.textAlign = 'right';
    ctx.fillStyle = INK_LABEL;
    ctx.fillText('NOW', px + pw - 2, py + 12);
    ctx.textAlign = 'left';
  }

  return {
    paint,
    stop() {
      stopped = true;
      if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
      ro?.disconnect?.();
      prepared.clear();
    },
  };
}

/** Letterspacing, which canvas will not do on its own. */
function spaced(s) { return String(s).split('').join(' '); }
