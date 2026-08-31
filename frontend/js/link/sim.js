/* ============================================================================
   sim.js — a board that does not exist.
   ----------------------------------------------------------------------------
   Not a mock of the interface. A fake board BEHIND the real interface.

   It writes encoded OHW1 lines into a real FrameReader, so the CRC, the
   framing, the mid-line recovery and the parsing are all exercised exactly as
   they will be by a serial port. It emits the same log noise a boot produces,
   so the pass-through path is exercised too. And it presents the same link
   object a real transport presents.

   That last point is the one worth defending. A simulator that satisfies a
   weaker contract than the real thing has stopped being evidence: it will keep
   passing after the real path has broken. So the shape is taken from the
   contract in protocol.js rather than from whatever happened to be convenient.

   What it buys, beyond having something to look at:

     until the firmware exists there is no other way to run the frontend at all
     the bring-up flow and the reconnection logic have something that answers
     a failure here implicates the frontend; a failure only on hardware
       implicates the firmware, and that split is otherwise unavailable

   ----------------------------------------------------------------------------
   SCENES

   Reached as ?sim, ?sim=hot, and so on. They exist so a state can be held
   rather than waited for, which is what designing against one requires.

       (none)   a healthy board, warming gently toward its idle temperature
       hot      climbing past a declared ceiling
       lost     reports, then stops, leaving the recorder to draw the outage
       nocam    no camera attached, so the panel has to disappear
       green    the camera returns a uniform green field — an unwritten
                framebuffer, the failure a compiler cannot catch
   ========================================================================== */

import { encodeFrame, FrameReader, IMG_CHUNK_RAW } from './protocol.js';

const MB = 1024 * 1024;

/** Cadences, matching what the harness is specified to emit. */
const BEAT_MS = 250;
const HELLO_MS = 5000;
const FRAME_MS = 2000;

/** ROM and bootloader chatter, so the log pass-through has something to pass. */
const BOOT_LOG = [
  'ESP-ROM:esp32s3-20210327',
  'build:Mar 27 2021',
  'rst:0x1 (POWERON),boot:0x8 (SPI_FAST_FLASH_BOOT)',
  'I (25) boot: compile time ' + new Date().toDateString(),
  'I (31) boot.esp32s3: SPI Mode       : DIO',
  'I (36) boot.esp32s3: SPI Flash Size : 8MB',
  'I (89) esp_psram: Found 8MB PSRAM device',
  'I (512) esp_psram: SPI SRAM memory test OK',
  'I (520) main_task: Started on CPU0',
];

export class SimBoard {
  /** @param {string} scene one of the scenes named above */
  constructor(scene = '') {
    this.scene = String(scene || '').toLowerCase();
    this.handlers = null;
    this.reader = null;
    this.timers = new Set();

    this.bootedAt = Date.now();
    this.tempC = 33.5;
    this.seq = 0;
    this.streaming = false;
    this.gone = false;

    this.hasCamera = this.scene !== 'nocam';
    this.cameraUp = false;
  }

  /* ---- the link ---------------------------------------------------------
     The same object a serial port presents. `open` included: without it a
     caller that checks before writing works against hardware and silently does
     not against this. */

  attach(handlers) {
    this.detach();
    this.handlers = handlers;
    this.reader = new FrameReader({
      onFrame: (f, raw) => handlers.onFrame?.(f, raw),
      onText: (t, bad, why) => handlers.onText?.(t, bad, why),
    });

    /* A board is already talking when something attaches to it, so the boot
       log is replayed rather than waited for. */
    for (const line of BOOT_LOG) this.write(line + '\n');

    this.after(60, () => this.sendHello());
    this.every(HELLO_MS, () => this.sendHello());
    this.every(BEAT_MS, () => { this.thermalTick(); this.sendBeat(); });
    this.every(FRAME_MS, () => this.sendImage());

    /* The camera comes up last, exactly as the bring-up order specifies: it is
       the one step that can take the system down, so it runs once the board is
       already reporting. */
    if (this.hasCamera) this.after(1800, () => this.probeCamera());
    else this.after(1800, () => { this.sendStatus('camera_absent', 'no camera detected'); this.sendCaps(); });

    if (this.scene === 'lost') this.after(14000, () => this.vanish());

    const board = this;
    return {
      get open() { return board.handlers === handlers; },
      send: async obj => { board.receive(obj); return true; },
      stop: async () => { board.detach(); },
    };
  }

