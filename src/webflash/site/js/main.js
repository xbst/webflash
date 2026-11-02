// The WebFlash site: wires the toolbar, the panels and the session together.
//
// With the package core alone the site is a working renderer: open a board
// TOML (or arrive with one in the URL), edit it in the TOML tab, pick a theme,
// Generate, and download the page and the TOML. Configure, Build and Flash are
// filled in by later chunks of the build-out; their controls are here,
// disabled, with a title naming the chunk.

import { Session, PROJECTS } from "./state.js";
import * as runtime from "./runtime.js";
import { tomlFromHash } from "./toml-io.js";
import { openGenerate, openAbout, maybeShowAboutOnFirstVisit, showError } from "./dialogs.js";
import { mountFlashPanel } from "./flash/flash-panel.js";

const session = new Session();

const STARTER_TOML = `# A board TOML: what to build and flash, and which settings the reader of the
# generated page may change. Open one with Open TOML or edit this one, then
# Generate the page. Reference: https://doctools.isiks.tech/webflash/

[board]
title = "My board"

[firmware]
project = "klipper"
version = "latest"

[config]
# The minimal configuration, exactly what \`make savedefconfig\` writes.
defconfig = """
CONFIG_MACH_STM32=y
CONFIG_MACH_STM32G0B1=y
"""
`;

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

