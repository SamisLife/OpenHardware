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

/**
 * What the board is running, said in terms somebody can act on.
 *
 * This replaces a sentence that was technically true and practically useless:
 * "this board is running 0.14.1, the baseline is 0.14.1, and their hashes
 * differ". Two identical version numbers and a hash mismatch describe the
 * ordinary state of a board an agent has been compiling for — it is running an
 * application built on top of that harness — and reporting it as a discrepancy
 * invited people to re-flash a board that was working perfectly.
 *
 * The distinction that matters is not whether the bytes differ. It is:
 *
 *   running    the published baseline exactly
 *   app        an application built on this harness — keep it
 *   build      some other build of this same harness — keep it
 *   outdated   a different harness version — writing the baseline is the answer
 *   unknown    firmware this page cannot read, or silence
 *
 * `recommend` is 'continue' or 'flash', and it is what decides which button
 * leads. Everything here is derived from what the board reported and what the
 * page publishes; nothing is guessed.
 *
 * @returns {{kind, headline, note, recommend, app, firmware, baseline}}
 */
export function describeRunning(state) {
  const hello = state?.hello ?? null;
  const found = state?.found ?? null;
  const pub = state?.published ?? null;
  const baseline = pub?.version || null;

  if (!hello && !found?.known) {
    const lines = found?.lines || 0;
    return {
      kind: 'unknown',
      firmware: null, app: null, baseline,
      short: lines ? `${lines} lines, none recognised` : 'no output at all',
      headline: lines
        ? `The board sent ${lines} lines of output and none of them were recognised.`
        : 'The port is open and the board has sent nothing at all.',
      note: lines
        ? 'It is running something this page cannot read. Whatever it said is on the wire beside this.'
        : 'A board that has never been written to sits in its bootloader and says nothing, which looks exactly like this.',
      recommend: 'flash',
    };
  }

  /* During the decision the identity has been read but not yet adopted, so
     what is known about the board lives on `found`. Both are consulted, and
     neither is invented. */
  const firmware = hello?.fw || found?.fw || null;
  const reported = hello?.app || found?.app || null;
  const appName = reported?.name || null;
  const appVer = reported?.ver || reported?.version || null;
  /* The baseline's own application is called `default`; anything else is
     something that was built and flashed on purpose. */
  const isApp = !!appName && appName !== 'default';
  const app = isApp ? { name: appName, version: appVer || null } : null;
  const shown = app ? `${app.name}${app.version ? ` ${app.version}` : ''}` : null;

  if (pub?.action === 'same') {
    return {
      kind: 'baseline', firmware, app, baseline,
      short: `baseline ${firmware || baseline}`,
      headline: `This board is running the known-safe baseline, ${firmware || baseline}.`,
      note: 'It is the image this page publishes, byte for byte. There is nothing to fix.',
      recommend: 'continue',
    };
  }

  if (pub?.action === 'outdated') {
    return {
      kind: 'outdated', firmware, app, baseline,
      short: `harness ${firmware || '?'} · baseline ${baseline}`,
      headline: `This board is running harness ${firmware || 'an older version'}, and the baseline is now ${baseline}.`,
      note: 'Writing the baseline brings it up to the version this page was built against.',
      recommend: 'flash',
    };
  }

  if (isApp) {
    return {
      kind: 'app', firmware, app, baseline,
      short: `${shown} on ${firmware || baseline}`,
      headline: `This board is running the application ${shown}, built on harness ${firmware || baseline}.`,
      note: 'That is a build somebody flashed on purpose, and keeping it is the normal choice.',
      recommend: 'continue',
    };
  }

  return {
    kind: 'build', firmware, app, baseline,
    short: `a build of ${firmware || baseline}`,
    headline: `This board is running a build based on harness ${firmware || baseline}.`,
    note: 'It is the same harness version this page publishes, compiled from different source — '
        + 'which is what a board that has been built for looks like. Keeping it is the normal choice.',
    recommend: 'continue',
  };
}

/** The flow, once, as sentences a model can plan against. */
export const HOW_IT_WORKS = [
  'Bring-up runs five rungs: connect, flash, boot, identify, telemetry. Only one '
    + 'of them stops and asks, and the buttons on the page answer it. Everything '
    + 'runs over the USB cable, and there is nothing else to set up.',
  'Only a person can choose a serial port. The picker is a native browser dialog '
    + 'that no tool or script can drive. It is the one step you cannot do '
    + 'yourself: ask for it, then wait.',
  'The flash decision says what the board is running. A board running an '
    + 'application, or another build of the same harness version, is working '
    + 'normally: "Continue with it" keeps it and writes nothing, and is the '
    + 'normal answer. "Restore baseline" writes the known-safe image, and leads '
    + 'only when the board runs an older harness or nothing readable.',
  'Once a board is linked the work is: read get_app_source for the API, compile '
    + 'with build_firmware, poll get_build, then flash_image with that build id. '
    + 'Only flash_image and restore_baseline touch the board, and both wait for a '
    + 'person to press Approve.',
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
  const running = describeRunning(state);
  const waitingOn = waiting(state, running);

  return {
    phase: state.phase,
    active: state.active ?? null,
    simulated: !!state.simulated,
    blocked: state.blocked ?? null,
    rungs,
    board: {
      firmware: state.hello?.fw ?? state.found?.fw ?? null,
      published: state.published?.version ?? null,
      /** 'same' | 'differs' | 'outdated' | 'unknown' — the raw comparison. */
      comparison: state.published?.action ?? null,
      /** The same thing said usefully: what it runs, and what to do about it. */
      running: running.kind,
      runningSays: running.headline,
      recommend: running.recommend,
      app: running.app,
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
function waiting(s, running) {
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

  if (s.phase === 'decide') {
    const r = running || describeRunning(s);
    const version = r.baseline;
    const restore = version ? `Restore baseline ${version}` : 'Restore baseline';
    const write = version ? `Write baseline ${version}` : 'Write baseline';

    if (r.kind === 'unknown') {
      return {
        who: 'person',
        what: `${r.headline} ${r.note} Writing the known-safe baseline is the answer here.`,
        options: [
          opt(write, 'writes the known-safe baseline; a person decides', true),
          opt('Listen anyway', 'keeps listening without writing', false),
        ],
      };
    }

    const lead = r.recommend === 'continue'
      ? '"Continue with it" keeps what is on the board and writes nothing, and is the normal answer here.'
      : `"${restore}" is the answer here. "Continue with it" keeps what is on the board and writes nothing.`;

    return {
      who: 'person',
      what: `${r.headline} ${r.note} ${lead}`,
      options: [
        opt('Continue with it', `keeps ${r.firmware || 'what is on the board'} and writes nothing`, false),
        opt(restore, 'writes the known-safe baseline over the board; a person decides', true),
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
