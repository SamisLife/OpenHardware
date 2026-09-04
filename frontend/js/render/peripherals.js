/* ============================================================================
   peripherals.js — what is actually attached to this board.
   ----------------------------------------------------------------------------
   Discovered, never assumed. Showing a camera panel to every board on the
   grounds that the reference hardware has one means most boards get a
   permanently empty viewport, which is a worse lie than no viewport at all.

   Two confidence levels, and they must not be presented alike. A sensor ID
   read off a part, or an address that acknowledged on the bus, is DETECTED:
   the board saw it. A part a person typed in is DECLARED: the board cannot
   see a strip of LEDs on a GPIO, so it has to be told. The badge on every row
   says which, in the same two colours the source badge uses for measured
   versus simulated, because it is the same distinction.

   An address is an observation; a part number beside it is an inference. So
   a new address raises a question — found 0x3c, is this an SSD1306 OLED? —
   and the answer, once given, is not asked for again. Only new addresses and
   ones that stopped answering come back to the person.

   Anything on SPI, on an analog pin, or on a bare GPIO cannot be discovered
   at all — no addressing, no acknowledgement, nothing to probe. The + add
   control exists for exactly those.

   The camera row keeps the one control that is not about wiring: Show or
   Hide the picture.
   ========================================================================== */

import { describe, hex, scanPins, BUSES } from '../wiring.js';

/* Drawn in the current ink rather than as emoji, so they take the row's
   colour — red on a faulted camera, grey on an absent part — and look the
   same on every platform the page is opened from. */
const ICON = {
  camera: '<svg class="periph__icon" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">'
    + '<path d="M2 5.5h2.2l1-1.7h5.6l1 1.7H14v7H2z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>'
    + '<circle cx="8" cy="9" r="2.4" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
  chip: '<svg class="periph__icon" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">'
    + '<rect x="4" y="4" width="8" height="8" fill="none" stroke="currentColor" stroke-width="1.2"/>'
    + '<path d="M6 1.5v2.5M10 1.5v2.5M6 12v2.5M10 12v2.5M1.5 6h2.5M1.5 10h2.5M12 6h2.5M12 10h2.5" stroke="currentColor" stroke-width="1.2"/></svg>',
  pin: '<svg class="periph__icon" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">'
    + '<path d="M8 1.5v5M5 6.5h6l-1 4H6z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>'
    + '<path d="M8 10.5v4" stroke="currentColor" stroke-width="1.2"/></svg>',
};

let el = {};
let handlers = {};
let lastRows = '';
let lastAsk = '';

export function mountPeripherals(root, opts = {}) {
  handlers = opts;
  el = {
    list: root.querySelector('[data-periph=list]'),
    empty: root.querySelector('[data-periph=empty]'),
    ask: root.querySelector('[data-periph=ask]'),
    scan: root.querySelector('[data-periph=scan]'),
    add: root.querySelector('[data-periph=add]'),
    form: root.querySelector('[data-periph=form]'),
    status: root.querySelector('[data-periph=status]'),
  };

  /* One listener per region, because rows and the question card are rebuilt
     as the board reports, and a listener on a rebuilt button is a listener
     on nothing. */
  el.list.addEventListener('click', ev => {
    const b = ev.target?.closest?.('[data-periph]');
    if (!b) return;
    const key = b.dataset.key;
    if (b.dataset.periph === 'toggle') handlers.onCamera?.(b.dataset.on === 'true');
    if (b.dataset.periph === 'remove') handlers.onRemove?.(key);
  });

  el.ask?.addEventListener('click', ev => {
    const b = ev.target?.closest?.('[data-periph]');
    if (!b) return;
    const key = b.dataset.key;
    switch (b.dataset.periph) {
      case 'confirm': return handlers.onConfirm?.(key, b.dataset.name);
      case 'ignore':  return handlers.onIgnore?.(key);
      case 'keep':    return handlers.onKeep?.(key);
      case 'drop':    return handlers.onRemove?.(key);
      case 'save': {
        const name = el.ask.querySelector('[data-periph=other]')?.value?.trim();
        if (name) handlers.onConfirm?.(key, name);
        return;
      }
      default: return;
    }
  });
  el.ask?.addEventListener('change', ev => {
    const s = ev.target?.closest?.('[data-periph=pick]');
    if (!s) return;
    if (s.value === '__other') {
      el.ask.querySelector('[data-periph=otherRow]')?.removeAttribute('hidden');
      el.ask.querySelector('[data-periph=other]')?.focus?.();
    } else if (s.value) {
      handlers.onConfirm?.(s.dataset.key, s.value);
    }
  });

  el.scan?.addEventListener('click', () => handlers.onScan?.());
  el.add?.addEventListener('click', () => {
    if (!el.form) return;
    el.form.hidden = !el.form.hidden;
    if (!el.form.hidden) el.form.querySelector('[data-f=name]')?.focus?.();
  });

  if (el.form) {
    const field = k => el.form.querySelector(`[data-f=${k}]`);
    el.form.addEventListener('submit', ev => {
      ev.preventDefault();
      const name = field('name')?.value?.trim();
      if (!name) return;
      const addrText = field('addr')?.value?.trim() || '';
      const addr = addrText ? Number(addrText) : null;
      handlers.onAdd?.({
        name,
        bus: field('bus')?.value || 'other',
        addr: Number.isInteger(addr) ? addr : null,
        pins: (field('pins')?.value || '').split(/[,\s]+/).filter(Boolean),
        note: field('note')?.value?.trim() || null,
      });
      el.form.reset?.();
      el.form.hidden = true;
    });
    el.form.querySelector('[data-periph=cancel]')?.addEventListener('click', () => { el.form.hidden = true; });
  }
}

