/* ============================================================================
   state.js — the whole model, and the only way into it.
   ----------------------------------------------------------------------------
   Everything that ever changes the screen goes through the apply* functions
   below. A board on a USB cable, a board reporting over the network, and a
   simulated board with no silicon behind it all write here, and nothing
   downstream can tell which one it is looking at.

   That interchangeability is the point rather than a convenience. It is what
   makes a rehearsed demo worth rehearsing: the thing being rehearsed is the
   thing that will be shown. It is also the seam — when this moves to Firestore,
   an onSnapshot listener calls these same functions and no renderer changes.

   Every field is shaped like the document it will eventually mirror:

     devices/{deviceId}                     -> applyDevice(doc)
     devices/{deviceId}/telemetry/{ts}      -> pushTelemetry(sample)
     devices/{deviceId}/frames/latest       -> applyFrame(doc)
     devices/{deviceId}/peripherals         -> applyPeripherals(doc)
     devices/{deviceId}/firmware/{version}  -> applyFirmware(docs)
     workOrders/{workOrderId}               -> applyWorkOrder(doc)
     workOrders/{workOrderId}/attempts/{n}  -> upsertAttempt(doc)

   Writes are patches rather than replacements, because Firestore snapshots
   arrive that way and because a partial update should not blank the fields it
   did not mention.

   ----------------------------------------------------------------------------
   THE TELEMETRY CONTRACT

   The fields below are what a board has to report for this instrument to be
   honest. They are decided here, before any firmware exists, and the harness is
   then built to satisfy them — rather than the instrument being shaped around
   whatever happened to be convenient to emit.

     t                    epoch ms, host arrival
     uptimeS              seconds since boot
     tempC                die temperature
     heapFree             free internal DRAM, bytes
     heapTotal            total internal DRAM, bytes    (see limits)
     psramFree            free PSRAM, bytes
     psramLargestBlock    largest CONTIGUOUS free PSRAM block, bytes
     rssi                 dBm, or absent when there is no association
     cpuMhz               current clock
     fps                  measured frame rate, not a configured one

   `psramLargestBlock` earns its place: it diverges badly from `psramFree` once
   a network stack has fragmented the heap, and the gap between them is the gap
   between "out of memory" and "out of contiguous memory" — two problems with
   completely different answers.

   Any field may be absent. Absent is not zero, and the renderers draw it as
   absence.
   ========================================================================== */

/** How many telemetry samples to retain. 480 @ 4 Hz = 120 s of chart. */
import { reconcile, keyFor } from './wiring.js';

export const BUFFER_LEN = 480;

/**
 * Bounds outside which a reading is not a reading.
 *
 * Firmware sometimes signals "no sensor" with a sentinel rather than by
 * omitting the field — an absolute-zero temperature being the usual one. A
 * sentinel that reaches the renderers is worse than a missing value, because
 * it draws as a confident measurement: a readout saying -273.0 °C with 343
 * degrees of headroom. Rejected here, once, at the only door into the model.
 */
const PLAUSIBLE = {
  tempC: [-40, 150],
  fps: [0, 1000],
  cpuMhz: [1, 10000],
  uptimeS: [0, Infinity],
  heapFree: [0, Infinity],
  heapTotal: [0, Infinity],
  psramFree: [0, Infinity],
  psramLargestBlock: [0, Infinity],
  rssi: [-120, 0],
};

