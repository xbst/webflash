// A toolchain worker: one copy of the WebAssembly LLVM (chunk 02's
// toolchain.js and llvm.js) running a build's compiler commands, one at a
// time. The pool (js/build/toolchain-pool.js) starts several and the engine
// worker sends each its jobs directly, over a MessagePort, so a compile never
// waits on the page's main thread.
//
// Messages in are {type, id, ...}; each is answered {type: "reply", id,
// result} or {type: "reply", id, error} on the channel it came in on:
//
//   init   {manifestUrl, files, reuse?}: load the toolchain release whose
//          manifest.json is at manifestUrl. files holds the release files
//          the pool downloaded ({name: Uint8Array}: manifest.json,
//          toolchain.js, llvm.js, llvm.wasm.gz, sysroot.tar.gz), used instead
//          of the network; anything else the release asks for (the libc++
//          headers, on the first clang++) comes through Cache Storage. The
//          module is compiled once here. reuse runs every job on one
//          long-lived instance (toolchain.js's runReusing) instead of a fresh
//          instance per job.
//   mount  {tree, bundles: [{key, bytes}]}: the source tree the engine
//          builds, at the absolute path the engine extracted it to
//          (/webflash/src/<project>/<sha>). Each bundle is a tar, gzipped or
//          not (the core bundle and the lib bundles); one already mounted
//          under the same key is skipped, and another tree path starts over.
//   run    {job: {argv, cwd, env, files, symlinks}}: one tool invocation, the
//          engine's run_tool spec: argv[0] a tool name, sysroot paths
//          /sysroot/..., files the generated inputs under out/ ({absolute
//          path: Uint8Array}), symlinks {absolute link: absolute target} (the
//          out/board links). The tree, the job's files and the symlinks are
//          mounted, the parent folders of the outputs are created (the tools
//          create none, make's mkdir -p did), and the result is {code,
//          stdout, stderr, outputs: {absolute path: Uint8Array}, time,
//          memory} with every file the tool wrote, the outputs' buffers
//          transferred.
//   stats  {reset?}: {jobs, busy, main, peakMemory, timeline} for this worker.
//   dispose: drop the long-lived instance of reuse mode.
//   port   {port}: a MessagePort to take messages on as well (no reply).
//
// Inputs move rather than copy: the job's files arrive transferred and
// toolchain.js mounts them without copying; the tree's files are views into
// the bundles' tar buffers.

import { readTar } from "../build/tar.js";
import { fetchBlob, gunzip } from "./blob-cache.js";

const TIMELINE_LIMIT = 4000;

