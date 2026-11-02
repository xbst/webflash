// The session: what the site is configuring, building and flashing.
//
// It holds the project and version picked in the toolbar, the board TOML text
// (the TOML tab edits it, and other controls patch it so its comments
// survive), the theme the page is generated with, the Kconfig symbols exposed
// to the reader, and the files opened beside the TOML (its image and firmware
// file, which Generate embeds with -i). Every change is announced as a
// "change" event whose detail names what changed; the TOML text has undo.

import { parseToml, patchValue } from "./toml-io.js";

export const PROJECTS = ["klipper", "kalico", "katapult"];

const UNDO_LIMIT = 100;

export class Session {
  constructor() {
    this.project = "klipper";
    this.version = "latest";
    this.tomlText = "";
    this.tomlName = "board.toml";
    this.theme = "default";
    this.exposed = [];          // Kconfig symbols the reader may change, one [[option]] each
    this.files = new Map();     // file name -> Uint8Array, opened beside the TOML
    this.toml = null;           // the TOML read into objects; null while it does not parse
    this.parseError = null;     // the TomlParseError when it does not
    this._listeners = new Map();
    this._undo = [];
    this._redo = [];
  }

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

  get canUndo() { return this._undo.length > 0; }
  get canRedo() { return this._redo.length > 0; }

  _snapshot() {
    return { tomlText: this.tomlText, tomlName: this.tomlName, files: this.files };
  }

  _restore(snap, origin) {
    this.tomlName = snap.tomlName;
    this.files = snap.files;
    this._read(snap.tomlText);
    this._changed("toml", origin);
    this._changed("undo", origin);
  }

  // Read the text into objects for the controls, and take the theme and the
  // project from it when it names them.
  _read(text) {
    this.tomlText = text;
    try {
      this.toml = parseToml(text);
      this.parseError = null;
    } catch (e) {
      this.toml = null;
      this.parseError = e;
      return;
    }
    const board = this.toml.board || {};
    this.theme = typeof board.theme === "string" && board.theme ? board.theme : "default";
    const firmware = this.toml.firmware || {};
    if (PROJECTS.includes(firmware.project)) this.project = firmware.project;
    this.exposed = Array.isArray(this.toml.option)
      ? this.toml.option.map((o) => o && o.symbol).filter((s) => typeof s === "string")
      : [];
  }

  /**
   * Replace the TOML text. origin says who did it ("editor" for typing in the
   * TOML tab, "open" for a file, "patch" for a control); undoable false keeps
   * it out of the history, for the text a session starts with.
   */
  setToml(text, { origin = "editor", undoable = true, name = null, files = null } = {}) {
    if (text === this.tomlText && name === null && files === null) return;
    if (undoable) {
      this._undo.push(this._snapshot());
      if (this._undo.length > UNDO_LIMIT) this._undo.shift();
      this._redo = [];
    }
    if (name !== null) this.tomlName = name;
    if (files !== null) this.files = files;
    this._read(text);
    this._changed("toml", origin);
    if (undoable) this._changed("undo", origin);
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

  /**
   * Set one value of the TOML and keep the rest of the text, as a control
   * does. Returns false when the TOML does not parse, so the control can show
   * the value that stands.
   */
  patch(table, key, value) {
    if (this.parseError) return false;
    let text;
    try {
      text = patchValue(this.tomlText, table, key, value);
    } catch (e) {
      return false;
    }
    this.setToml(text, { origin: "patch" });
    return true;
  }

  /** The theme of the generated page: [board] theme in the TOML. */
  setTheme(name) {
    if (name === this.theme) return true;
    return this.patch("board", "theme", name);
  }

  setProject(project) {
    if (!PROJECTS.includes(project) || project === this.project) return;
    this.project = project;
    this._changed("project", "visual");
  }

  setVersion(version) {
    if (!version || version === this.version) return;
    this.version = version;
    this._changed("version", "visual");
  }

  setExposed(symbols) {
    this.exposed = [...symbols];
    this._changed("exposed", "visual");
  }

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
    const t = this.toml || {};
    if (t.board && typeof t.board.image === "string" && t.board.image &&
        !/^(https?:|data:)/i.test(t.board.image)) {
      out.push({ role: "image", path: t.board.image, bytes: this.fileFor(t.board.image) });
    }
    if (t.prebuilt && typeof t.prebuilt.file === "string" && t.prebuilt.file) {
      out.push({ role: "firmware file", path: t.prebuilt.file, bytes: this.fileFor(t.prebuilt.file) });
    }
    return out;
  }
}
