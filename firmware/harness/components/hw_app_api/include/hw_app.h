/* hw_app.h — what an application layer may use, and what it must provide.
 *
 * The harness owns the wire, the telemetry, the camera driver and the radio.
 * An app runs on its own task, below the heartbeat, and talks to the world
 * through the calls below. Everything else the app does is its own business,
 * and everything that goes wrong with it is reported by the harness, which
 * keeps running.
 *
 * Every function here is safe to call from app_setup() and app_loop() only,
 * unless it says otherwise. */
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"

/* ---- what the app provides ---------------------------------------------- */

typedef struct {
    const char *name;      /* [a-z0-9_-]{1,31}: reported in every hello as app.name */
    const char *version;   /* free text, up to 15 chars: app.ver */
} hw_app_info_t;

/** Defined by the app. The harness reads it at boot. */
extern const hw_app_info_t app_info;

/** Called once on the app task, after the harness is reporting. Return promptly. */
void app_setup(void);

/**
 * Called every HW_APP_LOOP_MS on the app task. Return promptly: a loop that
 * blocks longer than HW_APP_HUNG_MS is reported as "hung" in every beat until
 * it returns, and the harness keeps beating regardless. Do not call
 * vTaskDelay for long periods here; keep state and return.
 */
void app_loop(void);

/**
 * Optional. Called on the camera task's 6144-byte stack for every frame the
 * harness captures while streaming, before the frame goes on the wire. Keep
 * it short: the camera task is paced by this call. Defined weak in the harness
 * as a no-op.
 */
void app_on_frame(const uint8_t *jpeg, size_t len, int width, int height);

#define HW_APP_LOOP_MS   100
#define HW_APP_HUNG_MS   3000

/* ---- what the app may use ----------------------------------------------- */

/**
 * A line on the wire, tagged as the app's: {"t":"log","src":"app","msg":...}.
 * Shows in the page's monitor and in the get_wire_tail tool. Rate-limited to
 * HW_APP_LOG_MAX_PER_S; lines past that are counted and reported as dropped.
 * The call only queues the line, so a stalled wire cannot stall the app.
 */
void hw_app_log(const char *fmt, ...);
#define HW_APP_LOG_MAX_PER_S 20

/**
 * Publish a finite number the app measures. It travels in every beat under
 * app.m.<key>, where the page charts it and an agent can watch it.
 *
 * key: [a-z0-9_]{1,16}. At most HW_APP_METRICS keys; a new key past that is
 * refused (false). Set the same key again to update it. A key never set is
 * absent from the beat, never zero. Values use a bounded six-significant-digit
 * representation on the wire so one metric cannot consume the whole frame.
 */
bool hw_app_metric(const char *key, double value);
#define HW_APP_METRICS 8

/** Stop publishing a key. */
void hw_app_metric_clear(const char *key);

/**
 * Ask the harness to run the camera at a frame size and JPEG quality.
 *
 * size is a ladder name: QQVGA QVGA CIF HVGA VGA SVGA XGA HD SXGA UXGA.
 * quality is clamped to 10..63; a lower number is higher image quality and
 * larger frames. The request is applied by the camera task on its next tick,
 * and the result is reported on the wire as cfg_ack and a fresh caps. Returns
 * ESP_ERR_INVALID_ARG for a name not on the ladder,
 * ESP_ERR_INVALID_STATE when there is no camera, ESP_OK when queued. Safe from
 * any task.
 */
esp_err_t hw_app_camera_set(const char *size, int quality);

/**
 * Turn the stream on or off, as the page's `cam` frame does. Safe from any
 * task. Returns ESP_ERR_INVALID_STATE when asked to start without a camera.
 */
esp_err_t hw_app_camera_stream(bool on);

/** Milliseconds since boot. */
int64_t hw_app_uptime_ms(void);
