/* ============================================================================
   protocol.mjs — the OHW1 wire format.

       node frontend/tests/protocol.mjs

   This protocol is implemented twice, here and in the firmware, and the two are
   written months apart by different halves of the project. That makes this file
   the contract between them: the standard CRC check value is pinned so the
   firmware can be written against a known constant rather than against
   whatever this happens to compute.

   The rest is the awkward reality of a shared endpoint — log noise between
   frames, a reader attaching mid-line, a payload that contains the sequence
   used to terminate it, and a burst of image chunks large enough that the wrong
   buffering strategy is quadratic.
   ========================================================================== */

import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const JS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'js');
const P = await import(pathToFileURL(path.join(JS, 'link', 'protocol.js')).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  — ' + extra : ''}`); }
};

/** Collect what a reader produces from a sequence of chunks. */
function read(...chunks) {
  const frames = [], texts = [];
  const r = new P.FrameReader({
    onFrame: f => frames.push(f),
    onText: (t, bad, reason) => texts.push({ t, bad: !!bad, reason }),
  });
  for (const c of chunks) r.push(c);
  return { frames, texts, reader: r };
}

/* ------------------------------------------------------------------------ */
/* the CRC, pinned to the standard                                           */
/* ------------------------------------------------------------------------ */

{
  /* The published check value for CRC-16/CCITT-FALSE. The firmware is written
     against this constant, not against whatever this file computes, which is
     what makes an independent second implementation possible at all. */
  ok('crc16("123456789") is the standard check value 0x29B1',
     P.crc16('123456789') === 0x29b1,
     '0x' + P.crc16('123456789').toString(16).toUpperCase());

  ok('an empty payload hashes to the initial value', P.crc16('') === 0xffff);

  /* Hashing UTF-16 code units instead of UTF-8 bytes would disagree with the
     firmware on any payload carrying a degree sign or an accented SSID —
     silently, and only for those boards. Checked against an explicit byte
     sequence rather than against another call to the same function. */
  const overBytes = bs => {
    let crc = 0xffff;
    for (const b of bs) {
      crc ^= b << 8;
      for (let i = 0; i < 8; i++) {
        crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
      }
    }
    return crc;
  };
  ok('the hash is over UTF-8 bytes',
     P.crc16('°') === overBytes([0xc2, 0xb0]),
     `got 0x${P.crc16('°').toString(16)}, expected 0x${overBytes([0xc2, 0xb0]).toString(16)}`);
  ok('and not over UTF-16 code units',
     P.crc16('°') !== overBytes([0xb0]),
     'hashing code units would disagree with the firmware on non-ASCII payloads');

  const round = P.decodeLine(P.encodeFrame({ t: 'status', detail: 'die at 41 °C' }));
  ok('and a payload outside ASCII survives a round trip',
     round.frame?.detail === 'die at 41 °C', JSON.stringify(round));
}

/* ------------------------------------------------------------------------ */
/* encode and decode                                                         */
/* ------------------------------------------------------------------------ */

{
  const line = P.encodeFrame({ t: 'hello', proto: 1, fw: '0.5.0' });
  ok('a frame starts with the sentinel', line.startsWith('#OHW1 '));
  ok('and ends with a newline', line.endsWith('\n'));
  ok('and carries four uppercase hex digits of CRC',
     /\ \*[0-9A-F]{4}\n$/.test(line), JSON.stringify(line.slice(-8)));

  const out = P.decodeLine(line.trimEnd());
  ok('a frame round-trips', out.frame?.t === 'hello' && out.frame.proto === 1);
}

{
  /* A JSON string may contain the sequence that terminates the frame. Scanning
     from the left would cut the payload in half and fail the CRC. */
  const line = P.encodeFrame({ t: 'status', detail: 'wrote 4 *A3F2 to flash' });
  const out = P.decodeLine(line.trimEnd());
  ok('a payload containing the CRC separator still decodes',
     out.frame?.detail === 'wrote 4 *A3F2 to flash', JSON.stringify(out));
}

{
  ok('an oversized frame is refused at the sender',
     (() => { try { P.encodeFrame({ t: 'x', d: 'y'.repeat(P.LINE_MAX) }); return false; }
              catch { return true; } })(),
     'a frame the far end must reject is better refused where the caller can see it');
}

/* ------------------------------------------------------------------------ */
/* the three ways a line can fail                                            */
/* ------------------------------------------------------------------------ */

