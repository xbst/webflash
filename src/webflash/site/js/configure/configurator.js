// The configure session's engine side: loading a version's sources into the
// engine, applying a configuration, setting symbols, and keeping the session's
// .config, defconfig, Kconfig tree and build plan in step with the engine.
//
// The engine holds one tree and one Kconfig state, so every operation here
// runs alone, in order (a queue). Picking a version supersedes any version
// load still waiting. Switching project or version carries the configuration
// over: the session's defconfig, with the microcontroller it leaves to the
// defaults, is loaded into the new tree with olddefconfig semantics, and what
// did not survive (symbols the new version lacks, values it would not take)
// is reported as a notice.

import * as runtime from "../runtime.js";
import { blobUrl, blobSize, formatBytes, loadIndex, projectTitle, resolveVersion } from "./sources.js";
import { normalizeTree, symbolNames } from "./kconfig-tree.js";

const AUTO_KEY = "webflash.configure.auto";

// ── .config text ─────────────────────────────────────────────────────

/** name -> value of a .config or defconfig text; "# CONFIG_X is not set" is "n". */
export function parseConfigLines(text) {
  const out = new Map();
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    let m = /^CONFIG_([A-Za-z0-9_]+)=(.*)$/.exec(line);
    if (m) {
      out.set(m[1], m[2]);
      continue;
    }
    m = /^#\s*CONFIG_([A-Za-z0-9_]+) is not set$/.exec(line);
    if (m) out.set(m[1], "n");
  }
  return out;
}

/**
 * The assignments of a carried configuration that the loaded one does not
 * hold: [{name, wanted, got}], got "n" for a symbol that is off or absent
 * (a .config leaves out symbols whose dependencies are off). Symbols the
 * version does not have at all (missing) are reported separately.
 */
export function notApplied(carriedText, configText, missing = []) {
  const gone = new Set(missing.map((m) => (Array.isArray(m) ? m[0] : m)));
  const have = parseConfigLines(configText);
  const out = [];
  for (const [name, wanted] of parseConfigLines(carriedText)) {
    if (gone.has(name)) continue;
    const got = have.has(name) ? have.get(name) : "n";
    if (got !== wanted) out.push({ name, wanted, got });
  }
  return out;
}

/**
 * What a load reports, whatever shape the engine gives it ({missing,
 * warnings}, or a list of warnings): {missing, warnings}, missing being the
 * assignments to symbols the loaded tree does not define, from the tree
 * itself when the engine does not list them.
 */
export function loadReport(result, carriedText, tree) {
  const warnings = Array.isArray(result) ? result : (result && result.warnings) || [];
  let missing = result && !Array.isArray(result) && Array.isArray(result.missing) ? result.missing : null;
  if (!missing) {
    const names = symbolNames(tree);
    missing = [...parseConfigLines(carriedText)].filter(([name]) => !names.has(name));
  }
  // A warning about a symbol that is not defined says what missing says
  // (kconfiglib's "undefined symbol X", the engine's "CONFIG_X is not a symbol").
  const dropped = [...new Set(missing.map(([name]) => name))];
  const rest = warnings.filter((w) => !dropped.some((name) =>
    String(w).includes(`undefined symbol ${name}`) || String(w).includes(`CONFIG_${name} is not a symbol`)));
  return { missing, warnings: rest };
}

/** An assignment as a sentence reads it: NAME, NAME (off), or NAME=value. */
export function describeAssignment(name, value) {
  if (value === "y") return name;
  if (value === "n" || value === undefined || value === null) return `${name} (off)`;
  return `${name}=${value}`;
}

/**
 * The microcontroller a configuration picks: the members selected in its
 * shown choices of MACH_ symbols (the architecture and the processor model,
 * named alike in Klipper, Kalico and Katapult), in menu order.
 */
export function machineChoices(tree) {
  const out = [];
  for (const n of Object.values((tree && tree.nodes) || {})) {
    if (n.kind === "choice" && n.visible && n.value && n.value.startsWith("MACH_")) out.push(n.value);
  }
  return out;
}

/**
 * What a switch of project or version carries: the defconfig, after the
 * microcontroller wherever the defconfig leaves it to the defaults. A
 * defconfig leaves out a choice's default member and the defaults differ
 * (Klipper's architecture is AVR, Katapult's LPC176x), so the defconfig alone
 * could change the chip without a word. The other choices (a bootloader
 * offset means one thing in Katapult and another in Klipper) follow the new
 * tree's defaults.
 */
