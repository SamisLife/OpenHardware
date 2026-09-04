/* ============================================================================
   wiring.mjs — what a person says is wired, and how it is kept.

       node frontend/tests/wiring.mjs

   There is no scan any more. This board cannot look at its own header, so the
   wiring list is entirely testimony: somebody typed it in, and the list has to
   carry that fact rather than let a reader mistake it for a measurement.

   What is pinned down here is small and load-bearing: a part is identified by
   something stable enough to survive a reload, adding the same part twice does
   not produce two of it, removing takes exactly one, and what a previous visit
   declared comes back without overwriting what this visit already said.
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

const { keyFor, hex, pinLabel, BUSES } = await load('wiring.js');
const S = await load('state.js');

/* ------------------------------------------------------------------------ */
/* the pure helpers                                                          */
/* ------------------------------------------------------------------------ */

{
  ok('an address is written the way a datasheet writes it', hex(0x3c) === '0x3c', hex(0x3c));
  ok('and a missing address is not written as zero', hex(null) === null || hex(null) === '', String(hex(null)));

  /* The silkscreen is what somebody reads off the board; the GPIO is what the
     firmware needs. Both, because either alone sends somebody to the wrong pin. */
  ok('a pin names both the label on the board and the number in the code',
     /D4/.test(pinLabel(5)) && /5/.test(pinLabel(5)), pinLabel(5));

  ok('the buses offered are the ones a part can actually be on',
     BUSES.includes('i2c') && BUSES.includes('spi') && BUSES.includes('gpio'));
}

{
  /* The key has to survive a reload, so it is derived from what the part IS
     rather than from when it was added. */
  ok('the same part declared twice keys the same',
     keyFor('i2c', 0x3c, 'OLED') === keyFor('i2c', 0x3c, 'OLED'));
  ok('two addresses on one bus are different parts',
     keyFor('i2c', 0x3c, 'OLED') !== keyFor('i2c', 0x76, 'OLED'));
  ok('and the same address on two buses is not the same part',
     keyFor('i2c', 0x3c, 'OLED') !== keyFor('spi', 0x3c, 'OLED'));
}

/* ------------------------------------------------------------------------ */
/* the list, which only a person writes to                                   */
/* ------------------------------------------------------------------------ */

{
  S.resetAll();
  S.addPart({ name: 'SSD1306 OLED', bus: 'i2c', addr: 0x3c, pins: [5, 6], note: '128x32' });

  const [p] = S.state.wiring.parts;
  ok('a declared part is listed', S.state.wiring.parts.length === 1 && p.name === 'SSD1306 OLED');
  ok('and it is marked as declared, never as detected', p.how === 'declared');
  ok('with the bus, address, pins and note it was given',
     p.bus === 'i2c' && p.addr === 0x3c && p.pins.join() === '5,6' && p.note === '128x32',
     JSON.stringify(p));

  /* Nothing measured it, so nothing may claim it answered. */
  ok('nothing on it claims the board saw it',
     p.present === undefined && p.confirmedBy === undefined && p.id === undefined,
     JSON.stringify(p));
}

{
  S.resetAll();
  S.addPart({ name: 'OLED', bus: 'i2c', addr: 0x3c });
  S.addPart({ name: 'OLED', bus: 'i2c', addr: 0x3c, note: 'on the right-hand header' });
  ok('declaring the same part again updates it rather than duplicating it',
     S.state.wiring.parts.length === 1
     && S.state.wiring.parts[0].note === 'on the right-hand header',
     JSON.stringify(S.state.wiring.parts));

  S.addPart({ name: '', bus: 'i2c', addr: 0x40 });
  ok('a part with no name is not added at all', S.state.wiring.parts.length === 1);
}

{
  S.resetAll();
  S.addPart({ name: 'OLED', bus: 'i2c', addr: 0x3c });
  S.addPart({ name: 'LED strip', bus: 'gpio', pins: [2] });
  const key = S.state.wiring.parts[0].key;

  S.removePart(key);
  ok('removing takes exactly the part asked for',
     S.state.wiring.parts.length === 1 && S.state.wiring.parts[0].name === 'LED strip');

  S.removePart('nothing-with-this-key');
  ok('and removing something that is not there changes nothing',
     S.state.wiring.parts.length === 1);
}

{
  /* What a previous visit knew, coming back. It must not overwrite anything
     said since, because the thing said since is the more recent claim. */
  S.resetAll();
  S.addPart({ name: 'OLED', bus: 'i2c', addr: 0x3c, note: 'said this visit' });
  const key = S.state.wiring.parts[0].key;

  S.restoreWiring({
    parts: [
      { key, name: 'OLED', bus: 'i2c', addr: 0x3c, how: 'declared', note: 'said last visit' },
      { key: 'other', name: 'BME280', bus: 'i2c', addr: 0x76, how: 'declared' },
    ],
  });

  const oled = S.state.wiring.parts.find(x => x.key === key);
  ok('a remembered part this visit already knows about is left alone',
     oled.note === 'said this visit', oled.note);
  ok('and one it does not know about comes back',
     S.state.wiring.parts.some(x => x.name === 'BME280'));

  S.restoreWiring({});
  ok('restoring nothing is not an error', S.state.wiring.parts.length === 2);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
