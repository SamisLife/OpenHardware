/* ============================================================================
   session.js — bringing a board up, one rung at a time.
   ----------------------------------------------------------------------------
   Five rungs, in the order the hardware actually does them:

       CONNECT     a port, granted and open
       FLASH       fetch, verify, write — the one stage with honest progress
       BOOT        the board resets, leaves the bus, and comes back
       IDENTIFY    something on the other end that answers
       TELEMETRY   and keeps answering

   FLASH and BOOT are skipped for a board already running something that speaks
   the protocol, which is the ordinary case once a board has been set up once.
   Writing over a working board costs it whatever it was holding, so it is
   never what happens by default.

   If bring-up stops, it stops on a named rung with a named observation. That
   is the whole design: "setup failed" is not something anybody can act on, but
   "the port is listed and would not open" is.

   The transport is injected rather than imported, so the same state machine
   drives a real cable and a simulated board. A simulator that exercised a
   different path would prove nothing about this one.

   ----------------------------------------------------------------------------
   TWO PHASES AROUND THE WRITE

   Everything is fetched and verified before the chip is opened, and the two
   halves have separate failures on purpose. Until the chip has answered, "the
   write did not finish" is not a reachable outcome — so a missing image is
   able to say the board was not touched, and mean it.
   ========================================================================== */

import { fault } from './faults.js';

export const RUNGS = ['connect', 'flash', 'boot', 'identify', 'telemetry'];

const RUNG_TITLE = {
  connect: 'Connect',
  flash: 'Flash',
  boot: 'Boot',
  identify: 'Identify',
  telemetry: 'Telemetry',
};

/** How long to wait for a board to announce itself before giving up on it. */
const HELLO_MS = 4000;
/** And for the first telemetry after it has. */
const BEAT_MS = 6000;
/** Lines kept in the monitor. A board in a boot loop can produce thousands. */
const MONITOR_MAX = 600;

export class Session {
  /**
   * @param {object} driver   transport, real or simulated
   * @param {(state, monitor) => void} onUpdate
   */
  constructor(driver, onUpdate) {
    this.driver = driver;
    this.onUpdate = onUpdate;
    this.port = null;
    this.link = null;
    /** Every frame is copied here once telemetry has been handed over. */
    this.frameSink = null;
    this.monitor = [];
    this._helloWaiters = new Set();
    this._beatTimer = 0;
    this.reset();
  }

  reset() {
    this.state = {
      /** idle | working | fault | done */
      phase: 'idle',
      active: null,
      rungs: Object.fromEntries(RUNGS.map(r => [r, {
        id: r, title: RUNG_TITLE[r], state: 'idle', detail: '', since: 0,
      }])),
      hasPort: false,
      /** { written, total } while a write is running, else null. */
      progress: null,
      /** What the server published, once it has been asked for. */
      manifest: null,
      /** The last identity frame seen, or null. */
      hello: null,
      /** What was heard on the wire before anything identified itself. */
      heard: { lines: 0, first: null },
      fault: null,
      simulated: !!this.driver?.simulated,
      blocked: this.driver?.blockedReason?.() ?? null,
    };
    this.monitor = [];
    this.emit();
  }

  emit() { this.onUpdate?.(this.state, this.monitor); }

  /** True once dispose() has run. Cheap guard for anything long-running. */
  get disposed() { return this.onUpdate === null; }

  /* ---- the wire -------------------------------------------------------- */

  /**
   * Append a line to the monitor.
   *
   * Repeats collapse into a count. A board announces itself repeatedly while
   * waiting, and an uncollapsed monitor is mostly one word. Matching ignores
   * the log's own tick counter, so `W (36522) wifi:…` and `W (36774) wifi:…`
   * are recognised as the same message — comparing them literally meant the
   * collapse never fired on exactly the floods that need it.
   */
  log(text, kind = 'text') {
    const key = kind === 'text' ? String(text).replace(/\(\s*\d+\)/, '(#)') : text;
    const last = this.monitor[this.monitor.length - 1];

    if (last && last.key === key && last.kind === kind) {
      last.n = (last.n || 1) + 1;
      last.text = text;
      last.t = Date.now();
      this.emit();
      return;
    }

    this.monitor.push({ t: Date.now(), text, kind, n: 1, key });
    if (this.monitor.length > MONITOR_MAX) {
      this.monitor.splice(0, this.monitor.length - MONITOR_MAX);
    }
    this.emit();
  }

