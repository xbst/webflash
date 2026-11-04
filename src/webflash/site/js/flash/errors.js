// Flashing errors, and what to do about them.
//
// Every failure the flash modules raise is a FlashError with a short code, so
// the panel (and the embed) can turn it into a sentence and a list of fixes
// without parsing messages. explainError() also maps the browser's own
// errors (a refused claim, a dismissed picker, a port another program holds)
// to the same shape, with the fix that depends on the operating system:
// Zadig on Windows, udev rules and group membership on Linux.
//
// This module imports nothing, so every other flash module can use it.

export class FlashError extends Error {
  /**
   * @param {string} message one sentence, for the log and the result box
   * @param {{code?: string, fix?: string|string[], cause?: any, details?: object}} [options]
   */
  constructor(message, { code = "flash", fix = null, cause = null, details = null } = {}) {
    super(message);
    this.name = "FlashError";
    this.code = code;
    this.fix = fix === null ? [] : Array.isArray(fix) ? fix : [fix];
    this.cause = cause;
    this.details = details;
  }
}

/** Shorthand: throw a FlashError with a code. */
export function fail(code, message, options = {}) {
  throw new FlashError(message, { code, ...options });
}

/** The user dismissed the browser's device picker: not an error worth a box. */
export function isCancel(err) {
  if (!err) return false;
  if (err.code === "cancelled") return true;
  const msg = String(err.message || err);
  return err.name === "NotFoundError" && /No (device|port) selected/i.test(msg);
}

// ── Platform ────────────────────────────────────────────────────────

/** "windows" | "linux" | "mac" | "android" | "ios" | "other" */
export function detectOs(nav = typeof navigator !== "undefined" ? navigator : null) {
  if (!nav) return "other";
  const platform = (nav.userAgentData && nav.userAgentData.platform) || nav.platform || "";
  const ua = nav.userAgent || "";
  const p = `${platform} ${ua}`;
  if (/android/i.test(p)) return "android";
  if (/iphone|ipad|ipod/i.test(p)) return "ios";
  if (/win/i.test(platform) || /windows/i.test(ua)) return "windows";
  if (/mac/i.test(platform) || /macintosh/i.test(ua)) return "mac";
  if (/linux|cros|x11/i.test(p)) return "linux";
  return "other";
}

