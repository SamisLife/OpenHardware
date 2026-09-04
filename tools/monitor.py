"""
monitor.py — watch a board over the cable, without a browser in the way.

The other two scripts in this directory write to a board. This one reads one
back, and it exists because until it did there was no way to observe the
hardware that did not route through Web Serial, the flasher, the bring-up state
machine and four renderers all being correct at the same moment. A board that
appears silent through that path has told nobody which of the five went wrong.

RUNS ON THE HOST, NOT IN THE CONTAINER
    manifest.py runs inside the toolchain image, where the build volume is
    mounted. This one cannot: Docker has no view of a host serial port. The one
    dependency is pyserial.

        pip install pyserial
        tools/monitor.py

THE PORT IS EXCLUSIVE, MACHINE-WIDE
    Nothing else may hold it while this runs — not the console page, not
    another copy of this script. That is the point rather than a limitation.
    Removing the browser from the picture is what makes the reading evidence
    about the firmware instead of evidence about the whole stack.

IT WRITES ONLY WHEN ASKED
    --cam turns the camera on and --scan probes the header, and then both go on
    watching, so the acknowledgement and whatever follows land on the same
    record as everything else. Those are the only frames this tool sends.
    They are here because the port is exclusive: something has to
    be able to drive a board while the page that would normally do it cannot
    hold the port — which also makes this the way to tell a board that will not
    stream from a page that cannot ask it to.

WHAT IT IS ACTUALLY FOR
    The board already reports everything needed to tell a reboot from a stall:
    `reset` and `boot_id` in every identity frame, `uptime_s` in every beat. It
    has simply never been read. A board that streams for a few seconds, stops,
    and repeats is either restarting — a fresh boot_id, an uptime back near
    zero, and a reset reason that names the kind — or it never stopped at all
    and the transmit path blocked, in which case uptime climbs straight through
    the gap and boot_id never changes. Those two have nothing in common and no
    shared fix, so the summary printed on exit answers that question first.
"""

import argparse
import json
import re
import sys
import time

# Missing pyserial is reported by main(), not here.
#
# Everything above the port — the framing, the CRC, the boot accounting — is
# ordinary code with no hardware behind it, and it is the half worth testing.
# Exiting at import time would make it unimportable, so the one dependency
# would decide whether the protocol could be checked at all.
try:
    import serial
    from serial.tools import list_ports
except ImportError:
    serial = list_ports = None


# Mirrors frontend/js/link/protocol.js, which is the specification, and
# hw_proto.c, which is the board's own implementation. A third independent
# copy is deliberate for the same reason the second one is: the CRC is what
# proves they agree, and a shared implementation would prove nothing. If this
# file ever disagrees with the other two, one of the three is wrong and the
# disagreement is the finding.
SENTINEL = '#OHW1 '
LINE_MAX = 768

# A frame is anything shaped like one: a hash, four characters, a space. Only
# the exact sentinel above is decoded, but recognising the others is what lets
# a board running somebody else's firmware be reported as that, rather than as
# a board that said nothing. The predecessor project's sentinel is the one that
# actually turns up, because the same hardware runs both.
FOREIGN_RE = re.compile(r'^#([A-Z0-9]{4}) \{')

# Six missed beats at 4 Hz. Past this the board has stopped reporting, which is
# a fact worth a line on the record rather than a gap nobody notices.
SILENCE_S = 1.5

# Espressif's USB Serial/JTAG device. The reference hardware has no bridge
# chip, so this identifies the chip itself rather than an adapter in front of
# one.
ESPRESSIF_VID = 0x303A
USB_JTAG_PID = 0x1001


# ---------------------------------------------------------------------------
# the protocol
# ---------------------------------------------------------------------------

def crc16(data: bytes) -> int:
    """CRC-16/CCITT-FALSE. crc16(b'123456789') is 0x29B1."""
    crc = 0xFFFF
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


