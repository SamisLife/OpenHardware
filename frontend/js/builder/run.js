/* ============================================================================
   run.js — the build loop, running against the board that is actually plugged in.
   ----------------------------------------------------------------------------
   This is the FALLBACK, and the one rule it follows is that it must not
   pretend. When no agent is calling tools, this local search advances the
   loop instead, and it says so:

     what is real     every number attributed to the hardware. Largest free
                      PSRAM block, die temperature, frame rate, frame size and
                      byte count are read from live telemetry, and the camera is
                      genuinely switched on to get them. The search over
                      configurations is real code making a real decision from
                      those readings. On a board that accepts a runtime `cfg`,
                      APPLY is real too: the configuration chosen is the one
                      the board then runs and the one the numbers describe.

     what is not      SYNTHESIZE, because the decision is the local search's
                      and not an agent's. And on a board with no `cfg`, the
                      COMPILE, FLASH and BOOT CONFIRM that would have been
                      needed instead — nothing is compiled and nothing is
                      written. Those steps are marked `sim` and the console
                      renders them differently, because a build log that shows
                      a flash which did not happen is worse than no build log.

   The seam is WebMCP tools. An agent in the browser calls run_experiment,
   set_camera_config and flash_image; they run in this tab through the same
   effectors this loop is handed, and write to the same attempts. Whoever is
   driving, the page shows one history.

   Attempt one is uncalibrated on purpose — see the note in plan.js. It is
   allowed to be wrong, out loud, and the recovery is the point.
   ========================================================================== */

import { state, applyWorkOrder, applyFirmware, upsertAttempt, applyLimits } from '../state.js';
import { parseObjective } from './objective.js';
import {
  LADDER, nextCandidate, calibrate, projectFps, fbBytes, feasible, label, fmtMB, pixels,
} from './plan.js';
import { requestGate, approvePending, holdPending, cancelPending, pendingGate } from './gate.js';

const ABORT = Symbol('build-abort');
const MAX_ATTEMPTS = 5;

/**
 * Step durations. The simulated ones are compressed maybe 6:1 against a real
 * ESP-IDF build; the two measurement windows are not compressed at all,
 * because they are how long the board is actually watched for.
 *
 * Overridable so the loop can be exercised end to end in a test without
 * waiting a minute for it — and so real build times can replace these when
 * there is a real builder behind them, without touching the loop.
 */
export const DEFAULT_TIMINGS = {
  observe: 900, synthesize: 1500, compile: 2600, flash: 1800,
  confirm: 900, frame: 4200, soak: 6500, between: 1100, tick: 80,
};

/* ------------------------------------------------------------------------ */

/**
 * @param {object} opts
 *   goal        what the operator typed
 *   setCamera   (on:boolean) => Promise — turns capture on to measure a rate
 *   setConfig   ({size, quality}) => Promise<{applied, error}> — applies a
 *               camera configuration at runtime, when the board accepts one.
 *               The same effector the set_camera_config tool uses. Absent, or
 *               on a board with no `cfg`, the loop falls back to marking the
 *               build steps as not having happened.
 *   onDone      called when the run finishes or is abandoned
 * @returns {{stop, approve, hold}}
 */
export function startBuild({ goal, setCamera = async () => {}, setConfig = null, onDone, timings } = {}) {
  const T = { ...DEFAULT_TIMINGS, ...(timings || {}) };
  let stopped = false;
  const waits = new Set();
  /* Whether the gate currently pending is this run's, so stop() cancels its
     own and never one an agent's tool is waiting on. */
  const ctl = { owns: false };

  const wait = ms => new Promise((resolve, reject) => {
    if (stopped) return reject(ABORT);
    const id = setTimeout(() => { waits.delete(id); resolve(); }, ms);
    waits.add(id);
  });

  const o = parseObjective(goal);
  const wo = `wo_${Math.random().toString(16).slice(2, 8)}`;

  run({ o, wo, wait, ctl, setCamera, setConfig, T, stopped: () => stopped })
    .catch(err => { if (err !== ABORT) console.error('[openhardware builder]', err); })
    .finally(() => { if (!stopped) onDone?.(); });

  return {
    stop() {
      stopped = true;
      for (const id of waits) clearTimeout(id);
      waits.clear();
      if (ctl.owns) cancelPending();
      if (state.workOrder && state.workOrder.status === 'running') {
        applyWorkOrder({ status: 'abandoned' });
      }
    },
    /* The buttons answer whatever gate is pending — this run's or a tool's.
       Kept on the handle so callers that only know about the run still work. */
    approve() { approvePending(); },
    hold() { holdPending(); },
  };
}

