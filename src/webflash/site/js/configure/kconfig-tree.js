// The Kconfig tree: every option of `make menuconfig` for the version being
// configured, rendered from the engine's tree JSON (SPEC 10: {root, nodes},
// nodes keyed by id) and patched by node id after every change, so focus,
// scroll position and open help texts survive an edit.
//
// It shows what menuconfig.py shows: only nodes the engine marks visible
// (the prompt's condition, a menu's `visible if`, an invisible symbol with
// shown children). Menus are collapsible sections (remembered for the browser
// session), `menuconfig` symbols bools that expand, choices a select (a radio
// group for two or three members), bools checkboxes, int and hex inputs
// checked against the active range, strings text inputs, comments headings.
// Symbols that depend on the one above them (an implicit menu) sit indented
// under it. A node's help is behind its ? button, its dependency in the
// prompt's tooltip. Search filters by prompt, name and help, opening the
// menus that hold matches and listing the matches that are hidden now.
//
// mode "expose" (the Embed options tab) shows the same tree with a "the
// reader can change this" box on every symbol and choice, values read-only,
// and a slot under each exposed one for its [[option]] editor.

const STORE = "webflash.kconfig";

function text(el, value) {
  const v = value == null ? "" : String(value);
  if (el.textContent !== v) el.textContent = v;
}

/** Help text as paragraphs: kconfiglib keeps the Kconfig file's line breaks. */
function setHelp(el, help) {
  const key = help || "";
  if (el.dataset.help === key) return;
  el.dataset.help = key;
  el.replaceChildren(...key.split(/\n\s*\n/).map((para) => {
    const p = document.createElement("p");
    p.textContent = para.split("\n").map((l) => l.trim()).join(" ").trim();
    return p;
  }));
}

/** textContent with the search term marked. */
function setMarked(el, value, query) {
  const v = value == null ? "" : String(value);
  const key = `${query}\u0000${v}`;
  if (el.dataset.marked === key) return;
  el.dataset.marked = key;
  if (!query) {
    el.textContent = v;
    return;
  }
  const lower = v.toLowerCase();
  const parts = [];
  let at = 0;
  for (let i = lower.indexOf(query); i >= 0 && query; i = lower.indexOf(query, at)) {
    if (i > at) parts.push(document.createTextNode(v.slice(at, i)));
    const mark = document.createElement("mark");
    mark.textContent = v.slice(i, i + query.length);
    parts.push(mark);
    at = i + query.length;
  }
  if (at < v.length) parts.push(document.createTextNode(v.slice(at)));
  el.replaceChildren(...parts);
}

function isMember(choice, node) {
  return node.kind === "symbol" && (choice.members || []).some((m) => m.name === node.name);
}

export const ROOT_ID = "$root";

/**
 * The engine's tree in the shape this module reads: {root: <id of a root
 * menu>, nodes}, every node with null for what it lacks (name, prompt, help,
 * depends, a choice's value), members [] outside choices, and editable.
 * Accepts the engine's {root: [top-level ids], nodes, title}, empty strings
 * for missing texts and "y" for no dependency, and fills editable in when the
 * engine leaves it out (a shown symbol or choice with a prompt; a bool that
 * another option selects then still looks editable, and the engine keeps its
 * value).
 */
export function normalizeTree(tree) {
  if (!tree || !tree.nodes) return tree;
  const nodes = {};
  for (const [id, n] of Object.entries(tree.nodes)) {
    const kind = n.kind || "symbol";
    const node = {
      ...n,
      id: n.id || id,
      kind,
      name: n.name || null,
      prompt: n.prompt || null,
      help: n.help || null,
      depends: !n.depends || n.depends === "y" ? null : n.depends,
      value: kind === "choice" ? (n.value || null) : (n.value ?? null),
      children: n.children || [],
      members: kind === "choice" ? (n.members || []) : [],
      menuconfig: kind === "symbol" && Boolean(n.menuconfig),
    };
    if (typeof n.editable !== "boolean") {
      node.editable = Boolean(n.visible) && Boolean(n.prompt) && (kind === "symbol" || kind === "choice") &&
        (kind !== "choice" || node.members.some((m) => m.visible));
    }
    nodes[node.id] = node;
  }
  let root = tree.root;
  if (Array.isArray(root)) {
    nodes[ROOT_ID] = {
      id: ROOT_ID, kind: "menu", name: null, prompt: tree.title || null, type: null, value: null,
      user_value: null, visible: true, menuconfig: false, editable: false, range: null, help: null,
      children: root, members: [], depends: null,
    };
    root = ROOT_ID;
  }
  return { root, nodes };
}

