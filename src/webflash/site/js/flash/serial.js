// Web Serial behind a small interface, so Katapult over USB and over a
// USB-UART adapter, and the 1200-baud bootloader request, run the same
// against a real SerialPort and against the scripted ports in mocks/.
//
// A SerialLink wraps anything shaped like Web Serial's SerialPort: open(),
// close(), readable, writable, setSignals(), getInfo(). Once open it runs a
// reader loop that feeds a byte queue, so protocol code reads with
// read(n, timeoutMs) and readUntil(sequence, timeoutMs) and never touches
// streams; write(bytes) goes through one writer. close() stops the loop,
// cancels the reader and releases both locks, which is what Web Serial
// needs before the port can be opened again.

import { FlashError, fail, isCancel } from "./errors.js";

/** Whether this browser has Web Serial at all (Android Chrome does not). */
export function hasWebSerial(nav = typeof navigator !== "undefined" ? navigator : null) {
  return !!(nav && nav.serial && typeof nav.serial.requestPort === "function");
}

/**
 * Show the browser's port picker. filters are [{usbVendorId, usbProductId?}];
 * an empty list shows every port (a USB-UART adapter has no useful id).
 */
export async function requestSerialPort(filters = [], { nav = typeof navigator !== "undefined" ? navigator : null } = {}) {
  if (!hasWebSerial(nav)) {
    fail("no-api", "This browser has no Web Serial, so it cannot open the board's serial port.");
  }
  let raw;
  try {
    raw = await nav.serial.requestPort(filters.length ? { filters } : {});
  } catch (e) {
    if (isCancel(e)) fail("cancelled", "No port was picked.", { cause: e });
    throw e;
  }
  return new SerialLink(raw);
}

/** Ports this page already has permission for, matching the filters. */
export async function pairedSerialPorts(filters = [], { nav = typeof navigator !== "undefined" ? navigator : null } = {}) {
  if (!hasWebSerial(nav)) return [];
  const ports = await nav.serial.getPorts();
  return ports.filter((p) => matchesSerialFilter(p, filters)).map((p) => new SerialLink(p));
}

