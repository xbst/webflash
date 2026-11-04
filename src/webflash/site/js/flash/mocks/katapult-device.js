// A scripted Katapult bootloader: the protocol of protocol.md over a byte
// stream, with the knobs the tests need (block size, MCU string, protocol
// and software version, the double-buffered USB quirk, NACKs, busy
// answers, wrong echoes, verification corruption, silence).
//
// It is transport-free: receive(bytes) takes host bytes and emits response
// frames through the emit callback. mock-serial.js wraps it as a Katapult
// USB serial port; gsusb-adapter.js as a CAN node.

import {
  CMD_HEADER, CMD_TRAILER, COMMANDS, ACK_SUCCESS, NACK, ACK_ERROR, ACK_BUSY, crc16ccitt,
} from "../katapult.js";

export class KatapultDevice {
  constructor({
    blockSize = 64, pageSize = 2048, mcu = "stm32g0b1xx", softwareVersion = "v0.0.1-100-gmock",
    protocolVersion = [1, 1, 0], appStart = 0x08002000, flashSize = 0x20000, flashStart = 0x08000000,
    uuid = [0x11, 0x22, 0x33, 0x44, 0x55, 0x66],
    doubleBuffered = false,     // the first response waits for the second (STM32 usbfs)
    nackFirst = 0,              // NACK this many commands first
    busyOnce = false,           // answer BUSY to the first CONNECT
    silentFirst = 0,            // ignore this many commands (timeouts)
    wrongEchoOnce = false,      // one SEND_BLOCK answers with the wrong address
    errorOnce = false,          // answer ERROR to the first command
    corruptReadAt = null,       // flip one byte at this flash offset in REQUEST_BLOCK answers
    garbageBefore = false,      // prepend junk bytes to responses (resync test)
    splitResponses = false,     // emit responses in two pieces (stream reassembly test)
    complete = null,            // callback when COMPLETE arrives (the device reboots)
  } = {}) {
    this.blockSize = blockSize;
    this.pageSize = pageSize;
    this.mcu = mcu;
    this.softwareVersion = softwareVersion;
    this.protocolVersion = protocolVersion;
    this.appStart = appStart;
    this.flashStart = flashStart;
    this.flash = new Uint8Array(flashSize).fill(0xff);
    this.uuid = new Uint8Array(uuid);
    this.doubleBuffered = doubleBuffered;
    this.nackFirst = nackFirst;
    this.busyOnce = busyOnce;
    this.silentFirst = silentFirst;
    this.wrongEchoOnce = wrongEchoOnce;
    this.errorOnce = errorOnce;
    this.corruptReadAt = corruptReadAt;
    this.garbageBefore = garbageBefore;
    this.splitResponses = splitResponses;
    this.onComplete = complete;
    this.buffer = new Uint8Array(0);
    this.held = null;           // the response held back by the double-buffer quirk
    this.responsesSent = 0;
    this.commands = [];         // every command id received, for the tests
    this.pagesWritten = new Set();
    this.bytesWritten = 0;
    this.completed = false;
    this.emit = null;
  }

  /** Host -> device bytes; responses go to emit(bytes). */
  receive(bytes, emit) {
    this.emit = emit;
    const joined = new Uint8Array(this.buffer.length + bytes.length);
    joined.set(this.buffer, 0);
    joined.set(bytes, this.buffer.length);
    this.buffer = joined;
    for (;;) {
      const frame = this._nextFrame();
      if (!frame) break;
      this._handle(frame);
    }
  }

  _nextFrame() {
    const buf = this.buffer;
    // Find the header.
    let start = -1;
    for (let i = 0; i + 1 < buf.length; i++) {
      if (buf[i] === CMD_HEADER[0] && buf[i + 1] === CMD_HEADER[1]) { start = i; break; }
    }
    if (start < 0) {
      this.buffer = buf.length > 1 ? buf.subarray(buf.length - 1) : buf;
      return null;
    }
    if (buf.length < start + 8) return null;
    const payloadLength = buf[start + 3] * 4;
    const total = payloadLength + 8;
    if (buf.length < start + total) return null;
    const frame = buf.slice(start, start + total);
    this.buffer = buf.slice(start + total);
    return frame;
  }

