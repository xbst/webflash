// The Katapult flashing protocol (SPEC 11.5), ported from Katapult's
// scripts/flashtool.py and protocol.md:
//
//   Copyright (C) 2022 Eric Callahan <arksine.code@gmail.com>
//   Distributed under the terms of the GNU GPLv3 license.
//
// The CRC16-CCITT is Klipper's klippy/msgproto.py crc16_ccitt (Kevin
// O'Connor, GPLv3). The CAN admin commands (node discovery, node ids, the
// Klipper reboot request) follow Klipper's src/generic/canserial.c and
// Katapult's src/generic/canserial.c.
//
// The flasher runs over a KatapultLink: SerialKatapultLink for a Web Serial
// port (Katapult in USB or UART mode) and CanKatapultLink for a node on a
// gs_usb adapter (gsusb.js). Both offer write(bytes), readUntil(trailer,
// timeoutMs), drain(ms) and close(); mocks implement the same.

import { FlashError, fail } from "./errors.js";
import { flatten, hex8 } from "./firmware-file.js";

export const CMD_HEADER = new Uint8Array([0x01, 0x88]);
export const CMD_TRAILER = new Uint8Array([0x99, 0x03]);

export const COMMANDS = {
  CONNECT: 0x11,
  SEND_BLOCK: 0x12,
  SEND_EOF: 0x13,
  REQUEST_BLOCK: 0x14,
  COMPLETE: 0x15,
  GET_CANBUS_ID: 0x16,
};
export const PRIME_COMMAND = 0x90;   // invalid on purpose: wakes double-buffered USB

export const ACK_SUCCESS = 0xa0;
export const NACK = 0xf1;
export const ACK_ERROR = 0xf2;
export const ACK_BUSY = 0xf3;

// CAN admin ids (Klipper's canserial.c and Katapult's).
export const CANBUS_ID_ADMIN = 0x3f0;
export const CANBUS_ID_ADMIN_RESP = 0x3f1;
export const CANBUS_CMD_QUERY_UNASSIGNED = 0x00;
export const CANBUS_CMD_SET_KLIPPER_NODEID = 0x01;
export const CANBUS_CMD_REQUEST_BOOTLOADER = 0x02;   // Klipper: reboot into Katapult
export const CANBUS_CMD_SET_NODEID = 0x11;           // Katapult: SET_CANBOOT_NODEID
export const CANBUS_CMD_CLEAR_NODE_ID = 0x12;        // Katapult: CLEAR_CANBOOT_NODEID
export const CANBUS_RESP_NEED_NODEID = 0x20;
export const CANBUS_NODEID_OFFSET = 128;

export const SERIAL_BL_REQ = new TextEncoder().encode("~ \x1c Request Serial Bootloader!! ~");

/** Klipper's crc16_ccitt over a byte array (msgproto.py). */
export function crc16ccitt(buf) {
  let crc = 0xffff;
  for (let i = 0; i < buf.length; i++) {
    let data = buf[i];
    data ^= crc & 0xff;
    data ^= (data & 0x0f) << 4;
    data &= 0xff;
    crc = (((data << 8) | (crc >> 8)) ^ (data >> 4) ^ (data << 3)) & 0xffff;
  }
  return crc;
}

/** A command frame: header, command, word count, payload, CRC (LE), trailer. */
export function buildFrame(cmd, payload = new Uint8Array(0)) {
  const wordCount = (payload.length >> 2) & 0xff;
  const out = new Uint8Array(2 + 2 + payload.length + 2 + 2);
  out.set(CMD_HEADER, 0);
  out[2] = cmd;
  out[3] = wordCount;
  out.set(payload, 4);
  const crc = crc16ccitt(out.subarray(2, 4 + payload.length));
  out[4 + payload.length] = crc & 0xff;
  out[5 + payload.length] = crc >> 8;
  out.set(CMD_TRAILER, 6 + payload.length);
  return out;
}

/**
 * Parse one response frame out of the received bytes. Returns
 * {ack, command, payload} or throws a FlashError "protocol" with the
 * reason (bad trailer, CRC mismatch). ack is the response byte (0xa0,
 * 0xf1, 0xf2, 0xf3), command the echoed command word when present.
 */
