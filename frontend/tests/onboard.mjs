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

  /* Stopped on FLASH rather than run past it. The rung that asks is the rung
     whose answer resolves it; faulting two rungs later on IDENTIFY reports the
     problem a long way from the thing that fixes it. */
  ok('a silent board stops on the rung that can do something about it',
     s.state.rungs.flash.state === 'ask', s.state.rungs.flash.state);
  ok('and it is a decision, not a malfunction',
     s.state.phase === 'decide' && s.state.fault === null, s.state.phase);
  ok('the rung says what was heard, which was nothing',
     /no output/i.test(s.state.rungs.flash.detail), s.state.rungs.flash.detail);
  ok('IDENTIFY has not run, because nothing has been identified',
     s.state.rungs.identify.state === 'idle');
  ok('and the connect rung still passed, because it did',
     s.state.rungs.connect.state === 'done',
     'the port opened; that is a different fact from the board answering');

  /* Choosing to wait it out is a real option, and choosing it does make the
     silence a fault — this time it was asked for. */
  await s.listen();
  ok('listening anyway leaves the board alone',
     s.state.rungs.flash.state === 'skipped', s.state.rungs.flash.state);
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
     /12 lines/.test(s.state.rungs.flash.detail || ''), s.state.rungs.flash.detail);
  ok('and what it said is counted rather than characterised',
     s.state.heard.lines === 12);
  ok('it is offered a decision rather than reported as broken',
     s.state.phase === 'decide' && s.state.fault === null);
  await s.dispose();
}

/* ------------------------------------------------------------------------ */
/* firmware nobody has a name for                                            */
/* ------------------------------------------------------------------------ */

{
  /* The general case, and the only honest one. Firmware this page cannot read
     is usually not another version of this project — it is arbitrary — so what
     can be said about it is how much of it arrived and that none of it was
     recognised. An earlier version named the framing it saw, which was
     accurate for exactly one board and a fabricated category everywhere else. */
  const LINES = [
    'I (697) esp_psram: SPI SRAM memory test OK',
    'boot: ESP-IDF v5.1 2nd stage bootloader',
    'garbage \u0000\u00ff not even text',
    'READY> ',
  ];

  const foreign = {
    ...simulatedDriver(),
    async fetchManifest() { return { version: '0.11.0', elf_sha8: 'abc123abc123abc1', parts: [] }; },
    async openPort(_p, handlers) {
      setTimeout(() => LINES.forEach(l => handlers.onText?.(l, false)), 10);
      return { get open() { return true; }, send: async () => true, stop: async () => {} };
    },
  };
  const s = new Session(foreign, () => {});
  await s.connect();

  ok('unrecognised firmware is counted, not characterised',
     s.state.found?.known === false && s.state.found?.lines === 4,
     JSON.stringify(s.state.found));

  /* The placement is the fix. The question "should this be overwritten" is
     answered on the rung that would do the overwriting. */
  ok('the question is asked on the flash rung',
     s.state.rungs.flash.state === 'ask', s.state.rungs.flash.state);
  ok('and the rung says only what was observed',
     /4 lines of output, none recognised/.test(s.state.rungs.flash.detail),
     s.state.rungs.flash.detail);

  /* A board running something else is not a broken board. */
  ok('it is a decision, not a malfunction',
     s.state.phase === 'decide' && s.state.fault === null, s.state.phase);
  ok('and the flow does not run past the decision',
     s.state.rungs.identify.state === 'idle' && s.state.rungs.boot.state === 'idle');
  ok('the version on offer comes from the manifest',
     s.state.published?.version === '0.11.0', JSON.stringify(s.state.published));

  /* Waiting it out is a real option, and only then is silence a fault. */
  await s.listen();
  ok('waiting it out reports what was actually seen',
     s.state.fault?.code === 'no_hello', s.state.fault?.code);
  await s.dispose();
}

/* ------------------------------------------------------------------------ */
/* a board that already speaks the protocol is still asked about             */
/* ------------------------------------------------------------------------ */

