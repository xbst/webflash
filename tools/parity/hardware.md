# Hardware validation

The flashing paths of WebFlash can only be proven on real boards: WebUSB and Web Serial need a person at the keyboard for the browser's device picker. This file is the checklist for that (SPEC 11.10): one row per board and method, the steps, what the page should show, and the result with the operating system and browser it was seen in. Chunk 07 ran the protocol bring-up; chunk 09 runs the whole list again against the live site.

Every method was first exercised against the scripted devices in `src/webflash/site/js/flash/mocks/` (open the site with `?mock=katapult`, `?mock=dfu`, `?mock=picoboot`, `?mock=can` or `?mock=uf2`, optionally `&fail=claim|verify|mcu|rdp|timeout|cancel`), so a row here records only what hardware adds: drivers, timing, re-enumeration, and the printer config hint.

## Firmware files used for the bring-up

Built natively on 2026-11-02 with the Arm GNU Toolchain 14.2.Rel1 under WSL Debian from Klipper `0cee841` (master) and Katapult `3b973a4` (master); the version strings carry `-dirty` because the checkouts were normalized for line endings before building. They live outside the repository in `tests/fixtures/flash/` of the main checkout (git-ignored):

| Folder | Project and configuration | Files | Flash with |
|---|---|---|---|
| `klipper-stm32g0b1-usb-katapult` | Klipper, STM32G0B1, 8 MHz crystal, USB PA11/PA12, 8 KiB bootloader | `klipper.bin` (address `0x08002000`), `klipper.elf`, `klipper.elf.hex` | Katapult over USB; DFU at `0x08002000` keeps Katapult |
| `klipper-stm32g0b1-usb-dfu` | Klipper, STM32G0B1, 8 MHz, USB, no bootloader | `klipper.bin` (`0x08000000`), `klipper.elf`, `klipper.elf.hex` | DFU (this overwrites Katapult) |
| `klipper-stm32g0b1-can` | Klipper, STM32G0B1, 8 MHz, CAN PB0/PB1 at 1 Mbit, 8 KiB bootloader | `klipper.bin` (`0x08002000`) | Katapult over CAN |
| `klipper-stm32f072-usbcan` | Klipper, STM32F072, USB to CAN bridge (CAN PB8/PB9), no bootloader | `klipper.bin` (`0x08000000`) | DFU (ToqueCAN-style bridge) |
| `klipper-rp2040-usb` | Klipper, RP2040, USB, no bootloader | `klipper.uf2`, `klipper.elf`, `klipper.elf.hex` | PICOBOOT, UF2 drive |
| `klipper-rp2040-katapult` | Klipper, RP2040, USB, 16 KiB bootloader | `klipper.bin` (`0x10004000`), `klipper.elf` | Katapult over USB |
| `katapult-stm32g0b1-usb` | Katapult, STM32G0B1, USB, 8 KiB offset, deployer | `katapult.bin` (`0x08000000`), `deployer.bin` (`0x08002000`) | DFU (installs Katapult); the deployer through an existing Katapult |
| `katapult-stm32g0b1-can` | Katapult, STM32G0B1, CAN PB0/PB1, 8 KiB offset | `katapult.bin` (`0x08000000`), `deployer.bin` | DFU or SWD |
| `katapult-rp2040-usb` | Katapult, RP2040, USB | `katapult.uf2`, `katapult.bin` (`0x10000000`) | PICOBOOT, UF2 drive |

