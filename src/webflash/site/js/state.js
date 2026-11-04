// The session: what the site is configuring, building and flashing.
//
// It holds the board TOML's tables in the shape webflash's board_data returns
// ([board], [firmware], [katapult], setups (from [config] or [[setup]]) with
// setups_form, [[option]], [flash], [prebuilt]); the site configures one
// setup at a time (setupIndex, the Setup select; the first by default):
// they are what Save TOML writes, and the TOML text is derived from them
// (tomlText, the same text as bridge.save_toml for the same tables). Opening a
// TOML replaces them; the Configure, Embed options and toolbar controls
// change them. Beside the tables it holds the configure session: the sources
// index, the ref being configured, the full .config and the Kconfig tree the
// engine reports, the build plan, the files opened beside the TOML (its image
// and firmware file, which Generate embeds with -i), and whether a build has
// configuring locked.
//
// Every change is announced as a "change" event whose detail names what
// changed ({what, origin}); what is one of board, firmware, project,
// version, config, options, flash, prebuilt, toml, files, index, ref, tree,
// plan, sources, lock, undo, open, setup (another setup picked, or the
// picked one's defconfigs replaced), setups (the list of setups changed),
// katapult (Katapult ticked, unticked or its
// version changed) and katapult-<part> (its engine side: ref, tree, config,
// plan, sources, link). Undo and redo cover the tables (and the TOML's name
// and files), Katapult's version and defconfig among them; a "restore" event
// tells the configure code to load the restored defconfigs into the engine.

import { parseToml, writeBoardToml, CONFIG_SETUP_ID, DEFAULT_ENGINE_URL } from "./toml-io.js";

export const PROJECTS = ["klipper", "kalico", "katapult"];
export const PROJECT_TITLES = { klipper: "Klipper", kalico: "Kalico", katapult: "Katapult" };
// The flashing methods, in the order webflash's config.METHODS lists them.
// The versions that follow new snapshots rather than pin a ref.
const PINLESS = ["latest", "release"];
export const METHODS = ["dfu", "picoboot", "uf2", "katapult", "katapult-can", "download"];

const UNDO_LIMIT = 100;

// What a fresh session configures: Klipper's latest version for an STM32G0B1,
// the shape of the boards WebFlash was written for, with the low-level
// options shown (the clock, the USB ids, the CAN bus speed).
export const STARTER_DEFCONFIG = "CONFIG_LOW_LEVEL_OPTIONS=y\nCONFIG_MACH_STM32=y\nCONFIG_MACH_STM32G0B1=y\n";

// The engine's side of Katapult beside the firmware (session.katapult), before
// the engine has loaded it.
function freshKatapultEngine() {
  return {
    ref: null, configText: "", tree: null, plan: null,
    sources: { state: "idle", detail: "" },
    link: null,     // the offset link (bridge pair answers' offset), while paired
    notes: [],      // what the last paired change could not copy into the other tree
  };
}

export function defaultTables() {
  return {
    board: {
      title: "My board", description: "", image: "", theme: "default",
      theme_dir: "./themes", engine_url: DEFAULT_ENGINE_URL,
    },
    firmware: { project: "klipper", projects: ["klipper"], version: "latest", versions: "all" },
    katapult: null,
    setups: [newSetup({ defconfig: STARTER_DEFCONFIG })],
    setups_form: "config",
    options: [],
    flash: { methods: null, instructions: {} },
    prebuilt: null,
  };
}

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** One setup as board_data gives it ({id, title, description, defconfig, katapult, methods}). */
export function newSetup(s = {}) {
  return {
    id: s.id || CONFIG_SETUP_ID,
    title: s.title || "",
    description: s.description || "",
    defconfig: s.defconfig || "",
    katapult: typeof s.katapult === "string" ? s.katapult : null,
    methods: Array.isArray(s.methods) ? [...s.methods] : null,
  };
}

/**
 * The tables of a board TOML as board_data gives them, every key present. A
 * [config] table given as config: {defconfig, katapult} (the shape before
 * setups) is read as the one setup.
 */