{
  /* Stopping here costs one click and buys the thing that matters more:
     writing a fresh image is always one step away, from the same place,
     without having to reach a failure first. */
  const hello = {
    t: 'hello', board_name: 'Board', mac: '02:00:00:00:00:09',
    fw: '0.10.0', sha: 'aaaaaaaaaaaaaaaa',
  };
  const known = {
    ...simulatedDriver(),
    async fetchManifest() { return { version: '0.11.0', elf_sha8: 'bbbbbbbbbbbbbbbb', parts: [] }; },
    async openPort(_p, handlers) {
      setTimeout(() => handlers.onFrame?.(hello), 10);
      return { get open() { return true; }, send: async () => true, stop: async () => {} };
    },
  };
  const s = new Session(known, () => {});
  await s.connect();

  ok('a recognised board is asked about too, so re-flashing is always reachable',
     s.state.phase === 'decide' && s.state.rungs.flash.state === 'ask',
     `${s.state.phase} / ${s.state.rungs.flash.state}`);
  ok('and it is described as running, not as a problem',
     s.state.found?.known === true && s.state.found?.fw === '0.10.0',
     JSON.stringify(s.state.found));
  ok('the comparison against the published image is already made',
     s.state.published?.action === 'differs' && s.state.published?.version === '0.11.0',
     JSON.stringify(s.state.published));
  ok('nothing has been written, and no warning is armed',
     s.state.writing === false && s.state.rungs.boot.state === 'idle');

  /* Carrying on reuses the identity that already answered. Probing again could
     fail at a question that has been answered. */
  await s.continueWithBoard();
  ok('carrying on writes nothing',
     s.state.rungs.flash.state === 'skipped'
     && /kept what was on the board/.test(s.state.rungs.flash.detail),
     s.state.rungs.flash.detail);
  ok('and goes straight through to identified',
     s.state.rungs.identify.state === 'done', s.state.rungs.identify.state);
  ok('reusing the identity that already answered',
     s.state.hello?.mac === '02:00:00:00:00:09');

  await s.dispose();
}

/* ------------------------------------------------------------------------ */
/* is the board running what was published?                                  */
/* ------------------------------------------------------------------------ */

{
  /* Compared on the ELF hash rather than on the version string. Two builds of
     different source can carry the same label, so comparing labels compares
     two claims; comparing hashes compares the artefacts. */
  const hello = {
    t: 'hello', board_name: 'Board', mac: '02:00:00:00:00:01',
    fw: '0.10.0', sha: 'aaaaaaaaaaaaaaaa',
  };

  const withManifest = (elf, version) => ({
    ...simulatedDriver(),
    async fetchManifest() { return { version, elf_sha8: elf, parts: [] }; },
    async openPort(_p, handlers) {
      setTimeout(() => handlers.onFrame?.(hello), 10);
      return { get open() { return true; }, send: async () => true, stop: async () => {} };
    },
  });

  const differs = new Session(withManifest('bbbbbbbbbbbbbbbb', '0.11.0'), () => {});
  await differs.connect();
  await wait(60);
  ok('a board running something other than the published image says so',
     differs.state.published?.action === 'differs', JSON.stringify(differs.state.published));
  ok('and names both sides of the comparison',
     differs.state.published?.running === '0.10.0'
     && differs.state.published?.version === '0.11.0');
  await differs.dispose();

  const same = new Session(withManifest('aaaaaaaaaaaaaaaa', '0.10.0'), () => {});
  await same.connect();
  await wait(60);
  ok('a matching hash is reported as matching',
     same.state.published?.action === 'same', JSON.stringify(same.state.published));
  await same.dispose();

  /* The common case, and the one that must stay quiet. */
  const noServer = {
    ...simulatedDriver(),
    async fetchManifest() { throw new Error('no server'); },
    async openPort(_p, handlers) {
      setTimeout(() => handlers.onFrame?.(hello), 10);
      return { get open() { return true; }, send: async () => true, stop: async () => {} };
    },
  };
  const quiet = new Session(noServer, () => {});
  await quiet.connect();
  await wait(60);
  ok('no published image is not a fault, and says nothing',
     quiet.state.published === null && quiet.state.phase !== 'fault',
     `${quiet.state.phase} / ${JSON.stringify(quiet.state.published)}`);
  await quiet.dispose();

  /* A manifest predating the field it would be compared on. */
  const older = {
    ...simulatedDriver(),
    async fetchManifest() { return { version: '0.9.0', parts: [] }; },
    async openPort(_p, handlers) {
      setTimeout(() => handlers.onFrame?.(hello), 10);
      return { get open() { return true; }, send: async () => true, stop: async () => {} };
    },
  };
  const noField = new Session(older, () => {});
  await noField.connect();
  await wait(60);
  /* The version is still wanted — it labels the button that writes it — but
     no claim is made about whether the board matches it. Reporting 'same' or
     'differs' on a manifest with no hash would be inventing the answer. */
  ok('a manifest with nothing to compare makes no claim about matching',
     noField.state.published?.action === 'unknown',
     JSON.stringify(noField.state.published));
  ok('and still offers the version it could name',
     noField.state.published?.version === '0.9.0');
  await noField.dispose();
}

