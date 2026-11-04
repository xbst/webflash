# Prebuilt firmware example

`prebuilt.toml` flashes a firmware file as it is, with nothing to configure or build: a `[prebuilt]` table instead of `[firmware]` and `[config]`. `webflash examples/prebuilt/prebuilt.toml -i` puts the file inside the page; without `-i` the page fetches it from beside itself.

`katapult.bin` is the Katapult bootloader for the STM32G0B1 (USB on PA11/PA12, 8 MHz crystal, the application at 8 KiB, double-tap RESET to stay in the bootloader), 3,954 bytes with SHA-256 `bc0043a352ca1333583cc06fecbeaeb5797f8f02624f4cf066f87b7f62e97ab3`. The WebFlash site built it from `../katapult-stm32g0b1/katapult-stm32g0b1.toml` on Katapult `master` at `3b973a4` (`v0.0.1-115-g3b973a4`, [github.com/Arksine/katapult](https://github.com/Arksine/katapult), GPL-3.0), and it was flashed with DFU and verified on an STM32G0B1 board, which then ran Klipper through it, on 2026-11-03.
