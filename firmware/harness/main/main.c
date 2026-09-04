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

#include <ctype.h>
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

static char s_boot_id[9];
static char s_mac[18];
static char s_sha[17];
static char s_fw[32];

static void activate_restart_task(void *arg)
{
    (void)arg;
    vTaskDelay(pdMS_TO_TICKS(250));
    esp_restart();
}

static bool same_sha8(const esp_app_desc_t *desc, const char *expected)
{
    if (!desc || !expected || strlen(expected) != 16) return false;
    char actual[17];
    for (int i = 0; i < 8; i++) {
        snprintf(actual + i * 2, 3, "%02x", desc->app_elf_sha256[i]);
    }
    actual[16] = '\0';
    for (int i = 0; i < 16; i++) {
        if (actual[i] != (char)tolower((unsigned char)expected[i])) return false;
    }
    return true;
}

/* ------------------------------------------------------------------------ */
/* the image the bootloader chose, and whether it will keep it              */
/* ------------------------------------------------------------------------ */

/**
 * What the bootloader thinks of the running image.
 *
 * With rollback enabled, an image selected with esp_ota_set_boot_partition
 * boots exactly once as "pending" and is abandoned on the next reset unless
 * the running firmware confirms it. That reset arrives sooner than it looks:
 * opening the serial port resets this board, so the page that just wrote a
 * candidate and reopens the port to watch it boot would, on its own, be the
 * thing that rolled it back. Reported in every hello so the far end never
 * has to guess which of those happened.
 */
static const char *ota_state_str(void)
{
    const esp_partition_t *running = esp_ota_get_running_partition();
    if (!running) return "unknown";
    if (running->subtype == ESP_PARTITION_SUBTYPE_APP_FACTORY) return "factory";

    esp_ota_img_states_t st;
    if (esp_ota_get_state_partition(running, &st) != ESP_OK) return "unknown";
    switch (st) {
        case ESP_OTA_IMG_NEW:            return "new";
        case ESP_OTA_IMG_PENDING_VERIFY: return "pending";
        case ESP_OTA_IMG_VALID:          return "valid";
        case ESP_OTA_IMG_INVALID:        return "invalid";
        case ESP_OTA_IMG_ABORTED:        return "aborted";
        default:                         return "undefined";
    }
}

/**
 * An OTA slot the bootloader gave up on, or NULL.
 *
 * A candidate that never confirmed itself is marked aborted in otadata and the
 * previous image is booted instead. That mark is the only trace the rollback
 * leaves, so it travels in the hello: a page that just activated ota_0 and
 * hears "factory, aborted ota_0" knows exactly what happened, rather than
 * being left with a board that quietly runs something else.
 */
static const char *aborted_slot(void)
{
    static const char *labels[] = { "ota_0", "ota_1" };
    const esp_partition_t *running = esp_ota_get_running_partition();

    for (int i = 0; i < 2; i++) {
        const esp_partition_t *p = esp_partition_find_first(
            ESP_PARTITION_TYPE_APP, ESP_PARTITION_SUBTYPE_ANY, labels[i]);
        if (!p || p == running) continue;
        esp_ota_img_states_t st;
        if (esp_ota_get_state_partition(p, &st) == ESP_OK && st == ESP_OTA_IMG_ABORTED) {
            return labels[i];
        }
    }
    return NULL;
}

/**
 * Keep this image.
 *
 * Called on the first line of app_main, before storage, the wire, the camera,
 * and the application layer. Reaching app_main proves the harness image can
 * boot; an application crash is contained by its own counter in hw_app.c and
 * stays visible in every hello. A factory image has nothing to confirm.
 */
static char s_image_note[48];
static bool s_image_unconfirmed = false;

static void confirm_image(void)
{
    const esp_partition_t *running = esp_ota_get_running_partition();
    esp_ota_img_states_t st;
    if (!running || esp_ota_get_state_partition(running, &st) != ESP_OK) return;
    if (st != ESP_OTA_IMG_PENDING_VERIFY && st != ESP_OTA_IMG_NEW) return;

    /* An early host reopen resets the board. Every millisecond between boot
       and this line is a window in which that reset rolls the image back, so
       the page leaves the candidate alone first. The report waits for wire. */
    const esp_err_t err = esp_ota_mark_app_valid_cancel_rollback();
    if (err == ESP_OK) {
        ESP_LOGI(TAG, "%s confirmed; the bootloader will keep it", running->label);
        snprintf(s_image_note, sizeof s_image_note, "%s", running->label);
    } else {
        ESP_LOGW(TAG, "could not confirm %s: %s", running->label, esp_err_to_name(err));
        snprintf(s_image_note, sizeof s_image_note, "%s", esp_err_to_name(err));
        s_image_unconfirmed = true;
    }
}

