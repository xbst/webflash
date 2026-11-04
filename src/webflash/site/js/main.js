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
// worker. The top bar holds the status chip, Open TOML, Open .config, Upload
// firmware and About.

import { Session, PROJECTS, fetchBoardToml } from "./state.js";
import * as runtime from "./runtime.js";
import { tomlFromHash, parseToml, openInSiteUrl } from "./toml-io.js";
import { openGenerate, openAbout, openModal, renderAbout, showError, siteEngineUrl } from "./dialogs.js";
import { mountFlashPanel } from "./flash/flash-panel.js";
import { explainError } from "./flash/errors.js";
import { Configurator } from "./configure/configurator.js";
import { ConfigurePage } from "./configure/configure-page.js";
import { ConfigTab, copyText } from "./configure/config-tab.js";
import { OptionsPanel } from "./configure/options-panel.js";
import { blobUrl, formatBytes } from "./configure/sources.js";
import { isCached } from "./workers/blob-cache.js";
import { BuildPanel, planErrorLine } from "./build/build-panel.js";
import { buildsMatch } from "./build/artifacts.js";
import { Wizard } from "./wizard/wizard.js";
import { mountStatusChip } from "./wizard/status-chip.js";
import { FirmwarePage } from "./wizard/firmware-page.js";
import { askConfigProject, configTables, sortConfigs } from "./configure/open-config.js";

const session = new Session();
const configurator = new Configurator(session);
let buildPanel = null;
let wizard = null;
let firmwarePage = null;
let configurePage = null;
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

// The Sources pill, {cls, text, title}, for the firmware's sources and
// Katapult's beside them (katapult: its sources state, or null): a failure of
// either comes first, then either one loading, then Ready once both are.
function sourcesPill(fw, katapult, pythonReady) {
  const loading = (st) => {
    const pct = st.total ? Math.min(100, Math.round((100 * (st.done || 0)) / st.total)) : null;
    // A download that finished before Python is up waits for it.
    const waiting = pct === 100 && !pythonReady;
    const what = st.phase === "extract" ? "unpacking" : st.phase === "kconfig" ? "reading Kconfig"
      : waiting ? "waiting for Python" : pct !== null ? `${pct}%` : "loading";
    return { cls: "busy", text: `Sources: ${what}`, title: `${st.detail}: ${st.phase === "kconfig" ? "loading the Kconfig files"
      : st.phase === "extract" ? "unpacking" : waiting ? "downloaded, waiting for Python"
      : `downloading${st.total ? ` ${formatBytes(st.total)}` : ""}`}…` };
  };
  const ready = (st) => `${st.detail}${st.ref ? ` (${st.ref.describe})` : ""}: ` +
    `${formatBytes(st.size)}${st.cached ? ", from this browser's cache" : ", downloaded"}`;
  const k = katapult && katapult.state ? katapult : null;
  if (fw.state === "error") return { cls: "error", text: "Sources: failed", title: fw.detail };
  if (k && k.state === "error") {
    return { cls: "error", text: "Sources: failed", title: /^Katapult\b/.test(k.detail || "") ? k.detail : `Katapult: ${k.detail}` };
  }
  if (fw.state === "loading") return loading(fw);
  if (k && k.state === "loading") return loading(k);
  if (fw.state === "ready" && (!k || k.state === "ready")) {
    return { cls: "ready", text: "Sources", title: [fw, k].filter(Boolean).map(ready).join("\n") };
  }
  if (fw.state === "ready") return { cls: "", text: "Sources", title: `${ready(fw)}\nKatapult's load next.` };
  return { cls: "", text: "Sources", title: "Loads when you press Next on Firmware." };
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
    const k = session.katapult;
    const pill = sourcesPill(session.sources, k ? k.sources : null, runtime.isReady());
    pillState(sources, pill.cls, pill.text, pill.title);
  };
  session.on("change", ({ what }) => {
    if (["sources", "katapult-sources", "katapult", "setup", "project"].includes(what)) render();
  });
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
  configurePage = new ConfigurePage(session, configurator, wizard, {
    title: $("configure-title"), lead: $("configure-lead"), search: $("kconfig-search"), count: $("kconfig-count"),
    undo: $("kconfig-undo"), redo: $("kconfig-redo"), load: $("kconfig-load"), reset: $("kconfig-reset"),
    status: $("kconfig-status"), notice: $("kconfig-notice"), start: $("kconfig-start"), tree: $("kconfig-tree"),
    setupRow: $("kconfig-setup-row"), setup: $("kconfig-setup"),
  }, {
    start: (reason) => startConfigure(reason),
    compiler: () => (buildPanel ? buildPanel.compilerToFetch() : Promise.resolve(null)),
    prefetch: () => { if (buildPanel) buildPanel.prefetch(); },
    showError,
  });
}

