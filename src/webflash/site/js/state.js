// The session: what the site is configuring, building and flashing.
//
// It holds the board TOML's tables in the shape webflash's board_data returns
// ([board], [firmware], [config] defconfig, [[option]], [flash], [prebuilt]):
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
// plan, sources, lock, undo, open. Undo and redo cover the tables (and the
// TOML's name and files); a "restore" event tells the configure code to load
// the restored defconfig into the engine.

import { parseToml, writeBoardToml, DEFAULT_ENGINE_URL } from "./toml-io.js";

export const PROJECTS = ["klipper", "kalico", "katapult"];
export const PROJECT_TITLES = { klipper: "Klipper", kalico: "Kalico", katapult: "Katapult" };
// The flashing methods, in the order webflash's config.METHODS lists them.
export const METHODS = ["dfu", "picoboot", "uf2", "katapult", "katapult-can", "download"];

const UNDO_LIMIT = 100;

// What a fresh session configures: Klipper's latest version for an STM32G0B1,
// the shape of the boards WebFlash was written for.
export const STARTER_DEFCONFIG = "CONFIG_MACH_STM32=y\nCONFIG_MACH_STM32G0B1=y\n";

export function defaultTables() {
  return {
    board: {
      title: "My board", description: "", image: "", theme: "default",
      theme_dir: "./themes", engine_url: DEFAULT_ENGINE_URL,
    },
    firmware: { project: "klipper", projects: ["klipper"], version: "latest", versions: "all" },
    config: { defconfig: STARTER_DEFCONFIG },
    options: [],
    flash: { methods: null, instructions: {} },
    prebuilt: null,
  };
}

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** The tables of a board TOML as board_data gives them, every key present. */
export function normalizeTables(t) {
  const d = defaultTables();
  const board = { ...d.board, ...(t.board || {}) };
  const firmware = t.firmware ? {
    project: t.firmware.project,
    projects: t.firmware.projects && t.firmware.projects.length ? [...t.firmware.projects] : [t.firmware.project],
    version: t.firmware.version || "latest",
    versions: t.firmware.versions === undefined ? "all" : clone(t.firmware.versions),
  } : null;
  return {
    board,
    firmware,
    config: firmware ? { defconfig: (t.config && t.config.defconfig) || "" } : null,
    options: firmware ? (t.options || []).map((o) => ({
      symbol: o.symbol,
      label: o.label || "",
      values: o.values === undefined || o.values === null ? null : o.values.map(String),
      labels: { ...(o.labels || {}) },
      help: o.help || "",
    })) : [],
    flash: {
      methods: t.flash && Array.isArray(t.flash.methods) ? [...t.flash.methods] : null,
      instructions: { ...((t.flash && t.flash.instructions) || {}) },
    },
    prebuilt: firmware ? null : (t.prebuilt ? { ...t.prebuilt } : null),
  };
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
  get defconfigText() { return this._t.config ? this._t.config.defconfig : ""; }
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

  /** Record the state before an undoable change (the configure code calls it before a Kconfig edit). */
  checkpoint() {
    this._undo.push(this._snapshot());
    if (this._undo.length > UNDO_LIMIT) this._undo.shift();
    this._redo = [];
    this._changed("undo", "checkpoint");
  }

  _restore(snap, origin) {
    const before = this._t;
    this._t = snap.tables;
    this.tomlName = snap.tomlName;
    this.files = snap.files;
    for (const what of ["board", "firmware", "options", "flash", "prebuilt", "files"]) this._changed(what, origin);
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

  undo() {
    if (!this.canUndo) return;
    this._redo.push(this._snapshot());
    this._restore(this._undo.pop(), "undo");
  }

  redo() {
    if (!this.canRedo) return;
    this._undo.push(this._snapshot());
    this._restore(this._redo.pop(), "redo");
  }

  // ── Changing the tables ──────────────────────────────────────────

  /**
   * Replace every table with an opened board TOML's (board_data's shape, as
   * bridge.check_board returns it), with the file's name and the files opened
   * beside it.
   */
  openTables(tables, { name = null, files = null, origin = "open" } = {}) {
    this.checkpoint();
    const before = this._t;
    this._t = normalizeTables(tables);
    if (name !== null) this.tomlName = name;
    if (files !== null) this.files = files;
    for (const what of ["board", "firmware", "options", "flash", "prebuilt", "files"]) this._changed(what, origin);
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
    this._changed("project", origin);
    this._changed("firmware", origin);
    if (version && version !== f.version) this._changed("version", origin);
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
   * and the defconfig, which becomes [config] defconfig. The undo point was
   * taken before the change (checkpoint).
   */
  setConfig({ configText, defconfigText }, { origin = "engine" } = {}) {
    const changed = configText !== this.configText ||
      (this._t.config && defconfigText !== this._t.config.defconfig);
    if (!changed) return;
    this.configText = configText;
    if (this._t.config) this._t.config = { defconfig: defconfigText };
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
