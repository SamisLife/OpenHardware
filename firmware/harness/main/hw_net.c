/* ============================================================================
   hw_net.c — joining a network, and the discipline of not giving up.
   ----------------------------------------------------------------------------
   There is one interesting decision in this file and it is what happens on
   failure: nothing dramatic. No reboot, no reinitialisation, no falling back
   to a captive portal. Back off, retry, and keep saying so over the cable in
   case anybody is still watching.

   A BOARD THAT REBOOTS ITSELF OUT OF A BAD MOMENT IS INDISTINGUISHABLE FROM
   ONE THAT CRASHED. Telling those two apart is most of what this project does,
   so the harness is not permitted to blur them. Every failure here is a status
   frame and a longer wait, and the boot identity in the heartbeat stays
   exactly as it was — which is how a reader knows the board rode it out.

   ----------------------------------------------------------------------------
   NOTHING HERE ABORTS

   ESP_ERROR_CHECK() calls abort(), which panics and reboots. Every setup step
   below is checked by hand and reported instead. A radio that will not
   initialise is a board with no network and a working cable, which is a
   perfectly serviceable board; a board that panics on the way to that
   conclusion has destroyed the only channel that could have explained it.

   ----------------------------------------------------------------------------
   THE EVENT HANDLERS DO ALMOST NOTHING

   Everything below the line marked so runs on the SYSTEM EVENT TASK, which is
   shared with the IP stack and has a small stack. The handlers record what
   happened and return.

   Two things were wrong with the obvious version, which formatted a status
   frame inline and then slept for the backoff. A line-sized buffer on that
   task overflows its stack and panics the board, repeatably, once the trigger
   is in flash — the reason the transmit buffers in hw_proto.c are at file
   scope. And sleeping inside an event handler stalls the event loop itself,
   including the IP events this code is waiting for.

   ----------------------------------------------------------------------------
   DISCONNECT REASONS ARE TRANSLATED

   "The board rejected the password" and "no such network — this radio is 2.4
   GHz only" account for nearly every failed bring-up, and both are invisible
   in the raw reason code. The number is reported alongside the sentence rather
   than replaced by it, because a translation is this file's reading and the
   code is what the driver actually said.
   ========================================================================== */

#include "hw.h"

#include <stdio.h>
#include <string.h>

#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "lwip/ip4_addr.h"

static const char *TAG = "hw_net";

static hw_net_state_t s_state = HW_NET_IDLE;
static char s_ip[16]   = {0};
static char s_ssid[33] = {0};
static char s_err[96]  = {0};
static bool s_started  = false;

/**
 * How long to wait before the next attempt, doubling to a ceiling.
 *
 * Thirty seconds is long enough to stop hammering a router that is refusing,
 * and short enough that a network coming back is noticed while somebody is
 * still standing at the bench.
 */
#define BACKOFF_START_MS 1000
#define BACKOFF_MAX_MS   30000

static int s_backoff_ms = BACKOFF_START_MS;

/* ------------------------------------------------------------------------ */
/* what the driver said, in words                                            */
/* ------------------------------------------------------------------------ */

static void explain(uint8_t reason, char *out, size_t len)
{
    switch (reason) {
        case WIFI_REASON_NO_AP_FOUND:
            snprintf(out, len, "no such network in range — this radio is 2.4 GHz only");
            break;
        case WIFI_REASON_AUTH_FAIL:
        case WIFI_REASON_HANDSHAKE_TIMEOUT:
        case WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT:
            snprintf(out, len, "the access point rejected the password");
            break;
        case WIFI_REASON_AUTH_EXPIRE:
            snprintf(out, len, "association expired — the access point dropped it");
            break;
        case WIFI_REASON_ASSOC_TOOMANY:
            snprintf(out, len, "the access point refused: too many clients");
            break;
        case WIFI_REASON_BEACON_TIMEOUT:
            snprintf(out, len, "out of range — no beacons from the access point");
            break;
        case WIFI_REASON_CONNECTION_FAIL:
            snprintf(out, len, "association failed");
            break;
        default:
            /* No sentence invented for a code nobody has seen here. The number
               is at least something to search for, and claiming to know what
               it means would be worse than admitting the gap. */
            snprintf(out, len, "disconnected, reason %u", (unsigned)reason);
            break;
    }
}

/* ------------------------------------------------------------------------ */
/* on the system event task: record and return                               */
/* ------------------------------------------------------------------------ */

/** Drained by net_task. -1 is nothing pending. */
static volatile int  s_pending_reason = -1;
static volatile bool s_pending_start = false;
static volatile bool s_pending_got_ip = false;

