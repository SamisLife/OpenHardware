/* ============================================================================
   protocol.js — the OHW1 wire protocol.
   ----------------------------------------------------------------------------
   THIS FILE IS THE SPECIFICATION. There is no separate document. The firmware
   implements the same format independently, and the CRC is what keeps the two
   honest: a divergence fails on the first frame rather than subtly, later,
   under load.

   One framed line looks like:

       #OHW1 {"t":"hello","proto":1,...} *A3F2\n
       ^      ^                           ^
       |      payload                     CRC-16/CCITT-FALSE over the payload
       sentinel                           bytes, four uppercase hex digits

   ----------------------------------------------------------------------------
   WHY IT IS SHAPED LIKE THIS

   A board with native USB has no bridge chip, so the protocol, the bootloader's
   startup noise, the firmware's own logging and anything the application layer
   prints all share one endpoint. Framing therefore has to be self-synchronising
   rather than positional:

     A reader scans for a line beginning with the sentinel and checks the CRC.
     Log output cannot produce a false positive. A truncated line fails the CRC
     rather than being half-believed. A reader that attaches part-way through a
     line — which happens on every post-flash reset, because the port comes back
     at an arbitrary moment — loses exactly that line and picks up the next.

   Anything that is not a valid frame is handed back as plain text rather than
   discarded. During bring-up the log is often the only thing that explains what
   happened, and a reader that swallows it leaves nothing to debug with.

   ----------------------------------------------------------------------------
   THE LINK CONTRACT

   Everything that carries these frames — a real serial port, a simulated board,
   a recorded capture — presents the same object, so nothing above this layer
   knows which it is holding:

       { get open(): boolean,
         send(obj): Promise<boolean>,
         stop(): Promise<void> }

   A transport that satisfies a weaker contract than the real one has stopped
   being evidence, so the shape is stated here rather than left to be inferred
   from whichever implementation was written first.
   ========================================================================== */

export const SENTINEL = '#OHW1 ';

/**
 * Longest line accepted, in characters.
 *
 * Bounded because a stream with no newline in it must not be able to grow the
 * reader's buffer without limit. Anything longer than this is not a frame —
 * the largest legal one is a base64 image chunk, which is well inside it.
 */
export const LINE_MAX = 768;

/**
 * Raw bytes per image chunk.
 *
 * An image cannot fit in one line, so it travels as a header naming its size
 * and chunk count, followed by that many indexed base64 chunks:
 *
 *     #OHW1 {"t":"img","seq":9,"w":800,"h":600,"bytes":30112,"chunks":63} *….
 *     #OHW1 {"t":"imgd","seq":9,"i":0,"d":"<640 base64 characters>"} *….
 *
 * 480 raw bytes encode to exactly 640 base64 characters, which leaves room for
 * the envelope inside LINE_MAX. Each chunk carries its own CRC, so a corrupted
 * one is dropped rather than painted, and chunks are indexed rather than
 * assumed to arrive in order.
 */
export const IMG_CHUNK_RAW = 480;

const encoder = new TextEncoder();

/* ------------------------------------------------------------------------ */
/* CRC-16/CCITT-FALSE                                                        */
/* ------------------------------------------------------------------------ */

/**
 * Over the UTF-8 BYTES of the payload, not its characters.
 *
 * The firmware CRCs the bytes it is about to write, so a payload containing
 * anything outside ASCII — a degree sign in a status message, an SSID with an
 * accent in it — would disagree if this hashed code units instead.
 *
 * Standard check value: crc16('123456789') === 0x29B1.
 */
