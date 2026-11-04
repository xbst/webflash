// A scripted WebUSB device and navigator.usb, for the Node tests and the
// site's ?mock= mode. MockUsbDevice has the USBDevice surface the UsbDevice
// wrapper uses (open, close, selectConfiguration, claimInterface,
// releaseInterface, selectAlternateInterface, controlTransferIn/Out,
// transferIn/Out, clearHalt, reset, forget, and the descriptor tree). A
// subclass or a handlers object supplies the device's behavior:
//
//   handlers.controlIn(setup, length, device)  -> Uint8Array | {status, data?}
//   handlers.controlOut(setup, data, device)   -> void | {status}
//   handlers.bulkIn(endpointNumber, length, device)   -> Uint8Array | {status, data?} (may be a promise)
//   handlers.bulkOut(endpointNumber, data, device)    -> void | {status}
//
// Returning {status: "stall"} stalls like a real endpoint. device.lose()
// makes every later call fail with NotFoundError, as a rebooting board does.

export function domError(name, message) {
  let e;
  if (typeof DOMException !== "undefined") {
    e = new DOMException(message, name);
  } else {
    e = new Error(message);
    e.name = name;
  }
  return e;
}

/** Build a WebUSB-shaped configuration tree from a compact description. */
export function makeConfiguration({ value = 1, interfaces }) {
  const config = { configurationValue: value, configurationName: null, interfaces: [] };
  for (const intf of interfaces) {
    const alternates = (intf.alternates || [intf]).map((alt, i) => ({
      alternateSetting: alt.alternateSetting ?? i,
      interfaceClass: alt.classCode ?? alt.interfaceClass ?? 0xff,
      interfaceSubclass: alt.subclassCode ?? alt.interfaceSubclass ?? 0,
      interfaceProtocol: alt.protocolCode ?? alt.interfaceProtocol ?? 0,
      interfaceName: alt.name ?? alt.interfaceName ?? null,
      mockStringIndex: alt.iInterface ?? 0,   // the mock's own, for its configuration descriptor: WebUSB exposes no string index
      endpoints: (alt.endpoints || []).map((ep) => ({
        endpointNumber: ep.number ?? ep.endpointNumber,
        direction: ep.direction,
        type: ep.type || "bulk",
        packetSize: ep.packetSize || 64,
      })),
    }));
    const entry = { interfaceNumber: intf.number ?? intf.interfaceNumber ?? config.interfaces.length, alternates, claimed: false, alternate: alternates[0] };
    config.interfaces.push(entry);
  }
  return config;
}

export class MockUsbDevice {
  constructor({ vendorId, productId, productName = "", manufacturerName = "", serialNumber = "", configurations = [], claimError = null, openError = null, openHang = false }, handlers = {}) {
    this.vendorId = vendorId;
    this.productId = productId;
    this.productName = productName;
    this.manufacturerName = manufacturerName;
    this.serialNumber = serialNumber;
    this.configurations = configurations;
    this.configuration = null;      // Chrome sets it once the device has an active configuration
    this.opened = false;
    this.lost = false;
    this.claimError = claimError;   // a DOMException to throw from claimInterface (driver, permissions)
    this.openError = openError;
    this.openHang = openHang;       // open() never settles, as Chrome on Windows does without a WinUSB driver
    this.handlers = handlers;
    this.navigator = null;
    this.halted = new Set();        // "in:1" / "out:2"
    this.log = [];                  // every call, for the tests
  }

  _check() {
    if (this.lost) throw domError("NotFoundError", "The device was disconnected.");
  }

  // Transfers to a device that is not open fail, as WebUSB's do.
  _checkOpen() {
    this._check();
    if (!this.opened) throw domError("InvalidStateError", "The device must be opened first.");
  }

  async open() {
    this._check();
    if (this.openError) throw this.openError;
    if (this.openHang) { this.log.push(["open", "hang"]); return new Promise(() => {}); }
    if (this.opened) return;
    this.opened = true;
    this.log.push(["open"]);
  }

  async close() {
    this.opened = false;
    this.log.push(["close"]);
    for (const c of this.configurations) for (const i of c.interfaces) i.claimed = false;
    if (this.handlers.onClose) this.handlers.onClose(this);
  }

  async forget() {
    if (this.navigator) this.navigator._remove(this);
  }

  async selectConfiguration(value) {
    this._check();
    if (!this.opened) throw domError("InvalidStateError", "The device must be opened first.");
    const config = this.configurations.find((c) => c.configurationValue === value);
    if (!config) throw domError("NotFoundError", "The configuration value provided is not supported by the device.");
    this.configuration = config;
    this.log.push(["selectConfiguration", value]);
  }

  _interface(number) {
    if (!this.configuration) throw domError("InvalidStateError", "The device must have a configuration selected.");
    const intf = this.configuration.interfaces.find((i) => i.interfaceNumber === number);
    if (!intf) throw domError("NotFoundError", "The interface number provided is not supported by the device in its current configuration.");
    return intf;
  }

  async claimInterface(number) {
    this._check();
    const intf = this._interface(number);
    if (this.claimError) throw typeof this.claimError === "function" ? this.claimError(number) : this.claimError;
    intf.claimed = true;
    this.log.push(["claimInterface", number]);
  }

  async releaseInterface(number) {
    this._check();
    const intf = this._interface(number);
    intf.claimed = false;
    this.log.push(["releaseInterface", number]);
  }

