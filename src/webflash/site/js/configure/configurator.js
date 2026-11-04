// The configure session's engine side: loading a version's sources into the
// engine, applying a configuration, setting symbols, and keeping the session's
// .config, defconfig, Kconfig tree and build plan in step with the engine.
//
// The engine holds two configurations, by slot: "fw" (the session's project,
// Klipper, Kalico or Katapult alone) and "katapult" (session.katapult, Katapult
// beside a firmware). Every operation here, for either slot, runs alone, in
// order, on one queue. Picking a version supersedes any load of that slot
// still waiting. Switching project or version carries the configuration
// over: the session's defconfig, with the microcontroller it leaves to the
// defaults, is loaded into the new tree with olddefconfig semantics, and what
// did not survive (symbols the new version lacks, values it would not take)
// is reported as a notice. While both slots are loaded the engine pairs them
// (engine/pair.py): the options they share are set in both, Klipper's
// bootloader offset follows Katapult's application offset, and every answer
// that changed the other slot's tree carries it, so both stay current here.

import * as runtime from "../runtime.js";
import { blobUrl, blobSize, formatBytes, loadIndex, projectTitle, resolveVersion, resolveVersionAsync } from "./sources.js";
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

/**
 * A configuration with "Enable extra low-level configuration options" on,
 * unless it says otherwise: what a fresh configuration gets after a project
 * switch (SPEC 3.5).
 */
export function withLowLevel(text) {
  const t = text || "";
  return parseConfigLines(t).has("LOW_LEVEL_OPTIONS") ? t : `CONFIG_LOW_LEVEL_OPTIONS=y\n${t}`;
}

const NOTICE_RANK = { info: 0, warn: 1, error: 2 };

/**
 * One notice from the two slots' own: either alone as it is, or both under
 * one title that names both projects ("Carried the configuration over to
 * Kalico v0.12.0 and Katapult v0.0.1"), each line led by its project.
 */
