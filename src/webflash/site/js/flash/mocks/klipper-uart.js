// A scripted USB-UART adapter wired to a board in UART mode: the adapter's
// port carries a CH340's id, not Klipper's or Katapult's. The board runs
// Klipper until Klipper's serial bootloader request arrives at its baud,
// then Katapult, which answers on the same port at the same baud. A port
// opened at another baud gets no answers (on a real line the bytes would be
// garbled), and the 1200-baud touch does nothing: an adapter carries no line
// coding to the board.

import { MockSerialPort } from "./mock-serial.js";
import { KatapultDevice } from "./katapult-device.js";
import { SERIAL_BL_REQ } from "../katapult.js";

export const UART_ADAPTER_ID = { usbVendorId: 0x1a86, usbProductId: 0x7523 };

/**
 * baud: what the board's Klipper and Katapult were built for. inKatapult:
 * the board starts in Katapult (double-tapped RESET). Returns
 * {port, device, requested, opens}: device is the KatapultDevice, opens
 * every baud the port was opened at, requested whether the request came.
 */
export function klipperUartPort({ baud = 250000, inKatapult = false, katapultOptions = {} } = {}) {
  const state = { port: null, device: new KatapultDevice(katapultOptions), requested: false, inKatapult, opens: [], openedAt: null, received: [] };
  const deviceObject = {
    onOpen(options) {
      state.openedAt = options.baudRate;
      state.opens.push(options.baudRate);
    },
    onWrite(bytes, port) {
      if (state.openedAt !== baud) return;
      if (state.inKatapult) {
        state.device.receive(bytes, (out) => port.emit(out));
        return;
      }
      for (const b of bytes) state.received.push(b);
      if (state.received.length > 256) state.received.splice(0, state.received.length - 256);
      if (endsWith(state.received, SERIAL_BL_REQ)) {
        state.requested = true;
        state.received.length = 0;
        state.inKatapult = true;
      }
    },
  };
  state.port = new MockSerialPort(deviceObject, { info: { ...UART_ADAPTER_ID }, name: "USB-UART adapter" });
  return state;
}

function endsWith(list, tail) {
  if (list.length < tail.length) return false;
  const off = list.length - tail.length;
  for (let i = 0; i < tail.length; i++) if (list[off + i] !== tail[i]) return false;
  return true;
}
