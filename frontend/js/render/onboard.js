/* ============================================================================
   onboard.js — the bring-up view.
   ----------------------------------------------------------------------------
   Two columns, and the split is the whole idea.

   LEFT is the ladder: rungs in hardware order, each waiting, working, done or
   faulted. Progress is honest — a rung says what it is waiting for and how long
   it has been waiting, rather than animating a bar that means nothing. A fake
   progress bar would be the one dishonest pixel on a page whose entire argument
   is that it shows what is really happening.

   RIGHT is the wire: the actual bytes off the board, colour-coded but unedited.
   This is the part nobody builds and the part engineers believe. When bring-up
   fails the answer is usually already sitting in this column, and no interface
   here had to anticipate it.

   A fault renders under three headings — what was observed, what might cause
   it, what to try — because the separation is the point. See onboard/faults.js.
   ========================================================================== */

import { RUNGS } from '../onboard/session.js';

let el = {};
let handlers = {};
let ladderIds = [];
/** True once the operator has scrolled the monitor up. */
let stuck = false;
/** How many monitor lines are currently in the DOM. */
let rendered = 0;
/** What the action row was last built for. See renderActions. */
let lastActionSig = null;

export function mountOnboard(root, opts = {}) {
  handlers = opts;
  el = {
    root,
    lede: root.querySelector('[data-ob=lede]'),
    actions: root.querySelector('[data-ob=actions]'),
    notice: root.querySelector('[data-ob=notice]'),
    ladder: root.querySelector('[data-ob=ladder]'),
    wire: root.querySelector('[data-ob=wire]'),
    wireEmpty: root.querySelector('[data-ob=wire-empty]'),
    sim: root.querySelector('[data-ob=sim]'),
  };

  buildLadder(RUNGS);

  el.wire.addEventListener('scroll', () => {
    const gap = el.wire.scrollHeight - el.wire.scrollTop - el.wire.clientHeight;
    stuck = gap > 24;
  });

  /* Writing cannot be made atomic, so the least this can do is warn. A board
     is never bricked by an interrupted write — the ROM bootloader is in mask
     ROM — but a half-written image will not boot, and somebody who closed the
     tab deserves to know why. */
  addEventListener('beforeunload', ev => {
    if (!handlers.isWriting?.()) return;
    ev.preventDefault();
    ev.returnValue = '';
  });
}

export function showOnboard() { if (el.root) el.root.hidden = false; }
export function hideOnboard() { if (el.root) el.root.hidden = true; }

export function renderOnboard(state, monitor) {
  /* Deliberately not un-hiding here. This runs on every emit, and a board that
     announces itself twice a second would drag the bring-up view back over the
     instrument moments after handover. Visibility belongs to whoever changed
     the view. */
  el.sim.hidden = !state.simulated;
  renderLadder(state);
  renderHead(state);
  renderWire(monitor);
}

/* ------------------------------------------------------------------------ */
/* the ladder                                                                */
/* ------------------------------------------------------------------------ */

function buildLadder(ids) {
  ladderIds = ids.slice();
  el.ladder.innerHTML = ids.map((id, i) => `
    <li class="rung" data-rung="${id}" data-state="idle">
      <span class="rung__n">${String(i + 1).padStart(2, '0')}</span>
      <span class="rung__dot" aria-hidden="true"></span>
      <span class="rung__title"></span>
      <span class="rung__detail"></span>
      <div class="rung__bar" hidden><i></i></div>
    </li>`).join('');
}

function renderLadder(state) {
  for (const id of ladderIds) {
    const r = state.rungs[id];
    const node = el.ladder.querySelector(`[data-rung="${id}"]`);
    if (!r || !node) continue;
    node.dataset.state = r.state;
    node.querySelector('.rung__title').textContent = r.title;
    node.querySelector('.rung__detail').textContent = r.detail || '';

    /* The only measured progress in the whole flow. Everything else here is
       genuinely indeterminate and says so rather than animating a bar that
       means nothing. */
    const bar = node.querySelector('.rung__bar');
    const show = id === 'flash' && state.progress && r.state === 'active';
    bar.hidden = !show;
    if (show) {
      const pct = (state.progress.written / state.progress.total) * 100;
      bar.firstElementChild.style.width = `${pct.toFixed(1)}%`;
    }
  }
}

/* ------------------------------------------------------------------------ */
/* head                                                                      */
/* ------------------------------------------------------------------------ */

const LEDE = {
  idle: 'Connect a board over USB, or run a simulated one. Nothing is installed '
      + 'and nothing is written to the board.',
  working: 'Working. The board is narrating itself on the right.',
  fault: '',
  done: 'Live.',
};

function renderHead(state) {
  if (state.phase === 'fault' && state.fault) renderFault(state.fault);
  else el.lede.textContent = LEDE[state.phase] || '';

  const blocked = state.blocked;
  const notice = blocked && !state.simulated
    ? `<p class="notice notice--block">${esc(blocked)}</p>
       <p class="notice__alt">A simulated board runs the same flow with no hardware:
         <a href="?sim">open it with ?sim</a>.</p>`
    : '';
  if (el.notice.innerHTML !== notice) el.notice.innerHTML = notice;

  renderActions(state, blocked);
}

/**
 * A fault, under three headings.
 *
 * The observation is stated as fact because it was observed. The causes are
 * listed as candidates because they are candidates. Nothing here can be
 * rearranged into a sentence that presents a guess as a measurement, which is
 * the point of splitting them in the data rather than in the prose.
 */
