/* ============================================================================
   format.js — how numbers are spoken on this page.
   ----------------------------------------------------------------------------
   One rule, applied everywhere: absent data reads as an em-dash pair, never as
   zero. A board that is rebooting has no temperature, and printing 0.0 would be
   a false reading rather than a missing one.
   ========================================================================== */

/** What a readout shows when there is no measurement. */
export const NIL = '––';

/** Fixed-decimal, or NIL when the value is not a finite number. */
export function num(v, digits = 0) {
  return Number.isFinite(v) ? v.toFixed(digits) : NIL;
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
 * obvious.
 */
export function tempColor(c, lo = 30, hi = 90) {
  const t = (c - lo) / (hi - lo);
  return inferno(0.34 + 0.66 * Math.max(0, Math.min(1, t)));
}
