/* ============================================================================
   guide.js — bring-up, described for a reader that cannot see the page.
   ----------------------------------------------------------------------------
   The bring-up ladder is drawn for a person. An agent in the browser reaches
   the same page through tools, and a tool that answers "no board is linked"
   has said what is wrong and nothing about what to do next. This turns the
   session's state into the missing half: which decision the flow is waiting
   on, which button answers it, what each button does, and which of them only
   a person can press.

   Nothing here is inferred. Every sentence is derived from a state the session
   already holds. The one rule added is the one the page cannot observe from
   inside: a serial port is chosen in the browser's own picker, which no script
   can drive.

   Pure: a function of the session state, so it can be checked without a DOM
   and without a board.
   ========================================================================== */

/** The flow, once, as sentences a model can plan against. */
export const HOW_IT_WORKS = [
  'Bring-up runs six rungs: connect, flash, boot, identify, network, telemetry. '
    + 'Two of them stop and ask, and the buttons on the page answer them.',
  'Only a person can choose a serial port. The picker is a native browser dialog '
    + 'that no tool or script can drive.',
  'The flash decision compares the firmware the board reports with the image this '
    + 'page publishes. "Continue with it" keeps what is on the board and writes '
    + 'nothing. "Restore baseline" writes the known-safe factory image; stored data is '
    + 'erased only when that option is selected.',
  'The network fork is optional. Telemetry runs over the cable either way, so '
    + '"Skip — use the cable" is a complete answer.',
  'Write tools register once the board is linked. Until then get_board reports '
    + 'link "offline" and the write tools do not exist.',
  'With no hardware, open the page with ?sim: a simulated board runs the same '
    + 'flow, and the same buttons answer it.',
];

/**
 * @param {object} state  a Session's state
 * @returns {object|null} phase, rungs, board, fault, waitingOn, next, howItWorks
 */
export function describeBringUp(state) {
  if (!state) return null;

  const rungs = Object.values(state.rungs || {}).map(r => ({
    id: r.id, title: r.title, state: r.state, detail: r.detail || '',
  }));
  const waitingOn = waiting(state);

  return {
    phase: state.phase,
    active: state.active ?? null,
    simulated: !!state.simulated,
    blocked: state.blocked ?? null,
    rungs,
    board: {
      firmware: state.hello?.fw ?? state.found?.fw ?? null,
      published: state.published?.version ?? null,
      /** 'same' | 'differs' | null — how the two compare, when both are known. */
      comparison: state.published?.action ?? null,
      network: state.net ?? null,
    },
    fault: state.fault
      ? { code: state.fault.code, observed: state.fault.observed, causes: state.fault.causes,
          next: state.fault.next, raw: state.fault.raw ?? null }
      : null,
    waitingOn,
    next: waitingOn.what,
    howItWorks: HOW_IT_WORKS,
  };
}

/**
 * What the flow is waiting on, and the buttons that answer it.
 *
 * `needsPerson` marks the choices that are a person's: choosing a port, writing
 * firmware, typing credentials. The others write nothing and keep the flow
 * moving, and an agent that can reach the page may press them.
 */
function waiting(s) {
  const opt = (label, does, needsPerson) => ({ label, does, needsPerson });

  if (s.phase === 'done') {
    return { who: 'nobody', what: 'The board is linked and reporting. Write tools are registered.', options: [] };
  }

  if (s.phase === 'working') {
    const detail = s.rungs?.[s.active]?.detail || s.active || 'bring-up in progress';
    return { who: 'board', what: `Working: ${detail}. Nothing to press.`, options: [] };
  }

  if (s.phase === 'fault' && s.fault) {
    const options = [opt('Try again', 'retries the step that failed', false)];
    if (s.hasPort) {
      options.push(opt('Write baseline',
        'writes the known-safe baseline over whatever is on the board; a person decides', true));
    }
    return { who: 'person', what: s.fault.next, options };
  }

  if (s.phase === 'decide' && s.rungs?.network?.state === 'ask') {
    return {
      who: 'person',
      what: 'Choose whether the board joins a Wi-Fi network. Telemetry runs over the cable '
          + 'either way, so "Skip — use the cable" is the normal answer.',
      options: [
        opt('Skip — use the cable', 'carries on over the cable; a complete answer', false),
        opt('Join this network',
          'stores the credentials typed into the form and asks the board to join; a person types them', true),
      ],
    };
  }

  if (s.phase === 'decide') {
    const fw = s.hello?.fw || s.found?.fw || null;
    const version = s.published?.version || null;

    if (s.found?.known) {
      const cmp = s.published?.action === 'same'
        ? ' It matches the known-safe baseline.'
        : s.published?.action === 'differs' && version
          ? ` The known-safe baseline is ${version}, built from different source.`
          : '';
      return {
        who: 'person',
        what: `The board is already running ${fw || 'firmware this page can read'}.${cmp} `
            + '"Continue with it" keeps it and writes nothing; that is the normal choice.',
        options: [
          opt('Continue with it', `keeps ${fw || 'what is on the board'} and writes nothing`, false),
          opt(version ? `Restore baseline ${version}` : 'Restore baseline',
            'writes the known-safe baseline over the board; a person decides', true),
        ],
      };
    }

    const lines = s.found?.lines || 0;
    return {
      who: 'person',
      what: lines
        ? `The board sent ${lines} lines of output and none were recognised. Writing the `
          + 'known-safe baseline replaces whatever it runs; listening keeps watching it.'
        : 'The port is open and the board has sent nothing; it may be sitting in its '
          + 'bootloader. Writing the known-safe baseline is the usual answer.',
      options: [
        opt(version ? `Write baseline ${version}` : 'Write baseline', 'writes the known-safe baseline; a person decides', true),
        opt('Listen anyway', 'keeps listening without writing', false),
      ],
    };
  }

  /* idle */
  if (s.blocked && !s.simulated) {
    return {
      who: 'person',
      what: `${s.blocked} With no hardware, open the page with ?sim for a simulated board.`,
      options: [],
    };
  }
  return {
    who: 'person',
    what: 'Press "Connect a board" and choose the serial port in the browser\'s picker. '
        + 'Only a person can choose a port. With no hardware, open the page with ?sim.',
    options: [
      opt(s.hasPort ? 'Connect again' : 'Connect a board',
        'opens the port picker; the choice itself is a person\'s', true),
    ],
  };
}
