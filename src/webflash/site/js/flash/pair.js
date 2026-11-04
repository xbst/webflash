// Katapult and the firmware as one flash (SPEC 4.2 and 4.3): the site's
// Flash step (flash-panel.js) and a generated page's card
// (js/embed/embed-model.js) both make their firmware here, from the two
// builds (build/artifacts.js's buildRecord, one per engine slot).
//
// The image holds two segments: katapult.bin at Katapult's flash start and
// the firmware's .bin at its application address. The chip's ROM methods
// (DFU, PICOBOOT, the UF2 drive) write both in one session; Katapult's own
// methods write the firmware alone (appImage), since Katapult refuses an
// image that does not start at the application.
//
// Needs no DOM: it is tested under Node.

import { FirmwareImage, fromBin, formatSize, hex8 } from "./firmware-file.js";
import { applyTomlMethods, familyOf, imageAddressFor, inferMethods, interfaceOf, mcuOf, configValue, serialBaud } from "./devices.js";
import { FlashError } from "./errors.js";

const TITLES = { klipper: "Klipper", kalico: "Kalico", katapult: "Katapult" };

/** A project's name as the page shows it. */
export function projectName(project) {
  return TITLES[project] || project || "the firmware";
}

// The methods that write the whole flash from the chip's ROM, so both images.
export const ROM_METHODS = new Set(["dfu", "picoboot", "uf2"]);
// The methods that talk to Katapult on the board, so the firmware alone.
export const KATAPULT_METHODS = new Set(["katapult", "katapult-can"]);

function outputsOf(build) {
  return build.outputs instanceof Map ? build.outputs : new Map(Object.entries(build.outputs || {}));
}

// The .bin a build flashes: katapult.bin or klipper.bin (Kalico's is
// klipper.bin too), else the first .bin that is not Katapult's deployer.
function binOf(outputs, project) {
  const names = [...outputs.keys()];
  const own = project === "katapult" ? /^katapult\.bin$/i : /^klipper\.bin$/i;
  return names.find((n) => own.test(n)) || names.find((n) => /\.bin$/i.test(n) && !/deployer/i.test(n)) || null;
}

function canBitrate(cfg) {
  const v = cfg ? configValue(cfg, "CANBUS_FREQUENCY") : null;
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isInteger(n) && n > 0 ? n : 1000000;
}

/**
 * One firmware for the flash panel (flash-ui.js's setFirmware) from builds
 * ({fw, katapult}, each a buildRecord) and options {methods (the TOML's
 * [flash] or the setup's methods, or null), instructions (the TOML's
 * [flash.instructions], or null)}. Throws a FlashError (code "address") with
 * a sentence when Katapult runs past the firmware's application address.
 */
