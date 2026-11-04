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
// got, for the top bar's status chip.
//
// Long work reports progress as it goes: call(method, params, {onProgress})
// receives that call's own progress ({phase, detail, done, total}, done and
// total in steps or bytes), and every listener of onProgress sees all of it.
// A call made with {long: true, signal} can be cancelled through the
// AbortSignal; the engine stops at its next check between steps.
//
// A generated page runs this module from /engine/v1/ on another site, so it
// names its own assets and payload with configure() before the first call,
// and the worker starts through toolchain-pool.js's startWorker, which takes
// a script from another origin.

import { startWorker } from "./build/toolchain-pool.js";

export const PYODIDE_VERSION = "v314.0.6";   // keep in step with engine-worker.js and PinConnect
export const PAYLOAD_NAME = "webflash.zip";

const WORKER_URL = new URL("./workers/engine-worker.js", import.meta.url);

// What configure() set: {assetsBase, payloadUrl}, each null for the site's own.
let _settings = { assetsBase: null, payloadUrl: null };
let _worker = null;
let _boot = null;
let _failure = null;
let _about = null;
let _nextId = 1;
const _pending = new Map();
const _listeners = [];

/**
 * Subscribe to progress: cb(phase, detail, info), info being {done, total,
 * call} (each may be undefined). Boot phases: runtime, package, ready, error.
 * Source phases: sources (downloading a core bundle, in bytes), extract.
 * Python adds its own (a build's steps).
 */
export function onProgress(cb) {
  _listeners.push(cb);
  return () => {
    const i = _listeners.indexOf(cb);
    if (i >= 0) _listeners.splice(i, 1);
  };
}

function emit(phase, detail = "", info = {}) {
  for (const cb of _listeners) {
    try { cb(phase, detail, info); } catch (e) { /* a bad listener must not stop boot */ }
  }
}

/**
 * For a page that is not the site (a generated page's embed runtime): where
 * toolchain/ and sources/ are, and the URL of webflash.zip, both absolute.
 * Call it before anything else; null keeps the site's own.
 */
export function configure({ assetsBase = null, payloadUrl = null } = {}) {
  _settings = { assetsBase, payloadUrl };
}

/**
 * Where the toolchain and the source snapshots come from, as an absolute URL
 * ending in "/". The local server names it in a <meta name="webflash-assets">
 * (empty: the server itself); the hosted site has no tag and serves them. A
 * generated page names it with configure().
 */
export function assetsBase() {
  let base = _settings.assetsBase;
  if (!base) {
    const meta = document.querySelector('meta[name="webflash-assets"]');
    const named = meta ? meta.getAttribute("content").trim() : "";
    base = named || new URL("./", document.baseURI).href;
  }
  return base.endsWith("/") ? base : `${base}/`;
}

function rejectAll(error) {
  for (const p of _pending.values()) p.reject(error);
  _pending.clear();
}

