// The flashing API the site's panel and the embed runtime share (SPEC 13):
//
//   connectDevice(method, options)        the browser picker for the method's transport
//   flashImage(method, image, options, callbacks)   one flash, start to finish
//
// Every method goes through the same shape: a connection from the picker,
// a FirmwareImage, options (the expected MCU, the CAN node's UUID, bauds
// and bitrates), and callbacks for the log, the progress and the CAN node
// choice. The result carries what the UI shows afterwards: the device, the
// verification, and the printer.cfg hint.
//
// usbSerialToUuid() is the fasthash64 of Katapult's flashtool.py
// (convert_usbsn_to_uuid), a port of Zilong Tan's fast-hash:
//   Copyright (C) 2012 Zilong Tan (eric.zltan@gmail.com), MIT License
// It turns a Klipper USB-to-CAN bridge's USB serial number into the CAN
// UUID the bridge itself answers to, so flashing the bridge through its own
// adapter can be recognized.

import { FlashError, fail, capabilities } from "./errors.js";
import { requestUsbDevice, UsbDevice, sleep } from "./usb.js";
import { requestSerialPort, SerialLink } from "./serial.js";
import { USB_FILTERS, SERIAL_FILTERS, METHODS, printerConfigHint, familyFromMcu } from "./devices.js";
import { flashKatapult, SerialKatapultLink, queryNodes, assignNode, clearNodeIds, requestCanBootloader, uuidFromHex, uuidToHex } from "./katapult.js";
import { GsUsbAdapter } from "./gsusb.js";
import { flashDfu } from "./dfu.js";
import { flashPicoboot } from "./picoboot.js";
import { flashUf2, pickBootselDrive, checkBootselDrive, describeDrive } from "./uf2.js";

export const TRANSPORTS = { dfu: "usb", picoboot: "usb", "katapult-can": "usb", katapult: "serial", uf2: "filesystem", download: "none" };

export function transportOf(method) {
  return TRANSPORTS[method] || "none";
}

/** Whether this browser can run the method: {ok, reason}. */
export function methodAvailable(method, caps = capabilities()) {
  const transport = transportOf(method);
  if (transport === "none") return { ok: true, reason: "" };
  if (transport === "usb" && !caps.usb) {
    return { ok: false, reason: caps.browser === "firefox" || caps.browser === "safari"
      ? "needs WebUSB, which this browser does not have (Chrome or Edge do)" : "needs WebUSB, which is not available here" };
  }
  if (transport === "serial" && !caps.serial) {
    return { ok: false, reason: caps.os === "android" ? "needs Web Serial, which Android Chrome does not have (DFU and PICOBOOT work there)"
      : "needs Web Serial, which this browser does not have (Chrome or Edge on a computer do)" };
  }
  if (transport === "filesystem" && !caps.fileSystem) {
    // Say what was checked: STOP 3 saw this on a desktop Chrome, where the
    // folder picker should exist, and the old text gave nothing to go on.
    const why = caps.secure === false ? "needs an https or localhost page: the browser hides the File System Access API elsewhere"
      : caps.os === "android" ? "needs the File System Access API, which Android Chrome does not have"
      : caps.browser === "firefox" || caps.browser === "safari" ? "needs the File System Access API, which this browser does not have (Chrome or Edge on a computer do)"
      : caps.browser === "brave" ? "needs the File System Access API, which Brave turns off by default (enable brave://flags/#file-system-access-api and restart Brave, or use Chrome or Edge)"
      : "needs the File System Access API, but this browser exposes no window.showDirectoryPicker on this page (Chrome and Edge on a computer have it unless a policy, a flag or an extension removes it)";
    return { ok: false, reason: `${why}; download the .uf2 and copy it onto the drive instead` };
  }
  return { ok: true, reason: "" };
}

