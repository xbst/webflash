// The Generate dialog, the About box and error dialogs.
//
// Generate renders through the same code path as the `webflash` command, so
// the downloaded file is the command's bytes. The preview is the same page
// with its runtime loaded from this site's own /engine/v1/ (and the files the
// TOML names inlined when they are attached), so the card in it runs.

import * as runtime from "./runtime.js";
import { clearCache } from "./workers/blob-cache.js";
import { openInSiteUrl, writeBoardToml } from "./toml-io.js";

const REPO_URL = "https://github.com/xbst/webflash";
const DOCS_URL = "https://doctools.isiks.tech/webflash/";
const ABOUT_SEEN_KEY = "webflash.about.seen";

export function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
                  .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// The open dialogs, the topmost last. Everything else on the page (the app
// and any dialog under the top one) is inert, so Tab cannot reach it, until
// the last dialog closes.
const openModals = [];
let inertNow = new Set();

function updateInert() {
  const top = openModals[openModals.length - 1];
  const want = new Set(top ? [...document.body.children].filter((el) => el !== top) : []);
  for (const el of inertNow) if (!want.has(el)) el.removeAttribute("inert");
  for (const el of want) el.setAttribute("inert", "");
  inertNow = want;
}

/** A modal shell. Returns the body element plus a close function. */
export function openModal(title, { wide = false } = {}) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML =
    `<div class="modal${wide ? " modal-wide" : ""}" role="dialog" aria-modal="true" aria-label="${esc(title)}">` +
    `<div class="modal-head"><span class="modal-title">${esc(title)}</span>` +
    `<button class="modal-close" title="Close" aria-label="Close">&times;</button></div>` +
    `<div class="modal-body"></div></div>`;

  const cleanups = [];
  let closed = false;
  const opener = document.activeElement;
  const close = () => {
    if (closed) return;
    closed = true;
    for (const fn of cleanups) { try { fn(); } catch (e) { /* keep closing */ } }
    document.removeEventListener("keydown", onKey);
    const i = openModals.indexOf(backdrop);
    if (i >= 0) openModals.splice(i, 1);
    backdrop.remove();
    updateInert();
    if (opener && opener.isConnected && typeof opener.focus === "function") opener.focus();
  };
  const onKey = (e) => { if (e.key === "Escape") close(); };

  backdrop.querySelector(".modal-close").addEventListener("click", close);
  backdrop.addEventListener("mousedown", (e) => { if (e.target === backdrop) close(); });
  document.addEventListener("keydown", onKey);
  openModals.push(backdrop);
  document.body.appendChild(backdrop);
  updateInert();
  backdrop.querySelector(".modal-close").focus();

  return { body: backdrop.querySelector(".modal-body"), close, onClose: (fn) => cleanups.push(fn) };
}

/** Hand the browser a file to save. */
export function saveFile(data, suggestedName, mime) {
  const blob = new Blob([data], { type: mime });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = suggestedName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next turn; revoking immediately can cancel the download.
  setTimeout(() => URL.revokeObjectURL(a.href), 0);
}

/** A problem worth stopping for, in its own words. */
export function showError(title, message) {
  const { body, close } = openModal(title);
  body.innerHTML =
    `<pre class="error-text">${esc(message)}</pre>` +
    `<div class="modal-actions"><button class="primary" id="error-ok">OK</button></div>`;
  body.querySelector("#error-ok").addEventListener("click", close);
  body.querySelector("#error-ok").focus();
  return close;
}

function base64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** The files the TOML names that were opened beside it, as render() takes them. */
export function renderFiles(session) {
  const files = {};
  for (const ref of session.referencedFiles()) {
    if (ref.bytes) files[ref.path] = base64(ref.bytes);
  }
  return files;
}

function sizeOf(n) {
  return n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(2)} MB`;
}

function sizeText(text) {
  const n = new TextEncoder().encode(text).length;
  return n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(2)} MB`;
}

function stemOf(name) {
  return (name || "board.toml").replace(/\.toml$/i, "") || "board";
}

/** This site's own embed runtime, where the Generate preview loads it from. */
export function siteEngineUrl(base = document.baseURI) {
  return new URL("engine/v1/", new URL("./", base)).href;
}

/**
 * The TOML the preview renders: the session's, with engine_url pointing at
 * this site's runtime (so the card in the preview runs here, whatever the
 * downloaded page names), and without the image when it is not attached (an
 * image beside the page does not exist in the preview).
 */