def encode_frame(obj) -> bytes:
    """
    One object as a framed line, newline included.

    The only thing this tool ever writes. It exists so a board can be driven
    without a browser: the port is exclusive machine-wide, so while this is
    watching it is the only thing that could have asked for anything.

    Refused rather than truncated when it will not fit. A frame the far end is
    guaranteed to drop is better rejected here, where the caller is still
    standing there, than sent and silently ignored.
    """
    body = json.dumps(obj, separators=(',', ':'))
    raw = body.encode('utf-8')
    line = '%s%s *%04X\n' % (SENTINEL, body, crc16(raw))
    if len(line) > LINE_MAX:
        raise ValueError('frame is %d characters, over the %d limit'
                         % (len(line), LINE_MAX))
    return line.encode('utf-8')


def decode_line(line):
    """
    One line, decoded.

    Returns (frame, None) for a valid frame, (None, None) for anything not
    addressed to this protocol, and (None, reason) for something that claimed
    to be a frame and was not.

    The reason is kept because the three failures point at different places. A
    CRC mismatch means the line was corrupted or truncated in transit; a JSON
    failure means the bytes arrived exactly as sent and whatever produced them
    emitted malformed JSON, so the fault is upstream of the wire.
    """
    if not line.startswith(SENTINEL):
        return None, None

    # Searched from the right so a payload containing " *" cannot end the frame
    # early — a JSON string is free to contain one.
    star = line.rfind(' *')
    if star < len(SENTINEL) or len(line) - star < 6:
        return None, 'no-crc-suffix'

    body = line[len(SENTINEL):star]
    try:
        want = int(line[star + 2:star + 6], 16)
    except ValueError:
        return None, 'no-crc-suffix'

    if crc16(body.encode('utf-8', 'surrogateescape')) != want:
        return None, 'crc'

    try:
        return json.loads(body), None
    except ValueError:
        return None, 'json'


# ---------------------------------------------------------------------------
# finding a board without disturbing it
# ---------------------------------------------------------------------------

def find_port(explicit=None):
    """
    The port to open, chosen without opening anything.

    Opening a port asserts DTR and RTS, which on hardware with native USB are
    wired to reset and boot select — so probing ports to see which one answers
    resets the board being probed, and resets every other board on the machine
    on the way past. Candidates are identified by their USB descriptors, which
    costs them nothing.

    More than one match is refused rather than guessed at. Picking the first of
    two boards is right half the time and silently resets the wrong one the
    other half.
    """
    if explicit:
        return explicit

    ports = list(list_ports.comports())
    matches = [p for p in ports
               if p.vid == ESPRESSIF_VID and p.pid == USB_JTAG_PID]

    if len(matches) == 1:
        return matches[0].device

    if not matches:
        if not ports:
            sys.exit('no serial ports at all. Is the board plugged in?')
        listed = '\n'.join('    %-8s %s' % (p.device, p.description) for p in ports)
        sys.exit('no Espressif USB Serial/JTAG device among the ports present:\n\n'
                 + listed + '\n\nName one with --port if the board is behind a bridge chip.')

    listed = '\n'.join('    %-8s %s' % (p.device, p.description) for p in matches)
    sys.exit('more than one board is attached, and opening the wrong one would '
             'reset it:\n\n' + listed + '\n\nName one with --port.')


def open_port(name, baud):
    """
    Open without touching the reset and boot lines.

    pyserial asserts DTR and RTS on open by default. On this hardware DTR low
    with RTS high is the state that holds GPIO0 down — it is literally the
    "set IO0" step of esptool's own USB-JTAG reset sequence — so a monitor that
    opens carelessly can leave the board in its ROM downloader, where it emits
    nothing at all and looks exactly like the failure being investigated.
    Both lines are set idle before the port is opened, never after.
    """
    port = serial.Serial()
    port.port = name
    port.baudrate = baud
    # Short, so a board that has gone quiet still lets the read loop round and
    # notice the silence. Blocking until a byte arrives would mean the gap
    # could only ever be reported late, after the board came back.
    port.timeout = 0.1
    port.dtr = False
    port.rts = False
    port.open()
    return port


# ---------------------------------------------------------------------------
# output
# ---------------------------------------------------------------------------