/** A picked device for a method: {kind, device, describe()}. serialScope: "katapult" (filtered) or "any" (UART adapters). */
export async function connectDevice(method, { nav = typeof navigator !== "undefined" ? navigator : null, win = typeof window !== "undefined" ? window : null, serialScope = "katapult" } = {}) {
  const transport = transportOf(method);
  if (transport === "usb") {
    const device = await requestUsbDevice(USB_FILTERS[method], { nav });
    return { kind: "usb", method, device, describe: () => device.describe() };
  }
  if (transport === "serial") {
    const filters = serialScope === "any" ? SERIAL_FILTERS.any : SERIAL_FILTERS.katapult;
    const device = await requestSerialPort(filters, { nav });
    return { kind: "serial", method, device, describe: () => device.describe() };
  }
  if (transport === "filesystem") {
    const device = await pickBootselDrive({ win });
    return { kind: "filesystem", method, device, describe: () => `drive "${device.name || "?"}"` };
  }
  fail("unsupported", `"${method}" has nothing to connect to.`);
}

/** Wrap an already-held raw device (a re-enumerated one, a mock) as a connection. */
export function connectionFor(method, raw) {
  const transport = transportOf(method);
  if (transport === "usb") {
    const device = raw instanceof UsbDevice ? raw : new UsbDevice(raw);
    return { kind: "usb", method, device, describe: () => device.describe() };
  }
  if (transport === "serial") {
    const device = raw instanceof SerialLink ? raw : new SerialLink(raw);
    return { kind: "serial", method, device, describe: () => device.describe() };
  }
  return { kind: "filesystem", method, device: raw, info: null, describe: () => describeDrive(null, raw.name) };
}

/**
 * Open and claim a USB connection's interface right after the picker, so a
 * missing driver or a busy device shows before the confirmation rather
 * than after Flash. The interface stays claimed for the flash; the protocol
 * modules' own claim() is then a no-op. A picked drive is read for its
 * INFO_UF2.TXT, so the confirmation names the board the drive belongs to
 * rather than the folder's name, which Chrome on Windows gives as "\" for
 * a drive root (STOP 3), and a folder that is no BOOTSEL drive is refused
 * before anything is written. Serial ports are left alone (opening a port
 * needs the baud rate of the method).
 */
export async function probeConnection(connection) {
  if (connection && connection.kind === "filesystem") {
    const info = await checkBootselDrive(connection.device, {});
    connection.info = info;
    connection.describe = () => describeDrive(info, connection.device.name);
    return connection;
  }
  if (!connection || connection.kind !== "usb") return connection;
  const usb = connection.device;
  await usb.open();
  await usb.selectConfiguration();
  const method = connection.method;
  let spec;
  if (method === "dfu") spec = { classCode: 0xfe, subclassCode: 0x01 };
  else if (method === "picoboot") spec = { classCode: 0xff, test: (alt) => (alt.endpoints || []).filter((e) => e.type === "bulk").length === 2 };
  else spec = { classCode: 0xff, test: (alt) => (alt.endpoints || []).some((e) => e.direction === "in") && (alt.endpoints || []).some((e) => e.direction === "out") };
  const found = usb.findInterface(spec) || (method === "katapult-can" ? usb.findInterface({ number: 0 }) : null);
  if (!found) {
    const what = method === "dfu" ? "DFU interface: it is not in its ROM bootloader (hold BOOT0 and tap RESET)"
      : method === "picoboot" ? "PICOBOOT interface: it is not in BOOTSEL mode (hold BOOTSEL while plugging it in)"
      : "vendor interface with bulk endpoints: it is not a gs_usb CAN adapter";
    fail("not-bootloader", `The device has no ${what}, or it is a different device.`);
  }
  await usb.claim({ number: found.interfaceNumber });
  return connection;
}

/** Katapult's priming quirk applies to STM32 USB stacks other than F2, F4 and H7. Unknown MCU: prime, it is harmless. */
export function shouldPrime(mcu) {
  const m = String(mcu || "").toLowerCase();
  if (!m) return true;
  if (!m.startsWith("stm32")) return false;
  const variant = m.slice(5, 7);
  return !["f2", "f4", "h7"].includes(variant);
}

/**
 * Flash an image. options: {connection, mcu, uuid, baud, bitrate, prime,
 * verify, leave, family, fileName, timing, nodeQueryMs, settleMs,
 * rebootWaitMs}. callbacks: {log(text), progress(phase, done, total),
 * status(text), pickNode(nodes) -> uuidHex | null}.
 */