/** Every symbol name the tree defines. */
export function symbolNames(tree) {
  const names = new Set();
  for (const n of Object.values((tree && tree.nodes) || {})) {
    if (n.name && n.kind === "symbol") names.add(n.name);
    for (const m of n.members || []) names.add(m.name);
  }
  return names;
}

/** The value text an int or hex input accepts, normalized, or an error sentence. */
export function checkNumber(node, raw) {
  const s = String(raw).trim();
  if (node.type === "int") {
    if (!/^[-+]?\d+$/.test(s)) return { error: "Enter a whole number." };
  } else if (node.type === "hex") {
    if (!/^(0[xX])?[0-9a-fA-F]+$/.test(s)) return { error: "Enter a hex number, like 0x8000." };
  } else {
    return { value: String(raw) };
  }
  // An int is written back in decimal without a plus sign or leading zeros: the
  // value reaches autoconf.h as typed, and C reads 0250000 as octal.
  const value = node.type === "int" ? BigInt(s).toString() : /^0[xX]/.test(s) ? s : `0x${s}`;
  if (node.range) {
    const parse = (t) => (node.type === "hex" ? BigInt(/^0[xX]/.test(t) ? t : `0x${t}`) : BigInt(t));
    try {
      const n = parse(value);
      if (n < parse(node.range[0]) || n > parse(node.range[1])) {
        return { error: `Enter a value from ${node.range[0]} to ${node.range[1]}.` };
      }
    } catch (e) {
      return { error: "Enter a number." };
    }
  }
  return { value };
}

function matchesText(node, q) {
  const fields = [node.prompt, node.name, node.help];
  for (const m of node.members || []) fields.push(m.prompt, m.name);
  return fields.some((f) => f && String(f).toLowerCase().includes(q));
}

export class KconfigTree {
  /**
   * container: an empty element the tree fills. Options: mode ("configure"
   * or "expose"), onSet(name, value) -> Promise (configure mode), and for
   * the expose mode isExposed(node) -> bool, onExpose(node, on) and
   * renderEditor(node, slot) (called on every update of an exposed node,
   * so it must keep focus itself). isExposed also marks exposed options in
   * configure mode.
   */
  constructor(container, { mode = "configure", onSet = null, isExposed = null, onExpose = null,
    renderEditor = null, idPrefix = "kc" } = {}) {
    this.container = container;
    this.mode = mode;
    this.onSet = onSet;
    this.isExposed = isExposed || (() => false);
    this.onExpose = onExpose;
    this.renderEditor = renderEditor;
    this.prefix = idPrefix;
    this.tree = null;
    this.key = null;            // which engine session the tree belongs to
    this.project = "";
    this.recs = new Map();      // node id -> {el, shape, ...}
    this.byEl = new WeakMap();  // a node's element -> its record
    this.helpOpen = new Set();
    this.collapsed = new Set();
    this.query = "";
    this.keep = null;           // node ids shown by the search, null when not searching
    this.matchCount = 0;
    this.hiddenMatches = [];
    this.locked = "";
    this.errors = new Map();    // node id -> message of a refused value

    this.list = document.createElement("div");
    this.list.className = "kc-list";
    this.hiddenNote = document.createElement("div");
    this.hiddenNote.className = "kc-hidden-matches";
    this.hiddenNote.hidden = true;
    this.container.classList.add("kc-tree", `kc-mode-${mode}`);
    this.container.append(this.list, this.hiddenNote);

    this.container.addEventListener("change", (e) => this._onChange(e));
    this.container.addEventListener("click", (e) => this._onClick(e));
    this.container.addEventListener("keydown", (e) => this._onKeyDown(e));
  }

