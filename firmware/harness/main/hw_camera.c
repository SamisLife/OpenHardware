/* ============================================================================
   hw_camera.c — the one call that can take the board down.
   ----------------------------------------------------------------------------
   Everything in hw_sensors.c is a core call that degrades rather than fails.
   esp_camera_init() is not. It is board-variant dependent, it is sensitive to
   a half-seated ribbon, it can pull enough current through a marginal supply
   to brown the rail out, and on some module and cable combinations it does not
   return at all.

   That is why it lives in its own file and runs on its own task, after the
   board is already reporting. The split is structural rather than a comment
   in a shared file, because the property being protected is structural: a
   camera that kills the board must not be able to take the telemetry that
   would have explained it.

   ----------------------------------------------------------------------------
   A GUARD THAT SURVIVES THE THING IT GUARDS AGAINST

   The retry counter is written to NVS BEFORE the attempt, not after it fails.
   An in-process guard cannot outlive a process that never returns: a probe
   that hangs leaves an in-memory counter at whatever it was, and the next boot
   tries again, hangs again, forever. A counter committed to flash first means
   a board that dies three times in the same place comes up the fourth time
   with the camera skipped and says so, which is a board somebody can still
   reach and fix.

   Nothing clears the counter except a probe that returned — including one that
   returned an error. A clean failure is a good outcome: the board said no
   instead of dying, and that path is repeatable and cheap.

   ----------------------------------------------------------------------------
   ONE OWNER

   Every call into esp_camera_* happens on the camera task. A framebuffer
   belongs to the driver that produced it, so anything that deinitialises the
   driver while another task is halfway through sending a buffer down the wire
   is a use-after-free. One owner removes that race by construction instead of
   defending against it with a lock that has to be right at every call site —
   now, and in whatever gets written against this later.
   ========================================================================== */

#include "hw.h"
#include "hw_app.h"

#include <stdio.h>
#include <string.h>

#include "driver/i2c.h"
#include "esp_camera.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"

static const char *TAG = "hw_camera";

/**
 * The I2C port the camera component put SCCB on.
 *
 * The legacy driver, deliberately: main/CMakeLists.txt explains why the new
 * one cannot be linked alongside the camera on this IDF, and this file is the
 * only other thing in the harness that touches the bus. A probe here is the
 * same start-address-stop the SCCB layer itself issues.
 */
#define SCCB_PORT I2C_NUM_1

/** Consecutive silent probes. See hw_camera_watch(). */
static int s_misses = 0;

/** When a frame was last captured. Liveness, when frames are flowing. */
static int64_t s_last_capture_us = 0;

/**
 * Whether the last attempt to grab a frame came back empty.
 *
 * A capture that failed is the first evidence a removal produces, and it
 * arrives a frame period after the ribbon moves rather than a watch period.
 * Holding it here lets the watcher stop trusting the liveness window the
 * moment it stops being true.
 */
static bool s_capture_failed = false;

/* ----------------------------------------------------------------------------
   THE ONLY BOARD-SPECIFIC THING IN THE HARNESS

   Pin map for the reference module (XIAO ESP32S3 Sense, per the published
   schematic). A different carrier needs a different map and nothing else here
   changes — which is why it is one block with a name rather than constants
   spread through the init call.

   Discovering this map at runtime is not possible. There is no enumeration on
   a parallel camera interface: the pins are wired or they are not, and a wrong
   guess produces a sensor that never acknowledges rather than an error that
   says which pin was wrong.
   -------------------------------------------------------------------------- */

#define CAM_PIN_PWDN    -1
#define CAM_PIN_RESET   -1
#define CAM_PIN_XCLK    10
#define CAM_PIN_SIOD    40
#define CAM_PIN_SIOC    39
#define CAM_PIN_D7      48
#define CAM_PIN_D6      11
#define CAM_PIN_D5      12
#define CAM_PIN_D4      14
#define CAM_PIN_D3      16
#define CAM_PIN_D2      18
#define CAM_PIN_D1      17
#define CAM_PIN_D0      15
#define CAM_PIN_VSYNC   38
#define CAM_PIN_HREF    47
#define CAM_PIN_PCLK    13

