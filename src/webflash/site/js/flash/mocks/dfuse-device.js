// A scripted STM32 ROM bootloader (DfuSe over USB DFU 1.1), with the ST
// quirks dfu.js has to handle: every DNLOAD first answers dfuDNBUSY with a
// poll timeout, data goes to the address pointer plus (block - 2) times the
// transfer size, a zero-length block 2 after pointing at the image leaves
// the bootloader and the device disappears. Writes into pages that were not
// erased first fail with errWRITE, so a client that forgets to erase is
// caught. Knobs: the memory map string, the transfer size, read-out
// protection (uploads fail with errVENDOR), a refused claim, and a flash
// byte the device corrupts on read-back.

import { MockUsbDevice, makeConfiguration, domError } from "./mock-usb.js";

const REQ = { DETACH: 0, DNLOAD: 1, UPLOAD: 2, GETSTATUS: 3, CLRSTATUS: 4, GETSTATE: 5, ABORT: 6 };
const S = { dfuIDLE: 2, dfuDNLOAD_SYNC: 3, dfuDNBUSY: 4, dfuDNLOAD_IDLE: 5, dfuMANIFEST_SYNC: 6, dfuMANIFEST: 7, dfuUPLOAD_IDLE: 9, dfuERROR: 10 };
const ST = { OK: 0, errTARGET: 1, errWRITE: 3, errERASE: 4, errADDRESS: 8, errVENDOR: 11, errSTALLEDPKT: 15 };

export const G0B1_MAP = "@Internal Flash  /0x08000000/256*02Kg";
export const F4_MAP = "@Internal Flash  /0x08000000/04*016Kg,01*064Kg,07*128Kg";
export const H7_MAP = "@Internal Flash   /0x08000000/08*128Kg";
export const OPTION_BYTES_MAP = "@Option Bytes   /0x1FFF7800/01*040 e";
export const OTP_MAP = "@OTP Memory /0x1FFF7000/01*01Ke";

export class DfuseDevice extends MockUsbDevice {
  constructor({
    memoryMap = G0B1_MAP, transferSize = 2048, flashStart = 0x08000000, flashSize = 0x80000,
    rdp = false, claimError = null, pollTimeoutMs = 2, corruptReadAt = null, serialNumber = "FFFFFFFEFFFF",
    productId = 0xdf11, protocol = 2,
  } = {}) {
    const alternates = [
      { alternateSetting: 0, classCode: 0xfe, subclassCode: 1, protocolCode: protocol, name: memoryMap, iInterface: 4 },
      { alternateSetting: 1, classCode: 0xfe, subclassCode: 1, protocolCode: protocol, name: OPTION_BYTES_MAP, iInterface: 5 },
      { alternateSetting: 2, classCode: 0xfe, subclassCode: 1, protocolCode: protocol, name: OTP_MAP, iInterface: 6 },
    ];
    super({
      vendorId: 0x0483, productId, productName: "STM32  BOOTLOADER", manufacturerName: "STMicroelectronics", serialNumber,
      configurations: [makeConfiguration({ value: 1, interfaces: [{ number: 0, alternates }] })],
      claimError,
    });
    this.memoryMapText = memoryMap;
    this.transferSize = transferSize;
    this.flashStart = flashStart;
    this.flash = new Uint8Array(flashSize).fill(0xff);
    this.pageSizeAt = (address) => pageSizeFromMap(memoryMap, address);
    this.erasedPages = new Set();        // page start addresses erased since their last write
    this.rdp = rdp;
    this.pollTimeoutMs = pollTimeoutMs;
    this.corruptReadAt = corruptReadAt;
    this.state = S.dfuIDLE;
    this.status = ST.OK;
    this.pointer = flashStart;
    this.pending = null;                 // {op, ...} applied when the busy poll ends
    this.busyPolls = 0;
    this.ops = [];                       // what the host asked, in order
    this.alternateNames = { 4: memoryMap, 5: OPTION_BYTES_MAP, 6: OTP_MAP };
    this.handlers = {
      controlIn: (setup, length) => this._controlIn(setup, length),
      controlOut: (setup, data) => this._controlOut(setup, data),
    };
  }

  // ── Standard requests ───────────────────────────────────────────