export function normalizeTables(t) {
  const d = defaultTables();
  const board = { ...d.board, ...(t.board || {}) };
  const firmware = t.firmware ? {
    project: t.firmware.project,
    projects: t.firmware.projects && t.firmware.projects.length ? [...t.firmware.projects] : [t.firmware.project],
    version: t.firmware.version || "latest",
    versions: t.firmware.versions === undefined ? "all" : clone(t.firmware.versions),
  } : null;
  const katapult = firmware && t.katapult ? {
    version: t.katapult.version || "latest",
    versions: t.katapult.versions === undefined ? "all" : clone(t.katapult.versions),
    default: t.katapult.default !== false,
  } : null;
  let setups = [];
  if (firmware) {
    if (Array.isArray(t.setups) && t.setups.length) setups = t.setups.map(newSetup);
    else setups = [newSetup(t.config || {})];
  }
  return {
    board,
    firmware,
    katapult,
    setups,
    setups_form: firmware ? (t.setups_form === "setup" ? "setup" : "config") : null,
    options: firmware ? (t.options || []).map((o) => ({
      symbol: o.symbol,
      label: o.label || "",
      values: o.values === undefined || o.values === null ? null : o.values.map(String),
      labels: { ...(o.labels || {}) },
      help: o.help || "",
      setups: Array.isArray(o.setups) ? [...o.setups] : null,
    })) : [],
    flash: {
      methods: t.flash && Array.isArray(t.flash.methods) ? [...t.flash.methods] : null,
      instructions: { ...((t.flash && t.flash.instructions) || {}) },
    },
    prebuilt: firmware ? null : (t.prebuilt ? { ...t.prebuilt } : null),
  };
}

function loadError(message) {
  const e = new Error(message);
  e.title = "Could not load the board TOML";
  return e;
}

/**
 * The board TOML a ?config= link names: {text, name}, the name being the
 * URL's last segment when it is a .toml file, else board.toml. A failure
 * throws an Error whose title and message are the error dialog's, worded by
 * the step that failed: only a fetch that fails outright can be CORS, since
 * an HTTP status reaches the page only when the server allowed it.
 */
export async function fetchBoardToml(config, base, fetchImpl = globalThis.fetch) {
  let url;
  try {
    url = new URL(config, base);
  } catch (e) {
    throw loadError(`${config}: not an address the site can fetch.`);
  }
  let resp;
  try {
    resp = await fetchImpl(url, { cache: "no-cache" });
  } catch (e) {
    throw loadError(`${config}: ${e.message}\n\nThe server could not be reached, or it does not allow the site to fetch the file (CORS).`);
  }
  if (!resp.ok) {
    throw loadError(`${config}: HTTP ${resp.status}\n\nThe file is not there or the server refused it: check the address.`);
  }
  let text;
  try {
    text = await resp.text();
  } catch (e) {
    throw loadError(`${config}: the download broke off: ${e.message}`);
  }
  let name = "board.toml";
  try {
    name = decodeURIComponent(url.pathname.split("/").pop() || "") || name;
  } catch (e) { /* a malformed escape: keep board.toml */ }
  if (!/\.toml$/i.test(name)) name = "board.toml";
  return { text, name };
}

export class Session {
  constructor() {
    this._t = defaultTables();
    this.tomlName = "board.toml";
    this.tomlText = writeBoardToml(this._t);
    this.files = new Map();     // file name -> Uint8Array, opened beside the TOML

    this.index = null;          // sources/index.json, once loaded
    this.ref = null;            // the index entry being configured, once its sources loaded
    this.configText = "";       // the full .config of the configuration (make olddefconfig's)
    this.tree = null;           // the Kconfig tree ({root, nodes}), as the engine reports it
    // What a build of the configuration needs: {dirs, libs: [{dir, blob, size}]
    // (the lib bundles to fetch, sizes from the index), unavailable: [lib/<dir>
    // the snapshot lacks], targets, configText, ref, error?}.
    this.plan = null;
    this.sources = { state: "idle", detail: "" };   // idle, loading, ready, error
    this.locked = "";           // why configuring is locked (a build running), "" when not
    // The last build of each engine slot (build/artifacts.js's buildRecord),
    // until a TOML is opened: {fw, katapult}. session.build is builds.fw.
    this.builds = { fw: null, katapult: null };
    // The engine's side of Katapult beside the firmware (see the katapult getter).
    this._katapultEngine = freshKatapultEngine();
    this._setupIndex = 0;       // the setup Configure edits (setupIndex clamps it)

    this._listeners = new Map();
    this._undo = [];
    this._redo = [];
  }

