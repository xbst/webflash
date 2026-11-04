// The Build card (SPEC 12): build the configuration in the browser.
//
// Build downloads what it needs the first time (the compiler release and the
// library bundles the Makefiles name; on a first visit the list and the sizes
// are shown before anything heavy downloads), starts the toolchain workers,
// gives them and the engine the sources, and runs the engine's build: the
// project's own Makefiles under Pyodide, every compiler command sent to the
// workers (builder.js does all of that; this is its view on the site). While
// it runs the Configure panel is locked, the steps appear as the Makefiles
// echo them, the log fills, and Cancel stops it (the workers are terminated
// and started again for the next build). Afterwards the card shows the memory
// table and the files, and the result goes to session.build, which the Flash
// card reads. A configuration changed after the build turns the button into
// Rebuild.
//
// The engine holds one tree, so the build runs in the configurator's queue:
// nothing else touches the engine while it runs.

import * as runtime from "../runtime.js";
import { esc } from "../dialogs.js";
import { formatBytes, projectTitle } from "../configure/sources.js";
import { copyText } from "../configure/config-tab.js";
import { chosenWorkerCount, defaultWorkerCount, setChosenWorkerCount, workerCount } from "./toolchain-pool.js";
import { cachedFlags, clearCache, storageEstimate } from "./cache.js";
import { buildMatches, buildRecord, configKey, renderArtifacts, renderMemory } from "./artifacts.js";
import { BuildCancelled, Builder, treePath } from "./builder.js";
import { unsupportedReason } from "../flash/devices.js";

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

// configKey lives in artifacts.js beside buildMatches; the embed imports it from here.
export { treePath, configKey };

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

// Short times in milliseconds, longer ones in seconds.
function duration(ms) {
  return ms < 1000 ? `${Math.round(ms)} ms` : seconds(ms);
}

