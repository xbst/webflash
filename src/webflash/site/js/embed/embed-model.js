// What a generated page's card knows without the DOM or the engine: the
// page's configuration (the #webflash-config JSON the renderer wrote), how
// each exposed option reads from the board TOML before the configuration
// loads and from the Kconfig tree after, the defconfig a reader's choices
// make, the TOML "Open in WebFlash" carries, what the frame may use, and the
// firmware the flash panel gets. node --test runs it from a staged copy of
// /engine/v1/, where these imports resolve.

import { writeBoardToml } from "./toml-io.js";
import { applyTomlMethods, configFromImage, familyOf, imageAddressFor, inferMethods, interfaceOf, mcuOf, methodsForPrebuilt, parseConfig, serialBaud } from "./flash/devices.js";
import { parseFirmware } from "./flash/firmware-file.js";

/** The configuration schema this runtime reads (renderer.CONFIG_SCHEMA). */
export const SCHEMA = 1;

// ── The page's configuration ─────────────────────────────────────────

const isObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/**
 * The #webflash-config text as {config} (every table present, with the
 * shapes board_data gives them) or {error} for the card to show; newer is
 * true when the page was made for a later runtime than this one.
 */
export function readConfig(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { error: "This page's configuration is not valid JSON, so the card cannot start." };
  }
  if (!isObject(data)) return { error: "This page carries no board configuration." };
  if (data.schema !== SCHEMA) {
    const newer = Number.isInteger(data.schema) && data.schema > SCHEMA;
    return {
      newer,
      error: newer
        ? `This page was made by a newer WebFlash (configuration schema ${data.schema}) than the runtime it loaded, which reads schema ${SCHEMA}. Generate it again, or load the runtime its version names.`
        : `This page's configuration has schema ${JSON.stringify(data.schema)}, which this runtime does not read (it reads schema ${SCHEMA}).`,
    };
  }
  if (!isObject(data.board) || typeof data.board.title !== "string") {
    return { error: "This page's configuration has no [board] table." };
  }
  const firmware = isObject(data.firmware) ? data.firmware : null;
  const flash = isObject(data.flash) ? data.flash : {};
  const katapult = firmware && isObject(data.katapult) ? data.katapult : null;
  const str = (v) => (typeof v === "string" ? v : "");
  const setups = firmware && Array.isArray(data.setups) ? data.setups.filter(isObject).map((s, i) => ({
    id: typeof s.id === "string" && s.id ? s.id : (i ? `setup-${i + 1}` : "default"),
    title: str(s.title),
    description: str(s.description),
    defconfig: str(s.defconfig),
    katapult: typeof s.katapult === "string" ? s.katapult : null,
    methods: Array.isArray(s.methods) ? s.methods : null,
  })) : [];
  if (firmware && !setups.length) return { error: "This page's configuration has no setup to build." };
  const config = {
    schema: SCHEMA,
    board: { description: "", image: "", theme: "default", theme_dir: "./themes", engine_url: "", ...data.board },
    firmware: firmware ? {
      project: firmware.project,
      projects: Array.isArray(firmware.projects) && firmware.projects.length ? firmware.projects : [firmware.project],
      version: firmware.version || "latest",
      versions: firmware.versions === undefined ? "all" : firmware.versions,
    } : null,
    katapult: katapult ? {
      version: katapult.version || "latest",
      versions: katapult.versions === undefined ? "all" : katapult.versions,
      default: katapult.default !== false,
    } : null,
    setups,
    setups_form: firmware ? (data.setups_form === "setup" ? "setup" : "config") : null,
    options: firmware && Array.isArray(data.options) ? data.options.filter((o) => isObject(o) && typeof o.symbol === "string").map((o) => ({
      symbol: o.symbol,
      label: o.label || "",
      values: Array.isArray(o.values) ? o.values.map(String) : null,
      labels: isObject(o.labels) ? { ...o.labels } : {},
      help: o.help || "",
      setups: Array.isArray(o.setups) ? o.setups.map(String) : null,
    })) : [],
    flash: {
      methods: Array.isArray(flash.methods) ? flash.methods : null,
      instructions: isObject(flash.instructions) ? flash.instructions : {},
    },
    prebuilt: !firmware && isObject(data.prebuilt) ? data.prebuilt : null,
    toml: typeof data.toml === "string" ? data.toml : "",
    inline: isObject(data.inline) ? data.inline : {},
  };
  if (!config.firmware && !config.prebuilt) return { error: "This page's configuration names neither a firmware to build nor a file to flash." };
  return { config };
}

