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

       { name, version, chip, total_bytes,
         parts: [ { path, offset, size, sha256 } ] }

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

export async function fetchManifest(base = '/firmware/') {
  let res;
  try {
    res = await fetch(new URL('manifest.json', new URL(base, location.origin)),
                      { cache: 'no-store' });
  } catch (err) {
    const e = new Error(`could not reach the server: ${err.message}`);
    e.code = 'no_server';
    throw e;
  }

  if (!res.ok) {
    /* The code comes from the status, not from the response body. A plain file
       server answers a missing manifest with an HTML 404 and no JSON at all,
       and reading the body to identify the failure is how a missing image once
       got reported as an interrupted write. */
    const e = new Error(`no firmware image published (HTTP ${res.status})`);
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
export async function fetchImages(manifest, base = '/firmware/') {
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
 * Wait for a board to reappear after a reset.
 *
 * On hardware with native USB the reset takes the whole USB device off the bus
 * and it returns a second or two later, possibly as a different port object.
 *
 * Deliberately NOT by opening ports to see whether they answer. Opening
 * asserts DTR and RTS, which on this hardware are wired to reset and boot
 * select — so a probe loop resets the board it is waiting for, repeatedly, and
 * can hold it in that state indefinitely. Presence is established by matching
 * USB identifiers, which costs the board nothing, and the port is opened once
 * at the end.
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
