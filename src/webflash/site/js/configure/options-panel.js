// The Embed options tab: everything the board TOML says besides the
// configurations themselves. Page ([board] title, description, image,
// theme); the setups the reader picks from (one row per [[setup]]: title
// and description edited in place, a summary line, Edit, Remove, reorder,
// and "+ Add the current configuration"); Versions ([firmware] projects and
// versions, and [katapult]: offered or not, ticked when the card opens, its
// versions); then, folded: Flashing methods ([flash] methods and
// instructions, and each setup's own methods), Options the reader can
// change (the [[option]] list: the Kconfig tree again, with a "the reader
// can change this" box per symbol and choice and, under each one ticked,
// its label, values, help and the setups it applies to), and Card behavior
// (the theme's [behavior], read-only: a board TOML cannot set it). Every
// field writes into the session, and so into the TOML, when it changes.

import { METHODS, PROJECTS, PROJECT_TITLES } from "../state.js";
import { esc } from "../dialogs.js";
import { inferMethods } from "../flash/devices.js";
import { KconfigTree, checkNumber } from "./kconfig-tree.js";
import { mountVersionPicker } from "./version-picker.js";
import { groupRefs } from "./sources.js";
import {
  addSetup, retitleSetup, describeSetup, removeSetup, moveSetup, setSetupMethods, setupSummary, setupTitle,
} from "./setups.js";

export const METHOD_TITLES = {
  dfu: "STM32 DFU (USB)",
  picoboot: "RP2040 / RP2350 BOOTSEL (USB)",
  uf2: "UF2 file to the BOOTSEL drive",
  katapult: "Katapult (USB or serial)",
  "katapult-can": "Katapult over CAN",
  download: "Download the firmware",
};

// The theme's [behavior] keys, as the Card behavior fold lists them.
export const BEHAVIOR_TITLES = {
  show_log: "Log open at the start",
  show_image: "Show the photo",
  compact: "Compact",
  show_versions: "Version selects",
  confirm_flash: "Ask before flashing",
  font_scale: "Text size",
  max_width: "Widest (px)",
};

const field = (el, value) => {
  const v = value == null ? "" : String(value);
  if (document.activeElement !== el && el.value !== v) el.value = v;
};

// Set innerHTML only when the markup changed, so focus and scroll stay.
const fill = (el, html) => {
  if (el.dataset.html === html) return false;
  el.innerHTML = html;
  el.dataset.html = html;
  return true;
};

/** The [[option]] an exposed tree node is, if any: by symbol, or for a choice by any member. */
export function optionFor(options, node) {
  if (!node) return null;
  if (node.kind === "choice") {
    const names = (node.members || []).map((m) => m.name);
    return options.find((o) => names.includes(o.symbol)) || null;
  }
  return options.find((o) => o.symbol === node.name) || null;
}

/** The theme's behavior values as one line: "log open, ask before flashing". */
export function behaviorLine(behavior) {
  if (!behavior) return "";
  const on = [];
  if (behavior.show_log) on.push("log open");
  if (behavior.compact) on.push("compact");
  if (behavior.show_image === false) on.push("no photo");
  if (behavior.show_versions === false) on.push("no version selects");
  if (behavior.confirm_flash) on.push("ask before flashing");
  return on.join(", ") || "defaults";
}

// The version controls of one project's table ([firmware] or [katapult]).
const versionControls = (p) =>
  `<div class="form-row"><span>Starts with</span><div class="opt-vp" id="${p}-version"></div></div>` +
  `<div class="form-row"><span>The reader may pick</span>` +
  `<div class="opt-checks" id="${p}-versions-mode">` +
  `<label class="check"><input type="radio" name="${p}-versions" value="all"> All</label>` +
  `<label class="check"><input type="radio" name="${p}-versions" value="releases"> Releases only</label>` +
  `<label class="check"><input type="radio" name="${p}-versions" value="list"> These:</label></div>` +
  `<div class="opt-checks opt-ref-list" id="${p}-versions-list"></div></div>`;

export class OptionsPanel {
  /**
   * actions: themes() (the bundled themes, once listed), wantThemes() (list
   * them now), onVersion(version) (switch the firmware's version, as page
   * 1's select does), onKatapultVersion(version), onKatapult(on) (offer
   * Katapult or take it out of the TOML), loadSetup(i) (load setup i into
   * the engine; resolves when loaded) and editSetup(i) (the same, then
   * Configure). Without them the panel only changes the session.
   */
  constructor(container, session, actions = {}) {
    this.container = container;
    this.session = session;
    this.themes = actions.themes || (() => []);
    this.wantThemes = actions.wantThemes || (() => {});
    this.onVersion = actions.onVersion || ((version) => session.setVersion(version));
    this.onKatapultVersion = actions.onKatapultVersion || ((version) => session.setKatapultTable({ version }));
    this.onKatapult = actions.onKatapult || ((on) => (on ? session.setKatapult({ on: true }) : session.removeKatapult()));
    this.loadSetup = actions.loadSetup || (async (i) => session.setSetupIndex(i));
    this.editSetup = actions.editSetup || this.loadSetup;
    this._adding = new Set();   // methods whose instructions box was opened but is still empty
    this._methodTarget = -1;    // whose methods the Flashing fold edits: -1 [flash], else a setup index
    this._configs = new Map();  // a setup's full .config, by project and defconfig, once it was configured
    this._picks = new Map();    // a "Starts with" host → what a pick there does
    this.pickers = new Map();   // a "Starts with" host → its version picker
    this._build();
    this._bind();
    this.render();
  }

