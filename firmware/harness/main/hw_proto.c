/* ============================================================================
   hw_proto.c — OHW1 over the USB serial endpoint.
   ----------------------------------------------------------------------------
   The board half of the protocol specified in frontend/js/link/protocol.js.
   Implemented independently on purpose: the CRC is what proves the two agree,
   and a shared implementation would prove nothing.

   ----------------------------------------------------------------------------
   TWO FAILURES THAT SHAPE THIS FILE

   printf LOSES DATA HERE. newlib flushes a line-buffered stream in chunks, and
   each chunk reaches a driver write that returns a SHORT COUNT when the host
   is not draining the endpoint. Nothing in the standard path checks that
   return, so frames are truncated mid-flight and two half-frames land on one
   line. Every byte out of this file goes through a write loop that keeps
   pushing until the whole line has left.

   LARGE BUFFERS ON THE WRONG STACK PANIC THE BOARD. The system event task is
   shared with the IP stack and gets a couple of kilobytes. A send function
   with a line-sized local on it overflows that stack the first time an event
   handler tries to report itself — repeatably, on every boot, once the trigger
   is stored in flash. The transmit buffers are therefore at file scope,
   written only under the transmit mutex, and one copy of each is enough
   precisely because the mutex is what makes it safe.
   ========================================================================== */

#include "hw.h"

#include <stdarg.h>
#include <stdio.h>
#include <string.h>

#include "driver/usb_serial_jtag.h"
#include "driver/usb_serial_jtag_vfs.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

static const char *TAG = "hw_proto";

#define RX_BUF_SZ 1024
#define TX_BUF_SZ 1024

static hw_proto_cb_t s_cb = NULL;
static uint32_t s_rx_total = 0;

/* Writes are serialised: several tasks emit, and an interleaved frame is a
   corrupt frame that the far end will reject on its CRC. */
static SemaphoreHandle_t s_tx_lock = NULL;

/* At file scope rather than on a caller's stack. See the header comment. Only
   ever touched while s_tx_lock is held. */
static char s_tx_json[HW_LINE_MAX];
static char s_tx_line[HW_LINE_MAX + 16];

/* Inbound line assembly. Only rx_task touches these. */
static char s_line[HW_LINE_MAX];
static size_t s_line_len = 0;

/* ------------------------------------------------------------------------ */
/* CRC-16/CCITT-FALSE                                                        */
/* ------------------------------------------------------------------------ */

uint16_t hw_crc16(const char *data, size_t len)
{
    uint16_t crc = 0xFFFF;
    for (size_t i = 0; i < len; i++) {
        crc ^= (uint16_t)((uint8_t)data[i]) << 8;
        for (int b = 0; b < 8; b++) {
            crc = (crc & 0x8000) ? (uint16_t)((crc << 1) ^ 0x1021)
                                 : (uint16_t)(crc << 1);
        }
    }
    return crc;
}

/* ------------------------------------------------------------------------ */
/* transmit                                                                  */
/* ------------------------------------------------------------------------ */

/**
 * Push every byte out, or give up loudly.
 *
 * usb_serial_jtag_write_bytes() reports a short count when the host is not
 * draining the endpoint fast enough, and a caller that ignores it loses the
 * tail of whatever it was sending. Backing off rather than spinning matters
 * too: a host that attaches a moment later should still receive whole frames.
 */
static void raw_write(const char *data, size_t len)
{
    size_t sent = 0;
    int stalls = 0;

    while (sent < len && stalls < 40) {
        int n = usb_serial_jtag_write_bytes(data + sent, len - sent, pdMS_TO_TICKS(50));
        if (n > 0) {
            sent += (size_t)n;
            stalls = 0;
        } else {
            stalls++;
            vTaskDelay(pdMS_TO_TICKS(5));
        }
    }
}

/** Assemble and write one frame. The caller already holds s_tx_lock. */
static void send_locked(const char *json_body)
{
    uint16_t crc = hw_crc16(json_body, strlen(json_body));

    /* Assembled whole, then written whole. A frame split across two write
       calls can be interleaved with a log line from another task and fail its
       CRC at the far end. */
    int n = snprintf(s_tx_line, sizeof(s_tx_line),
                     HW_FRAME_PREFIX "%s *%04X\n", json_body, crc);
    if (n <= 0) return;
    if (n >= (int)sizeof(s_tx_line)) return;   /* truncated: not a frame */
    raw_write(s_tx_line, (size_t)n);
}

