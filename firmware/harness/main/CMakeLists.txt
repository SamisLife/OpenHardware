idf_component_register(
  SRCS
    "main.c"
    "hw_proto.c"
    "hw_prov.c"
    "hw_sensors.c"
  INCLUDE_DIRS "."
  REQUIRES
    nvs_flash esp_psram app_update esp_timer esp_system spi_flash esp_partition
    esp_driver_usb_serial_jtag driver vfs esp_hw_support
)
