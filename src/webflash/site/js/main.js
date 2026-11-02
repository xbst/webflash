// The WebFlash site: wires the toolbar, the panels and the session together.
//
// Pick a project and a version (or open a board TOML, or arrive with one in
// the URL), configure the firmware in the Configure tab with every option of
// `make menuconfig`, decide in Embed options what the reader of the generated
// page may change, then Save TOML or Generate the page. The session's tables
// are the board TOML (the TOML tab shows what Save writes); the configure
// session behind them runs in the engine worker. Build and Flash are filled
// in by later chunks of the build-out; their controls are here, disabled,
// with a title naming the chunk.

import { Session, PROJECTS } from "./state.js";
import * as runtime from "./runtime.js";
import { tomlFromHash, parseToml } from "./toml-io.js";
import { openGenerate, openAbout, maybeShowAboutOnFirstVisit, showError, openModal, esc } from "./dialogs.js";
import { mountFlashPanel } from "./flash/flash-panel.js";
import { Configurator } from "./configure/configurator.js";
import { KconfigTree } from "./configure/kconfig-tree.js";
import { VersionPicker } from "./configure/version-picker.js";
import { ConfigTab, copyText } from "./configure/config-tab.js";
import { OptionsPanel } from "./configure/options-panel.js";
import { blobUrl, formatBytes, headSize, isChecked, projectTitle, uncheckedText } from "./configure/sources.js";
import { isCached } from "./workers/blob-cache.js";

const session = new Session();
const configurator = new Configurator(session);

const $ = (id) => document.getElementById(id);

// ── Color scheme ─────────────────────────────────────────────────────

// index.html picked the scheme before first paint; follow the system from
// here on unless ?theme= forced one.
function setupColorScheme() {
  let forced = null;
  try { forced = new URLSearchParams(location.search).get("theme"); } catch (e) { /* none */ }
  if (forced === "dark" || forced === "light" || !window.matchMedia) return;
  const query = matchMedia("(prefers-color-scheme: light)");
  query.addEventListener("change", () => {
    document.documentElement.setAttribute("data-theme", query.matches ? "light" : "dark");
  });
}

// ── Runtime status ───────────────────────────────────────────────────

function pillState(pill, cls, text, title) {
  pill.className = `pill${cls ? ` ${cls}` : ""}`;
  pill.textContent = text;
  pill.title = title;
}

function setupRuntimeStatus() {
  const pill = $("status-python");
  const idleTitle = "The Python runtime (Pyodide, about 7 MB) loads when it is first needed: " +
                    "configuring a version, opening a TOML, Generate, or the theme list.";
  pillState(pill, "", "Python", idleTitle);
  runtime.onProgress((phase, detail) => {
    if (phase === "runtime") pillState(pill, "busy", "Python: loading", "Downloading the Python runtime (Pyodide) from the CDN…");
    else if (phase === "package") pillState(pill, "busy", "Python: starting", "Loading the webflash package into Python…");
    else if (phase === "ready") {
      const a = runtime.about();
      pillState(pill, "ready", "Python", a ? `Python ${a.python}, Pyodide ${a.pyodide}, webflash ${a.webflash}` : "Ready");
      // Whatever booted it, the theme list can come now.
      refreshThemes();
    } else if (phase === "error") {
      pillState(pill, "error", "Python: failed", `${detail}\n\nClick to try again.`);
    }
  });
  pill.addEventListener("click", () => {
    if (runtime.failure()) runtime.retry().catch(() => {});
  });

  const sources = $("status-sources");
  const render = () => {
    const st = session.sources;
    if (st.state === "loading") {
      const pct = st.total ? Math.min(100, Math.round((100 * (st.done || 0)) / st.total)) : null;
      const what = st.phase === "extract" ? "unpacking" : st.phase === "kconfig" ? "reading Kconfig"
        : pct !== null ? `${pct}%` : "loading";
      pillState(sources, "busy", `Sources: ${what}`, `${st.detail}: ${st.phase === "kconfig" ? "loading the Kconfig files"
        : st.phase === "extract" ? "unpacking the sources" : `downloading${st.total ? ` ${formatBytes(st.total)}` : ""}`}…`);
    } else if (st.state === "ready") {
      pillState(sources, "ready", "Sources", `${st.detail}${st.ref ? ` (${st.ref.describe})` : ""}: ` +
        `${formatBytes(st.size)}${st.cached ? ", from the browser's cache" : ", downloaded"}`);
    } else if (st.state === "error") {
      pillState(sources, "error", "Sources: failed", st.detail);
    } else {
      pillState(sources, "", "Sources", "The source snapshots: a version's sources load when you configure it.");
    }
  };
  session.on("change", ({ what }) => { if (what === "sources") render(); });
  render();
}

