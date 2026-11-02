// The devices WebFlash talks to, the picker filters each method uses, and
// what a configuration says about how its firmware is flashed (SPEC 11.1
// and 11.2).
//
// inferMethods(configText) reads the few CONFIG_ symbols the rules need
// from the .config text in JavaScript. It has the same shape as the
// bridge's infer_methods (chunk 03), so the panel can switch to the Python
// side without changing callers.

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
    needs: "Chrome or Edge on a computer; on Linux your user in the dialout group. No driver on Windows.",
  },
  "katapult-can": {
    id: "katapult-can", label: "Katapult over CAN (USB to CAN adapter)", transport: "usb",
    short: "Katapult over CAN",
    needs: "A candleLight / gs_usb adapter or a Klipper board in USB to CAN bridge mode on the same bus; on Linux the adapter must be unbound from the kernel's gs_usb driver.",
  },
  dfu: {
    id: "dfu", label: "DFU (STM32 ROM bootloader)", transport: "usb",
    short: "DFU",
    needs: "Windows: the WinUSB driver on STM32 BOOTLOADER (Zadig, once). Linux: a udev rule. macOS: nothing.",
  },
  picoboot: {
    id: "picoboot", label: "PICOBOOT (RP2040/RP2350 BOOTSEL)", transport: "usb",
    short: "PICOBOOT",
    needs: "Windows: the WinUSB driver on RP2 Boot (Interface 1) (Zadig, once) for the RP2040. Linux: a udev rule. macOS: nothing.",
  },
  uf2: {
    id: "uf2", label: "UF2 file onto the BOOTSEL drive", transport: "filesystem",
    short: "UF2 drive",
    needs: "Chrome or Edge on a computer. No driver on any OS.",
  },
  download: {
    id: "download", label: "Download the files", transport: "none",
    short: "Download",
    needs: "Nothing: flash the downloaded file with the board's own tool.",
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

/** CONFIG_MCU ("stm32g0b1xx", "rp2040", ...) or null. */
export function mcuOf(cfg) {
  const v = configValue(cfg, "MCU");
  return typeof v === "string" && v ? v : null;
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
  const F1 = is("MACH_STM32F1") || is("MACH_STM32F103") || is("MACH_N32G452") || is("MACH_N32G455");
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

/** Whether the STM32's ROM has USB DFU: CONFIG_STM32_DFU_ROM_ADDRESS, else Klipper's table by chip. */
export function hasDfuRom(cfg) {
  const map = parseConfig(cfg);
  const given = configInt(map, "STM32_DFU_ROM_ADDRESS", null);
  if (given !== null) return given !== 0;
  if (familyOf(map) !== "stm32") return false;
  if (interfaceOf(map) === "can" || interfaceOf(map) === "serial") return false;   // default 0 if !USB
  const is = (sym) => map.get(`CONFIG_${sym}`) === true;
  const on = [...map.keys()].filter((k) => map.get(k) === true);
  if (is("MACH_STM32F042") || is("MACH_STM32F072")) return true;
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
    if (iface === "can") add("katapult-can", `${offset}, and it talks CAN bus (the toolhead is reached through a USB to CAN adapter)`);
    else if (iface === "usbcan") add("katapult", `${offset}; a USB to CAN bridge board runs Katapult over its own USB port`);
    else if (iface === "serial") add("katapult", `${offset}, and it talks serial (Katapult in UART mode through a USB-UART adapter)`);
    else add("katapult", `${offset}, so Katapult updates it over USB`);
  };

  if (project === "katapult") {
    // The bootloader itself: flashed with the chip's ROM bootloader, never with Katapult.
    if (family === "stm32") {
      if (hasDfuRom(cfg)) add("dfu", "the STM32's own ROM bootloader (hold BOOT0 and tap RESET) installs the Katapult bootloader");
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
          ? "the STM32's ROM bootloader (BOOT0) writes the whole flash, Katapult included, when Katapult is not there yet"
          : "no bootloader offset is configured, so the STM32's own ROM bootloader (hold BOOT0 and tap RESET) is the way in");
      } else if (!hasBootloader) {
        add("download", iface === "can"
          ? "a CAN-only configuration cannot reach the ROM's USB DFU; flash the file with an ST-LINK or another tool"
          : "this STM32 has no USB DFU in its ROM; flash the file with its own tool");
      }
      break;
    case "rp2040":
    case "rp2350":
      if (hasBootloader) katapultByInterface();
      add("picoboot", hasBootloader
        ? "the BOOTSEL ROM (hold BOOTSEL while plugging in) writes the flash directly, Katapult or not"
        : "no bootloader offset is configured, so the BOOTSEL ROM (hold BOOTSEL while plugging in) is the way in");
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
    else if (METHODS[idv]) warnings.push(`The board TOML offers "${idv}", which this configuration cannot use; it was left out.`);
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
  let family = familyFromMcu(mcu);
  if (!family && image) {
    const chip = image.family ? chipOf(image.family) : null;
    if (chip) family = chip;
    else if (image.start >= 0x08000000 && image.start < 0x09000000) family = "stm32";
    else if (image.start >= 0x10000000 && image.start < 0x11000000) family = "rp2040";
  }
  const why = mcu ? `the board TOML names the ${mcu}` : image && image.family ? `the UF2 is for the ${image.family}` : image ? `the file's address ${hex(image.start)} says so` : null;
  let inferred;
  if (family === "stm32") {
    inferred = [
      { id: "katapult", reason: `${why}: Katapult over USB when the board has it` },
      { id: "katapult-can", reason: `${why}: Katapult over CAN when the board is on a bus` },
      { id: "dfu", reason: `${why}: the STM32 ROM bootloader (BOOT0) when there is no Katapult` },
      { id: "download", reason: "the file for any other tool" },
    ];
  } else if (family === "rp2040" || family === "rp2350") {
    inferred = [
      { id: "katapult", reason: `${why}: Katapult over USB when the board has it` },
      { id: "picoboot", reason: `${why}: the BOOTSEL ROM over USB` },
      { id: "uf2", reason: `${why}: the BOOTSEL drive` },
      { id: "katapult-can", reason: `${why}: Katapult over CAN when the board is on a bus` },
      { id: "download", reason: "the file for any other tool" },
    ];
  } else if (family === "lpc176x") {
    inferred = [
      { id: "download", reason: `${why}: LPC176x boards load firmware.bin from the SD card` },
      { id: "katapult", reason: `${why}: Katapult over USB when the board has it` },
    ];
  } else {
    inferred = METHOD_IDS.map((idv) => ({ id: idv, reason: "nothing is known about the board, so every method is offered; pick the one that matches its bootloader" }));
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

// ── Instructions and hints ──────────────────────────────────────────

/** The connect step's text for a method when the board TOML gives none. */
export function defaultInstructions(method, family = null, { fromKlipper = true } = {}) {
  switch (method) {
    case "katapult":
      return (fromKlipper ? "If Klipper is running on the board, WebFlash asks it to restart into Katapult (pick the Klipper port when asked). " : "") +
        "Otherwise put the board in Katapult yourself: double-tap RESET (or hold the boot button while resetting, on boards built that way), then click Connect and pick the Katapult port. For a board on a USB-UART adapter pick the adapter's port.";
    case "katapult-can":
      return "Plug the USB to CAN adapter (candleLight, CANable in candleLight mode, or a Klipper board in USB to CAN bridge mode) into this computer with the toolhead on its bus, then click Connect and pick the adapter. WebFlash lists the nodes on the bus; a node running Klipper is restarted into Katapult first.";
    case "dfu":
      return "Put the board in its ROM bootloader: hold BOOT0 (or BOOT), tap RESET, release BOOT0; or plug it in with BOOT0 held. Then click Connect and pick \"STM32 BOOTLOADER\". On Windows that device needs the WinUSB driver once (Zadig).";
    case "picoboot":
      return "Hold BOOTSEL while plugging the board in (or while tapping RESET), then click Connect and pick \"RP2 Boot\". On Windows the RP2040's \"RP2 Boot (Interface 1)\" needs the WinUSB driver once (Zadig).";
    case "uf2":
      return `Hold BOOTSEL while plugging the board in; it shows up as a drive named ${family === "rp2350" ? "RP2350" : "RPI-RP2"}. Click Connect and pick that drive; WebFlash writes the .uf2 onto it and the board restarts by itself.`;
    case "download":
      switch (family) {
        case "lpc176x": return "Download klipper.bin, copy it to the board's SD card as firmware.bin, and power the board up with the card in.";
        case "atsam": case "atsamd": return "Download klipper.bin and flash it with bossac, as Klipper's make flash does for this board.";
        case "hc32f460": return "Download klipper.bin and flash it with the board's own tool.";
        default: return "Download the files and flash them with the tool your board's documentation names.";
      }
    default:
      return "";
  }
}

/** The printer.cfg line after a successful flash (SPEC 11.10), best effort. */
export function printerConfigHint({ method, mcu = null, serial = null, uuid = null, project = "klipper" } = {}) {
  if (project === "katapult") return null;
  if (method === "katapult-can" || uuid) {
    return uuid ? `[mcu]\ncanbus_uuid: ${uuid}` : "[mcu]\ncanbus_uuid: <the node's UUID>";
  }
  const name = mcu || "<mcu>";
  const ser = serial && /^[0-9A-Fa-f]{8,}$/.test(serial) ? serial.toUpperCase() : "<serial>";
  return `[mcu]\nserial: /dev/serial/by-id/usb-Klipper_${name}_${ser}-if00`;
}

export function hex(n) {
  return `0x${(n >>> 0).toString(16).padStart(8, "0")}`;
}
