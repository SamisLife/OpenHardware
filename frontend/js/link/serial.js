/* ============================================================================
   serial.js — a real board on a real cable.
   ----------------------------------------------------------------------------
   Web Serial, wrapped so it presents the link contract from protocol.js and
   nothing above it has to know the difference between this and a simulated
   board.

   Two properties are worth stating because both were learned expensively.

   THE PORT IS RELEASED PROVABLY. The obvious way to read a serial port is
   TextDecoderStream plus pipeTo, and it leaks: pipeTo locks port.readable and
   holds the lock until the pipe settles, and cancelling the decoder's reader
   does not abort the pipe. port.close() then rejects, and if that rejection is
   swallowed the port stays open — after which the next thing to want it fails,
   and the failure surfaces somewhere else entirely as "the board is not
   answering". One reader, released in a finally, and stop() waits for the read
   loop to finish before closing.

   OPENING A PORT CAN RESET THE BOARD. On hardware with native USB there is no
   bridge chip, so the host asserting DTR and RTS is wired to the chip's reset
   and boot pins. That makes "open the port to see whether it is there" a
   destructive probe: it resets the board it was asking about, and takes its
   uptime and its boot identity with it. Presence is therefore established by
   matching USB identifiers among ports already granted, never by opening one.
   ========================================================================== */

import { FrameReader } from './protocol.js';

const encoder = new TextEncoder();

/* ------------------------------------------------------------------------ */
/* availability                                                              */
/* ------------------------------------------------------------------------ */

export function serialSupported() {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
}

/**
 * Why serial is unavailable, in terms of what can be done about it.
 *
 * The secure-context case is the one that matters: Web Serial is silently
 * absent rather than throwing, so a page opened over plain http on a LAN
 * address has no navigator.serial and no explanation for it.
 */
export function serialBlockedReason() {
  if (typeof navigator === 'undefined') return 'This is not a browser.';
  if (typeof window !== 'undefined' && !window.isSecureContext) {
    return `This page is not a secure context (${location.origin}). `
         + 'Serial access needs one — open it at http://localhost, or over https.';
  }
  if (!('serial' in navigator)) {
    return 'This browser has no Web Serial API. Chrome or Edge on the desktop '
         + 'can talk to a board directly; Safari and Firefox cannot.';
  }
  return null;
}

/**
 * Ports already granted to this page whose USB identifiers match `port`, that
 * handle first. Nothing is opened.
 *
 * Permission is what makes a silent reconnect possible at all: requestPort()
 * needs a user gesture, getPorts() does not. The limit is worth knowing — a
 * board replugged into a different physical socket may fall outside the
 * existing grant, and then there is genuinely nothing to do but ask again.
 */
export async function portsLike(port) {
  if (!serialSupported()) return [];

  const ports = await navigator.serial.getPorts();
  const info = safeInfo(port);

  const matches = (info && info.usbVendorId !== undefined)
    ? ports.filter(p => {
        const i = safeInfo(p);
        return i && i.usbVendorId === info.usbVendorId
                 && i.usbProductId === info.usbProductId;
      })
    : ports;

  const at = matches.indexOf(port);
  if (at > 0) { matches.splice(at, 1); matches.unshift(port); }
  return matches;
}

function safeInfo(port) {
  try { return port?.getInfo?.() ?? null; } catch { return null; }
}

/* ------------------------------------------------------------------------ */
/* the port                                                                  */
/* ------------------------------------------------------------------------ */

export class BoardPort {
  /**
   * @param {SerialPort} port
   * @param {{onFrame, onText, onClose}} handlers
   */
  constructor(port, handlers = {}) {
    this.port = port;
    this.handlers = handlers;
    this.reader = null;
    this.open = false;
    this._pump = null;
    /** Set by stop(), so a close that was asked for is not reported as news. */
    this._stopping = false;
    this._writing = Promise.resolve();
    this._frames = new FrameReader({
      onFrame: (f, raw) => handlers.onFrame?.(f, raw),
      onText: (t, bad, why) => handlers.onText?.(t, bad, why),
    });
  }

  async start(baudRate = 115200) {
    if (this.open) return;

    try {
      await this.port.open({ baudRate, bufferSize: 4096 });
    } catch (err) {
      /* Already-open is not an error here: something else in this page may
         have left it open, and the read loop below will find out. */
      if (!/already open/i.test(err.message)) throw err;
    }

    /* Chrome does not define what DTR and RTS are on open, and on a board with
       native USB those lines are wired to reset and boot select. Putting them
       in a known state is best effort — some platforms refuse it, which is not
       fatal. */
    try {
      await this.port.setSignals({ dataTerminalReady: true, requestToSend: false });
    } catch { /* not supported here */ }

    this.open = true;
    /* Kept so stop() can wait for the loop to exit and drop its stream lock
       before closing. Without that wait, close() rejects. */
    this._pump = this._read();
  }

  async _read() {
    const decoder = new TextDecoder();
    let closedCleanly = false;

    try {
      this.reader = this.port.readable.getReader();
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) { closedCleanly = true; break; }
        if (value) this._frames.push(decoder.decode(value, { stream: true }));
      }
    } catch {
      /* A disconnect during a read throws. That is the ordinary way a board
         leaves when it resets, so it is not reported as a failure. */
    } finally {
      try { this.reader?.releaseLock(); } catch { /* already released */ }
      this.reader = null;
      this.open = false;
      /* A close that was asked for is not news. A close the device initiated
         is: that is a board that reset or a cable that moved, and it should be
         visible where it happened rather than three steps later when a write
         fails. */
      if (!this._stopping) this.handlers.onClose?.(closedCleanly);
    }
  }

  /**
   * Send one frame.
   *
   * Serialised: getWriter() throws if a writer is already held, and two
   * overlapping sends is an ordinary thing for a page with a retry loop and a
   * button on it to do.
   */
  send(obj) {
    const attempt = this._writing.then(async () => {
      if (!this.port.writable) return false;
      const writer = this.port.writable.getWriter();
      try {
        const { encodeFrame } = await import('./protocol.js');
        await writer.write(encoder.encode(encodeFrame(obj)));
        return true;
      } finally {
        writer.releaseLock();
      }
    });
    /* The chain must not break on a failed write, or every later send is
       rejected by a promise nobody is holding any more. */
    this._writing = attempt.then(() => {}, () => {});
    return attempt;
  }

  /**
   * Release the port.
   *
   * Throws if it will not close, because a port believed closed and not is
   * worse than an error: the next thing to want it fails with a message about
   * the board.
   */
  async stop() {
    this.open = false;
    this._stopping = true;

    try { await this.reader?.cancel(); } catch { /* already gone */ }
    /* Wait for the read loop to finish and drop its lock. close() rejects
       while readable is still locked. */
    try { await this._pump; } catch { /* the loop swallows its own errors */ }
    this._pump = null;
    this._frames.reset();

    try {
      await this.port.close();
    } catch (err) {
      if (/already closed/i.test(err.message)) return;
      throw new Error(`the serial port would not release: ${err.message}`);
    }
  }
}
