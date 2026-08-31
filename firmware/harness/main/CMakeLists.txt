idf_component_register(
  SRCS
    "main.c"
  INCLUDE_DIRS "."
  REQUIRES
    esp_psram app_update esp_timer esp_system spi_flash esp_partition
)
