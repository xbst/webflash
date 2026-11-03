// The toolchain workers of a build, and the job queue in front of them.
//
// A build runs the project's compiler commands in N toolchain workers
// (workers/toolchain-worker.js), each holding its own copy of the
// WebAssembly LLVM and of the source tree. GitHub Pages cannot send the
// headers SharedArrayBuffer needs, so there are no threads inside a worker:
// parallelism is N single-threaded workers. ToolchainPool starts them, loads
// the toolchain release into each (the release files downloaded once, here,
// through Cache Storage, and copied to every worker), mounts the source
// bundles, and hands out one MessagePort per worker: the engine worker takes
// them and sends its jobs straight to the workers, so a compile never waits
// on the page's main thread. run(job) does the same from the page.
//
// Dispatcher is the queue on either side: jobs wait until an endpoint (a
// worker, or a port to one) is free, one job per endpoint at a time, and
// every reply finds its job by id. The engine worker imports it too.
//
// Cancelling a build terminates the workers (a compile cannot be stopped any
// other way); the pool starts new ones from the bytes it kept.

import { fetchBlob } from "../workers/blob-cache.js";
import { fetchVerified, toolchainFiles } from "./cache.js";

export const WORKERS_KEY = "webflash.build.workers";

/** Copies the job's files need before they can be transferred (a view of a larger buffer is copied). */
function transferable(view) {
  if (!(view instanceof Uint8Array)) {
    view = ArrayBuffer.isView(view) ? new Uint8Array(view.buffer, view.byteOffset, view.byteLength) : new Uint8Array(view);
  }
  const whole = view.byteOffset === 0 && view.byteLength === view.buffer.byteLength &&
    !(typeof SharedArrayBuffer !== "undefined" && view.buffer instanceof SharedArrayBuffer);
  return whole ? view : view.slice();
}

/**
 * A job's message and its transfer list: the files move to the worker rather
 * than being copied. files may be a plain object or a Map of path to bytes.
 */
export function jobMessage(job) {
  const files = {};
  const transfer = [];
  const seen = new Set();
  for (const [path, data] of job.files instanceof Map ? job.files : Object.entries(job.files || {})) {
    const bytes = transferable(data);
    files[path] = bytes;
    if (!seen.has(bytes.buffer)) {
      seen.add(bytes.buffer);
      transfer.push(bytes.buffer);
    }
  }
  return {
    job: { argv: job.argv, cwd: job.cwd, env: job.env || {}, symlinks: job.symlinks || {}, files },
    transfer,
  };
}

/**
 * Jobs for a set of endpoints (Workers or MessagePorts speaking the
 * toolchain worker's protocol): run(job) waits for a free endpoint, sends
 * {type: "run", id, job} and resolves with its result; request(i, message)
 * sends anything else to one endpoint. One job per endpoint at a time, first
 * come first served.
 */
export class Dispatcher {
  constructor(endpoints = []) {
    this._next = 1;
    this._pending = new Map();   // id -> {resolve, reject, endpoint, job}
    this._queue = [];            // [{job, transfer, resolve, reject}]
    this._endpoints = [];
    this._idleWaiters = [];
    this.stats = [];
    if (endpoints.length) this.attach(endpoints);
  }

  get size() { return this._endpoints.length; }

  /** Jobs running or waiting. */
  get busy() { return this._pending.size + this._queue.length; }

  /** Take these endpoints instead of any before (whose work is dropped with reason). */
  attach(endpoints, reason = "the toolchain workers were replaced") {
    this.detach(reason);
    this._endpoints = endpoints.map((target, index) => {
      const ep = { target, index, job: null, listener: null };
      ep.listener = (event) => this._onMessage(ep, event.data);
      target.addEventListener("message", ep.listener);
      if (typeof target.start === "function") target.start();
      return ep;
    });
    this.stats = this._endpoints.map(() => ({ jobs: 0, busy: 0, main: 0, peakMemory: 0 }));
  }

  /** Forget the endpoints; everything running or waiting fails with reason. */
  detach(reason = "the toolchain workers stopped") {
    for (const ep of this._endpoints) {
      ep.target.removeEventListener("message", ep.listener);
    }
    this._endpoints = [];
    const error = new Error(reason);
    const waiting = [...this._pending.values(), ...this._queue];
    this._pending.clear();
    this._queue = [];
    for (const p of waiting) p.reject(error);
    this._settled();
  }

