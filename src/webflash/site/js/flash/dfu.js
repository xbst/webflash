// DFU 1.1 with ST's DfuSe extensions over WebUSB (SPEC 11.6): the STM32
// ROM bootloader (0483:df11). The sequences follow dfu-util's dfuse.c and
// dfuse_mem.c:
//
//   (C) 2010-2012 Tormod Volden <debian.tormod@gmail.com>
//   GNU General Public License version 2 or later
//
// with devanlai/webdfu (ISC) consulted for the WebUSB mechanics (the
// functional descriptor read, the alternate's interface name as the memory
// map). The requests and states are the USB DFU 1.1 specification's; the
// DfuSe commands are ST's AN3156 (SET_ADDRESS_POINTER 0x21, ERASE 0x41,
// READ_UNPROTECT 0x92).
//
// The device-side quirks this handles: the ST ROM answers every DNLOAD
// with dfuDNBUSY and a poll timeout before it reports the result, the data
// address is the pointer set by 0x21 plus (wBlockNum - 2) * wTransferSize,
// and the "leave" is a zero-length DNLOAD at block 2 after pointing at the
// image start, which makes the device run the firmware (and vanish from
// USB, so errors after it are expected).

import { FlashError, fail } from "./errors.js";
import { sleep, hex8 } from "./usb.js";
import { flatten, equalBytes, firstDifference, formatSize } from "./firmware-file.js";

export const DFU_REQUEST = { DETACH: 0, DNLOAD: 1, UPLOAD: 2, GETSTATUS: 3, CLRSTATUS: 4, GETSTATE: 5, ABORT: 6 };

export const DFU_STATE = {
  appIDLE: 0, appDETACH: 1, dfuIDLE: 2, dfuDNLOAD_SYNC: 3, dfuDNBUSY: 4, dfuDNLOAD_IDLE: 5,
  dfuMANIFEST_SYNC: 6, dfuMANIFEST: 7, dfuMANIFEST_WAIT_RESET: 8, dfuUPLOAD_IDLE: 9, dfuERROR: 10,
};

export const DFU_STATUS = {
  OK: 0, errTARGET: 1, errFILE: 2, errWRITE: 3, errERASE: 4, errCHECK_ERASED: 5, errPROG: 6, errVERIFY: 7,
  errADDRESS: 8, errNOTDONE: 9, errFIRMWARE: 10, errVENDOR: 11, errUSBR: 12, errPOR: 13, errUNKNOWN: 14, errSTALLEDPKT: 15,
};

export const DFUSE_CMD = { GET_COMMANDS: 0x00, SET_ADDRESS_POINTER: 0x21, ERASE: 0x41, READ_UNPROTECT: 0x92 };

export const DFU_CLASS = 0xfe;
export const DFU_SUBCLASS = 0x01;
export const DFU_PROTOCOL_DFU_MODE = 0x02;
export const DT_DFU_FUNCTIONAL = 0x21;
export const DEFAULT_TRANSFER_SIZE = 2048;    // when the functional descriptor cannot be read; the F4 ROMs say 2048, the G0B1 ROM 1024
export const DFU_TIMEOUT_MS = 5000;

const STATE_NAMES = Object.fromEntries(Object.entries(DFU_STATE).map(([k, v]) => [v, k]));
const STATUS_NAMES = Object.fromEntries(Object.entries(DFU_STATUS).map(([k, v]) => [v, k]));

export function stateName(s) { return STATE_NAMES[s] || `state ${s}`; }
export function statusName(s) { return STATUS_NAMES[s] || `status ${s}`; }

// ── Descriptors ─────────────────────────────────────────────────────

/**
 * The DfuSe memory map in an alternate setting's name, as dfu-util's
 * parse_memory_layout reads it (ST UM0424 section 4.3.2):
 *   "@Internal Flash  /0x08000000/128*0002Kg,384*0002Kg"
 * Returns {name, segments: [{start, end, pageSize, readable, erasable, writable}]}
 * with end exclusive, or null when the text is not a map.
 */
