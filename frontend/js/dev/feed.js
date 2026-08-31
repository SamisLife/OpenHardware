/* ============================================================================
   dev/feed.js — a design harness, not a simulator.
   ----------------------------------------------------------------------------
   Loaded only with ?dev on the URL, and dynamically imported so it is never
   fetched otherwise. It exists so the panels can be designed against states
   that are otherwise awkward to reach: a board that is too hot, one with no
   camera, one that has just gone quiet.

   It is deliberately NOT the simulated board. That one speaks the wire protocol
   over a fake port and exercises the real transport, which is what makes it
   evidence. This writes straight into the model instead, which makes it useless
   as evidence and ideal for design work — a state can be pinned and held rather
   than waited for.

   Nothing here is reachable from the instrument. The badge reads DEV and stays
   amber, because a page driven by invented numbers must never be mistakable for
   one driven by a board.

       ?dev          a healthy board, warming slowly
       ?dev=hot      climbing past a declared ceiling
       ?dev=lost     reporting, then gone, leaving blank paper
       ?dev=nocam    a board with no camera attached
       ?dev=empty    nothing at all, to check the absent state holds
   ========================================================================== */

import {
  applyDevice, applyFrame, applyLimits, applyPeripherals, applyUi,
  pushTelemetry, pushGap, resetAll,
} from '../state.js';

const MB = 1024 * 1024;
const TICK_MS = 250;

export function startDevFeed(mode = '') {
  const scene = String(mode || 'live').toLowerCase();
  resetAll();

  applyUi({ source: 'dev', label: `design harness · ${scene}` });

  if (scene === 'empty') return { stop() {} };

  applyDevice({
    id: 'dev-board',
    board: 'Development harness',
    mcu: 'no silicon',
    mac: '00:00:00:00:00:00',
    link: 'linked',
    firmware: { version: 'dev', sha: '0000000', slot: 'none' },
  });

  /* Board constants are reported by a board. The harness reports them because
     it is standing in for one — the panels must not have to guess. */
  applyLimits({ heapTotal: 327680, psramTotal: 8 * MB, tempCritC: 85 });
  if (scene === 'hot') applyLimits({ tempC: 55 });

  const hasCamera = scene !== 'nocam';
  applyPeripherals({
    known: true,
    camera: hasCamera ? { state: 'ok', sensor: 'OV2640' } : { state: 'absent', sensor: null },
    i2c: hasCamera ? [0x3c, 0x76] : [0x68],
    streaming: false,
    cameraAsked: false,
  });

  const started = Date.now();
  let tempC = 34;
  let seq = 0;
  let gone = false;

  const timer = setInterval(() => {
    const now = Date.now();
    const age = (now - started) / 1000;

    /* A board that leaves, so the recorder has an outage to draw. */
    if (scene === 'lost' && !gone && age > 12) {
      gone = true;
      pushGap(now, 'PORT CLOSED');
      applyDevice({ link: 'lost' });
      applyUi({ label: 'design harness · board gone' });
      return;
    }
    if (gone) return;

    /* First-order thermal rise toward a target, which is what a die actually
       does — a linear ramp reads as fake on the chart. */
    const target = scene === 'hot' ? 72 : 44;
    tempC += (target - tempC) * 0.012 + (Math.random() - 0.5) * 0.08;

    pushTelemetry({
      t: now,
      uptimeS: age + 3600,
      tempC,
      heapFree: 190000 + Math.sin(age / 7) * 9000,
      heapTotal: 327680,
      psramFree: 6.1 * MB + Math.sin(age / 11) * 0.2 * MB,
      psramLargestBlock: 3.1 * MB,
      rssi: Math.round(-57 + Math.sin(age / 5) * 4),
      cpuMhz: 240,
      fps: hasCamera ? 8.3 + Math.sin(age / 3) * 0.6 : 0,
    });

    /* A frame every two seconds, so the age readout has something to count
       against. There is no image behind it: the panel draws its absent state
       and the metadata is what is being designed here. */
    if (hasCamera && Math.floor(age * 4) % 8 === 0) {
      applyFrame({
        kind: null, seq: ++seq, ts: now,
        width: 800, height: 600, jpegQuality: 12, bytes: 31000, url: null,
        verdict: 'Design harness — no image behind this frame.',
      });
    }
  }, TICK_MS);

  return { stop() { clearInterval(timer); } };
}
