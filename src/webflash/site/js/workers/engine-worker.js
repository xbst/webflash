// The engine worker: Pyodide and the webflash package, behind a JSON RPC.
//
// Everything Python runs here, so building, configuring and rendering never
// block the page. Messages in are {id, method, params, long?}, params being
// the positional arguments; each gets {id, result} or {id, error} back, in
// any order, and the worker posts {progress: {phase, detail, done?, total?,
// call?}} while it works: done and total count steps or bytes, call is the id
// of the call the progress belongs to when the worker knows it. {cancel: id}
// asks a call that was sent with long: true (a build) to stop: Python sees it
// through webflash_js.cancelled() at its next check, so it only lands
// between steps that await.
//
// "boot" comes first, with {payloadUrl, assetsOrigin, pyodideBase?}: the URL
// of webflash.zip (the caller resolves it, since this module is also loaded
// from /engine/v1/ by generated pages), where the toolchain and the sources
// come from ("" for the page's own origin), and optionally another Pyodide.
// Every other method is either one of this worker's own (fetchBlob,
// loadSources: downloads, which JavaScript does better than Python) or a
// function of site/py/bridge.py, called with params as its arguments:
// strings and numbers as they are, typed arrays as Python bytes. Results
// come back as the bridge returns them (JSON text or text); a bridge
// function may also be async (a coroutine), and is awaited.
//
// Python code reports progress through the "webflash_js" module this worker
// registers: webflash_js.progress(phase, detail, done=None, total=None) and
// webflash_js.cancelled().
//
// The build's compiler commands go through webflash_js.run_tool(spec_json,
// files), the hook the engine's JsToolchain calls: spec_json is {argv, cwd,
// env, symlinks}, files the generated inputs ({absolute path: bytes}), and
// the promise resolves to {code, stdout, stderr, outputs, time, memory}. The
// jobs go straight to the toolchain workers, over the MessagePorts the page
// hands this worker with attachToolchain (js/build/toolchain-pool.js starts
// the workers); detachToolchain fails every job still running or waiting,
// which is how a cancelled build stops waiting for workers that were
// terminated.

import { fetchBlob, gunzip } from "./blob-cache.js";
import { Dispatcher } from "../build/toolchain-pool.js";

export const PYODIDE_VERSION = "v314.0.6";   // keep in step with runtime.js and PinConnect

const DEFAULT_PYODIDE_BASE = `https://cdn.jsdelivr.net/pyodide/${PYODIDE_VERSION}/full/`;
const ROOT_DIR = "/webflash";
const PKG_DIR = `${ROOT_DIR}/pkg`;

let py = null;
let bridge = null;
let booting = null;
let toBytes = null;

// The call whose code is running (best effort once Python awaits: progress
// then names the newest call), and the long call a cancel applies to.
let currentCall = null;
let longCall = null;
const cancelled = new Set();

function progress(phase, detail = "", done = null, total = null, call = currentCall) {
  const p = { phase, detail };
  if (Number.isFinite(done)) p.done = done;
  if (Number.isFinite(total)) p.total = total;
  if (call !== null && call !== undefined) p.call = call;
  postMessage({ progress: p });
}

// The toolchain workers' job queue, once the page attached them.
const toolchain = new Dispatcher();

// files from Python: a plain object of path -> Uint8Array (JsToolchain
// converts its dict with to_js), or a dict proxy, or a Map.
function jobFiles(files) {
  if (!files) return {};
  if (typeof files.toJs === "function") return files.toJs({ dict_converter: Object.fromEntries });
  if (files instanceof Map) return Object.fromEntries(files);
  return files;
}

/**
 * webflash_js.run_tool(spec_json, files): one tool invocation on the next
 * free toolchain worker. Resolves to {code, stdout, stderr, outputs: {path:
 * Uint8Array}, time, memory}; rejects when no toolchain is attached or the
 * workers were stopped.
 */
