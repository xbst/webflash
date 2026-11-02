// gs_usb (candleLight) CAN adapters over WebUSB (SPEC 11.8), the transport
// for Katapult over CAN. The device side of this protocol is Klipper's
// src/generic/usb_canbus.c (the "USB to CAN bus bridge" mode, GPLv3), which
// is the reference for the control requests and the host frame layout;
// candleLight's firmware, the Linux gs_usb driver and python-can's gs_usb
// backend were read for the bit timing values. Nothing was copied from
// ieb/candlelightjs or brandonros/node-gs_usb (ISC), which were consulted
// for WebUSB behavior.
//
// The host frame is 20 bytes: echo_id u32, can_id u32 (bit 31 extended,
// bit 30 RTR, bit 29 error frame), can_dlc u8, channel u8, flags u8,
// reserved u8, data[8]; 24 with a hardware timestamp, which WebFlash never
// enables. Frames sent by the host come back as echoes with the echo_id
// they were sent with; frames received from the bus carry 0xffffffff.
//
// WebUSB cannot cancel a bulk IN transfer, so the receive loop runs until
// close() stops the device (MODE RESET) and closes it, which fails the
// pending read; the loop treats that as the end.

import { FlashError, fail } from "./errors.js";
import { sleep, hex8 } from "./usb.js";

export const GS_USB_BREQ = {
  HOST_FORMAT: 0, BITTIMING: 1, MODE: 2, BERR: 3, BT_CONST: 4, DEVICE_CONFIG: 5, TIMESTAMP: 6, IDENTIFY: 7,
  GET_USER_ID: 8, SET_USER_ID: 9, DATA_BITTIMING: 10, BT_CONST_EXT: 11,
};
export const GS_CAN_MODE = { RESET: 0, START: 1 };
export const GS_CAN_MODE_FLAGS = {
  NORMAL: 0, LISTEN_ONLY: 1, LOOP_BACK: 2, TRIPLE_SAMPLE: 4, ONE_SHOT: 8, HW_TIMESTAMP: 16,
  PAD_PKTS_TO_MAX_PKT_SIZE: 128, FD: 256,
};
export const GS_CAN_FEATURE = {
  LISTEN_ONLY: 1, LOOP_BACK: 2, TRIPLE_SAMPLE: 4, ONE_SHOT: 8, HW_TIMESTAMP: 16, IDENTIFY: 32, USER_ID: 64,
  PAD_PKTS_TO_MAX_PKT_SIZE: 128, FD: 256, REQ_USB_QUIRK_LPC546XX: 512, BT_CONST_EXT: 1024, TERMINATION: 2048,
};
export const HOST_FORMAT_LITTLE_ENDIAN = 0x0000beef;
export const CAN_EFF_FLAG = 0x80000000;
export const CAN_RTR_FLAG = 0x40000000;
export const CAN_ERR_FLAG = 0x20000000;
export const CAN_SFF_MASK = 0x7ff;
export const CAN_EFF_MASK = 0x1fffffff;
export const HOST_FRAME_SIZE = 20;
export const HOST_FRAME_SIZE_TS = 24;
export const ECHO_NONE = 0xffffffff;
export const TX_ECHO_ID = 0;      // what python-can's gs_usb sends; echoes come back with it

// ── Bit timing ──────────────────────────────────────────────────────

/**
 * The bit timing for a bitrate from the adapter's constants ({fclk_can,
 * tseg1_min, tseg1_max, tseg2_min, tseg2_max, sjw_max, brp_min, brp_max,
 * brp_inc}): an exact bitrate with the sample point as close to 87.5% as
 * the limits allow, preferring more time quanta per bit. For the 48 MHz
 * candleLight clock this gives python-can's table (prop 1, phase1 12,
 * phase2 2, sjw 1, brp 3 for 1 Mbit). Returns {prop_seg, phase_seg1,
 * phase_seg2, sjw, brp, nbt, bitrate, samplePoint} or null.
 */
