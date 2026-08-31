/* ============================================================================
   plan.js — deciding what to try next, from what the board actually said.
   ----------------------------------------------------------------------------
   The premise of the whole project is that "the highest resolution this board
   can sustain" is not answerable from training data: it depends on how much
   contiguous PSRAM survives Wi-Fi init on THIS board, what the sensor is, and
   how those interact thermally. So the search here is deliberately not a
   lookup table of known-good configs. It reads two numbers off the hardware —
   largest free PSRAM block, and a measured frame rate — and everything else
   follows from them.

   Two consequences worth stating, because they are what make the loop real
   rather than staged:

     A board with 8 MB of PSRAM and a board with none walk different paths and
     stop at different answers. Nothing here has a favourite.

     The first attempt is uncalibrated ON PURPOSE. Before a frame rate has been
     measured there is no throughput constant, so the opening candidate is
     chosen on memory alone and is usually too ambitious. That is not a scripted
     stumble — it is what having no measurement costs, and the recovery from it
     is the thing worth watching.

   Every projection this file produces is labelled as one. See `measured` on
   the returned estimate: the console renders projected and measured numbers
   differently, because presenting a model's output as a reading would be the
   exact failure the rest of the console is built to avoid.
   ========================================================================== */

/**
 * The OV-series frame sizes esp32-camera exposes, smallest first.
 * Names match FRAMESIZE_* so a config in the build log is one a person can
 * paste into a camera_config_t.
 */
export const LADDER = [
  { name: 'QQVGA', w: 160, h: 120 },
  { name: 'QVGA',  w: 320, h: 240 },
  { name: 'CIF',   w: 400, h: 296 },
  { name: 'HVGA',  w: 480, h: 320 },
  { name: 'VGA',   w: 640, h: 480 },
  { name: 'SVGA',  w: 800, h: 600 },
  { name: 'XGA',   w: 1024, h: 768 },
  { name: 'HD',    w: 1280, h: 720 },
  { name: 'SXGA',  w: 1280, h: 1024 },
  { name: 'UXGA',  w: 1600, h: 1200 },
];

export const pixels = s => s.w * s.h;

/**
 * Framebuffer cost, in JPEG mode, per the driver's own arithmetic.
 *
 * esp32-camera sizes a JPEG receive buffer as width * height / 5 —
 * cam_hal.c:588, `cam_obj->recv_size = cam_obj->width * cam_obj->height / 5`.
 * It is a compression assumption, not a measurement, and the driver adds a DMA
 * half-buffer and an alignment margin on top; a tenth is allowed for that here.
 *
 * Worth stating because the intuitive number is wrong by more than double: a
 * UXGA frame is 3.84 MB at two bytes a pixel, and that figure is real for
 * RGB565 and irrelevant to JPEG. Sizing against it would rule out configs this
 * board can run comfortably.
 */
export function fbBytes(size, fbCount = 2) {
  return Math.round((pixels(size) / 5) * 1.1 * fbCount);
}

/**
 * Frame rate the sensor can deliver at a given size.
 *
 * `k` is a throughput constant in pixels per second, calibrated from one real
 * measurement on this board. Before that measurement exists there is no honest
 * answer, and this says so with `measured: false` and a wide margin rather
 * than inventing a plausible number.
 *
 * The ceiling matters: an OV2640 at a 20 MHz XCLK will not exceed roughly
 * 30 fps however few pixels it is asked for, so a pure pixel-rate model would
 * promise 200 fps at QQVGA and be believed.
 */
export function projectFps(size, calib) {
  const ceiling = calib?.ceilingFps ?? 30;
  if (!calib?.k) return { fps: null, measured: false, note: 'no measurement yet' };

  const fps = Math.min(ceiling, calib.k / pixels(size));
  const far = calib.atPixels
    ? Math.max(pixels(size), calib.atPixels) / Math.min(pixels(size), calib.atPixels)
    : 1;

  return {
    fps,
    measured: false,
    /* How far this is being extrapolated from the one point that was actually
       measured. A projection three doublings away deserves less trust and the
       reasoning text says so. */
    extrapolation: far,
    note: far > 2.2
      ? `projected ${far.toFixed(1)}× from the measured point`
      : 'projected from the measured point',
  };
}

