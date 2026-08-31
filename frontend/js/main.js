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

   ?sim attaches a simulated board. It speaks the real protocol over a real
   reader, so it exercises the same path a serial port will, and it is
   dynamically imported so it is never fetched otherwise. Scenes are documented
   in js/link/sim.js.
   ========================================================================== */

import { state, subscribe, renderAll, applyPeripherals, applyUi } from './state.js';
import { mountStrip } from './strip.js';
import { mountRail, renderRail } from './render/rail.js';
import { mountVitals, renderVitals } from './render/vitals.js';
import { mountCamera, renderCamera } from './render/camera.js';
import { mountPeripherals, renderPeripherals } from './render/peripherals.js';

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
/* go                                                                        */
/* ------------------------------------------------------------------------ */

renderAll();

const sim = new URLSearchParams(location.search).get('sim');
if (sim !== null) {
  Promise.all([import('./link/sim.js'), import('./link/feed.js')])
    .then(([{ SimBoard }, { createFeed }]) => {
      const feed = createFeed({ source: 'sim' });
      applyUi({ label: sim ? `simulated board · ${sim}` : 'simulated board' });
      link = new SimBoard(sim).attach({
        onFrame: feed.handleFrame,
        onText: feed.handleText,
      });
    })
    .catch(err => {
      applyUi({ label: 'simulated board unavailable' });
      console.error('[openhardware] simulator failed to load', err);
    });
}
