/* ============================================================================
   wiring.js — what is attached to the board, as far as anyone can tell.
   ----------------------------------------------------------------------------
   Two kinds of knowledge, kept apart by a field rather than by wording:

     DETECTED   the board found it. An I2C scan gives an address that
                acknowledged, which is a fact; a chip-ID register read gives a
                part name, which is also a fact. Everything else attached to an
                address is a guess from a table of common parts, and stays a
                guess until a person confirms it.

     DECLARED   a person typed it. The board cannot see a strip of LEDs on a
                GPIO or a sensor on SPI, so the only way for the page and the
                agent to know is to be told.

   Pure functions over plain objects, so the reconciliation a scan triggers
   can be checked without a board, a DOM or a registry.
   ========================================================================== */

/**
 * Common I2C addresses, as candidates rather than answers.
 *
 * Several very different parts share an address, so every entry is a
 * shortlist, most likely first. Nothing here is ever presented as a
 * determination: the page says "probably", and asks.
 */
export const BUSES = ['i2c', 'spi', 'uart', 'gpio', 'analog', 'other'];

/**
 * Header labels for the XIAO ESP32S3, GPIO number to the silkscreen name.
 *
 * The board reports GPIO numbers because that is what the firmware knows;
 * the person reads the silkscreen. Both travel in the label so neither has
 * to be looked up.
 */
export const PIN_LABELS = {
  1: 'D0', 2: 'D1', 3: 'D2', 4: 'D3', 5: 'D4', 6: 'D5',
  43: 'D6', 44: 'D7', 7: 'D8', 8: 'D9', 9: 'D10',
};

export function pinLabel(gpio) {
  const n = Number(gpio);
  if (!Number.isInteger(n)) return null;
  return PIN_LABELS[n] ? `${PIN_LABELS[n]} (GPIO${n})` : `GPIO${n}`;
}

/** The two I2C lines of a scan, as labels. */
export function hex(addr) {
  return `0x${Number(addr).toString(16).padStart(2, '0')}`;
}

export function keyFor(bus, addr, name = '') {
  if (bus === 'i2c' && Number.isInteger(Number(addr))) return `i2c:${hex(addr)}`;
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${bus}:${slug || 'part'}`;
}
