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
   the agent's problem. The page records the measurements and keeps the human
   gate around the write; it does not pretend to synthesize a build locally.

   ----------------------------------------------------------------------------
   THREE RULES

   Tools that touch the board exist only while it is linked. They are
   registered when the link comes up and unregistered when it goes, so an
   agent cannot be offered set_camera_config for a board that is not there.
   Read tools and tools that touch only the page or loopback builder are always
   registered; reading nothing and compiling before a board arrives are valid.

   Every result says where it came from. `source` is sim or usb and `link` is
   the state of the cable, on every reply, because the amber-versus-cyan
   honesty the badge keeps for the human has to reach the model too. A summary
   of simulated telemetry is not a measurement, and the reply says so.

   Approve and Hold are never tools. flash_image and provision_wifi ask
   through the page's single gate and wait for a person. An agent
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
  applyPeripherals, applyFirmware, applyWorkOrder, upsertAttempt, pushLimit, applyAgent, applyGate, applyUi,
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

  const names = new Set(FIELDS);
  for (const sample of samples) {
    for (const key of Object.keys(sample)) if (key.startsWith('app.')) names.add(key);
  }

  const fields = {};
  for (const f of names) {
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
/* board effectors                                                           */
/* ------------------------------------------------------------------------ */

/**
 * Apply a camera configuration and wait for the board to confirm it.
 *
 * Built here rather than in main.js so every tool uses one implementation and
 * a test can hand it the simulated board's send. The
 * confirmation is what the board reported back, read out of the peripherals
 * slice — not the request echoed — so a config the board refused, or never
 * received, cannot come back looking applied.
 */
export function configEffector(send) {
  return async function setConfig({ size, quality }, { signal, timeoutMs = 4000 } = {}) {
    const wantsQuality = Number.isFinite(Number(quality));
    const request = { t: 'cfg', size, ...(wantsQuality ? { quality: Number(quality) } : {}) };
    const sent = await send(request);
    if (!sent) return { applied: false, error: 'the link would not accept the write' };

    const before = state.peripherals.cfgError;
    const ok = await waitForState(
      s => (s.peripherals.config?.size === size
            && (!wantsQuality || s.peripherals.config?.quality === Number(quality)))
        || (s.peripherals.cfgError && s.peripherals.cfgError !== before),
      { timeoutMs, signal },
    ).catch(err => { if (err?.name === 'AbortError') throw err; return false; });

    const c = state.peripherals.config;
    if (c?.size === size && (!wantsQuality || c?.quality === Number(quality))) {
      return { applied: true, size: c.size, quality: c.quality };
    }
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

/** Where bring-up stands, or null when the page has no session to ask. */
function guide(fx) {
  try { return fx.bringUp?.() ?? null; } catch { return null; }
}

/**
 * A refusal that says what to do about it.
 *
 * "No board is linked" is the whole truth and no help: the thing that links a
 * board is a person choosing a port, and a caller that cannot see the page
 * has no way to know that. The guide's next step rides along.
 */
function notLinked(fx) {
  const g = guide(fx);
  return { ok: false, error: 'no board is linked', phase: g?.phase ?? null, next: g?.next ?? null };
}

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
 * history, and it lands in the same list the human sees.
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
             + 'Measurements come from the board; compiling changes only local files, and '
             + 'nothing is flashed unless a gate is approved.',
  });
  return state.workOrder;
}

