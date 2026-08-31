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

import { state, subscribe, renderAll, applyPeripherals, applyUi } from './state.js';
import { mountStrip } from './strip.js';
import { mountRail, renderRail } from './render/rail.js';
import { mountVitals, renderVitals } from './render/vitals.js';
import { mountCamera, renderCamera } from './render/camera.js';
import { mountPeripherals, renderPeripherals } from './render/peripherals.js';
import {
  mountOnboard, renderOnboard, showOnboard, hideOnboard, resetWire, eraseChecked,
} from './render/onboard.js';
import { Session } from './onboard/session.js';
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
  applyPeripherals({ cameraAsked: true });
  try { await link?.send({ t: 'cam', on }); }
  catch (err) { applyUi({ label: `could not reach the board: ${err.message}` }); }
}

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
  if (changed.has('peripherals')) { renderPeripherals(s); syncCameraPanel(s); }
  if (changed.has('ui')) renderSource(s);
  narrate(s, changed);
});

/** The camera panel exists only while there is a camera behind it. */
function syncCameraPanel(s) {
  document.body.dataset.camera = s.peripherals.camera?.state === 'ok' ? 'on' : 'off';
}

function renderSource(s) {
  const src = s.ui.source;
  badge.textContent = src ? String(src).toUpperCase() : 'NO SOURCE';
  /* Cyan only for a source with real hardware behind it. Anything synthetic
     stays amber, so a demonstration can never be mistaken for a measurement. */
  badge.dataset.live = String(src === 'usb' || src === 'server');
  note.textContent = s.ui.label || '';
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

/** Hand the open link over to the instrument. */
let handedOver = false;
function goLive(s) {
  if (handedOver) return;
  handedOver = true;

  hideOnboard();
  document.body.dataset.view = 'console';
  link = s.link;

  feed = createFeed({
    source: simulated ? 'sim' : 'usb',
    onLost: () => applyUi({ label: 'no telemetry' }),
  });
  /* The bring-up session keeps the port; every frame is copied on to the
     instrument. Closing the link here would stop the telemetry it just
     established. */
  s.frameSink = feed.handleFrame;

  applyUi({ label: simulated ? (scene ? `simulated · ${scene}` : 'simulated') : '' });
}

/* ------------------------------------------------------------------------ */
/* go                                                                        */
/* ------------------------------------------------------------------------ */

renderAll();
startOnboarding();
