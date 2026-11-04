// Open .config: a Klipper, Kalico or Katapult .config (or defconfig) as the
// start of a new board. One file configures that project; a firmware's and
// Katapult's together configure the firmware with Katapult beside it. What
// each file is for comes from its symbols (a full .config always tells), else
// from its name; a short defconfig that names neither is asked about.

import { defaultTables } from "../state.js";
import { esc, openModal } from "../dialogs.js";
import { checkConfigText } from "./configure-page.js";

// Symbols only Katapult defines (CanBoot was its name until 2023).
const KATAPULT_SYMBOL = /^CONFIG_(KATAPULT_VERSION|CANBOOT_VERSION|LAUNCH_APP_ADDRESS|BUILD_DEPLOYER|ENABLE_DOUBLE_RESET|ENABLE_BUTTON|ENABLE_LED|BLOCK_SIZE|STM32_APP_START_[0-9A-F]+)\b/m;

// Symbols only Klipper and Kalico define: the optional features, the GPIO
// capabilities and the architectures Katapult has no port for.
const FIRMWARE_SYMBOL = /^(# )?CONFIG_(WANT_[A-Z0-9_]+|HAVE_GPIO[A-Z0-9_]*|HAVE_STRICT_TIMING|HAVE_BOOTLOADER_REQUEST|INLINE_STEPPER_HACK|NEED_SENSOR_BULK|USBCANBUS|MACH_AVR|MACH_LINUX|MACH_PRU|MACH_AR100|MACH_SIMU)\b/m;

// The build stamp a .config carries: the version of the tree that wrote it,
// not a setting.
const STAMP = /^CONFIG_(KATAPULT_VERSION|CANBOOT_VERSION)=/;

/**
 * Which project a .config is for, from its text and file name: "katapult",
 * "klipper", "kalico", "firmware" (Klipper or Kalico; the symbols cannot
 * tell them apart) or null when neither says.
 */
export function classifyConfig(text, name = "") {
  const t = String(text || "");
  const katapult = KATAPULT_SYMBOL.test(t);
  const firmware = FIRMWARE_SYMBOL.test(t);
  const n = String(name || "").toLowerCase();
  // A name that mentions a firmware and Katapult ("klipper_for_canboot") is
  // as often a firmware's file named after its bootloader: it decides nothing.
  const namedKatapult = /katapult|canboot|deployer/.test(n);
  const namedFirmware = /kalico|danger/.test(n) ? "kalico" : /klipper/.test(n) ? "klipper" : null;
  const named = namedKatapult && namedFirmware ? null : namedKatapult ? "katapult" : namedFirmware;
  if (katapult && !firmware) return "katapult";
  if (firmware && !katapult) return namedFirmware || "firmware";
  return katapult && firmware ? null : named;
}

/**
 * A .config's settings as a defconfig holds them: its CONFIG_ lines and
 * "# CONFIG_X is not set" lines, LF, without the comments and the build stamp.
 */
export function configLines(text) {
  const out = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (STAMP.test(line)) continue;
    if (/^CONFIG_[A-Za-z0-9_]+=/.test(line)) out.push(line);
    else if (/^#\s*CONFIG_[A-Za-z0-9_]+ is not set$/.test(line)) out.push(line.replace(/^#\s*/, "# "));
  }
  return out.length ? `${out.join("\n")}\n` : "";
}

/**
 * What a set of opened files configures: {firmware: {name, text} or null,
 * katapult: {name, text} or null, ask: [{name, text}] (files that need the
 * reader to say which project they are for)}, or {error} when the files
 * cannot be one configuration. files: [{name, text}]; kinds: what
 * classifyConfig said for each.
 */
export function sortConfigs(files, kinds = files.map((f) => classifyConfig(f.text, f.name))) {
  if (!files.length) return { error: "Pick a .config file." };
  if (files.length > 2) {
    return { error: `${files.map((f) => f.name).join(", ")}: open one .config, or a firmware's and Katapult's together.` };
  }
  for (const f of files) {
    const bad = checkConfigText(f.text);
    if (bad.length) {
      return { error: `${f.name}: this is not a .config (CONFIG_NAME=value, or # CONFIG_NAME is not set):\n${bad.slice(0, 5).join("\n")}` };
    }
    if (!configLines(f.text)) return { error: `${f.name}: this file has no CONFIG_ lines.` };
  }
  let firmware = null;
  let katapult = null;
  const ask = [];
  for (const [i, f] of files.entries()) {
    const kind = kinds[i];
    if ((kind === "katapult" && katapult) || (kind && kind !== "katapult" && firmware)) {
      const both = kind === "katapult" ? "Katapult" : "firmware";
      return { error: `${files.map((x) => x.name).join(", ")}: both are ${both} configurations; open one, or a firmware's with Katapult's.` };
    }
    if (kind === "katapult") katapult = { ...f };
    else if (kind) firmware = { ...f, project: kind === "firmware" ? null : kind };
    else ask.push(f);
  }
  // Two files, one of them known: the other is the other project's.
  if (files.length === 2 && ask.length === 1) {
    const [f] = ask;
    if (firmware) katapult = { ...f };
    else firmware = { ...f, project: null };
    return { firmware, katapult, ask: [] };
  }
  return { firmware, katapult, ask };
}

/**
 * The tables of a new board built from the opened configurations: the
 * firmware's project (project: "klipper" or "kalico") with Katapult beside it
 * when katapult is given, or Katapult alone. version and katapultVersion are
 * the versions to load (page 1's).
 */
export function configTables({ project, firmwareText = null, katapultText = null, version = "latest", katapultVersion = "latest" }) {
  const t = defaultTables();
  if (firmwareText === null) {
    t.firmware = { project: "katapult", projects: ["katapult"], version: katapultVersion, versions: "all" };
    t.setups[0].defconfig = configLines(katapultText);
    return t;
  }
  t.firmware = { project, projects: [project], version, versions: "all" };
  t.setups[0].defconfig = configLines(firmwareText);
  if (katapultText !== null) {
    t.katapult = { version: katapultVersion, versions: "all", default: true };
    t.setups[0].katapult = configLines(katapultText);
  }
  return t;
}

/**
 * Ask which project a .config is for, when neither its symbols nor its name
 * say. Resolves to "klipper", "kalico", "katapult", or null when cancelled.
 */
export function askConfigProject(name) {
  return new Promise((resolve) => {
    const { body, close, onClose } = openModal("Which firmware is this .config for?");
    let answer = null;
    onClose(() => resolve(answer));
    body.innerHTML =
      `<p><code>${esc(name)}</code> sets nothing that only Klipper or only Katapult has. Pick the project it was made with.</p>` +
      `<div class="modal-actions"><button data-project="klipper">Klipper</button><button data-project="kalico">Kalico</button>` +
      `<button data-project="katapult">Katapult</button><span class="gen-spacer"></span><button data-project="">Cancel</button></div>`;
    for (const b of body.querySelectorAll("[data-project]")) {
      b.addEventListener("click", () => {
        answer = b.dataset.project || null;
        close();
      });
    }
    body.querySelector("[data-project=klipper]").focus();
  });
}
