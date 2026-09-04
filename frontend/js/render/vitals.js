/* ============================================================================
   vitals.js — the scalar readouts.
   ----------------------------------------------------------------------------
   Every cell is one number with a unit and, where a denominator exists, a bar
   showing how much of the budget is left. The bars are the only thing on this
   panel allowed colour, and only once a measurement is genuinely close to its
   ceiling.

   Two rules do most of the work here:

     When the link drops, every cell goes to em-dashes and dims. It does not
     hold the last value. A stale number presented as live is the exact failure
     this instrument exists to prevent.

     A bar needs a denominator. Until the board reports its total there is
     nothing to be a fraction of, so the track is drawn hatched and empty
     rather than filled against a number this page invented.
   ========================================================================== */

import { num, uptime, ago, tempColor, NIL, KB, MB } from '../format.js';

/** Label, unit, and whether the cell carries a headroom bar. */
const SPEC = [
  { id: 'temp',  label: 'DIE TEMP',   unit: '°C' },
  { id: 'heap',  label: 'HEAP FREE',  unit: 'KB', bar: true },
  { id: 'psram', label: 'PSRAM FREE', unit: 'MB', bar: true },
  { id: 'clk',   label: 'CPU CLOCK',  unit: 'MHz' },
  { id: 'up',    label: 'UPTIME',     unit: '' },
  { id: 'age',   label: 'FRAME AGE',  unit: '' },
  { id: 'fps',   label: 'FRAME RATE', unit: 'fps' },
];

let cells = {};
let ageTimer = 0;
/** Retained so the frame-age clock can tick between render passes. */
let seen = null;

export function mountVitals(root) {
  const grid = root.querySelector('[data-vitals=grid]');
  const rate = root.querySelector('[data-vitals=rate]');
  grid.innerHTML = '';
  cells = { _rate: rate };

  /* Built node by node rather than from a template string. The structure is
     this module's own, so there is nothing to parse and nothing to escape,
     and every node is held directly instead of being looked up again. */
  for (const s of SPEC) {
    const cell = make('div', 'vital');
    cell.appendChild(text(make('div', 'vital__label'), s.label));

    const row = make('div', 'vital__row');
    const value = text(make('span', 'vital__value'), NIL);
    row.appendChild(value);
    row.appendChild(text(make('span', 'vital__unit'), s.unit));
    cell.appendChild(row);

    let bar = null, track = null, noteEl = null;
    if (s.bar) {
      track = make('div', 'vital__bar');
      track.dataset.known = 'false';
      bar = make('i', '');
      track.appendChild(bar);
      cell.appendChild(track);
    } else {
      noteEl = make('div', 'vital__note');
      cell.appendChild(noteEl);
    }

    grid.appendChild(cell);
    cells[s.id] = { root: cell, v: value, bar, track, note: noteEl };
  }

  /* Frame age is the one readout that changes without new data arriving, so it
     needs its own clock. Everything else is push-driven. */
  clearInterval(ageTimer);
  ageTimer = setInterval(tickAge, 200);
}