export function renderPeripherals(state) {
  const p = state.peripherals;
  const w = state.wiring || { parts: [], asks: [], scan: null, scanning: false };

  if (el.scan) {
    el.scan.disabled = !!w.scanning;
    el.scan.textContent = w.scanning ? 'scanning…' : '+ scan';
  }

  renderAsk(w);
  renderScanStatus(w);

  /* Nothing is claimed until the board has actually reported. Declared parts
     are the person's and are listed regardless. */
  const rows = [];

  if (p.known && p.camera && p.camera.state === 'ok') {
    const shown = state.ui?.cameraShown !== false;
    rows.push(row(p.camera.sensor || 'camera', 'camera sensor', p.streaming ? 'streaming' : 'idle', {
      icon: ICON.camera, how: 'detected',
      action: shown
        ? `<button type="button" class="btn periph__act" data-periph="toggle" data-on="false" title="hide the picture; the stream keeps running so the frame rate and age stay measured">Hide</button>`
        : `<button type="button" class="btn btn--primary periph__act" data-periph="toggle" data-on="true" title="stream frames into the console">Show</button>`,
    }));
  } else if (p.known && p.camera && p.camera.state === 'absent') {
    rows.push(row('No camera', 'nothing answered on the camera bus', '', { icon: ICON.camera }));
  } else if (p.known && p.camera && p.camera.state === 'faulted') {
    rows.push(row('Camera faulted', 'probe crashed on previous boots, not retried', 'fault', { icon: ICON.camera }));
  }

  for (const part of w.parts) {
    const bits = [];
    if (part.bus === 'i2c' && Number.isInteger(part.addr)) bits.push(hex(part.addr));
    else bits.push(part.bus);
    if (part.pins?.length) bits.push(part.pins.join(' / '));
    if (part.how === 'detected' && !part.confirmed && describe(part)) bits.push(`probably ${describe(part)}`);
    if (part.present === false) bits.push('not seen on the last scan');
    if (part.note) bits.push(part.note);
    const tone = part.present === false ? 'absent' : part.how === 'detected' && !part.confirmed ? 'guess' : '';
    const removable = part.how === 'declared' || part.present === false;
    rows.push(row(part.name, bits.join(' · '), tone, {
      icon: part.bus === 'i2c' || part.bus === 'spi' || part.bus === 'uart' ? ICON.chip : ICON.pin,
      how: part.how,
      action: removable
        ? `<button type="button" class="btn periph__act" data-periph="remove" data-key="${esc(part.key)}" title="take it off the list">Remove</button>`
        : '',
    }));
  }

  const found = (p.known && p.camera?.state === 'ok') || w.parts.length > 0;
  el.empty.hidden = found;
  if (!found) {
    el.empty.textContent = !p.known
      ? 'Waiting for the board to report what is attached.'
      : 'Nothing was detected beyond the board itself. Parts on SPI, on an analog pin or on a '
        + 'bare GPIO cannot be discovered at all — there is no address to probe and nothing to '
        + 'acknowledge — so they have to be declared with + add.';
  }

  const html = rows.join('');
  if (html !== lastRows) { lastRows = html; el.list.innerHTML = html; }
}

/**
 * One line about the last scan: what answered, or why nothing did.
 *
 * A scan that went unanswered, or found a line held low, must not look like
 * a scan that found nothing. The three are different facts with different
 * next steps, and only the first sentence of each is drawn.
 */