export function previewToml(tables, engineUrl, { imageAttached = true } = {}) {
  const board = { ...tables.board, engine_url: engineUrl };
  if (!imageAttached) board.image = "";
  return writeBoardToml({ ...tables, board });
}

// ── Generate ────────────────────────────────────────────────────────

/**
 * The page the TOML renders to, previewed and ready to download, with the
 * TOML beside it. The dialog's Theme is the TOML's [board] theme, the same
 * setting as the toolbar's, so the downloaded TOML renders to the downloaded
 * page with the command line too. Attach files adds the image and firmware
 * file the TOML names to the session (session.files), for -i and the preview.
 */
export async function openGenerate(session) {
  const { body, close, onClose } = openModal("Generate the embeddable page", { wide: true });
  body.innerHTML = `<p class="gen-status">Starting the Python runtime…</p>`;
  let themes = [];
  try {
    themes = await runtime.themeCatalog();
  } catch (e) {
    body.innerHTML = `<pre class="error-text">${esc(e.message || e)}</pre>`;
    return close;
  }
  const bundled = new Set(themes.map((t) => t.name));
  const current = session.theme || "default";
  if (!bundled.has(current)) themes.push({ name: current, display: `${current} (not bundled)` });

  body.innerHTML =
    `<div class="gen-bar">` +
    `<label class="field">Theme <select id="gen-theme">` +
    themes.map((t) =>
      `<option value="${esc(t.name)}"${t.name === current ? " selected" : ""}>${esc(t.display)}</option>`
    ).join("") +
    `</select></label>` +
    `<label class="gen-embed"><input type="checkbox" id="gen-inline" disabled> Embed the image and firmware file (-i)</label>` +
    `<span class="gen-status" id="gen-status">Rendering…</span>` +
    `<span class="gen-spacer"></span>` +
    `<button id="gen-copy-link" title="Copy a link that opens this board TOML on the WebFlash site (Open in WebFlash)">Copy link</button>` +
    `<button id="gen-download-toml">Download TOML</button>` +
    `<button id="gen-download" class="primary">Download HTML</button>` +
    `</div>` +
    `<p class="gen-warn" id="gen-theme-note" hidden></p>` +
    `<div class="gen-files" id="gen-files"></div>` +
    `<p class="gen-warn" id="gen-warn" hidden></p>` +
    `<div class="gen-preview" id="gen-preview"></div>` +
    `<p class="gen-note"><span id="gen-inline-note"></span> The same page from the command line: ` +
    `<code id="gen-command"></code></p>`;

  const statusEl = body.querySelector("#gen-status");
  const previewEl = body.querySelector("#gen-preview");
  const themeEl = body.querySelector("#gen-theme");
  const inlineEl = body.querySelector("#gen-inline");
  const commandEl = body.querySelector("#gen-command");
  const downloadBtn = body.querySelector("#gen-download");
  const filesEl = body.querySelector("#gen-files");
  const themeNote = body.querySelector("#gen-theme-note");
  const stem = stemOf(session.tomlName);
  const engineUrl = siteEngineUrl();

  // The files the TOML names and which of them are attached; -i needs all.
  const renderFilesList = () => {
    const refs = session.referencedFiles();
    const missing = refs.filter((r) => !r.bytes);
    const canInline = refs.length > 0 && missing.length === 0;
    const note = !refs.length
      ? "The TOML names no image or firmware file, so there is nothing to embed."
      : missing.length
        ? `To embed them, attach ${missing.map((r) => r.path).join(" and ")}.`
        : "Embedding gives one self-contained file. Without it the page loads the files from beside it.";
    const wasDisabled = inlineEl.disabled;
    inlineEl.disabled = !canInline;
    if (!canInline) inlineEl.checked = false;
    else if (wasDisabled) inlineEl.checked = true;
    inlineEl.parentElement.title = note;
    body.querySelector("#gen-inline-note").textContent = note;
    filesEl.hidden = !refs.length;
    filesEl.innerHTML = refs.length
      ? `<span class="gen-files-head">Files the TOML names:</span>` + refs.map((r) =>
        `<span class="gen-file${r.bytes ? " attached" : ""}" title="${esc(r.role)}: ${esc(r.path)}">${esc(r.path.split(/[\\/]/).pop())} ` +
        `<span class="gen-file-state">${r.bytes ? `attached, ${esc(sizeOf(r.bytes.length))}` : "not attached"}</span></span>`).join("") +
        `<label class="file-btn" title="Pick the files under the names the TOML gives them">Attach files…<input type="file" id="gen-attach" multiple></label>`
      : "";
    const attach = filesEl.querySelector("#gen-attach");
    if (attach) {
      attach.addEventListener("change", async () => {
        const picked = [...attach.files];
        attach.value = "";
        if (!picked.length) return;
        session.addFiles(await Promise.all(picked.map(async (f) => [f.name, new Uint8Array(await f.arrayBuffer())])));
        renderFilesList();
        refresh();
      });
    }
    return { refs, canInline };
  };

  const renderThemeNote = () => {
    const name = session.theme || "default";
    themeNote.hidden = bundled.has(name);
    themeNote.textContent = bundled.has(name) ? "" :
      `This board TOML names the theme "${name}", which is not bundled with WebFlash, and the site renders with the bundled ` +
      `themes only: pick one here, or render the page with the command line (webflash ${session.tomlName}) next to the theme's file.`;
    return bundled.has(name);
  };

  // Honor the height protocol the generated page speaks, the one md-iframe's
  // listener implements: the frame takes the height the page reports.
  const onMessage = (e) => {
    const frame = previewEl.querySelector("iframe");
    if (!frame || e.source !== frame.contentWindow) return;
    const data = e.data;
    if (!data || typeof data !== "object" || !("mdIframeHeight" in data)) return;
    const h = Number(data.mdIframeHeight);
    frame.style.height = h > 0 ? `${Math.min(h, 20000)}px` : "";
  };
  addEventListener("message", onMessage);
  onClose(() => removeEventListener("message", onMessage));

  // html is only ever read while ok is true: a failed render must not leave
  // the previous page for Download to hand over as though it were current.
  let html = null;
  let ok = false;
  let renderCount = 0;
  const setOk = (value) => {
    ok = value;
    downloadBtn.disabled = !value;
    downloadBtn.title = value ? "" : "Nothing to download until the page renders.";
  };
  setOk(false);

  const showWarnings = (warnings) => {
    const el = body.querySelector("#gen-warn");
    el.hidden = !warnings.length;
    el.textContent = warnings.join("\n");
  };

  const showCommand = () => {
    commandEl.textContent = `webflash ${session.tomlName}${inlineEl.checked ? " -i" : ""}`;
  };

  // Two renders when they differ: the download is the command line's page;
  // the preview runs its runtime from this site, with every attached file
  // inlined so the srcdoc frame has them.
  const refresh = async () => {
    const mine = ++renderCount;
    statusEl.textContent = "Rendering…";
    showCommand();
    const { refs, canInline } = renderFilesList();
    if (!renderThemeNote()) {
      setOk(false);
      showWarnings([]);
      previewEl.replaceChildren();
      statusEl.textContent = "";
      return;
    }
    const files = renderFiles(session);
    const image = refs.find((r) => r.role === "image");
    const tables = session.tables();
    const preview = previewToml(tables, engineUrl, { imageAttached: !image || Boolean(image.bytes) });
    try {
      const out = await runtime.render(session.tomlText, { inline: inlineEl.checked, files });
      const shown = preview === session.tomlText && canInline === inlineEl.checked
        ? out : await runtime.render(preview, { inline: canInline, files });
      if (mine !== renderCount) return;     // a newer render is on its way
      html = out.html;
      setOk(true);
      showWarnings(out.warnings);
      statusEl.textContent = sizeText(html);
      const frame = document.createElement("iframe");
      frame.title = "Preview of the generated page";
      frame.srcdoc = shown.html;
      previewEl.replaceChildren(frame);
    } catch (e) {
      if (mine !== renderCount) return;
      setOk(false);
      showWarnings([]);
      previewEl.innerHTML = `<pre class="error-text gen-error">${esc(e && e.message ? e.message : e)}</pre>`;
      statusEl.textContent = "Failed";
    }
  };

  themeEl.addEventListener("change", () => {
    // A TOML that does not parse refuses the change: show the theme that stands.
    if (session.setTheme(themeEl.value)) refresh();
    else themeEl.value = session.theme;
  });
  inlineEl.addEventListener("change", refresh);
  downloadBtn.addEventListener("click", () => {
    if (ok) saveFile(html, `${stem}.webflash.html`, "text/html");
  });
  const copyBtn = body.querySelector("#gen-copy-link");
  copyBtn.addEventListener("click", async () => {
    const link = openInSiteUrl(session.board.engine_url || engineUrl, session.tomlText);
    try {
      await navigator.clipboard.writeText(link);
      copyBtn.textContent = "Link copied";
    } catch (e) {
      copyBtn.textContent = "Could not copy";
    }
    setTimeout(() => { copyBtn.textContent = "Copy link"; }, 1500);
  });
  body.querySelector("#gen-download-toml").addEventListener("click", () => {
    saveFile(session.tomlText, session.tomlName, "text/plain");
    session.emit("saved", { text: session.tomlText });
  });

  await refresh();
  return close;
}

