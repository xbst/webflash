// The firmware part of a generated page's card, for a board built from
// source: the project and the version, the options the board TOML exposes,
// Build with its progress, the files and the log. It drives the site's own
// flow through the site's own modules: the session (state.js) holds the
// board TOML's tables, the configurator loads a version into the engine
// worker and sets symbols, and builder.js runs the build in the toolchain
// workers, so a card builds what the site builds from the same TOML.
//
// Nothing heavy loads before the reader asks for it. The options read from
// the TOML until then (a value list, the defconfig's value, "Default" where
// only the Kconfig knows); the first Build, or Change on an option the TOML
// gives no values for, lists what it downloads with the sizes and waits for
// a click: the Python runtime, the version's sources, the compiler. Then the
// configuration loads (the defconfig, then each choice the reader made), the
// options follow the Kconfig tree, and the build runs. Once a build worked in
// this browser and its cache kept the compiler, later ones start at once.

import * as runtime from "./runtime.js";
import { esc } from "./dialogs.js";
import { Session } from "./state.js";
import { Configurator } from "./configure/configurator.js";
import { blobSize, blobUrl, formatBytes, groupRefs, isChecked, projectTitle, resolveVersion, uncheckedText } from "./configure/sources.js";
import { versionOptions } from "./configure/version-picker.js";
import { checkNumber } from "./configure/kconfig-tree.js";
import { BuildCancelled, Builder, untilAborted } from "./build/builder.js";
import { cachedFlags } from "./build/cache.js";
import { buildRecord, renderArtifacts, renderMemory } from "./build/artifacts.js";
import { configKey, splitFailure } from "./build/build-panel.js";
import { workerCount } from "./build/toolchain-pool.js";
import { isCached } from "./workers/blob-cache.js";
import { renderInline } from "./flash/flash-ui.js";
import { unsupportedReason } from "./flash/devices.js";
import { openInSiteUrl } from "./toml-io.js";
import { applyChoices, isCurrent, linkToml, liveOption, optionModel } from "./embed-model.js";

// A build worked in this browser with the compiler in Cache Storage (this
// site's storage): later ones start at once.
const AUTO_KEY = "webflash.embed.auto";
const ENGINE_PHASES = new Set(["configure", "plan", "build", "step", "done", "log", "failed", "finished"]);

function remembered(key) {
  try { return localStorage.getItem(key); } catch (e) { return null; }
}

function remember(key, value) {
  try { localStorage.setItem(key, value); } catch (e) { /* storage can be blocked in a frame */ }
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "html") node.innerHTML = v;
    else if (v === true) node.setAttribute(k, "");
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) node.append(c);
  return node;
}

