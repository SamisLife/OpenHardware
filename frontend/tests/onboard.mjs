/* ============================================================================
   onboard.mjs — bring-up, and the rule about not guessing.

       node frontend/tests/onboard.mjs

   Two things are under test and only one of them is a state machine.

   The first is that the flow stops on a named rung with a named observation,
   and that the three ways a connection can fail are told apart by something
   actually observed rather than by a guess.

   The second is the rule in onboard/faults.js: a message may not assert a
   cause that was not observed. That is enforced structurally — a fault has an
   `observed` field and a separate `causes` list — so it is testable, which is
   the entire reason it is a data shape instead of a style guide.
   ========================================================================== */

import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const JS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'js');
const load = rel => import(pathToFileURL(path.join(JS, rel)).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  — ' + extra : ''}`); }
};

globalThis.requestAnimationFrame = fn => setTimeout(() => fn(0), 0);
globalThis.URL.createObjectURL ??= () => 'blob:test';
globalThis.URL.revokeObjectURL ??= () => {};

const { Session, RUNGS } = await load('onboard/session.js');
const { FAULTS, fault } = await load('onboard/faults.js');
const { simulatedDriver } = await load('link/drivers.js');

const wait = ms => new Promise(r => setTimeout(r, ms));

/* ------------------------------------------------------------------------ */
/* the rule, checked against every fault there is                            */
/* ------------------------------------------------------------------------ */

{
  const codes = Object.keys(FAULTS);
  ok('there are faults to check', codes.length > 0);

  for (const code of codes) {
    const f = FAULTS[code];
    /* An observation is a statement about what happened. If it were allowed to
       be empty, the causes would end up carrying the weight of one. */
    ok(`${code}: states what was observed`, !!f.observed && f.observed.length > 10);
    ok(`${code}: keeps candidates separate from the observation`,
       Array.isArray(f.causes));
  }

  /* The failure mode being guarded against, in the words it used to take.
     Every one of these reads as a determination and is a guess. */
  const guesses = [
    /check (the |your )?(wi-?fi )?password/i,
    /the board is not responding/i,
    /writing was interrupted/i,
    /may have expired/i,
  ];
  const allObserved = codes.map(c => FAULTS[c].observed).join(' ');
  ok('no observation asserts a cause it could not have seen',
     guesses.every(re => !re.test(allObserved)),
     allObserved);

  /* The observation describes a state; the causes are where a guess belongs,
     and they are rendered under their own heading. */
  ok('candidates live in the list, not the statement',
     /another tab/i.test(FAULTS.no_open.causes.join(' '))
     && !/another tab/i.test(FAULTS.no_open.observed));
}

{
  const f = fault('no_open', 'Failed to open serial port.');
  ok('a fault keeps the underlying error verbatim',
     f.raw === 'Failed to open serial port.',
     'the API string is often the only precise thing available');

  const unknown = fault('something_new', 'boom');
  ok('an unrecognised failure is still reported honestly',
     unknown.observed.length > 0 && unknown.causes.length === 0,
     'rather than being flattened into the nearest familiar fault');
  ok('and keeps its raw error', unknown.raw === 'boom');
}

/* ------------------------------------------------------------------------ */
/* the two failures that look alike and are not                              */
/* ------------------------------------------------------------------------ */

{
  /* A port that is listed and will not open is held by something. A port that
     stopped being listed left the bus. Opposite faults, opposite fixes —
     guessing between them sends somebody to change a cable that is fine. */
  const held = { ...simulatedDriver(), openPort: async () => { throw new Error('Access denied'); } };
  const s = new Session(held, () => {});
  await s.connect();

  ok('a port that stays listed and will not open is reported as held',
     s.state.fault?.code === 'no_open', s.state.fault?.code);
  ok('and stops on the rung it failed at',
     s.state.rungs.connect.state === 'fault');
  await s.dispose();
}

{
  const gone = {
    ...simulatedDriver(),
    openPort: async () => { throw new Error('Failed to open serial port.'); },
    portsLike: async () => [],
  };
  const s = new Session(gone, () => {});
  await s.connect();

  ok('a port that stopped being listed is reported as vanished',
     s.state.fault?.code === 'port_vanished', s.state.fault?.code);
  ok('and the two faults say different things',
     FAULTS.no_open.observed !== FAULTS.port_vanished.observed);
  await s.dispose();
}

{
  /* Dismissing a picker is a decision, not a failure. Painting it red teaches
     people to distrust the red. */
  const dismissed = {
    ...simulatedDriver(),
    requestPort: async () => { const e = new Error('No port selected by the user.'); e.name = 'NotFoundError'; throw e; },
  };
  const s = new Session(dismissed, () => {});
  await s.connect();
  ok('a dismissed picker is not a fault', s.state.fault === null);
  ok('and the flow returns to idle', s.state.phase === 'idle');
  await s.dispose();
}