export function parseMemoryMap(text) {
  if (typeof text !== "string" || !text.startsWith("@")) return null;
  const slash = text.indexOf("/");
  if (slash < 0) return null;
  const name = text.slice(1, slash).trim();
  const segments = [];
  let rest = text.slice(slash);
  const group = /^\/\s*0x([0-9a-fA-F]{1,8})\s*\/\s*/;
  const item = /^(\d+)\s*\*\s*(\d+)\s*([BKMa-g ])?\s*([a-g])?\s*(,)?\s*/;
  for (;;) {
    const g = group.exec(rest);
    if (!g) break;
    let address = parseInt(g[1], 16);
    rest = rest.slice(g[0].length);
    for (;;) {
      const m = item.exec(rest);
      if (!m) break;
      rest = rest.slice(m[0].length);
      const sectors = parseInt(m[1], 10);
      let size = parseInt(m[2], 10);
      let multiplier = m[3];
      let type = m[4];
      // "01*040 e": a space multiplier means bytes; "01*01Ke": K then type;
      // "128*02Kg": K then g. A type letter in the multiplier slot with no
      // type after it is the type (dfu-util's fallback).
      if (multiplier === "K") size *= 1024;
      else if (multiplier === "M") size *= 1024 * 1024;
      else if (multiplier && /[a-g]/.test(multiplier) && !type) { type = multiplier; }
      if (!type) continue;
      const bits = type.charCodeAt(0) - "a".charCodeAt(0) + 1;
      segments.push({
        start: address, end: address + sectors * size, pageSize: size,
        readable: !!(bits & 1), erasable: !!(bits & 2), writable: !!(bits & 4),
      });
      address += sectors * size;
      if (!m[5]) break;
    }
  }
  return { name, segments };
}

/** The DFU functional descriptor out of a raw configuration descriptor. */
export function parseFunctionalDescriptor(bytes) {
  let off = 0;
  while (off + 2 <= bytes.length) {
    const len = bytes[off];
    const type = bytes[off + 1];
    if (!len) break;
    if (type === DT_DFU_FUNCTIONAL && len >= 7) {
      return {
        attributes: bytes[off + 2],
        detachTimeout: bytes[off + 3] | (bytes[off + 4] << 8),
        transferSize: bytes[off + 5] | (bytes[off + 6] << 8),
        bcdDFU: len >= 9 ? bytes[off + 7] | (bytes[off + 8] << 8) : 0x0100,
      };
    }
    off += len;
  }
  return null;
}

// ── The device ──────────────────────────────────────────────────────

export class DfuDevice {
  /**
   * @param {import("./usb.js").UsbDevice} usb an opened or closed UsbDevice
   * @param {{altSetting?: number|null, log?: Function}} options altSetting picks
   *        the alternate when no name says "Internal Flash"
   */
  constructor(usb, { altSetting = null, log = null } = {}) {
    this.usb = usb;
    this.altSetting = altSetting;
    this.logFn = log;
    this.transferSize = DEFAULT_TRANSFER_SIZE;
    this.memoryMap = null;
    this.alternateName = "";
    this.functional = null;
    this.interfaceNumber = null;
  }

  log(text) { if (this.logFn) this.logFn(text); }