  // ── Public ─────────────────────────────────────────────────────────

  /**
   * Show a tree. key names the engine session it comes from (project and
   * sha): a tree of another session is rendered afresh, one of the same
   * session is patched by id.
   */
  setTree(tree, key = "", project = "") {
    if (key !== this.key) {
      this.recs.clear();
      this.helpOpen.clear();
      this.errors.clear();
      this.list.replaceChildren();
      this.key = key;
      if (project !== this.project) {
        this.project = project;
        this._loadCollapsed();
      }
    }
    this.tree = tree;
    this.render();
  }

  /** Filter by text; returns {matches, hidden} counts. */
  setFilter(query) {
    this.query = String(query || "").trim().toLowerCase();
    this.render();
    return { matches: this.matchCount, hidden: this.hiddenMatches.length };
  }

  setLocked(reason) {
    this.locked = reason || "";
    this.render();
  }

  /** Re-render from the current tree (after the exposed options changed). */
  render() {
    const tree = this.tree;
    if (!tree || !tree.nodes || !tree.nodes[tree.root]) {
      this.list.replaceChildren();
      this.hiddenNote.hidden = true;
      return;
    }
    this._computeFilter();
    this._renderList(this.list, tree.nodes[tree.root].children, tree.nodes);
    this._renderHiddenMatches();
  }

  /** Focus the control of the first shown node, or of the shown node with this symbol name. */
  focus(name = null) {
    const target = this._navs().find((nav) => !name || (this._recOf(nav) || {}).name === name);
    if (!target) return false;
    target.focus();
    target.scrollIntoView({ block: "nearest" });
    return true;
  }

  // ── Search ─────────────────────────────────────────────────────────

  _computeFilter() {
    const q = this.query;
    this.hiddenMatches = [];
    this.matchCount = 0;
    if (!q) {
      this.keep = null;
      return;
    }
    const nodes = this.tree.nodes;
    const keep = new Set();
    const hidden = new Set();
    // forced: under a menu whose own prompt matches, which then shows whole.
    // A choice's members are matched (and counted) through the choice, which
    // shows them in its control.
    const visit = (id, forced, parent) => {
      const node = nodes[id];
      if (!node) return false;
      const member = parent && parent.kind === "choice" && isMember(parent, node);
      const self = id !== this.tree.root && !member && matchesText(node, q);
      const whole = forced || (self && node.kind === "menu");
      let any = false;
      for (const c of node.children || []) if (visit(c, whole, node)) any = true;
      if (node.visible && (self || any || forced || member)) {
        keep.add(id);
        if (self) this.matchCount++;
        return self || any || forced;
      }
      if (self && !node.visible && (node.kind === "symbol" || node.kind === "choice") && node.prompt) hidden.add(node);
      return false;
    };
    visit(this.tree.root, false, null);
    this.keep = keep;
    this.hiddenMatches = [...hidden];
  }

