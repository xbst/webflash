// The version control: mountVersionPicker, the searchable version list (a
// combobox) that page 1, Embed options and the embed card use.
//
// It lists the project's refs from the sources index, grouped "Latest" (the
// default branch, with its describe string and date), "Releases" (tags,
// newest first, with "Newest release" on top), "Branches" and "Older
// commits" (history/<project>.json, loaded when the list opens or the user
// types), labeled with the git describe string Mainsail and Fluidd show. The selected value is [firmware] version itself: "latest", "release",
// a ref id or an older commit's describe string, so what the control shows is
// what Save TOML writes. Refs whose snapshot did not pass the gate say so in
// their label, and a badge beside the control says so for the one selected;
// resolveVersion never picks them for "latest".

import {
  groupRefs, resolveVersion, projectTitle, isChecked, uncheckedText,
  historyInfo, historyRefs, loadHistory, findVersion, parseVersionString, sourcesBase,
} from "./sources.js";

// ── The version combobox ─────────────────────────────────────────────

/** How many older commits the list shows at once; typing narrows them. */
export const OLDER_SHOWN = 50;

const describeOf = (ref) => ref.describe || ref.id;

/**
 * Whether the TOML's versions setting ("all", "releases" or a list of ids)
 * offers a value; the value the control holds is always offered.
 */
function offered(versions, tags, value, current) {
  if (value === current || !versions || versions === "all") return true;
  if (versions === "releases") return value === "release" || tags.has(value);
  return Array.isArray(versions) && versions.includes(value);
}

/** Whether a versions setting narrows what the reader picks from. */
const restricts = (versions) => Boolean(versions) && versions !== "all";

/**
 * Whether the versions offered can hold an older commit (only then is the
 * history file worth its download): every version, a list naming one, or
 * the value held being one.
 */
export function mayOfferOlder(index, project, versions, value) {
  if (!restricts(versions)) return true;
  const older = (v) => {
    const r = resolveVersion(index, project, v);
    return Boolean(r.pending || (r.ref && r.ref.kind === "commit"));
  };
  if (value && value !== "latest" && value !== "release" && older(value)) return true;
  return Array.isArray(versions) && versions.some((v) => v !== "latest" && v !== "release" && older(v));
}

/**
 * findVersion among the versions offered: a pasted Mainsail/Fluidd version
 * never picks a ref the TOML's versions leave out, so a card restricted to
 * some versions builds only those. Anything but the commit itself waits for
 * the older commits: {ref: null, pending: true, error} while they are not
 * loaded (loading, or failed), since the closest kept commit may be among them.
 */
export function matchVersion(index, project, text, { value = "latest", versions = "all" } = {}) {
  let found;
  if (!restricts(versions)) found = findVersion(index, project, text);
  else {
    const g = groupRefs(index, project);
    const tags = new Set(g ? g.releases.map((r) => r.id) : []);
    found = findVersion(index, project, text, (ref) => offered(versions, tags, ref.id, value));
  }
  if (found && !found.exact && historyInfo(index, project) && !historyRefs(index, project) &&
      mayOfferOlder(index, project, versions, value)) {
    return { ref: null, pending: true,
      error: `${String(text).trim()} may be an older ${projectTitle(index, project)} commit; the list of older commits has not loaded yet.` };
  }
  return found;
}

/**
 * The combobox's list for a query, pure, for tests: {groups: [{label,
 * options: [{value, label, detail, unchecked, title, ref?}]}], match,
 * more, older}. The groups are "Latest", "Releases" and "Branches"
 * (narrowed by versions), then "Older commits" (the loaded history, OLDER_SHOWN at most; more says
 * how many matched beyond). A query filters by label, id, describe string
 * or commit; a query that reads as a Mainsail/Fluidd version gives match
 * (findVersion's answer), shown first as the "Match" group when it found a ref.
 */