export function renderVitals(state) {
  seen = state;
  const t = state.telemetry.latest;
  const lim = state.telemetry.limits;
  const live = !!t && state.device.link === 'linked';

  for (const s of SPEC) cells[s.id].root.classList.toggle('is-absent', !live);

  /* Sample cadence, measured rather than declared — the panel subtitle should
     not claim 4 Hz for a board reporting at one. */
  const buf = state.telemetry.buffer;
  const recent = buf.filter(s => !s.gap).slice(-9);
  if (cells._rate) {
    const span = recent.length > 1
      ? (recent[recent.length - 1].t - recent[0].t) / (recent.length - 1) : null;
    cells._rate.textContent = live && span > 0
      ? `reported at ${(1000 / span).toFixed(1)} Hz` : NIL;
  }

  if (!live) {
    for (const s of SPEC) {
      cells[s.id].v.textContent = NIL;
      cells[s.id].v.style.color = '';
      cells[s.id].root.classList.remove('is-fault', 'is-warn');
      if (cells[s.id].bar) cells[s.id].bar.style.width = '0%';
      if (cells[s.id].note) cells[s.id].note.textContent = '';
    }
    return;
  }

  /* ---- die temperature, against a ceiling only if one was declared ------ */
  const ceiling = lim.tempC;
  put('temp', num(t.tempC, 1));
  cells.temp.v.style.color = Number.isFinite(t.tempC) ? tempColor(t.tempC, ceiling) : '';
  const over = Number.isFinite(ceiling) && t.tempC > ceiling;
  cells.temp.root.classList.toggle('is-fault', over);
  note('temp', !Number.isFinite(t.tempC) ? 'no reading'
    : !Number.isFinite(ceiling) ? 'no ceiling declared'
    : over ? `${num(t.tempC - ceiling, 1)} over limit`
    : `${num(ceiling - t.tempC, 1)} headroom`);

  /* ---- memory: the value always, the proportion only with a total ------- */
  put('heap', Number.isFinite(t.heapFree) ? (t.heapFree / KB).toFixed(0) : NIL);
  bar('heap', t.heapFree, lim.heapTotal);

  put('psram', Number.isFinite(t.psramFree) ? (t.psramFree / MB).toFixed(2) : NIL);
  bar('psram', t.psramFree, lim.psramTotal);

  /* ---- link ------------------------------------------------------------
     A cable-tethered board has no radio association and reports nothing for
     it. Zero dBm is not a weak signal, it is the absence of one, and showing
     it as a reading would be a fabricated number. */

  /* The clock is reported, not judged. Calling a value "reduced" needs a
     nominal to compare against, and no board here has declared one. */
  put('clk', num(t.cpuMhz, 0));
  note('clk', '');

  put('up', uptime(t.uptimeS));
  note('up', 'since boot');

  put('fps', num(t.fps, 1));
  note('fps', '');

  tickAge();
}

/** Called both by the render pass and by its own interval. */
function tickAge() {
  const c = cells.age;
  const st = seen;
  if (!c || !st) return;

  const f = st.frame;
  const live = st.device.link === 'linked' && f.ts > 0;
  if (!live) {
    c.v.textContent = NIL;
    c.root.classList.remove('is-fault');
    if (c.note) c.note.textContent = '';
    return;
  }

  const age = Date.now() - f.ts;
  c.v.textContent = ago(f.ts);
  const stale = age > 3000;
  c.root.classList.toggle('is-fault', stale);
  if (c.note) c.note.textContent = stale ? 'stale' : `seq ${f.seq}`;
}

/* ------------------------------------------------------------------------ */

function make(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function text(node, value) {
  node.textContent = value;
  return node;
}

function put(id, text) {
  const c = cells[id];
  if (c && c.v.textContent !== text) c.v.textContent = text;
}

function note(id, text) {
  const c = cells[id];
  if (c && c.note && c.note.textContent !== text) c.note.textContent = text;
}

/**
 * A headroom bar, drawn only when there is a denominator to draw it against.
 *
 * Colour appears below a quarter remaining, which keeps the panel grey during
 * normal operation and makes the one bar that matters findable at a glance.
 */
function bar(id, free, total) {
  const c = cells[id];
  if (!c || !c.bar) return;

  const known = Number.isFinite(free) && Number.isFinite(total) && total > 0;
  c.track.dataset.known = String(known);
  c.root.classList.toggle('is-fault', false);
  c.root.classList.toggle('is-warn', false);

  if (!known) {
    c.bar.style.width = '0%';
    return;
  }

  const f = Math.max(0, Math.min(1, free / total));
  c.bar.style.width = `${(f * 100).toFixed(1)}%`;
  c.root.classList.toggle('is-fault', f < 0.10);
  c.root.classList.toggle('is-warn', f >= 0.10 && f < 0.25);
}
