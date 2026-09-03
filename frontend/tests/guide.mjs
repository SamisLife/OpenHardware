/* ============================================================================
   guide.mjs — bring-up, described for a reader that cannot see the page.

       node frontend/tests/guide.mjs

   The guide is a pure function of the session state, so every phase can be
   handed to it as a literal. What is pinned down is that it never says
   anything the state does not hold, that the choices only a person can make
   are marked as such, and that a reader with no hardware is always told
   where the simulated board is.
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

const { describeBringUp, HOW_IT_WORKS } = await load('onboard/guide.js');

const RUNGS = ['connect', 'flash', 'boot', 'identify', 'network', 'telemetry'];
const base = (over = {}) => ({
  phase: 'idle', active: null, hasPort: false, simulated: false, blocked: null,
  hello: null, found: null, published: null, net: null, fault: null,
  rungs: Object.fromEntries(RUNGS.map(r => [r, { id: r, title: r.toUpperCase(), state: 'idle', detail: '' }])),
  ...over,
});
const labels = g => g.waitingOn.options.map(o => o.label);
const person = (g, label) => g.waitingOn.options.find(o => o.label === label)?.needsPerson;

{
  ok('nothing in, nothing out', describeBringUp(null) === null);

  const g = describeBringUp(base());
  ok('idle waits on a person and names the button', g.waitingOn.who === 'person' && labels(g).includes('Connect a board'));
  ok('choosing a port is marked as a person\'s', person(g, 'Connect a board') === true);
  ok('and the reader with no hardware is told about ?sim', /\?sim/.test(g.next));
  ok('the flow is explained once, as sentences', Array.isArray(g.howItWorks) && g.howItWorks === HOW_IT_WORKS && g.howItWorks.length >= 5);
  ok('six rungs are listed with their state', g.rungs.length === 6 && g.rungs.every(r => r.state === 'idle'));
}

{
  const g = describeBringUp(base({ blocked: 'This browser has no Web Serial.', hasPort: false }));
  ok('a blocked browser is reported with the reason and the way out',
     /no Web Serial/.test(g.next) && /\?sim/.test(g.next) && g.waitingOn.options.length === 0);
}

{
  const s = base({ phase: 'working', active: 'boot' });
  s.rungs.boot = { ...s.rungs.boot, state: 'active', detail: 'waiting for the board to come back' };
  const g = describeBringUp(s);
  ok('working waits on the board, with the active rung\'s detail',
     g.waitingOn.who === 'board' && /waiting for the board to come back/.test(g.next) && g.waitingOn.options.length === 0);
}

{
  const s = base({
    phase: 'decide', hello: { fw: '0.13.4' }, found: { known: true, fw: '0.13.4' },
    published: { action: 'same', version: '0.13.4' },
  });
  s.rungs.flash = { ...s.rungs.flash, state: 'ask', detail: 'already running 0.13.4' };
  const g = describeBringUp(s);
  ok('the flash decision names the firmware and says it matches',
     /already running 0\.13\.4/.test(g.next) && /matches the known-safe baseline/.test(g.next));
  ok('and says which choice is the normal one', /"Continue with it" keeps it and writes nothing; that is the normal choice/.test(g.next));
  ok('continuing writes nothing and needs no person', person(g, 'Continue with it') === false);
  ok('restoring the baseline is a person\'s decision', person(g, 'Restore baseline 0.13.4') === true);
  ok('the board block carries both versions and the comparison',
     g.board.firmware === '0.13.4' && g.board.published === '0.13.4' && g.board.comparison === 'same');
}

{
  const s = base({
    phase: 'decide', hello: { fw: '0.12.0' }, found: { known: true, fw: '0.12.0' },
    published: { action: 'differs', version: '0.13.4', running: '0.12.0' },
  });
  s.rungs.flash = { ...s.rungs.flash, state: 'ask', detail: 'running 0.12.0 · 0.13.4 published' };
  const g = describeBringUp(s);
  ok('a differing image is named without pressing for the write',
     /known-safe baseline is 0\.13\.4/.test(g.next) && person(g, 'Continue with it') === false);
}

{
  const s = base({ phase: 'decide', found: { known: false, lines: 12 }, published: { version: '0.13.4' } });
  s.rungs.flash = { ...s.rungs.flash, state: 'ask', detail: '12 lines of output, none recognised' };
  const g = describeBringUp(s);
  ok('unrecognised firmware is counted, not characterised',
     /12 lines of output and none were recognised/.test(g.next) && !/version|protocol/.test(g.next));
  ok('writing is offered as a person\'s choice, listening as a safe one',
     person(g, 'Write baseline 0.13.4') === true && person(g, 'Listen anyway') === false);
}

{
  const s = base({ phase: 'decide', hello: { fw: '0.13.4', net: 'offline', provisioned: false } });
  s.rungs.network = { ...s.rungs.network, state: 'ask', detail: 'no network stored' };
  const g = describeBringUp(s);
  ok('the network fork says the cable is enough', /Skip — use the cable/.test(g.next) && /normal answer/.test(g.next));
  ok('skipping needs no person; joining does', person(g, 'Skip — use the cable') === false && person(g, 'Join this network') === true);
}

{
  const s = base({
    phase: 'fault', hasPort: true,
    fault: { code: 'no_hello', observed: 'Nothing identified itself.', causes: ['a', 'b'], next: 'Press the reset button on the board.', raw: null },
  });
  const g = describeBringUp(s);
  ok('a fault hands over its own next step', g.next === 'Press the reset button on the board.' && g.fault.code === 'no_hello');
  ok('and its causes as candidates, separately', Array.isArray(g.fault.causes) && g.fault.causes.length === 2);
  ok('writing from a fault is a person\'s choice', person(g, 'Write baseline') === true && person(g, 'Try again') === false);
}

{
  const g = describeBringUp(base({ phase: 'done' }));
  ok('done waits on nobody and says the write tools exist', g.waitingOn.who === 'nobody' && /Write tools are registered/.test(g.next));
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