/** What confirm_image() did, said once the wire can carry it. */
static void report_image(void)
{
    if (!s_image_note[0]) return;
    hw_proto_status(s_image_unconfirmed ? "image_unconfirmed" : "image_valid", s_image_note);
}

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

/**
 * Which build this actually is, taken from the image rather than from a
 * constant somebody has to remember to change.
 *
 * The version comes from version.txt by way of the app descriptor, and the
 * hash is the first eight bytes of the ELF's. Between them they answer the two
 * questions a person actually has — which release is this, and is it the exact
 * artefact that was published — and the packaging script reads both out of the
 * same bytes, so a manifest cannot describe an image nobody is running.
 */
static void read_build(void)
{
    const esp_app_desc_t *app = esp_app_get_description();

    snprintf(s_fw, sizeof(s_fw), "%s", app->version);
    for (int i = 0; i < 8; i++) {
        snprintf(s_sha + i * 2, 3, "%02x", app->app_elf_sha256[i]);
    }
    s_sha[16] = '\0';
}

/**
 * Append `,"key":value`, or nothing at all.
 *
 * A conditional key spliced straight into a format string does not work, and
 * it fails quietly: "%s%.2f" with the key suppressed still prints the number,
 * so a frame with no reading comes out as {..."boot_id":"5abc"0.00}. That is
 * not JSON, so the far end drops the whole frame — every field lost rather
 * than the one that was missing, and the symptom is a board that has gone
 * silent rather than a sensor that is absent.
 *
 * Built into its own buffer instead, so absent stays absent.
 */
static int opt_f(char *buf, size_t cap, int used, const char *key, bool have, float v)
{
    if (!have || used < 0 || (size_t)used >= cap) return used;
    int n = snprintf(buf + used, cap - used, ",\"%s\":%.2f", key, v);
    if (n < 0 || (size_t)(used + n) >= cap) return used;   /* leave it out entirely */
    return used + n;
}

/** The same rule for a whole number. Used for rssi, which is absent far more
    often than it is present — every board with no radio associated. */
static int opt_d(char *buf, size_t cap, int used, const char *key, bool have, int v)
{
    if (!have || used < 0 || (size_t)used >= cap) return used;
    int n = snprintf(buf + used, cap - used, ",\"%s\":%d", key, v);
    if (n < 0 || (size_t)(used + n) >= cap) return used;
    return used + n;
}

/**
 * And for a string.
 *
 * An address the board does not have is omitted rather than sent as "". A
 * present-but-empty field is one a reader has to guess at, and the guesses
 * differ: no radio, radio not associated, associated but no lease. Absent
 * means only one thing.
 */
static int opt_s(char *buf, size_t cap, int used, const char *key, bool have, const char *v)
{
    if (!have || !v || used < 0 || (size_t)used >= cap) return used;
    int n = snprintf(buf + used, cap - used, ",\"%s\":\"%s\"", key, v);
    if (n < 0 || (size_t)(used + n) >= cap) return used;
    return used + n;
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
    const bool have_temp = hw_sensors_temp_c(&temp);

    /* Omitted entirely when there is no sensor, rather than sent as a
       sentinel. A magic value travels the wire indistinguishable from a
       measurement; an absent field can only be read one way. */
    char opt[96] = {0};
    int used = opt_f(opt, sizeof opt, 0, "temp_c", have_temp, temp);
    /* The slot the bootloader abandoned, when there is one. Absent otherwise:
       a rollback that did not happen must not travel as an empty string. */
    const char *aborted = aborted_slot();
    opt_s(opt, sizeof opt, used, "aborted", aborted != NULL, aborted);

    char app_crashes[32] = {0};
    if (strcmp(hw_app_state_str(), "disabled") == 0) {
        snprintf(app_crashes, sizeof app_crashes, ",\"crashes\":%u",
                 (unsigned)hw_app_crash_tries());
    }

    /* This board reports over the cable and nothing else. There is no radio,
       no stored credentials and no network state, so the identity frame says
       nothing about any of them rather than carrying fields that are always
       the same. */
    hw_proto_sendf("hello",
        "\"proto\":%d,\"fw\":\"%s\",\"sha\":\"%s\",\"slot\":\"%s\","
        "\"board\":\"%s\",\"board_name\":\"%s\",\"chip\":\"esp32s3\","
        "\"mac\":\"%s\",\"boot_id\":\"%s\",\"reset\":\"%s\","
        "\"psram\":%lu,\"flash\":%lu,\"heap\":%lu,\"heap_total\":%lu,"
        "\"temp_crit_c\":85,\"rx\":%lu,\"rx_rescued\":%lu,"
        "\"ota\":\"%s\","
        "\"app\":{\"name\":\"%s\",\"ver\":\"%s\",\"state\":\"%s\"%s}%s",
        HW_PROTO_VERSION, s_fw, s_sha,
        running ? running->label : "unknown",
        HW_BOARD_ID, HW_BOARD_NAME,
        s_mac, s_boot_id, reset_reason_str(),
        (unsigned long)hw_sensors_psram_size(),
        (unsigned long)hw_sensors_flash_size(),
        (unsigned long)hw_sensors_heap_free(),
        (unsigned long)hw_sensors_heap_total(),
        (unsigned long)hw_proto_rx_bytes(),
        (unsigned long)hw_proto_rx_rescued(),
        ota_state_str(),
        hw_app_name(), hw_app_version(), hw_app_state_str(), app_crashes,
        opt);
}