  _build() {
    const methodRows = METHODS.map((m) =>
      `<li class="method-row" data-method="${m}">` +
      `<label class="check"><input type="checkbox" data-act="method-on"> ${esc(METHOD_TITLES[m])}</label>` +
      `<span class="method-id">${m}</span>` +
      `<button type="button" class="mini" data-act="method-up" aria-label="Move ${esc(METHOD_TITLES[m])} up" title="Move up">↑</button>` +
      `<button type="button" class="mini" data-act="method-down" aria-label="Move ${esc(METHOD_TITLES[m])} down" title="Move down">↓</button>` +
      `</li>`).join("");
    this.container.innerHTML = `
      <div class="opt-scroll">
        <section class="opt-section" aria-labelledby="opt-h-page">
          <h3 id="opt-h-page">Page</h3>
          <label class="form-row">Title
            <input type="text" id="opt-title" autocomplete="off" required>
          </label>
          <label class="form-row">Description
            <textarea id="opt-description" rows="3" title="**bold**, \`code\` and [links](https://…) work"></textarea>
          </label>
          <div class="form-pair">
            <label class="form-row">Photo
              <input type="text" id="opt-image" autocomplete="off" placeholder="board.png" title="A file beside the TOML, or a URL">
            </label>
            <label class="form-row">Theme
              <select id="opt-theme"></select>
            </label>
          </div>
        </section>

        <section class="opt-section" id="opt-setups-section" aria-labelledby="opt-h-setups">
          <h3 id="opt-h-setups">Setups the reader picks from</h3>
          <ol class="setup-list" id="opt-setups"></ol>
          <div class="opt-actions">
            <button type="button" class="mini" id="opt-setup-add">+ Add the current configuration</button>
            <button type="button" class="mini" id="opt-setup-undo">Undo</button>
            <span class="opt-note" id="opt-setups-note" role="status">Edit loads a setup into Configure.</span>
          </div>
        </section>

        <section class="opt-section" id="opt-firmware" aria-labelledby="opt-h-fw">
          <h3 id="opt-h-fw">Versions</h3>
          <div class="form-row"><span>Firmware the reader may pick</span>
            <div class="opt-checks" id="opt-projects">${PROJECTS.map((p) =>
              `<label class="check"><input type="checkbox" value="${p}"> ${PROJECT_TITLES[p]}</label>`).join("")}</div>
          </div>
          <div class="opt-versions">${versionControls("opt")}</div>
          <div id="opt-katapult-block">
            <div class="opt-checks">
              <label class="check"><input type="checkbox" id="opt-katapult-on"> Offer Katapult</label>
              <label class="check" id="opt-katapult-default-row"><input type="checkbox" id="opt-katapult-default"> Ticked when the card opens</label>
            </div>
            <div class="opt-versions" id="opt-katapult-versions">${versionControls("opt-k")}</div>
          </div>
        </section>

        <details class="spoiler opt-fold" id="opt-flash-fold">
          <summary>Flashing methods <span class="opt-fold-n" id="opt-flash-n"></span></summary>
          <div class="opt-section">
            <label class="form-row" id="opt-method-target-row">For
              <select id="opt-method-target"></select>
            </label>
            <div class="opt-checks" id="opt-method-mode">
              <label class="check"><input type="radio" name="opt-methods" value="auto"> <span id="opt-method-auto">From the configuration</span></label>
              <label class="check"><input type="radio" name="opt-methods" value="list"> These, in order:</label>
            </div>
            <ol class="method-list" id="opt-method-list">${methodRows}</ol>
            <div id="opt-instructions"></div>
          </div>
        </details>

        <details class="spoiler opt-fold" id="opt-options-fold">
          <summary>Options the reader can change <span class="opt-fold-n" id="opt-options-n"></span></summary>
          <div class="opt-section" id="opt-options">
            <p class="opt-note">Tick an option to let the reader change it.</p>
            <div class="panel-bar opt-search">
              <input type="search" id="opt-search" placeholder="Search options" aria-label="Search the options">
              <span class="kc-count" id="opt-count"></span>
            </div>
            <div class="opt-unknown" id="opt-unknown" hidden></div>
            <div id="opt-tree"></div>
            <p class="placeholder opt-empty" id="opt-tree-empty">Load a version on Configure to list the options.</p>
          </div>
        </details>

        <details class="spoiler opt-fold" id="opt-behavior-fold">
          <summary>Card behavior <span class="opt-fold-n" id="opt-behavior-n"></span></summary>
          <div class="opt-section">
            <ul class="opt-behavior" id="opt-behavior"></ul>
            <p class="opt-note">Set by the theme.</p>
          </div>
        </details>
      </div>`;
    const $ = (id) => this.container.querySelector(`#${id}`);
    this.el = {
      title: $("opt-title"), description: $("opt-description"), image: $("opt-image"), theme: $("opt-theme"),
      setupsSection: $("opt-setups-section"), setups: $("opt-setups"), add: $("opt-setup-add"),
      undo: $("opt-setup-undo"), setupsNote: $("opt-setups-note"),
      firmware: $("opt-firmware"), projects: $("opt-projects"),
      version: $("opt-version"), versionsMode: $("opt-versions-mode"), versionsList: $("opt-versions-list"),
      katapultBlock: $("opt-katapult-block"), katapultOn: $("opt-katapult-on"),
      katapultDefault: $("opt-katapult-default"), katapultDefaultRow: $("opt-katapult-default-row"),
      katapultVersions: $("opt-katapult-versions"), kVersion: $("opt-k-version"),
      kVersionsMode: $("opt-k-versions-mode"), kVersionsList: $("opt-k-versions-list"),
      flashFold: $("opt-flash-fold"), flashN: $("opt-flash-n"),
      methodTargetRow: $("opt-method-target-row"), methodTarget: $("opt-method-target"),
      methodAuto: $("opt-method-auto"), methodList: $("opt-method-list"), instructions: $("opt-instructions"),
      optionsFold: $("opt-options-fold"), optionsN: $("opt-options-n"),
      options: $("opt-options"), search: $("opt-search"), count: $("opt-count"), unknown: $("opt-unknown"),
      tree: $("opt-tree"), treeEmpty: $("opt-tree-empty"),
      behaviorFold: $("opt-behavior-fold"), behaviorN: $("opt-behavior-n"), behavior: $("opt-behavior"),
    };
    this.tree = new KconfigTree(this.el.tree, {
      mode: "expose",
      idPrefix: "kx",
      isExposed: (node) => Boolean(optionFor(this.session.options, node)),
      onExpose: (node, on) => this._expose(node, on),
      renderEditor: (node, slot) => this._editor(node, slot),
    });
  }