/* ------------------------------------------------------------------------ */
/* reading the board                                                         */
/* ------------------------------------------------------------------------ */

/** The frame size the board is actually running, if it has sent a frame. */
function runningSize() {
  const f = state.frame;
  if (f?.width > 0 && f?.height > 0) return { name: sizeName(f.width, f.height), w: f.width, h: f.height };
  return null;
}

function sizeName(w, h) {
  return LADDER.find(s => s.w === w && s.h === h)?.name || `${w}×${h}`;
}

/**
 * Watch live telemetry for a window and report what the board did.
 *
 * Averages of what actually arrived, plus the count — so a window that caught
 * two samples is distinguishable from one that caught twenty, and a window
 * that caught none reports nothing rather than zero.
 */
async function measure(wait, ms) {
  const from = Date.now();
  await wait(ms);

  const rows = state.telemetry.buffer.filter(s => !s.gap && s.t >= from);
  const pick = key => rows.map(r => r[key]).filter(Number.isFinite);
  const avg = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

  const temps = pick('tempC');
  return {
    n: rows.length,
    fps: avg(pick('fps')),
    tempC: avg(temps),
    tempPeak: temps.length ? Math.max(...temps) : null,
    heapFree: avg(pick('heapFree')),
    psramFree: avg(pick('psramFree')),
    largestBlock: rows.length
      ? Math.min(...pick('psramLargestBlock').concat(Infinity))
      : null,
    windowMs: Date.now() - from,
  };
}

const isLive = () => state.device.link === 'linked' && !!state.telemetry.latest;
const hasCamera = () => state.peripherals.camera?.state === 'ok';

/* ------------------------------------------------------------------------ */
/* the loop                                                                  */
/* ------------------------------------------------------------------------ */

