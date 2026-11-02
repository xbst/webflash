// A scripted Web Serial port and navigator.serial, for the Node tests and
// for the site's ?mock= mode. The port has the SerialPort surface the
// SerialLink wrapper uses: open, close, readable, writable, setSignals,
// getInfo, forget. Behind it sits a device object:
//
//   device.onOpen(options, port)      called by open(); may throw
//   device.onWrite(bytes, port)       host -> device; answer with port.emit()
//   device.onSignals(signals, port)   DTR/RTS changes
//   device.onClose(port)
//
// port.emit(bytes) is device -> host; port.lose() makes the port vanish the
// way a re-enumerating board does (the reader errors, the navigator fires
// "disconnect").

export class MockSerialPort {
  constructor(device, { info = {}, name = "mock port" } = {}) {
    this.device = device || {};
    this.info = info;
    this.name = name;
    this.opened = false;
    this.lost = false;
    this.readable = null;
    this.writable = null;
    this._controller = null;
    this.navigator = null;      // set by MockSerialNavigator.add()
    this.openOptions = null;
    this.signals = [];
    this.written = [];          // every chunk the host wrote
  }

  getInfo() { return { ...this.info }; }

  async open(options) {
    if (this.lost) throw domError("NetworkError", "Failed to open serial port.");
    if (this.opened) throw domError("InvalidStateError", "The port is already open.");
    if (this.device.onOpen) await this.device.onOpen(options, this);
    this.opened = true;
    this.openOptions = options;
    this.readable = new ReadableStream({
      start: (controller) => { this._controller = controller; },
      cancel: () => { this._controller = null; },
    });
    this.writable = new WritableStream({
      write: async (chunk) => {
        if (this.lost) throw domError("NetworkError", "The device has been lost.");
        const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        this.written.push(bytes.slice());
        if (this.device.onWrite) await this.device.onWrite(bytes, this);
      },
    });
  }

  /** Device -> host bytes. */
  emit(bytes) {
    if (!this._controller) return;
    try {
      this._controller.enqueue(bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes));
    } catch (e) {
      // The reader is gone.
    }
  }

  async setSignals(signals) {
    if (!this.opened) throw domError("InvalidStateError", "The port is not open.");
    this.signals.push({ ...signals });
    if (this.device.onSignals) await this.device.onSignals(signals, this);
  }

  async close() {
    if (!this.opened) return;
    this.opened = false;
    if (this._controller) {
      try { this._controller.close(); } catch (e) { /* already closed */ }
      this._controller = null;
    }
    this.readable = null;
    this.writable = null;
    if (this.device.onClose) await this.device.onClose(this);
  }

  /** The device went away (it rebooted into another USB personality). */
  lose() {
    this.lost = true;
    if (this._controller) {
      try { this._controller.error(domError("NetworkError", "The device has been lost.")); } catch (e) { /* closed */ }
      this._controller = null;
    }
    if (this.navigator) this.navigator._remove(this);
  }

  async forget() {
    if (this.navigator) this.navigator._remove(this);
  }
}

/** navigator.serial with scripted answers to requestPort(). */
export class MockSerialNavigator extends EventTarget {
  constructor() {
    super();
    this.ports = [];
    this.pickQueue = [];     // ports (or functions returning ports) handed out by requestPort, in order
    this.requests = [];      // the filters each requestPort() was called with
  }

  /** Make a port known (paired) without a picker. */
  add(port) {
    port.navigator = this;
    if (!this.ports.includes(port)) this.ports.push(port);
    return port;
  }

  /** The next requestPort() returns this port (null: the user cancels). */
  willPick(portOrFn) {
    this.pickQueue.push(portOrFn);
  }

  async requestPort(options = {}) {
    this.requests.push(options.filters || []);
    if (!this.pickQueue.length) throw domError("NotFoundError", "No port selected by the user.");
    let next = this.pickQueue.shift();
    if (typeof next === "function") next = await next(options);
    if (!next) throw domError("NotFoundError", "No port selected by the user.");
    return this.add(next);
  }

  async getPorts() {
    return this.ports.slice();
  }

  /** A new device appeared: fires "connect" like the real navigator.serial. */
  connect(port) {
    this.add(port);
    const ev = new Event("connect");
    ev.target_ = port;
    ev.port = port;
    this.dispatchEvent(ev);
  }

  _remove(port) {
    const i = this.ports.indexOf(port);
    if (i >= 0) this.ports.splice(i, 1);
    const ev = new Event("disconnect");
    ev.port = port;
    this.dispatchEvent(ev);
  }
}

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

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