  _bind() {
    const s = this.session;
    const e = this.el;
    e.title.addEventListener("change", () => {
      const v = e.title.value.trim();
      if (v) s.setBoard({ title: v });
      else e.title.value = s.board.title;   // the title is required
    });
    e.description.addEventListener("change", () => s.setBoard({ description: e.description.value.trim() }));
    e.image.addEventListener("change", () => s.setBoard({ image: e.image.value.trim() }));
    e.theme.addEventListener("change", () => s.setTheme(e.theme.value));
    e.theme.addEventListener("focus", () => this.fillThemes());
    e.behaviorFold.addEventListener("toggle", () => { if (e.behaviorFold.open) this.wantThemes(); });

    this._bindSetups();

    e.projects.addEventListener("change", () => {
      const f = s.firmware;
      if (!f) return;
      let projects = [...e.projects.querySelectorAll("input:checked")].map((i) => i.value);
      if (!projects.includes(f.project)) projects.unshift(f.project);
      if (f.project === "katapult") projects = ["katapult"];
      else projects = projects.filter((p) => p !== "katapult");
      s.setFirmware({ projects: PROJECTS.filter((p) => projects.includes(p)) });
    });
    this._bindVersions({
      select: e.version, mode: e.versionsMode, list: e.versionsList,
      table: () => s.firmware, project: () => s.project,
      set: (fields) => s.setFirmware(fields), pick: (v) => this.onVersion(v),
    });
    this._bindVersions({
      select: e.kVersion, mode: e.kVersionsMode, list: e.kVersionsList,
      table: () => s.tables().katapult, project: () => "katapult",
      set: (fields) => s.setKatapultTable(fields), pick: (v) => this.onKatapultVersion(v),
    });
    e.katapultOn.addEventListener("change", () => this.onKatapult(e.katapultOn.checked));
    e.katapultDefault.addEventListener("change", () => s.setKatapultTable({ default: e.katapultDefault.checked }));

    e.methodTarget.addEventListener("change", () => {
      this._methodTarget = Number(e.methodTarget.value);
      this.render();
    });
    e.flashFold.addEventListener("change", (ev) => {
      if (ev.target.name !== "opt-methods") return;
      const auto = ev.target.value === "auto";
      this._setMethods(auto ? null : (this._methods() || this._inferredOrder()));
    });
    e.methodList.addEventListener("change", (ev) => {
      if (ev.target.dataset.act !== "method-on") return;
      const methods = [...e.methodList.querySelectorAll("li")]
        .filter((li) => li.querySelector("input").checked).map((li) => li.dataset.method);
      if (methods.length) this._setMethods(methods);
      else this.render();   // a list keeps at least one method
    });
    e.methodList.addEventListener("click", (ev) => {
      const btn = ev.target.closest("button[data-act]");
      const current = this._methods();
      if (!btn || !current) return;
      const method = btn.closest("li").dataset.method;
      const methods = [...current];
      const i = methods.indexOf(method);
      const j = i + (btn.dataset.act === "method-up" ? -1 : 1);
      if (i < 0 || j < 0 || j >= methods.length) return;
      [methods[i], methods[j]] = [methods[j], methods[i]];
      this._setMethods(methods);
      this.container.querySelector(`li[data-method="${methods[j]}"] button[data-act="${btn.dataset.act}"]`)?.focus();
    });
    e.instructions.addEventListener("change", (ev) => {
      if (ev.target.dataset.act === "add-instructions") {
        const m = ev.target.value;
        if (!m) return;
        this._adding.add(m);
        this.render();
        e.instructions.querySelector(`textarea[data-method="${m}"]`)?.focus();
        return;
      }
      const method = ev.target.dataset.method;
      if (!method) return;
      const instructions = { ...s.flash.instructions };
      const v = ev.target.value.trim();
      if (v) instructions[method] = v;
      else delete instructions[method];
      // Keep the methods' order, so the TOML lists them as the page does.
      const ordered = {};
      for (const m of METHODS) if (instructions[m] !== undefined) ordered[m] = instructions[m];
      s.setFlash({ instructions: ordered });
    });

    e.search.addEventListener("input", () => {
      const { matches, hidden } = this.tree.setFilter(e.search.value);
      e.count.textContent = e.search.value.trim()
        ? `${matches} match${matches === 1 ? "" : "es"}${hidden ? `, ${hidden} hidden` : ""}` : "";
    });
    e.unknown.addEventListener("click", (ev) => {
      const btn = ev.target.closest("button[data-symbol]");
      if (btn) s.setOptions(s.options.filter((o) => o.symbol !== btn.dataset.symbol));
    });

    s.on("change", ({ what }) => {
      if (what === "config") this._rememberConfig();
      if (what === "tree" || what === "ref") this._renderTree();
      else if (what === "options" || what === "setups") this.tree.render();
      if (["board", "firmware", "project", "version", "flash", "prebuilt", "open", "index", "options", "tree", "undo",
        "setups", "setup", "katapult", "config", "lock"].includes(what)) {
        this.render();
      }
    });
  }

