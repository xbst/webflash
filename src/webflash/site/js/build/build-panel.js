// The Build card (SPEC 12): build the configuration in the browser.
//
// Build downloads what it needs the first time (the compiler release and the
// library bundles the Makefiles name; on a first visit the list and the sizes
// are shown before anything heavy downloads), starts the toolchain workers
// (toolchain-pool.js), gives them and the engine the sources, and runs the
// engine's build: the project's own Makefiles under Pyodide, every compiler
// command sent to the workers. While it runs the Configure panel is locked,
// the steps appear as the Makefiles echo them, the log fills, and Cancel stops
// it (the workers are terminated and started again for the next build).
// Afterwards the card shows the memory table and the files, and the result
// goes to session.build, which the Flash card reads. A configuration changed
// after the build turns the button into Rebuild.
//
// The engine holds one tree, so the build runs in the configurator's queue:
// nothing else touches the engine while it runs.

import * as runtime from "../runtime.js";
import { esc } from "../dialogs.js";
import { blobSize, blobUrl, formatBytes, projectTitle } from "../configure/sources.js";
import { copyText } from "../configure/config-tab.js";
import {
  ToolchainPool, chosenWorkerCount, defaultWorkerCount, discoverToolchain, loadToolchainFiles,
  setChosenWorkerCount, summarizeStats, workerCount,
} from "./toolchain-pool.js";
import { cachedFlags, clearCache, isCached, storageEstimate } from "./cache.js";
import { buildRecord, renderArtifacts, renderMemory } from "./artifacts.js";

const AUTO_KEY = "webflash.build.auto";
// Run every job of a worker on one long-lived instance (toolchain.js's
// runReusing) instead of a fresh one per job: a measurement knob, off.
const REUSE_KEY = "webflash.build.reuse";
const ENGINE_PHASES = new Set(["configure", "plan", "build", "step", "done", "log", "failed", "finished"]);

function remembered(key) {
  try { return localStorage.getItem(key); } catch (e) { return null; }
}

function remember(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch (e) { /* storage can be blocked */ }
}

/** Where the engine extracts a ref's sources (bridge.load_sources). */
export function treePath(project, ref) {
  return `/webflash/src/${project}/${ref && ref.sha ? ref.sha : "local"}`;
}

