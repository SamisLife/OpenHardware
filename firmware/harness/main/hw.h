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

/**
 * The firmware version is NOT defined here.
 *
 * It lives in version.txt, which the build compiles into the image's app
 * descriptor, and it is read back out of that descriptor at runtime. One
 * source, and the loop closes: the string a board reports over the wire and
 * the string in the published manifest are read from the same bytes, so they
 * cannot disagree. A constant here would be a second copy, and the first time
 * it drifted the manifest would confidently describe an image nobody is
 * running.
 */
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

/** Read a JSON boolean. Anything that is not literally `true` reads false. */
bool hw_json_bool(const char *json, const char *key);

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

/* ------------------------------------------------------------------------ */
/* pictures on the wire                                                      */
/* ------------------------------------------------------------------------ */

/**
 * Raw bytes per chunk. 480 encodes to 640 base64 characters, which leaves the
 * envelope and the CRC comfortably inside HW_LINE_MAX.
 *
 * Mirrored by IMG_CHUNK_RAW in frontend/js/link/protocol.js.
 */
#define HW_IMG_CHUNK_RAW   480

/**
 * The largest image this will put on the cable.
 *
 * A cap rather than a best effort. The link is shared with telemetry, and an
 * oversized frame does not merely arrive late — it occupies the wire long
 * enough for the heartbeat to look like it stopped, which turns one bad
 * capture into an apparently dead board.
 */
#define HW_IMG_MAX_BYTES   (64 * 1024)

/**
 * Send one JPEG: a header frame, then indexed base64 chunks.
 *
 * Chunked rather than sent as one long line because a bounded reader is a
 * reader that cannot be made to allocate without limit by anything on the
 * wire. Each chunk is a frame in its own right and carries its own CRC, so a
 * corrupted one is dropped rather than painted.
 *
 * Safe to call from more than one task: the encoder scratch is held under a
 * lock for the whole image, which also stops two images from interleaving into
 * something no reader could separate.
 */
void hw_proto_send_image(const uint8_t *jpeg, size_t len,
                         uint32_t seq, int w, int h, int q);

/* ------------------------------------------------------------------------ */
/* the camera — the part that can take the board down                        */
/* ------------------------------------------------------------------------ */

/**
 * UNTRIED  not looked for yet
 * OK       initialised, identified, capturing
 * ABSENT   the probe returned an error — nothing there, or nothing answering
 * FAULTED  the probe took the board down HW_CAM_MAX_TRIES boots running and
 *          will not be attempted again until the counter is cleared
 *
 * ABSENT and FAULTED are deliberately different. One is a board with no camera
 * on it, which is the ordinary case and needs no attention. The other is a
 * board that crashes when it looks, which needs somebody.
 */
typedef enum {
    HW_CAM_UNTRIED = 0,
    HW_CAM_OK,
    HW_CAM_ABSENT,
    HW_CAM_FAULTED,
} hw_cam_state_t;

/**
 * Consecutive boots that may die inside the probe before it is abandoned.
 *
 * Three, because two is within the range of a marginally seated connector and
 * the cost of a wrong verdict here is a camera that never works again without
 * a manual erase.
 */
#define HW_CAM_MAX_TRIES   3

/** Shared by the init config and by what gets reported, so they cannot drift. */
#define HW_CAM_JPEG_QUALITY 12

/** Frame pacing, and the camera task's own tick. */
#define HW_CAM_FRAME_MS    125
#define HW_CAM_TICK_MS     25

/**
 * Every function below must be called from the camera task and no other.
 *
 * A framebuffer belongs to the driver that produced it, so a teardown racing a
 * capture is a use-after-free on memory another task is writing to the cable.
 * Single ownership removes the race by construction. The two exceptions are
 * marked: they touch a flag and nothing else.
 */
hw_cam_state_t hw_camera_probe(void);

/**
 * Grab one frame, put it on the wire, and give it back to the driver.
 *
 * Capture and send are one call rather than two so that the framebuffer never
 * leaves the file that owns it. Handing the pointer out and documenting that
 * the caller must return it would work exactly until somebody returned early;
 * a buffer that is not given back stalls the pipeline after fb_count grabs,
 * with no error raised anywhere. It presents as the frame rate collapsing on
 * its own, which is a diagnosis nobody would reach quickly.
 *
 * @return whether a frame was actually sent.
 */
bool hw_camera_capture_and_send(uint32_t seq);

hw_cam_state_t hw_camera_state(void);
const char    *hw_camera_state_str(void);
const char    *hw_camera_sensor(void);
int            hw_camera_quality(void);

/** Safe from any task: a volatile flag, read by the owner on its next tick. */
void hw_camera_set_streaming(bool on);
bool hw_camera_streaming(void);

/**
 * @return false when there is no frame rate to report.
 *
 * A camera nobody asked to stream is not producing frames, and saying "0 fps"
 * about it claims a measurement that was never taken. Absent and zero mean
 * different things, so they travel the wire differently — zero means trying
 * and getting nothing, which is a fault worth showing.
 */
bool hw_camera_fps(float *out);

/* ------------------------------------------------------------------------ */
/* the camera probe, counted across reboots                                  */
/* ------------------------------------------------------------------------ */

/**
 * Written to flash BEFORE the attempt it guards, which is the only ordering
 * that survives a probe that never returns. An in-process counter cannot
 * outlive the process, so a board that hangs in esp_camera_init() would come
 * back and hang there again, indefinitely, with nothing recording that it had
 * ever tried.
 */
uint8_t   hw_prov_cam_tries(void);
esp_err_t hw_prov_set_cam_tries(uint8_t n);