export const state = {
  /* ---- devices/{id} ---------------------------------------------------- */
  device: {
    id: null,
    board: null,
    mcu: null,
    mac: null,
    ip: null,
    ssid: null,
    /** 'linked' | 'rebooting' | 'lost' | 'offline' */
    link: 'offline',
    /** epoch ms of the last heartbeat seen */
    lastSeen: 0,
    firmware: { version: null, sha: null, slot: null, builtAt: 0 },
    /** identity and health reported by the replaceable application layer */
    app: null,
    appState: null,
    appLoops: null,
    /** Total inbound bytes reported by the firmware in its latest hello. */
    rxBytes: null,
    bootId: null,
    reset: null,
    reboots: 0,
    /** 'factory' | 'pending' | 'valid' | 'aborted' | ... as the bootloader sees the running image */
    ota: null,
    /** an OTA slot the bootloader abandoned, or null */
    aborted: null,
  },

  /* ---- devices/{id}/telemetry ------------------------------------------ */
  telemetry: {
    /** rolling ring, oldest first. See pushTelemetry for the shape. */
    buffer: [],
    /** most recent sample, or null when the link is down */
    latest: null,

    /**
     * Ceilings and totals, every one of them null until something says
     * otherwise.
     *
     * Nothing here is guessed. A hardcoded 320 KB heap total is right for one
     * chip and wrong for the next, and wrong quietly — a headroom bar computed
     * against an invented denominator looks exactly like one computed against a
     * real one. `heapTotal` and `psramTotal` come from the board; `tempC` is
     * whatever ceiling a work order declared; `tempCritC` is the throttle point
     * for the part, which the board is in a position to know and this page is
     * not.
     */
    limits: {
      tempC: null,        // declared by a work order
      tempCritC: null,    // reported by the board
      heapTotal: null,    // reported by the board
      psramTotal: null,   // reported by the board
    },
  },

  /* ---- devices/{id}/frames/latest -------------------------------------- */
  frame: {
    /** 'jpeg' once a real capture arrives; null before that */
    kind: null,
    seq: 0,
    ts: 0,
    width: 0,
    height: 0,
    jpegQuality: 0,
    bytes: 0,
    /** an object URL for the decoded frame, when there is one */
    url: null,
    /** what a vision step concluded about it, once one has run */
    verdict: null,
  },

  /* ---- devices/{id}/peripherals ----------------------------------------
     Discovered, never assumed. Until a board says what is attached, nothing
     is claimed — most boards have no camera, and a permanently empty viewport
     is a worse lie than no viewport. */
  peripherals: {
    /** true once the board has reported; nothing is claimed before that */
    known: false,
    /** { state, sensor } — state is ok | absent | faulted | untried */
    camera: null,
    /** whether the board is currently capturing */
    streaming: false,
    /**
     * Whether the operator asked for the stream, as distinct from whether it
     * is running.
     *
     * A camera pulled off its connector and put back is a fresh driver with
     * streaming off, so `streaming` goes false through no decision of theirs.
     * Holding the intent separately is what lets the picture come back on its
     * own instead of asking the same question every time a ribbon moves.
     */
    streamWanted: false,
    /** whether the board accepts a runtime `cfg` command, per its caps */
    cfg: false,
    /** { size, quality } the board reports it is running, or null */
    config: null,
    /** what the board said the last time it refused a cfg, or null */
    cfgError: null,
  },

  /* ---- devices/{id}/wiring --------------------------------------------
     What is attached beyond the board, and how that is known. Detected parts
     come from the board's own scan of its I2C header; declared parts come
     from a person, because the board cannot see a strip of LEDs on a GPIO.
     See wiring.js for the shape of a part and for how a scan is folded in. */
  wiring: {
    /** the last scan the board answered, or null */
    scan: null,
    /** { key, how, bus, addr, pins, id, name, candidates, confirmed, confirmedBy, present, note, at } */
    parts: [],
    /** questions for a person: { kind: 'new' | 'missing', key } */
    asks: [],
    /** keys a person chose not to list; dropped from every scan */
    ignored: [],
    /** whether a scan is in flight */
    scanning: false,
  },

  /* ---- devices/{id}/memory/procedural ------------------------------------
     Limits recorded directly, by an agent through record_limit. The loop's
     own learnings live on the attempts that established them; both are read
     together, so there is one list and no second copy to drift. */
  /** { key, value, note, source, committed, at } */
  memory: [],

  /* ---- a gate an agent's tool is waiting on -----------------------------
     The loop's gate lives on the attempt that raised it. A tool's gate has no
     attempt, so it lives here, drawn with the same block and answered by the
     same buttons. Null when nothing is waiting. */
  gate: null,

  /* ---- devices/{id}/firmware -------------------------------------------- */
  /** newest first. { version, sha, builtAt, bytes, slot, outcome, note } */
  firmware: [],

  /* ---- workOrders/{id} -------------------------------------------------- */
  /** { id, goal, constraints[], status, createdAt, closedAt } or null */
  workOrder: null,

  /* ---- workOrders/{id}/attempts ----------------------------------------- */
  /** ascending by n. See upsertAttempt for the shape. */
  attempts: [],

  /* ---- page-local, never persisted --------------------------------------
     Which source is driving the model. Null until one is, because at startup
     nothing is — and "mock" defaulting to true would be the model asserting
     something about itself before any source had spoken. */
  ui: {
    /** null | 'usb' | 'server' | 'sim' | 'demo' */
    source: null,
    /** short status line: what the page would otherwise not be saying */
    label: '',
    /**
     * An agent, inferred from its calls. There is no presence event in the
     * standard, so the first call is the first evidence of one, `tool` is what
     * it is doing right now, and `quiet` is silence for long enough. `available`
     * is whether the browser offers document.modelContext at all — null until
     * the page has looked. `tools` is every tool the page offers and whether
     * each is registered at this moment, published by the toolbelt so the
     * panel can draw what an agent would find.
     */
    /**
     * Whether the person wants the picture on screen. The stream is a
     * separate question: it keeps running while the panel is hidden, so the
     * frame rate and the frame age stay measured for whoever is reading them.
     */
    cameraShown: true,
    /**
     * The flash in progress, or null. Set for the whole of one flash — from
     * the moment it is asked for, through the operator's approval, to the boot
     * verdict — so the Flash buttons and the tool refuse a second one while it
     * runs. `{ buildId }`, or `{ baseline: true }` for a baseline restore.
     */
    flashing: null,
    agent: { available: null, seen: false, tool: null, calls: 0, lastAt: 0, quiet: false, tools: [] },
  },
};

