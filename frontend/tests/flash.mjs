/* ============================================================================
   flash.mjs — writing firmware, and the two phases around it.

       node frontend/tests/flash.mjs

   esptool cannot be loaded outside a browser and there is no serial port here,
   so what is tested is everything around the write — which is where the
   failures that matter actually live.

   The property worth pinning down is the two-phase separation. Until the chip
   has answered, "the write did not finish" is not a reachable outcome, and
   reporting it would be a claim about hardware this page never touched. A 404
   on a JSON file is not a half-written flash, and the previous version of this
   project reported it as one.
   ========================================================================== */

import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';

const JS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'js');
const load = rel => import(pathToFileURL(path.join(JS, rel)).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  — ' + extra : ''}`); }
};

globalThis.crypto ??= webcrypto;
globalThis.requestAnimationFrame = fn => setTimeout(() => fn(0), 0);
globalThis.location = { origin: 'http://localhost:8000' };

const F = await load('link/flash.js');
const { Session } = await load('onboard/session.js');
const { simulatedDriver } = await load('link/drivers.js');
const { FAULTS } = await load('onboard/faults.js');

const wait = ms => new Promise(r => setTimeout(r, ms));
const hex64 = c => String(c).repeat(64);

const goodPart = (over = {}) => ({
  path: 'firmware.bin', offset: 0x20000, size: 16, sha256: hex64('a'), ...over,
});
const manifest = (over = {}) => ({
  project: 'test', version: '1.0.0', chip: 'esp32s3',
  parts: [goodPart()], ...over,
});

/* ------------------------------------------------------------------------ */
/* the manifest contract                                                     */
/* ------------------------------------------------------------------------ */

{
  ok('a well-formed manifest is accepted', F.validateManifest(manifest()) === null,
     String(F.validateManifest(manifest())));

  ok('a manifest with no images is refused',
     /no images/.test(F.validateManifest(manifest({ parts: [] })) || ''));
  ok('a part with no offset is refused',
     /offset/.test(F.validateManifest(manifest({ parts: [goodPart({ offset: null })] })) || ''));

  /* Two images at one offset means one silently overwrites the other, and the
     board boots whatever won. */
  const clash = manifest({ parts: [goodPart(), goodPart({ path: 'other.bin' })] });
  ok('two images at the same offset are refused',
     /share offset/.test(F.validateManifest(clash) || ''),
     String(F.validateManifest(clash)));
}

{
  /* A hash that cannot be checked is worse than none, because it looks like a
     guarantee. WebCrypto has no MD5, so a manifest carrying one could never be
     verified in a browser — which is why the contract specifies sha256. */
  ok('a part with no sha256 is refused',
     /sha256/.test(F.validateManifest(manifest({ parts: [goodPart({ sha256: undefined })] })) || ''));
  ok('and so is one carrying an md5-shaped hash',
     /sha256/.test(F.validateManifest(manifest({ parts: [goodPart({ sha256: 'd41d8cd98f00b204e9800998ecf8427e' })] })) || ''),
     'a 32-hex-digit hash is not a sha256, and cannot be checked here');

  ok('sha256Hex matches the known digest of an empty input',
     (await F.sha256Hex(new Uint8Array(0)))
       === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
}

/* ------------------------------------------------------------------------ */
/* fetching proves what arrived                                              */
/* ------------------------------------------------------------------------ */

{
  const body = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const digest = await F.sha256Hex(body);
  const serve = (bytes, status = 200) => {
    globalThis.fetch = async () => ({
      ok: status === 200, status,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
    });
  };

  serve(body);
  const m = manifest({ parts: [{ path: 'a.bin', offset: 0, size: 8, sha256: digest }] });
  const images = await F.fetchImages(m);
  ok('a verified image is returned with its address',
     images[0].address === 0 && images[0].data.length === 8);

  serve(body.slice(0, 6));
  await F.fetchImages(m).then(
    () => ok('a truncated download is refused', false),
    e => ok('a truncated download is refused', /expected 8 bytes/.test(e.message), e.message));

  serve(new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9]));
  await F.fetchImages(m).then(
    () => ok('contents that do not match the published hash are refused', false),
    e => ok('contents that do not match the published hash are refused',
            /sha256/.test(e.message) && e.code === 'fetch_failed', e.message));

  serve(body, 404);
  await F.fetchImages(m).then(
    () => ok('a missing image is refused', false),
    e => ok('a missing image is refused', e.code === 'fetch_failed', e.message));
}

{
  globalThis.fetch = async () => ({ ok: false, status: 404 });
  await F.fetchManifest().then(
    () => ok('a missing manifest is reported as a missing manifest', false),
    e => ok('a missing manifest is reported as a missing manifest',
            e.code === 'no_manifest', `${e.code}: ${e.message}`));

  globalThis.fetch = async () => { throw new Error('Failed to fetch'); };
  await F.fetchManifest().then(
    () => ok('an unreachable server is reported as unreachable', false),
    e => ok('an unreachable server is reported as unreachable', e.code === 'no_server'));
}

