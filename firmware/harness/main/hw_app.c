/* ============================================================================
   hw_app.c — the boundary around the untrusted application layer.
   ----------------------------------------------------------------------------
   The app runs below every reporting task and never owns the wire, camera or
   telemetry buffers. Its calls cross this file so a noisy or blocked app does
   not quietly become a blocked harness.

   The crash counter is committed before app_setup() and cleared after the
   first app_loop() returns. Three crash-boots disable the app while leaving the
   harness alive. A deliberate reset clears the evidence because it says
   nothing about whether the app caused the previous boot to end.
   ========================================================================== */

#include "hw.h"
#include "hw_app.h"

#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>

#include "esp_log.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

static const char *TAG = "hw_app";

#define HW_APP_MAX_CRASH_BOOTS 3
#define HW_APP_LOG_QUEUE_LEN   8
#define HW_APP_LOG_ESCAPED     560

typedef enum {
    APP_STARTING = 0,
    APP_RUNNING,
    APP_DISABLED,
} app_state_t;

typedef struct {
    char key[17];
    double value;
    bool set;
} app_metric_t;

typedef struct {
    char msg[HW_APP_LOG_ESCAPED];
} app_log_t;

static SemaphoreHandle_t s_lock;
static QueueHandle_t s_logs;
static bool s_started;
static volatile app_state_t s_state = APP_STARTING;
static volatile bool s_in_call;
static volatile int64_t s_call_started_us;
static uint32_t s_loops;
static float s_last_loop_ms;
static uint32_t s_dropped;
static uint8_t s_crash_tries;
static app_metric_t s_metrics[HW_APP_METRICS];
static char s_name[32] = "app";
static char s_version[16] = "unknown";
static int64_t s_log_window_us;
static unsigned s_log_window_count;

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

static void sanitise_name(const char *in)
{
    size_t used = 0;
    if (in) {
        while (*in && used < sizeof(s_name) - 1) {
            const char c = *in++;
            const bool allowed = (c >= 'a' && c <= 'z')
                || (c >= '0' && c <= '9') || c == '_' || c == '-';
            s_name[used++] = allowed ? c : '-';
        }
    }
    if (used == 0) {
        memcpy(s_name, "app", 4);
        return;
    }
    s_name[used] = '\0';
}

static void sanitise_version(const char *in)
{
    size_t used = 0;
    if (in) {
        while (*in && used < sizeof(s_version) - 1) {
            const unsigned char c = (unsigned char)*in++;
            s_version[used++] = (c >= 0x20 && c != '"' && c != '\\')
                ? (char)c : '-';
        }
    }
    if (used == 0) {
        memcpy(s_version, "unknown", 8);
        return;
    }
    s_version[used] = '\0';
}

void hw_app_init(void)
{
    sanitise_name(app_info.name);
    sanitise_version(app_info.version);
    s_lock = xSemaphoreCreateMutex();
    s_logs = xQueueCreate(HW_APP_LOG_QUEUE_LEN, sizeof(app_log_t));

    if (!last_reset_was_a_crash() && hw_prov_app_tries() != 0) {
        ESP_LOGI(TAG, "last reset was not a crash; clearing the app counter");
        hw_prov_set_app_tries(0);
    }
    s_crash_tries = hw_prov_app_tries();
}

const char *hw_app_name(void) { return s_name; }
const char *hw_app_version(void) { return s_version; }
uint8_t hw_app_crash_tries(void) { return s_crash_tries; }

static bool call_is_hung(void)
{
    return s_in_call && s_call_started_us > 0
        && (esp_timer_get_time() - s_call_started_us) > HW_APP_HUNG_MS * 1000LL;
}

const char *hw_app_state_str(void)
{
    if (s_state == APP_DISABLED) return "disabled";
    if (call_is_hung()) return "hung";
    return s_state == APP_RUNNING ? "running" : "starting";
}

static bool valid_metric_key(const char *key)
{
    if (!key || !key[0]) return false;
    size_t n = 0;
    for (; key[n]; n++) {
        if (n >= 16) return false;
        const char c = key[n];
        if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_')) {
            return false;
        }
    }
    return n > 0;
}