/* ------------------------------------------------------------------------ */
/* subscription                                                              */
/* ------------------------------------------------------------------------ */

const listeners = new Set();
/** Set of changed top-level keys, or null when nothing is scheduled. */
let pending = null;

/**
 * requestAnimationFrame in a browser, because coalescing to the paint is the
 * whole point. A timeout everywhere else, so the model can be exercised in a
 * test runner without a DOM standing in for one.
 */
const schedule = fn => (typeof requestAnimationFrame === 'function'
  ? requestAnimationFrame(fn)
  : setTimeout(fn, 0));

/**
 * @param {(state: object, changed: Set<string>) => void} fn
 * @returns {() => void} unsubscribe
 */
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Mark a slice dirty.
 *
 * Notifications coalesce into one frame, so a burst of writes in a single tick
 * — device, telemetry and frame all arriving together — causes exactly one
 * render pass rather than three.
 */
function touch(...keys) {
  if (!pending) {
    pending = new Set();
    schedule(flush);
  }
  for (const k of keys) pending.add(k);
}

function flush() {
  const changed = pending;
  pending = null;
  for (const fn of listeners) {
    /* One listener throwing must not stop the others from painting. */
    try { fn(state, changed); }
    catch (err) { console.error('[openhardware] render failed for', [...changed], err); }
  }
}

/** Force a full render. Used once at startup and on resize. */
export function renderAll() {
  touch('device', 'telemetry', 'frame', 'peripherals', 'firmware',
        'workOrder', 'attempts', 'memory', 'gate', 'ui', 'wiring');
}

/**
 * Resolve once the model satisfies `pred`, with false on timeout.
 *
 * The read-side counterpart of the apply* writers: a tool waiting for a frame
 * to arrive or a config to be confirmed waits on the model, not on the wire,
 * so it sees exactly what the panels see and nothing the panels do not.
 * Rejects with an AbortError when `signal` fires, because a caller that was
 * cancelled must not be handed a false that looks like a timeout.
 */
