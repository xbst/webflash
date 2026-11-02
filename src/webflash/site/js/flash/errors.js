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
  if (/Chrome\//.test(ua) || /Chromium\//.test(ua)) return "chrome";
  if (/Safari\//.test(ua)) return "safari";
  return "other";
}

/** What this browser can do: the panel shows download-only when none of it. */
export function capabilities(nav = typeof navigator !== "undefined" ? navigator : null, win = typeof window !== "undefined" ? window : null) {
  return {
    usb: !!(nav && nav.usb && typeof nav.usb.requestDevice === "function"),
    serial: !!(nav && nav.serial && typeof nav.serial.requestPort === "function"),
    fileSystem: !!(win && typeof win.showDirectoryPicker === "function"),
    os: detectOs(nav),
    browser: detectBrowser(nav),
  };
}

// ── Fix texts ───────────────────────────────────────────────────────

const ZADIG_STEPS = (deviceName) => [
  `On Windows, install the WinUSB driver for the device once with Zadig (zadig.akeo.ie): start Zadig, open Options and tick List All Devices, pick "${deviceName}" in the list, choose WinUSB as the driver and click Replace Driver (or Install Driver).`,
  "Unplug and replug the board, then click Connect again.",
];

const UDEV_RULE = (vid, pid) =>
  `On Linux, give your user access to the device with a udev rule, for example in /etc/udev/rules.d/70-webflash.rules: SUBSYSTEM=="usb", ATTR{idVendor}=="${vid}", ATTR{idProduct}=="${pid}", MODE="0666", TAG+="uaccess". Then run: sudo udevadm control --reload-rules && sudo udevadm trigger, and replug the board.`;

const DIALOUT = "On Linux, add your user to the dialout group (sudo usermod -a -G dialout $USER), log out and back in, and make sure no other program (Klipper, a serial monitor, ModemManager) holds the port.";

const GS_USB_UNBIND = [
  "On Linux the kernel's gs_usb driver claims the adapter, so the browser cannot. Take the CAN interface down and unbind the adapter first: sudo ip link set can0 down, then find the adapter under /sys/bus/usb/drivers/gs_usb/ (a name like 1-3:1.0) and run: echo 1-3:1.0 | sudo tee /sys/bus/usb/drivers/gs_usb/unbind. Replug the adapter when you are done to give it back to the kernel.",
  "A Klipper host running on the same adapter (klippy, can0 up) also keeps it busy: stop Klipper first, or use a laptop with no CAN setup.",
];

const BUSY_GENERIC = "Close any other program that is talking to the board: a Klipper host (stop klipper.service), a serial monitor, STM32CubeProgrammer, Arduino IDE, dfu-util or picotool. Then click Connect again.";

const PICKER_NOTE = "Make sure the board is in the right mode and is plugged straight into this computer (a USB hub can hide it); the picker only lists devices in that mode.";

function deviceLabel(method) {
  switch (method) {
    case "dfu": return "STM32 BOOTLOADER";
    case "picoboot": return "RP2 Boot (Interface 1)";
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
 * transport ("usb", "serial", "filesystem") and, optionally, os and browser
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
        if (!fixes.length) fixes.push("Reset the board into its bootloader again and click Connect; if it keeps timing out, try another USB cable or port (a charge-only cable has no data lines).");
        break;
      case "verify-failed":
        if (!fixes.length) fixes.push("Flash again. If the read-back differs a second time, the flash may be worn or write-protected; try the download and the vendor's flashing tool.");
        break;
      case "wrong-mcu":
        if (!fixes.length) fixes.push("Build the firmware for the micro-controller the board reports, or connect the board this firmware was built for.");
        break;
      case "reenumeration":
        if (!fixes.length) fixes.push("Put the board in its bootloader by hand (hold BOOT0 or BOOTSEL and tap RESET, or double-tap RESET for Katapult), then click Connect and pick it.");
        break;
      default:
        break;
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
      fixes: transport === "serial" ? [DIALOUT] : [
        os === "linux" ? UDEV_RULE(vid, pid) : "The page needs to be served over HTTPS or from localhost, and an embedded page needs allow=\"usb; serial\" on its iframe.",
        "If this page is embedded in another site, the embedding page must allow USB and serial access (the allow attribute of the iframe).",
      ],
    };
  }
  if (name === "NetworkError" || /claim interface|Unable to claim|open serial port|Failed to open|LIBUSB_ERROR_ACCESS|LIBUSB_ERROR_BUSY|device busy|Access denied/i.test(raw)) {
    const claim = /claim/i.test(raw) || transport === "usb";
    return {
      code: claim ? "claim-failed" : "busy",
      title: claim ? "The browser could not take over the device" : "The port could not be opened",
      message: raw,
      fixes: claim ? claimFixes(os, method, label, vid, pid, transport) : [transport === "serial" && os === "linux" ? DIALOUT : BUSY_GENERIC, BUSY_GENERIC],
    };
  }
  if (name === "NotFoundError" || /disconnected|Device unavailable|device was lost|has been lost/i.test(raw)) {
    return {
      code: "disconnected",
      title: "The device went away",
      message: raw,
      fixes: [
        "The board disconnected before the step finished. If it just restarted after a successful write, that is expected: check that it enumerates as Klipper (or Katapult) now.",
        "Otherwise put it back in its bootloader and click Connect again, with a different USB cable or port if it keeps dropping out.",
      ],
    };
  }
  if (name === "AbortError") {
    return { code: "aborted", title: "Stopped", message: raw, fixes: ["The transfer was stopped. Reset the board into its bootloader and start again."] };
  }
  if (name === "InvalidStateError" || /already open|An operation that changes interface state is in progress/i.test(raw)) {
    return {
      code: "busy",
      title: "The device is in use",
      message: raw,
      fixes: [BUSY_GENERIC, "Another tab of this site may hold the device: close it."],
    };
  }
  return { code: "flash", title: "Flashing failed", message: raw, fixes: dedupe([
    transport === "usb" ? `Reset the board into its bootloader (${label}) and click Connect again.` : "Reset the board and click Connect again.",
  ]) };
}

