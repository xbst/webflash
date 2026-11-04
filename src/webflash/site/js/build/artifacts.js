// A build's outputs: the files the Makefile made, under the names it gave
// them, plus .config and defconfig, as download buttons with their sizes; and
// the build result the flash panel reads (session.build).

import { esc, saveFile } from "../dialogs.js";
import { formatBytes } from "../configure/sources.js";

const hex = (n) => `0x${n.toString(16).padStart(8, "0")}`;

// The order the buttons come in: what gets flashed first, then what helps.
const ORDER = [
  [/^(klipper|katapult)\.bin$/i, 0], [/\.uf2$/i, 1], [/^deployer\.bin$/i, 2], [/\.bin$/i, 3],
  [/\.hex$/i, 4], [/\.elf$/i, 5], [/\.dict$/i, 6], [/^\.config$/, 8], [/^defconfig$/, 9],
];

function rank(name) {
  const hit = ORDER.find(([re]) => re.test(name));
  return hit ? hit[1] : 7;
}

/** What a file is, in a sentence, for its button's title. */
export function describeArtifact(name, build = {}) {
  if (/^deployer\.bin$/i.test(name)) {
    return "Katapult's deployer: run it from the bootloader already on the board to replace that bootloader with Katapult";
  }
  if (/\.withclear\.uf2$/i.test(name)) return "The UF2 that also erases the application, for a BOOTSEL drive";
  if (/\.bin$/i.test(name)) {
    return `The firmware image${Number.isFinite(build.appAddress) ? `, written at ${hex(build.appAddress)}` : ""}`;
  }
  if (/\.uf2$/i.test(name)) return "The firmware as a UF2, for a BOOTSEL drive";
  if (/\.hex$/i.test(name)) return "The firmware as Intel HEX";
  if (/\.elf$/i.test(name)) return "The linked ELF, with its symbols and debug information";
  if (/\.dict$/i.test(name)) return "The message dictionary the host software reads from the firmware";
  if (name === ".config") return "The full configuration, as make olddefconfig writes it";
  if (name === "defconfig") return "Only what differs from the defaults, as make savedefconfig writes it (a board TOML's [config])";
  return "A file the build made";
}

/** The outputs as [{name, size, title}], in download order. outputs: Map or object of name to bytes. */
export function artifactList(build) {
  const outputs = build.outputs instanceof Map ? build.outputs : new Map(Object.entries(build.outputs || {}));
  return [...outputs.entries()]
    .map(([name, bytes]) => ({ name, size: bytes ? bytes.length : 0, title: describeArtifact(name, build) }))
    .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}

const MIME = { ".bin": "application/octet-stream", ".uf2": "application/octet-stream", ".elf": "application/octet-stream", ".hex": "text/plain", ".dict": "application/json" };

function mimeOf(name) {
  const ext = Object.keys(MIME).find((e) => name.toLowerCase().endsWith(e));
  return ext ? MIME[ext] : "text/plain";
}

/**
 * Fill container with a download button per output. build is session.build;
 * stale says the configuration changed since (the buttons stay, labeled).
 */
export function renderArtifacts(container, build, { stale = false } = {}) {
  if (!build || !build.outputs) {
    container.replaceChildren();
    return;
  }
  const outputs = build.outputs instanceof Map ? build.outputs : new Map(Object.entries(build.outputs));
  const list = artifactList(build);
  container.innerHTML =
    `<div class="artifacts-head"><span>Files</span>` +
    (build.version ? `<span class="artifacts-version">${esc(build.version)}</span>` : "") +
    (stale ? `<span class="artifacts-stale" title="The configuration changed after this build: these files are from the earlier one.">earlier configuration</span>` : "") +
    `</div>` +
    `<div class="artifact-buttons">` +
    list.map((a, i) =>
      `<button type="button" class="artifact${i === 0 ? " primary" : ""}" data-name="${esc(a.name)}" title="${esc(`${a.title}. Click to download.`)}">` +
      `<span class="artifact-name">${esc(a.name)}</span><span class="artifact-size">${esc(formatBytes(a.size))}</span></button>`
    ).join("") +
    `</div>`;
  for (const btn of container.querySelectorAll(".artifact")) {
    btn.addEventListener("click", () => {
      const name = btn.dataset.name;
      const bytes = outputs.get(name);
      if (bytes) saveFile(bytes, name, mimeOf(name));
    });
  }
}

