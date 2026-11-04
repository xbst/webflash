// PICOBOOT over WebUSB (SPEC 11.7): the RP2040 and RP2350 BOOTSEL ROM
// (2e8a:0003 and 2e8a:000f). Ported from Klipper's lib/rp2040_flash
// (main.c and picoboot_connection.c, the latter Raspberry Pi's, BSD-3-Clause;
// Klipper's additions by Lasse Dalegaard, GPLv3), with picotool.js (Arm,
// Apache-2.0) as the WebUSB reference. Constants are the pico-sdk's
// boot/picoboot.h (BSD-3-Clause).
//
// The protocol: a 32-byte command on the bulk OUT endpoint (magic, token,
// id, argument size, transfer length, arguments), then the data transfer in
// the command's direction, then a zero-length acknowledgment in the other
// direction. A failed command stalls the endpoints; the status request on
// the interface tells why, and the reset request clears it.

import { FlashError, fail } from "./errors.js";
import { sleep, hex8 } from "./usb.js";
import { pages, equalBytes, firstDifference, chipOfFamily, isForeignFamily, formatSize } from "./firmware-file.js";

export const PICOBOOT_MAGIC = 0x431fd10b;
export const PICOBOOT_IF_RESET = 0x41;
export const PICOBOOT_IF_CMD_STATUS = 0x42;

export const PC = {
  EXCLUSIVE_ACCESS: 0x01, REBOOT: 0x02, FLASH_ERASE: 0x03, READ: 0x84, WRITE: 0x05, EXIT_XIP: 0x06, ENTER_CMD_XIP: 0x07,
  EXEC: 0x08, VECTORIZE_FLASH: 0x09, REBOOT2: 0x0a, GET_INFO: 0x8b, OTP_READ: 0x8c, OTP_WRITE: 0x0d,
};

export const EXCLUSIVE = { NOT_EXCLUSIVE: 0, EXCLUSIVE: 1, EXCLUSIVE_AND_EJECT: 2 };
export const REBOOT2_FLAG_REBOOT_TYPE_NORMAL = 0x0;
export const REBOOT2_FLAG_REBOOT_TYPE_BOOTSEL = 0x2;
export const GET_INFO_SYS = 1;
export const SYS_INFO_CHIP_INFO = 0x0001;

export const STATUS_TEXT = {
  0: "ok", 1: "unknown command", 2: "invalid command length", 3: "invalid transfer length", 4: "invalid address",
  5: "bad alignment", 6: "interleaved write", 7: "rebooting", 8: "unknown error", 9: "invalid state", 10: "not permitted",
  11: "invalid argument", 12: "buffer too small", 13: "precondition not met", 14: "modified data", 15: "invalid data",
  16: "not found", 17: "unsupported modification",
};

export const FLASH_START = 0x10000000;
export const FLASH_END = { rp2040: 0x11000000, rp2350: 0x12000000 };
export const PAGE_SIZE = 256;
export const SECTOR_SIZE = 4096;
export const WRITE_CHUNK = 4096;
export const REBOOT_DELAY_MS = 500;

export class PicobootDevice {
  constructor(usb, { log = null } = {}) {
    this.usb = usb;
    this.logFn = log;
    this.token = 1;
    this.outEndpoint = null;
    this.inEndpoint = null;
    this.interfaceNumber = null;
    this.model = null;      // "rp2040" | "rp2350"
  }

  log(text) { if (this.logFn) this.logFn(text); }

