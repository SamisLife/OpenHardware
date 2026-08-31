/* ============================================================================
   feed.js — OHW1 frames in, model writes out.
   ----------------------------------------------------------------------------
   The single consumer of the protocol. Every transport that carries frames — a
   simulated board today, a serial port and a network stream later — hands them
   here, and this is the only place that knows what a frame means.

   Nothing downstream of state.js can tell which transport produced a sample.
   That is what makes a rehearsal worth anything: the path being rehearsed is
   the path that will carry a real board.

   ----------------------------------------------------------------------------
   TWO RULES WORTH STATING

   Silence is the only way a board reports that it has stopped. It cannot send
   a message saying it crashed, so a watchdog turns absence into an explicit
   gap on the record rather than leaving the last sample sitting there looking
   current.

   A half-received image is never painted. Chunks are indexed rather than
   assumed to be in order, and the assembled length is checked against the
   header before anything reaches the screen. An image assembled from partial
   data would show tearing indistinguishable from the sensor faults this
   instrument exists to detect — so tearing has to come from the sensor, never
   from the transport.
   ========================================================================== */

import {
  state,
  applyDevice, applyFrame, applyLimits, applyPeripherals, applyUi,
  pushTelemetry, pushGap,
} from '../state.js';

/** Missed beats before a board counts as gone. Six at 4 Hz. */
const SILENCE_MS = 1500;

/**
 * @param {object} opts
 *   onLost()   called once when the board stops reporting
 *   label      what to show on the source badge
 * @returns {{ handleFrame, handleText, stop, fresh }}
 */
