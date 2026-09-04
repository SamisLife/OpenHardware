/* ============================================================================
   main.js — mount the instrument, then get out of the way.
   ----------------------------------------------------------------------------
   Every panel is mounted once and repainted from one subscription. Which slices
   changed decides which renderers run, so a burst of telemetry does not repaint
   a camera panel that nothing touched.

   With no source attached the page opens showing exactly what it knows, which
   is nothing: em-dashes across every readout, blank paper advancing on the
   recorder, and a badge saying NO SOURCE. That empty state is designed rather
   than incidental — a board that has not reported and a board reporting zeros
   must never look alike.

   The page opens on bring-up and only reaches the instrument once a board is
   actually reporting. Landing on the instrument is an upgrade a board has to
   earn: arriving there for any remembered identity leaves an operator staring
   at em-dashes with no way back and no explanation.

   ?sim runs the same flow against a simulated board. Scenes are documented in
   js/link/sim.js.
   ========================================================================== */

import {
  state, subscribe, renderAll, applyPeripherals, applyUi,
  applyFirmware, applyWorkOrder, resetAttempts,
} from './state.js';
import {
  removePart, addPart, restoreWiring, waitForState,
} from './state.js';
import { mountStrip } from './strip.js';
import { mountRail, renderRail } from './render/rail.js';
import { mountVitals, renderVitals } from './render/vitals.js';
import { mountCamera, renderCamera } from './render/camera.js';
import { mountPeripherals, renderPeripherals } from './render/peripherals.js';
import {
  mountOnboard, renderOnboard, showOnboard, hideOnboard, resetWire, eraseChecked,
} from './render/onboard.js';
import { mountAgent, renderWorkOrder, renderAttempts, renderGate } from './render/agent.js';
import { mountBelt, renderBelt } from './render/belt.js';
import { mountFirmware, renderFirmware, renderMemory } from './render/firmware.js';
import { approvePending, holdPending } from './builder/gate.js';
import { mountTools, configEffector, flashBuild } from './webmcp.js';
import { fetchManifest } from './link/flash.js';
import { createBuildClient } from './link/build.js';
import { clock } from './format.js';
import { readPref, writePref } from './prefs.js';
import { Session } from './onboard/session.js';
import { describeBringUp } from './onboard/guide.js';
import { webSerialDriver, simulatedDriver } from './link/drivers.js';
import { createFeed } from './link/feed.js';

const $ = sel => document.querySelector(sel);

/* ------------------------------------------------------------------------ */
/* mount                                                                     */
/* ------------------------------------------------------------------------ */

mountRail($('#rail'));
mountVitals($('#vitals'));
mountCamera($('#camera'));
/** Set once a transport is attached; the camera offer writes through it. */
let link = null;

/* The Flash button on each image row is the same write as the flash_image
   tool, through the same gate and into the same build log: one code path
   whether a person or an agent asked. */
mountFirmware($('#firmware'), {
  onFlash: buildId => flashBuild(toolFx, buildId, { requestedBy: 'operator' }),
  onMenu: buildId => applyUi({
    menuFor: state.ui.menuFor === buildId ? null : buildId,
    confirmDelete: null,
  }),
  onReview: buildId => openReview(buildId, 'row'),
  onCloseReview: closeReview,
  /* Two presses, and the second one is the one that says what it does. */
  onDelete: buildId => applyUi({ confirmDelete: buildId }),
  onDeleteConfirm: buildId => deleteBuild(buildId),
});
/* The two buttons answer whatever gate is pending — the loop's, before it
   commits a limit, or a tool's, before it writes to the board. Approve and
   Hold are never tools, which is the whole reason there is a gate. */
mountAgent($('#agent'), {
  onApprove: () => approvePending(),
  onHold: () => { holdPending(); announce('Gate held. Nothing was written.'); },
  onAbandon: () => abandonBuild(),
  /* Reading the code is not answering the question: the gate stays open, and
     a second press closes the listing again. */
  onReviewGate: gate => {
    const open = state.ui.review?.from === 'gate' && state.ui.review?.buildId === gate?.buildId;
    if (open) closeReview();
    else if (gate?.buildId) openReview(gate.buildId, 'gate');
  },
  onCloseReview: closeReview,
});
/* Nowhere to type. What an agent will find when it looks is drawn in the
   slot a form would otherwise occupy. */
