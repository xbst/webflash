// A scripted Klipper USB serial device: answers nothing useful, but on the
// 1200-baud touch (opened at 1200 baud, DTR raised then dropped) it
// "re-enumerates": the port is lost and, a moment later, a new device
// appears in the mock navigators, as Katapult (a serial port), as the
// STM32 DFU device or as an RP2 BOOTSEL device, per the board's build.

import { MockSerialPort } from "./mock-serial.js";
import { KatapultDevice, katapultSerialDevice } from "./katapult-device.js";
import { DfuseDevice } from "./dfuse-device.js";
import { PicobootMockDevice } from "./picoboot-device.js";

/**
 * becomes: "katapult" | "dfu" | "picoboot". serialNav and usbNav are the
 * MockSerialNavigator and MockUsbNavigator the new device appears in.
 * Returns {port, device} where device is the bootloader mock created on
 * the touch (null until then).
 */
export function klipperCdcPort({ becomes = "katapult", serialNav = null, usbNav = null, delayMs = 30, katapultOptions = {}, bootloaderOptions = {} } = {}) {
  const state = { port: null, device: null, touched: false, openedAt: null, dtr: [] };
  const deviceObject = {
    onOpen(options) { state.openedAt = options.baudRate; },
    onWrite() {},
    onSignals(signals, port) {
      if (typeof signals.dataTerminalReady !== "boolean") return;
      state.dtr.push(signals.dataTerminalReady);
      const n = state.dtr.length;
      if (state.openedAt === 1200 && n >= 2 && state.dtr[n - 2] === true && state.dtr[n - 1] === false && !state.touched) {
        state.touched = true;
        setTimeout(() => {
          port.lose();
          setTimeout(() => {
            if (becomes === "katapult") {
              state.device = new KatapultDevice(katapultOptions);
              const kat = new MockSerialPort(katapultSerialDevice(state.device), { info: { usbVendorId: 0x1d50, usbProductId: 0x6177 }, name: "Katapult" });
              if (serialNav) serialNav.connect(kat);
              state.newPort = kat;
            } else if (becomes === "dfu") {
              state.device = new DfuseDevice(bootloaderOptions);
              if (usbNav) usbNav.connect(state.device);
            } else if (becomes === "picoboot") {
              state.device = new PicobootMockDevice(bootloaderOptions);
              if (usbNav) usbNav.connect(state.device);
            }
          }, delayMs);
        }, 0);
      }
    },
  };
  state.port = new MockSerialPort(deviceObject, { info: { usbVendorId: 0x1d50, usbProductId: 0x614e }, name: "Klipper" });
  return state;
}