/** Turn one real telemetry sample into the throughput constant. */
export function calibrate({ fps, size, ceilingFps }) {
  if (!Number.isFinite(fps) || fps <= 0 || !size) return null;
  return {
    k: fps * pixels(size),
    atPixels: pixels(size),
    atFps: fps,
    atSize: size,
    ceilingFps: ceilingFps ?? Math.max(30, fps * 1.2),
  };
}

/* ------------------------------------------------------------------------ */

/**
 * Which frame sizes this board could hold at all.
 *
 * Uses the largest CONTIGUOUS free block, not total free PSRAM. They diverge
 * badly once the Wi-Fi stack has fragmented the heap, and the difference is
 * the difference between "out of memory" and "out of contiguous memory" —
 * two problems with completely different fixes, and the reason the harness
 * reports both.
 */
export function fitsMemory(size, largestBlock, fbCount = 2) {
  if (!Number.isFinite(largestBlock) || largestBlock <= 0) return null;
  return fbBytes(size, fbCount) <= largestBlock;
}

export function feasible(largestBlock, fbCount = 2) {
  return LADDER.filter(s => fitsMemory(s, largestBlock, fbCount) !== false);
}

/**
 * The next configuration to try.
 *
 * Walks DOWN from the largest size that fits memory and stops at the first one
 * projected to hold the frame-rate floor — the largest config that meets the
 * constraint, which is what "maximum resolution that maintains N fps" asks
 * for. Sizes already ruled out by a previous attempt are skipped, so the
 * search never repeats itself and always terminates.
 *
 * @param {object} o        parsed objective
 * @param {object} facts    { largestBlock, calib, ruledOut:Set<string>, fbCount }
 * @returns {{size, fbCount, quality, why, projected}|null}
 */
export function nextCandidate(o, facts) {
  const { largestBlock, calib, ruledOut = new Set(), fbCount = 2 } = facts;

  const fits = feasible(largestBlock, fbCount).filter(s => !ruledOut.has(s.name));
  if (!fits.length) return null;

  const floor = o.targetFps;
  const wantSmall = o.maximise === 'fps';

  /* Maximising frame rate is the same search upside down. */
  const ordered = wantSmall ? fits.slice() : fits.slice().reverse();

  for (const size of ordered) {
    const p = projectFps(size, calib);
    /* With no calibration, memory is the only evidence there is — take the
       most ambitious config that fits and let the measurement correct it. */
    if (p.fps === null) {
      return {
        size, fbCount, quality: 12, projected: p,
        why: `largest size whose framebuffers fit the ${fmtMB(largestBlock)} contiguous block; no frame rate measured yet`,
      };
    }
    if (floor === null || p.fps >= floor) {
      return {
        size, fbCount, quality: 12, projected: p,
        why: floor === null
          ? `largest size that fits, ${p.fps.toFixed(1)} fps projected`
          : `largest size projected to hold ${floor} fps (${p.fps.toFixed(1)} projected)`,
      };
    }
  }

  /* Everything that fits is projected below the floor. The smallest is still
     the best answer available, and the caller reports the shortfall. */
  const last = ordered[ordered.length - 1];
  const p = projectFps(last, calib);
  return {
    size: last, fbCount, quality: 12, projected: p,
    why: `no size that fits is projected to reach ${floor} fps; smallest available is the closest`,
    short: true,
  };
}

export function fmtMB(bytes) {
  return Number.isFinite(bytes) ? `${(bytes / 1048576).toFixed(2)} MB` : '—';
}

export const label = s => `${s.name} ${s.w}×${s.h}`;
