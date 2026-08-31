/* ============================================================================
   flash.js — writing firmware from a web page.
   ----------------------------------------------------------------------------
   esptool-js is Espressif's own port of esptool, and it is what makes the whole
   bring-up story possible: nothing is installed. No Python, no toolchain, no
   driver beyond the one the operating system already has.

   The interesting part of this file is not the writing. It is everything
   around it.

   ----------------------------------------------------------------------------
   THE MANIFEST CONTRACT

   Specified here, produced later by the packing tool. Offsets come from the
   partition table via the build, never from anything written down twice.

       { project, version, chip, total_bytes,
         parts: [ { path, offset, size, sha256 } ] }

   `project` rather than a display name, because the packing tool reads it out
   of the image's own app descriptor. A prettier label would be a second copy
   of the same fact, free to drift from the artefact it describes.

   `sha256` rather than md5 for one concrete reason: WebCrypto has no MD5, so a
   manifest carrying md5 cannot be verified by a browser without shipping a
   hash implementation to do it — and a checksum that is published but never
   checked is worse than none, because it looks like a guarantee.

   ----------------------------------------------------------------------------
   TWO PHASES, AND WHY THEY HAVE SEPARATE FAILURES

   Everything is downloaded and verified BEFORE the board is opened. Until the
   chip has answered, "writing was interrupted" is not a reachable outcome, and
   reporting it would be a claim about hardware this page never touched. A 404
   on a JSON file is not a half-written flash.

   ----------------------------------------------------------------------------
   THE PORT HANDOFF

   esptool opens the port itself, and it must not be open when it does. That is
   the same problem as releasing it provably, which is why the two arrived
   together: a port believed closed and not is worse than an error, because the
   failure surfaces later and somewhere else, as the board apparently refusing
   to answer.
   ========================================================================== */

const ESPTOOL_VERSION = '0.6.1';

/**
 * The one runtime dependency in this project, pinned to an exact version.
 *
 * Loaded from a CDN rather than bundled because bundling means a build step,
 * and a build step is a thing that can fail on somebody else's machine. To run
 * offline, vendor the module and point this at the local copy.
 */
const ESPTOOL_URL = `https://cdn.jsdelivr.net/npm/esptool-js@${ESPTOOL_VERSION}/+esm`;

let modPromise = null;

export function loadEsptool(url = ESPTOOL_URL) {
  if (modPromise) return modPromise;
  modPromise = import(/* @vite-ignore */ url).catch(err => {
    modPromise = null;
    throw new Error(
      `Could not load the flashing library from ${url}. `
      + `The network may be unavailable, or the module may be blocked. (${err.message})`);
  });
  return modPromise;
}

/* ------------------------------------------------------------------------ */
/* the manifest                                                              */
/* ------------------------------------------------------------------------ */

export async function fetchManifest(base = '/firmware/dist/') {
  const url = new URL('manifest.json', new URL(base, location.origin));

  let res;
  try {
    res = await fetch(url, { cache: 'no-store' });
  } catch (err) {
    const e = new Error(`could not reach ${url.href}: ${err.message}`);
    e.code = 'no_server';
    throw e;
  }

  if (!res.ok) {
    /* The code comes from the status, not from the response body. A plain file
       server answers a missing manifest with an HTML 404 and no JSON at all,
       and reading the body to identify the failure is how a missing image once
       got reported as an interrupted write.

       The URL is named because the most common cause of a 404 here is a file
       server rooted somewhere other than the repository — at which point the
       page loads perfectly and only this one path is missing. Reporting "no
       firmware published" without saying what was asked for turns a one-line
       fix into an investigation. */
    const e = new Error(`no firmware image published — ${url.href} returned HTTP ${res.status}`);
    e.code = 'no_manifest';
    throw e;
  }

  const manifest = await res.json();
  const problem = validateManifest(manifest);
  if (problem) {
    const e = new Error(problem);
    e.code = 'no_manifest';
    throw e;
  }
  return manifest;
}