class Out:
    """
    Colour when a terminal is watching, plain text when a file is.

    A log piped to a file is read later by somebody trying to work out what
    happened, and escape sequences in it are noise at exactly the moment
    legibility matters most.
    """

    COLOURS = {
        'boot': '\033[1;35m', 'frame': '\033[36m', 'meta': '\033[2m',
        'bad': '\033[33m', 'gap': '\033[1;31m', 'text': '',
    }

    def __init__(self, colour=True, log=None):
        # A Windows console defaults to a code page that cannot represent the
        # characters used below, and printing one RAISES rather than degrading
        # — so the first boot banner would end the session with a traceback
        # about charmap, during the reboot it was opened to observe. UTF-8 with
        # replacement means the worst case is a wrong-looking dash.
        try:
            sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        except (AttributeError, ValueError):
            pass

        self.colour = colour and sys.stdout.isatty()
        self.log = log
        if self.colour and sys.platform == 'win32':
            self._enable_windows_vt()
        self.t0 = time.time()

    @staticmethod
    def _enable_windows_vt():
        """Older Windows consoles need to be told they understand ANSI."""
        try:
            import ctypes
            k = ctypes.windll.kernel32
            k.SetConsoleMode(k.GetStdHandle(-11), 7)
        except Exception:
            pass

    def line(self, kind, text):
        # A separator is a separator. Stamping one puts a timestamp on the
        # absence of an event.
        if not text:
            print()
            if self.log:
                self.log.write('\n')
            return

        stamp = '%8.3f' % (time.time() - self.t0)
        plain = '%s  %s' % (stamp, text)
        if self.log:
            self.log.write(plain + '\n')
            self.log.flush()
        if self.colour and self.COLOURS.get(kind):
            print('\033[2m%s\033[0m  %s%s\033[0m' % (stamp, self.COLOURS[kind], text))
        else:
            print(plain)
        sys.stdout.flush()


# ---------------------------------------------------------------------------
# bytes into lines
# ---------------------------------------------------------------------------

class LineReader:
    """
    A byte stream, split into lines, bounded.

    Separate from the read loop because it is the half with rules in it and no
    hardware behind it, and a rule that cannot be exercised without a board
    attached is one nobody exercises.

    The bound is the point. A line longer than the limit contains no frame, and
    a reader that keeps buffering one lets anything on the wire decide how much
    memory this uses. The overlong line alone is abandoned and the reader
    resynchronises on the next newline, so one bad line costs one bad line
    rather than taking the frames queued behind it with it.
    """

    def __init__(self, limit=LINE_MAX):
        self.limit = limit
        self.buf = ''
        self.skipping = False
        self.dropped = 0

    def push(self, chunk):
        """@return the complete lines this chunk finished, in order."""
        self.buf += chunk
        lines = []

        while True:
            nl = self.buf.find('\n')
            if nl < 0:
                break
            line = self.buf[:nl].rstrip('\r')
            self.buf = self.buf[nl + 1:]

            if self.skipping:
                # The overlong line ended here. Resynchronised.
                self.skipping = False
                continue
            if line:
                lines.append(line)

        if len(self.buf) > self.limit:
            self.buf = ''
            self.skipping = True
            self.dropped += 1

        return lines

    def reset(self):
        """A board that left the bus takes any half-line with it."""
        self.buf = ''
        self.skipping = False


# ---------------------------------------------------------------------------
# the watch
# ---------------------------------------------------------------------------

