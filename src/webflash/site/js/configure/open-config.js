// Open .config: a Klipper, Kalico or Katapult .config (or defconfig) as the
// start of a new board. One file configures that project; a firmware's and
// Katapult's together configure the firmware with Katapult beside it. What
// each file is for comes from its symbols (a full .config always tells); a
// short defconfig they cannot place is asked about, its name preselecting the
// answer.

import { defaultTables } from "../state.js";
import { esc, openModal } from "../dialogs.js";
import { checkConfigText } from "./configure-page.js";

// Symbols only Katapult defines (CanBoot was its name until 2023).
const KATAPULT_SYMBOL = /^(# )?CONFIG_(KATAPULT_VERSION|CANBOOT_VERSION|LAUNCH_APP_ADDRESS|BUILD_DEPLOYER|ENABLE_DOUBLE_RESET|ENABLE_BUTTON|ENABLE_LED|BLOCK_SIZE|STM32_APP_START_[0-9A-F]+)\b/m;

// Symbols only Klipper and Kalico define: the optional features, the GPIO
// capabilities and the architectures Katapult has no port for (not USBCANBUS:
// Katapult has it too, for its USB to CAN bridge mode).
const FIRMWARE_SYMBOL = /^(# )?CONFIG_(WANT_[A-Z0-9_]+|HAVE_GPIO[A-Z0-9_]*|HAVE_STRICT_TIMING|HAVE_BOOTLOADER_REQUEST|INLINE_STEPPER_HACK|NEED_SENSOR_BULK|MACH_AVR|MACH_LINUX|MACH_PRU|MACH_AR100|MACH_SIMU)\b/m;

// The build stamp a .config carries: the version of the tree that wrote it,
// not a setting.
const STAMP = /^CONFIG_(KATAPULT_VERSION|CANBOOT_VERSION)=/;

// The firmware a file's name names: "klipper", "kalico" or null.
function namedFirmware(name) {
  const n = String(name || "").toLowerCase();
  return /kalico|danger/.test(n) ? "kalico" : /klipper/.test(n) ? "klipper" : null;
}

/**
 * The project a file's name names: "katapult", "klipper", "kalico", or null.
 * A name that mentions a firmware and Katapult ("klipper_for_canboot") is as
 * often a firmware's file named after its bootloader: it names nothing.
 */
export function nameHint(name) {
  const katapult = /katapult|canboot|deployer/.test(String(name || "").toLowerCase());
  const firmware = namedFirmware(name);
  return katapult && firmware ? null : katapult ? "katapult" : firmware;
}

/**
 * Which project a .config is for: "katapult", "klipper", "kalico",
 * "firmware" (Klipper or Kalico; the symbols cannot tell them apart) or null
 * when its symbols do not say. The name never decides alone: it only tells
 * Klipper from Kalico once the symbols say firmware.
 */
export function classifyConfig(text, name = "") {
  const t = String(text || "");
  const katapult = KATAPULT_SYMBOL.test(t);
  const firmware = FIRMWARE_SYMBOL.test(t);
  if (katapult && !firmware) return "katapult";
  if (firmware && !katapult) return namedFirmware(name) || "firmware";
  return null;
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
 * The files sortConfigs left to the reader, placed by asking: one file is
 * asked which project it is for; of two, the reader picks Katapult's, and
 * the other (the firmware's) is asked Klipper or Kalico unless its name
 * says. Resolves to {firmware, katapult}, {error}, or null when cancelled.
 * asks: the questions ({project, katapult}), replaceable for tests.
 */
export async function placeConfigs(sorted, { project: askProject = askConfigProject, katapult: askKatapult = askKatapultFile } = {}) {
  let { firmware, katapult } = sorted;
  const [first, second] = sorted.ask;
  if (second) {
    // Preselected: the one file whose name names Katapult, else the other
    // of the one whose name names a firmware.
    const hints = sorted.ask.map((f) => nameHint(f.name));
    const firmwares = hints.filter((h) => h && h !== "katapult");
    const named = hints.filter((h) => h === "katapult").length === 1 ? hints.indexOf("katapult")
      : firmwares.length === 1 ? 1 - hints.indexOf(firmwares[0]) : null;
    const which = await askKatapult(first.name, second.name, { preselect: named });
    if (which === null) return null;
    if (which === "neither") {
      return { error: `${first.name}, ${second.name}: both are firmware configurations; open one, or a firmware's with Katapult's.` };
    }
    katapult = { ...sorted.ask[which] };
    const fw = sorted.ask[1 - which];
    const project = namedFirmware(fw.name) || await askProject(fw.name, { katapult: false });
    if (!project) return null;
    firmware = { ...fw, project };
  } else if (first) {
    const project = await askProject(first.name, { preselect: nameHint(first.name) });
    if (!project) return null;
    if (project === "katapult") katapult = { ...first };
    else firmware = { ...first, project };
  }
  return { firmware, katapult };
}

/**
 * Ask which project a .config is for, when its symbols do not say (katapult:
 * false offers Klipper and Kalico only, for the firmware's file of a pair;
 * preselect: the answer its name suggests). Resolves to "klipper", "kalico",
 * "katapult", or null when cancelled.
 */
export function askConfigProject(name, { katapult = true, preselect = null } = {}) {
  return new Promise((resolve) => {
    const { body, close, onClose } = openModal(katapult ? "Which firmware is this .config for?" : "Klipper or Kalico?");
    let answer = null;
    onClose(() => resolve(answer));
    body.innerHTML =
      (katapult
        ? `<p><code>${esc(name)}</code> sets nothing that only Klipper or only Katapult has. Pick the project it was made with.</p>`
        : `<p>Pick the firmware <code>${esc(name)}</code> was made for.</p>`) +
      `<div class="modal-actions"><button data-project="klipper">Klipper</button><button data-project="kalico">Kalico</button>` +
      (katapult ? `<button data-project="katapult">Katapult</button>` : "") +
      `<span class="gen-spacer"></span><button data-project="">Cancel</button></div>`;
    for (const b of body.querySelectorAll("[data-project]")) {
      b.addEventListener("click", () => {
        answer = b.dataset.project || null;
        close();
      });
    }
    const pick = body.querySelector(`[data-project=${preselect || "klipper"}]`) || body.querySelector("[data-project=klipper]");
    if (preselect) pick.classList.add("primary");
    pick.focus();
  });
}

/**
 * Ask which of two .configs is Katapult's, when neither one's symbols say
 * (preselect: the file, 0 or 1, the names suggest). Resolves to 0 or 1 (a
 * file), "neither", or null when cancelled.
 */
export function askKatapultFile(a, b, { preselect = null } = {}) {
  return new Promise((resolve) => {
    const { body, close, onClose } = openModal("Which is Katapult's?");
    let answer = null;
    onClose(() => resolve(answer));
    body.innerHTML =
      `<p>Neither <code>${esc(a)}</code> nor <code>${esc(b)}</code> sets anything that only Klipper or only Katapult has. Pick Katapult's; the other is the firmware's.</p>` +
      `<div class="modal-actions"><button data-file="0">${esc(a)}</button><button data-file="1">${esc(b)}</button>` +
      `<button data-file="neither">Neither</button><span class="gen-spacer"></span><button data-file="">Cancel</button></div>`;
    for (const btn of body.querySelectorAll("[data-file]")) {
      btn.addEventListener("click", () => {
        const f = btn.dataset.file;
        answer = f === "" ? null : f === "neither" ? f : Number(f);
        close();
      });
    }
    const pick = body.querySelector(`[data-file='${preselect === 1 ? 1 : 0}']`);
    if (preselect !== null) pick.classList.add("primary");
    pick.focus();
  });
}