  _handle(frame) {
    const cmd = frame[2];
    const payloadLength = frame[3] * 4;
    const crcOk = (frame[frame.length - 4] | (frame[frame.length - 3] << 8)) === crc16ccitt(frame.subarray(2, frame.length - 4));
    const trailerOk = frame[frame.length - 2] === CMD_TRAILER[0] && frame[frame.length - 1] === CMD_TRAILER[1];
    this.commands.push(cmd);
    if (this.silentFirst > 0) { this.silentFirst--; return; }
    if (!crcOk || !trailerOk) { this._respond(NACK, new Uint8Array(0)); return; }
    if (this.nackFirst > 0) { this.nackFirst--; this._respond(NACK, new Uint8Array(0)); return; }
    if (this.errorOnce) { this.errorOnce = false; this._respond(ACK_ERROR, new Uint8Array(0)); return; }
    const payload = frame.subarray(4, 4 + payloadLength);
    switch (cmd) {
      case COMMANDS.CONNECT: {
        if (this.busyOnce) { this.busyOnce = false; this._respond(ACK_BUSY, new Uint8Array(0)); return; }
        const enc = new TextEncoder();
        const mcu = enc.encode(this.mcu);
        const ver = enc.encode(this.softwareVersion);
        const proto11 = cmpVersion(this.protocolVersion, [1, 1, 0]) >= 0;
        let info = proto11 ? concat(mcu, new Uint8Array([0]), ver) : mcu;
        // Pad to a word boundary with NULs, as the firmware does.
        const pad = (4 - ((16 + info.length) % 4)) % 4;
        info = concat(info, new Uint8Array(pad));
        const out = new Uint8Array(16 + info.length);
        out.set(le32(cmd), 0);
        out[4] = this.protocolVersion[2]; out[5] = this.protocolVersion[1]; out[6] = this.protocolVersion[0]; out[7] = 0;
        out.set(le32(this.appStart), 8);
        out.set(le32(this.blockSize), 12);
        out.set(info, 16);
        this._respond(ACK_SUCCESS, out);
        return;
      }
      case COMMANDS.SEND_BLOCK: {
        if (payload.length !== 4 + this.blockSize) { this._respond(NACK, new Uint8Array(0)); return; }
        const address = readU32(payload, 0);
        const offset = address - this.flashStart;
        if (address < this.appStart || offset + this.blockSize > this.flash.length) { this._respond(ACK_ERROR, new Uint8Array(0)); return; }
        this.flash.set(payload.subarray(4), offset);
        this.pagesWritten.add(Math.floor(offset / this.pageSize));
        this.bytesWritten = Math.max(this.bytesWritten, offset + this.blockSize - (this.appStart - this.flashStart));
        let echo = address;
        if (this.wrongEchoOnce) { this.wrongEchoOnce = false; echo = address + this.blockSize; }
        this._respond(ACK_SUCCESS, concat(le32(cmd), le32(echo)));
        return;
      }
      case COMMANDS.SEND_EOF: {
        this._respond(ACK_SUCCESS, concat(le32(cmd), le32(this.pagesWritten.size)));
        return;
      }
      case COMMANDS.REQUEST_BLOCK: {
        if (payload.length !== 4) { this._respond(NACK, new Uint8Array(0)); return; }
        const address = readU32(payload, 0);
        const offset = address - this.flashStart;
        if (address < this.appStart || offset + this.blockSize > this.flash.length) { this._respond(ACK_ERROR, new Uint8Array(0)); return; }
        const data = this.flash.slice(offset, offset + this.blockSize);
        if (this.corruptReadAt !== null && this.corruptReadAt >= offset && this.corruptReadAt < offset + this.blockSize) {
          data[this.corruptReadAt - offset] ^= 0x01;
        }
        this._respond(ACK_SUCCESS, concat(le32(cmd), le32(address), data));
        return;
      }
      case COMMANDS.COMPLETE: {
        this.completed = true;
        this._respond(ACK_SUCCESS, le32(cmd));
        if (this.onComplete) this.onComplete(this);
        return;
      }
      case COMMANDS.GET_CANBUS_ID: {
        this._respond(ACK_SUCCESS, concat(le32(cmd), this.uuid, new Uint8Array(2)));
        return;
      }
      default:
        this._respond(NACK, new Uint8Array(0));
    }
  }

  _respond(ack, payload) {
    const out = new Uint8Array(8 + payload.length);
    out.set(CMD_HEADER, 0);
    out[2] = ack;
    out[3] = (payload.length >> 2) & 0xff;
    out.set(payload, 4);
    const crc = crc16ccitt(out.subarray(2, 4 + payload.length));
    out[4 + payload.length] = crc & 0xff;
    out[5 + payload.length] = crc >> 8;
    out.set(CMD_TRAILER, 6 + payload.length);
    let frame = out;
    if (this.garbageBefore) frame = concat(new Uint8Array([0x00, 0x01, 0x99]), frame);
    if (this.doubleBuffered) {
      // The first transmission sticks in the second buffer until another
      // transmission flushes it: both leave together.
      if (this.responsesSent === 0 && this.held === null) {
        this.held = frame;
        this.responsesSent++;
        return;
      }
      if (this.held !== null) {
        const held = this.held;
        this.held = null;
        this._send(held);
      }
    }
    this.responsesSent++;
    this._send(frame);
  }

  _send(frame) {
    if (!this.emit) return;
    if (this.splitResponses && frame.length > 6) {
      this.emit(frame.slice(0, 5));
      this.emit(frame.slice(5));
    } else {
      this.emit(frame);
    }
  }

  /** The application area as written, for the tests to compare. */
  applicationBytes(length) {
    const off = this.appStart - this.flashStart;
    return this.flash.slice(off, off + length);
  }
}

/** A serial device object for MockSerialPort wrapping a KatapultDevice. */
export function katapultSerialDevice(device, { baud = null } = {}) {
  return {
    device,
    onOpen(options) {
      if (baud !== null && options.baudRate !== baud) {
        throw new Error(`The mock Katapult port expected ${baud} baud, got ${options.baudRate}`);
      }
    },
    onWrite(bytes, port) {
      device.receive(bytes, (out) => port.emit(out));
    },
  };
}

function cmpVersion(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function le32(n) {
  return new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
}

function readU32(b, o) {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return out;
}