export function mergeNotices(a, b) {
  if (!a || !b) return a || b || null;
  const kind = NOTICE_RANK[b.kind] > NOTICE_RANK[a.kind] ? b.kind : a.kind;
  const title = a.title === b.title ? a.title
    : a.verb && a.verb === b.verb ? `${a.verb} ${a.label} and ${b.label}` : `${a.title}. ${b.title}`;
  const lead = (n) => (n.project ? `${n.project}: ` : "");
  return { kind, title, lines: [...a.lines.map((l) => lead(a) + l), ...b.lines.map((l) => lead(b) + l)] };
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
    this._generations = { fw: 0, katapult: 0 };
    this._planTimers = { fw: null, katapult: null };
    this._planCounts = { fw: 0, katapult: 0 };
    this._indexPromise = null;
    // {project, ref, version} in the engine now, by slot (null: nothing loaded).
    this.slots = { fw: null, katapult: null };
    this.notice = null;         // what the last load or switch could not carry over (both slots')
    this._notices = { fw: null, katapult: null };
    this._noticeListeners = [];
    session.on("restore", () => this.reapply());
    session.on("change", ({ what }) => {
      // A prebuilt board TOML configures nothing: whatever was loaded no longer applies.
      if ((what === "open" || what === "prebuilt") && !session.firmware &&
          (this.loaded || session.sources.state !== "idle")) this.unload();
      // Katapult unticked (or the firmware became Katapult itself), or a board
      // TOML opened: the page loads an opened TOML's Katapult again.
      if ((what === "open" || (what === "katapult" && !session.katapult)) && this.slots.katapult) this.dropKatapult();
      // A build (js/build/) loads the built .config into the engine's Kconfig
      // session, which pins every symbol; load the defconfig again so later
      // edits follow the defaults as before.
      if (what === "build" && this.loaded && session.firmware) this.reapply();
    });
  }

  /** What the fw slot holds: {project, ref, version}, or null. */
  get loaded() { return this.slots.fw; }
  set loaded(value) { this.slots.fw = value; }

  /** Whether the engine pairs the slots: a firmware and Katapult beside it are both loaded. */
  get paired() {
    return Boolean(this.slots.fw && this.slots.katapult && this.slots.fw.project !== "katapult");
  }

  // The session's side of a slot: what it configures and where the engine's
  // answers go. "fw" is the session's own fields, "katapult" session.katapult.
  _view(slot) {
    const s = this.session;
    if (slot === "fw") {
      return {
        slot, project: s.project, version: s.version, defconfigText: s.defconfigText, tree: s.tree,
        configText: s.configText, sources: s.sources, on: Boolean(s.firmware),
        title: (index, project = s.project) => projectTitle(index, project),
        setRef: (ref) => s.setRef(ref),
        setTree: (tree) => s.setTree(tree),
        setConfig: (texts) => s.setConfig(texts),
        setSources: (state, detail, extra) => s.setSources(state, detail, extra),
        setPlan: (plan) => s.setPlan(plan),
      };
    }
    const k = s.katapult;
    return {
      slot, project: "katapult", version: k ? k.version : null, defconfigText: k ? k.defconfigText : "",
      tree: k ? k.tree : null, configText: k ? k.configText : "", sources: k ? k.sources : { state: "idle" },
      on: Boolean(k && s.firmware && s.project !== "katapult"),
      title: (index) => projectTitle(index, "katapult"),
      setRef: (ref) => s.setKatapultState({ ref }, "ref"),
      setTree: (tree) => s.setKatapultState({ tree }, "tree"),
      setConfig: (texts) => s.setKatapultConfig(texts),
      setSources: (state, detail = "", extra = {}) => s.setKatapultState({ sources: { state, detail, ...extra } }, "sources"),
      setPlan: (plan) => s.setKatapultState({ plan }, "plan"),
    };
  }

  /** Forget both loaded configurations (the session no longer builds from source). */
  unload() {
    const s = this.session;
    for (const slot of ["fw", "katapult"]) {
      this._generations[slot]++;
      clearTimeout(this._planTimers[slot]);
      this._planCounts[slot]++;
    }
    this.slots = { fw: null, katapult: null };
    s.setRef(null);
    s.setTree(null);
    s.setPlan(null);
    s.setConfig({ configText: "", defconfigText: "" });
    s.setSources("idle");
    if (s.katapult) s.setKatapultState({ ref: null, tree: null, plan: null, configText: "", sources: { state: "idle" }, link: null, notes: [] }, "engine");
    this._notices.katapult = null;
    this._setNotice(null);
  }

  /**
   * Let go of the katapult slot (Katapult unticked): the engine forgets it,
   * nothing pairs any more, and Klipper's bootloader offset is free again.
   */
  dropKatapult() {
    const slot = "katapult";
    this._generations[slot]++;
    clearTimeout(this._planTimers[slot]);
    this._planCounts[slot]++;
    const had = this.slots.katapult;
    this.slots.katapult = null;
    if (this._notices.katapult) this._setNotice(null, slot);
    if (!had) return Promise.resolve(false);
    return this._enqueue(async () => {
      await runtime.dropSlot(slot);
      return true;
    });
  }

  onNotice(cb) {
    this._noticeListeners.push(cb);
  }

  // Each slot reports on its own loads; the notice shown is both, merged.
  _setNotice(notice, slot = "fw") {
    this._notices[slot] = notice;
    this.notice = mergeNotices(this._notices.fw, this._notices.katapult);
    for (const cb of this._noticeListeners) {
      try { cb(this.notice); } catch (e) { console.error(e); }
    }
  }

  dismissNotice() {
    this._notices.katapult = null;
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

  /**
   * Run fn alone on the engine, after every operation queued so far and
   * before any queued later: a build, which must not have either tree changed
   * under it. A plan still waiting for changes to settle is dropped; the next
   * change (the reload after the build's "build" event) plans again.
   *
   * fn must not call load, apply, set, reapply, loadKatapult, dropKatapult or
   * pairTree and wait for them: they queue behind fn, which waits for them,
   * so neither ever runs. Call runtime directly inside fn instead.
   */
  exclusive(fn) {
    clearTimeout(this._planTimers.fw);
    clearTimeout(this._planTimers.katapult);
    return this._enqueue(() => fn());
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
   * Load a slot's project and version into the engine with a configuration
   * (default: the slot's defconfig, and on a switch the microcontroller the
   * tree shown so far has picked, see carryText; a fresh Katapult, with no
   * defconfig yet, takes the firmware's chip). reason is "start", "switch"
   * (project or version changed: report what did not carry over), "open" (a
   * board TOML) or "restore" (undo). slot is "fw" (the session's project) or
   * "katapult" (session.katapult). Once both slots are loaded, the
   * firmware's shared options are copied into Katapult (pairSync). Resolves
   * to true when it loaded, false when a newer load of the slot replaced it
   * or it failed (the slot's sources state then says why).
   */
  load({ reason = "start", carry, slot = "fw" } = {}) {
    const generation = ++this._generations[slot];
    const s = this.session;
    const start = this._view(slot);
    if (carry === undefined) {
      if (slot === "katapult" && !start.defconfigText) carry = carryText("", s.tree);
      else carry = reason === "switch" ? carryText(start.defconfigText, start.tree) : start.defconfigText;
    }
    return this._enqueue(async () => {
      if (generation !== this._generations[slot]) return false;
      const view = this._view(slot);
      const project = view.project;
      const version = view.version;
      if (!project || !view.on) return false;
      const previous = this.slots[slot];
      // A new project starts with the low-level options shown (SPEC 3.5);
      // Katapult has them on anyway, and hides the switch.
      if (slot === "fw" && reason === "switch" && previous && previous.project !== project && project !== "katapult") {
        carry = withLowLevel(carry);
      }
      // A branch's old bundles stay published for a short while only: a 404
      // means the index this page holds is out of date, so read it again
      // once and resolve the version anew.
      for (let attempt = 0; ; attempt++) {
        let index;
        try {
          index = await this.loadIndex({ fresh: attempt > 0 });
        } catch (e) {
          view.setSources("error", e.message);
          return false;
        }
        // An older commit (a history id) waits for its project's history file.
        const { ref, error, note } = await resolveVersionAsync(index, project, version);
        if (!ref) {
          view.setSources("error", error);
          this._setNotice({ kind: "error", title: `This ${view.title(index)} version is not available`, lines: [error] }, slot);
          return false;
        }
        const label = `${projectTitle(index, project)} ${ref.id}`;
        const size = this.coreSize(ref);
        view.setSources("loading", label, { ref, total: size, done: 0 });
        let out;
        try {
          out = await runtime.loadSources(project, ref, blobUrl(ref.core), {
            size, slot,
            onProgress: ({ phase, done, total }) => {
              if (generation !== this._generations[slot]) return;
              if (phase === "sources") view.setSources("loading", label, { ref, done, total: total || size });
              else if (phase === "extract") view.setSources("loading", label, { ref, phase: "extract" });
            },
          });
        } catch (e) {
          if (attempt === 0 && /\(HTTP 404\)/.test(e.message) && generation === this._generations[slot]) continue;
          if (generation === this._generations[slot]) {
            view.setSources("error", e.message, { ref });
            this._setNotice({ kind: "error", title: `Could not load ${label}`, lines: [e.message] }, slot);
          }
          return false;
        }
        if (generation !== this._generations[slot]) return false;
        return this._configure({ slot, generation, reason, carry, project, version, ref, label, note, previous, out });
      }
    });
  }

  /** Load session.katapult's version beside the firmware (Katapult ticked). */
  loadKatapult({ reason = "start" } = {}) {
    return this.load({ reason, slot: "katapult" });
  }

  // The second half of load: the sources are in the engine; read the
  // configuration into them and report.
  async _configure({ slot, generation, reason, carry, project, version, ref, label, note, previous, out }) {
    const view = this._view(slot);
    try {
      view.setSources("loading", label, { ref, phase: "kconfig" });
      const loaded = await runtime.kconfigLoad(carry || "", { slot });
      // The engine sends the tree with the load; ask for it when it does not.
      const tree = normalizeTree(loaded && loaded.tree ? loaded.tree : await runtime.kconfigTree({ slot }));
      const result = loadReport(loaded, carry || "", tree);
      const configText = await runtime.kconfigConfig({ slot });
      const defconfigText = await runtime.kconfigDefconfig({ slot });
      if (generation !== this._generations[slot]) return false;
      this.slots[slot] = { project, ref, version };
      view.setRef(ref);
      view.setTree(tree);
      view.setConfig({ configText, defconfigText });
      view.setSources("ready", label, { ref, size: out.size, cached: out.cached });
      remember(AUTO_KEY, "1");
      // What the other tree refused shows under the shared options (session.katapult.notes).
      await this._afterPairing(slot, loaded && loaded.pair, { sync: true });
      this._report(slot, reason, { result, carry, configText, previous, ref, note });
      this.schedulePlan(0, slot);
      return true;
    } catch (e) {
      if (generation === this._generations[slot]) {
        view.setSources("error", e.message, { ref });
        this._setNotice({ kind: "error", title: `Could not load ${label}`, lines: [e.message] }, slot);
      }
      return false;
    }
  }

  // After an engine call in a paired session: bring the other slot's tree
  // (and texts) up to date from the answer's pair block, and keep the link
  // and the notes in session.katapult. With sync (after a load), the
  // firmware's shared options are copied into Katapult first. Runs inside
  // the queue. Returns the notes.
  async _afterPairing(slot, pair, { sync = false } = {}) {
    if (!this.paired) return [];
    let block = pair || null;
    if (sync) {
      const synced = await runtime.pairSync();
      for (const s of ["fw", "katapult"]) await this._refresh(s, synced.trees[s], { plan: s !== slot });
      block = { notes: synced.notes, offset: synced.offset, trees: {} };
    } else if (block) {
      for (const [other, tree] of Object.entries(block.trees || {})) {
        if (other !== slot && this.slots[other]) await this._refresh(other, tree);
      }
    }
    if (!block) return [];
    this.session.setKatapultState({ link: block.offset || null, notes: block.notes || [] }, "link");
    return block.notes || [];
  }

  _report(slot, reason, { result, carry, configText, previous, ref, note }) {
    const s = this.session;
    const view = this._view(slot);
    const missing = result.missing || [];
    const lost = notApplied(carry, configText, missing);
    const warnings = result.warnings || [];
    const lines = [];
    if (note) lines.push(note);
    if (missing.length) {
      lines.push(`Not in this version, so dropped: ${missing.map(([n, v]) => describeAssignment(n, v)).join(", ")}.`);
    }
    if (lost.length) {
      lines.push("Not applied here: " +
        lost.map((l) => `${describeAssignment(l.name, l.wanted)} (now ${l.got === "n" ? "off" : l.got === "y" ? "on" : l.got})`)
          .join(", ") + ".");
    }
    for (const w of warnings) lines.push(w);
    const exposedGone = reason === "open" && slot === "fw" ? this._unknownOptions() : [];
    if (exposedGone.length) {
      lines.push(`Embed options this version lacks: ${exposedGone.join(", ")}.`);
    }
    // A load with nothing to report still clears an earlier load's notice
    // (an undo back across a switch reloads with reason "restore").
    if (!lines.length) {
      this._setNotice(null, slot);
      return;
    }
    const from = previous ? `${projectTitle(s.index, previous.project)} ${previous.ref.id}` : "";
    const to = `${view.title(s.index, view.project)} ${ref.id}`;
    const switched = reason === "switch" && from;
    const verb = switched ? "Carried the configuration over to" : reason === "open" ? "Opened the board TOML with" : "Loaded";
    this._setNotice({
      kind: missing.length || lost.length || exposedGone.length ? "warn" : "info",
      title: switched ? `Carried the configuration from ${from} to ${to}` : `${verb} ${to}`,
      lines, verb, label: to, project: view.title(s.index, view.project),
    }, slot);
  }

  // Exposed options whose symbol the loaded tree does not have.
  _unknownOptions() {
    const s = this.session;
    if (!s.tree) return [];
    const names = symbolNames(s.tree);
    return s.options.map((o) => o.symbol).filter((sym) => !names.has(sym));
  }

  // ── Changing the configuration ───────────────────────────────────

  /** Whether the fw slot's configuration is loaded and can be changed. */
  get ready() {
    return this.readySlot("fw");
  }

  /** Whether a slot's configuration is loaded and can be changed. */
  readySlot(slot) {
    const view = this._view(slot);
    return Boolean(this.slots[slot]) && view.on && view.sources.state === "ready";
  }

  async _refresh(slot, tree, { plan = true } = {}) {
    const view = this._view(slot);
    view.setTree(normalizeTree(tree || await runtime.kconfigTree({ slot })));
    const configText = await runtime.kconfigConfig({ slot });
    const defconfigText = await runtime.kconfigDefconfig({ slot });
    view.setConfig({ configText, defconfigText });
    if (plan) this.schedulePlan(undefined, slot);
  }

  /**
   * Set one symbol, as a control in the tree does. The slot is the one the
   * node id names ("katapult:n4"), else slot (default "fw"). While the slots
   * are paired a shared option changes in both trees, and the answer's notes
   * (what the other tree refused) land in session.katapult.notes. Rejects
   * with the engine's reason when it refuses the value; the tree is then
   * refreshed so the control shows the value that stands.
   */
  set(name, value, { slot } = {}) {
    const s = this.session;
    const which = slot || runtime.slotOf(name);
    return this._enqueue(async () => {
      if (!this.readySlot(which) || s.locked) throw new Error(s.locked || "The configuration has not loaded yet.");
      s.checkpoint();
      try {
        const out = await runtime.kconfigSet(name, value, { slot: which });
        await this._refresh(which, out);
        await this._afterPairing(which, out && out.pair);
        return out && out.pair ? out.pair.notes : [];
      } catch (e) {
        await this._refresh(which).catch(() => {});
        throw e;
      }
    });
  }

  /**
   * Load a .config or defconfig text into a slot's current version (Load
   * .config, Reset), reporting symbols it names that this version does not
   * have. checkpoint false: the caller took the undo point (a Reset of both
   * slots is one undo step).
   */
  apply(text, { title = "Loaded the configuration", slot = "fw", checkpoint = true } = {}) {
    const s = this.session;
    return this._enqueue(async () => {
      if (!this.readySlot(slot) || s.locked) throw new Error(s.locked || "The configuration has not loaded yet.");
      if (checkpoint) s.checkpoint();
      const loaded = await runtime.kconfigLoad(text, { slot });
      await this._refresh(slot, loaded && loaded.tree ? loaded.tree : null);
      await this._afterPairing(slot, loaded && loaded.pair, { sync: true });
      const view = this._view(slot);
      const result = loadReport(loaded, text, view.tree);
      const missing = result.missing;
      const lines = [];
      if (missing.length) {
        lines.push(`Not in ${view.title(s.index, view.project)} ${this.slots[slot].ref.id}, so dropped: ` +
          `${missing.map(([n, v]) => describeAssignment(n, v)).join(", ")}.`);
      }
      for (const w of result.warnings) lines.push(w);
      this._setNotice(lines.length ? { kind: "warn", title, lines, project: view.title(s.index, view.project) } : null, slot);
      return result;
    });
  }

  /** After undo or redo: bring the engine to the session's restored configuration, both slots. */
  reapply() {
    const s = this.session;
    if (!this.loaded || !s.firmware) return Promise.resolve(false);
    const fw = this._reapplySlot("fw");
    const k = this._view("katapult");
    let kat;
    if (!k.on) kat = this.slots.katapult ? this.dropKatapult() : Promise.resolve(false);
    else kat = this._reapplySlot("katapult");
    // Both restored: pair them again, which changes nothing in a restored
    // pair but brings back the notes of what Katapult refuses.
    return Promise.all([fw, kat]).then(async ([a]) => {
      if (this.paired) await this._enqueue(() => this._afterPairing("fw", null, { sync: true }));
      return a;
    });
  }

  _reapplySlot(slot) {
    const view = this._view(slot);
    const now = this.slots[slot];
    if (!now || now.project !== view.project || now.version !== view.version) return this.load({ reason: "restore", slot });
    const text = view.defconfigText;
    return this._enqueue(async () => {
      const loaded = await runtime.kconfigLoad(text, { slot });
      await this._refresh(slot, loaded && loaded.tree ? loaded.tree : null);
      await this._afterPairing(slot, loaded && loaded.pair);
      return true;
    });
  }

  /**
   * Both slots' trees in one, grouped (bridge.pair_tree: the shared options,
   * the firmware's own, Katapult's own), normalized for kconfig-tree.js with
   * the groups and the offset link kept beside it. Null when not paired.
   */
  pairTree() {
    return this._enqueue(async () => {
      if (!this.paired) return null;
      const raw = await runtime.pairTree();
      return { ...normalizeTree(raw), groups: raw.groups, offset: raw.offset, titles: raw.titles };
    });
  }

  // ── The build plan ───────────────────────────────────────────────

  /** Ask the engine what a build of a slot's configuration needs, once changes settle. */
  schedulePlan(delay = 400, slot = "fw") {
    clearTimeout(this._planTimers[slot]);
    this._planTimers[slot] = setTimeout(() => this._plan(slot), delay);
  }

  // The engine's plan loads the text it is given into the Kconfig session
  // before it evaluates the Makefiles. A full .config would pin every symbol
  // as if the user had set it, so later edits would stop following the
  // defaults; the defconfig leaves the session as it is (olddefconfig of the
  // defconfig, which is what the board TOML stores).
  _plan(slot = "fw") {
    const s = this.session;
    const mine = ++this._planCounts[slot];
    const loaded = this.slots[slot];
    const ref = loaded && loaded.ref;
    const view = this._view(slot);
    const configText = view.configText;
    const defconfigText = view.defconfigText;
    if (!ref || !configText) return Promise.resolve();
    return this._enqueue(async () => {
      if (mine !== this._planCounts[slot]) return;
      try {
        const out = await runtime.plan(defconfigText, { slot });
        if (mine !== this._planCounts[slot]) return;
        // Folders the core bundle holds are here already; one that is in
        // neither the core nor a lib bundle is missing from the snapshot.
        const inCore = new Set(ref.core_libs || []);
        const libs = (out.libs || []).filter((dir) => !inCore.has(dir)).map((dir) => {
          const blob = (ref.libs || {})[dir] || null;
          return { dir, blob, size: blob ? blobSize(s.index, blob) : null };
        });
        const unavailable = libs.filter((l) => !l.blob).map((l) => l.dir);
        view.setPlan({
          dirs: out.dirs || [], libs: libs.filter((l) => l.blob), unavailable, targets: out.targets || [],
          configText, ref: ref.id,
        });
      } catch (e) {
        if (mine === this._planCounts[slot]) {
          view.setPlan({ dirs: [], libs: [], unavailable: [], targets: [], error: e.message, configText, ref: ref.id });
        }
      }
    });
  }
}

export { formatBytes };