export function carryText(defconfigText, tree) {
  const text = defconfigText || "";
  const named = parseConfigLines(text);
  return machineChoices(tree).filter((name) => !named.has(name)).map((name) => `CONFIG_${name}=y\n`).join("") + text;
}

function remembered(key) {
  try { return localStorage.getItem(key); } catch (e) { return null; }
}

function remember(key, value) {
  try { localStorage.setItem(key, value); } catch (e) { /* storage can be blocked */ }
}

export class Configurator {
  constructor(session) {
    this.session = session;
    this._queue = Promise.resolve();
    this._generation = 0;
    this._planTimer = null;
    this._planCount = 0;
    this._indexPromise = null;
    this.loaded = null;         // {project, ref, version} in the engine now
    this.notice = null;         // what the last load or switch could not carry over
    this._noticeListeners = [];
    session.on("restore", () => this.reapply());
    session.on("change", ({ what }) => {
      // A prebuilt board TOML configures nothing: whatever was loaded no longer applies.
      if ((what === "open" || what === "prebuilt") && !session.firmware &&
          (this.loaded || session.sources.state !== "idle")) this.unload();
      // A build (chunk 06) loads the built .config into the engine's Kconfig
      // session, which pins every symbol; load the defconfig again so later
      // edits follow the defaults as before.
      if (what === "build" && this.loaded && session.firmware) this.reapply();
    });
  }

  /** Forget the loaded configuration (the session no longer builds from source). */
  unload() {
    const s = this.session;
    this._generation++;
    this.loaded = null;
    clearTimeout(this._planTimer);
    this._planCount++;
    s.setRef(null);
    s.setTree(null);
    s.setPlan(null);
    s.setConfig({ configText: "", defconfigText: "" });
    s.setSources("idle");
    this._setNotice(null);
  }

  onNotice(cb) {
    this._noticeListeners.push(cb);
  }

  _setNotice(notice) {
    this.notice = notice;
    for (const cb of this._noticeListeners) {
      try { cb(notice); } catch (e) { console.error(e); }
    }
  }

  dismissNotice() {
    this._setNotice(null);
  }

  /** Whether this browser configured before, so a visit can load at once. */
  get autoStart() {
    return remembered(AUTO_KEY) === "1";
  }

  _enqueue(fn) {
    const run = this._queue.then(fn, fn);
    this._queue = run.catch(() => {});
    return run;
  }

  // ── The index ──────────────────────────────────────────────────────

  /**
   * sources/index.json into the session (once; again after a failure, or
   * with fresh: the index moved on and a bundle it named is gone).
   */
  loadIndex({ fresh = false } = {}) {
    if (fresh) this._indexPromise = null;
    if (!this._indexPromise) {
      this._indexPromise = loadIndex().then((index) => {
        this.session.setIndex(index);
        return index;
      }).catch((e) => {
        this._indexPromise = null;
        throw e;
      });
    }
    return this._indexPromise;
  }

  /** {ref, note} or {ref: null, error} for the session's project and version. */
  resolve(project = this.session.project, version = this.session.version) {
    if (!this.session.index) return { ref: null, error: "The list of versions has not loaded." };
    return resolveVersion(this.session.index, project, version);
  }

  /** The core bundle's size in bytes for a ref, or null when the index does not say. */
  coreSize(ref) {
    return ref ? blobSize(this.session.index, ref.core) : null;
  }

  // ── Loading a version ────────────────────────────────────────────