  rung(id, state, detail = '') {
    const r = this.state.rungs[id];
    if (!r) return;
    if (r.state !== state) r.since = Date.now();
    r.state = state;
    r.detail = detail;
    if (state === 'active') this.state.active = id;
    this.emit();
  }

  fail(id, code, raw) {
    this.state.fault = fault(code, raw);
    this.state.phase = 'fault';
    this.rung(id, 'fault', this.state.fault.observed);
    if (raw) this.log(String(raw), 'error');
    this.emit();
    return null;
  }

  /* ---- 1. CONNECT ------------------------------------------------------ */

  /**
   * Ask for a port and open it.
   *
   * @param {{reuse?: boolean}} opts  reuse a port already granted, so a retry
   *        does not make somebody pick the same board out of a dialog again
   */
  async connect({ reuse = false } = {}) {
    if (this.state.blocked) return this.fail('connect', 'blocked', this.state.blocked);

    this.state.fault = null;
    this.state.phase = 'working';
    this.rung('connect', 'active', 'waiting for a port to be chosen');

    if (!(this.port && reuse)) {
      try {
        this.port = await this.driver.requestPort();
      } catch (err) {
        /* Dismissing the picker is a decision, not a failure. Painting it red
           teaches people to distrust the red. */
        if (err.name === 'NotFoundError' || /no port selected/i.test(err.message)) {
          this.log('port picker dismissed', 'meta');
          this.rung('connect', 'idle', '');
          this.state.phase = 'idle';
          this.emit();
          return null;
        }
        return this.fail('connect', 'no_port', err.message);
      }
      if (!this.port) return this.fail('connect', 'no_port');
    }
    this.state.hasPort = true;

    this.rung('connect', 'active', 'opening');
    let opened = await this.openLink();

    /* One retry, and only for a port that would not open. A board with native
       USB leaves the bus whenever it resets, so a port can be listed and
       unopenable for a fraction of a second. */
    if (!opened) {
      await this.closeLink();
      await sleep(700);
      opened = await this.openLink();
    }

    if (!opened) {
      /* Which fault this is turns on one observable: is the device still
         listed? Held open, and it is. Resetting under this page, and it is
         not. Guessing between them sends someone to change a good cable. */
      const present = (await this.driver.portsLike?.(this.port))?.length > 0;
      return this.fail('connect', present ? 'no_open' : 'port_vanished',
                       this._openError);
    }

    this.rung('connect', 'done', 'port open');

    /* A board already speaking the protocol needs nothing written to it. */
    this.rung('flash', 'skipped', 'not written');
    this.rung('boot', 'skipped', '');
    return this.identify();
  }

  async openLink() {
    this._openError = null;
    try {
      this.link = await this.driver.openPort(this.port, {
        onFrame: frame => this.onFrame(frame),
        onText: (text, bad) => {
          this.state.heard.lines++;
          if (!this.state.heard.first) this.state.heard.first = String(text).slice(0, 70);
          this.log(text, bad ? 'bad' : 'text');
        },
        onClose: () => {
          this.log('the board closed the link', 'error');
          this._helloWaiters.forEach(fn => fn(null));
        },
      });
      return !!this.link?.open;
    } catch (err) {
      this._openError = err.message;
      this.log(`could not open the port: ${err.message}`, 'error');
      return false;
    }
  }

  /* ---- 2. FLASH -------------------------------------------------------- */