/** The card's behavior switches, from the data-* attributes the renderer writes on it. */
export function behaviorOf(dataset) {
  const flag = (v, fallback) => (v === "true" ? true : v === "false" ? false : fallback);
  return {
    showLog: flag(dataset.showLog, false),
    showImage: flag(dataset.showImage, true),
    compact: flag(dataset.compact, false),
    showVersions: flag(dataset.showVersions, true),
    confirmFlash: flag(dataset.confirmFlash, true),
  };
}

// ── Exposed options ──────────────────────────────────────────────────

// A choice is exposed by one of its members, and its values are members: the
// site's Embed options tab writes the selected member as the option's symbol
// and keeps it among the values offered.
const choiceLike = (option) => Array.isArray(option.values) && option.values.includes(option.symbol);

const sameValue = (a, b) => a === b || (a !== null && b !== null && String(a).toLowerCase() === String(b).toLowerCase());

function rawValue(map, symbol) {
  const v = map.get(`CONFIG_${symbol}`);
  if (v === true) return "y";
  if (v === false) return "n";
  return v === undefined ? null : String(v);
}

/**
 * An option as the board TOML and its defconfig describe it, before the
 * configuration loads: {symbol, label, kind, values: [{value, label}],
 * current, known}. kind is "choice" (one member of a choice), "values" (a
 * value from the TOML's list) or "free" (no list: the Kconfig says what may
 * go there, so it is read-only until the configuration loads). current is
 * null when only the Kconfig knows it (a default the defconfig leaves out).
 */
export function optionModel(option, defconfig) {
  const map = parseConfig(defconfig || "");
  const labelOf = (v) => option.labels[v] || v;
  const base = { symbol: option.symbol, label: option.label || option.symbol };
  if (choiceLike(option)) {
    const named = option.values.find((v) => map.get(`CONFIG_${v}`) === true);
    return {
      ...base, kind: "choice", values: option.values.map((v) => ({ value: v, label: labelOf(v) })),
      current: named || option.symbol, known: Boolean(named),
    };
  }
  const raw = rawValue(map, option.symbol);
  if (Array.isArray(option.values)) {
    const values = option.values.map((v) => ({ value: v, label: labelOf(v) }));
    const hit = raw === null ? null : values.find((v) => sameValue(v.value, raw));
    if (raw !== null && !hit) values.unshift({ value: raw, label: labelOf(raw) });
    return { ...base, kind: "values", values, current: hit ? hit.value : raw, known: raw !== null };
  }
  return { ...base, kind: "free", values: [], current: raw, known: raw !== null };
}

function treeNodes(tree) {
  return Object.values((tree && tree.nodes) || {});
}

/**
 * An option as the loaded Kconfig tree has it: {symbol, label, kind, set,
 * values: [{value, label}], current, type, range, enabled, note, help}.
 * kind is "choice", "bool", "values" (a value from the TOML's list), "input"
 * (int, hex or string) or "missing" (not in this version); set is what
 * kconfig_set takes for it (a choice's node id, else the symbol). An option
 * the reader cannot change now is disabled with a note saying why.
 */