  /** Open, pick the DFU interface and the internal flash alternate, read the transfer size and the memory map. */
  async open() {
    await this.usb.open();
    await this.usb.selectConfiguration();
    const found = this.usb.findInterface({ classCode: DFU_CLASS, subclassCode: DFU_SUBCLASS });
    if (!found) {
      fail("not-bootloader", "The device has no DFU interface: it is not in its ROM bootloader (hold BOOT0 and tap RESET), or it is a different device.");
    }
    const alternates = found.interface.alternates || [];
    if (!alternates.length || alternates.every((a) => a.interfaceProtocol === 0x01)) {
      fail("not-bootloader", "The device is in run-time DFU mode (its application is running), not in the bootloader. Put it in its bootloader first.");
    }
    await this.usb.claim({ number: found.interfaceNumber });
    this.interfaceNumber = found.interfaceNumber;

    // Each alternate's name is its DfuSe memory map. Chrome gives the name
    // as interfaceName on Linux and macOS and leaves it null on Windows, so
    // whatever is missing is read from the device's own descriptors, the
    // way dfu-util and webdfu read it.
    const names = new Map(alternates.map((a) => [a.alternateSetting, typeof a.interfaceName === "string" && a.interfaceName.trim() ? a.interfaceName : null]));
    let raw = null;
    let indexes = null;
    if ([...names.values()].some((n) => n === null)) {
      try {
        const read = await this.usb.readInterfaceNames(found.interfaceNumber);
        raw = read.raw;
        indexes = read.indexes;
        for (const [setting, text] of read.names) if (names.get(setting) === null && text) names.set(setting, text);
        for (const f of read.failures) this.log(`Could not read ${f}`);
      } catch (e) {
        this.log(`Could not read the interface names from the device (${e.message}).`);
      }
    }
    // The string index goes into the log because the STM32G0B1 ROM answered
    // the internal flash's name for all three of its alternates (hardware.md);
    // the index tells whether the ROM shares one string or names the
    // alternate currently selected.
    const describeAlt = (a) => `alternate ${a.alternateSetting} "${names.get(a.alternateSetting) || ""}"${indexes && indexes.has(a.alternateSetting) ? ` (string ${indexes.get(a.alternateSetting)})` : ""}`;
    this.log(`DFU interface ${found.interfaceNumber}: ${alternates.map(describeAlt).join(", ")}`);

    let alt = alternates.find((a) => /internal\s*flash/i.test(names.get(a.alternateSetting) || "")) || null;
    if (!alt && this.altSetting !== null) alt = alternates.find((a) => a.alternateSetting === this.altSetting) || null;
    if (!alt) alt = alternates[0];
    if (alternates.length > 1 || (found.interface.alternate && found.interface.alternate.alternateSetting !== alt.alternateSetting)) {
      await this.usb.selectAlternate(alt.alternateSetting, found.interfaceNumber);
    }
    this.alternateName = names.get(alt.alternateSetting) || "";
    this.memoryMap = parseMemoryMap(this.alternateName);
    try {
      if (!raw) raw = await this.usb.readConfigurationDescriptor();
      this.functional = parseFunctionalDescriptor(raw);
    } catch (e) {
      this.log(`Could not read the configuration descriptor (${e.message}); assuming a ${DEFAULT_TRANSFER_SIZE}-byte transfer size.`);
    }
    this.transferSize = (this.functional && this.functional.transferSize) || DEFAULT_TRANSFER_SIZE;
    this.log(`Using alternate ${alt.alternateSetting} "${this.alternateName}", transfer size ${this.transferSize}`);
    if (!this.memoryMap || !this.memoryMap.segments.length) {
      if (!this.alternateName) {
        fail("not-bootloader", "The name of the DFU interface, which carries an STM32 ROM bootloader's memory map, could not be read from the device. Unplug the board, put it back in its bootloader and try again; if it is not an STM32, WebFlash cannot flash it over DFU.");
      }
      fail("not-bootloader", `The DFU interface does not describe its memory ("${this.alternateName}"), so it is not an STM32 ROM bootloader WebFlash knows how to write.`);
    }
    return this.info();
  }

  info() {
    return { transferSize: this.transferSize, memoryMap: this.memoryMap, alternateName: this.alternateName, functional: this.functional,
             device: this.usb.describe(), serial: this.usb.serialNumber };
  }

  // Requests
  _setup(request, value = 0) {
    return { requestType: "class", recipient: "interface", request, value, index: this.interfaceNumber };
  }