bool hw_app_metric(const char *key, double value)
{
    if (!valid_metric_key(key) || !isfinite(value) || !s_lock) return false;
    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(20)) != pdTRUE) return false;

    int empty = -1;
    for (int i = 0; i < HW_APP_METRICS; i++) {
        if (s_metrics[i].set && strcmp(s_metrics[i].key, key) == 0) {
            s_metrics[i].value = value;
            xSemaphoreGive(s_lock);
            return true;
        }
        if (!s_metrics[i].set && empty < 0) empty = i;
    }

    if (empty >= 0) {
        snprintf(s_metrics[empty].key, sizeof(s_metrics[empty].key), "%s", key);
        s_metrics[empty].value = value;
        s_metrics[empty].set = true;
        xSemaphoreGive(s_lock);
        return true;
    }

    xSemaphoreGive(s_lock);
    return false;
}

void hw_app_metric_clear(const char *key)
{
    if (!valid_metric_key(key) || !s_lock) return;
    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(20)) != pdTRUE) return;
    for (int i = 0; i < HW_APP_METRICS; i++) {
        if (s_metrics[i].set && strcmp(s_metrics[i].key, key) == 0) {
            memset(&s_metrics[i], 0, sizeof(s_metrics[i]));
            break;
        }
    }
    xSemaphoreGive(s_lock);
}

static void count_dropped(void)
{
    if (s_lock && xSemaphoreTake(s_lock, pdMS_TO_TICKS(20)) == pdTRUE) {
        s_dropped++;
        xSemaphoreGive(s_lock);
    } else {
        s_dropped++;
    }
}

static size_t escape_log(const char *in, char *out, size_t cap)
{
    static const char HEX[] = "0123456789abcdef";
    size_t used = 0;
    while (*in && used + 1 < cap) {
        const unsigned char c = (unsigned char)*in++;
        if (c == '"' || c == '\\') {
            if (used + 2 >= cap) break;
            out[used++] = '\\';
            out[used++] = (char)c;
        } else if (c < 0x20) {
            if (used + 6 >= cap) break;
            out[used++] = '\\'; out[used++] = 'u'; out[used++] = '0'; out[used++] = '0';
            out[used++] = HEX[c >> 4]; out[used++] = HEX[c & 0x0f];
        } else {
            out[used++] = (char)c;
        }
    }
    out[used] = '\0';
    return used;
}

void hw_app_log(const char *fmt, ...)
{
    if (!fmt || !s_logs) { count_dropped(); return; }

    const int64_t now = esp_timer_get_time();
    if (!s_lock || xSemaphoreTake(s_lock, pdMS_TO_TICKS(20)) != pdTRUE) {
        count_dropped();
        return;
    }
    if (now - s_log_window_us >= 1000000LL) {
        s_log_window_us = now;
        s_log_window_count = 0;
    }
    if (s_log_window_count >= HW_APP_LOG_MAX_PER_S) {
        s_dropped++;
        xSemaphoreGive(s_lock);
        return;
    }
    s_log_window_count++;
    xSemaphoreGive(s_lock);

    char raw[200];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(raw, sizeof(raw), fmt, ap);
    va_end(ap);

    app_log_t item = {0};
    escape_log(raw, item.msg, sizeof(item.msg));
    if (xQueueSend(s_logs, &item, 0) != pdTRUE) count_dropped();
}

static void log_task(void *arg)
{
    (void)arg;
    app_log_t item;
    for (;;) {
        if (xQueueReceive(s_logs, &item, portMAX_DELAY) == pdTRUE) {
            hw_proto_sendf("log", "\"src\":\"app\",\"msg\":\"%s\"", item.msg);
        }
    }
}

static void mark_call_started(void)
{
    if (s_lock) xSemaphoreTake(s_lock, portMAX_DELAY);
    s_call_started_us = esp_timer_get_time();
    s_in_call = true;
    if (s_lock) xSemaphoreGive(s_lock);
}

static void mark_loop_returned(int64_t elapsed_us)
{
    if (s_lock) xSemaphoreTake(s_lock, portMAX_DELAY);
    s_in_call = false;
    s_call_started_us = 0;
    s_loops++;
    s_last_loop_ms = (float)elapsed_us / 1000.0f;
    s_state = APP_RUNNING;
    if (s_lock) xSemaphoreGive(s_lock);
}

static void app_task(void *arg)
{
    (void)arg;
    hw_prov_set_app_tries((uint8_t)(s_crash_tries + 1));
    s_crash_tries++;

    mark_call_started();
    app_setup();

    bool first = true;
    for (;;) {
        mark_call_started();
        const int64_t started = esp_timer_get_time();
        app_loop();
        mark_loop_returned(esp_timer_get_time() - started);

        if (first) {
            hw_prov_set_app_tries(0);
            s_crash_tries = 0;
            first = false;
        }
        vTaskDelay(pdMS_TO_TICKS(HW_APP_LOOP_MS));
    }
}

