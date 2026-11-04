// The devices WebFlash talks to, the picker filters each method uses, and
// what a configuration says about how its firmware is flashed (SPEC 11.1
// and 11.2).
//
// inferMethods(configText) reads the few CONFIG_ symbols the rules need
// from the .config text in JavaScript. It has the same shape as the
// bridge's infer_methods (engine/methods.py), so the panel can switch to the
// Python side without changing callers.

import { isForeignFamily } from "./firmware-file.js";

// ── USB ids ─────────────────────────────────────────────────────────

export const IDS = {
  STM32_DFU: { vendorId: 0x0483, productId: 0xdf11, label: "STM32 BOOTLOADER" },
  RP2040_BOOT: { vendorId: 0x2e8a, productId: 0x0003, label: "RP2 Boot" },
  RP2350_BOOT: { vendorId: 0x2e8a, productId: 0x000f, label: "RP2350 Boot" },
  KLIPPER: { vendorId: 0x1d50, productId: 0x614e, label: "Klipper" },
  KATAPULT: { vendorId: 0x1d50, productId: 0x6177, label: "Katapult" },
  GS_USB: { vendorId: 0x1d50, productId: 0x606f, label: "gs_usb / candleLight" },
  CANDLELIGHT_ALT: { vendorId: 0x1209, productId: 0x2323, label: "candleLight" },
  CES_CANEXT_FD: { vendorId: 0x1cd2, productId: 0x606f, label: "CES CANext FD" },
  ABE_CANDEBUGGER_FD: { vendorId: 0x16d0, productId: 0x10b8, label: "ABE CANdebugger FD" },
  XYLANTA_SAINT3: { vendorId: 0x16d0, productId: 0x0f30, label: "Xylanta SAINT3" },
};

const id = (d) => ({ vendorId: d.vendorId, productId: d.productId });

/** WebUSB requestDevice filters per method. */
export const USB_FILTERS = {
  dfu: [id(IDS.STM32_DFU)],
  picoboot: [id(IDS.RP2040_BOOT), id(IDS.RP2350_BOOT)],
  "katapult-can": [id(IDS.GS_USB), id(IDS.CANDLELIGHT_ALT), id(IDS.CES_CANEXT_FD), id(IDS.ABE_CANDEBUGGER_FD), id(IDS.XYLANTA_SAINT3)],
  klipper: [id(IDS.KLIPPER)],
  katapult: [id(IDS.KATAPULT)],
};

/** Web Serial requestPort filters. A UART adapter has no useful id: "any". */
export const SERIAL_FILTERS = {
  katapult: [{ usbVendorId: IDS.KATAPULT.vendorId, usbProductId: IDS.KATAPULT.productId }],
  klipper: [{ usbVendorId: IDS.KLIPPER.vendorId, usbProductId: IDS.KLIPPER.productId }],
  any: [],
};

export function labelForIds(vendorId, productId) {
  for (const d of Object.values(IDS)) if (d.vendorId === vendorId && d.productId === productId) return d.label;
  return null;
}

// ── Methods ─────────────────────────────────────────────────────────

export const METHODS = {
  katapult: {
    id: "katapult", label: "Katapult (USB or UART)", transport: "serial",
    short: "Katapult",
    needs: "No driver needed; on Linux, add your user to the dialout group.",
  },
  "katapult-can": {
    id: "katapult-can", label: "Katapult over CAN", transport: "usb",
    short: "Katapult over CAN",
    needs: "Needs a candleLight (gs_usb) adapter or a USB to CAN bridge board; on Linux, unbind it from gs_usb first.",
  },
  dfu: {
    id: "dfu", label: "DFU (STM32 ROM)", transport: "usb",
    short: "DFU",
    needs: "Windows needs the WinUSB driver once (Zadig: \"DFU in FS Mode\"); Linux needs a udev rule.",
  },
  picoboot: {
    id: "picoboot", label: "PICOBOOT (RP2 BOOTSEL)", transport: "usb",
    short: "PICOBOOT",
    needs: "Windows needs the WinUSB driver once for the RP2040 (Zadig: \"RP2 Boot (Interface 1)\"); Linux needs a udev rule.",
  },
  uf2: {
    id: "uf2", label: "UF2 drive (RP2 BOOTSEL)", transport: "filesystem",
    short: "UF2 drive",
    needs: "No driver needed.",
  },
  download: {
    id: "download", label: "Download the files", transport: "none",
    short: "Download",
    needs: "",
  },
};

export const METHOD_IDS = Object.keys(METHODS);

// ── Reading a .config ───────────────────────────────────────────────

/**
 * The .config (or defconfig) text as a Map: "CONFIG_X=y" gives true,
 * "CONFIG_X=123" or "CONFIG_X=0x8000" the string, "CONFIG_X=\"s\"" the
 * string without quotes, "# CONFIG_X is not set" false. Keys keep the
 * CONFIG_ prefix.
 */
