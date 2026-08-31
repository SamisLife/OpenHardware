/* ============================================================================
   webmcp.js — the page as a toolbelt.
   ----------------------------------------------------------------------------
   The reasoning lives in the browser's agent. This page is the instrument the
   human watches and, through document.modelContext, the set of tools the
   agent reaches for — and both see the same board at the same moment, because
   every tool below runs inside this tab against the same state, feed and link
   the panels are drawn from.

   Nothing here decides anything. A tool reads the model or asks the board for
   something and reports what came back. Which configuration to try next is
   the agent's problem, exactly as it is the local search's problem when
   nobody is calling.

   ----------------------------------------------------------------------------
   THREE RULES

   Write tools exist only while a board is linked. They are registered when
   the link comes up and unregistered when it goes, so an agent cannot be
   offered set_camera_config for a board that is not there. Read tools are
   always registered; reading nothing is a valid answer.

   Every result says where it came from. `source` is sim or usb and `link` is
   the state of the cable, on every reply, because the amber-versus-cyan
   honesty the badge keeps for the human has to reach the model too. A summary
   of simulated telemetry is not a measurement, and the reply says so.

   Approve and Hold are never tools. flash_image and provision_wifi ask
   through the same gate the build loop uses, and wait for a person. An agent
   that could approve its own gate has no gate.

   ----------------------------------------------------------------------------
   PRESENCE IS INFERRED

   The standard has no event for "an agent is here". The first call is the
   first evidence there is one, the running tool is what it is doing, and
   silence for long enough is it having gone quiet. All three are drawn beside
   the source badge, and none of them changes its colour.
   ========================================================================== */

import {
  state, subscribe, waitForState,
  applyPeripherals, applyWorkOrder, upsertAttempt, pushLimit, applyAgent, applyGate,
} from './state.js';
import { LADDER, fbBytes, label } from './builder/plan.js';
import { requestGate } from './builder/gate.js';

/** The telemetry contract, as the fields a summary is computed over. */
const FIELDS = [
  'uptimeS', 'tempC', 'heapFree', 'psramFree', 'psramLargestBlock', 'rssi', 'cpuMhz', 'fps',
];

/** How long after the last call an agent is considered to have gone quiet. */
const QUIET_MS = 30000;

/** How long to give a freshly switched-on camera to produce a first frame. */
const FIRST_FRAME_MS = 2500;

/* ------------------------------------------------------------------------ */
/* reading                                                                   */
/* ------------------------------------------------------------------------ */

/**
 * Telemetry over a window, as numbers rather than samples.
 *
 * Count, min, max, mean and slope per field. Never the samples themselves: a
 * window of raw rows is a pile the agent has to do arithmetic on, and the
 * arithmetic is where a model is least trustworthy. The count is the honesty
 * term — a window that caught three samples is distinguishable from one that
 * caught forty, and one that caught none reports null rather than zero.
 *
 * Slope is a least-squares fit in units per second, so "the die is climbing
 * 0.4 °C every second" can be read off directly rather than guessed from two
 * endpoints that may both be noise.
 */
export function summarize(buffer, { windowMs = 10000, now = Date.now() } = {}) {
  const from = now - windowMs;
  const rows = buffer.filter(s => s.t >= from);
  const gaps = rows.filter(s => s.gap).length;
  const samples = rows.filter(s => !s.gap);

  const fields = {};
  for (const f of FIELDS) {
    const pts = samples.map(s => [s.t, s[f]]).filter(([, v]) => Number.isFinite(v));
    if (!pts.length) { fields[f] = null; continue; }

    const vs = pts.map(([, v]) => v);
    const n = vs.length;
    const mean = vs.reduce((a, b) => a + b, 0) / n;

    let slope = null;
    if (n >= 2) {
      const t0 = pts[0][0];
      const xs = pts.map(([t]) => (t - t0) / 1000);
      const xm = xs.reduce((a, b) => a + b, 0) / n;
      const num = xs.reduce((acc, x, i) => acc + (x - xm) * (vs[i] - mean), 0);
      const den = xs.reduce((acc, x) => acc + (x - xm) ** 2, 0);
      slope = den > 0 ? num / den : 0;
    }

    fields[f] = {
      n,
      min: Math.min(...vs),
      max: Math.max(...vs),
      mean: round(mean, 3),
      slopePerS: slope === null ? null : round(slope, 4),
    };
  }

  return { windowMs, from, to: now, samples: samples.length, gaps, fields };
}