  // ── Setups ─────────────────────────────────────────────────────────

  _bindSetups() {
    const s = this.session;
    const e = this.el;
    e.add.addEventListener("click", () => {
      const out = addSetup(s.tables(), s.setupIndex);
      s.setSetups(out, { selected: out.selected });
      this._note(`Added “${out.setups[out.selected].title}”. Configure now edits it.`);
      // Name it at once: the title is selected for typing over.
      const input = e.setups.querySelector(`li[data-i="${out.selected}"] [data-f="title"]`);
      if (input) {
        input.focus();
        if (input.select) input.select();
      }
    });
    e.undo.addEventListener("click", () => s.undo());
    e.setups.addEventListener("change", (ev) => {
      const row = ev.target.closest("li[data-i]");
      if (!row) return;
      const i = Number(row.dataset.i);
      const t = ev.target;
      const out = t.dataset.f === "title" ? retitleSetup(s.tables(), i, t.value)
        : t.dataset.f === "description" ? describeSetup(s.tables(), i, t.value) : null;
      if (!out) return;
      if (out.error) {
        this._note(out.error, true);
        const setup = s.tables().setups[i];
        t.value = setup ? setup[t.dataset.f] : "";
        return;
      }
      if (out.setups) s.setSetups(out);
      this._note();
    });
    e.setups.addEventListener("click", (ev) => {
      const btn = ev.target.closest("button[data-act]");
      const row = btn && btn.closest("li[data-i]");
      if (!row) return;
      const i = Number(row.dataset.i);
      const act = btn.dataset.act;
      if (act === "edit") {
        this.editSetup(i);
      } else if (act === "remove") {
        const tables = s.tables();
        const out = removeSetup(tables, i, s.setupIndex);
        if (out.error) {
          this._note(out.error, true);
          return;
        }
        const title = setupTitle(tables.setups[i], i);
        const { reload } = s.setSetups(out, { selected: out.selected });
        this._note(`Removed “${title}”` + (out.dropped.length
          ? ` and ${out.dropped.length === 1 ? "its reader option" : `${out.dropped.length} reader options`}.` : "."));
        if (reload) this.loadSetup(s.setupIndex);
        this.el.setups.querySelector(`li[data-i="${Math.min(i, s.tables().setups.length - 1)}"] [data-act="edit"]`)?.focus();
      } else if (act === "up" || act === "down") {
        const j = i + (act === "up" ? -1 : 1);
        const out = moveSetup(s.tables(), i, j, s.setupIndex);
        if (!out.setups) return;
        s.setSetups(out, { selected: out.selected });
        this.el.setups.querySelector(`li[data-i="${j}"] [data-act="${act}"]`)?.focus();
      }
    });
  }

  _note(text = "", warn = false) {
    const el = this.el.setupsNote;
    el.textContent = text || "Edit loads a setup into Configure.";
    el.classList.toggle("warn", Boolean(warn));
  }

  // The selected setup's full .config, kept for its summary line once
  // Configure edits another one.
  _rememberConfig() {
    const s = this.session;
    if (s.setup && s.configText && s.project) this._configs.set(`${s.project}\n${s.setup.defconfig}`, s.configText);
  }

  _renderSetups() {
    const s = this.session;
    const e = this.el;
    const t = s.tables();
    e.setupsSection.hidden = !s.firmware;
    if (!s.firmware) return;
    const setups = t.setups;
    const locked = Boolean(s.locked);
    const sel = s.setupIndex;
    const n = setups.length;
    const html = setups.map((setup, i) =>
      `<li class="setup-row${i === sel ? " current" : ""}" data-i="${i}">` +
      `<div class="setup-move">` +
      `<button type="button" class="mini" data-act="up" aria-label="Move up" title="Move up"${i === 0 ? " disabled" : ""}>↑</button>` +
      `<button type="button" class="mini" data-act="down" aria-label="Move down" title="Move down"${i === n - 1 ? " disabled" : ""}>↓</button>` +
      `</div>` +
      `<div class="setup-what">` +
      `<div class="setup-head"><input type="text" class="setup-title" data-f="title" autocomplete="off" ` +
      `placeholder="${n > 1 ? "Title" : "Title (optional)"}" aria-label="Setup ${i + 1}: title">` +
      (i === sel ? `<span class="setup-badge" title="Configure edits this setup">In Configure</span>` : "") +
      `</div>` +
      `<div class="setup-sub" data-f="summary"></div>` +
      `<input type="text" class="setup-desc" data-f="description" autocomplete="off" placeholder="Description (optional)" ` +
      `aria-label="Setup ${i + 1}: description">` +
      `</div>` +
      `<div class="setup-acts">` +
      `<button type="button" class="mini" data-act="edit" title="Load it into Configure">Edit</button>` +
      `<button type="button" class="mini" data-act="remove" aria-label="Remove setup ${i + 1}" title="Remove"${n < 2 ? " disabled" : ""}>×</button>` +
      `</div></li>`).join("");
    fill(e.setups, html);
    e.setups.querySelectorAll("li[data-i]").forEach((li, i) => {
      const setup = setups[i];
      field(li.querySelector('[data-f="title"]'), setup.title);
      field(li.querySelector('[data-f="description"]'), setup.description);
      const config = this._configs.get(`${s.project}\n${setup.defconfig}`) || null;
      li.querySelector('[data-f="summary"]').textContent =
        setupSummary(setup, { project: s.project, options: t.options, config });
      li.querySelector('[data-act="up"]').disabled = i === 0;
      li.querySelector('[data-act="down"]').disabled = i === n - 1;
      li.querySelector('[data-act="edit"]').disabled = locked;
      li.querySelector('[data-act="remove"]').disabled = locked || n < 2;
      li.title = setup.id ? `id: ${setup.id}` : "";
    });
    e.add.disabled = locked;
    e.undo.disabled = locked || !s.canUndo;
  }