A board with a different crystal, USB pins or CAN pins needs its own build (chunk 06's Build, or `make` on a Klipper checkout); the configuration of each file is in its folder's `dot.config`.

## How to run a row

1. Open the site (the local `webflash` server during development; the hosted site after release) in Chrome or Edge on a computer.
2. Click **Upload firmware** in the toolbar and pick the file of the row (a `.bin` asks for its address: use the one in the table). The Flash card then names the file, its address range and, for Klipper binaries, the MCU and version it was built for.
3. Pick the **Method**, read the instructions, put the board in the mode they describe, click **Connect** (or **Restart Klipper into ...** when Klipper is running on the board) and pick the device in the browser's list.
4. Check the confirmation (device, method, address range, size, MCU) and click **Flash**. Watch the progress, the verification and the result box; expand **Log** for the details and **What went wrong?** on a failure.
5. Confirm the board came back: it enumerates as Klipper (`1d50:614e`) or Katapult (`1d50:6177`), and a Klipper host connects to it (Mainsail or Fluidd shows the MCU ready).
6. Record the row: date, OS, browser, board, firmware file, result, and anything the page said that was wrong or missing.

## STOP points for chunk 07 (in this order)

### STOP 1: Katapult over USB, STM32G0B1 with Katapult installed

Board: an STM32G0B1 board with Katapult in its first 8 KiB (Hedgehog or Birds' Nest), on USB.

1. Open `http://127.0.0.1:8071/` (the chunk 07 server) in Chrome.
2. **Upload firmware** → `tests/fixtures/flash/klipper-stm32g0b1-usb-katapult/klipper.bin` → address `0x08002000` → **Use this address**. Expected: "Uploaded klipper.bin: 0x08002000 to 0x0800d72f (45.8 KiB), built for the stm32g0b1xx" in the log; Method shows "Katapult (USB or UART)" with the reason "the firmware starts at 0x08002000, after a bootloader, so Katapult updates it over USB".
3. If Klipper is running on the board: click **Restart Klipper into Katapult**, pick the Klipper port (the picker is filtered to `1d50:614e`), watch the countdown, then click **Pick the Katapult port** when asked and pick it (`1d50:6177`). If the board is already in Katapult (double-tap RESET): click **Connect** and pick it.
4. Check the confirmation, click **Flash**. Expected: "Writing" then "Verifying" to 100 %, the result "Flashed and verified. Katapult v... on serial port (USB 1d50:6177) (stm32g0b1xx). The board has restarted into the new firmware." and the printer.cfg hint.
5. Confirm Klipper enumerates and a host connects.

### STOP 2: DFU on the same board

Board: the same STM32G0B1, put in its ROM bootloader (hold BOOT0, tap RESET, release BOOT0; or **Restart Klipper into the bootloader** from the page when Klipper runs with a DFU-capable build).

1. Windows only, first time: the bootloader device needs WinUSB. It is "DFU in FS Mode" in Zadig's list and in Chrome's picker on a G0B1 (older ROMs say "STM32  BOOTLOADER"; Device Manager shows "STM32 BOOTLOADER"). Zadig (zadig.akeo.ie): Options → List All Devices, pick it, driver WinUSB, Replace Driver. Note here whether STM32CubeProgrammer's driver was in the way.
2. **Upload firmware** → the same `klipper.bin` at `0x08002000` (Katapult stays in place; the DFU bootloader writes anywhere in flash). Method **DFU**.
3. **Connect**, pick "DFU in FS Mode" (`0483:df11`), check the confirmation (23 pages of 2 KiB are erased), **Flash**. Expected: the log names the three alternates ("@Internal Flash  /0x08000000/256*02Kg", "@Option Bytes", "@OTP Memory") and a 1024-byte transfer size, then "Erasing", "Writing", "Verifying", then "Flashed and verified ... The board has restarted into the new firmware." and the hint with `<serial>` (the DFU device's serial is not Klipper's).
4. Confirm Klipper enumerates. If the board stays in the bootloader instead, power-cycle it and say so: the page would then have to stop claiming a restart. Optional: repeat with `katapult-stm32g0b1-usb/katapult.bin` at `0x08000000` to reinstall Katapult itself.

Attempt 1 (2026-11-02) failed before the erase: Chrome on Windows leaves the alternates' `interfaceName` null, and the page's fallback read the string descriptors through a field only the mock had, so the memory map came out empty (see Results). Fixed the same day; attempt 2 passed. On the board at hand all three alternates answered with the internal flash's name (see Results): a device whose alternates all read alike is still flashed through alternate 0.

### STOP 3: PICOBOOT and the UF2 drive, RP2040

Board: an RP2040 board (KUSBA) in BOOTSEL mode (hold BOOTSEL while plugging in).

1. Windows only, first time, for PICOBOOT: "RP2 Boot (Interface 1)" needs WinUSB via Zadig (as above). Record whether Windows installed it by itself.
2. **Upload firmware** → `tests/fixtures/flash/klipper-rp2040-usb/klipper.uf2`. Method **PICOBOOT**: **Connect**, pick "RP2 Boot" (`2e8a:0003`), **Flash**. Expected: 12 sectors erased, 178 pages written and verified, "Rebooting the RP2040 into the firmware", the board enumerates as Klipper.
3. Back in BOOTSEL mode: Method **UF2 file onto the BOOTSEL drive**: **Pick the drive**, pick `RPI-RP2` in the folder picker (the browser asks to allow editing files in it), **Flash**. Expected: "The board took the file and restarted." (the drive vanishes mid-write) and Klipper enumerates.
4. If an RP2350 board is at hand: the same two rows (the drive is `RP2350`; needs a build for the RP2350).

### STOP 4: Katapult over CAN

Boards: a toolhead (STM32G0B1 with Katapult, CAN on PB0/PB1 at 1 Mbit) and either a candleLight-compatible USB to CAN adapter or a Klipper board in USB to CAN bridge mode (ToqueCAN), with the bus terminated.

1. Linux only: the kernel's gs_usb driver owns the adapter. `sudo ip link set can0 down`, then unbind the interface (`echo 1-3:1.0 | sudo tee /sys/bus/usb/drivers/gs_usb/unbind`, with the adapter's own id from `/sys/bus/usb/drivers/gs_usb/`). Windows and macOS need nothing.
2. **Upload firmware** → `tests/fixtures/flash/klipper-stm32g0b1-can/klipper.bin` at `0x08002000` (only if the toolhead's CAN pins and crystal match; else a build for it). Method **Katapult over CAN**.
3. **Connect**, pick the adapter (`1d50:606f`), then pick the toolhead in the node list (a Klipper node is restarted into Katapult first). **Flash**. Expected: "Verifying canbus connection", the write and the verification, "Flashed and verified ... at CAN UUID ..." and the `canbus_uuid` hint.
4. Repeat through the Klipper bridge board. Also try picking the bridge's own UUID: the page should say the bridge is restarting into Katapult over USB and switch the method to Katapult.

### STOP 5: Katapult in UART mode (if wired)

Board: a board built with a serial interface and Katapult in UART mode, on a USB-UART adapter.

1. Method **Katapult**, click **Any serial port**, pick the adapter's port, confirm, **Flash**. The baud is 250000 (Klipper's default). Expected as STOP 1, without the Klipper restart.

## Results

| Date | OS and browser | Board | Method | File | Result | Notes |
|---|---|---|---|---|---|---|
| 2026-11-02 | Windows 10 Pro 19045, Chrome 156.0.8078.79 | STM32G0B1 with Katapult, USB | Katapult over USB (STOP 1) | `klipper-stm32g0b1-usb-katapult/klipper.bin` at `0x08002000` | Pass: flashed and verified, Klipper enumerated and the host connected | As reported by the user from the page; the Katapult version string and the entry path (restart from Klipper or double-tap RESET) were not recorded |
| 2026-11-02 | Windows 10 Pro 19045, Chrome 156.0.8078.79 | STM32G0B1 in its ROM bootloader ("STMicroelectronics DFU in FS Mode", `0483:df11`) | DFU (STOP 2, attempt 1) | `klipper-stm32g0b1-usb-katapult/klipper.bin` at `0x08002000` | Fail before any erase: `The DFU interface does not describe its memory ("")` | Chrome on Windows gives no `interfaceName` for the alternates, and the page's fallback read the string descriptors through a field only the mock had, so the map was empty. Fixed the same day: the names are read from the configuration and string descriptors, as dfu-util reads them, and the mock now hides the names like Chrome on Windows. Also seen: the ROM's transfer size is 1024, not 2048, and Chrome's picker shows "DFU in FS Mode", not "STM32 BOOTLOADER". The WinUSB driver was already in place (Zadig not reported). Retry below |
| 2026-11-02 | Windows 10 Pro 19045, Chrome 156.0.8078.79 | STM32G0B1 with 128 KiB of flash ("@Internal Flash   /0x08000000/64*02Kg") in its ROM bootloader | DFU (STOP 2, attempt 2) | `klipper-stm32g0b1-usb-katapult/klipper.bin` at `0x08002000` | Pass: 23 pages erased in 2 s, 45.8 KiB written in 1024-byte transfers in 7 s, read back and verified in 1 s, "Leaving the bootloader: state dfuMANIFEST, status OK", Klipper enumerated and the host connected, Katapult left in place | The ROM answered the same "@Internal Flash" name for all three alternates (0, 1 and 2) instead of "@Option Bytes" and "@OTP Memory" for 1 and 2: either it uses one string index for all of them or it names the alternate currently selected. Alternate 0 is the right one either way; the log now shows each alternate's string index so the next board tells which |