  /** Open, claim the vendor interface with the two bulk endpoints, find out which chip, reset the interface. */
  async open() {
    await this.usb.open();
    await this.usb.selectConfiguration();
    const found = this.usb.findInterface({
      classCode: 0xff,
      test: (alt) => (alt.endpoints || []).filter((e) => e.type === "bulk").length === 2 &&
        alt.endpoints.some((e) => e.direction === "in") && alt.endpoints.some((e) => e.direction === "out"),
    });
    if (!found) {
      fail("not-bootloader", "The device has no PICOBOOT interface: it is not in BOOTSEL mode (hold BOOTSEL while plugging it in), or it is a different device.");
    }
    await this.usb.claim({ number: found.interfaceNumber });
    this.interfaceNumber = found.interfaceNumber;
    this.outEndpoint = found.alternate.endpoints.find((e) => e.direction === "out").endpointNumber;
    this.inEndpoint = found.alternate.endpoints.find((e) => e.direction === "in").endpointNumber;
    if (this.usb.productId === 0x0003) this.model = "rp2040";
    else if (this.usb.productId === 0x000f) this.model = "rp2350";
    await this.reset();
    if (!this.model) {
      // RP2040 ROMs do not know GET_INFO; RP2350 ROMs answer it.
      try {
        await this.getInfo(GET_INFO_SYS, [SYS_INFO_CHIP_INFO]);
        this.model = "rp2350";
      } catch (e) {
        this.model = "rp2040";
        await this.reset();
      }
    }
    this.log(`PICOBOOT interface ${this.interfaceNumber} (${this.model.toUpperCase()}), endpoints out ${this.outEndpoint} in ${this.inEndpoint}`);
    return this.info();
  }

  info() {
    return { model: this.model, device: this.usb.describe(), serial: this.usb.serialNumber };
  }

  /** PICOBOOT_IF_RESET: un-stall the endpoints and forget any command in progress. */
  async reset() {
    try { await this.usb.clearHalt("in", this.inEndpoint); } catch (e) { /* not halted */ }
    try { await this.usb.clearHalt("out", this.outEndpoint); } catch (e) { /* not halted */ }
    await this.usb.controlOut({ requestType: "vendor", recipient: "interface", request: PICOBOOT_IF_RESET, value: 0, index: this.interfaceNumber });
  }

  /** PICOBOOT_IF_CMD_STATUS: {token, statusCode, cmdId, inProgress}. */
  async cmdStatus() {
    const data = await this.usb.controlIn({ requestType: "vendor", recipient: "interface", request: PICOBOOT_IF_CMD_STATUS, value: 0, index: this.interfaceNumber }, 16);
    if (data.byteLength < 16) fail("protocol", "The PICOBOOT status answer is short.");
    return { token: data.getUint32(0, true), statusCode: data.getUint32(4, true), cmdId: data.getUint8(8), inProgress: data.getUint8(9) };
  }

  /** The 32-byte command packet. */
  buildCommand(cmdId, args = new Uint8Array(0), transferLength = 0) {
    if (args.length > 16) throw new Error("PICOBOOT arguments are at most 16 bytes");
    const out = new Uint8Array(32);
    const view = new DataView(out.buffer);
    view.setUint32(0, PICOBOOT_MAGIC, true);
    view.setUint32(4, this.token++ >>> 0, true);
    view.setUint8(8, cmdId);
    view.setUint8(9, args.length);
    view.setUint16(10, 0, true);
    view.setUint32(12, transferLength >>> 0, true);
    out.set(args, 16);
    return out;
  }

  /**
   * Send a command, move its data, take the acknowledgment. A stall is
   * turned into a FlashError naming the ROM's status code, after which the
   * interface is reset so the next command can run.
   */
  async command(cmdId, args = new Uint8Array(0), { transferLength = 0, data = null, timeout = 10000 } = {}) {
    const cmd = this.buildCommand(cmdId, args, data ? data.length : transferLength);
    let result = null;
    try {
      await this.usb.transferOut(this.outEndpoint, cmd, { timeout: 3000 });
      if (cmdId & 0x80) {
        if (transferLength > 0) result = await this.usb.transferIn(this.inEndpoint, transferLength, { timeout });
        await this.usb.transferOut(this.outEndpoint, new Uint8Array(1), { timeout: 3000 });
      } else {
        if (data && data.length) await this.usb.transferOut(this.outEndpoint, data, { timeout });
        await this.usb.transferIn(this.inEndpoint, 1, { timeout: transferLength || (data && data.length) ? 3000 : timeout });
      }
    } catch (e) {
      if (e instanceof FlashError && e.code === "stall") {
        let status = null;
        try { status = await this.cmdStatus(); } catch (e2) { /* unknown */ }
        try { await this.reset(); } catch (e2) { /* the next command will tell */ }
        const code = status ? status.statusCode : 8;
        const text = STATUS_TEXT[code] || `status ${code}`;
        const addr = args.length >= 4 ? ` at ${hex8(new DataView(args.buffer, args.byteOffset).getUint32(0, true))}` : "";
        throw new FlashError(`The BOOTSEL ROM refused command 0x${cmdId.toString(16)}${addr}: ${text}.`, {
          code: code === 4 || code === 5 ? "address" : code === 7 ? "disconnected" : "protocol", cause: e, details: status,
        });
      }
      throw e;
    }
    return result;
  }

