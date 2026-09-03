/* ============================================================================
   belt.js — the agent panel at rest.
   ----------------------------------------------------------------------------
   There is nowhere to type. Instructions reach this board through an agent in
   the browser, over WebMCP, and the person's half of that conversation happens
   in the agent's own window rather than on this page. What the panel shows
   while it waits is what that agent will find: whether this browser exposes a
   tool registry at all, which tools are registered at this moment, and whether
   anything has called one yet.

   The list is drawn from what was actually registered rather than from a
   static catalogue. A write tool withdrawn because the link dropped is shown
   withdrawn, and in a browser with no registry every tool is listed and none
   is marked live — so a person can see what the page offers without being
   told it is on offer here.

   The example requests are things to say to the agent, not to the page. They
   copy to the clipboard on click, because the agent's window is a different
   window and retyping a sentence across two of them is friction with nothing
   behind it.
   ========================================================================== */

import { clock } from '../format.js';

/** Requests worth making, phrased for an agent rather than for a parser. */
export const ASK = [
  'What board is attached, and is its camera working?',
  'Find the largest frame size this camera holds at 10 fps or better, and record it as a limit.',
  'Watch the die temperature for a minute and tell me whether it is climbing.',
];

let el = {};
let lastTools = '';

export function mountBelt(root) {
  el = {
    root,
    avail:    root.querySelector('[data-belt=avail]'),
    presence: root.querySelector('[data-belt=presence]'),
    hint:     root.querySelector('[data-belt=hint]'),
    tools:    root.querySelector('[data-belt=tools]'),
    examples: root.querySelector('[data-belt=examples]'),
  };

  el.examples.innerHTML = ASK
    .map((t, i) => `<li><button type="button" class="ask" data-ask="${i}" title="copy">${esc(t)}</button></li>`)
    .join('');
  el.examples.addEventListener('click', async ev => {
    const b = ev.target.closest?.('[data-ask]');
    if (!b) return;
    try {
      await navigator.clipboard.writeText(ASK[Number(b.dataset.ask)]);
      flash(b, 'copied');
    } catch {
      /* No clipboard: an insecure context, or permission withheld. The text
         is still on the button to be selected by hand. */
      flash(b, 'select it to copy');
    }
  });
}

function flash(b, msg) {
  b.dataset.flash = msg;
  setTimeout(() => { delete b.dataset.flash; }, 1400);
}

/**
 * Hidden once a work order exists — the order and its log take the slot —
 * and back the moment it is cleared.
 */
export function renderBelt(state) {
  el.root.hidden = !!state.workOrder;

  const a = state.ui.agent || {};
  const tools = a.tools || [];
  const live = tools.filter(t => t.registered).length;

  let tone = 'muted';
  let tag = 'WEBMCP ––';
  let line = '';
  let hint = '';

  if (a.available === false) {
    tag = 'NO REGISTRY';
    line = 'this browser exposes no tool registry';
    hint = 'Nothing here is callable yet. Open this page in ChatGPT\'s built-in browser, '
         + 'or in Chrome with chrome://flags/#enable-webmcp-testing switched on, and the '
         + 'tools below register on load.';
  } else if (a.available) {
    const calls = `${a.calls || 0} call${a.calls === 1 ? '' : 's'}`;
    if (!a.seen) {
      tone = 'ok';
      tag = 'TOOLS READY';
      line = `${live} registered · nothing has called one yet`;
    } else if (a.tool) {
      tone = 'active';
      tag = 'AGENT';
      line = `running ${a.tool}`;
    } else if (a.quiet) {
      tone = 'warn';
      tag = 'AGENT';
      line = `quiet since ${clock(a.lastAt)} · ${calls}`;
    } else {
      tone = 'active';
      tag = 'AGENT';
      line = `attached · ${calls}`;
    }
  }

  if (el.avail.textContent !== tag) el.avail.textContent = tag;
  el.avail.dataset.tone = tone;
  if (el.presence.textContent !== line) el.presence.textContent = line;
  el.hint.hidden = !hint;
  if (el.hint.textContent !== hint) el.hint.textContent = hint;

  const why = a.available ? 'withdrawn until a board is linked' : 'not registered';
  const html = tools.map(t => `
    <li class="tool" data-kind="${t.readOnly ? 'read' : 'write'}" data-registered="${t.registered ? 'true' : 'false'}">
      <span class="tool__kind">${t.readOnly ? 'read' : 'write'}</span>
      <span class="tool__name">${esc(t.name)}</span>
      <span class="tool__title">${esc(t.title)}${t.registered ? '' : `<span class="tool__state">${why}</span>`}</span>
    </li>`).join('');
  if (html !== lastTools) { lastTools = html; el.tools.innerHTML = html; }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