export function createFeed({ onLost = null, source = null } = {}) {
  let watchdog = 0;
  let lastLink = null;
  let lastBeatAt = 0;
  /** The image currently being reassembled, or null. */
  let inbound = null;
  /** The object URL on screen, so it can be revoked when replaced. */
  let shown = null;

  if (source) applyUi({ source });

  function handleFrame(frame) {
    if (!frame || !frame.t) return;

    switch (frame.t) {
      case 'hello': return onHello(frame);
      case 'beat': return onBeat(frame);
      case 'caps': return onCaps(frame);
      case 'cam_ack': return applyPeripherals({ streaming: !!frame.on });
      /* What the board confirmed it is running, or why it refused. Read out of
         the ack rather than assumed from the request, so a config that never
         took cannot show as applied. */
      case 'cfg_ack': return frame.ok
        ? applyPeripherals({ config: readConfig(frame), cfgError: null })
        : applyPeripherals({ cfgError: String(frame.err || 'refused') });
      case 'img': return beginImage(frame);
      case 'imgd': return addChunk(frame);
      case 'status': return onStatus(frame);
      default: return;
    }
  }

  /**
   * Log lines and anything else on the wire.
   *
   * Kept rather than discarded: during bring-up the board's own logging is
   * often the only thing that explains what happened. Nothing is done with it
   * at this layer beyond handing it on.
   */
  function handleText() { /* consumed by the monitor, once one exists */ }

  /* ---- identity -------------------------------------------------------- */

  function onHello(h) {
    const patch = {
      id: h.device_id || idFromMac(h.mac),
      board: h.board_name || h.board || null,
      mcu: h.chip || null,
      mac: h.mac || null,
      link: 'linked',
      firmware: { version: h.fw || null, sha: h.sha || null, slot: h.slot || null },
    };
    /* Only what the frame carried. A hello that says nothing about the network
       must not blank an address another transport reported. */
    if ('ssid' in h) patch.ssid = h.ssid || null;
    if ('ip' in h) patch.ip = h.ip || null;
    applyDevice(patch);

    /* Board constants arrive here and nowhere else — the panels refuse to draw
       a proportion until one of these has been reported. */
    const limits = {};
    if (Number.isFinite(h.psram)) limits.psramTotal = h.psram;
    if (Number.isFinite(h.heap_total)) limits.heapTotal = h.heap_total;
    if (Number.isFinite(h.temp_crit_c)) limits.tempCritC = h.temp_crit_c;
    if (Object.keys(limits).length) applyLimits(limits);

    kick();
  }

  /**
   * Without a server there is nobody to hand out identifiers, so one is derived
   * from the hardware address. Stable across reboots and reflashes, which is
   * the only property an identifier actually needs here.
   */
  function idFromMac(mac) {
    if (!mac) return 'device';
    return `board-${mac.replace(/[^0-9a-f]/gi, '').slice(-4).toLowerCase()}`;
  }

  /* ---- telemetry ------------------------------------------------------- */

  function onBeat(b) {
    const now = Date.now();
    lastBeatAt = now;

    if (lastLink !== 'linked') {
      lastLink = 'linked';
      applyDevice({ link: 'linked' });
      applyUi({ label: '' });
    }

    pushTelemetry({
      t: now,
      uptimeS: num(b.uptime_s),
      tempC: num(b.temp_c),
      heapFree: num(b.heap_free),
      psramFree: num(b.psram_free),
      psramLargestBlock: num(b.psram_largest),
      rssi: num(b.rssi),
      cpuMhz: num(b.cpu_mhz),
      fps: num(b.fps),
    });

    kick();
  }

  /**
   * A board that has gone quiet.
   *
   * The gap is what turns absence into something visible. Without it the last
   * sample sits on every readout looking current, which is the one failure this
   * instrument is built to prevent.
   */
  function kick() {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      if (lastLink !== 'linked') return;
      lastLink = 'lost';
      pushGap(Date.now(), 'NO TELEMETRY');
      applyDevice({ link: 'lost' });
      applyUi({ label: 'no telemetry' });
      onLost?.();
    }, SILENCE_MS);
  }

  /* ---- what is attached ------------------------------------------------ */

  function onCaps(frame) {
    const cam = frame.camera || null;
    const wasOk = state.peripherals.camera?.state === 'ok';
    const isOk = cam?.state === 'ok';

    const patch = {
      known: true,
      camera: cam,
      i2c: Array.isArray(frame.i2c) ? frame.i2c : [],
      streaming: !!frame.streaming,
      /* Advertised, never assumed. A board that says nothing about cfg does
         not support it, and a tool asking for a config it cannot apply is told
         so rather than handed numbers from a size the board never ran. */
      cfg: frame.cfg === true,
      config: readConfig(frame.config),
    };
    /* A sensor that has just arrived is a new question for the operator, and
       the answer on file was about a different module. */
    if (isOk && !wasOk) patch.cameraAsked = false;
    applyPeripherals(patch);

    if (wasOk && !isOk) dropImage('The camera stopped answering and was removed.');
  }

  function onStatus(frame) {
    if (frame.stage === 'camera_absent' || frame.stage === 'camera_faulted') {
      dropImage(frame.detail || 'The camera is not available.');
    }
  }

  /* ---- images ---------------------------------------------------------- */

  function beginImage(h) {
    const chunks = Number(h.chunks);
    const bytes = Number(h.bytes);
    if (!Number.isInteger(chunks) || chunks <= 0 || !Number.isFinite(bytes)) return;

    /* A new header abandons whatever was in flight. One image is sent at a
       time, so an unfinished one means chunks were lost. */
    inbound = {
      seq: h.seq,
      width: Number(h.w) || 0,
      height: Number(h.h) || 0,
      quality: Number(h.q) || 0,
      bytes, chunks,
      parts: new Array(chunks),
      got: 0,
    };
  }

  function addChunk(c) {
    if (!inbound || c.seq !== inbound.seq) return;

    const i = Number(c.i);
    if (!Number.isInteger(i) || i < 0 || i >= inbound.chunks) return;
    if (inbound.parts[i] !== undefined) return;          // duplicate

    inbound.parts[i] = c.d || '';
    inbound.got++;
    if (inbound.got === inbound.chunks) finishImage();
  }

  function finishImage() {
    const img = inbound;
    inbound = null;

    let bin;
    try { bin = atob(img.parts.join('')); }
    catch { return; }                                     // corrupt base64

    /* Short or long is not a frame worth trusting. */
    if (bin.length !== img.bytes) return;

    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);

    const url = URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }));
    /* Revoked only now, so the panel never has a moment with no valid URL to
       draw. Without this an hour of streaming leaks every frame. */
    if (shown) URL.revokeObjectURL(shown);
    shown = url;

    applyFrame({
      kind: 'jpeg',
      seq: Number(img.seq) || 0,
      ts: Date.now(),
      width: img.width,
      height: img.height,
      jpegQuality: img.quality,
      bytes: img.bytes,
      url,
      verdict: null,
    });
  }

  /** Drop the picture and say why. A stale frame is not a frame. */
  function dropImage(verdict) {
    inbound = null;
    if (shown) { URL.revokeObjectURL(shown); shown = null; }
    applyFrame({
      kind: null, seq: 0, ts: 0, width: 0, height: 0,
      jpegQuality: 0, bytes: 0, url: null, verdict,
    });
  }

  /* ---------------------------------------------------------------------- */

  return {
    handleFrame,
    handleText,
    /** Whether this transport has produced telemetry recently. */
    fresh(withinMs = SILENCE_MS) {
      return lastBeatAt > 0 && Date.now() - lastBeatAt < withinMs;
    },
    stop() {
      clearTimeout(watchdog);
      watchdog = 0;
      inbound = null;
      lastBeatAt = 0;
      if (shown) { URL.revokeObjectURL(shown); shown = null; }
    },
  };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** { size, quality } from a frame, or null when it carried no usable config. */
function readConfig(c) {
  if (!c || typeof c !== 'object' || typeof c.size !== 'string') return null;
  const quality = Number(c.quality);
  return { size: c.size, quality: Number.isFinite(quality) ? quality : null };
}
