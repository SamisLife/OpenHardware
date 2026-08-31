/* ============================================================================
   peripherals.js — what is actually attached to this board.
   ----------------------------------------------------------------------------
   Discovered, never assumed. Showing a camera panel to every board on the
   grounds that the reference hardware has one means most boards get a
   permanently empty viewport, which is a worse lie than no viewport at all.

   The subtle part is that detection has two very different confidence levels,
   and they must not be presented alike:

     IDENTIFIED   a driver read an ID register off the part. "OV2640" is a
                  fact about the silicon. This is also why an unseated ribbon
                  produces "detected but unsupported" rather than "no camera".

     OBSERVED     an address acknowledged on a bus. That is all it is. 0x68 is
                  an MPU6050 or a DS3231; 0x76 is a BME280 or a BMP280, and
                  telling them apart needs a device-specific ID read. The
                  address is what was seen; any name beside it is inference,
                  rendered in italics and prefixed "probably".

   Anything on SPI, on an analog pin, or on a bare GPIO cannot be discovered at
   all — no addressing, no acknowledgement, nothing to probe. An IR sensor on a
   GPIO is indistinguishable from a floating pin. The empty state says so
   rather than implying the list is complete.
   ========================================================================== */

/**
 * Common I2C addresses, as candidates rather than answers.
 *
 * Several very different parts share an address, so every entry here is a
 * shortlist. Nothing in this table is ever presented as a determination.
 */
const I2C_CANDIDATES = {
  0x0d: 'QMC5883L magnetometer',
  0x18: 'LIS3DH accelerometer',
  0x1e: 'HMC5883L magnetometer',
  0x23: 'BH1750 light sensor',
  0x27: 'PCF8574 I/O expander, or a 16x2 LCD backpack',
  0x29: 'VL53L0X range finder, or TCS34725 colour',
  0x38: 'AHT10/AHT20 humidity',
  0x39: 'APDS-9960 gesture and proximity',
  0x3c: 'SSD1306 / SH1106 OLED',
  0x3d: 'SSD1306 OLED, alternate address',
  0x40: 'INA219 current, or HTU21D humidity',
  0x44: 'SHT3x temperature and humidity',
  0x48: 'ADS1115 ADC, or TMP102',
  0x4a: 'ADS1115 ADC, alternate address',
  0x53: 'ADXL345 accelerometer',
  0x57: 'AT24C EEPROM, or MAX30102 pulse',
  0x5a: 'MLX90614 infrared thermometer, or CCS811 air quality',
  0x60: 'MCP4725 DAC, or Si1145',
  0x68: 'MPU6050 IMU, or DS3231 real-time clock',
  0x69: 'MPU6050 IMU, alternate address',
  0x6b: 'LSM6DS3 IMU',
  0x70: 'TCA9548A I2C multiplexer',
  0x76: 'BME280 / BMP280 environmental',
  0x77: 'BME280 / BMP280, alternate address',
};

let el = {};
let handlers = {};

export function mountPeripherals(root, opts = {}) {
  handlers = opts;
  el = {
    list: root.querySelector('[data-periph=list]'),
    empty: root.querySelector('[data-periph=empty]'),
    prompt: root.querySelector('[data-periph=prompt]'),
  };
}

export function renderPeripherals(state) {
  const p = state.peripherals;

  /* Nothing is claimed until the board has actually reported. */
  if (!p.known) {
    el.empty.hidden = false;
    el.empty.textContent = 'Waiting for the board to report what is attached.';
    el.list.innerHTML = '';
    el.prompt.hidden = true;
    return;
  }

  renderOffer(p);

  const rows = [];

  if (p.camera && p.camera.state === 'ok') {
    /* A sensor ID read off the part. This one is not a guess. */
    rows.push(row(p.camera.sensor || 'camera', 'camera sensor',
      p.streaming ? 'streaming' : 'idle'));
  } else if (p.camera && p.camera.state === 'absent') {
    rows.push(row('No camera', 'nothing answered on the camera bus', ''));
  } else if (p.camera && p.camera.state === 'faulted') {
    rows.push(row('Camera faulted', 'probe crashed on previous boots, not retried', 'fault'));
  }

  for (const addr of p.i2c || []) {
    const n = Number(addr);
    const hex = `0x${n.toString(16).padStart(2, '0')}`;
    const candidate = I2C_CANDIDATES[n];
    rows.push(row(hex, candidate ? `probably ${candidate}` : 'unidentified device', 'guess'));
  }

  /* Keyed on whether anything was actually FOUND, not on whether any row was
     drawn. "No camera" is a negative finding and it occupies a row, so keying
     on row count would let a board with no camera and a bare bus lose the one
     sentence that says the list is not the whole truth. */
  const found = p.camera?.state === 'ok' || (p.i2c || []).length > 0;
  el.empty.hidden = found;
  if (!found) {
    el.empty.textContent = 'Nothing was detected beyond the board itself. '
      + 'Parts on SPI, on an analog pin or on a bare GPIO cannot be discovered at all — '
      + 'there is no address to probe and nothing to acknowledge — so they have to be '
      + 'declared rather than found.';
  }

  const html = rows.join('');
  if (el.list.innerHTML !== html) el.list.innerHTML = html;
}

/**
 * Streaming is worth offering rather than assuming: frames cost real bandwidth
 * on the link and plenty of runs never need to look at one.
 */
function renderOffer(p) {
  const offer = !!(p.camera && p.camera.state === 'ok' && !p.streaming && !p.cameraAsked);
  el.prompt.hidden = !offer;
  if (!offer) return;

  const sensor = esc(p.camera.sensor || 'A camera');
  const html = `
    <p class="offer__text"><strong>${sensor}</strong> detected. Stream frames into the console?</p>
    <div class="offer__actions">
      <button class="btn btn--primary" type="button" data-periph="yes">Show the camera</button>
      <button class="btn" type="button" data-periph="no">Not now</button>
    </div>
    <p class="offer__why">Frames cost bandwidth on the link. This can be turned on or off
      at any time.</p>`;

  if (el.prompt.innerHTML !== html) {
    el.prompt.innerHTML = html;
    el.prompt.querySelector('[data-periph=yes]')
      ?.addEventListener('click', () => handlers.onCamera?.(true));
    el.prompt.querySelector('[data-periph=no]')
      ?.addEventListener('click', () => handlers.onCameraDecline?.());
  }
}

function row(name, detail, tone) {
  return `<li class="periph" data-tone="${esc(tone || '')}">
    <span class="periph__name">${esc(name)}</span>
    <span class="periph__detail">${esc(detail)}</span>
  </li>`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