mountBelt($('#belt'));

/* An open row menu is dismissed by the next click that is not in it, and by
   Escape — the two ways every menu closes. Without this the only way out is
   the button that opened it, which reads as stuck. Escape also closes an open
   source listing, but never answers the gate: leaving a keystroke able to
   refuse a flash would make Hold reachable by accident. */
document.addEventListener('click', ev => {
  if (!state.ui.menuFor) return;
  if (ev.target.closest?.('.fw__menuwrap')) return;
  applyUi({ menuFor: null, confirmDelete: null });
});
document.addEventListener('keydown', ev => {
  if (ev.key !== 'Escape') return;
  if (state.ui.menuFor) applyUi({ menuFor: null, confirmDelete: null });
  else if (state.ui.review) closeReview();
});
/* The menu is fixed to the viewport so it can escape the table's scroll box
   and the panel above it, which means it does not travel with the row it
   belongs to. Anything that scrolls therefore closes it, rather than leaving
   it pointing at a row that has moved. Capture, because the scroll that
   matters happens inside a panel and does not bubble. */
window.addEventListener('scroll', () => {
  if (state.ui.menuFor) applyUi({ menuFor: null, confirmDelete: null });
}, true);

mountPeripherals($('#vitals'), {
  onCamera: on => chooseCamera(on),
  /* Everything below is a person's: the page asks, the person answers, and
     no tool can answer for them. */
  onRemove: key => removePart(key),
  onAdd: part => addPart(part),
});
$('[data-cam=hide]')?.addEventListener('click', () => chooseCamera(false));

/**
 * Ask the board to start or stop capturing. Nothing else.
 *
 * This is what a tool calls: an agent that switches the camera on to measure
 * a frame rate and off again afterwards has expressed no opinion about
 * whether the person wants to watch, so nothing here touches their choice.
 */
async function setCamera(on) {
  try { await link?.send({ t: 'cam', on }); }
  catch (err) { applyUi({ label: `could not reach the board: ${err.message}` }); }
}

/**
 * The person's answer: show the picture, or hide it.
 *
 * About the picture only. The stream keeps running while the panel is
 * hidden, so the frame rate and the frame age go on being measured and an
 * agent reading them is reading a live camera, not a paused one. Showing
 * again starts the stream only if something else had stopped it.
 * Remembered across visits.
 */
function chooseCamera(on) {
  applyUi({ cameraShown: on });
  writePref('cameraShown', on);
  if (on && !state.peripherals.streaming) return setCamera(true);
  return Promise.resolve();
}


/** The board whose wiring memory is loaded, so a change of board reloads. */
let wiringFor = null;

/**
 * What a previous visit knew about this board.
 *
 * Keyed on the board's own identity rather than on the page, because the
 * wiring belongs to the board: a second board on the same bench has its own
 * header and its own answers.
 */
function restoreWiringFor(s) {
  const id = s.device.id;
  if (!id || id === wiringFor) return;
  wiringFor = id;
  restoreWiring(readPref(`wiring.${id}`, {}));
}

/** Only what a person said is worth remembering; what the board said it will say again. */
function rememberWiring(s) {
  if (!wiringFor) return;
  writePref(`wiring.${wiringFor}`, { parts: s.wiring.parts });
}

/**
 * Apply a camera configuration at runtime and wait for the board to confirm.
 *
 * One implementation, handed to both the build loop and the agent's tools, so
 * an attempt recorded by either was applied the same way and confirmed the
 * same way — by what the board reported back, not by what was sent.
 */
const setConfig = configEffector(async obj => {
  if (!link) return false;
  return link.send(obj);
});

mountOnboard($('#onboard'), {
  onConnect: () => connect(),
  onFlash: () => session?.flash({ eraseAll: eraseChecked() }),
  onListen: () => session?.listen(),
  onContinue: () => session?.continueWithBoard(),
  onRetry: () => retry(),
  /* The flag, not the rung. The flash rung is also active while it is reading
     what the board already has, and warning about that trains somebody to
     dismiss the warning that matters. */
  isWriting: () => !!session?.state.writing,
});