function renderScanStatus(w) {
  if (!el.status) return;
  const s = w.scan;
  let text = '';
  if (w.scanning) text = 'scanning the I2C header…';
  else if (s && s.ok === false && s.err === 'no_answer') {
    text = 'no scan reply arrived. Compare rxBytes before and after another scan to separate the link from the board handler.';
  } else if (s && s.ok === false && s.err === 'bus_stuck') {
    text = `scan failed: ${String(s.line || 'a line').toUpperCase()} is held low. Check the wiring on ${scanPinsText(s)}.`;
  } else if (s && s.ok === false) {
    text = `scan failed: ${s.err || 'unknown error'}`;
  } else if (s) {
    const n = (s.found || []).length;
    text = `last scan: ${n === 0 ? 'nothing answered' : `${n} answered`} on ${scanPinsText(s)}${Number.isFinite(s.ms) ? ` · ${s.ms} ms` : ''}`;
  }
  el.status.hidden = !text;
  if (el.status.textContent !== text) el.status.textContent = text;
}

function scanPinsText(s) {
  const pins = scanPins(s);
  return pins.length ? pins.join(' / ') : 'the header';
}

/**
 * The question card: one question at a time, oldest first, with a count.
 *
 * A new address offers the table's first candidate as a yes, the rest as a
 * pick, a free field for anything else, and ignore. A missing part asks
 * whether to keep it. Nothing here asserts an identity: the sentence says
 * "probably", and the person decides.
 */
function renderAsk(w) {
  if (!el.ask) return;
  const ask = (w.asks || [])[0];
  const part = ask && (w.parts || []).find(p => p.key === ask.key);
  if (!ask || !part) {
    if (lastAsk !== '') { lastAsk = ''; el.ask.innerHTML = ''; }
    el.ask.hidden = true;
    return;
  }

  const where = part.pins?.length ? ` on ${part.pins.join(' / ')}` : '';
  const count = w.asks.length > 1 ? `<span class="meta ask__count">1 of ${w.asks.length}</span>` : '';
  const key = esc(part.key);
  let html;

  if (ask.kind === 'missing') {
    html = `<div class="question" data-kind="missing">
      <p class="question__text"><strong>${esc(part.name)}</strong> (${esc(hex(part.addr))})${esc(where)} did not answer on the last scan.</p>
      <div class="question__row">
        <button type="button" class="btn btn--primary" data-periph="keep" data-key="${key}">Keep it listed</button>
        <button type="button" class="btn" data-periph="drop" data-key="${key}">Remove</button>
        ${count}
      </div>
    </div>`;
  } else {
    const c = part.candidates || [];
    const first = c[0] || null;
    const rest = c.slice(1);
    html = `<div class="question" data-kind="new">
      <p class="question__text">Found <strong>${esc(hex(part.addr))}</strong>${esc(where)}.
        ${first ? `Is this <strong>${esc(first)}</strong>?` : 'Nothing in the table answers to that address. What is it?'}</p>
      <div class="question__row">
        ${first ? `<button type="button" class="btn btn--primary" data-periph="confirm" data-key="${key}" data-name="${esc(first)}">Yes</button>` : ''}
        <select class="question__pick" data-periph="pick" data-key="${key}" aria-label="pick another part">
          <option value="">${first ? 'Pick another…' : 'Pick…'}</option>
          ${rest.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('')}
          <option value="__other">Something else…</option>
        </select>
        <button type="button" class="btn" data-periph="ignore" data-key="${key}" title="leave it off the list and stop asking">Ignore</button>
        ${count}
      </div>
      <div class="question__row" data-periph="otherRow" hidden>
        <input class="question__other" data-periph="other" type="text" placeholder="what is it?" aria-label="part name">
        <button type="button" class="btn btn--primary" data-periph="save" data-key="${key}">Save</button>
      </div>
    </div>`;
  }

  if (html !== lastAsk) { lastAsk = html; el.ask.innerHTML = html; }
  el.ask.hidden = false;
}

function row(name, detail, tone, { icon = '', action = '', how = '' } = {}) {
  const badge = how ? `<span class="tag periph__how" data-how="${how}">${how}</span>` : '';
  return `<li class="periph" data-tone="${esc(tone || '')}">
    <span class="periph__name">${icon}${esc(name)}</span>
    <span class="periph__detail">${esc(detail)}</span>
    ${badge}
    ${action}
  </li>`;
}

export { BUSES };

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
