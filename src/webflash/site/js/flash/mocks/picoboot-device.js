// A scripted RP2040 / RP2350 BOOTSEL ROM: the PICOBOOT interface of
// pico-sdk's boot/picoboot.h on a mock USB device, with a flash array, the
// mass-storage interface beside it, the status codes and the stalls a real
// ROM produces. Knobs: the model, a refused claim, a sector whose erase
// fails, a byte corrupted on read-back, and whether REBOOT is refused.

import { MockUsbDevice, makeConfiguration, ByteQueue, domError } from "./mock-usb.js";

const MAGIC = 0x431fd10b;
const PC = { EXCLUSIVE_ACCESS: 0x01, REBOOT: 0x02, FLASH_ERASE: 0x03, READ: 0x84, WRITE: 0x05, EXIT_XIP: 0x06, ENTER_CMD_XIP: 0x07, EXEC: 0x08, REBOOT2: 0x0a, GET_INFO: 0x8b };
const STATUS = { OK: 0, UNKNOWN_CMD: 1, INVALID_CMD_LENGTH: 2, INVALID_TRANSFER_LENGTH: 3, INVALID_ADDRESS: 4, BAD_ALIGNMENT: 5, INTERLEAVED_WRITE: 6, REBOOTING: 7, UNKNOWN_ERROR: 8, INVALID_STATE: 9 };
const FLASH_START = 0x10000000;

export class PicobootMockDevice extends MockUsbDevice {
  constructor({ model = "rp2040", flashSize = 2 * 1024 * 1024, claimError = null, failEraseAt = null, corruptReadAt = null,
                rejectReboot = false, rebootDelayCap = 5, serialNumber = "E0C9125B0D9B" } = {}) {
    const rp2350 = model === "rp2350";
    super({
      vendorId: 0x2e8a, productId: rp2350 ? 0x000f : 0x0003, productName: rp2350 ? "RP2350 Boot" : "RP2 Boot",
      manufacturerName: "Raspberry Pi", serialNumber,
      configurations: [makeConfiguration({ value: 1, interfaces: [
        { number: 0, classCode: 0x08, subclassCode: 0x06, protocolCode: 0x50, endpoints: [{ number: 1, direction: "in" }, { number: 2, direction: "out" }] },
        { number: 1, classCode: 0xff, subclassCode: 0, protocolCode: 0, endpoints: [{ number: 3, direction: "out" }, { number: 4, direction: "in" }] },
      ] })],
      claimError,
    });
    this.model = model;
    this.flash = new Uint8Array(flashSize).fill(0xff);
    this.failEraseAt = failEraseAt;
    this.corruptReadAt = corruptReadAt;
    this.rejectReboot = rejectReboot;
    this.rebootDelayCap = rebootDelayCap;
    this.inQueue = new ByteQueue();
    this.pendingWrite = null;      // {address, size, parts, got}
    this.awaitingOutAck = false;
    this.exclusive = 0;
    this.xipExited = false;
    this.status = { token: 0, code: 0, cmdId: 0 };
    this.commands = [];            // parsed command packets, for the tests
    this.ops = [];
    this.erasedSectors = new Set();
    this.rebooted = false;
    this.handlers = {
      controlIn: (setup, length) => this._controlIn(setup, length),
      controlOut: (setup, data) => this._controlOut(setup, data),
      bulkOut: (ep, data) => this._bulkOut(ep, data),
      bulkIn: (ep, length) => this._bulkIn(ep, length),
      onLose: () => this.inQueue.fail(domError("NotFoundError", "The device was disconnected.")),
    };
  }

  _controlIn(setup, length) {
    if (setup.requestType === "vendor" && setup.request === 0x42) {
      const out = new Uint8Array(16);
      const v = new DataView(out.buffer);
      v.setUint32(0, this.status.token, true);
      v.setUint32(4, this.status.code, true);
      v.setUint8(8, this.status.cmdId);
      v.setUint8(9, 0);
      return out.subarray(0, length);
    }
    return { status: "stall" };
  }