/** @returns {string|null} what is wrong with it, or null. */
export function validateManifest(m) {
  if (!m || typeof m !== 'object') return 'the manifest is not an object';
  if (!Array.isArray(m.parts) || !m.parts.length) return 'the manifest lists no images';

  for (const [i, p] of m.parts.entries()) {
    if (typeof p.path !== 'string' || !p.path) return `part ${i} has no path`;
    if (!Number.isInteger(p.offset) || p.offset < 0) return `part ${i} has no valid offset`;
    if (!Number.isInteger(p.size) || p.size <= 0) return `part ${i} has no valid size`;
    /* Refused rather than warned about. An unverifiable image is one nobody
       can say arrived intact, and it is about to be written to a board. */
    if (typeof p.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(p.sha256)) {
      return `part ${i} (${p.path}) has no sha256`;
    }
  }

  /* Two parts at one offset means one silently overwrites the other. */
  const offsets = new Set();
  for (const p of m.parts) {
    if (offsets.has(p.offset)) return `two images share offset 0x${p.offset.toString(16)}`;
    offsets.add(p.offset);
  }
  return null;
}

/* ------------------------------------------------------------------------ */
/* fetching, and proving what arrived                                        */
/* ------------------------------------------------------------------------ */

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Fetch every image the manifest lists and check each against its hash.
 *
 * Done in full before the board is touched, so a missing file or a truncated
 * download fails while the board is still in a known-good state. Fetched in
 * parallel because they are independent and there are only a handful.
 */
export async function fetchImages(manifest, base = '/firmware/dist/') {
  const root = new URL(base, location.origin);

  return Promise.all(manifest.parts.map(async part => {
    let res;
    try {
      res = await fetch(new URL(part.path, root));
    } catch (err) {
      throw tagged('fetch_failed', `${part.path}: ${err.message}`);
    }
    if (!res.ok) throw tagged('fetch_failed', `${part.path}: HTTP ${res.status}`);

    const data = new Uint8Array(await res.arrayBuffer());
    if (data.length !== part.size) {
      throw tagged('fetch_failed',
        `${part.path}: expected ${part.size} bytes, received ${data.length}`);
    }

    const got = await sha256Hex(data);
    if (got !== String(part.sha256).toLowerCase()) {
      /* The one check worth having: it separates "the download was corrupted"
         from "the board rejected the image", which are otherwise the same
         symptom hours apart. */
      throw tagged('fetch_failed',
        `${part.path}: contents do not match the published sha256`);
    }

    return { data, address: part.offset, name: part.path };
  }));
}