/** "chrome" | "edge" | "firefox" | "safari" | "other" (Chromium forks count as chrome). */
export function detectBrowser(nav = typeof navigator !== "undefined" ? navigator : null) {
  if (!nav) return "other";
  const ua = nav.userAgent || "";
  if (/Edg\//.test(ua)) return "edge";
  if (/Firefox\//.test(ua)) return "firefox";
  // Brave's user agent is Chrome's; navigator.brave gives it away. It has
  // WebUSB and Web Serial but ships with the File System Access API off.
  if (nav.brave && typeof nav.brave.isBrave === "function") return "brave";
  if (/Chrome\//.test(ua) || /Chromium\//.test(ua)) return "chrome";
  if (/Safari\//.test(ua)) return "safari";
  return "other";
}

/**
 * Whether a window is a page embedded from another origin than the top
 * page's: browsers open no file picker there, whatever the iframe allows. A
 * window object the embed runtime builds says so itself (crossOriginFrame).
 */
function isCrossOriginFrame(win) {
  if (!win || typeof win !== "object") return false;
  if (win.crossOriginFrame !== undefined) return Boolean(win.crossOriginFrame);
  if (!("top" in win) || !win.top || win.top === win) return false;
  try {
    return typeof win.top.location.href !== "string";
  } catch (e) {
    return true;
  }
}

/** What this browser can do: the panel shows download-only when none of it. */
export function capabilities(nav = typeof navigator !== "undefined" ? navigator : null, win = typeof window !== "undefined" ? window : null) {
  return {
    usb: !!(nav && nav.usb && typeof nav.usb.requestDevice === "function"),
    serial: !!(nav && nav.serial && typeof nav.serial.requestPort === "function"),
    fileSystem: !!(win && typeof win.showDirectoryPicker === "function"),
    // Chrome hides WebUSB, Web Serial and the folder picker off https and
    // localhost; a window without the flag (the Node mocks) counts as secure.
    secure: !win || win.isSecureContext !== false,
    crossOriginFrame: isCrossOriginFrame(win),
    os: detectOs(nav),
    browser: detectBrowser(nav),
  };
}

// ── Fix texts ───────────────────────────────────────────────────────

const ZADIG_STEPS = (deviceName) => [
  "Windows: open Zadig (zadig.akeo.ie) and tick Options > List All Devices.",
  `In Zadig, pick ${deviceName}, choose WinUSB and click Replace Driver.`,
  "Replug the board, then click Connect again.",
];

const UDEV_RULE = (vid, pid) => [
  `Linux: add SUBSYSTEM=="usb", ATTR{idVendor}=="${vid}", ATTR{idProduct}=="${pid}", MODE="0666", TAG+="uaccess" to /etc/udev/rules.d/70-webflash.rules.`,
  "Run sudo udevadm control --reload-rules && sudo udevadm trigger, then replug the board.",
];

const DIALOUT = [
  "Linux: run sudo usermod -a -G dialout $USER, then log out and back in.",
  "Stop anything else holding the port (Klipper, ModemManager).",
];

const GS_USB_UNBIND = [
  "Linux: run sudo ip link set can0 down.",
  "Run echo <name> | sudo tee /sys/bus/usb/drivers/gs_usb/unbind (<name> is listed in that folder, like 1-3:1.0).",
  "Replug the adapter after flashing.",
  "Stop a Klipper host that uses the same adapter.",
];

const BUSY_GENERIC = "Close other programs using the board (Klipper, a serial monitor, STM32CubeProgrammer, dfu-util, picotool), then click Connect again.";

const OTHER_TAB = "Close other tabs of this site.";

const SECURE_PAGE = "Open the page over HTTPS or from localhost.";

const EMBED_ALLOW = "Embedded in another site? Its iframe needs allow=\"usb; serial\".";

const UART_BAUD = "Over UART, Katapult must use the same baud rate as the firmware.";

const PICKER_NOTE ="Put the board in the right mode and plug it straight into this computer (not a hub).";

const DISCONNECTED_FIXES = [
  "Just flashed? Then the restart is expected: check that the board shows up as Klipper (or Katapult).",
  "Otherwise, put it back in its bootloader and connect again.",
  "Keeps dropping? Try another cable or USB port.",
];

// The device a fix names: a ROM bootloader in quotes as Zadig lists it, else a description.
function deviceLabel(method) {
  switch (method) {
    case "dfu": return "\"DFU in FS Mode\" or \"STM32 BOOTLOADER\"";
    case "picoboot": return "\"RP2 Boot (Interface 1)\"";
    case "katapult-can": return "candleLight USB to CAN adapter";
    default: return "the board";
  }
}

function vidPid(method) {
  switch (method) {
    case "dfu": return ["0483", "df11"];
    case "picoboot": return ["2e8a", "0003"];
    case "katapult-can": return ["1d50", "606f"];
    default: return ["1d50", "6177"];
  }
}

// ── The mapping ─────────────────────────────────────────────────────

/**
 * Turn any error into {code, title, message, fixes}. context names the
 * method ("dfu", "picoboot", "uf2", "katapult", "katapult-can"), the
 * transport ("usb", "serial", "filesystem"), optionally the firmware's
 * interface (iface: "usb", "serial", "can", "usbcan") and os and browser
 * (detected when absent).
 */
export function explainError(err, context = {}) {
  const os = context.os || detectOs();
  const browser = context.browser || detectBrowser();
  const method = context.method || "";
  const transport = context.transport || (method === "katapult" ? "serial" : method === "uf2" ? "filesystem" : "usb");
  const name = err && err.name ? String(err.name) : "";
  const raw = err && err.message ? String(err.message) : String(err || "unknown error");
  const label = deviceLabel(method);
  const [vid, pid] = vidPid(method);

  // Our own errors already carry a code and, usually, a fix.
  if (err instanceof FlashError || (err && typeof err.code === "string" && Array.isArray(err.fix))) {
    const fixes = err.fix.slice();
    switch (err.code) {
      case "claim-failed":
        fixes.push(...claimFixes(os, method, label, vid, pid, transport));
        break;
      case "no-api":
        fixes.push(...apiFixes(os, browser, transport));
        break;
      case "timeout":
        if (!fixes.length) fixes.push(
          "Reset the board into its bootloader and click Connect again.",
          "Still timing out? Try another USB cable or port (a charge-only cable has no data lines).",
        );
        // One baud serves Klipper's request and Katapult, as flashtool's -b does.
        if (method === "katapult" && context.iface === "serial") fixes.push(UART_BAUD);
        break;
      case "verify-failed":
        if (!fixes.length) fixes.push(
          "Flash again.",
          "Fails again? The flash may be worn or write-protected: download the file and use the vendor's flashing tool.",
        );
        break;
      case "wrong-mcu":
        if (!fixes.length) fixes.push(
          "Build the firmware for the micro-controller the board reports.",
          "Or connect the board this firmware was built for.",
        );
        break;
      case "read-protected":
        if (!fixes.length) fixes.push(
          "In STM32CubeProgrammer (over USB to the ROM bootloader, or with an ST-LINK), set RDP to level 0 (AA) under Option bytes; this erases the whole chip, Katapult included.",
          "Put the board back in its ROM bootloader (hold BOOT0, tap RESET) and flash again.",
        );
        break;
      case "wrong-family":
        if (fixes.length) break;
        if (method === "picoboot") {
          fixes.push(
            "Build or pick a firmware for the chip that is connected (RP2040 and RP2350 files differ).",
            "Or connect the board this firmware was built for.",
          );
        } else {
          fixes.push(
            "Build or pick a .uf2 for the chip the drive belongs to (an RP2040's drive is RPI-RP2, an RP2350's is RP2350).",
            "Or pick the drive of the board it was built for.",
          );
        }
        break;
      case "reenumeration":
        if (!fixes.length) fixes.push(
          "Put the board in its bootloader by hand: hold BOOT0 or BOOTSEL and tap RESET (double-tap RESET for Katapult).",
          "Click Connect and pick it.",
        );
        break;
      case "disconnected":
        // The serial and USB wrappers' own error for a board unplugged mid-step.
        if (!fixes.length) fixes.push(...DISCONNECTED_FIXES);
        break;
      case "busy":
        // The wrappers' error for a port another program or tab holds.
        if (!fixes.length) fixes.push(...busyFixes(os, transport, err.cause));
        break;
      case "permission":
        // The wrappers' error for a device the browser or the OS refuses.
        if (!fixes.length) fixes.push(...permissionFixes(os, transport, vid, pid));
        break;
      default:
        break;
    }
    // A wrapped browser error keeps the advice the browser's error itself
    // would get, when that advice is about the same thing.
    if (!fixes.length && err.cause && !(err.cause instanceof FlashError) && err.cause.name) {
      const inner = explainError(err.cause, { ...context, os, browser, method, transport });
      if (inner.code === err.code) fixes.push(...inner.fixes);
    }
    return { code: err.code, title: titleFor(err.code), message: err.message, fixes: dedupe(fixes) };
  }

  // The browser's errors.
  if (isCancel(err)) {
    return { code: "cancelled", title: "No device picked", message: "The device picker was closed without choosing a device.", fixes: [PICKER_NOTE] };
  }
  if (name === "SecurityError") {
    return {
      code: "permission",
      title: "The browser may not use this device",
      message: raw,
      fixes: permissionFixes(os, transport, vid, pid),
    };
  }
  if (name === "NetworkError" || /claim interface|Unable to claim|open serial port|Failed to open|LIBUSB_ERROR_ACCESS|LIBUSB_ERROR_BUSY|device busy|Access denied/i.test(raw)) {
    const claim = /claim/i.test(raw) || transport === "usb";
    return {
      code: claim ? "claim-failed" : "busy",
      title: claim ? titleFor("claim-failed") : "The port could not be opened",
      message: raw,
      fixes: dedupe(claim ? claimFixes(os, method, label, vid, pid, transport) : busyFixes(os, transport, err)),
    };
  }
  if (name === "NotFoundError" || /disconnected|Device unavailable|device was lost|has been lost/i.test(raw)) {
    return {
      code: "disconnected",
      title: "The device went away",
      message: raw,
      fixes: DISCONNECTED_FIXES.slice(),
    };
  }
  if (name === "AbortError") {
    return { code: "aborted", title: "Stopped", message: raw, fixes: ["Reset the board into its bootloader and start again."] };
  }
  if (name === "InvalidStateError" || /already open|An operation that changes interface state is in progress/i.test(raw)) {
    return {
      code: "busy",
      title: "The device is in use",
      message: raw,
      fixes: busyFixes(os, transport, err),
    };
  }
  return { code: "flash", title: "Flashing failed", message: raw, fixes: dedupe([
    transport === "usb" ? `Reset the board into its bootloader (${label}) and click Connect again.` : "Reset the board and click Connect again.",
  ]) };
}

function claimFixes(os, method, label, vid, pid, transport) {
  if (transport === "serial") return [...DIALOUT, BUSY_GENERIC];
  const fixes = [];
  if (os === "windows") {
    if (method === "katapult-can") {
      fixes.push("Windows: if the adapter has no WinUSB driver, install WinUSB on it with Zadig.");
    } else {
      fixes.push(...ZADIG_STEPS(label));
      if (method === "dfu") fixes.push("STM32CubeProgrammer installed? Replace its STTub30 driver with WinUSB in Zadig.");
    }
  } else if (os === "linux") {
    if (method === "katapult-can") fixes.push(...GS_USB_UNBIND);
    fixes.push(...UDEV_RULE(vid, pid));
    if (method === "dfu") fixes.push("Quit dfu-util or STM32CubeProgrammer.");
  } else if (os === "mac") {
    fixes.push("macOS needs no driver: quit the program holding the device (picotool, dfu-util, STM32CubeProgrammer, Klipper).");
  } else if (os === "android") {
    fixes.push("Android: accept the USB permission prompt; the board needs a USB OTG adapter.");
  }
  fixes.push(BUSY_GENERIC);
  return fixes;
}

function busyFixes(os, transport, cause) {
  // "The port is already open" is this page's own handle, not a permission.
  const msg = cause && cause.message ? String(cause.message) : "";
  const alreadyOpen = !!cause && (cause.name === "InvalidStateError" || /already open|interface state is in progress/i.test(msg));
  const fixes = [];
  if (transport === "serial" && os === "linux" && !alreadyOpen) fixes.push(...DIALOUT);
  fixes.push(BUSY_GENERIC, OTHER_TAB);
  return fixes;
}

function permissionFixes(os, transport, vid, pid) {
  if (transport === "serial") {
    // Chrome refuses a port with a SecurityError for the permissions policy
    // (an iframe without allow) or an insecure page, not for the OS's rules.
    const fixes = [EMBED_ALLOW, SECURE_PAGE];
    if (os === "linux") fixes.push(...DIALOUT);
    return fixes;
  }
  if (transport === "filesystem") {
    return [
      "Pick the drive's top folder (RPI-RP2 or RP2350) and allow editing.",
      "Or download the .uf2 and copy it onto the drive yourself.",
    ];
  }
  return [
    ...(os === "linux" ? UDEV_RULE(vid, pid) : [SECURE_PAGE]),
    EMBED_ALLOW,
  ];
}

function apiFixes(os, browser, transport) {
  const fixes = [];
  if (browser === "firefox" || browser === "safari") {
    fixes.push("Use Chrome or Edge: Firefox and Safari have no WebUSB or Web Serial.");
    fixes.push("Or download the files and flash them with dfu-util, picotool or Katapult's flashtool.py.");
  } else if (transport === "serial" && os === "android") {
    fixes.push("Android Chrome has no Web Serial: use DFU or PICOBOOT, or a computer.");
  } else if (transport === "filesystem" && browser === "brave") {
    fixes.push("Brave: enable brave://flags/#file-system-access-api and restart, or use Chrome or Edge.");
    fixes.push("Or download the .uf2 and copy it onto the drive yourself.");
  } else if (transport === "filesystem") {
    fixes.push("Download the .uf2 and copy it onto the drive yourself.");
  } else {
    fixes.push("Use Chrome or Edge on a computer, over HTTPS or from localhost.");
  }
  return fixes;
}

function titleFor(code) {
  switch (code) {
    case "no-api": return "This browser cannot flash";
    case "cancelled": return "No device picked";
    case "claim-failed": return "The browser could not claim the device";
    case "busy": return "The device is in use";
    case "permission": return "The browser may not use this device";
    case "disconnected": return "The device went away";
    case "timeout": return "The board did not answer";
    case "protocol": return "Unexpected answer from the board";
    case "wrong-mcu": return "Firmware for another micro-controller";
    case "wrong-family": return "Firmware for another chip";
    case "verify-failed": return "The verification failed";
    case "not-bootloader": return "Not in its bootloader";
    case "address": return "The firmware does not fit";
    case "read-protected": return "The chip is read-protected";
    case "drive": return "Not a BOOTSEL drive";
    case "reenumeration": return "The board did not restart into its bootloader";
    case "unsupported": return "Not supported";
    case "aborted": return "Stopped";
    default: return "Flashing failed";
  }
}

function dedupe(list) {
  return [...new Set(list.filter(Boolean))];
}