void hw_app_start(void)
{
    if (s_started) return;
    s_started = true;

    if (s_crash_tries >= HW_APP_MAX_CRASH_BOOTS) {
        s_state = APP_DISABLED;
        hw_proto_sendf("status",
            "\"stage\":\"app_disabled\","
            "\"detail\":\"the app crashed before its first loop returned on %u boots\"",
            (unsigned)s_crash_tries);
        ESP_LOGE(TAG, "app disabled after %u crash boots", (unsigned)s_crash_tries);
        return;
    }

    if (s_logs) xTaskCreate(log_task, "hw_app_log", 3072, NULL, 2, NULL);
    if (xTaskCreate(app_task, "hw_app", 8192, NULL, 2, NULL) != pdPASS) {
        s_state = APP_DISABLED;
        hw_proto_status("app_disabled", "the app task could not be created");
    }
}

void hw_app_beat_json(char *out, size_t cap)
{
    if (!out || cap == 0) return;
    out[0] = '\0';

    app_metric_t metrics[HW_APP_METRICS] = {0};
    uint32_t loops = s_loops;
    uint32_t dropped = s_dropped;
    float last_loop_ms = s_last_loop_ms;
    uint8_t crashes = s_crash_tries;

    if (s_lock) xSemaphoreTake(s_lock, portMAX_DELAY);
    memcpy(metrics, s_metrics, sizeof(metrics));
    loops = s_loops;
    dropped = s_dropped;
    last_loop_ms = s_last_loop_ms;
    crashes = s_crash_tries;
    if (s_lock) xSemaphoreGive(s_lock);

    int used = snprintf(out, cap,
        "\"app\":{\"state\":\"%s\",\"loops\":%lu,\"loop_ms\":%.2f,\"m\":{",
        hw_app_state_str(), (unsigned long)loops, (double)last_loop_ms);
    if (used < 0 || (size_t)used >= cap) { out[0] = '\0'; return; }

    bool comma = false;
    for (int i = 0; i < HW_APP_METRICS; i++) {
        if (!metrics[i].set || !isfinite(metrics[i].value)) continue;
        int n = snprintf(out + used, cap - (size_t)used, "%s\"%s\":%.6g",
                         comma ? "," : "", metrics[i].key, metrics[i].value);
        if (n < 0 || (size_t)n >= cap - (size_t)used) break;
        used += n;
        comma = true;
    }

    int n = snprintf(out + used, cap - (size_t)used, "}");
    if (n < 0 || (size_t)n >= cap - (size_t)used) { out[0] = '\0'; return; }
    used += n;

    if (dropped) {
        n = snprintf(out + used, cap - (size_t)used, ",\"dropped\":%lu",
                     (unsigned long)dropped);
        if (n < 0 || (size_t)n >= cap - (size_t)used) { out[0] = '\0'; return; }
        used += n;
    }

    if (strcmp(hw_app_state_str(), "disabled") == 0) {
        n = snprintf(out + used, cap - (size_t)used, ",\"crashes\":%u",
                     (unsigned)crashes);
        if (n < 0 || (size_t)n >= cap - (size_t)used) { out[0] = '\0'; return; }
        used += n;
    }

    n = snprintf(out + used, cap - (size_t)used, "}");
    if (n < 0 || (size_t)n >= cap - (size_t)used) out[0] = '\0';
}

esp_err_t hw_app_camera_set(const char *size, int quality)
{
    if (hw_camera_state() != HW_CAM_OK) return ESP_ERR_INVALID_STATE;
    return hw_camera_request_config(size, quality) ? ESP_OK : ESP_ERR_INVALID_ARG;
}

esp_err_t hw_app_camera_stream(bool on)
{
    if (on && hw_camera_state() != HW_CAM_OK) return ESP_ERR_INVALID_STATE;
    hw_camera_set_streaming(on);
    return ESP_OK;
}

int64_t hw_app_uptime_ms(void)
{
    return esp_timer_get_time() / 1000;
}

__attribute__((weak))
void app_on_frame(const uint8_t *jpeg, size_t len, int width, int height)
{
    (void)jpeg;
    (void)len;
    (void)width;
    (void)height;
}