class Watch:
    """
    What has been seen, and the one question it exists to answer.

    A boot is counted when the board says so — a fresh boot_id — and also when
    uptime goes backwards, because an identity frame can be missed while a beat
    two hundred milliseconds later cannot be mistaken. Either way what gets
    recorded is how long the board survived, which is the number that says
    whether it died at a fixed point after boot or at an arbitrary one.
    """

    def __init__(self, out, show_beats=False, clock=time.time):
        self.out = out
        self.show_beats = show_beats
        # Injected so the silence rule and the verdict can be exercised without
        # a test spending six real seconds proving a six-second timeout.
        self.clock = clock

        self.boot_id = None
        self.boots = []          # {'id', 'reset', 'lasted'}
        self.uptime = None
        self.last_beat = 0.0
        self.beats = 0
        self.silent = False
        self.bad = {}
        self.text_lines = 0
        self.enumerations = 0
        # Sentinels seen that are not this protocol's, by name and count.
        self.foreign = {}
        # Pictures, and the bytes in them. Counted because "the camera streams"
        # is a claim that should rest on frames arriving, not on an ack.
        self.images = 0
        self.image_bytes = 0
        # Whether --cam was used, and what the board said about it.
        self.asked_cam = False
        self.cam_ack = None
        self.cam_err = None
        self.app_identity = None
        self.app_state = None
        self.app_beat_seen = False
        self.rx_bytes = None
        self.rx_rescued = 0

    # ---- boots ----------------------------------------------------------

    def _new_boot(self, boot_id, reset, how):
        lasted = self.uptime
        if self.boots:
            self.boots[-1]['lasted'] = lasted

        self.boots.append({'id': boot_id, 'reset': reset, 'lasted': None})
        self.boot_id = boot_id
        self.uptime = None

        if len(self.boots) > 1:
            # The whole reason this tool exists gets the loudest line it has.
            self.out.line('boot', '── BOOT %d ── %s · reset %s · previous boot lasted %s (%s)'
                          % (len(self.boots), boot_id, reset or 'unreported',
                             ('%.2f s' % lasted) if lasted is not None else 'unknown',
                             how))
        else:
            # The first boot needs no explanation when the board announced it.
            # It needs one when it did not — "reset unreported" on its own
            # reads like a board that failed to say, rather than a monitor that
            # arrived after it had already said.
            self.out.line('boot', '── BOOT 1 ── %s · reset %s%s'
                          % (boot_id, reset or 'unreported',
                             '' if how == 'it said so' else ' (%s)' % how))

    # ---- frames ---------------------------------------------------------

    def frame(self, f):
        t = f.get('t')

        if t == 'hello':
            boot_id = f.get('boot_id')
            if boot_id and boot_id != self.boot_id:
                self._new_boot(boot_id, f.get('reset'), 'it said so')
                # Said once per boot rather than every 700 ms. Which image is
                # running is the first thing to establish and the last thing
                # worth repeating.
                self.out.line('meta', '   fw %s · sha %s · slot %s%s · %s · psram %s · heap %s of %s'
                              % (f.get('fw', '?'), f.get('sha', '?'), f.get('slot', '?'),
                                 (' (%s)' % f['ota']) if f.get('ota') else '',
                                 f.get('mac', '?'), fmt(f.get('psram')),
                                 fmt(f.get('heap')), fmt(f.get('heap_total'))))
                app = f.get('app')
                if isinstance(app, dict):
                    self.app_identity = (app.get('name'), app.get('ver'))
                    self.app_state = app.get('state')
                    crashes = app.get('crashes')
                    self.out.line('meta', '   app %s %s · %s%s'
                                  % (app.get('name', '?'), app.get('ver', '?'),
                                     app.get('state', 'unreported'),
                                     ' · %s crash boots' % crashes
                                     if crashes is not None else ''))
            rx = f.get('rx')
            if isinstance(rx, int) and rx != self.rx_bytes:
                if self.rx_bytes is not None:
                    self.out.line('meta', '   inbound bytes %s -> %s' % (self.rx_bytes, rx))
                self.rx_bytes = rx
            # Bytes the harness took straight out of the OUT FIFO because they
            # landed before its driver existed. A non-zero count is the boot
            # window's early write being rescued rather than blocking the port.
            rescued = f.get('rx_rescued')
            if isinstance(rescued, int) and rescued and rescued != self.rx_rescued:
                self.out.line('meta', '   %s bytes rescued from the USB OUT FIFO at boot' % rescued)
                self.rx_rescued = rescued
            return

        if t == 'beat':
            return self._beat(f)

        if t in ('img', 'imgd'):
            # Chunks arrive in their dozens. The header carries everything a
            # reader needs; the chunks would bury every other line on screen.
            if t == 'img':
                self.images += 1
                try:
                    self.image_bytes += int(f.get('bytes') or 0)
                except (TypeError, ValueError):
                    pass
                self.out.line('frame', '< img #%s · %sx%s · %s bytes in %s chunks'
                              % (f.get('seq'), f.get('w'), f.get('h'),
                                 f.get('bytes'), f.get('chunks')))
            return

        if t == 'scan_ack':
            if f.get('ok'):
                found = f.get('found') or []
                names = ', '.join('0x%02x%s' % (d.get('addr', 0), (' (%s)' % d['id']) if d.get('id') else '')
                                  for d in found)
                self.out.line('frame', '< scan_ack i2c0 sda %s scl %s · %s found in %s ms%s'
                              % (f.get('sda'), f.get('scl'), len(found), f.get('ms'),
                                 (' · ' + names) if names else ''))
            else:
                self.out.line('frame', '< scan_ack failed · %s%s'
                              % (f.get('err'), (' (%s low)' % f['line']) if f.get('line') else ''))
            return

        if t == 'cam_ack':
            self.cam_ack = bool(f.get('on'))
            self.cam_err = f.get('err') or None
            self.out.line('frame', '< cam_ack on=%s%s'
                          % (self.cam_ack, ' · %s' % self.cam_err if self.cam_err else ''))
            return

        if t == 'cfg_ack':
            self.out.line('frame', '< cfg_ack ok=%s%s%s'
                          % (bool(f.get('ok')),
                             ' · %s q%s' % (f.get('size'), f.get('quality'))
                             if f.get('ok') else '',
                             ' · %s' % f.get('err') if f.get('err') else ''))
            return

        if t == 'activate_ack':
            self.out.line('frame', '< activate_ack ok=%s%s%s' % (
                f.get('ok'),
                ' slot=%s' % f.get('slot') if f.get('slot') else '',
                ' err=%s' % f.get('err') if f.get('err') else ''))
            return

        if t == 'log' and f.get('src') == 'app':
            self.out.line('frame', '   app: %s' % (f.get('msg') or ''))
            return

        if t == 'status':
            detail = f.get('detail')
            self.out.line('meta', '< status %s%s'
                          % (f.get('stage', '?'), ' · %s' % detail if detail else ''))
            return

        self.out.line('frame', '< %s %s' % (t, json.dumps(
            {k: v for k, v in f.items() if k != 't'}, separators=(',', ':'))))

    def _beat(self, b):
        now = self.clock()
        up = b.get('uptime_s')

        # Attaching to a board that has been running a while means the first
        # thing seen is a beat, not an identity frame — hello is only sent
        # every five seconds once the fast window has closed. Registering the
        # boot here rather than waiting means the count is right from the
        # start, and the reset reason stays absent because none was reported.
        if self.boot_id is None and b.get('boot_id'):
            self._new_boot(b['boot_id'], None, 'attached mid-session')

        # An uptime that went backwards is a restart, whether or not the
        # identity frame announcing it arrived. Trusting only hello would mean
        # a reboot during a burst of output goes uncounted.
        if isinstance(up, (int, float)) and self.uptime is not None and up < self.uptime - 0.5:
            self._new_boot(b.get('boot_id') or '(unreported)', None, 'uptime went backwards')

        if self.silent:
            self.out.line('gap', '   ── the board is reporting again after %.1f s ── '
                                 'uptime %s, so it %s'
                          % (now - self.last_beat,
                             ('%.2f s' % up) if isinstance(up, (int, float)) else 'unknown',
                             self._verdict(up, now)))
            self.silent = False

        if isinstance(up, (int, float)):
            self.uptime = up
        self.last_beat = now
        self.beats += 1

        app = b.get('app')
        if isinstance(app, dict):
            state = app.get('state')
            metrics = app.get('m') if isinstance(app.get('m'), dict) else {}
            first = not self.app_beat_seen
            changed = state != self.app_state
            self.app_state = state
            self.app_beat_seen = True
            if first or changed or self.show_beats:
                rendered = ', '.join('%s=%s' % (k, fmt(v))
                                     for k, v in sorted(metrics.items()))
                self.out.line('text', '   app %s · loops=%s%s'
                              % (state or 'unreported', fmt(app.get('loops')),
                                 ' · ' + rendered if rendered else ''))

        if self.show_beats:
            self.out.line('text', '   beat up=%s heap=%s psram=%s temp=%s fps=%s'
                          % (fmt(b.get('uptime_s')), fmt(b.get('heap_free')),
                             fmt(b.get('psram_free')), fmt(b.get('temp_c')),
                             fmt(b.get('fps'))))

    def _verdict(self, up, now):
        """
        The reading, stated at the moment it can be taken.

        Silence is the only symptom either explanation produces, so the verdict
        has to be read off the first beat that comes back rather than off the
        gap itself.
        """
        if not isinstance(up, (int, float)):
            return 'reported no uptime'
        gap = now - self.last_beat
        if up < gap:
            return 'restarted during the gap'
        return 'never restarted — the transmit path stalled'

    # ---- everything else on the wire -------------------------------------

    def text(self, line, reason):
        self.text_lines += 1

        m = FOREIGN_RE.match(line)
        if m:
            tag = m.group(1)
            first = tag not in self.foreign
            self.foreign[tag] = self.foreign.get(tag, 0) + 1
            # Said once per sentinel. A board speaking a different protocol
            # emits these at 4 Hz, and the finding is the sentinel, not the
            # count of how often it repeated.
            if first:
                self.out.line('bad', '! this board speaks #%s, not %s — its frames '
                                     'are readable but not this protocol'
                              % (tag, SENTINEL.strip()))
            self.out.line('text', '  %s' % line)
            return

        if reason:
            self.reject(reason)
            self.out.line('bad', '! %s (%s)' % (line, reason))
        else:
            self.out.line('text', '  %s' % line)

    def reject(self, reason):
        """A line that claimed to be a frame and was not, counted by kind."""
        self.bad[reason] = self.bad.get(reason, 0) + 1

    def tick(self):
        """Called between reads. Turns absence into a line on the record."""
        if self.silent or not self.last_beat:
            return
        if self.clock() - self.last_beat > SILENCE_S:
            self.silent = True
            self.out.line('gap', '   ── no telemetry ── last beat at uptime %s'
                          % (('%.2f s' % self.uptime) if self.uptime is not None else 'unknown'))

    def left_bus(self):
        self.enumerations += 1
        self.out.line('gap', '   ── the device left the USB bus ── '
                             'a reset on this part takes the whole endpoint down')

    # ---- the answer ------------------------------------------------------

    def summary(self):
        out = self.out
        out.line('meta', '')
        out.line('boot', '── summary ──')
        out.line('meta', '   %s, %s, %s of other output, %s'
                 % (plural(len(self.boots), 'boot'), plural(self.beats, 'beat'),
                    plural(self.text_lines, 'line'),
                    plural(self.enumerations, 'bus disappearance')))

        if self.images:
            out.line('meta', '   %s carrying %d bytes of picture'
                     % (plural(self.images, 'image'), self.image_bytes))

        for tag, n in sorted(self.foreign.items()):
            out.line('bad', '   %s framed as #%s, a protocol this tool does not read'
                     % (plural(n, 'line'), tag))

        # The boot still running has no recorded duration — it has not ended —
        # so its figure comes from the last beat instead. Absent stays absent
        # for any boot whose beats were missed entirely.
        for i, b in enumerate(self.boots, 1):
            lasted = self.uptime if i == len(self.boots) else b['lasted']
            out.line('meta', '   boot %-2d %s · reset %-9s · lasted %s'
                     % (i, b['id'], b['reset'] or 'unreported',
                        ('%.2f s' % lasted) if lasted is not None else 'unknown'))

        if self.bad:
            out.line('bad', '   rejected lines: '
                     + ', '.join('%s x%d' % (k, v) for k, v in sorted(self.bad.items())))

        # Stated rather than left to be inferred, because inferring it wrongly
        # is what sent the last investigation after four hypotheses at once.
        out.line('meta', '')
        if len(self.boots) > 1:
            reasons = sorted({b['reset'] for b in self.boots[1:] if b['reset']})
            out.line('boot', '   The board restarted %s. It is not a transmit stall.'
                     % plural(len(self.boots) - 1, 'time'))
            if reasons:
                out.line('boot', '   Reset reasons after the first boot: %s' % ', '.join(reasons))
            else:
                out.line('boot', '   No reset reason was captured; the identity frames were missed.')
        elif self.asked_cam:
            # The whole point of --cam: it separates a board that will not
            # stream from a page that cannot ask it to. Both present as an
            # empty camera panel, and they are fixed in different files.
            if self.images:
                out.line('boot', '   The board streams. %s arrived after cam on, so the '
                                 'firmware and the cable are fine — a console showing no '
                                 'picture is not being answered, not being starved.'
                         % plural(self.images, 'image'))
            elif self.cam_ack is False:
                out.line('bad', '   The board refused to stream: %s' % (self.cam_err or 'no reason given'))
            elif self.cam_ack is None:
                out.line('bad', '   The board never acknowledged cam on. Nothing this tool '
                                'sent was acted on, which is a fault in the inbound path.')
            else:
                out.line('bad', '   The board acknowledged cam on and sent no pictures. '
                                'The camera is not producing frames.')
        elif self.boots and self.beats:
            out.line('boot', '   One boot, uptime never went backwards. Any gap above was the '
                             'wire, not a restart.')
        elif self.beats:
            # Beats with no boot_id anywhere in them. Older firmware, or a
            # frame shape this build does not know about — either way the
            # question cannot be answered from what arrived, and saying so is
            # the only honest option.
            out.line('bad', '   Beats arrived but none carried a boot_id, so nothing here can '
                            'tell a restart from a stall.')
        elif self.foreign:
            # The difference between "silent" and "speaking a language this
            # tool does not read" is the whole finding, and reporting the
            # second as the first sends somebody to debug a working board.
            worst = max(self.foreign.items(), key=lambda kv: kv[1])
            out.line('boot', '   This board is running other firmware. It sent %s framed as '
                             '#%s, which is not %s, so none of it could be decoded here.'
                     % (plural(worst[1], 'frame'), worst[0], SENTINEL.strip()))
            out.line('boot', '   The board is fine. Flash the published image and run this again.')
        else:
            out.line('bad', '   No beats arrived at all. Nothing here distinguishes a board that '
                            'is not running from one whose output never reached this port.')