export function liveOption(option, tree) {
  const nodes = treeNodes(tree);
  const labelOf = (v, fallback) => option.labels[v] || fallback || v;
  const prefer = (list) => list.find((n) => n.visible) || list[0] || null;
  const choice = prefer(nodes.filter((n) => n.kind === "choice" && (n.members || []).some((m) => m.name === option.symbol)));
  const state = (node) => {
    if (!node.visible) return { enabled: false, note: "Not available with the settings above." };
    if (node.editable === false) return { enabled: false, note: "Set by another setting." };
    return { enabled: true, note: "" };
  };
  if (choice) {
    const members = choice.members || [];
    const shown = members.filter((m) => m.visible);
    let offered = Array.isArray(option.values)
      ? option.values.map((v) => shown.find((m) => m.name === v)).filter(Boolean)
      : shown;
    const current = choice.value || null;
    if (current && !offered.some((m) => m.name === current)) {
      const m = members.find((x) => x.name === current);
      offered = [m || { name: current, prompt: current }, ...offered];
    }
    const st = state(choice);
    if (st.enabled && !offered.length) Object.assign(st, { enabled: false, note: "None of its choices is available with the settings above." });
    return {
      symbol: option.symbol, label: option.label || choice.prompt || option.symbol, kind: "choice", set: choice.id,
      values: offered.map((m) => ({ value: m.name, label: labelOf(m.name, m.prompt) })),
      current, type: null, range: null, ...st, help: choice.help || "",
    };
  }
  const node = prefer(nodes.filter((n) => n.kind === "symbol" && n.name === option.symbol));
  if (!node) {
    return {
      symbol: option.symbol, label: option.label || option.symbol, kind: "missing", set: option.symbol, values: [],
      current: null, type: null, range: null, enabled: false, note: "Not in this version.", help: "",
    };
  }
  const current = node.value === null || node.value === undefined ? null : String(node.value);
  const base = {
    symbol: option.symbol, label: option.label || node.prompt || option.symbol, set: option.symbol, current,
    type: node.type || null, range: node.range || null, ...state(node), help: node.help || "",
  };
  if (Array.isArray(option.values)) {
    const values = option.values.map((v) => ({ value: v, label: labelOf(v) }));
    const hit = current === null ? null : values.find((v) => sameValue(v.value, current));
    if (current !== null && current !== "" && !hit) values.unshift({ value: current, label: labelOf(current) });
    return { ...base, kind: "values", values, current: hit ? hit.value : current };
  }
  if (node.type === "bool" || node.type === "tristate") return { ...base, kind: "bool", values: [] };
  return { ...base, kind: "input", values: [] };
}

/** Whether a value is what an option has already (hex and case aside). */
export function isCurrent(model, value) {
  return model.current !== null && sameValue(model.current, value);
}

// ── The reader's choices as a configuration ──────────────────────────

const numberLike = (value) => /^-?\d+$/.test(value) || /^0[xX][0-9a-fA-F]+$/.test(value);

function configLine(symbol, value, { string = false } = {}) {
  if (!string) {
    if (value === "y") return `CONFIG_${symbol}=y`;
    if (value === "n") return `# CONFIG_${symbol} is not set`;
    if (numberLike(value)) return `CONFIG_${symbol}=${value}`;
  }
  return `CONFIG_${symbol}="${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Whether an option's symbol is a string one, as far as can be told before
 * the configuration loads: the defconfig assigns it a quoted value, or the
 * option offers a value no bool, int or hex symbol takes. (The TOML's value
 * types cannot tell: both writers write an integer as a string.) The engine
 * ignores an unquoted value for a string symbol.
 */
function isStringOption(option, lines) {
  const quoted = new RegExp(`^\\s*CONFIG_${option.symbol}="`);
  if (lines.some((l) => quoted.test(l))) return true;
  return Array.isArray(option.values) && option.values.some((v) => !/^[ynm]$/.test(String(v)) && !numberLike(String(v)));
}

/**
 * A defconfig with the reader's choices (choices: Map of option symbol to
 * value) made before the configuration loaded: a choice's members the
 * options offer are replaced by the one picked, any other symbol's line by
 * its new value. The engine reads it with olddefconfig's rules, as the
 * site's Open does.
 */
export function applyChoices(defconfig, options, choices) {
  let lines = String(defconfig || "").replace(/\r\n?/g, "\n").split("\n").filter((l) => l.trim());
  for (const option of options) {
    if (!choices.has(option.symbol)) continue;
    const value = String(choices.get(option.symbol));
    const names = choiceLike(option) ? option.values : [option.symbol];
    const string = !choiceLike(option) && isStringOption(option, lines);
    const drop = new RegExp(`^\\s*(?:CONFIG_(?:${names.join("|")})=|#\\s*CONFIG_(?:${names.join("|")}) is not set\\s*$)`);
    lines = lines.filter((l) => !drop.test(l));
    lines.push(choiceLike(option) ? `CONFIG_${value}=y` : configLine(option.symbol, value, { string }));
  }
  return lines.length ? `${lines.join("\n")}\n` : "";
}

/**
 * The TOML "Open in WebFlash" carries: the page's own text while the reader
 * changed nothing (comments and all, as the fallback's link has it), else
 * one written from the tables with the reader's project, version and
 * defconfig.
 */
