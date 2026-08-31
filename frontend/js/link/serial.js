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

import { FrameReader, encodeFrame } from './protocol.js';

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
    /** Bytes that actually arrived. The denominator for "nothing came back". */
    this.bytes = 0;
    /** Held for the life of the port. See _getWriter. */
    this._writer = null;
    /** Why the read loop never attached, or null. See _read(). */
    this.readerFailed = null;
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
      /* Already-open is not fatal — something else in this page may have left
         it open — but it is recorded rather than forgotten. A port this page
         did not open is one whose control lines are in a state this page did
         not set, and if the read loop then attaches to nothing, that is the
         first thing worth knowing. */
      if (!/already open/i.test(err.message)) throw err;
      this.wasAlreadyOpen = true;
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

  /**
   * ----------------------------------------------------------------------------
   * NEVER STARTING AND HEARING NOTHING ARE DIFFERENT FACTS
   *
   * These two used to share one catch, and the cost was a specific lie. If
   * `port.readable` is null, or another reader still holds the stream — which
   * is exactly the state a flashing library can leave behind — `getReader()`
   * throws before a single byte is ever asked for. Swallowed, that leaves the
   * page believing it has a live link, reporting a silent board, and naming
   * causes that are all about the hardware. The board may be streaming
   * perfectly into a reader that was never attached.
   *
   * So the failure to start is recorded, and `bytes` counts what actually
   * arrived. "The port was open for four seconds and nothing came" is a
   * measurement. "The reader never attached" is a defect in this page. A
   * diagnosis that cannot tell them apart is worse than none.
   */
  async _read() {
    const decoder = new TextDecoder();
    let closedCleanly = false;

    try {
      if (!this.port.readable) {
        throw new Error('the port reports no readable stream');
      }
      this.reader = this.port.readable.getReader();
    } catch (err) {
      /* Loud, and on the object, because nothing downstream can observe this
         and everything downstream will otherwise blame the board. */
      this.readerFailed = err.message;
      this.open = false;
      this.handlers.onReadError?.(err.message);
      return;
    }

    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) { closedCleanly = true; break; }
        if (value) {
          this.bytes += value.length;
          this._frames.push(decoder.decode(value, { stream: true }));
        }
      }
    } catch {
      /* A disconnect DURING a read throws. That is the ordinary way a board
         leaves when it resets, and unlike the case above it is not a fault. */
    } finally {
      try { this.reader?.releaseLock(); } catch { /* already released */ }
      this.reader = null;
      this.open = false;
      /* A device that left the bus takes the writable stream with it, and a
         writer still bound to it would reject every later send with an error
         about a stream rather than about a board. */
      if (!this._stopping) this._writer = null;
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
      const writer = this._getWriter();
      if (!writer) return false;

      /* Ready BEFORE, so the queue has room, and ready AGAIN after the write,
         so the bytes have actually left. write() alone resolves when the chunk
         is accepted into the queue — not when it reaches the device — and a
         caller that treats that as delivery reports a send the board never
         saw. See the note on _getWriter. */
      await writer.ready;
      await writer.write(encoder.encode(encodeFrame(obj)));
      await writer.ready;
      return true;
    });
    /* The chain must not break on a failed write, or every later send is
       rejected by a promise nobody is holding any more. */
    this._writing = attempt.then(() => {}, () => {});
    return attempt;
  }

  /**
   * One writer, held for the life of the port.
   *
   * ----------------------------------------------------------------------------
   * RELEASING THE LOCK AFTER EVERY WRITE LOSES THE WRITE
   *
   * The obvious shape — getWriter(), write(), releaseLock() in a finally — is
   * what both this project and its predecessor did, and it silently drops
   * data. `write()` resolves once the chunk is accepted into the stream's
   * queue; the bytes have not necessarily reached the device. Releasing the
   * lock at that moment tears down the writer with the queue still draining,
   * and what was queued goes nowhere.
   *
   * The symptom is brutal to diagnose because nothing fails: the promise
   * resolves, the caller logs a successful send, and the board reports it has
   * received nothing at all. That is exactly what `rx: 0` was — the page had
   * sent three frames and the board had seen none of them, with no error
   * anywhere. The predecessor project recorded its provisioning as having
   * "failed for a different environmental reason" every single time.
   *
   * So the writer is acquired once and kept. stop() drains it and lets it go,
   * which it must: port.close() rejects while writable is still locked.
   */
  _getWriter() {
    if (this._writer) return this._writer;
    if (!this.port.writable) return null;
    this._writer = this.port.writable.getWriter();
    return this._writer;
  }

  /** Drain and release the writer, so the port can close. */
  async _dropWriter() {
    if (!this._writer) return;
    try { await this._writer.ready; } catch { /* already errored */ }
    try { this._writer.releaseLock(); } catch { /* already released */ }
    this._writer = null;
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

    /* The writer goes first: port.close() rejects while writable is locked,
       and a half-sent frame is better finished than abandoned. */
    await this._dropWriter();

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