function runTool(specJson, files) {
  let spec;
  try {
    spec = JSON.parse(String(specJson));
  } catch (e) {
    return Promise.reject(new Error(`run_tool: the spec is not JSON (${e.message})`));
  }
  return toolchain.run({
    argv: spec.argv, cwd: spec.cwd, env: spec.env || {}, symlinks: spec.symlinks || {}, files: jobFiles(files),
  });
}

// webflash_js.progress from Python: positional (phase, detail, done, total),
// or keyword arguments, which Pyodide passes as a trailing object.
function pyProgress(phase, detail, done, total) {
  if (done && typeof done === "object") ({ done = null, total = null } = done);
  else if (detail && typeof detail === "object") ({ detail = "", done = null, total = null } = detail);
  progress(String(phase), detail == null ? "" : String(detail),
           done == null ? null : Number(done), total == null ? null : Number(total));
}

async function boot({ payloadUrl, assetsOrigin = "", pyodideBase = DEFAULT_PYODIDE_BASE } = {}) {
  if (!payloadUrl) throw new Error("boot needs the payload's URL");
  progress("runtime");
  let loadPyodide;
  try {
    ({ loadPyodide } = await import(`${pyodideBase}pyodide.mjs`));
  } catch (e) {
    throw new Error(
      "Could not download the Python runtime from cdn.jsdelivr.net. Check your " +
      "network or allowlist that host, or use the webflash command line tool."
    );
  }
  py = await loadPyodide({ indexURL: pyodideBase });

  progress("package");
  const resp = await fetch(payloadUrl, { cache: "no-store" });
  if (!resp.ok) {
    throw new Error(
      `Could not load ${payloadUrl} (HTTP ${resp.status}). If you are serving ` +
      "the site yourself, run python -m webflash.payload <site folder>/webflash.zip " +
      "first, or open it with the webflash command, which serves it for you."
    );
  }
  const bytes = new Uint8Array(await resp.arrayBuffer());

  // Extract with Python's own zipfile rather than a Pyodide helper, so this
  // depends only on the filesystem API, which is stable across releases.
  py.FS.mkdirTree(ROOT_DIR);
  py.FS.writeFile(`${ROOT_DIR}/payload.zip`, bytes);
  py.registerJsModule("webflash_js", {
    progress: pyProgress,
    cancelled: () => longCall !== null && cancelled.has(longCall),
    run_tool: runTool,
  });
  py.runPython(`
import sys, zipfile
with zipfile.ZipFile("${ROOT_DIR}/payload.zip") as z:
    z.extractall("${PKG_DIR}")
if "${PKG_DIR}" not in sys.path:
    sys.path.insert(0, "${PKG_DIR}")
`);
  bridge = py.pyimport("bridge");
  toBytes = py.runPython("lambda data: data.to_bytes()");
  const about = JSON.parse(bridge.init(assetsOrigin));
  return { ...about, pyodide: py.version };
}

// Typed arrays become Python bytes; everything else crosses as Pyodide
// converts it (strings, numbers, booleans and null as themselves).
function toPython(value) {
  if (value instanceof ArrayBuffer) value = new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return toBytes(value);
  return value;
}

function release(value) {
  if (value && typeof value.destroy === "function") {
    try { value.destroy(); } catch (e) { /* already gone */ }
  }
}

function fromPython(value) {
  if (value && typeof value.toJs === "function") {
    try { return value.toJs(); } finally { release(value); }
  }
  return value;
}

async function callBridge(method, params) {
  const fn = bridge[method];
  if (typeof fn !== "function") {
    release(fn);
    throw new Error(`Unknown engine method: ${method}`);
  }
  const args = params.map(toPython);
  try {
    let result = fn(...args);
    // An async bridge function returns an awaitable proxy: wait for it.
    if (result && typeof result.then === "function") result = await result;
    return fromPython(result);
  } finally {
    args.forEach(release);
    release(fn);
  }
}