export function waitForState(pred, { timeoutMs = 10000, signal = null } = {}) {
  return new Promise((resolve, reject) => {
    let unsubscribe = null;
    let timer = 0;

    const done = (value, err) => {
      unsubscribe?.();
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      if (err) reject(err); else resolve(value);
    };
    const onAbort = () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      done(null, e);
    };

    if (signal?.aborted) return onAbort();
    let first = false;
    try { first = !!pred(state); } catch { first = false; }
    if (first) return resolve(true);

    signal?.addEventListener?.('abort', onAbort);
    unsubscribe = subscribe(s => {
      let hit = false;
      try { hit = !!pred(s); } catch { hit = false; }
      if (hit) done(true);
    });
    timer = setTimeout(() => done(false), timeoutMs);
  });
}

/** Flush any pending notification immediately. Tests and teardown only. */
export function flushNow() {
  if (pending) flush();
}

/* ------------------------------------------------------------------------ */
/* write path                                                                */
/* ------------------------------------------------------------------------ */

/**
 * devices/{id} — partial patch. Nested firmware merges rather than replaces.
 *
 * The previous firmware is captured BEFORE the assign, because the assign has
 * already overwritten it by the time the merge line runs — reading it after
 * spreads the incoming value over itself and the merge silently does nothing.
 * A source reporting only a new sha would blank the version and the slot.
 */
export function applyDevice(patch) {
  if (!patch) return;
  const prevFirmware = state.device.firmware;
  Object.assign(state.device, patch);
  if (patch.firmware) {
    state.device.firmware = { ...prevFirmware, ...patch.firmware };
  }
  touch('device');
}

/**
 * One telemetry sample. See the contract in the file header for the fields.
 *
 * Samples arrive in order and out-of-order ones are dropped rather than
 * sorted, because a chart that rewrites history is a lie. Implausible values
 * are nulled rather than dropped: the sample still happened, one of its
 * readings just is not a reading.
 */
export function pushTelemetry(sample) {
  if (!sample || !Number.isFinite(sample.t)) return;

  const buf = state.telemetry.buffer;
  const last = buf[buf.length - 1];
  if (last && sample.t <= last.t) return;

  const clean = { t: sample.t };
  for (const [key, value] of Object.entries(sample)) {
    if (key === 't') continue;
    clean[key] = plausible(key, value) ? value : null;
  }

  buf.push(clean);
  if (buf.length > BUFFER_LEN) buf.splice(0, buf.length - BUFFER_LEN);

  state.telemetry.latest = clean;
  state.device.lastSeen = clean.t;
  touch('telemetry', 'device');
}

function plausible(key, value) {
  if (!Number.isFinite(value)) return false;
  const range = PLAUSIBLE[key];
  if (!range) return true;
  return value >= range[0] && value <= range[1];
}

/**
 * Record a break in the record.
 *
 * The chart draws nothing across a gap rather than interpolating over it, so a
 * reboot leaves blank paper. This is the most honest thing the chart does and
 * it should not be smoothed. Consecutive gaps collapse into one — a link that
 * is down stays down, and it is one outage rather than many.
 *
 * @param {number} t      epoch ms
 * @param {string} label  short marker, e.g. 'PORT CLOSED'
 */
export function pushGap(t, label) {
  if (!Number.isFinite(t)) return;

  const buf = state.telemetry.buffer;
  const last = buf[buf.length - 1];
  if (last && last.gap) {
    if (!last.label && label) {
      last.label = label;
      touch('telemetry');
    } else if (label?.startsWith('REBOOT') && !last.label.includes(label)) {
      /* A native-USB reset closes the port before the next hello explains it.
         Keep the first observation and append the later reset evidence. */
      last.label = `${last.label} · ${label}`;
      touch('telemetry');
    }
    return;
  }

  buf.push({ t, gap: true, label: label || '' });
  if (buf.length > BUFFER_LEN) buf.splice(0, buf.length - BUFFER_LEN);

  /* Nothing is live across a gap. Holding the last sample here is what makes
     a readout show a stale number as though it were current. */
  state.telemetry.latest = null;
  touch('telemetry');
}

/** Board constants and declared ceilings. Patch; see telemetry.limits. */
export function applyLimits(patch) {
  Object.assign(state.telemetry.limits, patch);
  touch('telemetry');
}

