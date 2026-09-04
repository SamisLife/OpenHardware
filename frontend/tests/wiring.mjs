/* ============================================================================
   wiring.mjs — the wiring list's arithmetic.

       node frontend/tests/wiring.mjs

   A scan is folded into the list by a pure function, so the claims that
   matter can be checked with literals: an address is a fact and a part name
   beside it is a guess; a name the silicon gave is a fact; a name a person
   gave outranks both; a scan that failed changes nothing; and the board's
   silence says nothing about a part only a person could know about.
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

const { reconcile, keyFor, hex, pinLabel, candidatesFor, describe } = await load('wiring.js');

{
  const scan = { ok: true, sda: 5, scl: 6, at: 10, found: [{ addr: 0x3c }, { addr: 0x76, id: 'BME280' }] };
  const { parts, asks } = reconcile(scan, [], []);
  ok('every acknowledged address becomes a detected part',
     parts.length === 2 && parts.every(p => p.how === 'detected' && p.present === true));
  ok('an address with no chip id is named by its address and offered guesses',
     parts[0].name === '0x3c' && parts[0].candidates[0] === 'SSD1306 OLED' && parts[0].confirmed === false);
  ok('a chip id is a name the silicon gave, confirmed and not asked about',
     parts[1].name === 'BME280' && parts[1].confirmed === true && parts[1].confirmedBy === 'chip');
  ok('only the unnamed one raises a question',
     asks.length === 1 && asks[0].kind === 'new' && asks[0].key === 'i2c:0x3c');
  ok('the lines travel as silkscreen labels with the GPIO beside them',
     parts[0].pins.join('/') === 'D4 (GPIO5)/D5 (GPIO6)');

  const confirmed = parts.map(p => (p.key === 'i2c:0x3c'
    ? { ...p, name: 'SH1106 OLED', confirmed: true, confirmedBy: 'person' } : p));
  const again = reconcile({ ...scan, at: 20, found: [{ addr: 0x3c, id: 'XYZ' }] }, confirmed, []);
  ok('a person\'s name outranks a later chip id', again.parts[0].name === 'SH1106 OLED');
  ok('a part that stopped answering is marked absent and asked about',
     again.parts[1].present === false && again.asks.some(a => a.kind === 'missing' && a.key === 'i2c:0x76'));
  ok('and a confirmed part that answers again raises nothing', !again.asks.some(a => a.key === 'i2c:0x3c'));
  ok('nothing handed in was mutated', parts[1].present === true && confirmed[0].present === true);

  const ignored = reconcile(scan, [], ['i2c:0x3c']);
  ok('an ignored address is dropped without a question', ignored.parts.length === 1 && ignored.asks.length === 0);

  const declared = [{ key: 'gpio:ws2812', how: 'declared', bus: 'gpio', name: 'WS2812', present: null, confirmed: true }];
  const d = reconcile({ ok: true, at: 30, found: [] }, declared, []);
  ok('a declared part is never marked absent by a scan that cannot see it',
     d.parts[0].present === null && d.asks.length === 0);

  const stuck = reconcile({ ok: false, err: 'bus_stuck', line: 'sda', at: 40 }, parts, []);
  ok('a failed scan changes nothing',
     stuck.parts.length === 2 && stuck.parts.every(p => p.present === true) && stuck.asks.length === 0);
}

{
  ok('keys are stable across scans and sessions',
     keyFor('i2c', 0x3c) === 'i2c:0x3c' && keyFor('gpio', null, 'WS2812 strip') === 'gpio:ws2812-strip');
  ok('addresses print as two hex digits', hex(0x76) === '0x76' && hex(0x0d) === '0x0d');
  ok('known header pins carry their silkscreen name, others only the GPIO',
     pinLabel(43) === 'D6 (GPIO43)' && pinLabel(21) === 'GPIO21' && pinLabel('x') === null);
  ok('a description joins candidates as alternatives',
     describe({ candidates: candidatesFor(0x68) }) === 'MPU6050 IMU, or DS3231 real-time clock');
  ok('an address the table does not know has no description', describe({ candidates: candidatesFor(0x11) }) === null);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
