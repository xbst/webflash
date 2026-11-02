// A scripted gs_usb adapter (candleLight, or a Klipper board in USB to CAN
// bridge mode) with a CAN bus behind it: one Katapult node and one Klipper
// node that restarts into Katapult when asked. The control requests, the
// BT_CONST answer and the host frame echo follow Klipper's usb_canbus.c.

import { MockUsbDevice, makeConfiguration, ByteQueue, domError } from "./mock-usb.js";
import { KatapultDevice } from "./katapult-device.js";

const BREQ = { HOST_FORMAT: 0, BITTIMING: 1, MODE: 2, BERR: 3, BT_CONST: 4, DEVICE_CONFIG: 5, TIMESTAMP: 6, IDENTIFY: 7 };
const ADMIN = 0x3f0;
const ADMIN_RESP = 0x3f1;
const CMD_QUERY_UNASSIGNED = 0x00;
const CMD_SET_KLIPPER_NODEID = 0x01;
const CMD_REQUEST_BOOTLOADER = 0x02;
const CMD_SET_KATAPULT_NODEID = 0x11;
const CMD_CLEAR_KATAPULT_NODEID = 0x12;
const RESP_NEED_NODEID = 0x20;

export const CANDLELIGHT_BT_CONST = {
  feature: 1 | 2 | 4 | 8 | 16 | 32, fclk_can: 48000000, tseg1_min: 1, tseg1_max: 16, tseg2_min: 1, tseg2_max: 8, sjw_max: 4, brp_min: 1, brp_max: 1024, brp_inc: 1,
};
export const KLIPPER_BRIDGE_BT_CONST = {
  feature: 0, fclk_can: 48000000, tseg1_min: 1, tseg1_max: 16, tseg2_min: 1, tseg2_max: 8, sjw_max: 4, brp_min: 1, brp_max: 1024, brp_inc: 1,
};

/** A Katapult bootloader on the bus. */
export class KatapultCanNode {
  constructor({ uuid = [0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff], device = null, deviceOptions = {} } = {}) {
    this.uuid = new Uint8Array(uuid);
    this.device = device || new KatapultDevice({ uuid: this.uuid, ...deviceOptions });
    this.nodeId = 0;
    this.app = "Katapult";
  }

  get assigned() { return this.nodeId !== 0; }

  onFrame(canId, data, bus) {
    if (canId === ADMIN) {
      if (!data.length) return;
      if (data[0] === CMD_QUERY_UNASSIGNED) {
        if (this.assigned) return;
        bus.send(ADMIN_RESP, new Uint8Array([RESP_NEED_NODEID, ...this.uuid, CMD_SET_KATAPULT_NODEID]));
      } else if (data[0] === CMD_SET_KATAPULT_NODEID && data.length >= 8) {
        if (sameUuid(data.subarray(1, 7), this.uuid)) this.nodeId = data[7];
      } else if (data[0] === CMD_CLEAR_KATAPULT_NODEID) {
        this.nodeId = 0;
      }
      return;
    }
    if (this.assigned && canId === this.nodeId * 2 + 0x100) {
      this.device.receive(data, (out) => {
        for (let off = 0; off < out.length; off += 8) bus.send(this.nodeId * 2 + 0x101, out.subarray(off, Math.min(off + 8, out.length)));
      });
    }
  }
}

/** A Klipper node that answers the query while unassigned and reboots into Katapult on request. */
export class KlipperCanNode {
  constructor({ uuid = [0x01, 0x02, 0x03, 0x04, 0x05, 0x06], rebootDelayMs = 20, assigned = false, deviceOptions = {} } = {}) {
    this.uuid = new Uint8Array(uuid);
    this.rebootDelayMs = rebootDelayMs;
    this.assignedByHost = assigned;
    this.deviceOptions = deviceOptions;
    this.bootloader = null;     // the KatapultCanNode it becomes
    this.app = "Klipper";
    this.rebootRequests = 0;
  }

  onFrame(canId, data, bus) {
    if (this.bootloader) { this.bootloader.onFrame(canId, data, bus); return; }
    if (canId !== ADMIN || !data.length) return;
    if (data[0] === CMD_QUERY_UNASSIGNED && !this.assignedByHost) {
      bus.send(ADMIN_RESP, new Uint8Array([RESP_NEED_NODEID, ...this.uuid, CMD_SET_KLIPPER_NODEID]));
    } else if (data[0] === CMD_REQUEST_BOOTLOADER && data.length >= 7 && sameUuid(data.subarray(1, 7), this.uuid)) {
      this.rebootRequests++;
      setTimeout(() => { this.bootloader = new KatapultCanNode({ uuid: this.uuid, deviceOptions: this.deviceOptions }); }, this.rebootDelayMs);
    }
  }
}

function sameUuid(a, b) {
  for (let i = 0; i < 6; i++) if (a[i] !== b[i]) return false;
  return true;
}

