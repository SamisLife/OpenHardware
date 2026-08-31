/* ============================================================================
   format.js — how numbers are spoken on this page.
   ----------------------------------------------------------------------------
   One rule, applied everywhere: absent data reads as an em-dash pair, never as
   zero. A board that is rebooting has no temperature, and printing 0.0 would be
   a false reading rather than a missing one.

   Units are returned separately from values wherever both are shown, so the
   value can carry tabular figures and the unit can be dimmed alongside it.
   ========================================================================== */

/** What a readout shows when there is no measurement. */
export const NIL = '––';

export const KB = 1024;
export const MB = 1024 * 1024;

/** Fixed-decimal, or NIL when the value is not a finite number. */
export function num(v, digits = 0) {
  return Number.isFinite(v) ? v.toFixed(digits) : NIL;
}

/** Bytes as KB or MB, chosen by magnitude. Returns [value, unit]. */
export function bytes(v) {
  if (!Number.isFinite(v)) return [NIL, ''];
  if (v >= MB) return [(v / MB).toFixed(2), 'MB'];
  if (v >= KB) return [(v / KB).toFixed(0), 'KB'];
  return [String(Math.round(v)), 'B'];
}

/** Seconds as the uptime format an embedded engineer expects: 1d 04:12:38. */
export function uptime(s) {
  if (!Number.isFinite(s) || s < 0) return NIL;
  s = Math.floor(s);
  const d = Math.floor(s / 86400);
  const h = String(Math.floor((s % 86400) / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = String(s % 60).padStart(2, '0');
  return d > 0 ? `${d}d ${h}:${m}:${sec}` : `${h}:${m}:${sec}`;
}

/** Wall clock as HH:MM:SS, 24h. */
export function clock(t) {
  if (!Number.isFinite(t) || t <= 0) return NIL;
  const d = new Date(t);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Relative age, for frame staleness. */
export function ago(t, now = Date.now()) {
  if (!Number.isFinite(t) || t <= 0) return NIL;
  const s = (now - t) / 1000;
  if (s < 0) return NIL;
  if (s < 1) return `${Math.round(s * 1000)}ms`;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m`;
}

/**
 * RSSI in dBm mapped to a 0..4 bar count.
 *
 * Banded rather than linear, using the thresholds the ESP-IDF examples use —
 * signal strength is not perceived linearly and a linear mapping shows four
 * bars for a link that is about to drop.
 */
export function rssiBars(dbm) {
  if (!Number.isFinite(dbm)) return 0;
  if (dbm >= -55) return 4;
  if (dbm >= -66) return 3;
  if (dbm >= -77) return 2;
  if (dbm >= -88) return 1;
  return 0;
}

/**
 * The inferno colormap, sampled at `t` in 0..1.
 *
 * Reserved for die temperature and nothing else. A trace that changes hue as
 * the part heats is legible from across a room in a way that a fixed accent
 * colour is not, and giving the ramp a second meaning would cost that.
 */
const INFERNO = [
  [0.00, [24, 13, 46]],
  [0.20, [77, 16, 105]],
  [0.40, [140, 35, 105]],
  [0.60, [196, 60, 78]],
  [0.75, [234, 107, 38]],
  [0.90, [249, 167, 43]],
  [1.00, [251, 224, 138]],
];

export function inferno(t) {
  t = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0));
  for (let i = 1; i < INFERNO.length; i++) {
    const [p1, c1] = INFERNO[i - 1];
    const [p2, c2] = INFERNO[i];
    if (t > p2) continue;
    const k = (t - p1) / (p2 - p1);
    return `rgb(${Math.round(c1[0] + (c2[0] - c1[0]) * k)},`
         + `${Math.round(c1[1] + (c2[1] - c1[1]) * k)},`
         + `${Math.round(c1[2] + (c2[2] - c1[2]) * k)})`;
  }
  return 'rgb(251,224,138)';
}

/**
 * A die temperature as ink for text.
 *
 * The bottom of the ramp is near-black, which is correct for a filled area on
 * dark paper and unreadable as type. Readouts therefore start a third of the
 * way up, keeping an idle board legible while the climb toward a ceiling stays
 * obvious. `hi` is the declared ceiling when one exists; without one the ramp
 * spans a plain ambient-to-hot range rather than inventing a limit.
 */
export function tempColor(c, hi = null) {
  const top = Number.isFinite(hi) ? hi + 12 : 90;
  const t = (c - 30) / (top - 30);
  return inferno(0.34 + 0.66 * Math.max(0, Math.min(1, t)));
}