  async getStatus() {
    const data = await this.usb.controlIn(this._setup(DFU_REQUEST.GETSTATUS), 6, { timeout: DFU_TIMEOUT_MS });
    if (data.byteLength < 6) fail("protocol", "GETSTATUS returned fewer than 6 bytes.");
    return {
      status: data.getUint8(0),
      pollTimeout: data.getUint8(1) | (data.getUint8(2) << 8) | (data.getUint8(3) << 16),
      state: data.getUint8(4),
    };
  }

  async getState() {
    const data = await this.usb.controlIn(this._setup(DFU_REQUEST.GETSTATE), 1, { timeout: DFU_TIMEOUT_MS });
    return data.getUint8(0);
  }

  async clearStatus() { await this.usb.controlOut(this._setup(DFU_REQUEST.CLRSTATUS)); }
  async abort() { await this.usb.controlOut(this._setup(DFU_REQUEST.ABORT)); }

  async download(data, blockNum) {
    return this.usb.controlOut(this._setup(DFU_REQUEST.DNLOAD, blockNum), data, { timeout: DFU_TIMEOUT_MS });
  }

  async upload(length, blockNum) {
    const data = await this.usb.controlIn(this._setup(DFU_REQUEST.UPLOAD, blockNum), length, { timeout: DFU_TIMEOUT_MS });
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }

  /** Back to dfuIDLE from wherever the device is (clearing an error first). */
  async abortToIdle() {
    let state = await this.getState();
    if (state === DFU_STATE.dfuERROR) {
      await this.clearStatus();
      state = await this.getState();
    }
    if (state === DFU_STATE.dfuIDLE) return;
    await this.abort();
    state = await this.getState();
    if (state === DFU_STATE.dfuERROR) {
      await this.clearStatus();
      state = await this.getState();
    }
    if (state !== DFU_STATE.dfuIDLE) fail("protocol", `The bootloader did not return to idle (it is in ${stateName(state)}).`);
  }

  /** Poll GETSTATUS, sleeping the reported time, until the state leaves the busy states. */
  async pollUntilSettled() {
    for (;;) {
      const st = await this.getStatus();
      if (st.state === DFU_STATE.dfuDNBUSY || st.state === DFU_STATE.dfuDNLOAD_SYNC || st.state === DFU_STATE.dfuMANIFEST_SYNC) {
        await sleep(Math.max(st.pollTimeout, 1));
        continue;
      }
      return st;
    }
  }

  /**
   * A DfuSe command through DNLOAD block 0, then the status dance dfu-util
   * does: GETSTATUS (busy, wait its timeout), GETSTATUS (must be OK),
   * ABORT, GETSTATUS (must be idle).
   */
  async dfuseCommand(command, address = null, what = "command") {
    const payload = address === null ? new Uint8Array([command]) : new Uint8Array([command, address & 0xff, (address >>> 8) & 0xff, (address >>> 16) & 0xff, (address >>> 24) & 0xff]);
    await this.download(payload, 0);
    const first = await this.getStatus();
    if (first.state !== DFU_STATE.dfuDNBUSY && first.state !== DFU_STATE.dfuDNLOAD_IDLE && first.state !== DFU_STATE.dfuDNLOAD_SYNC) {
      await this._raiseStatus(first, what);
    }
    await sleep(Math.max(first.pollTimeout, 1));
    const second = await this.pollUntilSettled();
    if (second.status !== DFU_STATUS.OK) await this._raiseStatus(second, what);
    if (command === DFUSE_CMD.READ_UNPROTECT) return;
    await this.abort();
    const st = await this.getStatus();
    if (st.state !== DFU_STATE.dfuIDLE) {
      if (st.state === DFU_STATE.dfuERROR) await this._raiseStatus(st, what);
      fail("protocol", `The bootloader did not go idle after the ${what} (it is in ${stateName(st.state)}).`);
    }
    await sleep(Math.max(st.pollTimeout, 0));
  }

