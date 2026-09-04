# OpenHardware

A web page that brings up an ESP32-S3 over USB, shows what the board is
actually doing, and hands the same controls to an AI agent running in the
browser — with a person approving anything that writes to the board.

**<https://donthiresami.com/openhardware>**

---

## What this is

Plug a board into your laptop, open the page in Chrome, and pick the serial
port. The page tells you what the board is running, writes firmware to it if
you ask, and then draws what it reports: die temperature, free memory, frame
rate, camera frames, uptime. Nothing on screen is assumed. A reading the board
has not sent is drawn as absent, never as zero.

The part that makes it more than a serial monitor is the other half. The page
registers its controls as [WebMCP](https://github.com/webmachinelearning/webmcp)
tools, so an agent in the browser — ChatGPT's built-in browser, for instance —
can read the telemetry, write a small C application, compile it against the
firmware on your machine, and ask to flash it. It cannot flash anything on its
own. Every write stops at a gate that only a person can answer.

The firmware is split in two for that reason. A fixed **harness** owns the USB
link, the camera, the heartbeat and the OTA slots, and an agent may never edit
it. The **application** on top is the replaceable part. However wrong the
generated code is, the harness keeps reporting, so you can see what went wrong
and write over it.

---

## What you need

| | |
|---|---|
| **Browser** | Chrome or Edge on the desktop. The page uses Web Serial, which Safari and Firefox do not have. |
| **Board** | An ESP32-S3 with native USB and 8 MB of flash. Developed against a [Seeed XIAO ESP32-S3 Sense](https://wiki.seeedstudio.com/xiao_esp32s3_getting_started/); the camera pin map is that board's. |
| **Cable** | One that carries data. A charge-only cable looks exactly like a dead board. |
| **Python 3** | Runs the two local servers. No packages needed for those. |
| **Docker** | Compiles the firmware, in the official `espressif/idf:v5.3` image. You do not need ESP-IDF installed. |

Optional: Node 18 or newer to run the tests, and `pip install pyserial` for
`tools/monitor.py`.

On Windows the build scripts are shell scripts and run through Git Bash, which
the tooling finds at its default location. Set `OHW_BASH` if yours is
somewhere else.

You can look at the whole interface with no hardware at all — see
[Without a board](#without-a-board).

---

## Getting started

### 1. Build the recovery image

The compiled firmware is not committed, so build it once after cloning. This
takes a few minutes the first time, mostly Docker pulling the toolchain.

```sh
python tools/baseline.py
```

That produces `firmware/baseline/` — the known-safe image the page writes to a
board and the one you fall back to when an experiment goes wrong.

### 2. Serve the page

```sh
python tools/serve.py
```

Then open <http://localhost:8000/frontend/>.

Use `localhost` rather than your machine's IP address. Web Serial is only
available in a secure context, and a plain `http://192.168.…` page is not one —
the API is missing entirely rather than failing with a message.

### 3. Connect the board

Press **Connect a board** and choose the port. Only a person can do this: the
port picker is a native browser dialog and no script can drive it.

The page then tells you what the board is running and offers two answers.
A board running an application, or another build of the same harness version,
is working normally — **Continue with it** keeps it and writes nothing. A board
running an older harness, or nothing the page can read, leads with **Restore
baseline** instead. Either way both choices are on screen every time, so a
fresh image is never more than one click away.

Once the board is reporting, the bring-up screen gives way to the instrument.

### 4. Compile something (optional)

To let an agent build firmware, start the build daemon in a second terminal:

```sh
python tools/buildd.py
```

It listens on `127.0.0.1:8001` and only on loopback. It is a development tool
that runs a compiler on your machine, and it is not built to be exposed.

---

## Without a board

Add `?sim` to the URL and a simulated board runs the same bring-up, the same
protocol and the same tools:

<http://localhost:8000/frontend/?sim>

The simulator is a fake board behind the real interface, not a mock of the
interface — its frames go through the same encoder, the same CRC and the same
reader that a serial port does. Scenes exercise the cases that are awkward to
produce on demand:

| URL | What it does |
|---|---|
| `?sim` | a healthy board, warming gently toward its idle temperature |
| `?sim=hot` | climbs past a declared ceiling |
| `?sim=lost` | reports, then stops, so the recorder draws the outage |
| `?sim=nocam` | no camera attached |
| `?sim=green` | the camera returns a uniform green field, which a compiler cannot catch |

---

## The WebMCP integration

Every control on the page is registered as a WebMCP tool, one call per tool,
with the standard API:

```js
document.modelContext.registerTool({
  name: 'flash_image',
  description:
    "Write a specific successful build to the board's inactive OTA slot. This ASKS A "
    + 'HUMAN FIRST: the call blocks until the operator presses Approve on the page, and '
    + 'returns refused if they press Hold or do not answer before you cancel. Nothing '
    + 'touches the board until approval.',        // shortened here; the real one is longer
  inputSchema: {
    type: 'object', required: ['buildId'],
    properties: { buildId: { type: 'string', minLength: 1, maxLength: 40 } },
    additionalProperties: false,
  },
  execute: (input, { signal } = {}) =>
    flashBuild(fx, String(input?.buildId || '').trim(), { signal, requestedBy: 'agent' }),
}, { signal });
```

The tools are defined in [`frontend/js/webmcp.js`](frontend/js/webmcp.js) and
registered by `mountTools()` at the bottom of that file. Two details there are
worth knowing:

- Registration is **per tool with an `AbortSignal`**, so the board controls can
  be taken away again the moment the board goes. An agent is never holding a
  tool that has nothing on the end of it.
- `execute` always resolves rather than throwing. A failure comes back as
  `{ ok: false, error, next }`, where `next` says which button a person has to
  press. A rejected tool call tells a model what went wrong and nothing about
  how to recover.

---

## Working with an agent

Open the page in a browser that supports WebMCP. ChatGPT's built-in browser
does; desktop Chrome can with `chrome://flags/#enable-webmcp-testing`. If the
browser has no registry, the page says so beside the source badge and simply
works as an instrument.

Twenty tools are registered, in three groups.

**Reading, always available** — `get_board`, `get_bring_up`,
`get_telemetry_summary`, `get_wiring`, `get_images`, `get_build`,
`get_app_source`, `get_wire_tail`, `capture_frame`, `get_work_order`,
`get_learned_limits`. They answer before any board is connected; the ones that
need one refuse by saying which button a person has to press.

**Local, always available** — `build_firmware` and `record_attempt` compile
and write notes on your machine. Neither touches the board.

**Board controls, registered only once a board is linked** — `set_camera`,
`set_camera_config`, `run_experiment`, `record_limit`, `watch_for`, and the
two that stop and ask: `flash_image` and `restore_baseline` block until
somebody presses Approve on the page. There is no tool that approves a gate,
which is the entire point of having one.

Registering the board controls only when a board is there means an agent is
never offered a lever with nothing on the end.

A typical loop: the agent reads `get_app_source` for the API and `get_wiring`
for what you have told it is attached, writes an application, compiles it with
`build_firmware`, polls `get_build`, then calls `flash_image` and waits for
you. You can read the exact source of any build before approving it, from the
approval prompt or from the row's `•••` menu in the Images list.

The wiring list is worth a note. This board cannot discover what is wired to
it, so nothing is probed — you declare parts with **+ add**, and the tool
reply says on its face that the list is something a person typed rather than
something measured. That is what an agent should read before writing code that
assumes a pin.

---

## The board's side

Applications implement three functions and get a small API. There is nothing
else to learn:

```c
#include "hw_app.h"

void app_setup(void);                    // once, after the harness is up
void app_loop(void);                     // every 100 ms
void app_on_frame(const uint8_t *jpeg, size_t len, int w, int h);   // optional
```

```c
hw_app_log("anything: %d", n);           // a line on the wire, rate limited
hw_app_metric("detail", value);          // charts on the recorder as app.detail
hw_app_camera_stream(true);              // ask the harness for frames
```

A metric published with `hw_app_metric` becomes a new pen on the chart
recorder without any change to the page. That is usually the most direct way
to see whether generated firmware is doing what it claims.

Flash is laid out so an experiment cannot cost you the board:

```
0x020000  factory   the image you flashed over USB. Never an OTA target.
0x200000  ota_0     candidates alternate between these two, so the image
0x3E0000  ota_1     currently running is never the one being overwritten
```

A candidate is written to whichever OTA slot is not running, and the harness
verifies the image hash before it selects it. If it boots and reports, it
confirms itself; if it never gets that far, the bootloader puts the previous
image back on its own. Factory keeps the baseline throughout, so **Restore
baseline** always has somewhere to go home to.

---

## Repository layout

```
frontend/          the page. Plain ES modules, no build step, no framework
  js/state.js      the whole model, and the only way into it
  js/link/         serial, the OHW1 wire protocol, the flasher, the simulator
  js/onboard/      the bring-up state machine and its explanations
  js/render/       one module per panel
  js/webmcp.js     the tools an agent sees
  js/builder/gate.js   the one place a person is asked before a write
  tests/           node frontend/tests/<name>.mjs
firmware/
  harness/         the fixed layer: USB, protocol, camera, OTA, app sandbox
  apps/default/    the minimal application the baseline carries
tools/
  serve.py         static files with caching turned off
  buildd.py        loopback build daemon
  build.sh         compile in the ESP-IDF container
  baseline.py      build and publish the known-safe image
  monitor.py       watch the wire with no browser in the way
  tests/           python tools/tests/<name>.py
```

The page has no build step and no dependencies to install. It is ES modules
served as files, which is also why `serve.py` sends `Cache-Control: no-store`:
a stale module is a confusing bug to chase.

---

## When something goes wrong

**The port list is empty.** Try a different cable first. Charge-only USB cables
are common and present exactly as a board that will not enumerate.

**The board is silent, or the page cannot open the port.** A serial port is
exclusive machine-wide, so close any other tab or serial monitor holding it,
then run:

```sh
python tools/monitor.py
```

That reads the board with the browser out of the picture, which settles
whether the board is quiet or the page is deaf. It prints reboots, boot ids
and reset reasons, so a board that restarts every few seconds is
distinguishable from one whose transmit path stalled.

**An application crashed the board.** The harness counts crashes across boots
and disables the application after repeated ones, then keeps reporting and
says so. Flash a previous build from the Images list, or restore the baseline.

**Nothing is bricked.** The ROM bootloader lives in mask ROM and cannot be
overwritten. If a write is interrupted, unplug the board, plug it back in and
write again. If the board comes back silent after a flash, it is usually
sitting in download mode: a power cycle leaves it.

---

## Tests

No runner and no dependencies. Each file is a program that prints what it
checked.

```sh
node frontend/tests/protocol.mjs
python tools/tests/monitor.py
```

They are written to pin down claims rather than implementations — that a gap
in the record breaks the trace instead of being interpolated across, that a
board reporting zeros never renders the same as one that has not reported,
that no tool can approve its own gate.

---

## Limits worth knowing

- Chrome and Edge on the desktop only, because of Web Serial.
- One board at a time. You choose the port in the browser's own picker;
  `monitor.py` refuses to guess when two boards are plugged in, because
  opening the wrong port resets the wrong board.
- The camera and header pin maps are the XIAO ESP32-S3 Sense's. Another
  ESP32-S3 board will need those changed.
- There is no networking. The board reports over USB and nothing else, and
  there is nothing to configure.
- `buildd.py` runs a compiler on your machine for a page in your browser. It
  binds to loopback deliberately. Do not put it anywhere else.

---

## Third party

- [esptool-js](https://github.com/espressif/esptool-js) — writes flash from the
  browser. Loaded from a CDN at runtime, pinned to a version.
- [ESP-IDF](https://github.com/espressif/esp-idf) v5.3 and
  [esp32-camera](https://github.com/espressif/esp32-camera) — used inside the
  build container.

Both are Apache-2.0.

---

## License

MIT. See [LICENSE](LICENSE).