function seconds(ms) {
  return ms < 10000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`;
}

const now = () => performance.now();

/** A ref as the card names it: a tag by its name, a branch by its describe string. */
function refText(ref) {
  return ref.kind === "tag" ? ref.id : (ref.describe || ref.id);
}

/** The board TOML's tables (board_data's shape) from the page's configuration. */
function tablesOf(config) {
  return {
    board: config.board, firmware: config.firmware, config: config.config,
    options: config.options, flash: config.flash, prebuilt: null,
  };
}

export class FirmwareSection {
  /**
   * root: the section to fill; config: readConfig's; env: embed.js's
   * runtimeLocation. onBuild(build | null) gets session.build's record after
   * each build, and null while the settings differ from it; onLink(href) the
   * "Open in WebFlash" link whenever it changes; onRelayout() runs after a
   * change the page's height script cannot see.
   */
  constructor(root, config, env, { behavior, onBuild = () => {}, onLink = () => {}, onRelayout = () => {} } = {}) {
    runtime.configure({ assetsBase: env.assets, payloadUrl: env.payloadUrl });
    this.root = root;
    this.config = config;
    this.env = env;
    this.behavior = behavior;
    this.onBuild = onBuild;
    this.onLink = onLink;
    this.onRelayout = onRelayout;
    this.session = new Session();
    this.session.openTables(tablesOf(config), { origin: "embed" });
    this.configurator = new Configurator(this.session);
    this.builder = new Builder({ assetsBase: env.assets, workers: workerCount });
    this.pending = new Map();       // option symbol -> a value picked before the configuration loaded
    this.optionsChanged = false;    // the reader changed an option in the loaded configuration
    this.running = "";              // "build" or "load" while one runs
    this.cancelled = false;
    this._stop = null;              // the running run's AbortController
    this.build = null;              // the last build that worked (buildRecord's)
    this.shownBuild = undefined;    // what onBuild got last
    this.indexError = "";
    this.optionErrors = new Map();
    this.failed = null;             // the failing command and its output, from the engine
    this.logBuffer = [];
    this.logLines = 0;
    this._logTimer = null;
    this._dom();
    this.session.on("change", ({ what }) => this._changed(what));
    this.configurator.onNotice((notice) => this._renderNotice(notice));
    this.configurator.loadIndex().catch((e) => {
      this.indexError = e.message;
      this.render();
    });
    this.render();
  }

  // ── State ──────────────────────────────────────────────────────────

  /** Whether the engine holds the configuration of the project and version shown. */
  get loaded() {
    const s = this.session;
    const l = this.configurator.loaded;
    return Boolean(l) && l.project === s.project && l.version === s.version && s.sources.state === "ready";
  }

  /** The reader changed something the board TOML sets: project, version or an option. */
  get changed() {
    const s = this.session;
    const f = this.config.firmware;
    return s.project !== f.project || s.version !== f.version || this.pending.size > 0 || this.optionsChanged;
  }

  /** The last build no longer matches the settings shown. */
  get stale() {
    const s = this.session;
    const b = this.build;
    if (!b) return false;
    if (b.project !== s.project || this.pending.size) return true;
    if (!s.ref || b.ref !== s.ref.id || !this.loaded) return true;
    return configKey(b.config) !== configKey(s.configText);
  }

  /** The ref the project and version name now: {ref, note} or {ref: null, error}. */
  resolve() {
    const s = this.session;
    if (!s.index) return { ref: null, error: this.indexError || "Loading the list of versions…" };
    return resolveVersion(s.index, s.project, s.version);
  }

  /** Why Build cannot start now, or "". */
  blockReason() {
    const s = this.session;
    if (this.running) return this.running === "build" ? "A build is running." : "The configuration is loading.";
    const { ref, error } = this.resolve();
    if (!ref) return error;
    // Before the configuration loads, the defconfig names the architecture
    // when it sets one; afterwards the resolved .config always does.
    const config = this.loaded ? s.configText
      : applyChoices((this.config.config || {}).defconfig || "", this.config.options, this.pending);
    const unsupported = unsupportedReason(config || "");
    if (unsupported) return unsupported;
    const p = s.plan;
    if (this.loaded && p && p.ref === ref.id && p.unavailable && p.unavailable.length) {
      return `This snapshot does not include ${p.unavailable.join(", ")}, which the build needs.`;
    }
    return "";
  }

  // ── The view ───────────────────────────────────────────────────────

  _dom() {
    this.versionEl = el("div", { class: "wf-version" });
    this.optionsEl = el("div", { class: "wf-options" });
    this.noticeEl = el("div", { class: "wf-box wf-warn", hidden: true });
    this.buildBtn = el("button", { class: "primary", type: "button", text: "Build" });
    this.cancelBtn = el("button", { type: "button", text: "Cancel", hidden: true });
    this.statusEl = el("span", { class: "wf-status" });
    this.consentEl = el("div", { class: "wf-box wf-consent", hidden: true });
    this.stepEl = el("div", { class: "wf-step" });
    this.barEl = el("progress", { max: "1" });
    this.progressEl = el("div", { class: "wf-progress", hidden: true }, [this.stepEl, this.barEl]);
    this.errorEl = el("div", { class: "wf-box wf-error", hidden: true });
    this.memoryEl = el("table", { class: "memory", hidden: true });
    this.filesEl = el("div", { class: "artifacts" });
    this.logPre = el("pre", { class: "log" });
    this.logCount = el("span", { class: "wf-muted" });
    this.logCopy = el("button", { class: "mini", type: "button", text: "Copy", disabled: true });
    this.logBox = el("details", { class: "log-box", hidden: true },
      [el("summary", {}, ["Build log ", this.logCount, " ", this.logCopy]), this.logPre]);
    if (this.behavior.showLog) this.logBox.open = true;
    this.root.append(
      this.versionEl, this.optionsEl, this.noticeEl,
      el("div", { class: "wf-actions" }, [this.buildBtn, this.cancelBtn, this.statusEl]),
      this.consentEl, this.progressEl, this.errorEl, this.memoryEl, this.filesEl, this.logBox,
    );
    this.buildBtn.addEventListener("click", () => this.onBuildClick());
    this.cancelBtn.addEventListener("click", () => this.cancel());
    this.logCopy.addEventListener("click", (e) => {
      // The button sits in the log's <summary>: copying must not fold it.
      e.preventDefault();
      e.stopPropagation();
      if (navigator.clipboard) navigator.clipboard.writeText(this.logPre.textContent).catch(() => {});
    });
    this.logBox.addEventListener("toggle", () => this.onRelayout());
  }

  _changed(what) {
    if (["index", "project", "version", "firmware", "ref", "sources", "lock"].includes(what)) this.renderVersion();
    if (["tree", "config", "sources", "ref", "index", "lock", "project", "version"].includes(what)) this.renderOptions();
    if (["sources", "plan", "ref", "config", "lock", "index", "project", "version"].includes(what)) this.renderButton();
    if (["config", "project", "version", "firmware"].includes(what)) {
      this.renderLink();
      this.renderBuildState();
    }
    if (what === "sources" && this.session.sources.state === "error" && !this.running) {
      this.setStatus("error", "Not loaded", this.session.sources.detail);
    }
  }

  render() {
    this.renderVersion();
    this.renderOptions();
    this.renderButton();
    this.renderLink();
    this.renderBuildState();
  }

  renderVersion() {
    const s = this.session;
    const index = s.index;
    const f = this.config.firmware;
    const box = this.versionEl;
    const title = projectTitle(index, s.project);
    const choices = index ? this.versionChoices() : null;
    const pick = this.behavior.showVersions && (f.projects.length > 1 || (choices && choices.count > 1));
    const { ref, note, error } = this.resolve();
    const badge = ref && !isChecked(ref)
      ? el("span", { class: "wf-badge", text: "unchecked", title: `This snapshot ${uncheckedText(ref)}: WebFlash could not confirm that it builds. It may still work.` })
      : null;
    const detail = ref ? `${title} ${ref.id}: ${ref.describe || ""}${ref.date ? `, ${ref.date}` : ""}${note ? `\n${note}` : ""}` : (error || "");
    if (!pick || !index) {
      const line = el("p", { class: "wf-fixed", title: detail }, [
        el("strong", { text: title }), " ", ref ? refText(ref) : s.version,
      ]);
      if (badge) line.append(" ", badge);
      const why = !index && this.indexError ? `The list of versions did not load: ${this.indexError}` : ref || !index ? "" : error;
      box.replaceChildren(line, why ? el("p", { class: "wf-muted", text: why }) : "");
      return;
    }
    const busy = Boolean(this.running);
    const parts = [];
    if (f.projects.length > 1) {
      const sel = el("select", { "aria-label": "Firmware" });
      for (const p of f.projects) sel.append(new Option(projectTitle(index, p), p));
      sel.value = s.project;
      sel.disabled = busy;
      sel.addEventListener("change", () => this.changeProject(sel.value));
      parts.push(el("label", { class: "wf-field" }, ["Firmware ", sel]));
    }
    const sel = el("select", { "aria-label": "Version", title: detail });
    for (const g of choices.groups) {
      const group = el("optgroup", { label: g.label });
      for (const o of g.options) {
        const opt = new Option(o.label, o.value);
        if (o.title) opt.title = o.title;
        group.append(opt);
      }
      sel.append(group);
    }
    if (choices.value === null) {
      const missing = new Option(`${s.version} (not in the index)`, s.version);
      missing.disabled = true;
      sel.prepend(missing);
    }
    sel.value = s.version;
    sel.disabled = busy;
    sel.addEventListener("change", () => this.changeVersion(sel.value));
    parts.push(el("label", { class: "wf-field" }, ["Version ", sel]));
    if (badge) parts.push(badge);
    box.replaceChildren(el("div", { class: "wf-row" }, parts), error ? el("p", { class: "wf-muted", text: error }) : "");
  }

  /**
   * The versions the reader may pick for the project shown: the site's
   * Version select (version-picker.js), narrowed by the TOML's versions
   * ("releases": the tags; a list: those refs), always with the version the
   * TOML starts from. {groups, value, count}.
   */
  versionChoices() {
    const s = this.session;
    const f = this.config.firmware;
    const { groups, value } = versionOptions(s.index, s.project, s.version);
    const allowed = f.versions;
    const tags = new Set(((groupRefs(s.index, s.project) || {}).releases || []).map((r) => r.id));
    const keep = (o) => o.value === f.version || o.value === s.version || allowed === "all" ||
      (allowed === "releases" ? o.value === "release" || tags.has(o.value) : Array.isArray(allowed) && allowed.includes(o.value));
    const out = groups.map((g) => ({ ...g, options: g.options.filter(keep) })).filter((g) => g.options.length);
    return { groups: out, value, count: out.reduce((n, g) => n + g.options.length, 0) };
  }

  renderOptions() {
    const s = this.session;
    const options = this.config.options;
    this.optionsEl.hidden = !options.length;
    if (!options.length) return;
    const live = this.loaded && s.tree;
    const rows = [...this.optionsEl.children];
    options.forEach((option, i) => {
      let model = live ? liveOption(option, s.tree) : optionModel(option, this.config.config.defconfig);
      if (!live && this.pending.has(option.symbol)) model = { ...model, current: this.pending.get(option.symbol), known: true };
      let row = rows[i];
      if (!row) {
        row = el("div", { class: "wf-option" });
        this.optionsEl.append(row);
      }
      this._renderOption(row, option, model, i, Boolean(live));
    });
    this.onRelayout();
  }

  _renderOption(row, option, model, i, live) {
    const id = `wf-opt-${i}`;
    const busy = Boolean(this.running) || Boolean(this.session.locked);
    const key = `${model.kind}:${live}`;
    if (row.dataset.key !== key) {
      row.dataset.key = key;
      row.replaceChildren();
      row.append(el("label", { class: "wf-option-label", for: id }), el("span", { class: "wf-option-control" }),
        el("p", { class: "wf-option-note", hidden: true }), el("div", { class: "wf-option-help" }));
    }
    const [label, control, noteEl, helpEl] = row.children;
    label.textContent = model.label;
    const error = this.optionErrors.get(option.symbol) || "";
    const enabled = live ? model.enabled : true;
    noteEl.hidden = !(error || (live && model.note));
    noteEl.className = `wf-option-note${error ? " wf-bad" : ""}`;
    noteEl.textContent = error || (live ? model.note : "");

    if (model.kind === "choice" || model.kind === "values") {
      let sel = control.querySelector("select");
      if (!sel) {
        sel = el("select", { id });
        sel.addEventListener("change", () => this.setOption(option, sel.value));
        control.replaceChildren(sel);
      }
      const opts = model.values.map((v) => [v.value, v.label]);
      if (!model.known && model.current === null) opts.unshift(["", "Default"]);
      const sig = JSON.stringify(opts);
      if (sel.dataset.sig !== sig) {
        sel.dataset.sig = sig;
        sel.replaceChildren(...opts.map(([v, t]) => new Option(t, v)));
      }
      sel.value = model.current === null ? "" : model.values.find((v) => isCurrent(model, v.value))?.value ?? model.current;
      sel.disabled = busy || !enabled;
      sel.title = model.current === null ? "The configuration's default: the version's Kconfig says, once it loads." : "";
    } else if (model.kind === "bool") {
      let box = control.querySelector("input");
      if (!box) {
        box = el("input", { type: "checkbox", id });
        box.addEventListener("change", () => this.setOption(option, box.checked ? "y" : "n"));
        control.replaceChildren(box);
      }
      box.checked = model.current === "y";
      box.disabled = busy || !enabled;
    } else if (model.kind === "input") {
      let input = control.querySelector("input");
      if (!input) {
        input = el("input", { type: "text", id, spellcheck: "false", autocomplete: "off" });
        input.addEventListener("change", () => {
          const checked = checkNumber({ type: input.dataset.type, range: input.dataset.range ? JSON.parse(input.dataset.range) : null }, input.value);
          if (checked.error) {
            this.optionErrors.set(option.symbol, checked.error);
            this.renderOptions();
            return;
          }
          this.setOption(option, checked.value);
        });
        control.replaceChildren(input);
      }
      input.dataset.type = model.type || "string";
      if (model.range) input.dataset.range = JSON.stringify(model.range);
      else delete input.dataset.range;
      input.placeholder = model.range ? `${model.range[0]} to ${model.range[1]}` : "";
      // A refused value stays, beside the reason, to be corrected.
      if (document.activeElement !== input && !error) input.value = model.current || "";
      input.disabled = busy || !enabled;
    } else if (model.kind === "free") {
      // Only the Kconfig says what may go here: change it once the configuration loads.
      const shown = model.current !== null && model.current !== "y" && model.current !== "n" ? model.current : "";
      const text = el("span", { class: "wf-muted", text: shown || "as the board's configuration sets it" });
      const change = el("button", {
        class: "mini", type: "button", text: "Change",
        title: "Load this version's configuration to see what this option can be",
      });
      change.disabled = busy;
      change.addEventListener("click", () => this.onChangeClick());
      control.replaceChildren(text, " ", change);
    } else {
      control.replaceChildren(el("span", { class: "wf-muted", text: "not in this version" }));
    }

    const help = option.help ? renderInline(option.help) : "";
    if (help) {
      helpEl.innerHTML = help;
    } else if (live && model.help) {
      helpEl.replaceChildren(el("details", { class: "wf-more" }, [
        el("summary", { text: "About this option" }),
        ...model.help.split(/\n\s*\n/).map((p) => el("p", { text: p.split("\n").map((l) => l.trim()).join(" ") })),
      ]));
      helpEl.querySelector("details").addEventListener("toggle", () => this.onRelayout());
    } else {
      helpEl.replaceChildren();
    }
  }

  renderButton() {
    const reason = this.blockReason();
    const stale = this.stale;
    this.buildBtn.disabled = Boolean(reason);
    this.buildBtn.textContent = this.build && stale ? "Rebuild" : "Build";
    this.buildBtn.title = reason || (this.build && stale ? "The settings changed since the last build: build it again"
      : "Compile the firmware in this browser");
    this.cancelBtn.hidden = this.running !== "build" && this.running !== "load";
    this.cancelBtn.disabled = this.cancelled;
  }

  renderLink() {
    const s = this.session;
    const defconfig = this.loaded ? s.defconfigText : applyChoices(this.config.config.defconfig, this.config.options, this.pending);
    const text = linkToml(this.config, { changed: this.changed, project: s.project, version: s.version, defconfig });
    this.onLink(openInSiteUrl(this.config.board.engine_url || this.env.engine, text));
  }

  // The files and the flash panel follow the build while the settings match it.
  renderBuildState() {
    if (!this.build || this.running) return;
    const stale = this.stale;
    renderArtifacts(this.filesEl, this.build, { stale });
    const show = stale ? null : this.build;
    if (show !== this.shownBuild) {
      this.shownBuild = show;
      this.onBuild(show);
    }
    this.renderButton();
  }

  _renderNotice(notice) {
    const box = this.noticeEl;
    box.hidden = !notice;
    if (notice) {
      box.className = `wf-box wf-${notice.kind === "error" ? "error" : notice.kind === "warn" ? "warn" : "info"}`;
      box.innerHTML = `<p><strong>${esc(notice.title)}</strong></p>` + notice.lines.map((l) => `<p>${esc(l)}</p>`).join("");
      const close = el("button", { class: "mini", type: "button", text: "Dismiss" });
      close.addEventListener("click", () => this.configurator.dismissNotice());
      box.append(close);
    }
    this.onRelayout();
  }

  setStatus(cls, text, title = "") {
    this.statusEl.className = `wf-status${cls ? ` ${cls}` : ""}`;
    this.statusEl.textContent = text;
    this.statusEl.title = title;
  }

  // ── The reader's choices ─────────────────────────────────────────

  changeProject(project) {
    const s = this.session;
    // A ref id belongs to one project; the aliases work for any.
    const f = this.config.firmware;
    const version = ["latest", "release"].includes(s.version) ? s.version
      : ["latest", "release"].includes(f.version) ? f.version : "latest";
    s.setProject(project, { version });
    this._afterSwitch();
  }

  changeVersion(version) {
    this.session.setVersion(version);
    this._afterSwitch();
  }

  // Once the configuration has loaded, a switch loads the new version at
  // once (Python is up; the sources are small), carrying the configuration.
  _afterSwitch() {
    this.renderLink();
    if (!this.configurator.loaded) return;
    this.setStatus("busy", "Loading the version…");
    this.configurator.load({ reason: "switch" }).then((ok) => {
      if (ok) this.setStatus("", "");
    });
  }

  /**
   * One option to a value: remembered until the configuration loads, else
   * set in the engine at once (kconfig_set), the tree following.
   */
  async setOption(option, value) {
    this.optionErrors.delete(option.symbol);
    if (!this.loaded) {
      const model = optionModel(option, this.config.config.defconfig);
      if (value === "" || (model.known && isCurrent(model, value))) this.pending.delete(option.symbol);
      else this.pending.set(option.symbol, value);
      this.renderOptions();
      this.renderLink();
      this.renderBuildState();
      return;
    }
    const model = liveOption(option, this.session.tree);
    if (isCurrent(model, value)) return;
    try {
      await this.configurator.set(model.set, value);
      this.optionsChanged = true;
    } catch (e) {
      this.optionErrors.set(option.symbol, runtime.pythonMessage(e));
      this.renderOptions();
    }
    this.renderLink();
  }

  // The choices made before the configuration loaded, set in the engine. A
  // choice the tree hides may be shown by a later one (a bitrate listed before
  // the interface that needs it), so they go in passes, in the TOML's order,
  // until a pass sets nothing; only the ones still hidden then are reported.
  // An aborted signal stops between choices: the rest stay for the next run.
  async applyPending(signal = null) {
    const s = this.session;
    let applied = true;
    while (applied && this.pending.size) {
      applied = false;
      for (const option of this.config.options) {
        if (signal && signal.aborted) return;
        if (!this.pending.has(option.symbol)) continue;
        const model = liveOption(option, s.tree);
        if (!model.enabled) continue;
        const value = this.pending.get(option.symbol);
        this.pending.delete(option.symbol);
        if (isCurrent(model, value)) continue;
        try {
          await this.configurator.set(model.set, value);
          this.optionsChanged = true;
          applied = true;
        } catch (e) {
          this.optionErrors.set(option.symbol, runtime.pythonMessage(e));
          throw new Error(`${model.label}: ${runtime.pythonMessage(e)}`);
        }
      }
    }
    for (const option of this.config.options) {
      if (!this.pending.has(option.symbol)) continue;
      const model = liveOption(option, s.tree);
      this.appendLog(`${model.label}: ${this.pending.get(option.symbol)} was not applied: ${model.note}`);
      this.pending.delete(option.symbol);
    }
  }

  // ── Downloads, asked for first ───────────────────────────────────

  /**
   * What loading the configuration ("load") or building ("build") downloads
   * now: [{label, size, sizeText, cached}].
   */
  async downloads(kind) {
    const s = this.session;
    const items = [];
    if (!runtime.isReady()) {
      items.push({ label: "The Python runtime (Pyodide), from cdn.jsdelivr.net", size: null, approx: 7 * 1048576, sizeText: "about 7 MB", cached: false });
    }
    const { ref } = this.resolve();
    if (!this.loaded && ref) {
      items.push({
        label: `${projectTitle(s.index, s.project)} ${ref.id}'s sources`, size: blobSize(s.index, ref.core),
        cached: await isCached(blobUrl(ref.core)),
      });
    }
    if (kind === "build") {
      const tc = await this.builder.discover();
      const plan = this.loaded && s.plan && s.ref && s.plan.ref === s.ref.id && !s.plan.error ? s.plan : null;
      // Before the configuration loads, the sources are listed above.
      items.push(...await this.builder.downloads(tc, {
        project: s.project, ref: s.ref || ref, index: this.loaded ? s.index : null, libs: plan ? plan.libs : [],
      }));
      if (!plan) {
        items.push({ label: "The library bundles of this chip (about 1 MB for an STM32G0B1, up to 5 MB for an STM32H7)", size: null, sizeText: "", cached: false });
      }
    }
    return items;
  }

  /** Whether the reader agreed to what kind downloads: at once when nothing is new or a build worked here before. */
  async consent(kind) {
    if (remembered(AUTO_KEY) === "1") return true;
    let list;
    try {
      list = await this.downloads(kind);
    } catch (e) {
      this.showFailure(kind === "build" ? "No compiler" : "Could not start", e.message);
      return false;
    }
    if (!list.some((d) => !d.cached)) return true;
    return this.askConsent(kind, list);
  }

  askConsent(kind, list) {
    const s = this.session;
    const { ref } = this.resolve();
    const what = `${projectTitle(s.index, s.project)} ${ref ? ref.id : s.version}`;
    const fresh = list.filter((d) => !d.cached);
    const total = fresh.reduce((n, d) => n + (d.size || d.approx || 0), 0);
    const approx = fresh.some((d) => !d.size);
    const rest = fresh.some((d) => !d.size && !d.approx) ? ", plus the chip's library bundles" : "";
    const box = this.consentEl;
    box.hidden = false;
    box.innerHTML =
      `<p><strong>${kind === "build" ? `Build ${esc(what)}` : `Load the options of ${esc(what)}`}</strong> in this browser. ` +
      `${kind === "build" ? "The first build downloads" : "This downloads"}:</p>` +
      `<ul class="wf-downloads">` + list.map((d) =>
        `<li><span>${esc(d.label)}</span><span class="wf-size">${esc(d.size ? formatBytes(d.size) : d.sizeText || "")}</span>` +
        `${d.cached ? `<span class="wf-cached">in this browser's cache</span>` : ""}</li>`).join("") +
      `</ul><p class="wf-muted">${total ? `${approx ? "About " : ""}${esc(formatBytes(total))} in all${esc(rest)}, kept` : "Kept"} ` +
      `in this browser's cache, so later builds start at once. Nothing you pick or build leaves the browser.</p>`;
    const go = el("button", { class: "primary", type: "button", text: kind === "build" ? "Download and build" : "Download and continue" });
    const no = el("button", { type: "button", text: "Not now" });
    box.append(el("div", { class: "wf-actions" }, [go, no]));
    this.onRelayout();
    return new Promise((resolve) => {
      const done = (answer) => {
        box.hidden = true;
        box.replaceChildren();
        this.onRelayout();
        resolve(answer);
      };
      go.addEventListener("click", () => done(true));
      no.addEventListener("click", () => done(false));
      go.focus();
    });
  }

  // ── Loading and building ─────────────────────────────────────────

  async onBuildClick() {
    if (this.blockReason()) return;
    this.clearError();
    if (!(await this.consent("build"))) return;
    this.run({ build: true });
  }

  async onChangeClick() {
    if (this.running || this.loaded || this.blockReason()) return;
    this.clearError();
    if (!(await this.consent("load"))) return;
    this.run({ build: false });
  }

  async run({ build }) {
    const s = this.session;
    if (this.running || this.blockReason()) return;
    this.running = build ? "build" : "load";
    this.cancelled = false;
    // Cancel ends the wait for the configuration at once; its load goes on in
    // the engine's queue, which keeps the engine consistent.
    const stop = new AbortController();
    this._stop = stop;
    this.failed = null;
    this.resetView();
    this.startClock(build ? "Building" : "Loading");
    this.render();
    // The compiler downloads while Python starts and the sources load, rather
    // than after them; prepare() below joins that download. A failure there
    // is left to prepare(), which loads it again and says why.
    if (build && !this.loaded) this.builder.discover().then((tc) => this.builder.fetchToolchain(tc)).catch(() => {});
    try {
      if (!this.loaded) await untilAborted(this.loadConfiguration(stop.signal), stop.signal);
      else await untilAborted(this.applyPending(stop.signal), stop.signal);
      this.checkCancelled();
      if (!build) {
        this.finishLoaded();
        return;
      }
      // A defconfig that leaves the architecture to the Kconfig's default
      // shows it only now (Klipper's is AVR).
      const unsupported = unsupportedReason(s.configText || "");
      if (unsupported) throw new Error(unsupported);
      const tc = await untilAborted(this.builder.discover(), stop.signal);
      this.builder.begin();
      this.checkCancelled();
      await this.builder.prepare(tc, { step: (text) => this.step(text) });
      // Later builds start without asking only when the release is in Cache
      // Storage: one held in memory (a browser without Cache Storage, or one
      // that evicted it) would download again.
      this.builder.cached = (await cachedFlags(tc.files)).every(Boolean);
      if (this.builder.cached) remember(AUTO_KEY, "1");
      const job = { project: s.project, ref: s.ref, configText: s.configText, defconfigText: s.defconfigText };
      s.setLocked("A build is running.");
      const out = await this.configurator.exclusive(() => {
        if (!s.ref || s.ref.id !== job.ref.id || s.project !== job.project) throw new Error("The version changed before the build started.");
        return this.builder.run({
          project: job.project, ref: job.ref, index: s.index, configText: job.configText, defconfigText: job.defconfigText,
          step: (text) => this.step(text), onProgress: (phase, detail, info) => this.onEngineProgress(phase, detail, info),
        });
      });
      this.finishOk(out, job);
    } catch (e) {
      if (e instanceof BuildCancelled || this.cancelled) this.finishCancelled();
      else this.finishFailed(this.failed, e);
    } finally {
      if (this._stop === stop) this._stop = null;
      this.running = "";
      s.setLocked("");
      this.stopClock();
      this.flushLog();
      this.render();
    }
  }

  checkCancelled() {
    if (this.cancelled) throw new BuildCancelled();
  }

  /**
   * The Python runtime, the version's sources and its Kconfig (they download
   * side by side: one step, its bar the sources' bytes), then the reader's
   * choices. Once signal aborts (the run was cancelled), it reports nothing
   * and leaves the choices for the next run.
   */
  async loadConfiguration(signal = null) {
    const s = this.session;
    const { ref } = this.resolve();
    const label = `${projectTitle(s.index, s.project)} ${ref ? ref.id : s.version}`;
    const row = this.step(`Loading ${label}`);
    const what = (text) => {
      if (this.stepEl.dataset.text === row.text) this.stepEl.textContent = `${row.text} · ${text}`;
    };
    const offBoot = runtime.onProgress((phase) => {
      if (phase === "runtime") what("starting Python");
      else if (phase === "ready") this.appendLog("The Python runtime is ready.");
    });
    const offSources = s.on("change", ({ what: changed }) => {
      const st = s.sources;
      if (changed !== "sources" || st.state !== "loading") return;
      if (st.phase === "kconfig") what("reading the Kconfig files");
      else if (st.phase === "extract") what("unpacking the sources");
      else if (Number.isFinite(st.total) && st.total > 0) {
        row.progress(st.done || 0, st.total);
        // The sources are in; they unpack once Python is up.
        if ((st.done || 0) >= st.total && !runtime.isReady()) what("starting Python");
      }
    });
    let ok;
    try {
      ok = await this.configurator.load({ reason: this.configurator.loaded ? "switch" : "open" });
    } finally {
      offSources();
      offBoot();
    }
    if (signal && signal.aborted) return;
    if (!ok) throw new Error(s.sources.state === "error" ? s.sources.detail : `${label} did not load.`);
    row.finish(`${s.ref ? s.ref.describe || s.ref.id : ""}, sources ${s.sources.cached ? "from this browser's cache" : formatBytes(s.sources.size)}`);
    this.checkCancelled();
    if (this.pending.size) {
      const apply = this.step("Applying your choices");
      await this.applyPending(signal);
      apply.finish();
    }
  }

  onEngineProgress(phase, detail, info) {
    if (!ENGINE_PHASES.has(phase)) return;
    if (phase === "log") {
      this.appendLog(detail);
      return;
    }
    if (phase === "failed") {
      this.failed = detail;
      return;
    }
    if (Number.isFinite(info.total) && info.total > 0) this.setBar(info.done || 0, info.total);
    if (phase === "configure") this.setStep("Configuring");
    else if (phase === "plan") this.setStep("Reading the Makefiles");
    else if (phase === "build") this.setStep(`Building: ${detail}`);
    else if (phase === "step") this.setStep(detail);
  }

  /** A row of what the build does, as builder.js draws it: the status line and the log. */
  step(text) {
    this.setStep(text);
    this.setBar(null);
    const started = now();
    return {
      text,
      progress: (done, total) => {
        if (this.stepEl.dataset.text !== text) return;
        this.setBar(done, total);
        this.stepEl.textContent = Number.isFinite(total) && total > 0
          ? `${text} · ${total > 64 ? `${Math.min(100, Math.round((100 * done) / total))}%` : `${done} of ${total}`}`
          : text;
      },
      finish: (note = null) => {
        const ms = now() - started;
        this.appendLog(`${text}${note ? `: ${note}` : ms >= 100 ? `: ${seconds(ms)}` : ""}`);
      },
    };
  }

  async cancel() {
    if (!this.running || this.cancelled) return;
    this.cancelled = true;
    if (this._stop) this._stop.abort();
    this.renderButton();
    this.setStep("Cancelling…");
    if (this.running === "build") await this.builder.cancel("the build was cancelled");
  }

  finishLoaded() {
    this.progressEl.hidden = true;
    this.setStatus("", "Options loaded", "The version's configuration is loaded: the options follow its Kconfig now.");
  }

  finishOk({ result, outputs, stats }, job) {
    const s = this.session;
    const total = now() - this.clockStart;
    const build = buildRecord(result, outputs, { project: job.project, ref: job.ref.id });
    const engine = Number(result.duration) * 1000;
    build.timing = { engine, total, workers: this.builder.pool ? this.builder.pool.size : 0, summary: stats };
    this.build = build;
    this.progressEl.hidden = true;
    // The time the clock showed: the wait from the click, downloads included.
    this.setStatus("ok", `Built in ${seconds(total)}`, `Compiling took ${seconds(engine)}; the rest was downloading and starting the compiler.`);
    this.appendLog(`Built ${build.version} in ${seconds(total)} (compiling ${seconds(engine)}).`);
    if (!this.behavior.compact) renderMemory(this.memoryEl, build.memory);
    // The site's configure code reloads the defconfig into the engine after a
    // build (bridge.build pins the full .config); the session does it here too.
    s.build = build;
    s._changed("build", "build");
    this.shownBuild = undefined;
    this.renderBuildState();
  }

  finishCancelled() {
    this.progressEl.hidden = true;
    this.setStatus("", "Cancelled", "Cancelled. Build starts again.");
    this.appendLog("Cancelled.");
  }

  finishFailed(failed, error) {
    const message = failed || runtime.pythonMessage(error);
    this.progressEl.hidden = true;
    this.setStatus("error", "Failed", message.split("\n")[0]);
    this.showFailure(this.running === "load" ? "The configuration did not load" : "The build failed", message);
    this.logBox.open = true;
  }

  showFailure(title, message) {
    const { command, code, output } = splitFailure(message);
    const box = this.errorEl;
    box.hidden = false;
    box.innerHTML = `<p><strong>${esc(title)}</strong></p>` +
      (command ? `<p>This command failed${code !== null ? ` (exit code ${code})` : ""}:</p><pre class="wf-cmd">${esc(command)}</pre>` : "") +
      (output ? `<pre class="wf-out">${esc(output)}</pre>` : "");
    this.onRelayout();
  }

  clearError() {
    this.errorEl.hidden = true;
    this.errorEl.replaceChildren();
  }

  // ── Progress, status and log ─────────────────────────────────────

  resetView() {
    this.clearError();
    this.progressEl.hidden = false;
    this.memoryEl.hidden = true;
    this.logBox.hidden = false;
    clearTimeout(this._logTimer);
    this._logTimer = null;
    this.logBuffer = [];
    this.logPre.textContent = "";
    this.logLines = 0;
    this.logCount.textContent = "";
    this.logCopy.disabled = true;
    this.setBar(null);
    this.onRelayout();
  }

  setStep(text) {
    this.stepEl.dataset.text = text;
    this.stepEl.textContent = text;
  }

  setBar(done, total = null) {
    if (done === null || !Number.isFinite(total) || total <= 0) {
      this.barEl.removeAttribute("value");
      return;
    }
    this.barEl.max = total;
    this.barEl.value = Math.min(done, total);
  }

  // A build logs hundreds of lines: they reach the page ten times a second.
  appendLog(line) {
    this.logBuffer.push(String(line));
    if (!this._logTimer) this._logTimer = setTimeout(() => this.flushLog(), 100);
  }

  flushLog() {
    clearTimeout(this._logTimer);
    this._logTimer = null;
    if (!this.logBuffer.length) return;
    const pre = this.logPre;
    const follow = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
    pre.append(document.createTextNode(`${this.logBuffer.join("\n")}\n`));
    this.logLines += this.logBuffer.length;
    this.logBuffer = [];
    if (follow) pre.scrollTop = pre.scrollHeight;
    this.logCount.textContent = `${this.logLines} line${this.logLines === 1 ? "" : "s"}`;
    this.logCopy.disabled = false;
  }

  startClock(verb) {
    this.clockStart = now();
    const tick = () => this.setStatus("busy", `${this.cancelled ? "Cancelling" : verb} · ${seconds(now() - this.clockStart)}`);
    tick();
    clearInterval(this._clock);
    this._clock = setInterval(tick, 250);
  }

  stopClock() {
    clearInterval(this._clock);
    this._clock = null;
  }
}