/** The window the frame rate is measured over. */
#define FPS_WINDOW_US   1000000

/* ------------------------------------------------------------------------ */

static hw_cam_state_t s_cam = HW_CAM_UNTRIED;
static char           s_sensor[16] = "none";
static esp_err_t      s_last_err = ESP_OK;

/* Off until a host asks. A board nobody is watching should not be spending
   cable bandwidth and PSRAM bandwidth producing pictures for nobody. */
static volatile bool  s_streaming = false;

static uint32_t s_frames = 0;
static int64_t  s_window_us = 0;
static float    s_fps = 0.0f;

typedef struct {
    framesize_t size;
    int quality;
} camera_request_t;

typedef struct {
    const char *name;
    framesize_t size;
} camera_size_t;

static const camera_size_t SIZES[] = {
    { "QQVGA", FRAMESIZE_QQVGA },
    { "QVGA",  FRAMESIZE_QVGA  },
    { "CIF",   FRAMESIZE_CIF   },
    { "HVGA",  FRAMESIZE_HVGA  },
    { "VGA",   FRAMESIZE_VGA   },
    { "SVGA",  FRAMESIZE_SVGA  },
    { "XGA",   FRAMESIZE_XGA   },
    { "HD",    FRAMESIZE_HD    },
    { "SXGA",  FRAMESIZE_SXGA  },
    { "UXGA",  FRAMESIZE_UXGA  },
};

static QueueHandle_t s_config_queue;
static framesize_t s_running_size = FRAMESIZE_SVGA;
static int s_running_quality = HW_CAM_JPEG_QUALITY;

/* ------------------------------------------------------------------------ */
/* what it is                                                                */
/* ------------------------------------------------------------------------ */

hw_cam_state_t hw_camera_state(void)  { return s_cam; }
const char    *hw_camera_sensor(void) { return s_sensor; }
int            hw_camera_quality(void) { return s_running_quality; }

void hw_camera_set_streaming(bool on) { s_streaming = on; }
bool hw_camera_streaming(void)        { return s_streaming; }

static const camera_size_t *size_by_name(const char *name)
{
    if (!name) return NULL;
    for (size_t i = 0; i < sizeof(SIZES) / sizeof(SIZES[0]); i++) {
        if (strcmp(SIZES[i].name, name) == 0) return &SIZES[i];
    }
    return NULL;
}

static const char *name_by_size(framesize_t size)
{
    for (size_t i = 0; i < sizeof(SIZES) / sizeof(SIZES[0]); i++) {
        if (SIZES[i].size == size) return SIZES[i].name;
    }
    return "unknown";
}

const char *hw_camera_size_name(void)
{
    return name_by_size(s_running_size);
}

void hw_camera_init(void)
{
    if (!s_config_queue) s_config_queue = xQueueCreate(1, sizeof(camera_request_t));
}

bool hw_camera_request_config(const char *size, int quality)
{
    const camera_size_t *found = size_by_name(size);
    if (!found || !s_config_queue) return false;

    camera_request_t request = {
        .size = found->size,
        .quality = quality < 10 ? 10 : (quality > 63 ? 63 : quality),
    };
    return xQueueOverwrite(s_config_queue, &request) == pdTRUE;
}

const char *hw_camera_state_str(void)
{
    switch (s_cam) {
        case HW_CAM_OK:      return "ok";
        case HW_CAM_ABSENT:  return "absent";
        case HW_CAM_FAULTED: return "faulted";
        default:             return "untried";
    }
}

/**
 * Roll the measurement window if it has closed.
 *
 * Called on capture and on read, deliberately. A window that only advanced on
 * capture would leave the last healthy rate sitting in the variable forever
 * once captures stopped — so a stalled pipeline would keep reporting the rate
 * it used to manage. That is precisely the failure this instrument exists to
 * catch, and it must not be the one thing it cannot see.
 */
