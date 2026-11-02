// Getting a board into its bootloader (SPEC 11.4).
//
// A USB Klipper device enters its bootloader on the Arduino-style 1200-baud
// touch: Klipper's usb_cdc.c calls bootloader_request() when it sees a line
// coding of 1200 baud with DTR cleared, so the port is opened at 1200, DTR
// is raised and dropped, and the port closed. The board then re-enumerates
// as Katapult, as the STM32 DFU device or as an RP2 BOOTSEL device,
// according to its build. A Katapult-in-UART-mode board gets the serial
// request string instead (serial_irq.c), and a CAN node the admin reboot
// command (katapult.js). Without any of these, the TOML's instructions or
// the per-MCU defaults tell the user which buttons to press.
//
// After the touch the browser needs a new permission for the new USB
// identity, so waitForDevice() can only see devices this page already has
// permission for; the panel shows a countdown and then asks the user to
// pick the device.

import { FlashError, fail } from "./errors.js";
import { hasWebSerial, pairedSerialPorts, requestSerialPort, matchesSerialFilter, SerialLink } from "./serial.js";
import { hasWebUsb, pairedUsbDevices, requestUsbDevice, matchesAny, UsbDevice, sleep } from "./usb.js";
import { SERIAL_FILTERS, USB_FILTERS, defaultInstructions } from "./devices.js";
import { SERIAL_BL_REQ, requestCanBootloader } from "./katapult.js";

export { requestCanBootloader };

export const REENUMERATION_TIMEOUT_MS = 10000;
export const POLL_MS = 250;

/**
 * The 1200-baud touch on an open-able serial port (a SerialLink). Errors
 * after the open are tolerated: the board may reset before the last step.
 */
export async function touch1200(link, { log = null } = {}) {
  if (log) log(`Asking Klipper on ${link.describe()} to enter its bootloader (1200 baud, DTR on then off)`);
  await link.open({ baudRate: 1200 });
  try {
    await link.setSignals({ dataTerminalReady: true });
    await link.setSignals({ dataTerminalReady: false });
  } catch (e) {
    if (log) log(`The board reset during the touch (${e.message}); that is expected`);
  } finally {
    try { await link.close(); } catch (e) { /* the device is gone */ }
  }
}

/** Katapult's serial bootloader request for a board in UART mode, at the configured baud. */
export async function requestSerialBootloader(link, baud = 250000, { log = null, settleMs = 1000 } = {}) {
  if (log) log(`Sending the serial bootloader request at ${baud} baud`);
  await link.open({ baudRate: baud });
  try {
    await link.write(SERIAL_BL_REQ);
    await sleep(settleMs);
  } finally {
    try { await link.close(); } catch (e) { /* gone */ }
  }
}

/** The connect step's text: the board TOML's per-method instructions, else the defaults. */
export function manualInstructions(method, family = null, tomlInstructions = null, options = {}) {
  if (tomlInstructions && typeof tomlInstructions === "object" && typeof tomlInstructions[method] === "string" && tomlInstructions[method].trim()) {
    return tomlInstructions[method].trim();
  }
  return defaultInstructions(method, family, options);
}

/** What the board turns into after the touch, per method: the picker filters for it. */
export function expectedAfterTouch(method) {
  switch (method) {
    case "katapult": return { kind: "serial", filters: SERIAL_FILTERS.katapult, label: "the Katapult port" };
    case "dfu": return { kind: "usb", filters: USB_FILTERS.dfu, label: "STM32 BOOTLOADER" };
    case "picoboot": return { kind: "usb", filters: USB_FILTERS.picoboot, label: "RP2 Boot" };
    case "uf2": return { kind: "filesystem", filters: [], label: "the RPI-RP2 drive" };
    default: return { kind: "none", filters: [], label: "" };
  }
}

/**
 * Wait for a device matching the filters that this page already has
 * permission for, polling and listening for "connect" events, up to
 * timeoutMs. onTick(remainingMs) drives a countdown. Resolves with a
 * UsbDevice or SerialLink, or null on timeout (the panel then asks the
 * user to pick it).
 */
