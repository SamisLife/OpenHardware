/* ============================================================================
   faults.js — what went wrong, kept separate from what it probably means.
   ----------------------------------------------------------------------------
   The rule this file exists to enforce:

       A MESSAGE MAY NOT ASSERT A CAUSE THAT WAS NOT OBSERVED.

   It is written down because breaking it is the easiest mistake in this entire
   project, and the most damaging. A console whose whole product claim is that
   it tells the truth about hardware can very comfortably say:

       "check the Wi-Fi password"        for a sixty-second timeout
       "the board is not responding"     for a port this page never released
       "writing was interrupted"         for a missing firmware file
       "the claim token may have expired" for a connection that never opened

   Every one of those reads as a diagnosis and is a guess. Each sends someone
   to fix a thing that was not broken, and the true cause — a leaked handle, a
   firewall, a file that was never built — goes on being invisible because the
   interface already gave an answer.

   ----------------------------------------------------------------------------
   WHY IT IS A DATA SHAPE RATHER THAN A STYLE GUIDE

   Careful wording does not survive contact with a deadline. So the separation
   is structural: a fault has an `observed` field and a `causes` list, and the
   renderer prints them under different headings. There is nowhere to put a
   guess that makes it look like a measurement, because the only field that
   renders as a statement of fact is the one describing what was seen.

     observed   what actually happened, phrased so it could be checked
     causes     candidates, in the order worth checking. May be empty.
     next       the single most useful thing to do about it
     fatal      whether the flow can continue from here
   ========================================================================== */