export function parseConfig(text) {
  const map = new Map();
  if (text instanceof Map) return text;
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let m = /^#\s*(CONFIG_\w+)\s+is not set$/.exec(line);
    if (m) { map.set(m[1], false); continue; }
    if (line[0] === "#") continue;
    m = /^(CONFIG_\w+)=(.*)$/.exec(line);
    if (!m) continue;
    const [, key, raw] = m;
    let value;
    if (raw === "y") value = true;
    else if (raw === "n") value = false;
    else if (raw.length >= 2 && raw[0] === '"' && raw[raw.length - 1] === '"') value = raw.slice(1, -1).replace(/\\(["\\])/g, "$1");
    else value = raw;
    map.set(key, value);
  }
  return map;
}

/** A symbol's value (with or without the CONFIG_ prefix), or undefined. */
export function configValue(cfg, symbol) {
  const map = parseConfig(cfg);
  const key = symbol.startsWith("CONFIG_") ? symbol : `CONFIG_${symbol}`;
  return map.get(key);
}

export function configBool(cfg, symbol) {
  return configValue(cfg, symbol) === true;
}

/** An int or hex symbol as a number, or fallback when absent or unreadable. */
export function configInt(cfg, symbol, fallback = null) {
  const v = configValue(cfg, symbol);
  if (v === undefined || v === false || v === true) return fallback;
  const n = /^0x/i.test(v) ? parseInt(v, 16) : parseInt(v, 10);
  return Number.isNaN(n) ? fallback : n;
}

/** The MCU family of a configuration: "stm32", "rp2040", "rp2350", "lpc176x", ... or null. */
export function familyOf(cfg) {
  const map = parseConfig(cfg);
  if (map.get("CONFIG_MACH_STM32") === true) return "stm32";
  if (map.get("CONFIG_MACH_RPXXXX") === true || map.get("CONFIG_MACH_RP2040") === true || map.get("CONFIG_MACH_RP2350") === true) {
    return map.get("CONFIG_MACH_RP2350") === true ? "rp2350" : "rp2040";
  }
  if (map.get("CONFIG_MACH_LPC176X") === true) return "lpc176x";
  if (map.get("CONFIG_MACH_ATSAM") === true) return "atsam";
  if (map.get("CONFIG_MACH_ATSAMD") === true) return "atsamd";
  if (map.get("CONFIG_MACH_HC32F460") === true) return "hc32f460";
  if (map.get("CONFIG_MACH_AVR") === true) return "avr";
  if (map.get("CONFIG_MACH_PRU") === true) return "pru";
  if (map.get("CONFIG_MACH_AR100") === true) return "ar100";
  if (map.get("CONFIG_MACH_LINUX") === true) return "linux";
  if (map.get("CONFIG_MACH_SIMU") === true) return "simulator";
  const mcu = map.get("CONFIG_MCU");
  return typeof mcu === "string" ? familyFromMcu(mcu) : null;
}

// The families the projects offer that WebFlash does not build: its
// toolchain is clang for arm-none-eabi only. The twin of engine/methods.py's
// UNSUPPORTED_ARCH.
const UNSUPPORTED_ARCH = {
  avr: "Atmega AVR",
  pru: "Beaglebone PRU",
  ar100: "Allwinner AR100",
  linux: "Linux process",
  simulator: "Host simulator",
};

/** The name of a configuration's architecture when WebFlash cannot build it (AVR, PRU, AR100, Linux, the simulator), else null. */
export function unsupportedArch(cfg) {
  return UNSUPPORTED_ARCH[familyOf(cfg)] || null;
}

/** The sentence that refuses a build of such an architecture, else "" (the twin of methods.py's unsupported_reason). */
export function unsupportedReason(cfg) {
  const title = unsupportedArch(cfg);
  return title ? `${title} firmware cannot be built in WebFlash: it builds for Arm chips only ` +
    "(STM32, RP2040/RP2350, LPC176x, SAM/SAMD, HC32F460)" : "";
}

/**
 * CONFIG_MCU ("stm32g0b1xx", "rp2040", ...), or for a bare defconfig the
 * name Klipper's Kconfig gives the chosen MACH_ symbol, or null.
 */
export function mcuOf(cfg) {
  const map = parseConfig(cfg);
  const v = map.get("CONFIG_MCU");
  if (typeof v === "string" && v) return v;
  for (const [key, on] of map) {
    if (on !== true) continue;
    const m = /^CONFIG_MACH_(\w+)$/.exec(key);
    if (m && MCU_NAMES[m[1]]) return MCU_NAMES[m[1]];
  }
  return null;
}

// Klipper's and Kalico's `config MCU` defaults, by the chip's MACH_ symbol (src/*/Kconfig).
const MCU_NAMES = {
  STM32F031: "stm32f031x6", STM32F042: "stm32f042x6", STM32F070: "stm32f070xb", STM32F072: "stm32f072xb", STM32F103: "stm32f103xe", AT32F403: "stm32f103xe",
  STM32F207: "stm32f207xx", STM32F401: "stm32f401xc", STM32F405: "stm32f405xx", STM32F407: "stm32f407xx", STM32F429: "stm32f429xx",
  STM32F446: "stm32f446xx", STM32F765: "stm32f765xx", STM32G070: "stm32g070xx", STM32G071: "stm32g071xx", STM32G0B0: "stm32g0b0xx",
  STM32G0B1: "stm32g0b1xx", STM32G431: "stm32g431xx", STM32G474: "stm32g474xx", STM32H723: "stm32h723xx", STM32H743: "stm32h743xx",
  STM32H750: "stm32h750xx", STM32L412: "stm32l412xx", N32G452: "stm32f103xe", N32G455: "stm32f103xe",
  RP2040: "rp2040", RP2350: "rp2350", LPC1768: "lpc1768", LPC1769: "lpc1769",
};

// The chip's MACH_ symbol by its CONFIG_MCU name (the first of the few that share one).
const MACH_BY_MCU = {};
for (const [sym, name] of Object.entries(MCU_NAMES)) if (!(name in MACH_BY_MCU)) MACH_BY_MCU[name] = sym;

/**
 * What a Klipper dictionary's config says about the communication
 * interface: canserial.c, usbserial.c, serial.c and usb_canbus.c reserve
 * their pins by name, and the CAN code exports its bitrate. Returns
 * {kind: "usb"|"can"|"usbcan"|"serial"|null, pins, bitrate}.
 */
export function interfaceFromDict(d) {
  if (!d || typeof d !== "object") return { kind: null, pins: null, bitrate: null };
  const rate = d.CANBUS_FREQUENCY !== undefined ? parseInt(d.CANBUS_FREQUENCY, 10) : NaN;
  const bitrate = Number.isInteger(rate) && rate > 0 ? rate : null;
  const can = d.RESERVE_PINS_CAN !== undefined || bitrate !== null;
  const usb = d.RESERVE_PINS_USB !== undefined;
  if (d.CANBUS_BRIDGE || (can && usb)) return { kind: "usbcan", pins: d.RESERVE_PINS_CAN || null, bitrate };
  if (can) return { kind: "can", pins: d.RESERVE_PINS_CAN || null, bitrate };
  if (usb) return { kind: "usb", pins: d.RESERVE_PINS_USB || null, bitrate: null };
  if (d.RESERVE_PINS_serial !== undefined) return { kind: "serial", pins: d.RESERVE_PINS_serial || null, bitrate: null };
  return { kind: null, pins: null, bitrate: null };
}

/**
 * A .config-shaped text from what an uploaded Klipper file says about
 * itself: its dictionary's MCU and chip, the interface its pins reserve,
 * the CAN bitrate, and the address it starts at. inferMethods reads it
 * like a configuration, so an uploaded CAN build gets Katapult over CAN
 * whatever the page's own configuration says (STOP 4 found it offered
 * Katapult over USB). Null for a file without a dictionary.
 */
export function configFromImage(image) {
  const d = image && image.dict && image.dict.config && typeof image.dict.config === "object" ? image.dict.config : null;
  if (!d) return null;
  const lines = [];
  const mcu = typeof d.MCU === "string" && d.MCU ? d.MCU : null;
  const family = (image.family ? chipOf(image.family) : null) || familyFromMcu(mcu);
  if (mcu) lines.push(`CONFIG_MCU="${mcu}"`);
  const mach = {
    stm32: ["CONFIG_MACH_STM32=y"], rp2040: ["CONFIG_MACH_RPXXXX=y", "CONFIG_MACH_RP2040=y"], rp2350: ["CONFIG_MACH_RPXXXX=y", "CONFIG_MACH_RP2350=y"],
    lpc176x: ["CONFIG_MACH_LPC176X=y"], atsam: ["CONFIG_MACH_ATSAM=y"], atsamd: ["CONFIG_MACH_ATSAMD=y"], hc32f460: ["CONFIG_MACH_HC32F460=y"], avr: ["CONFIG_MACH_AVR=y"],
  };
  if (family && mach[family]) lines.push(...mach[family]);
  if (mcu && MACH_BY_MCU[mcu.toLowerCase()]) lines.push(`CONFIG_MACH_${MACH_BY_MCU[mcu.toLowerCase()]}=y`);
  const iface = interfaceFromDict(d);
  if (iface.kind === "usbcan") lines.push("CONFIG_USBCANBUS=y");
  else if (iface.kind === "can") lines.push("CONFIG_CANSERIAL=y");
  else if (iface.kind === "serial") lines.push("CONFIG_SERIAL=y");
  else if (iface.kind === "usb") lines.push("CONFIG_USBSERIAL=y");
  if (iface.bitrate) lines.push(`CONFIG_CANBUS_FREQUENCY=${iface.bitrate}`);
  // serial_irq.c exports the UART's baud, which Katapult in UART mode is built for too.
  const baud = d.SERIAL_BAUD !== undefined ? parseInt(d.SERIAL_BAUD, 10) : NaN;
  if (Number.isInteger(baud) && baud > 0) lines.push(`CONFIG_SERIAL_BAUD=${baud}`);
  if (Number.isInteger(image.start)) {
    // An RP2040 image at the flash base carries the 256-byte stage-2 boot block; Klipper's application starts after it.
    const app = family === "rp2040" && image.start === 0x10000000 ? 0x10000100 : image.start;
    lines.push(`CONFIG_FLASH_APPLICATION_ADDRESS=0x${app.toString(16)}`);
  }
  return `${lines.join("\n")}\n`;
}

/** The family a Katapult-reported or TOML mcu string belongs to. */
export function familyFromMcu(mcu) {
  const m = String(mcu || "").toLowerCase();
  if (!m) return null;
  if (m.startsWith("stm32") || m.startsWith("n32g4")) return "stm32";
  if (m.startsWith("rp2350")) return "rp2350";
  if (m.startsWith("rp2")) return "rp2040";
  if (m.startsWith("lpc176")) return "lpc176x";
  if (m.startsWith("samd") || m.startsWith("same5") || m.startsWith("samc")) return "atsamd";
  if (m.startsWith("sam")) return "atsam";
  if (m.startsWith("hc32")) return "hc32f460";
  if (m.startsWith("atmega") || m.startsWith("at90")) return "avr";
  return null;
}

/**
 * "usb" | "serial" | "can" | "usbcan" | null: the firmware's communication
 * interface. A full .config says so directly (USBSERIAL, SERIAL, CANSERIAL,
 * USBCANBUS); a bare defconfig only names the chosen pins, so those are
 * read too, and an STM32 or RP2 defconfig that names none means the
 * default, USB.
 */
export function interfaceOf(cfg) {
  const map = parseConfig(cfg);
  if (map.get("CONFIG_USBCANBUS") === true) return "usbcan";
  if (map.get("CONFIG_USBSERIAL") === true) return "usb";
  if (map.get("CONFIG_CANSERIAL") === true) return "can";
  if (map.get("CONFIG_SERIAL") === true) return "serial";
  for (const key of map.keys()) {
    if (map.get(key) !== true) continue;
    if (/^CONFIG_\w+_USBCANBUS/.test(key)) return "usbcan";
    if (/^CONFIG_\w+_(MMENU_)?CANBUS_P|^CONFIG_RPXXXX_CANBUS$|^CONFIG_LPC_CANBUS/.test(key)) return "can";
    if (/^CONFIG_\w+_SERIAL_U|^CONFIG_LPC_SERIAL/.test(key)) return "serial";
    if (/^CONFIG_\w+_USB(_|$)/.test(key)) return "usb";
  }
  const family = familyOf(map);
  return family === "stm32" || family === "rp2040" || family === "rp2350" || family === "lpc176x" ? "usb" : null;
}

/**
 * The UART's baud rate: CONFIG_SERIAL_BAUD, else Klipper's and Katapult's
 * default, 250000 (the symbol only shows under the low-level options, so a
 * defconfig often leaves it out). Katapult in UART mode talks at the baud
 * it was built with, which is normally Klipper's: flashtool.py takes one
 * baud for both.
 */
export function serialBaud(cfg) {
  const n = configInt(cfg, "SERIAL_BAUD", null);
  return Number.isInteger(n) && n > 0 ? n : 250000;
}

/** Default flash start by family (CONFIG_FLASH_BOOT_ADDRESS when the config lacks it). */
export function flashBootAddress(cfg) {
  const given = configInt(cfg, "FLASH_BOOT_ADDRESS", null);
  if (given !== null) return given;
  switch (familyOf(cfg)) {
    case "stm32": return 0x08000000;
    case "rp2040": return 0x10000100;
    case "rp2350": return 0x10000000;
    default: return 0;
  }
}

/**
 * Where the application goes: CONFIG_FLASH_APPLICATION_ADDRESS. A bare
 * defconfig lacks it, so the bootloader-offset choice symbol is read
 * (STM32_FLASH_START_2000, RPXXXX_FLASH_START_4000, LPC_FLASH_START_4000),
 * and when that is absent too, the family's default choice as Klipper's
 * Kconfig orders it (the first visible member of the choice).
 */
export function applicationAddress(cfg) {
  const map = parseConfig(cfg);
  const given = configInt(map, "FLASH_APPLICATION_ADDRESS", null);
  if (given !== null) return given;
  const family = familyOf(map);
  for (const key of map.keys()) {
    if (map.get(key) !== true) continue;
    let m = /^CONFIG_STM32_FLASH_START_([0-9A-Fa-f]+)$/.exec(key);
    if (m) return 0x08000000 + parseInt(m[1], 16);
    m = /^CONFIG_RPXXXX_FLASH_START_([0-9A-Fa-f]+)$/.exec(key);
    if (m) return 0x10000000 + parseInt(m[1], 16);
    m = /^CONFIG_LPC_FLASH_START_([0-9A-Fa-f]+)$/.exec(key);
    if (m) return parseInt(m[1], 16);
  }
  if (family === "stm32") return 0x08000000 + defaultStm32Offset(map);
  if (family === "rp2040") return 0x10000100;
  if (family === "rp2350") return 0x10000000;
  if (family === "lpc176x") return 0x4000;
  return flashBootAddress(map);
}

/** The first visible member of Klipper's STM32 "Bootloader offset" choice, by chip. */
function defaultStm32Offset(map) {
  const is = (sym) => map.get(`CONFIG_${sym}`) === true;
  // Kalico's AT32F403 selects MACH_STM32F1, which a bare defconfig does not carry.
  const F1 = is("MACH_STM32F1") || is("MACH_STM32F103") || is("MACH_N32G452") || is("MACH_N32G455") || is("MACH_AT32F403");
  const F0x2 = is("MACH_STM32F0x2") || is("MACH_STM32F042") || is("MACH_STM32F072");
  const F0 = is("MACH_STM32F0") || F0x2 || is("MACH_STM32F031") || is("MACH_STM32F070");
  const G0 = is("MACH_STM32G0") || /^CONFIG_MACH_STM32G0/.test([...map.keys()].find((k) => /^CONFIG_MACH_STM32G0\w+$/.test(k) && map.get(k) === true) || "");
  const G4 = is("MACH_STM32G4") || is("MACH_STM32G431") || is("MACH_STM32G474");
  const F2 = is("MACH_STM32F2") || is("MACH_STM32F207");
  const F4 = is("MACH_STM32F4") || is("MACH_STM32F401") || is("MACH_STM32F405") || is("MACH_STM32F407") || is("MACH_STM32F429") || is("MACH_STM32F446");
  const F7 = is("MACH_STM32F7") || is("MACH_STM32F765");
  const H7 = is("MACH_STM32H7") || is("MACH_STM32H723") || is("MACH_STM32H743") || is("MACH_STM32H750");
  if (F1 || is("MACH_STM32F070") || G0 || G4 || F0x2) return 0x2000;
  if (F2 || F4 || F7 || is("MACH_STM32H750")) return 0x8000;
  if (F0) return 0x1000;
  if (H7) return 0x20000;
  return 0;
}

/**
 * Whether the STM32's ROM has USB DFU, whatever interface the firmware uses:
 * a CAN or serial build of a toolhead with a USB port is flashed through the
 * ROM's DFU like any other. CONFIG_STM32_DFU_ROM_ADDRESS is 0 for those
 * builds (its "default 0 if !USB" is about Klipper restarting itself into
 * the ROM), so a 0 there falls back to the Kconfig's table by chip.
 */
export function hasDfuRom(cfg) {
  const map = parseConfig(cfg);
  const given = configInt(map, "STM32_DFU_ROM_ADDRESS", null);
  if (given) return true;
  if (familyOf(map) !== "stm32") return false;
  const is = (sym) => map.get(`CONFIG_${sym}`) === true;
  // The G070 and G071 are the G0 parts without a USB peripheral at all.
  if (is("MACH_STM32G070") || is("MACH_STM32G071")) return false;
  const on = [...map.keys()].filter((k) => map.get(k) === true);
  if (is("MACH_STM32F042") || is("MACH_STM32F072") || is("MACH_AT32F403")) return true;
  return on.some((k) => /^CONFIG_MACH_STM32(F4\w*|F7\w*|G0\w*|G4\w*|L4\w*|H7\w*)$/.test(k));
}

/**
 * The address a raw .bin of this build belongs at. Klipper's klipper.bin
 * starts at the application address; Katapult's katapult.bin starts at the
 * flash start (CONFIG_FLASH_START), since the bootloader sits in front of
 * the application; its deployer.bin is an application like Klipper's.
 */
export function imageAddressFor(cfg, project = "klipper", artifact = "") {
  const map = parseConfig(cfg);
  if (project === "katapult") {
    if (/deployer/i.test(artifact)) {
      // The deployer is an application Katapult itself loads: it goes where Katapult launches from.
      return configInt(map, "LAUNCH_APP_ADDRESS", applicationAddress(map));
    }
    const start = configInt(map, "FLASH_START", null);
    if (start !== null) return start;
    const family = familyOf(map);
    if (family === "rp2040" || family === "rp2350") return 0x10000000;
    return flashBootAddress(map);
  }
  return applicationAddress(map);
}

// ── Inference (SPEC 11.2) ───────────────────────────────────────────

/**
 * The flashing methods a configuration can use, best first, each with a
 * one-line reason: [{id, reason}]. project is "klipper", "kalico" or
 * "katapult".
 */
export function inferMethods(configText, { project = "klipper" } = {}) {
  const cfg = parseConfig(configText);
  const family = familyOf(cfg);
  const iface = interfaceOf(cfg);
  const appAddr = applicationAddress(cfg);
  const bootAddr = flashBootAddress(cfg);
  const hasBootloader = appAddr !== bootAddr;
  const out = [];
  const add = (idv, reason) => { if (!out.some((m) => m.id === idv)) out.push({ id: idv, reason }); };
  const offset = `the firmware starts at ${hex(appAddr)}, after a bootloader`;

  const katapultByInterface = () => {
    if (iface === "can") add("katapult-can", `${offset}, and it talks CAN through a USB to CAN adapter`);
    else if (iface === "usbcan") add("katapult", `${offset}; a USB to CAN bridge board runs Katapult over its own USB port`);
    else if (iface === "serial") add("katapult", `${offset}, and Katapult answers in UART mode through a USB-UART adapter`);
    else add("katapult", `${offset}, so Katapult updates it over USB`);
  };

  // A CAN or serial build reaches the ROM's DFU through the board's own USB
  // port, which a toolhead may or may not have.
  const overUsb = iface === "can" || iface === "serial" ? " over the board's USB port, if it has one" : "";

  if (project === "katapult") {
    // The bootloader itself: flashed with the chip's ROM bootloader, never with Katapult.
    if (family === "stm32") {
      if (hasDfuRom(cfg)) add("dfu", `the STM32's own ROM bootloader (hold BOOT0 and tap RESET) installs the Katapult bootloader${overUsb}`);
    } else if (family === "rp2040" || family === "rp2350") {
      add("picoboot", "the RP2 BOOTSEL ROM installs the Katapult bootloader over USB");
      add("uf2", "the same ROM also takes a .uf2 copied onto its drive");
    }
    add("download", "the files for any other tool (ST-LINK, picotool, OpenOCD)");
    return out;
  }

  switch (family) {
    case "stm32":
      if (hasBootloader) katapultByInterface();
      if (hasDfuRom(cfg)) {
        add("dfu", hasBootloader
          ? `the STM32's ROM bootloader (BOOT0) writes the flash${overUsb} while Katapult is not on the board yet`
          : `there is no bootloader offset, so the STM32's ROM bootloader (hold BOOT0, tap RESET) writes it${overUsb}`);
      } else if (!hasBootloader) {
        add("download", "this STM32 has no USB DFU in its ROM; flash the file with its own tool");
      }
      break;
    case "rp2040":
    case "rp2350":
      if (hasBootloader) katapultByInterface();
      add("picoboot", hasBootloader
        ? "the BOOTSEL ROM (hold BOOTSEL while plugging in) writes the flash directly, Katapult or not"
        : "there is no bootloader offset, so the BOOTSEL ROM (hold BOOTSEL while plugging in) writes it");
      add("uf2", "the BOOTSEL ROM also takes a .uf2 copied onto its drive");
      break;
    case "lpc176x":
      if (appAddr === 0x4000) {
        add("download", "LPC176x boards usually load firmware.bin from the SD card");
        add("katapult", "Katapult also runs on the LPC176x when it is installed in the first 16 KiB");
      } else {
        add("download", "copy the file to the board's SD card");
      }
      break;
    default:
      add("download", family
        ? `WebFlash builds for the ${family} family but does not flash it from the browser yet`
        : "the configuration names no micro-controller WebFlash can flash from the browser");
      break;
  }
  add("download", "the files for any other tool");
  return out;
}

/**
 * Apply the board TOML's [flash].methods: it fixes the order and the set;
 * a listed method the configuration cannot use is dropped with a warning.
 * Returns {methods: [{id, reason}], warnings: [string]}.
 */
export function applyTomlMethods(inferred, tomlMethods) {
  if (!Array.isArray(tomlMethods) || !tomlMethods.length) return { methods: inferred, warnings: [] };
  const warnings = [];
  const methods = [];
  for (const idv of tomlMethods) {
    const found = inferred.find((m) => m.id === idv);
    if (found) methods.push(found);
    else if (METHODS[idv]) warnings.push(`The board TOML's "${idv}" does not fit this configuration, so it is left out.`);
    else warnings.push(`The board TOML names an unknown flashing method "${idv}".`);
  }
  if (!methods.length) {
    methods.push(inferred.find((m) => m.id === "download") || { id: "download", reason: "the files for any other tool" });
  }
  return { methods, warnings };
}

/**
 * Methods for a prebuilt or uploaded file with no configuration: from the
 * TOML's mcu or the image (its UF2 family, its address range), else
 * everything with the user choosing (SPEC 11.2, last bullet).
 */
export function methodsForPrebuilt({ mcu = null, image = null, tomlMethods = null } = {}) {
  if (image && isForeignFamily(image.family)) {
    // A UF2 for another chip family (SAMD51, ESP32, ...): no RP2 method takes it, whatever the TOML says.
    return applyTomlMethods([{ id: "download", reason: `the UF2 is for another chip family (${image.family}), which WebFlash does not flash from the browser` }], tomlMethods);
  }
  let family = familyFromMcu(mcu);
  let why = mcu ? `the board TOML names the ${mcu}` : null;
  if (!family && image) {
    const chip = image.family ? chipOf(image.family) : null;
    const fromMcu = image.mcu ? familyFromMcu(image.mcu) : null;
    if (chip) { family = chip; why = `the UF2 is for the ${image.family}`; }
    else if (fromMcu) { family = fromMcu; why = `the file was built for the ${image.mcu}`; }
    else if (image.start >= 0x08000000 && image.start < 0x09000000) { family = "stm32"; why = `the file's address ${hex(image.start)} says so`; }
    else if (image.start >= 0x10000000 && image.start < 0x11000000) { family = "rp2040"; why = `the file's address ${hex(image.start)} says so`; }
  }
  // A file that starts at the flash base is the whole firmware, for the
  // chip's ROM bootloader; one that starts after a bootloader's space is
  // for Katapult. The first method is the default the page picks.
  const atBase = !!image && (image.start === 0x08000000 || image.start === 0x10000000);
  const base = `${why}; the file starts at the flash base, so it is the whole firmware`;
  let inferred;
  if (family === "stm32") {
    const katapult = [
      { id: "katapult", reason: `${why}: Katapult over USB when the board has it${atBase ? " (the file would then have to start after it)" : ""}` },
      { id: "katapult-can", reason: `${why}: Katapult over CAN when the board is on a bus` },
    ];
    const rom = [{ id: "dfu", reason: atBase ? `${base}, for the STM32 ROM bootloader (BOOT0)` : `${why}: the STM32 ROM bootloader (BOOT0) when there is no Katapult` }];
    inferred = [...(atBase ? [...rom, ...katapult] : [...katapult, ...rom]), { id: "download", reason: "the file for any other tool" }];
  } else if (family === "rp2040" || family === "rp2350") {
    const katapult = [
      { id: "katapult", reason: `${why}: Katapult over USB when the board has it${atBase ? " (the file would then have to start after it)" : ""}` },
      { id: "katapult-can", reason: `${why}: Katapult over CAN when the board is on a bus` },
    ];
    const rom = [
      { id: "picoboot", reason: atBase ? `${base}, for the BOOTSEL ROM over USB` : `${why}: the BOOTSEL ROM over USB` },
      { id: "uf2", reason: `${why}: the BOOTSEL drive` },
    ];
    inferred = atBase
      ? [...rom, ...katapult, { id: "download", reason: "the file for any other tool" }]
      : [katapult[0], ...rom, katapult[1], { id: "download", reason: "the file for any other tool" }];
  } else if (family === "lpc176x") {
    inferred = [
      { id: "download", reason: `${why}: LPC176x boards load firmware.bin from the SD card` },
      { id: "katapult", reason: `${why}: Katapult over USB when the board has it` },
    ];
  } else {
    inferred = METHOD_IDS.map((idv) => ({ id: idv, reason: "nothing names the chip, so every method is offered: pick the one for its bootloader" }));
  }
  if (image && image.family && image.format === "uf2") {
    // A UF2 can only go where UF2s go, plus the methods that write its bytes.
    inferred = inferred.filter((m) => m.id !== "dfu");
  }
  return applyTomlMethods(inferred, tomlMethods);
}

function chipOf(family) {
  if (family === "rp2040") return "rp2040";
  if (typeof family === "string" && family.startsWith("rp2350")) return "rp2350";
  return null;
}

/**
 * The chip family a firmware file says it is for: its UF2 family id or the
 * MCU in its Klipper dictionary. "other" for a UF2 of a chip family the
 * RP2 ROMs do not take, which fits no configuration. Null when the file
 * says nothing (a bare .bin or .hex); its address range is then only a
 * hint, see configFitsImage.
 */
export function imageFamily(image) {
  if (!image) return null;
  if (isForeignFamily(image.family)) return "other";
  const chip = image.family ? chipOf(image.family) : null;
  if (chip) return chip;
  return image.mcu ? familyFromMcu(image.mcu) : null;
}

/**
 * Whether a configuration describes the chip a firmware file was built
 * for, so its inferred methods apply to the file. A file that names its
 * chip (UF2 family, Klipper dictionary) must match the configuration's
 * family; a bare file must at least sit in the family's flash range (the
 * RP2040 and RP2350 share theirs); a file or configuration that says
 * nothing fits, and a UF2 of another chip family fits none. STOP 3 found an RP2040 UF2 offered the STM32
 * configuration's methods, with no PICOBOOT among them.
 */
export function configFitsImage(cfg, image) {
  if (image && imageFamily(image) === "other") return false;
  const family = familyOf(cfg);
  if (!family || !image) return true;
  const named = imageFamily(image);
  if (named) return named === family;
  if (!Number.isInteger(image.start)) return true;
  if (image.start >= 0x08000000 && image.start < 0x09000000) return family === "stm32";
  if (image.start >= 0x10000000 && image.start < 0x11000000) return family === "rp2040" || family === "rp2350";
  return true;
}

// ── Instructions and hints ──────────────────────────────────────────

/**
 * The connect step for a method when the board TOML gives none, as short
 * numbered steps (SPEC 7). fromKlipper: the restart from Klipper is offered;
 * serial: the firmware talks over a UART (a USB-UART adapter), at baud.
 */
export function defaultSteps(method, family = null, { fromKlipper = true, serial = false, baud = 250000 } = {}) {
  switch (method) {
    case "katapult":
      return [
        ...(fromKlipper ? ["Klipper running? Click **Restart Klipper into Katapult**."] : []),
        `${fromKlipper ? "Otherwise, double-tap" : "Double-tap"} RESET to start Katapult.`,
        serial ? `Click **Connect** and pick the adapter's port.` : "Click **Connect** and pick the Katapult port.",
        ...(serial ? [`Katapult must talk at ${baud || 250000} baud too.`] : []),
      ];
    case "katapult-can":
      return [
        "Plug in the USB to CAN adapter.",
        "Click **Connect** and pick the adapter.",
        "Pick the node; Klipper restarts into Katapult.",
      ];
    case "dfu":
      return [
        "Plug the board in over USB.",
        "Hold BOOT0, tap RESET, release BOOT0.",
        "Click **Connect** and pick \"DFU in FS Mode\".",
      ];
    case "picoboot":
      return [
        "Hold BOOTSEL and plug the board in.",
        "Click **Connect** and pick \"RP2 Boot\".",
      ];
    case "uf2":
      return [
        "Hold BOOTSEL and plug the board in.",
        `Click **Pick the drive** and choose ${family === "rp2350" ? "RP2350" : "RPI-RP2"}.`,
        "The board restarts by itself.",
      ];
    case "download":
      switch (family) {
        case "lpc176x": return ["Download klipper.bin.", "Copy it to the SD card as firmware.bin.", "Power the board up with the card in."];
        case "atsam": case "atsamd": return ["Download klipper.bin.", "Flash it with bossac (as `make flash` does)."];
        case "hc32f460": return ["Download klipper.bin.", "Flash it with the board's own tool."];
        default: return ["Download the files.", "Flash them with your board's own tool."];
      }
    default:
      return [];
  }
}

/** defaultSteps as one text, a step per line. */
export function defaultInstructions(method, family = null, options = {}) {
  return defaultSteps(method, family, options).join("\n");
}

/**
 * The printer.cfg line after a successful flash (SPEC 11.10), best effort.
 * baud is the firmware's UART baud, written when it is not Klipper's default.
 */
export function printerConfigHint({ method, mcu = null, serial = null, uuid = null, project = "klipper", iface = null, baud = null } = {}) {
  if (project === "katapult") return null;
  // The firmware's interface decides the form, not the transport it was
  // flashed over: a CAN node flashed through the ROM's USB DFU, or a USB to
  // CAN bridge flashed over its own USB port, both go into printer.cfg by
  // canbus_uuid (STOP 4 saw a bridge get a serial path).
  const kind = iface || (method === "katapult-can" ? "can" : null);
  if (kind === "can" || kind === "usbcan" || uuid) {
    if (uuid) return `[mcu]\ncanbus_uuid: ${uuid}`;
    const query = "# Find it with: ~/klippy-env/bin/python ~/klipper/scripts/canbus_query.py can0";
    return `[mcu]\ncanbus_uuid: <the ${kind === "usbcan" ? "bridge" : "node"}'s UUID>\n${query}`;
  }
  if (kind === "serial") {
    // Klipper opens the UART at 250000 unless [mcu] names another baud.
    const rate = Number.isInteger(baud) && baud > 0 && baud !== 250000 ? `\nbaud: ${baud}` : "";
    return `[mcu]\nserial: /dev/serial/by-id/<the USB-UART adapter>${rate}\n# Find it with: ls /dev/serial/by-id/`;
  }
  const name = mcu || "<mcu>";
  const known = !!(serial && /^[0-9A-Fa-f]{8,}$/.test(serial));
  const ser = known ? serial.toUpperCase() : "<serial>";
  const note = known ? "" : "\n# Find <serial> with: ls /dev/serial/by-id/ (once Klipper runs)";
  return `[mcu]\nserial: /dev/serial/by-id/usb-Klipper_${name}_${ser}-if00${note}`;
}

export function hex(n) {
  return `0x${(n >>> 0).toString(16).padStart(8, "0")}`;
}
