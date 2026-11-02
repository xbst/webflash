// WebUSB behind a small interface, so the protocols (DFU, PICOBOOT, gs_usb)
// run the same against a real USBDevice and against the scripted devices in
// mocks/. A UsbDevice wraps anything shaped like WebUSB's USBDevice: open,
// close, selectConfiguration, claimInterface, releaseInterface,
// selectAlternateInterface, controlTransferIn/Out, transferIn/Out, clearHalt,
// reset, and the descriptor tree under `configurations`.
//
// What the wrapper adds: picking a configuration and an interface by class
// or number, timeouts on transfers (WebUSB has none, and a transfer that
// times out is left pending, which is the best the API allows), the error
// mapping for a refused claim, and string descriptor reads for the DfuSe
// memory map, which WebUSB exposes as interfaceName only when the device
// enumerated with it.

import { FlashError, fail, isCancel } from "./errors.js";

export const DEFAULT_TIMEOUT_MS = 5000;

/** Whether this browser has WebUSB at all. */
export function hasWebUsb(nav = typeof navigator !== "undefined" ? navigator : null) {
  return !!(nav && nav.usb && typeof nav.usb.requestDevice === "function");
}

/**
 * Show the browser's device picker filtered to the given VID/PID pairs and
 * return a UsbDevice for the choice. Throws a FlashError "cancelled" when
 * the picker is dismissed and "no-api" without WebUSB.
 */
export async function requestUsbDevice(filters, { nav = typeof navigator !== "undefined" ? navigator : null } = {}) {
  if (!hasWebUsb(nav)) fail("no-api", "This browser has no WebUSB, so it cannot talk to the board directly.");
  let raw;
  try {
    raw = await nav.usb.requestDevice({ filters: filters.map(normalizeFilter) });
  } catch (e) {
    if (isCancel(e)) fail("cancelled", "No device was picked.", { cause: e });
    throw e;
  }
  return new UsbDevice(raw);
}

/** Devices this page already has permission for, matching the filters. */
export async function pairedUsbDevices(filters, { nav = typeof navigator !== "undefined" ? navigator : null } = {}) {
  if (!hasWebUsb(nav)) return [];
  const devices = await nav.usb.getDevices();
  return devices.filter((d) => matchesAny(d, filters)).map((d) => new UsbDevice(d));
}

export function normalizeFilter(f) {
  const out = {};
  if (f.vendorId !== undefined) out.vendorId = f.vendorId;
  if (f.productId !== undefined) out.productId = f.productId;
  if (f.classCode !== undefined) out.classCode = f.classCode;
  if (f.subclassCode !== undefined) out.subclassCode = f.subclassCode;
  if (f.protocolCode !== undefined) out.protocolCode = f.protocolCode;
  if (f.serialNumber !== undefined) out.serialNumber = f.serialNumber;
  return out;
}