/* The recorder reads the telemetry slice through a function rather than
   importing the model, so it has no opinion about where state lives. */
mountStrip($('[data-ui=strip]'), { read: () => state.telemetry });

const badge = $('[data-ui=source]');
const note = $('[data-ui=label]');
const liveRegion = $('[data-ui=live]');

/* ------------------------------------------------------------------------ */
/* render dispatch                                                           */
/* ------------------------------------------------------------------------ */

subscribe((s, changed) => {
  if (changed.has('device') || changed.has('telemetry')) renderRail(s);
  if (changed.has('telemetry') || changed.has('device') || changed.has('frame')) renderVitals(s);
  /* Peripherals too: the camera panel names the sensor the board reported, so
     it has to repaint when that changes — including when it changes to
     nothing. */
  if (changed.has('frame') || changed.has('device') || changed.has('peripherals')) renderCamera(s);
  if (changed.has('peripherals')) { renderPeripherals(s); syncCameraPanel(s); resumeCamera(s); }
  if (changed.has('wiring')) { renderPeripherals(s); rememberWiring(s); }
  if (changed.has('device')) restoreWiringFor(s);
  if (changed.has('workOrder')) { renderWorkOrder(s); renderBelt(s); }
  /* Attempts drive the learned-limits list too: what the board has been shown
     to do is read off the attempts rather than stored separately, so there is
     no second copy to fall out of step. */
  if (changed.has('attempts')) { renderAttempts(s); renderMemory(s); }
  if (changed.has('memory')) renderMemory(s);
  /* The gate repaints on a ui change too: the source listing it can hold open
     lives in the ui slice, not in the gate itself. */
  if (changed.has('gate') || changed.has('ui')) renderGate(s);
  if (changed.has('gate')) {
    renderSource(s);
    if (s.gate?.state === 'pending') announce('Agent waiting for approval.');
  }
  /* The image rows also carry the Flash buttons, whose disabled state turns on
     the link and on whether a flash is in flight — so they repaint when the
     device or the ui slice moves, not only when the image list does. */
  if (changed.has('firmware') || changed.has('ui') || changed.has('device')) renderFirmware(s);
  if (changed.has('ui')) { renderSource(s); renderBelt(s); syncCameraPanel(s); renderPeripherals(s); }
  narrate(s, changed);
});

/**
 * The camera panel exists while there is a camera behind it and the person
 * wants the picture. Whether frames are flowing is a different fact, drawn
 * inside the panel and on the vitals, never by the panel's presence.
 */
function syncCameraPanel(s) {
  const on = s.peripherals.camera?.state === 'ok' && s.ui.cameraShown !== false;
  document.body.dataset.camera = on ? 'on' : 'off';
}

/** Whether the camera was reported present on the previous paint. */
let camWasOk = false;

/**
 * Put the stream back after a camera comes back.
 *
 * A sensor pulled off its connector and reseated is a fresh driver with
 * streaming off, and the board is right to report that. But nobody decided to
 * stop watching, so asking again would be asking a question already answered —
 * and the answer would have to be given again every time a ribbon moved.
 *
 * Only on the transition into present, and only when the operator had asked
 * for it. A camera that has been there all along is left exactly as it is.
 */
function resumeCamera(s) {
  const isOk = s.peripherals.camera?.state === 'ok';
  const wasOk = camWasOk;
  camWasOk = isOk;

  if (!isOk || wasOk) return;
  if (!s.peripherals.streamWanted || s.peripherals.streaming) return;

  announce('Camera back. Resuming the stream.');
  setCamera(true);
}

function renderSource(s) {
  const src = s.ui.source;
  badge.textContent = src ? String(src).toUpperCase() : 'NO SOURCE';
  /* Cyan only for a source with real hardware behind it. Anything synthetic
     stays amber, so a demonstration can never be mistaken for a measurement.
     An agent being present changes none of this: it is drawn in the note,
     never in the colour, because a model calling tools against a simulated
     board is still looking at a simulation. */
  badge.dataset.live = String(src === 'usb' || src === 'server');
  note.textContent = [
    s.ui.label || '',
    s.gate?.state === 'pending' ? 'Agent waiting for approval.' : presenceLine(s.ui.agent),
  ].filter(Boolean).join(' · ');
}