/** devices/{id}/frames/latest — partial patch. */
export function applyFrame(patch) {
  Object.assign(state.frame, patch);
  touch('frame');
}

/** devices/{id}/peripherals — partial patch. */
export function applyPeripherals(patch) {
  Object.assign(state.peripherals, patch);
  touch('peripherals');
}

/** devices/{id}/firmware — the whole list, newest first. */
export function applyFirmware(list) {
  state.firmware = (list || []).map(f => ({ ...f }));
  touch('firmware');
}

/** workOrders/{id}. Pass null to clear. */
export function applyWorkOrder(doc) {
  state.workOrder = doc ? { ...(state.workOrder || {}), ...doc } : null;
  touch('workOrder');
}

/**
 * workOrders/{id}/attempts/{n} — insert or patch by `n`.
 *
 * Steps merge by `id` so a step can be updated in place as it runs, which is
 * what lets a build log show a step going from running to passed without the
 * writer having to resend the ones around it.
 */
export function upsertAttempt(patch) {
  if (!patch || !Number.isFinite(patch.n)) return;

  const i = state.attempts.findIndex(a => a.n === patch.n);
  if (i === -1) {
    state.attempts.push({ steps: [], reasoning: {}, ...patch });
    state.attempts.sort((a, b) => a.n - b.n);
  } else {
    const prev = state.attempts[i];
    const next = { ...prev, ...patch };
    if (patch.steps) next.steps = mergeSteps(prev.steps, patch.steps);
    if (patch.reasoning) next.reasoning = { ...prev.reasoning, ...patch.reasoning };
    state.attempts[i] = next;
  }
  touch('attempts');
}

function mergeSteps(prev, incoming) {
  const out = (prev || []).map(s => ({ ...s }));
  for (const step of incoming) {
    const j = out.findIndex(s => s.id === step.id);
    if (j === -1) out.push({ ...step });
    else out[j] = { ...out[j], ...step };
  }
  return out;
}

/* ---- devices/{id}/wiring ---------------------------------------------- */

function emptyWiring() {
  return { scan: null, parts: [], asks: [], ignored: [], scanning: false };
}

/**
 * A scan the board answered, folded into the list.
 *
 * Questions already open stay open while they still apply — a new part not
 * yet confirmed, a missing part not yet kept — and are dropped the moment the
 * list no longer has the thing they ask about. Nothing else in the model is
 * touched: a scan says what answered on one bus, and that is all it says.
 */
export function applyScan(result) {
  if (!result) return;
  const scan = { ...result, at: result.at || Date.now() };
  const { parts, asks } = reconcile(scan, state.wiring.parts, state.wiring.ignored);
  const still = state.wiring.asks.filter(a => {
    const p = parts.find(x => x.key === a.key);
    if (!p) return false;
    return a.kind === 'new' ? (!p.confirmed && p.present !== false) : p.present === false;
  });
  for (const a of asks) if (!still.some(s => s.key === a.key)) still.push(a);
  state.wiring = { ...state.wiring, scan, parts, asks: still, scanning: false };
  touch('wiring');
}

/** Page-side flags of the wiring slice: scanning, and nothing else yet. */
export function applyWiring(patch) {
  Object.assign(state.wiring, patch);
  touch('wiring');
}

function dropAsk(key) {
  state.wiring.asks = state.wiring.asks.filter(a => a.key !== key);
}

/** A person named a detected part. Their word outranks the table and the silicon. */
export function confirmPart(key, name) {
  const clean = String(name || '').trim();
  const p = state.wiring.parts.find(x => x.key === key);
  if (!p || !clean) return;
  Object.assign(p, { name: clean, confirmed: true, confirmedBy: 'person' });
  dropAsk(key);
  touch('wiring');
}

/** A person chose not to list an address. Remembered, so it is not asked again. */
export function ignorePart(key) {
  state.wiring.parts = state.wiring.parts.filter(x => x.key !== key);
  if (!state.wiring.ignored.includes(key)) state.wiring.ignored.push(key);
  dropAsk(key);
  touch('wiring');
}