// Load what page 1 picked: the firmware, then Katapult beside it (whose
// shared options then follow the firmware's). Whether the TOML is as it was
// last saved or opened, so a load that only normalizes the defconfigs does
// not count as an unsaved change. A change of the tables made meanwhile by
// anything but the engine (an edit in Embed, an undo) does.
async function startConfigure(reason) {
  const clean = !hasUnsavedChanges();
  let touched = false;
  const off = session.on("change", ({ what, origin }) => {
    if (origin !== "engine" && ["board", "firmware", "setups", "options", "flash", "prebuilt", "katapult", "project",
      "version", "undo"].includes(what)) touched = true;
  });
  let ok;
  try {
    ok = await configurator.load({ reason });
    if (ok && session.katapult && !configurator.slots.katapult) ok = await configurator.loadKatapult({ reason });
  } finally {
    off();
  }
  if (ok && clean && !touched && ["start", "open", "config"].includes(reason)) markSaved(session.tomlText);
  return ok;
}

// Katapult ticked, or its version changed, once configuring has started: load it beside the firmware.
function loadKatapult(reason = "start") {
  if (!configureStarted() || !session.katapult) return Promise.resolve(false);
  return configurator.load({ reason, slot: "katapult" });
}

function configureStarted() {
  return session.sources.state !== "idle" || Boolean(configurator.loaded);
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
  if (buildPanel.current) {
    autoBuild = false;
    return;
  }
  if (!buildPanel.check().ok) return;
  autoBuild = false;
  buildPanel.onBuild();
}

// Next goes to Flash once every firmware the configuration builds (Katapult
// and the firmware for a pair) has a build that still matches.
function renderBuildStep() {
  if (!wizard) return;
  wizard.setNext("build", { enabled: buildsMatch(session), reason: "Next is enabled once the build is done." });
}