export function pickerList(index, project, { value = "latest", versions = "all", query = "" } = {}) {
  const g = groupRefs(index, project);
  if (!g) return { groups: [], match: null, more: 0, older: false };
  const tags = new Set(g.releases.map((r) => r.id));
  const q = String(query || "").trim().toLowerCase();
  const hits = (o) => !q || [o.label, o.value, o.detail, o.ref && o.ref.describe, o.ref && o.ref.sha && o.ref.sha.slice(0, 12)]
    .some((s) => s && String(s).toLowerCase().includes(q));
  const caution = (ref) => {
    const text = uncheckedText(ref);
    return `${text[0].toUpperCase()}${text.slice(1)}: it may not build.`;
  };
  const opt = (v, label, ref, detail, title) => ({
    value: v, label, detail: detail.filter(Boolean).join(" · "), ref, unchecked: !isChecked(ref),
    title: title || (isChecked(ref) ? "" : caution(ref)),
  });
  const groups = [];
  const push = (label, options) => {
    const shown = options.filter((o) => offered(versions, tags, o.value, value) && hits(o));
    if (shown.length) groups.push({ label, options: shown });
  };
  const latest = resolveVersion(index, project, "latest");
  if (latest.ref) {
    const r = latest.ref;
    push("Latest", [opt("latest", "Latest", r, [r.id, r.kind === "tag" ? "" : r.describe, r.date],
      latest.note || `The newest checked snapshot of ${projectTitle(index, project)}'s default branch.`)]);
  }
  if (g.releases.length) {
    const newest = resolveVersion(index, project, "release").ref;
    push("Releases", [
      opt("release", "Newest release", newest, [newest.id, newest.date],
        "Follows the newest checked release: a saved board TOML moves to the next release when it is published."),
      ...g.releases.map((r) => opt(r.id, r.id, r, [r.date])),
    ]);
  }
  const branches = [...g.branches];
  // A board TOML may name the default branch itself; list it so it can show as selected.
  if (g.defaultBranch && value === g.defaultBranch.id) branches.unshift(g.defaultBranch);
  push("Branches", branches.map((r) => opt(r.id, r.id, r, [r.describe, r.date])));
  const older = historyRefs(index, project);
  let more = 0;
  if (older) {
    const options = [];
    for (const ref of older) {
      if (!offered(versions, tags, ref.id, value)) continue;
      const o = opt(ref.id, describeOf(ref), ref, [ref.date]);
      if (!hits(o)) continue;
      if (options.length < OLDER_SHOWN) options.push(o);
      else more += 1;
    }
    if (options.length) groups.push({ label: "Older commits", options });
  }
  const match = q && parseVersionString(query) ? matchVersion(index, project, query, { value, versions }) : null;
  // The match leads the list, unless the filter already shows it (a hash typed whole).
  if (match && match.ref && !groups.some((grp) => grp.options.some((o) => o.value === match.ref.id))) {
    const ref = match.ref;
    groups.unshift({
      label: "Match",
      options: [{ value: ref.id, label: describeOf(ref),
        detail: match.exact ? "this commit" : restricts(versions) ? "closest offered" : "closest kept",
        unchecked: !isChecked(ref), ref, note: match.note, title: match.note || "" }],
    });
  }
  return { groups, match, more, older: older !== null };
}

/** What the closed combobox shows for a value. */
export function versionText(index, project, value) {
  if (!index) return value || "";
  const { ref } = resolveVersion(index, project, value);
  if (!ref) return value;
  if (value === "latest" || !value) return `Latest · ${describeOf(ref)}`;
  if (value === "release") return `Newest release · ${ref.id}`;
  if (ref.kind === "tag" || ref.kind === "commit") return ref.kind === "tag" ? ref.id : describeOf(ref);
  return `${ref.id} · ${describeOf(ref)}`;
}

let pickers = 0;
const PLACEHOLDER = "Search, or paste a version from Mainsail";

