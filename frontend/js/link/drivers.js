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
       simulated                   whether anything real is behind it
   ========================================================================== */

import {
  BoardPort, portsLike, serialBlockedReason, serialSupported,
} from './serial.js';

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
      board = new SimBoard(scene);
      return board.attach(handlers);
    },

    /* A simulated board never leaves the bus on its own, so it is always
       "still listed" — which is the answer that distinguishes a port held open
       from one that vanished. */
    async portsLike() { return [{ simulated: true }]; },
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