  async exclusiveAccess(level = EXCLUSIVE.EXCLUSIVE) {
    await this.command(PC.EXCLUSIVE_ACCESS, new Uint8Array([level]));
  }

  async exitXip() { await this.command(PC.EXIT_XIP); }
  async enterCmdXip() { await this.command(PC.ENTER_CMD_XIP); }

  async flashErase(address, size) {
    await this.command(PC.FLASH_ERASE, rangeArgs(address, size), { timeout: 10000 });
  }

  async write(address, data) {
    await this.command(PC.WRITE, rangeArgs(address, data.length), { data });
  }

  async read(address, length) {
    const out = await this.command(PC.READ, rangeArgs(address, length), { transferLength: length });
    if (!out || out.length !== length) fail("protocol", `The ROM returned ${out ? out.length : 0} of ${length} bytes at ${hex8(address)}.`);
    return out;
  }

  /** GET_INFO (RP2350): the words the ROM returns for a type and parameters. */
  async getInfo(type, params = [], length = 64 * 4) {
    const args = new Uint8Array(16);
    const view = new DataView(args.buffer);
    view.setUint8(0, type);
    params.forEach((p, i) => view.setUint32(4 + i * 4, p >>> 0, true));
    const out = await this.command(PC.GET_INFO, args, { transferLength: length });
    const words = [];
    const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
    for (let i = 0; i + 4 <= out.length; i += 4) words.push(dv.getUint32(i, true));
    return words;
  }

  /** Reboot into the flashed firmware: REBOOT on the RP2040, REBOOT2 on the RP2350. */
  async reboot(delayMs = REBOOT_DELAY_MS) {
    const args = new Uint8Array(16);
    const view = new DataView(args.buffer);
    if (this.model === "rp2350") {
      view.setUint32(0, REBOOT2_FLAG_REBOOT_TYPE_NORMAL, true);
      view.setUint32(4, delayMs, true);
      await this.command(PC.REBOOT2, args);
    } else {
      view.setUint32(0, 0, true);
      view.setUint32(4, 0, true);
      view.setUint32(8, delayMs, true);
      await this.command(PC.REBOOT, args.subarray(0, 12));
    }
  }

  async close() { await this.usb.close(); }
}

function rangeArgs(address, size) {
  const args = new Uint8Array(8);
  const view = new DataView(args.buffer);
  view.setUint32(0, address >>> 0, true);
  view.setUint32(4, size >>> 0, true);
  return args;
}

/** The 4 KiB sectors an image touches, and its 256-byte pages grouped into write chunks of up to 4 KiB. */
export function planWrites(image, { chunk = WRITE_CHUNK, pageSize = PAGE_SIZE, sector = SECTOR_SIZE } = {}) {
  const sectors = [];
  const seen = new Set();
  const pageList = pages(image, pageSize);
  for (const p of pageList) {
    const s = Math.floor(p.address / sector) * sector;
    if (!seen.has(s)) { seen.add(s); sectors.push(s); }
  }
  const chunks = [];
  let cur = null;
  for (const p of pageList) {
    if (cur && cur.address + cur.data.length === p.address && cur.data.length + pageSize <= chunk) {
      const joined = new Uint8Array(cur.data.length + pageSize);
      joined.set(cur.data, 0);
      joined.set(p.data, cur.data.length);
      cur.data = joined;
    } else {
      cur = { address: p.address, data: p.data.slice() };
      chunks.push(cur);
    }
  }
  return { sectors, chunks, pages: pageList.length };
}