const STYLE = `
.wf-vp{position:relative;display:flex;flex-wrap:wrap;align-items:center;gap:6px;min-width:0;width:100%;max-width:30em;font:inherit}
.wf-vp-field{position:relative;display:flex;flex:1 1 18em;min-width:0}
.wf-vp-input{flex:1;min-width:0;box-sizing:border-box;font:inherit;padding:5px 28px 5px 8px;border-radius:6px;
  color:var(--control-text,var(--text,#e6e6e6));background:var(--control-bg,var(--bg-input,#1d2127));
  border:1px solid var(--control-border,var(--border,#3a3f47))}
.wf-vp-input:focus{outline:2px solid var(--accent,#4c8dff);outline-offset:-1px}
.wf-vp-input:disabled{opacity:.6}
.wf-vp-toggle{position:absolute;right:2px;top:50%;transform:translateY(-50%);border:0;background:none;cursor:pointer;
  color:var(--text-muted,var(--text-dim,#9aa0a6));padding:2px 6px;font:inherit}
.wf-vp-badge{font-size:.8em;padding:1px 6px;border-radius:9px;color:var(--warn,#e0a030);border:1px solid currentColor}
.wf-vp-list{position:absolute;z-index:50;left:0;right:0;top:100%;margin-top:2px;max-height:min(22em,60vh);overflow:auto;
  box-sizing:border-box;padding:4px 0;border-radius:6px;background:var(--bg-panel,var(--control-bg,var(--bg,#1b1e23)));
  border:1px solid var(--control-border,var(--border,#3a3f47));box-shadow:0 6px 20px rgba(0,0,0,.35)}
.wf-vp-group{padding:6px 10px 2px;font-size:.78em;text-transform:uppercase;letter-spacing:.04em;
  color:var(--text-muted,var(--text-dim,#9aa0a6))}
.wf-vp-option{display:flex;gap:8px;align-items:baseline;padding:4px 10px;cursor:pointer;color:var(--text,#e6e6e6)}
.wf-vp-option[aria-selected="true"] .wf-vp-label{font-weight:600}
.wf-vp-option.active{background:var(--accent-bg,rgba(76,141,255,.18))}
.wf-vp-label{font-family:var(--mono-font,ui-monospace,monospace);white-space:nowrap}
.wf-vp-detail{color:var(--text-muted,var(--text-dim,#9aa0a6));font-size:.88em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wf-vp-option.unchecked .wf-vp-detail::after{content:" · unchecked";color:var(--warn,#e0a030)}
.wf-vp-info{padding:4px 10px;font-size:.88em;color:var(--text-muted,var(--text-dim,#9aa0a6))}
.wf-vp-info button{font:inherit;color:var(--accent,#4c8dff);background:none;border:0;padding:0;cursor:pointer;text-decoration:underline}
.wf-vp-note{flex-basis:100%;font-size:.88em;color:var(--text-muted,var(--text-dim,#9aa0a6))}
.wf-vp-note.error{color:var(--error,var(--danger,#e5534b))}
`;

// The control styles itself (once per document) from the page's theme
// variables, with fallbacks, so it looks at home on the site and in a card.
function addStyle(doc) {
  const parent = doc.head || doc.documentElement;
  if (!parent || (doc.getElementById && doc.getElementById("wf-vp-style"))) return;
  const style = doc.createElement("style");
  style.id = "wf-vp-style";
  style.textContent = STYLE;
  parent.append(style);
}

function make(doc, tag, attrs = {}, text = "") {
  const el = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  if (text) el.textContent = text;
  return el;
}

/**
 * Mount the version combobox in el. opts: project, index (the sources
 * index, or null while it loads), value ([firmware] version: "latest",
 * "release", a ref id or an older commit's describe string), versions (the
 * TOML's offered versions: "all", "releases" or a list of ids; default
 * "all"), onChange(value, {ref, note}) when the user picks one, and
 * optionally base (where sources/ is), disabled and label (its accessible
 * name). Returns {update(opts), destroy(), value, el}.
 */
export function mountVersionPicker(el, opts = {}) {
  return new VersionCombobox(el, opts);
}