  // ── Versions ───────────────────────────────────────────────────────

  _bindVersions({ select, mode, list, table, project, set, pick }) {
    this._picks.set(select, pick);
    mode.addEventListener("change", () => {
      const m = mode.querySelector("input:checked").value;
      const t = table();
      if (!t) return;
      if (m === "list") {
        // A fresh list starts with the version the card starts with, when
        // that pins a ref, else with the default branch.
        const pinned = !["latest", "release"].includes(t.version) ? [t.version] : null;
        const refs = Array.isArray(t.versions) ? t.versions : pinned || this._refIds(project()).slice(0, 1);
        set({ versions: refs.length ? refs : ["latest"] });
      } else {
        set({ versions: m });
      }
    });
    list.addEventListener("change", () => {
      const ids = [...list.querySelectorAll("input:checked")].map((i) => i.value);
      // A list keeps at least one version, and a pinned start version stays
      // ticked (the session adds it back).
      if (ids.length) set({ versions: ids });
      this.render();
    });
  }

  // "Starts with" is U04's version picker (older commits, a pasted Mainsail
  // version), made in its host on first use.
  _renderVersions({ select, mode, list }, t, project) {
    const opts = {
      project, index: this.session.index || null, value: t.version, disabled: Boolean(this.session.locked),
      label: `${PROJECT_TITLES[project] || project} version the card starts with`,
    };
    const picker = this.pickers.get(select);
    if (!picker) {
      const pick = this._picks.get(select);
      // The renders a pick causes would set the picker back to the old
      // version (dropping its "Closest kept" note) until the session has it.
      const onChange = (v) => {
        this._picking = true;
        try { pick(v); } finally { this._picking = false; }
        this.render();
      };
      this.pickers.set(select, mountVersionPicker(select, { ...opts, onChange }));
    } else if (!this._picking) {
      const o = picker.opts;
      if (o.project !== opts.project || o.index !== opts.index || o.value !== opts.value || o.disabled !== opts.disabled) picker.update(opts);
    }

    const m = Array.isArray(t.versions) ? "list" : t.versions || "all";
    for (const r of mode.querySelectorAll("input")) r.checked = r.value === m;
    const chosen = Array.isArray(t.versions) ? t.versions : [];
    const all = [...new Set([...this._refIds(project), ...chosen])];
    fill(list, all.map((id) => `<label class="check"><input type="checkbox" value="${esc(id)}"> ${esc(id)}</label>`).join(""));
    for (const box of list.querySelectorAll("input")) {
      box.checked = chosen.includes(box.value);
      box.disabled = box.value === t.version;   // the version the card starts with is always offered
      box.closest("label").title = box.disabled ? "The version the card starts with" : "";
    }
    list.hidden = m !== "list";
  }

  _refIds(project) {
    const s = this.session;
    const groups = s.index && project ? groupRefs(s.index, project) : null;
    if (!groups) return [];
    return [groups.defaultBranch, ...groups.releases, ...groups.branches].filter(Boolean).map((r) => r.id);
  }

  // ── Flashing methods ───────────────────────────────────────────────

  // The methods the Flashing fold edits: [flash] methods, or a setup's own.
  _methods() {
    const s = this.session;
    if (this._methodTarget < 0) return s.flash.methods;
    const setup = s.tables().setups[this._methodTarget];
    return setup ? setup.methods : null;
  }

  _setMethods(methods) {
    const s = this.session;
    if (this._methodTarget < 0) {
      s.setFlash({ methods });
      return;
    }
    const out = setSetupMethods(s.tables(), this._methodTarget, methods);
    if (out.setups) s.setSetups(out);
  }

  // A fresh list starts as what the flash panel infers from the configuration
  // (the full .config once a version is loaded, else the defconfig), for the
  // author to trim and reorder.
  _inferredOrder() {
    const s = this.session;
    const setup = this._methodTarget >= 0 ? s.tables().setups[this._methodTarget] : s.setup;
    let config = s.configText || s.defconfigText;
    if (setup && this._methodTarget >= 0 && this._methodTarget !== s.setupIndex) {
      config = this._configs.get(`${s.project}\n${setup.defconfig}`) || setup.defconfig;
    }
    let ids = [];
    try {
      ids = inferMethods(config, { project: s.project || "klipper" }).map((m) => m.id).filter((id) => METHODS.includes(id));
    } catch (e) { /* fall back to every method */ }
    return ids.length ? ids : [...METHODS];
  }