void hw_proto_sendf(const char *type, const char *fmt, ...)
{
    if (s_tx_lock) xSemaphoreTake(s_tx_lock, portMAX_DELAY);

    char *body = s_tx_json;
    const size_t cap = sizeof(s_tx_json);

    int n = snprintf(body, cap, "{\"t\":\"%s\"", type);
    if (n < 0 || n >= (int)cap) goto done;

    if (fmt && fmt[0]) {
        body[n++] = ',';
        va_list ap;
        va_start(ap, fmt);
        int m = vsnprintf(body + n, cap - n - 2, fmt, ap);
        va_end(ap);
        if (m < 0) goto done;

        /* vsnprintf returns what it WOULD have written. A frame that did not
           fit is dropped rather than closed with a brace over truncated JSON:
           that would pass its CRC and fail to parse, which reports the fault
           in the wrong place entirely. */
        if (m >= (int)(cap - n - 2)) {
            ESP_LOGW(TAG, "frame '%s' does not fit in %u bytes; dropped",
                     type, (unsigned)cap);
            goto done;
        }
        n += m;
    }
    body[n++] = '}';
    body[n] = '\0';
    send_locked(body);

done:
    if (s_tx_lock) xSemaphoreGive(s_tx_lock);
}

void hw_proto_status(const char *stage, const char *detail)
{
    hw_proto_sendf("status", "\"stage\":\"%s\",\"detail\":\"%s\"",
                   stage ? stage : "", detail ? detail : "");
}

uint32_t hw_proto_rx_bytes(void) { return s_rx_total; }

/* ------------------------------------------------------------------------ */
/* pictures                                                                  */
/* ------------------------------------------------------------------------ */