export function firmwareFromPair(builds, { methods: tomlMethods = null, instructions = null } = {}) {
  const k = builds && builds.katapult;
  const f = builds && builds.fw;
  if (!k || !f) throw new Error("firmwareFromPair needs a Katapult build and a firmware build");
  const kOut = outputsOf(k);
  const fOut = outputsOf(f);
  const kName = binOf(kOut, "katapult");
  const fName = binOf(fOut, f.project);
  const title = projectName(f.project);
  if (!kName || !fName) {
    throw new FlashError(`The builds lack ${!kName ? "katapult.bin" : `${title}'s .bin`}, so they cannot be flashed together.`, { code: "format" });
  }
  const kAddr = Number.isFinite(k.appAddress) ? k.appAddress : imageAddressFor(k.config || "", "katapult", kName);
  const fAddr = Number.isFinite(f.appAddress) ? f.appAddress : imageAddressFor(f.config || "", f.project, fName);
  const kBytes = kOut.get(kName);
  const fBytes = fOut.get(fName);
  if (fAddr <= kAddr) {
    throw new FlashError(`${title} starts at ${hex8(fAddr)}, where Katapult goes: give ${title} a bootloader offset.`, { code: "address" });
  }
  if (kAddr + kBytes.length > fAddr) {
    throw new FlashError(`Katapult (${formatSize(kBytes.length)}) runs past ${hex8(fAddr)}, where ${title} starts: pick a larger application offset in Katapult.`, { code: "address" });
  }
  const kImage = fromBin(kBytes, kAddr, { name: kName, source: "build" });
  const appImage = fromBin(fBytes, fAddr, { name: fName, source: "build" });
  const image = new FirmwareImage({
    segments: [...kImage.segments, ...appImage.segments],
    source: "build", name: `${f.project}-with-katapult.bin`, format: "bin",
  });
  const cfg = f.config || "";
  const parts = [
    { slot: "katapult", project: "katapult", title: "Katapult", name: kName, address: kAddr, size: kBytes.length },
    { slot: "fw", project: f.project, title, name: fName, address: fAddr, size: fBytes.length },
  ];

  // The ROM methods Katapult's configuration allows write both; the
  // firmware's Katapult methods write the firmware alone.
  const rom = inferMethods(k.config || "", { project: "katapult" })
    .filter((m) => ROM_METHODS.has(m.id))
    .map((m) => ({ id: m.id, reason: `the chip's ROM bootloader writes Katapult and ${title} in one go`, both: true }));
  const viaKatapult = inferMethods(cfg, { project: f.project })
    .filter((m) => KATAPULT_METHODS.has(m.id))
    .map((m) => ({ ...m, appOnly: true }));
  const inferred = [...rom, ...viaKatapult, { id: "download", reason: "the files for any other tool" }];
  const { methods, warnings } = applyTomlMethods(inferred, tomlMethods);

  const artifacts = [];
  for (const [build, outputs] of [[k, kOut], [f, fOut]]) {
    const who = projectName(build.project);
    for (const [name, bytes] of outputs) {
      if (!(/\.(bin|uf2|elf|hex|dict)$/i.test(name) || name === ".config" || name === "defconfig")) continue;
      // .config and defconfig come from both builds: Katapult's are saved under its name.
      const plain = name === ".config" || name === "defconfig";
      artifacts.push({
        name, bytes, project: build.project,
        label: plain ? `${who} ${name}` : name,
        saveAs: plain && build.project === "katapult" ? `katapult${name === ".config" ? ".config" : ".defconfig"}` : name,
      });
    }
  }

  return {
    image, appImage, parts, pair: true, methods, warnings, instructions,
    mcu: f.mcu || mcuOf(cfg), project: f.project, family: familyOf(cfg), iface: interfaceOf(cfg), artifacts,
    source: "build", version: f.version || null, label: `Katapult and ${title}`,
    bitrate: canBitrate(cfg), baud: interfaceOf(cfg) === "serial" ? serialBaud(cfg) : undefined,
  };
}

/**
 * The image a method writes: the firmware alone for Katapult's methods on a
 * pair (Katapult is already on the board then), else the whole image.
 */
export function imageForMethod(firmware, method) {
  if (!firmware) return null;
  return firmware.appImage && KATAPULT_METHODS.has(method) ? firmware.appImage : firmware.image;
}

/**
 * What a method writes, as rows for the Flash step: [{title, name, address,
 * size}]. A pair lists Katapult and the firmware (the firmware alone for
 * Katapult's methods); any other firmware is one row per segment.
 */
export function writesFor(firmware, method) {
  if (!firmware) return [];
  if (firmware.parts) {
    return KATAPULT_METHODS.has(method) && firmware.appImage ? firmware.parts.filter((p) => p.slot !== "katapult") : firmware.parts;
  }
  const image = firmware.image;
  // A build is named by its project, an uploaded or prebuilt file by its name.
  const title = firmware.source === "build" && firmware.project ? projectName(firmware.project) : firmware.label || image.name || "Firmware";
  return image.segments.map((s, i) => ({
    title: image.segments.length > 1 ? `${title} (part ${i + 1})` : title,
    name: image.name || "", address: s.address, size: s.data.length,
  }));
}