/**
 * What is actually attached.
 *
 * Sent when it changes rather than on a schedule. At the telemetry rate this
 * would be chatter on a link already carrying a heartbeat and pictures, and
 * the answer changes perhaps twice in the life of a session.
 *
 * The camera state is a word rather than a boolean, because "absent" and
 * "faulted" are not the same fact. A board with no camera on it is the
 * ordinary case and needs nobody. A board that crashes when it looks for one
 * needs somebody, and a boolean renders both as "no camera".
 */
static void send_caps(void)
{
    hw_proto_sendf("caps",
        "\"camera\":{\"state\":\"%s\",\"sensor\":\"%s\"},"
        "\"psram\":%lu,\"flash\":%lu,\"streaming\":%s,"
        "\"cfg\":true,\"config\":{\"size\":\"%s\",\"quality\":%d}",
        hw_camera_state_str(), hw_camera_sensor(),
        (unsigned long)hw_sensors_psram_size(),
        (unsigned long)hw_sensors_flash_size(),
        hw_camera_streaming() ? "true" : "false",
        hw_camera_size_name(), hw_camera_quality());
}

/* ------------------------------------------------------------------------ */
/* inbound                                                                   */
/* ------------------------------------------------------------------------ */

static void on_frame(const char *type, const char *json)
{
    if (strcmp(type, "ping") == 0) {
        send_hello();
        return;
    }

    if (strcmp(type, "caps") == 0) {
        send_caps();
        return;
    }

    /* Turning the stream on and off sets a flag and nothing else. Every actual
       camera call belongs to the camera task: doing one here would put a
       second owner on a driver whose buffers outlive the call that produced
       them. The task picks this up on its next tick. */
    if (strcmp(type, "cam") == 0) {
        const bool want = hw_json_bool(json, "on");

        /* Refusing out loud is more useful than failing silently. A host that
           asked for a stream and got nothing cannot tell "there is no camera"
           from "the request never arrived", and those have completely
           different answers. */
        if (want && hw_camera_state() != HW_CAM_OK) {
            hw_proto_sendf("cam_ack", "\"on\":false,\"err\":\"%s\"",
                           hw_camera_state_str());
            return;
        }

        hw_camera_set_streaming(want);
        hw_proto_sendf("cam_ack", "\"on\":%s", want ? "true" : "false");
        return;
    }

    /* A scan occupies the header for a few hundred milliseconds and answers
       once, from its own task, so the wire keeps its cadence meanwhile. Pins
       default to the header's; a request naming others is checked against
       what the camera and the USB peripheral own before anything is touched. */
    if (strcmp(type, "scan") == 0) {
        int sda = HW_I2C_DEFAULT_SDA, scl = HW_I2C_DEFAULT_SCL;
        hw_json_int(json, "sda", &sda);
        hw_json_int(json, "scl", &scl);
        const esp_err_t err = hw_i2c_request_scan(sda, scl);
        if (err != ESP_OK) {
            hw_proto_sendf("scan_ack", "\"ok\":false,\"err\":\"%s\",\"sda\":%d,\"scl\":%d",
                           err == ESP_ERR_INVALID_STATE ? "busy" : esp_err_to_name(err), sda, scl);
        }
        return;
    }

    if (strcmp(type, "cfg") == 0) {
        char size[12] = {0};
        int quality = hw_camera_quality();
        hw_json_int(json, "quality", &quality);

        if (!hw_json_str(json, "size", size, sizeof(size))
            || !hw_camera_request_config(size, quality)) {
            hw_proto_sendf("cfg_ack",
                "\"ok\":false,\"err\":\"ESP_ERR_INVALID_ARG\"");
        }
        return;
    }

    /* Candidate bytes are written to an inactive OTA partition by the cable
       flasher. The running harness validates the image and its expected ELF
       identity before selecting it, so an interrupted write leaves the
       current image and the factory baseline selected exactly as they were. */
    if (strcmp(type, "activate") == 0) {
        char slot[12] = {0}, expected[17] = {0};
        if (!hw_json_str(json, "slot", slot, sizeof(slot))
            || !hw_json_str(json, "sha", expected, sizeof(expected))
            || (strcmp(slot, "ota_0") != 0 && strcmp(slot, "ota_1") != 0)) {
            hw_proto_sendf("activate_ack", "\"ok\":false,\"err\":\"invalid target\"");
            return;
        }

        const esp_partition_t *target = esp_partition_find_first(
            ESP_PARTITION_TYPE_APP, ESP_PARTITION_SUBTYPE_ANY, slot);
        const esp_partition_t *running = esp_ota_get_running_partition();
        esp_app_desc_t desc = {0};
        esp_err_t err = target ? esp_ota_get_partition_description(target, &desc) : ESP_ERR_NOT_FOUND;
        if (err == ESP_OK && target == running) err = ESP_ERR_INVALID_STATE;
        if (err == ESP_OK && !same_sha8(&desc, expected)) err = ESP_ERR_INVALID_CRC;
        if (err == ESP_OK) err = esp_ota_set_boot_partition(target);
        if (err != ESP_OK) {
            hw_proto_sendf("activate_ack", "\"ok\":false,\"err\":\"%s\"",
                           esp_err_to_name(err));
            return;
        }

        if (xTaskCreate(activate_restart_task, "hw_activate", 2048, NULL, 8, NULL) != pdPASS) {
            esp_ota_set_boot_partition(running);
            hw_proto_sendf("activate_ack", "\"ok\":false,\"err\":\"no restart task\"");
            return;
        }
        hw_proto_sendf("activate_ack", "\"ok\":true,\"slot\":\"%s\",\"sha\":\"%s\"",
                       slot, expected);
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
        const bool have_temp = hw_sensors_temp_c(&temp);

        /* Present only while the camera is actually being asked for frames.
           Zero would be a measurement — "trying and getting nothing", which is
           a fault — and a camera nobody asked to stream is not faulty. */
        float fps = 0.0f;
        const bool have_fps = hw_camera_fps(&fps);

        char opt[96] = {0};
        int used = opt_f(opt, sizeof opt, 0, "temp_c", have_temp, temp);
        opt_f(opt, sizeof opt, used, "fps", have_fps, fps);

        char app[400] = {0};
        hw_app_beat_json(app, sizeof app);

        hw_proto_sendf("beat",
            "\"uptime_s\":%.2f,\"heap_free\":%lu,\"psram_free\":%lu,"
            "\"psram_largest\":%lu,\"cpu_mhz\":%d,\"boot_id\":\"%s\",%s%s",
            (double)esp_timer_get_time() / 1000000.0,
            (unsigned long)hw_sensors_heap_free(),
            (unsigned long)hw_sensors_psram_free(),
            (unsigned long)hw_sensors_psram_largest(),
            hw_sensors_cpu_mhz(),
            s_boot_id,
            app,
            opt);

        vTaskDelayUntil(&next, pdMS_TO_TICKS(HW_BEAT_MS));
    }
}