async function run({ o, wo, wait, ctl, setCamera, setConfig, T, stopped }) {
  /* Whether a chosen configuration can be put on the board without a build.
     Decided by what the board advertised, never by what this page would like. */
  const runtime = () => typeof setConfig === 'function' && state.peripherals.cfg === true;

  applyWorkOrder({
    id: wo,
    goal: o.goal,
    constraints: o.chips,
    targetFps: o.targetFps,
    status: 'running',
    createdAt: Date.now(),
    by: 'loop',
    /* Rendered as a standing banner. The console says what it is once, at the
       top, rather than leaving it to be inferred from step markers. */
    rehearsal: runtime()
      ? 'The local search is driving — no agent is calling tools. Configurations are '
        + 'applied to the board at runtime; nothing is compiled or flashed.'
      : 'The local search is driving — no agent is calling tools. Measurements come '
        + 'from the board; this board has no runtime config, so build and flash steps '
        + 'do not happen.',
  });

  /* A frame-rate floor is also a limit line on the recorder, so the constraint
     is visible on the chart and not only in the log. */
  const tempCap = o.constraints.find(c => c.metric === 'temp' && c.op === '<=');
  if (tempCap) applyLimits({ tempC: tempCap.value });

  const images = [];
  const ruledOut = new Set();
  let calib = null;
  let best = null;
  let n = 0;

  while (n < MAX_ATTEMPTS && !stopped()) {
    n++;
    const A = attempt(n, wo, wait, ctl, T);
    await A.open();

    /* ---- 1. OBSERVE — entirely real ---------------------------------- */
    await A.stepStart('observe', 'OBSERVE', 'reading live telemetry from the board');
    const base = await measure(wait, T.observe);

    if (!isLive()) {
      await A.stepEnd('observe', 'no telemetry — the board is not reporting', 'fail');
      await A.close('failed', null, {
        observed: 'No heartbeat while the work order was open.',
        hypothesis: 'Nothing can be optimised against a board that is not reporting. '
                  + 'This is a link problem, not a firmware one.',
        change: 'None. The loop stops rather than iterating blind.',
        result: 'Abandoned before any change was proposed.',
      });
      applyWorkOrder({ status: 'failed' });
      return;
    }

    const largest = Number.isFinite(base.largestBlock) ? base.largestBlock : null;
    const sensor = state.peripherals.camera?.sensor || 'unknown sensor';
    await A.stepEnd('observe',
      `${sensor} · ${fmtMB(largest)} largest free PSRAM block · ${base.tempC?.toFixed(1)} °C · `
      + `${base.n} samples in ${(base.windowMs / 1000).toFixed(1)} s`, 'pass');

    /* ---- 2. SYNTHESIZE — real search, simulated planner --------------- */
    await A.stepStart('synthesize', 'SYNTHESIZE', 'scoring frame sizes against memory and the measured rate');
    const fits = feasible(largest);
    const cand = nextCandidate(o, { largestBlock: largest, calib, ruledOut });

    if (!cand) {
      await A.stepEnd('synthesize', 'no untried configuration fits this board', 'fail');
      await A.close('failed', null, {
        observed: `Every frame size on the ladder has been tried or ruled out. Largest contiguous PSRAM block is ${fmtMB(largest)}.`,
        hypothesis: 'The constraint cannot be met on this hardware with this sensor.',
        change: 'None left to make.',
        result: 'Search exhausted. The honest answer is that the goal is out of reach here.',
      });
      applyWorkOrder({ status: 'failed' });
      return;
    }

    /* Marked sim not because the search is fake — it is real code on real
       readings — but because the decision is the local fallback's and not an
       agent's. The line is drawn at who decided, and it stays honest. */
    await A.stepEnd('synthesize',
      `${fits.length} of ${LADDER.length} sizes fit · chose ${label(cand.size)} · ${cand.why}`,
      'pass', { sim: true });

    const version = runtime() ? null : `0.${n}.0`;

    if (runtime()) {
      /* ---- 3. APPLY — real: the board is asked, and its answer is kept --- */
      await A.stepStart('apply', 'APPLY', `cfg ${label(cand.size)} q${cand.quality}`);
      let r;
      try { r = await setConfig({ size: cand.size.name, quality: cand.quality }); }
      catch (err) { r = { applied: false, error: err.message }; }

      if (!r?.applied) {
        await A.stepEnd('apply', `refused — ${r?.error || 'no acknowledgement'}`, 'fail');
        ruledOut.add(cand.size.name);
        await A.close('failed', null, {
          observed: `The board refused ${label(cand.size)}: ${r?.error || 'no acknowledgement'}.`,
          hypothesis: 'A configuration the driver will not accept cannot be measured, whatever the arithmetic said.',
          change: `Ruling out ${cand.size.name}. The next candidate comes from what the board will take.`,
          result: 'Nothing measured on this attempt. The board is still running what it had.',
        });
        await wait(T.between);
        continue;
      }
      await A.stepEnd('apply',
        `board confirmed ${label(cand.size)} q${cand.quality} — running it now, no build needed`, 'pass');
    } else {
      /* ---- 3-5. the parts that cannot happen on this board -------------- */
      await A.step('compile', 'COMPILE',
        `would build ${label(cand.size)} q${cand.quality} fb_count ${cand.fbCount} · `
        + `${fmtMB(fbBytes(cand.size, cand.fbCount))} of framebuffers`,
        T.compile, 'pass', { sim: true });

      await A.step('flash', 'FLASH',
        'not written — nothing here writes firmware without a gate, and no agent asked',
        T.flash, 'skipped', { sim: true });

      images.unshift({
        version, sha: shaFor(wo, n), bytes: (1180 + n * 14) * 1024,
        slot: n % 2 ? 'ota_0' : 'ota_1', builtAt: Date.now(), outcome: 'simulated',
        note: `${label(cand.size)}, q${cand.quality}, fb_count ${cand.fbCount}. Not built and not flashed.`,
      });
      applyFirmware(images);

      await A.step('boot_confirm', 'BOOT CONFIRM',
        'skipped — no image was written, so the board never rebooted',
        T.confirm, 'skipped', { sim: true });
    }

    /* ---- 6. FRAME CHECK — real, when there is a camera ---------------- */
    let shot = null;
    if (hasCamera()) {
      await A.stepStart('frame_check', 'FRAME CHECK', 'streaming from the board to measure the real rate');
      try { await setCamera(true); } catch { /* reported by the measurement */ }
      shot = await measure(wait, T.frame);

      const actual = runningSize();
      if (actual && Number.isFinite(shot.fps) && shot.fps > 0) {
        /* The one measurement everything downstream is projected from. */
        calib = calibrate({ fps: shot.fps, size: actual });
        await A.stepEnd('frame_check',
          `${shot.fps.toFixed(1)} fps measured at ${label(actual)} — the configuration the board is `
          + `actually running · ${(state.frame.bytes / 1024).toFixed(1)} KB per frame`, 'pass');
      } else {
        await A.stepEnd('frame_check',
          shot.n ? 'camera on, but no frames arrived in the window' : 'no telemetry in the window',
          'fail');
      }
    } else {
      await A.step('frame_check', 'FRAME CHECK',
        'no camera attached — nothing to measure, every rate below is projected',
        T.tick * 8, 'skipped');
    }

    /* ---- 7. SOAK — real ---------------------------------------------- */
    await A.stepStart('soak', 'SOAK', `holding for ${(T.soak / 1000).toFixed(0)} s and watching the die`);
    const soak = await measure(wait, T.soak);
    const soakOk = !tempCap || (soak.tempPeak !== null && soak.tempPeak <= tempCap.value);
    await A.stepEnd('soak',
      soak.tempPeak !== null
        ? `peak ${soak.tempPeak.toFixed(1)} °C over ${(soak.windowMs / 1000).toFixed(0)} s`
          + (tempCap ? ` · limit ${tempCap.value} °C` : '')
        : 'no samples in the window',
      soakOk ? 'pass' : 'fail');

    /* ---- verdict ------------------------------------------------------ */
    const proj = projectFps(cand.size, calib);
    const meetsFps = o.targetFps === null || (proj.fps !== null && proj.fps >= o.targetFps);
    const measuredHere = shot && Number.isFinite(shot.fps) && runningSize();

    if (!meetsFps) {
      ruledOut.add(cand.size.name);
      await A.close('failed', version, {
        observed: measuredHere
          ? `${shot.fps.toFixed(1)} fps measured at ${label(runningSize())}, `
            + `${soak.tempPeak?.toFixed(1)} °C peak, ${fmtMB(largest)} largest contiguous PSRAM block.`
          : `${fmtMB(largest)} largest contiguous PSRAM block. No frame rate could be measured.`,
        hypothesis: `${label(cand.size)} fits memory — ${fmtMB(fbBytes(cand.size, cand.fbCount))} of `
          + `framebuffers against a ${fmtMB(largest)} block — but memory was never the binding constraint. `
          + `At ${(pixels(cand.size) / 1e6).toFixed(2)} MP it ${proj.fps === null ? 'cannot be projected at all' : `projects to ${proj.fps.toFixed(1)} fps`}, `
          + `under the ${o.targetFps} fps floor.`,
        change: `Ruling out ${cand.size.name} and everything above it. Next candidate comes from the `
          + `measured throughput rather than from what fits.`,
        result: `Rejected on projection, not on a reading — nothing was flashed. ${proj.note || ''}`.trim(),
      }, calib ? {
        key: `throughput.${(state.device.board || 'board').replace(/\s+/g, '_').toLowerCase()}`,
        value: `${(calib.k / 1e6).toFixed(1)} MP/s at q12`,
      } : null);
      await wait(T.between);
      continue;
    }

    /* Met. Whether that is a measurement or a projection is the difference
       between a result and a forecast, and it gets said in the verdict. */
    best = { cand, proj, soak, shot };
    const confirmed = measuredHere && runningSize().name === cand.size.name;

    await A.gate({
      action: `Commit "${cand.size.name} is the largest size holding ${o.targetFps ?? '—'} fps" to procedural memory`,
      rationale: 'A learned board limit narrows every future work order on this hardware. '
               + 'It outlives this run, so it is not something a model gets to write on its own.',
      policy: 'auto-approves in 20 s for the rehearsal',
      timeoutMs: 20000,
    });

    await A.close('passed', version, {
      observed: measuredHere
        ? `${shot.fps.toFixed(1)} fps measured at ${label(runningSize())}; peak die temperature `
          + `${soak.tempPeak?.toFixed(1)} °C over the ${(soak.windowMs / 1000).toFixed(0)} s soak.`
        : `${fmtMB(largest)} largest contiguous PSRAM block; no frame rate could be measured on this board.`,
      hypothesis: `${label(cand.size)} is the largest size that both fits the contiguous block `
        + `(${fmtMB(fbBytes(cand.size, cand.fbCount))} of framebuffers) and holds the rate floor.`,
      /* Written as the fields of a camera_config_t, with the dimensions
         spelled out. Someone reading the log should be able to paste this
         into firmware without going and looking up what VGA means. */
      change: `frame_size FRAMESIZE_${cand.size.name} (${cand.size.w}×${cand.size.h}), `
        + `jpeg_quality ${cand.quality}, fb_count ${cand.fbCount}, `
        + `grab_mode CAMERA_GRAB_LATEST.`,
      result: confirmed
        ? `Goal met and measured: ${proj.fps.toFixed(1)} fps against a ${o.targetFps} fps floor.`
        : `Goal met in projection — ${proj.fps.toFixed(1)} fps against a ${o.targetFps} fps floor, `
          + `extrapolated from ${calib ? `${calib.atFps.toFixed(1)} fps measured at ${label(calib.atSize)}` : 'no measurement'}. `
          + (runtime()
            ? 'The board did not produce frames at the applied size in the window, so this is not yet a reading.'
            : 'Confirming it means running this configuration, which this board cannot take at runtime and nothing here flashed.'),
    }, {
      key: `camera.max_size_at_${o.targetFps ?? 'n'}fps`,
      value: `${cand.size.name} ${cand.size.w}×${cand.size.h}`,
    });

    applyWorkOrder({ status: 'passed', closedAt: Date.now() });
    return;
  }

  if (!stopped()) applyWorkOrder({ status: best ? 'passed' : 'failed', closedAt: Date.now() });
}