function setupRuntimeStatus() {
  const pill = $("status-python");
  const idleTitle = "The Python runtime (Pyodide, about 7 MB) loads when it is first needed: " +
                    "opening a TOML, Generate, or the theme list.";
  const show = (cls, text, title) => {
    pill.className = `pill${cls ? ` ${cls}` : ""}`;
    pill.textContent = text;
    pill.title = title;
  };
  show("", "Python", idleTitle);
  runtime.onProgress((phase, detail) => {
    if (phase === "runtime") show("busy", "Python: loading", "Downloading the Python runtime (Pyodide) from the CDN…");
    else if (phase === "package") show("busy", "Python: starting", "Loading the webflash package into Python…");
    else if (phase === "ready") {
      const a = runtime.about();
      show("ready", "Python", a ? `Python ${a.python}, Pyodide ${a.pyodide}, webflash ${a.webflash}` : "Ready");
      // Whatever booted it, the theme list and the TOML's check can come now.
      refreshThemes();
    } else if (phase === "error") {
      show("error", "Python: failed", `${detail}\n\nClick to try again.`);
    }
  });
  pill.addEventListener("click", () => {
    if (runtime.failure()) runtime.retry().catch(() => {});
  });
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

let checkTimer = null;
let checkCount = 0;

function setStatus(cls, text) {
  const el = $("toml-status");
  el.className = `toml-status${cls ? ` ${cls}` : ""}`;
  el.textContent = text;
}

// The loader's verdict, once Python is up: the same checks Generate and the
// command line make. A parse error is shown at once, without Python.
async function checkToml() {
  const mine = ++checkCount;
  if (session.parseError) {
    setStatus("error", session.parseError.message);
    return;
  }
  if (!runtime.isReady()) {
    setStatus("", "");
    return;
  }
  try {
    const out = await runtime.checkBoard(session.tomlText);
    if (mine !== checkCount) return;
    if (out.errors.length) setStatus("error", out.errors.join("\n"));
    else if (out.warnings.length) setStatus("warn", out.warnings.join("\n"));
    else setStatus("ok", "The board TOML is valid.");
  } catch (e) {
    if (mine === checkCount) setStatus("error", e.message);
  }
}

function scheduleCheck(delay = 500) {
  clearTimeout(checkTimer);
  checkTimer = setTimeout(checkToml, delay);
}

function setupTomlEditor() {
  const textarea = $("toml-text");
  let typing = null;
  textarea.value = session.tomlText;
  textarea.addEventListener("input", () => {
    clearTimeout(typing);
    typing = setTimeout(() => session.setToml(textarea.value, { origin: "editor" }), 400);
  });
  // Leaving the editor commits what was typed, so a toolbar action never
  // works on text older than what is on screen.
  textarea.addEventListener("blur", () => flushEditor());
  session.on("change", ({ what, origin }) => {
    if (what !== "toml") return;
    if (origin !== "editor" && textarea.value !== session.tomlText) {
      const { selectionStart, selectionEnd } = textarea;
      textarea.value = session.tomlText;
      if (document.activeElement === textarea) textarea.setSelectionRange(selectionStart, selectionEnd);
    }
    $("toml-name").textContent = session.tomlName;
    scheduleCheck(origin === "editor" ? 500 : 0);
  });
  session.on("change", ({ what }) => {
    if (what !== "files" && what !== "toml") return;
    const names = [...session.files.keys()];
    $("toml-files").textContent = names.length ? `with ${names.join(", ")}` : "";
  });

  function flushEditor() {
    clearTimeout(typing);
    if (textarea.value !== session.tomlText) session.setToml(textarea.value, { origin: "editor" });
  }
  return { flush: flushEditor, textarea };
}

// ── The Embed options tab (filled by chunk 05; shows the TOML for now) ──

function setupEmbedFields() {
  const refresh = () => {
    const board = (session.toml && session.toml.board) || {};
    $("embed-title").value = typeof board.title === "string" ? board.title : "";
    $("embed-description").value = typeof board.description === "string" ? board.description : "";
    $("embed-image").value = typeof board.image === "string" ? board.image : "";
    const instructions = session.toml && session.toml.flash && session.toml.flash.instructions;
    $("embed-instructions").value = instructions && typeof instructions === "object"
      ? Object.entries(instructions).map(([k, v]) => `${k}: ${v}`).join("\n") : "";
  };
  session.on("change", ({ what }) => { if (what === "toml") refresh(); });
  refresh();
}

// ── Toolbar ──────────────────────────────────────────────────────────

let themeList = [];

function fillThemeSelect() {
  const sel = $("theme-select");
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
                              .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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
  scheduleCheck(0);
}

function setupToolbar(editor) {
  const project = $("project-select");
  project.value = session.project;
  project.addEventListener("change", () => session.setProject(project.value));

  const theme = $("theme-select");
  fillThemeSelect();
  // The list comes from the bundled themes, in Python: load it when the
  // select is first reached for, not with the page.
  const wantThemes = () => { if (!themeList.length) refreshThemes(); };
  theme.addEventListener("pointerdown", wantThemes);
  theme.addEventListener("focus", wantThemes);
  theme.addEventListener("change", () => {
    editor.flush();
    if (!session.setTheme(theme.value)) {
      fillThemeSelect();
      showError("The theme was not changed", "The board TOML does not parse, so the site cannot change its theme. " +
                "Fix it in the TOML tab first.\n\n" + (session.parseError ? session.parseError.message : ""));
    }
  });

  session.on("change", ({ what }) => {
    if (what === "toml" || what === "project") project.value = session.project;
    if (what === "toml") fillThemeSelect();
  });

  $("generate-btn").addEventListener("click", () => {
    editor.flush();
    openGenerate(session);
  });
  $("about-btn").addEventListener("click", openAbout);
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

async function openFiles(fileList, editor, tabs) {
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
    editor.flush();
    session.setToml(text, { origin: "open", name: tomls[0].name, files: new Map(extras) });
    markSaved(session.tomlText);
    if (session.parseError) tabs.show("tab-toml");
  } else if (extras.length) {
    session.addFiles(extras);
  }
  // Opening a board is the moment the site needs Python: the loader checks it.
  runtime.ready().catch(() => {});
}

function setupFileIO(editor, tabs) {
  $("open-toml").addEventListener("change", async (e) => {
    const input = e.target;
    try {
      await openFiles(input.files, editor, tabs);
    } catch (err) {
      showError("Could not open the file", err.message || String(err));
    }
    input.value = "";
  });

  $("save-toml").addEventListener("click", async () => {
    editor.flush();
    const text = session.tomlText;
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
    editor.flush();
    if (!hasUnsavedChanges()) return;
    e.preventDefault();
    e.returnValue = "";
  });
}

// ── URL ──────────────────────────────────────────────────────────────

// ?project= and ?version= preselect; #toml= (what a generated page's "Open
// in WebFlash" sends) and ?config=<url> open a board TOML. hashOnly is a
// later change of the hash, which only #toml= answers.
async function openFromUrl(tabs, { hashOnly = false } = {}) {
  const params = new URLSearchParams(location.search);
  if (!hashOnly) {
    const project = params.get("project");
    if (PROJECTS.includes(project)) session.setProject(project);
    const version = params.get("version");
    if (version) session.setVersion(version);
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
  session.setToml(text, { origin: "open", name, files: new Map() });
  markSaved(session.tomlText);
  if (session.parseError) tabs.show("tab-toml");
  runtime.ready().catch(() => {});
  return true;
}

// ── Keys ─────────────────────────────────────────────────────────────

function setupKeys(editor) {
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
    // In a text field, undo is the field's own.
    const typing = document.activeElement?.matches("input, textarea, select") || document.activeElement?.isContentEditable;
    if (typing) return;
    if (mod && key === "z" && !e.shiftKey) {
      e.preventDefault();
      editor.flush();
      session.undo();
    } else if (mod && (key === "y" || (key === "z" && e.shiftKey))) {
      e.preventDefault();
      editor.flush();
      session.redo();
    }
  });
}

// ── Start ────────────────────────────────────────────────────────────

async function init() {
  setupColorScheme();
  setupRuntimeStatus();
  const tabs = setupPanelTabs();
  session.setToml(STARTER_TOML, { origin: "init", undoable: false });
  const editor = setupTomlEditor();
  setupEmbedFields();
  setupToolbar(editor);
  setupFileIO(editor, tabs);
  setupKeys(editor);
  markSaved(session.tomlText);
  $("toml-name").textContent = session.tomlName;
  mountFlashPanel(session, $("flash-card"), { uploadButton: $("upload-firmware"), showError })
    .catch((e) => console.error("The flash panel could not start:", e));

  const opened = await openFromUrl(tabs);
  addEventListener("hashchange", () => openFromUrl(tabs, { hashOnly: true }));
  if (!opened) maybeShowAboutOnFirstVisit();
}

init();