export async function waitForDevice({ kind, filters = [], timeoutMs = REENUMERATION_TIMEOUT_MS, nav = typeof navigator !== "undefined" ? navigator : null,
                                      onTick = null, ignore = [] } = {}) {
  const target = kind === "usb" ? (nav && nav.usb) : kind === "serial" ? (nav && nav.serial) : null;
  if (!target) return null;
  const ignored = new Set(ignore.map((d) => d && (d.raw || d)));
  const present = async () => {
    const list = kind === "usb" ? await pairedUsbDevices(filters, { nav }) : await pairedSerialPorts(filters, { nav });
    return list.find((d) => !ignored.has(d.raw)) || null;
  };
  const deadline = Date.now() + timeoutMs;
  let found = await present();
  if (found) return found;
  return new Promise((resolve) => {
    let timer = null;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearInterval(timer);
      try { target.removeEventListener("connect", onConnect); } catch (e) { /* mock without events */ }
      resolve(value);
    };
    const onConnect = (ev) => {
      const raw = ev.device || ev.port || ev.target;
      if (!raw || ignored.has(raw)) return;
      const ok = kind === "usb" ? matchesAny(raw, filters) : matchesSerialFilter(raw, filters);
      if (ok) finish(kind === "usb" ? new UsbDevice(raw) : new SerialLink(raw));
    };
    try { target.addEventListener("connect", onConnect); } catch (e) { /* mock without events */ }
    timer = setInterval(async () => {
      const remaining = deadline - Date.now();
      if (onTick) onTick(Math.max(0, remaining));
      const hit = await present().catch(() => null);
      if (hit) finish(hit);
      else if (remaining <= 0) finish(null);
    }, POLL_MS);
  });
}

/** Resolves true when the navigator reports the device gone, false after timeoutMs. */
export function waitForDisconnect(device, { timeoutMs = 5000, nav = typeof navigator !== "undefined" ? navigator : null } = {}) {
  const raw = device && (device.raw || device);
  const targets = [nav && nav.usb, nav && nav.serial].filter(Boolean);
  if (!targets.length) return Promise.resolve(false);
  return new Promise((resolve) => {
    let timer = null;
    const finish = (value) => {
      clearTimeout(timer);
      for (const t of targets) { try { t.removeEventListener("disconnect", onDisconnect); } catch (e) { /* none */ } }
      resolve(value);
    };
    const onDisconnect = (ev) => {
      const gone = ev.device || ev.port || ev.target;
      if (gone === raw) finish(true);
    };
    for (const t of targets) { try { t.addEventListener("disconnect", onDisconnect); } catch (e) { /* none */ } }
    timer = setTimeout(() => finish(false), timeoutMs);
  });
}

/**
 * The Klipper-over-USB entry: pick the Klipper port (filtered), touch it,
 * then wait for the bootloader's device. Returns {device, picked: boolean}:
 * device is null when the user must pick it after the countdown.
 */
export async function enterFromKlipperUsb(method, { nav = typeof navigator !== "undefined" ? navigator : null, log = null, onTick = null,
                                                   timeoutMs = REENUMERATION_TIMEOUT_MS, port = null } = {}) {
  if (!hasWebSerial(nav)) fail("no-api", "This browser has no Web Serial, so it cannot ask Klipper to restart into its bootloader. Put the board in its bootloader by hand.");
  const link = port || await requestSerialPort(SERIAL_FILTERS.klipper, { nav });
  await touch1200(link, { log });
  const expect = expectedAfterTouch(method);
  if (expect.kind === "none" || expect.kind === "filesystem") return { device: null, expect };
  if (log) log(`Waiting for ${expect.label} to appear`);
  const device = await waitForDevice({ kind: expect.kind, filters: expect.filters, timeoutMs, nav, onTick, ignore: [link] });
  return { device, expect };
}