// ── Tabs ─────────────────────────────────────────────────────────────

function setupPanelTabs() {
  const tabs = [...document.querySelectorAll(".panel-tab")];
  const storageKey = "webflash.tab";
  const activate = (tab, remember = true) => {
    for (const candidate of tabs) {
      const active = candidate === tab;
      candidate.setAttribute("aria-selected", String(active));
      candidate.tabIndex = active ? 0 : -1;
      $(candidate.getAttribute("aria-controls")).hidden = !active;
    }
    if (remember) {
      try { localStorage.setItem(storageKey, tab.id); } catch (_) { /* storage can be blocked */ }
    }
  };
  for (const tab of tabs) {
    tab.addEventListener("click", () => activate(tab));
    tab.addEventListener("keydown", (e) => {
      const index = tabs.indexOf(tab);
      let next;
      if (e.key === "ArrowRight") next = tabs[(index + 1) % tabs.length];
      else if (e.key === "ArrowLeft") next = tabs[(index + tabs.length - 1) % tabs.length];
      else if (e.key === "Home") next = tabs[0];
      else if (e.key === "End") next = tabs[tabs.length - 1];
      else return;
      e.preventDefault();
      activate(next);
      next.focus();
    });
  }
  let initial = tabs[0];
  try { initial = tabs.find((t) => t.id === localStorage.getItem(storageKey)) || initial; } catch (_) { /* default */ }
  activate(initial, false);
  return { show: (id) => activate($(id)) };
}

// ── The TOML tab ─────────────────────────────────────────────────────

function setTomlStatus(cls, text) {
  const el = $("toml-status");
  el.className = `toml-status${cls ? ` ${cls}` : ""}`;
  el.textContent = text;
}

// What Save TOML writes, read-only: the session's tables are the TOML.
function setupTomlView() {
  const textarea = $("toml-text");
  const show = () => {
    if (textarea.value !== session.tomlText) textarea.value = session.tomlText;
    $("toml-name").textContent = session.tomlName;
    const names = [...session.files.keys()];
    $("toml-files").textContent = names.length ? `with ${names.join(", ")}` : "";
  };
  session.on("change", ({ what }) => { if (["toml", "files", "open", "undo"].includes(what)) show(); });
  $("toml-copy").addEventListener("click", (e) => copyText(session.tomlText, e.currentTarget));
  show();
}

// ── Configure ────────────────────────────────────────────────────────

let tabs = null;

