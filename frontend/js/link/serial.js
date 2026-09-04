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

/** How long the first write on a link waits for the board's first frame. A
    board that has just been reset says hello within a second or two; one that
    is running beats every 250 ms. Longer than both, shorter than a person. */
const FIRST_FRAME_MS = 6000;

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
    /** Why the read loop never attached, or null. See _read(). */
    this.readerFailed = null;
    /** Set by stop(), so a close that was asked for is not reported as news. */
    this._stopping = false;
    this._writing = Promise.resolve();
    /** Valid frames heard on this link. Non-zero is proof the board's own
        driver is up, which is the one condition under which it is safe to
        write to it; see send(). */
    this.frames = 0;
    this._heard = new Promise(resolve => { this._resolveHeard = resolve; });
    this._frames = new FrameReader({
      onFrame: (f, raw) => {
        if (this.frames++ === 0) this._resolveHeard(true);
        handlers.onFrame?.(f, raw);
      },
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

    /* Chrome does not define what DTR and RTS are on open (on Windows both
       come up asserted), and on this native USB part they drive reset and
       boot select: RTS asserted with DTR clear is reset, DTR asserted with
       RTS clear is the boot strap, both together is nothing. Both are wanted
       inactive, so a later esp_restart() boots the image just selected rather
       than the ROM downloader. The ORDER of dropping them is what decides
       whether the board reboots: clearing DTR first passes through reset and
       every open reset the board, taking its uptime and boot identity and
       opening the boot window that swallows the first frames sent (see
       send()). RTS first passes through the harmless strap state instead. */
    try {
      await this.port.setSignals({ requestToSend: false });
      await this.port.setSignals({ dataTerminalReady: false });
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
      /* ----------------------------------------------------------------------
         NOTHING IS WRITTEN TO A BOARD THAT HAS NOT SPOKEN ON THIS LINK

         The board holds one inbound USB packet in a hardware FIFO that its
         driver empties from an interrupt, and the FIFO is not cleared by a
         reset. A packet that lands while the board is still booting — before
         that driver exists — is never delivered: the driver is installed over
         it, no interrupt fires for it, and the peripheral refuses every later
         packet until the next flash. The host sees writes accepted and a
         receive count that never moves. Measured, not inferred: one ping sent
         in the first second after a reopen was enough.

         A valid frame is the proof that the driver is up, because frames come
         out through it. So the first write on a link waits for the first
         frame in, bounded: a board that never speaks is not written to, and
         the caller learns that as false rather than as silence. A running
         board beats four times a second, so the wait costs a quarter second
         at most and only once per link. */
      if (!this.frames) {
        const heard = await Promise.race([
          this._heard,
          new Promise(resolve => setTimeout(() => resolve(false), FIRST_FRAME_MS)),
        ]);
        if (!heard) return false;
      }

      /* Checked inside the chain, not before it: a send queued behind another
         while the port was open must not run once it has closed. The port
         object outlives this link — the flasher reopens the very same one —
         and a writer taken on it then is a lock stolen from whoever is
         writing firmware through it. */
      if (!this.open || this._stopping) return false;
      if (!this.port.writable) return false;

      /* Match the transport that just wrote the firmware successfully:
         acquire for one write, await the underlying Web Serial write, then
         release the lock. releaseLock() does not abort or close the stream;
         it only lets the next serialized send acquire it. Holding one writer
         for the link's whole lifetime left Chrome's USB OUT path accepting
         promises while the board's receive counter stayed unchanged. */
      const writer = this.port.writable.getWriter();
      try {
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
    /* A first send still waiting for a frame is released now, as a no. */
    this._resolveHeard(false);

    /* A send already inside writer.write() owns the stream until it finishes.
       Wait for the serialized queue before closing; sends queued behind the
       stop see _stopping and decline without touching the port. */
    await this._writing;

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