const REGION_NAMES = { rom: "Flash", flash: "Flash", ram: "RAM" };

/** The linker's memory table ({region: {used, size}}) as table rows, Flash and RAM first. */
export function renderMemory(table, memory) {
  const regions = memory ? Object.entries(memory) : [];
  table.hidden = !regions.length;
  if (!regions.length) {
    table.replaceChildren();
    return;
  }
  regions.sort(([a], [b]) => (REGION_NAMES[a] ? 0 : 1) - (REGION_NAMES[b] ? 0 : 1));
  table.innerHTML = `<caption>Memory</caption>` + regions.map(([region, { used, size }]) => {
    const pct = size > 0 ? Math.min(100, (100 * used) / size) : 0;
    const name = REGION_NAMES[region.toLowerCase()] || region;
    // Klipper's linker scripts put the stack at the end of RAM, so the
    // linker counts RAM up to its end: full is normal there, not a warning.
    const ram = name === "RAM";
    const title = ram ? "RAM as the linker counts it: up to the end of the stack, which the firmware places at the end of RAM"
      : `the linker script's ${region} region`;
    return `<tr><th scope="row" title="${esc(title)}">${esc(name)}</th>` +
      `<td class="mem-bar"><span class="mem-fill${ram ? " ram" : pct >= 90 ? " full" : ""}" style="width:${pct.toFixed(1)}%"></span></td>` +
      `<td class="mem-num">${esc(formatBytes(used))} of ${esc(formatBytes(size))}</td>` +
      `<td class="mem-pct">${pct < 1 && used > 0 ? "<1" : Math.round(pct)}%</td></tr>`;
  }).join("");
}

/**
 * The build result as the flash panel reads it (session.build):
 * {project, ref, version, config, outputs: Map<name, Uint8Array>,
 * appAddress, mcu} plus what else the engine reported. appAddress is where
 * the main .bin goes: CONFIG_FLASH_APPLICATION_ADDRESS for Klipper and
 * Kalico; for Katapult, whose FLASH_APPLICATION_ADDRESS is the deployer's,
 * CONFIG_FLASH_START, where katapult.bin goes.
 */
export function buildRecord(result, outputs, { project, ref }) {
  const proj = result.project || project;
  const appAddress = proj === "katapult" ? numberOrNull(result.flash_start) : numberOrNull(result.app_address);
  return {
    project: proj,
    ref,
    version: result.version || "",
    config: result.config || "",
    defconfig: result.defconfig || "",
    outputs,
    appAddress,
    mcu: result.mcu || "",
    bootAddress: numberOrNull(result.boot_address),
    flashStart: numberOrNull(result.flash_start),
    launchAppAddress: numberOrNull(result.launch_app_address),
    memory: result.memory || null,
    methods: result.methods || [],
    duration: Number(result.duration) || 0,
  };
}

/** The CONFIG_ lines of a .config, for telling whether two configurations differ. */
export function configKey(text) {
  return String(text || "").split(/\r?\n/).map((l) => l.trim())
    .filter((l) => /^(# )?CONFIG_/.test(l)).sort().join("\n");
}

/**
 * Whether a build record (buildRecord's) is a build of what the session
 * configures now: the same project, the same ref and the same .config. A
 * build that no longer matches is not flashed (the Build card keeps its
 * files, labeled as from an earlier configuration).
 */
export function buildMatches(session, build) {
  if (!session || !build) return false;
  return build.project === session.project && Boolean(session.ref) && build.ref === session.ref.id &&
    configKey(build.config) === configKey(session.configText);
}

function numberOrNull(v) {
  return Number.isFinite(v) ? v : null;
}
