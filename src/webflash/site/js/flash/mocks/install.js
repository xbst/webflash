// ?mock= mode for the site: scripted devices behind fake navigator.usb,
// navigator.serial and window.showDirectoryPicker, so the whole flash panel
// can be exercised in a browser with no hardware (and in the browser pane,
// whose device pickers cannot be driven).
//
//   ?mock=katapult   a Klipper port that becomes Katapult on the touch, and a paired Katapult port
//   ?mock=dfu        an STM32 ROM bootloader
//   ?mock=picoboot   an RP2040 BOOTSEL device
//   ?mock=can        a candleLight adapter with one Katapult and one Klipper node
//   ?mock=uf2        a BOOTSEL drive
//   &fail=claim|hang|verify|mcu|rdp|timeout|cancel|busy   one failure to show its explanation (hang: open() never settles, as Chrome on Windows without a WinUSB driver)
//   &fail=vanish|unplug   for ?mock=uf2: the drive goes away with the last block (a successful flash) or after 64 KiB (a cable pulled)
//   &os=windows|linux|mac|android  &browser=firefox|safari|brave   pretend to be elsewhere
//
// The firmware is a small generated image at the method's usual address,
// so the flow runs from the URL alone; Upload firmware replaces it.

import { MockUsbNavigator, domError } from "./mock-usb.js";
import { MockSerialNavigator, MockSerialPort } from "./mock-serial.js";
import { KatapultDevice, katapultSerialDevice } from "./katapult-device.js";
import { DfuseDevice } from "./dfuse-device.js";
import { PicobootMockDevice } from "./picoboot-device.js";
import { GsUsbMockAdapter, KatapultCanNode, KlipperCanNode } from "./gsusb-adapter.js";
import { bootselDrive } from "./mock-fs.js";
import { klipperCdcPort } from "./klipper-cdc.js";
import { toUf2, fromBin } from "../firmware-file.js";

function sampleBin(size, seed = 17) {
  const data = new Uint8Array(size);
  for (let i = 0; i < size; i++) data[i] = (i * seed + 1) & 0xff;
  return data;
}