static void on_wifi(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    (void)arg; (void)base;

    if (id == WIFI_EVENT_STA_START) {
        s_state = HW_NET_JOINING;
        s_pending_start = true;
        return;
    }

    if (id == WIFI_EVENT_STA_DISCONNECTED) {
        const wifi_event_sta_disconnected_t *e = (const wifi_event_sta_disconnected_t *)data;
        /* Cleared here rather than when the retry runs. An address that no
           longer routes is worse than no address: it travels the wire looking
           exactly like a working one. */
        s_ip[0] = '\0';
        s_state = HW_NET_RETRYING;
        s_pending_reason = (int)e->reason;
    }
}

static void on_ip(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    (void)arg; (void)base;
    if (id != IP_EVENT_STA_GOT_IP) return;

    const ip_event_got_ip_t *e = (const ip_event_got_ip_t *)data;
    snprintf(s_ip, sizeof(s_ip), IPSTR, IP2STR(&e->ip_info.ip));

    s_state = HW_NET_CONNECTED;
    s_backoff_ms = BACKOFF_START_MS;   /* a good association clears the penalty */
    s_err[0] = '\0';
    s_pending_got_ip = true;
}

/* ------------------------------------------------------------------------ */
/* the talking and the waiting, on a stack of its own                        */
/* ------------------------------------------------------------------------ */

/**
 * Where the retry policy lives: back off, keep trying, never restart.
 *
 * A polling loop rather than an event group, because the backoff is a sleep
 * and a sleep is the one thing an event handler must not do. Fifty
 * milliseconds is far below the rate anything here changes, and it keeps the
 * whole policy readable in one place instead of split across two.
 */
static void net_task(void *arg)
{
    (void)arg;

    for (;;) {
        if (s_pending_start) {
            s_pending_start = false;
            hw_proto_status("wifi_join", s_ssid);
            esp_wifi_connect();
        }

        if (s_pending_got_ip) {
            s_pending_got_ip = false;
            ESP_LOGI(TAG, "online at %s", s_ip);
            hw_proto_sendf("status",
                "\"stage\":\"wifi_ok\",\"detail\":\"%s\",\"ip\":\"%s\"", s_ssid, s_ip);
        }

        const int reason = s_pending_reason;
        if (reason >= 0) {
            s_pending_reason = -1;
            explain((uint8_t)reason, s_err, sizeof(s_err));
            ESP_LOGW(TAG, "disconnected: %s", s_err);

            /* The wait is announced before it is taken. A board that says
               nothing for thirty seconds and a board that has stopped look the
               same from the other end, and one of them is fine. */
            hw_proto_sendf("status",
                "\"stage\":\"wifi_fail\",\"detail\":\"%s\","
                "\"reason\":%u,\"retry_ms\":%d",
                s_err, (unsigned)reason, s_backoff_ms);

            vTaskDelay(pdMS_TO_TICKS(s_backoff_ms));
            s_backoff_ms = (s_backoff_ms * 2 > BACKOFF_MAX_MS)
                         ? BACKOFF_MAX_MS : s_backoff_ms * 2;

            s_state = HW_NET_JOINING;
            esp_wifi_connect();
            continue;
        }

        vTaskDelay(pdMS_TO_TICKS(50));
    }
}

/* ------------------------------------------------------------------------ */
/* bring-up                                                                  */
/* ------------------------------------------------------------------------ */

/** Copy credentials into a driver config. Truncation is the caller's problem. */
static void fill_config(wifi_config_t *wc, const char *ssid, const char *psk)
{
    memset(wc, 0, sizeof(*wc));
    strncpy((char *)wc->sta.ssid, ssid, sizeof(wc->sta.ssid) - 1);
    strncpy((char *)wc->sta.password, psk ? psk : "", sizeof(wc->sta.password) - 1);

    /* WPA2 is not demanded. Plenty of bench networks are still open, and
       refusing to associate at all is a worse outcome than a weak link on a
       board whose entire job is to be reachable. */
    wc->sta.threshold.authmode = WIFI_AUTH_OPEN;
    wc->sta.pmf_cfg.capable = true;
    wc->sta.pmf_cfg.required = false;
}

/** Say what went wrong, then hand the code back. Never abort. */
static esp_err_t step(esp_err_t err, const char *what)
{
    if (err == ESP_OK) return ESP_OK;
    snprintf(s_err, sizeof(s_err), "%s: %s", what, esp_err_to_name(err));
    ESP_LOGE(TAG, "%s", s_err);
    hw_proto_sendf("status", "\"stage\":\"wifi_unavailable\",\"detail\":\"%s\"", s_err);
    s_state = HW_NET_IDLE;
    return err;
}