static const char B64[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Standard base64 with padding. Returns the number of characters written. */
static size_t b64_encode(const uint8_t *in, size_t n, char *out)
{
    size_t o = 0;
    size_t i = 0;

    while (i + 3 <= n) {
        uint32_t v = ((uint32_t)in[i] << 16) | ((uint32_t)in[i + 1] << 8) | in[i + 2];
        out[o++] = B64[(v >> 18) & 0x3F];
        out[o++] = B64[(v >> 12) & 0x3F];
        out[o++] = B64[(v >> 6) & 0x3F];
        out[o++] = B64[v & 0x3F];
        i += 3;
    }

    /* Padded rather than truncated. The far end checks the decoded length
       against the byte count in the header, and unpadded tail groups decode
       short — which would fail that check on every image whose length is not a
       multiple of three, meaning two images in three. */
    const size_t rem = n - i;
    if (rem == 1) {
        uint32_t v = (uint32_t)in[i] << 16;
        out[o++] = B64[(v >> 18) & 0x3F];
        out[o++] = B64[(v >> 12) & 0x3F];
        out[o++] = '=';
        out[o++] = '=';
    } else if (rem == 2) {
        uint32_t v = ((uint32_t)in[i] << 16) | ((uint32_t)in[i + 1] << 8);
        out[o++] = B64[(v >> 18) & 0x3F];
        out[o++] = B64[(v >> 12) & 0x3F];
        out[o++] = B64[(v >> 6) & 0x3F];
        out[o++] = '=';
    }
    return o;
}

/* Scratch for one chunk, at file scope for the same reason as the transmit
   buffers: 648 bytes on the stack of a task nobody has sized for it is the
   mistake that panics this board. */
static char s_b64[HW_IMG_CHUNK_RAW * 4 / 3 + 8];

/* Held for a whole image rather than per chunk.
 *
 * It protects the scratch above, but that is the smaller half. The real job is
 * that a reader treats a new header as abandoning whatever was in flight, so
 * two images interleaving on the wire would not arrive as two damaged pictures
 * — the first would silently never complete. A contract saying "only one task
 * may call this" would work until the day something else did. */
static SemaphoreHandle_t s_img_lock = NULL;

void hw_proto_send_image(const uint8_t *jpeg, size_t len,
                         uint32_t seq, int w, int h, int q)
{
    if (!jpeg || !len) return;

    if (len > HW_IMG_MAX_BYTES) {
        /* Saying why there is no picture costs one frame. Sending it would
           occupy the cable long enough for the heartbeat to look like it
           stopped, turning one oversized capture into an apparently dead
           board. */
        hw_proto_sendf("status",
            "\"stage\":\"frame_too_large\","
            "\"detail\":\"%u bytes is past the %u byte cable budget\"",
            (unsigned)len, (unsigned)HW_IMG_MAX_BYTES);
        return;
    }

    const size_t chunks = (len + HW_IMG_CHUNK_RAW - 1) / HW_IMG_CHUNK_RAW;

    if (s_img_lock) xSemaphoreTake(s_img_lock, portMAX_DELAY);

    hw_proto_sendf("img",
        "\"seq\":%lu,\"w\":%d,\"h\":%d,\"q\":%d,\"bytes\":%u,\"chunks\":%u",
        (unsigned long)seq, w, h, q, (unsigned)len, (unsigned)chunks);

    for (size_t i = 0; i < chunks; i++) {
        const size_t off = i * HW_IMG_CHUNK_RAW;
        size_t n = len - off;
        if (n > HW_IMG_CHUNK_RAW) n = HW_IMG_CHUNK_RAW;

        const size_t m = b64_encode(jpeg + off, n, s_b64);
        s_b64[m] = '\0';

        /* Indexed, not positional. Chunks are separate frames and any one of
           them can fail its CRC and be dropped; an index means the far end
           knows which one went missing instead of reassembling the rest into a
           picture that is subtly wrong. */
        hw_proto_sendf("imgd", "\"seq\":%lu,\"i\":%u,\"d\":\"%s\"",
                       (unsigned long)seq, (unsigned)i, s_b64);
    }

    if (s_img_lock) xSemaphoreGive(s_img_lock);
}

/* ------------------------------------------------------------------------ */
/* receive                                                                   */
/* ------------------------------------------------------------------------ */

/**
 * Pull the "t" field out so the dispatcher needs no JSON parser on this path.
 * Parsing the rest of the payload is the handler's problem.
 */
static void dispatch(char *line, size_t len)
{
    if (len <= HW_FRAME_PREFIX_N) return;
    if (strncmp(line, HW_FRAME_PREFIX, HW_FRAME_PREFIX_N) != 0) {
        /* Worth one line. During bring-up, "the host is sending something
           unrecognised" and "the host is sending nothing" are different
           problems with the same symptom. */
        ESP_LOGI(TAG, "rx non-frame (%u bytes): %.60s", (unsigned)len, line);
        return;
    }

    char *payload = line + HW_FRAME_PREFIX_N;

    /* Searched from the right, so a payload containing " *" cannot terminate
       the frame early — a JSON string is free to contain one. */
    char *star = NULL;
    for (char *p = line + len - 1; p > payload; p--) {
        if (*p == '*' && p[-1] == ' ') { star = p; break; }
    }
    if (!star || (size_t)(line + len - star) < 5) {
        ESP_LOGW(TAG, "frame with no crc suffix, dropped");
        return;
    }

    unsigned int want = 0;
    if (sscanf(star + 1, "%4x", &want) != 1) return;

    size_t payload_len = (size_t)(star - 1 - payload);   /* -1 for the space */
    uint16_t got = hw_crc16(payload, payload_len);
    if (got != (uint16_t)want) {
        ESP_LOGW(TAG, "crc mismatch: got %04X want %04X", got, want);
        return;
    }
    payload[payload_len] = '\0';

    char type[24] = {0};
    if (!hw_json_str(payload, "t", type, sizeof(type))) {
        ESP_LOGW(TAG, "frame with no type field, dropped");
        return;
    }

    if (s_cb) s_cb(type, payload);
}

static void rx_task(void *arg)
{
    (void)arg;
    uint8_t chunk[128];

    for (;;) {
        int n = usb_serial_jtag_read_bytes(chunk, sizeof(chunk), pdMS_TO_TICKS(100));
        if (n <= 0) continue;

        /* Said once, the first time anything at all arrives. Whether the host
           can reach this task is the one fact that cannot be deduced from the
           other end. */
        if (s_rx_total == 0) ESP_LOGI(TAG, "first inbound bytes on USB");
        s_rx_total += (uint32_t)n;

        for (int i = 0; i < n; i++) {
            char c = (char)chunk[i];
            if (c == '\n' || c == '\r') {
                if (s_line_len) {
                    s_line[s_line_len] = '\0';
                    dispatch(s_line, s_line_len);
                    s_line_len = 0;
                }
                continue;
            }
            /* An over-long line is not a frame. Dropping it and resynchronising
               on the next newline costs one line; truncating it into something
               that might accidentally validate costs trust in all of them. */
            if (s_line_len >= HW_LINE_MAX - 1) { s_line_len = 0; continue; }
            s_line[s_line_len++] = c;
        }
    }
}

esp_err_t hw_proto_init(hw_proto_cb_t on_frame)
{
    s_cb = on_frame;
    s_tx_lock = xSemaphoreCreateMutex();
    if (!s_tx_lock) return ESP_ERR_NO_MEM;

    s_img_lock = xSemaphoreCreateMutex();
    if (!s_img_lock) return ESP_ERR_NO_MEM;

    usb_serial_jtag_driver_config_t cfg = {
        .tx_buffer_size = TX_BUF_SZ,
        .rx_buffer_size = RX_BUF_SZ,
    };
    esp_err_t err = usb_serial_jtag_driver_install(&cfg);
    if (err != ESP_OK) return err;

    /* Route the logging subsystem through the same driver, so it and the
       protocol are not fighting over the peripheral. Named usb_serial_jtag_vfs_*
       since IDF 5.3; the esp_vfs_* spelling survives as a deprecated shim in a
       different header, which makes the symptom an implicit declaration rather
       than a missing symbol. */
    usb_serial_jtag_vfs_use_driver();
    setvbuf(stdout, NULL, _IOLBF, 0);

    return xTaskCreate(rx_task, "hw_rx", 4096, NULL, 6, NULL) == pdPASS
        ? ESP_OK : ESP_ERR_NO_MEM;
}

/* ------------------------------------------------------------------------ */
/* a deliberately small JSON string reader                                   */
/* ------------------------------------------------------------------------ */

/**
 * Pulls out `"key":"value"`, unescaping the handful of sequences a credential
 * can legitimately contain. A full parser is linked in for the HTTP layer, but
 * this path runs before anything else is up and benefits from having no
 * allocation in it at all.
 */
/**
 * Read `"key":true` or `"key":false`.
 *
 * Anything that is not literally `true` reads as false, including a key that
 * is absent and a value that is a string or a number. A command whose argument
 * did not parse must not be treated as an instruction to turn something on:
 * the safe reading of a malformed request is the one that does nothing.
 */
bool hw_json_bool(const char *json, const char *key)
{
    if (!json || !key) return false;

    char pattern[40];
    int pn = snprintf(pattern, sizeof(pattern), "\"%s\"", key);
    if (pn < 0 || pn >= (int)sizeof(pattern)) return false;

    const char *p = strstr(json, pattern);
    if (!p) return false;
    p += pn;

    while (*p == ' ' || *p == '\t') p++;
    if (*p != ':') return false;
    p++;
    while (*p == ' ' || *p == '\t') p++;

    return strncmp(p, "true", 4) == 0;
}

bool hw_json_str(const char *json, const char *key, char *out, size_t out_len)
{
    if (!json || !key || !out || out_len == 0) return false;

    char pattern[40];
    int pn = snprintf(pattern, sizeof(pattern), "\"%s\"", key);
    if (pn < 0 || pn >= (int)sizeof(pattern)) return false;

    const char *p = strstr(json, pattern);
    if (!p) return false;
    p += pn;

    while (*p == ' ' || *p == '\t') p++;
    if (*p != ':') return false;
    p++;
    while (*p == ' ' || *p == '\t') p++;
    if (*p != '"') return false;
    p++;

    size_t i = 0;
    while (*p && *p != '"' && i < out_len - 1) {
        if (*p == '\\' && p[1]) {
            p++;
            switch (*p) {
                case 'n':  out[i++] = '\n'; break;
                case 't':  out[i++] = '\t'; break;
                case 'r':  out[i++] = '\r'; break;
                case '"':  out[i++] = '"';  break;
                case '\\': out[i++] = '\\'; break;
                case '/':  out[i++] = '/';  break;
                default:   out[i++] = *p;   break;
            }
            p++;
            continue;
        }
        out[i++] = *p++;
    }
    out[i] = '\0';
    return true;
}