function round(v, d) { const k = 10 ** d; return Math.round(v * k) / k; }

/** The frame size the board is actually running, from the last frame it sent. */
function runningSize() {
  const f = state.frame;
  if (!(f?.width > 0 && f?.height > 0)) return null;
  const s = LADDER.find(x => x.w === f.width && x.h === f.height);
  return { name: s?.name || `${f.width}×${f.height}`, w: f.width, h: f.height };
}

/* ------------------------------------------------------------------------ */
/* effectors, shared with the build loop                                     */
/* ------------------------------------------------------------------------ */

/**
 * Apply a camera configuration and wait for the board to confirm it.
 *
 * Built here rather than in main.js so the build loop and the tools use one
 * implementation, and so a test can hand it the simulated board's send. The
 * confirmation is what the board reported back, read out of the peripherals
 * slice — not the request echoed — so a config the board refused, or never
 * received, cannot come back looking applied.
 */
export function configEffector(send) {
  return async function setConfig({ size, quality }, { signal, timeoutMs = 4000 } = {}) {
    const sent = await send({ t: 'cfg', size, quality });
    if (!sent) return { applied: false, error: 'the link would not accept the write' };

    const before = state.peripherals.cfgError;
    const ok = await waitForState(
      s => (s.peripherals.config?.size === size && s.peripherals.config?.quality === quality)
        || (s.peripherals.cfgError && s.peripherals.cfgError !== before),
      { timeoutMs, signal },
    ).catch(err => { if (err?.name === 'AbortError') throw err; return false; });

    const c = state.peripherals.config;
    if (c?.size === size && c?.quality === quality) return { applied: true, size, quality };
    return {
      applied: false, size, quality,
      error: state.peripherals.cfgError || (ok ? 'the board answered something else' : `no acknowledgement within ${timeoutMs} ms`),
    };
  };
}

/* ------------------------------------------------------------------------ */
/* the tools                                                                 */
/* ------------------------------------------------------------------------ */

const linked = () => state.device.link === 'linked';

/** Every reply carries these, so the model knows what it is looking at. */
function envelope(fx, result) {
  return { ...result, source: fx.source?.() ?? state.ui.source ?? null, link: state.device.link };
}

const notLinked = () => ({ ok: false, error: 'no board is linked' });

function abortError() {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(() => { signal?.removeEventListener?.('abort', on); resolve(); }, ms);
    const on = () => { clearTimeout(t); reject(abortError()); };
    signal?.addEventListener?.('abort', on);
  });
}

function nextAttemptNumber() {
  return state.attempts.reduce((m, a) => Math.max(m, a.n), 0) + 1;
}

/**
 * A work order to record under, opening one if there is none.
 *
 * An agent that starts experimenting without submitting a goal still leaves a
 * history, and it lands in the same list the local loop writes to — one log,
 * whoever is driving. The banner says who.
 */
function ensureWorkOrder() {
  const wo = state.workOrder;
  if (wo && wo.status === 'running') return wo;
  applyWorkOrder({
    id: wo?.id || `wo_${Math.random().toString(16).slice(2, 8)}`,
    goal: wo?.goal || 'Driven by an agent through WebMCP tools',
    constraints: wo?.constraints || [],
    status: 'running',
    createdAt: wo?.createdAt || Date.now(),
    by: 'agent',
    rehearsal: 'An agent in the browser is driving this board through WebMCP tools. '
             + 'Measurements come from the board; nothing is compiled or flashed unless '
             + 'a gate is approved.',
  });
  return state.workOrder;
}