function setupConfigure() {
  const tree = new KconfigTree($("kconfig-tree"), {
    mode: "configure",
    onSet: (name, value) => configurator.set(name, value),
    isExposed: (node) => {
      if (node.kind === "choice") return (node.members || []).some((m) => session.exposed.includes(m.name));
      return session.exposed.includes(node.name);
    },
  });
  const search = $("kconfig-search");
  const count = $("kconfig-count");
  const runSearch = () => {
    const { matches, hidden } = tree.setFilter(search.value);
    count.textContent = search.value.trim()
      ? `${matches} match${matches === 1 ? "" : "es"}${hidden ? `, ${hidden} hidden` : ""}` : "";
  };
  search.addEventListener("input", runSearch);
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && search.value) {
      search.value = "";
      runSearch();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      tree.focus();
    }
  });
  $("kconfig-reset").addEventListener("click", () => {
    configurator.apply("", { title: "Every option is back to its default" }).catch((e) => showError("Could not reset", e.message));
  });
  $("kconfig-load").addEventListener("click", openLoadConfig);

  const renderTree = () => {
    const has = Boolean(session.tree && session.ref);
    tree.setTree(has ? session.tree : null, has ? `${session.project}/${session.ref.sha}` : "", session.project || "");
    if (search.value) runSearch();
  };
  const renderState = () => {
    const ready = configurator.ready;
    const locked = Boolean(session.locked);
    search.disabled = !ready;
    $("kconfig-reset").disabled = !ready || locked;
    $("kconfig-load").disabled = !ready || locked;
    tree.setLocked(session.locked);
    renderStatus();
    renderStart();
  };
  session.on("change", ({ what }) => {
    if (what === "tree" || what === "ref") renderTree();
    if (what === "options") tree.render();
    if (["sources", "lock", "ref", "index", "project", "version", "firmware", "open", "prebuilt"].includes(what)) renderState();
  });
  configurator.onNotice(renderNotice);
  renderState();
  return tree;
}

// The line above the tree: what is loaded, and whether its snapshot passed the check.
function renderStatus() {
  const el = $("kconfig-status");
  const st = session.sources;
  const ref = session.ref;
  if (!ref || st.state !== "ready" || !session.firmware) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const title = projectTitle(session.index, session.project);
  el.innerHTML = `<span class="kc-status-ref">${esc(title)} <strong>${esc(ref.id)}</strong></span>` +
    `<span class="kc-status-detail">${esc(ref.describe || "")}${ref.date ? ` · ${esc(ref.date)}` : ""}</span>` +
    (isChecked(ref) ? "" : `<span class="ref-badge" title="This snapshot ${esc(uncheckedText(ref))}: WebFlash could not confirm that it builds.">unchecked</span>`) +
    (session.locked ? `<span class="kc-locked">${esc(session.locked)}</span>` : "");
}

function renderNotice(notice) {
  const el = $("kconfig-notice");
  el.hidden = !notice;
  if (!notice) return;
  el.className = `kc-notice ${notice.kind || "info"}`;
  el.innerHTML = `<div class="kc-notice-head"><strong>${esc(notice.title)}</strong>` +
    `<button type="button" class="mini" id="kconfig-notice-close" aria-label="Dismiss">Dismiss</button></div>` +
    notice.lines.map((l) => `<p>${esc(l)}</p>`).join("");
  $("kconfig-notice-close").addEventListener("click", () => configurator.dismissNotice());
}

