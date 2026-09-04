/* ============================================================================
   hw_i2c.c — what answers on the expansion I2C header.
   ----------------------------------------------------------------------------
   A scan is not telemetry. It occupies a bus, it takes a few hundred
   milliseconds, and its answer changes perhaps twice in the life of a bench,
   so it runs when asked and never on the heartbeat. The host sends `scan`,
   the board answers `scan_ack` once, from a task that exists only for the
   duration.

   The bus is port 0. The camera's SCCB owns port 1 and its driver instance,
   and this file never touches either. The driver used here is the LEGACY I2C
   driver, deliberately: the camera component links it, and the new driver's
   presence in the same image aborts the board before app_main (see
   main/CMakeLists.txt). Anything added here must stay on driver/i2c.h.

   What a scan can and cannot say. An address that acknowledges is present:
   that is a fact. WHICH part is behind it is not, except for the handful that
   carry a chip-ID register worth reading (an MPU-series IMU at 0x68/0x69, a
   Bosch pressure sensor at 0x76/0x77). Those are named by the silicon; the
   rest travel as bare addresses and the host offers its guesses to a person.

   A bus held low cannot be scanned. Every address would fail identically,
   which reads as "nothing attached" when the truth is "something is wrong
   with the wiring". So the lines are read before the driver is installed,
   and a low line is reported as what it is.
   ========================================================================== */

#include "hw.h"

#include <stdio.h>
#include <string.h>

#include "driver/gpio.h"
#include "driver/i2c.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "hw_i2c";

#define SCAN_PORT       I2C_NUM_0
#define SCAN_FREQ_HZ    100000
#define SCAN_PROBE_MS   20
#define SCAN_MAX_FOUND  20

/* GPIOs the camera and the USB peripheral own on the XIAO ESP32S3 Sense. A
   scan asked to use one of these is refused rather than allowed to disturb
   a sensor that is streaming. */
static const int RESERVED[] = { 10, 40, 39, 15, 17, 18, 16, 14, 12, 11, 48, 38, 47, 13, 19, 20 };

static volatile bool s_running = false;
static int s_sda = HW_I2C_DEFAULT_SDA;
static int s_scl = HW_I2C_DEFAULT_SCL;

typedef struct {
    uint8_t addr;
    const char *id;   /* NULL when the part did not identify itself */
} found_t;

static bool pin_ok(int gpio)
{
    if (gpio < 0 || gpio > 48) return false;
    for (size_t i = 0; i < sizeof(RESERVED) / sizeof(RESERVED[0]); i++) {
        if (RESERVED[i] == gpio) return false;
    }
    return true;
}

/** Read one register over a repeated start. false when the part did not answer. */
static bool read_reg(uint8_t addr, uint8_t reg, uint8_t *out)
{
    i2c_cmd_handle_t cmd = i2c_cmd_link_create();
    if (!cmd) return false;
    i2c_master_start(cmd);
    i2c_master_write_byte(cmd, (uint8_t)((addr << 1) | I2C_MASTER_WRITE), true);
    i2c_master_write_byte(cmd, reg, true);
    i2c_master_start(cmd);
    i2c_master_write_byte(cmd, (uint8_t)((addr << 1) | I2C_MASTER_READ), true);
    i2c_master_read_byte(cmd, out, I2C_MASTER_NACK);
    i2c_master_stop(cmd);
    const esp_err_t err = i2c_master_cmd_begin(SCAN_PORT, cmd, pdMS_TO_TICKS(SCAN_PROBE_MS));
    i2c_cmd_link_delete(cmd);
    return err == ESP_OK;
}

/**
 * Name the part behind an address, when its silicon says.
 *
 * Only registers whose meaning is fixed by the part are consulted, so a
 * wrong guess cannot come out of here: an unexpected value is reported as
 * nothing, and the host falls back to its table.
 */
static const char *identify(uint8_t addr)
{
    uint8_t v = 0;
    if (addr == 0x68 || addr == 0x69) {
        if (!read_reg(addr, 0x75, &v)) return NULL;          /* WHO_AM_I */
        if (v == 0x68) return "MPU6050";
        if (v == 0x70) return "MPU6500";
        if (v == 0x71) return "MPU9250";
        return NULL;
    }
    if (addr == 0x76 || addr == 0x77) {
        if (!read_reg(addr, 0xD0, &v)) return NULL;          /* chip id */
        if (v == 0x60) return "BME280";
        if (v == 0x58) return "BMP280";
        if (v == 0x55) return "BMP180";
        return NULL;
    }
    return NULL;
}

static bool probe(uint8_t addr)
{
    i2c_cmd_handle_t cmd = i2c_cmd_link_create();
    if (!cmd) return false;
    i2c_master_start(cmd);
    i2c_master_write_byte(cmd, (uint8_t)((addr << 1) | I2C_MASTER_WRITE), true);
    i2c_master_stop(cmd);
    const esp_err_t err = i2c_master_cmd_begin(SCAN_PORT, cmd, pdMS_TO_TICKS(SCAN_PROBE_MS));
    i2c_cmd_link_delete(cmd);
    return err == ESP_OK;
}