export function matchesAny(device, filters) {
  if (!filters || !filters.length) return true;
  return filters.some((f) =>
    (f.vendorId === undefined || f.vendorId === device.vendorId) &&
    (f.productId === undefined || f.productId === device.productId) &&
    (f.serialNumber === undefined || f.serialNumber === device.serialNumber));
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve with the promise's value or throw a FlashError "timeout" after
 * ms. The underlying operation keeps running: WebUSB cannot cancel it.
 */
export function withTimeout(promise, ms, what = "the device") {
  if (!(ms > 0) || ms === Infinity) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new FlashError(`${what} did not answer within ${ms} ms.`, { code: "timeout" })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class UsbDevice {
  constructor(raw) {
    this.raw = raw;
    this.interfaceNumber = null;
    this.opened = false;
    this.claimed = [];
  }

  get vendorId() { return this.raw.vendorId; }
  get productId() { return this.raw.productId; }
  get productName() { return this.raw.productName || ""; }
  get manufacturerName() { return this.raw.manufacturerName || ""; }
  get serialNumber() { return this.raw.serialNumber || ""; }
  get configurations() { return this.raw.configurations || []; }
  get configuration() { return this.raw.configuration || null; }

  /** "1d50:6177" */
  get idString() {
    return `${hex4(this.vendorId)}:${hex4(this.productId)}`;
  }

  /** A line for the confirmation: product, ids, serial. */
  describe() {
    const parts = [];
    if (this.manufacturerName) parts.push(this.manufacturerName);
    if (this.productName) parts.push(this.productName);
    let text = parts.join(" ") || "USB device";
    text += ` (${this.idString}`;
    if (this.serialNumber) text += `, serial ${this.serialNumber}`;
    return `${text})`;
  }

  async open() {
    if (this.opened) return;
    try {
      await this.raw.open();
    } catch (e) {
      throw mapOpenError(e);
    }
    this.opened = true;
  }

  /** Select a configuration by value (default: the first) if not current. */
  async selectConfiguration(value = null) {
    const configs = this.configurations;
    if (!configs.length) fail("not-bootloader", "The device reports no USB configuration.");
    const wanted = value === null ? configs[0].configurationValue : value;
    const current = this.configuration;
    if (!current || current.configurationValue !== wanted) {
      try {
        await this.raw.selectConfiguration(wanted);
      } catch (e) {
        throw mapClaimError(e);
      }
    }
    return this.configuration || configs[0];
  }

  /**
   * Find an interface by {number} or by {classCode, subclassCode?,
   * protocolCode?} over the current configuration's alternates. Returns
   * {interfaceNumber, alternate, interface} or null.
   */
  findInterface(spec = {}) {
    const config = this.configuration || this.configurations[0];
    if (!config) return null;
    for (const intf of config.interfaces || []) {
      for (const alt of intf.alternates || []) {
        if (spec.number !== undefined && intf.interfaceNumber !== spec.number) continue;
        if (spec.classCode !== undefined && alt.interfaceClass !== spec.classCode) continue;
        if (spec.subclassCode !== undefined && alt.interfaceSubclass !== spec.subclassCode) continue;
        if (spec.protocolCode !== undefined && alt.interfaceProtocol !== spec.protocolCode) continue;
        if (spec.alternateSetting !== undefined && alt.alternateSetting !== spec.alternateSetting) continue;
        if (spec.test && !spec.test(alt, intf)) continue;
        return { interfaceNumber: intf.interfaceNumber, alternate: alt, interface: intf };
      }
    }
    return null;
  }

  /**
   * Claim an interface (by number or by the findInterface spec) and make it
   * the device's working interface. Maps the refused claim to a FlashError
   * "claim-failed", which explainError turns into the driver or permission
   * steps for the OS.
   */
  async claim(spec = {}) {
    const found = typeof spec === "number" ? this.findInterface({ number: spec }) : this.findInterface(spec);
    if (!found) {
      fail("not-bootloader", "The device has no interface of the kind this method needs; it is probably not in its bootloader.", {
        details: { spec: typeof spec === "number" ? { number: spec } : { ...spec, test: undefined } },
      });
    }
    try {
      await this.raw.claimInterface(found.interfaceNumber);
    } catch (e) {
      throw mapClaimError(e);
    }
    this.interfaceNumber = found.interfaceNumber;
    this.claimed.push(found.interfaceNumber);
    return found;
  }

  async selectAlternate(alternateSetting, interfaceNumber = this.interfaceNumber) {
    try {
      await this.raw.selectAlternateInterface(interfaceNumber, alternateSetting);
    } catch (e) {
      // A redundant SET_INTERFACE on a device with one alternate is refused
      // by some stacks; the interface is already what we asked for.
      const intf = this.findInterface({ number: interfaceNumber });
      if (intf && intf.interface.alternate && intf.interface.alternate.alternateSetting === alternateSetting &&
          (intf.interface.alternates || []).length <= 1) return;
      throw mapClaimError(e);
    }
  }

  async release(interfaceNumber = this.interfaceNumber) {
    if (interfaceNumber === null) return;
    try {
      await this.raw.releaseInterface(interfaceNumber);
    } catch (e) {
      // Releasing a gone device is fine.
    }
    this.claimed = this.claimed.filter((n) => n !== interfaceNumber);
    if (this.interfaceNumber === interfaceNumber) this.interfaceNumber = null;
  }

  async close() {
    if (!this.opened) return;
    for (const n of this.claimed.slice()) await this.release(n);
    try {
      await this.raw.close();
    } catch (e) {
      // Closing a device that just rebooted throws; that is the point.
    }
    this.opened = false;
  }

  async reset() {
    try {
      await this.raw.reset();
    } catch (e) {
      throw wrapTransferError(e, "reset");
    }
  }

  async forget() {
    if (typeof this.raw.forget === "function") {
      try { await this.raw.forget(); } catch (e) { /* not important */ }
    }
  }

  // ── Transfers ─────────────────────────────────────────────────────

  /**
   * Control IN. setup = {requestType: "standard"|"class"|"vendor",
   * recipient: "device"|"interface"|"endpoint"|"other", request, value,
   * index}. Returns a DataView of the bytes received.
   */
  async controlIn(setup, length, { timeout = DEFAULT_TIMEOUT_MS } = {}) {
    let result;
    try {
      result = await withTimeout(this.raw.controlTransferIn(fullSetup(setup, this.interfaceNumber), length), timeout, "the device");
    } catch (e) {
      throw wrapTransferError(e, "control transfer");
    }
    if (result.status !== "ok") {
      fail("protocol", `The device refused a control request (${result.status}).`, { details: { setup, status: result.status } });
    }
    return result.data;
  }

  /** Control OUT; data may be omitted for a zero-length request. */
  async controlOut(setup, data = undefined, { timeout = DEFAULT_TIMEOUT_MS } = {}) {
    let result;
    try {
      const full = fullSetup(setup, this.interfaceNumber);
      const p = data === undefined || data === null ? this.raw.controlTransferOut(full) : this.raw.controlTransferOut(full, toBuffer(data));
      result = await withTimeout(p, timeout, "the device");
    } catch (e) {
      throw wrapTransferError(e, "control transfer");
    }
    if (result.status !== "ok") {
      fail("protocol", `The device refused a control request (${result.status}).`, { details: { setup, status: result.status } });
    }
    return result.bytesWritten;
  }

  /** Bulk/interrupt IN of up to length bytes. Returns a Uint8Array. */
  async transferIn(endpointNumber, length, { timeout = DEFAULT_TIMEOUT_MS } = {}) {
    let result;
    try {
      result = await withTimeout(this.raw.transferIn(endpointNumber, length), timeout, "the device");
    } catch (e) {
      throw wrapTransferError(e, "read");
    }
    if (result.status === "stall") {
      throw new FlashError("The device stalled the read.", { code: "stall", details: { endpoint: endpointNumber } });
    }
    if (result.status !== "ok") {
      fail("protocol", `The read failed (${result.status}).`, { details: { endpoint: endpointNumber, status: result.status } });
    }
    const view = result.data;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }

  /** Bulk/interrupt OUT. Returns the number of bytes written. */
  async transferOut(endpointNumber, data, { timeout = DEFAULT_TIMEOUT_MS } = {}) {
    let result;
    try {
      result = await withTimeout(this.raw.transferOut(endpointNumber, toBuffer(data)), timeout, "the device");
    } catch (e) {
      throw wrapTransferError(e, "write");
    }
    if (result.status === "stall") {
      throw new FlashError("The device stalled the write.", { code: "stall", details: { endpoint: endpointNumber } });
    }
    if (result.status !== "ok") {
      fail("protocol", `The write failed (${result.status}).`, { details: { endpoint: endpointNumber, status: result.status } });
    }
    return result.bytesWritten;
  }

  async clearHalt(direction, endpointNumber) {
    try {
      await this.raw.clearHalt(direction, endpointNumber);
    } catch (e) {
      throw wrapTransferError(e, "clear halt");
    }
  }

  // ── Descriptors ───────────────────────────────────────────────────

  /** The raw configuration descriptor (with its sub-descriptors) by index. */
  async readConfigurationDescriptor(index = 0) {
    const setup = { requestType: "standard", recipient: "device", request: 0x06, value: (0x02 << 8) | index, index: 0 };
    const head = await this.controlIn(setup, 9);
    const total = head.getUint16(2, true);
    const full = await this.controlIn(setup, total);
    return new Uint8Array(full.buffer, full.byteOffset, full.byteLength);
  }

  /** A string descriptor as text (US English). */
  async readStringDescriptor(index, langId = 0x0409) {
    if (!index) return "";
    const setup = { requestType: "standard", recipient: "device", request: 0x06, value: (0x03 << 8) | index, index: langId };
    const head = await this.controlIn(setup, 1);
    const length = head.getUint8(0);
    if (length < 2) return "";
    const full = await this.controlIn(setup, length);
    const codes = [];
    for (let i = 2; i + 1 < full.byteLength; i += 2) codes.push(full.getUint16(i, true));
    return String.fromCharCode(...codes);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

export function hex4(n) {
  return (n >>> 0).toString(16).padStart(4, "0");
}

export function hex8(n) {
  return `0x${(n >>> 0).toString(16).padStart(8, "0")}`;
}

function fullSetup(setup, interfaceNumber) {
  const out = { requestType: setup.requestType || "vendor", recipient: setup.recipient || "interface",
                request: setup.request, value: setup.value || 0, index: setup.index };
  if (out.index === undefined || out.index === null) out.index = interfaceNumber === null ? 0 : interfaceNumber;
  return out;
}

function toBuffer(data) {
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  if (Array.isArray(data)) return new Uint8Array(data).buffer;
  throw new TypeError("transfer data must be an ArrayBuffer, a typed array or an array of bytes");
}

function mapOpenError(e) {
  if (e instanceof FlashError) return e;
  const msg = String(e && e.message ? e.message : e);
  if (e && (e.name === "SecurityError" || /Access denied/i.test(msg))) {
    return new FlashError(`The browser may not open the device: ${msg}`, { code: "permission", cause: e });
  }
  if (e && (e.name === "NetworkError" || /Failed to open|busy|in use/i.test(msg))) {
    return new FlashError(`The device could not be opened: ${msg}`, { code: "claim-failed", cause: e });
  }
  if (e && e.name === "NotFoundError") {
    return new FlashError(`The device went away: ${msg}`, { code: "disconnected", cause: e });
  }
  return new FlashError(`The device could not be opened: ${msg}`, { code: "flash", cause: e });
}

function mapClaimError(e) {
  if (e instanceof FlashError) return e;
  const msg = String(e && e.message ? e.message : e);
  if (e && e.name === "SecurityError") {
    return new FlashError(`The browser may not claim the device's interface: ${msg}`, { code: "permission", cause: e });
  }
  if (e && e.name === "NotFoundError") {
    return new FlashError(`The device went away while claiming its interface: ${msg}`, { code: "disconnected", cause: e });
  }
  // Chrome: "NetworkError: Unable to claim interface." on Windows when the
  // driver is not WinUSB, on Linux when a kernel driver or another program
  // holds it, and when another tab holds it.
  return new FlashError(`The browser could not claim the device's interface (${msg}).`, { code: "claim-failed", cause: e });
}

function wrapTransferError(e, what) {
  if (e instanceof FlashError) return e;
  const msg = String(e && e.message ? e.message : e);
  if (e && (e.name === "NotFoundError" || /disconnected|unavailable|lost/i.test(msg))) {
    return new FlashError(`The device went away during a ${what}: ${msg}`, { code: "disconnected", cause: e });
  }
  if (e && e.name === "AbortError") {
    return new FlashError(`The ${what} was stopped: ${msg}`, { code: "aborted", cause: e });
  }
  if (e && e.name === "InvalidStateError") {
    return new FlashError(`The ${what} is not possible in the device's state: ${msg}`, { code: "busy", cause: e });
  }
  return new FlashError(`The ${what} failed: ${msg}`, { code: "protocol", cause: e });
}