class VersionCombobox {
  constructor(el, opts) {
    const doc = el.ownerDocument || document;
    addStyle(doc);
    this.doc = doc;
    this.host = el;
    this.opts = { versions: "all", value: "latest", ...opts };
    this.id = `wf-vp-${++pickers}`;
    this.query = null;          // the typed text while the user searches, else null
    this.open = false;
    this.active = -1;
    this.flat = [];
    this.note = "";
    this.noteError = false;
    this.loadError = "";

    const list = `${this.id}-list`;
    const root = make(doc, "div", { class: "wf-vp" });
    const field = make(doc, "div", { class: "wf-vp-field" });
    this.input = make(doc, "input", {
      class: "wf-vp-input", type: "text", role: "combobox", autocomplete: "off", spellcheck: "false",
      "aria-autocomplete": "list", "aria-expanded": "false", "aria-controls": list, placeholder: PLACEHOLDER,
    });
    this.toggle = make(doc, "button", { class: "wf-vp-toggle", type: "button", tabindex: "-1",
      "aria-label": "Show versions", "aria-controls": list }, "▾");
    field.append(this.input, this.toggle);
    this.badge = make(doc, "span", { class: "wf-vp-badge", hidden: true }, "unchecked");
    this.list = make(doc, "div", { class: "wf-vp-list", role: "listbox", "aria-label": "Versions", id: list, hidden: true });
    this.noteEl = make(doc, "div", { class: "wf-vp-note", "aria-live": "polite", hidden: true });
    root.append(field, this.badge, this.list, this.noteEl);
    this.root = root;
    this.rows = [];
    el.append(root);

    this._on(this.input, "input", () => this._typed(false));
    this._on(this.input, "paste", () => setTimeout(() => this._typed(true), 0));
    this._on(this.input, "keydown", (e) => this._key(e));
    this._on(this.input, "click", () => { if (!this.open) this._open(); });
    this._on(this.input, "focus", () => { if (this.input.select) this.input.select(); });
    this._on(this.toggle, "mousedown", (e) => e.preventDefault());
    this._on(this.toggle, "click", () => { this.input.focus(); this.open ? this._close() : this._open(); });
    this._on(this.list, "mousedown", (e) => e.preventDefault());
    this._on(this.list, "click", (e) => this._click(e));
    this._on(root, "focusout", (e) => { if (!root.contains(e.relatedTarget)) this._close(true); });
    this.render();
  }

  _on(target, type, fn) {
    target.addEventListener(type, fn);
    (this.listeners || (this.listeners = [])).push(() => target.removeEventListener(type, fn));
  }

  get value() { return this.opts.value; }
  get el() { return this.root; }

  update(opts) {
    if (opts.project !== undefined && opts.project !== this.opts.project) {
      this.query = null;
      this._setNote("");
    }
    if ((opts.index !== undefined && opts.index !== this.opts.index) || (opts.value !== undefined && opts.value !== this.opts.value)) {
      this.loadError = "";
      if (opts.value !== undefined && opts.value !== this.opts.value) this._setNote("");
    }
    Object.assign(this.opts, opts);
    this.render();
  }

  destroy() {
    for (const off of this.listeners || []) off();
    this.root.remove();
  }

  _setNote(text, error = false) {
    this.note = text || "";
    this.noteError = error;
  }

  /** Start loading the older commits if they are not here yet; resolves when settled. */
  _history() {
    const { index, project } = this.opts;
    // A load started for another project or index (a switch, a reloaded
    // index) is left to settle alone: this one is the one waited for.
    if (this.loading && this.loadingFor.index === index && this.loadingFor.project === project) return this.loading;
    if (!index || !historyInfo(index, project) || historyRefs(index, project)) return null;
    if (!mayOfferOlder(index, project, this.opts.versions, this.opts.value)) return null;
    this.loadError = "";
    this.loadingFor = { index, project };
    const p = loadHistory(index, project, this.opts.base || sourcesBase())
      .then(() => {}, (e) => { if (this.loading === p) this.loadError = e.message; })
      .then(() => {
        if (this.loading !== p) return;
        this.loading = null;
        this.render();
      });
    this.loading = p;
    return p;
  }

  _open() {
    if (this.opts.disabled || !this.opts.index) return;
    if (!this.open && this.query === null) {
      // The closed field shows a label, not text to edit: the open list
      // searches from an empty field, the version held as its placeholder.
      this.query = "";
      this.input.placeholder = versionText(this.opts.index, this.opts.project, this.opts.value);
      this.input.value = "";
    }
    this.open = true;
    this._history();
    this.render();
    this._scrollToActive();
  }