  async _raiseStatus(st, what) {
    const status = statusName(st.status);
    let code = "protocol";
    let hint = "";
    if (st.status === DFU_STATUS.errVENDOR) { code = "read-protected"; hint = " The chip's read-out protection (RDP) is on: the ROM refuses reads, and flashing needs it removed (the READ_UNPROTECT command erases the whole chip; STM32CubeProgrammer can do it)."; }
    else if (st.status === DFU_STATUS.errTARGET || st.status === DFU_STATUS.errADDRESS) { code = "address"; hint = " The address is outside what the bootloader can write."; }
    else if (st.status === DFU_STATUS.errWRITE || st.status === DFU_STATUS.errPROG) { hint = " The flash write failed; the page may be write-protected (WRP) or the chip's flash worn."; }
    else if (st.status === DFU_STATUS.errERASE || st.status === DFU_STATUS.errCHECK_ERASED) { hint = " The erase failed; the page may be write-protected."; }
    try { await this.clearStatus(); } catch (e) { /* leave it */ }
    throw new FlashError(`The bootloader reported ${status} during the ${what} (state ${stateName(st.state)}).${hint}`, { code, details: st });
  }

  async setAddress(address) { await this.dfuseCommand(DFUSE_CMD.SET_ADDRESS_POINTER, address, "address set"); }
  async erasePage(address) { await this.dfuseCommand(DFUSE_CMD.ERASE, address, `erase of the page at ${hex8(address)}`); }
  async massErase() { await this.dfuseCommand(DFUSE_CMD.ERASE, null, "mass erase"); }

  /** One data block at the address pointer: DNLOAD block 2 and the status poll. */
  async downloadChunk(data, blockNum = 2) {
    await this.download(data, blockNum);
    const st = await this.pollUntilSettled();
    if (st.status !== DFU_STATUS.OK) await this._raiseStatus(st, "write");
    if (st.state !== DFU_STATE.dfuDNLOAD_IDLE && st.state !== DFU_STATE.dfuMANIFEST && st.state !== DFU_STATE.dfuIDLE) {
      fail("protocol", `Unexpected state ${stateName(st.state)} after a write.`);
    }
    return st;
  }

  // Memory map helpers
  segmentAt(address) {
    return this.memoryMap.segments.find((s) => s.start <= address && address < s.end) || null;
  }

  /** The distinct page start addresses covering [start, end). Throws when a byte is not writable. */
  pagesFor(start, end) {
    const pages = [];
    let address = start;
    while (address < end) {
      const seg = this.segmentAt(address);
      if (!seg || !seg.writable) {
        fail("address", `The firmware wants to write ${hex8(address)}, which is outside the bootloader's writable flash (${this.memoryMap.segments.filter((s) => s.writable).map((s) => `${hex8(s.start)} to ${hex8(s.end - 1)}`).join(", ")}).`);
      }
      const page = seg.start + Math.floor((address - seg.start) / seg.pageSize) * seg.pageSize;
      if (seg.erasable) pages.push({ address: page, size: seg.pageSize });
      address = page + seg.pageSize;
    }
    return pages;
  }

  /** Read length bytes from address, in transfer-size blocks. */
  async readBack(address, length, progress = null) {
    await this.abortToIdle();
    await this.setAddress(address);
    await this.abortToIdle();
    const out = new Uint8Array(length);
    let block = 2;
    let done = 0;
    while (done < length) {
      const want = Math.min(this.transferSize, length - done);
      let got;
      try {
        got = await this.upload(want, block++);
      } catch (e) {
        if (e instanceof FlashError && e.code === "protocol") {
          const st = await this.getStatus().catch(() => null);
          if (st && st.status === DFU_STATUS.errVENDOR) await this._raiseStatus(st, "read-back");
        }
        throw e;
      }
      if (!got.length) fail("protocol", `The bootloader returned no data at ${hex8(address + done)}.`);
      out.set(got.subarray(0, Math.min(got.length, length - done)), done);
      done += got.length;
      if (progress) progress("verify", done, length);
    }
    await this.abortToIdle();
    return out;
  }

