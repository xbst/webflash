// The engine worker: Pyodide and the webflash package, behind a JSON RPC.
//
// Everything Python runs here, so building, configuring and rendering never
// block the page. Messages in are {id, method, params}, params being the
// positional arguments; each gets {id, result} or {id, error} back, in any
// order, and the worker posts {progress: {phase, detail}} while it works.
//
// "boot" comes first, with {payloadUrl, assetsOrigin, pyodideBase?}: the URL
// of webflash.zip (the caller resolves it, since this module is also loaded
// from /engine/v1/ by generated pages), where the toolchain and the sources
// come from ("" for the page's own origin), and optionally another Pyodide.
// Every other method is a function of site/py/bridge.py, called with params
// as its arguments: strings and numbers as they are, typed arrays as Python
// bytes. Results come back as the bridge returns them (JSON text or text).
//
// Python code reports progress through the "webflash_js" module this worker
// registers: webflash_js.progress(phase, detail).

export const PYODIDE_VERSION = "v314.0.6";   // keep in step with runtime.js and PinConnect

const DEFAULT_PYODIDE_BASE = `https://cdn.jsdelivr.net/pyodide/${PYODIDE_VERSION}/full/`;
const ROOT_DIR = "/webflash";
const PKG_DIR = `${ROOT_DIR}/pkg`;

let py = null;
let bridge = null;
let booting = null;
let toBytes = null;

function progress(phase, detail = "") {
  postMessage({ progress: { phase, detail } });
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
    progress: (phase, detail) => progress(String(phase), detail == null ? "" : String(detail)),
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

async function handle(method, params) {
  if (method === "boot") {
    if (!booting) booting = boot(params[0]);
    return booting;
  }
  if (!booting) throw new Error("The engine has not been booted.");
  await booting;
  const fn = bridge[method];
  if (typeof fn !== "function") {
    release(fn);
    throw new Error(`Unknown engine method: ${method}`);
  }
  const args = params.map(toPython);
  try {
    return fromPython(fn(...args));
  } finally {
    args.forEach(release);
    release(fn);
  }
}

self.addEventListener("message", async (event) => {
  const { id, method, params = [] } = event.data || {};
  if (id === undefined || typeof method !== "string") return;
  try {
    const result = await handle(method, Array.isArray(params) ? params : [params]);
    postMessage({ id, result });
  } catch (e) {
    postMessage({ id, error: e && e.message ? e.message : String(e) });
  }
});
