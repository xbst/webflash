// The site's Flash card: flash-ui.js wired to the session (SPEC 12).
//
// This is the one flash module that knows the site's state. The firmware
// comes, in this order of preference, from a file the user uploaded with
// the toolbar's Upload firmware, from session.build (chunk 06: the
// in-browser build's outputs), or from a [prebuilt] board TOML whose file
// was opened beside it. The methods come from the configuration
// (session.configText from chunk 05, else the TOML's defconfig) through
// devices.js's inferMethods, narrowed by the TOML's [flash].methods; a file
// with no configuration gets the methods its MCU or address allow.
//
// ?mock=<katapult|dfu|picoboot|can|uf2>[&fail=<knob>] installs scripted
// devices (mocks/install.js) so the whole panel runs without hardware.

import { createFlashPanel } from "./flash-ui.js";
import { parseFirmware, describe as describeImage, extractKlipperDict, fromBin } from "./firmware-file.js";
import { inferMethods, applyTomlMethods, methodsForPrebuilt, mcuOf, familyOf, imageAddressFor, configValue } from "./devices.js";
import { explainError } from "./errors.js";

/**
 * Mount the panel into root (the #flash-card element) for a Session. The
 * toolbar's Upload firmware button (uploadButton) is taken over. Returns
 * the panel API plus refresh().
 */