  /** Point at the image start and leave: a zero-length DNLOAD, then GETSTATUS; the device resets. */
  async leave(address) {
    await this.abortToIdle();
    await this.setAddress(address);
    try {
      await this.download(new Uint8Array(0), 2);
      const st = await this.getStatus();
      this.log(`Leaving the bootloader: state ${stateName(st.state)}, status ${statusName(st.status)}`);
    } catch (e) {
      // The device reset before answering: that is the point.
      this.log(`Leaving the bootloader: the device went away (${e.message})`);
    }
  }

  async close() {
    await this.usb.close();
  }
}

// ── One-call flashing ───────────────────────────────────────────────

/**
 * Flash an image over DFU: open, check it fits, erase the pages it
 * touches, write it, read it back, leave. callbacks: log(text),
 * progress(phase, done, total). Returns {verified, transferSize, device,
 * serial}.
 */
export async function flashDfu(usb, image, { verify = true, leave = true, altSetting = null } = {}, { log = null, progress = null } = {}) {
  const dfu = new DfuDevice(usb, { altSetting, log });
  await dfu.open();
  if (image.isEmpty) fail("address", "The firmware image is empty.");
  // Every byte must land in writable flash before anything is erased.
  const plan = image.segments.map((seg) => ({ seg, pages: dfu.pagesFor(seg.address, seg.address + seg.data.length) }));
  await dfu.abortToIdle();

  // Erase, each page once.
  const erased = new Set();
  const allPages = [];
  for (const { pages } of plan) for (const p of pages) if (!erased.has(p.address)) { erased.add(p.address); allPages.push(p); }
  if (log) log(`Erasing ${allPages.length} pages (${formatSize(allPages.reduce((n, p) => n + p.size, 0))})`);
  let n = 0;
  for (const p of allPages) {
    await dfu.erasePage(p.address);
    n++;
    if (progress) progress("erase", n, allPages.length);
  }

  // Write, transferSize at a time, each chunk at an explicit address.
  const total = image.size;
  let written = 0;
  if (log) log(`Writing ${formatSize(total)} in ${dfu.transferSize}-byte transfers`);
  for (const { seg } of plan) {
    for (let off = 0; off < seg.data.length; off += dfu.transferSize) {
      let chunk = seg.data.subarray(off, Math.min(off + dfu.transferSize, seg.data.length));
      // The ST ROM programs double words on the G0 and H7: pad the tail with erased bytes.
      if (chunk.length % 8) {
        const padded = new Uint8Array(chunk.length + (8 - (chunk.length % 8))).fill(0xff);
        padded.set(chunk, 0);
        chunk = padded;
      }
      await dfu.setAddress(seg.address + off);
      await dfu.downloadChunk(chunk, 2);
      written += Math.min(dfu.transferSize, seg.data.length - off);
      if (progress) progress("write", written, total);
    }
  }

  // Verify by reading back.
  if (verify) {
    if (log) log("Reading back to verify");
    let checked = 0;
    for (const { seg } of plan) {
      const back = await dfu.readBack(seg.address, seg.data.length, (phase, done) => {
        if (progress) progress("verify", checked + done, total);
      });
      checked += seg.data.length;
      if (!equalBytes(back, seg.data)) {
        const at = firstDifference(back, seg.data);
        fail("verify-failed", `The flash contents differ from the firmware at ${hex8(seg.address + at)} (wrote 0x${seg.data[at].toString(16).padStart(2, "0")}, read 0x${back[at].toString(16).padStart(2, "0")}).`);
      }
    }
    if (log) log("Verification passed");
  }

  if (leave) {
    if (log) log(`Starting the firmware at ${hex8(image.start)}`);
    await dfu.leave(image.start);
  }
  const info = dfu.info();
  try { await dfu.close(); } catch (e) { /* gone */ }
  return { verified: verify, transferSize: info.transferSize, device: info.device, serial: info.serial, memoryMap: info.memoryMap };
}