/* ------------------------------------------------------------------------ */
/* one attempt                                                               */
/* ------------------------------------------------------------------------ */

function attempt(n, wo, wait, ctl, T) {
  const startedAt = Date.now();
  const began = new Map();

  const api = {
    async open() {
      upsertAttempt({ n, status: 'running', startedAt, steps: [], reasoning: {} });
      await wait(T.tick * 4);
    },

    async stepStart(id, label, detail) {
      began.set(id, Date.now());
      upsertAttempt({
        n, steps: [{ id, label, detail, status: 'running', ms: null, key: idemKey(wo, n, id, detail) }],
      });
      await wait(T.tick);
    },

    async stepEnd(id, detail, status, extra = {}) {
      const t0 = began.get(id);
      upsertAttempt({
        n, steps: [{ id, detail, status, ms: t0 ? Date.now() - t0 : null, ...extra }],
      });
      await wait(T.tick * 2);
    },

    async step(id, label, detail, ms, status, extra = {}) {
      await api.stepStart(id, label, detail);
      await wait(ms);
      await api.stepEnd(id, detail, status, { ms, ...extra });
    },

    async gate({ action, rationale, policy, timeoutMs }) {
      upsertAttempt({ n, status: 'gated', gate: { state: 'pending', action, rationale, policy } });

      /* The shared gate, so the same two buttons answer this and a tool's. If
         a tool's gate is already waiting the loop does not queue behind it —
         it takes the policy answer and moves on, because two gates pending at
         once is a state the buttons cannot express. */
      let by;
      ctl.owns = !pendingGate();
      try {
        by = ctl.owns
          ? await requestGate({ action, rationale, policy, timeoutMs })
          : 'policy';
      } finally {
        ctl.owns = false;
      }
      if (by === 'cancelled') throw ABORT;

      upsertAttempt({
        n, status: 'running',
        gate: {
          state: 'approved', action, rationale, policy,
          approvedBy: by === 'operator' ? 'operator' : by === 'held' ? 'held, then released' : 'policy · auto',
          approvedAt: Date.now(),
        },
      });
      await wait(T.tick * 6);
    },

    async close(status, firmware, reasoning, learned) {
      upsertAttempt({ n, status, firmware, reasoning, learned, durationMs: Date.now() - startedAt });
      await wait(T.tick * 4);
    },
  };

  return api;
}

/* ------------------------------------------------------------------------ */

/** Same construction as the mock feed's, so the two look alike in the log. */
function idemKey(wo, n, stepId, payload) {
  let h = 0x811c9dc5;
  for (const ch of `${wo}:${n}:${stepId}:${payload}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  let h2 = Math.imul(0x9e3779b9 ^ h, 0x85ebca6b) >>> 0;
  return h.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

function shaFor(wo, n) {
  return idemKey(wo, n, 'image', 'sha').slice(0, 10);
}
