/* ============================================================================
   main.c — bring-up order, and what it is for.
   ----------------------------------------------------------------------------
   The order below is the most important thing in this file:

       1. NVS               cannot fail in a way there is no recovery from
       2. the wire          so there is a channel before anything else runs
       3. safe telemetry    temperature, memory, flash, clock — none can hang
       4. identity          the board says what it is, repeatedly
       5. heartbeat         and keeps saying how it is, from this point on

   NOTHING THAT CAN FAIL RUNS BEFORE THE THING THAT REPORTS FAILURES.

   Everything here is in the first group. The steps that can genuinely take the
   system down — bringing up a camera, joining a network — arrive later and run
   after this point precisely so that when one of them does fail, the board is
   already reporting and can say so.

   A board with a cable in it is fully observable from here: no network, no
   credentials, no server, nothing to configure. That is deliberate. The cable
   is the path that always exists, and everything optional is an additional
   consumer of the same sample rather than a prerequisite for producing it.
   ========================================================================== */

#include "hw.h"

#include <stdio.h>
#include <string.h>

#include "esp_app_desc.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_ota_ops.h"
#include "esp_random.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "harness";

static hw_creds_t s_creds;
static char s_boot_id[9];
static char s_mac[18];
static char s_sha[17];

/* ------------------------------------------------------------------------ */
/* identity                                                                  */
/* ------------------------------------------------------------------------ */

static const char *reset_reason_str(void)
{
    switch (esp_reset_reason()) {
        case ESP_RST_POWERON:  return "POWERON";
        case ESP_RST_EXT:      return "EXT";
        case ESP_RST_SW:       return "SW";
        case ESP_RST_PANIC:    return "PANIC";
        case ESP_RST_INT_WDT:  return "INT_WDT";
        case ESP_RST_TASK_WDT: return "TASK_WDT";
        case ESP_RST_WDT:      return "WDT";
        case ESP_RST_BROWNOUT: return "BROWNOUT";
        case ESP_RST_SDIO:     return "SDIO";
        default:               return "UNKNOWN";
    }
}

/**
 * A fresh identifier every power-up.
 *
 * A host compares it against the last one it saw, and a change nobody ordered
 * means the board restarted on its own. Once images can be replaced remotely,
 * that is precisely how one that failed and was rolled back announces itself.
 */
static void make_boot_id(void)
{
    snprintf(s_boot_id, sizeof(s_boot_id), "%04lx%04lx",
             (unsigned long)(esp_random() & 0xFFFF),
             (unsigned long)(esp_random() & 0xFFFF));
}

static void read_mac(void)
{
    uint8_t m[6] = {0};
    esp_read_mac(m, ESP_MAC_WIFI_STA);
    snprintf(s_mac, sizeof(s_mac), "%02X:%02X:%02X:%02X:%02X:%02X",
             m[0], m[1], m[2], m[3], m[4], m[5]);
}

/** The first eight bytes of the image hash: which build this actually is. */
static void read_sha(void)
{
    const esp_app_desc_t *app = esp_app_get_description();
    for (int i = 0; i < 8; i++) {
        snprintf(s_sha + i * 2, 3, "%02x", app->app_elf_sha256[i]);
    }
    s_sha[16] = '\0';
}

/**
 * The identity frame.
 *
 * Carries the board's constants, so nothing downstream has to assume any of
 * them: total heap and PSRAM are the denominators a host would otherwise have
 * to invent, and the throttle point is a property of the part that a page has
 * no way to know.
 */
static void send_hello(void)
{
    const esp_partition_t *running = esp_ota_get_running_partition();

    float temp = 0.0f;
    bool have_temp = hw_sensors_temp_c(&temp);

    hw_proto_sendf("hello",
        "\"proto\":%d,\"fw\":\"%s\",\"sha\":\"%s\",\"slot\":\"%s\","
        "\"board\":\"%s\",\"board_name\":\"%s\",\"chip\":\"esp32s3\","
        "\"mac\":\"%s\",\"boot_id\":\"%s\",\"reset\":\"%s\","
        "\"provisioned\":%s,\"ssid\":\"%s\","
        "\"psram\":%lu,\"flash\":%lu,\"heap\":%lu,\"heap_total\":%lu,"
        "\"temp_crit_c\":85,\"rx\":%lu%s%.1f",
        HW_PROTO_VERSION, HW_FW_VERSION, s_sha,
        running ? running->label : "unknown",
        HW_BOARD_ID, HW_BOARD_NAME,
        s_mac, s_boot_id, reset_reason_str(),
        s_creds.have_wifi ? "true" : "false", s_creds.ssid,
        (unsigned long)hw_sensors_psram_size(),
        (unsigned long)hw_sensors_flash_size(),
        (unsigned long)hw_sensors_heap_free(),
        (unsigned long)hw_sensors_heap_total(),
        (unsigned long)hw_proto_rx_bytes(),
        /* Omitted entirely when there is no sensor, rather than sent as a
           sentinel. A reader can only interpret an absent field one way. */
        have_temp ? ",\"temp_c\":" : "", have_temp ? temp : 0.0f);
}