function readTools(fx) {
  return [
    {
      name: 'get_board',
      description:
        'Identity and capabilities of the board this page is attached to: board name, MCU, '
        + 'MAC, firmware version and slot, link state, which source is driving the page '
        + '(sim or usb), what is attached (camera state and sensor, I2C addresses), whether '
        + 'the board supports runtime camera configuration (cfg), and the frame-size ladder '
        + 'with the PSRAM each size costs. Call this first; every other tool assumes it.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      execute: async () => {
        const d = state.device;
        const p = state.peripherals;
        const lim = state.telemetry.limits;
        return {
          ok: true,
          device: {
            id: d.id, board: d.board, mcu: d.mcu, mac: d.mac, ip: d.ip, ssid: d.ssid,
            firmware: { ...d.firmware },
          },
          reporting: !!state.telemetry.latest,
          peripherals: {
            known: p.known, camera: p.camera, i2c: p.i2c, streaming: p.streaming,
            cfgSupported: !!p.cfg, config: p.config,
          },
          limits: { ...lim },
          ladder: LADDER.map(s => ({
            name: s.name, w: s.w, h: s.h, framebufferBytes: fbBytes(s, 2),
          })),
        };
      },
    },

    {
      name: 'get_telemetry_summary',
      description:
        'Telemetry over the last windowMs, summarised: per field the sample count, min, max, '
        + 'mean and slope in units per second. Fields: uptimeS, tempC (die °C), heapFree and '
        + 'psramFree (bytes), psramLargestBlock (largest CONTIGUOUS free PSRAM, bytes — the '
        + 'number that decides whether a framebuffer fits), rssi (dBm, absent with no radio), '
        + 'cpuMhz, fps (measured frame rate, only while the camera streams). A field is null '
        + 'when nothing was measured. `gaps` counts breaks in the record inside the window. '
        + 'Raw samples are never returned.',
      inputSchema: {
        type: 'object',
        properties: {
          windowMs: { type: 'integer', minimum: 250, maximum: 120000, default: 10000,
                      description: 'How far back to look. The page keeps about 120 s.' },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      execute: async input => {
        const windowMs = clamp(Number(input?.windowMs) || 10000, 250, 120000);
        return { ok: true, ...summarize(state.telemetry.buffer, { windowMs }) };
      },
    },

    {
      name: 'get_learned_limits',
      description:
        'Procedural memory: board-specific limits established so far, each with its key, '
        + 'value, who recorded it (the local loop, from an attempt, or an agent via '
        + 'record_limit) and whether a human committed it. These narrow the search on this '
        + 'hardware; read them before proposing configurations that were already ruled out.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      execute: async () => ({ ok: true, limits: learnedLimits() }),
    },

    {
      name: 'capture_frame',
      description:
        'Capture one frame from the camera. The frame is decoded and shown in the camera '
        + 'panel for the human; this returns its dimensions, JPEG quality, byte count and '
        + 'sequence number, not the pixels. Turns the camera on if it is off and back off '
        + 'afterwards. Fails if no board is linked or it has no camera.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      execute: async (_input, { signal } = {}) => {
        if (!linked()) return notLinked();
        if (state.peripherals.camera?.state !== 'ok') {
          return { ok: false, error: `no camera on this board (${state.peripherals.camera?.state || 'unknown'})` };
        }
        const seq0 = state.frame.seq;
        const wasStreaming = state.peripherals.streaming;
        if (!wasStreaming) await fx.setCamera(true);
        try {
          const got = await waitForState(s => s.frame.seq > seq0, { timeoutMs: 8000, signal });
          if (!got) return { ok: false, error: 'no frame arrived within 8 s' };
          const f = state.frame;
          return {
            ok: true, seq: f.seq, width: f.width, height: f.height,
            jpegQuality: f.jpegQuality, bytes: f.bytes, size: runningSize()?.name ?? null,
          };
        } finally {
          if (!wasStreaming) await fx.setCamera(false).catch(() => {});
        }
      },
    },

    {
      name: 'get_images',
      description:
        'Firmware images this page can write to the board: what the server has published '
        + '(version, project, ELF hash, parts with offsets and sizes) and what has already been '
        + 'recorded as built or applied in this session. Writing one requires flash_image and '
        + 'a human approval.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      execute: async () => {
        let published = null;
        let error = null;
        try {
          const m = await fx.manifest();
          published = m && {
            version: m.version, project: m.project, elfSha8: m.elf_sha8, totalBytes: m.total_bytes,
            parts: (m.parts || []).map(p => ({ path: p.path, offset: p.offset, size: p.size })),
          };
        } catch (err) {
          error = err.message;
        }
        return {
          ok: !error, error, published,
          history: state.firmware.map(f => ({
            version: f.version, sha: f.sha, bytes: f.bytes, slot: f.slot,
            outcome: f.outcome, note: f.note,
          })),
        };
      },
    },

    {
      name: 'get_work_order',
      description:
        'The current work order (goal, parsed constraints, status, who opened it) and every '
        + 'attempt recorded under it, newest last: steps with pass/fail/skipped status and '
        + 'whether each was simulated, the four-field reasoning block, the gate state, and '
        + 'any limit the attempt learned. This is the same log the human sees.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      execute: async () => ({
        ok: true,
        workOrder: state.workOrder,
        attempts: state.attempts.map(a => ({
          n: a.n, status: a.status, by: a.by || 'loop', verdict: a.verdict || null,
          firmware: a.firmware || null, durationMs: a.durationMs ?? null,
          steps: (a.steps || []).map(s => ({
            id: s.id, label: s.label, status: s.status, sim: !!s.sim, detail: s.detail, ms: s.ms ?? null,
          })),
          reasoning: a.reasoning || {},
          gate: a.gate ? { state: a.gate.state, action: a.gate.action, approvedBy: a.gate.approvedBy || null } : null,
          learned: a.learned || null,
        })),
      }),
    },
  ];
}