  detach() {
    for (const id of this.timers) clearInterval(id);
    this.timers.clear();
    this.handlers = null;
    this.reader = null;
  }

  /* ---- the wire -------------------------------------------------------- */

  /** Everything the board says goes through the real reader. */
  write(text) { this.reader?.push(text); }

  emit(obj) {
    if (!this.reader || this.gone) return;
    try { this.write(encodeFrame(obj)); }
    catch (err) { this.write(`E (0) sim: ${err.message}\n`); }
  }

  /* ---- frames ---------------------------------------------------------- */

  sendHello() {
    this.emit({
      t: 'hello',
      proto: 1,
      fw: '0.6.0-sim',
      sha: '5111111111',
      slot: 'factory',
      board: 'sim_board',
      board_name: 'Simulated board',
      chip: 'esp32s3',
      mac: '02:00:00:00:00:01',
      boot_id: 'sim00001',
      reset: 'POWERON',
      psram: 8 * MB,
      heap_total: 327680,
      temp_crit_c: 85,
      heap: 190000,
      temp_c: round(this.tempC, 1),
    });
  }

  sendBeat() {
    const age = (Date.now() - this.bootedAt) / 1000;
    this.emit({
      t: 'beat',
      uptime_s: round(age, 2),
      temp_c: round(this.tempC, 2),
      heap_free: Math.round(190000 + Math.sin(age / 7) * 9000),
      psram_free: Math.round(6.1 * MB + Math.sin(age / 11) * 0.2 * MB),
      psram_largest: Math.round(3.1 * MB),
      /* A cable-tethered board has no association. Reporting a plausible
         signal strength here would be inventing one. */
      rssi: 0,
      cpu_mhz: 240,
      fps: this.streaming && this.cameraUp ? round(8.3 + Math.sin(age / 3) * 0.5, 2) : 0,
      boot_id: 'sim00001',
      cam: this.cameraUp ? 'ok' : this.hasCamera ? 'untried' : 'absent',
      net: 'offline',
    });
  }

  sendCaps() {
    this.emit({
      t: 'caps',
      camera: this.cameraUp
        ? { state: 'ok', sensor: 'OV2640' }
        : { state: this.hasCamera ? 'untried' : 'absent', sensor: 'none' },
      i2c: this.hasCamera ? [0x3c, 0x76] : [0x68],
      psram: 8 * MB,
      flash: 8 * MB,
      streaming: this.streaming,
    });
  }

  sendStatus(stage, detail, extra = {}) {
    this.emit({ t: 'status', stage, detail, ...extra });
  }

  probeCamera() {
    this.sendStatus('camera_probe', 'initialising sensor');
    this.after(220, () => {
      this.cameraUp = true;
      this.sendStatus('camera_ok', 'OV2640');
      this.sendCaps();
    });
  }

  /* ---- inbound --------------------------------------------------------- */

  receive(obj) {
    if (!obj || this.gone) return;
    if (obj.t === 'ping') return this.sendHello();
    if (obj.t === 'caps') return this.sendCaps();
    if (obj.t === 'cam') {
      const on = !!obj.on;
      if (on && !this.cameraUp) return this.emit({ t: 'cam_ack', on: false, err: 'no camera' });
      this.streaming = on;
      return this.emit({ t: 'cam_ack', on });
    }
  }

  /* ---- the model ------------------------------------------------------- */

  /**
   * First-order thermal rise toward a target set by duty cycle.
   *
   * A linear ramp reads as fake on a chart because nothing thermal behaves
   * that way. The time constant here is roughly what a small package in open
   * air actually does, so the trace bends the way a real one does.
   */
  thermalTick() {
    const target = this.scene === 'hot' ? 74 : this.streaming ? 48 : 41;
    this.tempC += (target - this.tempC) * 0.012 + (Math.random() - 0.5) * 0.06;
  }