static void fps_roll(void)
{
    const int64_t now = esp_timer_get_time();
    const int64_t span = now - s_window_us;
    if (span < FPS_WINDOW_US) return;

    s_fps = (float)s_frames * 1000000.0f / (float)span;
    s_frames = 0;
    s_window_us = now;
}

/**
 * @return false when there is no rate to report, leaving *out untouched.
 *
 * Not producing frames is reported by omitting the field rather than by
 * sending zero. Zero is a measurement — it means "trying and getting nothing",
 * which is a fault — and a camera that was never asked to stream is not
 * faulty. The two have to look different on the wire.
 */
bool hw_camera_fps(float *out)
{
    if (!out || s_cam != HW_CAM_OK || !s_streaming) return false;
    fps_roll();
    *out = s_fps;
    return true;
}

/* ------------------------------------------------------------------------ */
/* bring-up                                                                  */
/* ------------------------------------------------------------------------ */

/**
 * Bring the sensor up and identify it.
 *
 * No NVS and no status frames here — the caller decides what a failure means
 * and how loudly to say it, and there is more than one caller once hot-plug
 * exists.
 *
 * The leading deinit is not defensive noise. A failed esp_camera_init() runs
 * its own cleanup, but a *successful* one followed by a second init would
 * leak XCLK and the SCCB bus, and this function is the retry path.
 */
static hw_cam_state_t bring_up(void)
{
    esp_camera_deinit();

    camera_config_t cfg = {
        .pin_pwdn = CAM_PIN_PWDN,
        .pin_reset = CAM_PIN_RESET,
        .pin_xclk = CAM_PIN_XCLK,
        .pin_sccb_sda = CAM_PIN_SIOD,
        .pin_sccb_scl = CAM_PIN_SIOC,
        .pin_d7 = CAM_PIN_D7, .pin_d6 = CAM_PIN_D6,
        .pin_d5 = CAM_PIN_D5, .pin_d4 = CAM_PIN_D4,
        .pin_d3 = CAM_PIN_D3, .pin_d2 = CAM_PIN_D2,
        .pin_d1 = CAM_PIN_D1, .pin_d0 = CAM_PIN_D0,
        .pin_vsync = CAM_PIN_VSYNC,
        .pin_href = CAM_PIN_HREF,
        .pin_pclk = CAM_PIN_PCLK,

        .xclk_freq_hz = 20000000,
        .ledc_timer = LEDC_TIMER_0,
        .ledc_channel = LEDC_CHANNEL_0,

        .pixel_format = PIXFORMAT_JPEG,
        /* Buffers are allocated once. Initialising at the largest supported
           rung makes later set-down and set-up requests safe without tearing
           down the driver or reallocating memory under a live stream. */
        .frame_size = FRAMESIZE_UXGA,
        .jpeg_quality = s_running_quality,
        .fb_count = 2,
        .fb_location = CAMERA_FB_IN_PSRAM,
        .grab_mode = CAMERA_GRAB_LATEST,
    };

    s_last_err = esp_camera_init(&cfg);
    if (s_last_err != ESP_OK) {
        strcpy(s_sensor, "none");
        s_cam = HW_CAM_ABSENT;
        return s_cam;
    }

    /* Read off the silicon, not assumed from the board name. A carrier can be
       populated with any of these, and the number that comes back is the one
       fact about the module that is not a guess. */
    sensor_t *s = esp_camera_sensor_get();
    if (s) {
        switch (s->id.PID) {
            case OV2640_PID: strcpy(s_sensor, "OV2640"); break;
            case OV3660_PID: strcpy(s_sensor, "OV3660"); break;
            case OV5640_PID: strcpy(s_sensor, "OV5640"); break;
            case OV7725_PID: strcpy(s_sensor, "OV7725"); break;
            default:
                snprintf(s_sensor, sizeof(s_sensor), "0x%02X", s->id.PID);
                break;
        }
        /* UXGA sized the buffers; the configured rung is what actually runs.
           A hot-plug re-init follows the same path and therefore restores the
           last accepted request instead of silently returning to defaults. */
        if (s->set_framesize(s, s_running_size) != 0
            || s->set_quality(s, s_running_quality) != 0) {
            s_last_err = ESP_ERR_CAMERA_FAILED_TO_SET_FRAME_SIZE;
            esp_camera_deinit();
            strcpy(s_sensor, "none");
            s_cam = HW_CAM_ABSENT;
            return s_cam;
        }
        s_running_size = s->status.framesize;
        s_running_quality = s->status.quality;
    } else {
        s_last_err = ESP_ERR_INVALID_STATE;
        esp_camera_deinit();
        strcpy(s_sensor, "none");
        s_cam = HW_CAM_ABSENT;
        return s_cam;
    }

    s_cam = HW_CAM_OK;
    s_frames = 0;
    s_fps = 0.0f;
    s_window_us = esp_timer_get_time();
    return s_cam;
}