export async function flashImage(method, image, options = {}, callbacks = {}) {
  const log = callbacks.log || (() => {});
  const progress = callbacks.progress || (() => {});
  const status = callbacks.status || (() => {});
  const { connection } = options;
  if (!METHODS[method]) fail("unsupported", `Unknown flashing method "${method}".`);
  if (method === "download") fail("unsupported", "Download is not a flashing method; save the files instead.");
  if (!connection || !connection.device) fail("flash", "No device is connected.");
  if (!image || image.isEmpty) fail("address", "There is no firmware to write.");
  const mcu = options.mcu || image.mcu || null;
  const verify = options.verify !== false;
  const leave = options.leave !== false;

  switch (method) {
    case "katapult": return flashOverSerial(image, { ...options, mcu, verify }, { log, progress, status });
    case "katapult-can": return flashOverCan(image, { ...options, mcu, verify }, { log, progress, status, pickNode: callbacks.pickNode });
    case "dfu": {
      status("Writing over DFU");
      const r = await flashDfu(connection.device, image, { verify, leave }, { log, progress });
      return { method, verified: r.verified, deviceText: r.device, serial: r.serial, mcu, uuid: null,
               hint: printerConfigHint({ method, mcu, serial: null, project: options.project }), info: r, restarted: leave };
    }
    case "picoboot": {
      status("Writing over PICOBOOT");
      const r = await flashPicoboot(connection.device, image, { verify, reboot: leave }, { log, progress });
      return { method, verified: r.verified, deviceText: r.device, serial: r.serial, mcu: mcu || r.model, uuid: null,
               hint: printerConfigHint({ method, mcu: mcu || r.model, serial: null, project: options.project }), info: r, restarted: leave };
    }
    case "uf2": {
      status("Writing the .uf2 onto the drive");
      const r = await flashUf2(connection.device, image, { family: options.family || null, fileName: options.fileName || null }, { log, progress });
      return { method, verified: false, deviceText: `BOOTSEL drive ${r.info.boardId || r.info.model}`, serial: null, mcu: mcu || r.chip, uuid: null,
               hint: printerConfigHint({ method, mcu: mcu || r.chip, serial: null, project: options.project }), info: r,
               restarted: true, disappeared: r.disappeared };
    }
    default:
      fail("unsupported", `"${method}" is not implemented.`);
  }
}

async function flashOverSerial(image, options, { log, progress, status }) {
  const link = options.connection.device;
  const baud = options.baud || 250000;
  status(`Opening ${link.describe()} at ${baud} baud`);
  await link.open({ baudRate: baud });
  try {
    const prime = options.prime === null || options.prime === undefined ? shouldPrime(options.mcu) : options.prime;
    status("Talking to Katapult");
    const r = await flashKatapult(new SerialKatapultLink(link), image, { mcu: options.mcu, prime, timing: options.timing || {}, verify: options.verify }, { log, progress });
    return { method: "katapult", verified: r.verified, deviceText: `Katapult ${r.softwareVersion} on ${link.describe()} (${r.mcu})`, serial: null,
             mcu: r.mcu, uuid: null, hint: printerConfigHint({ method: "katapult", mcu: r.mcu, serial: null, project: options.project }), info: r, restarted: true };
  } finally {
    try { await link.close(); } catch (e) { /* the board restarted */ }
  }
}

