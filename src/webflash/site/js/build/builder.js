// A build, without its view: what the site's Build card (build-panel.js) and
// a generated page's card (js/embed/embed-build.js) both run.
//
// prepare() makes the compiler ready: the release named by
// toolchain/current.json, its files through Cache Storage with their checks
// (cache.js), and the toolchain workers started with them
// (toolchain-pool.js). runAll() builds one configuration per engine slot in
// turn (Katapult, then the firmware), each as run() does, under one cancel.
// run() builds one configuration of one ref: it asks the
// engine what the Makefiles need (bridge.plan), gives the engine the lib
// bundles its tree lacks (add_lib) and the workers the sources they lack
// (the core and lib bundles, at the engine's tree path), hands the engine
// the workers' ports, and runs bridge.build, whose compiler commands go
// straight to the workers. cancel() stops it: the engine's queued jobs fail
// and the workers are terminated (prepare() starts them again).
//
// The view only draws: step(text) gives it a row ({progress(done, total),
// finish(note)}) for each thing the build does before the engine's own
// steps, which arrive through the engine worker's progress (runtime.js).
// No tree may change under a build, so the caller runs run() and runAll()
// where nothing else talks to the engine (the site: inside the
// configurator's exclusive()).

import * as runtime from "../runtime.js";
import { blobSize, formatBytes, projectTitle } from "../configure/sources.js";
import { ToolchainPool, discoverToolchain, loadToolchainFiles, summarizeStats, workerCount } from "./toolchain-pool.js";
import { cachedFlags, isCached } from "./cache.js";

/** Where the engine extracts a ref's sources (bridge.load_sources). */
export function treePath(project, ref) {
  return `/webflash/src/${project}/${ref && ref.sha ? ref.sha : "local"}`;
}

export class BuildCancelled extends Error {
  constructor() { super("the build was cancelled"); }
}

/**
 * promise, or a BuildCancelled as soon as signal aborts, whichever comes
 * first. What the promise stands for goes on unawaited (a download still
 * fills the cache); onAbort() runs when the abort ends the wait.
 */
export function untilAborted(promise, signal, onAbort = null) {
  promise.catch(() => {});   // nothing may await it after an abort
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const stop = () => {
      if (onAbort) onAbort();
      reject(new BuildCancelled());
    };
    if (signal.aborted) {
      stop();
      return;
    }
    signal.addEventListener("abort", stop, { once: true });
    promise.then((value) => {
      signal.removeEventListener("abort", stop);
      resolve(value);
    }, (e) => {
      signal.removeEventListener("abort", stop);
      reject(e);
    });
  });
}

// A view that draws nothing.
const NO_STEP = () => ({ progress() {}, finish() {} });

