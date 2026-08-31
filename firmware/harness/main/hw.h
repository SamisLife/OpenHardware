/* ============================================================================
   hw.h — the harness, declared in one place.
   ----------------------------------------------------------------------------
   The harness is the fixed firmware layer. An agent supplies an application
   layer compiled alongside it and is never permitted to edit anything in this
   directory. That is the property the whole project rests on: however wrong
   the generated code is, telemetry still comes back to say so.

   One rule governs everything below:

       THE HARNESS MUST NEVER GO SILENT.

   No path here calls esp_restart() on a failure. A network that will not come
   up means back off and retry. A server that will not answer means hold state
   and retry. A harness that gives up has destroyed the only channel anything
   downstream has, and nothing can debug a board that has stopped talking.
   ========================================================================== */

#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#define HW_FW_VERSION   "0.10.0"
#define HW_BOARD_ID     "esp32s3_generic"
#define HW_BOARD_NAME   "ESP32-S3"

/** Wire protocol version. Bumped only on a breaking frame change. */
#define HW_PROTO_VERSION 1

/** Telemetry cadence. 4 Hz is 250 ms of paper per sample on the recorder. */
#define HW_BEAT_MS      250

/**
 * Identity cadence.
 *
 * Fast at first, then slow. A host attaches at an unpredictable moment — after
 * a reset the USB device re-enumerates and the page reopens the port whenever
 * that finishes — so a single announcement at boot is one nothing hears.
 */
#define HW_HELLO_FAST_MS 700
#define HW_HELLO_SLOW_MS 5000
#define HW_HELLO_FAST_FOR_MS 15000

/* ------------------------------------------------------------------------ */
/* stored across power cycles                                                */
/* ------------------------------------------------------------------------ */

#define HW_NVS_NS       "openhw"

typedef struct {
    char ssid[33];
    char psk[65];
    char server[128];
    bool have_wifi;
} hw_creds_t;

esp_err_t hw_prov_init(void);
void      hw_prov_load(hw_creds_t *out);
esp_err_t hw_prov_save_wifi(const char *ssid, const char *psk, const char *server);
esp_err_t hw_prov_erase(void);

/* ------------------------------------------------------------------------ */
/* the wire                                                                  */
/* ------------------------------------------------------------------------ */

/**
 * One framed line:
 *
 *     #OHW1 {"t":"hello",...} *A3F2\n
 *
 * The sentinel is what makes this survive a shared endpoint. There is no UART
 * bridge on this hardware, so the ROM's startup noise, the logging subsystem
 * and anything the application layer prints all land on the same USB
 * peripheral. A reader that scans for the sentinel at the start of a line and
 * checks the CRC cannot be confused by any of it, and nothing else on the wire
 * begins with those six characters.
 *
 * Mirrored by frontend/js/link/protocol.js, which is the specification. The
 * CRC is what keeps the two honest: a divergence fails on the first frame
 * rather than subtly, later, under load.
 */
#define HW_FRAME_PREFIX   "#OHW1 "
#define HW_FRAME_PREFIX_N 6

/** Longest line either end will accept. */
#define HW_LINE_MAX       768

/** Called for each valid inbound frame. `json` is the raw payload text. */
typedef void (*hw_proto_cb_t)(const char *type, const char *json);

esp_err_t hw_proto_init(hw_proto_cb_t on_frame);

/** Emit {"t":"<type>", ...extra}. `extra` carries no braces on either side. */
void hw_proto_sendf(const char *type, const char *fmt, ...);

/** Emit a progress frame a host shows while bringing the board up. */
void hw_proto_status(const char *stage, const char *detail);

/** CRC-16/CCITT-FALSE. crc16("123456789") is 0x29B1. */
uint16_t hw_crc16(const char *data, size_t len);

/**
 * Total bytes ever received from the host.
 *
 * Reported in every identity frame, because "did anything sent actually arrive"
 * is the one question that cannot be answered from the other end: a write the
 * operating system accepted looks identical to one the device received. A
 * counter still at zero while frames are being sent says the inbound half of
 * the link is dead, and separates that from a framing or parsing fault.
 */
uint32_t hw_proto_rx_bytes(void);

/** Copy a JSON string field out of `json`. false when it is absent. */
bool hw_json_str(const char *json, const char *key, char *out, size_t out_len);

/* ------------------------------------------------------------------------ */
/* what the board can say about itself                                       */
/* ------------------------------------------------------------------------ */

/**
 * Everything here is a core call that degrades gracefully. On a part with no
 * PSRAM, esp_psram_get_size() returns zero — that is not a failure, it is the
 * diagnosis, and it is exactly what a host needs in order to refuse work the
 * hardware cannot do.
 *
 * The die temperature is the one reading that can genuinely be absent, so it
 * is reported through a validity flag rather than through a sentinel value. A
 * sentinel travels the wire looking like a measurement, and -273 °C rendered
 * as a readout with 343 degrees of headroom is worse than showing nothing.
 */
void     hw_sensors_init(void);

bool     hw_sensors_temp_c(float *out);
uint32_t hw_sensors_heap_free(void);
uint32_t hw_sensors_heap_total(void);
uint32_t hw_sensors_psram_free(void);
uint32_t hw_sensors_psram_largest(void);
uint32_t hw_sensors_psram_size(void);
uint32_t hw_sensors_flash_size(void);
int      hw_sensors_cpu_mhz(void);
