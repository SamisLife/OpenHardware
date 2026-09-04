/* ============================================================================
   session.js — bringing a board up, one rung at a time.
   ----------------------------------------------------------------------------
   Five rungs, in the order the hardware actually does them:

       CONNECT     a port, granted and open
       FLASH       fetch, verify, write — the one stage with honest progress
       BOOT        the board resets, leaves the bus, and comes back
       IDENTIFY    something on the other end that answers
       TELEMETRY   and keeps answering

   Every rung is on the path to a board that is reporting. There is no optional
   step and nothing to decline: the cable carries everything this page needs,
   so the flow never stops to ask about anything it does not require.

   FLASH always stops and asks, and it asks having already looked. It listens
   first, so the question it puts is a specific one: this board is running
   something recognisable, or it is not, and either way writing is a choice
   somebody makes rather than something that happens on the way past.

   That placement is the point. Listening for an identity is how the decision
   about writing gets made, not a step after it — so running past FLASH and
   failing on IDENTIFY would report the problem two rungs from the thing that
   fixes it, and would report a decision nobody was asked to make as a
   malfunction. A board running unrecognised firmware is not broken.

   Stopping even when the firmware IS recognised costs one click and buys the
   thing that matters more: writing a fresh image is always one step away,
   from the same place, without having to reach a failure first.

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
import { describeRunning } from './guide.js';
import { pushGap, applyDevice, applyPeripherals, applyUi } from '../state.js';

export const RUNGS = ['connect', 'flash', 'boot', 'identify', 'telemetry'];

const RUNG_TITLE = {
  connect: 'Connect',
  flash: 'Flash',
  boot: 'Boot',
  identify: 'Identify',
  telemetry: 'Telemetry',
};

/** Activation is idempotent until its restart, and must be acknowledged. */
const ACTIVATE_ACK_MS = 1600;
const ACTIVATE_TRIES = 3;
/** How long to wait for a board to announce itself before giving up on it. */
const HELLO_MS = 4000;
/**
 * How long a freshly activated image is left completely alone after restart.
 * Opening the port resets this board, and the USB peripheral can be back on
 * the bus while the bootloader is still running — before the new
 * image has had a chance to confirm itself. Opened then, the reset lands on
 * an unconfirmed image and the bootloader puts the previous one back. The
 * harness confirms within its first second; this is that second, with room.
 */