/* ------------------------------------------------------------------------ */
/* runtime configuration                                                     */
/* ------------------------------------------------------------------------ */

int hw_camera_apply_pending(const char **err)
{
    if (err) *err = NULL;
    if (!s_config_queue) return 0;

    camera_request_t request;
    if (xQueueReceive(s_config_queue, &request, 0) != pdTRUE) return 0;

    if (s_cam != HW_CAM_OK) {
        if (err) *err = "no camera";
        return -1;
    }
    if (request.size > FRAMESIZE_UXGA) {
        if (err) *err = "ESP_ERR_INVALID_SIZE";
        return -1;
    }

    sensor_t *sensor = esp_camera_sensor_get();
    if (!sensor) {
        if (err) *err = "no camera";
        return -1;
    }

    const framesize_t previous_size = s_running_size;
    const int previous_quality = s_running_quality;
    if (sensor->set_framesize(sensor, request.size) != 0) {
        if (err) *err = "ESP_ERR_CAMERA_FAILED_TO_SET_FRAME_SIZE";
        return -1;
    }
    if (sensor->set_quality(sensor, request.quality) != 0) {
        sensor->set_framesize(sensor, previous_size);
        sensor->set_quality(sensor, previous_quality);
        if (err) *err = "ESP_ERR_CAMERA_FAILED_TO_SET_QUALITY";
        return -1;
    }

    s_running_size = sensor->status.framesize;
    s_running_quality = sensor->status.quality;
    s_frames = 0;
    s_fps = 0.0f;
    s_window_us = esp_timer_get_time();
    hw_proto_reset_image_budget_notice();
    return 1;
}

void hw_camera_drain_frames(void)
{
    /* Acknowledgement precedes this drain in camera_task. esp_camera_fb_get()
       may wait several seconds on a stalled sensor, and a successfully applied
       request must not look unacknowledged while old queued frames are cleared. */
    for (int i = 0; i < 2; i++) {
        camera_fb_t *fb = esp_camera_fb_get();
        if (!fb) break;
        esp_camera_fb_return(fb);
    }
}

/**
 * Whether the last reset was the board dying, as opposed to being told to.
 *
 * The counter guards against a probe that takes the board down, and it counts
 * disappearances: a boot that entered the probe and never cleared the flag.
 * But a host resets this board constantly during bring-up — every port open
 * asserts DTR and RTS, which are the reset and boot straps — and a reset that
 * lands in the second between the counter being written and the probe
 * returning looks, to the counter, exactly like the probe crashing. Three
 * reflashes in a row and a perfectly good camera is declared faulted until
 * somebody erases NVS.
 *
 * So the reason is consulted. A panic, a watchdog or a brownout is the board
 * dying and counts. Power-on, the EN pin, a software restart: somebody reset
 * the board on purpose, and the probe never got a chance to prove anything
 * either way. UNKNOWN counts, because a reset that cannot be explained is not
 * one to be optimistic about.
 */
static bool last_reset_was_a_crash(void)
{
    switch (esp_reset_reason()) {
        case ESP_RST_PANIC:
        case ESP_RST_INT_WDT:
        case ESP_RST_TASK_WDT:
        case ESP_RST_WDT:
        case ESP_RST_BROWNOUT:
        case ESP_RST_UNKNOWN:
            return true;
        default:
            return false;
    }
}