/**
 * The camera, and every call into its driver.
 *
 * On its own task for two separate reasons that happen to agree.
 *
 * The first is that this is the one thing here that can take the board down.
 * It runs after the heartbeat is already going, so a probe that hangs or
 * browns out the rail is a failure the board was reporting right up to the
 * moment it stopped — and the boot after it says why, because the counter
 * behind hw_camera_probe() reaches the flash before the attempt does.
 *
 * The second is ownership. A framebuffer belongs to the driver that produced
 * it, so a teardown racing a capture is a use-after-free on memory another
 * task is writing to the cable. Every esp_camera_* call being on one task
 * removes that race by construction rather than by a lock that has to be got
 * right at every call site — including in whatever is added here later.
 */
static void camera_task(void *arg)
{
    (void)arg;

    /* Late enough that a host attaching at power-on has the identity and a few
       beats in hand before anything risky runs. Bring-up nobody is watching is
       bring-up nobody can diagnose. */
    vTaskDelay(pdMS_TO_TICKS(1200));

    hw_camera_probe();
    send_caps();

    /* The app never runs while the camera probe counter is armed. A panic in
       app_setup must be attributed to the app rather than carried into the
       next boot as evidence against the sensor. */
    hw_app_start();

    uint32_t seq = 0;
    int64_t last_frame = 0;
    int64_t last_watch = 0;

    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(HW_CAM_TICK_MS));
        const int64_t now = esp_timer_get_time() / 1000;

        const char *config_err = NULL;
        const int configured = hw_camera_apply_pending(&config_err);
        if (configured > 0) {
            hw_proto_sendf("cfg_ack",
                "\"ok\":true,\"size\":\"%s\",\"quality\":%d",
                hw_camera_size_name(), hw_camera_quality());
            send_caps();
            hw_camera_drain_frames();
        } else if (configured < 0) {
            hw_proto_sendf("cfg_ack", "\"ok\":false,\"err\":\"%s\"",
                           config_err ? config_err : "ESP_FAIL");
        }

        /* Arrival and removal, on their own slower clock than the tick. Told
           to the host only when something changed: a `caps` every second
           would be chatter on a link already carrying telemetry and frames,
           and a host that wants the current answer can ask for it. */
        if (now - last_watch >= HW_CAM_WATCH_MS) {
            last_watch = now;
            if (hw_camera_watch()) send_caps();
        }

        if (!hw_camera_streaming()) continue;
        if (hw_camera_state() != HW_CAM_OK) continue;

        if (now - last_frame < HW_CAM_FRAME_MS) continue;

        /* Stamped after the send, not before it. Putting an image on the wire
           takes as long as the cable takes, and pacing from the moment a
           capture STARTED would queue frames faster than the wire drains them
           — which presents as latency growing without bound rather than as a
           frame rate that settles somewhere honest. */
        hw_camera_capture_and_send(++seq);
        last_frame = esp_timer_get_time() / 1000;
    }
}