// Before the first load: what Configure will download, and the button for it.
async function renderStart() {
  const el = $("kconfig-start");
  const st = session.sources;
  if (!session.firmware) {
    el.hidden = false;
    el.innerHTML = `<p>This board TOML flashes a prebuilt firmware file: there is nothing to configure.</p>`;
    return;
  }
  if (st.state === "ready") {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const index = session.index;
  const title = projectTitle(index, session.project);
  if (st.state === "loading") {
    const pct = st.total ? Math.min(100, Math.round((100 * (st.done || 0)) / st.total)) : null;
    const what = st.phase === "extract" ? "Unpacking the sources…" : st.phase === "kconfig" ? "Reading the Kconfig files…"
      : !runtime.isReady() ? "Starting the Python runtime and downloading the sources…"
      : `Downloading the sources${pct !== null ? ` (${pct}%)` : ""}…`;
    el.innerHTML = `<p class="kc-loading"><span class="spinner" aria-hidden="true"></span>${esc(st.detail)}: ${esc(what)}</p>` +
      (st.total ? `<progress max="${st.total}" value="${st.done || 0}"></progress>` : "");
    return;
  }
  if (st.state === "error") {
    el.innerHTML = `<p class="kc-error-text">${esc(st.detail)}</p>` +
      `<button class="primary" id="kconfig-retry">Try again</button>`;
    $("kconfig-retry").addEventListener("click", () => startConfigure("start"));
    return;
  }
  if (!index) {
    el.innerHTML = `<p>Loading the list of versions…</p>`;
    return;
  }
  const { ref, error, note } = configurator.resolve();
  if (!ref) {
    el.innerHTML = `<p class="kc-error-text">${esc(error)}</p>`;
    return;
  }
  const mine = (el.dataset.ref = `${session.project}/${ref.id}`);
  let size = configurator.coreSize(ref);
  const url = blobUrl(ref.core);
  const cached = await isCached(url);
  if (size === null) size = await headSize(url);
  if (el.dataset.ref !== mine || session.sources.state !== "idle") return;
  const downloads = [];
  if (!runtime.isReady()) downloads.push("the Python runtime (about 7 MB, from cdn.jsdelivr.net, once per browser)");
  downloads.push(`${title} ${ref.id}'s sources (${size ? formatBytes(size) : "size unknown"}${cached ? ", already in this browser's cache" : ""})`);
  el.innerHTML =
    `<h3>Configure ${esc(title)} ${esc(ref.id)}</h3>` +
    `<p>Every option of <code>make menuconfig</code>, from the Kconfig files of ${esc(ref.describe || ref.id)}` +
    `${ref.date ? ` (${esc(ref.date)})` : ""}.</p>` +
    (note ? `<p class="kc-warn-text">${esc(note)}</p>` : "") +
    `<p>This downloads ${downloads.map(esc).join(" and ")}. Nothing you configure leaves the browser.</p>` +
    `<button class="primary" id="kconfig-start-btn">Load the configuration</button>`;
  $("kconfig-start-btn").addEventListener("click", () => startConfigure("start"));
}

// Whether the TOML is as it was last saved or opened, so a load that only
// normalizes the defconfig does not count as an unsaved change.
async function startConfigure(reason) {
  const clean = !hasUnsavedChanges();
  const ok = await configurator.load({ reason });
  if (ok && clean && (reason === "start" || reason === "open")) markSaved(session.tomlText);
  return ok;
}

function configureStarted() {
  return session.sources.state !== "idle" || Boolean(configurator.loaded);
}

function checkConfigText(text) {
  const bad = [];
  String(text).split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || /^#\s*CONFIG_[A-Za-z0-9_]+ is not set$/.test(line) || (line.startsWith("#"))) return;
    if (!/^CONFIG_[A-Za-z0-9_]+=.*$/.test(line)) bad.push(`line ${i + 1}: ${line.slice(0, 60)}`);
  });
  return bad;
}

function openLoadConfig() {
  const { body, close } = openModal("Load a .config", { wide: false });
  const ref = session.ref;
  body.innerHTML =
    `<p>Paste a <code>.config</code> or a defconfig (what <code>make savedefconfig</code> writes), or open the file. ` +
    `It replaces the configuration of ${esc(projectTitle(session.index, session.project))} ${esc(ref ? ref.id : "")} ` +
    `the way <code>make olddefconfig</code> reads it: whatever it leaves out takes its default.</p>` +
    `<textarea id="load-config-text" class="code load-config" spellcheck="false" rows="12" ` +
    `placeholder="CONFIG_MACH_STM32=y&#10;CONFIG_MACH_STM32G0B1=y" aria-label="The .config to load"></textarea>` +
    `<p class="kc-error-text" id="load-config-error" hidden></p>` +
    `<div class="modal-actions"><label class="file-btn">Open a file…<input type="file" id="load-config-file"></label>` +
    `<span class="gen-spacer"></span><button id="load-config-cancel">Cancel</button>` +
    `<button class="primary" id="load-config-apply">Apply</button></div>`;
  const textarea = body.querySelector("#load-config-text");
  const error = body.querySelector("#load-config-error");
  textarea.focus();
  body.querySelector("#load-config-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (file) textarea.value = await file.text();
    e.target.value = "";
  });
  body.querySelector("#load-config-cancel").addEventListener("click", close);
  const apply = body.querySelector("#load-config-apply");
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
      await configurator.apply(text, { title: "Loaded the .config" });
      close();
    } catch (e) {
      error.hidden = false;
      error.textContent = e.message;
      apply.disabled = false;
      apply.textContent = "Apply";
    }
  });
}