/** Absolute, normalized POSIX path: relative paths are taken from cwd. */
export function absolute(path, cwd = "/") {
  let p = String(path).replace(/\\/g, "/");
  if (!p.startsWith("/")) p = `${cwd.endsWith("/") ? cwd : `${cwd}/`}${p}`;
  const parts = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function parentOf(path) {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

/**
 * The folders a command's outputs go to, which must exist before it runs:
 * the parent of the -o argument, and of every path under the tree's out/
 * that the command names (an output given positionally, as llvm-objcopy
 * takes it). An input's folder is created anyway, so naming one is harmless.
 */
export function outputDirs(argv, cwd) {
  const dirs = new Set();
  const outRoot = absolute("out", cwd);
  const add = (p) => {
    if (!p || p.startsWith("-")) return;
    const parent = parentOf(absolute(p, cwd));
    if (parent !== "/" && parent !== cwd) dirs.add(parent);
  };
  const underOut = (p) => {
    if (!p || p.startsWith("-")) return false;
    const abs = absolute(p, cwd);
    return abs === outRoot || abs.startsWith(`${outRoot}/`);
  };
  for (let i = 1; i < argv.length; i++) {
    const a = String(argv[i]);
    if (a === "-o" || a === "-MF") {
      add(argv[i + 1]);
      i++;
      continue;
    }
    // A path inside an option: --script=out/x.ld, -Wl,-Map=out/x.map, -Iout/.
    const candidates = [a, ...a.split(","), a.slice(a.indexOf("=") + 1)];
    for (const c of candidates) if (underOut(c)) add(c);
  }
  return [...dirs].sort();
}

/** A view that owns its whole buffer, so the buffer can be transferred. */
export function exact(view) {
  if (!(view instanceof Uint8Array)) view = ArrayBuffer.isView(view)
    ? new Uint8Array(view.buffer, view.byteOffset, view.byteLength) : new Uint8Array(view);
  if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength &&
      !(typeof SharedArrayBuffer !== "undefined" && view.buffer instanceof SharedArrayBuffer)) return view;
  return view.slice();
}

function isGzip(bytes) {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

// What toolchain.js's fetch needs of a Response, for bytes already in hand.
function response(bytes) {
  return {
    ok: true,
    status: 200,
    body: null,
    headers: { get: () => null },
    arrayBuffer: async () => exact(bytes).buffer,
    text: async () => new TextDecoder().decode(bytes),
    json: async () => JSON.parse(new TextDecoder().decode(bytes)),
  };
}

/**
 * Import an ES module from bytes in hand (through a Blob URL, so it comes
 * from Cache Storage rather than the network), else from its URL: Node, and
 * a page whose policy forbids blob: scripts, import the URL itself.
 */
async function importModule(url, bytes) {
  const href = String(url && url.href ? url.href : url);
  if (bytes && typeof Blob === "function" && typeof URL.createObjectURL === "function") {
    const blobUrl = URL.createObjectURL(new Blob([bytes], { type: "text/javascript" }));
    try {
      return await import(/* webpackIgnore: true */ blobUrl);
    } catch (e) {
      /* fall through to the URL */
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }
  return import(/* webpackIgnore: true */ href);
}

function errorText(e) {
  return e && e.message ? e.message : String(e);
}

/** The worker's state and its answers to each message, without the messaging. */
export class ToolchainHost {
  constructor() {
    this.tc = null;
    this.id = null;
    this.reuse = false;
    this.tree = { path: null, files: new Map(), keys: new Set() };
    this._queue = Promise.resolve();
    this.resetStats();
  }

  resetStats() {
    this.stats = { jobs: 0, failed: 0, busy: 0, main: 0, peakMemory: 0, timeline: [] };
  }

  // Everything but stats runs in arrival order: a job never starts before the
  // init and the mounts sent ahead of it are done.
  _serial(fn) {
    const run = this._queue.then(fn, fn);
    this._queue = run.catch(() => {});
    return run;
  }

  async init({ manifestUrl, files = {}, reuse = false } = {}) {
    if (!manifestUrl) throw new Error("init needs the manifest's URL");
    const started = now();
    const base = new URL(String(manifestUrl), typeof location !== "undefined" ? location.href : undefined);
    const dir = new URL("./", base).href;
    const given = new Map(Object.entries(files || {}).map(([name, bytes]) => [name, bytes ? exact(bytes) : bytes]));
    const nameOf = (url) => {
      const href = new URL(String(url && url.href ? url.href : url), base).href;
      return href.startsWith(dir) ? decodeURIComponent(href.slice(dir.length)) : null;
    };
    const fetchFn = async (url) => {
      const name = nameOf(url);
      let bytes = name !== null ? given.get(name) : undefined;
      if (bytes === undefined) bytes = (await fetchBlob(new URL(String(url), base).href)).bytes;
      return response(bytes);
    };
    const mod = await importModule(new URL("toolchain.js", base), given.get("toolchain.js"));
    if (typeof mod.createToolchain !== "function") throw new Error("toolchain.js does not export createToolchain");
    this.tc = await mod.createToolchain({
      manifestUrl: base.href,
      fetch: fetchFn,
      importModule: (url) => importModule(url, given.get(nameOf(url))),
    });
    // The compiled module and the parsed sysroot are kept; the downloaded
    // bytes are not needed any more.
    given.clear();
    this.id = this.tc.id;
    this.reuse = Boolean(reuse);
    return { id: this.tc.id, tools: this.tc.tools, sysrootEntries: this.tc.sysrootEntries, ms: Math.round(now() - started) };
  }

  async mount({ tree, bundles = [] } = {}) {
    if (!tree) throw new Error("mount needs the tree's path");
    const path = absolute(tree);
    if (this.tree.path !== path) this.tree = { path, files: new Map(), keys: new Set() };
    let added = 0;
    for (const bundle of bundles) {
      const key = String(bundle.key);
      if (this.tree.keys.has(key)) continue;
      let bytes = exact(bundle.bytes);
      if (isGzip(bytes)) bytes = await gunzip(bytes);
      for (const entry of readTar(bytes)) {
        if (entry.type !== "file") continue;
        const rel = entry.name;
        if (rel.startsWith("/") || rel.split("/").includes("..")) {
          throw new Error(`the bundle ${key} holds a path outside the tree: ${rel}`);
        }
        this.tree.files.set(`${path}/${rel}`, entry.data);
        added++;
      }
      this.tree.keys.add(key);
    }
    return { tree: path, files: this.tree.files.size, added, keys: [...this.tree.keys] };
  }

  async run({ job } = {}) {
    if (!this.tc) throw new Error("the toolchain is not loaded (init first)");
    const { argv, cwd = this.tree.path || "/", env = {}, files = {}, symlinks = {} } = job || {};
    if (!Array.isArray(argv) || !argv.length) throw new Error("run: argv must be a non-empty list");
    const base = absolute(cwd);
    if (this.tree.path && base !== this.tree.path && !base.startsWith(`${this.tree.path}/`)) {
      throw new Error(`the job runs in ${base}, but the tree mounted here is ${this.tree.path}`);
    }
    const mounted = new Map(this.tree.files);
    for (const [path, data] of files instanceof Map ? files : Object.entries(files)) {
      mounted.set(absolute(path, base), data instanceof Uint8Array ? data : exact(data));
    }
    for (const [link, target] of Object.entries(symlinks || {})) {
      mounted.set(absolute(link, base), { symlink: String(target) });
    }
    const dirs = outputDirs(argv, base);
    const startedAt = wallClock();
    const started = now();
    const runFn = this.reuse ? this.tc.runReusing : this.tc.run;
    const r = await runFn({ argv: argv.map(String), cwd: base, env, files: mounted, dirs });
    const elapsed = now() - started;
    const outputs = {};
    for (const [path, data] of r.outputs) outputs[path] = exact(data);
    const s = this.stats;
    s.jobs++;
    if (r.code !== 0) s.failed++;
    s.busy += elapsed;
    s.main += r.time || 0;
    s.peakMemory = Math.max(s.peakMemory, r.memory || 0);
    if (s.timeline.length < TIMELINE_LIMIT) {
      const out = argv.indexOf("-o") >= 0 ? argv[argv.indexOf("-o") + 1] : argv[argv.length - 1];
      s.timeline.push({ tool: String(argv[0]), out: String(out), start: startedAt, ms: Math.round(elapsed), main: Math.round(r.time || 0), memory: r.memory || 0, code: r.code });
    }
    return {
      result: { code: r.code, stdout: r.stdout, stderr: r.stderr, outputs, time: r.time, memory: r.memory, ms: elapsed },
      transfer: Object.values(outputs).map((v) => v.buffer),
    };
  }

  /** The answer to one message: {result, transfer?}. */
  handle(msg) {
    switch (msg.type) {
      case "init": return this._serial(() => this.init(msg)).then((result) => ({ result }));
      case "mount": return this._serial(() => this.mount(msg)).then((result) => ({ result }));
      case "run": return this._serial(() => this.run(msg));
      case "dispose":
        return this._serial(async () => {
          if (this.tc && this.tc.dispose) this.tc.dispose();
          return { result: true };
        });
      case "stats": {
        const result = { ...this.stats, timeline: [...this.stats.timeline], id: this.id, files: this.tree.files.size };
        if (msg.reset) this.resetStats();
        return Promise.resolve({ result });
      }
      default:
        return Promise.reject(new Error(`unknown message type ${msg.type}`));
    }
  }
}

function now() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

// Milliseconds since the epoch, comparable between workers for a timeline.
function wallClock() {
  return typeof performance !== "undefined" && performance.timeOrigin ? performance.timeOrigin + performance.now() : Date.now();
}

/**
 * Answer the protocol on a scope (the worker's global scope, or a fake one in
 * tests) and on every MessagePort handed over with {type: "port"}. Returns
 * the host.
 */
export function serve(scope) {
  const host = new ToolchainHost();
  const listen = (endpoint, reply) => {
    endpoint.addEventListener("message", async (event) => {
      const msg = event.data;
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "port") {
        if (msg.port) {
          listen(msg.port, (m, t) => msg.port.postMessage(m, t));
          if (typeof msg.port.start === "function") msg.port.start();
        }
        return;
      }
      try {
        const { result, transfer = [] } = await host.handle(msg);
        reply({ type: "reply", id: msg.id, result }, transfer);
      } catch (e) {
        reply({ type: "reply", id: msg.id, error: errorText(e) });
      }
    });
  };
  listen(scope, (m, t) => scope.postMessage(m, t));
  return host;
}

// Started as a worker: answer on its own scope.
if (typeof WorkerGlobalScope === "function" && globalThis instanceof WorkerGlobalScope) {
  serve(globalThis);
}