esp_err_t hw_net_start(const char *ssid, const char *psk)
{
    if (!ssid || !ssid[0]) return ESP_ERR_INVALID_ARG;

    if (s_started) {
        /* Re-provisioned while running. The credentials are swapped in place
           rather than by restarting the board, because a reboot here would
           throw away the uptime and boot identity that say whether anything
           else has gone wrong today. */
        wifi_config_t wc;
        fill_config(&wc, ssid, psk);
        strncpy(s_ssid, ssid, sizeof(s_ssid) - 1);

        esp_wifi_disconnect();
        esp_err_t err = esp_wifi_set_config(WIFI_IF_STA, &wc);
        if (err != ESP_OK) return step(err, "set_config");

        s_backoff_ms = BACKOFF_START_MS;
        s_state = HW_NET_JOINING;
        return esp_wifi_connect();
    }

    /* The driver logs "Haven't to connect to a suitable AP now!" at warning
       level on every failed scan — twice a second, indefinitely, whenever the
       stored network is out of range. The retry is correct and stays; it is
       the narration that has to go, because it buries the serial monitor that
       bring-up depends on. The status frames above report the same failures
       with a reason and a backoff, which is the version somebody can act on.
       Errors still come through. */
    esp_log_level_set("wifi", ESP_LOG_ERROR);

    esp_err_t err;
    if ((err = step(esp_netif_init(), "netif_init")) != ESP_OK) return err;

    /* Already created if anything else brought up the default loop first.
       That is a success for this purpose, not a collision. */
    err = esp_event_loop_create_default();
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) return step(err, "event_loop");

    if (!esp_netif_create_default_wifi_sta()) {
        return step(ESP_ERR_NO_MEM, "netif_create");
    }

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    if ((err = step(esp_wifi_init(&cfg), "wifi_init")) != ESP_OK) return err;

    err = esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID,
                                              &on_wifi, NULL, NULL);
    if ((err = step(err, "wifi_events")) != ESP_OK) return err;

    err = esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP,
                                              &on_ip, NULL, NULL);
    if ((err = step(err, "ip_events")) != ESP_OK) return err;

    wifi_config_t wc;
    fill_config(&wc, ssid, psk);
    strncpy(s_ssid, ssid, sizeof(s_ssid) - 1);

    if ((err = step(esp_wifi_set_mode(WIFI_MODE_STA), "set_mode")) != ESP_OK) return err;
    if ((err = step(esp_wifi_set_config(WIFI_IF_STA, &wc), "set_config")) != ESP_OK) return err;

    /* The radio stays awake. Modem sleep adds latency to every heartbeat and
       makes the telemetry jitter, which buys nothing on a board powered over
       the same cable that carries the measurements. */
    esp_wifi_set_ps(WIFI_PS_NONE);

    /* Started before the radio, so the first STA_START event is never missed.
       The other order works almost always, which is the worst kind of race. */
    if (xTaskCreate(net_task, "hw_net", 4096, NULL, 5, NULL) != pdPASS) {
        return step(ESP_ERR_NO_MEM, "net_task");
    }

    if ((err = step(esp_wifi_start(), "wifi_start")) != ESP_OK) return err;

    s_started = true;
    return ESP_OK;
}

/* ------------------------------------------------------------------------ */
/* what it can say about itself                                              */
/* ------------------------------------------------------------------------ */

hw_net_state_t hw_net_state(void) { return s_state; }

const char *hw_net_state_str(void)
{
    switch (s_state) {
        case HW_NET_JOINING:   return "joining";
        case HW_NET_CONNECTED: return "online";
        case HW_NET_RETRYING:  return "retrying";
        default:               return "offline";
    }
}

bool hw_net_online(void) { return s_state == HW_NET_CONNECTED && s_ip[0] != '\0'; }

const char *hw_net_ssid(void) { return s_ssid; }

const char *hw_net_last_error(void) { return s_err[0] ? s_err : NULL; }

/**
 * @return false when there is no address, leaving *out untouched.
 *
 * An empty string would travel the wire as a field that is present and blank,
 * which a reader has to guess at. Absent is unambiguous.
 */
bool hw_net_ip(const char **out)
{
    if (!out || !s_ip[0]) return false;
    *out = s_ip;
    return true;
}

/**
 * @return false when there is no association to measure, leaving *out alone.
 *
 * Not zero. Zero dBm is an extraordinarily strong signal, not a missing one,
 * and a panel drawing four bars for a board with no radio associated is the
 * exact failure this project exists to prevent.
 */
bool hw_net_rssi(int *out)
{
    if (!out || s_state != HW_NET_CONNECTED) return false;

    wifi_ap_record_t ap;
    if (esp_wifi_sta_get_ap_info(&ap) != ESP_OK) return false;
    *out = ap.rssi;
    return true;
}