export const FAULTS = {
  blocked: {
    observed: 'This page cannot reach a serial port at all.',
    causes: [],
    next: 'The reason is shown below. A simulated board is available at ?sim '
        + 'and exercises the same flow without hardware.',
    fatal: true,
  },

  no_port: {
    observed: 'No port was chosen.',
    causes: [
      'the picker was dismissed',
      'the board is not plugged in',
      'the cable carries power but not data, which is common and looks '
        + 'exactly like a dead board',
    ],
    next: 'Pick a port again. If the list was empty, try a different cable.',
  },

  /* Split from port_vanished on one observable: whether the device is still
     listed. Held-open and gone-away are opposite faults with opposite fixes,
     and guessing between them sends people to change a cable that is fine. */
  no_open: {
    observed: 'The port is still listed on the bus, and it would not open.',
    causes: [
      'another tab with this page open',
      'a serial monitor left running in another program',
      'an earlier session on this page that has not let go',
    ],
    next: 'Reload this page to rule out the last one, then unplug the board and '
        + 'plug it back in.',
  },

  port_vanished: {
    observed: 'The port stopped being listed while it was being opened, twice.',
    causes: [
      'the board is resetting repeatedly, which takes the whole USB device off '
        + 'the bus each time',
      'a loose cable',
    ],
    next: 'Nothing is holding the port — it stopped being there. If the board '
        + 'is in a boot loop, hold its BOOT button and tap RESET to park it in '
        + 'the ROM bootloader, which does not reset on its own.',
  },

  no_manifest: {
    observed: 'The server published no firmware image, or one this page cannot use.',
    causes: [
      'the file server is rooted somewhere other than the repository, so the '
      + 'page loads and only the firmware path is missing',
      'the firmware has not been built and packaged yet',
    ],
    next: 'Nothing was written to the board. The exact URL that failed is in the '
        + 'monitor beside this — if the page itself loaded, compare the two. '
        + 'Serve the repository root, then build with tools/build.sh and publish '
        + 'with tools/package.sh.',
  },

  fetch_failed: {
    observed: 'An image could not be downloaded, or did not match its published hash.',
    causes: [
      'a truncated or interrupted download',
      'a published hash that does not describe the file being served',
    ],
    /* Reachable only before the chip is opened, which is why this can be said
       with certainty rather than hedged. */
    next: 'Nothing was written to the board — it is exactly as it was.',
  },

  no_chip: {
    observed: 'The port opened for the flasher and no chip answered on it.',
    causes: [
      'the board is running an application that refuses the automatic reset',
      'the port belongs to something that is not a board',
    ],
    next: 'Put the board in download mode by hand — hold BOOT, tap RESET, release '
        + 'BOOT — and try again.',
  },

  flash_failed: {
    observed: 'The chip answered, and then the write did not finish.',
    causes: [
      'the cable moved',
      'the board lost power partway through',
    ],
    next: 'Nothing is bricked: the ROM bootloader is in mask ROM and cannot be '
        + 'overwritten. Unplug, plug back in, and write again.',
  },

  no_reopen: {
    observed: 'The board was reset after writing and did not reappear on the bus.',
    causes: [
      'it re-enumerated as a device this page has no permission for',
      'it did not restart',
    ],
    next: 'The image was written. Unplug the board, plug it back in, and connect '
        + 'again.',
  },

  no_hello: {
    observed: 'The port opened and stayed open, and nothing identifiable arrived.',
    causes: [
      'the board is running firmware that does not speak this protocol',
      'it is sitting in its bootloader rather than running an application',
      'it is still starting up',
    ],
    next: 'Anything the board did say is in the monitor beside this. Look there '
        + 'first — during bring-up it is usually already the answer.',
  },

  /**
   * Written, reset, came back — and said nothing at all.
   *
   * Separate from no_hello because the circumstances are different and so is
   * the first thing to try. Nothing arriving from a board that was just
   * written to and reset is most often a board that came back in its download
   * mode rather than running the image, and a board in download mode is
   * silent by design: it answers a protocol and volunteers nothing.
   */
  silent_after_write: {
    observed: 'The image was written and the board reset, and nothing has '
            + 'arrived since — not the new firmware, and not the boot messages '
            + 'that come before it.',
    causes: [
      'the board came back in its download mode instead of running the image, '
      + 'which is silent by design',
      'the image was written but does not start',
    ],
    next: 'Unplug the board and plug it back in, then connect again. A power '
        + 'cycle leaves download mode, and it is the difference between a '
        + 'board that will not run and one that was never asked to. If it is '
        + 'still silent, close this page and run tools/monitor.py — a serial '
        + 'port is exclusive, so that reads the board with nothing else in the '
        + 'way, and it settles whether the board is quiet or this page is deaf.',
  },

  /**
   * The distinction this fault exists to draw is the one the project is about.
   *
   * Every other reading here is about the board. This one is not: the page
   * never attached a reader, so it has heard nothing and knows nothing, and
   * the board may be streaming perfectly the whole time. No cause here names
   * the hardware, because none was observed.
   */
  read_failed: {
    observed: 'The port opened but this page never started reading from it, so '
            + 'nothing has been heard and nothing can be concluded about the '
            + 'board.',
    causes: [
      'the flashing library still holds the stream, so a second reader cannot '
      + 'attach to it',
      'another tab or program has the port — a serial port is exclusive '
      + 'machine-wide',
    ],
    next: 'Reload the page and connect again. To see what the board is doing '
        + 'meanwhile, close this page and run tools/monitor.py, which reads it '
        + 'with nothing else in the way.',
  },

  /* ---- the network rung -------------------------------------------------
     Everything here is recoverable and none of it stops telemetry, which runs
     over the cable regardless. The `next` lines say so, because a fault that
     reads as terminal when it is not is its own kind of false report. */

  no_ssid: {
    observed: 'No network name was given.',
    causes: ['the field was left empty'],
    next: 'Type the name of a 2.4 GHz network, or skip — the board reports over '
        + 'the cable either way.',
  },

  no_prov_ack: {
    observed: 'The credentials were sent three times and the board never '
            + 'confirmed storing them.',
    causes: [
      'the frames are not reaching the board',
      'the board is running firmware that does not answer a prov frame',
    ],
    next: 'Nothing has been stored, so the board is unchanged. Telemetry over '
        + 'the cable is unaffected — skip the network, or re-flash and try again.',
  },

  /* Split from no_prov_ack on an actual measurement rather than a guess: the
     board reports how many bytes it has ever received, and zero after three
     sends means the inbound half of the link is dead. That is a different
     fault in a different place from a frame that arrived and was ignored. */
  nothing_arrives: {
    observed: 'The board reports that it has never received a single byte from '
            + 'this page, after three attempts to send.',
    causes: [
      'the port is open for reading but writes are not reaching the board',
      'something else holds the port and is absorbing the writes',
    ],
    next: 'Reload the page and connect again. The board itself is fine — it is '
        + 'still reporting, which is how this was measured.',
  },

  prov_refused: {
    observed: 'The board received the credentials and refused to store them.',
    causes: [
      'the name was empty or longer than the board can hold',
      'the stored settings could not be written to flash',
    ],
    next: 'The board reported the reason beside this. Its previous settings are '
        + 'unchanged.',
  },

  /* The board said why. That sentence is its observation, not this page's, and
     it is passed through rather than paraphrased. */
  wifi_failed: {
    observed: 'The board stored the credentials and could not join the network.',
    causes: [
      'the passphrase was rejected',
      'the network is 5 GHz only — this radio is 2.4 GHz',
      'the access point is out of range',
    ],
    next: 'The board is still retrying, backing off as it goes, and it will join '
        + 'on its own if the network appears. Telemetry over the cable is '
        + 'unaffected.',
  },

  wifi_silent: {
    observed: 'The board stored the credentials and then said nothing about '
            + 'joining.',
    causes: [
      'the join is still in progress and is taking longer than the wait allowed',
      'the firmware stored the network but never attempted it',
    ],
    next: 'The board keeps trying on its own. Watch the monitor beside this for '
        + 'a wifi_ok or wifi_fail, or carry on over the cable.',
  },

  link_dropped: {
    observed: 'The link to the board closed part-way through.',
    causes: ['the cable moved', 'the board reset'],
    next: 'Reconnect and try again.',
  },

  no_beat: {
    observed: 'The board identified itself and then sent no telemetry.',
    causes: [
      'firmware older than this page expects',
      'a panic shortly after boot',
    ],
    next: 'Check the monitor for a panic just after the identity frame.',
  },

  link_dropped: {
    observed: 'The board closed the serial link.',
    causes: [
      'it reset',
      'it was unplugged',
      'the operating system suspended the device',
    ],
    next: 'Connect again. Nothing was written to the board.',
  },
};

/**
 * Build a fault for display.
 *
 * `raw` is whatever the underlying API said, kept verbatim and separate. It is
 * frequently the only precise thing available, and paraphrasing it loses the
 * one string somebody could search for.
 */
export function fault(code, raw = null) {
  const known = FAULTS[code];
  if (!known) {
    /* An unrecognised failure still gets reported honestly rather than being
       flattened into the nearest familiar one. */
    return {
      code,
      observed: 'Something failed that this page has no specific description for.',
      causes: [],
      next: 'The underlying error is below.',
      raw: raw ? String(raw) : null,
      fatal: false,
    };
  }
  return { code, ...known, raw: raw ? String(raw) : null };
}