/**
 * What the page has inferred about an agent, in the voice of the link
 * narration. There is no presence event to draw from, so this is the first
 * call, the running tool, and silence — nothing the page did not observe.
 */
function presenceLine(a) {
  if (!a) return '';
  if (a.available === false) return 'WebMCP tools are available in a WebMCP-enabled browser.';
  if (!a.seen) return '';
  if (a.tool) return `Agent running ${a.tool}.`;
  if (a.quiet) return `Agent quiet since ${clock(a.lastAt)}.`;
  return 'Agent attached.';
}

/* ------------------------------------------------------------------------ */
/* accessibility                                                             */
/* ------------------------------------------------------------------------ */

let saidLink = null;

function announce(msg) { if (liveRegion) liveRegion.textContent = msg; }

/** Link transitions are the one thing worth speaking aloud unprompted. */
function narrate(s, changed) {
  if (!changed.has('device') || s.device.link === saidLink) return;
  saidLink = s.device.link;
  const said = {
    linked: `Device linked. Firmware ${s.device.firmware.version || 'unknown'}.`,
    rebooting: 'Device rebooting. Telemetry suspended.',
    lost: 'Link lost. No heartbeat.',
    offline: 'No source attached.',
  }[s.device.link];
  if (said) announce(said);
}

/* ------------------------------------------------------------------------ */
/* bring-up                                                                  */
/* ------------------------------------------------------------------------ */

const params = new URLSearchParams(location.search);
const scene = params.get('sim');
const simulated = scene !== null;
const buildClient = createBuildClient({
  base: params.get('buildd') || 'http://127.0.0.1:8001',
});
buildClient.list().then(result => {
  if (!result.ok || !Array.isArray(result.builds)) return;
  const restored = result.builds.map(record => ({
    buildId: record.id,
    version: record.image?.version || null,
    sha: record.image?.elf_sha8 || null,
    bytes: record.image?.total_bytes ?? null,
    builtAt: Date.parse(record.endedAt || record.startedAt || '') || 0,
    slot: null,
    outcome: record.status === 'built' ? 'built' : 'failed',
    note: record.status === 'built'
      ? [`app ${record.app?.name || 'unknown'} ${record.app?.version || ''}`.trim(),
         record.image?.activation_protocol === 2 ? '' : 'legacy artifact · rebuild before OTA flash']
          .filter(Boolean).join(' · ')
      : record.diagnostics?.[0]?.message || 'build failed',
  }));
  const known = new Set(restored.map(row => row.buildId));
  applyFirmware([...state.firmware.filter(row => !known.has(row.buildId)), ...restored]);
});

let session = null;
let feed = null;
/** Bumped per session, so a callback that outlives its session paints nothing. */
let generation = 0;

function startOnboarding() {
  session?.dispose();
  feed?.stop();
  feed = null;
  link = null;

  document.body.dataset.view = 'onboard';
  showOnboard();
  resetWire();

  const driver = simulated ? simulatedDriver(scene) : webSerialDriver;
  const gen = ++generation;
  const current = new Session(driver, (s, monitor) => {
    if (gen !== generation) return;
    renderOnboard(s, monitor);
    trackFlashProgress(s);
    if (s.phase === 'done') goLive(current);
  });
  session = current;
  renderOnboard(current.state, current.monitor);
}

async function connect() {
  applyUi({ source: simulated ? 'sim' : 'usb' });
  await session?.connect();
}

function retry() {
  const code = session?.state.fault?.code;
  session.state.fault = null;

  /* Retry what actually failed. A write that could not fetch its image should
     not send somebody back through the port picker. */
  if (code === 'no_manifest' || code === 'fetch_failed'
      || code === 'no_chip' || code === 'flash_failed') {
    return session?.flash({ eraseAll: eraseChecked() });
  }
  if (code === 'no_reopen') return session?.waitForBoot();

  /* A port already granted stays granted. Making somebody pick the same board
     out of a dialog again is friction with nothing behind it. */
  session?.connect({ reuse: code !== 'no_port' });
}