export async function mountFlashPanel(session, root, { uploadButton = null, showError = null } = {}) {
  let mocks = null;
  try {
    const params = new URLSearchParams(location.search);
    if (params.get("mock")) {
      const { installMocks } = await import("./mocks/install.js");
      mocks = await installMocks(params);
    }
  } catch (e) {
    console.error("The flash mocks could not be installed:", e);
  }

  const panel = createFlashPanel(root, { nav: mocks ? mocks.nav : null, win: mocks ? mocks.win : null });
  const state = { uploaded: null };   // {image, name, bytes}

  // ── Sources ─────────────────────────────────────────────────────
  function configText() {
    if (typeof session.configText === "string" && session.configText.trim()) return session.configText;
    const t = session.toml || {};
    return (t.config && typeof t.config.defconfig === "string") ? t.config.defconfig : "";
  }

  function tomlFlash() {
    const t = session.toml || {};
    const flash = t.flash && typeof t.flash === "object" ? t.flash : {};
    return {
      methods: Array.isArray(flash.methods) ? flash.methods : null,
      instructions: flash.instructions && typeof flash.instructions === "object" ? flash.instructions : null,
    };
  }

  function prebuiltTable() {
    const t = session.toml || {};
    return t.prebuilt && typeof t.prebuilt === "object" ? t.prebuilt : null;
  }

  /** The build's firmware (chunk 06's state.build), as a panel firmware, or null. */
  function fromBuild() {
    const b = session.build;
    if (!b || !b.outputs) return null;
    const outputs = b.outputs instanceof Map ? b.outputs : new Map(Object.entries(b.outputs));
    const project = b.project || session.project || "klipper";
    const cfg = b.config || configText();
    const names = [...outputs.keys()];
    const pick = (re) => names.find((n) => re.test(n));
    // Prefer the .bin at its address; else the .elf, the .uf2, the .hex.
    const binName = pick(/^(klipper|katapult)\.bin$/i) || pick(/\.bin$/i);
    const elfName = pick(/\.elf$/i);
    const uf2Name = pick(/\.uf2$/i);
    const hexName = pick(/\.hex$/i);
    let image = null;
    try {
      if (binName) image = parseFirmware(binName, outputs.get(binName), { address: b.appAddress ?? imageAddressFor(cfg, project, binName), source: "build" });
      else if (elfName) image = parseFirmware(elfName, outputs.get(elfName), { source: "build" });
      else if (uf2Name) image = parseFirmware(uf2Name, outputs.get(uf2Name), { source: "build" });
      else if (hexName) image = parseFirmware(hexName, outputs.get(hexName), { source: "build" });
    } catch (e) {
      panel.log(`The build's output could not be read: ${e.message}`);
      return null;
    }
    if (!image) return null;
    const mcu = b.mcu || mcuOf(cfg);
    const { methods, warnings } = applyTomlMethods(inferMethods(cfg, { project }), tomlFlash().methods);
    const artifacts = names.filter((n) => /\.(bin|uf2|elf|hex|dict|config)$/i.test(n) || n === ".config" || n === "defconfig")
      .map((n) => ({ name: n, bytes: outputs.get(n) }));
    return {
      image, methods, warnings, instructions: tomlFlash().instructions, mcu, project, family: familyOf(cfg), artifacts,
      source: "build", version: b.version || null, label: `${project} ${b.version || ""}`.trim(), bitrate: canBitrate(cfg),
    };
  }

  /** A [prebuilt] TOML whose file was opened beside it. */
  function fromPrebuilt() {
    const pre = prebuiltTable();
    if (!pre || typeof pre.file !== "string") return null;
    const bytes = session.fileFor ? session.fileFor(pre.file) : null;
    if (!bytes) return null;
    let image;
    try {
      image = parseFirmware(pre.file, bytes, { address: typeof pre.address === "number" ? pre.address : null, source: "upload" });
    } catch (e) {
      panel.log(`${pre.file}: ${e.message}`);
      return null;
    }
    const { methods, warnings } = methodsForPrebuilt({ mcu: pre.mcu || null, image, tomlMethods: tomlFlash().methods });
    return {
      image, methods, warnings, instructions: tomlFlash().instructions, mcu: pre.mcu || image.mcu || null, project: "klipper",
      family: null, artifacts: [{ name: pre.file.split(/[\\/]/).pop(), bytes }], source: "prebuilt", version: image.version, label: pre.file,
    };
  }

  function fromUpload() {
    const u = state.uploaded;
    if (!u) return null;
    const cfg = configText();
    const project = session.project || "klipper";
    const pre = prebuiltTable();
    let methods;
    let warnings = [];
    if (cfg && !pre) {
      // The uploaded file stands in for the build of this configuration.
      ({ methods, warnings } = applyTomlMethods(inferMethods(cfg, { project }), tomlFlash().methods));
      const cfgMcu = mcuOf(cfg);
      if (cfgMcu && u.image.mcu && cfgMcu.toLowerCase() !== u.image.mcu.toLowerCase()) {
        warnings = [...warnings, `The file says it is for the ${u.image.mcu}, but the configuration is for the ${cfgMcu}; the file's MCU is used.`];
      }
    } else {
      ({ methods, warnings } = methodsForPrebuilt({ mcu: (pre && pre.mcu) || u.image.mcu || null, image: u.image, tomlMethods: tomlFlash().methods }));
    }
    const mcu = u.image.mcu || (pre && pre.mcu) || (cfg ? mcuOf(cfg) : null);
    if (u.preferredMethod && !methods.some((m) => m.id === u.preferredMethod)) {
      // The mock mode asks for a method the configuration would not offer.
      methods = [{ id: u.preferredMethod, reason: "the mock mode asked for it" }, ...methods];
    }
    return {
      image: u.image, methods, warnings, instructions: tomlFlash().instructions, mcu, project,
      family: cfg ? familyOf(cfg) : null, artifacts: [{ name: u.name, bytes: u.bytes }], source: "upload", version: u.image.version,
      label: u.name, bitrate: canBitrate(cfg), preferredMethod: u.preferredMethod || null, onClear: () => { state.uploaded = null; refresh(); },
    };
  }

  function canBitrate(cfg) {
    const v = cfg ? configValue(cfg, "CANBUS_FREQUENCY") : null;
    const n = v ? parseInt(v, 10) : NaN;
    return Number.isInteger(n) && n > 0 ? n : 1000000;
  }

  function refresh() {
    const firmware = fromUpload() || fromBuild() || fromPrebuilt();
    panel.setFirmware(firmware);
  }

  // ── Upload firmware ─────────────────────────────────────────────
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".bin,.hex,.ihx,.uf2,.elf,application/octet-stream";
  input.hidden = true;
  document.body.appendChild(input);
  input.addEventListener("change", async () => {
    const file = input.files && input.files[0];
    input.value = "";
    if (!file) return;
    try {
      await useUploadedFile(file.name, new Uint8Array(await file.arrayBuffer()));
    } catch (e) {
      const ex = explainError(e, {});
      if (showError) showError("The file could not be used", `${file.name}: ${ex.message}`);
      else panel.log(`${file.name}: ${ex.message}`);
    }
  });

  async function useUploadedFile(name, bytes, { address: givenAddress = null, preferredMethod = null } = {}) {
    const cfg = configText();
    const pre = prebuiltTable();
    const project = session.project || "klipper";
    let image;
    const lower = name.toLowerCase();
    const isBin = !/\.(hex|ihx|ihex|uf2|elf)$/.test(lower) && !(bytes.length >= 4 && bytes[0] === 0x7f && bytes[1] === 0x45) &&
      !(bytes.length >= 512 && bytes[0] === 0x55 && bytes[1] === 0x46 && bytes[2] === 0x32 && bytes[3] === 0x0a);
    if (isBin) {
      let address = givenAddress;
      if (address === null) {
        address = pre && typeof pre.address === "number" ? pre.address : (cfg ? imageAddressFor(cfg, project, name) : null);
        address = await panel.askAddress(address, { name });
        if (address === null) return;
      }
      image = fromBin(bytes, address, { name, source: "upload" });
    } else {
      image = parseFirmware(name, bytes, { source: "upload" });
    }
    try {
      image.dict = await extractKlipperDict(image);
    } catch (e) {
      image.dict = null;
    }
    state.uploaded = { image, name, bytes, preferredMethod };
    refresh();
    const d = describeImage(image);
    panel.log(`Uploaded ${name}: ${d.rangeText}${image.mcu ? `, built for the ${image.mcu}` : ""}${image.version ? ` (${image.version})` : ""}`);
  }

  if (uploadButton) {
    uploadButton.disabled = false;
    uploadButton.title = "Flash a firmware file you already have (.bin, .hex, .uf2 or .elf)";
    uploadButton.addEventListener("click", () => input.click());
  }

  // ── Session changes ─────────────────────────────────────────────
  session.on("change", ({ what }) => {
    if (["toml", "project", "build", "config", "configText", "files"].includes(what)) refresh();
  });
  refresh();

  if (mocks && mocks.firmware) {
    // The mock mode also brings a firmware, so the whole flow runs from one URL.
    await useUploadedFile(mocks.firmware.name, mocks.firmware.bytes, { address: mocks.firmware.address ?? null, preferredMethod: mocks.method || null });
  }

  return { ...panel, refresh, useUploadedFile };
}
