/* ============================================================================
   hw_sensors.c — everything the board can say about itself, safely.
   ----------------------------------------------------------------------------
   Every call in this file is a core one that degrades rather than fails. Die
   temperature, heap, PSRAM size and fragmentation, flash size and clock: none
   can hang, none can brown out the rail, and none needs anything configured
   first. That is why the harness reports all of it from the first boot instead
   of starting minimal.

   A lean bootstrap sounds safer and is not. It makes the first update a blind
   push, and if that image fails there is no baseline to compare against — no
   PSRAM size, no flash size, no reset reason. That is the same blindness this
   project exists to remove, moved one step earlier.

   ----------------------------------------------------------------------------
   TWO NUMBERS FOR MEMORY, ON PURPOSE

   Free PSRAM and the largest contiguous free block are reported separately.
   They diverge badly once a network stack has fragmented the heap, and the gap
   between them is the gap between "out of memory" and "out of contiguous
   memory" — two problems with completely different answers. A search over
   framebuffer sizes that only knew the total would keep choosing configurations
   that cannot allocate.

   TOTALS ARE REPORTED, NOT ASSUMED

   heap_total travels with the identity frame because the alternative is a host
   dividing by a number it invented. A headroom bar drawn against a guessed
   denominator looks exactly like one drawn against a real figure.
   ========================================================================== */

#include "hw.h"

#include "driver/temperature_sensor.h"
#include "esp_flash.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_psram.h"
#include "esp_private/esp_clk.h"

static const char *TAG = "hw_sensors";

static temperature_sensor_handle_t s_temp = NULL;

void hw_sensors_init(void)
{
    /* The on-die sensor has selectable ranges. 20..100 °C covers ambient
       through the throttle point with the best accuracy available; outside it
       the reading saturates rather than lying. */
    temperature_sensor_config_t cfg = TEMPERATURE_SENSOR_CONFIG_DEFAULT(20, 100);
    if (temperature_sensor_install(&cfg, &s_temp) != ESP_OK) {
        ESP_LOGW(TAG, "no die temperature sensor on this part");
        s_temp = NULL;
        return;
    }
    if (temperature_sensor_enable(s_temp) != ESP_OK) {
        ESP_LOGW(TAG, "die temperature sensor would not enable");
        temperature_sensor_uninstall(s_temp);
        s_temp = NULL;
    }
}

/**
 * @return false when there is no reading, leaving *out untouched.
 *
 * Deliberately not a sentinel. A magic value travels the wire indistinguishable
 * from a measurement, and a host has no way to tell -273 °C apart from a very
 * cold board. Absence is reported by omitting the field from the frame, which
 * a reader can only interpret one way.
 */
bool hw_sensors_temp_c(float *out)
{
    if (!s_temp || !out) return false;
    float v = 0.0f;
    if (temperature_sensor_get_celsius(s_temp, &v) != ESP_OK) return false;
    *out = v;
    return true;
}

/* ------------------------------------------------------------------------ */
/* memory                                                                    */
/* ------------------------------------------------------------------------ */

uint32_t hw_sensors_heap_free(void)
{
    return (uint32_t)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
}

/** What the free figure is a fraction of. Reported so nobody has to guess. */
uint32_t hw_sensors_heap_total(void)
{
    return (uint32_t)heap_caps_get_total_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
}

uint32_t hw_sensors_psram_free(void)
{
    return (uint32_t)heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
}

/** The number that decides whether a large allocation can succeed. */
uint32_t hw_sensors_psram_largest(void)
{
    return (uint32_t)heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM);
}

uint32_t hw_sensors_psram_size(void)
{
#if CONFIG_SPIRAM
    /* Zero here is not a failure to report. It is the diagnosis. */
    return (uint32_t)esp_psram_get_size();
#else
    return 0;
#endif
}

/* ------------------------------------------------------------------------ */

uint32_t hw_sensors_flash_size(void)
{
    uint32_t size = 0;
    if (esp_flash_get_size(NULL, &size) != ESP_OK) return 0;
    return size;
}

int hw_sensors_cpu_mhz(void)
{
    return esp_clk_cpu_freq() / 1000000;
}