function now() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export class Builder {
  /**
   * assetsBase: where toolchain/ and sources/ are (default: the page's, as
   * runtime.assetsBase() says; a generated page passes its own, such as the
   * origin of its engine_url); workers(): how many toolchain workers
   * (default: toolchain-pool.js's workerCount()); reuse: one long-lived
   * instance per worker (a measurement knob); onCrash(message): a worker
   * died while nothing was running.
   */
  constructor({ assetsBase = null, workers = workerCount, reuse = false, onCrash = null } = {}) {
    this.assetsBase = assetsBase;
    this.workers = workers;
    this.reuse = reuse;
    this.onCrash = onCrash;
    this.toolchain = null;   // discoverToolchain's result
    this.cached = false;     // every release file is in Cache Storage
    this.files = null;       // the release files ({name: bytes}), once loaded
    this.filesId = null;
    this.pool = null;
    this.generation = 0;     // bumped whenever the workers start
    this.attached = -1;      // the generation the engine has ports to
    this.crash = "";         // why a worker died during a build
    this._discovering = null;
    this._fetching = null;   // fetchToolchain's download, while it runs
    this._fetchingId = null;
    this._fetchListeners = new Set();
    this._abort = null;
  }

  /** Where toolchain/ and sources/ are: the base given, else the page's. */
  get base() {
    return this.assetsBase || runtime.assetsBase();
  }

  /** The URL of a bundle the sources index names ("blobs/<sha256>.tar.gz"). */
  blobUrl(path) {
    return new URL(path, new URL("sources/", this.base)).href;
  }

  /** The published release: toolchain/current.json and its manifest, once. */
  discover() {
    if (!this._discovering) {
      this._discovering = discoverToolchain(this.base).then(async (tc) => {
        this.toolchain = tc;
        this.cached = (await cachedFlags(tc.files)).every(Boolean);
        return tc;
      }).catch((e) => {
        this._discovering = null;
        throw e;
      });
    }
    return this._discovering;
  }

  /**
   * Download the release's files (through Cache Storage) without starting
   * the workers, so the build that follows starts at once: the site does it
   * while the user configures, a generated page while Python starts. Calls
   * made while one runs share it; onProgress({done, total}) follows it in
   * bytes. Resolves to {files, cached}. Aborting signal rejects this call
   * with a BuildCancelled and drops its onProgress, while the download goes
   * on for the others and the cache.
   */
  fetchToolchain(tc, { onProgress = null, signal = null } = {}) {
    if (this.files && this.filesId === tc.id) return Promise.resolve({ files: this.files, cached: true });
    if (onProgress) this._fetchListeners.add(onProgress);
    if (!this._fetching || this._fetchingId !== tc.id) {
      this._fetchingId = tc.id;
      this._fetching = loadToolchainFiles(tc, {
        onProgress: (p) => { for (const cb of this._fetchListeners) cb(p); },
      }).then((got) => {
        this.files = got.files;
        this.filesId = tc.id;
        this.cached = true;
        return got;
      }).finally(() => {
        this._fetching = null;
        this._fetchListeners.clear();
      });
    }
    return untilAborted(this._fetching, signal, () => this._fetchListeners.delete(onProgress));
  }

  /** Whether fetchToolchain is downloading the release now. */
  get fetching() {
    return Boolean(this._fetching);
  }

  /** The bytes a release's files take ({files} from discover()). */
  static size(tc) {
    return tc ? tc.files.reduce((n, f) => n + (f.size || 0), 0) : 0;
  }

  /** Whether the workers are running, with this many of them. */
  get ready() {
    return Boolean(this.pool && this.pool.ready);
  }

  /** Whether the workers hold this tree with these bundles (core, lib/<dir>). */
  has(tree, keys) {
    return Boolean(this.pool && this.pool.has(tree, keys));
  }

  /**
   * What a build of a ref downloads before it can start: [{label, size,
   * cached}] (the compiler, unless it is loaded; the ref's sources and each
   * lib bundle the workers lack). libs: [{dir, blob, size}] (the
   * configuration's plan); index (sources/index.json, for the sources' size):
   * without it the sources are left out, for a caller that lists them itself.
   */
  async downloads(tc, { project, ref, libs = [], index = null }) {
    const items = [];
    if (!this.files || this.filesId !== tc.id) {
      items.push({
        label: `The compiler: clang and lld ${tc.manifest.llvm} for Arm, with the libraries of Arm Toolchain for Embedded ${tc.manifest.atfe}`,
        size: Builder.size(tc), cached: (await cachedFlags(tc.files)).every(Boolean),
      });
    }
    const tree = treePath(project, ref);
    // The workers take the sources from the cache configuring filled, unless
    // it was emptied since (About's Clear cache): then they download again.
    if (index && ref && ref.core && !this.has(tree, ["core"])) {
      items.push({
        label: `${projectTitle(index, project)} ${ref.id}'s sources`,
        size: blobSize(index, ref.core), cached: await isCached(this.blobUrl(ref.core)),
      });
    }
    for (const lib of libs) {
      if (this.has(tree, [lib.dir])) continue;
      items.push({ label: `The ${lib.dir} library bundle`, size: lib.size, cached: await isCached(this.blobUrl(lib.blob)) });
    }
    return items;
  }

  /**
   * Start one build, before prepare(): cancel() stops it from here until
   * run() ends. prepare() and run() start one themselves when the caller did
   * not; a build ends with run() or with a prepare() that was cancelled.
   */
  begin() {
    this._abort = new AbortController();
    this.crash = "";
  }

  // Between steps: stop when the build was cancelled, or failed with a worker.
  _check() {
    if (!this._abort || !this._abort.signal.aborted) return;
    if (this.crash) throw new Error(this.crash);
    throw new BuildCancelled();
  }

  // What an error means once the build was stopped: the worker's crash, or
  // the cancel. Terminating the workers rejects whatever waits on them (their
  // start, a mount) with a plain Error, which is a cancel here, not a failure.
  _stopped(e) {
    if (!this._abort || !this._abort.signal.aborted) return e;
    return this.crash ? new Error(this.crash) : new BuildCancelled();
  }

  /**
   * Make the compiler ready: the release's files (downloaded or read from
   * the cache) and the workers started with them. step(text) draws a row.
   * Resolves at once when the workers already run this release with the
   * number of workers wanted.
   */
  async prepare(tc, options = {}) {
    if (!this._abort) this.begin();
    try {
      await this._prepare(tc, options);
    } catch (e) {
      const error = this._stopped(e);
      if (this._abort.signal.aborted) this._abort = null;
      throw error;
    }
  }

  async _prepare(tc, { step = NO_STEP, onDownload = null }) {
    this._check();
    const n = Math.max(1, this.workers() | 0);
    if (this.ready && this.pool.size === n && this.pool.toolchain.id === tc.id) return;
    if (!this.files || this.filesId !== tc.id) {
      const size = Builder.size(tc);
      const row = step("Loading the compiler");
      // Joins a download fetchToolchain already started. A cancel stops the
      // wait at once; the download goes on for the cache.
      const got = await this.fetchToolchain(tc, {
        signal: this._abort.signal,
        onProgress: ({ done, total }) => {
          row.progress(done, total);
          if (onDownload) onDownload(done, total);
        },
      });
      row.finish(got.cached ? "from this browser's cache" : formatBytes(size));
      this._check();
    }
    if (!this.pool || this.pool.size !== n) {
      if (this.pool) this.pool.terminate();
      this.pool = new ToolchainPool({ size: n, onCrash: (m) => this._crashed(m), reuse: this.reuse });
    }
    const row = step(`Starting ${n} compiler worker${n === 1 ? "" : "s"}`);
    const started = now();
    await this.pool.init(tc, this.files, { onProgress: ({ done, total }) => row.progress(done, total) });
    this.generation++;
    row.finish(`${((now() - started) / 1000).toFixed(1)} s`);
    this._check();
  }

  /**
   * Build a configuration of a ref with the prepared workers: {project, ref
   * (the index entry), index (sources/index.json, for the bundles' sizes),
   * configText (the full .config the engine builds), defconfigText (what the
   * engine plans with: a full .config would pin every symbol), version ("":
   * the ref's describe)}. step(text) draws the rows before the engine's
   * build; onProgress(phase, detail, info) gets the engine's own progress
   * (runtime.onProgress's arguments) while it builds. Resolves to {result
   * (bridge.build's JSON), outputs: Map<name, Uint8Array>, stats (the
   * workers' summary, or null)}.
   */
  async run(options) {
    if (!this._abort) this.begin();
    try {
      return await this._run(options);
    } catch (e) {
      throw this._stopped(e);
    } finally {
      this._abort = null;
    }
  }

  /**
   * Build several configurations in a row, one per engine slot (SPEC 4.1):
   * jobs are run()'s options plus {slot}, in the order given (the site
   * passes Katapult first, so the engine ends on the firmware's tree). The
   * workers stay up between jobs and take each job's tree in turn. One
   * cancel() (or an abort of signal) ends the whole run with a
   * BuildCancelled, between jobs too. step(text, job) and onProgress(phase,
   * detail, info, job) are run()'s, told which job; onStart(job) runs before
   * each job and onDone(job, out) after each one that worked, so a run that
   * fails late keeps the builds before it. Resolves to {<slot>: out}.
   */
  async runAll(jobs, { step = null, onProgress = null, onStart = null, onDone = null, signal = null } = {}) {
    if (!this._abort) this.begin();
    const abort = this._abort;
    const stop = () => this.cancel();
    if (signal) {
      if (signal.aborted) abort.abort();
      else signal.addEventListener("abort", stop, { once: true });
    }
    const results = {};
    try {
      for (const job of jobs) {
        this._check();
        if (onStart) onStart(job);
        const out = await this._run({
          ...job,
          step: step ? (text) => step(text, job) : job.step || NO_STEP,
          onProgress: onProgress ? (phase, detail, info) => onProgress(phase, detail, info, job) : job.onProgress || null,
        });
        results[job.slot || "fw"] = out;
        this._check();
        if (onDone) onDone(job, out);
      }
      return results;
    } catch (e) {
      throw this._stopped(e);
    } finally {
      if (signal) signal.removeEventListener("abort", stop);
      this._abort = null;
    }
  }

  async _run({ slot = "fw", project, ref, index, configText, defconfigText, version = "", step = NO_STEP, onProgress = null }) {
    this._check();
    if (!this.ready) throw new Error("the compiler workers are not running (prepare first)");
    const tc = this.toolchain;
    const signal = this._abort.signal;
    const tree = treePath(project, ref);
    // What the build needs, from the engine: every lib/ folder the Makefiles
    // name, and the ones its tree lacks.
    const plan = await runtime.plan(defconfigText, { slot });
    const inCore = new Set(ref.core_libs || []);
    const libs = (plan.libs || []).filter((dir) => !inCore.has(dir));
    const absent = libs.filter((dir) => !(ref.libs || {})[dir]);
    if (absent.length) throw new Error(`This snapshot does not include ${absent.join(", ")}, which the build needs.`);
    const bundles = [
      { key: "core", url: this.blobUrl(ref.core), size: blobSize(index, ref.core), label: "the sources" },
      ...libs.map((dir) => ({ key: dir, url: this.blobUrl(ref.libs[dir]), size: blobSize(index, ref.libs[dir]), label: dir })),
    ];
    const engineLacks = new Set(plan.missing || []);
    const forPool = bundles.filter((b) => !this.pool.has(tree, [b.key]));
    for (const b of bundles) {
      if (!forPool.includes(b) && !engineLacks.has(b.key)) continue;
      this._check();
      const row = step(b.key === "core" ? "Reading the sources" : `Loading ${b.label}`);
      const got = await untilAborted(runtime.fetchBlob(b.url, {
        size: b.size, phase: "lib", detail: b.key,
        onProgress: ({ done, total }) => { if (!signal.aborted) row.progress(done, total); },
      }), signal);
      this._check();
      b.bytes = got.bytes;
      if (engineLacks.has(b.key)) await runtime.addLib(b.key, got.bytes, { slot });
      row.finish(got.cached ? "from this browser's cache" : formatBytes(got.size));
    }
    if (forPool.length) {
      this._check();
      const row = step("Giving the sources to the compiler workers");
      await this.pool.mount(tree, forPool.map((b) => ({ key: b.key, bytes: b.bytes })));
      row.finish();
    }
    if (this.attached !== this.generation) {
      await runtime.attachToolchain(this.pool.ports());
      this.attached = this.generation;
    }
    await runtime.setToolchain(tc.manifest);
    // Jobs a failed build left running must not land in this one's out/.
    await runtime.toolchainIdle();
    await this.pool.stats({ reset: true });
    this._check();
    const off = onProgress ? runtime.onProgress(onProgress) : () => {};
    let result;
    try {
      result = await runtime.build(configText, version, this.pool.size, { signal, slot });
    } catch (e) {
      if (this.crash) throw new Error(this.crash);
      if (signal.aborted) throw new BuildCancelled();
      throw e;
    } finally {
      off();
    }
    const stats = await this.pool.stats({ reset: true }).then(summarizeStats).catch(() => null);
    if (this.pool.reuse) await this.pool.dispose();
    const outputs = new Map();
    for (const name of Object.keys(result.outputs || {})) outputs.set(name, await runtime.buildOutput(name, { slot }));
    return { slot, result, outputs, stats };
  }

  /**
   * Stop a build: the engine stops at its next step, the jobs it queued
   * fail, and the workers (whose compiles cannot be stopped any other way)
   * are terminated; prepare() starts them again.
   */
  async cancel(reason = "the build was cancelled") {
    if (this._abort) this._abort.abort();
    try { await runtime.detachToolchain(reason); } catch (e) { /* the engine is gone */ }
    if (this.pool) this.pool.terminate(reason);
    this.attached = -1;
  }

  // A worker died (most likely out of memory): a running build cannot go on.
  _crashed(message) {
    this.attached = -1;
    this.crash = `${message}. It may have run out of memory: set fewer compiler workers under Versions and licenses.`;
    if (this._abort) this._abort.abort();
    runtime.detachToolchain(message).catch(() => {});
    if (this.onCrash) this.onCrash(this.crash);
  }
}
