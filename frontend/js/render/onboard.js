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

/**
 * Faults where writing firmware is the fix rather than merely a possibility.
 *
 * Retrying any of these produces the same result every time, because nothing
 * about the board changes between attempts — so "Try again" is the wrong thing
 * to give primary weight to.
 */
const WRITE_ANSWERS = new Set(['no_hello', 'no_beat']);

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
  decide: '',
  fault: '',
  done: 'Live.',
};

/**
 * What was found on the board, said plainly.
 *
 * Not rendered as a fault, and the difference is not cosmetic. A board running
 * somebody else's firmware is working exactly as it should — it has power, the
 * cable is good, it boots and reports — and filing that under "Observed /
 * possible causes" describes a healthy board as a broken one. What is actually
 * happening is that the flow reached a decision only a person can make.
 */
function renderDecision(state) {
  const f = state.found || {};
  const pub = state.published;

  let found;
  let ask;

  if (f.known) {
    const running = f.fw ? `<strong>${esc(f.fw)}</strong>` : 'firmware this page can read';
    found = `This board is already running ${running}.`;

    if (pub?.action === 'differs' && pub.version) {
      found += ` The published image is <strong>${esc(pub.version)}</strong>,
                and the two are built from different source.`;
    } else if (pub?.action === 'same') {
      found += ' It matches the published image.';
    }
    ask = 'Carrying on uses what is already there and writes nothing. Writing a '
        + 'fresh copy replaces it, along with anything the board had stored.';
  } else if (f.lines) {
    /* Counted, not characterised. Firmware this page cannot read is usually
       not another version of this project — it is arbitrary — and naming a
       category for it would claim knowledge that does not exist. */
    found = `The board sent <strong>${f.lines} lines</strong> of output and none
             of them were recognised. It is running something; what, cannot be
             determined from here.`;
    ask = 'Whatever it was saying is in the monitor beside this. Writing '
        + 'replaces it, along with anything the board had stored.';
  } else {
    found = 'The port is open and the board has sent nothing at all.';
    ask = 'It may be sitting in its bootloader rather than running an '
        + 'application, which is the ordinary state of a board that has never '
        + 'been written to.';
  }

  el.lede.innerHTML = `
    <p class="decide__found">${found}</p>
    <p class="decide__ask">${ask}</p>`;
}

/**
 * The network fork.
 *
 * Written to make declining an obvious and complete answer. Telemetry runs
 * over the cable whether or not the board ever sees a network, so a page that
 * pressed for credentials here would be pressing for something nothing below
 * it needs — and somebody who gave in would then be waiting on a join that
 * bought them nothing.
 */
function renderNetworkDecision(state) {
  const stored = state.hello?.ssid;
  const provisioned = !!state.hello?.provisioned;

  const found = provisioned
    ? `This board has <strong>${esc(stored || 'a network')}</strong> stored and is
       not associated with it.`
    : 'This board has no network stored.';

  el.lede.innerHTML = `
    <p class="decide__found">${found}</p>
    <p class="decide__ask">Telemetry runs over the cable either way — a network is
      what lets the board be reached once the cable is gone. The radio is 2.4 GHz
      only. Nothing below this step depends on the answer.</p>`;
}