  /** Run one job on the next free endpoint: resolves with the worker's result. */
  run(job) {
    if (!this._endpoints.length) {
      return Promise.reject(new Error("no toolchain workers are running"));
    }
    const { job: payload, transfer } = jobMessage(job);
    return new Promise((resolve, reject) => {
      this._queue.push({ job: payload, transfer, resolve, reject, queued: now() });
      this._pump();
    });
  }

  /** Send one message to one endpoint and wait for its reply. */
  request(index, message, transfer = []) {
    const ep = this._endpoints[index];
    if (!ep) return Promise.reject(new Error(`no toolchain worker ${index}`));
    return new Promise((resolve, reject) => {
      const id = this._next++;
      this._pending.set(id, { resolve, reject, endpoint: ep, job: null });
      ep.target.postMessage({ ...message, id }, transfer);
    });
  }

  /** Resolves once nothing is running or waiting. */
  whenIdle() {
    if (!this.busy) return Promise.resolve();
    return new Promise((resolve) => this._idleWaiters.push(resolve));
  }

  _pump() {
    for (const ep of this._endpoints) {
      if (!this._queue.length) return;
      if (ep.job) continue;
      const item = this._queue.shift();
      const id = this._next++;
      ep.job = { id, started: now() };
      this._pending.set(id, { resolve: item.resolve, reject: item.reject, endpoint: ep, job: ep.job });
      try {
        ep.target.postMessage({ type: "run", id, job: item.job }, item.transfer);
      } catch (e) {
        this._pending.delete(id);
        ep.job = null;
        item.reject(e);
      }
    }
  }

  _onMessage(ep, msg) {
    if (!msg || msg.type !== "reply") return;
    const p = this._pending.get(msg.id);
    if (!p || p.endpoint !== ep) return;
    this._pending.delete(msg.id);
    if (p.job && ep.job === p.job) {
      ep.job = null;
      const s = this.stats[ep.index];
      if (s && msg.result) {
        s.jobs++;
        s.busy += now() - p.job.started;
        s.main += msg.result.time || 0;
        s.peakMemory = Math.max(s.peakMemory, msg.result.memory || 0);
      }
    }
    if ("error" in msg) p.reject(new Error(msg.error));
    else p.resolve(msg.result);
    this._pump();
    this._settled();
  }

  _settled() {
    if (this.busy) return;
    const waiters = this._idleWaiters;
    this._idleWaiters = [];
    for (const w of waiters) w();
  }
}

function now() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

// ── Timing ───────────────────────────────────────────────────────────

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * What the workers' stats (ToolchainPool.stats()) say about a build: {jobs,
 * workers: [{jobs, busy, peakMemory}], compiles: {count, median, max,
 * slowest}, links: [{out, ms}], others, overlap} (milliseconds; overlap the
 * most jobs that ran at the same moment, from the timelines).
 */
