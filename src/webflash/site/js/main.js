// The WebFlash site: wires the wizard, its steps and the session together.
//
// The page is one box with five steps (js/wizard/wizard.js): Firmware (what
// to flash and which versions; Next starts the downloads), Configure (every
// option of `make menuconfig`), Build (compiles the configuration in the
// browser, build/build-panel.js), Flash (writes the result, or an uploaded
// file, to the board, flash/flash-panel.js) and Embed (what the reader of
// the generated page may change, the .config, the TOML, Save TOML and
// Generate). The session's tables are the board TOML (the TOML tab shows
// what Save writes); the configure session behind them runs in the engine
// worker. The top bar holds the status chip, Open TOML, Upload firmware and
// About.

import { Session, PROJECTS, PROJECT_TITLES, fetchBoardToml } from "./state.js";
import * as runtime from "./runtime.js";
import { tomlFromHash, parseToml, openInSiteUrl } from "./toml-io.js";
import { openGenerate, openAbout, renderAbout, showError, openModal, esc, siteEngineUrl } from "./dialogs.js";
import { mountFlashPanel } from "./flash/flash-panel.js";
import { explainError } from "./flash/errors.js";
import { Configurator } from "./configure/configurator.js";
import { KconfigTree } from "./configure/kconfig-tree.js";
import { ConfigTab, copyText } from "./configure/config-tab.js";
import { OptionsPanel } from "./configure/options-panel.js";
import { blobUrl, formatBytes, headSize, isChecked, projectTitle, uncheckedText } from "./configure/sources.js";
import { isCached } from "./workers/blob-cache.js";
import { BuildPanel, planErrorLine } from "./build/build-panel.js";
import { buildMatches } from "./build/artifacts.js";
import { Wizard } from "./wizard/wizard.js";
import { mountStatusChip } from "./wizard/status-chip.js";
import { FirmwarePage } from "./wizard/firmware-page.js";

const session = new Session();
const configurator = new Configurator(session);
let buildPanel = null;
let wizard = null;
let firmwarePage = null;
let flashApi = null;

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

// The pills live in the status chip's popover; the chip sums them up.
function setupRuntimeStatus() {
  const pill = $("status-python");
  const idleTitle = "About 7 MB, loaded when first needed.";
  pillState(pill, "", "Python", idleTitle);
  runtime.onProgress((phase, detail) => {
    if (phase === "runtime") pillState(pill, "busy", "Python: loading", "Downloading Pyodide from the CDN…");
    else if (phase === "package") pillState(pill, "busy", "Python: starting", "Loading the webflash package…");
    else if (phase === "ready") {
      const a = runtime.about();
      pillState(pill, "ready", "Python", a ? `Python ${a.python}, Pyodide ${a.pyodide}, webflash ${a.webflash}` : "Ready");
      // Whatever booted it, the theme list can come now.
      refreshThemes();
    } else if (phase === "error") {
      pillState(pill, "error", "Python: failed", detail);
    }
  });
  const retry = () => { if (runtime.failure()) runtime.retry().catch(() => {}); };
  pill.addEventListener("click", retry);

  const sources = $("status-sources");
  const render = () => {
    const st = session.sources;
    if (st.state === "loading") {
      const pct = st.total ? Math.min(100, Math.round((100 * (st.done || 0)) / st.total)) : null;
      // A download that finished before Python is up waits for it.
      const waiting = pct === 100 && !runtime.isReady();
      const what = st.phase === "extract" ? "unpacking" : st.phase === "kconfig" ? "reading Kconfig"
        : waiting ? "waiting for Python" : pct !== null ? `${pct}%` : "loading";
      pillState(sources, "busy", `Sources: ${what}`, `${st.detail}: ${st.phase === "kconfig" ? "loading the Kconfig files"
        : st.phase === "extract" ? "unpacking" : waiting ? "downloaded, waiting for Python"
        : `downloading${st.total ? ` ${formatBytes(st.total)}` : ""}`}…`);
    } else if (st.state === "ready") {
      pillState(sources, "ready", "Sources", `${st.detail}${st.ref ? ` (${st.ref.describe})` : ""}: ` +
        `${formatBytes(st.size)}${st.cached ? ", from this browser's cache" : ", downloaded"}`);
    } else if (st.state === "error") {
      pillState(sources, "error", "Sources: failed", st.detail);
    } else {
      pillState(sources, "", "Sources", "Load when you press Next on Firmware.");
    }
  };
  session.on("change", ({ what }) => { if (what === "sources") render(); });
  render();

  mountStatusChip({
    chip: $("status-chip"), popover: $("status-pop"),
    pills: [$("status-python"), $("status-sources"), $("status-toolchain")],
    retry: $("status-python-retry"), onRetry: retry,
  });
}