  _renderMethods() {
    const s = this.session;
    const e = this.el;
    const setups = s.firmware ? s.tables().setups : [];
    if (this._methodTarget >= setups.length || setups.length < 2) this._methodTarget = -1;
    e.methodTargetRow.hidden = setups.length < 2;
    fill(e.methodTarget, `<option value="-1">Every setup</option>` +
      setups.map((st, i) => `<option value="${i}">${esc(setupTitle(st, i))}</option>`).join(""));
    e.methodTarget.value = String(this._methodTarget);
    e.methodAuto.textContent = this._methodTarget < 0 ? "From the configuration" : "As for every setup";

    const methods = this._methods();
    for (const r of e.flashFold.querySelectorAll('input[name="opt-methods"]')) {
      r.checked = r.value === (methods ? "list" : "auto");
    }
    e.methodList.hidden = !methods;
    if (methods) {
      const rows = [...e.methodList.children];
      const order = [...methods, ...METHODS.filter((m) => !methods.includes(m))];
      for (const m of order) e.methodList.append(rows.find((li) => li.dataset.method === m));
      for (const li of e.methodList.children) {
        const on = methods.includes(li.dataset.method);
        li.querySelector("input").checked = on;
        li.classList.toggle("off", !on);
        const i = methods.indexOf(li.dataset.method);
        li.querySelector('[data-act="method-up"]').disabled = !on || i === 0;
        li.querySelector('[data-act="method-down"]').disabled = !on || i === methods.length - 1;
      }
    }
    const own = setups.filter((st) => st.methods).length;
    e.flashN.textContent = (s.flash.methods ? s.flash.methods.join(", ") : "from the configuration") +
      (own ? ` · ${own} setup${own === 1 ? "" : "s"} with their own` : "");

    // A box per listed method; with inferred methods, only the methods that
    // have instructions (or are being given some), and a picker for the rest.
    const instructions = s.flash.instructions;
    const listed = s.flash.methods;
    const shown = listed || METHODS.filter((m) => instructions[m] !== undefined || this._adding.has(m));
    const rest = listed ? [] : METHODS.filter((m) => !shown.includes(m));
    const instrHtml = shown.map((m) =>
      `<label class="form-row" data-for="${m}">${esc(METHOD_TITLES[m])}: before Connect` +
      `<textarea rows="2" data-method="${m}" placeholder="The default steps"></textarea></label>`).join("") +
      (rest.length ? `<select class="opt-add-instructions" data-act="add-instructions" aria-label="Add instructions for a method">` +
        `<option value="">Add instructions for…</option>` +
        rest.map((m) => `<option value="${m}">${esc(METHOD_TITLES[m])}</option>`).join("") + `</select>` : "");
    fill(e.instructions, `<p class="opt-note">Instructions, for every setup (**bold**, \`code\` and links work).</p>${instrHtml}`);
    for (const ta of e.instructions.querySelectorAll("textarea")) field(ta, instructions[ta.dataset.method] || "");
  }

  // ── Themes and behavior ────────────────────────────────────────────

  /** The bundled themes for the select, once Python has listed them, and the theme's behavior. */
  fillThemes() {
    const sel = this.el.theme;
    const cur = this.session.theme;
    const list = [...this.themes()];
    if (!list.some((t) => t.name === cur)) list.push({ name: cur, display: cur });
    fill(sel, list.map((t) => `<option value="${esc(t.name)}">${esc(t.display)}</option>`).join(""));
    sel.value = cur;
    this._renderBehavior(list.find((t) => t.name === cur));
  }

  _renderBehavior(theme) {
    const e = this.el;
    const b = theme && theme.behavior;
    e.behaviorN.textContent = b ? behaviorLine(b) : "";
    const yes = (v) => (v ? "yes" : "no");
    fill(e.behavior, b
      ? Object.keys(BEHAVIOR_TITLES).filter((k) => k in b).map((k) =>
        `<li><span>${esc(BEHAVIOR_TITLES[k])}</span><b>${esc(typeof b[k] === "boolean" ? yes(b[k]) : String(b[k]))}</b></li>`).join("")
      : `<li class="placeholder">${this.themes().length ? "Not a bundled theme." : "Loading the themes…"}</li>`);
  }

  // ── Render ─────────────────────────────────────────────────────────

  render() {
    const s = this.session;
    const e = this.el;
    const b = s.board;
    field(e.title, b.title);
    field(e.description, b.description);
    field(e.image, b.image);
    this.fillThemes();

    const f = s.firmware;
    const t = s.tables();
    e.firmware.hidden = !f;
    e.optionsFold.hidden = !f;
    this._renderSetups();
    if (f) {
      for (const box of e.projects.querySelectorAll("input")) {
        const p = box.value;
        box.checked = (f.projects || [f.project]).includes(p);
        box.disabled = p === f.project || (f.project === "katapult") !== (p === "katapult");
        box.closest("label").title = p === f.project ? "The firmware the card starts with (Firmware step)"
          : box.disabled ? "Katapult alone is never offered beside a firmware" : "";
      }
      this._renderVersions({ select: e.version, mode: e.versionsMode, list: e.versionsList }, f, f.project);
      const k = t.katapult;
      e.katapultBlock.hidden = f.project === "katapult";
      e.katapultOn.checked = Boolean(k);
      e.katapultOn.disabled = Boolean(s.locked);
      e.katapultDefaultRow.hidden = !k;
      e.katapultVersions.hidden = !k;
      if (k) {
        e.katapultDefault.checked = k.default !== false;
        this._renderVersions({ select: e.kVersion, mode: e.kVersionsMode, list: e.kVersionsList }, k, "katapult");
      }
      e.optionsN.textContent = s.options.length ? String(s.options.length) : "none";
    }
    this._renderMethods();
    this._renderUnknown();
  }

  _renderTree() {
    const s = this.session;
    const has = Boolean(s.tree && s.ref);
    this.el.treeEmpty.hidden = has;
    if (has) this.tree.setTree(s.tree, `${s.project}/${s.ref.sha}`, s.project);
    else this.tree.setTree(null, "", s.project || "");
    this._renderUnknown();
  }

  // [[option]] entries of the edited setup whose symbol the loaded version
  // does not have: kept in the TOML (another version may have them) and
  // listed with a way to drop them.
  _renderUnknown() {
    const s = this.session;
    const e = this.el;
    if (!s.tree || !s.firmware) {
      e.unknown.hidden = true;
      return;
    }
    const names = new Set(Object.values(s.tree.nodes).map((n) => n.name).filter(Boolean));
    // Only the options of the setup Configure edits: the tree is its.
    const id = s.setup ? s.setup.id : null;
    const gone = s.options.filter((o) => (!o.setups || o.setups.includes(id)) && !names.has(o.symbol));
    e.unknown.hidden = !gone.length;
    if (!gone.length) return;
    fill(e.unknown, `<p>Not in ${esc(s.ref ? s.ref.id : "this version")}:</p><ul>` +
      gone.map((o) => `<li><code>${esc(o.symbol)}</code>${o.label ? ` (${esc(o.label)})` : ""} ` +
        `<button type="button" class="mini" data-symbol="${esc(o.symbol)}">Remove</button></li>`).join("") + "</ul>");
  }