/** A person kept a part the last scan did not find. It stays, marked absent. */
export function keepPart(key) {
  dropAsk(key);
  touch('wiring');
}

export function removePart(key) {
  state.wiring.parts = state.wiring.parts.filter(x => x.key !== key);
  dropAsk(key);
  touch('wiring');
}

/**
 * A part a person declared. `present` is null rather than true: the board
 * cannot see it, so nothing here claims it answered.
 */
export function addPart({ name, bus = 'other', addr = null, pins = [], note = null } = {}) {
  const clean = String(name || '').trim();
  if (!clean) return;
  const a = Number.isInteger(addr) ? addr : null;
  const key = keyFor(bus, a, clean);
  const part = {
    key, how: 'declared', bus, addr: a, pins: [...pins], id: null, name: clean,
    candidates: [], confirmed: true, confirmedBy: 'person', present: null,
    note: note || null, at: Date.now(), seenAt: 0,
  };
  const i = state.wiring.parts.findIndex(x => x.key === key);
  if (i >= 0) state.wiring.parts[i] = { ...state.wiring.parts[i], ...part };
  else state.wiring.parts.push(part);
  dropAsk(key);
  touch('wiring');
}

/**
 * What a previous visit knew about this board: the parts a person declared or
 * confirmed, and the addresses they ignored. Merged under what this visit has
 * already found, never over it.
 */
export function restoreWiring({ parts = [], ignored = [] } = {}) {
  const known = new Set(state.wiring.parts.map(p => p.key));
  for (const p of parts) {
    if (p && p.key && !known.has(p.key)) state.wiring.parts.push({ ...p, present: null });
  }
  for (const k of ignored) if (!state.wiring.ignored.includes(k)) state.wiring.ignored.push(k);
  touch('wiring');
}

/** Page-local flags. */
export function applyUi(patch) {
  Object.assign(state.ui, patch);
  touch('ui');
}

/** What the page has inferred about an agent. Merged, so a tool ending does
    not forget that one was ever seen. */
export function applyAgent(patch) {
  Object.assign(state.ui.agent, patch);
  touch('ui');
}

/** devices/{id}/memory/procedural — one more limit, recorded directly. */
export function pushLimit(fact) {
  if (!fact || !fact.key) return;
  state.memory.push({ ...fact });
  touch('memory');
}

/** The gate a tool is waiting on, or null to clear it. */
export function applyGate(doc) {
  state.gate = doc ? { ...doc } : null;
  touch('gate');
}

/* ------------------------------------------------------------------------ */
/* resets                                                                    */
/* ------------------------------------------------------------------------ */

/**
 * Forget the agent's output without touching the board.
 *
 * Abandoning a work order says nothing about the hardware: telemetry, the
 * frame, the chart and whatever is attached are all still true.
 */
export function resetAttempts() {
  state.attempts = [];
  touch('attempts');
}

/** Start over. Used when a source hands off to another one. */
export function resetAll() {
  state.telemetry.buffer.length = 0;
  state.telemetry.latest = null;
  state.telemetry.limits = {
    tempC: null, tempCritC: null, heapTotal: null, psramTotal: null,
  };
  state.frame = {
    kind: null, seq: 0, ts: 0, width: 0, height: 0,
    jpegQuality: 0, bytes: 0, url: null, verdict: null,
  };
  state.peripherals = {
    known: false, camera: null, streaming: false,
    /* The person's choice survives a change of source; it was never the
       board's to make. */
    streamWanted: state.peripherals.streamWanted, cfg: false, config: null, cfgError: null,
  };
  state.firmware = [];
  state.wiring = emptyWiring();
  state.workOrder = null;
  state.attempts = [];
  state.device.link = 'offline';
  state.device.lastSeen = 0;
  state.device.app = null;
  state.device.appState = null;
  state.device.appLoops = null;
  state.device.rxBytes = null;
  state.device.bootId = null;
  state.device.reset = null;
  state.device.reboots = 0;
  renderAll();
}