/* ------------------------------------------------------------------------ */
/* nothing from one attempt may describe another                             */
/* ------------------------------------------------------------------------ */

{
  /* The failure this whole project exists to prevent, found in its own code.
     It presented as a screen reporting that nothing identifiable had arrived
     while, directly underneath, stating which version the board was running —
     two statements about two different moments, rendered as one situation.

     A stale reading is worse than an absent one: absence is visibly absent,
     and a stale value looks exactly like a current measurement. */
  let answer = true;
  const flaky = {
    ...simulatedDriver(),
    async fetchManifest() { return { version: '0.11.0', elf_sha8: 'aaaaaaaaaaaaaaaa', parts: [] }; },
    async openPort(_p, handlers) {
      if (answer) {
        setTimeout(() => handlers.onFrame?.({
          t: 'hello', board_name: 'Board', mac: '02:00:00:00:00:07',
          fw: '0.11.0', sha: 'aaaaaaaaaaaaaaaa',
        }), 10);
      }
      return { get open() { return true; }, send: async () => true, stop: async () => {} };
    },
  };

  const s = new Session(flaky, () => {});
  await s.connect();
  ok('a board that answers is described', s.state.published?.action === 'same'
     && s.state.found?.known === true, JSON.stringify(s.state.published));

  /* Same session, same board object, and this time it says nothing. */
  answer = false;
  await s.connect({ reuse: true });

  /* The version survives, because it names the image on offer and that is
     still true. What must not survive is the CLAIM — that the board matches
     it, and which firmware the board was running — because neither was
     observed this time. */
  ok('a later attempt inherits no claim about the board',
     s.state.published?.action === 'unknown' && s.state.published?.running === null,
     JSON.stringify(s.state.published));
  ok('though what is published is still known, because it still is',
     s.state.published?.version === '0.11.0');
  ok('nor what was found on the board before',
     s.state.found?.known === false, JSON.stringify(s.state.found));
  ok('nor the identity that has since stopped answering',
     s.state.hello === null);

  await s.dispose();
}

/* ------------------------------------------------------------------------ */
/* the happy path, against the simulated board                               */
/* ------------------------------------------------------------------------ */

{
  const s = new Session(simulatedDriver(''), () => {});
  await s.connect();

  /* The simulated board goes through the same decision a real one does. A
     simulator held to a weaker contract keeps passing after the real path has
     broken, at which point it has stopped being evidence. */
  ok('even a board that answers is asked about', s.state.phase === 'decide');
  await s.continueWithBoard();

  ok('the board is identified', s.state.rungs.identify.state === 'done');
  ok('by what it reported about itself',
     /Simulated board/.test(s.state.rungs.identify.detail), s.state.rungs.identify.detail);

  /* Adopting a board reaches the same network fork a freshly written one does.
     The question is about the board, not about how it got here. */
  ok('a board adopted rather than written is still asked about a network',
     s.state.rungs.network.state === 'ask', s.state.rungs.network.state);
  await s.skipNetwork();

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