/** The CONFIG_ lines of a .config, for telling whether two configurations differ. */
export function configKey(text) {
  return String(text || "").split(/\r?\n/).map((l) => l.trim())
    .filter((l) => /^(# )?CONFIG_/.test(l)).sort().join("\n");
}

/**
 * The parts of an engine build error: the bridge's message is the failing
 * command, "failed with exit code N", then its output. {command, code,
 * output} when it has that shape, else {output: message}.
 */
export function splitFailure(message) {
  const text = String(message || "").trim();
  const m = /^([\s\S]*?)\nfailed with exit code (-?\d+)(?::\n([\s\S]*))?$/.exec(text);
  if (!m) return { command: "", code: null, output: text };
  return { command: m[1].trim(), code: Number(m[2]), output: (m[3] || "").trim() };
}

function seconds(ms) {
  return ms < 10000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`;
}

function now() {
  return performance.now();
}

class Cancelled extends Error {
  constructor() { super("the build was cancelled"); }
}

export class BuildPanel {
  /**
   * els: {button, cancel, status, start, bar, list, error, memory, artifacts,
   * logBox, log, logCopy, logCount, pill}.
   */
  constructor(session, configurator, els, { showError = null } = {}) {
    this.session = session;
    this.configurator = configurator;
    this.els = els;
    this.showError = showError;
    this.toolchain = null;         // discoverToolchain's result
    this.toolchainError = "";
    this.toolchainCached = false;
    this._discovering = null;
    this.files = null;             // the release files, once downloaded ({name: bytes})
    this.pool = null;
    this.generation = 0;           // bumped whenever the pool's workers start
    this.attached = -1;            // the generation the engine has ports to
    this.running = false;
    this.phase = "";               // what the pill says the toolchain is doing
    this.cancelled = false;
    this.ctrl = null;
    this.last = null;              // {config, project, ref} of the last build that worked
    this.follow = true;            // the log scrolls with new lines
    this.logBuffer = [];
    this.logLines = 0;
    this._logTimer = null;
    this.rows = [];

    els.button.addEventListener("click", () => this.onBuild());
    els.cancel.addEventListener("click", () => this.cancel());
    els.logCopy.addEventListener("click", (e) => {
      // The button sits in the log's <summary>: copying must not fold it.
      e.preventDefault();
      e.stopPropagation();
      this.flushLog();
      copyText(els.log.textContent, els.logCopy);
    });
    els.log.addEventListener("scroll", () => {
      const pre = els.log;
      this.follow = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
    });
    session.on("change", ({ what }) => {
      if (["sources", "plan", "ref", "config", "firmware", "open", "prebuilt", "lock", "project", "version"].includes(what)) this.render();
    });
    this.render();
    this.renderPill();
    // What the toolchain is, for the status pill: two small files, not the toolchain.
    setTimeout(() => this.discover().catch(() => {}), 1000);
  }

  // ── State ──────────────────────────────────────────────────────────

  /** Whether a build can start now: {ok, reason}. */
  check() {
    const s = this.session;
    if (this.running) return { ok: false, reason: "A build is running." };
    if (!s.firmware) return { ok: false, reason: "This board TOML flashes a prebuilt firmware file: there is nothing to build." };
    if (s.sources.state !== "ready" || !s.ref) return { ok: false, reason: "Load the configuration first (the Configure tab)." };
    if (s.locked) return { ok: false, reason: s.locked };
    const p = s.plan;
    if (!p || p.ref !== s.ref.id) return { ok: false, reason: "Working out what the build needs…" };
    if (p.error) return { ok: false, reason: `What the build needs could not be worked out: ${p.error}` };
    if (p.unavailable && p.unavailable.length) {
      return { ok: false, reason: `This snapshot does not include ${p.unavailable.join(", ")}, which the build needs.` };
    }
    return { ok: true, reason: "" };
  }

  /** The last build no longer matches the configuration: another project, version or .config. */
  get stale() {
    const s = this.session;
    if (!this.last) return false;
    return this.last.project !== s.project || !s.ref || this.last.ref !== s.ref.id ||
      configKey(this.last.config) !== configKey(s.configText);
  }

  render() {
    const { button, cancel } = this.els;
    const c = this.check();
    button.disabled = !c.ok;
    button.textContent = this.last && this.stale ? "Rebuild" : "Build";
    button.title = c.ok
      ? (this.last && this.stale ? "The configuration changed since the last build: build it again"
        : "Compile the firmware in this browser")
      : c.reason;
    cancel.hidden = !this.running;
    cancel.disabled = this.cancelled;
    if (this.session.build && !this.running) renderArtifacts(this.els.artifacts, this.session.build, { stale: this.stale });
  }

  // ── The toolchain ─────────────────────────────────────────────────

  /** The published release (toolchain/current.json and its manifest), once per page. */
  discover() {
    if (!this._discovering) {
      this._discovering = discoverToolchain(runtime.assetsBase()).then(async (tc) => {
        this.toolchain = tc;
        this.toolchainError = "";
        this.toolchainCached = (await cachedFlags(tc.files)).every(Boolean);
        this.renderPill();
        return tc;
      }).catch((e) => {
        this._discovering = null;
        this.toolchainError = e.message;
        this.renderPill();
        throw e;
      });
    }
    return this._discovering;
  }

  toolchainSize(tc = this.toolchain) {
    return tc ? tc.files.reduce((n, f) => n + (f.size || 0), 0) : 0;
  }

  renderPill(state = null) {
    const pill = this.els.pill;
    if (!pill) return;
    const tc = this.toolchain;
    const set = (cls, text, title, badge = "") => {
      pill.className = `pill${cls ? ` ${cls}` : ""}`;
      pill.innerHTML = `${esc(text)}${badge ? `<span class="pill-badge">${esc(badge)}</span>` : ""}`;
      pill.title = title;
    };
    const size = formatBytes(this.toolchainSize());
    const what = tc ? `The compiler ${tc.id} (LLVM ${tc.manifest.llvm}, Arm Toolchain for Embedded ${tc.manifest.atfe})` : "The compiler";
    if (state && state.busy) {
      set("busy", state.text, `${what}: ${state.title || state.text}`);
    } else if (this.pool && this.pool.ready) {
      set("ready", "Toolchain", `${what}: ${this.pool.size} worker${this.pool.size === 1 ? "" : "s"} running, ${size}` +
        `${this.toolchainCached ? ", from this browser's cache" : ""}.`, this.toolchainCached ? "cached" : "");
    } else if (this.toolchainError) {
      set("error", "Toolchain: none", this.toolchainError);
    } else if (tc) {
      set(this.toolchainCached ? "" : "off", "Toolchain",
        this.toolchainCached ? `${what}: ${size}, in this browser's cache; it starts with the first build.`
          : `${what}: ${size}, downloaded with the first build and kept in this browser's cache.`,
        this.toolchainCached ? "cached" : "");
    } else {
      set("off", "Toolchain", "The compiler (clang and lld for Arm, in WebAssembly), downloaded with the first build.");
    }
  }

  /** What the first build downloads: [{label, size, cached}]. */
  async downloadList(tc) {
    const s = this.session;
    const items = [];
    if (!this.files) {
      items.push({
        label: `The compiler: clang and lld ${tc.manifest.llvm} for Arm, with the libraries of Arm Toolchain for Embedded ${tc.manifest.atfe}`,
        size: this.toolchainSize(tc), cached: (await cachedFlags(tc.files)).every(Boolean),
      });
    }
    const tree = treePath(s.project, s.ref);
    for (const lib of (s.plan && s.plan.libs) || []) {
      if (this.pool && this.pool.has(tree, [lib.dir])) continue;
      items.push({ label: `The ${lib.dir} library bundle`, size: lib.size, cached: await isCached(blobUrl(lib.blob)) });
    }
    return items;
  }

  // ── Building ──────────────────────────────────────────────────────

  async onBuild() {
    if (!this.check().ok) return;
    this.clearError();
    let tc;
    try {
      tc = await this.discover();
    } catch (e) {
      this.showFailure("No compiler", e.message);
      return;
    }
    let list;
    try {
      list = await this.downloadList(tc);
    } catch (e) {
      list = [];
    }
    if (list.some((d) => !d.cached) && remembered(AUTO_KEY) !== "1") {
      this.showStart(tc, list);
      return;
    }
    this.run(tc);
  }

  /** The first-visit list: what the build downloads, with sizes, and a Start. */
  showStart(tc, list) {
    const s = this.session;
    const el = this.els.start;
    const total = list.filter((d) => !d.cached).reduce((n, d) => n + (d.size || 0), 0);
    el.hidden = false;
    el.innerHTML =
      `<p><strong>Build ${esc(projectTitle(s.index, s.project))} ${esc(s.ref.id)}</strong> in this browser. The first build downloads:</p>` +
      `<ul class="build-downloads">` +
      list.map((d) => `<li><span>${esc(d.label)}</span><span class="dl-size">${esc(d.size ? formatBytes(d.size) : "size unknown")}</span>` +
        `${d.cached ? `<span class="dl-cached">in this browser's cache</span>` : ""}</li>`).join("") +
      `</ul>` +
      `<p class="card-note">${esc(formatBytes(total))} in all, kept in this browser's cache, so later builds start at once. ` +
      `Nothing you configure or build leaves the browser.</p>` +
      `<div class="build-start-actions"><button class="primary" id="build-start-go">Download and build</button>` +
      `<button id="build-start-no">Not now</button></div>`;
    el.querySelector("#build-start-go").addEventListener("click", () => {
      el.hidden = true;
      if (this.check().ok) this.run(tc);
    });
    el.querySelector("#build-start-no").addEventListener("click", () => { el.hidden = true; });
    el.querySelector("#build-start-go").focus();
  }

  async run(tc) {
    const s = this.session;
    if (this.running || !this.check().ok) return;
    this.running = true;
    this.cancelled = false;
    this.crash = "";
    this.ctrl = new AbortController();
    const signal = this.ctrl.signal;
    const job = { project: s.project, ref: s.ref, configText: s.configText, defconfigText: s.defconfigText, failed: null };
    this.els.start.hidden = true;
    this.resetView();
    s.setLocked("A build is running.");
    this.startClock();
    this.render();
    try {
      await this.ensurePool(tc, signal);
      const { result, outputs } = await this.configurator.exclusive(() => this.engineBuild(tc, job, signal));
      this.finishOk(result, outputs, job);
    } catch (e) {
      if (this.cancelled && !this.crash) this.finishCancelled();
      else this.finishFailed(job.failed, this.crash ? new Error(this.crash) : e);
    } finally {
      this.running = false;
      this.stopClock();
      s.setLocked("");
      this.render();
      this.renderPill();
    }
  }

  _check(signal) {
    if (signal.aborted) throw new Cancelled();
  }

  /** The workers running the release: download it (or read the cache) and start them. */
  async ensurePool(tc, signal) {
    const n = workerCount();
    if (this.pool && this.pool.ready && this.pool.size === n && this.pool.toolchain.id === tc.id) return;
    if (!this.files || this.filesId !== tc.id) {
      const size = this.toolchainSize(tc);
      const row = this.addRow("Loading the compiler");
      const got = await loadToolchainFiles(tc, {
        onProgress: ({ done, total }) => {
          this.rowProgress(row, done, total);
          this.renderPill({ busy: true, text: `Toolchain: ${Math.round((100 * done) / (total || 1))}%`, title: `downloading, ${formatBytes(done)} of ${formatBytes(total)}` });
        },
      });
      this.files = got.files;
      this.filesId = tc.id;
      this.toolchainCached = true;
      this.finishRow(row, got.cached ? "from this browser's cache" : formatBytes(size));
      this._check(signal);
    }
    if (!this.pool || this.pool.size !== n) {
      if (this.pool) this.pool.terminate();
      this.pool = new ToolchainPool({ size: n, onCrash: (m) => this.onCrash(m), reuse: remembered(REUSE_KEY) === "1" });
    }
    const row = this.addRow(`Starting ${n} compiler worker${n === 1 ? "" : "s"}`);
    this.renderPill({ busy: true, text: "Toolchain: starting", title: `starting ${n} worker${n === 1 ? "" : "s"}` });
    const started = now();
    await this.pool.init(tc, this.files, { onProgress: ({ done, total }) => this.rowProgress(row, done, total) });
    this.generation++;
    this.finishRow(row, seconds(now() - started));
    remember(AUTO_KEY, "1");
    this.renderPill();
    this._check(signal);
  }

  /** Inside the configurator's queue: the sources, then the engine's build. */
  async engineBuild(tc, job, signal) {
    const s = this.session;
    const { project, ref } = job;
    this._check(signal);
    if (!s.ref || s.ref.id !== ref.id || s.project !== project) throw new Error("The version changed before the build started.");
    const tree = treePath(project, ref);
    // What the build needs, from the engine: every lib/ folder the Makefiles
    // name, and the ones its tree lacks.
    const plan = await runtime.plan(job.defconfigText);
    const inCore = new Set(ref.core_libs || []);
    const libs = (plan.libs || []).filter((dir) => !inCore.has(dir));
    const absent = libs.filter((dir) => !(ref.libs || {})[dir]);
    if (absent.length) throw new Error(`This snapshot does not include ${absent.join(", ")}, which the build needs.`);
    const bundles = [
      { key: "core", url: blobUrl(ref.core), size: blobSize(s.index, ref.core), label: "the sources" },
      ...libs.map((dir) => ({ key: dir, url: blobUrl(ref.libs[dir]), size: blobSize(s.index, ref.libs[dir]), label: dir })),
    ];
    const engineLacks = new Set(plan.missing || []);
    const forPool = bundles.filter((b) => !this.pool.has(tree, [b.key]));
    for (const b of bundles) {
      if (!forPool.includes(b) && !engineLacks.has(b.key)) continue;
      this._check(signal);
      const row = this.addRow(b.key === "core" ? "Reading the sources" : `Loading ${b.label}`);
      const got = await runtime.fetchBlob(b.url, {
        size: b.size, phase: "lib", detail: b.key, onProgress: ({ done, total }) => this.rowProgress(row, done, total),
      });
      b.bytes = got.bytes;
      if (engineLacks.has(b.key)) await runtime.addLib(b.key, got.bytes);
      this.finishRow(row, got.cached ? "from this browser's cache" : formatBytes(got.size));
    }
    if (forPool.length) {
      this._check(signal);
      const row = this.addRow(`Giving the sources to the compiler workers`);
      await this.pool.mount(tree, forPool.map((b) => ({ key: b.key, bytes: b.bytes })));
      this.finishRow(row);
    }
    if (this.attached !== this.generation) {
      await runtime.attachToolchain(this.pool.ports());
      this.attached = this.generation;
    }
    await runtime.setToolchain(tc.manifest);
    // Jobs a failed build left running must not land in this one's out/.
    await runtime.toolchainIdle();
    await this.pool.stats({ reset: true });
    this._check(signal);
    const off = runtime.onProgress((phase, detail, info) => this.onEngineProgress(phase, detail, info, job));
    let result;
    try {
      result = await runtime.build(job.configText, "", this.pool.size, { signal });
    } finally {
      off();
      this.flushLog();
    }
    this.workerStats = await this.pool.stats({ reset: true }).catch(() => null);
    if (this.pool.reuse) await this.pool.dispose();
    const outputs = new Map();
    for (const name of Object.keys(result.outputs || {})) outputs.set(name, await runtime.buildOutput(name));
    return { result, outputs };
  }

  onEngineProgress(phase, detail, info, job) {
    if (!ENGINE_PHASES.has(phase)) return;
    if (phase === "log") {
      this.appendLog(detail);
      return;
    }
    if (phase === "failed") {
      job.failed = detail;
      return;
    }
    if (Number.isFinite(info.total) && info.total > 0) {
      this.els.bar.hidden = false;
      this.els.bar.max = info.total;
      this.els.bar.value = info.done || 0;
    }
    if (phase === "configure") this.addRow("Configuring");
    else if (phase === "plan") this.stepRow("Reading the Makefiles");
    else if (phase === "build") {
      this.stepRow(`Building: ${detail}`);
      this.finishOpen(null);
    } else if (phase === "step") {
      this.addRow(detail, { target: true });
    } else if (phase === "done") {
      const row = [...this.rows].reverse().find((r) => r.target && !r.done && (r.text.endsWith(` ${detail}`) || r.text === detail));
      if (row) this.finishRow(row);
    }
  }

  // ── Endings ──────────────────────────────────────────────────────

  finishOk(result, outputs, job) {
    const s = this.session;
    const total = now() - this.clockStart;
    this.finishOpen(null);
    this.els.bar.value = this.els.bar.max;
    const build = buildRecord(result, outputs, { project: job.project, ref: job.ref.id });
    this.last = { config: build.config, project: job.project, ref: job.ref.id };
    renderMemory(this.els.memory, build.memory);
    const engine = Number(result.duration) * 1000;
    this.setStatus("ok", `Built in ${seconds(engine)}`, `The build took ${seconds(engine)}; ${seconds(total)} with the downloads and starting the compiler.`);
    build.timing = { engine, total, workers: this.pool ? this.pool.size : 0, summary: null };
    if (this.workerStats && this.workerStats.length) {
      const sum = summarizeStats(this.workerStats);
      build.timing.summary = sum;
      const ms = (n) => (n < 1000 ? `${Math.round(n)} ms` : seconds(n));
      this.appendLog(`WebFlash: ${sum.jobs} tool runs on ${sum.workers.length} compiler worker${sum.workers.length === 1 ? "" : "s"}, ` +
        `up to ${sum.overlap} at once; ${sum.compiles.count} compiles, median ${ms(sum.compiles.median)}, ` +
        `slowest ${ms(sum.compiles.max)} (${sum.compiles.slowest})` +
        `${sum.links.length ? `; ${sum.links.map((l) => `link ${l.out} ${ms(l.ms)}`).join(", ")}` : ""}.`);
      this.appendLog(`WebFlash: ${sum.workers.map((w, i) => `worker ${i + 1}: ${w.jobs} runs, ${ms(w.busy)} busy` +
        `${w.peakMemory ? `, ${formatBytes(w.peakMemory)} peak memory` : ""}`).join("; ")}.`);
      this.flushLog();
    }
    s.build = build;
    s._changed("build", "build");
    renderArtifacts(this.els.artifacts, build, { stale: false });
  }

  finishCancelled() {
    this.finishOpen("cancelled");
    this.setStatus("", "Cancelled", "The build was cancelled. Build starts it again.");
    this.els.bar.hidden = true;
  }

  finishFailed(failed, error) {
    const message = failed || runtime.pythonMessage(error);
    this.finishOpen("failed");
    this.els.bar.hidden = true;
    this.setStatus("error", "Failed", message.split("\n")[0]);
    this.showFailure("The build failed", message);
    this.els.logBox.open = true;
    this.flushLog();
  }

  showFailure(title, message) {
    const { command, code, output } = splitFailure(message);
    const el = this.els.error;
    el.hidden = false;
    el.innerHTML = `<strong>${esc(title)}</strong>` +
      (command ? `<p class="build-error-what">This command failed${code !== null ? ` (exit code ${code})` : ""}:</p>` +
        `<pre class="build-cmd">${esc(command)}</pre>` : "") +
      (output ? `<pre class="build-out">${esc(output)}</pre>` : "");
  }

  clearError() {
    this.els.error.hidden = true;
    this.els.error.replaceChildren();
  }

  /** A compiler worker died (most likely out of memory): the build cannot go on. */
  onCrash(message) {
    this.attached = -1;
    this.renderPill();
    if (!this.running) return;
    this.crash = `${message}. It may have run out of memory: fewer compiler workers (About) use less.`;
    this.cancelled = true;
    if (this.ctrl) this.ctrl.abort();
    runtime.detachToolchain(message).catch(() => {});
  }

  async cancel() {
    if (!this.running || this.cancelled) return;
    this.cancelled = true;
    this.render();
    this.setStatus("", "Cancelling…", "Stopping the compiler workers and the build");
    this.ctrl.abort();
    // The engine stops at its next step; compiles in flight stop with their
    // workers, which start again with the next build.
    try { await runtime.detachToolchain("the build was cancelled"); } catch (e) { /* the engine is gone */ }
    if (this.pool) this.pool.terminate("the build was cancelled");
    this.attached = -1;
    this.renderPill();
  }

  // ── The view ─────────────────────────────────────────────────────

  resetView() {
    const { list, bar, memory, log, logCount, logCopy } = this.els;
    this.rows = [];
    list.replaceChildren();
    bar.hidden = true;
    bar.removeAttribute("value");
    memory.hidden = true;
    this.clearError();
    log.textContent = "";
    this.logBuffer = [];
    this.logLines = 0;
    this.follow = true;
    logCount.textContent = "";
    logCopy.disabled = true;
    this.workerStats = null;
  }

  addRow(text, { target = false } = {}) {
    const li = document.createElement("li");
    li.className = "build-row running";
    li.innerHTML = `<span class="row-icon" aria-hidden="true"></span><span class="row-text"></span><span class="row-note"></span>`;
    li.querySelector(".row-text").textContent = text;
    const list = this.els.list;
    const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 8;
    list.appendChild(li);
    if (atBottom) list.scrollTop = list.scrollHeight;
    const row = { li, text, target, done: false, started: now() };
    this.rows.push(row);
    return row;
  }

  // A one-line phase of the engine: the previous phase's row is done.
  stepRow(text) {
    const open = this.rows.filter((r) => !r.done && !r.target);
    for (const r of open) this.finishRow(r);
    return this.addRow(text);
  }

  rowProgress(row, done, total) {
    const note = row.li.querySelector(".row-note");
    note.textContent = Number.isFinite(total) && total > 0
      ? (total > 64 ? `${Math.min(100, Math.round((100 * done) / total))}%` : `${done} of ${total}`)
      : done ? formatBytes(done) : "";
  }

  finishRow(row, note = null, state = "done") {
    if (row.done) return;
    row.done = true;
    row.li.className = `build-row ${state}`;
    const el = row.li.querySelector(".row-note");
    el.textContent = note !== null ? note : state === "done" && row.target ? "" : el.textContent;
  }

  // Every row still running: done (null), failed or cancelled. A failed build
  // marks the newest row as the one that failed.
  finishOpen(state) {
    const open = this.rows.filter((r) => !r.done);
    open.forEach((r, i) => this.finishRow(r, null, state === "failed" && i < open.length - 1 ? "cancelled" : state || "done"));
  }

  appendLog(line) {
    this.logBuffer.push(String(line));
    if (!this._logTimer) this._logTimer = setTimeout(() => this.flushLog(), 100);
  }

  flushLog() {
    clearTimeout(this._logTimer);
    this._logTimer = null;
    if (!this.logBuffer.length) return;
    const pre = this.els.log;
    pre.append(document.createTextNode(`${this.logBuffer.join("\n")}\n`));
    this.logLines += this.logBuffer.length;
    this.logBuffer = [];
    if (this.follow) pre.scrollTop = pre.scrollHeight;
    this.els.logCount.textContent = `${this.logLines} line${this.logLines === 1 ? "" : "s"}`;
    this.els.logCopy.disabled = false;
  }

  setStatus(cls, text, title = "") {
    const el = this.els.status;
    el.className = `build-status${cls ? ` ${cls}` : ""}`;
    el.textContent = text;
    el.title = title;
  }

  startClock() {
    this.clockStart = now();
    const tick = () => this.setStatus("busy", `${this.cancelled ? "Cancelling" : "Building"} · ${seconds(now() - this.clockStart)}`);
    tick();
    clearInterval(this._clock);
    this._clock = setInterval(tick, 200);
  }

  stopClock() {
    clearInterval(this._clock);
    this._clock = null;
  }

  // ── About ────────────────────────────────────────────────────────

  /** The Toolchain row of About. */
  aboutText() {
    const tc = this.toolchain;
    if (!tc) return this.toolchainError ? esc(this.toolchainError) : "loads with the first build";
    return `${esc(tc.id)}: LLVM ${esc(tc.manifest.llvm)}, Arm Toolchain for Embedded ${esc(tc.manifest.atfe)}, ` +
      `${esc(formatBytes(this.toolchainSize()))}${this.toolchainCached ? ", in this browser's cache" : ", not downloaded yet"}` +
      `${this.pool && this.pool.ready ? `; ${this.pool.size} worker${this.pool.size === 1 ? "" : "s"} running` : ""}`;
  }

  /** About's build section: the worker count, what the cache holds, the toolchain's licenses. */
  extendAbout(el) {
    const auto = defaultWorkerCount();
    const chosen = chosenWorkerCount();
    const cores = navigator.hardwareConcurrency || 0;
    const options = [`<option value="auto"${chosen ? "" : " selected"}>Automatic (${auto})</option>`];
    for (let n = 1; n <= Math.max(4, Math.min(8, cores || 4)); n++) {
      options.push(`<option value="${n}"${chosen === n ? " selected" : ""}>${n}</option>`);
    }
    const tc = this.toolchain;
    const licenses = tc && tc.manifest.licenses ? Object.entries(tc.manifest.licenses) : [];
    el.innerHTML =
      `<h3>Build</h3><table class="about-table">` +
      `<tr><td>Compiler workers</td><td><select id="about-workers" title="How many compiles run at once. Each worker holds its own compiler, about 100 to 300 MB.">${options.join("")}</select>` +
      ` <span class="about-note">${cores ? `${cores} cores` : ""}${navigator.deviceMemory ? `, at least ${navigator.deviceMemory} GB` : ""}</span></td></tr>` +
      `<tr><td>Kept in this browser</td><td id="about-storage">…</td></tr>` +
      `</table>` +
      (licenses.length ? `<h3>Compiler licenses</h3><table class="about-table">` + licenses.map(([what, file]) =>
        `<tr><td>${esc(what)}</td><td><a href="${esc(new URL(file, tc.base).href)}" target="_blank" rel="noopener">${esc(file.split("/").pop())}</a></td></tr>`).join("") +
        `</table>` : "");
    el.querySelector("#about-workers").addEventListener("change", (e) => {
      setChosenWorkerCount(e.target.value === "auto" ? null : Number(e.target.value));
      this.renderPill();
    });
    this.renderStorage(el.querySelector("#about-storage"));
  }

  async renderStorage(cell) {
    const e = await storageEstimate();
    if (!cell.isConnected) return;
    if (!e || e.usage === null) {
      cell.textContent = "this browser does not say";
      return;
    }
    cell.textContent = `${formatBytes(e.caches !== null ? e.caches : e.usage)}` +
      `${e.caches !== null ? " in the download cache" : " in all"}${e.quota ? ` (room for ${formatBytes(e.quota)})` : ""}`;
  }

  /** After About's Clear cache: the next build asks before downloading again. */
  async cacheCleared() {
    remember(AUTO_KEY, null);
    if (this.toolchain) this.toolchainCached = (await cachedFlags(this.toolchain.files)).every(Boolean);
    this.renderPill();
  }
}

export { clearCache };
