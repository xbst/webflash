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
// mapping for a refused claim, and descriptor reads for what WebUSB leaves
// out: the DFU functional descriptor, and the alternates' names (the DfuSe
// memory map), which Chrome fills in as interfaceName on Linux and macOS
// but leaves null on Windows, so they are read from the configuration and
// string descriptors the way dfu-util and webdfu read them.

import { FlashError, fail, isCancel } from "./errors.js";

export const DEFAULT_TIMEOUT_MS = 5000;
export const OPEN_TIMEOUT_MS = 10000;    // open, selectConfiguration, claimInterface, selectAlternateInterface

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
    this.openTimeoutMs = OPEN_TIMEOUT_MS;
  }

  /**
   * Opening, configuring and claiming have no timeout in WebUSB, and on
   * Windows Chrome can sit forever on a device whose interface has no
   * WinUSB driver (STOP 3 found the connect step stuck on an RP2040 in
   * BOOTSEL). A bounded wait turns that into the driver steps.
   */
  async _bounded(promise, what) {
    try {
      return await withTimeout(promise, this.openTimeoutMs, "the device");
    } catch (e) {
      if (e instanceof FlashError && e.code === "timeout") {
        throw new FlashError(`The browser did not finish ${what} within ${Math.round(this.openTimeoutMs / 1000)} s. The device is listed but cannot be used, which on Windows means its interface has no WinUSB driver.`, { code: "claim-failed", cause: e });
      }
      throw e;
    }
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
      await this._bounded(this.raw.open(), "opening the device");
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
        await this._bounded(this.raw.selectConfiguration(wanted), "selecting the device's configuration");
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
    if (!this.claimed.includes(found.interfaceNumber)) {
      // The connect step may have claimed it already, to surface driver and
      // permission problems before the confirmation.
      try {
        await this._bounded(this.raw.claimInterface(found.interfaceNumber), "claiming the device's interface");
      } catch (e) {
        throw mapClaimError(e);
      }
      this.claimed.push(found.interfaceNumber);
    }
    this.interfaceNumber = found.interfaceNumber;
    return found;
  }

  async selectAlternate(alternateSetting, interfaceNumber = this.interfaceNumber) {
    try {
      await this._bounded(this.raw.selectAlternateInterface(interfaceNumber, alternateSetting), "selecting the interface's alternate");
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

  /** The position of the active configuration among the device's, for GET_DESCRIPTOR. */
  _configurationIndex() {
    const current = this.configuration;
    const i = current ? this.configurations.findIndex((c) => c.configurationValue === current.configurationValue) : 0;
    return i < 0 ? 0 : i;
  }

  /** The raw configuration descriptor (with its sub-descriptors) by index (default: the active configuration's). */
  async readConfigurationDescriptor(index = null) {
    const which = index === null ? this._configurationIndex() : index;
    const setup = { requestType: "standard", recipient: "device", request: 0x06, value: (0x02 << 8) | which, index: 0 };
    const head = await this.controlIn(setup, 9);
    if (head.byteLength < 4) fail("protocol", "The configuration descriptor came back short.");
    const total = head.getUint16(2, true);
    const full = await this.controlIn(setup, total);
    return new Uint8Array(full.buffer, full.byteOffset, full.byteLength);
  }

  /** The language ids the device's strings come in (string descriptor 0), or [0x0409] when it lists none. */
  async readLangIds() {
    const setup = { requestType: "standard", recipient: "device", request: 0x06, value: 0x03 << 8, index: 0 };
    const data = await this.controlIn(setup, 255);
    const ids = [];
    const length = data.byteLength ? Math.min(data.getUint8(0), data.byteLength) : 0;
    for (let i = 2; i + 1 < length; i += 2) ids.push(data.getUint16(i, true));
    return ids.length ? ids : [0x0409];
  }

  /** A string descriptor as text: one 255-byte read, as libusb does it. */
  async readStringDescriptor(index, langId = 0x0409) {
    if (!index) return "";
    const setup = { requestType: "standard", recipient: "device", request: 0x06, value: (0x03 << 8) | index, index: langId };
    const data = await this.controlIn(setup, 255);
    if (data.byteLength < 2) return "";
    const length = Math.min(data.getUint8(0), data.byteLength);
    const codes = [];
    for (let i = 2; i + 1 < length; i += 2) codes.push(data.getUint16(i, true));
    return String.fromCharCode(...codes);
  }

  /**
   * The name of each alternate of an interface, read from the device's own
   * descriptors: the configuration descriptor gives each alternate's string
   * index (WebUSB does not expose it), then each string is read once.
   * Returns {raw, langId, names: Map<alternateSetting, string|null>,
   * indexes: Map<alternateSetting, iInterface>, failures: [text]}: raw is
   * the configuration descriptor, for the class-specific descriptors in
   * it, and failures says which reads the device refused.
   */
  async readInterfaceNames(interfaceNumber = this.interfaceNumber) {
    const raw = await this.readConfigurationDescriptor();
    const parsed = parseConfigurationDescriptor(raw);
    const failures = [];
    let langId = 0x0409;
    try {
      langId = (await this.readLangIds())[0];
    } catch (e) {
      failures.push(`string descriptor 0 (the language list): ${e.message}`);
    }
    const names = new Map();
    const indexes = new Map();
    const strings = new Map();
    for (const d of parsed.interfaces) {
      if (interfaceNumber !== null && interfaceNumber !== undefined && d.interfaceNumber !== interfaceNumber) continue;
      indexes.set(d.alternateSetting, d.iInterface);
      let text = null;
      if (d.iInterface) {
        if (!strings.has(d.iInterface)) {
          try {
            strings.set(d.iInterface, await this.readStringDescriptor(d.iInterface, langId));
          } catch (e) {
            strings.set(d.iInterface, null);
            failures.push(`string descriptor ${d.iInterface}: ${e.message}`);
          }
        }
        text = strings.get(d.iInterface);
      }
      names.set(d.alternateSetting, text);
    }
    return { raw, langId, names, indexes, failures };
  }
}

/**
 * Walk a raw configuration descriptor: the header, every interface
 * descriptor (type 4) with the string index WebUSB leaves out, and the
 * position of every descriptor in it. Returns {configurationValue,
 * totalLength, iConfiguration, interfaces: [{interfaceNumber,
 * alternateSetting, endpoints, interfaceClass, interfaceSubclass,
 * interfaceProtocol, iInterface}], descriptors: [{type, offset, length}]}.
 */
export function parseConfigurationDescriptor(bytes) {
  const out = { configurationValue: 0, totalLength: bytes.length, iConfiguration: 0, interfaces: [], descriptors: [] };
  if (bytes.length >= 9 && bytes[1] === 0x02) {
    out.totalLength = bytes[2] | (bytes[3] << 8);
    out.configurationValue = bytes[5];
    out.iConfiguration = bytes[6];
  }
  let off = 0;
  while (off + 2 <= bytes.length) {
    const length = bytes[off];
    const type = bytes[off + 1];
    if (length < 2) break;
    out.descriptors.push({ type, offset: off, length });
    if (type === 0x04 && length >= 9) {
      out.interfaces.push({
        interfaceNumber: bytes[off + 2], alternateSetting: bytes[off + 3], endpoints: bytes[off + 4],
        interfaceClass: bytes[off + 5], interfaceSubclass: bytes[off + 6], interfaceProtocol: bytes[off + 7], iInterface: bytes[off + 8],
      });
    }
    off += length;
  }
  return out;
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
  return new FlashError(`The browser could not claim the device's interface (${msg.replace(/\.$/, "")}).`, { code: "claim-failed", cause: e });
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
