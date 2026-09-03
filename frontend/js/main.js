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
import { mountTools, configEffector } from './webmcp.js';
import { fetchManifest } from './link/flash.js';
import { createBuildClient } from './link/build.js';
import { clock } from './format.js';
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

mountFirmware($('#firmware'));
/* The two buttons answer whatever gate is pending — the loop's, before it
   commits a limit, or a tool's, before it writes to the board. Approve and
   Hold are never tools, which is the whole reason there is a gate. */
mountAgent($('#agent'), {
  onApprove: () => approvePending(),
  onHold: () => { holdPending(); announce('Gate held. Nothing was written.'); },
  onAbandon: () => abandonBuild(),
});
/* Nowhere to type. What an agent will find when it looks is drawn in the
   slot a form would otherwise occupy. */
mountBelt($('#belt'));

mountPeripherals($('#vitals'), {
  onCamera: on => setCamera(on),
  onCameraDecline: () => applyPeripherals({ cameraAsked: true }),
});

/**
 * Ask the board to start or stop capturing.
 *
 * Recording that the question was answered matters even when there is no
 * transport to carry it: it is what stops the offer reappearing every time the
 * board re-reports what is attached.
 */
async function setCamera(on) {
  /* The intent is recorded separately from the state. A ribbon that comes out
     and goes back in leaves streaming off through no decision of anybody's,
     and this is what lets the picture return by itself rather than putting the
     same question up every time the hardware moves. */
  applyPeripherals({ cameraAsked: true, streamWanted: on });
  try { await link?.send({ t: 'cam', on }); }
  catch (err) { applyUi({ label: `could not reach the board: ${err.message}` }); }
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
  onProvision: (ssid, psk) => session?.provision(ssid, psk),
  onSkipNetwork: () => session?.skipNetwork(),
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
  if (changed.has('workOrder')) { renderWorkOrder(s); renderBelt(s); }
  /* Attempts drive the learned-limits list too: what the board has been shown
     to do is read off the attempts rather than stored separately, so there is
     no second copy to fall out of step. */
  if (changed.has('attempts')) { renderAttempts(s); renderMemory(s); }
  if (changed.has('memory')) renderMemory(s);
  if (changed.has('gate')) {
    renderGate(s);
    renderSource(s);
    if (s.gate?.state === 'pending') announce('Agent waiting for approval.');
  }
  if (changed.has('firmware')) renderFirmware(s);
  if (changed.has('ui')) { renderSource(s); renderBelt(s); }
  narrate(s, changed);
});

/** The camera panel exists only while there is a camera behind it. */
function syncCameraPanel(s) {
  document.body.dataset.camera = s.peripherals.camera?.state === 'ok' ? 'on' : 'off';
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
}

/* ------------------------------------------------------------------------ */
/* the agent                                                                 */
/* ------------------------------------------------------------------------ */

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
mountTools({
  fx: {
    setCamera: on => setCamera(on),
    setConfig,
    flash: async opts => {
      await session?.flash({
        eraseAll: false,
        imageBase: opts?.imageBase || buildClient.baselineBase,
      });
      if (session?.state.phase === 'decide') await session.skipNetwork();
      const s = session?.state;
      return {
        phase: s?.phase || null,
        fault: s?.fault || null,
        flashDone: s?.rungs?.flash?.state === 'done',
      };
    },
    provision: (ssid, psk) => session?.provision(ssid, psk),
    manifest: () => session?.driver?.fetchManifest?.() || fetchManifest(),
    build: buildClient,
    wireTail: lines => (session?.monitor || []).slice(-lines).map(row => ({
      t: row.t, kind: row.kind, text: row.n > 1 ? `${row.text} ×${row.n}` : row.text,
    })),
    source: () => (simulated ? 'sim' : 'usb'),
    /* Where bring-up stands, for a caller that cannot see the ladder. */
    bringUp: () => (session ? describeBringUp(session.state) : null),
  },
});

/* ------------------------------------------------------------------------ */
/* go                                                                        */
/* ------------------------------------------------------------------------ */

renderAll();
startOnboarding();