/* ------------------------------------------------------------------------ */
/* getting the board back, without resetting it to find out                  */
/* ------------------------------------------------------------------------ */

{
  /* waitForBoard is for a board that is already RUNNING. Opening a port
     asserts DTR and RTS, which on hardware with native USB are wired to reset
     and boot select, so probing by opening would reset the running board it
     was reattaching to and take its uptime and boot identity with it. */
  let opened = 0;
  const port = { open: async () => { opened++; }, close: async () => {} };

  let appears = false;
  setTimeout(() => { appears = true; }, 250);

  const found = await F.waitForBoard(port, {
    timeoutMs: 3000, pollMs: 100,
    portsLike: async () => (appears ? [port] : []),
    serial: null,
  });

  ok('a running board is found once it is back on the bus', found === port);
  ok('and nothing was opened to find out', opened === 0,
     `${opened} ports were opened — probing by opening resets a running board`);
}

/* ------------------------------------------------------------------------ */
/* and the opposite rule, for the opposite moment                            */
/* ------------------------------------------------------------------------ */

{
  /* reopenAfterReset is for the moment AFTER a write, and it has to do the
     thing the function above must not: drive DTR and RTS through a complete
     open-and-close cycle. That cycle is what leaves the chip running the
     application instead of waiting in its ROM downloader, which is silent by
     design and looks exactly like a board that will not start. */
  const seen = [];
  const port = {
    open: async () => { seen.push('open'); },
    close: async () => { seen.push('close'); },
  };

  const found = await F.reopenAfterReset(port, {
    timeoutMs: 3000, pollMs: 50, portsLike: async () => [port],
  });

  ok('the board comes back after a write', found === port);
  ok('and the port was opened, not merely matched', seen.includes('open'),
     'a board left in download mode emits nothing at all');
  ok('and released again, so the reader can have it',
     seen.join(',') === 'open,close', seen.join(','));
}

{
  /* The handle held may be stale: a reset takes the whole USB device off the
     bus and it can return as a different port object. */
  let live = false;
  setTimeout(() => { live = true; }, 150);

  const stale = { open: async () => { throw new Error('device gone'); }, close: async () => {} };
  let replacementOpened = 0;
  const replacement = {
    open: async () => {
      if (!live) throw new Error('not yet');
      replacementOpened++;
    },
    close: async () => {},
  };

  const found = await F.reopenAfterReset(stale, {
    timeoutMs: 3000, pollMs: 50, portsLike: async () => [stale, replacement],
  });

  ok('a board that re-enumerated is found as its new handle', found === replacement);
  ok('and it was cycled too', replacementOpened === 1, replacementOpened);
}

{
  const dead = { open: async () => { throw new Error('nothing there'); }, close: async () => {} };
  const t0 = Date.now();
  const found = await F.reopenAfterReset(dead, {
    timeoutMs: 400, pollMs: 80, portsLike: async () => [],
  });
  ok('a board that never comes back times out rather than hanging', found === null);
  ok('and does so within its deadline', Date.now() - t0 < 1500);
}

{
  const port = {};
  const t0 = Date.now();
  const found = await F.waitForBoard(port, {
    timeoutMs: 400, pollMs: 80, portsLike: async () => [], serial: null,
  });
  ok('a board that never returns times out rather than hanging', found === null);
  ok('and does so within its deadline', Date.now() - t0 < 1500);
}

/* ------------------------------------------------------------------------ */
/* the two phases, through the session                                       */
/* ------------------------------------------------------------------------ */

{
  /* Phase one. The chip was never opened, so the board is untouched — and the
     message is allowed to say so without hedging. */
  const d = { ...simulatedDriver(''), fetchManifest: async () => { const e = new Error('no build published'); e.code = 'no_manifest'; throw e; } };
  const s = new Session(d, () => {});
  await s.connect();
  await s.flash();

  ok('a missing image fails on the flash rung', s.state.fault?.code === 'no_manifest');
  ok('and states that nothing was written',
     /Nothing was written to the board/i.test(s.state.fault.next),
     s.state.fault.next);
  ok('an interrupted write is not even a possible answer here',
     s.state.fault.code !== 'flash_failed',
     'until the chip answers, that outcome is unreachable');
  await s.dispose();
}

{
  /* Phase two, before the chip answers. */
  const d = {
    ...simulatedDriver(''),
    flash: async () => { throw new Error('Timed out waiting for packet header'); },
  };
  const s = new Session(d, () => {});
  await s.connect();
  await s.flash();
  ok('a chip that never answers is reported as such', s.state.fault?.code === 'no_chip',
     s.state.fault?.code);
  await s.dispose();
}

