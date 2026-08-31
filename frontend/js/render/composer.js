/* ============================================================================
   composer.js — where a work order gets written.
   ----------------------------------------------------------------------------
   One field, submitted once. Not a chat, for the reason recorded in NOTES §11:
   a message list would visually argue against the autonomy thesis, and the
   claim being made here is that you write a sentence, walk away, and come back
   to work already done. A conversation is the opposite of that.

   The one thing it does while you type is show what it understood. Constraints
   appear as chips the moment they parse — "≥ 10 fps", "die ≤ 70 °C" — and
   anything it recognised but cannot measure is shown greyed with the reason.
   That last part matters more than it looks: "no dropped frames" is a perfectly
   reasonable thing to ask for and this harness cannot verify it, so the console
   says so BEFORE the run rather than declaring the goal met afterwards.

   A sentence that yields nothing measurable does not get a Start button. There
   is nothing for a loop to close on, and four attempts against no criterion
   would be theatre.
   ========================================================================== */

import { parseObjective } from '../builder/objective.js';

const EXAMPLES = [
  'Run the camera at the highest resolution this board can sustain at 10 fps or better.',
  'Maximise frame rate and keep the die under 55 °C.',
  'Highest resolution possible while leaving at least 2 MB of PSRAM free.',
];

let el = {};
let handlers = {};
let lastChips = '';

export function mountComposer(root, opts = {}) {
  handlers = opts;
  el = {
    root,
    /* The mounted element IS the form — querySelector only searches
       descendants, so looking for it below would find nothing. */
    form:   root.matches('[data-wo=form]') ? root : root.querySelector('[data-wo=form]'),
    input:  root.querySelector('[data-wo=input]'),
    submit: root.querySelector('[data-wo=submit]'),
    read:   root.querySelector('[data-wo=read]'),
    note:   root.querySelector('[data-wo=note]'),
    examples: root.querySelector('[data-wo=examples]'),
  };

  el.examples.innerHTML = EXAMPLES
    .map((e, i) => `<li><button type="button" class="eg" data-eg="${i}">${esc(e)}</button></li>`)
    .join('');
  el.examples.addEventListener('click', ev => {
    const b = ev.target.closest('[data-eg]');
    if (!b) return;
    el.input.value = EXAMPLES[Number(b.dataset.eg)];
    el.input.focus();
    reflect();
  });

  el.input.addEventListener('input', reflect);
  el.form.addEventListener('submit', ev => {
    ev.preventDefault();
    const goal = el.input.value.trim();
    if (!parseObjective(goal).ok) return;
    handlers.onSubmit?.(goal);
  });

  reflect();
}

/** Show what the sentence currently parses to, as it is typed. */
function reflect() {
  const text = el.input.value.trim();
  const o = parseObjective(text);

  el.submit.disabled = !o.ok;

  if (!text) {
    el.note.textContent = 'The agent needs something it can check against the board.';
    setChips('');
    return;
  }

  el.note.textContent = o.ok
    ? 'Parsed. Every constraint below is a field the harness reports, so the result can be checked rather than claimed.'
    : 'Nothing measurable in that yet — name a frame rate, a temperature, a memory floor, or ask for a maximum.';

  setChips([
    ...(o.maximise ? [chip(`maximise ${o.maximise}`, 'goal')] : []),
    ...o.constraints.map(c => chip(c.label, 'measurable')),
    ...o.unmeasured.map(u => chip(`${u.label}`, 'unmeasurable', u.why)),
  ].join(''));
}

function chip(text, kind, title) {
  return `<li class="chip" data-kind="${kind}"${title ? ` title="${esc(title)}"` : ''}>${esc(text)}</li>`;
}

function setChips(html) {
  if (html === lastChips) return;
  lastChips = html;
  el.read.innerHTML = html;
}

/**
 * The composer is the panel's resting state and the build log replaces it.
 * Hidden rather than unmounted so a half-typed sentence survives a run being
 * abandoned — losing what someone typed is a small cruelty with no upside.
 */
export function renderComposer(state) {
  const busy = !!state.workOrder && state.workOrder.status === 'running';
  el.root.hidden = !!state.workOrder;
  if (!busy) el.submit.disabled = !parseObjective(el.input.value.trim()).ok;
}

export function composerValue() { return el.input?.value.trim() || ''; }

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
