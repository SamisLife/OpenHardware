/* ============================================================================
   rail.js — the front-panel legend.
   ----------------------------------------------------------------------------
   Identity and link state, nothing else. This is the strip of silkscreen along
   the top of an instrument: what is being looked at, whether it is talking, and
   how long it has been up.

   Every field here comes from the board. Nothing is inferred from the presence
   of a connection, and nothing is filled in from what a board of this kind
   usually reports.
   ========================================================================== */

import { uptime, rssiBars, NIL } from '../format.js';

const LINK_TEXT = {
  linked: 'LINKED',
  rebooting: 'REBOOTING',
  lost: 'LINK LOST',
  offline: 'OFFLINE',
};

let el = {};

export function mountRail(root) {
  el = {
    id: root.querySelector('[data-rail=id]'),
    board: root.querySelector('[data-rail=board]'),
    net: root.querySelector('[data-rail=net]'),
    fw: root.querySelector('[data-rail=fw]'),
    sha: root.querySelector('[data-rail=sha]'),
    app: root.querySelector('[data-rail=app]'),
    slot: root.querySelector('[data-rail=slot]'),
    link: root.querySelector('[data-rail=link]'),
    linkText: root.querySelector('[data-rail=link-text]'),
    bars: root.querySelector('[data-rail=bars]'),
    uptime: root.querySelector('[data-rail=uptime]'),
  };
}

export function renderRail(state) {
  const d = state.device;
  const t = state.telemetry.latest;

  set(el.id, d.id);
  set(el.board, d.board);
  /* An SSID with no address is an association that has not produced a route
     yet, which is a different thing from being on a network. */
  set(el.net, d.ip && d.ssid ? `${d.ssid} · ${d.ip}` : d.ssid || null);
  set(el.fw, d.firmware.version);
  set(el.sha, d.firmware.sha ? d.firmware.sha.slice(0, 7) : null);
  set(el.app, d.app?.name
    ? `${d.app.name}${d.app.ver ? ` ${d.app.ver}` : ''}${d.appState ? ` · ${d.appState}` : ''}`
    : null);
  set(el.slot, d.firmware.slot);

  el.link.dataset.state = d.link;
  set(el.linkText, LINK_TEXT[d.link] || String(d.link).toUpperCase());

  /* Signal strength belongs to the sample, not to the connection: a board on a
     cable has no association, and zero bars is the honest answer rather than
     four bars left over from the last time it did. */
  const rssi = t ? t.rssi : null;
  const bars = rssiBars(rssi);
  el.bars.dataset.bars = String(bars);
  el.bars.setAttribute('aria-label',
    Number.isFinite(rssi) && rssi < 0 ? `Wi-Fi ${rssi} dBm` : 'No Wi-Fi association');

  set(el.uptime, t ? uptime(t.uptimeS) : null);
}

/** Absent reads as an em-dash pair, never as an empty cell or a zero. */
function set(node, value) {
  if (!node) return;
  const next = value == null || value === '' ? NIL : String(value);
  if (node.textContent !== next) node.textContent = next;
}