function writeTools(fx) {
  return [
    {
      name: 'set_camera',
      description:
        'Start or stop the camera streaming frames over the cable. Frames cost bandwidth on a '
        + 'link shared with telemetry, so leave it off when not measuring. fps in telemetry is '
        + 'only measured while streaming.',
      inputSchema: {
        type: 'object', required: ['on'],
        properties: { on: { type: 'boolean' } },
        additionalProperties: false,
      },
      execute: async input => {
        if (!linked()) return notLinked();
        const on = !!input?.on;
        const seq0 = state.peripherals.streaming;
        await fx.setCamera(on);
        const ack = await waitForState(s => s.peripherals.streaming === on, { timeoutMs: 3000 }).catch(() => false);
        return { ok: ack, streaming: state.peripherals.streaming, was: seq0,
                 error: ack ? null : 'the board did not confirm' };
      },
    },

    {
      name: 'set_camera_config',
      description:
        'Change the camera frame size and JPEG quality at runtime, without a rebuild or '
        + 'reflash. Only works on a board whose get_board reports cfgSupported; otherwise it '
        + 'fails and the board keeps running what it has. `size` is a ladder name (QQVGA, '
        + 'QVGA, CIF, HVGA, VGA, SVGA, XGA, HD, SXGA, UXGA). quality is 10–63, lower is '
        + 'better. The reply is what the board confirmed, not what was asked.',
      inputSchema: {
        type: 'object', required: ['size'],
        properties: {
          size: { type: 'string', enum: LADDER.map(s => s.name) },
          quality: { type: 'integer', minimum: 10, maximum: 63, default: 12 },
        },
        additionalProperties: false,
      },
      execute: async (input, { signal } = {}) => {
        if (!linked()) return notLinked();
        const size = sizeNamed(input?.size);
        if (!size) return { ok: false, error: `unknown frame size; the ladder is ${LADDER.map(s => s.name).join(', ')}` };
        if (!state.peripherals.cfg) {
          return { ok: false, applied: false, error: 'this board does not support runtime camera configuration',
                   running: state.peripherals.config };
        }
        const quality = clamp(int(input?.quality, 12), 10, 63);
        const r = await fx.setConfig({ size: size.name, quality }, { signal });
        return { ok: r.applied, ...r, running: state.peripherals.config };
      },
    },

    {
      name: 'run_experiment',
      description:
        'One closed measurement: apply a camera config, let the board run it for soakMs, '
        + 'summarise the telemetry over that window, and record the whole thing as an attempt '
        + 'in the build log the human sees. Returns the numbers: fps, die temperature, largest '
        + 'contiguous PSRAM block and heap, each with count/min/max/mean/slope, plus '
        + '`applied` — whether the board actually ran the requested config. On a board without '
        + 'cfg support the config is NOT applied and the numbers describe whatever it was '
        + 'already running; `measuredSize` says which. Honors cancellation.',
      inputSchema: {
        type: 'object', required: ['size'],
        properties: {
          size: { type: 'string', enum: LADDER.map(s => s.name) },
          quality: { type: 'integer', minimum: 10, maximum: 63, default: 12 },
          soakMs: { type: 'integer', minimum: 500, maximum: 60000, default: 4000,
                    description: 'How long to watch after applying. Longer windows catch thermal drift.' },
        },
        additionalProperties: false,
      },
      execute: (input, ctx) => runExperiment(fx, input, ctx),
    },

    {
      name: 'watch_for',
      description:
        'Block until a condition on live telemetry or the link becomes true, or timeoutMs '
        + 'expires. Either `field`/`op`/`value` (field is a telemetry field name, op is one of '
        + '>, >=, <, <=, ==) or `link` (linked, lost, rebooting, offline). Returns whether it '
        + 'matched, why it stopped, how long it waited and the value seen. Use it instead of '
        + 'polling get_telemetry_summary. Honors cancellation.',
      inputSchema: {
        type: 'object',
        properties: {
          field: { type: 'string', enum: FIELDS },
          op: { type: 'string', enum: ['>', '>=', '<', '<=', '=='] },
          value: { type: 'number' },
          link: { type: 'string', enum: ['linked', 'lost', 'rebooting', 'offline'] },
          timeoutMs: { type: 'integer', minimum: 100, maximum: 300000, default: 30000 },
        },
        additionalProperties: false,
      },
      execute: async (input, { signal } = {}) => {
        const timeoutMs = clamp(int(input?.timeoutMs, 30000), 100, 300000);
        const pred = predicate(input);
        if (!pred) return { ok: false, error: 'give either field/op/value or link' };

        const t0 = Date.now();
        try {
          const matched = await waitForState(pred, { timeoutMs, signal });
          return { ok: true, matched, reason: matched ? 'matched' : 'timeout',
                   waitedMs: Date.now() - t0, value: seen(input) };
        } catch (err) {
          if (err?.name !== 'AbortError') throw err;
          return { ok: true, matched: false, reason: 'aborted', waitedMs: Date.now() - t0, value: seen(input) };
        }
      },
    },

    {
      name: 'record_limit',
      description:
        'Write a learned limit into the board\'s procedural memory, where the human reads it '
        + 'alongside what the local loop learned. Use a stable dotted key such as '
        + '"camera.max_size_at_10fps" and a value a person can act on, and say in `note` which '
        + 'measurement established it. Recorded limits are marked as recorded by an agent and '
        + 'as session-only until a human commits them.',
      inputSchema: {
        type: 'object', required: ['key', 'value'],
        properties: {
          key: { type: 'string', minLength: 1, maxLength: 80 },
          value: { type: 'string', minLength: 1, maxLength: 200 },
          note: { type: 'string', maxLength: 300 },
        },
        additionalProperties: false,
      },
      execute: async input => {
        const key = String(input?.key || '').trim();
        const value = String(input?.value || '').trim();
        if (!key || !value) return { ok: false, error: 'key and value are required' };
        pushLimit({ key, value, note: String(input?.note || '').trim() || null, source: 'agent', committed: false, at: Date.now() });
        return { ok: true, limits: learnedLimits() };
      },
    },

    {
      name: 'flash_image',
      description:
        'Write the published firmware image to the board. This ASKS A HUMAN FIRST: the call '
        + 'blocks until the operator presses Approve on the page, and returns refused if they '
        + 'press Hold or do not answer before you cancel. Nothing touches the board until '
        + 'approval. The board resets afterwards and the link is re-established by the page. '
        + 'eraseAll wipes stored credentials and counters too.',
      inputSchema: {
        type: 'object',
        properties: { eraseAll: { type: 'boolean', default: false } },
        additionalProperties: false,
      },
      execute: async (input, { signal } = {}) => {
        if (!linked()) return notLinked();
        return gated(fx, {
          action: `Write the published firmware image to the board${input?.eraseAll ? ', erasing it first' : ''}`,
          rationale: 'An agent asked to reflash the board. Writing replaces what is running and, '
                   + 'with erase, everything the board has stored. It does not happen without you.',
          signal,
        }, async () => {
          await fx.flash({ eraseAll: !!input?.eraseAll });
          return { ok: true, written: true, note: 'the board is resetting; the link will return on its own' };
        });
      },
    },

    {
      name: 'provision_wifi',
      description:
        'Store Wi-Fi credentials on the board and have it join. ASKS A HUMAN FIRST — blocks '
        + 'until Approve, refused on Hold. The radio is 2.4 GHz only. The reply is what the '
        + 'board read back from its own storage, never the passphrase. Telemetry over the cable '
        + 'is unaffected either way.',
      inputSchema: {
        type: 'object', required: ['ssid'],
        properties: {
          ssid: { type: 'string', minLength: 1, maxLength: 32 },
          psk: { type: 'string', maxLength: 64, default: '' },
        },
        additionalProperties: false,
      },
      execute: async (input, { signal } = {}) => {
        if (!linked()) return notLinked();
        const ssid = String(input?.ssid || '').trim();
        if (!ssid) return { ok: false, error: 'ssid is required' };
        return gated(fx, {
          action: `Store credentials for "${ssid}" on the board and join it`,
          rationale: 'An agent asked to put this board on a network. Credentials outlive the '
                   + 'session and the board will try to join on every boot. It does not happen '
                   + 'without you.',
          signal,
        }, async () => {
          await fx.provision(ssid, String(input?.psk || ''));
          return { ok: true, network: state.device.ssid, ip: state.device.ip };
        });
      },
    },

    {
      name: 'submit_work_order',
      description:
        'Hand a goal in plain language to the page\'s own build loop and let it run. The loop '
        + 'searches configurations against the board and records attempts in the same log as '
        + 'run_experiment; watch it with get_work_order. The goal must contain something '
        + 'checkable — a frame-rate floor, a temperature ceiling, a memory reserve, or '
        + 'something to maximise — or it is refused. Refused if a run is already in progress.',
      inputSchema: {
        type: 'object', required: ['goal'],
        properties: { goal: { type: 'string', minLength: 4, maxLength: 400 } },
        additionalProperties: false,
      },
      execute: async input => {
        if (!linked()) return notLinked();
        if (state.workOrder?.status === 'running') {
          return { ok: false, error: 'a work order is already running; abandon it on the page first' };
        }
        const goal = String(input?.goal || '').trim();
        const r = fx.submitWorkOrder(goal);
        if (r && r.ok === false) return r;
        return { ok: true, workOrder: state.workOrder };
      },
    },
  ];
}