  /** The board leaves the bus. Telemetry stops; nothing announces it. */
  vanish() {
    this.gone = true;
    for (const id of this.timers) clearInterval(id);
    this.timers.clear();
  }

  /* ---- images ---------------------------------------------------------- */

  /**
   * A capture, chunked exactly as the protocol specifies.
   *
   * The picture is drawn and JPEG-encoded by the browser, so what travels the
   * wire is a real image of a real size — which is what makes the chunk count,
   * the reassembly and the length check worth anything. Outside a browser
   * there is no canvas and no image; the rest of the board still reports.
   */
  async sendImage() {
    if (!this.cameraUp || !this.streaming || this.gone) return;
    const jpeg = await this.capture();
    if (!jpeg) return;

    const seq = ++this.seq;
    const chunks = Math.ceil(jpeg.length / IMG_CHUNK_RAW);

    this.emit({ t: 'img', seq, w: 640, h: 480, q: 12, bytes: jpeg.length, chunks });
    for (let i = 0; i < chunks; i++) {
      const slice = jpeg.subarray(i * IMG_CHUNK_RAW, (i + 1) * IMG_CHUNK_RAW);
      this.emit({ t: 'imgd', seq, i, d: base64(slice) });
    }
  }

  async capture() {
    if (typeof document === 'undefined') return null;
    try {
      const c = document.createElement('canvas');
      c.width = 640; c.height = 480;
      this.paint(c.getContext('2d'), 640, 480);
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.55));
      if (!blob) return null;
      return new Uint8Array(await blob.arrayBuffer());
    } catch {
      return null;
    }
  }

  /**
   * The scene.
   *
   * `green` is a uniform field, which is what an unwritten framebuffer looks
   * like when a driver hands back memory it never filled. It is worth
   * simulating because it is the failure that compiles, links, boots and
   * reports healthy — the whole reason this project watches frames at all.
   */
  paint(g, w, h) {
    if (this.scene === 'green') {
      g.fillStyle = '#00e83a';
      g.fillRect(0, 0, w, h);
      return;
    }

    const t = (Date.now() - this.bootedAt) / 1000;
    const bg = g.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#20242c');
    bg.addColorStop(1, '#0d0f12');
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);

    g.strokeStyle = 'rgba(255,255,255,0.05)';
    g.lineWidth = 1;
    for (let x = 0; x < w; x += 40) {
      g.beginPath(); g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, h); g.stroke();
    }
    for (let y = 0; y < h; y += 40) {
      g.beginPath(); g.moveTo(0, y + 0.5); g.lineTo(w, y + 0.5); g.stroke();
    }

    /* Something that moves, so consecutive frames are visibly different and a
       stalled pipeline is obvious rather than merely suspected. */
    const cx = w / 2 + Math.cos(t / 2) * w * 0.22;
    const cy = h / 2 + Math.sin(t / 3) * h * 0.18;
    g.fillStyle = '#c8b48a';
    g.beginPath();
    g.arc(cx, cy, 46, 0, Math.PI * 2);
    g.fill();

    g.fillStyle = 'rgba(236,230,221,0.55)';
    g.font = '16px monospace';
    g.fillText('SIMULATED SENSOR', 16, h - 18);
    g.fillText(`t+${t.toFixed(1)}s`, w - 96, h - 18);
  }

  /* ---- timers ---------------------------------------------------------- */

  every(ms, fn) {
    const id = setInterval(() => { if (this.handlers) fn(); }, ms);
    this.timers.add(id);
    return id;
  }

  after(ms, fn) {
    const id = setTimeout(() => { this.timers.delete(id); if (this.handlers) fn(); }, ms);
    this.timers.add(id);
    return id;
  }
}

/* ------------------------------------------------------------------------ */

function round(v, digits) {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
}

/** Bytes to base64, without depending on a browser or on Node specifically. */
function base64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  if (typeof btoa === 'function') return btoa(bin);
  return Buffer.from(bin, 'binary').toString('base64');
}