// ── About ───────────────────────────────────────────────────────────

const LICENSES = [
  ["WebFlash", "GPL-3.0", REPO_URL],
  ["Klipper, Kalico, Katapult (built from their sources)", "GPL-3.0", "https://github.com/Klipper3d/klipper"],
  ["kconfiglib (in each project's sources)", "ISC", "https://github.com/ulfalizer/Kconfiglib"],
  ["Pyodide (the Python runtime)", "MPL-2.0", "https://pyodide.org"],
  ["LLVM: clang, lld and the LLVM tools", "Apache-2.0 WITH LLVM-exception", "https://llvm.org"],
  ["picolibc and compiler-rt (the firmware libraries)", "BSD-3-Clause, Apache-2.0 WITH LLVM-exception", "https://github.com/arm/arm-toolchain"],
  ["Emscripten runtime", "MIT", "https://emscripten.org"],
];

/**
 * The About box. sources says which snapshot is loaded, as the toolbar's
 * status does; toolchain (HTML) describes the compiler; extend(el) fills the
 * build section (the build panel's worker count and cache size);
 * onClearCache runs after Clear cache emptied the cache.
 */
export function openAbout({ sources = "", toolchain = "", extend = null, onClearCache = null } = {}) {
  const { body } = openModal("About WebFlash");
  const about = runtime.about();
  const row = (k, v) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`;
  body.innerHTML =
    `<p>WebFlash configures, builds and flashes Klipper, Kalico and Katapult firmware for ` +
    `3D printer boards from the browser. It runs <code>make menuconfig</code> with the ` +
    `project's own Kconfig files, compiles the firmware with clang and lld compiled to ` +
    `WebAssembly, and flashes it over USB. <strong>Generate</strong> turns a board TOML ` +
    `into a page you can embed in a documentation site.</p>` +
    `<p>Everything runs in your browser: nothing you configure or build is uploaded. The ` +
    `<code>webflash</code> command renders the same pages from a saved board TOML.</p>` +
    `<h3>Versions</h3><table class="about-table">` +
    row("WebFlash", about ? esc(about.webflash) : "loads with the Python runtime") +
    row("Python", about ? `${esc(about.python)} (Pyodide ${esc(about.pyodide)})` : `Pyodide ${esc(runtime.PYODIDE_VERSION)}, not loaded yet`) +
    row("Toolchain", toolchain || "loads with the first build") +
    row("Sources", sources ? esc(sources) : "a version's source snapshot loads when you configure it") +
    `</table>` +
    `<div id="about-build"></div>` +
    `<h3>Licenses</h3><table class="about-table">` +
    LICENSES.map(([what, license, url]) =>
      row(what, `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(license)}</a>`)).join("") +
    `</table>` +
    `<p class="about-links">` +
    `<a href="${DOCS_URL}" target="_blank" rel="noopener">Documentation</a>` +
    `<a href="${REPO_URL}" target="_blank" rel="noopener">Source on GitHub</a>` +
    `<button id="about-clear-cache" title="Forget the downloaded toolchain and sources, so the next use downloads them again">Clear cache</button>` +
    `</p>`;
  if (extend) extend(body.querySelector("#about-build"));
  const clear = body.querySelector("#about-clear-cache");
  clear.addEventListener("click", async () => {
    clear.disabled = true;
    clear.textContent = (await clearCache()) ? "Cache cleared" : "Nothing cached";
    if (onClearCache) await onClearCache();
    // What the cache holds now, where About shows it.
    if (extend) extend(body.querySelector("#about-build"));
  });
}

/** Show the About box once per browser, for someone arriving with no context. */
export function maybeShowAboutOnFirstVisit() {
  let seen = null;
  try { seen = localStorage.getItem(ABOUT_SEEN_KEY); } catch (e) { seen = "1"; }
  if (seen) return;
  try { localStorage.setItem(ABOUT_SEEN_KEY, "1"); } catch (e) { /* private window */ }
  openAbout();
}