  /**
   * Write firmware, then wait for the board to come back.
   *
   * Never reached by default. Writing over a board that is already running
   * costs it whatever it was holding, so it is something asked for rather than
   * something that happens on the way past.
   */
  async flash({ eraseAll = false } = {}) {
    if (!this.port) return this.fail('connect', 'no_port');

    this.state.fault = null;
    this.state.phase = 'working';

    /* Everything downstream is about to happen again, so it is put back to
       waiting first. Without this a beat from the board being replaced arrives
       mid-write, completes the telemetry rung for firmware that is on its way
       out, and the board that comes back afterwards finds its own rung already
       marked done. The flow has to be re-entrant because a retry re-enters it. */
    clearTimeout(this._beatTimer);
    this.rung('identify', 'idle', '');
    this.rung('telemetry', 'idle', '');
    this.state.hello = null;

    /* ---- phase one: fetch. The board is not touched. ------------------- */
    this.rung('flash', 'active', 'fetching the image');
    let manifest, images;
    try {
      manifest = await this.driver.fetchManifest();
      this.state.manifest = manifest;
      images = await this.driver.fetchImages(manifest);
    } catch (err) {
      const code = err.code === 'no_server' ? 'no_manifest' : err.code || 'fetch_failed';
      return this.fail('flash', code, err.message);
    }

    const kb = (manifest.total_bytes || 0) / 1024;
    this.log(`${manifest.name || 'firmware'} ${manifest.version || ''} · `
           + `${manifest.parts.length} images · ${kb.toFixed(0)} KB · hashes verified`, 'meta');

    /* ---- phase two: write. From here the board is in play. ------------- */
    await this.closeLink();

    let chipAnswered = false;
    this.rung('flash', 'active', 'connecting to the chip');
    try {
      await this.driver.flash(this.port, images, {
        eraseAll,
        onLog: line => this.log(String(line).replace(/\s+$/, ''), 'esptool'),
        onChip: chip => {
          chipAnswered = true;
          this.log(`chip: ${chip}`, 'meta');
          this.rung('flash', 'active', String(chip));
        },
        onProgress: (written, total) => {
          this.state.progress = { written, total };
          this.rung('flash', 'active',
            `${(written / 1024).toFixed(0)} of ${(total / 1024).toFixed(0)} KB`);
        },
      });
    } catch (err) {
      this.state.progress = null;
      /* Whether the chip ever answered is the fact that decides the message,
         not a regex over the error text. */
      return this.fail('flash', chipAnswered ? 'flash_failed' : 'no_chip', err.message);
    }

    this.state.progress = null;
    this.rung('flash', 'done', `${manifest.version || 'image'} written`);
    return this.waitForBoot();
  }

  /**
   * The board has been reset by the flasher.
   *
   * On hardware with native USB the whole device leaves the bus and returns a
   * second or two later, possibly as a different port object. This is the most
   * fragile moment in the flow, so it gets an explicit patient recovery rather
   * than an assumption that the handle still works.
   */
  async waitForBoot() {
    this.rung('boot', 'active', 'board is resetting');

    const port = await this.driver.waitForBoard(this.port, {
      onWait: (_n, remaining) =>
        this.rung('boot', 'active', `waiting for the bus · ${Math.ceil(remaining / 1000)}s`),
    });
    if (!port) return this.fail('boot', 'no_reopen');

    this.port = port;
    this.rung('boot', 'active', 'back on the bus');
    if (!(await this.openLink())) return this.fail('boot', 'no_open', this._openError);

    this.rung('boot', 'done', 'running');
    return this.identify();
  }

  /* ---- 3. IDENTIFY ----------------------------------------------------- */

  /**
   * Wait for the board to say what it is.
   *
   * Asked for as well as waited on: a board that has been running a while
   * announces itself infrequently, and there is no reason to sit through that
   * when it answers a request immediately.
   */
  async identify() {
    this.state.heard = { lines: 0, first: null };
    this.rung('identify', 'active', 'listening for the board');

    this.link?.send({ t: 'ping' }).catch(() => {});
    const hello = await this.awaitHello(HELLO_MS);

    if (!hello) {
      /* Three outcomes, not two. A board chattering away in firmware that does
         not speak this protocol is not the same as a silent one, and reporting
         "nothing there" over a running project is both wrong and alarming. */
      if (this.state.heard.lines > 0) {
        this.rung('identify', 'fault',
          `${this.state.heard.lines} lines of output, none of them protocol frames`);
        this.state.fault = fault('no_hello');
        this.state.fault.observed =
          `The port opened and ${this.state.heard.lines} lines arrived, none of `
          + 'them protocol frames.';
        this.state.phase = 'fault';
        this.emit();
        return null;
      }
      return this.fail('identify', 'no_hello');
    }

    this.state.hello = hello;
    this.rung('identify', 'done',
      [hello.board_name || hello.board, hello.mac, hello.fw].filter(Boolean).join(' · '));

    return this.watchTelemetry();
  }