  _descriptor(setup, length) {
    const type = setup.value >> 8;
    const index = setup.value & 0xff;
    if (type === 0x02) return this._configDescriptor().subarray(0, length);
    if (type === 0x03) {
      if (index === 0) return new Uint8Array([4, 3, 0x09, 0x04]);
      const text = index === 1 ? this.manufacturerName : index === 2 ? this.productName : index === 3 ? this.serialNumber : this.alternateNames[index];
      if (text === undefined) return { status: "stall" };
      const out = new Uint8Array(2 + text.length * 2);
      out[0] = out.length; out[1] = 3;
      for (let i = 0; i < text.length; i++) { out[2 + i * 2] = text.charCodeAt(i) & 0xff; out[3 + i * 2] = text.charCodeAt(i) >> 8; }
      return out.subarray(0, length);
    }
    return { status: "stall" };
  }

  _configDescriptor() {
    const alts = this.configurations[0].interfaces[0].alternates;
    const total = 9 + alts.length * 9 + 9;
    const out = new Uint8Array(total);
    out.set([9, 2, total & 0xff, total >> 8, 1, 1, 0, 0xc0, 50], 0);
    let off = 9;
    for (const alt of alts) {
      out.set([9, 4, 0, alt.alternateSetting, 0, 0xfe, 1, alt.interfaceProtocol, alt.iInterface], off);
      off += 9;
    }
    // DFU functional descriptor: bmAttributes (download, upload, manifestation tolerant, will detach), detach timeout, transfer size, bcdDFU 1.1a
    out.set([9, 0x21, 0x0b, 0xff, 0x00, this.transferSize & 0xff, this.transferSize >> 8, 0x1a, 0x01], off);
    return out;
  }

  // ── DFU requests ────────────────────────────────────────────────

  _controlIn(setup, length) {
    if (setup.requestType === "standard" && setup.request === 0x06) return this._descriptor(setup, length);
    if (setup.requestType !== "class") return { status: "stall" };
    switch (setup.request) {
      case REQ.GETSTATUS: {
        const timeout = this.busyPolls > 0 ? this.pollTimeoutMs : 0;
        const state = this.busyPolls > 0 ? S.dfuDNBUSY : this.state;
        if (this.busyPolls > 0 && --this.busyPolls === 0) this._applyPending();
        const out = new Uint8Array([this.status, timeout & 0xff, (timeout >> 8) & 0xff, (timeout >> 16) & 0xff, state, 0]);
        if (state === S.dfuMANIFEST && !this.busyPolls && this.pending === null && this.leaving) {
          // Answered the status after the leave: the firmware starts, the device vanishes.
          setTimeout(() => this.lose(), 0);
        }
        return out;
      }
      case REQ.GETSTATE:
        return new Uint8Array([this.busyPolls > 0 ? S.dfuDNBUSY : this.state]);
      case REQ.UPLOAD: {
        const block = setup.value;
        if (block === 0) {
          this.ops.push(["get-commands"]);
          return new Uint8Array([0x00, 0x21, 0x41, 0x92]);
        }
        if (block < 2 || (this.state !== S.dfuIDLE && this.state !== S.dfuUPLOAD_IDLE)) return this._error(ST.errSTALLEDPKT);
        if (this.rdp) return this._error(ST.errVENDOR);
        const address = this.pointer + (block - 2) * this.transferSize;
        const off = address - this.flashStart;
        if (off < 0 || off >= this.flash.length) return this._error(ST.errADDRESS);
        const n = Math.min(length, this.flash.length - off);
        const data = this.flash.slice(off, off + n);
        if (this.corruptReadAt !== null && this.corruptReadAt >= address && this.corruptReadAt < address + n) data[this.corruptReadAt - address] ^= 0x10;
        this.ops.push(["upload", address, n]);
        this.state = S.dfuUPLOAD_IDLE;
        return data;
      }
      default:
        return { status: "stall" };
    }
  }