hw_cam_state_t hw_camera_probe(void)
{
    /* A boot that follows a deliberate reset starts the count over. The
       previous boot did not die in the probe; it was interrupted, and an
       interruption is not evidence about the camera. */
    if (!last_reset_was_a_crash() && hw_prov_cam_tries() != 0) {
        ESP_LOGI(TAG, "last reset was not a crash; clearing the camera probe counter");
        hw_prov_set_cam_tries(0);
    }

    const uint8_t tries = hw_prov_cam_tries();

    if (tries >= HW_CAM_MAX_TRIES) {
        ESP_LOGE(TAG, "camera probe faulted %u boots running; not retrying",
                 (unsigned)tries);
        hw_proto_sendf("status",
            "\"stage\":\"camera_faulted\","
            "\"detail\":\"the probe crashed the board %u boots running\"",
            (unsigned)tries);
        s_cam = HW_CAM_FAULTED;
        return s_cam;
    }

    /* Committed before the attempt. See the note at the top of this file: a
       guard that only records failures it survived does not guard against the
       failure that matters. */
    hw_prov_set_cam_tries((uint8_t)(tries + 1));
    hw_proto_status("camera_probe", "initialising sensor");

    if (bring_up() != HW_CAM_OK) {
        /* Returning an error is a good outcome — the board said no rather than
           dying — so the counter goes back to zero. Otherwise three boots with
           no camera attached would leave a board that refuses to look for one. */
        hw_prov_set_cam_tries(0);
        ESP_LOGW(TAG, "no camera: %s", esp_err_to_name(s_last_err));
        hw_proto_sendf("status",
            "\"stage\":\"camera_absent\",\"detail\":\"%s\"",
            esp_err_to_name(s_last_err));
        return s_cam;
    }

    hw_prov_set_cam_tries(0);
    ESP_LOGI(TAG, "camera up: %s", s_sensor);
    hw_proto_sendf("status", "\"stage\":\"camera_ok\",\"detail\":\"%s\"", s_sensor);
    return s_cam;
}

/* ------------------------------------------------------------------------ */
/* hot-plug                                                                  */
/* ------------------------------------------------------------------------ */

/**
 * Whether the sensor still acknowledges its address.
 *
 * One start, the address, one stop. No register is read, because the question
 * is not "what does it say" but "is anything there to say it" — and the
 * acknowledgement bit is the only thing on this bus that answers that.
 *
 * A failure to build the command is not evidence of absence, so it counts as
 * alive: a board short of memory has a different problem, and it is not that
 * its camera fell off.
 */
static bool sccb_alive(void)
{
    sensor_t *s = esp_camera_sensor_get();
    if (!s || !s->slv_addr) return false;

    i2c_cmd_handle_t cmd = i2c_cmd_link_create();
    if (!cmd) return true;

    i2c_master_start(cmd);
    i2c_master_write_byte(cmd, (uint8_t)((s->slv_addr << 1) | I2C_MASTER_WRITE), true);
    i2c_master_stop(cmd);
    const esp_err_t err = i2c_master_cmd_begin(SCCB_PORT, cmd, pdMS_TO_TICKS(50));
    i2c_cmd_link_delete(cmd);

    return err == ESP_OK;
}