/* ------------------------------------------------------------------------ */

async function runExperiment(fx, input, { signal } = {}) {
  if (!linked()) return notLinked();
  const size = sizeNamed(input?.size);
  if (!size) return { ok: false, error: `unknown frame size; the ladder is ${LADDER.map(s => s.name).join(', ')}` };
  if (state.peripherals.camera?.state !== 'ok') {
    return { ok: false, error: `no camera on this board (${state.peripherals.camera?.state || 'unknown'})` };
  }

  const quality = clamp(int(input?.quality, 12), 10, 63);
  const soakMs = clamp(int(input?.soakMs, 4000), 500, 60000);

  ensureWorkOrder();
  const n = nextAttemptNumber();
  const startedAt = Date.now();
  upsertAttempt({ n, status: 'running', startedAt, by: 'agent', steps: [], reasoning: {} });
  const step = (id, lbl, detail, status, extra = {}) =>
    upsertAttempt({ n, steps: [{ id, label: lbl, detail, status, ...extra }] });

  let applied = false;
  let applyError = null;

  try {
    /* ---- APPLY: real when the board can, said plainly when it cannot ---- */
    if (state.peripherals.cfg) {
      const t0 = Date.now();
      step('apply', 'APPLY', `cfg ${label(size)} q${quality}`, 'running');
      const r = await fx.setConfig({ size: size.name, quality }, { signal });
      applied = !!r.applied;
      applyError = r.error || null;
      step('apply', 'APPLY',
        applied ? `board confirmed ${label(size)} q${quality}` : `refused — ${applyError}`,
        applied ? 'pass' : 'fail', { ms: Date.now() - t0 });
      if (!applied) {
        upsertAttempt({ n, status: 'failed', verdict: 'CONFIG REFUSED', durationMs: Date.now() - startedAt,
          reasoning: { observed: `The board refused ${label(size)} q${quality}: ${applyError}.`,
                       result: 'Nothing was measured. The board is still running what it had.' } });
        return { ok: false, applied: false, error: applyError, attempt: n, running: state.peripherals.config };
      }
    } else {
      step('apply', 'APPLY',
        'this board does not support runtime camera config — measuring what it is already running',
        'skipped', { sim: true });
    }

    /* ---- MEASURE: always real ---------------------------------------- */
    const wasStreaming = state.peripherals.streaming;
    if (!wasStreaming) {
      await fx.setCamera(true);
      const seq0 = state.frame.seq;
      /* A first frame proves the pipeline is producing; its absence is
         reported by the numbers rather than by failing here. */
      await waitForState(s => s.frame.seq > seq0, { timeoutMs: FIRST_FRAME_MS, signal }).catch(err => {
        if (err?.name === 'AbortError') throw err;
      });
    }

    const t1 = Date.now();
    step('measure', 'MEASURE', `soaking ${(soakMs / 1000).toFixed(1)} s and watching the die`, 'running');
    await sleep(soakMs, signal);
    const sum = summarize(state.telemetry.buffer, { windowMs: Date.now() - t1 });
    const running = runningSize();
    const fps = sum.fields.fps;
    const temp = sum.fields.tempC;

    const line = [
      fps ? `${fps.mean.toFixed(1)} fps` : 'no frame rate',
      running ? `at ${label(running)}` : 'frame size unknown',
      temp ? `${temp.max.toFixed(1)} °C peak` : null,
      `${sum.samples} samples`,
    ].filter(Boolean).join(' · ');
    step('measure', 'MEASURE', line, sum.samples ? 'pass' : 'fail', { ms: Date.now() - t1 });

    const measuredSize = running?.name ?? null;
    const mismatch = applied && measuredSize && measuredSize !== size.name;

    upsertAttempt({
      n, status: 'passed', verdict: 'MEASURED', durationMs: Date.now() - startedAt,
      reasoning: {
        observed: line + (sum.gaps ? ` · ${sum.gaps} gap${sum.gaps === 1 ? '' : 's'} in the window` : ''),
        change: applied
          ? `frame_size FRAMESIZE_${size.name} (${size.w}×${size.h}), jpeg_quality ${quality}, applied at runtime.`
          : `Requested ${label(size)} q${quality}; not applied — no cfg support on this board.`,
        result: mismatch
          ? `Frames arrived at ${measuredSize}, not ${size.name}; the numbers describe ${measuredSize}.`
          : applied ? 'Measured on the requested configuration.' : `Measured on the running configuration${measuredSize ? ` (${measuredSize})` : ''}.`,
      },
    });

    return {
      ok: true, attempt: n, applied, applyError,
      requested: { size: size.name, w: size.w, h: size.h, quality },
      measuredSize, soakMs,
      samples: sum.samples, gaps: sum.gaps,
      fps, tempC: temp, psramLargestBlock: sum.fields.psramLargestBlock,
      heapFree: sum.fields.heapFree,
      streaming: state.peripherals.streaming,
    };
  } catch (err) {
    if (err?.name !== 'AbortError') throw err;
    upsertAttempt({
      n, status: 'abandoned', verdict: 'CANCELLED', durationMs: Date.now() - startedAt,
      steps: [{ id: 'measure', label: 'MEASURE', detail: 'cancelled by the agent', status: 'fail' }],
      reasoning: { result: 'Cancelled before the window closed. Anything applied is still applied.' },
    });
    return { ok: false, aborted: true, applied, attempt: n };
  }
}