def fmt(v):
    """A reading, or the mark this project uses everywhere for one it has not got."""
    if v is None:
        return '—'
    return ('%.2f' % v) if isinstance(v, float) else str(v)


def plural(n, noun):
    """A summary is read by somebody tired. `1 boots` costs them a moment."""
    return '%d %s%s' % (n, noun, '' if n == 1 else 's')


# ---------------------------------------------------------------------------

def run(port_name, args, out, watch, outbound=()):
    """
    Read until interrupted, reconnecting when the board leaves the bus.

    Reconnection matters here more than it would elsewhere: a reset on this
    part takes the whole USB device down and brings it back a second or two
    later, so a monitor that exits on the first disconnect can never watch the
    thing it was opened to watch.
    """
    reader = LineReader()
    port = None
    said_why = False
    # Held until the board has said it is running.
    #
    # OPENING THE PORT CAN RESET THE BOARD. The control lines are the reset and
    # boot straps on this part, so a frame written the instant the port opens is
    # written to a chip that is still in its bootloader — and it lands nowhere,
    # silently, because there is no receive task yet to land in. That produces a
    # session where the tool reports having sent something, the board reports
    # having received nothing, and the fault looks like it is in the inbound
    # path rather than in the timing.
    #
    # The board's own identity frame is the proof: it is emitted from a task,
    # after the protocol is up, which is exactly the condition for a write to be
    # read. Sent once, not on every reconnect — the board already has them, and
    # re-sending mid-join would restart the very attempt this is watching.
    pending = list(outbound)

    while True:
        if port is None:
            try:
                port = open_port(port_name, args.baud)
                out.line('meta', '   listening on %s' % port_name)
                said_why = False

                if pending:
                    out.line('meta', '   holding %s until the board says it is running'
                             % plural(len(pending), 'frame'))
            except serial.SerialException as err:
                # Said once, then retried quietly. A board that has just reset
                # is away for a second and does not need a line about it every
                # 300 ms — but the FIRST failure has to be reported, because
                # the likeliest one is the console page still holding the port,
                # and a tool that spun silently on that would be a hang with no
                # explanation. Which is the failure this whole project exists
                # to argue against.
                if not said_why:
                    out.line('bad', '! %s could not be opened: %s' % (port_name, err))
                    out.line('meta', '   a serial port is exclusive machine-wide — close the '
                                     'console page if it is open. Retrying.')
                    said_why = True
                time.sleep(0.3)
                continue

        try:
            chunk = port.read(512)
        except serial.SerialException:
            watch.left_bus()
            try:
                port.close()
            except Exception:
                pass
            port = None
            reader.reset()
            continue

        if not chunk:
            watch.tick()
            continue

        # surrogateescape: the ROM emits bytes at the wrong rate during
        # re-enumeration, and a decode error must not be allowed to end a
        # session that exists to observe exactly that moment.
        dropped = reader.dropped
        for line in reader.push(chunk.decode('utf-8', 'surrogateescape')):
            frame, reason = decode_line(line)
            if frame is not None:
                watch.frame(frame)
                # The board is up and emitting from a task, so a write now has
                # something to arrive at.
                if pending and frame.get('t') in ('hello', 'beat'):
                    for f in pending:
                        port.write(encode_frame(f))
                        out.line('meta', '   > %s'
                                 % json.dumps(f, separators=(',', ':')))
                    pending = []
            else:
                watch.text(line, reason)

        # Reported rather than silently absorbed. A run that dropped lines saw
        # less than the board sent, and a summary that did not say so would
        # describe a quieter board than the one on the bench.
        if reader.dropped != dropped:
            out.line('bad', '! a line longer than %d characters, abandoned' % LINE_MAX)
            watch.reject('overlong')

        watch.tick()


