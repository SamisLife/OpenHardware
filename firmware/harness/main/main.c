/* ============================================================================
   main.c — prove the build configuration landed.
   ----------------------------------------------------------------------------
   The first image, and it deliberately does nothing except report what the
   build config decided. Every one of these is a claim that is easy to make in
   sdkconfig.defaults and easy to have silently not take effect: an incremental
   build keeps whatever is already in sdkconfig, so a default added later can
   be ignored without anything saying so.

   Reading them back off the running chip is the only way to know. A partition
   table that landed somewhere other than where it was written, a clock running
   at two thirds of what was asked for, PSRAM that never initialised — all of
   those produce a board that works and measures wrong, which is the failure
   this project exists to catch.

   Everything the harness actually does arrives in the next commits. This one
   is here so that when it does, the ground under it is known to be correct.
   ========================================================================== */

#include <inttypes.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "esp_app_desc.h"
#include "esp_chip_info.h"
#include "esp_flash.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_partition.h"
#include "esp_psram.h"
#include "esp_system.h"
#include "esp_private/esp_clk.h"

static const char *TAG = "harness";

static const char *part_kind(const esp_partition_t *p)
{
    if (p->type == ESP_PARTITION_TYPE_APP) {
        switch (p->subtype) {
            case ESP_PARTITION_SUBTYPE_APP_FACTORY: return "app  factory";
            case ESP_PARTITION_SUBTYPE_APP_OTA_0:   return "app  ota_0";
            case ESP_PARTITION_SUBTYPE_APP_OTA_1:   return "app  ota_1";
            default:                                return "app";
        }
    }
    switch (p->subtype) {
        case ESP_PARTITION_SUBTYPE_DATA_NVS:      return "data nvs";
        case ESP_PARTITION_SUBTYPE_DATA_OTA:      return "data otadata";
        case ESP_PARTITION_SUBTYPE_DATA_PHY:      return "data phy";
        case ESP_PARTITION_SUBTYPE_DATA_COREDUMP: return "data coredump";
        case ESP_PARTITION_SUBTYPE_DATA_SPIFFS:   return "data storage";
        default:                                  return "data";
    }
}

/** The table as the bootloader actually read it, not as it was written down. */
static void report_partitions(void)
{
    esp_partition_iterator_t it =
        esp_partition_find(ESP_PARTITION_TYPE_ANY, ESP_PARTITION_SUBTYPE_ANY, NULL);

    uint32_t claimed = 0;
    for (; it != NULL; it = esp_partition_next(it)) {
        const esp_partition_t *p = esp_partition_get(it);
        claimed += p->size;
        ESP_LOGI(TAG, "  0x%06" PRIx32 "  %-13s %-10s %6" PRIu32 " KB",
                 p->address, part_kind(p), p->label, p->size / 1024);
    }
    esp_partition_iterator_release(it);

    uint32_t flash = 0;
    esp_flash_get_size(NULL, &flash);
    ESP_LOGI(TAG, "  %" PRIu32 " KB claimed of %" PRIu32 " KB flash",
             claimed / 1024, flash / 1024);
}

void app_main(void)
{
    esp_chip_info_t chip;
    esp_chip_info(&chip);

    uint32_t flash = 0;
    esp_flash_get_size(NULL, &flash);

    const esp_app_desc_t *app = esp_app_get_description();
    const esp_partition_t *running = esp_ota_get_running_partition();

    ESP_LOGI(TAG, "openhardware harness, build check");
    ESP_LOGI(TAG, "  chip        ESP32-S3 rev %d, %d core(s)",
             chip.revision, chip.cores);

    /* The one that is wrong by default. 160 MHz is what an unconfigured build
       produces, and every measurement taken on it is understated. */
    ESP_LOGI(TAG, "  clock       %d MHz", esp_clk_cpu_freq() / 1000000);

    ESP_LOGI(TAG, "  flash       %" PRIu32 " KB", flash / 1024);

    /* Zero is not a failure to report; it is the diagnosis. A board with no
       usable PSRAM cannot hold a framebuffer, and saying so is more useful
       than anything downstream discovering it later. */
    ESP_LOGI(TAG, "  psram       %u KB", (unsigned)(esp_psram_get_size() / 1024));

    ESP_LOGI(TAG, "  running     %s at 0x%06" PRIx32,
             running ? running->label : "unknown",
             running ? running->address : 0);
    ESP_LOGI(TAG, "  app         %s, built %s %s",
             app->version, app->date, app->time);
    ESP_LOGI(TAG, "  reset       %d", (int)esp_reset_reason());

    ESP_LOGI(TAG, "partition table as the bootloader read it:");
    report_partitions();

    /* Nothing further. Keeping the task alive rather than returning leaves the
       log above as the last thing on the wire, which is the entire output of
       this image. */
    for (;;) vTaskDelay(pdMS_TO_TICKS(10000));
}