function readTools(fx) {
  return [
    {
      name: 'get_board',
      title: 'Board identity, capabilities and the frame-size ladder',
      description:
        'Identity and capabilities of the board this page is attached to: board name, MCU, '
        + 'MAC, firmware version and slot, inbound byte count, link state, which source is driving the page '
        + '(sim or usb), what is attached (camera state and sensor, the wiring list), whether '
        + 'the board supports runtime camera configuration (cfg), and the frame-size ladder '
        + 'with the PSRAM each size costs. Call this first; every other tool assumes it. '
        + 'While link is not "linked", bringUp says which step the page is waiting on and what '
        + 'a person must do; get_bring_up has the whole flow.',
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
            harness: { ...d.firmware },
            firmware: { ...d.firmware },
            app: d.app, appState: d.appState, appLoops: d.appLoops,
            rxBytes: d.rxBytes,
            activeBuild: state.firmware.find(row =>
              String(row.sha || '').toLowerCase() === String(d.firmware.sha || '').toLowerCase())?.buildId || null,
            bootId: d.bootId, reset: d.reset, reboots: d.reboots,
            ota: d.ota ?? null, aborted: d.aborted ?? null,
          },
          reporting: !!state.telemetry.latest,
          peripherals: {
            known: p.known, camera: p.camera, streaming: p.streaming,
            cfgSupported: !!p.cfg, config: p.config,
            running: p.config
              ? { ...p.config, from: 'caps' }
              : runningSize() ? { ...runningSize(), quality: state.frame.jpegQuality || null, from: 'frame' } : null,
          },
          limits: { ...lim },
          wiring: wiringView(),
          /* Only while there is something to do about it. A linked board has
             no bring-up left to describe. */
          bringUp: linked() ? null : orient(guide(fx)),
          ladder: LADDER.map(s => ({
            name: s.name, w: s.w, h: s.h, framebufferBytes: fbBytes(s, 2),
          })),
        };
      },
    },

    {
      name: 'get_bring_up',
      title: 'Where bring-up stands, and what only a person can do',
      description:
        'The flow this page runs before a board is linked, as data: the six rungs and their '
        + 'state, the decision the page is waiting on, the buttons that answer it with what each '
        + 'does and whether it needs a person, the current fault as observed/causes/next, and how '
        + 'to get a simulated board with no hardware. Call this when get_board reports link '
        + '"offline" or a tool answers "no board is linked". Only a person can choose a serial '
        + 'port; the other buttons write nothing.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      execute: async () => {
        const g = guide(fx);
        return g ? { ok: true, ...g } : { ok: false, error: 'this page has no bring-up session' };
      },
    },

    {
      name: 'get_app_source',
      title: 'Application API and the sources running now',
      description:
        'Read the application API header, mutable draft, and immutable minimal baseline from the local '
        + 'build daemon. Program only against `api`; `files` is the whole replaceable app that '
        + 'will be used as the next draft, while `baseline` is the recovery starting point. The fixed harness is not editable. Also reports whether the daemon is '
        + 'reachable or busy.'
        + ' Pass buildId to read the exact source one immutable build was compiled from, which is '
        + 'what to quote when asking a person to approve flashing it.',
      inputSchema: {
        type: 'object',
        properties: { buildId: { type: 'string', maxLength: 40 } },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      execute: async input => {
        if (!fx.build) return { ok: false, error: 'no build client is configured' };
        /* One build's stored source, on its own: the caller asked about that
           artefact, and returning the draft beside it invites quoting the
           wrong code to the person deciding. */
        const wanted = String(input?.buildId || '').trim();
        if (wanted) {
          const stored = await fx.build.source(wanted);
          if (!stored?.ok) return { ok: false, error: stored?.error || `no stored source for build ${wanted}` };
          const record = await fx.build.get(wanted);
          return {
            ok: true,
            buildId: wanted,
            files: stored.files,
            app: record?.ok ? record.app || null : null,
            note: record?.ok ? record.note || null : null,
          };
        }
        const [health, app, builds] = await Promise.all([fx.build.health(), fx.build.app(), fx.build.list()]);
        if (!health.ok || !app.ok) {
          return {
            ok: false,
            error: `no build daemon at ${fx.build.base}`,
            daemon: { reachable: false, busy: false },
          };
        }
        const runningSha = String(state.device.firmware.sha || '').toLowerCase();
        const activeBuild = builds.ok && Array.isArray(builds.builds)
          ? builds.builds.find(record => String(record.image?.elf_sha8 || '').toLowerCase() === runningSha)
          : null;
        const active = activeBuild ? await fx.build.source(activeBuild.id) : null;
        return {
          ok: true,
          api: app.api,
          files: app.files,
          baseline: app.baseline,
          active: active?.ok ? { buildId: activeBuild.id, files: active.files } : null,
          ladder: LADDER.map(({ name, w, h }) => ({ name, w, h })),
          daemon: { reachable: true, busy: !!health.busy },
        };
      },
    },

    {
      name: 'get_build',
      title: 'Compiler status, diagnostics and image metadata',
      description:
        'Read one local firmware build by id. Omit id to get the latest build. Returns status, '
        + 'the last 200 log lines, parsed compiler diagnostics, app identity and the packaged '
        + 'image metadata. Poll this after build_firmware returns status "building".',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', minLength: 1, maxLength: 40 } },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      execute: async input => {
        if (!fx.build) return { ok: false, error: 'no build client is configured' };
        const record = await fx.build.get(String(input?.id || '').trim() || null);
        const attempt = record?.id ? state.attempts.find(row => row.buildId === record.id) : null;
        if (attempt && record.status !== 'building') {
          const built = record.status === 'built';
          upsertAttempt({
            n: attempt.n, status: built ? 'built' : 'failed', verdict: built ? 'BUILT' : 'BUILD FAILED',
            steps: [{ id: 'compile', label: 'BUILD', status: built ? 'pass' : 'fail',
                      detail: built ? `immutable build ${record.id}` : record.diagnostics?.[0]?.message || 'build failed' }],
          });
          if (!state.firmware.some(row => row.buildId === record.id)) {
            applyFirmware([{
              buildId: record.id, version: record.image?.version || null,
              sha: record.image?.elf_sha8 || null, bytes: record.image?.total_bytes ?? null,
              builtAt: Date.parse(record.endedAt || '') || Date.now(), slot: null,
              outcome: built ? 'built' : 'failed',
              note: built
                ? `app ${record.app?.name || 'unknown'} ${record.app?.version || ''}`.trim()
                : record.diagnostics?.[0]?.message || 'build failed',
            }, ...state.firmware]);
          }
        }
        return record;
      },
    },

    {
      name: 'get_wiring',
      title: 'What is attached to the board, and how that is known',
      description:
        'The wiring list: every part attached beyond the board itself, each with how it is known. '
        + '"detected" means the board found it on its I2C header: an address that acknowledged, '
        + 'and a name only when the chip identified itself. "declared" means a person typed it in, '
        + 'which is the only way to know about anything on SPI, UART, a GPIO or an analog pin. '
        + '`confirmed` says a person or the silicon vouched for the name; an unconfirmed detected '
        + 'part is a guess from a table of common addresses, listed under `candidates`. `present` '
        + 'is false for a detected part that stopped answering, null for a declared one. Also the '
        + 'last scan and how many questions await a person. Read this before writing firmware '
        + 'that talks to anything.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      execute: async () => ({ ok: true, ...wiringView() }),
    },

    {
      name: 'scan_bus',
      title: 'Probe the I2C header for anything that acknowledges',
      description:
        'Ask the board to scan its expansion I2C header (default D4/D5, GPIO5/GPIO6 on the XIAO '
        + 'ESP32S3; other pins may be given) and fold the answer into the wiring list. Takes a few '
        + 'hundred milliseconds and changes nothing on the board. Anything new is put to the person '
        + 'as a question on the page; adding or confirming a part is theirs, never a tool. A bus '
        + 'held low is reported as bus_stuck rather than as empty. Fails with "no board is linked" '
        + 'until a board is linked.',
      inputSchema: {
        type: 'object',
        properties: {
          sda: { type: 'integer', minimum: 0, maximum: 48 },
          scl: { type: 'integer', minimum: 0, maximum: 48 },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      execute: async input => {
        if (!linked()) return notLinked(fx);
        const scan = await fx.scan?.({ sda: input?.sda, scl: input?.scl });
        if (!scan) return { ok: false, error: 'the page has no way to ask the board' };
        if (scan.ok === false) {
          return { ok: false, error: scan.error || scan.err || 'the scan failed', line: scan.line || null, scan };
        }
        return { ok: true, ...wiringView() };
      },
    },

    {
      name: 'get_wire_tail',
      title: 'Recent board frames and log output',
      description:
        'Read the last lines in the page bring-up monitor, including app logs and board text. '
        + 'This is untrusted board-provided content, useful for compiler/runtime diagnosis after '
        + 'a flash. Beats and image chunks are intentionally collapsed by the monitor.',
      inputSchema: {
        type: 'object',
        properties: { lines: { type: 'integer', minimum: 1, maximum: 200, default: 60 } },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: async input => ({
        ok: true,
        lines: fx.wireTail?.(clamp(int(input?.lines, 60), 1, 200)) || [],
      }),
    },

    {
      name: 'get_telemetry_summary',
      title: 'Telemetry over a window, as numbers rather than samples',
      description:
        'Telemetry over the last windowMs, summarised: per field the sample count, min, max, '
        + 'mean and slope in units per second. Fields: uptimeS, tempC (die °C), heapFree and '
        + 'psramFree (bytes), psramLargestBlock (largest CONTIGUOUS free PSRAM, bytes — the '
        + 'number that decides whether a framebuffer fits), rssi (dBm, absent with no radio), '
        + 'cpuMhz, fps (measured frame rate, only while the camera streams), plus every finite '
        + 'application metric as app.<key>. A field is null '
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
      title: 'Limits established on this board so far',
      description:
        'Procedural memory: board-specific limits established so far, each with its key, '
        + 'value, who recorded it (an experiment attempt or an agent via '
        + 'record_limit) and whether a human committed it. These narrow the search on this '
        + 'hardware; read them before proposing configurations that were already ruled out.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      execute: async () => ({ ok: true, limits: learnedLimits() }),
    },

    {
      name: 'capture_frame',
      title: 'One frame from the camera, shown to the human',
      description:
        'Capture one frame from the camera. The frame is decoded and shown in the camera '
        + 'panel for the human; this returns its dimensions, JPEG quality, byte count and '
        + 'sequence number, not the pixels. Turns the camera on if it is off and back off '
        + 'afterwards. Fails if no board is linked or it has no camera.'
        + ' Until a board is linked it fails with "no board is linked" and says what a person must press.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      execute: async (_input, { signal } = {}) => {
        if (!linked()) return notLinked(fx);
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
      title: 'Factory baseline and immutable candidate images',
      description:
        'Read the known-safe factory baseline and the immutable candidates built in this session. '
        + 'Candidates are selected by buildId and written only to inactive OTA slots. Writing any '
        + 'image requires a human approval.',
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
          ok: !error, error, baseline: published,
          history: state.firmware.map(f => ({
            buildId: f.buildId || null, version: f.version, sha: f.sha, bytes: f.bytes, slot: f.slot,
            outcome: f.outcome, note: f.note,
          })),
        };
      },
    },

    {
      name: 'get_work_order',
      title: 'The work order and every attempt under it',
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

/** Tools that mutate only the local page or loopback build daemon. */
function pageTools(fx) {
  return [
    {
      name: 'build_firmware',
      title: 'Compile a whole application beside the fixed harness',
      description:
        'Replace the complete application source set and compile it with the fixed harness on '
        + 'the local build daemon. Read get_app_source first and program only against its API. '
        + 'The daemon returns compiler diagnostics; fix them and build again. This does not touch '
        + 'the board. The default wait is 20 seconds; if status is "building", keep the id and '
        + 'poll get_build. Flash only with flash_image, which asks a human first.',
      inputSchema: {
        type: 'object', required: ['files'],
        properties: {
          files: {
            type: 'object',
            description: 'The whole app: file name to C/header source. Must include app.c. Multiple C files are supported; the daemon generates the component manifest.',
            additionalProperties: { type: 'string' },
          },
          note: { type: 'string', maxLength: 1000 },
          waitMs: { type: 'integer', minimum: 1000, maximum: 120000, default: 20000 },
        },
        additionalProperties: false,
      },
      execute: async (input, { signal } = {}) => {
        if (!fx.build) return { ok: false, error: 'no build client is configured' };
        const health = await fx.build.health();
        if (!health.ok) return { ok: false, error: `no build daemon at ${fx.build.base}` };

        const files = input?.files;
        const note = String(input?.note || '').trim();
        const started = await fx.build.start(files, note);
        if (!started.ok) return started;

        ensureWorkOrder();
        const attempt = nextAttemptNumber();
        upsertAttempt({
          n: attempt, by: 'agent', buildId: started.id, status: 'running',
          startedAt: Date.now(), firmware: null,
          steps: [{ id: 'compile', label: 'BUILD', status: 'running', detail: `build ${started.id}` }],
          reasoning: { change: note || 'Compiled a new application candidate.' },
        });

        const waitMs = clamp(int(input?.waitMs, 20000), 1000, 120000);
        const record = await fx.build.waitFor(started.id, { untilMs: waitMs, signal });
        if (!record.ok) {
          upsertAttempt({ n: attempt, status: 'failed', verdict: 'BUILD FAILED',
            steps: [{ id: 'compile', label: 'BUILD', status: 'fail', detail: record.error || 'build unavailable' }] });
          return { ...record, id: record.id || started.id, attempt };
        }
        if (record.status === 'building') {
          upsertAttempt({ n: attempt, steps: [{ id: 'compile', label: 'BUILD', status: 'running', detail: `build ${started.id} continues` }] });
          return { ok: true, status: 'building', id: started.id, attempt };
        }

        const firstDiagnostic = record.diagnostics?.[0];
        const identity = record.app || {};
        const outcome = record.status === 'built' ? 'built' : 'failed';
        const rowNote = outcome === 'built'
          ? [`app ${identity.name || 'unknown'} ${identity.version || ''}`.trim(), note].filter(Boolean).join(' · ')
          : firstDiagnostic?.message || 'the build failed; read get_build for its log';
        applyFirmware([{
          version: record.image?.version || null,
          sha: record.image?.elf_sha8 || null,
          bytes: record.image?.total_bytes ?? null,
          builtAt: Date.parse(record.endedAt || '') || Date.now(),
          slot: null,
          outcome,
          note: rowNote,
          buildId: record.id,
        }, ...state.firmware]);
        upsertAttempt({
          n: attempt,
          status: outcome === 'built' ? 'built' : 'failed',
          verdict: outcome === 'built' ? 'BUILT' : 'BUILD FAILED',
          firmware: outcome === 'built'
            ? `${record.image?.version || 'firmware'} / ${identity.name || 'app'} ${identity.version || ''}`.trim()
            : null,
          durationMs: Date.now() - state.attempts.find(row => row.n === attempt)?.startedAt,
          steps: [{ id: 'compile', label: 'BUILD', status: outcome === 'built' ? 'pass' : 'fail',
                    detail: outcome === 'built' ? `immutable build ${record.id}` : rowNote }],
        });
        return { ...record, ok: outcome === 'built', attempt };
      },
    },

    {
      name: 'record_attempt',
      title: 'Record the agent’s reasoning and observed result',
      description:
        'Append one experiment record to the build log the human sees. Supply observations, '
        + 'the hypothesis being tested, the concrete change and the result. verdict may be '
        + 'passed, failed or recorded. Pass the buildId returned by build_firmware to complete '
        + 'that build\'s existing live record instead of opening another attempt. This records '
        + 'evidence; it does not build or touch a board.',
      inputSchema: {
        type: 'object', required: ['observed', 'hypothesis', 'change', 'result'],
        properties: {
          observed: { type: 'string', maxLength: 2000 },
          hypothesis: { type: 'string', maxLength: 2000 },
          change: { type: 'string', maxLength: 2000 },
          result: { type: 'string', maxLength: 2000 },
          verdict: { type: 'string', enum: ['passed', 'failed', 'recorded'], default: 'recorded' },
          firmware: { type: 'string', maxLength: 80 },
          buildId: { type: 'string', maxLength: 40, description: 'Build to update instead of opening a separate attempt.' },
        },
        additionalProperties: false,
      },
      execute: async input => {
        ensureWorkOrder();
        const verdict = ['passed', 'failed'].includes(input?.verdict) ? input.verdict : 'recorded';
        const buildId = String(input?.buildId || '').trim();
        const existing = buildId ? state.attempts.find(row => row.buildId === buildId) : null;
        const n = existing?.n || nextAttemptNumber();
        upsertAttempt({
          n,
          buildId: buildId || existing?.buildId || null,
          by: 'agent',
          status: verdict,
          verdict: verdict.toUpperCase(),
          firmware: String(input?.firmware || '').trim() || null,
          startedAt: Date.now(),
          durationMs: 0,
          steps: [{ id: 'record', label: 'VERIFY', status: verdict === 'failed' ? 'fail' : 'pass' }],
          reasoning: {
            observed: String(input?.observed || '').trim(),
            hypothesis: String(input?.hypothesis || '').trim(),
            change: String(input?.change || '').trim(),
            result: String(input?.result || '').trim(),
          },
        });
        return { ok: true, attempt: n, status: verdict };
      },
    },
  ];
}

function writeTools(fx) {
  return [
    {
      name: 'set_camera',
      title: 'Start or stop the camera stream',
      description:
        'Start or stop the camera streaming frames over the cable. Frames cost bandwidth on a '
        + 'link shared with telemetry, so leave it off when not measuring. fps in telemetry is '
        + 'only measured while streaming.'
        + ' Fails with "no board is linked" until a board is linked; the next field of the reply, and get_bring_up, say what a person must do.',
      inputSchema: {
        type: 'object', required: ['on'],
        properties: { on: { type: 'boolean' } },
        additionalProperties: false,
      },
      execute: async input => {
        if (!linked()) return notLinked(fx);
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
      title: 'Frame size and JPEG quality, changed at runtime',
      description:
        'Change the camera frame size and JPEG quality at runtime, without a rebuild or '
        + 'reflash. Only works on a board whose get_board reports cfgSupported; otherwise it '
        + 'fails and the board keeps running what it has. `size` is a ladder name (QQVGA, '
        + 'QVGA, CIF, HVGA, VGA, SVGA, XGA, HD, SXGA, UXGA). quality is 10–63, lower is '
        + 'better. The reply is what the board confirmed, not what was asked.'
        + ' Fails with "no board is linked" until a board is linked; the next field of the reply, and get_bring_up, say what a person must do.',
      inputSchema: {
        type: 'object', required: ['size'],
        properties: {
          size: { type: 'string', enum: LADDER.map(s => s.name) },
          quality: { type: 'integer', minimum: 10, maximum: 63, default: 12 },
        },
        additionalProperties: false,
      },
      execute: async (input, { signal } = {}) => {
        if (!linked()) return notLinked(fx);
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
      title: 'Apply a config, soak, measure, record an attempt',
      description:
        'One closed measurement: apply a camera config, let the board run it for soakMs, '
        + 'summarise the telemetry over that window, and record the whole thing as an attempt '
        + 'in the build log the human sees. Returns the numbers: fps, die temperature, largest '
        + 'contiguous PSRAM block and heap, each with count/min/max/mean/slope, plus '
        + '`applied` — whether the board actually ran the requested config. On a board without '
        + 'cfg support the config is NOT applied and the numbers describe whatever it was '
        + 'already running; `measuredSize` says which. Honors cancellation.'
        + ' Fails with "no board is linked" until a board is linked; the next field of the reply, and get_bring_up, say what a person must do.',
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
      title: 'Block until telemetry or the link meets a condition',
      description:
        'Block until a condition on live telemetry or the link becomes true, or timeoutMs '
        + 'expires. Either `field`/`op`/`value` (field is a telemetry field name, op is one of '
        + '>, >=, <, <=, ==; application metrics are app.<key>) or `link` (linked, lost, '
        + 'rebooting, offline). Returns whether it '
        + 'matched, why it stopped, how long it waited and the value seen. Use it instead of '
        + 'polling get_telemetry_summary. Honors cancellation.',
      inputSchema: {
        type: 'object',
        properties: {
          field: { type: 'string', minLength: 1, maxLength: 40 },
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
      title: 'Write a learned limit into procedural memory',
      description:
        'Write a learned limit into the board\'s procedural memory, where the human reads it '
        + 'alongside what experiment attempts learned. Use a stable dotted key such as '
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
      title: 'Write one immutable candidate build; asks a human first',
      description:
        'Write a specific successful build to the board\'s inactive OTA slot. This ASKS A HUMAN FIRST: the call '
        + 'blocks until the operator presses Approve on the page, and returns refused if they '
        + 'press Hold or do not answer before you cancel. Nothing touches the board until '
        + 'approval. The immutable buildId prevents a newer build from replacing the approved image. '
        + 'The factory baseline is not overwritten.'
        + ' Before calling this, read the code you are asking to run: call get_app_source with this '
        + 'buildId, and tell the person in your message what the app does and anything about it they '
        + 'should look at. Say that they can read it themselves with Review source, on the approval '
        + 'prompt and in the Images list. Do not describe source you have not read.'
        + ' Fails with "no board is linked" until a board is linked; the next field of the reply, and get_bring_up, say what a person must do.',
      inputSchema: {
        type: 'object', required: ['buildId'],
        properties: { buildId: { type: 'string', minLength: 1, maxLength: 40 } },
        additionalProperties: false,
      },
      execute: (input, { signal } = {}) =>
        flashBuild(fx, String(input?.buildId || '').trim(), { signal, requestedBy: 'agent' }),
    },

    {
      name: 'restore_baseline',
      title: 'Restore the known-safe factory baseline; asks a human first',
      description:
        'Write the explicit minimal baseline image to factory and reboot into it. This is a recovery operation and ASKS A HUMAN FIRST. '
        + 'It does not promote a candidate or change baseline source. Stored data is retained.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: async (_input, { signal } = {}) => {
        if (!linked()) return notLinked(fx);
        if (state.ui.flashing) return { ok: false, refused: 'busy', error: 'a flash is already in progress' };
        const baseline = await fx.build?.baseline();
        if (!baseline?.ok) return { ok: false, error: baseline?.error || 'the baseline image has not been built yet' };
        applyUi({ flashing: { baseline: true } });
        try {
          return await gated(fx, {
            action: `Restore factory baseline ${baseline.version || ''} · ${baseline.app?.name || 'default'} ${baseline.app?.version || ''}`,
            rationale: 'This replaces the factory image with the committed minimal baseline and reboots the board. It does not erase stored data.',
            signal, requestedBy: 'agent',
          }, async () => {
            const result = await fx.flash({ baseline: true, imageBase: fx.build.baselineBase });
            const fault = result?.fault || null;
            return { ok: !!result?.flashDone && !fault, written: !!result?.flashDone, baseline: true,
                     phase: result?.phase || null, fault };
          });
        } finally {
          applyUi({ flashing: null });
        }
      },
    },

    {
      name: 'provision_wifi',
      title: 'Store Wi-Fi credentials; asks a human first',
      description:
        'Store Wi-Fi credentials on the board and have it join. ASKS A HUMAN FIRST — blocks '
        + 'until Approve, refused on Hold. The radio is 2.4 GHz only. The reply is what the '
        + 'board read back from its own storage, never the passphrase. Telemetry over the cable '
        + 'is unaffected either way.'
        + ' Fails with "no board is linked" until a board is linked; the next field of the reply, and get_bring_up, say what a person must do.',
      inputSchema: {
        type: 'object', required: ['ssid'],
        properties: {
          ssid: { type: 'string', minLength: 1, maxLength: 32 },
          psk: { type: 'string', maxLength: 64, default: '' },
        },
        additionalProperties: false,
      },
      execute: async (input, { signal } = {}) => {
        if (!linked()) return notLinked(fx);
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
  ];
}

/* ------------------------------------------------------------------------ */

async function runExperiment(fx, input, { signal } = {}) {
  if (!linked()) return notLinked(fx);
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
/**
 * Write one immutable candidate build to the inactive OTA slot, behind the gate.
 *
 * The one flash path, whoever asked: the flash_image tool calls this with
 * requestedBy 'agent', the Flash button on the Images panel with 'operator'.
 * Both go through the same gate (a person still presses Approve, even when a
 * person asked — the gate is where the decision is recorded, and a click on a
 * row is easy to make by accident), the same session flash, and both leave
 * their attempt in the same build log. An attempt is made for the build when
 * none exists yet, so a human flash is as visible afterwards as an agent's.
 *
 * @returns {{ok, written, buildId, phase, fault, refused?, error?}}
 */
export async function flashBuild(fx, buildId, { signal = null, requestedBy = 'agent' } = {}) {
  if (!linked()) return notLinked(fx);
  if (state.ui.flashing) return { ok: false, refused: 'busy', error: `a flash of ${state.ui.flashing.buildId || 'an image'} is already in progress` };
  const build = await fx.build?.get(buildId);
  if (!build?.ok || build.status !== 'built' || !build.image?.artifact) {
    return { ok: false, error: `build ${buildId || '(missing)'} is not a flashable successful build` };
  }
  if (build.image.activation_protocol !== 2) {
    return { ok: false, error: `build ${buildId} predates the self-confirming harness (protocol 2); rebuild its source against the current harness` };
  }
  const app = build.app || {};
  let attempt = state.attempts.find(row => row.buildId === buildId);
  if (!attempt) {
    ensureWorkOrder();
    upsertAttempt({
      n: nextAttemptNumber(), buildId, by: requestedBy, status: 'gated',
      verdict: 'AWAITING APPROVAL', firmware: app.name ? `${app.name} ${app.version || ''}`.trim() : null,
      startedAt: Date.now(), durationMs: 0,
      steps: [{ id: 'compile', label: 'BUILD', status: 'pass', detail: `immutable build ${buildId}` }],
    });
    attempt = state.attempts.find(row => row.buildId === buildId);
  }
  const step = (status, detail) => ({ id: 'flash', label: 'FLASH', status, detail });
  /* The image row's Outcome column follows the flash too, so the panel a
     person is looking at says the same thing the build log does. `active` is
     left to the confirming hello (feed.js), which is the only honest source
     for "the board is running exactly this". */
  const patchRow = (outcome, note) => applyFirmware(state.firmware.map(row =>
    row.buildId === buildId ? { ...row, outcome, ...(note !== undefined ? { note } : {}) } : row));
  upsertAttempt({ n: attempt.n, status: 'gated', steps: [step('running', 'waiting for operator approval')] });

  const who = requestedBy === 'operator' ? 'The operator' : 'An agent';
  /* Cleared as this one starts: the row is about to report on this attempt,
     and last time's verdict beside a running flash is the wrong answer to the
     question somebody is asking. */
  applyUi({ flashing: { buildId, written: null, total: null, stage: 'waiting' }, lastFlash: null });
  let outcome;
  try {
  outcome = await gated(fx, {
    action: `Write build ${buildId} · ${app.name || 'app'} ${app.version || ''} to the inactive OTA slot`,
    rationale: `${who} asked to activate one immutable candidate. The factory baseline and stored data remain untouched. `
             + 'Review source shows the exact code this image was compiled from.',
    signal, requestedBy, buildId,
  }, async () => {
    upsertAttempt({ n: attempt.n, status: 'running', steps: [step('running', 'writing inactive OTA slot')] });
    patchRow('flashing', null);
    applyUi({ flashing: { buildId, written: null, total: null, stage: 'starting' } });
    const result = await fx.flash({ buildId, imageBase: fx.build.artifactBase(buildId) });
    const fault = result?.fault || null;
    const reply = {
      ok: !!result?.flashDone && !fault,
      written: !!result?.flashDone,
      buildId,
      phase: result?.phase || null,
      fault,
    };
    const activated = reply.ok;
    const wroteOnly = reply.written && !!fault;
    upsertAttempt({
      n: attempt.n, status: activated ? 'passed' : 'failed',
      verdict: activated ? 'FLASHED' : wroteOnly ? 'ACTIVATION FAILED' : 'FLASH FAILED',
      durationMs: Date.now() - attempt.startedAt,
      steps: wroteOnly
        ? [
            step('pass', 'candidate bytes written to inactive OTA slot'),
            { id: 'activate', label: 'ACTIVATE', status: 'fail',
              detail: fault.raw || fault.observed || 'candidate was not activated' },
          ]
        : [step(activated ? 'pass' : 'fail',
                activated ? 'candidate booted and reported' : fault?.raw || fault?.observed || 'flash did not complete')],
    });
    if (activated) patchRow('active', null);
    else if (wroteOnly) patchRow(fault.code === 'rolled_back' ? 'rolled_back' : 'failed',
                                 fault.raw || fault.observed || 'candidate was not activated');
    else patchRow('failed', fault?.raw || fault?.observed || 'flash did not complete');
    /* Said on the row itself, in one word, because the tag column names the
       state of an image and not the outcome of the attempt somebody just
       made. The reason travels with it for the failures. */
    applyUi({ lastFlash: { buildId, ok: activated, reason: activated ? null
      : fault?.raw || fault?.observed || 'the flash did not complete' } });
    return reply;
  });
  } finally {
    applyUi({ flashing: null });
  }
  if (outcome?.refused) upsertAttempt({ n: attempt.n, status: 'built', verdict: 'BUILT',
    steps: [step('skipped', `operator ${outcome.refused}`)] });
  else if (!outcome?.ok && outcome?.error) {
    upsertAttempt({ n: attempt.n, status: 'failed', verdict: 'FLASH FAILED',
      steps: [step('fail', outcome?.error || 'flash did not complete')] });
    applyUi({ lastFlash: { buildId, ok: false, reason: outcome.error } });
  }
  return outcome;
}

async function gated(fx, { action, rationale, signal, requestedBy = 'agent', buildId = null }, run) {
  const policy = 'waits for the operator — nothing happens until Approve';
  let verdict;
  try {
    verdict = await requestGate({
      action, rationale, policy, timeoutMs: null, signal,
      /* buildId travels with the gate so the page can offer that build's
         stored source beside the button that writes it. */
      onState: st => applyGate(st === 'pending'
        ? { state: 'pending', action, rationale, policy, requestedBy, buildId, requestedAt: Date.now() }
        : { state: st, action, rationale, policy, requestedBy, buildId, answeredAt: Date.now() }),
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

/** The wiring list as the tools hand it over: parts, the last scan, the open questions. */
function wiringView() {
  const w = state.wiring;
  const s = w.scan;
  return {
    parts: w.parts.map(p => ({
      name: p.name, how: p.how, bus: p.bus, addr: p.addr ?? null, pins: p.pins || [],
      id: p.id || null, confirmed: !!p.confirmed, confirmedBy: p.confirmedBy || null,
      candidates: p.confirmed ? [] : (p.candidates || []),
      present: p.present ?? null, note: p.note || null,
    })),
    scan: s ? {
      at: s.at, ok: s.ok !== false, bus: s.bus || null, sda: s.sda ?? null, scl: s.scl ?? null,
      ms: s.ms ?? null, error: s.ok === false ? (s.err || null) : null, line: s.line || null,
      found: (s.found || []).map(f => ({ addr: f.addr, id: f.id || null })),
    } : null,
    asks: w.asks.length,
  };
}

/** The guide, cut to what get_board needs: the phase, the wait, the next step. */
function orient(g) {
  if (!g) return null;
  return { phase: g.phase, waitingOn: g.waitingOn, next: g.next };
}

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
  if (!validTelemetryField(f) || !op || !Number.isFinite(v)) return null;
  return s => {
    const x = s.telemetry.latest?.[f];
    return Number.isFinite(x) && op(x, v);
  };
}

function validTelemetryField(field) {
  if (FIELDS.includes(field)) return true;
  if (!/^app\.[a-z0-9_]{1,16}$/.test(field || '')) return false;
  return state.telemetry.buffer.some(sample => Number.isFinite(sample?.[field]));
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
 *                 manifest, build, wireTail, source
 *   modelContext  the registry; defaults to document.modelContext, then to
 *                 navigator.modelContext
 *   quietMs       how long since the last call counts as gone quiet
 * @returns {{ available, dispose, names }}
 */
export function mountTools({ fx = {}, modelContext, quietMs = QUIET_MS } = {}) {
  /* The standard hangs the registry on the document. It hung it on navigator
     first, and a browser still shipping it there has an agent in it all the
     same — this page would rather be found by that agent than be right about
     where to look. */
  const mc = modelContext
    ?? globalThis.document?.modelContext
    ?? globalThis.navigator?.modelContext
    ?? null;

  const reads = readTools(fx);
  const pages = pageTools(fx);
  const writes = writeTools(fx);
  const registered = new Set();

  /* What the panel draws: every tool the page offers, and whether each one is
     registered at this moment. Published on every change to the registry, and
     once even when there is no registry, so a person can see what an agent
     would get before opening the page somewhere one can. */
  const publish = () => applyAgent({
    tools: [...reads, ...pages, ...writes].map(t => ({
      name: t.name,
      title: t.title || t.name,
      readOnly: !!t.annotations?.readOnlyHint,
      registered: registered.has(t.name),
    })),
  });

  if (!mc || typeof mc.registerTool !== 'function') {
    /* The page works exactly as it does without an agent, and says once,
       quietly, that there is more to be had. */
    applyAgent({ available: false });
    publish();
    return { available: false, names: () => [], dispose() {} };
  }
  applyAgent({ available: true });

  let quietTimer = 0;
  /* Calls in flight. The quiet timer is armed only when the last of them
     ends: armed per call, the timer of a short call would outlive a long one
     started beside it and report the agent quiet while it was still working. */
  let inFlight = 0;

  /* Presence, inferred from calls. Wrapped once here so no tool has to
     remember to report itself.

     The result goes back as an object. The registry serialises it itself —
     executeTool hands the agent a JSON string made from whatever execute
     resolved with — so a string returned here would be serialised a second
     time, and the model would be reading escaped quotes. */
  const wrap = tool => ({
    ...tool,
    execute: async (input, ctx = {}) => {
      clearTimeout(quietTimer);
      inFlight++;
      applyAgent({ seen: true, tool: tool.name, calls: (state.ui.agent.calls || 0) + 1,
                   lastAt: Date.now(), quiet: false });
      let result;
      try {
        let args = input ?? {};
        if (typeof args === 'string') {
          try { args = JSON.parse(args); }
          catch { args = {}; }
        }
        result = await tool.execute(args, ctx);
      } catch (err) {
        result = { ok: false, error: err?.message || String(err) };
      } finally {
        inFlight--;
        applyAgent({ tool: inFlight ? state.ui.agent.tool : null, lastAt: Date.now() });
        if (!inFlight) {
          clearTimeout(quietTimer);
          quietTimer = setTimeout(() => applyAgent({ quiet: true }), quietMs);
        }
      }
      return envelope(fx, result);
    },
  });

  const register = (tools, signal) => {
    for (const t of tools) {
      mc.registerTool(wrap(t), { signal });
      registered.add(t.name);
      signal.addEventListener('abort', () => registered.delete(t.name), { once: true });
    }
    publish();
  };

  const readCtl = new AbortController();
  register([...reads, ...pages], readCtl.signal);

  /* Write tools follow the link. Registered on linked, withdrawn on anything
     else, so the agent is never offered a lever with nothing on the end. */
  let writeCtl = null;
  const sync = s => {
    const on = s.device.link === 'linked';
    if (on && !writeCtl) {
      writeCtl = new AbortController();
      register(writes, writeCtl.signal);
    } else if (!on && writeCtl) {
      writeCtl.abort();
      writeCtl = null;
      publish();
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
      publish();
    },
  };
}