/* ------------------------------------------------------------------------ */
/* a board that says nothing, and one that says the wrong thing              */
/* ------------------------------------------------------------------------ */

{
  const silent = {
    ...simulatedDriver(),
    async openPort() { return { get open() { return true; }, send: async () => true, stop: async () => {} }; },
  };
  const s = new Session(silent, () => {});
  await s.connect();

  ok('a silent board is reported as unidentified', s.state.fault?.code === 'no_hello');
  ok('and the connect rung still passed, because it did',
     s.state.rungs.connect.state === 'done',
     'the port opened; that is a different fact from the board answering');
  await s.dispose();
}

{
  /* Three outcomes, not two. A board chattering in firmware that does not
     speak this protocol is not the same as a silent one, and reporting
     "nothing there" over a running project is both wrong and alarming. */
  const other = {
    ...simulatedDriver(),
    async openPort(_p, handlers) {
      setTimeout(() => {
        for (let i = 0; i < 12; i++) handlers.onText?.(`some other firmware line ${i}`, false);
      }, 10);
      return { get open() { return true; }, send: async () => true, stop: async () => {} };
    },
  };
  const s = new Session(other, () => {});
  await s.connect();

  ok('a board running something else is distinguished from a silent one',
     /12 lines arrived/.test(s.state.fault?.observed || ''),
     s.state.fault?.observed);
  ok('and what it said is counted rather than characterised',
     s.state.heard.lines === 12);
  await s.dispose();
}

/* ------------------------------------------------------------------------ */
/* the happy path, against the simulated board                               */
/* ------------------------------------------------------------------------ */

{
  const s = new Session(simulatedDriver(''), () => {});
  await s.connect();

  ok('the board is identified', s.state.rungs.identify.state === 'done');
  ok('by what it reported about itself',
     /Simulated board/.test(s.state.rungs.identify.detail), s.state.rungs.identify.detail);

  await wait(400);
  ok('and telemetry follows', s.state.rungs.telemetry.state === 'done');
  ok('which ends bring-up', s.state.phase === 'done');

  /* Every rung is accounted for, and the two that did not run say `skipped`
     rather than `done`. A board that was never written to must not leave a
     ladder claiming firmware was written to it. */
  ok('every rung is accounted for',
     RUNGS.every(r => ['done', 'skipped'].includes(s.state.rungs[r].state)),
     RUNGS.map(r => `${r}=${s.state.rungs[r].state}`).join(' '));
  ok('and connecting to a running board does not claim to have written to it',
     s.state.rungs.flash.state === 'skipped' && s.state.rungs.boot.state === 'skipped');

  /* The link stays open — it is the transport, not a setup channel. */
  ok('the link is still open after handover', s.link?.open === true);
  await s.dispose();
  ok('and closed once the session is disposed', s.link === null);
}

/* ------------------------------------------------------------------------ */
/* the monitor                                                               */
/* ------------------------------------------------------------------------ */

{
  const s = new Session(simulatedDriver(''), () => {});

  /* A board announces itself repeatedly while waiting, and an uncollapsed
     monitor is mostly one word. */
  for (let i = 0; i < 5; i++) s.log('W (100) wifi: no suitable AP', 'text');
  ok('repeats collapse into a count', s.monitor.length === 1 && s.monitor[0].n === 5);

  /* Matching ignores the log's tick counter, or the collapse never fires on
     exactly the floods that need it. */
  s.log('W (36522) wifi: retrying', 'text');
  s.log('W (36774) wifi: retrying', 'text');
  const last = s.monitor[s.monitor.length - 1];
  ok('and a changing tick count does not defeat it', last.n === 2, `n=${last.n}`);
  ok('while the newest text is what is kept', /36774/.test(last.text));

  /* A board in a boot loop produces thousands of lines and the monitor must
     not become the reason the tab dies. */
  for (let i = 0; i < 900; i++) s.log(`line ${i}`, 'text');
  ok('the monitor is bounded', s.monitor.length <= 600, `${s.monitor.length} lines`);
  ok('and keeps the newest, not the oldest',
     s.monitor[s.monitor.length - 1].text === 'line 899');

  await s.dispose();
}

{
  const s = new Session(simulatedDriver(''), () => {});
  await s.dispose();
  ok('a disposed session stops painting', s.disposed === true);
  /* Without this, a replaced session keeps its port and repaints its own stale
     state over whatever replaced it. */
  ok('and lets go of its link', s.link === null);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
