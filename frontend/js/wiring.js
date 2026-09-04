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
export const I2C_CANDIDATES = {
  0x0d: ['QMC5883L magnetometer'],
  0x18: ['LIS3DH accelerometer'],
  0x1e: ['HMC5883L magnetometer'],
  0x23: ['BH1750 light sensor'],
  0x27: ['PCF8574 I/O expander', '16x2 LCD backpack'],
  0x29: ['VL53L0X range finder', 'TCS34725 colour sensor'],
  0x38: ['AHT10 / AHT20 humidity sensor'],
  0x39: ['APDS-9960 gesture and proximity sensor'],
  0x3c: ['SSD1306 OLED', 'SH1106 OLED'],
  0x3d: ['SSD1306 OLED, alternate address'],
  0x40: ['INA219 current sensor', 'HTU21D humidity sensor'],
  0x44: ['SHT3x temperature and humidity sensor'],
  0x48: ['ADS1115 ADC', 'TMP102 temperature sensor'],
  0x4a: ['ADS1115 ADC, alternate address'],
  0x53: ['ADXL345 accelerometer'],
  0x57: ['AT24C EEPROM', 'MAX30102 pulse sensor'],
  0x5a: ['MLX90614 infrared thermometer', 'CCS811 air quality sensor'],
  0x60: ['MCP4725 DAC', 'Si1145 light sensor'],
  0x68: ['MPU6050 IMU', 'DS3231 real-time clock'],
  0x69: ['MPU6050 IMU, alternate address'],
  0x6b: ['LSM6DS3 IMU'],
  0x70: ['TCA9548A I2C multiplexer'],
  0x76: ['BME280 environmental sensor', 'BMP280 pressure sensor'],
  0x77: ['BME280 environmental sensor, alternate address', 'BMP180 pressure sensor'],
};

/** Buses a person may declare a part on. */
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
export function scanPins(scan) {
  return [scan?.sda, scan?.scl].filter(Number.isInteger).map(pinLabel);
}

export function hex(addr) {
  return `0x${Number(addr).toString(16).padStart(2, '0')}`;
}

export function candidatesFor(addr) {
  return [...(I2C_CANDIDATES[Number(addr)] || [])];
}

/** A stable identity for a part: the bus and, on I2C, the address. */
export function keyFor(bus, addr, name = '') {
  if (bus === 'i2c' && Number.isInteger(Number(addr))) return `i2c:${hex(addr)}`;
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${bus}:${slug || 'part'}`;
}

/**
 * Fold a scan into the list.
 *
 * Every acknowledged address becomes, or refreshes, a detected part. An
 * address the chip-ID read identified is named by the silicon and needs no
 * question; one it did not is named by its address, offered the table's
 * candidates, and put to the person. A detected I2C part the scan did not
 * find is marked absent and put to the person too. Declared parts are never
 * touched: the board cannot see them, so its silence says nothing.
 *
 * Ignored keys are addresses a person chose not to list; they are dropped
 * quietly, every scan, until the choice is withdrawn.
 *
 * @returns {{ parts: object[], asks: object[] }} new lists; nothing mutated
 */
export function reconcile(scan, parts = [], ignored = []) {
  const now = scan?.at || 0;
  const next = parts.map(p => ({ ...p }));
  const asks = [];
  if (!scan || scan.ok === false) return { parts: next, asks };

  const seen = new Set();
  for (const f of scan.found || []) {
    const addr = Number(f.addr);
    if (!Number.isInteger(addr)) continue;
    const key = keyFor('i2c', addr);
    seen.add(key);
    if (ignored.includes(key)) continue;

    const i = next.findIndex(p => p.key === key);
    if (i >= 0) {
      const p = next[i];
      next[i] = {
        ...p,
        present: true,
        seenAt: now,
        id: f.id || p.id || null,
        /* A name the silicon gave overrides a guess, never a person. */
        name: p.confirmed ? p.name : (f.id || p.name),
        confirmed: p.confirmed || !!f.id,
        confirmedBy: p.confirmed ? p.confirmedBy : (f.id ? 'chip' : null),
        pins: scanPins(scan).length ? scanPins(scan) : p.pins,
      };
      continue;
    }

    const table = candidatesFor(addr);
    const candidates = f.id ? [f.id, ...table.filter(c => c !== f.id)] : table;
    next.push({
      key, how: 'detected', bus: 'i2c', addr,
      pins: scanPins(scan),
      id: f.id || null,
      name: f.id || hex(addr),
      candidates,
      confirmed: !!f.id,
      confirmedBy: f.id ? 'chip' : null,
      present: true,
      note: null,
      at: now,
      seenAt: now,
    });
    if (!f.id) asks.push({ kind: 'new', key });
  }

  for (const p of next) {
    if (p.how === 'detected' && p.bus === 'i2c' && !seen.has(p.key) && p.present !== false) {
      p.present = false;
      asks.push({ kind: 'missing', key: p.key });
    }
  }

  return { parts: next, asks };
}

/** The candidate sentence for an ask: "probably an SSD1306 OLED". */
export function describe(part) {
  const c = part?.candidates || [];
  if (!c.length) return null;
  return c.length === 1 ? c[0] : `${c[0]}, or ${c.slice(1).join(', or ')}`;
}
