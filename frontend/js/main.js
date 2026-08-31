/* ============================================================================
   main.js — mount the instrument, then get out of the way.
   ----------------------------------------------------------------------------
   Every panel is mounted once and repainted from one subscription. Which slices
   changed decides which renderers run, so a burst of telemetry does not repaint
   a camera panel that nothing touched.

   There is no source attached yet. The page therefore opens showing exactly
   what it knows, which is nothing: em-dashes across every readout, blank paper
   advancing on the recorder, and a badge saying NO SOURCE. That empty state is
   a designed state rather than a placeholder — a board that has not reported
   and a board reporting zeros must never look alike, and the only way to be
   sure of that is for the nothing case to be the first one built.

   A development harness can be attached with ?dev — see js/dev/feed.js. It is
   dynamically imported so it is never fetched in ordinary use.
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
mountPeripherals($('#vitals'), {
  /* No transport exists yet to carry the request. Recording the answer still
     matters: it is what stops the offer reappearing every time the board
     re-reports what is attached. */
  onCamera: () => applyPeripherals({ cameraAsked: true }),
  onCameraDecline: () => applyPeripherals({ cameraAsked: true }),
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
/* go                                                                        */
/* ------------------------------------------------------------------------ */

renderAll();

const dev = new URLSearchParams(location.search).get('dev');
if (dev !== null) {
  import('./dev/feed.js')
    .then(m => m.startDevFeed(dev))
    .catch(err => {
      applyUi({ label: 'development feed unavailable' });
      console.error('[openhardware] dev feed failed to load', err);
    });
}
