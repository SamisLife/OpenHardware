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

import { hex, BUSES } from '../wiring.js';

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
    add: root.querySelector('[data-periph=add]'),
    form: root.querySelector('[data-periph=form]'),
  };

  /* One listener on the list, because the rows are rebuilt whenever anything
     is added or removed and a listener on a rebuilt button is a listener on
     nothing. */
  el.list.addEventListener('click', ev => {
    const b = ev.target?.closest?.('[data-periph]');
    if (!b) return;
    const key = b.dataset.key;
    if (b.dataset.periph === 'toggle') handlers.onCamera?.(b.dataset.on === 'true');
    if (b.dataset.periph === 'remove') handlers.onRemove?.(key);
  });

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
  const w = state.wiring || { parts: [] };

  /* The camera is the one thing the board reports about itself. Everything
     else on this list was declared by a person, because this board has no way
     to look. */
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
    if (part.note) bits.push(part.note);
    rows.push(row(part.name, bits.join(' · '), '', {
      icon: part.bus === 'i2c' || part.bus === 'spi' || part.bus === 'uart' ? ICON.chip : ICON.pin,
      how: 'declared',
      action: `<button type="button" class="btn periph__act" data-periph="remove" data-key="${esc(part.key)}" title="take it off the list">Remove</button>`,
    }));
  }

  const found = (p.known && p.camera?.state === 'ok') || w.parts.length > 0;
  el.empty.hidden = found;
  if (!found) {
    el.empty.textContent = !p.known
      ? 'Waiting for the board to report what is attached.'
      : 'Nothing beyond the board itself. This board cannot discover what is wired to it, so '
        + 'anything on I2C, SPI, an analog pin or a bare GPIO has to be listed here with + add. '
        + 'What is listed is what an agent reads before it writes code that assumes a pin.';
  }

  const html = rows.join('');
  if (html !== lastRows) { lastRows = html; el.list.innerHTML = html; }
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