  /**
   * Load the session's project and version into the engine with a
   * configuration (default: the session's defconfig, and on a switch the
   * microcontroller the tree shown so far has picked, see carryText). reason
   * is "start", "switch" (project or version changed: report what did not
   * carry over), "open" (a board TOML) or "restore" (undo). Resolves to true
   * when it loaded, false when a newer load replaced it or it failed (the
   * session's sources state then says why).
   */
  load({ reason = "start", carry } = {}) {
    const generation = ++this._generation;
    const s = this.session;
    if (carry === undefined) carry = reason === "switch" ? carryText(s.defconfigText, s.tree) : s.defconfigText;
    return this._enqueue(async () => {
      if (generation !== this._generation) return false;
      const project = s.project;
      const version = s.version;
      if (!project) return false;
      const previous = this.loaded;
      // A branch's old bundles stay published for a short while only: a 404
      // means the index this page holds is out of date, so read it again
      // once and resolve the version anew.
      for (let attempt = 0; ; attempt++) {
        let index;
        try {
          index = await this.loadIndex({ fresh: attempt > 0 });
        } catch (e) {
          s.setSources("error", e.message);
          return false;
        }
        const { ref, error, note } = resolveVersion(index, project, version);
        if (!ref) {
          s.setSources("error", error);
          this._setNotice({ kind: "error", title: "This version is not available", lines: [error] });
          return false;
        }
        const label = `${projectTitle(index, project)} ${ref.id}`;
        const size = this.coreSize(ref);
        s.setSources("loading", label, { ref, total: size, done: 0 });
        let out;
        try {
          out = await runtime.loadSources(project, ref, blobUrl(ref.core), {
            size,
            onProgress: ({ phase, done, total }) => {
              if (generation !== this._generation) return;
              if (phase === "sources") s.setSources("loading", label, { ref, done, total: total || size });
              else if (phase === "extract") s.setSources("loading", label, { ref, phase: "extract" });
            },
          });
        } catch (e) {
          if (attempt === 0 && /\(HTTP 404\)/.test(e.message) && generation === this._generation) continue;
          if (generation === this._generation) {
            s.setSources("error", e.message, { ref });
            this._setNotice({ kind: "error", title: `Could not load ${label}`, lines: [e.message] });
          }
          return false;
        }
        if (generation !== this._generation) return false;
        return this._configure({ generation, reason, carry, project, version, ref, label, note, previous, out });
      }
    });
  }

  // The second half of load: the sources are in the engine; read the
  // configuration into them and report.
  async _configure({ generation, reason, carry, project, version, ref, label, note, previous, out }) {
    const s = this.session;
    try {
      s.setSources("loading", label, { ref, phase: "kconfig" });
      const loaded = await runtime.kconfigLoad(carry || "");
      // The engine sends the tree with the load; ask for it when it does not.
      const tree = normalizeTree(loaded && loaded.tree ? loaded.tree : await runtime.kconfigTree());
      const result = loadReport(loaded, carry || "", tree);
      const configText = await runtime.kconfigConfig();
      const defconfigText = await runtime.kconfigDefconfig();
      if (generation !== this._generation) return false;
      this.loaded = { project, ref, version };
      s.setRef(ref);
      s.setTree(tree);
      s.setConfig({ configText, defconfigText });
      s.setSources("ready", label, { ref, size: out.size, cached: out.cached });
      remember(AUTO_KEY, "1");
      this._report(reason, { result, carry, configText, previous, ref, note });
      this.schedulePlan(0);
      return true;
    } catch (e) {
      if (generation === this._generation) {
        s.setSources("error", e.message, { ref });
        this._setNotice({ kind: "error", title: `Could not load ${label}`, lines: [e.message] });
      }
      return false;
    }
  }

  _report(reason, { result, carry, configText, previous, ref, note }) {
    const s = this.session;
    const missing = result.missing || [];
    const lost = notApplied(carry, configText, missing);
    const warnings = result.warnings || [];
    const lines = [];
    if (note) lines.push(note);
    if (missing.length) {
      lines.push(`Not in this version, so dropped: ${missing.map(([n, v]) => describeAssignment(n, v)).join(", ")}.`);
    }
    if (lost.length) {
      lines.push("Not applied (their dependencies are off here, or the value is not allowed): " +
        lost.map((l) => `${describeAssignment(l.name, l.wanted)}, now ${l.got === "n" ? "off" : l.got === "y" ? "on" : l.got}`)
          .join("; ") + ".");
    }
    for (const w of warnings) lines.push(w);
    const exposedGone = reason === "open" ? this._unknownOptions() : [];
    if (exposedGone.length) {
      lines.push(`The board TOML exposes options this version does not have: ${exposedGone.join(", ")}.`);
    }
    if (!lines.length) {
      if (reason === "switch" || reason === "open") this._setNotice(null);
      return;
    }
    const from = previous ? `${projectTitle(s.index, previous.project)} ${previous.ref.id}` : "";
    const to = `${projectTitle(s.index, s.project)} ${ref.id}`;
    const title = reason === "switch" && from
      ? `Carried the configuration from ${from} to ${to}`
      : reason === "open" ? `Opened the board TOML with ${to}` : `Loaded ${to}`;
    this._setNotice({ kind: missing.length || lost.length || exposedGone.length ? "warn" : "info", title, lines });
  }

  // Exposed options whose symbol the loaded tree does not have.
  _unknownOptions() {
    const s = this.session;
    if (!s.tree) return [];
    const names = symbolNames(s.tree);
    return s.options.map((o) => o.symbol).filter((sym) => !names.has(sym));
  }

  // ── Changing the configuration ───────────────────────────────────