function spawn() {
  _worker = startWorker(WORKER_URL);
  _worker.addEventListener("message", (e) => {
    const msg = e.data || {};
    if (msg.progress) {
      const { phase, detail = "", done, total, call: callId } = msg.progress;
      const info = { done, total, call: callId };
      const own = callId !== undefined && _pending.get(callId);
      if (own && own.onProgress) {
        try { own.onProgress({ phase, detail, done, total }); } catch (err) { /* keep the call going */ }
      }
      emit(phase, detail, info);
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

function post(method, params, { onProgress = null, signal = null, long = false, transfer = [] } = {}) {
  return new Promise((resolve, reject) => {
    const id = _nextId++;
    const worker = _worker;
    let onAbort = null;
    const done = (fn) => (value) => {
      if (onAbort) signal.removeEventListener("abort", onAbort);
      fn(value);
    };
    _pending.set(id, { resolve: done(resolve), reject: done(reject), onProgress });
    worker.postMessage(long ? { id, method, params, long: true } : { id, method, params }, transfer);
    if (signal) {
      onAbort = () => worker.postMessage({ cancel: id });
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/** Resolves once webflash is importable in the worker. Safe to call repeatedly. */
export function ready() {
  if (!_boot) {
    _failure = null;
    if (!_worker) spawn();
    emit("runtime");
    const params = {
      payloadUrl: _settings.payloadUrl || new URL(PAYLOAD_NAME, document.baseURI).href,
      assetsOrigin: assetsBase(),
      // Only a generated page names its payload (configure()).
      embedded: Boolean(_settings.payloadUrl),
    };
    _boot = post("boot", [params]).then((about) => {
      _about = about;
      emit("ready");
      return about;
    }).catch((e) => {
      // Keep the rejected promise, so the calls waiting on this boot fail
      // with it rather than each one restarting the download. The next call
      // made after the failure starts over through retry() (see booted()).
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

// The boot a new call waits for: after a failed one, a fresh boot in a new
// worker, so Try again, a card's next Build, Generate and the theme list
// recover once the CDN or the payload answers again. retry() clears
// _failure at once, so calls made together restart it only once.
function booted() {
  return _failure ? retry() : ready();
}

/** True once webflash is importable, for callers that cannot await. */
export function isReady() { return _about !== null; }

/** Versions reported by the worker once booted: {webflash, python, pyodide}. */
export function about() { return _about; }

const TRACEBACK = "Traceback (most recent call last):";
const CHAINED = /^(During handling of the above exception, another exception occurred|The above exception was the direct cause of the following exception):$/;

/**
 * Turn a Python exception into something worth showing someone.
 *
 * Pyodide puts the whole traceback in .message, so the sentence bridge.py
 * raises on purpose ends up last, behind frames and virtual filesystem paths
 * the reader has never seen. Keep the final exception's whole message, every
 * line of it, without its class name and the frames before it. Text that is
 * not a traceback (the worker's own errors, or a message call() has already
 * turned into one) comes back as it is.
 */
export function pythonMessage(e) {
  const raw = (e && e.message ? e.message : String(e)).trim();
  if (!raw.startsWith(TRACEBACK)) return raw;
  const lines = raw.split("\n");
  let message = [];
  let i = 0;
  while (i < lines.length) {
    // A header, its frames (indented), then the exception's message, which
    // runs to the end or to the line that chains the next traceback on.
    i += 1;
    while (i < lines.length && (/^\s/.test(lines[i]) || !lines[i].trim())) i += 1;
    let end = lines.length;
    for (let j = i; j < lines.length; j++) {
      if (CHAINED.test(lines[j]) && !lines[j + 1] && lines[j + 2] === TRACEBACK) { end = j; break; }
    }
    message = lines.slice(i, end);
    i = end + 2;
  }
  const text = message.join("\n").trim();
  // Drop the exception class (dotted outside builtins), keep what it says.
  const body = text.replace(/^[A-Za-z_][\w.]*:[ \t]*/, "").trim();
  return body || text || raw;
}

/**
 * Call a function of the bridge (site/py/bridge.py), or one of the worker's
 * own (fetchBlob, loadSources), booting the worker first if needed, and
 * again if the last boot failed. params are its positional arguments:
 * strings, numbers, booleans, null, plain objects for the worker's own
 * methods, or typed arrays (Python bytes).
 * Rejects with the Python error's own message.
 *
 * Options: onProgress({phase, detail, done, total}) for this call's own
 * progress; long and signal for a call that can be cancelled; early to send
 * the call as soon as the boot has started rather than once it finished (the
 * worker's own downloads overlap the Python download that way); transfer,
 * the objects in params to move rather than copy (MessagePorts must move).
 */
export async function call(method, params = [], { onProgress = null, signal = null, long = false, early = false, transfer = [] } = {}) {
  const boot = booted();
  if (!early) await boot;
  else boot.catch(() => {});   // the call itself reports the failure
  try {
    return await post(method, params, { onProgress, signal, long, transfer });
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

// ── Sources and Kconfig (the engine's bridge methods) ─────────────
//
// The engine holds two configurations at once, by slot: "fw" (Klipper,
// Kalico, or Katapult alone) and "katapult" (Katapult beside a firmware).
// Every wrapper below takes {slot} (default "fw"); node ids in what comes
// back are prefixed with it ("fw:n12", "katapult:n4").

/** The slot a node id names ("katapult:n4" is katapult), else fallback. */
export function slotOf(id, fallback = "fw") {
  const m = /^(fw|katapult):/.exec(String(id || ""));
  return m ? m[1] : fallback;
}

/**
 * Make one ref of a project the tree a slot configures and builds: the
 * worker downloads its core bundle (Cache Storage keeps it), gunzips it and
 * hands it to bridge.load_sources. ref is the ref's entry in
 * sources/index.json, url the core bundle's URL, size its size from the
 * index's blobs table (the progress total; null when unknown). Resolves to
 * {slot, project, id, sha, tree, size, cached}; onProgress gets the download
 * in bytes.
 */
export async function loadSources(project, ref, url, { onProgress = null, size = null, slot = "fw" } = {}) {
  return JSON.parse(await call("loadSources", [project, ref, url, size, slot], { onProgress, early: true }));
}

/** Forget a slot's sources, configuration and build (Katapult unticked). */
export async function dropSlot(slot) {
  return JSON.parse(await call("drop_slot", [slot]));
}

/**
 * Load a .config or a defconfig into a slot's tree with olddefconfig
 * semantics ("" loads every default). Resolves to {missing: [[name, value]],
 * warnings: [text], tree, pair?}: missing are the assignments to symbols this
 * version does not have; pair (while the slots are paired) is as kconfigSet's.
 */
export async function kconfigLoad(configText, { slot = "fw" } = {}) {
  return JSON.parse(await call("kconfig_load", [slot, configText]));
}

/** A slot's Kconfig tree: {root, nodes: {id: node}} (SPEC 10 nodes). */
export async function kconfigTree({ slot = "fw" } = {}) {
  return JSON.parse(await call("kconfig_tree", [slot]));
}

/**
 * Set one symbol ("y"/"n" for a bool, the text for int, hex and string; a
 * choice is set by its node id and the member, or by its member with "y").
 * Resolves to the slot's new tree; rejects with the engine's reason for a
 * value it refuses. While the slots are paired the tree carries pair:
 * {notes: [what the other tree refused], offset: the offset link, trees:
 * {slot: tree} (the other slot's, when the set changed it)}.
 */
export async function kconfigSet(name, value, { slot = slotOf(name) } = {}) {
  return JSON.parse(await call("kconfig_set", [slot, name, value]));
}

/** A slot's full .config, as make olddefconfig writes it. */
export function kconfigConfig({ slot = "fw" } = {}) { return call("kconfig_config", [slot]); }

/** A slot's minimal configuration, as make savedefconfig writes it. */
export function kconfigDefconfig({ slot = "fw" } = {}) { return call("kconfig_defconfig", [slot]); }

/** One symbol's node, or null. */
export async function kconfigSymbol(name, { slot = "fw" } = {}) {
  return JSON.parse(await call("kconfig_symbol", [slot, name]));
}

/** The ids of a slot's nodes whose name, prompt or help mention text. */
export async function kconfigSearch(text, { slot = "fw" } = {}) {
  return JSON.parse(await call("kconfig_search", [slot, text]));
}

/**
 * The options the firmware and Katapult share, while both slots hold a
 * configuration: [{kind, name, prompt, type, fw: node id, katapult: node id,
 * members}].
 */
export async function pairShared() {
  return JSON.parse(await call("pair_shared"));
}

/**
 * Copy the firmware's shared values into Katapult and apply the offset link:
 * {notes, offset, trees: {fw, katapult}}.
 */
export async function pairSync() {
  return JSON.parse(await call("pair_sync"));
}

/**
 * Both slots' trees in one: {root: ["group:shared", "group:fw",
 * "group:katapult"], groups: [{id, title, root}], nodes, title, titles,
 * offset}. normalizeTree reads it like any tree (each group is a menu node).
 */
export async function pairTree() {
  return JSON.parse(await call("pair_tree"));
}

/** What a build of a slot's configuration needs: {dirs, libs: ["lib/<dir>", ...], missing, targets}. */
export async function plan(configText, { slot = "fw" } = {}) {
  return JSON.parse(await call("plan", [slot, configText]));
}

/** The flashing methods a configuration allows, best first: [{id, reason}]. */
export async function inferMethods(configText, { slot = "fw" } = {}) {
  return JSON.parse(await call("infer_methods", [slot, configText]));
}

/**
 * The bytes of a URL, through Cache Storage when its content is immutable
 * (source bundles, toolchain files), in the engine worker. size is the
 * file's size when known (the index's blobs table): Content-Length is not
 * (GitHub Pages compresses .gz files again in transit). Resolves to {bytes,
 * size, cached}.
 */
export function fetchBlob(url, { onProgress = null, phase = "download", detail = "", size = null } = {}) {
  return call("fetchBlob", [url, { phase, detail, size }], { onProgress, early: true });
}

// ── The build ───────────────────────────────────────────────────────

/** Extract one lib/<dir> bundle (gzipped or not) into a slot's tree: {name, files}. */
export async function addLib(name, bytes, { slot = "fw" } = {}) {
  return JSON.parse(await call("add_lib", [slot, name, bytes]));
}

/** Tell the engine which toolchain release the workers run (its manifest): {id, llvm}. */
export async function setToolchain(manifest) {
  return JSON.parse(await call("set_toolchain", [JSON.stringify(manifest)]));
}

/**
 * Hand the toolchain workers' MessagePorts (ToolchainPool.ports()) to the
 * engine worker, which sends the build's compiler jobs to them directly.
 */
export function attachToolchain(ports) {
  return call("attachToolchain", [ports], { transfer: ports });
}

/** Fail every toolchain job running or waiting (the workers are being stopped). */
export function detachToolchain(reason) {
  return call("detachToolchain", [reason]);
}

/** Resolves once no toolchain job is running or waiting. */
export function toolchainIdle() {
  return call("toolchainIdle");
}

/**
 * Build a slot's configuration with the attached toolchain workers. Resolves
 * to the bridge's result ({slot, outputs: {name: size}, memory, log,
 * duration, version, config, defconfig, project, mcu, app_address, ...});
 * progress goes to onProgress; aborting signal stops the build at its next
 * step. Afterwards the slot's Kconfig holds the built .config (every symbol
 * pinned): load its defconfig again before configuring on.
 */
export async function build(configText, version, jobs, { onProgress = null, signal = null, slot = "fw" } = {}) {
  return JSON.parse(await call("build", [slot, configText, version || "", jobs], { onProgress, signal, long: true }));
}

/** One output file of a slot's last build, as a Uint8Array (transferred, not copied). */
export function buildOutput(name, { slot = "fw" } = {}) {
  return call("build_output", [slot, name]);
}