  _renderHiddenMatches() {
    const list = this.hiddenMatches;
    this.hiddenNote.hidden = !list.length;
    if (!list.length) return;
    const head = document.createElement("p");
    head.textContent = `${list.length === 1 ? "One match is" : `${list.length} matches are`} hidden with the current options:`;
    const ul = document.createElement("ul");
    const seen = new Set();
    const LIMIT = 12;
    for (const node of list) {
      const key = node.name || `${node.prompt}\u0000${node.depends}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (seen.size > LIMIT) {
        const more = document.createElement("li");
        more.textContent = `…and ${list.length - LIMIT} more. Search for a longer text to narrow the list.`;
        ul.append(more);
        break;
      }
      const li = document.createElement("li");
      const name = document.createElement("code");
      name.textContent = node.name || "choice";
      li.append(name, ` ${node.prompt}`);
      if (node.depends) {
        const dep = document.createElement("span");
        dep.className = "kc-dep";
        dep.textContent = ` (depends on ${node.depends})`;
        li.append(dep);
      }
      ul.append(li);
    }
    this.hiddenNote.replaceChildren(head, ul);
  }

  _shows(node) {
    return Boolean(node.visible) && (!this.keep || this.keep.has(node.id));
  }

  // ── Collapsing ─────────────────────────────────────────────────────

  _storeKey() {
    return `${STORE}.collapsed.${this.project || "any"}`;
  }

  _loadCollapsed() {
    this.collapsed = new Set();
    try {
      const raw = sessionStorage.getItem(this._storeKey());
      if (raw) for (const k of JSON.parse(raw)) this.collapsed.add(String(k));
    } catch (e) { /* storage blocked or damaged: everything open */ }
  }

  _saveCollapsed() {
    try { sessionStorage.setItem(this._storeKey(), JSON.stringify([...this.collapsed])); } catch (e) { /* blocked */ }
  }

  // A menu is remembered by its prompt (and a menuconfig symbol by its name),
  // which stay the same across versions, unlike node ids.
  _collapseKey(node) {
    return node.kind === "menu" ? `menu:${node.prompt}` : `sym:${node.name}`;
  }

  _isCollapsed(node) {
    return !this.keep && this.collapsed.has(this._collapseKey(node));
  }

  // ── Rendering ────────────────────────────────────────────────────

  _shape(node) {
    if (this.mode === "expose" && (node.kind === "choice" || node.kind === "symbol")) return `expose:${node.kind}`;
    if (node.kind === "choice") {
      const n = (node.members || []).filter((m) => m.visible).length;
      return `choice:${n <= 3 ? "radio" : "select"}`;
    }
    if (node.kind === "symbol") return `symbol:${node.type}:${node.menuconfig ? "mc" : ""}`;
    return node.kind;
  }

  // The children a node's element lists: a choice shows its members in its
  // control, so only what hangs under a member (or is not a member) remains.
  _childIds(node, nodes) {
    const ids = node.children || [];
    if (node.kind !== "choice") return ids;
    const out = [];
    for (const id of ids) {
      const child = nodes[id];
      if (!child) continue;
      if (isMember(node, child)) out.push(...(child.children || []));
      else out.push(id);
    }
    return out;
  }

  _renderList(parent, ids, nodes) {
    let cursor = parent.firstElementChild;
    for (const id of ids) {
      const node = nodes[id];
      if (!node) continue;
      let rec = this.recs.get(id);
      const shows = this._shows(node);
      if (!rec && !shows) continue;
      if (shows) {
        const shape = this._shape(node);
        if (!rec || rec.shape !== shape) {
          if (rec && rec.el.parentNode) {
            if (rec.el === cursor) cursor = cursor.nextElementSibling;
            rec.el.remove();
          }
          rec = this._create(node, shape);
          this.recs.set(id, rec);
        }
        this._update(rec, node, nodes);
      } else {
        // Hidden: left as it is (with what it holds) until it shows again.
        rec.el.hidden = true;
      }
      if (rec.el === cursor) cursor = cursor.nextElementSibling;
      else parent.insertBefore(rec.el, cursor);
    }
    while (cursor) {
      const next = cursor.nextElementSibling;
      cursor.remove();
      cursor = next;
    }
  }

  _el(tag, cls, attrs = {}) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  }

  _create(node, shape) {
    const id = `${this.prefix}-${node.id}`;
    const rec = { id: node.id, shape, kind: node.kind, name: node.name, el: null, nav: null };
    if (node.kind === "menu") {
      const el = this._el("section", "kc-node kc-menu");
      const head = this._el("button", "kc-menu-head", { type: "button", "aria-controls": `${id}-c`, "data-act": "toggle" });
      const caret = this._el("span", "kc-caret", { "aria-hidden": "true" });
      const prompt = this._el("span", "kc-prompt");
      head.append(caret, prompt);
      const children = this._el("div", "kc-children", { id: `${id}-c`, role: "group" });
      el.append(head, children);
      Object.assign(rec, { el, head, prompt, children, nav: head });
      this.byEl.set(el, rec);
      return rec;
    }
    if (node.kind === "comment") {
      const el = this._el("div", "kc-node kc-comment");
      const prompt = this._el("div", "kc-comment-text", { role: "heading", "aria-level": "4" });
      const children = this._el("div", "kc-children");
      el.append(prompt, children);
      Object.assign(rec, { el, prompt, children });
      this.byEl.set(el, rec);
      return rec;
    }

    const el = this._el("div", `kc-node kc-${node.kind}`);
    rec.el = el;
    const row = this._el("div", "kc-row");
    el.append(row);
    const help = this._el("div", "kc-help", { id: `${id}-h` });
    help.hidden = true;
    const helpBtn = this._el("button", "kc-help-btn", {
      type: "button", "data-act": "help", "aria-controls": `${id}-h`, "aria-expanded": "false",
    });
    helpBtn.textContent = "?";
    const nameEl = this._el("span", "kc-name");
    const badge = this._el("span", "kc-exposed", { title: "The reader of the generated page can change this ([[option]])" });
    badge.textContent = "embed option";
    const error = this._el("div", "kc-error", { role: "alert" });
    error.hidden = true;

    if (this.mode === "expose") {
      // The reader-can-change box, the prompt, and the value as text: the
      // values themselves are set in the Configure tab.
      const expose = this._el("input", "kc-expose", { type: "checkbox", id: `${id}-x`, "data-act": "expose" });
      const prompt = this._el("label", "kc-prompt", { for: `${id}-x` });
      const state = this._el("span", "kc-state");
      row.append(expose, prompt, state, nameEl, helpBtn);
      Object.assign(rec, { expose, prompt, state, nav: expose });
    } else if (node.kind === "choice" && shape === "choice:radio") {
      const prompt = this._el("span", "kc-prompt", { id: `${id}-p` });
      const options = this._el("div", "kc-radio-list", { role: "radiogroup", "aria-labelledby": `${id}-p` });
      row.append(prompt, options, badge, nameEl, helpBtn);
      Object.assign(rec, { prompt, radios: options });
    } else if (node.kind === "choice") {
      const prompt = this._el("label", "kc-prompt", { for: `${id}-v` });
      const select = this._el("select", "kc-select", { id: `${id}-v`, "data-act": "choice" });
      row.append(prompt, select, badge, nameEl, helpBtn);
      Object.assign(rec, { prompt, control: select, nav: select });
    } else if (node.type === "bool") {
      const box = this._el("input", "kc-check", { type: "checkbox", id: `${id}-v`, "data-act": "bool" });
      const prompt = this._el("label", "kc-prompt", { for: `${id}-v` });
      row.append(box, prompt, badge, nameEl, helpBtn);
      Object.assign(rec, { prompt, control: box, nav: box });
    } else if (node.type === "tristate") {
      const prompt = this._el("label", "kc-prompt", { for: `${id}-v` });
      const select = this._el("select", "kc-select kc-tri", { id: `${id}-v`, "data-act": "tristate" });
      for (const [v, label] of [["n", "No"], ["m", "Module"], ["y", "Yes"]]) select.append(new Option(label, v));
      row.append(prompt, select, badge, nameEl, helpBtn);
      Object.assign(rec, { prompt, control: select, nav: select });
    } else if (node.type === "int" || node.type === "hex" || node.type === "string") {
      const prompt = this._el("label", "kc-prompt", { for: `${id}-v` });
      const input = this._el("input", `kc-input kc-${node.type}`, {
        type: "text", id: `${id}-v`, "data-act": "value", spellcheck: "false", autocomplete: "off",
        "aria-describedby": `${id}-r`,
      });
      if (node.type === "int") input.setAttribute("inputmode", "numeric");
      const range = this._el("span", "kc-range", { id: `${id}-r` });
      row.append(prompt, input, range, badge, nameEl, helpBtn);
      Object.assign(rec, { prompt, control: input, range, nav: input });
    } else {
      // A symbol of unknown type (a Kconfig warning): show its value only.
      const prompt = this._el("span", "kc-prompt");
      const value = this._el("code", "kc-value");
      row.append(prompt, value, nameEl, helpBtn);
      Object.assign(rec, { prompt, value });
    }
    el.append(error, help);
    const editor = this._el("div", "kc-editor");
    editor.hidden = true;
    const children = this._el("div", "kc-children");
    el.append(editor, children);
    Object.assign(rec, { row, help, helpBtn, nameEl, badge, error, editor, children });
    if (!rec.nav) rec.nav = rec.expose || helpBtn;
    this.byEl.set(el, rec);
    return rec;
  }

  _update(rec, node, nodes) {
    const q = this.query;
    rec.el.hidden = !this._shows(node);
    rec.name = node.name;
    rec.el.dataset.name = node.name || "";
    if (node.kind === "menu") {
      const collapsed = this._isCollapsed(node);
      rec.head.setAttribute("aria-expanded", String(!collapsed));
      rec.children.hidden = collapsed;
      setMarked(rec.prompt, node.prompt, q);
      rec.head.title = node.depends ? `Depends on: ${node.depends}` : "";
      this._renderList(rec.children, this._childIds(node, nodes), nodes);
      return;
    }
    if (node.kind === "comment") {
      setMarked(rec.prompt, node.prompt, q);
      rec.prompt.title = node.depends ? `Depends on: ${node.depends}` : "";
      this._renderList(rec.children, this._childIds(node, nodes), nodes);
      return;
    }

    const exposed = this.isExposed(node);
    const lockedOut = Boolean(this.locked) || this.mode === "expose";
    const disabled = lockedOut || !node.editable;
    setMarked(rec.prompt, node.prompt || node.name, q);
    rec.prompt.title = node.depends ? `Depends on: ${node.depends}` : "";
    setMarked(rec.nameEl, node.name || "", q);
    rec.badge.hidden = !(exposed && this.mode === "configure");
    rec.el.classList.toggle("kc-is-exposed", exposed);
    rec.el.classList.toggle("kc-user", node.user_value !== null && node.user_value !== undefined);

    const hasHelp = Boolean(node.help);
    rec.helpBtn.hidden = !hasHelp;
    if (hasHelp) {
      const open = this.helpOpen.has(node.id) || Boolean(q && node.help.toLowerCase().includes(q));
      rec.helpBtn.setAttribute("aria-expanded", String(open));
      rec.helpBtn.setAttribute("aria-label", `Help: ${node.prompt || node.name}`);
      rec.helpBtn.title = "Show the help text";
      rec.help.hidden = !open;
      if (open) setHelp(rec.help, node.help);
    } else {
      rec.help.hidden = true;
    }

    const err = this.errors.get(node.id);
    rec.error.hidden = !err;
    text(rec.error, err || "");

    if (rec.state) text(rec.state, this._stateText(node));
    else if (node.kind === "choice") this._updateChoice(rec, node, disabled);
    else if (rec.control) this._updateValue(rec, node, disabled);
    else if (rec.value) text(rec.value, node.value);

    if (rec.expose) {
      const can = Boolean(node.editable);
      rec.expose.checked = exposed;
      rec.expose.disabled = !can && !exposed;
      rec.expose.title = can ? "The reader of the generated page can change this ([[option]])"
        : "Not shown with the current options, so the reader could not change it";
      rec.expose.setAttribute("aria-label", `The reader can change: ${node.prompt || node.name}`);
      rec.editor.hidden = !exposed;
      if (exposed && this.renderEditor) this.renderEditor(node, rec.editor);
      else if (!exposed && rec.editor.firstChild) rec.editor.replaceChildren();
    }

    const childIds = this._childIds(node, nodes);
    const collapsible = node.kind === "symbol" && node.menuconfig;
    if (collapsible) {
      const collapsed = this._isCollapsed(node) || node.value === "n";
      rec.children.hidden = collapsed;
    }
    this._renderList(rec.children, childIds, nodes);
  }

  // A value as the expose mode shows it.
  _stateText(node) {
    if (node.kind === "choice") {
      const m = (node.members || []).find((x) => x.name === node.value);
      return m ? m.prompt : "(none)";
    }
    if (node.type === "bool" || node.type === "tristate") return { y: "on", m: "module", n: "off" }[node.value] || node.value;
    return node.value === "" ? "(empty)" : node.value;
  }

  _updateValue(rec, node, disabled) {
    const c = rec.control;
    c.disabled = disabled;
    if (node.type === "bool") {
      c.checked = node.value === "y";
      c.indeterminate = node.value === "m";
    } else if (node.type === "tristate") {
      if (c.value !== node.value) c.value = node.value;
    } else {
      // Never overwrite what someone is typing, or a value the engine refused
      // (it stays for them to fix).
      if (document.activeElement !== c && !this.errors.has(node.id)) {
        if (c.value !== (node.value || "")) c.value = node.value || "";
      }
      c.setAttribute("aria-invalid", String(this.errors.has(node.id)));
      if (node.range) {
        text(rec.range, `${node.range[0]} to ${node.range[1]}`);
        rec.range.title = `Allowed: ${node.range[0]} to ${node.range[1]}`;
      } else {
        text(rec.range, node.type === "hex" ? "hex" : "");
      }
    }
  }

  _updateChoice(rec, node, disabled) {
    const members = (node.members || []).filter((m) => m.visible);
    const key = members.map((m) => `${m.name}\u0001${m.prompt}`).join("\u0002");
    if (rec.radios) {
      if (rec.optionsKey !== key) {
        rec.optionsKey = key;
        const group = `${this.prefix}-${node.id}-g`;
        rec.radios.replaceChildren(...members.map((m) => {
          const label = this._el("label", "kc-radio");
          const input = this._el("input", "", { type: "radio", name: group, value: m.name, "data-act": "choice" });
          const span = this._el("span", "kc-radio-text");
          label.append(input, span);
          return label;
        }));
      }
      const inputs = [...rec.radios.querySelectorAll("input")];
      inputs.forEach((input, i) => {
        input.checked = members[i].name === node.value;
        input.disabled = disabled;
        setMarked(input.nextElementSibling, members[i].prompt, this.query);
        input.closest("label").title = members[i].name;
      });
      rec.nav = inputs.find((i) => i.checked) || inputs[0] || rec.helpBtn;
      return;
    }
    const select = rec.control;
    if (rec.optionsKey !== key || (node.value === null) !== Boolean(rec.noneOption)) {
      rec.optionsKey = key;
      select.replaceChildren(...members.map((m) => {
        const opt = new Option(m.prompt, m.name);
        opt.title = m.name;
        return opt;
      }));
      rec.noneOption = null;
      if (node.value === null) {
        rec.noneOption = new Option("(none)", "");
        select.prepend(rec.noneOption);
      }
    }
    if (select.value !== (node.value || "")) select.value = node.value || "";
    select.disabled = disabled;
  }

  // ── Events ─────────────────────────────────────────────────────────

  _recOf(el) {
    const nodeEl = el.closest(".kc-node");
    return nodeEl ? this.byEl.get(nodeEl) || null : null;
  }

  _node(rec) {
    return rec && this.tree ? this.tree.nodes[rec.id] : null;
  }

  async _set(rec, name, value) {
    if (!this.onSet) return;
    this.errors.delete(rec.id);
    rec.el.setAttribute("aria-busy", "true");
    try {
      await this.onSet(name, value);
    } catch (e) {
      this.errors.set(rec.id, e && e.message ? e.message : String(e));
    } finally {
      rec.el.removeAttribute("aria-busy");
      this.render();
    }
  }

  _onChange(e) {
    const t = e.target;
    const act = t.dataset ? t.dataset.act : null;
    const rec = this._recOf(t);
    const node = this._node(rec);
    if (!rec || !node) return;
    if (act === "expose") {
      if (this.onExpose) this.onExpose(node, t.checked);
      return;
    }
    if (this.mode !== "configure") return;
    if (act === "bool") this._set(rec, node.name, t.checked ? "y" : "n");
    else if (act === "tristate") this._set(rec, node.name, t.value);
    else if (act === "choice" && t.value) this._set(rec, t.value, "y");
    else if (act === "value") {
      const checked = checkNumber(node, t.value);
      if (checked.error) {
        this.errors.set(rec.id, checked.error);
        this.render();
        return;
      }
      if (checked.value === node.value) {
        this.errors.delete(rec.id);
        this.render();
        return;
      }
      this._set(rec, node.name, checked.value);
    }
  }

  _onClick(e) {
    const btn = e.target.closest("button[data-act]");
    if (!btn || !this.container.contains(btn)) return;
    const rec = this._recOf(btn);
    const node = this._node(rec);
    if (!node) return;
    if (btn.dataset.act === "toggle") {
      const key = this._collapseKey(node);
      if (this.collapsed.has(key)) this.collapsed.delete(key);
      else this.collapsed.add(key);
      this._saveCollapsed();
      this.render();
    } else if (btn.dataset.act === "help") {
      if (this.helpOpen.has(node.id)) this.helpOpen.delete(node.id);
      else this.helpOpen.add(node.id);
      this.render();
    }
  }

  // Up and Down move between rows (Alt with them inside a text field, select
  // or radio group, which use the arrows themselves); Left and Right fold a
  // menu; Escape puts back a value being typed.
  _onKeyDown(e) {
    const t = e.target;
    const own = t.matches("input[type=text], select, input[type=radio], textarea");
    if (e.key === "Escape" && t.matches("input.kc-input")) {
      const rec = this._recOf(t);
      const node = this._node(rec);
      if (node) {
        this.errors.delete(rec.id);
        t.value = node.value || "";
        this.render();
      }
      return;
    }
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && (e.altKey || !own)) {
      const navs = this._navs();
      const row = t.closest(".kc-row");
      const i = navs.findIndex((n) => n === t || (row !== null && n.closest(".kc-row") === row));
      const next = navs[i + (e.key === "ArrowDown" ? 1 : -1)];
      if (next) {
        e.preventDefault();
        next.focus();
      }
      return;
    }
    if ((e.key === "Home" || e.key === "End") && !own) {
      const navs = this._navs();
      const next = e.key === "Home" ? navs[0] : navs[navs.length - 1];
      if (next) {
        e.preventDefault();
        next.focus();
      }
      return;
    }
    if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && t.matches(".kc-menu-head")) {
      const rec = this._recOf(t);
      const node = this._node(rec);
      if (!node) return;
      const key = this._collapseKey(node);
      const collapse = e.key === "ArrowLeft";
      if (collapse === this.collapsed.has(key)) return;
      e.preventDefault();
      if (collapse) this.collapsed.add(key);
      else this.collapsed.delete(key);
      this._saveCollapsed();
      this.render();
    }
  }

  _navs() {
    const out = [];
    const walk = (parent) => {
      for (const el of parent.children) {
        if (el.hidden) continue;
        const rec = this._recOf(el);
        if (!rec) continue;
        if (rec.nav && !rec.nav.disabled && !rec.nav.hidden) out.push(rec.nav);
        else if (rec.expose && !rec.expose.disabled) out.push(rec.expose);
        if (rec.children && !rec.children.hidden) walk(rec.children);
      }
    };
    walk(this.list);
    return out;
  }
}
