// The Embed options tab: everything the board TOML says besides the
// configuration itself. The page's [board] fields (title, description, image,
// theme), the version policy of [firmware] (the project and version the card
// starts with, the projects and versions the reader may pick), [flash] (the
// methods offered and their order, per-method instructions), and the
// [[option]] list: the Kconfig tree again, with a "the reader can change
// this" box per symbol and choice and, under each one ticked, its label,
// the values offered with their labels, and its help. Every field writes
// into the session, and so into the TOML, when it changes.

import { METHODS, PROJECTS, PROJECT_TITLES } from "../state.js";
import { esc } from "../dialogs.js";
import { inferMethods } from "../flash/devices.js";
import { KconfigTree } from "./kconfig-tree.js";
import { versionOptions } from "./version-picker.js";
import { groupRefs } from "./sources.js";

export const METHOD_TITLES = {
  dfu: "STM32 DFU (USB)",
  picoboot: "RP2040 / RP2350 BOOTSEL (USB)",
  uf2: "UF2 file to the BOOTSEL drive",
  katapult: "Katapult (USB or serial)",
  "katapult-can": "Katapult over CAN",
  download: "Download the firmware",
};

const field = (el, value) => {
  const v = value == null ? "" : String(value);
  if (document.activeElement !== el && el.value !== v) el.value = v;
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

export class OptionsPanel {
  /**
   * onVersion(version) switches the version the card starts with, as the
   * toolbar's Version select does (and loads it once configuring started);
   * without it the select only changes the session.
   */
  constructor(container, session, { themes = () => [], onVersion = null } = {}) {
    this.container = container;
    this.session = session;
    this.themes = themes;
    this.onVersion = onVersion || ((version) => session.setVersion(version));
    this._adding = new Set();   // methods whose instructions box was opened but is still empty
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
            <input type="text" id="opt-title" autocomplete="off" required title="The card's heading and the page title ([board] title)">
          </label>
          <label class="form-row">Description
            <textarea id="opt-description" rows="3" title="One or more paragraphs above the controls: **bold**, \`code\` and [links](https://…) work"></textarea>
          </label>
          <div class="form-pair">
            <label class="form-row">Image file
              <input type="text" id="opt-image" autocomplete="off" placeholder="board.png" title="A photo next to the TOML, by its file name ([board] image)">
            </label>
            <label class="form-row">Theme
              <select id="opt-theme" title="The theme of the generated page ([board] theme)"></select>
            </label>
          </div>
        </section>

        <section class="opt-section" id="opt-firmware" aria-labelledby="opt-h-fw">
          <h3 id="opt-h-fw">Firmware and versions</h3>
          <div class="form-row"><span>Projects the reader may pick</span>
            <div class="opt-checks" id="opt-projects">${PROJECTS.map((p) =>
              `<label class="check"><input type="checkbox" value="${p}"> ${PROJECT_TITLES[p]}</label>`).join("")}</div>
          </div>
          <label class="form-row">Version the card starts with
            <select id="opt-version" title="[firmware] version: Latest and Newest release follow new snapshots; a ref pins one"></select>
          </label>
          <div class="form-row"><span>Versions the reader may pick</span>
            <div class="opt-checks" id="opt-versions-mode">
              <label class="check"><input type="radio" name="opt-versions" value="all"> All</label>
              <label class="check"><input type="radio" name="opt-versions" value="releases"> Releases only</label>
              <label class="check"><input type="radio" name="opt-versions" value="list"> These:</label>
            </div>
            <div class="opt-checks opt-ref-list" id="opt-versions-list"></div>
          </div>
        </section>

        <section class="opt-section" aria-labelledby="opt-h-flash">
          <h3 id="opt-h-flash">Flashing</h3>
          <div class="opt-checks">
            <label class="check"><input type="radio" name="opt-methods" value="auto"> Methods inferred from the configuration</label>
            <label class="check"><input type="radio" name="opt-methods" value="list"> These methods, in this order:</label>
          </div>
          <ol class="method-list" id="opt-method-list">${methodRows}</ol>
          <div id="opt-instructions"></div>
        </section>

        <section class="opt-section" id="opt-options" aria-labelledby="opt-h-options">
          <h3 id="opt-h-options">Options the reader can change</h3>
          <p class="opt-note">Tick an option to let the reader of the generated page change it; everything else stays as configured. A choice becomes one dropdown.</p>
          <div class="panel-bar opt-search">
            <input type="search" id="opt-search" placeholder="Search options" aria-label="Search the options">
            <span class="kc-count" id="opt-count"></span>
          </div>
          <div class="opt-unknown" id="opt-unknown" hidden></div>
          <div id="opt-tree"></div>
          <p class="placeholder opt-empty" id="opt-tree-empty">The options appear once the version's sources have loaded (Configure tab).</p>
        </section>
      </div>`;
    const $ = (id) => this.container.querySelector(`#${id}`);
    this.el = {
      title: $("opt-title"), description: $("opt-description"), image: $("opt-image"), theme: $("opt-theme"),
      firmware: $("opt-firmware"), projects: $("opt-projects"), version: $("opt-version"),
      versionsMode: $("opt-versions-mode"), versionsList: $("opt-versions-list"),
      methodList: $("opt-method-list"), instructions: $("opt-instructions"),
      options: $("opt-options"), search: $("opt-search"), count: $("opt-count"), unknown: $("opt-unknown"),
      tree: $("opt-tree"), treeEmpty: $("opt-tree-empty"),
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

    e.projects.addEventListener("change", () => {
      const f = s.firmware;
      if (!f) return;
      let projects = [...e.projects.querySelectorAll("input:checked")].map((i) => i.value);
      if (!projects.includes(f.project)) projects.unshift(f.project);
      if (f.project === "katapult") projects = ["katapult"];
      else projects = projects.filter((p) => p !== "katapult");
      s.setFirmware({ projects: PROJECTS.filter((p) => projects.includes(p)) });
    });
    e.version.addEventListener("change", () => this.onVersion(e.version.value));
    e.versionsMode.addEventListener("change", () => {
      const mode = e.versionsMode.querySelector("input:checked").value;
      if (mode === "list") {
        // A fresh list starts with the version the card starts with, when
        // that pins a ref, else with the default branch.
        const f = s.firmware;
        const pinned = f && !["latest", "release"].includes(f.version) ? [f.version] : null;
        const refs = f && Array.isArray(f.versions) ? f.versions : pinned || this._refIds().slice(0, 1);
        s.setFirmware({ versions: refs.length ? refs : ["latest"] });
      } else {
        s.setFirmware({ versions: mode });
      }
    });
    e.versionsList.addEventListener("change", () => {
      const ids = [...e.versionsList.querySelectorAll("input:checked")].map((i) => i.value);
      // A list keeps at least one version, and a pinned start version stays
      // ticked (the session adds it back).
      if (ids.length) s.setFirmware({ versions: ids });
      this.render();
    });

    this.container.addEventListener("change", (ev) => {
      if (ev.target.name === "opt-methods") {
        const auto = ev.target.value === "auto";
        s.setFlash({ methods: auto ? null : this._inferredOrder() });
      }
    });
    e.methodList.addEventListener("change", (ev) => {
      if (ev.target.dataset.act !== "method-on") return;
      const methods = [...e.methodList.querySelectorAll("li")]
        .filter((li) => li.querySelector("input").checked).map((li) => li.dataset.method);
      if (methods.length) s.setFlash({ methods });
      else this.render();   // a list keeps at least one method
    });
    e.methodList.addEventListener("click", (ev) => {
      const btn = ev.target.closest("button[data-act]");
      if (!btn || !s.flash.methods) return;
      const method = btn.closest("li").dataset.method;
      const methods = [...s.flash.methods];
      const i = methods.indexOf(method);
      const j = i + (btn.dataset.act === "method-up" ? -1 : 1);
      if (i < 0 || j < 0 || j >= methods.length) return;
      [methods[i], methods[j]] = [methods[j], methods[i]];
      s.setFlash({ methods });
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
      if (what === "tree" || what === "ref") this._renderTree();
      else if (what === "options") this.tree.render();
      if (["board", "firmware", "project", "version", "flash", "prebuilt", "open", "index", "options", "tree", "undo"].includes(what)) {
        this.render();
      }
    });
  }

  // A fresh list starts as what the flash panel infers from the configuration
  // (the full .config once a version is loaded, else the defconfig), for the
  // author to trim and reorder.
  _inferredOrder() {
    const s = this.session;
    const config = s.configText || s.defconfigText;
    let ids = [];
    try {
      ids = inferMethods(config, { project: s.project || "klipper" }).map((m) => m.id).filter((id) => METHODS.includes(id));
    } catch (e) { /* fall back to every method */ }
    return ids.length ? ids : [...METHODS];
  }

  _refIds() {
    const s = this.session;
    const groups = s.index && s.firmware ? groupRefs(s.index, s.firmware.project) : null;
    if (!groups) return [];
    return [groups.defaultBranch, ...groups.releases, ...groups.branches].filter(Boolean).map((r) => r.id);
  }

  /** The bundled themes for the select, once Python has listed them. */
  fillThemes() {
    const sel = this.el.theme;
    const cur = this.session.theme;
    const list = [...this.themes()];
    if (!list.some((t) => t.name === cur)) list.push({ name: cur, display: cur });
    const html = list.map((t) => `<option value="${esc(t.name)}">${esc(t.display)}</option>`).join("");
    if (sel.dataset.html !== html) {
      sel.innerHTML = html;
      sel.dataset.html = html;
    }
    sel.value = cur;
  }

  render() {
    const s = this.session;
    const e = this.el;
    const b = s.board;
    field(e.title, b.title);
    field(e.description, b.description);
    field(e.image, b.image);
    this.fillThemes();

    const f = s.firmware;
    e.firmware.hidden = !f;
    e.options.hidden = !f;
    if (f) {
      for (const box of e.projects.querySelectorAll("input")) {
        const p = box.value;
        box.checked = (f.projects || [f.project]).includes(p);
        box.disabled = p === f.project || (f.project === "katapult") !== (p === "katapult");
        box.closest("label").title = p === f.project ? "The project the card starts with (the toolbar's Project)"
          : box.disabled ? "Katapult is a bootloader: it is never offered beside the firmware projects" : "";
      }
      const opts = s.index ? versionOptions(s.index, f.project, f.version) : { groups: [] };
      const html = (opts.value === null ? `<option value="${esc(f.version)}">${esc(f.version)} (not in the index)</option>` : "") +
        opts.groups.map((g) => `<optgroup label="${esc(g.label)}">${g.options.map((o) =>
          `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join("")}</optgroup>`).join("");
      if (e.version.dataset.html !== html) {
        e.version.innerHTML = html || `<option value="${esc(f.version)}">${esc(f.version)}</option>`;
        e.version.dataset.html = html;
      }
      e.version.value = f.version;

      const mode = Array.isArray(f.versions) ? "list" : f.versions || "all";
      for (const r of e.versionsMode.querySelectorAll("input")) r.checked = r.value === mode;
      const ids = this._refIds();
      const chosen = Array.isArray(f.versions) ? f.versions : [];
      const all = [...new Set([...ids, ...chosen])];
      const listHtml = all.map((id) =>
        `<label class="check"><input type="checkbox" value="${esc(id)}"> ${esc(id)}</label>`).join("");
      if (e.versionsList.dataset.html !== listHtml) {
        e.versionsList.innerHTML = listHtml;
        e.versionsList.dataset.html = listHtml;
      }
      for (const box of e.versionsList.querySelectorAll("input")) {
        box.checked = chosen.includes(box.value);
        box.disabled = box.value === f.version;   // the version the card starts with is always offered
        box.closest("label").title = box.disabled ? "The version the card starts with: the reader can always pick it" : "";
      }
      e.versionsList.hidden = mode !== "list";
    }

    const methods = s.flash.methods;
    for (const r of this.container.querySelectorAll('input[name="opt-methods"]')) {
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
    // A box per listed method; with inferred methods, only the methods that
    // have instructions (or are being given some), and a picker for the rest.
    const instructions = s.flash.instructions;
    const shown = methods || METHODS.filter((m) => instructions[m] !== undefined || this._adding.has(m));
    const rest = methods ? [] : METHODS.filter((m) => !shown.includes(m));
    const instrHtml = shown.map((m) =>
      `<label class="form-row" data-for="${m}">${esc(METHOD_TITLES[m])}: what to do before Connect` +
      `<textarea rows="2" data-method="${m}" placeholder="Default instructions for this method"></textarea></label>`).join("") +
      (rest.length ? `<select class="opt-add-instructions" data-act="add-instructions" aria-label="Add instructions for a method">` +
        `<option value="">Add instructions for…</option>` +
        rest.map((m) => `<option value="${m}">${esc(METHOD_TITLES[m])}</option>`).join("") + `</select>` : "");
    if (e.instructions.dataset.html !== instrHtml) {
      e.instructions.innerHTML = `<p class="opt-note">Instructions shown in the connect step (optional; **bold**, \`code\` and links work).</p>${instrHtml}`;
      e.instructions.dataset.html = instrHtml;
    }
    for (const ta of e.instructions.querySelectorAll("textarea")) field(ta, instructions[ta.dataset.method] || "");

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

  // [[option]] entries whose symbol the loaded version does not have: kept in
  // the TOML (another version may have them) and listed with a way to drop them.
  _renderUnknown() {
    const s = this.session;
    const e = this.el;
    if (!s.tree || !s.firmware) {
      e.unknown.hidden = true;
      return;
    }
    const names = new Set(Object.values(s.tree.nodes).map((n) => n.name).filter(Boolean));
    const gone = s.options.filter((o) => !names.has(o.symbol));
    e.unknown.hidden = !gone.length;
    if (!gone.length) return;
    const html = `<p>Exposed in the board TOML but not in ${esc(s.ref ? s.ref.id : "this version")}:</p><ul>` +
      gone.map((o) => `<li><code>${esc(o.symbol)}</code>${o.label ? ` (${esc(o.label)})` : ""} ` +
        `<button type="button" class="mini" data-symbol="${esc(o.symbol)}">Remove</button></li>`).join("") + "</ul>";
    if (e.unknown.dataset.html !== html) {
      e.unknown.innerHTML = html;
      e.unknown.dataset.html = html;
    }
  }

  // ── Exposing an option ─────────────────────────────────────────────

  _expose(node, on) {
    const s = this.session;
    const current = optionFor(s.options, node);
    if (on && !current) {
      const visible = (node.members || []).filter((m) => m.visible);
      const symbol = node.kind === "choice" ? (node.value || (visible[0] && visible[0].name)) : node.name;
      if (!symbol) return;
      s.setOptions([...s.options, { symbol, label: "", values: null, labels: {}, help: "" }]);
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
    const shape = `${kind}:${members.map((m) => m.name).join(",")}`;
    if (slot.dataset.shape !== shape || !slot.firstElementChild) {
      slot.dataset.shape = shape;
      slot.innerHTML =
        `<div class="opt-editor">` +
        `<label class="form-row">Label<input type="text" data-f="label" autocomplete="off" placeholder="${esc(node.prompt || "")}"></label>` +
        (kind === "choice"
          ? `<div class="form-row"><span>Offered, with the label the reader sees</span><div class="opt-values">` +
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
    if (list.dataset.count !== String(values.length)) {
      list.innerHTML = html;
      list.dataset.count = String(values.length);
    }
    list.querySelectorAll(".opt-value-row").forEach((row, i) => {
      field(row.querySelector('[data-f="value"]'), values[i]);
      field(row.querySelector('[data-f="value-label"]'), opt.labels[values[i]] || "");
    });
  }

  _editorChange(slot, ev) {
    const node = this._currentNode(slot);
    const opt = optionFor(this.session.options, node);
    if (!node || !opt) return;
    const t = ev.target;
    const f = t.dataset.f;
    if (f === "label") this._update(node, { label: t.value.trim() });
    else if (f === "help") this._update(node, { help: t.value.trim() });
    else if (f === "member") {
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
        const v = row.querySelector('[data-f="value"]').value.trim();
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