/**
 * Hand the open link over to the instrument.
 *
 * Keyed on the link rather than on a once-only flag. A board written to by
 * flash_image resets, comes back, and finishes bring-up a second time with a
 * new link — and a flag that only ever let the first handover through would
 * leave the instrument fed by a port that no longer exists.
 */
function goLive(s) {
  /* Only an open link is handed over. The session emits on every log line,
     and while it is reattaching after a replug its link is null for a moment
     — a handover then would point the instrument at nothing and ask nothing
     for its capabilities, which is a TypeError thrown back up into the
     reattach itself, killing it on its first line. */
  if (!s.link?.open) return;
  if (link === s.link) return;

  hideOnboard();
  document.body.dataset.view = 'console';
  link = s.link;

  /* The feed is made once per session and kept across every link that
     follows — a replug, a reflash. It belongs to the page, not to the port:
     tearing it down for a new link revokes the frame on screen, forgets which
     way the link last went, and re-arms every watchdog from zero, all of which
     showed as the instrument flickering on every reconnect. The session keeps
     the port; every frame is copied on to the instrument through the sink,
     and the sink survives the port it was set up with. */
  if (!feed) {
    feed = createFeed({
      source: simulated ? 'sim' : 'usb',
      onLost: () => applyUi({ label: 'no telemetry' }),
      /* Frames stopped. The board is the only thing that can say why, so it
         gets asked rather than guessed at. */
      ask: () => link?.send({ t: 'caps' }).catch(() => {}),
    });
    s.frameSink = feed.handleFrame;
    applyUi({ label: simulated ? (scene ? `simulated · ${scene}` : 'simulated') : '' });
  }

  /* Ask what is attached — after the sink exists, or the answer lands with
     nothing listening. The board announces its capabilities once, when its
     camera probe finishes about a second after boot, which is long before a
     page attaches to a board that was already running. Without this ask, a
     board that booted with a camera on it reports "waiting for the board to
     report what is attached" for as long as the page is open. Asked again on
     every new link for the same reason: the board on the other end of it has
     just rebooted. */
  link.send({ t: 'caps' }).catch(() => {});

  /* The identity that answered during bring-up is handed over straight away
     rather than waited for. The board repeats its hello only every few
     seconds once it is up, and an agent whose first call lands inside that
     gap would otherwise be told the board has no name and no firmware — by a
     page that has known both since the flash decision. */
  if (s.state.hello) feed.handleFrame(s.state.hello);

  /* Once per link: what is on the header. Asked after the identity has been
     handed over, so what a previous visit knew about this board is in place
     before the answer lands and only genuinely new addresses raise a
     question. Firmware without the command never answers; the ask times
     out quietly. */
}

/* ------------------------------------------------------------------------ */
/* the agent                                                                 */
/* ------------------------------------------------------------------------ */

/**
 * Copy the flasher's own progress onto the row being written.
 *
 * The session already measures this — it is the same count the flash rung
 * shows — so the image row reads it rather than estimating anything. Bytes
 * are only reported while bytes are moving; the parts either side of the
 * write have no denominator, and say what they are doing instead of
 * animating a number nobody measured.
 */
function trackFlashProgress(s) {
  const f = state.ui.flashing;
  if (!f) return;

  const written = Number.isFinite(s.progress?.written) ? s.progress.written : null;
  const total = Number.isFinite(s.progress?.total) && s.progress.total > 0 ? s.progress.total : null;

  let stage = f.stage || null;
  if (written !== null && total !== null) stage = null;
  else if (s.rungs?.boot?.state === 'active') stage = 'booting';
  else if (s.rungs?.identify?.state === 'active') stage = 'checking';
  else if (s.phase === 'working' || s.rungs?.flash?.state === 'active') stage = 'preparing';

  if (f.written === written && f.total === total && f.stage === stage) return;
  applyUi({ flashing: { ...f, written, total, stage } });
}

/* ------------------------------------------------------------------------ */
/* reading a build, and getting rid of one                                   */
/* ------------------------------------------------------------------------ */