// What the next build downloads beyond the sources (chunk 06 fetches it).
function setupPlan() {
  const el = $("build-plan");
  const render = () => {
    const p = session.plan;
    if (!p || !session.ref || session.sources.state !== "ready") {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    if (p.error) {
      el.textContent = `Could not work out what the build needs: ${p.error}`;
      return;
    }
    if (!p.libs.length) {
      el.textContent = "The build needs no library bundles beyond the sources already loaded.";
      return;
    }
    const known = p.libs.filter((l) => Number.isFinite(l.size));
    const total = known.reduce((n, l) => n + l.size, 0);
    el.textContent = `The build downloads ${p.libs.length === 1 ? "one library bundle" : `${p.libs.length} library bundles`}: ` +
      p.libs.map((l) => `${l.dir}${Number.isFinite(l.size) ? ` (${formatBytes(l.size)})` : ""}`).join(", ") +
      (known.length > 1 ? `, ${formatBytes(total)} in all.` : ".");
  };
  session.on("change", ({ what }) => { if (["plan", "sources", "ref"].includes(what)) render(); });
  render();
}

// ── Toolbar ──────────────────────────────────────────────────────────

let themeList = [];

function fillThemeSelect() {
  const sel = $("theme-select");
  const cur = session.theme || "default";
  const list = themeList.slice();
  if (!list.some((t) => t.name === cur)) list.push({ name: cur, display: cur });
  sel.innerHTML = list.map((t) =>
    `<option value="${esc(t.name)}"${t.name === cur ? " selected" : ""}>${esc(t.display)}</option>`
  ).join("");
}

async function refreshThemes() {
  try {
    themeList = await runtime.themeCatalog();
  } catch (e) {
    return;   // the status pill says why
  }
  fillThemeSelect();
  if (optionsPanel) optionsPanel.fillThemes();
}

let picker = null;
let optionsPanel = null;

function setupToolbar() {
  picker = new VersionPicker({
    projectSelect: $("project-select"), versionSelect: $("version-select"), badge: $("version-badge"),
  }, session, {
    onProject: (project) => {
      // An exact ref belongs to one project; the aliases work for any.
      const version = ["latest", "release"].includes(session.version) ? session.version : "latest";
      session.setProject(project, { version });
      if (configureStarted()) configurator.load({ reason: "switch" });
    },
    onVersion: (version) => {
      session.setVersion(version);
      if (configureStarted()) configurator.load({ reason: "switch" });
    },
  });

  const theme = $("theme-select");
  fillThemeSelect();
  // The list comes from the bundled themes, in Python: load it when the
  // select is first reached for, not with the page.
  const wantThemes = () => { if (!themeList.length) refreshThemes(); };
  theme.addEventListener("pointerdown", wantThemes);
  theme.addEventListener("focus", wantThemes);
  theme.addEventListener("change", () => session.setTheme(theme.value));
  session.on("change", ({ what }) => { if (what === "board" || what === "open") fillThemeSelect(); });

  $("generate-btn").addEventListener("click", () => openGenerate(session));
  $("about-btn").addEventListener("click", () => {
    const st = session.sources;
    openAbout({
      sources: st.state === "ready" && st.ref
        ? `${st.detail} (${st.ref.describe}), ${formatBytes(st.size)}${st.cached ? ", from the browser's cache" : ""}` : "",
    });
  });
}

// ── Files ────────────────────────────────────────────────────────────

// The TOML as it was last saved or opened. Comparing the text against it is
// what "unsaved changes" means here.
let savedText = null;

function markSaved(text) { savedText = text; }

function hasUnsavedChanges() {
  return savedText !== null && session.tomlText !== savedText;
}

function readFile(file, as) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(as === "text" ? reader.result : new Uint8Array(reader.result));
    reader.onerror = () => reject(reader.error || new Error(`could not read ${file.name}`));
    if (as === "text") reader.readAsText(file);
    else reader.readAsArrayBuffer(file);
  });
}