  async selectAlternateInterface(number, alternateSetting) {
    this._check();
    const intf = this._interface(number);
    if (!intf.claimed) throw domError("InvalidStateError", "The specified interface has not been claimed.");
    const alt = intf.alternates.find((a) => a.alternateSetting === alternateSetting);
    if (!alt) throw domError("NotFoundError", "The alternate setting provided is not supported by the device in its current configuration.");
    intf.alternate = alt;
    this.log.push(["selectAlternateInterface", number, alternateSetting]);
    if (this.handlers.onAlternate) this.handlers.onAlternate(number, alternateSetting, this);
  }

  async controlTransferIn(setup, length) {
    this._checkOpen();
    this.log.push(["controlIn", setup.request, setup.value, setup.index, length]);
    const res = this.handlers.controlIn ? await this.handlers.controlIn(setup, length, this) : { status: "stall" };
    return asInResult(res, length);
  }

  async controlTransferOut(setup, data) {
    this._checkOpen();
    const bytes = data === undefined ? new Uint8Array(0) : toBytes(data);
    this.log.push(["controlOut", setup.request, setup.value, setup.index, bytes.length]);
    const res = this.handlers.controlOut ? await this.handlers.controlOut(setup, bytes, this) : undefined;
    return asOutResult(res, bytes.length);
  }

  async transferIn(endpointNumber, length) {
    this._checkOpen();
    if (this.halted.has(`in:${endpointNumber}`)) return { status: "stall", data: new DataView(new ArrayBuffer(0)) };
    const res = this.handlers.bulkIn ? await this.handlers.bulkIn(endpointNumber, length, this) : { status: "stall" };
    this._check();
    const out = asInResult(res, length);
    if (out.status === "stall") this.halted.add(`in:${endpointNumber}`);
    return out;
  }

  async transferOut(endpointNumber, data) {
    this._checkOpen();
    const bytes = toBytes(data);
    if (this.halted.has(`out:${endpointNumber}`)) return { status: "stall", bytesWritten: 0 };
    const res = this.handlers.bulkOut ? await this.handlers.bulkOut(endpointNumber, bytes, this) : undefined;
    const out = asOutResult(res, bytes.length);
    if (out.status === "stall") this.halted.add(`out:${endpointNumber}`);
    return out;
  }

  async clearHalt(direction, endpointNumber) {
    this._check();
    this.halted.delete(`${direction}:${endpointNumber}`);
    this.log.push(["clearHalt", direction, endpointNumber]);
  }

  async reset() {
    this._check();
    this.halted.clear();
    this.log.push(["reset"]);
    if (this.handlers.onReset) this.handlers.onReset(this);
  }

  /** The device left the bus (it rebooted). */
  lose() {
    this.lost = true;
    this.opened = false;
    if (this.handlers.onLose) this.handlers.onLose(this);
    if (this.navigator) this.navigator._remove(this);
  }
}

function toBytes(data) {
  if (data instanceof Uint8Array) return data.slice();
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  return new Uint8Array(data);
}

function asInResult(res, length) {
  if (res instanceof Uint8Array) {
    const bytes = res.length > length ? res.subarray(0, length) : res;
    return { status: "ok", data: new DataView(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)) };
  }
  if (res && res.status && res.status !== "ok") return { status: res.status, data: new DataView(new ArrayBuffer(0)) };
  if (res && res.data) return asInResult(res.data instanceof Uint8Array ? res.data : new Uint8Array(res.data), length);
  return { status: "ok", data: new DataView(new ArrayBuffer(0)) };
}

function asOutResult(res, length) {
  if (res && res.status && res.status !== "ok") return { status: res.status, bytesWritten: 0 };
  return { status: "ok", bytesWritten: length };
}

/** navigator.usb with scripted answers to requestDevice(). */
export class MockUsbNavigator extends EventTarget {
  constructor() {
    super();
    this.devices = [];
    this.pickQueue = [];
    this.requests = [];
  }

  add(device) {
    device.navigator = this;
    if (!this.devices.includes(device)) this.devices.push(device);
    return device;
  }

  willPick(deviceOrFn) {
    this.pickQueue.push(deviceOrFn);
  }

  async requestDevice(options = {}) {
    this.requests.push(options.filters || []);
    if (!this.pickQueue.length) throw domError("NotFoundError", "No device selected.");
    let next = this.pickQueue.shift();
    if (typeof next === "function") next = await next(options);
    if (!next) throw domError("NotFoundError", "No device selected.");
    return this.add(next);
  }

  async getDevices() {
    return this.devices.slice();
  }

  connect(device) {
    this.add(device);
    const ev = new Event("connect");
    ev.device = device;
    this.dispatchEvent(ev);
  }

  _remove(device) {
    const i = this.devices.indexOf(device);
    if (i >= 0) this.devices.splice(i, 1);
    const ev = new Event("disconnect");
    ev.device = device;
    this.dispatchEvent(ev);
  }
}

/** A byte queue a bulk IN handler can wait on. */
export class ByteQueue {
  constructor() {
    this.items = [];
    this.waiters = [];
    this.closed = false;
    this.error = null;
  }
  push(item) {
    this.items.push(item);
    const w = this.waiters.shift();
    if (w) w();
  }
  /** Resolve with the next item, waiting until one arrives or the queue fails. */
  async take() {
    while (!this.items.length) {
      if (this.error) throw this.error;
      if (this.closed) return null;
      await new Promise((resolve) => this.waiters.push(resolve));
    }
    return this.items.shift();
  }
  fail(error) {
    this.error = error;
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }
  close() {
    this.closed = true;
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }
  get length() { return this.items.length; }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