bool hw_camera_watch(void)
{
    switch (s_cam) {

    case HW_CAM_OK:
        /* A frame arrived a moment ago, so the sensor is there. Asking the bus
           to confirm what a filled framebuffer already proved would only add a
           transaction the driver has to share the bus with, and a miss caused
           by that contention reads exactly like a removal. */
        if (s_streaming && !s_capture_failed
            && (esp_timer_get_time() - s_last_capture_us) < HW_CAM_LIVE_US) {
            s_misses = 0;
            return false;
        }
        if (sccb_alive()) { s_misses = 0; return false; }
        /* Said every time, not only on the miss that evicts. A camera that is
           being evicted wrongly is a camera that keeps coming and going, and
           the count is the only thing that distinguishes that from a ribbon
           somebody pulled. */
        ESP_LOGW(TAG, "camera did not acknowledge on SCCB (miss %d of %d)",
                 s_misses + 1, HW_CAM_MISSES);
        if (++s_misses < HW_CAM_MISSES) return false;

        /* Gone. Streaming is cleared before the driver is released — the
           frame loop checks that flag and shares this task, so no framebuffer
           can be in flight across the deinit. Single ownership is what makes
           that true by construction rather than by luck. */
        s_streaming = false;
        esp_camera_deinit();
        strcpy(s_sensor, "none");
        s_cam = HW_CAM_ABSENT;
        s_misses = 0;
        s_frames = 0;
        s_fps = 0.0f;
        s_capture_failed = false;
        hw_proto_reset_image_budget_notice();

        ESP_LOGW(TAG, "camera stopped answering on SCCB; treating it as removed");
        hw_proto_status("camera_absent", "the sensor stopped answering");
        return true;

    case HW_CAM_ABSENT: {
        /* No NVS counting on this path, and that is not a gap. The counter
           exists to survive a probe that never returns; a probe that takes the
           board down still lands on the counted boot probe when it comes back.
           Counting here too would write flash once a second for as long as a
           board sits with nothing attached. */
        if (hw_prov_cam_tries() >= HW_CAM_MAX_TRIES) return false;

        /* The component narrates a failed probe at ERROR level across three
           tags, and this runs once a second for as long as no camera is
           attached. On an endpoint shared with the protocol that is not noise,
           it is the monitor being unusable. Silenced for the attempt only; the
           boot probe still narrates in full, and so does a success. */
        esp_log_level_set("camera", ESP_LOG_NONE);
        esp_log_level_set("sccb", ESP_LOG_NONE);
        esp_log_level_set("cam_hal", ESP_LOG_NONE);
        const hw_cam_state_t got = bring_up();
        esp_log_level_set("camera", ESP_LOG_INFO);
        esp_log_level_set("sccb", ESP_LOG_INFO);
        esp_log_level_set("cam_hal", ESP_LOG_INFO);

        if (got != HW_CAM_OK) return false;

        ESP_LOGI(TAG, "camera attached: %s", s_sensor);
        hw_proto_sendf("status", "\"stage\":\"camera_ok\",\"detail\":\"%s\"", s_sensor);
        return true;
    }

    default:
        /* UNTRIED belongs to the boot probe. FAULTED is never touched again
           without a manual erase, which is the whole point of FAULTED. */
        return false;
    }
}

/* ------------------------------------------------------------------------ */
/* capture                                                                   */
/* ------------------------------------------------------------------------ */

/**
 * One frame: grabbed, sent, and given back.
 *
 * All three in one function because the framebuffer must not outlive it. The
 * driver owns that memory, and anything that tears the driver down while a
 * pointer to it is still in flight is a use-after-free on a buffer being
 * written to the cable. Keeping the pointer inside this file means there is no
 * call site anywhere that could hold one.
 *
 * Returning it is not optional in the other direction either: miss it fb_count
 * times and the pipeline stalls with no error raised, which presents as the
 * frame rate quietly collapsing. That is why the rate is measured on a window
 * that closes on its own rather than one that only advances when a frame
 * arrives — the symptom has to be visible even when the cause is silence.
 */
bool hw_camera_capture_and_send(uint32_t seq)
{
    if (s_cam != HW_CAM_OK) return false;

    camera_fb_t *fb = esp_camera_fb_get();
    if (!fb) {
        /* The watcher stops trusting the liveness window on this, so a sensor
           that has stopped producing is probed on the next tick rather than
           two seconds later. */
        s_capture_failed = true;
        return false;
    }

    s_capture_failed = false;
    s_last_capture_us = esp_timer_get_time();

    app_on_frame(fb->buf, fb->len, (int)fb->width, (int)fb->height);
    const bool sent = hw_proto_send_image(fb->buf, fb->len, seq,
                                          (int)fb->width, (int)fb->height,
                                          s_running_quality);
    if (sent) s_frames++;
    fps_roll();

    esp_camera_fb_return(fb);
    return sent;
}
