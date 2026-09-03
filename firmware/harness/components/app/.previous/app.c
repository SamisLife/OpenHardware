#include "hw_app.h"

const hw_app_info_t app_info = {
    .name = "hvga_frame_meter",
    .version = "1.0.0",
};

static int64_t s_previous_frame_ms;

void app_setup(void)
{
    const esp_err_t config_err = hw_app_camera_set("HVGA", 12);
    const esp_err_t stream_err = hw_app_camera_stream(true);

    s_previous_frame_ms = 0;
    hw_app_log("HVGA q12 config=%d stream=%d", (int)config_err, (int)stream_err);
}

void app_loop(void)
{
}

void app_on_frame(const uint8_t *jpeg, size_t len, int width, int height)
{
    (void)jpeg;
    (void)len;
    (void)width;
    (void)height;

    const int64_t now_ms = hw_app_uptime_ms();
    if (s_previous_frame_ms != 0) {
        hw_app_metric("frame_ms", (double)(now_ms - s_previous_frame_ms));
    }
    s_previous_frame_ms = now_ms;
}