export function linkToml(config, { changed = false, project = null, version = null, defconfig = null } = {}) {
  if (!config.firmware || (!changed && config.toml)) return config.toml;
  // The card configures the first setup.
  const [first, ...rest] = config.setups;
  return writeBoardToml({
    board: config.board,
    firmware: { ...config.firmware, project: project || config.firmware.project, version: version || config.firmware.version },
    katapult: config.katapult,
    setups: [{ ...first, defconfig: defconfig === null ? first.defconfig : defconfig }, ...rest],
    setups_form: config.setups_form,
    options: config.options,
    flash: config.flash,
    prebuilt: null,
  });
}

// ── What the frame may do ────────────────────────────────────────────

/**
 * What this frame may use for flashing: {usb, serial, picker, crossOrigin}.
 * The embedding page's permissions policy decides usb and serial (a frame
 * from another origin needs allow="usb; serial" on its iframe); a file
 * picker (the UF2 drive) never opens in a frame from another origin than
 * the top page's.
 */
export function framePermissions(doc, win) {
  const policy = doc.permissionsPolicy || doc.featurePolicy;
  const allows = (feature) => {
    try {
      return !policy || typeof policy.allowsFeature !== "function" || policy.allowsFeature(feature);
    } catch (e) {
      return true;
    }
  };
  let crossOrigin = false;
  try {
    crossOrigin = win.top !== win && typeof win.top.location.href !== "string";
  } catch (e) {
    crossOrigin = true;
  }
  return { usb: allows("usb"), serial: allows("serial"), picker: !crossOrigin, crossOrigin };
}

/**
 * The navigator and window the flash panel gets when the frame may not use
 * everything the browser has: copies without what is not allowed, so the
 * panel offers downloads there instead of failing at the device picker.
 * {nav: null, win: null} when nothing is withheld (the panel's defaults).
 */
export function platformFor(nav, win, perms) {
  const hasUsb = Boolean(nav && nav.usb);
  const hasSerial = Boolean(nav && nav.serial);
  const hasPicker = Boolean(win && typeof win.showDirectoryPicker === "function");
  if ((perms.usb || !hasUsb) && (perms.serial || !hasSerial) && (perms.picker || !hasPicker)) return { nav: null, win: null };
  return {
    nav: {
      usb: perms.usb ? nav.usb : undefined,
      serial: perms.serial ? nav.serial : undefined,
      userAgent: nav.userAgent,
      platform: nav.platform,
      userAgentData: nav.userAgentData,
      brave: nav.brave,
    },
    win: {
      showDirectoryPicker: perms.picker && hasPicker ? win.showDirectoryPicker.bind(win) : undefined,
      isSecureContext: win.isSecureContext,
      crossOriginFrame: Boolean(perms.crossOrigin),
    },
  };
}

const escHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The notice for what the embedding page does not let the card use (perms,
 * framePermissions'), as HTML, or null when it withholds nothing this
 * browser has. It names what is not offered here: with USB or serial ports
 * still allowed, the methods on them still flash from the card. href is
 * the card's own page, which a tab of its own can open.
 */
export function frameNotice(perms, nav, href) {
  const usbBlocked = !perms.usb && Boolean(nav && nav.usb);
  const serialBlocked = !perms.serial && Boolean(nav && nav.serial);
  if (!usbBlocked && !serialBlocked) return null;
  const own = `<a href="${escHtml(href)}" target="_blank" rel="noopener">open this card in a tab of its own</a>`;
  const allow = `(The site can allow it with <code>allow="usb; serial"</code> on the embed.)`;
  const usable = (perms.usb && nav.usb) || (perms.serial && nav.serial);
  if (!usable) {
    const blocked = [usbBlocked ? "USB" : "", serialBlocked ? "serial ports" : ""].filter(Boolean).join(" or ");
    return `<p>The page this card is embedded in does not let it use ${blocked}, so it cannot flash from here. ` +
      `Build and download the files, or ${own}. ${allow}</p>`;
  }
  if (serialBlocked) {
    return `<p>The page this card is embedded in does not let it use serial ports, so Katapult over a USB or UART serial port is not offered here; ` +
      `the USB methods (DFU, PICOBOOT, Katapult through a CAN adapter) still work. For a serial port, ${own}. ${allow}</p>`;
  }
  return `<p>The page this card is embedded in does not let it use USB, so DFU, PICOBOOT and CAN adapters are not offered here; ` +
    `Katapult over a serial port still works. For the others, ${own}. ${allow}</p>`;
}

// ── The firmware the flash panel gets ────────────────────────────────

function canBitrate(cfg) {
  const v = cfg ? parseConfig(cfg).get("CONFIG_CANBUS_FREQUENCY") : undefined;
  const n = typeof v === "string" ? parseInt(v, 10) : NaN;
  return Number.isInteger(n) && n > 0 ? n : 1000000;
}

/** The UART's baud for a configuration that talks serial, else undefined, as flash-panel.js gives it. */
function uartBaud(cfg) {
  return cfg && interfaceOf(cfg) === "serial" ? serialBaud(cfg) : undefined;
}

const baseName = (path) => String(path).split(/[\\/]/).pop();

/**
 * A build (artifacts.js's buildRecord) as the flash panel's firmware, the
 * way the site's flash-panel.js makes it: the .bin at its address (else the
 * .elf, the .uf2 or the .hex), the methods the .config allows narrowed by
 * the TOML's [flash] methods, every output as a download.
 */
export function firmwareFromBuild(build, config) {
  const outputs = build.outputs instanceof Map ? build.outputs : new Map(Object.entries(build.outputs || {}));
  const project = build.project || (config.firmware && config.firmware.project) || "klipper";
  const cfg = build.config || "";
  const names = [...outputs.keys()];
  const pick = (re) => names.find((n) => re.test(n));
  const binName = pick(/^(klipper|katapult)\.bin$/i) || pick(/\.bin$/i);
  const elfName = pick(/\.elf$/i);
  const uf2Name = pick(/\.uf2$/i);
  const hexName = pick(/\.hex$/i);
  let image = null;
  if (binName) image = parseFirmware(binName, outputs.get(binName), { address: build.appAddress ?? imageAddressFor(cfg, project, binName), source: "build" });
  else if (elfName) image = parseFirmware(elfName, outputs.get(elfName), { source: "build" });
  else if (uf2Name) image = parseFirmware(uf2Name, outputs.get(uf2Name), { source: "build" });
  else if (hexName) image = parseFirmware(hexName, outputs.get(hexName), { source: "build" });
  if (!image) return null;
  // The first setup's methods, which the card builds, else [flash]'s.
  const setup = (config.setups || [])[0];
  const tomlMethods = setup && setup.methods ? setup.methods : config.flash.methods;
  const { methods, warnings } = applyTomlMethods(inferMethods(cfg, { project }), tomlMethods);
  const artifacts = names.filter((n) => /\.(bin|uf2|elf|hex|dict)$/i.test(n) || n === ".config" || n === "defconfig")
    .map((n) => ({ name: n, bytes: outputs.get(n) }));
  return {
    image, methods, warnings, instructions: config.flash.instructions, mcu: build.mcu || mcuOf(cfg), project,
    family: familyOf(cfg), iface: interfaceOf(cfg), artifacts, source: "build", version: build.version || null,
    label: `${project} ${build.version || ""}`.trim(), bitrate: canBitrate(cfg), baud: uartBaud(cfg),
  };
}

/**
 * A [prebuilt] board's file as the flash panel's firmware: the methods its
 * MCU (the TOML's mcu, else the file's own) allows, narrowed by [flash]
 * methods. image is parseFirmware's, with its Klipper dictionary read when
 * it has one.
 */
export function firmwareFromPrebuilt(config, image, bytes) {
  const pre = config.prebuilt;
  const { methods, warnings } = methodsForPrebuilt({ mcu: pre.mcu || null, image, tomlMethods: config.flash.methods });
  const dictCfg = configFromImage(image);
  return {
    image, methods, warnings, instructions: config.flash.instructions, mcu: pre.mcu || image.mcu || null, project: "klipper",
    family: dictCfg ? familyOf(dictCfg) : null, iface: dictCfg ? interfaceOf(dictCfg) : null,
    artifacts: [{ name: baseName(pre.file), bytes }], source: "prebuilt", version: image.version || null, label: baseName(pre.file),
    baud: uartBaud(dictCfg),
  };
}
