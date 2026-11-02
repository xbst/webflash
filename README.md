# WebFlash

Configure, build and flash Klipper, Kalico and Katapult firmware for 3D printer boards from a web browser, with nothing to install. WebFlash runs `make menuconfig` with the project's own Kconfig files, compiles the firmware in the browser with clang and lld built to WebAssembly, and flashes it over USB (STM32 DFU, RP2040 PICOBOOT and UF2, Katapult over USB, UART and CAN). It also turns a board's firmware settings into a themed card you can embed in an MkDocs or Zensical documentation site, so readers build and flash the right firmware for that board in one place.

Documentation coming at <https://doctools.isiks.tech/webflash/>.

## License

This project is licensed under GPL-3.0. See [LICENSE](LICENSE).