/**
 * Ask the human, then do it — or report that they said no.
 *
 * The gate's state is mirrored into the model so the panel draws it with the
 * same block the loop's gate uses. Held and cancelled both end here without
 * touching the board: a tool's gate guards a write that cannot be undone.
 */
async function gated(fx, { action, rationale, signal }, run) {
  const policy = 'waits for the operator — nothing happens until Approve';
  let verdict;
  try {
    verdict = await requestGate({
      action, rationale, policy, timeoutMs: null, signal,
      onState: st => applyGate(st === 'pending'
        ? { state: 'pending', action, rationale, policy, requestedBy: 'agent', requestedAt: Date.now() }
        : { state: st, action, rationale, policy, requestedBy: 'agent', answeredAt: Date.now() }),
    });
  } catch (err) {
    return { ok: false, refused: 'busy', error: err.message };
  }

  if (verdict !== 'operator') {
    applyGate(null);
    return { ok: false, refused: verdict,
             error: verdict === 'held' ? 'the operator held it' : verdict === 'cancelled' ? 'cancelled before an answer' : 'not approved' };
  }

  try {
    const r = await run();
    return { ...r, approvedBy: 'operator' };
  } catch (err) {
    return { ok: false, approvedBy: 'operator', error: err.message };
  } finally {
    applyGate(null);
  }
}