{
  const good = P.encodeFrame({ t: 'beat', fps: 8.3 }).trimEnd();

  const corrupted = good.replace('8.3', '9.3');
  const a = P.decodeLine(corrupted);
  ok('a corrupted payload fails the CRC', a.bad && a.reason === 'crc');
  ok('and is handed back verbatim rather than swallowed', a.text === corrupted);

  const truncated = good.slice(0, good.length - 10);
  const b = P.decodeLine(truncated);
  ok('a truncated line is caught', b.bad === true, JSON.stringify(b));

  /* The CRC held, so the bytes arrived exactly as sent — whatever produced
     them emitted malformed JSON, and the fault is upstream of the wire. */
  const body = '{"t":"beat",';
  const c = P.decodeLine(`#OHW1 ${body} *${P.crc16(body).toString(16).toUpperCase().padStart(4, '0')}`);
  ok('a valid CRC over malformed JSON is reported as a sender fault',
     c.bad && c.reason === 'json',
     'a CRC failure and a JSON failure have different places to look');
}

/* ------------------------------------------------------------------------ */
/* sharing the endpoint with everything else                                 */
/* ------------------------------------------------------------------------ */

{
  const { frames, texts } = read(
    'I (25) boot: ESP-IDF 2nd stage bootloader\n',
    P.encodeFrame({ t: 'hello', fw: '0.5.0' }),
    'I (699) esp_psram: SPI SRAM memory test OK\n',
    P.encodeFrame({ t: 'beat', fps: 4 }),
  );
  ok('frames are picked out of interleaved log noise', frames.length === 2);
  ok('and the log is passed through rather than discarded', texts.length === 2,
     'during bring-up the log is often the only thing that explains what happened');
  ok('the log arrives verbatim', /esp_psram/.test(texts[1].t));
  ok('and is not marked as a failed frame', texts.every(t => !t.bad),
     'noise is not a broken frame');
}

{
  /* Every post-flash reset reattaches the port at an arbitrary moment. */
  const whole = P.encodeFrame({ t: 'hello', fw: '0.5.0' });
  const { frames, texts } = read(
    whole.slice(20),
    P.encodeFrame({ t: 'beat', fps: 4 }),
  );
  ok('attaching mid-line loses that line and no more', frames.length === 1,
     `${frames.length} frames`);
  ok('and the partial line is reported as text, not as a frame',
     texts.length === 1 && !texts[0].bad);
}

{
  const line = P.encodeFrame({ t: 'beat', fps: 4 });
  ok('a frame split across chunk boundaries reassembles',
     read(line.slice(0, 9), line.slice(9, 22), line.slice(22)).frames.length === 1);

  ok('carriage returns terminate a line as well as newlines',
     read(line.replace('\n', '\r\n')).frames.length === 1);
  ok('and a bare carriage return does too',
     read(line.replace('\n', '\r')).frames.length === 1);

  ok('blank lines are not reported as anything',
     read('\n\n\r\n').texts.length === 0);
}

/* ------------------------------------------------------------------------ */
/* an overlong line costs one line                                           */
/* ------------------------------------------------------------------------ */

{
  /* A stream with no newline in it must not grow the buffer without limit, and
     abandoning the whole buffer would take the frames queued behind it. */
  const flood = 'x'.repeat(P.LINE_MAX * 3);
  const { frames, reader } = read(
    flood,
    '\n',
    P.encodeFrame({ t: 'beat', fps: 4 }),
    P.encodeFrame({ t: 'hello', fw: '0.5.0' }),
  );
  ok('an overlong line is abandoned', reader.dropped === 1, `dropped ${reader.dropped}`);
  ok('and the frames behind it still arrive', frames.length === 2,
     `${frames.length} frames survived — one bad line must cost one bad line`);
  ok('the buffer does not keep the flood', reader.pending < P.LINE_MAX,
     `${reader.pending} characters pending`);
}

{
  const r = new P.FrameReader({});
  r.push('x'.repeat(P.LINE_MAX * 10));
  ok('a stream with no newline at all stays bounded', r.pending <= P.LINE_MAX,
     `${r.pending} characters held`);
}

/* ------------------------------------------------------------------------ */
/* a burst, at the size an image actually arrives in                         */
/* ------------------------------------------------------------------------ */

{
  /* One image is dozens of consecutive chunk frames delivered at once. The
     obvious buffering — search the whole buffer, re-slice it per line — is
     quadratic in the burst, which is megabytes of copying per frame. */
  const chunk = 'A'.repeat(640);
  const burst = Array.from({ length: 90 },
    (_, i) => P.encodeFrame({ t: 'imgd', seq: 1, i, d: chunk })).join('');

  const t0 = process.hrtime.bigint();
  const { frames, reader } = read(burst);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;

  ok('every chunk of a large burst is decoded', frames.length === 90,
     `${frames.length} of 90`);
  ok('in order', frames.every((f, i) => f.i === i));
  ok('and the buffer is left empty afterwards', reader.pending === 0);
  ok('without quadratic cost', ms < 200, `${ms.toFixed(1)} ms for a 90-chunk burst`);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