// ── The worker's own methods ─────────────────────────────────────────

// Bytes go back to the page without a copy.
class Transfer {
  constructor(value, buffers) {
    this.value = value;
    this.buffers = buffers;
  }
}

const OWN = {
  /**
   * {bytes, size, cached} for a URL, through Cache Storage when it is
   * content-addressed. size is the file's size when the caller knows it
   * (sources/index.json's blobs table), for the progress total.
   */
  async fetchBlob(id, [url, { phase = "download", detail = "", size = null } = {}]) {
    const out = await fetchBlob(url, { size, onProgress: (done, total) => progress(phase, detail, done, total, id) });
    return new Transfer(out, [out.bytes.buffer]);
  },

  /**
   * Download a ref's core bundle (cached), gunzip it here, and hand the tar
   * to bridge.load_sources(project, ref_json, tar_bytes). ref is the ref's
   * entry from sources/index.json, url the core bundle's URL, size its size
   * from the index (or null). Resolves to the bridge's JSON plus the bundle's
   * size and whether it came from the cache.
   */
  async loadSources(id, [project, ref, url, size = null]) {
    const label = `${project} ${ref && ref.id ? ref.id : ""}`.trim();
    const blob = await fetchBlob(url, { size, onProgress: (done, total) => progress("sources", label, done, total, id) });
    progress("extract", label, null, null, id);
    const tar = await gunzip(blob.bytes);
    await booting;
    const out = JSON.parse(await callBridge("load_sources", [project, JSON.stringify(ref), tar]));
    return JSON.stringify({ ...out, size: blob.size, cached: blob.cached });
  },

  /**
   * Take the toolchain workers' MessagePorts (transferred with the call):
   * run_tool's jobs go to them from now on. Resolves to {workers}.
   */
  attachToolchain(id, [ports = []]) {
    toolchain.attach(ports);
    return { workers: toolchain.size };
  },

  /** Let go of the toolchain workers: every job running or waiting fails with reason. */
  detachToolchain(id, [reason = "the build was cancelled"]) {
    toolchain.detach(reason);
    return true;
  },

  /** Resolves once no toolchain job is running or waiting (a failed build's stragglers). */
  async toolchainIdle() {
    await toolchain.whenIdle();
    return true;
  },

  /** Per worker: {jobs, busy, main, peakMemory} as seen from here; reset clears them. */
  toolchainStats(id, [reset = false]) {
    const stats = toolchain.stats.map((s) => ({ ...s }));
    if (reset) toolchain.stats = toolchain.stats.map(() => ({ jobs: 0, busy: 0, main: 0, peakMemory: 0 }));
    return stats;
  },
};

async function handle(id, method, params) {
  if (method === "boot") {
    if (!booting) booting = boot(params[0]);
    return booting;
  }
  if (!booting) throw new Error("The engine has not been booted.");
  if (Object.prototype.hasOwnProperty.call(OWN, method)) return OWN[method](id, params);
  await booting;
  currentCall = id;
  return callBridge(method, params);
}

self.addEventListener("message", async (event) => {
  const data = event.data || {};
  if (data.cancel !== undefined) {
    cancelled.add(data.cancel);
    return;
  }
  const { id, method, params = [], long = false } = data;
  if (id === undefined || typeof method !== "string") return;
  if (long) longCall = id;
  try {
    const result = await handle(id, method, Array.isArray(params) ? params : [params]);
    if (result instanceof Transfer) postMessage({ id, result: result.value }, result.buffers);
    // Bytes from Python (build_output) arrive as a fresh Uint8Array: hand it over.
    else if (ArrayBuffer.isView(result)) postMessage({ id, result }, [result.buffer]);
    else postMessage({ id, result });
  } catch (e) {
    postMessage({ id, error: e && e.message ? e.message : String(e) });
  } finally {
    cancelled.delete(id);
    if (longCall === id) longCall = null;
    if (currentCall === id) currentCall = null;
  }
});