// ── Embed's tabs ─────────────────────────────────────────────────────

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
  $("toml-copy-link").addEventListener("click", (e) => {
    copyText(openInSiteUrl(session.board.engine_url || siteEngineUrl(), session.tomlText), e.currentTarget);
  });
  show();
}

// ── Configure ────────────────────────────────────────────────────────

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
  $("kconfig-undo").addEventListener("click", () => session.undo());
  $("kconfig-redo").addEventListener("click", () => session.redo());

  const renderTree = () => {
    const has = Boolean(session.tree && session.ref);
    tree.setTree(has ? session.tree : null, has ? `${session.project}/${session.ref.sha}` : "", session.project || "");
    if (search.value) runSearch();
  };
  const renderUndo = () => {
    const locked = Boolean(session.locked);
    $("kconfig-undo").disabled = locked || !session.canUndo;
    $("kconfig-redo").disabled = locked || !session.canRedo;
  };
  const renderState = () => {
    const ready = configurator.ready;
    const locked = Boolean(session.locked);
    search.disabled = !ready;
    $("kconfig-reset").disabled = !ready || locked;
    $("kconfig-load").disabled = !ready || locked;
    tree.setLocked(session.locked);
    renderUndo();
    renderStatus();
    renderStart();
    renderConfigureStep();
  };
  session.on("change", ({ what }) => {
    if (what === "tree" || what === "ref") renderTree();
    if (what === "options") tree.render();
    if (["sources", "lock", "ref", "index", "project", "version", "firmware", "open", "prebuilt"].includes(what)) renderState();
    else renderUndo();
  });
  configurator.onNotice(renderNotice);
  renderState();
  return tree;
}