/**
 * Open one build's stored source.
 *
 * The artefact's own copy, fetched from the daemon rather than read off the
 * draft: the draft moves on with every build, and the question a reviewer is
 * answering is what THIS image was compiled from. Drawn where it was asked
 * for — under the image row, or inside the approval gate.
 */
async function openReview(buildId, from) {
  if (!buildId) return;
  applyUi({ review: { buildId, from, files: null, loading: true, error: null, app: null, note: null }, menuFor: null, confirmDelete: null });

  const [stored, record] = await Promise.all([
    buildClient.source(buildId),
    buildClient.get(buildId).catch(() => null),
  ]);

  /* Another review may have been opened, or this one closed, while the fetch
     was in flight. The answer to a question nobody is asking any more is
     dropped rather than painted over whatever replaced it. */
  const now = state.ui.review;
  if (!now || now.buildId !== buildId || now.from !== from) return;

  applyUi({
    review: stored?.ok
      ? { buildId, from, files: stored.files || {}, loading: false, error: null,
          app: record?.ok ? record.app || null : null,
          note: record?.ok ? record.note || null : null }
      : { buildId, from, files: null, loading: false, app: null, note: null,
          error: stored?.error
            ? `the build daemon could not read that source: ${stored.error}`
            : `no stored source for build ${buildId}` },
  });
}

function closeReview() { applyUi({ review: null }); }

/**
 * Delete one build for good.
 *
 * A person only, from the menu, after a second press. The images and the
 * source go together with the record, because a listing that offers a build
 * whose images are gone is worse than not listing it. Refused while that
 * build is the one being written.
 */
async function deleteBuild(buildId) {
  applyUi({ menuFor: null, confirmDelete: null });
  if (state.ui.flashing?.buildId === buildId) {
    announce('That build is being written to the board. Nothing was deleted.');
    return;
  }
  const result = await buildClient.remove(buildId);
  if (!result?.ok) {
    announce(`Could not delete that build: ${result?.error || 'the build daemon did not answer'}.`);
    return;
  }
  if (state.ui.review?.buildId === buildId) closeReview();
  applyFirmware(state.firmware.filter(row => row.buildId !== buildId));
  announce(result.warning ? `Build removed from the list. ${result.warning}` : 'Build deleted.');
}

function abandonBuild() {
  applyWorkOrder(null);
  resetAttempts();
  announce('Work order cleared.');
}

/* ------------------------------------------------------------------------ */
/* the toolbelt                                                              */
/* ------------------------------------------------------------------------ */

/**
 * Register the page's tools with the browser's agent, if it has one.
 *
 * The effectors are the page's own: the same link, the same session, the
 * same loop. A tool does nothing the page could not already do from a
 * button, and the two writes that matter go through the same gate the
 * buttons answer. Absent document.modelContext, this registers nothing and
 * the note beside the badge says so, once.
 */
const toolFx = {
    setCamera: on => setCamera(on),
    setConfig,
    flash: async opts => {
      await session?.flash({
        eraseAll: false,
        imageBase: opts?.imageBase || buildClient.baselineBase,
      });
      const s = session?.state;
      return {
        phase: s?.phase || null,
        fault: s?.fault || null,
        flashDone: s?.rungs?.flash?.state === 'done',
      };
    },
    manifest: () => session?.driver?.fetchManifest?.() || fetchManifest(),
    build: buildClient,
    wireTail: lines => (session?.monitor || []).slice(-lines).map(row => ({
      t: row.t, kind: row.kind, text: row.n > 1 ? `${row.text} ×${row.n}` : row.text,
    })),
    source: () => (simulated ? 'sim' : 'usb'),
    /* Where bring-up stands, for a caller that cannot see the ladder. */
    bringUp: () => (session ? describeBringUp(session.state) : null),
};
mountTools({ fx: toolFx });

/* ------------------------------------------------------------------------ */
/* go                                                                        */
/* ------------------------------------------------------------------------ */

/* The picture is wanted on screen unless a previous visit hid it; the stream
   is wanted whenever there is a camera, so it starts on its own and keeps
   measuring while the panel is hidden. */
applyUi({ cameraShown: readPref('cameraShown', true) !== false });
applyPeripherals({ streamWanted: true });

renderAll();
startOnboarding();