async function flashOverCan(image, options, { log, progress, status, pickNode }) {
  const adapter = new GsUsbAdapter(options.connection.device, { log });
  const bitrate = options.bitrate || 1000000;
  const settle = options.settleMs === undefined ? 500 : options.settleMs;
  const queryMs = options.nodeQueryMs || 2000;
  status(`Starting the CAN adapter at ${bitrate} bit/s`);
  await adapter.open({ bitrate });
  try {
    status("Looking for nodes on the bus");
    let nodes = await queryNodes(adapter, { timeoutMs: queryMs, log });
    let uuidHex = options.uuid ? uuidToHex(uuidFromHex(options.uuid)) : null;
    if (!uuidHex) {
      if (!nodes.length) fail("timeout", "No node answered on the bus. Check the bus speed, the wiring and the termination, and that the toolhead is powered; a node that is already talking to a Klipper host does not answer either.");
      if (!pickNode) fail("flash", "Several nodes may be on the bus; a node UUID is needed.");
      const picked = await pickNode(nodes);
      if (!picked) fail("cancelled", "No node was picked.");
      uuidHex = uuidToHex(uuidFromHex(picked));
    }
    const uuid = uuidFromHex(uuidHex);
    const info = adapter.info();
    if (info.isKlipperBridge && info.serial && usbSerialToUuid(info.serial) === uuidHex) {
      // The node is the bridge board itself: it restarts into Katapult on
      // its USB port, and the flash continues over USB serial.
      log(`The node ${uuidHex} is this USB to CAN bridge itself: asking it to restart into Katapult over USB`);
      await requestCanBootloader(adapter, uuid);
      return { method: "katapult-can", verified: false, deviceText: info.device, serial: info.serial, mcu: options.mcu, uuid: uuidHex,
               hint: null, info, restarted: true, reenumerated: true, nextMethod: "katapult" };
    }
    let node = nodes.find((n) => n.uuidHex === uuidHex);
    if (!node || node.app !== "Katapult") {
      status("Asking the node to restart into Katapult");
      log(`Sending the bootloader request to ${uuidHex}${node ? ` (${node.app})` : ""}`);
      await requestCanBootloader(adapter, uuid);
      const deadline = Date.now() + (options.rebootWaitMs || 8000);
      node = null;
      while (Date.now() < deadline) {
        await sleep(Math.min(settle * 2, 1000));
        nodes = await queryNodes(adapter, { timeoutMs: Math.min(queryMs, 1000) });
        node = nodes.find((n) => n.uuidHex === uuidHex && n.app === "Katapult") || null;
        if (node) break;
      }
      if (!node) fail("reenumeration", `The node ${uuidHex} did not come back as Katapult. If it runs Klipper and is connected to a host, stop Klipper first; if it has no Katapult, flash it over USB or SWD.`);
    }
    await clearNodeIds(adapter);
    await sleep(settle);
    const link = await assignNode(adapter, uuid, 128);
    await sleep(settle);
    try {
      status("Talking to Katapult over CAN");
      const r = await flashKatapult(link, image, { mcu: options.mcu, uuid, prime: false, timing: options.timing || {}, verify: options.verify }, { log, progress });
      return { method: "katapult-can", verified: r.verified, deviceText: `Katapult ${r.softwareVersion} at CAN UUID ${uuidHex} (${r.mcu}) through ${info.device}`,
               serial: null, mcu: r.mcu, uuid: uuidHex, hint: printerConfigHint({ method: "katapult-can", uuid: uuidHex, project: options.project }), info: r, restarted: true };
    } finally {
      await link.close();
    }
  } finally {
    await adapter.close();
  }
}

// ── fasthash64 (MIT), as flashtool.py's convert_usbsn_to_uuid ───────

const M64 = 0xffffffffffffffffn;

function mix(v) {
  v ^= v >> 23n;
  v = (v * 0x2127599bf4325c37n) & M64;
  v ^= v >> 47n;
  return v;
}

export function fasthash64(bytes, seed) {
  const m = 0x880355f21e6d1965n;
  let h = (BigInt(seed) ^ ((BigInt(bytes.length) * m) & M64)) & M64;
  const longs = Math.floor(bytes.length / 8);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < longs; i++) {
    h ^= mix(view.getBigUint64(i * 8, true));
    h = (h * m) & M64;
  }
  const rest = bytes.subarray(longs * 8);
  if (rest.length) {
    let v = 0n;
    for (let i = rest.length; i > 0; i--) v ^= BigInt(rest[i - 1]) << BigInt(8 * (i - 1));
    h ^= mix(v);
    h = (h * m) & M64;
  }
  return mix(h);
}

/** The CAN UUID (12 hex digits) a Klipper bridge derives from its USB serial number (its chip id). */
export function usbSerialToUuid(serialHex) {
  const clean = String(serialHex || "").replace(/[^0-9a-fA-F]/g, "");
  if (!clean.length || clean.length % 2) return null;
  const chipId = new Uint8Array(clean.length / 2);
  for (let i = 0; i < chipId.length; i++) chipId[i] = parseInt(clean.substr(i * 2, 2), 16);
  const result = fasthash64(chipId, 0xA16231A7);
  const out = [];
  for (let i = 0; i < 6; i++) out.push(Number((result >> BigInt(i * 8)) & 0xffn));
  return out.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export { METHODS, familyFromMcu, FlashError };
