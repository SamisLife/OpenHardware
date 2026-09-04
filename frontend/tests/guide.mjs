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

const { describeBringUp, describeRunning, HOW_IT_WORKS } = await load('onboard/guide.js');

const RUNGS = ['connect', 'flash', 'boot', 'identify', 'telemetry'];
const base = (over = {}) => ({
  phase: 'idle', active: null, hasPort: false, simulated: false, blocked: null,
  hello: null, found: null, published: null, fault: null,
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
  ok('every rung is listed with its state', g.rungs.length === 5 && g.rungs.every(r => r.state === 'idle'));
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

/* ------------------------------------------------------------------------ */
/* what the board is running, which is the whole flash decision              */
/* ------------------------------------------------------------------------ */

{
  /* The exact published image. Nothing to do. */
  const s = base({
    phase: 'decide', found: { known: true, fw: '0.13.4', app: { name: 'default', ver: '1.0' } },
    published: { action: 'same', version: '0.13.4' },
  });
  const r = describeRunning(s);
  ok('an image that matches the baseline is named as the baseline',
     r.kind === 'baseline' && /known-safe baseline/.test(r.headline), r.headline);
  ok('and keeping it is the recommendation', r.recommend === 'continue');

  const g = describeBringUp(s);
  ok('the decision says what is running, not that two hashes differ',
     /known-safe baseline/.test(g.next) && !/hash/i.test(g.next), g.next);
  ok('continuing writes nothing and needs no person', person(g, 'Continue with it') === false);
  ok('restoring the baseline is a person\'s decision', person(g, 'Restore baseline 0.13.4') === true);
  ok('the board block carries both versions and the comparison',
     g.board.firmware === '0.13.4' && g.board.published === '0.13.4' && g.board.comparison === 'same');
  ok('and says in one word what it is running', g.board.running === 'baseline');
}

{
  /* An application built on this harness. Same version, different hash — the
     ordinary state of a board being worked on, and the case that used to be
     reported as a discrepancy. */
  const s = base({
    phase: 'decide',
    found: { known: true, fw: '0.14.1', app: { name: 'oled_hello', ver: '1.0.1' } },
    published: { action: 'differs', version: '0.14.1', running: '0.14.1' },
  });
  const r = describeRunning(s);
  ok('an application is named, with the harness it was built on',
     r.kind === 'app' && /oled_hello 1\.0\.1/.test(r.headline) && /0\.14\.1/.test(r.headline),
     r.headline);
  ok('and it is not reported as anything being wrong',
     r.recommend === 'continue' && !/hash|differ|mismatch/i.test(r.headline + r.note), r.note);

  const g = describeBringUp(s);
  ok('the agent is told keeping it is the normal answer',
     /normal answer/.test(g.next) && person(g, 'Continue with it') === false);
  ok('and the app is offered as data, not only as prose',
     g.board.app?.name === 'oled_hello' && g.board.recommend === 'continue');
}

{
  /* Same harness version, no application: another build of the harness. */
  const s = base({
    phase: 'decide', found: { known: true, fw: '0.14.1', app: { name: 'default', ver: '1.0' } },
    published: { action: 'differs', version: '0.14.1', running: '0.14.1' },
  });
  const r = describeRunning(s);
  ok('another build of the same harness is described as exactly that',
     r.kind === 'build' && /a build based on harness 0\.14\.1/.test(r.headline), r.headline);
  ok('and keeping it still leads', r.recommend === 'continue');
}

{
  /* A different harness version. This is the one where writing leads. */
  const s = base({
    phase: 'decide', found: { known: true, fw: '0.12.0' },
    published: { action: 'outdated', version: '0.14.1', running: '0.12.0' },
  });
  const r = describeRunning(s);
  ok('an older harness is named against the baseline that replaces it',
     r.kind === 'outdated' && /0\.12\.0/.test(r.headline) && /0\.14\.1/.test(r.headline), r.headline);
  ok('and writing the baseline is the recommendation', r.recommend === 'flash');

  const g = describeBringUp(s);
  ok('the agent is told the restore is the answer here',
     /is the answer here/.test(g.next), g.next);
  ok('and continuing is still reachable', labels(g).includes('Continue with it'));
}

{
  const s = base({ phase: 'decide', found: { known: false, lines: 12 }, published: { version: '0.13.4' } });
  const g = describeBringUp(s);
  ok('unrecognised firmware is counted, not characterised',
     /12 lines of output and none of them were recognised/.test(g.next) && !/version|protocol/.test(g.next),
     g.next);
  ok('writing is offered as a person\'s choice, listening as a safe one',
     person(g, 'Write baseline 0.13.4') === true && person(g, 'Listen anyway') === false);
  ok('and it is the answer rather than one of two equals',
     /is the answer here/.test(g.next), g.next);
}

{
  /* Nothing about a network is described any more, because there is none. */
  const g = describeBringUp(base({ phase: 'decide', found: { known: true, fw: '0.14.1' } }));
  const all = [g.next, ...g.howItWorks, ...labels(g)].join(' ');
  ok('the flow never mentions a network, a radio or credentials',
     !/wi-?fi|network|ssid|credential|passphrase/i.test(all), all.slice(0, 160));
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