const CONFIRM_GRACE_MS = 4000;
/** And for the first telemetry after it has. */
const BEAT_MS = 6000;
/** How long "listen anyway" waits. Long, because reading the wire is the point. */
const LISTEN_MS = 60000;
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
    this._matchWaiters = new Set();
    this._beatTimer = 0;
    this._relinkArmed = false;
    this._relinking = false;
    /** A reconnect that arrived while one was running, to be run after it. */
    this._relinkQueued = null;
    this.reset();
  }

  reset() {
    this.state = {
      /**
       * idle | working | decide | fault | done
       *
       * `decide` is not a failure. The flow is waiting on a person, and the
       * distinction matters: a fault means something went wrong, and putting a
       * board running perfectly good third-party firmware under that heading
       * is a false report.
       */
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
      /**
       * How the running firmware compares to what is published, once both are
       * known. Null while unknown, and null is the ordinary state — there may
       * be no published image to compare against at all.
       */
      published: null,
      /**
       * What the flash rung found. { known, fw, app } for a board that
       * identified itself, { known: false, lines } for one that did not — the
       * line count being the only honest thing that can be said about firmware
       * nobody has a name for.
       */
      found: null,
      /**
       * True only while bytes are going to the chip.
       *
       * Distinct from the flash rung being active, which now also covers
       * reading what is already on the board. Warning somebody about closing
       * the tab during a read-only check trains them to dismiss the warning
       * that matters.
       */
      writing: false,
      fault: null,
      simulated: !!this.driver?.simulated,
      blocked: this.driver?.blockedReason?.() ?? null,
    };
    this.monitor = [];
    this.emit();
  }

  /**
   * Repaint. A renderer that throws must not take the flow down with it.
   *
   * emit() is called from inside log(), which is called from inside the
   * reconnect and the flash paths. An exception in the
   * callback is therefore an exception in the middle of whichever of those is
   * running — and one bad paint once killed a reattach on its first line. The
   * model's own subscribers are guarded the same way, for the same reason.
   */
  emit() {
    try {
      this.onUpdate?.(this.state, this.monitor);
    } catch (err) {
      console.error('[openhardware] bring-up render failed', err);
    }
  }

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
    /* Once the instrument has taken over, the monitor this writes to is
       hidden. Anything this session has to say after that — a link closing,
       a reattach, a board that left the bus — goes to the note beside the
       source badge as well, or a reconnection that fails does so with nothing
       on screen to say it was even tried. The next heartbeat clears it. */
    if (this.state.phase === 'done' && (kind === 'meta' || kind === 'error')) {
      applyUi({ label: String(text) });
    }

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

    /* Everything the previous attempt concluded, cleared.
     *
     * This is the failure this whole project exists to prevent, in its own
     * code: a finding from one attempt rendering as though it described the
     * current one. It showed up as a screen reporting that nothing
     * identifiable had arrived while, directly underneath, stating which
     * version the board was running — two statements about two different
     * moments, presented as one situation. */
    this.state.fault = null;
    this.state.published = null;
    this.state.found = null;
    this.state.writing = false;
    this.state.hello = null;
    this._justWritten = false;

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
    return this.decideFirmware();
  }

  /* ---- 2. FLASH, which begins by deciding ------------------------------ */

  /**
   * What is on this board, and does anything need writing?
   *
   * Always ends by asking. Two shapes of the same question, decided by whether
   * anything identified itself, and the flow waits on the answer either way.
   *
   * What is deliberately NOT done here is characterising unrecognised
   * firmware. An earlier version named the framing it saw, which was accurate
   * for exactly one board and misleading everywhere else: firmware this page
   * does not recognise is usually not another version of this project, it is
   * arbitrary, and inventing a category for it claims knowledge that does not
   * exist. What can honestly be said is how much the board said and that none
   * of it was recognised.
   */
  async decideFirmware() {
    this.rung('flash', 'active', 'checking what the board is running');
    this.state.heard = { lines: 0, first: null };

    /* Asked as well as waited for: a board that has been running a while
       announces itself infrequently, and there is no reason to sit through
       that when it answers a request immediately. */
    this.link?.send({ t: 'ping' }).catch(() => {});
    const hello = await this.awaitHello(HELLO_MS);

    /* Awaited here, unlike after identification, because the answer changes
       what the question says — a version to write, and whether it differs from
       what is already there. */
    await this.loadPublished(hello);

    this._pending = hello;

    /* The app the board reported is kept with the rest of what was found, so
       the decision can name what is running rather than describing a hash. */
    this.state.found = hello
      ? { known: true, fw: hello.fw || null, app: hello.app || null }
      : { known: false, lines: this.state.heard.lines };

    /* One line, in the same words the notice and the agent get. */
    this.rung('flash', 'ask', describeRunning(this.state).short || '');

    this.state.phase = 'decide';
    this.emit();
    return null;
  }

  /**
   * Carry on with whatever is already on the board.
   *
   * The identity that answered during the decision is reused rather than asked
   * for again. A board that has just said what it is has not become a
   * different board, and probing twice would mean the flow could fail on the
   * second attempt at a question already answered.
   */
  continueWithBoard() {
    if (!this._pending) return this.listen();

    this.rung('flash', 'skipped', 'kept what was on the board');
    this.rung('boot', 'skipped', '');
    return this.identified(this._pending);
  }

  /**
   * What is published, and how it compares to what is running.
   *
   * Compared on the ELF hash rather than the version string: two builds of
   * different source can carry the same label, so comparing labels compares
   * two claims where comparing hashes compares the artefacts.
   *
   * Every failure is silent. There may be no server and no published image,
   * which is not a problem with the board in front of somebody.
   */
  async loadPublished(hello) {
    let manifest;
    try {
      manifest = await this.driver.fetchManifest();
    } catch {
      return;
    }
    if (!manifest) return;
    this.state.manifest = manifest;

    const running = String(hello?.sha || '').toLowerCase();
    const published = String(manifest.elf_sha8 || '').toLowerCase();
    const runningVersion = hello?.fw || null;
    const publishedVersion = manifest.version || '';

    /* Four answers rather than two, because "the hashes differ" is not a fact
       anybody can act on. What a reader needs to know is whether the board is
       running the published image, a DIFFERENT BUILD of the same harness —
       which is the ordinary state of a board an agent has been compiling for,
       and perfectly fine to keep — or an OLDER HARNESS, which is the one case
       where writing the baseline is the recommendation rather than an option. */
    let action = 'unknown';
    if (running && published) {
      if (running === published) action = 'same';
      else if (runningVersion && runningVersion === publishedVersion) action = 'differs';
      else action = 'outdated';
    }

    this.state.published = {
      version: publishedVersion,
      sha: published || null,
      running: runningVersion,
      action,
    };
  }

  /**
   * Leave the board alone and keep listening to it.
   *
   * A real choice rather than a way of declining one. Watching a board nobody
   * intends to overwrite is a legitimate thing to want — it is most of what
   * the monitor is for — and the window is long because the reason to sit here
   * is to read what the board is saying, not to wait for a verdict.
   */
  async listen() {
    this.rung('flash', 'skipped', 'left as it was');
    this.rung('boot', 'skipped', '');
    this.rung('identify', 'active', 'listening — nothing recognised yet');
    this.state.phase = 'working';
    this.emit();

    const hello = await this.awaitHello(LISTEN_MS);
    if (hello) return this.identified(hello);

    /* Now it is a fault, because this time it was asked for and waited out. */
    this.rung('identify', 'fault', `${this.state.heard.lines} lines, nothing identifiable`);
    this.state.fault = fault('no_hello');
    this.state.phase = 'fault';
    this.emit();
    return null;
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
          this._matchWaiters.forEach(w => w.finish(null));
          void this.onLinkClosed();
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
  async flash({ eraseAll = false, imageBase = '/firmware/baseline/' } = {}) {
    if (!this.port) return this.fail('connect', 'no_port');
    const runningSlot = this.state.hello?.slot || 'unknown';

    this.state.fault = null;
    this.state.found = null;
    this.state.hello = null;
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
      manifest = await this.driver.fetchManifest(imageBase);
      this.state.manifest = manifest;
      images = await this.driver.fetchImages(manifest, imageBase);
    } catch (err) {
      const code = err.code === 'no_server' ? 'no_manifest' : err.code || 'fetch_failed';
      return this.fail('flash', code, err.message);
    }

    const kb = (manifest.total_bytes || 0) / 1024;
    this.log(`${manifest.project || 'firmware'} ${manifest.version || ''} · `
           + `${manifest.parts.length} images · ${kb.toFixed(0)} KB · hashes verified`, 'meta');

    let activation = null;
    if (manifest.kind === 'candidate') {
      if (manifest.activation_protocol !== 2) {
        return this.fail('flash', 'no_manifest', 'candidate predates the self-confirming harness (protocol 2); rebuild it against the current harness');
      }
      const target = runningSlot === 'ota_0' ? 'ota_1' : 'ota_0';
      const address = Number(manifest.targets?.[target]);
      if (!Number.isInteger(address) || address <= 0 || images.length !== 1) {
        return this.fail('flash', 'no_manifest', 'candidate manifest has no valid inactive OTA target');
      }
      images = images.map(image => ({ ...image, address }));
      activation = { slot: target, sha: manifest.elf_sha8, buildId: manifest.build_id || null };
      this.log(`candidate ${activation.buildId || manifest.elf_sha8} targets ${target}; factory is untouched`, 'meta');
    }

    /* ---- phase two: write. From here the board is in play. ------------- */
    await this.closeLink();

    let chipAnswered = false;
    this.state.writing = true;
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
      this.state.writing = false;
      return this.fail('flash', chipAnswered ? 'flash_failed' : 'no_chip', err.message);
    }

    this.state.progress = null;
    this.state.writing = false;
    this.rung('flash', 'done', `${manifest.version || 'image'} written`);
    return this.waitForBoot(activation);
  }

  /**
   * The board has been reset by the flasher.
   *
   * On hardware with native USB the whole device leaves the bus and returns a
   * second or two later, possibly as a different port object. This is the most
   * fragile moment in the flow, so it gets an explicit patient recovery rather
   * than an assumption that the handle still works.
   */
  async waitForBoot(activation = null) {
    this.rung('boot', 'active', 'board is resetting');

    const port = await this.driver.waitForBoard(this.port, {
      onWait: (_n, remaining) =>
        this.rung('boot', 'active', `waiting for the bus · ${Math.ceil(remaining / 1000)}s`),
    });
    if (!port) return this.fail('boot', 'no_reopen');

    this.port = port;
    this.rung('boot', 'active', 'back on the bus');
    if (!(await this.openLink())) return this.fail('boot', 'no_open', this._openError);

    if (activation) return this.activateCandidate(activation);

    this.rung('boot', 'done', 'back on the bus');

    /* Marked so that silence from here is reported as what it is. A board that
       has just been written to and reset is in different circumstances from
       one somebody has only connected to, and the first thing worth trying
       differs. */
    this._justWritten = true;
    return this.identify();
  }

  /** Validate the inactive image, select it, then observe the candidate boot. */
  async activateCandidate(activation) {
    this.rung('boot', 'active', `validating ${activation.slot}`);
    this.state.hello = null;
    const helloWait = this.awaitHello(5000);
    this.link?.send({ t: 'ping' }).catch(() => {});
    const current = await helloWait;
    if (!current) return this.fail('boot', 'no_hello', 'the current image did not return to activate the candidate');

    /* A successful stream write is not proof that the USB OUT endpoint
       delivered the frame. Other acknowledged commands already retry for
       this reason; selecting an image must be at least as strict. The command
       is idempotent until its scheduled restart. If the link closes before
       the acknowledgement, continue to the boot verdict: that close may be
       the accepted command restarting the board. */
    const rxBefore = Number(current.rx);
    let ack = null;
    let sent = 0;
    for (let attempt = 1; attempt <= ACTIVATE_TRIES; attempt++) {
      const ackWait = this.awaitFrame('activate_ack', ACTIVATE_ACK_MS);
      this.log(`> activate ${activation.slot} · attempt ${attempt}`, 'frame');
      const accepted = await this.link?.send({
        t: 'activate', slot: activation.slot, sha: activation.sha,
      });
      if (accepted) sent++;
      ack = await ackWait;
      if (ack || !this.link?.open) break;
    }

    if (ack && !ack.ok) {
      return this.fail('boot', 'activation_refused', ack.err || 'the candidate image was not accepted');
    }
    if (!ack && this.link?.open) {
      const rxAfter = Number(this.state.hello?.rx);
      const rxDetail = Number.isFinite(rxBefore) && Number.isFinite(rxAfter)
        ? `; board rx changed from ${rxBefore} to ${rxAfter}` : '';
      return this.fail('boot', 'no_activate_ack',
                       `${sent} activation frame${sent === 1 ? '' : 's'} queued${rxDetail}`);
    }

    if (ack) this.log(`< activate_ack ${ack.slot} ${ack.sha || ''}`, 'frame');
    else this.log('activation link reset before its acknowledgement; reading the boot verdict', 'meta');
    this.rung('boot', 'active', `${activation.slot} selected; waiting for candidate boot`);
    await sleep(400);
    await this.closeLink();

    /* Leave the candidate alone before even looking for its port. The native
       USB driver used below actively opens the port to release it after an
       esptool reset. That is needed after writing, but here it would reset a
       pending candidate before app_main can mark it valid. */
    for (let left = CONFIRM_GRACE_MS; left > 0; left -= 500) {
      this.rung('boot', 'active', `${activation.slot} booting · ${Math.ceil(left / 1000)}s for it to confirm itself`);
      await sleep(Math.min(500, left));
    }

    const port = await this.driver.waitForBoard(this.port, {
      onWait: (_n, remaining) =>
        this.rung('boot', 'active', `waiting for candidate · ${Math.ceil(remaining / 1000)}s`),
    });
    if (!port) return this.fail('boot', 'no_reopen');
    this.port = port;

    if (!(await this.openLink())) return this.fail('boot', 'no_open', this._openError);

    /* The port just reopened, which resets this board, and that reset is the
       one a pending image has to survive: what comes back is the verdict. The
       harness confirms itself the moment it is reporting and says so in its
       hello. "valid" is the candidate kept; "factory" with the slot marked
       aborted is the bootloader having put the baseline back. */
    this.rung('boot', 'active', `${activation.slot} selected; reading what booted`);
    this.state.hello = null;
    const booted = this.awaitHello(HELLO_MS * 2);
    this.link?.send({ t: 'ping' }).catch(() => {});
    const hello = await booted;
    if (!hello) return this.fail('boot', 'no_hello', 'nothing identified itself after activation');

    const sha = String(hello.sha || '').toLowerCase();
    if (hello.slot !== activation.slot || sha !== String(activation.sha || '').toLowerCase()) {
      if (hello.aborted === activation.slot || hello.slot === 'factory') {
        return this.fail('boot', 'rolled_back',
          `${activation.slot} was abandoned by the bootloader; running ${hello.fw || 'firmware'} from ${hello.slot || '?'}`);
      }
      return this.fail('boot', 'flash_failed',
        `expected ${activation.sha} in ${activation.slot}, found ${hello.sha || '?'} in ${hello.slot || '?'}`);
    }

    this.rung('boot', 'done',
      `${activation.slot} active · ${hello.ota === 'valid' ? 'confirmed' : (hello.ota || 'state unknown')}`);
    this._justWritten = true;
    return this.identified(hello);
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
         "nothing there" over a running board is both wrong and alarming. */
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
      /* Before blaming the board: did this page ever manage to read at all?
         A reader that never attached — a stream still locked by the flashing
         library, or a port with no readable at all — produces exactly the
         same silence as a board that is not running, and the two have nothing
         in common. Saying "nothing arrived" about a link that was never
         listening is the one kind of statement this whole project exists to
         refuse. */
      if (this.link?.readerFailed) {
        return this.fail('identify', 'read_failed', this.link.readerFailed);
      }

      return this.fail('identify', this._justWritten ? 'silent_after_write' : 'no_hello');
    }

    return this.identified(hello);
  }

  /**
   * A board has said what it is. Shared by both routes to that point.
   *
   * Reached either from the flash decision, when the board already spoke the
   * protocol, or from IDENTIFY after an image has been written. The second
   * route probes again because the board it is talking to is a different one
   * from the board it decided about.
   */
  identified(hello) {
    this.state.hello = hello;
    this.state.phase = 'working';
    this.rung('identify', 'done',
      [hello.board_name || hello.board, hello.mac, hello.fw].filter(Boolean).join(' · '));

    /* Deliberately not awaited. The board has identified itself and telemetry
       is the next thing that matters; whether a newer image exists somewhere
       is worth knowing and worth nobody waiting on. */
    this.loadPublished(hello).then(() => this.emit());

    return this.watchTelemetry();
  }


  /* ---- 4. TELEMETRY --------------------------------------------------- */

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

  /**
   * The same wait, for any frame matching a predicate.
   *
   * Separate from awaitHello because identity is the one frame the whole flow
   * turns on and it has its own fan-out; this is for the one-off replies —
   * an acknowledgement, a join result — where a timeout means "it did not
   * come" rather than "the board is gone".
   */
  awaitMatch(matches, timeoutMs) {
    return new Promise(resolve => {
      let done = false;
      const finish = v => {
        if (done) return;
        done = true;
        this._matchWaiters.delete(entry);
        clearTimeout(timer);
        resolve(v);
      };
      const entry = { matches, finish };
      const timer = setTimeout(() => finish(null), timeoutMs);
      this._matchWaiters.add(entry);
    });
  }

  awaitFrame(type, timeoutMs) {
    return this.awaitMatch(f => f.t === type, timeoutMs);
  }

  awaitStatus(stages, timeoutMs) {
    return this.awaitMatch(f => f.t === 'status' && stages.includes(f.stage), timeoutMs);
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
    this.armRelink();
    this.emit();
  }

  /* ---- surviving the cable ---------------------------------------------- */

  /**
   * Watch for the board coming back, without ever going looking for it.
   *
   * Chrome fires `connect` for any device this page already has permission
   * for, with no user gesture. That is the whole reason a silent reconnect is
   * possible at all: requestPort() needs a click, and the point of this is to
   * survive somebody walking away.
   *
   * Event-driven rather than polled. While the board is unplugged this costs
   * nothing, and no port is ever opened speculatively — so no board is ever
   * reset just to find out whether it is there.
   */
  armRelink() {
    /* A simulated board has no bus to reappear on, and a real board plugged in
       during ?sim must not be adopted by a simulated session. */
    if (this._relinkArmed || this.driver.simulated) return;
    if (typeof navigator === 'undefined' || !navigator.serial) return;
    this._relinkArmed = true;

    this._onSerialConnect = () => {
      void this.relink('a board appeared on the bus', { appeared: true });
    };
    navigator.serial.addEventListener('connect', this._onSerialConnect);

    /* Returning to the tab is the other moment worth trying, because a
       backgrounded tab deliberately declines the port. See relink(). */
    this._onVisible = () => {
      if (!globalThis.document?.hidden) {
        void this.relink('the tab came back to the foreground');
      }
    };
    globalThis.document?.addEventListener('visibilitychange', this._onVisible);

    /* Leaving for good. A serial port is exclusive across the whole machine,
       so a document that goes away still holding one denies it to every other
       tab and every other program, and the next thing to want it is told
       access was denied with nothing on screen to explain why. */
    this._onPageHide = () => { void this.closeLink(); };
    globalThis.addEventListener?.('pagehide', this._onPageHide);
  }

  disarmRelink() {
    if (this._onSerialConnect) {
      globalThis.navigator?.serial?.removeEventListener('connect', this._onSerialConnect);
      this._onSerialConnect = null;
    }
    if (this._onVisible) {
      globalThis.document?.removeEventListener('visibilitychange', this._onVisible);
      this._onVisible = null;
    }
    if (this._onPageHide) {
      globalThis.removeEventListener?.('pagehide', this._onPageHide);
      this._onPageHide = null;
    }
    this._relinkArmed = false;
  }

  /**
   * The device closed the port.
   *
   * Recorded immediately rather than left to the silence watchdog, which would
   * take another 1.5 s to reach the same conclusion. A console showing live
   * numbers for a board that has left the bus is the single thing this
   * instrument exists to prevent.
   */
  async onLinkClosed() {
    if (!this._relinkArmed || this.state.phase !== 'done') return;
    pushGap(Date.now(), 'PORT CLOSED');
    applyDevice({ link: 'lost' });
    await this.relink('the port closed', { justClosed: true });
  }

  /**
   * Get the cable back, without disturbing the board.
   *
   * Bounded on purpose. If the board is not there, stop and wait to be told it
   * is, because retrying forever would be a poll wearing an event's clothes.
   */
  async relink(why, { justClosed = false, appeared = false } = {}) {
    if (this.disposed) return false;

    /* Queued, not dropped. The ordinary fast replug is a `connect` event that
       lands while the pass that noticed the board leaving is still running,
       and the bus announces it exactly once. A pass that ignored it would
       leave the page waiting for an event that already happened. */
    if (this._relinking) {
      this._relinkQueued = { why, appeared };
      return false;
    }
    /* Bring-up owns the port while it runs. This covers only the stretch after
       handover. */
    if (this.state.phase !== 'done') return false;
    if (this.link?.open) return false;

    /* A background tab does not get to take the board.
     *
     * The port is exclusive machine-wide, so a console left open in another
     * tab would silently reclaim the device the moment it re-enumerates, and
     * the tab actually being used would then fail to open it, with the board
     * sitting right there on the bus and nothing saying who has it.
     *
     * Deferred rather than dropped: visibilitychange retries the moment this
     * tab is looked at again. */
    if (globalThis.document?.hidden) {
      this.log('a board is back, but this tab is in the background - '
             + 'leaving the port for whoever is in front', 'meta');
      return false;
    }

    this._relinking = true;
    try {
      this.log(`reattaching to the board — ${why}`, 'meta');
      await this.closeLink();

      /* The port just closed. Before hunting, ask the bus whether the device
         is still on it. If it left, opening ports it is not behind finds
         nothing — and holds this pass busy for exactly the seconds a fast
         replug needs it free. Better to say so and wait to be told. */
      if (justClosed) {
        const present = (await this.driver.portsLike?.(this.port)) ?? [];
        if (!present.length) {
          this.log('the board left the bus — waiting for it to come back', 'meta');
          return false;
        }
      }

      /* A board that just appeared has just booted, so there is no uptime to
         protect. It goes through the same open-and-release cycle the post-write
         path uses: that is what leaves this part running the application
         rather than parked in its downloader, and it is the one path proven to
         bring a board back on this hardware. */
      if (appeared && typeof this.driver.waitForBoard === 'function') {
        const back = await this.driver.waitForBoard(this.port, { timeoutMs: 8000 });
        if (this.disposed) return false;
        if (back) this.port = back;
      }

      for (let attempt = 1; attempt <= 5; attempt++) {
        if (this.disposed) return false;
        /* A board that has just enumerated may refuse an open for a moment.
           Waited before the first try, not only between tries. */
        await sleep(attempt === 1 ? 250 : 700);

        for (const port of (await this.driver.portsLike?.(this.port)) ?? []) {
          if (this.disposed) return false;
          this.port = port;

          if (!(await this.openLink())) continue;

          this.link?.send({ t: 'ping' }).catch(() => {});
          const hello = await this.awaitHello(4000);

          /* Re-checked AFTER the await, not only before it. dispose() can land
             while this is opening, and a link opened after that point belongs
             to nobody: the session is gone, nothing will close it, and the next
             session's Connect fails on a port this one is still holding. */
          if (this.disposed) { await this.closeLink(); return false; }
          if (!this.link?.open) { await this.closeLink(); continue; }

          if (hello) this.state.hello = hello;

          /* A board that has just booted is not streaming, and it has
             rediscovered whatever is attached to it. What the previous boot
             said is dropped and the question asked again, rather than carried
             forward as though it were still current. */
          applyPeripherals({ known: false, streaming: false });
          this.link.send({ t: 'caps' }).catch(() => {});

          this.log('serial link re-established', 'meta');
          this.rung('telemetry', 'done', 'reporting');
          this.emit();
          return true;
        }
      }

      /* Nothing matched. Most often the board is simply not plugged in yet and
         `connect` will call back. It can also mean it went into a socket this
         page has no grant for, which needs a person. Both are named; neither
         is asserted. */
      this.log('no permitted serial port matches this board', 'meta');
      return false;
    } finally {
      this._relinking = false;
      /* Whatever arrived while this pass was busy gets its turn — unless the
         pass succeeded, in which case there is nothing left to reattach. */
      const queued = this._relinkQueued;
      this._relinkQueued = null;
      if (queued && !this.link?.open && !this.disposed) {
        void this.relink(queued.why, { appeared: queued.appeared });
      }
    }
  }

  /* ---- frames ---------------------------------------------------------- */

  onFrame(frame) {
    /* Beats and image chunks arrive in their dozens and would drown the
       monitor. An image header still gets a line, so frames arriving stays
       visible. */
    if (frame.t === 'log' && frame.src === 'app') {
      this.log(`app: ${frame.msg || ''}`, 'app');
    } else if (frame.t === 'img') {
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

    /* Run over a copy: a waiter that resolves removes itself from the set. */
    for (const w of [...this._matchWaiters]) {
      if (w.matches(frame)) w.finish(frame);
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
    /* Before anything else: a disposed session must not go on grabbing ports
       out from under its successor when a board reappears. */
    this.disarmRelink();
    this._helloWaiters.forEach(fn => fn(null));
    this._helloWaiters.clear();
    this._matchWaiters.forEach(w => w.finish(null));
    this._matchWaiters.clear();
    this.frameSink = null;
    this.onUpdate = null;
    await this.closeLink();
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