export function crc16(text) {
  let crc = 0xffff;
  for (const b of encoder.encode(text)) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

/* ------------------------------------------------------------------------ */
/* encode                                                                    */
/* ------------------------------------------------------------------------ */

/**
 * One object as a framed line, newline included.
 *
 * @throws if the result would exceed LINE_MAX — a frame the other end is
 *         guaranteed to reject is better refused here, where the caller still
 *         has a stack trace, than sent and silently dropped at the far end.
 */
export function encodeFrame(obj) {
  const body = JSON.stringify(obj);
  const line = `${SENTINEL}${body} *${crc16(body).toString(16).toUpperCase().padStart(4, '0')}\n`;
  if (line.length > LINE_MAX) {
    throw new Error(`frame is ${line.length} characters, over the ${LINE_MAX} limit`);
  }
  return line;
}

/* ------------------------------------------------------------------------ */
/* decode                                                                    */
/* ------------------------------------------------------------------------ */

/**
 * Decode one line.
 *
 * @returns {{frame:object}} a valid frame, or
 *          {{text:string}} anything that is not addressed to this protocol, or
 *          {{text:string, bad:true, reason:string}} something that claimed to
 *          be a frame and was not.
 *
 * The `reason` matters. A CRC failure means the line was corrupted or
 * truncated in transit; a JSON failure means the sender produced a malformed
 * payload and the corruption is upstream of the wire. Those are different
 * faults with different places to look, and collapsing them into "bad frame"
 * throws away the only clue.
 */
export function decodeLine(line) {
  if (!line.startsWith(SENTINEL)) return { text: line };

  /* Searched from the right so a payload containing " *" cannot end the frame
     early — JSON strings are free to contain one. */
  const star = line.lastIndexOf(' *');
  if (star < SENTINEL.length || line.length - star < 6) {
    return { text: line, bad: true, reason: 'no-crc-suffix' };
  }

  const body = line.slice(SENTINEL.length, star);
  const want = parseInt(line.slice(star + 2, star + 6), 16);
  if (!Number.isFinite(want)) return { text: line, bad: true, reason: 'no-crc-suffix' };
  if (crc16(body) !== want) return { text: line, bad: true, reason: 'crc' };

  try {
    return { frame: JSON.parse(body) };
  } catch {
    /* The CRC held, so the bytes arrived exactly as sent. Whatever produced
       them emitted malformed JSON. */
    return { text: line, bad: true, reason: 'json' };
  }
}

/* ------------------------------------------------------------------------ */
/* the reader                                                                */
/* ------------------------------------------------------------------------ */

/**
 * Turns a stream of decoded text into frames and log lines.
 *
 * Cost matters here more than it looks. One image arrives as dozens of
 * consecutive lines in a single burst, and the obvious implementation —
 * searching the whole pending buffer for a newline and re-slicing it for every
 * line found — is quadratic in the size of the burst. A cursor over the buffer
 * with occasional compaction is linear, and the difference is megabytes of
 * string copying per frame.
 *
 * The overflow rule is the other thing worth stating. A buffer that grows past
 * the line limit contains no frame, but discarding the buffer wholesale would
 * also throw away the frames queued behind the offending line. Instead the
 * overlong line alone is abandoned and the reader resynchronises on the next
 * newline, so one bad line costs one bad line.
 */
export class FrameReader {
  /**
   * @param {object} handlers
   *   onFrame(frame, rawLine)   a valid OHW1 frame
   *   onText(line, bad, reason) anything else, verbatim
   */
  constructor({ onFrame, onText } = {}) {
    this.onFrame = onFrame;
    this.onText = onText;
    this.buf = '';
    this.start = 0;
    /** Set while an overlong line is being skipped to the next newline. */
    this.skipping = false;
    /** Lines abandoned for being longer than LINE_MAX. Reported, not hidden. */
    this.dropped = 0;
  }

  /** Characters held but not yet consumed. */
  get pending() { return this.buf.length - this.start; }

  push(chunk) {
    if (!chunk) return;
    this.buf += chunk;

    for (;;) {
      const nl = this.findNewline();
      if (nl === -1) break;

      if (this.skipping) {
        this.skipping = false;
      } else {
        const line = this.buf.slice(this.start, nl);
        if (line.trim()) this.emit(line);
      }
      this.start = nl + 1;
    }

    /* No newline in sight and more than a line's worth of text pending: this
       cannot become a frame, so abandon it and wait for the next newline. */
    if (this.pending > LINE_MAX) {
      if (!this.skipping) { this.skipping = true; this.dropped++; }
      this.start = this.buf.length;
    }

    this.compact();
  }

  findNewline() {
    const n = this.buf.indexOf('\n', this.start);
    const r = this.buf.indexOf('\r', this.start);
    if (n === -1) return r;
    if (r === -1) return n;
    return Math.min(n, r);
  }

  /** Drop the consumed prefix, but only once it is worth the copy. */
  compact() {
    if (this.start === 0) return;
    if (this.start < 4096 && this.pending > 0) return;
    this.buf = this.buf.slice(this.start);
    this.start = 0;
  }

  emit(line) {
    const out = decodeLine(line);
    if (out.frame) this.onFrame?.(out.frame, line);
    else this.onText?.(out.text, !!out.bad, out.reason);
  }

  /** Forget anything half-received. Used when a port is reattached. */
  reset() {
    this.buf = '';
    this.start = 0;
    this.skipping = false;
  }
}