/**
 * Flash an image through PICOBOOT: open, check the chip family and the
 * address range, exclusive access, exit XIP, erase the sectors, write the
 * pages in 4 KiB chunks, read back, reboot. Returns {model, verified,
 * serial, device}.
 */
export async function flashPicoboot(usb, image, { verify = true, reboot = true } = {}, { log = null, progress = null } = {}) {
  const dev = new PicobootDevice(usb, { log });
  await dev.open();
  if (image.isEmpty) fail("address", "The firmware image is empty.");
  if (isForeignFamily(image.family)) {
    fail("wrong-family", `This .uf2 is for another chip family (${image.family}), not the RP2040 or RP2350, so it does not belong on the connected ${dev.model.toUpperCase()}.`);
  }
  const chip = chipOfFamily(image.family);
  if (chip && chip !== dev.model) {
    // fromUf2 takes the chip from an RP2040-family file's image definition,
    // since Klipper stamps the RP2040 family on its RP2350 files too.
    const why = image.stampedFamily ? ` (its image definition says so, although its blocks carry the ${image.stampedFamily.toUpperCase()} family id)` : "";
    fail("wrong-family", `This firmware is a ${image.family.toUpperCase()} image${why}, but the connected chip is an ${dev.model.toUpperCase()}.`);
  }
  const end = FLASH_END[dev.model];
  for (const seg of image.segments) {
    if (seg.address < FLASH_START || seg.address + seg.data.length > end) {
      fail("address", `The firmware wants ${hex8(seg.address)} to ${hex8(seg.address + seg.data.length - 1)}, outside the ${dev.model.toUpperCase()}'s flash (${hex8(FLASH_START)} to ${hex8(end - 1)}). A file that is not meant for the flash (RAM-only, or for another chip) cannot be written here.`);
    }
  }
  const plan = planWrites(image);
  if (log) log(`Locking the ROM for exclusive access and leaving XIP`);
  await dev.exclusiveAccess(EXCLUSIVE.EXCLUSIVE);
  await dev.exitXip();

  if (log) log(`Erasing ${plan.sectors.length} sectors (${formatSize(plan.sectors.length * SECTOR_SIZE)})`);
  let n = 0;
  for (const s of plan.sectors) {
    await dev.flashErase(s, SECTOR_SIZE);
    n++;
    if (progress) progress("erase", n, plan.sectors.length);
  }

  const total = plan.chunks.reduce((sum, c) => sum + c.data.length, 0);
  if (log) log(`Writing ${plan.pages} pages (${formatSize(total)})`);
  let written = 0;
  for (const c of plan.chunks) {
    await dev.write(c.address, c.data);
    written += c.data.length;
    if (progress) progress("write", written, total);
  }

  if (verify) {
    if (log) log("Reading back to verify");
    let checked = 0;
    for (const c of plan.chunks) {
      const back = await dev.read(c.address, c.data.length);
      checked += c.data.length;
      if (progress) progress("verify", checked, total);
      if (!equalBytes(back, c.data)) {
        const at = firstDifference(back, c.data);
        fail("verify-failed", `The flash contents differ from the firmware at ${hex8(c.address + at)} (wrote 0x${c.data[at].toString(16).padStart(2, "0")}, read 0x${back[at].toString(16).padStart(2, "0")}).`);
      }
    }
    if (log) log("Verification passed");
  }

  const info = dev.info();
  if (reboot) {
    if (log) log(`Rebooting the ${dev.model.toUpperCase()} into the firmware`);
    try {
      await dev.reboot(REBOOT_DELAY_MS);
    } catch (e) {
      if (!(e instanceof FlashError && e.code === "disconnected")) throw e;
    }
  }
  try { await dev.close(); } catch (e) { /* gone */ }
  return { model: info.model, verified: verify, serial: info.serial, device: info.device, pages: plan.pages, sectors: plan.sectors.length };
}