/**
 * Open a board TOML: the loader (bridge.check_board) checks it, its tables
 * replace the session's, and its project and version load with its
 * defconfig, so the Configure tab shows it and the exposed options are ticked.
 */
async function openToml(text, { name = "board.toml", files = new Map() } = {}) {
  try {
    parseToml(text);
  } catch (e) {
    showError("The board TOML does not parse", `${name}: ${e.message}`);
    return false;
  }
  let out;
  try {
    out = await runtime.checkBoard(text);
  } catch (e) {
    showError("Could not check the board TOML", e.message);
    return false;
  }
  if (out.errors.length) {
    showError("The board TOML has errors", out.errors.join("\n"));
    return false;
  }
  session.openTables(out.board, { name, files });
  markSaved(session.tomlText);
  setTomlStatus(out.warnings.length ? "warn" : "ok",
    out.warnings.length ? out.warnings.join("\n") : `Opened ${name}. This is what Save TOML writes; comments are not kept.`);
  if (session.firmware) {
    if (tabs) tabs.show("tab-configure");
    await startConfigure("open");
  }
  return true;
}

async function openFiles(fileList) {
  const files = [...fileList];
  const tomls = files.filter((f) => /\.toml$/i.test(f.name));
  if (tomls.length > 1) {
    showError("Open one board TOML at a time",
              `${tomls.map((f) => f.name).join(", ")}: pick one TOML, with the image and firmware file it names.`);
    return;
  }
  const extras = [];
  for (const f of files) {
    if (f !== tomls[0]) extras.push([f.name, await readFile(f, "bytes")]);
  }
  if (tomls.length) {
    const text = await readFile(tomls[0], "text");
    await openToml(text, { name: tomls[0].name, files: new Map(extras) });
  } else if (extras.length) {
    session.addFiles(extras);
  }
}

