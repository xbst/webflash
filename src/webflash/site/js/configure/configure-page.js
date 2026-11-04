// The wizard's Configure step: every option of `make menuconfig` for what
// page 1 picked, with the bar above it (search, Undo, Redo, Load .config,
// Reset), the status line, the notice box, the start box, and the Setup
// select for a board TOML with several setups.
//
// One project shows its own tree. A firmware with Katapult beside it shows
// the engine's pair tree (bridge.pair_tree) in three groups: the options both
// use, set once, then each project's own. Klipper's bootloader offset is a
// locked line there (it follows Katapult's application offset), and what
// Katapult could not take from the firmware ("Katapult has no USART5") shows
// under the shared option it concerns. The pair tree is asked for again after
// every change of either tree.

import * as runtime from "../runtime.js";
import { esc, openModal } from "../dialogs.js";
import { KconfigTree, slotOfId } from "./kconfig-tree.js";
import { carryText, withLowLevel } from "./configurator.js";
import { blobUrl, formatBytes, headSize, isChecked, projectTitle, uncheckedText } from "./sources.js";
import { isCached } from "../workers/blob-cache.js";

/** "Klipper", "Klipper and Katapult": the projects Configure sets up. */
export function configureNames(index, project, katapult) {
  const fw = projectTitle(index, project);
  return katapult ? `${fw} and Katapult` : fw;
}

// The ids under a node, depth first (choices' members included).
function descendants(nodes, id) {
  const out = [];
  const walk = (i) => {
    for (const c of (nodes[i] && nodes[i].children) || []) {
      out.push(c);
      walk(c);
    }
  };
  walk(id);
  return out;
}

/**
 * Where a paired tree's notes show: a Map of node id -> [{text, kind}]. The
 * offset link's error goes under Klipper's locked offset (or the firmware's
 * group when the chip has none). Each note of what Katapult refused goes
 * under the shared option it names (a choice by its selected member's
 * prompt, a symbol by NAME=), else under the option just changed, else under
 * the shared group's heading.
 */
export function pairNotes(tree, { notes = [], offset = null } = {}, changed = null) {
  const out = new Map();
  const nodes = (tree && tree.nodes) || {};
  const add = (id, text, kind) => {
    if (!out.has(id)) out.set(id, []);
    out.get(id).push({ text, kind });
  };
  if (offset && offset.error) add(offset.choice && nodes[offset.choice] ? offset.choice : "group:fw", offset.error, "error");
  const shared = descendants(nodes, "group:shared");
  for (const note of notes || []) {
    let target = null;
    for (const id of shared) {
      const n = nodes[id];
      if (!n || !n.visible) continue;
      if (n.kind === "choice") {
        const m = (n.members || []).find((x) => x.name === n.value);
        if (m && m.prompt && note.includes(m.prompt)) target = id;
      } else if (n.kind === "symbol" && n.name && note.includes(`${n.name}=`)) {
        target = id;
      }
      if (target) break;
    }
    if (!target && changed && shared.includes(changed)) target = changed;
    add(target || "group:shared", note, "warn");
  }
  return out;
}

/**
 * What Reset loads into a slot: every option at its default except the
 * microcontroller the tree has picked (the defaults are Atmega AVR in
 * Klipper, which WebFlash cannot build, and LPC176x in Katapult) and, for a
 * firmware, the low-level options, which stay shown.
 */
export function resetText(tree, project) {
  const keep = carryText("", tree);
  return project === "katapult" ? keep : withLowLevel(keep);
}

/** The setups' labels for the Setup select: the title, else the id. */
export function setupLabels(setups) {
  return (setups || []).map((s, i) => s.title || s.id || `Setup ${i + 1}`);
}