def main():
    p = argparse.ArgumentParser(
        description='Watch an OpenHardware board over the cable.',
        epilog='Nothing else may hold the port while this runs — a serial port '
               'is exclusive machine-wide, so close the console page first.')
    p.add_argument('--port', help='serial port, if more than one board is attached')
    p.add_argument('--baud', type=int, default=115200,
                   help='ignored by native USB, which has no line rate; kept for '
                        'boards reached through a bridge chip')
    p.add_argument('--beats', action='store_true',
                   help='print every beat rather than only what changes')
    p.add_argument('--log', help='write the same lines, uncoloured, to a file')
    p.add_argument('--no-color', action='store_true')

    p.add_argument('--cam', action='store_true',
                   help='turn the camera on, then count the pictures that arrive')
    p.add_argument('--scan', action='store_true',
                   help='scan the default I2C header after the board says it is running')
    p.add_argument('--cfg', metavar='SIZE',
                   help='set QQVGA, QVGA, CIF, HVGA, VGA, SVGA, XGA, HD, SXGA or UXGA')
    p.add_argument('--quality', type=int, metavar='N',
                   help='JPEG quality for --cfg (10..63); omitted uses the running value')
    args = p.parse_args()

    if args.quality is not None and not args.cfg:
        p.error('--quality requires --cfg')

    outbound = []
    if args.scan:
        outbound.append({'t': 'scan'})
    if args.cfg:
        config = {'t': 'cfg', 'size': args.cfg.upper()}
        if args.quality is not None:
            config['quality'] = args.quality
        outbound.append(config)
    if args.cam:
        outbound.append({'t': 'cam', 'on': True})


    if serial is None:
        sys.exit('monitor.py needs pyserial to reach a port:\n\n    pip install pyserial\n')

    port_name = find_port(args.port)
    log = open(args.log, 'w', encoding='utf-8') if args.log else None
    out = Out(colour=not args.no_color, log=log)
    watch = Watch(out, show_beats=args.beats)
    # Recorded on the watch, not on the arguments, because the summary is what
    # reads it — and only a run that actually asked for the camera is entitled
    # to draw a conclusion about why no pictures arrived.
    watch.asked_cam = bool(args.cam)

    out.line('meta', '   watching %s · Ctrl-C to stop' % port_name)

    try:
        run(port_name, args, out, watch, outbound=outbound)
    except KeyboardInterrupt:
        pass
    finally:
        watch.summary()
        if log:
            log.close()


if __name__ == '__main__':
    main()
