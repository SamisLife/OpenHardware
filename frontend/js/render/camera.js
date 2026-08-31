/* ============================================================================
   camera.js — what the board is actually seeing.
   ----------------------------------------------------------------------------
   The only panel allowed to be large, and the one thing on the page a viewer
   can judge for themselves in half a second. Everything else here is a number
   that has to be trusted.

   When the link is down there is no frame, and the panel says so rather than
   holding the last good image. Holding it would be the most flattering thing
   to do and the least true.

   Nothing on this panel names a part. The sensor is whatever the board
   reported it to be — esp_camera reads an ID off the silicon, so the name is a
   fact about the hardware attached right now. A model number written into the
   markup would be right on one desk and wrong on every other, including the
   same desk after somebody swaps the module.
   ========================================================================== */

import { clock, NIL } from '../format.js';

/** What each frame kind means, in the words used about it elsewhere. */
const VERDICT = {
  jpeg: { chip: 'CAPTURE', tone: 'ok',
          text: 'Live frame from the board. No vision verdict yet.' },
};

let el = {}, ctx = null, drawn = -1, lastKind = null;

export function mountCamera(root) {
  el = {
    canvas: root.querySelector('[data-cam=canvas]'),
    sensor: root.querySelector('[data-cam=sensor]'),
    res: root.querySelector('[data-cam=res]'),
    q: root.querySelector('[data-cam=quality]'),
    seq: root.querySelector('[data-cam=seq]'),
    bytes: root.querySelector('[data-cam=bytes]'),
    stamp: root.querySelector('[data-cam=stamp]'),
    chip: root.querySelector('[data-cam=chip]'),
    verdict: root.querySelector('[data-cam=verdict]'),
    well: root.querySelector('[data-cam=well]'),
  };
  ctx = el.canvas.getContext('2d');
}

export function renderCamera(state) {
  const f = state.frame;
  const down = state.device.link !== 'linked';
  const cam = state.peripherals.camera;

  el.well.dataset.link = state.device.link;

  /* Named by the board, never by this page. */
  set(el.sensor, cam && cam.state === 'ok' && cam.sensor ? cam.sensor : null);

  /* ---- the image -------------------------------------------------------- */
  if (down || !f.kind || !f.url) {
    if (lastKind !== 'none') {
      blank();
      lastKind = 'none';
      drawn = -1;
    }
  } else if (f.seq !== drawn || f.kind !== lastKind) {
    drawFromUrl(f);
    drawn = f.seq;
    lastKind = f.kind;
  }

  /* ---- capture metadata, laid out like a frame header ------------------- */
  const meta = !down && !!f.kind;
  set(el.res, meta && f.width ? `${f.width}×${f.height}` : null);
  set(el.q, meta && f.jpegQuality ? `q${f.jpegQuality}` : null);
  set(el.seq, meta ? `#${String(f.seq).padStart(5, '0')}` : null);
  set(el.bytes, meta && f.bytes ? `${(f.bytes / 1024).toFixed(1)} KB` : null);
  set(el.stamp, meta ? clock(f.ts) : null);

  /* ---- the verdict ------------------------------------------------------ */
  if (down) {
    el.chip.textContent = state.device.link === 'rebooting' ? 'REBOOTING' : 'NO LINK';
    el.chip.dataset.tone = 'muted';
    el.verdict.textContent = state.device.link === 'rebooting'
      ? 'The board is restarting. Nothing is being captured until it reports healthy.'
      : 'No heartbeat. Nothing is being captured.';
    return;
  }

  const v = VERDICT[f.kind];
  if (!v) {
    el.chip.textContent = 'WAITING';
    el.chip.dataset.tone = 'muted';
    /* A verdict without a frame is a real thing to say: a camera that was
       removed has no picture AND a reason there is none. */
    el.verdict.textContent = f.verdict || (cam && cam.state === 'ok'
      ? 'Camera detected. No capture yet this boot.'
      : 'No capture yet this boot.');
    return;
  }

  el.chip.textContent = v.chip;
  el.chip.dataset.tone = v.tone;
  el.verdict.textContent = f.verdict || v.text;
}

/** Deliberately not a frame: it is an absence. */
function blank() {
  sizeCanvas(640, 480);
  ctx.fillStyle = '#0f0e0d';
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
}

/**
 * Decode a frame that arrived as a blob or over HTTP.
 *
 * A failed load keeps whatever is already on the canvas: dropping a frame is
 * normal on a lossy link and is not worth blanking the panel over.
 */
function drawFromUrl(f) {
  const img = new Image();
  img.decoding = 'async';
  img.onload = () => {
    sizeCanvas(img.naturalWidth || f.width || 640, img.naturalHeight || f.height || 480);
    ctx.drawImage(img, 0, 0, ctx.canvas.width, ctx.canvas.height);
  };
  img.onerror = () => { /* keep the last good frame; the next one will land */ };
  img.src = f.url;
}

/**
 * The backing store is the sensor resolution, capped so a large frame does not
 * cost several times the fill rate of a small one. CSS handles display size;
 * the aspect ratio is carried by the element so the well never jumps.
 */
function sizeCanvas(w, h) {
  const cap = 800;
  const k = Math.min(1, cap / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * k));
  const ch = Math.max(1, Math.round(h * k));
  if (ctx.canvas.width !== cw || ctx.canvas.height !== ch) {
    ctx.canvas.width = cw;
    ctx.canvas.height = ch;
  }
  el.well.style.setProperty('--cam-aspect', `${w} / ${h}`);
}

function set(node, value) {
  if (!node) return;
  const next = value == null || value === '' ? NIL : String(value);
  if (node.textContent !== next) node.textContent = next;
}