function setupFileIO() {
  $("open-toml").addEventListener("change", async (e) => {
    const input = e.target;
    try {
      await openFiles(input.files);
    } catch (err) {
      showError("Could not open the file", err.message || String(err));
    }
    input.value = "";
  });

  $("save-toml").addEventListener("click", async () => {
    // bridge.save_toml writes it when Python is up; toml-io.js writes the same
    // text otherwise, so saving never waits for a 7 MB download.
    let text = session.tomlText;
    if (runtime.isReady()) {
      try {
        text = await runtime.saveToml(session.tables());
      } catch (err) {
        showError("Could not write the board TOML", err.message);
        return;
      }
    }
    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: session.tomlName,
          types: [{ description: "Board TOML", accept: { "text/plain": [".toml"] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(text);
        await writable.close();
        markSaved(text);
        return;
      } catch (err) {
        // Cancelling the picker is not a save, so the document stays unsaved.
        if (err.name === "AbortError") return;
      }
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    a.download = session.tomlName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 0);
    markSaved(text);
  });
  session.on("saved", ({ text }) => markSaved(text));

  // Ask before losing work. The browser writes the wording and ignores
  // anything passed, so the only choice here is whether to ask at all.
  addEventListener("beforeunload", (e) => {
    if (!hasUnsavedChanges()) return;
    e.preventDefault();
    e.returnValue = "";
  });
}

// ── URL ──────────────────────────────────────────────────────────────

// ?project= and ?version= preselect; #toml= (what a generated page's "Open
// in WebFlash" sends) and ?config=<url> open a board TOML. hashOnly is a
// later change of the hash, which only #toml= answers.
async function openFromUrl({ hashOnly = false } = {}) {
  const params = new URLSearchParams(location.search);
  if (!hashOnly) {
    const project = params.get("project");
    const version = params.get("version");
    if (PROJECTS.includes(project)) session.setProject(project, { version: version || "latest", undoable: false });
    // The project may be the one already picked, which setProject leaves alone.
    if (version) session.setVersion(version, { undoable: false });
  }

  let text = null;
  let name = "board.toml";
  try {
    text = tomlFromHash(location.hash);
  } catch (e) {
    showError("Could not open the board TOML in the link", `The #toml= part of the address is damaged: ${e.message}`);
  }
  const config = hashOnly ? null : params.get("config");
  if (text === null && config) {
    try {
      const url = new URL(config, location.href);
      const resp = await fetch(url, { cache: "no-cache" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      text = await resp.text();
      name = decodeURIComponent(url.pathname.split("/").pop() || "") || name;
      if (!/\.toml$/i.test(name)) name = "board.toml";
    } catch (e) {
      showError("Could not load the board TOML",
                `${config}: ${e.message}\n\nThe server it is on must allow the site to fetch it (CORS).`);
    }
  }
  if (text === null) return false;
  return openToml(text, { name, files: new Map() });
}

// ── Keys ─────────────────────────────────────────────────────────────

function setupKeys() {
  document.addEventListener("keydown", (e) => {
    // A dialog is on top: its own keys are its business, and the session
    // must not change behind it.
    if (e.defaultPrevented || document.querySelector(".modal-backdrop")) return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && key === "s") {
      e.preventDefault();
      $("save-toml").click();
      return;
    }
    // In a text field, undo is the field's own (and "/" is a character).
    const active = document.activeElement;
    const typing = active?.matches("input:not([type=checkbox]):not([type=radio]):not([type=button]), textarea") ||
      active?.isContentEditable;
    if (typing) return;
    if (key === "/" && !mod && !active?.matches("select") && !$("kconfig-search").disabled) {
      e.preventDefault();
      tabs.show("tab-configure");
      $("kconfig-search").focus();
    } else if (mod && key === "z" && !e.shiftKey) {
      e.preventDefault();
      session.undo();
    } else if (mod && (key === "y" || (key === "z" && e.shiftKey))) {
      e.preventDefault();
      session.redo();
    }
  });
}

// ── Start ────────────────────────────────────────────────────────────

async function init() {
  setupColorScheme();
  setupRuntimeStatus();
  tabs = setupPanelTabs();
  setupTomlView();
  setupConfigure();
  optionsPanel = new OptionsPanel($("embed-options"), session, { themes: () => themeList });
  new ConfigTab({
    textarea: $("config-text"), minimal: $("config-minimal"), copy: $("config-copy"),
    download: $("config-download"), note: $("config-note"),
  }, session);
  setupPlan();
  setupToolbar();
  setupFileIO();
  setupKeys();
  markSaved(session.tomlText);
  mountFlashPanel(session, $("flash-card"), { uploadButton: $("upload-firmware"), showError })
    .catch((e) => console.error("The flash panel could not start:", e));

  configurator.loadIndex().catch((e) => {
    picker.setError(e.message);
    if (session.sources.state === "idle") session.setSources("error", e.message);
  });
  const opened = await openFromUrl();
  addEventListener("hashchange", () => openFromUrl({ hashOnly: true }));
  if (!opened) {
    if (configurator.autoStart) startConfigure("start");
    else maybeShowAboutOnFirstVisit();
  }
}

init();