  _close(restore = true) {
    this.open = false;
    if (restore) this.query = null;
    this.active = -1;
    this.render();
  }

  async _typed(pasted) {
    if (!this.opts.index) return;
    this.query = this.input.value;
    this.open = true;
    this.active = -1;
    this._history();
    this.render();
    if (!pasted || !parseVersionString(this.query)) return;
    // A version pasted from Mainsail or Fluidd is picked at once: the commit
    // when it is kept, else the closest older kept one, with a note.
    await this._pickTyped();
  }

  /**
   * Pick what the typed version string names once the older commits are
   * here; when they could not be loaded, the open list says why, with Try again.
   */
  async _pickTyped() {
    const query = this.query;
    const loading = this._history();
    if (loading) await loading;
    if (this.query !== query) return;
    const found = this._find(query);
    if (found && found.ref) this._pick(found.ref.id, found.note || "");
    else if (found && !found.pending) { this._setNote(found.error, true); this.render(); }
    else this.render();
  }

  /** What a typed or pasted version string picks, among the versions offered. */
  _find(text) {
    const { index, project, value, versions } = this.opts;
    return matchVersion(index, project, text, { value, versions });
  }

  _pick(value, note = "") {
    const { index, project } = this.opts;
    this.opts.value = value;
    this.query = null;
    this.open = false;
    this.active = -1;
    this._setNote(note);
    this.render();
    const ref = index ? resolveVersion(index, project, value).ref : null;
    if (this.opts.onChange) this.opts.onChange(value, { ref, note });
  }

  _click(e) {
    const retry = e.target.closest("[data-retry]");
    if (retry) { this._history(); this.render(); return; }
    const option = e.target.closest("[role=option]");
    if (!option) return;
    const o = this.flat[Number(option.dataset.i)];
    if (o) this._pick(o.value, o.note || "");
  }

  _key(e) {
    const move = (step) => {
      e.preventDefault();
      if (!this.open) {
        // Opening lands on the selected version.
        this._open();
        this.active = Math.max(0, this._selectedIndex());
      } else {
        const n = this.flat.length;
        if (!n) return;
        const from = this.active < 0 ? (step > 0 ? -1 : n) : this.active;
        this.active = Math.max(0, Math.min(n - 1, from + step));
      }
      this.render();
      this._scrollToActive();
    };
    if (e.key === "ArrowDown" && e.altKey) { e.preventDefault(); this._open(); return; }
    if (e.key === "ArrowUp" && e.altKey) { e.preventDefault(); this._close(false); return; }
    if (e.key === "ArrowDown") return move(1);
    if (e.key === "ArrowUp") return move(-1);
    if (e.key === "PageDown") return move(10);
    if (e.key === "PageUp") return move(-10);
    if (e.key === "Enter") {
      if (!this.open && this.query === null) return;
      e.preventDefault();
      const o = this.active >= 0 ? this.flat[this.active] : null;
      if (o) return this._pick(o.value, o.note || "");
      const found = this.query && this._find(this.query);
      if (found && found.pending) { this._pickTyped(); return; }
      if (found && found.ref) return this._pick(found.ref.id, found.note || "");
      if (found) { this._setNote(found.error, true); this.render(); }
      return;
    }
    if (e.key === "Escape") {
      // Only an Escape the control uses stops here: a dialog around it gets the rest.
      if (this.open || this.query !== null) {
        e.preventDefault();
        if (e.stopPropagation) e.stopPropagation();
        this._close(true);
        if (this.input.select) this.input.select();
      }
    }
  }

  _selectedIndex() {
    return this.flat.findIndex((o) => o.value === this.opts.value);
  }

  _scrollToActive() {
    const row = this.rows[this.active];
    if (row && row.scrollIntoView) row.scrollIntoView({ block: "nearest" });
  }