function learnedLimits() {
  const out = [];
  for (const a of state.attempts) {
    if (a.learned) {
      out.push({ ...a.learned, by: a.by === 'agent' ? 'agent' : 'loop', from: `attempt ${a.n}`,
                 committed: !!a.gate && a.gate.state === 'approved' });
    }
  }
  for (const m of state.memory) {
    out.push({ key: m.key, value: m.value, note: m.note || null, by: m.source || 'agent',
               from: 'record_limit', committed: !!m.committed });
  }
  return out;
}

/* ---- small helpers ----------------------------------------------------- */

const sizeNamed = name => LADDER.find(s => s.name === String(name || '').toUpperCase()) || null;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const int = (v, d) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : d);

const OPS = {
  '>': (a, b) => a > b, '>=': (a, b) => a >= b,
  '<': (a, b) => a < b, '<=': (a, b) => a <= b, '==': (a, b) => a === b,
};

function predicate(input) {
  if (input?.link) return s => s.device.link === input.link;
  const f = input?.field;
  const op = OPS[input?.op];
  const v = Number(input?.value);
  if (!FIELDS.includes(f) || !op || !Number.isFinite(v)) return null;
  return s => {
    const x = s.telemetry.latest?.[f];
    return Number.isFinite(x) && op(x, v);
  };
}