// The step's title, its footer hint and whether Next (Build) can go on.
function renderConfigureStep() {
  if (!wizard) return;
  const title = PROJECT_TITLES[session.project] || (session.project ? projectTitle(session.index, session.project) : "");
  $("configure-title").textContent = title ? `Set up ${title}` : "Configure";
  wizard.setHint("configure", session.firmware ? `Next builds ${title} here, in your browser.` : "");
  const st = session.sources.state;
  wizard.setNext("configure", {
    enabled: Boolean(session.firmware) && (st === "loading" || st === "ready"),
    reason: st === "error" ? "The configuration did not load." : "Load the configuration first.",
  });
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
    (isChecked(ref) ? "" : `<span class="ref-badge" title="This snapshot ${esc(uncheckedText(ref))}. It may still build.">unchecked</span>`) +
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

// Above the tree until it loads: the progress, a failure with Try again, or,
// reached without page 1's Next, what loading downloads and its button.
async function renderStart() {
  const el = $("kconfig-start");
  const st = session.sources;
  if (!session.firmware) {
    el.hidden = false;
    el.innerHTML = `<p>This board TOML flashes its own file: there is nothing to configure.</p>`;
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
      : !runtime.isReady() ? (pct === 100 ? "Starting Python…" : "Starting Python and downloading the sources…")
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
  // The compiler, when this browser does not have it: it can download while
  // the user configures, so the first build does not wait for it.
  const compiler = buildPanel ? await buildPanel.compilerToFetch() : null;
  if (el.dataset.ref !== mine || session.sources.state !== "idle") return;
  const downloads = [];
  if (!runtime.isReady()) downloads.push("Python (about 7 MB, once)");
  downloads.push(`the sources (${size ? formatBytes(size) : "size unknown"}${cached ? ", in this browser already" : ""})`);
  el.innerHTML =
    `<h3>${esc(title)} ${esc(ref.id)}</h3>` +
    (note ? `<p class="kc-warn-text">${esc(note)}</p>` : "") +
    `<p>Loading it downloads ${downloads.map(esc).join(" and ")}.</p>` +
    (compiler ? `<p><label class="check kc-start-compiler"><input type="checkbox" id="kconfig-start-compiler" checked> ` +
      `Download the compiler while I configure (${esc(formatBytes(compiler.size))})</label></p>` : "") +
    `<button class="primary" id="kconfig-start-btn">Load the configuration</button>`;
  $("kconfig-start-btn").addEventListener("click", async () => {
    const box = $("kconfig-start-compiler");
    const compilerToo = Boolean(box && box.checked);
    const ok = await startConfigure("start");
    if (ok && compilerToo && buildPanel) buildPanel.prefetch();
  });
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
    `<p>Paste a <code>.config</code> or a defconfig, or open the file. ` +
    `It replaces the configuration of ${esc(projectTitle(session.index, session.project))} ${esc(ref ? ref.id : "")}; ` +
    `what it leaves out takes its default.</p>` +
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

// What the next build downloads beyond the sources, and what of it the
// browser's cache holds already.
function setupPlan() {
  const el = $("build-plan");
  let count = 0;
  const render = async () => {
    const mine = ++count;
    const p = session.plan;
    if (!p || !session.ref || session.sources.state !== "ready") {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    el.classList.toggle("warn", Boolean(p.error || (p.unavailable && p.unavailable.length)));
    if (p.error) {
      el.textContent = planErrorLine(p.error);
      return;
    }
    const missing = p.unavailable && p.unavailable.length
      ? ` This snapshot lacks ${p.unavailable.join(", ")}, which the build needs.` : "";
    if (!p.libs.length) {
      el.textContent = `No library bundles needed.${missing}`;
      return;
    }
    const cached = await Promise.all(p.libs.map((l) => isCached(blobUrl(l.blob))));
    if (mine !== count) return;
    const known = p.libs.filter((l) => Number.isFinite(l.size));
    const total = known.reduce((n, l) => n + l.size, 0);
    const all = cached.every(Boolean);
    el.textContent = `Library bundles${all ? "" : " to download"}: ` +
      p.libs.map((l, i) => {
        const bits = [Number.isFinite(l.size) ? formatBytes(l.size) : "", cached[i] && !all ? "cached" : ""].filter(Boolean);
        return `${l.dir}${bits.length ? ` (${bits.join(", ")})` : ""}`;
      }).join(", ") +
      (known.length > 1 ? `, ${formatBytes(total)} in all` : "") +
      (all ? `, ${p.libs.length === 1 ? "in this browser already" : "all in this browser already"}.` : ".") + missing;
  };
  session.on("change", ({ what }) => { if (["plan", "sources", "ref", "build"].includes(what)) render(); });
  render();
  return render;
}

let renderPlanNote = () => {};

// ── Build ────────────────────────────────────────────────────────────

// The Build step starts the build on arrival, unless the build on record
// still matches the configuration. It waits for what the build needs (the
// sources, the plan) while the step is shown, and starts at most once per
// arrival.
let autoBuild = false;

function tryAutoBuild() {
  if (!autoBuild) return;
  if (!wizard || wizard.current !== "build" || !buildPanel || buildPanel.running) {
    autoBuild = false;
    return;
  }
  if (buildPanel.last && !buildPanel.stale) {
    autoBuild = false;
    return;
  }
  if (!buildPanel.check().ok) return;
  autoBuild = false;
  buildPanel.onBuild();
}

function renderBuildStep() {
  if (!wizard) return;
  const done = Boolean(session.build) && buildMatches(session, session.build);
  wizard.setNext("build", { enabled: done, reason: "Next is enabled once the build is done." });
}

function setupBuildStep() {
  wizard.onEnter("build", () => {
    autoBuild = true;
    tryAutoBuild();
  });
  wizard.onLeave("build", () => { autoBuild = false; });
  session.on("change", ({ what }) => {
    if (autoBuild) tryAutoBuild();
    if (["build", "ref", "config", "project", "version", "open"].includes(what)) renderBuildStep();
  });
  renderBuildStep();
}

// ── Themes ───────────────────────────────────────────────────────────

let themeList = [];

async function refreshThemes() {
  try {
    themeList = await runtime.themeCatalog();
  } catch (e) {
    return;   // the status chip says why
  }
  if (optionsPanel) optionsPanel.fillThemes();
}

let optionsPanel = null;

// Embed options' Theme select lists the bundled themes, from Python: load
// the list when the select is first reached for, not with the page.
function setupThemes() {
  const want = (e) => {
    if (e.target && e.target.id === "opt-theme" && !themeList.length) refreshThemes();
  };
  $("embed-options").addEventListener("pointerdown", want);
  $("embed-options").addEventListener("focusin", want);
}

// ── Project and version ──────────────────────────────────────────────

// Page 1's switch, its version selects and Embed options' "Version the card
// starts with" all edit [firmware]: a change loads the new version once
// configuring has started.
function switchProject(project) {
  // An exact ref belongs to one project; the aliases work for any.
  const version = ["latest", "release"].includes(session.version) ? session.version : "latest";
  session.setProject(project, { version });
  if (configureStarted()) configurator.load({ reason: "switch" });
}

function switchVersion(version) {
  session.setVersion(version);
  if (configureStarted()) configurator.load({ reason: "switch" });
}

// ── About ────────────────────────────────────────────────────────────

function aboutOptions() {
  const st = session.sources;
  return {
    sources: st.state === "ready" && st.ref
      ? `${st.detail} (${st.ref.describe}), ${formatBytes(st.size)}${st.cached ? ", from this browser's cache" : ""}` : "",
    toolchain: buildPanel ? () => buildPanel.aboutText() : "",
    extend: buildPanel ? (el) => buildPanel.extendAbout(el) : null,
    onClearCache: async () => {
      if (buildPanel) await buildPanel.cacheCleared();
      renderPlanNote();
      if (firmwarePage) firmwarePage.renderHint();
    },
  };
}

function setupAbout() {
  $("about-btn").addEventListener("click", () => openAbout(aboutOptions()));
  // Page 1's folded "Versions and licenses": the same content, filled when opened.
  const fold = $("about-fold");
  const fill = () => { if (fold.open) renderAbout($("about-inline"), aboutOptions()); };
  fold.addEventListener("toggle", fill);
  wizard.onEnter("firmware", fill);
}

// ── Page 1 ───────────────────────────────────────────────────────────

function setupFirmwarePage() {
  firmwarePage = new FirmwarePage(session, configurator, wizard, {
    fwButtons: [...document.querySelectorAll("[data-fw]")],
    fwVersion: $("version-select"), fwBadge: $("version-badge"), fwVersionRow: $("fw-version-row"),
    katapult: $("katapult-check"), katVersion: $("katapult-version"), katBadge: $("katapult-badge"),
    katVersionRow: $("katapult-version-row"), soon: $("katapult-soon"), prebuilt: $("fw-prebuilt"),
  }, {
    switchProject,
    switchVersion,
    start: () => startConfigure("start"),
    sourcesStarted: () => ["loading", "ready"].includes(session.sources.state),
    compiler: () => (buildPanel ? buildPanel.compilerToFetch() : Promise.resolve(null)),
    // Next agreed to the downloads: the compiler comes now, and the first
    // build does not list them again.
    consent: async () => {
      if (!buildPanel) return;
      buildPanel.consented = true;
      if (await buildPanel.compilerToFetch()) buildPanel.prefetch();
    },
  });
  $("fw-open-toml").addEventListener("click", () => $("open-toml").click());
  $("fw-upload").addEventListener("click", () => uploadFirmware());
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
 * defconfig on the Configure step (a [prebuilt] TOML goes to Flash).
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
    out.warnings.length ? out.warnings.join("\n") : `Opened ${name}. Save TOML writes this; comments are not kept.`);
  if (session.firmware) {
    wizard.go("configure");
    await startConfigure("open");
  } else {
    wizard.go("flash");
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

// A message about a file with its name in front, unless it starts with it
// already (the flash panel's own rule).
function aboutFile(name, message) {
  return !name || message.startsWith(`${name}:`) || message.startsWith(`${name} `) ? message : `${name}: ${message}`;
}

// Upload firmware (the top bar) and "Flash a file you have" (page 1): the
// file goes to the Flash step, skipping Configure and Build. The step shows
// first, since a raw .bin asks for its address there.
const uploadInput = document.createElement("input");
uploadInput.type = "file";
uploadInput.accept = ".bin,.hex,.ihx,.uf2,.elf,application/octet-stream";
uploadInput.hidden = true;

function uploadFirmware() {
  if (flashApi) uploadInput.click();
}

function setupUpload() {
  document.body.appendChild(uploadInput);
  uploadInput.addEventListener("change", async () => {
    const file = uploadInput.files && uploadInput.files[0];
    uploadInput.value = "";
    if (!file || !flashApi) return;
    wizard.go("flash");
    try {
      await flashApi.useUploadedFile(file.name, new Uint8Array(await file.arrayBuffer()));
    } catch (e) {
      showError("The file could not be used", aboutFile(file.name, explainError(e, {}).message));
    }
  });
  $("upload-firmware").addEventListener("click", uploadFirmware);
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
  $("generate-btn").addEventListener("click", () => openGenerate(session));

  // Ask before losing work. The browser writes the wording and ignores
  // anything passed, so the only choice here is whether to ask at all.
  addEventListener("beforeunload", (e) => {
    if (!hasUnsavedChanges()) return;
    e.preventDefault();
    e.returnValue = "";
  });
}

// ── URL ──────────────────────────────────────────────────────────────

// ?project= and ?version= preselect page 1; #toml= (what a generated page's
// "Open in WebFlash" sends) and ?config=<url> open a board TOML. hashOnly is
// a later change of the hash, which only #toml= answers. Returns true when a
// TOML opened, false when the link named one that did not open (an error
// dialog said why), and null when the address names none.
async function openFromUrl({ hashOnly = false } = {}) {
  const params = new URLSearchParams(location.search);
  if (!hashOnly) {
    // A preselection is where the page starts, not a change to save.
    const clean = !hasUnsavedChanges();
    const project = params.get("project");
    const version = params.get("version");
    if (PROJECTS.includes(project)) session.setProject(project, { version: version || "latest", undoable: false });
    // The project may be the one already picked, which setProject leaves alone.
    if (version) session.setVersion(version, { undoable: false });
    if (clean) markSaved(session.tomlText);
  }

  let text = null;
  let name = "board.toml";
  let failed = false;
  try {
    text = tomlFromHash(location.hash);
  } catch (e) {
    failed = true;
    showError("Could not open the board TOML in the link", `The #toml= part of the address is damaged: ${e.message}`);
  }
  const config = hashOnly ? null : params.get("config");
  if (text === null && config) {
    try {
      ({ text, name } = await fetchBoardToml(config, location.href));
    } catch (e) {
      failed = true;
      showError(e.title || "Could not load the board TOML", e.message || String(e));
    }
  }
  if (text === null) return failed ? false : null;
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
      wizard.go("configure");
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

function setupWizard() {
  wizard = new Wizard({ box: $("wizard"), bar: $("wizard-steps") });
  // A [prebuilt] board TOML has nothing to configure or build.
  const skip = () => {
    wizard.setSkipped("configure", !session.firmware);
    wizard.setSkipped("build", !session.firmware);
  };
  session.on("change", ({ what }) => { if (what === "open" || what === "prebuilt" || what === "firmware") skip(); });
  skip();
  wizard.onNext("configure", () => (session.firmware ? "build" : "flash"));
}

async function init() {
  setupColorScheme();
  setupWizard();
  setupRuntimeStatus();
  setupPanelTabs();
  setupTomlView();
  setupConfigure();
  optionsPanel = new OptionsPanel($("embed-options"), session, { themes: () => themeList, onVersion: switchVersion });
  setupThemes();
  new ConfigTab({
    textarea: $("config-text"), minimal: $("config-minimal"), copy: $("config-copy"),
    download: $("config-download"), note: $("config-note"),
  }, session);
  renderPlanNote = setupPlan();
  buildPanel = new BuildPanel(session, configurator, {
    button: $("build-btn"), cancel: $("build-cancel"), status: $("build-status"), start: $("build-start"),
    bar: $("build-bar"), list: $("build-progress"), error: $("build-error"), memory: $("build-memory"),
    artifacts: $("build-artifacts"), logBox: $("build-log-box"), log: $("build-log"), logCopy: $("build-log-copy"),
    logCount: $("build-log-count"), pill: $("status-toolchain"),
  }, { showError });
  setupBuildStep();
  setupFirmwarePage();
  setupAbout();
  setupFileIO();
  setupUpload();
  setupKeys();
  renderConfigureStep();
  markSaved(session.tomlText);
  const mock = new URLSearchParams(location.search).get("mock");
  mountFlashPanel(session, $("flash-card"), { showError })
    .then((api) => {
      flashApi = api;
      $("upload-firmware").disabled = false;
      // The mock mode brings its own firmware: start where it is used.
      if (mock) wizard.go("flash");
    })
    .catch((e) => console.error("The flash panel could not start:", e));

  configurator.loadIndex().catch((e) => {
    firmwarePage.setIndexError(e.message);
    if (session.sources.state === "idle") session.setSources("error", e.message);
  });
  const opened = await openFromUrl();
  addEventListener("hashchange", () => openFromUrl({ hashOnly: true }));
  // A returning visitor's configuration loads at once, behind page 1.
  if (opened !== true && configurator.autoStart) startConfigure("start");
}

init();