function claimFixes(os, method, label, vid, pid, transport) {
  if (transport === "serial") return [DIALOUT, BUSY_GENERIC];
  const fixes = [];
  if (os === "windows") {
    if (method === "katapult-can") {
      fixes.push("On Windows a candleLight adapter and a Klipper board in USB to CAN bridge mode install the WinUSB driver by themselves. If this one did not, use Zadig to put WinUSB on it (Options, List All Devices, pick the adapter, WinUSB, Replace Driver).");
    } else {
      fixes.push(...ZADIG_STEPS(label));
      if (method === "dfu") fixes.push("If STM32CubeProgrammer is installed, its STTub30 driver owns the DFU device and blocks the browser: Zadig replaces it with WinUSB (STM32CubeProgrammer still works through the WinUSB driver in its recent versions).");
    }
  } else if (os === "linux") {
    if (method === "katapult-can") fixes.push(...GS_USB_UNBIND);
    fixes.push(UDEV_RULE(vid, pid));
    if (method === "dfu") fixes.push("A running dfu-util or STM32CubeProgrammer also holds the device.");
  } else if (os === "mac") {
    fixes.push("On macOS nothing needs installing: another program holds the device. Quit it (picotool, dfu-util, STM32CubeProgrammer, a Klipper host) and click Connect again.");
  } else if (os === "android") {
    fixes.push("On Android, accept the USB permission prompt for the device; a USB OTG adapter is needed to plug the board in.");
  }
  fixes.push(BUSY_GENERIC);
  return fixes;
}

function apiFixes(os, browser, transport) {
  const fixes = [];
  if (browser === "firefox" || browser === "safari") {
    fixes.push("Flashing from the browser needs WebUSB and Web Serial, which Firefox and Safari do not have. Download the firmware here and flash it with Chrome or Edge, or with the usual tools (dfu-util, picotool, Katapult's flashtool.py).");
  } else if (transport === "serial" && os === "android") {
    fixes.push("Android Chrome has WebUSB but no Web Serial, so Katapult over USB cannot run here. Use DFU or PICOBOOT if the board has that bootloader, or a computer with Chrome or Edge.");
  } else if (transport === "filesystem") {
    fixes.push("This browser cannot write to a drive from a web page. Download the .uf2 and copy it onto the BOOTSEL drive yourself.");
  } else {
    fixes.push("Use Chrome or Edge on a computer; the page must be served over HTTPS or from localhost.");
  }
  return fixes;
}

function titleFor(code) {
  switch (code) {
    case "no-api": return "This browser cannot flash";
    case "cancelled": return "No device picked";
    case "claim-failed": return "The browser could not take over the device";
    case "busy": return "The device is in use";
    case "permission": return "The browser may not use this device";
    case "disconnected": return "The device went away";
    case "timeout": return "The board did not answer";
    case "protocol": return "The board answered with something unexpected";
    case "wrong-mcu": return "This firmware is for a different micro-controller";
    case "wrong-family": return "This firmware is for a different chip";
    case "verify-failed": return "The verification failed";
    case "not-bootloader": return "The device is not in its bootloader";
    case "address": return "The firmware does not fit the device's memory";
    case "read-protected": return "The chip is read-protected";
    case "drive": return "That is not a BOOTSEL drive";
    case "reenumeration": return "The board did not come back in its bootloader";
    case "unsupported": return "Not supported";
    case "aborted": return "Stopped";
    default: return "Flashing failed";
  }
}

function dedupe(list) {
  return [...new Set(list.filter(Boolean))];
}