/* ------------------------------------------------------------------------ */
/* inbound                                                                   */
/* ------------------------------------------------------------------------ */

static void on_frame(const char *type, const char *json)
{
    (void)json;

    if (strcmp(type, "ping") == 0) {
        send_hello();
        return;
    }

    if (strcmp(type, "erase") == 0) {
        esp_err_t err = hw_prov_erase();
        hw_proto_sendf("prov_ack", "\"ok\":%s,\"erased\":true",
                       err == ESP_OK ? "true" : "false");
        return;
    }
}

/* ------------------------------------------------------------------------ */
/* tasks                                                                     */
/* ------------------------------------------------------------------------ */

/**
 * Keeps announcing the board while anything might be listening.
 *
 * Fast at first, then slow. A host attaches at a moment this end cannot
 * predict — after a reset the USB device re-enumerates and the page reopens
 * the port whenever that finishes — so an identity sent once at boot is one
 * that nothing hears.
 */
static void hello_task(void *arg)
{
    (void)arg;
    const int64_t started = esp_timer_get_time();

    for (;;) {
        send_hello();
        bool early = (esp_timer_get_time() - started) < (HW_HELLO_FAST_FOR_MS * 1000LL);
        vTaskDelay(pdMS_TO_TICKS(early ? HW_HELLO_FAST_MS : HW_HELLO_SLOW_MS));
    }
}

/**
 * Telemetry, every 250 ms, over the cable — always.
 *
 * This path depends on nothing. No network, no credentials, no server. A board
 * on a bench with a cable in it is fully observable, and anything optional is
 * an additional consumer of this sample rather than a condition for producing
 * it.
 */
static void beat_task(void *arg)
{
    (void)arg;

    /* A fixed period rather than a fixed delay: the work above takes time, and
       delaying by the period after doing it makes the interval drift by however
       long that was. A recorder whose paper advances on the wall clock shows
       that drift as jitter. */
    TickType_t next = xTaskGetTickCount();

    for (;;) {
        float temp = 0.0f;
        bool have_temp = hw_sensors_temp_c(&temp);

        hw_proto_sendf("beat",
            "\"uptime_s\":%.2f,\"heap_free\":%lu,\"psram_free\":%lu,"
            "\"psram_largest\":%lu,\"cpu_mhz\":%d,\"boot_id\":\"%s\"%s%.2f",
            (double)esp_timer_get_time() / 1000000.0,
            (unsigned long)hw_sensors_heap_free(),
            (unsigned long)hw_sensors_psram_free(),
            (unsigned long)hw_sensors_psram_largest(),
            hw_sensors_cpu_mhz(),
            s_boot_id,
            have_temp ? ",\"temp_c\":" : "", have_temp ? temp : 0.0f);

        /* No rssi and no fps in this build. There is no radio brought up and
           no camera, and reporting a plausible-looking zero for either would be
           inventing a measurement. Absent is the truth. */

        vTaskDelayUntil(&next, pdMS_TO_TICKS(HW_BEAT_MS));
    }
}

/* ------------------------------------------------------------------------ */

void app_main(void)
{
    /* 1. Storage. */
    esp_err_t err = hw_prov_init();
    if (err != ESP_OK) ESP_LOGE(TAG, "nvs unavailable: %s", esp_err_to_name(err));

    /* 2. The channel, before anything that might need to report a problem. */
    ESP_ERROR_CHECK(hw_proto_init(on_frame));

    /* 3. Facts about this boot. */
    make_boot_id();
    read_mac();
    read_sha();
    hw_sensors_init();
    hw_prov_load(&s_creds);

    ESP_LOGI(TAG, "openhardware %s (%s) on %s", HW_FW_VERSION, s_sha, HW_BOARD_NAME);
    ESP_LOGI(TAG, "boot %s, reset %s, %lu KB psram, %d MHz",
             s_boot_id, reset_reason_str(),
             (unsigned long)(hw_sensors_psram_size() / 1024),
             hw_sensors_cpu_mhz());

    /* 4 and 5. Observable from here on. */
    xTaskCreate(hello_task, "hw_hello", 4096, NULL, 4, NULL);
    xTaskCreate(beat_task, "hw_beat", 4096, NULL, 5, NULL);

    hw_proto_status("ready", "reporting over USB");

    /* Nothing below this line is a prerequisite for being observable, and for
       now there is nothing below this line at all. */
}