  // ── Events ───────────────────────────────────────────────────────────

  on(event, callback) {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event).push(callback);
    return () => this.off(event, callback);
  }

  off(event, callback) {
    const cbs = this._listeners.get(event);
    if (!cbs) return;
    const i = cbs.indexOf(callback);
    if (i >= 0) cbs.splice(i, 1);
  }

  emit(event, data) {
    for (const cb of [...(this._listeners.get(event) || [])]) {
      try { cb(data); } catch (e) { console.error(e); }
    }
  }

  _changed(what, origin) {
    this.emit("change", { what, origin });
  }

  // ── The tables ─────────────────────────────────────────────────────

  get board() { return this._t.board; }
  get firmware() { return this._t.firmware; }
  get options() { return this._t.options; }
  get flash() { return this._t.flash; }
  get prebuilt() { return this._t.prebuilt; }
  get project() { return this._t.firmware ? this._t.firmware.project : null; }
  get version() { return this._t.firmware ? this._t.firmware.version : null; }
  get defconfigText() { return this.setup ? this.setup.defconfig : ""; }

  /** Which setup Configure edits (the Setup select): an index into the tables' setups. */
  get setupIndex() {
    return Math.max(0, Math.min(this._setupIndex, this._t.setups.length - 1));
  }

  /** The setup Configure edits, or null ([prebuilt]). */
  get setup() { return this._t.setups[this.setupIndex] || null; }

  /** The firmware's last build (builds.fw). */
  get build() { return this.builds.fw; }
  set build(record) { this.builds = { ...this.builds, fw: record }; }

  /**
   * Katapult configured beside the firmware, or null when not picked: {on,
   * version, defconfigText, ref, configText, tree, plan, sources, link,
   * notes}, the configure session's side of the engine's "katapult" slot.
   * on, version and defconfigText are the tables' ([katapult] version and
   * the configured setup's katapult defconfig), so undo and Save TOML cover
   * them; the rest is the engine's. Null while the project is Katapult
   * itself, and for a setup without a Katapult defconfig.
   */
  get katapult() {
    if (!this._t.katapult || !this._t.firmware || this._t.firmware.project === "katapult") return null;
    const setup = this.setup;
    if (!setup || typeof setup.katapult !== "string") return null;
    return {
      on: true, version: this._t.katapult.version,
      defconfigText: setup.katapult,
      ...this._katapultEngine,
    };
  }

  /**
   * Edit another setup (the Setup select): its defconfigs become the
   * session's, and Katapult follows whether it has one. Not undoable (it
   * changes what is shown, not the tables). Announced as a "setup" change,
   * and "katapult" when Katapult comes or goes with it; the configure code
   * then loads the setup into the engine.
   */
  setSetupIndex(i) {
    const next = Math.max(0, Math.min(Number(i) || 0, this._t.setups.length - 1));
    if (next === this.setupIndex) return;
    const before = this.katapult;
    this._setupIndex = next;
    if (!this.katapult) this._katapultEngine = freshKatapultEngine();
    this._changed("setup", "visual");
    if (Boolean(before) !== Boolean(this.katapult)) this._changed("katapult", "visual");
  }

  get theme() { return this._t.board.theme || "default"; }
  get exposed() { return this._t.options.map((o) => o.symbol); }

  /** A copy of the tables, in board_data's shape: what save_toml and writeBoardToml take. */
  tables() { return clone(this._t); }

  /**
   * The board TOML read into objects, as toml-io.js's parseToml reads the
   * text Save TOML writes ([[option]] as option, keys at their defaults left
   * out): the shape the flash panel reads.
   */
  get toml() {
    if (this._tomlParsed === undefined || this._tomlParsedFrom !== this.tomlText) {
      this._tomlParsedFrom = this.tomlText;
      this._tomlParsed = parseToml(this.tomlText);
    }
    return this._tomlParsed;
  }

  // The TOML text follows the tables.
  _sync(origin) {
    const text = writeBoardToml(this._t);
    if (text === this.tomlText) return;
    this.tomlText = text;
    this._changed("toml", origin);
  }

  // ── Undo ───────────────────────────────────────────────────────────

  get canUndo() { return this._undo.length > 0; }
  get canRedo() { return this._redo.length > 0; }

  _snapshot() {
    return { tables: clone(this._t), tomlName: this.tomlName, files: this.files };
  }

  // After the tables were replaced (undo, redo, open): announce a Katapult
  // ticked, unticked or at another version, and forget the engine's side of
  // one that is gone. Returns whether it changed.
  _katapultReplaced(before, origin) {
    const was = before && before.version;
    const now = this.katapult && this.katapult.version;
    if (was === now) return false;
    if (!now) this._katapultEngine = freshKatapultEngine();
    this._changed("katapult", origin);
    return true;
  }

  /** Record the state before an undoable change (the configure code calls it before a Kconfig edit). */
  checkpoint() {
    this._undo.push(this._snapshot());
    if (this._undo.length > UNDO_LIMIT) this._undo.shift();
    this._redo = [];
    this._changed("undo", "checkpoint");
  }

  _restore(snap, origin) {
    const before = this._t;
    const katapultBefore = this.katapult;
    this._t = snap.tables;
    this.tomlName = snap.tomlName;
    this.files = snap.files;
    for (const what of ["board", "firmware", "setups", "options", "flash", "prebuilt", "files"]) this._changed(what, origin);
    this._katapultReplaced(katapultBefore, origin);
    this._changed("katapult-config", origin);
    if (!before.firmware || !this._t.firmware || before.firmware.project !== this._t.firmware.project) {
      this._changed("project", origin);
    }
    if (!before.firmware || !this._t.firmware || before.firmware.version !== this._t.firmware.version) {
      this._changed("version", origin);
    }
    this.emit("restore", { origin });
    this._sync(origin);
    this._changed("undo", origin);
  }

  // Neither applies while configuring is locked: the build in progress
  // depends on the tables and the engine's configuration.
  undo() {
    if (!this.canUndo || this.locked) return;
    this._redo.push(this._snapshot());
    this._restore(this._undo.pop(), "undo");
  }

  redo() {
    if (!this.canRedo || this.locked) return;
    this._undo.push(this._snapshot());
    this._restore(this._redo.pop(), "redo");
  }

  // ── Changing the tables ──────────────────────────────────────────

  /**
   * Replace every table with an opened board TOML's (board_data's shape, as
   * bridge.check_board returns it), with the file's name and the files opened
   * beside it. The last build is dropped with the board it was made for (the
   * "open" event tells the Flash card; a "build" event would also make the
   * configurator load the engine's defconfig again, which the open does).
   */
  openTables(tables, { name = null, files = null, origin = "open" } = {}) {
    this.checkpoint();
    const before = this._t;
    const katapultBefore = this.katapult;
    this._t = normalizeTables(tables);
    this.builds = { fw: null, katapult: null };
    this._setupIndex = 0;
    // An opened TOML's Katapult starts over in the engine.
    this._katapultEngine = freshKatapultEngine();
    if (name !== null) this.tomlName = name;
    if (files !== null) this.files = files;
    for (const what of ["board", "firmware", "setups", "options", "flash", "prebuilt", "files"]) this._changed(what, origin);
    if (katapultBefore || this.katapult) this._changed("katapult", origin);
    if (!before.firmware || !this._t.firmware || before.firmware.project !== this._t.firmware.project) {
      this._changed("project", origin);
    }
    this._changed("version", origin);
    this._changed("open", origin);
    this._sync(origin);
  }

  /** [board] fields: title, description, image, theme. */
  setBoard(fields, { origin = "visual", undoable = true } = {}) {
    const next = { ...this._t.board, ...fields };
    if (JSON.stringify(next) === JSON.stringify(this._t.board)) return;
    if (undoable) this.checkpoint();
    this._t.board = next;
    this._changed("board", origin);
    this._sync(origin);
  }

  /** The theme of the generated page: [board] theme. Always applies (callers check the result). */
  setTheme(name) {
    if (name && name !== this.theme) this.setBoard({ theme: name });
    return true;
  }

  /**
   * [firmware] fields: projects, version, versions (the project goes through
   * setProject, which keeps projects consistent with it).
   */
  setFirmware(fields, { origin = "visual", undoable = true } = {}) {
    if (!this._t.firmware) return;
    const next = { ...this._t.firmware, ...fields };
    // A pinned version must be one of the versions the reader picks from
    // (the loader refuses the TOML otherwise): a list gains it.
    if (Array.isArray(next.versions) && !PINLESS.includes(next.version) && !next.versions.includes(next.version)) {
      next.versions = [...next.versions, next.version];
    }
    if (JSON.stringify(next) === JSON.stringify(this._t.firmware)) return;
    if (undoable) this.checkpoint();
    const versionChanged = next.version !== this._t.firmware.version;
    this._t.firmware = next;
    this._changed("firmware", origin);
    if (versionChanged) this._changed("version", origin);
    this._sync(origin);
  }

  /**
   * The project being configured, and optionally the version with it (one
   * undo step). projects follows: a single project is replaced, a list keeps
   * it (or gains it), and Katapult never mixes with the firmware projects
   * (the loader refuses that).
   */
  setProject(project, { version = null, origin = "visual", undoable = true } = {}) {
    if (!PROJECTS.includes(project) || !this._t.firmware || project === this._t.firmware.project) return;
    if (undoable) this.checkpoint();
    const f = this._t.firmware;
    let projects = f.projects && f.projects.length ? [...f.projects] : [f.project];
    if (project === "katapult" || projects.includes("katapult") || projects.length === 1) projects = [project];
    else if (!projects.includes(project)) projects.push(project);
    const next = { ...f, project, projects };
    if (version) next.version = version;
    this._t.firmware = next;
    // Katapult alone has no Katapult beside it (the loader refuses [katapult] then).
    const dropKatapult = project === "katapult" && Boolean(this._t.katapult);
    if (dropKatapult) {
      this._t.katapult = null;
      this._t.setups = this._t.setups.map((s) => ({ ...s, katapult: null }));
      this._katapultEngine = freshKatapultEngine();
    }
    this._changed("project", origin);
    this._changed("firmware", origin);
    if (dropKatapult) this._changed("katapult", origin);
    if (version && version !== f.version) this._changed("version", origin);
    this._sync(origin);
  }

  // ── Katapult beside the firmware ─────────────────────────────────

  /**
   * Tick or untick Katapult beside the firmware, or change its version: {on,
   * version} (one undo step). Ticking it adds [katapult] (version "latest"
   * unless named) and an empty Katapult defconfig to the configured setup
   * (the configure code loads it with the firmware's chip); unticking takes
   * the configured setup's Katapult defconfig away, and [katapult] with it
   * once no setup has one (the loader refuses one without the other).
   * Refused while the project is Katapult itself. Announced as a "katapult"
   * change.
   */
  setKatapult({ on, version } = {}, { origin = "visual", undoable = true } = {}) {
    if (!this._t.firmware || this.project === "katapult") return;
    const k = this._t.katapult;
    const at = this.setupIndex;
    const mine = Boolean(this.katapult);
    const turnOn = on === undefined ? mine : Boolean(on);
    if (!turnOn) {
      if (!mine) return;
      if (undoable) this.checkpoint();
      const setups = this._t.setups.map((s, i) => (i === at ? { ...s, katapult: null } : s));
      const others = setups.some((s) => typeof s.katapult === "string");
      this._t.setups = others ? setups : setups.map((s) => ({ ...s, katapult: null }));
      if (!others) this._t.katapult = null;
      this._katapultEngine = freshKatapultEngine();
    } else if (!mine) {
      if (undoable) this.checkpoint();
      this._t.katapult = k ? { ...k } : { version: version || "latest", versions: "all", default: true };
      if (k && version && version !== k.version) this._t.katapult.version = version;
      this._t.setups = this._t.setups.map((s, i) => (i === at && s.katapult === null ? { ...s, katapult: "" } : s));
      this._katapultEngine = freshKatapultEngine();
    } else {
      if (!version || version === k.version) return;
      if (undoable) this.checkpoint();
      const next = { ...k, version };
      // A pinned version must be one of the versions the reader picks from.
      if (Array.isArray(next.versions) && !PINLESS.includes(version) && !next.versions.includes(version)) {
        next.versions = [...next.versions, version];
      }
      this._t.katapult = next;
    }
    this._changed("katapult", origin);
    this._sync(origin);
  }

  /**
   * [katapult] fields as the Embed step edits them: version, versions,
   * default. Works whichever setup Configure edits (setKatapult needs one
   * with Katapult). Announced as a "katapult" change.
   */
  setKatapultTable(fields, { origin = "visual", undoable = true } = {}) {
    const k = this._t.katapult;
    if (!k) return;
    const next = { ...k, ...fields };
    // A pinned version must be one of the versions the reader picks from.
    if (Array.isArray(next.versions) && !PINLESS.includes(next.version) && !next.versions.includes(next.version)) {
      next.versions = [...next.versions, next.version];
    }
    if (JSON.stringify(next) === JSON.stringify(k)) return;
    if (undoable) this.checkpoint();
    this._t.katapult = next;
    this._changed("katapult", origin);
    this._sync(origin);
  }

  /** Take Katapult out of the board TOML: [katapult] and every setup's Katapult defconfig (one undo step). */
  removeKatapult({ origin = "visual", undoable = true } = {}) {
    if (!this._t.katapult) return;
    if (undoable) this.checkpoint();
    this._t.katapult = null;
    this._t.setups = this._t.setups.map((s) => ({ ...s, katapult: null }));
    this._katapultEngine = freshKatapultEngine();
    this._changed("katapult", origin);
    this._changed("setups", origin);
    this._sync(origin);
  }

  /**
   * Replace the setups (the Embed step's setups editor), with the options
   * and [katapult] that follow them, as one undo step: fields {setups,
   * options?, katapult?} (configure/setups.js makes them); selected: the
   * setup Configure edits afterwards. Announced as a "setups" change, plus
   * "options", "setup" (the selected setup's defconfigs are not the ones
   * loaded) and "katapult" as they apply. Resolves to {reload}: whether the
   * configure code must load the selected setup into the engine.
   */
  setSetups({ setups, options, katapult }, { selected, origin = "visual", undoable = true } = {}) {
    if (!this._t.firmware || !Array.isArray(setups) || !setups.length) return { reload: false };
    const before = this.setup;
    const katapultBefore = this.katapult;
    const next = {
      setups: setups.map(newSetup),
      options: options ? normalizeTables({ firmware: this._t.firmware, options }).options : this._t.options,
      katapult: katapult === undefined ? this._t.katapult : (katapult ? { ...katapult } : null),
    };
    const index = selected === undefined ? this.setupIndex : Math.max(0, Math.min(selected, next.setups.length - 1));
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const optionsChanged = !same(next.options, this._t.options);
    if (same(next.setups, this._t.setups) && !optionsChanged && same(next.katapult, this._t.katapult) &&
      index === this.setupIndex) return { reload: false };
    if (undoable) this.checkpoint();
    this._t.setups = next.setups;
    this._t.options = next.options;
    this._t.katapult = next.katapult;
    this._setupIndex = index;
    const after = this.setup;
    const reload = !before || !after || before.defconfig !== after.defconfig || before.katapult !== after.katapult;
    if (!this.katapult || reload) this._katapultEngine = freshKatapultEngine();
    this._changed("setups", origin);
    if (optionsChanged) this._changed("options", origin);
    if (reload) this._changed("setup", origin);
    if (Boolean(katapultBefore) !== Boolean(this.katapult)) this._changed("katapult", origin);
    this._sync(origin);
    return { reload };
  }

  /**
   * The engine's side of session.katapult (ref, configText, tree, plan,
   * sources, link, notes), as the configure code reports it: not undoable.
   * Announced as a "katapult-<part>" change.
   */
  setKatapultState(fields, part = "engine", { origin = "engine" } = {}) {
    if (!this.katapult) return;
    const engine = { ...this._katapultEngine };
    for (const key of Object.keys(freshKatapultEngine())) if (key in fields) engine[key] = fields[key];
    this._katapultEngine = engine;
    this._changed(`katapult-${part}`, origin);
  }

  /**
   * Katapult's .config and defconfig after a change; the defconfig becomes
   * the configured setup's katapult defconfig. The undo point was taken
   * before the change (checkpoint).
   */
  setKatapultConfig({ configText, defconfigText }, { origin = "engine" } = {}) {
    const k = this.katapult;
    if (!k || (k.configText === configText && k.defconfigText === defconfigText)) return;
    this._katapultEngine = { ...this._katapultEngine, configText };
    const at = this.setupIndex;
    const setup = this._t.setups[at];
    if (setup) this._t.setups[at] = { ...setup, katapult: defconfigText };
    this._changed("katapult-config", origin);
    this._sync(origin);
  }

  setVersion(version, { origin = "visual", undoable = true } = {}) {
    if (!version || !this._t.firmware || version === this._t.firmware.version) return;
    this.setFirmware({ version }, { origin, undoable });
  }

  /** The [[option]] list (each {symbol, label, values, labels, help}). */
  setOptions(options, { origin = "visual", undoable = true } = {}) {
    if (!this._t.firmware) return;
    const next = normalizeTables({ firmware: this._t.firmware, options }).options;
    if (JSON.stringify(next) === JSON.stringify(this._t.options)) return;
    if (undoable) this.checkpoint();
    this._t.options = next;
    this._changed("options", origin);
    this._sync(origin);
  }

  /** [flash] methods (null: inferred) and instructions. */
  setFlash(fields, { origin = "visual", undoable = true } = {}) {
    const next = { ...this._t.flash, ...fields };
    if (JSON.stringify(next) === JSON.stringify(this._t.flash)) return;
    if (undoable) this.checkpoint();
    this._t.flash = next;
    this._changed("flash", origin);
    this._sync(origin);
  }

  // ── The configure session ────────────────────────────────────────

  /**
   * The configuration the engine reports after a change: the full .config
   * and the defconfig, which becomes the configured setup's defconfig. The
   * undo point was taken before the change (checkpoint).
   */
  setConfig({ configText, defconfigText }, { origin = "engine" } = {}) {
    const at = this.setupIndex;
    const setup = this._t.setups[at];
    const changed = configText !== this.configText || (setup && defconfigText !== setup.defconfig);
    if (!changed) return;
    this.configText = configText;
    if (setup) this._t.setups[at] = { ...setup, defconfig: defconfigText };
    this._changed("config", origin);
    this._sync(origin);
  }

  setTree(tree, { origin = "engine" } = {}) {
    this.tree = tree;
    this._changed("tree", origin);
  }

  setIndex(index) {
    this.index = index;
    this._changed("index", "sources");
  }

  setRef(ref) {
    this.ref = ref;
    this._changed("ref", "sources");
  }

  setPlan(plan) {
    this.plan = plan;
    this._changed("plan", "engine");
  }

  /** state: idle, loading, ready or error; detail says what (shown in the status pill). */
  setSources(state, detail = "", extra = {}) {
    this.sources = { state, detail, ...extra };
    this._changed("sources", "sources");
  }

  /** Lock configuring while something (a build) depends on the configuration: reason, or "" to unlock. */
  setLocked(reason) {
    if ((reason || "") === this.locked) return;
    this.locked = reason || "";
    this._changed("lock", "visual");
  }

  // ── Files opened beside the TOML ─────────────────────────────────

  /** Files opened beside the TOML, by name: they replace any of the same name. */
  addFiles(entries) {
    const files = new Map(this.files);
    for (const [name, bytes] of entries) files.set(name, bytes);
    this.files = files;
    this._changed("files", "open");
  }

  /** The bytes of a file the TOML names by a path relative to itself, if opened. */
  fileFor(relPath) {
    if (!relPath) return null;
    const base = String(relPath).replace(/\\/g, "/").split("/").pop();
    return this.files.get(base) || null;
  }

  /** The image and firmware file the TOML names: [{role, path, bytes}]. */
  referencedFiles() {
    const out = [];
    const image = this._t.board.image;
    if (typeof image === "string" && image && !/^(https?:|data:)/i.test(image)) {
      out.push({ role: "image", path: image, bytes: this.fileFor(image) });
    }
    const p = this._t.prebuilt;
    if (p && typeof p.file === "string" && p.file) {
      out.push({ role: "firmware file", path: p.file, bytes: this.fileFor(p.file) });
    }
    return out;
  }
}
