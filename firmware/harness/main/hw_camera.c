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

#include <stdio.h>
#include <string.h>

#include "esp_camera.h"
#include "esp_log.h"
#include "esp_timer.h"

static const char *TAG = "hw_camera";

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

/* ------------------------------------------------------------------------ */
/* what it is                                                                */
/* ------------------------------------------------------------------------ */

hw_cam_state_t hw_camera_state(void)  { return s_cam; }
const char    *hw_camera_sensor(void) { return s_sensor; }
int            hw_camera_quality(void) { return HW_CAM_JPEG_QUALITY; }

void hw_camera_set_streaming(bool on) { s_streaming = on; }
bool hw_camera_streaming(void)        { return s_streaming; }

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
        /* Conservative on purpose. The harness only has to prove the sensor
           works. Finding the resolution and quality a given board can actually
           sustain is the job of whatever runs on top, and is the entire point
           of the project — so the harness must not quietly pick the answer. */
        .frame_size = FRAMESIZE_SVGA,
        .jpeg_quality = HW_CAM_JPEG_QUALITY,
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
    }

    s_cam = HW_CAM_OK;
    s_frames = 0;
    s_fps = 0.0f;
    s_window_us = esp_timer_get_time();
    return s_cam;
}

hw_cam_state_t hw_camera_probe(void)
{
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
    if (!fb) return false;

    s_frames++;
    fps_roll();

    hw_proto_send_image(fb->buf, fb->len, seq,
                        (int)fb->width, (int)fb->height, HW_CAM_JPEG_QUALITY);

    esp_camera_fb_return(fb);
    return true;
}
