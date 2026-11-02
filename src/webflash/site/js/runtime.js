// Runs webflash in the page, under Pyodide, in the engine worker.
//
// The site does not reimplement the renderer, the loaders or the build
// engine: it loads the webflash package into Pyodide and calls it, so Generate
// gives the same bytes as the `webflash` command. Python runs in a Web Worker
// (workers/engine-worker.js) and is reached through a JSON RPC: call(method,
// params) posts {id, method, params} and resolves with the result.
//
// Nothing heavy downloads at page load: the first call boots the worker
// (Pyodide from the CDN, then webflash.zip), and onProgress reports how far it
// got, for the toolbar's status.

export const PYODIDE_VERSION = "v314.0.6";   // keep in step with engine-worker.js and PinConnect
export const PAYLOAD_NAME = "webflash.zip";

const WORKER_URL = new URL("./workers/engine-worker.js", import.meta.url);

let _worker = null;
let _boot = null;
let _failure = null;
let _about = null;
let _nextId = 1;
const _pending = new Map();
const _listeners = [];

/** Subscribe to boot progress. Phases: runtime, package, ready, error. */
export function onProgress(cb) {
  _listeners.push(cb);
  return () => {
    const i = _listeners.indexOf(cb);
    if (i >= 0) _listeners.splice(i, 1);
  };
}

function emit(phase, detail = "") {
  for (const cb of _listeners) {
    try { cb(phase, detail); } catch (e) { /* a bad listener must not stop boot */ }
  }
}

/**
 * Where the toolchain and the source snapshots come from, as an absolute URL
 * ending in "/". The local server names it in a <meta name="webflash-assets">
 * (empty: the server itself); the hosted site has no tag and serves them.
 */
export function assetsBase() {
  const meta = document.querySelector('meta[name="webflash-assets"]');
  const named = meta ? meta.getAttribute("content").trim() : "";
  const base = named || new URL("./", document.baseURI).href;
  return base.endsWith("/") ? base : `${base}/`;
}

function rejectAll(error) {
  for (const p of _pending.values()) p.reject(error);
  _pending.clear();
}

function spawn() {
  _worker = new Worker(WORKER_URL, { type: "module" });
  _worker.addEventListener("message", (e) => {
    const msg = e.data || {};
    if (msg.progress) {
      emit(msg.progress.phase, msg.progress.detail);
      return;
    }
    const p = _pending.get(msg.id);
    if (!p) return;
    _pending.delete(msg.id);
    if ("error" in msg) p.reject(new Error(msg.error));
    else p.resolve(msg.result);
  });
  // A worker that cannot even load (a syntax error, a blocked script) only
  // ever fires this: fail what waits rather than leave it hanging.
  _worker.addEventListener("error", (e) => {
    e.preventDefault();
    rejectAll(new Error(`The engine worker could not start: ${e.message || "script error"}`));
  });
}

function post(method, params) {
  return new Promise((resolve, reject) => {
    const id = _nextId++;
    _pending.set(id, { resolve, reject });
    _worker.postMessage({ id, method, params });
  });
}

/** Resolves once webflash is importable in the worker. Safe to call repeatedly. */
export function ready() {
  if (!_boot) {
    _failure = null;
    if (!_worker) spawn();
    emit("runtime");
    const params = {
      payloadUrl: new URL(PAYLOAD_NAME, document.baseURI).href,
      assetsOrigin: assetsBase(),
    };
    _boot = post("boot", [params]).then((about) => {
      _about = about;
      emit("ready");
      return about;
    }).catch((e) => {
      // Keep the rejected promise so a blocked CDN does not restart the whole
      // download on every call. Recovery goes through retry().
      _failure = e;
      emit("error", e && e.message ? e.message : String(e));
      throw e;
    });
  }
  return _boot;
}

/** Discard a failed boot (and its worker) and start over, for a Retry control. */
export function retry() {
  if (_worker) _worker.terminate();
  _worker = null;
  _boot = null;
  rejectAll(new Error("The engine was restarted."));
  return ready();
}

export function failure() { return _failure; }

/** True once webflash is importable, for callers that cannot await. */
export function isReady() { return _about !== null; }

/** Versions reported by the worker once booted: {webflash, python, pyodide}. */
export function about() { return _about; }

/**
 * Turn a Python exception into something worth showing someone.
 *
 * Pyodide puts the whole traceback in .message, so the sentence bridge.py
 * raises on purpose ends up last, behind frames and virtual filesystem paths
 * the reader has never seen. Keep the final line, which is the message.
 */
export function pythonMessage(e) {
  const raw = (e && e.message ? e.message : String(e)).trim();
  if (!raw.includes("Traceback (most recent call last)")) return raw;
  const lines = raw.split("\n").filter((l) => l.trim() && !/^\s+/.test(l));
  const last = lines[lines.length - 1] || raw;
  // Drop the exception class, keep what it says. Multi-line messages keep
  // their tail, which is where bridge.py puts the actionable half.
  const body = last.replace(/^\w[\w.]*(Error|Exception):\s*/, "");
  const tail = raw.slice(raw.indexOf(last) + last.length).trim();
  return tail ? `${body}\n${tail}` : body;
}

/**
 * Call a function of the bridge (site/py/bridge.py) in the worker, booting it
 * first if needed. params are its positional arguments: strings, numbers,
 * booleans, null, or typed arrays (Python bytes). Rejects with the Python
 * error's own message.
 */
export async function call(method, params = []) {
  await ready();
  try {
    return await post(method, params);
  } catch (e) {
    throw new Error(pythonMessage(e));
  }
}

// ── The bridge's functions, typed ───────────────────────────────────

/** Bundled themes as [{name, display}], default first. */
export async function themeCatalog() {
  return JSON.parse(await call("theme_catalog"));
}

/** The loader's view of a board TOML: {errors, warnings, board}. */
export async function checkBoard(tomlText) {
  return JSON.parse(await call("check_board", [tomlText]));
}

/** A board TOML written fresh from the session's tables. */
export async function saveToml(tables) {
  return call("save_toml", [JSON.stringify(tables)]);
}

/**
 * Render a board TOML to its page, as `webflash board.toml [-t theme] [-i]`.
 * files maps the names the TOML gives its image and firmware file to their
 * base64 data. Resolves to {html, warnings}.
 */
export async function render(tomlText, { themeName = "", inline = false, files = {} } = {}) {
  const out = JSON.parse(await call("render", [tomlText, themeName, JSON.stringify({ inline, files })]));
  return { html: out.html, warnings: out.warnings || [] };
}