function seen(input) {
  if (input?.link) return state.device.link;
  const x = state.telemetry.latest?.[input?.field];
  return Number.isFinite(x) ? x : null;
}

/* ------------------------------------------------------------------------ */
/* mounting                                                                  */
/* ------------------------------------------------------------------------ */

/**
 * Register the toolbelt, and keep it honest about what is attached.
 *
 * @param {object} opts
 *   fx            effectors: setCamera, setConfig, flash, provision,
 *                 submitWorkOrder, manifest, source
 *   modelContext  the registry; defaults to document.modelContext
 *   quietMs       how long since the last call counts as gone quiet
 * @returns {{ available, dispose, names }}
 */
export function mountTools({ fx = {}, modelContext, quietMs = QUIET_MS } = {}) {
  const mc = modelContext ?? globalThis.document?.modelContext ?? null;

  if (!mc || typeof mc.registerTool !== 'function') {
    /* The page works exactly as it does without an agent, and says once,
       quietly, that there is more to be had. */
    applyAgent({ available: false });
    return { available: false, names: () => [], dispose() {} };
  }
  applyAgent({ available: true });

  const registered = new Set();
  let quietTimer = 0;

  /* Presence, inferred from calls. Wrapped once here so no tool has to
     remember to report itself. */
  const wrap = tool => ({
    ...tool,
    execute: async (input, ctx = {}) => {
      clearTimeout(quietTimer);
      applyAgent({ seen: true, tool: tool.name, calls: (state.ui.agent.calls || 0) + 1,
                   lastAt: Date.now(), quiet: false });
      let result;
      try {
        result = await tool.execute(input ?? {}, ctx);
      } catch (err) {
        result = { ok: false, error: err?.message || String(err) };
      } finally {
        applyAgent({ tool: null, lastAt: Date.now() });
        quietTimer = setTimeout(() => applyAgent({ quiet: true }), quietMs);
      }
      return JSON.stringify(envelope(fx, result));
    },
  });

  const register = (tools, signal) => {
    for (const t of tools) {
      mc.registerTool(wrap(t), { signal });
      registered.add(t.name);
      signal.addEventListener('abort', () => registered.delete(t.name), { once: true });
    }
  };

  const readCtl = new AbortController();
  register(readTools(fx), readCtl.signal);

  /* Write tools follow the link. Registered on linked, withdrawn on anything
     else, so the agent is never offered a lever with nothing on the end. */
  let writeCtl = null;
  const sync = s => {
    const on = s.device.link === 'linked';
    if (on && !writeCtl) {
      writeCtl = new AbortController();
      register(writeTools(fx), writeCtl.signal);
    } else if (!on && writeCtl) {
      writeCtl.abort();
      writeCtl = null;
    }
  };
  sync(state);
  const unsubscribe = subscribe(sync);

  return {
    available: true,
    names: () => [...registered],
    dispose() {
      unsubscribe();
      clearTimeout(quietTimer);
      readCtl.abort();
      writeCtl?.abort();
      writeCtl = null;
    },
  };
}