  get ready() {
    return Boolean(this.loaded) && Boolean(this.session.firmware) && this.session.sources.state === "ready";
  }

  async _refresh(tree) {
    const s = this.session;
    s.setTree(normalizeTree(tree || await runtime.kconfigTree()));
    const configText = await runtime.kconfigConfig();
    const defconfigText = await runtime.kconfigDefconfig();
    s.setConfig({ configText, defconfigText });
    this.schedulePlan();
  }

  /**
   * Set one symbol, as a control in the tree does. Rejects with the engine's
   * reason when it refuses the value; the tree is then refreshed so the
   * control shows the value that stands.
   */
  set(name, value) {
    const s = this.session;
    return this._enqueue(async () => {
      if (!this.ready || s.locked) throw new Error(s.locked || "The configuration has not loaded yet.");
      s.checkpoint();
      try {
        await this._refresh(await runtime.kconfigSet(name, value));
      } catch (e) {
        await this._refresh().catch(() => {});
        throw e;
      }
    });
  }

  /**
   * Load a .config or defconfig text into the current version (Load .config;
   * "" is Reset to defaults), reporting symbols it names that this version
   * does not have.
   */
  apply(text, { title = "Loaded the configuration" } = {}) {
    const s = this.session;
    return this._enqueue(async () => {
      if (!this.ready || s.locked) throw new Error(s.locked || "The configuration has not loaded yet.");
      s.checkpoint();
      const loaded = await runtime.kconfigLoad(text);
      await this._refresh(loaded && loaded.tree ? loaded.tree : null);
      const result = loadReport(loaded, text, s.tree);
      const missing = result.missing;
      const lines = [];
      if (missing.length) {
        lines.push(`Not in ${projectTitle(s.index, s.project)} ${this.loaded.ref.id}, so dropped: ` +
          `${missing.map(([n, v]) => describeAssignment(n, v)).join(", ")}.`);
      }
      for (const w of result.warnings) lines.push(w);
      this._setNotice(lines.length ? { kind: "warn", title, lines } : null);
      return result;
    });
  }

  /** After undo or redo: bring the engine to the session's restored configuration. */
  reapply() {
    const s = this.session;
    if (!this.loaded || !s.firmware) return Promise.resolve(false);
    const same = this.loaded.project === s.project && this.loaded.version === s.version;
    if (!same) return this.load({ reason: "restore" });
    const text = s.defconfigText;
    return this._enqueue(async () => {
      const loaded = await runtime.kconfigLoad(text);
      await this._refresh(loaded && loaded.tree ? loaded.tree : null);
      return true;
    });
  }

  // ── The build plan ───────────────────────────────────────────────

  /** Ask the engine what a build of the configuration needs, once changes settle. */
  schedulePlan(delay = 400) {
    clearTimeout(this._planTimer);
    this._planTimer = setTimeout(() => this._plan(), delay);
  }

  // The engine's plan loads the text it is given into the Kconfig session
  // before it evaluates the Makefiles. A full .config would pin every symbol
  // as if the user had set it, so later edits would stop following the
  // defaults; the defconfig leaves the session as it is (olddefconfig of the
  // defconfig, which is what the board TOML stores).
  _plan() {
    const s = this.session;
    const mine = ++this._planCount;
    const ref = this.loaded && this.loaded.ref;
    const configText = s.configText;
    const defconfigText = s.defconfigText;
    if (!ref || !configText) return Promise.resolve();
    return this._enqueue(async () => {
      if (mine !== this._planCount) return;
      try {
        const out = await runtime.plan(defconfigText);
        if (mine !== this._planCount) return;
        // Folders the core bundle holds are here already; one that is in
        // neither the core nor a lib bundle is missing from the snapshot.
        const inCore = new Set(ref.core_libs || []);
        const libs = (out.libs || []).filter((dir) => !inCore.has(dir)).map((dir) => {
          const blob = (ref.libs || {})[dir] || null;
          return { dir, blob, size: blob ? blobSize(s.index, blob) : null };
        });
        const unavailable = libs.filter((l) => !l.blob).map((l) => l.dir);
        s.setPlan({
          dirs: out.dirs || [], libs: libs.filter((l) => l.blob), unavailable, targets: out.targets || [],
          configText, ref: ref.id,
        });
      } catch (e) {
        if (mine === this._planCount) {
          s.setPlan({ dirs: [], libs: [], unavailable: [], targets: [], error: e.message, configText, ref: ref.id });
        }
      }
    });
  }
}

export { formatBytes };
