// The setups editor's table work, without the DOM: what adding, retitling,
// describing, removing and reordering a setup does to the board TOML's
// tables (board_data's shape: setups, options, katapult), and the summary
// line each setup's row shows. Every function takes the tables and returns
// the fields that change, for session.setSetups, or {error} when the change
// would make a TOML the loader refuses.
//
// Ids: a setup made here, and the one setup of a [config] TOML, has an id
// that follows its title (setupIdFor); an id an opened TOML gave stays as it
// is. [[option]] setups lists follow every rename and removal.

import { CONFIG_SETUP_ID, asConfigTable } from "../toml-io.js";
import { PROJECT_TITLES } from "../state.js";

const ID_MAX = 32;

/** A setup id from a title: lowercase words joined by "-", at most 32 characters. */
export function slugify(title) {
  const words = String(title || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/).filter(Boolean);
  let id = "";
  for (const w of words) {
    const next = id ? `${id}-${w}` : w;
    if (next.length > ID_MAX) {
      if (!id) id = w.slice(0, ID_MAX);
      break;
    }
    id = next;
  }
  return id;
}

/** base, or base-2, base-3, ... : the first not in taken. */
export function uniqueId(base, taken) {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** Whether a setup's id follows its title: one made here or a [config] TOML's. */
export function isAutoId(setup) {
  const id = setup.id || CONFIG_SETUP_ID;
  return id === CONFIG_SETUP_ID || /^setup-\d+$/.test(id) || id === slugify(setup.title);
}

/** The id a setup titled title gets, unique among the other setups. */
export function setupIdFor(title, others) {
  return uniqueId(slugify(title) || "setup", others.map((s) => s.id));
}

const copySetups = (setups) => setups.map((s) => ({ ...s, methods: s.methods ? [...s.methods] : null }));
const copyOptions = (options) => options.map((o) => ({ ...o, labels: { ...o.labels }, setups: o.setups ? [...o.setups] : null }));

// [[option]] setups after the setups changed: ids renamed (rename: old ->
// new), ids gone dropped, a list naming every setup made null (all). An
// option left with no setup is dropped; dropped lists their symbols.
function fixOptions(options, setups, rename = {}) {
  const ids = setups.map((s) => s.id);
  const dropped = [];
  const out = [];
  for (const o of options) {
    if (!o.setups) {
      out.push(o);
      continue;
    }
    const list = [...new Set(o.setups.map((id) => rename[id] || id).filter((id) => ids.includes(id)))];
    if (!list.length) {
      dropped.push(o.symbol);
      continue;
    }
    out.push({ ...o, setups: list.length === ids.length && ids.length > 1 ? null : list });
  }
  return { options: out, dropped };
}

/** The setups' labels: the title, else "Setup N". */
export function setupTitle(setup, i) {
  return setup.title || `Setup ${i + 1}`;
}

function nextNumber(setups) {
  const used = new Set(setups.map((s) => (/^Setup (\d+)$/.exec(s.title || "") || [])[1]).filter(Boolean).map(Number));
  let n = setups.length + 1;
  while (used.has(n)) n++;
  return n;
}

/**
 * "+ Add the current configuration": a copy of the setup Configure edits
 * (index selected), appended and selected. A lone untitled setup is titled
 * "Setup 1" first, since every setup of several needs a title. An option
 * limited to the copied setup applies to the copy too.
 */
export function addSetup(tables, selected, { title = "" } = {}) {
  let setups = copySetups(tables.setups);
  let options = copyOptions(tables.options);
  const rename = {};
  if (setups.length === 1 && !setups[0].title) {
    const first = setups[0];
    const id = isAutoId(first) ? "setup-1" : first.id;
    if (id !== first.id) rename[first.id] = id;
    setups[0] = { ...first, id, title: "Setup 1" };
  }
  const source = setups[Math.max(0, Math.min(selected, setups.length - 1))];
  const name = String(title).trim() || `Setup ${nextNumber(setups)}`;
  const copy = {
    ...source,
    id: setupIdFor(name, setups),
    title: name,
    description: "",
    methods: source.methods ? [...source.methods] : null,
  };
  const sourceId = source.id;
  setups = [...setups, copy];
  options = options.map((o) => {
    if (!o.setups) return o;
    const list = o.setups.map((id) => rename[id] || id);
    return { ...o, setups: list.includes(sourceId) ? [...list, copy.id] : list };
  });
  return { setups, options: fixOptions(options, setups).options, selected: setups.length - 1 };
}

/**
 * A new title for setup i; its id follows when it is one made here. Empty
 * is allowed only for a lone setup that then fits a [config] table again.
 */
export function retitleSetup(tables, i, title) {
  const setups = copySetups(tables.setups);
  const s = setups[i];
  if (!s) return { error: "No such setup." };
  const t = String(title).trim();
  if (t === s.title) return {};
  const rename = {};
  let id = s.id;
  if (!t) {
    if (setups.length > 1 || s.description || s.methods) return { error: "A setup needs a title." };
    if (isAutoId(s)) id = CONFIG_SETUP_ID;
  } else if (isAutoId(s)) {
    id = setupIdFor(t, setups.filter((_, k) => k !== i));
  }
  if (id !== s.id) rename[s.id] = id;
  setups[i] = { ...s, id, title: t };
  return { setups, options: fixOptions(copyOptions(tables.options), setups, rename).options };
}

/** A new description for setup i (a description needs a title). */
export function describeSetup(tables, i, description) {
  const setups = copySetups(tables.setups);
  const s = setups[i];
  if (!s) return { error: "No such setup." };
  const d = String(description).trim();
  if (d === s.description) return {};
  if (d && !s.title) return { error: "Give it a title first." };
  setups[i] = { ...s, description: d };
  return { setups };
}

/**
 * Remove setup i (never the last one). Options that applied to it alone go
 * with it (dropped names them), and [katapult] once no setup has Katapult.
 * selected: the index Configure edits, which follows.
 */
export function removeSetup(tables, i, selected) {
  if (tables.setups.length < 2) return { error: "A board TOML keeps at least one setup." };
  if (!tables.setups[i]) return { error: "No such setup." };
  const setups = copySetups(tables.setups).filter((_, k) => k !== i);
  const { options, dropped } = fixOptions(copyOptions(tables.options), setups);
  const katapult = setups.some((s) => typeof s.katapult === "string") ? tables.katapult : null;
  let next = selected;
  if (i < selected) next = selected - 1;
  else if (i === selected) next = Math.min(i, setups.length - 1);
  return { setups, options, katapult, selected: next, dropped };
}

/** Move setup i to index j; the selected index follows its setup. */
export function moveSetup(tables, i, j, selected) {
  const n = tables.setups.length;
  if (i < 0 || i >= n || j < 0 || j >= n || i === j) return {};
  const setups = copySetups(tables.setups);
  const [s] = setups.splice(i, 1);
  setups.splice(j, 0, s);
  let next = selected;
  if (selected === i) next = j;
  else if (i < selected && j >= selected) next = selected - 1;
  else if (i > selected && j <= selected) next = selected + 1;
  return { setups, selected: next };
}

/** Setup i's own flashing methods (null: [flash] methods). */
export function setSetupMethods(tables, i, methods) {
  const setups = copySetups(tables.setups);
  if (!setups[i]) return { error: "No such setup." };
  setups[i] = { ...setups[i], methods: methods && methods.length ? [...methods] : null };
  return { setups };
}

/** Whether the writers would write these setups as one [config] table. */
export function writesConfig(tables) {
  return asConfigTable(tables.setups_form, tables.setups);
}

// ── The summary line ─────────────────────────────────────────────────

const pins = (a, b) => (a && b ? ` ${a.replace(/_/g, ".")}/${b.replace(/_/g, ".")}` : "");

/**
 * The interface a .config (or defconfig) picks, as a few words: "CAN
 * PB0/PB1", "USB to CAN bridge", "USB PA11/PA12", "Serial USART2"; "" when
 * the text does not say (a defconfig that keeps the default).
 */
export function interfaceOf(configText) {
  const on = new Set();
  const values = {};
  for (const line of String(configText || "").split("\n")) {
    const m = /^CONFIG_([A-Za-z0-9_]+)=(.*)$/.exec(line.trim());
    if (!m || m[1].startsWith("HAVE_")) continue;
    if (m[2] === "y") on.add(m[1]);
    else values[m[1]] = m[2];
  }
  const names = [...on];
  const find = (re) => names.map((n) => re.exec(n)).find(Boolean);
  let m = find(/^(?:STM32|RPXXXX|LPC)_USBCANBUS(?:_(P[A-Z]\d+)_(P[A-Z]\d+))?/);
  if (m) return "USB to CAN bridge";
  m = find(/^STM32_(?:[MC]MENU_)?CANBUS_(P[A-Z]\d+)_(P[A-Z]\d+)/);
  if (m) return `CAN${pins(m[1], m[2])}`;
  if (on.has("RPXXXX_CANBUS")) {
    const rx = values.RPXXXX_CANBUS_GPIO_RX;
    const tx = values.RPXXXX_CANBUS_GPIO_TX;
    return rx && tx ? `CAN gpio${rx}/gpio${tx}` : "CAN";
  }
  m = find(/^LPC_CANBUS_(P\d+_\d+)_(P\d+_\d+)/);
  if (m) return `CAN${pins(m[1], m[2])}`;
  m = find(/^(?:STM32|RPXXXX|LPC|SAM\w*|HC32\w*)_USB(?:_(P[A-Z]\d+)_(P[A-Z]\d+))?(?:_REMAP)?$/);
  if (m) return `USB${pins(m[1], m[2])}`;
  m = find(/^\w+_SERIAL_(US?ART\d+|UART\d+)/);
  if (m) return `Serial ${m[1]}`;
  return "";
}

/**
 * The bootloader offset a firmware .config (or defconfig) picks: "8 KiB
 * offset", "no bootloader", or "" when the text does not say.
 */
export function offsetOf(configText) {
  const m = /^CONFIG_(STM32|RPXXXX|LPC)_FLASH_START_([0-9A-Fa-f]+)=y$/m.exec(String(configText || ""));
  if (!m) return "";
  const bytes = parseInt(m[2], 16);
  // RP2040/RP2350's 0x100 is the boot2 stage, not a bootloader.
  if (!bytes || (m[1] === "RPXXXX" && bytes <= 0x100)) return "no bootloader";
  return bytes % 1024 ? `${bytes} byte offset` : `${bytes / 1024} KiB offset`;
}

/**
 * The line under a setup's title: "Klipper + Katapult · CAN PB0/PB1 · 8 KiB
 * offset · 1 reader option". config: the setup's full .config when known
 * (else its defconfig is read), project: [firmware] project.
 */
export function setupSummary(setup, { project, options = [], config = null } = {}) {
  const text = config || setup.defconfig;
  const parts = [];
  const name = PROJECT_TITLES[project] || project || "";
  parts.push(typeof setup.katapult === "string" ? `${name} + Katapult` : name);
  const iface = interfaceOf(text);
  if (iface) parts.push(iface);
  const offset = offsetOf(text);
  if (offset) parts.push(offset);
  const n = options.filter((o) => !o.setups || o.setups.includes(setup.id)).length;
  if (n) parts.push(`${n} reader option${n === 1 ? "" : "s"}`);
  if (setup.methods) parts.push(`methods: ${setup.methods.join(", ")}`);
  return parts.filter(Boolean).join(" · ");
}