export function matchesSerialFilter(port, filters) {
  if (!filters || !filters.length) return true;
  const info = (typeof port.getInfo === "function" && port.getInfo()) || {};
  return filters.some((f) =>
    (f.usbVendorId === undefined || f.usbVendorId === info.usbVendorId) &&
    (f.usbProductId === undefined || f.usbProductId === info.usbProductId));
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SerialLink {
  constructor(raw) {
    this.raw = raw;
    this.opened = false;
    this.reader = null;
    this.writer = null;
    this.queue = [];        // Uint8Array chunks not yet consumed
    this.queued = 0;        // bytes in queue
    this.waiters = [];      // resolvers of pending reads
    this.readError = null;  // why the reader loop stopped, if it failed
    this.lastSerialError = null;  // the latest break, framing, parity or overrun error the loop read past
    this.loop = null;
  }

  /** {usbVendorId, usbProductId} when the port is a USB device. */
  getInfo() {
    try {
      return (typeof this.raw.getInfo === "function" && this.raw.getInfo()) || {};
    } catch (e) {
      return {};
    }
  }

  get idString() {
    const info = this.getInfo();
    if (info.usbVendorId === undefined) return "";
    return `${hex4(info.usbVendorId)}:${hex4(info.usbProductId || 0)}`;
  }

  describe() {
    const id = this.idString;
    return id ? `serial port (USB ${id})` : "serial port";
  }

  async open({ baudRate = 250000, bufferSize = 64 * 1024, dataBits = 8, stopBits = 1, parity = "none", flowControl = "none" } = {}) {
    if (this.opened) return;
    try {
      await this.raw.open({ baudRate, bufferSize, dataBits, stopBits, parity, flowControl });
    } catch (e) {
      throw mapOpenError(e);
    }
    this.opened = true;
    this.readError = null;
    if (this.raw.readable) {
      this.reader = this.raw.readable.getReader();
      this.loop = this._readLoop();
    }
    if (this.raw.writable) this.writer = this.raw.writable.getWriter();
  }

  // Web Serial reports a break, a framing or parity error and a buffer
  // overrun by erroring the current readable while the port stays open;
  // port.readable then hands out a new stream. Those errors are ordinary on
  // a USB-UART adapter around a board reset, so the loop takes the new
  // stream and goes on. Anything else (the device went away) ends it. A
  // burst of them (a wrong baud rate) counts as a failure too.
  async _readLoop() {
    const recent = [];  // times of the latest non-fatal errors
    for (;;) {
      const reader = this.reader;
      if (!reader) break;
      let again = false;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value && value.byteLength) {
            const bytes = value instanceof Uint8Array ? value : new Uint8Array(value.buffer || value);
            this.queue.push(bytes);
            this.queued += bytes.byteLength;
            this._wake();
          }
        }
      } catch (e) {
        if (isNonFatalSerialError(e)) {
          const now = Date.now();
          recent.push(now);
          while (recent.length && now - recent[0] > NON_FATAL_WINDOW_MS) recent.shift();
          this.lastSerialError = e;
          again = recent.length <= NON_FATAL_LIMIT;
        }
        if (!again) this.readError = e;
      } finally {
        try { reader.releaseLock(); } catch (e) { /* already released */ }
        if (this.reader === reader) this.reader = null;
      }
      // close() during the swap starts no new reader.
      if (!again || !this.opened || !this.raw.readable) {
        if (again && this.opened) this.readError = this.lastSerialError;
        break;
      }
      try {
        this.reader = this.raw.readable.getReader();
      } catch (e) {
        this.readError = e;
        break;
      }
    }
    this._wake();
  }

  _wake() {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  /** Wait until the queue changes or the timeout passes. */
  _waitForData(deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      let timer = null;
      const done = (value) => {
        clearTimeout(timer);
        const i = this.waiters.indexOf(wake);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve(value);
      };
      const wake = () => done(true);
      this.waiters.push(wake);
      timer = setTimeout(() => done(false), remaining);
    });
  }

  _takeBytes(n) {
    const out = new Uint8Array(n);
    let pos = 0;
    while (pos < n) {
      const head = this.queue[0];
      const take = Math.min(head.byteLength, n - pos);
      out.set(head.subarray(0, take), pos);
      pos += take;
      if (take === head.byteLength) this.queue.shift();
      else this.queue[0] = head.subarray(take);
    }
    this.queued -= n;
    return out;
  }

  /** Bytes received so far, without consuming them. */
  peek() {
    const out = new Uint8Array(this.queued);
    let pos = 0;
    for (const chunk of this.queue) { out.set(chunk, pos); pos += chunk.byteLength; }
    return out;
  }

  /**
   * Read exactly n bytes, waiting up to timeoutMs for them. Throws a
   * FlashError "timeout" (what arrived stays queued) or "disconnected" when
   * the port's reader failed.
   */
  async read(n, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    while (this.queued < n) {
      if (this.readError) throw mapReadError(this.readError);
      if (!this.opened || (!this.reader && !this.queued)) {
        fail("disconnected", "The serial port is closed.");
      }
      const got = await this._waitForData(deadline);
      if (!got && this.queued < n) {
        fail("timeout", `No answer from the board within ${timeoutMs} ms.`, { details: { wanted: n, have: this.queued } });
      }
    }
    return this._takeBytes(n);
  }

  /**
   * Read up to and including the first occurrence of sequence, waiting up
   * to timeoutMs. Katapult frames end in the trailer 0x99 0x03.
   */
  async readUntil(sequence, timeoutMs = 2000) {
    const seq = sequence instanceof Uint8Array ? sequence : new Uint8Array(sequence);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const all = this.peek();
      const at = indexOfSequence(all, seq);
      if (at >= 0) return this._takeBytes(at + seq.length);
      if (this.readError) throw mapReadError(this.readError);
      if (!this.opened) fail("disconnected", "The serial port is closed.");
      const got = await this._waitForData(deadline);
      if (!got && indexOfSequence(this.peek(), seq) < 0) {
        fail("timeout", `No complete answer from the board within ${timeoutMs} ms.`, { details: { have: this.queued } });
      }
    }
  }

  /** Whatever arrives within timeoutMs (possibly nothing): the buffer drain between retries. */
  async drain(timeoutMs = 250) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await this._waitForData(deadline);
    }
    const n = this.queued;
    return n ? this._takeBytes(n) : new Uint8Array(0);
  }

  /** Throw away everything received so far. */
  discard() {
    this.queue = [];
    this.queued = 0;
  }

  async write(bytes) {
    if (!this.writer) fail("disconnected", "The serial port is not open for writing.");
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    try {
      await this.writer.write(data);
    } catch (e) {
      throw mapReadError(e);
    }
  }

  async setSignals(signals) {
    try {
      await this.raw.setSignals(signals);
    } catch (e) {
      throw new FlashError(`The port's control lines could not be set: ${e && e.message ? e.message : e}`, { code: "protocol", cause: e });
    }
  }

  async close() {
    if (!this.opened) return;
    this.opened = false;
    const reader = this.reader;
    if (reader) {
      try { await reader.cancel(); } catch (e) { /* the loop ends either way */ }
    }
    if (this.loop) {
      try { await this.loop; } catch (e) { /* reported through readError */ }
      this.loop = null;
    }
    if (this.writer) {
      try { await this.writer.close(); } catch (e) { /* a gone port cannot be flushed */ }
      try { this.writer.releaseLock(); } catch (e) { /* already released */ }
      this.writer = null;
    }
    try {
      await this.raw.close();
    } catch (e) {
      // A port whose device re-enumerated is already closed.
    }
    this._wake();
  }

  async forget() {
    if (typeof this.raw.forget === "function") {
      try { await this.raw.forget(); } catch (e) { /* not important */ }
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

export function indexOfSequence(haystack, needle) {
  if (!needle.length) return 0;
  const first = needle[0];
  const last = haystack.length - needle.length;
  outer: for (let i = 0; i <= last; i++) {
    if (haystack[i] !== first) continue;
    for (let j = 1; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function hex4(n) {
  return (n >>> 0).toString(16).padStart(4, "0");
}

function mapOpenError(e) {
  if (e instanceof FlashError) return e;
  const msg = String(e && e.message ? e.message : e);
  if (e && e.name === "InvalidStateError") {
    return new FlashError(`The port is already open (${msg}).`, { code: "busy", cause: e });
  }
  if (e && e.name === "SecurityError") {
    return new FlashError(`The browser may not open the port: ${msg}`, { code: "permission", cause: e });
  }
  // Chrome: "NetworkError: Failed to open serial port." when another program
  // holds it (Klipper, a monitor) or, on Linux, the user lacks dialout.
  return new FlashError(`The serial port could not be opened (${msg}).`, { code: "busy", cause: e });
}

// More non-fatal errors than this within the window end the reader loop.
const NON_FATAL_LIMIT = 20;
const NON_FATAL_WINDOW_MS = 2000;

function isNonFatalSerialError(e) {
  return !!e && (e.name === "BufferOverrunError" || e.name === "BreakError" || e.name === "FramingError" || e.name === "ParityError");
}

function mapReadError(e) {
  if (e instanceof FlashError) return e;
  const msg = String(e && e.message ? e.message : e);
  if (e && (e.name === "NetworkError" || e.name === "NotFoundError" || /disconnected|lost|device has been lost/i.test(msg))) {
    return new FlashError(`The serial port went away: ${msg}`, { code: "disconnected", cause: e });
  }
  if (isNonFatalSerialError(e)) {
    return new FlashError(`A serial error happened: ${e.name}.`, { code: "protocol", cause: e });
  }
  return new FlashError(`The serial port failed: ${msg}`, { code: "protocol", cause: e });
}