function renderHead(state) {
  if (state.phase === 'fault' && state.fault) renderFault(state.fault);
  else if (state.phase === 'decide' && state.rungs.network?.state === 'ask') {
    renderNetworkDecision(state);
  } else if (state.phase === 'decide') renderDecision(state);
  else el.lede.textContent = LEDE[state.phase] || '';

  const blocked = state.blocked;
  let notice = '';

  if (blocked && !state.simulated) {
    notice = `<p class="notice notice--block">${esc(blocked)}</p>
       <p class="notice__alt">A simulated board runs the same flow with no hardware:
         <a href="?sim">open it with ?sim</a>.</p>`;
  } else if (state.published?.action === 'differs') {
    /* Stated, not pressed. The board works, so this is information rather than
       a problem, and writing over it costs whatever it was holding. The
       control is already in the row below — this only says why somebody might
       reach for it. */
    notice = `<p class="notice">This board is running
       <strong>${esc(state.published.running)}</strong>.
       The published image is <strong>${esc(state.published.version)}</strong>,
       and their hashes differ. Keeping what is on the board is fine.</p>`;
  } else if (state.published?.action === 'same') {
    notice = `<p class="notice notice--quiet">Running the published image,
       ${esc(state.published.version)}.</p>`;
  }

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
    state.published ? state.published.action : null,
    state.published ? state.published.version : null,
    state.found ? !!state.found.known : null,
  ]);
  if (sig === lastActionSig) return;
  lastActionSig = sig;

  el.actions.innerHTML = '';

  if (state.phase === 'working') {
    add('button', 'Working…', { cls: 'btn', disabled: true });
    return;
  }

  /* Waiting on a person, not on the hardware. Both options are real and
     neither is a recovery: writing replaces what is there, and listening
     anyway is a legitimate choice for somebody who wants to watch a board they
     have no intention of overwriting. */
  /* The network fork, which is a form rather than a pair of buttons. Skipping
     is placed as an equal, not as a way out: nothing downstream needs a
     network, so declining is an answer and not a failure to answer. */
  if (state.phase === 'decide' && state.rungs.network?.state === 'ask') {
    const form = document.createElement('form');
    form.className = 'netform';
    form.innerHTML = `
      <label class="netform__field">Network name
        <input type="text" data-ob="ssid" autocomplete="off" spellcheck="false"
               placeholder="2.4 GHz network" value="${esc(state.hello?.ssid || '')}">
      </label>
      <label class="netform__field">Passphrase
        <input type="password" data-ob="psk" autocomplete="off"
               placeholder="leave empty for an open network">
      </label>`;

    form.addEventListener('submit', ev => {
      ev.preventDefault();
      const ssid = form.querySelector('[data-ob=ssid]')?.value || '';
      const psk = form.querySelector('[data-ob=psk]')?.value || '';
      handlers.onProvision?.(ssid, psk);
    });
    el.actions.appendChild(form);

    add('button', 'Join this network', {
      cls: 'btn btn--primary',
      on: () => form.requestSubmit
        ? form.requestSubmit()
        : form.dispatchEvent(new Event('submit', { cancelable: true })),
    });
    add('button', 'Skip — use the cable', {
      cls: 'btn', on: () => handlers.onSkipNetwork?.(),
    });
    return;
  }

  if (state.phase === 'decide') {
    const version = state.published?.version;
    const write = version ? `Write ${version}` : 'Write firmware';
    const known = !!state.found?.known;

    /* Which one leads depends on what is already there, and it is never the
       destructive one for a board that works. Writing over a board that is
       running costs it whatever it was holding, so it is offered rather than
       suggested — but it is offered every time, from here, so that a fresh
       image never requires reaching a failure first. */
    if (known) {
      add('button', 'Continue with it', {
        cls: 'btn btn--primary', on: () => handlers.onContinue?.(),
      });
      add('button', version ? `Re-flash ${version}` : 'Re-flash', {
        cls: 'btn', on: () => handlers.onFlash?.(),
      });
    } else {
      add('button', write, { cls: 'btn btn--primary', on: () => handlers.onFlash?.() });
      add('button', 'Listen anyway', { cls: 'btn', on: () => handlers.onListen?.() });
    }

    const check = document.createElement('label');
    check.className = 'check';
    check.innerHTML = '<input type="checkbox" data-ob="erase"> Erase first'
      + '<em>slower, and forgets anything the board had stored</em>';
    el.actions.appendChild(check);
    return;
  }

  if (state.phase === 'fault') {
    /* Writing has to be reachable from here.
     *
     * Every fault used to offer exactly one control, "Try again", and for the
     * faults below that is the wrong and only option: a board running the
     * wrong firmware will fail identically however many times it is retried,
     * and there was no way from that screen to the one thing that fixes it.
     * The way out was to dismiss the fault, reconnect, and find a button that
     * only appears when nothing is wrong. */
    const writeFixesIt = WRITE_ANSWERS.has(state.fault?.code);

    add('button', 'Try again', {
      cls: writeFixesIt ? 'btn' : 'btn btn--primary',
      on: () => handlers.onRetry?.(),
    });

    /* Primary only where it is genuinely the answer. Offered but secondary
       elsewhere, because writing over a board costs it whatever it was
       holding and that is not a decision to nudge somebody into. */
    if (state.hasPort) {
      add('button', 'Write this firmware', {
        cls: writeFixesIt ? 'btn btn--primary' : 'btn',
        on: () => handlers.onFlash?.(),
      });
    }

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
    /* Named once there is a name. "Write firmware" leaves somebody to wonder
       which firmware; "Write 0.11.0" is the same click with the answer on it. */
    const label = state.published?.version
      ? `Write ${state.published.version}`
      : 'Write firmware';
    add('button', label, {
      cls: state.published?.action === 'differs' ? 'btn btn--primary' : 'btn',
      on: () => handlers.onFlash?.(),
    });
    const check = document.createElement('label');
    check.className = 'check';
    check.innerHTML = '<input type="checkbox" data-ob="erase"> Erase first'
      + '<em>slower, and forgets anything the board had stored</em>';
    el.actions.appendChild(check);
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