function tagged(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/* ------------------------------------------------------------------------ */
/* writing                                                                   */
/* ------------------------------------------------------------------------ */

/**
 * Write an image set to a board.
 *
 * @param {SerialPort} port  must be closed; esptool opens it itself
 * @param {Array} images     from fetchImages()
 * @param {object} opts
 *   onLog(line)                 esptool's own output, shown on the wire
 *   onProgress(written, total)  bytes across the whole write, measured
 *   onChip(description)         once the chip has identified itself
 *   eraseAll                    wipe flash first
 */
export async function flashBoard(port, images, opts = {}) {
  const { ESPLoader, Transport } = await loadEsptool(opts.esptoolUrl);

  /* esptool opens the port itself and fails unhelpfully if anything still
     holds it. Closing an already-closed port throws, and that throw is the
     expected case rather than a problem. */
  try { await port.close(); } catch { /* already closed, which is the goal */ }

  const terminal = {
    clean() {},
    writeLine(data) { opts.onLog?.(String(data)); },
    write(data) { opts.onLog?.(String(data)); },
  };

  const transport = new Transport(port, false);
  const loader = new ESPLoader({
    transport,
    baudrate: 460800,
    /* The ROM speaks at 115200 until the rate is negotiated up. Saying so
       explicitly avoids a sync failure on a board that came up already in
       download mode. */
    romBaudrate: 115200,
    terminal,
    debugLogging: false,
  });

  /* Progress is reported per file; the offsets are accumulated so the bar
     measures the whole operation. Every other stage of bring-up is genuinely
     indeterminate and says so rather than animating something. */
  const total = images.reduce((n, f) => n + f.data.length, 0);
  const before = [];
  images.reduce((n, f) => { before.push(n); return n + f.data.length; }, 0);

  let chip = null;
  try {
    chip = await loader.main();
    opts.onChip?.(chip);

    await loader.writeFlash({
      fileArray: images.map(f => ({ data: f.data, address: f.address })),
      flashSize: 'keep',
      flashMode: 'keep',
      flashFreq: 'keep',
      eraseAll: !!opts.eraseAll,
      compress: true,
      reportProgress(fileIndex, written) {
        opts.onProgress?.(before[fileIndex] + written, total);
      },
    });

    opts.onProgress?.(total, total);
    await loader.after('hard_reset');
    return { chip };
  } finally {
    /* Released whatever happened, or nothing else can open it. */
    try { await transport.disconnect(); } catch { /* nothing holds it now */ }
  }
}

/* ------------------------------------------------------------------------ */
/* getting the board back                                                    */
/* ------------------------------------------------------------------------ */

/**
 * Wait for a board to reappear after a reset, WITHOUT opening anything.
 *
 * For a board that is already running: a hot replug, an OS suspend, a cable
 * moved between sockets. Opening asserts DTR and RTS, which on this hardware
 * are wired to reset and boot select — so a probe loop resets the running
 * board it was supposed to be reattaching to, and takes its uptime and its
 * boot identity with it. That is a reboot nobody ordered, reported as a
 * measurement.
 *
 * NOT for the moment after a write. See reopenAfterReset() below, which is a
 * separate function precisely because the right answer there is the opposite
 * one, and collapsing the two is a defect this file has already had.
 *
 * @returns {SerialPort|null}
 */
export async function waitForBoard(port, {
  timeoutMs = 15000, pollMs = 400, onWait, portsLike, serial,
} = {}) {
  const bus = serial ?? (typeof navigator !== 'undefined' ? navigator.serial : null);
  const deadline = Date.now() + timeoutMs;

  let resolveConnect;
  const connected = new Promise(r => { resolveConnect = r; });
  const onConnect = () => resolveConnect(true);
  bus?.addEventListener?.('connect', onConnect);

  try {
    for (let attempt = 1; Date.now() < deadline; attempt++) {
      onWait?.(attempt, Math.max(0, deadline - Date.now()));

      const found = await portsLike(port);
      if (found?.length) return found[0];

      /* Either the bus says something arrived, or the poll comes round again.
         The event is the fast path; the poll is what covers a browser that
         reuses the same port object and fires nothing. */
      await Promise.race([connected, sleep(pollMs)]);
    }
    return null;
  } finally {
    bus?.removeEventListener?.('connect', onConnect);
  }
}

/**
 * Get the board back after a write, by opening the port and letting it go.
 *
 * ----------------------------------------------------------------------------
 * THIS ONE PROBES BY OPENING, AND THAT IS THE WHOLE POINT
 *
 * The reasoning that forbids opening applies to a board that is running. This
 * is not that moment. esptool has just reset a chip that was in its ROM
 * downloader, the board is in a state nothing here knows, and a reset costs
 * nothing because there is no uptime and no boot identity to lose.
 *
 * What the open and the close actually do is drive DTR and RTS through a
 * complete cycle. On a part with native USB those lines are the reset and
 * boot-select straps, so the cycle is what leaves the chip reset with the boot
 * strap released — running the application rather than waiting in the
 * downloader. Merely opening the port and holding it is not the same thing:
 * this page then sits with DTR asserted and RTS clear, which is the state that
 * HOLDS the boot strap down, and a board that resets under it comes back into
 * download mode. Download mode is silent by design — no protocol frames, and
 * no boot messages either, which is exactly what a silent board after a
 * successful write looks like.
 *
 * The predecessor project had this function and used it only here, with a
 * separate identifier-matching one for hot replug. The rebuild kept the second
 * and used it for both, and the board stopped coming up.
 *
 * @returns {SerialPort|null}
 */
export async function reopenAfterReset(port, {
  timeoutMs = 15000, pollMs = 500, onWait, portsLike, baudRate = 115200,
} = {}) {
  const deadline = Date.now() + timeoutMs;

  /* Opened and immediately closed. Holding it here would leave the port locked
     against the reader that is about to want it, and the open is being done
     for its effect on the control lines rather than for anything to read. */
  const cycle = async p => {
    try {
      await p.open({ baudRate, bufferSize: 4096 });
      await p.close();
      return true;
    } catch {
      return false;                    /* not back yet, or not this one */
    }
  };

  for (let attempt = 1; Date.now() < deadline; attempt++) {
    onWait?.(attempt, Math.max(0, deadline - Date.now()));

    /* The handle already held is worth trying first: a reset that
       re-enumerates into the same slot often leaves it perfectly usable. */
    if (await cycle(port)) return port;

    /* Otherwise the device came back as a different port object. Only ports
       already granted are considered — requestPort() needs a user gesture and
       there is nobody to ask in the middle of a reset. */
    for (const other of (await portsLike?.(port)) ?? []) {
      if (other === port) continue;
      if (await cycle(other)) return other;
    }

    await sleep(pollMs);
  }
  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