export class GsUsbMockAdapter extends MockUsbDevice {
  constructor({ nodes = [], btConst = CANDLELIGHT_BT_CONST, kind = "candlelight", claimError = null, padFrames = false, busDelayMs = 0 } = {}) {
    const klipper = kind === "klipper-bridge";
    super({
      vendorId: 0x1d50, productId: 0x606f,
      productName: klipper ? "stm32f072xb" : "candleLight USB to CAN adapter",
      manufacturerName: klipper ? "Klipper" : "bytewerk", serialNumber: klipper ? "2E0030000A504B4633373520" : "0045001A3433511234567890",
      configurations: [makeConfiguration({ value: 1, interfaces: [
        { number: 0, classCode: 0xff, subclassCode: 0xff, protocolCode: 0xff, endpoints: [{ number: 2, direction: "out" }, { number: 1, direction: "in" }] },
      ] })],
      claimError,
    });
    this.nodes = nodes;
    this.btConst = btConst;
    this.padFrames = padFrames;
    this.busDelayMs = busDelayMs;
    this.rx = new ByteQueue();
    this.hostFormat = null;
    this.timing = null;
    this.mode = null;
    this.modes = [];
    this.sentToBus = [];       // frames the host sent, decoded
    this.handlers = {
      controlIn: (setup, length) => this._controlIn(setup, length),
      controlOut: (setup, data) => this._controlOut(setup, data),
      bulkOut: (ep, data) => this._bulkOut(ep, data),
      bulkIn: (ep, length) => this._bulkIn(ep, length),
      onLose: () => this.rx.fail(domError("NotFoundError", "The device was disconnected.")),
      onClose: () => this.rx.fail(domError("NotFoundError", "The device was disconnected.")),
    };
    this.bus = {
      send: (canId, data) => this._fromBus(canId, data),
    };
  }

  _controlIn(setup, length) {
    if (setup.requestType !== "vendor") return { status: "stall" };
    if (setup.request === BREQ.BT_CONST) {
      const c = this.btConst;
      const out = new Uint8Array(40);
      const v = new DataView(out.buffer);
      [c.feature, c.fclk_can, c.tseg1_min, c.tseg1_max, c.tseg2_min, c.tseg2_max, c.sjw_max, c.brp_min, c.brp_max, c.brp_inc]
        .forEach((x, i) => v.setUint32(i * 4, x >>> 0, true));
      return out.subarray(0, length);
    }
    if (setup.request === BREQ.DEVICE_CONFIG) {
      const out = new Uint8Array(12);
      const v = new DataView(out.buffer);
      out[3] = 0;                 // icount: one channel
      v.setUint32(4, 2, true);    // sw_version
      v.setUint32(8, 1, true);    // hw_version
      return out.subarray(0, length);
    }
    return { status: "stall" };
  }

  _controlOut(setup, data) {
    if (setup.requestType !== "vendor") return { status: "stall" };
    const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
    switch (setup.request) {
      case BREQ.HOST_FORMAT:
        this.hostFormat = v.getUint32(0, true);
        return;
      case BREQ.BITTIMING:
        this.timing = { prop_seg: v.getUint32(0, true), phase_seg1: v.getUint32(4, true), phase_seg2: v.getUint32(8, true), sjw: v.getUint32(12, true), brp: v.getUint32(16, true) };
        return;
      case BREQ.MODE:
        this.mode = { mode: v.getUint32(0, true), flags: v.getUint32(4, true) };
        this.modes.push(this.mode);
        return;
      case BREQ.IDENTIFY:
        return;
      default:
        return { status: "stall" };
    }
  }

  _frame(canId, data, echoId) {
    const out = new Uint8Array(this.padFrames ? 64 : 20);
    const v = new DataView(out.buffer);
    v.setUint32(0, echoId >>> 0, true);
    v.setUint32(4, canId >>> 0, true);
    out[8] = data.length;
    out.set(data, 12);
    return out;
  }

  _fromBus(canId, data) {
    const push = () => this.rx.push(this._frame(canId, data, 0xffffffff));
    if (this.busDelayMs) setTimeout(push, this.busDelayMs);
    else push();
  }

  async _bulkOut(ep, data) {
    if (ep !== 2) return { status: "stall" };
    if (data.length < 20) return { status: "stall" };
    const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const echoId = v.getUint32(0, true);
    const canId = v.getUint32(4, true) & 0x1fffffff;
    const dlc = data[8];
    const payload = data.slice(12, 12 + dlc);
    this.sentToBus.push({ canId, data: payload });
    if (!this.mode || this.mode.mode !== 1) return;    // not started: the device drops it
    // Echo first, as the bridge does, then deliver to every node.
    this.rx.push(this._frame(v.getUint32(4, true), payload, echoId));
    for (const node of this.nodes) node.onFrame(canId, payload, this.bus);
  }

  async _bulkIn(ep, length) {
    if (ep !== 1) return { status: "stall" };
    const item = await this.rx.take();
    if (item === null) return { status: "stall" };
    return item.length > length ? item.subarray(0, length) : item;
  }
}
