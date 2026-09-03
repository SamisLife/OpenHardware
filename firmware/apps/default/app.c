#include "hw_app.h"

const hw_app_info_t app_info = {
    .name = "default",
    .version = "1.0",
};

static int64_t s_previous_ms;
static uint32_t s_loops;

void app_setup(void)
{
    s_previous_ms = hw_app_uptime_ms();
    hw_app_log("app layer up");
}

void app_loop(void)
{
    const int64_t now = hw_app_uptime_ms();
    hw_app_metric("loop_ms", (double)(now - s_previous_ms));
    hw_app_metric("loops", (double)++s_loops);
    s_previous_ms = now;
}