export function computeBitTiming(btConst, bitrate, { samplePoint = 0.875, tolerance = 0.002 } = {}) {
  const c = btConst;
  const inc = c.brp_inc || 1;
  let best = null;
  for (let brp = c.brp_min || 1; brp <= (c.brp_max || 1024); brp += inc) {
    const nbtExact = c.fclk_can / (brp * bitrate);
    const nbt = Math.round(nbtExact);
    if (nbt < 1 + (c.tseg1_min || 1) + (c.tseg2_min || 1)) break;
    if (nbt > 1 + c.tseg1_max + c.tseg2_max) continue;
    const got = c.fclk_can / (brp * nbt);
    const error = Math.abs(got - bitrate) / bitrate;
    if (error > tolerance) continue;
    let tseg1 = Math.round(nbt * samplePoint) - 1;
    tseg1 = Math.min(Math.max(tseg1, c.tseg1_min || 1), c.tseg1_max);
    let tseg2 = nbt - 1 - tseg1;
    if (tseg2 < (c.tseg2_min || 1)) { tseg2 = c.tseg2_min || 1; tseg1 = nbt - 1 - tseg2; }
    if (tseg2 > c.tseg2_max) { tseg2 = c.tseg2_max; tseg1 = nbt - 1 - tseg2; }
    if (tseg1 < (c.tseg1_min || 1) || tseg1 > c.tseg1_max || tseg2 < (c.tseg2_min || 1) || tseg2 > c.tseg2_max) continue;
    const sp = (1 + tseg1) / nbt;
    const candidate = {
      prop_seg: 1, phase_seg1: tseg1 - 1, phase_seg2: tseg2, sjw: Math.max(1, Math.min(c.sjw_max || 1, tseg2, 1)), brp, nbt,
      bitrate: got, samplePoint: sp, error,
    };
    if (candidate.phase_seg1 < 1) continue;
    const score = [Math.abs(sp - samplePoint), -nbt, error];
    if (!best || compare(score, best.score) < 0) best = { ...candidate, score };
  }
  if (!best) return null;
  delete best.score;
  return best;
}