function setupBuildStep() {
  wizard.onEnter("build", () => {
    autoBuild = true;
    tryAutoBuild();
  });
  wizard.onLeave("build", () => { autoBuild = false; });
  session.on("change", ({ what }) => {
    if (autoBuild) tryAutoBuild();
    if (["build", "ref", "config", "project", "version", "open", "katapult", "katapult-ref", "katapult-config", "setup"].includes(what)) renderBuildStep();
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

// Embed options. Its Katapult controls act as page 1's do (ticking loads
// Katapult beside the firmware once configuring started); Edit on a setup
// loads it into Configure and goes there.
function setupOptionsPanel() {
  optionsPanel = new OptionsPanel($("embed-options"), session, {
    themes: () => themeList,
    wantThemes: () => { if (!themeList.length) refreshThemes(); },
    onVersion: switchVersion,
    onKatapultVersion: (version) => {
      session.setKatapultTable({ version });
      if (session.katapult) loadKatapult("switch");
    },
    onKatapult: (on) => {
      if (!on) {
        session.removeKatapult();
        return;
      }
      session.setKatapult({ on: true, version: firmwarePage ? firmwarePage.katapultVersion : "latest" });
      loadKatapult("start");
    },
    loadSetup: (i) => configurePage.pickSetup(i),
    editSetup: (i) => {
      $("configure-to-embed").hidden = false;
      wizard.go("configure");
      return i === session.setupIndex ? Promise.resolve() : configurePage.pickSetup(i);
    },
  });
  // Configure reached through Edit offers the way back to Embed, which needs
  // no build; it goes once Configure is left.
  $("configure-to-embed").addEventListener("click", () => wizard.go("embed"));
  wizard.onLeave("configure", () => { $("configure-to-embed").hidden = true; });
}

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
// configuring has started. version: the one to switch to (Katapult alone
// takes page 1's Katapult version); by default the latest/release alias stays
// (leaving Katapult alone, setProject brings back the firmware's own version).
function switchProject(project, version = null) {
  // An exact ref belongs to one project; the aliases work for any.
  const v = version || (session.project === "katapult" ? null
    : ["latest", "release"].includes(session.version) ? session.version : "latest");
  session.setProject(project, { version: v });
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
    fwVersion: $("fw-version"), fwVersionRow: $("fw-version-row"),
    katapult: $("katapult-check"), katVersion: $("katapult-version"),
    katVersionRow: $("katapult-version-row"), prebuilt: $("fw-prebuilt"),
  }, {
    switchProject,
    switchVersion,
    loadKatapult,
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
  $("fw-open-config").addEventListener("click", () => $("open-config").click());
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
    out.warnings.length ? out.warnings.join("\n") : `Opened ${name}; Save TOML writes this text, without its comments.`);
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

/**
 * Open .config: a new board configured by a Klipper, Kalico or Katapult
 * .config (or defconfig), or a firmware's and Katapult's together, at page
 * 1's versions. It loads on the Configure step as an opened TOML does, then
 * again from the defconfig the engine made of it, so the .config's values
 * stay values rather than pinning every option the way a .config does.
 */
async function openConfigs(fileList) {
  const files = [];
  for (const f of fileList) files.push({ name: f.name, text: await readFile(f, "text") });
  const sorted = sortConfigs(files);
  if (sorted.error) {
    showError("Could not open the .config", sorted.error);
    return false;
  }
  let { firmware, katapult } = sorted;
  if (sorted.ask.length) {
    const [first, second] = sorted.ask;
    const project = await askConfigProject(first.name);
    if (!project) return false;
    if (project === "katapult") {
      katapult = first;
      if (second) firmware = { ...second, project: null };
    } else {
      firmware = { ...first, project };
      if (second) katapult = second;
    }
  }
  // Klipper or Kalico: what the file says, else page 1's pick.
  const project = firmware && (firmware.project || (["klipper", "kalico"].includes(session.project) ? session.project : "klipper"));
  const keep = (p) => (session.firmware && (session.project === p || ["latest", "release"].includes(session.version))
    ? session.version : "latest");
  const tables = configTables({
    project,
    firmwareText: firmware ? firmware.text : null,
    katapultText: katapult ? katapult.text : null,
    version: firmware ? keep(project) : "latest",
    katapultVersion: firmwarePage ? firmwarePage.katapultVersion : "latest",
  });
  session.openTables(tables, { name: "board.toml", files: new Map() });
  markSaved(session.tomlText);
  const names = [firmware, katapult].filter(Boolean).map((f) => f.name).join(" and ");
  setTomlStatus("ok", `Made from ${names}; Save TOML writes it as a board TOML.`);
  wizard.go("configure");
  const ok = await startConfigure("config");
  if (ok) await configurator.reapply();
  return ok;
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
  $("open-config").addEventListener("change", async (e) => {
    const input = e.target;
    const files = [...input.files];
    input.value = "";
    try {
      await openConfigs(files);
    } catch (err) {
      showError("Could not open the .config", err.message || String(err));
    }
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

// The hash of the address the session's board came from: Back and Forward
// to an entry of that link only move between steps.
const link = { hash: null };

// A later change of the hash: a #toml= pasted or followed in this tab, or the
// browser's Back and Forward across one. Another link's TOML replaces the
// board, after asking when that loses unsaved changes.
async function onHashChange() {
  const hash = location.hash;
  if (hash === link.hash) return;
  let named = true;
  try {
    named = tomlFromHash(hash) !== null;
  } catch (e) { /* damaged: openFromUrl says so */ }
  if (!named) return;
  if (hasUnsavedChanges() && !(await askOpenLink())) return;
  link.hash = hash;
  await openFromUrl({ hashOnly: true });
}

// Whether the link's board TOML may replace a board with unsaved changes.
function askOpenLink() {
  return new Promise((resolve) => {
    const { body, close, onClose } = openModal("Open the board TOML in the link?");
    let answer = false;
    onClose(() => resolve(answer));
    body.innerHTML =
      "<p>The board you are working on has unsaved changes, which the link's board TOML replaces.</p>" +
      `<div class="modal-actions"><button class="primary" data-open="1">Open the link</button>` +
      `<span class="gen-spacer"></span><button data-open="">Keep my board</button></div>`;
    for (const b of body.querySelectorAll("[data-open]")) {
      b.addEventListener("click", () => {
        answer = Boolean(b.dataset.open);
        close();
      });
    }
    body.querySelector("[data-open='']").focus();
  });
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
  // Build first: Configure, shown when an undo makes the board [prebuilt],
  // then gives way to Flash rather than to Build.
  const skip = () => {
    wizard.setSkipped("build", !session.firmware);
    wizard.setSkipped("configure", !session.firmware);
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
  setupOptionsPanel();
  setupThemes();
  new ConfigTab({
    textarea: $("config-text"), minimal: $("config-minimal"), copy: $("config-copy"),
    download: $("config-download"), note: $("config-note"), project: $("config-project"),
  }, session);
  renderPlanNote = setupPlan();
  buildPanel = new BuildPanel(session, configurator, {
    title: $("build-title"), clock: $("build-clock"), pre: $("build-pre"), jobs: $("build-jobs"), error: $("build-error"),
    start: $("build-start"), list: $("build-progress"), memoryBox: $("build-memory-box"), memory: $("build-memory"),
    logBox: $("build-log-box"), log: $("build-log"), logCopy: $("build-log-copy"), logCount: $("build-log-count"),
    button: $("build-btn"), cancel: $("build-cancel"), pill: $("status-toolchain"),
  }, { showError });
  setupBuildStep();
  setupFirmwarePage();
  setupAbout();
  setupFileIO();
  setupUpload();
  setupKeys();
  configurePage.renderHead();
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
  link.hash = location.hash;
  addEventListener("hashchange", () => onHashChange());
  // A returning visitor's configuration loads at once, behind page 1.
  if (opened !== true && configurator.autoStart) startConfigure("start");
}

init();