{
  /* Phase two, after it answered. The decision is made on whether the chip was
     ever seen, not by matching the error text. */
  const d = {
    ...simulatedDriver(''),
    flash: async (_p, _i, opts) => {
      opts.onChip?.('ESP32-S3');
      throw new Error('Timed out waiting for packet header');
    },
  };
  const s = new Session(d, () => {});
  await s.connect();
  await s.flash();
  ok('the same error after the chip answered is an interrupted write',
     s.state.fault?.code === 'flash_failed', s.state.fault?.code);
  ok('and it says nothing is bricked', /not bricked|mask ROM/i.test(s.state.fault.next));
  await s.dispose();
}

{
  const d = { ...simulatedDriver(''), waitForBoard: async () => null };
  const s = new Session(d, () => {});
  await s.connect();
  await s.flash();
  ok('a board that does not come back after a write is reported',
     s.state.fault?.code === 'no_reopen', s.state.fault?.code);
  ok('and the image is still acknowledged as written',
     /image was written/i.test(s.state.fault.next));
  await s.dispose();
}

/* ------------------------------------------------------------------------ */
/* the whole path, simulated                                                 */
/* ------------------------------------------------------------------------ */

{
  const seen = [];
  const s = new Session(simulatedDriver(''), st => {
    if (st.progress) seen.push(st.progress.written / st.progress.total);
  });

  await s.connect();
  /* Connecting stops to ask and writes nothing. Asserted on the flag rather
     than on the rung, because the rung is also 'active' while it reads what is
     already on the board — and the invariant worth protecting is that no bytes
     reach the chip, not which label the rung is wearing. */
  ok('connecting alone does not write anything',
     s.state.writing === false && s.state.rungs.flash.state === 'ask',
     'writing over a working board is never what happens on the way past');

  await s.flash();
  await wait(400);

  ok('the write completes', s.state.rungs.flash.state === 'done');
  ok('progress was measured rather than animated',
     seen.length > 3 && seen[seen.length - 1] === 1, `${seen.length} updates`);
  ok('and it only ever moved forwards',
     seen.every((v, i) => i === 0 || v >= seen[i - 1]));

  ok('the board comes back', s.state.rungs.boot.state === 'done');
  ok('and identifies itself again', s.state.rungs.identify.state === 'done');
  ok('and reports', s.state.rungs.telemetry.state === 'done');
  ok('which ends bring-up', s.state.phase === 'done');
  await s.dispose();
}

/* ------------------------------------------------------------------------ */
/* the rule still holds for the faults added here                            */
/* ------------------------------------------------------------------------ */

{
  for (const code of ['no_manifest', 'fetch_failed', 'no_chip', 'flash_failed', 'no_reopen']) {
    const f = FAULTS[code];
    ok(`${code}: states what was observed`, !!f?.observed && f.observed.length > 10);
    ok(`${code}: keeps candidates out of the observation`, Array.isArray(f.causes));
  }

  /* The exact sentence the previous project used for a missing image. */
  ok('a missing image is not described as an interrupted write',
     !/writing was interrupted/i.test(FAULTS.no_manifest.observed),
     FAULTS.no_manifest.observed);
}

/* ------------------------------------------------------------------------ */
/* a link that never listened must not report on the board                   */
/* ------------------------------------------------------------------------ */

{
  const f = FAULTS.read_failed;
  ok('read_failed: states what was observed', !!f?.observed && f.observed.length > 10);
  ok('read_failed: says the page heard nothing, not that the board sent nothing',
     /never started reading|nothing can be concluded/i.test(f.observed), f.observed);

  /* The whole point of separating this from silent_after_write. A reader that
     never attached has observed nothing about the hardware, so naming a
     hardware cause would be inventing one. */
  const blames = f.causes.filter(c => /board|firmware|image|power|cable/i.test(c));
  ok('read_failed: names no cause in the hardware, because none was observed',
     blames.length === 0, blames.join(' | '));
}

{
  /* The session has to reach for that fault rather than the one about the
     board. A link whose reader never attached knows nothing either way. */
  const s = new Session(simulatedDriver(''), () => {});
  s._justWritten = true;
  s.link = {
    readerFailed: 'the stream is locked by another reader',
    /* A link whose reader never attached can still be written to, and the
       flow does try — which is the point: sending succeeds and nothing comes
       back, because there is nothing listening on this side. */
    send: async () => true,
  };
  s.state.heard = { lines: 0, first: null };
  await s.identify();

  ok('a failed reader is reported as a failed reader',
     s.state.fault?.code === 'read_failed', s.state.fault?.code);
  ok('and not as a board that will not start',
     s.state.fault?.code !== 'silent_after_write');
  await s.dispose();
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