export function parseFrame(data) {
  if (data.length < 8) fail("protocol", "The answer is shorter than a frame.");
  if (data[0] !== CMD_HEADER[0] || data[1] !== CMD_HEADER[1]) fail("protocol", "The answer does not start with the frame header.");
  if (data[data.length - 2] !== CMD_TRAILER[0] || data[data.length - 1] !== CMD_TRAILER[1]) {
    fail("protocol", `Invalid trailer received 0x${data[data.length - 2].toString(16)}${data[data.length - 1].toString(16)}.`);
  }
  const payloadLength = data[3] * 4;
  if (data.length !== payloadLength + 8) fail("protocol", `The frame says ${payloadLength} payload bytes but holds ${data.length - 8}.`);
  const received = data[data.length - 4] | (data[data.length - 3] << 8);
  const computed = crc16ccitt(data.subarray(2, data.length - 4));
  if (received !== computed) fail("protocol", `Frame CRC mismatch, expected ${computed}, received ${received}.`);
  const payload = data.slice(4, 4 + payloadLength);
  const command = payloadLength >= 4 ? readU32(payload, 0) : 0;
  return { ack: data[2], command, payload };
}

export function readU32(bytes, off) {
  return (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0;
}

export function u32(n) {
  return new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Six UUID bytes as the 12-character lower-case hex Klipper prints. */
export function uuidToHex(bytes) {
  return Array.from(bytes.subarray(0, 6), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function uuidFromHex(text) {
  const clean = String(text || "").trim().toLowerCase().replace(/[^0-9a-f]/g, "");
  if (clean.length !== 12) fail("protocol", `"${text}" is not a 12-digit CAN UUID.`);
  const out = new Uint8Array(6);
  for (let i = 0; i < 6; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

// ── Links ───────────────────────────────────────────────────────────

/**
 * Katapult over a SerialLink (serial.js). The bootloader's USB CDC port, or
 * a USB-UART adapter wired to a board running Katapult in UART mode.
 */
export class SerialKatapultLink {
  constructor(serial) {
    this.serial = serial;
    this.kind = "serial";
  }
  async write(bytes) { await this.serial.write(bytes); }
  readUntil(trailer, timeoutMs) { return this.serial.readUntil(trailer, timeoutMs); }
  drain(ms) { return this.serial.drain(ms); }
  describe() { return this.serial.describe(); }
  async close() { await this.serial.close(); }
}

/**
 * Katapult over CAN: the node's id is nodeId * 2 + 0x100, it answers from
 * the id above. Frames of up to 8 bytes go through a gs_usb adapter
 * (gsusb.js); its received frames for the response id are fed into a byte
 * queue here, so the protocol code reads a byte stream as over serial.
 */
export class CanKatapultLink {
  constructor(adapter, nodeId) {
    this.adapter = adapter;
    this.nodeId = nodeId;
    this.txId = nodeId * 2 + 0x100;
    this.rxId = this.txId + 1;
    this.kind = "can";
    this.chunks = [];
    this.queued = 0;
    this.waiters = [];
    this.unsubscribe = adapter.subscribe(this.rxId, (frame) => this._feed(frame.data));
  }

  _feed(bytes) {
    if (!bytes.length) return;
    this.chunks.push(bytes);
    this.queued += bytes.length;
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  _wait(deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      let timer;
      const wake = () => { clearTimeout(timer); resolve(true); };
      this.waiters.push(wake);
      timer = setTimeout(() => {
        const i = this.waiters.indexOf(wake);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve(false);
      }, remaining);
    });
  }

  _peek() {
    const out = new Uint8Array(this.queued);
    let pos = 0;
    for (const c of this.chunks) { out.set(c, pos); pos += c.length; }
    return out;
  }

  _take(n) {
    const all = this._peek();
    const out = all.slice(0, n);
    const rest = all.slice(n);
    this.chunks = rest.length ? [rest] : [];
    this.queued = rest.length;
    return out;
  }

  async write(bytes) {
    for (let off = 0; off < bytes.length; off += 8) {
      await this.adapter.send(this.txId, bytes.subarray(off, Math.min(off + 8, bytes.length)));
    }
  }

  async readUntil(trailer, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const all = this._peek();
      const at = indexOf(all, trailer);
      if (at >= 0) return this._take(at + trailer.length);
      if (this.adapter.closed) fail("disconnected", "The CAN adapter was closed.");
      const got = await this._wait(deadline);
      if (!got && indexOf(this._peek(), trailer) < 0) {
        fail("timeout", `No complete answer from the CAN node within ${timeoutMs} ms.`);
      }
    }
  }

  async drain(ms) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) await this._wait(deadline);
    return this.queued ? this._take(this.queued) : new Uint8Array(0);
  }

  describe() { return `CAN node ${this.nodeId} (id ${hex8(this.txId)}) on ${this.adapter.describe()}`; }

  async close() {
    if (this.unsubscribe) { this.unsubscribe(); this.unsubscribe = null; }
  }
}

function indexOf(haystack, needle) {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

// ── The flasher ─────────────────────────────────────────────────────

export const DEFAULT_TIMING = {
  commandTries: 5,
  commandTimeoutMs: 2000,
  blockTries: 3,
  blockTimeoutMs: 5000,
  blockRetries: 3,          // address-echo mismatches per block
  busySleepMs: 1500,
  retrySleepMs: 500,
  drainMs: 250,
  mismatchSleepMs: 100,
};

/**
 * One Katapult session over a link. callbacks: log(text), progress(phase,
 * done, total). options: timing (tests shrink it), prime (send the
 * invalid command first; the serial caller decides from the USB product
 * string: STM32 other than F2, F4, H7), log.
 */
export class KatapultFlasher {
  constructor(link, { timing = {}, prime = false, log = null } = {}) {
    this.link = link;
    this.timing = { ...DEFAULT_TIMING, ...timing };
    this.primed = false;
    this.wantPrime = prime;
    this.logFn = log;
    this.blockSize = 64;
    this.appStart = 0;
    this.mcu = "";
    this.softwareVersion = "?";
    this.protocolVersion = [0, 0, 0];
    this.blockCount = 0;
    this.lastHash = null;
  }

  log(text) {
    if (this.logFn) this.logFn(text);
  }

  /** The invalid command that makes double-buffered USB devices answer the real first command at once. */
  async prime() {
    await this.link.write(buildFrame(PRIME_COMMAND));
    this.primed = true;
  }

  async sendCommand(name, payload = new Uint8Array(0), tries = this.timing.commandTries, readTimeout = this.timing.commandTimeoutMs) {
    const cmd = COMMANDS[name];
    const frame = buildFrame(cmd, payload);
    let lastError = null;
    while (tries > 0) {
      let data = new Uint8Array(0);
      let received = false;
      try {
        await this.link.write(frame);
        let readDone = false;
        while (!readDone) {
          const chunk = await this.link.readUntil(CMD_TRAILER, readTimeout);
          data = concat(data, chunk);
          // Resynchronize on the header: drop leading garbage.
          while (data.length > 7) {
            if (data[0] !== CMD_HEADER[0] || data[1] !== CMD_HEADER[1]) {
              data = data.subarray(1);
              continue;
            }
            readDone = data.length === data[3] * 4 + 8;
            break;
          }
          if (this.primed && readDone) {
            // The answer to the priming command: throw it away and read the real one.
            data = new Uint8Array(0);
            this.primed = false;
            readDone = false;
          }
        }
        received = true;
      } catch (e) {
        if (e instanceof FlashError && e.code === "timeout") {
          this.log(`Response for command ${name} timed out, ${tries - 1} tries remaining`);
          lastError = e;
        } else if (e instanceof FlashError && (e.code === "disconnected" || e.code === "aborted")) {
          throw e;
        } else {
          this.log(`Device read error: ${e && e.message ? e.message : e}`);
          lastError = e;
        }
      }
      if (received) {
        let parsed = null;
        try {
          parsed = parseFrame(data);
        } catch (e) {
          this.log(`Command '${name}': ${e.message}`);
        }
        if (parsed) {
          if (parsed.ack === ACK_ERROR) {
            this.log(`Command '${name}': received error response`);
          } else if (parsed.ack === ACK_BUSY) {
            this.log(`Command '${name}': received busy signal`);
            await sleep(this.timing.busySleepMs);
          } else if (parsed.ack !== ACK_SUCCESS) {
            this.log(`Command '${name}': received NACK`);
          } else if (parsed.payload.length >= 4 && parsed.command !== cmd) {
            this.log(`Command '${name}': acknowledged wrong command, expected ${cmd.toString(16)}, received ${parsed.command.toString(16)}`);
          } else {
            return parsed.payload.length <= 4 ? new Uint8Array(0) : parsed.payload.slice(4);
          }
        }
      }
      tries -= 1;
      // Clear whatever is left in the read buffer before the next try.
      const leftover = await this.link.drain(this.timing.drainMs);
      if (leftover.length) this.log(`Read buffer contents: ${leftover.length} bytes`);
      await sleep(this.timing.retrySleepMs);
    }
    throw new FlashError(`Error sending command [${name}] to the device.`, {
      code: lastError && lastError.code === "timeout" ? "timeout" : "protocol", cause: lastError,
    });
  }

  /** CONNECT: protocol version, application start, block size, MCU type, software version. */
  async connect() {
    this.log("Attempting to connect to bootloader");
    if (this.wantPrime && !this.primed) await this.prime();
    const ret = await this.sendCommand("CONNECT");
    if (ret.length < 12) fail("protocol", "The CONNECT answer is too short.");
    const ver = ret.subarray(0, 4);
    this.appStart = readU32(ret, 4);
    this.blockSize = readU32(ret, 8);
    this.protocolVersion = [ver[2], ver[1], ver[0]];
    if (![64, 128, 256, 512].includes(this.blockSize)) fail("protocol", `Invalid block size: ${this.blockSize}.`);
    let info = ret.subarray(12);
    let end = info.length;
    while (end > 0 && info[end - 1] === 0) end--;
    info = info.subarray(0, end);
    const decoder = new TextDecoder();
    this.softwareVersion = "?";
    if (compareVersion(this.protocolVersion, [1, 1, 0]) >= 0) {
      const nul = info.indexOf(0);
      if (nul >= 0) {
        this.mcu = decoder.decode(info.subarray(0, nul));
        this.softwareVersion = decoder.decode(info.subarray(nul + 1));
      } else {
        this.mcu = decoder.decode(info);
        this.log("Katapult build not reporting software version!");
      }
    } else {
      this.mcu = decoder.decode(info);
    }
    this.log(`Katapult connected\nSoftware version: ${this.softwareVersion}\nProtocol version: ${this.protocolVersion.join(".")}\n` +
             `Block size: ${this.blockSize} bytes\nApplication start: ${hex8(this.appStart)}\nMCU type: ${this.mcu}`);
    return this.info();
  }

  info() {
    return {
      mcu: this.mcu, softwareVersion: this.softwareVersion, protocolVersion: this.protocolVersion.join("."),
      blockSize: this.blockSize, appStart: this.appStart,
    };
  }

  /**
   * Refuse to write firmware built for another chip. expected is the
   * build's CONFIG_MCU, the TOML's [prebuilt].mcu or the MCU found in the
   * image's dictionary.
   */
  checkMcu(expected) {
    if (!expected || !this.mcu) return;
    if (expected.toLowerCase() !== this.mcu.toLowerCase()) {
      fail("wrong-mcu", `The MCU returned by Katapult does not match the firmware.\nKatapult MCU: ${this.mcu}\nFirmware MCU: ${expected}`);
    }
  }

  async verifyCanbusUuid(uuidBytes) {
    this.log("Verifying canbus connection");
    const ret = await this.sendCommand("GET_CANBUS_ID");
    const got = uuidToHex(ret);
    const want = uuidToHex(uuidBytes);
    if (got !== want) fail("protocol", `UUID mismatch (${want} vs ${got}): the node that answered is not the one picked.`);
  }

  /**
   * Write the image from the application start in blocks, each echoed
   * back by address. The image must start at Katapult's application start
   * (a .bin built for the bootloader offset); an image that starts lower
   * (one that includes the bootloader) or higher is refused.
   */
  async sendImage(image, progress = null) {
    if (image.start !== this.appStart) {
      fail("address", `The firmware starts at ${hex8(image.start)} but Katapult's application start is ${hex8(this.appStart)}. ` +
        (image.start < this.appStart
          ? "The file includes the bootloader area (it was built with no bootloader offset); build it for the bootloader, or flash it with DFU or PICOBOOT instead."
          : "Build the firmware for this bootloader's offset."));
    }
    const data = flatten(image);
    const fileSize = data.length;
    this.log(`Flashing ${fileSize} bytes...`);
    const hash = new Sha1Accumulator();
    let address = this.appStart;
    this.blockCount = 0;
    for (let off = 0; off < fileSize; off += this.blockSize) {
      let block = data.subarray(off, Math.min(off + this.blockSize, fileSize));
      if (block.length < this.blockSize) {
        const padded = new Uint8Array(this.blockSize).fill(0xff);
        padded.set(block, 0);
        block = padded;
      }
      hash.update(block);
      const payload = concat(u32(address), block);
      let ok = false;
      let receivedAddress = 0;
      for (let attempt = 0; attempt < this.timing.blockRetries; attempt++) {
        let resp;
        try {
          resp = await this.sendCommand("SEND_BLOCK", payload, this.timing.blockTries, this.timing.blockTimeoutMs);
        } catch (e) {
          throw new FlashError(`Flash write failed, flash address ${hex8(address)}: ${e.message}`, { code: e.code || "protocol", cause: e });
        }
        receivedAddress = readU32(resp, 0);
        if (receivedAddress === address) { ok = true; break; }
        this.log(`Block write mismatch: expected ${hex8(address)}, received ${hex8(receivedAddress)}`);
        await sleep(this.timing.mismatchSleepMs);
      }
      if (!ok) fail("protocol", `Flash write failed, block address ${hex8(receivedAddress)}.`);
      address += this.blockSize;
      this.blockCount += 1;
      if (progress) progress("write", Math.min(off + this.blockSize, fileSize), fileSize);
    }
    const resp = await this.sendCommand("SEND_EOF");
    const pageCount = readU32(resp, 0);
    this.log(`Write complete: ${pageCount} pages`);
    this.lastHash = hash;
    return { pageCount, blocks: this.blockCount };
  }

  /** Read every block back and compare SHA-1 digests. */
  async verifyImage(progress = null) {
    this.log(`Verifying (block count = ${this.blockCount})...`);
    const hash = new Sha1Accumulator();
    for (let i = 0; i < this.blockCount; i++) {
      const address = i * this.blockSize + this.appStart;
      let resp = null;
      for (let attempt = 0; attempt < this.timing.blockRetries; attempt++) {
        const r = await this.sendCommand("REQUEST_BLOCK", u32(address));
        if (readU32(r, 0) === address) { resp = r; break; }
        this.log(`Block read mismatch: expected ${hex8(address)}, received ${hex8(readU32(r, 0))}`);
        await sleep(this.timing.mismatchSleepMs);
      }
      if (!resp) fail("protocol", `Block request error, block ${i}.`);
      hash.update(resp.subarray(4, 4 + this.blockSize));
      if (progress) progress("verify", i + 1, this.blockCount);
    }
    const got = await hash.hex();
    const want = await this.lastHash.hex();
    if (got !== want) fail("verify-failed", `Checksum mismatch: expected ${want}, received ${got}.`);
    this.log(`Verification complete: SHA = ${got}`);
    return got;
  }

  /** COMPLETE: the bootloader resets and starts the application. */
  async finish() {
    await this.sendCommand("COMPLETE");
  }
}

function compareVersion(a, b) {
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0);
  }
  return 0;
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** SHA-1 over appended chunks, computed once at the end with Web Crypto. */
class Sha1Accumulator {
  constructor() { this.parts = []; this.length = 0; }
  update(bytes) { this.parts.push(bytes.slice()); this.length += bytes.length; }
  async hex() {
    const all = new Uint8Array(this.length);
    let pos = 0;
    for (const p of this.parts) { all.set(p, pos); pos += p.length; }
    const digest = await crypto.subtle.digest("SHA-1", all);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  }
}

// ── CAN node discovery ──────────────────────────────────────────────

/**
 * Ask every unassigned node on the bus to name itself. Returns
 * [{uuid: Uint8Array(6), uuidHex, app: "Klipper"|"Katapult"|"Unknown"}].
 * A node that already has a node id (Klipper talking to a host) does not
 * answer; adapter.subscribe/send/unsubscribe is gsusb.js's interface.
 */
export async function queryNodes(adapter, { timeoutMs = 2000, log = null } = {}) {
  const found = [];
  const seen = new Set();
  const unsubscribe = adapter.subscribe(CANBUS_ID_ADMIN_RESP, (frame) => {
    const d = frame.data;
    if (d.length < 7 || d[0] !== CANBUS_RESP_NEED_NODEID) return;
    const uuid = d.slice(1, 7);
    const hexId = uuidToHex(uuid);
    const appByte = d.length > 7 ? d[7] : CANBUS_CMD_SET_KLIPPER_NODEID;
    const app = appByte === CANBUS_CMD_SET_KLIPPER_NODEID ? "Klipper" : appByte === CANBUS_CMD_SET_NODEID ? "Katapult" : "Unknown";
    const key = `${hexId}:${app}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (log) log(`Detected UUID: ${hexId}, Application: ${app}`);
    found.push({ uuid, uuidHex: hexId, app });
  });
  try {
    if (log) log("Checking for nodes on the bus...");
    await adapter.send(CANBUS_ID_ADMIN, new Uint8Array([CANBUS_CMD_QUERY_UNASSIGNED]));
    await sleep(timeoutMs);
  } finally {
    unsubscribe();
  }
  return found;
}

/** Katapult's admin command: every bootloader node forgets its node id. */
export async function clearNodeIds(adapter) {
  await adapter.send(CANBUS_ID_ADMIN, new Uint8Array([CANBUS_CMD_CLEAR_NODE_ID]));
}

/** Ask a Klipper node to restart into Katapult (KLIPPER_REBOOT_CMD with its UUID). */
export async function requestCanBootloader(adapter, uuidBytes) {
  const payload = new Uint8Array(7);
  payload[0] = CANBUS_CMD_REQUEST_BOOTLOADER;
  payload.set(uuidBytes.subarray(0, 6), 1);
  await adapter.send(CANBUS_ID_ADMIN, payload);
}

/**
 * Give a Katapult node a node id and return the link to talk to it.
 * nodeId defaults to 128 (the first free one, as flashtool numbers them).
 */
export async function assignNode(adapter, uuidBytes, nodeId = CANBUS_NODEID_OFFSET) {
  const payload = new Uint8Array(8);
  payload[0] = CANBUS_CMD_SET_NODEID;
  payload.set(uuidBytes.subarray(0, 6), 1);
  payload[7] = nodeId;
  await adapter.send(CANBUS_ID_ADMIN, payload);
  return new CanKatapultLink(adapter, nodeId);
}

// ── One-call flashing ───────────────────────────────────────────────

/**
 * Flash an image through a link: connect, check the MCU, (over CAN) verify
 * the UUID, write, verify, complete. COMPLETE is sent once the whole image
 * was written, even when the verification then fails, as flashtool does,
 * so the bootloader leaves. It is not sent when the connect, the MCU or
 * UUID check or the write fails, where flashtool would send it anyway:
 * Katapult's COMPLETE starts the application without checking it, so a
 * board with a partial image stays in Katapult, ready for another Flash.
 * Returns the bootloader info plus {verified, sha1}.
 */
export async function flashKatapult(link, image, { mcu = null, uuid = null, prime = false, timing = {}, verify = true } = {}, { log = null, progress = null } = {}) {
  const flasher = new KatapultFlasher(link, { timing, prime, log });
  const info = await flasher.connect();
  flasher.checkMcu(mcu || image.mcu);
  if (uuid) await flasher.verifyCanbusUuid(uuid instanceof Uint8Array ? uuid : uuidFromHex(uuid));
  let sha1 = null;
  let wrote = false;
  try {
    await flasher.sendImage(image, progress);
    wrote = true;
    if (verify) sha1 = await flasher.verifyImage(progress);
  } finally {
    if (wrote) {
      try { await flasher.finish(); } catch (e) { if (log) log(`COMPLETE failed: ${e.message}`); }
    }
  }
  return { ...info, verified: verify, sha1 };
}
