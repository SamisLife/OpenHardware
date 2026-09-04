/* ============================================================================
   prefs.js — the few things the page remembers about a person.
   ----------------------------------------------------------------------------
   Kept apart from the model on purpose. state.js holds what the board said;
   this holds what the person said, which outlives the board, the session and
   the tab. One JSON object under one key, read and written whole, so a page
   that stores two preferences does not leave two ways of getting it wrong.

   Every call tolerates a browser that refuses storage — a private window, a
   host that blocks site data, a test runner with no window at all — by
   answering with the fallback. A preference that cannot be kept is not an
   error; it is the default, again.
   ========================================================================== */

const KEY = 'openhardware.prefs';

function store() {
  try { return globalThis.localStorage ?? null; }
  catch { return null; }
}

function readAll(s) {
  try { return JSON.parse(s.getItem(KEY) || '{}') || {}; }
  catch { return {}; }
}

/** The stored value, or `fallback` when nothing was ever stored. */
export function readPref(name, fallback) {
  const s = store();
  if (!s) return fallback;
  const all = readAll(s);
  return Object.prototype.hasOwnProperty.call(all, name) ? all[name] : fallback;
}

/** @returns whether the value was actually kept. */
export function writePref(name, value) {
  const s = store();
  if (!s) return false;
  try {
    const all = readAll(s);
    all[name] = value;
    s.setItem(KEY, JSON.stringify(all));
    return true;
  } catch {
    return false;
  }
}