export function summarizeStats(stats) {
  const all = stats.flatMap((s) => s.timeline || []);
  const compiles = all.filter((t) => /^clang/.test(t.tool) && /\.o$/.test(t.out));
  const links = all.filter((t) => t.tool === "ld.lld" || (/^clang/.test(t.tool) && /\.elf$/.test(t.out)));
  const slowest = compiles.reduce((a, b) => (b.ms > (a ? a.ms : -1) ? b : a), null);
  const edges = all.flatMap((t) => [[t.start, 1], [t.start + t.ms, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let overlap = 0;
  let open = 0;
  for (const [, d] of edges) overlap = Math.max(overlap, (open += d));
  return {
    jobs: all.length,
    workers: stats.map((s) => ({ jobs: s.jobs, busy: s.busy, peakMemory: s.peakMemory })),
    compiles: { count: compiles.length, median: median(compiles.map((t) => t.ms)), max: slowest ? slowest.ms : 0, slowest: slowest ? slowest.out : "" },
    links: links.map((t) => ({ out: t.out, ms: t.ms })),
    others: all.length - compiles.length - links.length,
    overlap,
  };
}

// ── Sizing ───────────────────────────────────────────────────────────

/**
 * How many toolchain workers to start: one per core but one, at most 4,
 * halved on a device with less than 8 GB of memory (each worker holds its
 * own compiler and source tree), unless About set a number.
 */
export function defaultWorkerCount(nav = typeof navigator !== "undefined" ? navigator : {}) {
  const cores = Number(nav.hardwareConcurrency) || 2;
  let n = Math.min(4, Math.max(1, cores - 1));
  if (Number(nav.deviceMemory) > 0 && nav.deviceMemory < 8) n = Math.max(1, Math.floor(n / 2));
  return n;
}

/** The number About set ("auto" or 1 to 8), or null for automatic. */
export function chosenWorkerCount() {
  try {
    const n = parseInt(localStorage.getItem(WORKERS_KEY), 10);
    return Number.isInteger(n) && n >= 1 && n <= 8 ? n : null;
  } catch (e) {
    return null;
  }
}

export function setChosenWorkerCount(n) {
  try {
    if (n === null || n === "auto") localStorage.removeItem(WORKERS_KEY);
    else localStorage.setItem(WORKERS_KEY, String(n));
  } catch (e) { /* storage can be blocked */ }
}

export function workerCount() {
  return chosenWorkerCount() || defaultWorkerCount();
}

// ── The release ──────────────────────────────────────────────────────

/**
 * The toolchain release the assets origin publishes: toolchain/current.json
 * (revalidated) names it, toolchain/<id>/manifest.json (content-addressed,
 * so cached) describes it. Resolves to {id, base, manifestUrl, manifest,
 * files}, files being the ones a build downloads (toolchainFiles).
 */
export async function discoverToolchain(assetsBase) {
  const root = new URL("toolchain/", assetsBase).href;
  let current;
  try {
    const resp = await fetch(`${root}current.json`, { cache: "no-cache" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    current = await resp.json();
  } catch (e) {
    throw new Error(`No compiler is published at ${root} (current.json: ${e.message}), so building is not available here.`);
  }
  const id = current && typeof current.id === "string" ? current.id : "";
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`${root}current.json does not name a toolchain release.`);
  const base = `${root}${id}/`;
  const manifestUrl = `${base}manifest.json`;
  let manifest;
  try {
    const { bytes } = await fetchBlob(manifestUrl);
    manifest = JSON.parse(new TextDecoder().decode(bytes));
  } catch (e) {
    throw new Error(`Could not read the compiler's manifest (${manifestUrl}): ${e.message}`);
  }
  if (!manifest || manifest.schema !== 1) {
    throw new Error(`${manifestUrl} is not a schema 1 toolchain manifest; this site needs a newer copy of itself.`);
  }
  return { id, base, manifestUrl, manifest, files: toolchainFiles(manifest, base) };
}

/**
 * The release files every worker needs, downloaded (or read from Cache
 * Storage) once and checked against the manifest: {name: Uint8Array}, the
 * manifest itself included. onProgress({name, done, total, file, files})
 * counts bytes of all files together.
 */
export async function loadToolchainFiles(toolchain, { onProgress = null } = {}) {
  const out = { "manifest.json": new TextEncoder().encode(JSON.stringify(toolchain.manifest)) };
  const total = toolchain.files.reduce((n, f) => n + (f.size || 0), 0);
  let before = 0;
  let cached = true;
  for (const [i, f] of toolchain.files.entries()) {
    const got = await fetchVerified(f.url, {
      size: f.size, sha256: f.sha256,
      onProgress: (done) => {
        if (onProgress) onProgress({ name: f.name, done: before + done, total, file: i + 1, files: toolchain.files.length });
      },
    });
    cached = cached && got.cached;
    before += f.size || got.bytes.length;
    out[f.name] = got.bytes;
  }
  return { files: out, cached };
}

// ── The pool ─────────────────────────────────────────────────────────

const WORKER_URL = new URL("../workers/toolchain-worker.js", import.meta.url);

/**
 * A module worker for a URL. A worker script from another origin is refused
 * by the browser (generated pages load this from webflash.isiks.tech), so
 * that one starts from a same-origin Blob URL that imports the real module.
 */
export function startWorker(url = WORKER_URL) {
  const href = String(url);
  const sameOrigin = typeof location === "undefined" || new URL(href, location.href).origin === location.origin;
  if (sameOrigin) return new Worker(href, { type: "module" });
  const shim = URL.createObjectURL(new Blob([`import ${JSON.stringify(href)};\n`], { type: "text/javascript" }));
  const worker = new Worker(shim, { type: "module" });
  setTimeout(() => URL.revokeObjectURL(shim), 30000);
  return worker;
}

export class ToolchainPool {
  /**
   * size: how many workers; createWorker(): a Worker-like object (tests pass
   * a fake); onCrash(message): a worker died (out of memory, most likely).
   */
  constructor({ size = workerCount(), createWorker = () => startWorker(), onCrash = null, reuse = false } = {}) {
    this.size = Math.max(1, size | 0);
    this.createWorker = createWorker;
    this.onCrash = onCrash;
    this.reuse = reuse;
    this.workers = [];
    this.dispatcher = new Dispatcher();
    this.toolchain = null;     // {id, manifestUrl, ...} once init ran
    this.tree = null;          // the tree path mounted
    this.mounted = new Set();  // bundle keys mounted on every worker
    this._files = null;        // the release files, kept to start workers again
    this._ready = null;
  }

  get ready() { return Boolean(this._ready) && this.workers.length > 0; }

  /**
   * Start the workers and load the release into each: files from
   * loadToolchainFiles. Resolves to the workers' init results.
   */
  async init(toolchain, files, { onProgress = null } = {}) {
    this.toolchain = toolchain;
    this._files = files;
    this.terminate();
    this.workers = Array.from({ length: this.size }, () => this.createWorker());
    for (const [i, w] of this.workers.entries()) {
      w.addEventListener("error", (e) => {
        if (e && typeof e.preventDefault === "function") e.preventDefault();
        this._crashed(i, e && e.message ? e.message : "the worker stopped");
      });
    }
    this.dispatcher.attach(this.workers, "the compiler workers were restarted");
    let done = 0;
    if (onProgress) onProgress({ done, total: this.size });
    this._ready = Promise.all(this.workers.map((_, i) => {
      const copy = {};
      for (const [name, bytes] of Object.entries(files)) copy[name] = bytes;
      return this.dispatcher.request(i, { type: "init", manifestUrl: toolchain.manifestUrl, files: copy, reuse: this.reuse })
        .then((r) => {
          done++;
          if (onProgress) onProgress({ done, total: this.size });
          return r;
        });
    }));
    try {
      return await this._ready;
    } catch (e) {
      this.terminate();
      throw e;
    }
  }

  /**
   * Mount the source tree on every worker: tree is the engine's path for it,
   * bundles [{key, bytes}] (gzipped tars; the core under "core", each lib
   * bundle under its lib/<dir>). Bundles already mounted are skipped; another
   * tree replaces the old one.
   */
  async mount(tree, bundles) {
    if (!this.ready) throw new Error("the compiler workers are not running");
    if (tree !== this.tree) {
      this.tree = tree;
      this.mounted = new Set();
    }
    const fresh = bundles.filter((b) => !this.mounted.has(b.key));
    if (!fresh.length) return;
    await Promise.all(this.workers.map((_, i) => this.dispatcher.request(i, {
      type: "mount", tree, bundles: fresh.map((b) => ({ key: b.key, bytes: b.bytes })),
    })));
    for (const b of fresh) this.mounted.add(b.key);
  }

  /** Whether this tree and these bundle keys are mounted already. */
  has(tree, keys) {
    return this.tree === tree && keys.every((k) => this.mounted.has(k));
  }

  /** One job from the page: {argv, cwd, env, files, symlinks} -> {code, stdout, stderr, outputs, time, memory}. */
  run(job) {
    return this.dispatcher.run(job);
  }

  /**
   * One MessagePort per worker for the engine worker, which dispatches its
   * jobs itself. Transfer them (they are the second argument's list).
   */
  ports() {
    return this.workers.map((w) => {
      const channel = new MessageChannel();
      w.postMessage({ type: "port", port: channel.port1 }, [channel.port1]);
      return channel.port2;
    });
  }

  /** Every worker's stats ({jobs, busy, main, peakMemory, timeline}); reset clears them. */
  stats({ reset = false } = {}) {
    return Promise.all(this.workers.map((_, i) => this.dispatcher.request(i, { type: "stats", reset })));
  }

  /** Drop the long-lived instances of reuse mode (after a build). */
  dispose() {
    return Promise.all(this.workers.map((_, i) => this.dispatcher.request(i, { type: "dispose" }).catch(() => {})));
  }

  /** Stop every worker now; the pool can be started again from the kept files. */
  terminate(reason = "the compiler workers were stopped") {
    this.dispatcher.detach(reason);
    for (const w of this.workers) {
      try { w.terminate(); } catch (e) { /* gone already */ }
    }
    this.workers = [];
    this._ready = null;
    this.tree = null;
    this.mounted = new Set();
  }

  /** terminate, then start the same number of workers with the same release. */
  async restart({ onProgress = null } = {}) {
    if (!this.toolchain || !this._files) throw new Error("the pool was never started");
    return this.init(this.toolchain, this._files, { onProgress });
  }

  _crashed(index, message) {
    const text = `Compiler worker ${index + 1} stopped: ${message}`;
    this.terminate(text);
    if (this.onCrash) this.onCrash(text);
  }
}
