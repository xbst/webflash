# WebFlash

Configure, build and flash Klipper, Kalico and Katapult firmware for 3D printer boards from a web browser, with nothing to install. WebFlash runs `make menuconfig` with the project's own Kconfig files, compiles the firmware in the browser with clang and lld built to WebAssembly, and flashes it over USB: the STM32 DFU bootloader, RP2040 PICOBOOT and UF2, and Katapult over USB, UART and CAN. It also turns a board's firmware settings into a themed card you can embed in an MkDocs or Zensical documentation site, so readers build and flash the right firmware for that board in one place.

## Quick start

Open **<https://webflash.isiks.tech>** in Chrome or Edge, pick Klipper, Kalico or Katapult and a version, set the options as you would in `make menuconfig`, and press **Build**. The firmware is compiled in your browser, so your configuration never leaves it. Then plug the board in and press **Flash**: WebFlash finds it over USB, writes the firmware and reads it back to verify it. Firefox and Safari build the firmware and download it, since only Chromium browsers can talk to USB devices.

**Save TOML** keeps the configuration as a board TOML, and **Generate** turns it into a page with a flash card for that one board. To regenerate those pages as a board changes, or publish them from CI, install the command line tool (Python 3.9 or later). It renders the same file from a saved board TOML:

```bash
pip install "git+https://github.com/xbst/webflash.git@master"
webflash board.toml           # writes board.webflash.html
webflash                      # opens the WebFlash site locally
```

To embed the cards in an MkDocs or Zensical site, use [md-iframe](https://github.com/xbst/md-iframe), which sizes the frame to the card and keeps it in step with the site's light and dark mode:

```markdown
![Flash Klipper to the board](board.webflash.html){ type=iframe }
```

`examples/` holds a board TOML for each way of flashing a board, from `stm32g0b1-usb` (Katapult or DFU) and `can-toolhead` (Katapult over CAN) to `prebuilt` (a firmware file, nothing to build): `webflash examples/stm32g0b1-usb/stm32g0b1-usb.toml`.

## Documentation

Coming at **<https://doctools.isiks.tech/webflash/>**.

## US-based PCB Assembly

We moved to in-house PCB assembly in early 2025 after struggling to find a reliable and affordable US-based PCB assembler, and we recently launched a new PCB assembly service to help others with PCB assembly as well. We can often match or beat delivered costs from overseas. We have an estimator on our website so you can upload your BOM and get an instant estimate. [For more information, visit IsikPCB.com](https://isikpcb.com/)

## License

This project is licensed under GPL-3.0. See [LICENSE](LICENSE).

If you'd like to support the development of this and other open-source projects, you can donate on [GitHub Sponsors](https://github.com/sponsors/xbst/) or [Patreon](https://patreon.com/isikstech).