// formatBytes, with gigabytes for a browser's storage quota.
function bigBytes(n) {
  return n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB` : formatBytes(n);
}

function now() {
  return performance.now();
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
    this.builder = new Builder({
      workers: workerCount,
      reuse: remembered(REUSE_KEY) === "1",
      onCrash: () => this.renderPill(),
    });
    this.toolchainError = "";
    this.consented = false;        // the Configure tab's first-visit box agreed to the build's downloads
    this.running = false;
    this.cancelled = false;
    this.last = null;              // the last build that worked (buildRecord's), also session.build until a TOML is opened
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
    const unsupported = unsupportedReason(s.configText || "");
    if (unsupported) return { ok: false, reason: unsupported };
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
    return Boolean(this.last) && !buildMatches(this.session, this.last);
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
    // The card's own last build: opening a board TOML clears session.build,
    // but its files stay here, labeled as from an earlier configuration.
    if (this.last && !this.running) renderArtifacts(this.els.artifacts, this.last, { stale: this.stale });
  }

  // ── The toolchain ─────────────────────────────────────────────────

  /** The published release, once per page (the pill shows it). */
  async discover() {
    try {
      const tc = await this.builder.discover();
      this.toolchainError = "";
      return tc;
    } catch (e) {
      this.toolchainError = e.message;
      throw e;
    } finally {
      this.renderPill();
    }
  }

  /** For the Configure tab's first-visit box: {size} of the compiler when this browser does not have it yet, else null. */
  async compilerToFetch() {
    try {
      const tc = await this.discover();
      if ((this.builder.files && this.builder.filesId === tc.id) || this.builder.cached || this.builder.fetching) return null;
      return { size: Builder.size(tc) };
    } catch (e) {
      return null;
    }
  }

  /**
   * Get the compiler ready while the user configures: the release's files
   * into the cache, the workers left for the first build. The Configure
   * tab's first-visit box asks for it (it lists the size), so the first
   * build asks no more. A failure is left for the build, which says why.
   */
  async prefetch() {
    this.consented = true;
    try {
      const tc = await this.discover();
      if (this.running) return;
      await this.builder.fetchToolchain(tc, {
        onProgress: ({ done, total }) => {
          if (this.running) return;
          this.renderPill({
            busy: true, text: `Toolchain: ${Math.round((100 * done) / (total || 1))}%`,
            title: `downloading while you configure, ${formatBytes(done)} of ${formatBytes(total)}`,
          });
        },
      });
    } catch (e) { /* the build loads it again and says why */ } finally {
      if (!this.running) this.renderPill();
    }
  }

  renderPill(state = null) {
    const pill = this.els.pill;
    if (!pill) return;
    const b = this.builder;
    const tc = b.toolchain;
    const set = (cls, text, title, badge = "") => {
      pill.className = `pill${cls ? ` ${cls}` : ""}`;
      pill.innerHTML = `${esc(text)}${badge ? `<span class="pill-badge">${esc(badge)}</span>` : ""}`;
      pill.title = title;
    };
    const size = formatBytes(Builder.size(tc));
    const what = tc ? `The compiler ${tc.id} (LLVM ${tc.manifest.llvm}, Arm Toolchain for Embedded ${tc.manifest.atfe})` : "The compiler";
    if (state && state.busy) {
      set("busy", state.text, `${what}: ${state.title || state.text}`);
    } else if (b.ready) {
      set("ready", "Toolchain", `${what}: ${b.pool.size} worker${b.pool.size === 1 ? "" : "s"} running, ${size}` +
        `${b.cached ? ", from this browser's cache" : ""}.`, b.cached ? "cached" : "");
    } else if (this.toolchainError) {
      set("error", "Toolchain: none", this.toolchainError);
    } else if (tc) {
      set(b.cached ? "" : "off", "Toolchain",
        b.cached ? `${what}: ${size}, in this browser's cache; it starts with the first build.`
          : `${what}: ${size}, downloaded with the first build and kept in this browser's cache.`,
        b.cached ? "cached" : "");
    } else {
      set("off", "Toolchain", "The compiler (clang and lld for Arm, in WebAssembly), downloaded with the first build.");
    }
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
    const s = this.session;
    let list = [];
    try {
      list = await this.builder.downloads(tc, { project: s.project, ref: s.ref, index: s.index, libs: (s.plan && s.plan.libs) || [] });
    } catch (e) { /* the build lists what it loads anyway */ }
    if (list.some((d) => !d.cached) && remembered(AUTO_KEY) !== "1" && !this.consented) {
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

  // A row of the list for something the build does, as builder.js draws it.
  step(text) {
    const row = this.addRow(text);
    if (/^Starting \d+ compiler worker/.test(text)) {
      this.renderPill({ busy: true, text: "Toolchain: starting", title: text.toLowerCase() });
    }
    return {
      progress: (done, total) => this.rowProgress(row, done, total),
      finish: (note = null) => this.finishRow(row, note),
    };
  }

  async run(tc) {
    const s = this.session;
    if (this.running || !this.check().ok) return;
    this.running = true;
    this.cancelled = false;
    const job = { project: s.project, ref: s.ref, configText: s.configText, defconfigText: s.defconfigText, failed: null };
    this.els.start.hidden = true;
    this.resetView();
    s.setLocked("A build is running.");
    this.startClock();
    this.render();
    const step = (text) => this.step(text);
    try {
      this.builder.begin();
      await this.builder.prepare(tc, {
        step,
        onDownload: (done, total) => this.renderPill({
          busy: true, text: `Toolchain: ${Math.round((100 * done) / (total || 1))}%`,
          title: `downloading, ${formatBytes(done)} of ${formatBytes(total)}`,
        }),
      });
      // Later visits build without asking only when the release is in Cache
      // Storage: one held in memory since Clear cache would download again.
      this.builder.cached = (await cachedFlags(tc.files)).every(Boolean);
      if (this.builder.cached) remember(AUTO_KEY, "1");
      this.renderPill();
      const out = await this.configurator.exclusive(() => {
        if (!s.ref || s.ref.id !== job.ref.id || s.project !== job.project) {
          throw new Error("The version changed before the build started.");
        }
        return this.builder.run({
          project: job.project, ref: job.ref, index: s.index, configText: job.configText, defconfigText: job.defconfigText,
          step, onProgress: (phase, detail, info) => this.onEngineProgress(phase, detail, info, job),
        });
      });
      this.flushLog();
      this.finishOk(out, job);
    } catch (e) {
      this.flushLog();
      if (e instanceof BuildCancelled || this.cancelled) this.finishCancelled();
      else this.finishFailed(job.failed, e);
    } finally {
      this.running = false;
      this.stopClock();
      s.setLocked("");
      this.render();
      this.renderPill();
    }
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

  finishOk({ result, outputs, stats }, job) {
    const s = this.session;
    const total = now() - this.clockStart;
    this.finishOpen(null);
    this.els.bar.value = this.els.bar.max;
    const build = buildRecord(result, outputs, { project: job.project, ref: job.ref.id });
    this.last = build;
    renderMemory(this.els.memory, build.memory);
    const engine = Number(result.duration) * 1000;
    // The time the clock showed: the wait from the click, downloads included.
    this.setStatus("ok", `Built in ${seconds(total)}`, `Compiling took ${seconds(engine)}; the rest was downloading and starting the compiler.`);
    build.timing = { engine, total, workers: this.builder.pool ? this.builder.pool.size : 0, summary: stats };
    this.appendLog(`WebFlash: built ${build.version} in ${seconds(total)} (compiling ${seconds(engine)}).`);
    if (stats) {
      this.appendLog(`WebFlash: ${stats.jobs} tool runs on ${stats.workers.length} compiler worker${stats.workers.length === 1 ? "" : "s"}, ` +
        `up to ${stats.overlap} at once; ${stats.compiles.count} compiles, median ${duration(stats.compiles.median)}, ` +
        `slowest ${duration(stats.compiles.max)} (${stats.compiles.slowest})` +
        `${stats.links.length ? `; ${stats.links.map((l) => `link ${l.out} ${duration(l.ms)}`).join(", ")}` : ""}.`);
      this.appendLog(`WebFlash: ${stats.workers.map((w, i) => `worker ${i + 1}: ${w.jobs} runs, ${duration(w.busy)} busy` +
        `${w.peakMemory ? `, ${formatBytes(w.peakMemory)} peak memory` : ""}`).join("; ")}.`);
    }
    this.flushLog();
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

  async cancel() {
    if (!this.running || this.cancelled) return;
    this.cancelled = true;
    this.render();
    this.setStatus("", "Cancelling…", "Stopping the compiler workers and the build");
    // The engine stops at its next step; compiles in flight stop with their
    // workers, which start again with the next build.
    await this.builder.cancel("the build was cancelled");
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
    const b = this.builder;
    const tc = b.toolchain;
    if (!tc) return this.toolchainError ? esc(this.toolchainError) : "loads with the first build";
    return `${esc(tc.id)}: LLVM ${esc(tc.manifest.llvm)}, Arm Toolchain for Embedded ${esc(tc.manifest.atfe)}, ` +
      `${esc(formatBytes(Builder.size(tc)))}${b.cached ? ", in this browser's cache" : ", not downloaded yet"}` +
      `${b.ready ? `; ${b.pool.size} worker${b.pool.size === 1 ? "" : "s"} running` : ""}`;
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
    const tc = this.builder.toolchain;
    const licenses = tc && tc.manifest.licenses ? Object.entries(tc.manifest.licenses) : [];
    const machine = [cores ? `${cores} cores` : "", navigator.deviceMemory ? `at least ${navigator.deviceMemory} GB of memory` : ""]
      .filter(Boolean).join(", ");
    el.innerHTML =
      `<h3>Build</h3><table class="about-table">` +
      `<tr><td>Compiler workers</td><td><select id="about-workers" title="How many compiles run at once. Each worker holds its own compiler and a copy of the sources.">${options.join("")}</select>` +
      `${machine ? `<div class="about-note">${esc(machine)}</div>` : ""}</td></tr>` +
      `<tr><td>Kept in this browser</td><td id="about-storage">…</td></tr>` +
      `</table>` +
      (licenses.length ? `<h3>Compiler licenses</h3><ul class="about-licenses">` + licenses.map(([what, file]) =>
        `<li><a href="${esc(new URL(file, tc.base).href)}" target="_blank" rel="noopener" title="${esc(file)}">${esc(what)}</a></li>`).join("") +
        `</ul>` : "");
    el.querySelector("#about-workers").addEventListener("change", (e) => {
      setChosenWorkerCount(e.target.value === "auto" ? null : Number(e.target.value));
      this.renderPill();
    });
    this.renderStorage(el.querySelector("#about-storage"));
  }

  async renderStorage(cell) {
    // The browser updates its estimate in its own time: right after Clear
    // cache it would still count what was just removed.
    if (this.clearedAt && Date.now() - this.clearedAt < 10000) {
      cell.textContent = "nothing: the cache was just emptied";
      return;
    }
    const e = await storageEstimate();
    if (!cell.isConnected) return;
    if (!e || e.usage === null) {
      cell.textContent = "this browser does not say";
      return;
    }
    cell.textContent = `${bigBytes(e.caches !== null ? e.caches : e.usage)}` +
      `${e.caches !== null ? " in the download cache" : " in all"}${e.quota ? ` (room for ${bigBytes(e.quota)})` : ""}`;
  }

  /** After About's Clear cache: the next build asks before downloading again. */
  async cacheCleared() {
    this.clearedAt = Date.now();
    remember(AUTO_KEY, null);
    this.consented = false;
    const tc = this.builder.toolchain;
    if (tc) this.builder.cached = (await cachedFlags(tc.files)).every(Boolean);
    this.renderPill();
  }
}

export { clearCache };