export class ConfigurePage {
  /**
   * els: {title, lead, search, count, undo, redo, load, reset, status,
   * notice, start, tree, setupRow, setup}. actions: {start(reason) (load
   * what page 1 picked, resolves to whether it loaded), compiler()
   * (resolves to {size} or null: the compiler to download), prefetch(),
   * showError(title, message)}.
   */
  constructor(session, configurator, wizard, els, actions) {
    this.session = session;
    this.configurator = configurator;
    this.wizard = wizard;
    this.els = els;
    this.actions = actions;
    this.paired = false;        // whether the tree shows the pair tree now
    this.changed = null;        // the node id last changed, where a note lands when it names nothing
    this._gen = 0;
    this._pending = null;
    this._setting = 0;          // changes made here still in flight

    const s = session;
    this.tree = new KconfigTree(els.tree, {
      mode: "configure",
      onSet: (name, value, node) => this._set(name, value, node),
      isExposed: (node) => {
        if (slotOfId(node.id) === "katapult") return false;
        if (node.kind === "choice") return (node.members || []).some((m) => s.exposed.includes(m.name));
        return s.exposed.includes(node.name);
      },
    });

    els.search.addEventListener("input", () => this.runSearch());
    els.search.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && els.search.value) {
        els.search.value = "";
        this.runSearch();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        this.tree.focus();
      }
    });
    els.reset.addEventListener("click", () => this.reset().catch((e) => actions.showError("Could not reset", e.message)));
    els.load.addEventListener("click", () => this.openLoadConfig());
    els.undo.addEventListener("click", () => s.undo());
    els.redo.addEventListener("click", () => s.redo());
    els.setup.addEventListener("change", () => this.pickSetup(Number(els.setup.value)));

    s.on("change", ({ what }) => {
      // A change made here refreshes once it is done (_set).
      if (!this._setting && ["tree", "ref", "katapult", "katapult-tree", "katapult-ref", "katapult-link", "setup", "open"].includes(what)) {
        this.refresh();
      }
      if (what === "options") this.tree.render();
      if (["sources", "katapult-sources", "katapult-ref", "katapult", "lock", "ref", "index", "project", "version",
        "firmware", "open", "prebuilt", "setup", "setups", "undo"].includes(what)) this.renderState();
      else this.renderUndo();
    });
    configurator.onNotice((n) => this.renderNotice(n));
    this.renderState();
  }

  // ── The tree ───────────────────────────────────────────────────────

  /**
   * Show the session's tree again, or the pair tree while paired, once the
   * changes in flight have landed. Resolves when it is shown.
   */
  refresh() {
    if (!this._pending) {
      this._pending = new Promise((r) => setTimeout(r, 0)).then(() => {
        this._pending = null;
        return this._render();
      });
    }
    return this._pending;
  }

  async _render() {
    const s = this.session;
    const gen = ++this._gen;
    const k = s.katapult;
    if (this.configurator.paired && k && k.tree && k.ref && s.tree && s.ref) {
      let t = null;
      try {
        t = await this.configurator.pairTree();
      } catch (e) {
        console.warn("The paired tree could not be read:", e);
      }
      if (gen !== this._gen) return;
      if (t) {
        this.paired = true;
        this.tree.setTree(t, `pair/${s.project}/${s.ref.sha}/${k.ref.sha}`, { fw: s.project, katapult: "katapult" });
        this.tree.setNotes(pairNotes(t, { notes: k.notes, offset: t.offset || k.link }, this.changed));
        this._afterRender();
        return;
      }
    }
    this.paired = false;
    const has = Boolean(s.tree && s.ref);
    this.tree.setTree(has ? s.tree : null, has ? `${s.project}/${s.ref.sha}` : "", s.project || "");
    this.tree.setNotes(null);
    this._afterRender();
  }

  _afterRender() {
    if (this.els.search.value) this.runSearch();
    this.renderHead();
  }

  async _set(name, value, node) {
    const slot = slotOfId(node && node.id) || "fw";
    this.changed = node ? node.id : null;
    this._setting++;
    try {
      await this.configurator.set(name, value, { slot });
    } finally {
      this._setting--;
      // The tree re-renders once this resolves: let it show the answer.
      await this.refresh();
    }
  }

  runSearch() {
    const { search, count } = this.els;
    const { matches, hidden } = this.tree.setFilter(search.value);
    count.textContent = search.value.trim()
      ? `${matches} match${matches === 1 ? "" : "es"}${hidden ? `, ${hidden} hidden` : ""}` : "";
  }

  // ── Bar, status, notice ────────────────────────────────────────────

  renderUndo() {
    const s = this.session;
    const locked = Boolean(s.locked);
    this.els.undo.disabled = locked || !s.canUndo;
    this.els.redo.disabled = locked || !s.canRedo;
  }

  renderState() {
    const s = this.session;
    const ready = this.configurator.ready;
    const locked = Boolean(s.locked);
    this.els.search.disabled = !ready;
    this.els.reset.disabled = !ready || locked;
    this.els.load.disabled = !ready || locked;
    this.tree.setLocked(s.locked);
    this.renderUndo();
    this.renderSetup();
    this.renderStatus();
    this.renderStart();
    this.renderHead();
  }

  // The title, the lead, the footer's hint, and whether Next (Build) can go on.
  renderHead() {
    const s = this.session;
    const k = s.katapult;
    const names = s.project ? configureNames(s.index, s.project, Boolean(k)) : "";
    this.els.title.textContent = names ? `Set up ${names}` : "Configure";
    this.els.lead.textContent = this.paired ? "Match your board; options both use are set once." : "Match your board.";
    if (!this.wizard) return;
    this.wizard.setHint("configure", s.firmware ? `Next builds ${names} here, in your browser.` : "");
    const st = s.sources.state;
    const kst = k ? k.sources.state : "ready";
    const ok = (state) => state === "loading" || state === "ready";
    this.wizard.setNext("configure", {
      enabled: Boolean(s.firmware) && ok(st) && (ok(kst) || kst === "idle"),
      reason: st === "error" || kst === "error" ? "The configuration did not load." : "Load the configuration first.",
    });
  }

  // The Setup select: shown when the board TOML has several setups.
  renderSetup() {
    const s = this.session;
    const setups = s.firmware ? s.tables().setups : [];
    const { setupRow, setup } = this.els;
    setupRow.hidden = setups.length < 2;
    if (setupRow.hidden) return;
    const labels = setupLabels(setups);
    const key = labels.join("\u0001");
    if (setup.dataset.key !== key) {
      setup.dataset.key = key;
      setup.replaceChildren(...labels.map((l, i) => new Option(l, String(i))));
    }
    setup.value = String(s.setupIndex);
    setup.disabled = Boolean(s.locked);
    const desc = setups[s.setupIndex] && setups[s.setupIndex].description;
    setup.title = desc || "";
  }

  /** Edit another setup: its defconfigs load into the engine. */
  async pickSetup(i) {
    const s = this.session;
    s.setSetupIndex(i);
    if (this.configurator.loaded) await this.configurator.reapply();
  }

  // The line above the tree: what is loaded, and whether its snapshot passed the check.
  renderStatus() {
    const el = this.els.status;
    const s = this.session;
    const st = s.sources;
    if (!s.ref || st.state !== "ready" || !s.firmware) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    const part = (title, ref) => `<span class="kc-status-ref"${ref.date ? ` title="${esc(ref.date)}"` : ""}>` +
      `${esc(title)} <strong>${esc(ref.id)}</strong></span>` +
      (ref.describe && ref.describe !== ref.id ? `<span class="kc-status-detail">${esc(ref.describe)}</span>` : "") +
      (isChecked(ref) ? "" : `<span class="ref-badge" title="This snapshot ${esc(uncheckedText(ref))}; it may still build.">unchecked</span>`);
    let html = part(projectTitle(s.index, s.project), s.ref);
    const k = s.katapult;
    if (k) {
      html += `<span class="kc-status-sep" aria-hidden="true">·</span>`;
      if (k.sources.state === "ready" && k.ref) html += part("Katapult", k.ref);
      else if (k.sources.state === "error") {
        html += `<span class="kc-error-text">Katapult: ${esc(k.sources.detail)}</span>` +
          `<button type="button" class="mini" data-act="katapult-retry">Try again</button>`;
      } else html += `<span class="kc-status-ref">Katapult</span><span class="kc-status-detail">loading…</span>`;
    }
    if (s.locked) html += `<span class="kc-locked">${esc(s.locked)}</span>`;
    el.innerHTML = html;
    const retry = el.querySelector("[data-act=katapult-retry]");
    if (retry) retry.addEventListener("click", () => this.configurator.loadKatapult({ reason: "start" }));
  }

  renderNotice(notice) {
    const el = this.els.notice;
    el.hidden = !notice;
    if (!notice) return;
    el.className = `kc-notice ${notice.kind || "info"}`;
    el.innerHTML = `<div class="kc-notice-head"><strong>${esc(notice.title)}</strong>` +
      `<button type="button" class="mini" data-act="dismiss" aria-label="Dismiss">Dismiss</button></div>` +
      notice.lines.map((l) => `<p>${esc(l)}</p>`).join("");
    el.querySelector("[data-act=dismiss]").addEventListener("click", () => this.configurator.dismissNotice());
  }

  // Above the tree until it loads: the progress, a failure with Try again, or,
  // reached without page 1's Next, what loading downloads and its button.
  async renderStart() {
    const el = this.els.start;
    const s = this.session;
    const st = s.sources;
    if (!s.firmware) {
      el.hidden = false;
      el.innerHTML = `<p>This board TOML flashes its own file: there is nothing to configure.</p>`;
      return;
    }
    if (st.state === "ready") {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    const index = s.index;
    const title = projectTitle(index, s.project);
    if (st.state === "loading") {
      const pct = st.total ? Math.min(100, Math.round((100 * (st.done || 0)) / st.total)) : null;
      const what = st.phase === "extract" ? "Unpacking the sources…" : st.phase === "kconfig" ? "Reading the Kconfig files…"
        : !runtime.isReady() ? (pct === 100 ? "Starting Python…" : "Starting Python and downloading the sources…")
        : `Downloading the sources${pct !== null ? ` (${pct}%)` : ""}…`;
      el.innerHTML = `<p class="kc-loading"><span class="spinner" aria-hidden="true"></span>${esc(st.detail)}: ${esc(what)}</p>` +
        (st.total ? `<progress max="${st.total}" value="${st.done || 0}"></progress>` : "");
      return;
    }
    if (st.state === "error") {
      el.innerHTML = `<p class="kc-error-text">${esc(st.detail)}</p>` +
        `<button class="primary" data-act="retry">Try again</button>`;
      el.querySelector("[data-act=retry]").addEventListener("click", () => this.actions.start("start"));
      return;
    }
    if (!index) {
      el.innerHTML = `<p>Loading the list of versions…</p>`;
      return;
    }
    const { ref, error, note } = this.configurator.resolve();
    if (!ref) {
      el.innerHTML = `<p class="kc-error-text">${esc(error)}</p>`;
      return;
    }
    const mine = (el.dataset.ref = `${s.project}/${ref.id}`);
    let size = this.configurator.coreSize(ref);
    const url = blobUrl(ref.core);
    const cached = await isCached(url);
    if (size === null) size = await headSize(url);
    // The compiler, when this browser does not have it: it can download while
    // the user configures, so the first build does not wait for it.
    const compiler = await this.actions.compiler();
    if (el.dataset.ref !== mine || s.sources.state !== "idle") return;
    const downloads = [];
    if (!runtime.isReady()) downloads.push("Python (about 7 MB, once)");
    downloads.push(`the sources (${size ? formatBytes(size) : "size unknown"}${cached ? ", in this browser already" : ""})`);
    el.innerHTML =
      `<h3>${esc(title)} ${esc(ref.id)}</h3>` +
      (note ? `<p class="kc-warn-text">${esc(note)}</p>` : "") +
      `<p>Loading it downloads ${downloads.map(esc).join(" and ")}.</p>` +
      (compiler ? `<p><label class="check kc-start-compiler"><input type="checkbox" data-act="compiler" checked> ` +
        `Download the compiler while I configure (${esc(formatBytes(compiler.size))})</label></p>` : "") +
      `<button class="primary" data-act="load">Load the configuration</button>`;
    el.querySelector("[data-act=load]").addEventListener("click", async () => {
      const box = el.querySelector("[data-act=compiler]");
      const compilerToo = Boolean(box && box.checked);
      const ok = await this.actions.start("start");
      if (ok && compilerToo) this.actions.prefetch();
    });
  }

  // ── Reset and Load .config ─────────────────────────────────────────

  /**
   * Every option back to its default, keeping the microcontroller and the
   * low-level options (resetText); both projects of a pair, as one undo step.
   */
  async reset() {
    const s = this.session;
    const c = this.configurator;
    const title = "Back to the defaults (chip and low-level options kept)";
    s.checkpoint();
    const k = s.katapult;
    if (c.paired && k && k.tree) await c.apply(resetText(k.tree, "katapult"), { title, slot: "katapult", checkpoint: false });
    await c.apply(resetText(s.tree, s.project), { title, checkpoint: false });
  }

  openLoadConfig() {
    const s = this.session;
    const { body, close } = openModal("Load a .config", { wide: false });
    const paired = this.configurator.paired && s.katapult;
    const ref = s.ref;
    const fwName = `${projectTitle(s.index, s.project)} ${ref ? ref.id : ""}`.trim();
    body.innerHTML =
      `<p>Paste or open a <code>.config</code> or defconfig: ` +
      (paired ? "it replaces the configuration of the project picked below, " : `it replaces ${esc(fwName)}'s configuration, `) +
      `and what it leaves out takes its default.</p>` +
      (paired ? `<p><label>Load into <select data-act="slot"><option value="fw">${esc(fwName)}</option>` +
        `<option value="katapult">Katapult ${esc(s.katapult.ref ? s.katapult.ref.id : "")}</option></select></label></p>` : "") +
      `<textarea class="code load-config" spellcheck="false" rows="12" data-act="text" ` +
      `placeholder="CONFIG_MACH_STM32=y&#10;CONFIG_MACH_STM32G0B1=y" aria-label="The .config to load"></textarea>` +
      `<p class="kc-error-text" data-act="error" hidden></p>` +
      `<div class="modal-actions"><label class="file-btn">Open a file…<input type="file" data-act="file"></label>` +
      `<span class="gen-spacer"></span><button data-act="cancel">Cancel</button>` +
      `<button class="primary" data-act="apply">Apply</button></div>`;
    const q = (act) => body.querySelector(`[data-act=${act}]`);
    const textarea = q("text");
    const error = q("error");
    textarea.focus();
    q("file").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (file) textarea.value = await file.text();
      e.target.value = "";
    });
    q("cancel").addEventListener("click", close);
    const apply = q("apply");
    apply.addEventListener("click", async () => {
      const text = textarea.value;
      const bad = checkConfigText(text);
      if (bad.length) {
        error.hidden = false;
        error.textContent = `These are not .config lines (CONFIG_NAME=value, or # CONFIG_NAME is not set):\n${bad.slice(0, 5).join("\n")}`;
        return;
      }
      apply.disabled = true;
      apply.textContent = "Applying…";
      try {
        await this.configurator.apply(text, { title: "Loaded the .config", slot: paired ? q("slot").value : "fw" });
        close();
      } catch (e) {
        error.hidden = false;
        error.textContent = e.message;
        apply.disabled = false;
        apply.textContent = "Apply";
      }
    });
  }
}

/** The lines of a pasted .config that are not .config syntax: ["line N: text"]. */
export function checkConfigText(text) {
  const bad = [];
  String(text).split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || /^#\s*CONFIG_[A-Za-z0-9_]+ is not set$/.test(line) || (line.startsWith("#"))) return;
    if (!/^CONFIG_[A-Za-z0-9_]+=.*$/.test(line)) bad.push(`line ${i + 1}: ${line.slice(0, 60)}`);
  });
  return bad;
}