  _controlOut(setup, data) {
    if (setup.requestType !== "class") return { status: "stall" };
    switch (setup.request) {
      case REQ.CLRSTATUS:
        this.ops.push(["clrstatus"]);
        if (this.state !== S.dfuERROR) return this._error(ST.errSTALLEDPKT);
        this.state = S.dfuIDLE;
        this.status = ST.OK;
        return;
      case REQ.ABORT:
        this.ops.push(["abort"]);
        if (![S.dfuIDLE, S.dfuDNLOAD_IDLE, S.dfuUPLOAD_IDLE, S.dfuDNLOAD_SYNC, S.dfuMANIFEST_SYNC].includes(this.state)) return this._error(ST.errSTALLEDPKT);
        this.state = S.dfuIDLE;
        return;
      case REQ.DNLOAD: {
        if (this.state !== S.dfuIDLE && this.state !== S.dfuDNLOAD_IDLE) return this._error(ST.errSTALLEDPKT);
        if (this.pending) return this._error(ST.errSTALLEDPKT);    // the host did not wait for the busy poll
        const block = setup.value;
        if (block === 0) {
          const cmd = data[0];
          const address = data.length >= 5 ? (data[1] | (data[2] << 8) | (data[3] << 16) | (data[4] << 24)) >>> 0 : null;
          if (cmd === 0x21 && address !== null) this.pending = { op: "setaddr", address };
          else if (cmd === 0x41 && address !== null) this.pending = { op: "erase", address };
          else if (cmd === 0x41 && data.length === 1) this.pending = { op: "mass-erase" };
          else if (cmd === 0x92) this.pending = { op: "unprotect" };
          else return this._error(ST.errSTALLEDPKT);
          this.state = S.dfuDNLOAD_SYNC;
          this.busyPolls = 1;
          return;
        }
        if (block === 1) return this._error(ST.errSTALLEDPKT);
        const address = this.pointer + (block - 2) * this.transferSize;
        if (data.length === 0) {
          this.ops.push(["leave", this.pointer]);
          this.leaving = true;
          this.state = S.dfuMANIFEST;
          return;
        }
        if (data.length > this.transferSize) return this._error(ST.errSTALLEDPKT);
        this.pending = { op: "write", address, data: data.slice() };
        this.state = S.dfuDNLOAD_SYNC;
        this.busyPolls = 1;
        return;
      }
      case REQ.DETACH:
        return;
      default:
        return { status: "stall" };
    }
  }

  _applyPending() {
    const p = this.pending;
    this.pending = null;
    if (!p) return;
    switch (p.op) {
      case "setaddr":
        this.ops.push(["setaddr", p.address]);
        this.pointer = p.address;
        this.state = S.dfuDNLOAD_IDLE;
        return;
      case "erase": {
        const size = this.pageSizeAt(p.address);
        const off = p.address - this.flashStart;
        if (!size || off < 0 || off >= this.flash.length) { this._setError(ST.errTARGET); return; }
        const page = p.address - ((p.address - this.flashStart) % size);
        this.ops.push(["erase", page]);
        this.flash.fill(0xff, page - this.flashStart, page - this.flashStart + size);
        this.erasedPages.add(page);
        this.state = S.dfuDNLOAD_IDLE;
        return;
      }
      case "mass-erase":
        this.ops.push(["mass-erase"]);
        this.flash.fill(0xff);
        this.state = S.dfuDNLOAD_IDLE;
        return;
      case "unprotect":
        this.ops.push(["unprotect"]);
        this.rdp = false;
        this.flash.fill(0xff);
        setTimeout(() => this.lose(), 0);
        return;
      case "write": {
        const off = p.address - this.flashStart;
        if (off < 0 || off + p.data.length > this.flash.length) { this._setError(ST.errADDRESS); return; }
        this.ops.push(["write", p.address, p.data.length]);
        for (let i = 0; i < p.data.length; i++) {
          const addr = p.address + i;
          const size = this.pageSizeAt(addr);
          const page = addr - ((addr - this.flashStart) % size);
          if (!this.erasedPages.has(page)) { this._setError(ST.errWRITE); return; }
          this.flash[off + i] = p.data[i];
        }
        this.state = S.dfuDNLOAD_IDLE;
        return;
      }
      default:
        this._setError(ST.errSTALLEDPKT);
    }
  }

  _setError(status) {
    this.state = S.dfuERROR;
    this.status = status;
  }

  _error(status) {
    this._setError(status);
    return { status: "stall" };
  }

  /** The flash bytes at an address, for the tests. */
  read(address, length) {
    const off = address - this.flashStart;
    return this.flash.slice(off, off + length);
  }
}

/** The page size at an address per a DfuSe map string, or 0 outside it. */
export function pageSizeFromMap(map, address) {
  const slash = map.indexOf("/");
  let rest = map.slice(slash);
  const group = /^\/\s*0x([0-9a-fA-F]+)\s*\/\s*/;
  const item = /^(\d+)\s*\*\s*(\d+)\s*([BKM ])?\s*([a-g])\s*(,)?\s*/;
  for (;;) {
    const g = group.exec(rest);
    if (!g) return 0;
    let base = parseInt(g[1], 16);
    rest = rest.slice(g[0].length);
    for (;;) {
      const m = item.exec(rest);
      if (!m) break;
      rest = rest.slice(m[0].length);
      let size = parseInt(m[2], 10);
      if (m[3] === "K") size *= 1024;
      else if (m[3] === "M") size *= 1048576;
      const count = parseInt(m[1], 10);
      if (address >= base && address < base + count * size) return size;
      base += count * size;
      if (!m[5]) break;
    }
  }
}

export { domError };