function compare(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

// ── Frames ──────────────────────────────────────────────────────────

export function encodeHostFrame(canId, data, { echoId = TX_ECHO_ID, extended = false, channel = 0 } = {}) {
  if (data.length > 8) throw new Error("a classic CAN frame carries at most 8 bytes");
  const out = new Uint8Array(HOST_FRAME_SIZE);
  const v = new DataView(out.buffer);
  let id = canId >>> 0;
  if (extended || id > CAN_SFF_MASK) id = (id & CAN_EFF_MASK) | CAN_EFF_FLAG;
  v.setUint32(0, echoId >>> 0, true);
  v.setUint32(4, id >>> 0, true);
  out[8] = data.length;
  out[9] = channel;
  out[10] = 0;
  out[11] = 0;
  out.set(data, 12);
  return out;
}

/** {echoId, canId, extended, rtr, error, dlc, channel, flags, data} from 20 or more bytes, or null when short. */
export function decodeHostFrame(bytes) {
  if (bytes.length < HOST_FRAME_SIZE) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const raw = v.getUint32(4, true);
  const dlc = Math.min(bytes[8], 8);
  return {
    echoId: v.getUint32(0, true),
    canId: raw & CAN_EFF_MASK,
    extended: !!(raw & CAN_EFF_FLAG),
    rtr: !!(raw & CAN_RTR_FLAG),
    error: !!(raw & CAN_ERR_FLAG),
    dlc,
    channel: bytes[9],
    flags: bytes[10],
    data: bytes.slice(12, 12 + dlc),
  };
}

// ── The adapter ─────────────────────────────────────────────────────

export class GsUsbAdapter {
  constructor(usb, { log = null } = {}) {
    this.usb = usb;
    this.logFn = log;
    this.interfaceNumber = null;
    this.inEndpoint = null;
    this.outEndpoint = null;
    this.packetSize = 64;
    this.btConst = null;
    this.deviceConfig = null;
    this.timing = null;
    this.bitrate = null;
    this.started = false;
    this.closed = false;
    this.closing = false;
    this.listeners = new Map();   // canId -> Set of fn; the key -1 gets every frame
    this.loop = null;
    this.loopError = null;
    this.received = 0;
    this.sent = 0;
  }

  log(text) { if (this.logFn) this.logFn(text); }

  describe() { return this.usb.describe(); }

  /** Open the adapter and start the bus at the bitrate. */
  async open({ bitrate = 1000000, listenOnly = false } = {}) {
    await this.usb.open();
    await this.usb.selectConfiguration();
    const found = this.usb.findInterface({
      classCode: 0xff,
      test: (alt) => (alt.endpoints || []).some((e) => e.direction === "in" && e.type === "bulk") &&
        (alt.endpoints || []).some((e) => e.direction === "out" && e.type === "bulk"),
    }) || this.usb.findInterface({ number: 0 });
    if (!found) fail("not-bootloader", "The device has no vendor interface with bulk endpoints: it is not a gs_usb CAN adapter.");
    await this.usb.claim({ number: found.interfaceNumber });
    this.interfaceNumber = found.interfaceNumber;
    const inEp = found.alternate.endpoints.find((e) => e.direction === "in");
    const outEp = found.alternate.endpoints.find((e) => e.direction === "out");
    this.inEndpoint = inEp.endpointNumber;
    this.outEndpoint = outEp.endpointNumber;
    this.packetSize = Math.max(inEp.packetSize || 64, HOST_FRAME_SIZE_TS);

    // Little-endian frames, always (the firmware ignores the value anyway).
    await this.controlOut(GS_USB_BREQ.HOST_FORMAT, 1, u32le(HOST_FORMAT_LITTLE_ENDIAN));
    try {
      const cfg = await this.controlIn(GS_USB_BREQ.DEVICE_CONFIG, 1, 12);
      this.deviceConfig = { icount: cfg.getUint8(3), swVersion: cfg.getUint32(4, true), hwVersion: cfg.getUint32(8, true) };
    } catch (e) {
      this.deviceConfig = null;
    }
    const bt = await this.controlIn(GS_USB_BREQ.BT_CONST, 0, 40);
    this.btConst = {
      feature: bt.getUint32(0, true), fclk_can: bt.getUint32(4, true), tseg1_min: bt.getUint32(8, true), tseg1_max: bt.getUint32(12, true),
      tseg2_min: bt.getUint32(16, true), tseg2_max: bt.getUint32(20, true), sjw_max: bt.getUint32(24, true),
      brp_min: bt.getUint32(28, true), brp_max: bt.getUint32(32, true), brp_inc: bt.getUint32(36, true),
    };
    this.timing = computeBitTiming(this.btConst, bitrate);
    if (!this.timing) {
      fail("protocol", `The adapter (CAN clock ${this.btConst.fclk_can / 1e6} MHz) cannot run at ${bitrate} bit/s with its timing limits.`);
    }
    this.bitrate = bitrate;
    const timing = new Uint8Array(20);
    const tv = new DataView(timing.buffer);
    tv.setUint32(0, this.timing.prop_seg, true);
    tv.setUint32(4, this.timing.phase_seg1, true);
    tv.setUint32(8, this.timing.phase_seg2, true);
    tv.setUint32(12, this.timing.sjw, true);
    tv.setUint32(16, this.timing.brp, true);
    // Stop first: a device left running by another program keeps its old state.
    await this.setMode(GS_CAN_MODE.RESET, 0);
    await this.controlOut(GS_USB_BREQ.BITTIMING, 0, timing);
    const flags = listenOnly ? GS_CAN_MODE_FLAGS.LISTEN_ONLY : GS_CAN_MODE_FLAGS.NORMAL;
    await this.setMode(GS_CAN_MODE.START, flags);
    this.started = true;
    this.log(`CAN adapter ${this.usb.describe()}: clock ${this.btConst.fclk_can / 1e6} MHz, ${bitrate} bit/s ` +
             `(brp ${this.timing.brp}, ${this.timing.nbt} tq, sample point ${(this.timing.samplePoint * 100).toFixed(1)}%)`);
    this.loop = this._receiveLoop();
    return this.info();
  }

  info() {
    return { device: this.usb.describe(), serial: this.usb.serialNumber, btConst: this.btConst, timing: this.timing, bitrate: this.bitrate,
             deviceConfig: this.deviceConfig, isKlipperBridge: /klipper/i.test(this.usb.manufacturerName) };
  }

  controlOut(request, channel, data) {
    return this.usb.controlOut({ requestType: "vendor", recipient: "interface", request, value: channel, index: this.interfaceNumber }, data);
  }

  controlIn(request, channel, length) {
    return this.usb.controlIn({ requestType: "vendor", recipient: "interface", request, value: channel, index: this.interfaceNumber }, length);
  }

  async setMode(mode, flags) {
    const data = new Uint8Array(8);
    const v = new DataView(data.buffer);
    v.setUint32(0, mode, true);
    v.setUint32(4, flags, true);
    await this.controlOut(GS_USB_BREQ.MODE, 0, data);
  }

  /** Send one classic CAN frame (up to 8 bytes). */
  async send(canId, data) {
    if (this.closed) fail("disconnected", "The CAN adapter is closed.");
    const frame = encodeHostFrame(canId, data instanceof Uint8Array ? data : new Uint8Array(data));
    await this.usb.transferOut(this.outEndpoint, frame, { timeout: 2000 });
    this.sent++;
  }

  /** Call fn({canId, data, extended, ...}) for every frame with this id; -1 for all. Returns the unsubscribe function. */
  subscribe(canId, fn) {
    if (!this.listeners.has(canId)) this.listeners.set(canId, new Set());
    this.listeners.get(canId).add(fn);
    return () => {
      const set = this.listeners.get(canId);
      if (set) { set.delete(fn); if (!set.size) this.listeners.delete(canId); }
    };
  }

  /** Resolve with the first frame for canId that passes test (default: any) within timeoutMs, else null. */
  waitFor(canId, timeoutMs, test = null) {
    return new Promise((resolve) => {
      let timer = null;
      const unsubscribe = this.subscribe(canId, (frame) => {
        if (test && !test(frame)) return;
        clearTimeout(timer);
        unsubscribe();
        resolve(frame);
      });
      timer = setTimeout(() => { unsubscribe(); resolve(null); }, timeoutMs);
    });
  }

  _dispatch(frame) {
    this.received++;
    for (const key of [frame.canId, -1]) {
      const set = this.listeners.get(key);
      if (!set) continue;
      for (const fn of [...set]) {
        try { fn(frame); } catch (e) { this.log(`A CAN listener failed: ${e.message}`); }
      }
    }
  }

  async _receiveLoop() {
    while (!this.closing) {
      let bytes;
      try {
        bytes = await this.usb.transferIn(this.inEndpoint, this.packetSize, { timeout: Infinity });
      } catch (e) {
        if (this.closing) break;
        this.loopError = e;
        this.log(`CAN receive stopped: ${e.message}`);
        break;
      }
      // One frame per transfer from candleLight and Klipper's bridge; take
      // several when a device packs them.
      for (let off = 0; off + HOST_FRAME_SIZE <= bytes.length; off += HOST_FRAME_SIZE) {
        const frame = decodeHostFrame(bytes.subarray(off));
        if (!frame) break;
        if (frame.echoId !== ECHO_NONE) continue;    // our own frame coming back
        if (frame.error) continue;
        this._dispatch(frame);
        // Frames are not packed by the devices WebFlash supports; a 64-byte
        // padded packet (PAD_PKTS_TO_MAX_PKT_SIZE) holds one frame.
        break;
      }
    }
    this.closed = true;
  }

  /** Stop the bus and close the device; the receive loop ends when the pending read fails. */
  async close() {
    if (this.closing) return;
    this.closing = true;
    if (this.started) {
      try { await this.setMode(GS_CAN_MODE.RESET, 0); } catch (e) { /* gone */ }
      this.started = false;
    }
    try { await this.usb.close(); } catch (e) { /* gone */ }
    this.closed = true;
    const loop = this.loop;
    if (loop) {
      // The pending transferIn rejects on close in Chrome; if a stack keeps
      // it pending, do not wait forever.
      await Promise.race([loop, sleep(1000)]);
    }
  }
}

function u32le(n) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n >>> 0, true);
  return out;
}

export { hex8 };