export async function installMocks(params) {
  const kind = params.get("mock");
  const fail = params.get("fail") || "";
  const usb = new MockUsbNavigator();
  const serial = new MockSerialNavigator();
  const claimError = fail === "claim" ? domError("NetworkError", "Unable to claim interface.") : null;
  let firmware = null;
  let drive = null;

  if (kind === "katapult") {
    const katOptions = { mcu: fail === "mcu" ? "stm32f072xb" : "stm32g0b1xx", corruptReadAt: fail === "verify" ? 0x2000 + 100 : null, silentFirst: fail === "timeout" ? 100 : 0, busyOnce: fail === "busy", doubleBuffered: true };
    const k = klipperCdcPort({ becomes: "katapult", serialNav: serial, usbNav: usb, delayMs: 1500, katapultOptions: katOptions });
    const paired = new MockSerialPort(katapultSerialDevice(new KatapultDevice(katOptions)), { info: { usbVendorId: 0x1d50, usbProductId: 0x6177 }, name: "Katapult" });
    // The picker: the Klipper port when the filter asks for Klipper, else the Katapult port.
    const picker = (options) => {
      if (fail === "cancel") return null;
      const f = (options.filters || [])[0];
      if (f && f.usbProductId === 0x614e) return k.port;
      return k.newPort || paired;
    };
    for (let i = 0; i < 20; i++) serial.willPick(picker);
    firmware = { name: "klipper.bin", bytes: sampleBin(3000), address: 0x08002000 };
  } else if (kind === "dfu") {
    const dev = new DfuseDevice({ claimError, rdp: fail === "rdp", corruptReadAt: fail === "verify" ? 0x08000040 : null });
    for (let i = 0; i < 20; i++) usb.willPick(() => (fail === "cancel" ? null : new DfuseDevice({ claimError, rdp: fail === "rdp", corruptReadAt: fail === "verify" ? 0x08000040 : null })));
    usb.add(dev);
    firmware = { name: "klipper.bin", bytes: sampleBin(5000), address: 0x08000000 };
  } else if (kind === "picoboot") {
    for (let i = 0; i < 20; i++) usb.willPick(() => (fail === "cancel" ? null : new PicobootMockDevice({ claimError, openHang: fail === "hang", corruptReadAt: fail === "verify" ? 0x10000123 : null, rebootDelayCap: 300 })));
    firmware = { name: "klipper.uf2", bytes: toUf2(fromBin(sampleBin(9000), 0x10000000), "rp2040") };
  } else if (kind === "can") {
    const nodes = [
      new KatapultCanNode({ uuid: [0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff], deviceOptions: { mcu: fail === "mcu" ? "stm32f072xb" : "stm32g0b1xx", corruptReadAt: fail === "verify" ? 0x2000 + 50 : null } }),
      new KlipperCanNode({ uuid: [0x01, 0x02, 0x03, 0x04, 0x05, 0x06], rebootDelayMs: 800 }),
    ];
    for (let i = 0; i < 20; i++) usb.willPick(() => (fail === "cancel" ? null : new GsUsbMockAdapter({ nodes, claimError, busDelayMs: 2 })));
    firmware = { name: "klipper.bin", bytes: sampleBin(2000), address: 0x08002000 };
  } else if (kind === "uf2") {
    // vanish: the drive goes away inside the last block, as when the ROM
    // restarts the chip; unplug: it goes away after the first 64 KiB of a
    // larger file, before the board has the whole file.
    firmware = { name: "klipper.uf2", bytes: toUf2(fromBin(sampleBin(fail === "unplug" ? 100000 : 9000), 0x10000000), "rp2040") };
    const vanishAfterBytes = fail === "vanish" ? firmware.bytes.length - 256 : fail === "unplug" ? 65536 + 4096 : null;
    drive = bootselDrive({ chip: params.get("chip") === "rp2350" ? "rp2350" : "rp2040", vanishAfterBytes });
  }

  const win = {
    showDirectoryPicker: kind === "uf2" ? async () => { if (fail === "cancel") throw domError("AbortError", "The user aborted a request."); return drive; } : undefined,
  };
  const os = params.get("os");
  const browser = params.get("browser");
  const nav = {
    usb: browser === "firefox" || browser === "safari" ? undefined : usb,
    serial: browser === "firefox" || browser === "safari" || os === "android" ? undefined : serial,
    userAgent: browser === "firefox" ? "Mozilla/5.0 (Windows NT 10.0; rv:131.0) Gecko/20100101 Firefox/131.0"
      : browser === "safari" ? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"
      : os === "android" ? "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36"
      : os === "linux" ? "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
      : os === "mac" ? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
      : os === "windows" ? "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
      : navigator.userAgent,
    platform: os === "linux" ? "Linux x86_64" : os === "mac" ? "MacIntel" : os === "windows" ? "Win32" : os === "android" ? "Linux armv8l" : navigator.platform,
    userAgentData: undefined,
    brave: browser === "brave" ? { isBrave: async () => true } : undefined,   // Brave: Chrome's user agent, WebUSB and Web Serial, no folder picker
  };
  if (kind === "uf2" && browser !== "firefox" && browser !== "safari" && browser !== "brave") win.showDirectoryPicker = win.showDirectoryPicker || (async () => drive);
  if (browser === "firefox" || browser === "safari" || browser === "brave") win.showDirectoryPicker = undefined;
  console.info(`WebFlash mock mode: ${kind}${fail ? ` (fail=${fail})` : ""}`);
  const method = { katapult: "katapult", dfu: "dfu", picoboot: "picoboot", can: "katapult-can", uf2: "uf2" }[kind] || null;
  return { nav, win, firmware, usb, serial, drive, method };
}