  // ── Exposing an option ─────────────────────────────────────────────

  _expose(node, on) {
    const s = this.session;
    const current = optionFor(s.options, node);
    if (on && !current) {
      const visible = (node.members || []).filter((m) => m.visible);
      const symbol = node.kind === "choice" ? (node.value || (visible[0] && visible[0].name)) : node.name;
      if (!symbol) return;
      s.setOptions([...s.options, { symbol, label: "", values: null, labels: {}, help: "", setups: null }]);
    } else if (!on && current) {
      s.setOptions(s.options.filter((o) => o !== current));
    }
  }

  _update(node, changes) {
    const s = this.session;
    const current = optionFor(s.options, node);
    if (!current) return;
    s.setOptions(s.options.map((o) => (o === current ? { ...o, ...changes } : o)));
  }

  /**
   * The [[option]] editor under an exposed node: built once per node, then
   * only the fields that are not being edited are refreshed.
   */
  _editor(node, slot) {
    const opt = optionFor(this.session.options, node);
    if (!opt) return;
    const kind = node.kind === "choice" ? "choice" : (node.type === "bool" || node.type === "tristate") ? "bool" : "value";
    const members = node.kind === "choice" ? (node.members || []).filter((m) => m.visible) : [];
    const setups = this.session.firmware ? this.session.tables().setups : [];
    const scoped = setups.length > 1;
    const shape = `${kind}:${members.map((m) => m.name).join(",")}:${scoped ? setups.map((st, i) => `${st.id}=${setupTitle(st, i)}`).join(",") : ""}`;
    if (slot.dataset.shape !== shape || !slot.firstElementChild) {
      slot.dataset.shape = shape;
      slot.innerHTML =
        `<div class="opt-editor">` +
        `<label class="form-row">Label<input type="text" data-f="label" autocomplete="off" placeholder="${esc(node.prompt || "")}"></label>` +
        (kind === "choice"
          ? `<div class="form-row"><span>Offered, with the reader's label</span><div class="opt-values">` +
            members.map((m) =>
              `<div class="opt-value-row"><label class="check"><input type="checkbox" data-f="member" value="${esc(m.name)}"> <code>${esc(m.name)}</code></label>` +
              `<input type="text" data-f="member-label" data-value="${esc(m.name)}" autocomplete="off" placeholder="${esc(m.prompt)}" aria-label="Label for ${esc(m.name)}"></div>`).join("") +
            `</div></div>`
          : "") +
        (kind === "value"
          ? `<div class="form-row"><span>Values offered (none: any value${node.range ? ` from ${esc(node.range[0])} to ${esc(node.range[1])}` : ""})</span>` +
            `<div class="opt-values" data-f="values"></div>` +
            `<button type="button" class="mini" data-f="add-value">Add a value</button></div>`
          : "") +
        `<label class="form-row">Help<textarea rows="2" data-f="help" placeholder="The Kconfig help text"></textarea></label>` +
        (scoped
          ? `<div class="form-row"><span>Applies to</span><div class="opt-checks">` +
            setups.map((st, i) => `<label class="check"><input type="checkbox" data-f="setup" value="${esc(st.id)}"> ${esc(setupTitle(st, i))}</label>`).join("") +
            `</div></div>`
          : "") +
        `</div>`;
      if (!slot.dataset.bound) {
        slot.dataset.bound = "1";
        slot.addEventListener("change", (ev) => this._editorChange(slot, ev));
        slot.addEventListener("click", (ev) => this._editorClick(slot, ev));
      }
    }
    slot.dataset.node = node.id;
    this._fillEditor(node, slot, opt, members);
  }

  _currentNode(slot) {
    const s = this.session;
    return s.tree ? s.tree.nodes[slot.dataset.node] : null;
  }

  _fillEditor(node, slot, opt, members) {
    field(slot.querySelector('[data-f="label"]'), opt.label);
    field(slot.querySelector('[data-f="help"]'), opt.help);
    const helpBox = slot.querySelector('[data-f="help"]');
    helpBox.placeholder = node.help ? node.help.split("\n").map((l) => l.trim()).join(" ").slice(0, 160) : "No help text";
    for (const box of slot.querySelectorAll('[data-f="setup"]')) box.checked = !opt.setups || opt.setups.includes(box.value);
    if (node.kind === "choice") {
      for (const box of slot.querySelectorAll('[data-f="member"]')) {
        box.checked = opt.values === null || opt.values.includes(box.value);
      }
      for (const input of slot.querySelectorAll('[data-f="member-label"]')) field(input, opt.labels[input.dataset.value] || "");
      return;
    }
    const list = slot.querySelector('[data-f="values"]');
    if (!list) return;
    const values = opt.values || [];
    const html = values.map((v, i) =>
      `<div class="opt-value-row" data-i="${i}">` +
      `<input type="text" data-f="value" autocomplete="off" spellcheck="false" aria-label="Value ${i + 1}">` +
      `<input type="text" data-f="value-label" autocomplete="off" aria-label="Label for value ${i + 1}" placeholder="Label">` +
      `<button type="button" class="mini" data-f="remove-value" aria-label="Remove value ${i + 1}">×</button></div>`).join("");
    const shown = [...list.querySelectorAll(".opt-value-row")];
    if (list.dataset.count !== String(values.length) && shown.length === values.length && values.length) {
      // A new row that now holds a value: kept as it is (with its remove
      // button), so the Tab that left it reaches its label field.
      shown.forEach((row, i) => {
        row.dataset.i = String(i);
        if (!row.querySelector('[data-f="remove-value"]')) {
          const btn = document.createElement("button");
          btn.setAttribute("type", "button");
          btn.className = "mini";
          btn.dataset.f = "remove-value";
          btn.setAttribute("aria-label", `Remove value ${i + 1}`);
          btn.textContent = "×";
          row.append(btn);
        }
      });
      list.dataset.count = String(values.length);
    } else if (list.dataset.count !== String(values.length)) {
      list.innerHTML = html;
      list.dataset.count = String(values.length);
    }
    list.querySelectorAll(".opt-value-row").forEach((row, i) => {
      field(row.querySelector('[data-f="value"]'), values[i]);
      field(row.querySelector('[data-f="value-label"]'), opt.labels[values[i]] || "");
      this._markValue(row, this._checkValue(node, row.querySelector('[data-f="value"]').value.trim()).error);
    });
  }