  render() {
    const { index, project, value, versions, disabled } = this.opts;
    const input = this.input;
    input.disabled = Boolean(disabled) || !index;
    input.setAttribute("aria-label", this.opts.label || `${index ? projectTitle(index, project) : ""} version`.trim());
    if (this.query === null) {
      const text = index ? versionText(index, project, value) : "Loading versions…";
      if (input.value !== text) input.value = text;
      input.placeholder = PLACEHOLDER;
    }
    const resolved = index ? resolveVersion(index, project, value) : { ref: null };
    const ref = resolved.ref;
    if (index && !ref && resolved.pending && !this.loadError) this._history();
    this.badge.hidden = !(ref && !isChecked(ref));
    if (!this.badge.hidden) {
      this.badge.title = `This snapshot (${describeOf(ref)}) ${uncheckedText(ref)}; it may still build.`;
    }
    input.title = ref ? `${projectTitle(index, project)} ${describeOf(ref)}${ref.date ? ` · ${ref.date}` : ""}` +
      (resolved.note ? `\n${resolved.note}` : "") : (resolved.error || "");

    const note = this.note || (index && !ref && !resolved.pending && value ? `${value} is not in the list of versions.` : "");
    this.noteEl.hidden = !note;
    this.noteEl.textContent = note;
    this.noteEl.classList.toggle("error", this.noteError || (!this.note && Boolean(note)));

    input.setAttribute("aria-expanded", String(this.open));
    this.list.hidden = !this.open;
    if (!this.open) {
      input.removeAttribute("aria-activedescendant");
      this.list.replaceChildren();
      this.flat = [];
      this.rows = [];
      return;
    }
    const doc = this.doc;
    const data = pickerList(index, project, { value, versions, query: this.query || "" });
    this.flat = data.groups.flatMap((g) => g.options);
    if (this.active >= this.flat.length) this.active = this.flat.length - 1;
    if (this.active < 0 && this.query) this.active = this.flat.length ? 0 : -1;
    const nodes = [];
    this.rows = [];
    data.groups.forEach((g, gi) => {
      const group = make(doc, "div", { role: "group", "aria-label": g.label });
      group.append(make(doc, "div", { class: "wf-vp-group", "aria-hidden": "true" }, g.label));
      for (const o of g.options) {
        const i = this.rows.length;
        // Named outright: the hover title is a note, not the option's name.
        const name = [o.label, o.detail, o.unchecked ? "unchecked" : ""].filter(Boolean).join(", ");
        const row = make(doc, "div", {
          role: "option", id: `${this.id}-o${i}`, "data-i": String(i), "aria-label": name,
          class: `wf-vp-option${o.unchecked ? " unchecked" : ""}${i === this.active ? " active" : ""}`,
          "aria-selected": String(o.value === value && g.label !== "Match"),
        });
        if (o.title) row.title = o.title;
        row.append(make(doc, "span", { class: "wf-vp-label" }, o.label),
          make(doc, "span", { class: "wf-vp-detail" }, o.detail || ""));
        group.append(row);
        this.rows.push(row);
      }
      nodes.push(group);
    });
    const info = (text, retry = false) => {
      const row = make(doc, "div", { class: "wf-vp-info", role: "presentation" }, text);
      if (retry) {
        row.append(" ");
        row.append(make(doc, "button", { type: "button", "data-retry": "" }, "Try again"));
      }
      nodes.push(row);
    };
    const history = historyInfo(index, project);
    const showsOlder = history && mayOfferOlder(index, project, versions, value);
    if (showsOlder && !data.older) {
      if (this.loadError) info(this.loadError, true);
      else {
        info(`Loading ${history.count} older commits…`);
        this._history();     // a switch or a new index while the list is open
      }
    }
    if (data.more) info(`${data.more} more older commits: type to narrow the list.`);
    // A match waiting for the older commits: the row above says they load, or why they did not.
    if (data.match && !data.match.ref && !data.match.pending) info(data.match.error);
    else if (!this.flat.length && !(showsOlder && !data.older)) info("No version matches.");
    this.list.replaceChildren(...nodes);
    if (this.active >= 0) input.setAttribute("aria-activedescendant", `${this.id}-o${this.active}`);
    else input.removeAttribute("aria-activedescendant");
  }
}