/** Whether a line idles high. A line that reads low with the pull-up on is
    being held by something, and no address will answer through it. */
static bool line_high(int gpio)
{
    gpio_config_t io = {
        .pin_bit_mask = 1ULL << gpio,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    if (gpio_config(&io) != ESP_OK) return true;    /* cannot tell; let the driver try */
    vTaskDelay(pdMS_TO_TICKS(2));
    return gpio_get_level(gpio) != 0;
}

static void scan_task(void *arg)
{
    (void)arg;
    const int sda = s_sda, scl = s_scl;
    const int64_t t0 = esp_timer_get_time();

    const char *low = !line_high(sda) ? "sda" : !line_high(scl) ? "scl" : NULL;
    if (low) {
        ESP_LOGW(TAG, "%s held low; scan abandoned", low);
        hw_proto_sendf("scan_ack",
            "\"ok\":false,\"err\":\"bus_stuck\",\"line\":\"%s\",\"bus\":\"i2c0\",\"sda\":%d,\"scl\":%d",
            low, sda, scl);
        s_running = false;
        vTaskDelete(NULL);
        return;
    }

    i2c_config_t cfg = {
        .mode = I2C_MODE_MASTER,
        .sda_io_num = sda,
        .scl_io_num = scl,
        .sda_pullup_en = GPIO_PULLUP_ENABLE,
        .scl_pullup_en = GPIO_PULLUP_ENABLE,
        .master.clk_speed = SCAN_FREQ_HZ,
    };
    esp_err_t err = i2c_param_config(SCAN_PORT, &cfg);
    if (err == ESP_OK) err = i2c_driver_install(SCAN_PORT, I2C_MODE_MASTER, 0, 0, 0);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "i2c0 unavailable: %s", esp_err_to_name(err));
        hw_proto_sendf("scan_ack", "\"ok\":false,\"err\":\"%s\",\"bus\":\"i2c0\",\"sda\":%d,\"scl\":%d",
                       esp_err_to_name(err), sda, scl);
        s_running = false;
        vTaskDelete(NULL);
        return;
    }

    found_t found[SCAN_MAX_FOUND];
    int n = 0, more = 0;
    for (int addr = HW_I2C_SCAN_FIRST; addr <= HW_I2C_SCAN_LAST; addr++) {
        if (!probe((uint8_t)addr)) continue;
        if (n < SCAN_MAX_FOUND) {
            found[n].addr = (uint8_t)addr;
            found[n].id = identify((uint8_t)addr);
            n++;
        } else {
            more++;
        }
    }

    i2c_driver_delete(SCAN_PORT);

    /* Bounded: twenty entries at most, so the line stays inside HW_LINE_MAX
       however busy the bus. Anything past that is counted, not dropped
       silently. */
    /* Empty is a valid result. Initialising the first byte matters because no
       snprintf call runs when nothing acknowledges; passing an uninitialised
       array to %s can otherwise turn that result into malformed JSON or make
       hw_proto_sendf drop the oversized frame entirely. */
    char list[SCAN_MAX_FOUND * 28 + 8] = {0};
    int used = 0;
    for (int i = 0; i < n && used < (int)sizeof(list) - 32; i++) {
        used += snprintf(list + used, sizeof(list) - used, "%s{\"addr\":%d%s%s%s}",
                         i ? "," : "", found[i].addr,
                         found[i].id ? ",\"id\":\"" : "", found[i].id ? found[i].id : "",
                         found[i].id ? "\"" : "");
    }

    const int ms = (int)((esp_timer_get_time() - t0) / 1000);
    ESP_LOGI(TAG, "scanned i2c0 (sda %d, scl %d): %d found in %d ms", sda, scl, n + more, ms);

    char extra[24] = {0};
    if (more) snprintf(extra, sizeof extra, ",\"more\":%d", more);

    hw_proto_sendf("scan_ack",
        "\"ok\":true,\"bus\":\"i2c0\",\"sda\":%d,\"scl\":%d,\"ms\":%d,\"found\":[%s]%s",
        sda, scl, ms, list, extra);

    s_running = false;
    vTaskDelete(NULL);
}

esp_err_t hw_i2c_request_scan(int sda, int scl)
{
    if (!pin_ok(sda) || !pin_ok(scl) || sda == scl) return ESP_ERR_INVALID_ARG;
    if (s_running) return ESP_ERR_INVALID_STATE;

    s_running = true;
    s_sda = sda;
    s_scl = scl;
    if (xTaskCreate(scan_task, "hw_scan", 4096, NULL, 2, NULL) != pdPASS) {
        s_running = false;
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}
