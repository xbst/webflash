# Prebuilt firmware example

`prebuilt.toml` flashes a firmware file as it is, with nothing to configure or build: a `[prebuilt]` table instead of `[firmware]` and `[config]`.

The file it names, `katapult.bin`, is not in the repository yet. It will be a Katapult build for the STM32G0B1 (USB on PA11/PA12, 8 MHz crystal, 8 KiB application offset, under 16 KiB), added from a build that has been flashed and verified on real hardware. Until then the example renders without `-i`, referencing the file by its relative path, and `webflash examples/prebuilt/prebuilt.toml -i` stops with "firmware file not found".