/* ------------------------------------------------------------------------ */

void app_main(void)
{
    /* 0. Keep this image, if it is on trial. Nothing else is needed for it,
       and everything else takes time the trial does not have. */
    confirm_image();

    /* The request mailbox must exist before the RX task can accept a cfg
       frame. This allocates no camera resource and makes no sensor call. */
    hw_camera_init();

    /* 2. The channel, before anything that might need to report a problem.
       Not ESP_ERROR_CHECK: that aborts, and an abort here is a boot loop with
       nothing on the wire to say why — the one failure this firmware is built
       never to have. If the channel itself cannot be opened there is nowhere
       to report it, so the log is all that is left and the board carries on
       doing whatever it still can. */
    /* 1. Storage, which holds only the crash counters now. */
    esp_err_t err = hw_prov_init();
    if (err != ESP_OK) ESP_LOGE(TAG, "nvs unavailable: %s", esp_err_to_name(err));

    err = hw_proto_init(on_frame);
    if (err != ESP_OK) ESP_LOGE(TAG, "serial channel unavailable: %s", esp_err_to_name(err));

    /* 3. Facts about this boot. */
    make_boot_id();
    read_mac();
    read_build();
    hw_sensors_init();
    hw_app_init();

    ESP_LOGI(TAG, "openhardware %s (%s) on %s", s_fw, s_sha, HW_BOARD_NAME);
    ESP_LOGI(TAG, "boot %s, reset %s, %lu KB psram, %d MHz",
             s_boot_id, reset_reason_str(),
             (unsigned long)(hw_sensors_psram_size() / 1024),
             hw_sensors_cpu_mhz());

    /* 4 and 5. Observable from here on. */
    xTaskCreate(hello_task, "hw_hello", 4096, NULL, 4, NULL);
    xTaskCreate(beat_task, "hw_beat", 4096, NULL, 5, NULL);

    hw_proto_status("ready", "reporting over USB");
    report_image();

    /* Below the line: everything that can fail. It runs at a lower priority
       than the heartbeat, on its own stack, and it starts by waiting — so the
       board is already being watched by the time any of it is attempted.

       The stack is generous because the camera driver allocates and formats on
       its caller during init. The pictures themselves do not travel on it: the
       image encoder writes through file-scope buffers precisely so this number
       does not have to grow with the frame size. */
    xTaskCreate(camera_task, "hw_cam", 6144, NULL, 3, NULL);
}
