/* ============================================================================
   hw_prov.c — what the board remembers across power cycles.
   ----------------------------------------------------------------------------
   The harness image is a public artefact: anyone can download it and write it
   to their own board. So it contains no credentials of any kind — no network
   password, no key, nothing per-person. Everything identifying lives here, in
   NVS, written once over the cable.

   Nothing in this file is used yet. It lands with the rest of the harness
   because the namespace and the key names are the kind of decision that is
   free to make now and awkward later: a board in somebody's hands has already
   stored things under them.
   ========================================================================== */

#include "hw.h"

#include <string.h>

#include "esp_log.h"
#include "nvs.h"
#include "nvs_flash.h"

static const char *TAG = "hw_prov";

#define KEY_PSK    "psk"
#define KEY_CAM    "cam_tries"
#define KEY_APP    "app_tries"

esp_err_t hw_prov_init(void)
{
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        /* A changed partition table, or a page that was half written when the
           power went. Wiping costs whoever owns the board one reconfiguration;
           refusing to boot costs them the board. */
        ESP_LOGW(TAG, "nvs unusable (%s), erasing", esp_err_to_name(err));
        err = nvs_flash_erase();
        if (err != ESP_OK) return err;
        err = nvs_flash_init();
    }
    return err;
}


/* ------------------------------------------------------------------------ */
/* the camera probe counter                                                  */
/* ------------------------------------------------------------------------ */

/**
 * How many times in a row the board has entered the camera probe.
 *
 * Incremented before the attempt and cleared by any attempt that came back —
 * including one that came back with an error. What it therefore counts is not
 * failures but disappearances: a probe that returns is evidence the board
 * survived, whatever the answer was.
 *
 * This has to live in flash rather than in a variable. The failure being
 * guarded against is a call that never returns, and nothing in the process
 * outlives that. A board that hangs in esp_camera_init() would otherwise come
 * back and hang in exactly the same place, indefinitely, with no record that
 * it had ever tried.
 */
uint8_t hw_prov_cam_tries(void)
{
    nvs_handle_t h;
    if (nvs_open(HW_NVS_NS, NVS_READONLY, &h) != ESP_OK) return 0;

    uint8_t n = 0;
    /* A key that has never been written is a board that has never probed,
       which is zero. Not an error. */
    if (nvs_get_u8(h, KEY_CAM, &n) != ESP_OK) n = 0;
    nvs_close(h);
    return n;
}

esp_err_t hw_prov_set_cam_tries(uint8_t n)
{
    nvs_handle_t h;
    esp_err_t err = nvs_open(HW_NVS_NS, NVS_READWRITE, &h);
    if (err != ESP_OK) return err;

    err = nvs_set_u8(h, KEY_CAM, n);
    /* Committed here and not deferred. The whole value of this counter is that
       it is on the flash before the risky call runs; a write still sitting in
       a cache when the board dies has recorded nothing. */
    if (err == ESP_OK) err = nvs_commit(h);

    nvs_close(h);
    if (err != ESP_OK) ESP_LOGW(TAG, "camera counter not stored: %s", esp_err_to_name(err));
    return err;
}

/* ------------------------------------------------------------------------ */
/* the application crash counter                                             */
/* ------------------------------------------------------------------------ */

uint8_t hw_prov_app_tries(void)
{
    nvs_handle_t h;
    if (nvs_open(HW_NVS_NS, NVS_READONLY, &h) != ESP_OK) return 0;

    uint8_t n = 0;
    if (nvs_get_u8(h, KEY_APP, &n) != ESP_OK) n = 0;
    nvs_close(h);
    return n;
}

esp_err_t hw_prov_set_app_tries(uint8_t n)
{
    nvs_handle_t h;
    esp_err_t err = nvs_open(HW_NVS_NS, NVS_READWRITE, &h);
    if (err != ESP_OK) return err;

    err = nvs_set_u8(h, KEY_APP, n);
    /* The app can panic before its first loop returns. Committing before it
       starts is what leaves evidence for the next boot to read. */
    if (err == ESP_OK) err = nvs_commit(h);

    nvs_close(h);
    if (err != ESP_OK) ESP_LOGW(TAG, "app counter not stored: %s", esp_err_to_name(err));
    return err;
}
