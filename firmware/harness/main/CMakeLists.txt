idf_component_register(
  SRCS
    "main.c"
    "hw_proto.c"
    "hw_prov.c"
    "hw_sensors.c"
    "hw_camera.c"
    "hw_app.c"
    "hw_i2c.c"
  INCLUDE_DIRS "."
  REQUIRES
    nvs_flash esp_psram app_update esp_timer esp_system spi_flash esp_partition
    esp_driver_usb_serial_jtag driver vfs esp_hw_support
    espressif__esp32-camera
    app hw_app_api
)

# esp_driver_i2c is deliberately absent from that list, and this is not a
# tidying decision.
#
# ESP-IDF ships two mutually exclusive I2C drivers. The legacy one, in
# components/driver/i2c/i2c.c, carries an __attribute__((constructor)) that
# calls abort() if the new driver is LINKED into the same application — not
# used, linked. It fires before app_main, which is before hw_proto_init(), so
# the board boot-loops emitting no OHW1 frames at all. That is the one failure
# this firmware is built never to have: a board that cannot say what is wrong
# with it.
#
# Which of the two ends up linked is decided by the camera, not by this file.
# esp32-camera's own CMakeLists picks the source by IDF version:
#
#     if (idf_version VERSION_GREATER_EQUAL "5.4" AND NOT CONFIG_SCCB_..._LEGACY)
#       list(APPEND srcs driver/sccb-ng.c)      # the new driver
#     else()
#       list(APPEND srcs driver/sccb.c)         # the legacy one
#
# On the 5.3 this project builds against, that is unconditionally the legacy
# driver. `driver` on the REQUIRES list above carries it.
#
# The committed sdkconfig disagrees, and reading it is the trap. It contains
# CONFIG_SCCB_HARDWARE_I2C_DRIVER_NEW=y, because the Kconfig choice defaults
# that way — but the branch above never consults that symbol below 5.4, only
# its _LEGACY sibling. So the config says "new" and the build links "legacy".
# The linker map is the authority here; sdkconfig is not.
#
# The umbrella `driver` component publicly requires esp_driver_i2c in IDF 5.3,
# so leaving esp_driver_i2c off this list does not make its headers unreachable
# from main. The application component deliberately avoids `driver`, the build
# daemon refuses the new-driver API in app sources, and the final ELF is checked
# for i2c_acquire_bus_handle. The linker check is the authority. Moving to IDF
# 5.4 or above flips the camera to the new driver, at which point the legacy
# watcher in hw_camera.c has to move with it.