  // A value of an int or hex symbol, normalized, or the error the Configure
  // tab would show for it; other symbols take any text.
  _checkValue(node, raw) {
    if (!raw || (node.type !== "int" && node.type !== "hex")) return { value: raw };
    return checkNumber(node, raw);
  }

  _markValue(row, error) {
    const input = row.querySelector('[data-f="value"]');
    input.setAttribute("aria-invalid", String(Boolean(error)));
    input.title = error || "";
    input.style.borderColor = error ? "var(--danger)" : "";
    let note = row.nextElementSibling;
    if (note && !note.classList.contains("opt-value-error")) note = null;
    if (error) {
      if (!note) {
        note = document.createElement("p");
        note.className = "kc-error-text opt-value-error";
        note.setAttribute("role", "alert");
        row.parentNode.insertBefore(note, row.nextElementSibling);
      }
      note.textContent = error;
    } else if (note) {
      note.remove();
    }
  }

  _editorChange(slot, ev) {
    const node = this._currentNode(slot);
    const opt = optionFor(this.session.options, node);
    if (!node || !opt) return;
    const t = ev.target;
    const f = t.dataset.f;
    if (f === "label") this._update(node, { label: t.value.trim() });
    else if (f === "help") this._update(node, { help: t.value.trim() });
    else if (f === "setup") {
      const boxes = [...slot.querySelectorAll('[data-f="setup"]')];
      const ids = boxes.filter((b) => b.checked).map((b) => b.value);
      if (!ids.length) {
        t.checked = true;   // an option applies to at least one setup
        return;
      }
      this._update(node, { setups: ids.length === boxes.length ? null : ids });
    } else if (f === "member") {
      const names = [...slot.querySelectorAll('[data-f="member"]')].filter((b) => b.checked).map((b) => b.value);
      const all = [...slot.querySelectorAll('[data-f="member"]')].map((b) => b.value);
      if (!names.length) {
        t.checked = true;   // a dropdown offers at least one value
        return;
      }
      const labels = Object.fromEntries(Object.entries(opt.labels).filter(([k]) => names.includes(k)));
      // The option's symbol must stay one of the values offered.
      const symbol = names.includes(opt.symbol) ? opt.symbol : names[0];
      this._update(node, { symbol, values: names.length === all.length ? null : names, labels });
    } else if (f === "member-label") {
      const labels = { ...opt.labels };
      const v = t.value.trim();
      if (v) labels[t.dataset.value] = v;
      else delete labels[t.dataset.value];
      this._update(node, { labels });
    } else if (f === "value" || f === "value-label") {
      const rows = [...slot.querySelectorAll('[data-f="values"] .opt-value-row')];
      const values = [];
      const labels = {};
      for (const row of rows) {
        const input = row.querySelector('[data-f="value"]');
        const raw = input.value.trim();
        const checked = this._checkValue(node, raw);
        this._markValue(row, checked.error);
        let v = checked.value;
        if (checked.error) {
          // A value the symbol refuses is never offered: the row keeps what it
          // held before, and a new row adds nothing.
          v = row.dataset.i === undefined ? "" : (opt.values || [])[Number(row.dataset.i)] || "";
        } else if (input === t && v !== raw) {
          input.value = v;
        }
        if (!v || values.includes(v)) continue;
        values.push(v);
        const l = row.querySelector('[data-f="value-label"]').value.trim();
        if (l) labels[v] = l;
      }
      this._update(node, { values: values.length ? values : null, labels });
    }
  }

  _editorClick(slot, ev) {
    const btn = ev.target.closest("button[data-f]");
    if (!btn) return;
    const node = this._currentNode(slot);
    const opt = optionFor(this.session.options, node);
    if (!node || !opt) return;
    if (btn.dataset.f === "add-value") {
      const values = [...(opt.values || [])];
      let candidate = node.value || "";
      if (values.includes(candidate)) candidate = "";
      if (!candidate) {
        // An empty row to fill in: shown without a TOML change until it has a value.
        const list = slot.querySelector('[data-f="values"]');
        const row = document.createElement("div");
        row.className = "opt-value-row";
        row.innerHTML = `<input type="text" data-f="value" autocomplete="off" spellcheck="false" aria-label="New value">` +
          `<input type="text" data-f="value-label" autocomplete="off" aria-label="Label for the new value" placeholder="Label">`;
        list.append(row);
        row.querySelector("input").focus();
        return;
      }
      this._update(node, { values: [...values, candidate] });
    } else if (btn.dataset.f === "remove-value") {
      const i = Number(btn.closest(".opt-value-row").dataset.i);
      const values = (opt.values || []).filter((_, k) => k !== i);
      const labels = Object.fromEntries(Object.entries(opt.labels).filter(([k]) => values.includes(k)));
      this._update(node, { values: values.length ? values : null, labels });
    }
  }
}