  _controlOut(setup) {
    if (setup.requestType === "vendor" && setup.request === 0x41) {
      this.halted.clear();
      this.pendingWrite = null;
      this.awaitingOutAck = false;
      this.inQueue = new ByteQueue();
      this.ops.push(["reset"]);
      return;
    }
    return { status: "stall" };
  }

  _fail(code, cmdId, token) {
    this.status = { token, code, cmdId };
    this.halted.add("in:4");
    this.pendingWrite = null;
    this.awaitingOutAck = false;
    return { status: "stall" };
  }

  _ack() {
    this.inQueue.push(new Uint8Array(0));
  }

  async _bulkOut(ep, data) {
    if (ep !== 3) return { status: "stall" };
    if (this.awaitingOutAck) {
      // The host's acknowledgment of an IN command's data (any short packet).
      this.awaitingOutAck = false;
      this.ops.push(["out-ack", data.length]);
      return;
    }
    if (this.pendingWrite) {
      const w = this.pendingWrite;
      w.parts.push(data);
      w.got += data.length;
      if (w.got < w.size) return;
      if (w.got > w.size) return this._fail(STATUS.INVALID_TRANSFER_LENGTH, PC.WRITE, w.token);
      const all = new Uint8Array(w.got);
      let pos = 0;
      for (const p of w.parts) { all.set(p, pos); pos += p.length; }
      this.pendingWrite = null;
      const off = w.address - FLASH_START;
      this.flash.set(all, off);
      this.ops.push(["write", w.address, w.size]);
      this._ack();
      return;
    }
    if (data.length !== 32) return this._fail(STATUS.INVALID_CMD_LENGTH, 0, 0);
    const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const magic = v.getUint32(0, true);
    const token = v.getUint32(4, true);
    const cmdId = v.getUint8(8);
    const cmdSize = v.getUint8(9);
    const transferLength = v.getUint32(12, true);
    const args = data.subarray(16, 16 + cmdSize);
    if (magic !== MAGIC) return this._fail(STATUS.UNKNOWN_CMD, cmdId, token);
    this.commands.push({ token, cmdId, cmdSize, transferLength, args: args.slice() });
    this.status = { token, code: 0, cmdId };
    const av = new DataView(args.buffer, args.byteOffset, args.byteLength);
    const flashEnd = FLASH_START + this.flash.length;
    switch (cmdId) {
      case PC.EXCLUSIVE_ACCESS:
        if (cmdSize !== 1) return this._fail(STATUS.INVALID_CMD_LENGTH, cmdId, token);
        this.exclusive = args[0];
        this.ops.push(["exclusive", args[0]]);
        this._ack();
        return;
      case PC.EXIT_XIP:
        this.xipExited = true;
        this.ops.push(["exit-xip"]);
        this._ack();
        return;
      case PC.ENTER_CMD_XIP:
        this.xipExited = false;
        this.ops.push(["enter-xip"]);
        this._ack();
        return;
      case PC.FLASH_ERASE: {
        if (cmdSize !== 8) return this._fail(STATUS.INVALID_CMD_LENGTH, cmdId, token);
        const address = av.getUint32(0, true);
        const size = av.getUint32(4, true);
        if (!this.xipExited) return this._fail(STATUS.INVALID_STATE, cmdId, token);
        if (address % 4096 || size % 4096) return this._fail(STATUS.BAD_ALIGNMENT, cmdId, token);
        if (address < FLASH_START || address + size > flashEnd) return this._fail(STATUS.INVALID_ADDRESS, cmdId, token);
        if (this.failEraseAt !== null && this.failEraseAt >= address && this.failEraseAt < address + size) return this._fail(STATUS.UNKNOWN_ERROR, cmdId, token);
        this.flash.fill(0xff, address - FLASH_START, address - FLASH_START + size);
        for (let s = address; s < address + size; s += 4096) this.erasedSectors.add(s);
        this.ops.push(["erase", address, size]);
        this._ack();
        return;
      }
      case PC.WRITE: {
        if (cmdSize !== 8) return this._fail(STATUS.INVALID_CMD_LENGTH, cmdId, token);
        const address = av.getUint32(0, true);
        const size = av.getUint32(4, true);
        if (transferLength !== size) return this._fail(STATUS.INVALID_TRANSFER_LENGTH, cmdId, token);
        if (!this.xipExited) return this._fail(STATUS.INVALID_STATE, cmdId, token);
        if (address % 256) return this._fail(STATUS.BAD_ALIGNMENT, cmdId, token);
        if (address < FLASH_START || address + size > flashEnd) return this._fail(STATUS.INVALID_ADDRESS, cmdId, token);
        this.pendingWrite = { address, size, parts: [], got: 0, token };
        return;
      }
      case PC.READ: {
        if (cmdSize !== 8) return this._fail(STATUS.INVALID_CMD_LENGTH, cmdId, token);
        const address = av.getUint32(0, true);
        const size = av.getUint32(4, true);
        if (transferLength !== size) return this._fail(STATUS.INVALID_TRANSFER_LENGTH, cmdId, token);
        if (address < FLASH_START || address + size > flashEnd) return this._fail(STATUS.INVALID_ADDRESS, cmdId, token);
        const out = this.flash.slice(address - FLASH_START, address - FLASH_START + size);
        if (this.corruptReadAt !== null && this.corruptReadAt >= address && this.corruptReadAt < address + size) out[this.corruptReadAt - address] ^= 0x40;
        this.ops.push(["read", address, size]);
        this.inQueue.push(out);
        this.awaitingOutAck = true;
        return;
      }
      case PC.REBOOT: {
        if (this.model === "rp2350" || this.rejectReboot) return this._fail(STATUS.UNKNOWN_CMD, cmdId, token);
        if (cmdSize !== 12) return this._fail(STATUS.INVALID_CMD_LENGTH, cmdId, token);
        const delay = av.getUint32(8, true);
        this.ops.push(["reboot", delay]);
        this._ack();
        this.rebooted = true;
        setTimeout(() => this.lose(), Math.min(delay, this.rebootDelayCap));
        return;
      }
      case PC.REBOOT2: {
        if (this.model !== "rp2350") return this._fail(STATUS.UNKNOWN_CMD, cmdId, token);
        if (cmdSize !== 16) return this._fail(STATUS.INVALID_CMD_LENGTH, cmdId, token);
        const flags = av.getUint32(0, true);
        const delay = av.getUint32(4, true);
        this.ops.push(["reboot2", flags, delay]);
        this._ack();
        this.rebooted = true;
        setTimeout(() => this.lose(), Math.min(delay, this.rebootDelayCap));
        return;
      }
      case PC.GET_INFO: {
        if (this.model !== "rp2350") return this._fail(STATUS.UNKNOWN_CMD, cmdId, token);
        const out = new Uint8Array(transferLength);
        const ov = new DataView(out.buffer);
        ov.setUint32(0, 3, true);          // word count
        ov.setUint32(4, 0x0001, true);     // SYS_INFO_CHIP_INFO
        ov.setUint32(8, 0x10002, true);    // package / device id
        ov.setUint32(12, 0x12345678, true);
        this.inQueue.push(out);
        this.awaitingOutAck = true;
        return;
      }
      default:
        return this._fail(STATUS.UNKNOWN_CMD, cmdId, token);
    }
  }

  async _bulkIn(ep, length) {
    if (ep !== 4) return { status: "stall" };
    const item = await this.inQueue.take();
    if (item === null) return { status: "stall" };
    return item.length > length ? item.subarray(0, length) : item;
  }

  read(address, length) {
    return this.flash.slice(address - FLASH_START, address - FLASH_START + length);
  }
}