function renderFault(f) {
  const causes = f.causes?.length
    ? `<p class="fault__label">Possible causes, in the order worth checking</p>
       <ul class="fault__causes">${f.causes.map(c => `<li>${esc(c)}</li>`).join('')}</ul>`
    : '';
  el.lede.innerHTML = `
    <p class="fault__observed"><strong>Observed.</strong> ${esc(f.observed)}</p>
    ${causes}
    ${f.next ? `<p class="fault__next">${esc(f.next)}</p>` : ''}`;
}

/**
 * Rebuilt only when the set of controls actually changes.
 *
 * This runs on every emit, and a board announces itself repeatedly while it is
 * waiting — so an unconditional rebuild destroys and recreates the controls
 * under the operator's cursor several times a second. The signature is made of
 * only the things that decide WHICH controls exist.
 */
function renderActions(state, blocked) {
  const sig = JSON.stringify([
    state.phase, state.hasPort, state.simulated, !!blocked,
    state.fault ? state.fault.code : null, state.fault ? state.fault.raw : null,
  ]);
  if (sig === lastActionSig) return;
  lastActionSig = sig;

  el.actions.innerHTML = '';

  if (state.phase === 'working') {
    add('button', 'Working…', { cls: 'btn', disabled: true });
    return;
  }

  if (state.phase === 'fault') {
    add('button', 'Try again', { cls: 'btn btn--primary', on: () => handlers.onRetry?.() });
    if (state.fault?.raw) {
      const pre = document.createElement('code');
      pre.className = 'fault__raw';
      pre.textContent = state.fault.raw;
      el.actions.appendChild(pre);
    }
    return;
  }

  if (blocked && !state.simulated) return;

  add('button', state.hasPort ? 'Connect again' : 'Connect a board', {
    cls: 'btn btn--primary', on: () => handlers.onConnect?.(),
  });

  /* Offered, never taken on the way past. Writing over a board that is already
     running costs it whatever it was holding, so the label names what it does
     and it does not get the primary weight. */
  if (state.hasPort) {
    add('button', 'Write firmware', { cls: 'btn', on: () => handlers.onFlash?.() });
    const label = document.createElement('label');
    label.className = 'check';
    label.innerHTML = '<input type="checkbox" data-ob="erase"> Erase first'
      + '<em>slower, and forgets anything the board had stored</em>';
    el.actions.appendChild(label);
  }
}

export function eraseChecked() {
  return !!el.actions?.querySelector('[data-ob=erase]')?.checked;
}

function add(tag, text, { cls = '', on, disabled } = {}) {
  const node = document.createElement(tag);
  node.className = cls;
  node.textContent = text;
  if (tag === 'button') node.type = 'button';
  if (disabled) node.disabled = true;
  if (on) node.addEventListener('click', on);
  el.actions.appendChild(node);
  return node;
}

/* ------------------------------------------------------------------------ */
/* the wire                                                                  */
/* ------------------------------------------------------------------------ */

/**
 * Append-only, and trimmed in step with the buffer behind it.
 *
 * The trimming is the part worth getting right. The monitor is capped, so once
 * it is full every new line pushes an old one off the front — and a renderer
 * that only appends, keyed on the buffer's length, silently stops appending at
 * exactly that point. The visible effect is a monitor that freezes at the cap
 * and rewrites its last row forever, on a board producing thousands of lines,
 * which is precisely when it is being read.
 */
function renderWire(monitor) {
  const wire = el.wire;

  /* A shorter buffer means it was reset. */
  if (monitor.length < rendered) {
    wire.innerHTML = '';
    rendered = 0;
  }

  /* Lines dropped from the front of the buffer are dropped from the DOM too,
     which keeps the two indexed the same. */
  const overflow = wire.children.length - monitor.length;
  for (let i = 0; i < overflow; i++) wire.firstElementChild?.remove();
  if (overflow > 0) rendered = Math.max(0, rendered - overflow);

  /* The last line can change without a new one arriving, because repeats
     collapse into a count rather than appending. */
  const tail = monitor[rendered - 1];
  if (tail && wire.lastElementChild) {
    setLine(wire.lastElementChild, tail);
  }

  const frag = document.createDocumentFragment();
  for (let i = rendered; i < monitor.length; i++) {
    frag.appendChild(buildLine(monitor[i]));
  }
  rendered = monitor.length;

  if (el.wireEmpty) el.wireEmpty.hidden = monitor.length > 0;
  if (frag.childNodes.length) {
    wire.appendChild(frag);
    if (!stuck) wire.scrollTop = wire.scrollHeight;
  }
}

function buildLine(line) {
  const row = document.createElement('div');
  row.className = 'wire__line';
  const t = document.createElement('span');
  t.className = 'wire__t';
  const x = document.createElement('span');
  x.className = 'wire__x';
  row.appendChild(t);
  row.appendChild(x);
  setLine(row, line);
  return row;
}

function setLine(row, line) {
  row.dataset.kind = line.kind;
  row.firstElementChild.textContent = clock(line.t);
  row.lastElementChild.textContent =
    line.n > 1 ? `${line.text}  ×${line.n}` : line.text;
}

export function resetWire() {
  rendered = 0;
  lastActionSig = null;
  stuck = false;
  if (el.wire) el.wire.innerHTML = '';
}

/* ------------------------------------------------------------------------ */

function clock(t) {
  const d = new Date(t);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
