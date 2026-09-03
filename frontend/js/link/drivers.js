/* ============================================================================
   drivers.js — the seam between the flow and whatever is carrying it.
   ----------------------------------------------------------------------------
   The bring-up flow is written against this shape and nothing else, so the same
   state machine drives a cable and a simulated board. A simulator reached
   through a different path would prove nothing about the path that matters.

       requestPort()               a port to talk to
       openPort(port, handlers)    a link, per the contract in protocol.js
       portsLike(port)             ports already granted that look like this one
       blockedReason()             why none of the above is possible, or null
       fetchManifest()             what firmware is published
       fetchImages(manifest)       the images, verified against their hashes
       flash(port, images, opts)   write them
       waitForBoard(port, opts)    the board, after a write reset it
       simulated                   whether anything real is behind it
   ========================================================================== */

import {
  BoardPort, portsLike, serialBlockedReason, serialSupported,
} from './serial.js';
import {
  fetchManifest, fetchImages, flashBoard, reopenAfterReset,
} from './flash.js';

export const webSerialDriver = {
  simulated: false,

  blockedReason: () => serialBlockedReason(),

  requestPort: () => {
    if (!serialSupported()) throw new Error('Web Serial is not available here');
    return navigator.serial.requestPort();
  },

  async openPort(port, handlers) {
    const link = new BoardPort(port, handlers);
    await link.start(115200);
    return link;
  },

  portsLike,
  fetchManifest,
  fetchImages,
  flash: (port, images, opts) => flashBoard(port, images, opts),
  /* The post-write path, which probes by opening. flash.js has a second
     function that finds a board without touching it; that one is for a board
     already running, and using it here is what left the chip sitting in its
     downloader after every write. */
  waitForBoard: (port, opts) => reopenAfterReset(port, { ...opts, portsLike }),
};

/**
 * A driver backed by the simulated board.
 *
 * The fake port is opaque: nothing between here and the flow inspects it, so
 * it only has to be a token that comes back unchanged. Everything meaningful
 * happens through the link, which is the same object the real driver returns.
 */
export function simulatedDriver(scene = '') {
  let board = null;
  let boot = 0;
  let runningSha = '5111111111111111';
  let publishedSha = '8222222222222222';

  return {
    simulated: true,
    scene,

    blockedReason: () => null,

    /* Latency, because a port picker is not instant and a flow that is
       instantaneous here reads as fake everywhere it is not. */
    async requestPort() {
      await sleep(350);
      return { simulated: true };
    },

    async openPort(_port, handlers) {
      const { SimBoard } = await import('./sim.js');
      board?.detach();
      boot++;
      board = new SimBoard(scene, {
        sha: runningSha,
        bootId: `sim${String(boot).padStart(5, '0')}`,
      });
      return board.attach(handlers);
    },

    /* A simulated board never leaves the bus on its own, so it is always
       "still listed" — which is the answer that distinguishes a port held open
       from one that vanished. */
    async portsLike() { return [{ simulated: true }]; },

    /* ---- writing, simulated ---------------------------------------------
       Not a shortcut past the flash path but a way through it: the same two
       phases, the same progress reporting, the same reset and reacquire. Only
       the bytes are not real, so the flow can be exercised — and demonstrated
       — with no toolchain and no board. */

    async fetchManifest() {
      await sleep(180);
      return {
        project: 'Simulated firmware',
        version: '0.14.0-sim',
        elf_sha8: publishedSha,
        chip: 'esp32s3',
        total_bytes: 1064 * 1024,
        parts: [
          { path: 'bootloader.bin', offset: 0x0, size: 21 * 1024, sha256: 'f'.repeat(64) },
          { path: 'partitions.bin', offset: 0x8000, size: 3 * 1024, sha256: 'f'.repeat(64) },
          { path: 'firmware.bin', offset: 0x20000, size: 1040 * 1024, sha256: 'f'.repeat(64) },
        ],
      };
    },

    async fetchImages(manifest) {
      await sleep(320);
      return manifest.parts.map(p => ({
        data: new Uint8Array(p.size), address: p.offset, name: p.path,
      }));
    },

    async flash(_port, images, opts = {}) {
      const total = images.reduce((n, f) => n + f.data.length, 0);
      opts.onLog?.('Connecting...');
      await sleep(400);
      opts.onChip?.('ESP32-S3 (simulated)');
      opts.onLog?.('Chip is ESP32-S3 (simulated)');

      /* Reported at a plausible rate rather than jumping to done, because a
         progress bar is the one honest measurement in this flow and a fake
         one that finishes instantly teaches nobody anything. */
      let written = 0;
      while (written < total) {
        written = Math.min(total, written + 96 * 1024);
        opts.onProgress?.(written, total);
        await sleep(120);
      }
      opts.onLog?.('Hash of data verified.');
      opts.onLog?.('Hard resetting via RTS pin...');

      /* The board really does go away and come back. */
      board?.detach();
      board = null;
      runningSha = publishedSha;
      await sleep(600);
      return { chip: 'ESP32-S3 (simulated)' };
    },

    async waitForBoard(port, opts = {}) {
      const deadline = Date.now() + 2200;
      for (let n = 1; Date.now() < deadline; n++) {
        opts.onWait?.(n, Math.max(0, deadline - Date.now()));
        await sleep(400);
      }
      return port;
    },
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