  awaitHello(timeoutMs) {
    return new Promise(resolve => {
      let done = false;
      const finish = v => {
        if (done) return;
        done = true;
        this._helloWaiters.delete(finish);
        clearTimeout(timer);
        resolve(v);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      this._helloWaiters.add(finish);
    });
  }

  /* ---- 4. TELEMETRY ---------------------------------------------------- */

  /**
   * The board is identified. It now has to keep reporting.
   *
   * A board that says hello and then goes quiet is a distinct and common
   * failure — firmware older than this page expects, or a panic just after
   * boot — and it deserves its own rung rather than being folded into
   * "connected".
   */
  watchTelemetry() {
    this.rung('telemetry', 'active', 'waiting for the first reading');

    clearTimeout(this._beatTimer);
    this._beatTimer = setTimeout(() => {
      if (this.state.phase === 'done' || this.disposed) return;
      this.fail('telemetry', 'no_beat');
    }, BEAT_MS);

    return this.state.hello;
  }

  /**
   * Called on the first beat. Bring-up is over; the instrument takes it.
   *
   * Guarded on the rung rather than on the phase. The phase is a property of
   * the whole flow and a rung is a property of the step, so a stale beat that
   * arrives while a later step is running finds its rung no longer waiting and
   * does nothing — which is the correct outcome and the one a phase check gets
   * wrong in both directions.
   */
  markLive() {
    if (this.state.rungs.telemetry.state !== 'active') return;
    clearTimeout(this._beatTimer);
    this.rung('telemetry', 'done', 'reporting');
    this.log('telemetry is live', 'meta');
    this.state.phase = 'done';
    this.state.active = null;
    this.emit();
  }

  /* ---- frames ---------------------------------------------------------- */

  onFrame(frame) {
    /* Beats and image chunks arrive in their dozens and would drown the
       monitor. An image header still gets a line, so frames arriving stays
       visible. */
    if (frame.t === 'img') {
      this.log(`< img #${frame.seq} · ${frame.w}×${frame.h} · ${frame.bytes} bytes`, 'frame');
    } else if (frame.t !== 'beat' && frame.t !== 'imgd') {
      this.log(`< ${frame.t}`, 'frame');
    }

    if (frame.t === 'hello') {
      this.state.hello = frame;
      this._helloWaiters.forEach(fn => fn(frame));
    }
    if (frame.t === 'beat' && this.state.rungs.telemetry.state === 'active') {
      this.markLive();
    }
    if (frame.t === 'status') {
      this.log(`${frame.stage}${frame.detail ? ` · ${frame.detail}` : ''}`, 'meta');
    }

    this.frameSink?.(frame);
  }

  /* ---- teardown -------------------------------------------------------- */

  async closeLink() {
    if (!this.link) return;
    try {
      await this.link.stop();
    } catch (err) {
      /* Said here, where it happened. Swallowing this is what turns a leaked
         port into "the board did not answer" three steps later. */
      this.log(err.message, 'error');
    }
    this.link = null;
  }

  /**
   * Shut this session down for good.
   *
   * Without it, replacing a session only drops the reference: the old one keeps
   * its port open and its render callback live, and repaints its own stale
   * state over whatever replaced it.
   */
  async dispose() {
    clearTimeout(this._beatTimer);
    this._helloWaiters.forEach(fn => fn(null));
    this._helloWaiters.clear();
    this.frameSink = null;
    this.onUpdate = null;
    await this.closeLink();
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
