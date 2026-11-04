// The Build step (SPEC 2.1 item 3): build the configuration in the browser,
// Katapult first and the firmware last when both are picked.
//
// Build downloads what it needs the first time (the compiler release and the
// library bundles the Makefiles name; page 1's Next agreed to them, and a
// direct Build after Clear cache lists them with their sizes first), starts
// the toolchain workers, gives them and the engine each tree's sources, and
// runs the engine's build of each slot in turn: the project's own Makefiles
// under Pyodide, every compiler command sent to the workers (builder.js's
// runAll does all of that; this is its view on the site). While it runs
// configuring is locked, each firmware's row counts its files, the steps and
// the log fill (folded), and Cancel stops it (the workers are terminated and
// started again for the next build). Afterwards each row offers its files,
// the folded Memory holds each project's table, and the results go to
// session.builds, which the Flash step reads. A configuration changed after
// the build turns the button into Rebuild.
//
// The engine holds the slots' trees, so the build runs in the configurator's
// queue: nothing else touches the engine while it runs.

import * as runtime from "../runtime.js";
import { esc } from "../dialogs.js";
import { formatBytes, projectTitle } from "../configure/sources.js";
import { copyText } from "../configure/config-tab.js";
import { chosenWorkerCount, defaultWorkerCount, setChosenWorkerCount, workerCount } from "./toolchain-pool.js";
import { cachedFlags, clearCache, storageEstimate } from "./cache.js";
import { buildMatches, buildRecord, configKey, renderArtifacts, renderMemory, slotConfig, slotsToBuild } from "./artifacts.js";
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

/**
 * The Build step's note for a plan that failed (main.js's #build-plan line).
 * The bridge's refusal of an architecture WebFlash does not build (the twin
 * of devices.js's unsupportedReason) is a whole sentence already; any other
 * error says what could not be worked out.
 */
export function planErrorLine(error) {
  const text = String(error || "");
  return text.includes("cannot be built in WebFlash") ? text : `Could not work out what the build needs: ${text}`;
}

/** The status of a firmware's row: "Waiting", a step, "112 / 196 files", "Done". */
export function jobStatus({ state = "waiting", step = "", done = null, total = null } = {}) {
  if (state === "done") return "Done";
  if (state === "failed") return "Failed";
  if (state === "cancelled") return "Cancelled";
  if (state === "waiting") return "Waiting";
  if (Number.isFinite(total) && total > 0) return `${Math.min(done || 0, total)} / ${total} files`;
  return step || "Starting";
}

/** Why a slot of the session ("fw" or "katapult") cannot be built now, or "". */
export function slotProblem(s, slot) {
  const k = slot === "katapult" ? s.katapult : null;
  const sources = k ? k.sources : s.sources;
  const ref = k ? k.ref : s.ref;
  const title = k ? "Katapult" : projectTitle(s.index, s.project);
  if (!sources || sources.state !== "ready" || !ref) return `Load ${k ? "Katapult's" : "the"} configuration first.`;
  const unsupported = unsupportedReason((k ? k.configText : s.configText) || "");
  if (unsupported) return unsupported;
  const p = k ? k.plan : s.plan;
  if (!p || p.ref !== ref.id) return "Working out what the build needs…";
  if (p.error) return `Could not work out what the ${title} build needs: ${p.error}`;
  if (p.unavailable && p.unavailable.length) {
    return `This snapshot of ${title} lacks ${p.unavailable.join(", ")}, which the build needs.`;
  }
  return "";
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
   * els: {title, clock, pre, jobs, error, start, list, memoryBox, memory,
   * logBox, log, logCopy, logCount, button, cancel, pill}.
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
    this.consented = false;        // page 1's Next agreed to the build's downloads
    this.running = false;
    this.cancelled = false;
    // The last build of each slot that worked (buildRecord's), also
    // session.builds until a TOML is opened, when only the rows keep them.
    this.lastBuilds = { fw: null, katapult: null };
    this.jobs = new Map();         // slot -> the row's state while a build runs or after it
    this.compiler = null;          // the prerequisites' compiler item while the build loads it
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
      if (["sources", "plan", "ref", "config", "firmware", "open", "prebuilt", "lock", "project", "version", "katapult", "setup"].includes(what) ||
          String(what).startsWith("katapult-")) this.render();
    });
    this.render();
    this.renderPill();
    // What the toolchain is, for the status pill: two small files, not the toolchain.
    setTimeout(() => this.discover().catch(() => {}), 1000);
  }

  // ── State ──────────────────────────────────────────────────────────

  /** The firmware's last build (lastBuilds.fw). */
  get last() {
    return this.lastBuilds.fw;
  }

  /** The slots a build makes now, in order: Katapult first when it is picked. */
  get slots() {
    return slotsToBuild(this.session);
  }

  /** Whether a build can start now: {ok, reason}. */
  check() {
    const s = this.session;
    if (this.running) return { ok: false, reason: "A build is running." };
    if (!s.firmware) return { ok: false, reason: "This board TOML flashes a prebuilt file: there is nothing to build." };
    if (s.locked) return { ok: false, reason: s.locked };
    for (const slot of slotsToBuild(s)) {
      const why = slotProblem(s, slot);
      if (why) return { ok: false, reason: why };
    }
    return { ok: true, reason: "" };
  }

  /** Some build on record no longer matches the configuration: another project, version or .config. */
  get stale() {
    const slots = this.slots;
    if (!slots.some((slot) => this.lastBuilds[slot])) return Boolean(this.last);
    return slots.some((slot) => !buildMatches(this.session, this.lastBuilds[slot], slot));
  }

  /**
   * Whether a build of every slot is in session.builds and still matches:
   * the rows' records (lastBuilds) outlive an opened TOML, which drops
   * session.builds, so a reopened board builds again, as Next and Flash ask.
   */
  get current() {
    const builds = this.session.builds || {};
    return this.slots.every((slot) => buildMatches(this.session, builds[slot], slot));
  }

  render() {
    const { button, cancel } = this.els;
    const c = this.check();
    const any = Object.values(this.lastBuilds).some(Boolean);
    button.disabled = !c.ok;
    button.hidden = this.running;
    button.textContent = any ? "Rebuild" : "Build";
    button.title = c.ok ? (any && this.stale ? "The configuration changed since the last build: build it again" : "Compile in this browser") : c.reason;
    cancel.hidden = !this.running;
    cancel.disabled = this.cancelled;
    if (!this.running) this.renderJobs();
    this.renderPre();
  }

  // ── The view ─────────────────────────────────────────────────────

  // One row per firmware the configuration builds (Katapult first), each
  // with its last build's files (marked when the configuration moved on).
  renderJobs() {
    const slots = this.session.firmware ? this.slots : [];
    for (const slot of [...this.jobs.keys()]) if (!slots.includes(slot)) this.dropJob(slot);
    for (const slot of slots) {
      const job = this.job(slot);
      const build = this.lastBuilds[slot];
      if (job.state !== "failed" && job.state !== "cancelled") job.state = build ? "done" : "idle";
      // A record an opened TOML dropped from session.builds is from an earlier configuration too.
      job.stale = Boolean(build) && (build !== (this.session.builds || {})[slot] || !buildMatches(this.session, build, slot));
      this.drawJob(job);
    }
  }

  // The row of a slot, made on first use.
  job(slot) {
    let job = this.jobs.get(slot);
    if (job) return job;
    const make = (tag, cls, parent) => {
      const node = document.createElement(tag);
      node.className = cls;
      parent.appendChild(node);
      return node;
    };
    const el = document.createElement("div");
    el.className = "job";
    el.setAttribute("data-slot", slot);
    const head = make("div", "job-head", el);
    const parts = {
      name: make("strong", "job-name", head),
      version: make("span", "job-version", head),
      status: make("span", "job-status", head),
      bar: make("progress", "job-bar", el),
      error: make("div", "build-error job-error", el),
      files: make("div", "job-files", el),
    };
    parts.status.setAttribute("aria-live", "polite");
    parts.bar.setAttribute("aria-label", "Build progress");
    parts.error.setAttribute("role", "alert");
    parts.error.hidden = true;
    job = { slot, el, parts, state: "idle", step: "", done: null, total: null, stale: false };
    this.jobs.set(slot, job);
    // Katapult's row comes first.
    const first = this.els.jobs.firstChild;
    if (slot === "katapult" && first) this.els.jobs.insertBefore(el, first);
    else this.els.jobs.appendChild(el);
    return job;
  }

  dropJob(slot) {
    const job = this.jobs.get(slot);
    if (!job) return;
    job.el.remove();
    this.jobs.delete(slot);
  }

  drawJob(job) {
    const s = this.session;
    const el = job.el;
    const build = this.lastBuilds[job.slot];
    const now = slotConfig(s, job.slot);
    const { name, version: versionEl, status, bar, files } = job.parts;
    const project = (now && now.project) || (build && build.project) || "";
    name.textContent = project === "katapult" ? "Katapult" : projectTitle(s.index, project) || project;
    // A finished build names what it built (git describe), else the ref configured.
    versionEl.textContent = job.state === "done" && build ? build.version || build.ref : now && now.ref ? now.ref.id : "";
    status.textContent = job.state === "idle" ? "Not built" : jobStatus(job);
    status.className = `job-status ${job.state}`;
    el.className = `job${job.state === "running" ? " running" : ""}`;
    bar.hidden = job.state === "idle" || job.state === "waiting" && !this.running;
    if (job.state === "done") {
      bar.max = 1;
      bar.value = 1;
    } else if (Number.isFinite(job.total) && job.total > 0) {
      bar.max = job.total;
      bar.value = job.done || 0;
    } else if (job.state === "running") {
      bar.removeAttribute("value");
    } else {
      bar.max = 1;
      bar.value = 0;
    }
    if (build && job.state !== "running" && job.state !== "waiting") renderArtifacts(files, build, { stale: job.stale, compact: true });
    else files.replaceChildren();
  }

  // The prerequisites line: Python, the sources and the compiler, checked off.
  renderPre() {
    const el = this.els.pre;
    if (!el) return;
    const s = this.session;
    const k = s.katapult && s.katapult.on ? s.katapult : null;
    const sourcesOk = s.sources.state === "ready" && (!k || (k.sources && k.sources.state === "ready"));
    const sourcesBusy = s.sources.state === "loading" || Boolean(k && k.sources && k.sources.state === "loading");
    const b = this.builder;
    const items = [
      { text: "Python", state: runtime.isReady() ? "ok" : "wait" },
      { text: "Sources", state: sourcesOk ? "ok" : sourcesBusy ? "run" : "wait" },
    ];
    if (this.compiler) items.push(this.compiler);
    else if (b.ready) items.push({ text: `Compiler${b.cached ? " (cached)" : ""}`, state: "ok" });
    else items.push({ text: `Compiler${b.cached ? " (cached)" : ""}`, state: b.fetching ? "run" : "wait" });
    el.innerHTML = items.map((i) => `<li class="pre-${i.state}">${i.state === "run" ? `<span class="spinner" aria-hidden="true"></span>` : ""}${esc(i.text)}</li>`).join("");
    el.hidden = !s.firmware;
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

  /** For the Configure step's start box: {size} of the compiler when this browser does not have it yet, else null. */
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
   * into the cache, the workers left for the first build. Page 1's Next
   * (or the Configure step's start box) asks for it, listing the size, so
   * the first build asks no more. A failure is left for the build, which
   * says why.
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
            busy: true, text: `Compiler: ${Math.round((100 * done) / (total || 1))}%`,
            title: `downloading while you configure, ${formatBytes(done)} of ${formatBytes(total)}`,
          });
        },
      });
    } catch (e) { /* the build loads it again and says why */ } finally {
      if (!this.running) this.renderPill();
      this.renderPre();
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
    const what = tc ? `${tc.id} (LLVM ${tc.manifest.llvm}, Arm Toolchain for Embedded ${tc.manifest.atfe})` : "clang and lld for Arm, in WebAssembly";
    if (state && state.busy) {
      set("busy", state.text, `${what}: ${state.title || state.text}`);
    } else if (b.ready) {
      set("ready", "Compiler", `${what}: ${b.pool.size} worker${b.pool.size === 1 ? "" : "s"} running, ${size}` +
        `${b.cached ? ", from this browser's cache" : ""}.`, b.cached ? "cached" : "");
    } else if (this.toolchainError) {
      set("error", "Compiler: none", this.toolchainError);
    } else if (tc) {
      set(b.cached ? "" : "off", "Compiler",
        b.cached ? `${what}: ${size}, in this browser's cache.` : `${what}: ${size}, downloaded once with the first build.`,
        b.cached ? "cached" : "");
    } else {
      set("off", "Compiler", `${what}, downloaded once with the first build.`);
    }
  }

  // ── Building ──────────────────────────────────────────────────────

  // What each slot builds: run()'s options for builder.runAll.
  jobsToRun() {
    const s = this.session;
    return this.slots.map((slot) => {
      if (slot === "katapult") {
        const k = s.katapult;
        return { slot, project: "katapult", ref: k.ref, configText: k.configText, defconfigText: k.defconfigText, failed: null, libs: (k.plan && k.plan.libs) || [] };
      }
      return { slot, project: s.project, ref: s.ref, configText: s.configText, defconfigText: s.defconfigText, failed: null, libs: (s.plan && s.plan.libs) || [] };
    });
  }

  async onBuild() {
    if (!this.check().ok) return;
    this.clearError();
    let tc;
    try {
      tc = await this.discover();
    } catch (e) {
      this.showFailure(this.els.error, "No compiler", e.message);
      return;
    }
    const s = this.session;
    let list = [];
    try {
      for (const job of this.jobsToRun()) {
        for (const d of await this.builder.downloads(tc, { project: job.project, ref: job.ref, index: s.index, libs: job.libs })) {
          if (!list.some((x) => x.label === d.label)) list.push(d);
        }
      }
    } catch (e) { /* the build lists what it loads anyway */ }
    // Page 1's Next agreed to the downloads; a build after Clear cache asks again.
    if (list.some((d) => !d.cached) && remembered(AUTO_KEY) !== "1" && !this.consented) {
      this.showStart(tc, list);
      return;
    }
    this.run(tc);
  }

  /** What the build downloads, with sizes, and a Start: for a build nothing agreed to yet. */
  showStart(tc, list) {
    const el = this.els.start;
    const total = list.filter((d) => !d.cached).reduce((n, d) => n + (d.size || 0), 0);
    el.hidden = false;
    el.innerHTML =
      `<p>The build downloads ${esc(formatBytes(total))}, once:</p>` +
      `<ul class="build-downloads">` +
      list.map((d) => `<li><span>${esc(d.label)}</span><span class="dl-size">${esc(d.size ? formatBytes(d.size) : "size unknown")}</span>` +
        `${d.cached ? `<span class="dl-cached">cached</span>` : ""}</li>`).join("") +
      `</ul>` +
      `<div class="build-start-actions"><button class="primary" id="build-start-go">Download and build</button>` +
      `<button id="build-start-no">Not now</button></div>`;
    el.querySelector("#build-start-go").addEventListener("click", () => {
      el.hidden = true;
      if (this.check().ok) this.run(tc);
    });
    el.querySelector("#build-start-no").addEventListener("click", () => { el.hidden = true; });
    el.querySelector("#build-start-go").focus();
  }

  // A row of the steps list for something the build does, as builder.js
  // draws it; the compiler's own rows also drive the prerequisites line,
  // a job's its status.
  step(text, job = null) {
    const owner = job ? this.jobs.get(job.slot) : null;
    const pair = this.jobs.size > 1;
    const row = this.addRow(owner && pair ? `${this.titleOf(job)}: ${text}` : text);
    if (/^Loading the compiler/.test(text)) {
      this.compiler = { text: "Compiler: loading", state: "run" };
      this.renderPre();
    } else if (/^Starting \d+ compiler worker/.test(text)) {
      this.compiler = { text: "Compiler: starting", state: "run" };
      this.renderPre();
      this.renderPill({ busy: true, text: "Compiler: starting", title: text.toLowerCase() });
    }
    if (owner) {
      owner.step = text;
      this.drawJob(owner);
    }
    return {
      progress: (done, total) => {
        this.rowProgress(row, done, total);
        if (/^Loading the compiler/.test(text) && Number.isFinite(total) && total > 0) {
          this.compiler = { text: `Compiler: ${Math.min(100, Math.round((100 * done) / total))}%`, state: "run" };
          this.renderPre();
        }
      },
      finish: (note = null) => this.finishRow(row, note),
    };
  }

  titleOf(job) {
    return job.project === "katapult" ? "Katapult" : projectTitle(this.session.index, job.project) || job.project;
  }

  async run(tc) {
    const s = this.session;
    if (this.running || !this.check().ok) return;
    this.running = true;
    this.cancelled = false;
    const jobs = this.jobsToRun();
    this.els.start.hidden = true;
    this.resetView(jobs);
    s.setLocked("A build is running.");
    this.startClock();
    this.render();
    const done = {};
    try {
      this.builder.begin();
      await this.builder.prepare(tc, {
        step: (text) => this.step(text),
        onDownload: (got, total) => this.renderPill({
          busy: true, text: `Compiler: ${Math.round((100 * got) / (total || 1))}%`,
          title: `downloading, ${formatBytes(got)} of ${formatBytes(total)}`,
        }),
      });
      this.compiler = null;
      // Later visits build without asking only when the release is in Cache
      // Storage: one held in memory since Clear cache would download again.
      this.builder.cached = (await cachedFlags(tc.files)).every(Boolean);
      if (this.builder.cached) remember(AUTO_KEY, "1");
      this.renderPill();
      this.renderPre();
      await this.configurator.exclusive(() => {
        for (const job of jobs) {
          const now = slotConfig(s, job.slot);
          if (!now || !now.ref || now.ref.id !== job.ref.id || now.project !== job.project) {
            throw new Error("The version changed before the build started.");
          }
        }
        return this.builder.runAll(jobs.map((j) => ({ ...j, index: s.index })), {
          step: (text, job) => this.step(text, job),
          onProgress: (phase, detail, info, job) => this.onEngineProgress(phase, detail, info, job),
          onStart: (job) => this.setJob(job.slot, { state: "running", step: "Starting" }),
          onDone: (job, out) => { done[job.slot] = this.jobDone(job, out); },
        });
      });
      this.flushLog();
      this.finishOk(done, jobs);
    } catch (e) {
      this.flushLog();
      this.compiler = null;
      const failed = jobs.find((j) => this.jobs.get(j.slot) && this.jobs.get(j.slot).state === "running");
      if (e instanceof BuildCancelled || this.cancelled) this.finishCancelled(jobs);
      else this.finishFailed(failed, e, jobs);
      this.publish(done);
    } finally {
      this.running = false;
      this.stopClock();
      s.setLocked("");
      this.render();
      this.renderPill();
    }
  }

  setJob(slot, fields) {
    const job = this.jobs.get(slot);
    if (!job) return;
    Object.assign(job, fields);
    this.drawJob(job);
  }

  onEngineProgress(phase, detail, info, job) {
    if (!ENGINE_PHASES.has(phase)) return;
    const pair = this.jobs.size > 1;
    const tag = (text) => (pair ? `${this.titleOf(job)}: ${text}` : text);
    if (phase === "log") {
      this.appendLog(detail);
      return;
    }
    if (phase === "failed") {
      job.failed = detail;
      return;
    }
    if (Number.isFinite(info.total) && info.total > 0) this.setJob(job.slot, { done: info.done || 0, total: info.total });
    if (phase === "configure") {
      this.addRow(tag("Configuring"));
      this.setJob(job.slot, { step: "Configuring" });
    } else if (phase === "plan") {
      this.stepRow(tag("Reading the Makefiles"));
      this.setJob(job.slot, { step: "Reading the Makefiles" });
    } else if (phase === "build") {
      this.stepRow(tag(`Building: ${detail}`));
      this.finishOpen(null);
    } else if (phase === "step") {
      this.addRow(detail, { target: true });
    } else if (phase === "done") {
      const row = [...this.rows].reverse().find((r) => r.target && !r.done && (r.text.endsWith(` ${detail}`) || r.text === detail));
      if (row) this.finishRow(row);
    }
  }

  // ── Endings ──────────────────────────────────────────────────────

  // One job built: its record, its row done with its files.
  jobDone(job, { result, outputs, stats }) {
    this.finishOpen(null);
    const build = buildRecord(result, outputs, { project: job.project, ref: job.ref.id, slot: job.slot });
    build.timing = { engine: Number(result.duration) * 1000, workers: this.builder.pool ? this.builder.pool.size : 0, summary: stats };
    this.lastBuilds = { ...this.lastBuilds, [job.slot]: build };
    this.setJob(job.slot, { state: "done" });
    const title = this.titleOf(job);
    this.appendLog(`WebFlash: built ${title} ${build.version} (compiling ${seconds(build.timing.engine)}).`);
    if (stats) {
      this.appendLog(`WebFlash: ${stats.jobs} tool runs on ${stats.workers.length} compiler worker${stats.workers.length === 1 ? "" : "s"}, ` +
        `up to ${stats.overlap} at once; ${stats.compiles.count} compiles, median ${duration(stats.compiles.median)}, ` +
        `slowest ${duration(stats.compiles.max)} (${stats.compiles.slowest})` +
        `${stats.links.length ? `; ${stats.links.map((l) => `link ${l.out} ${duration(l.ms)}`).join(", ")}` : ""}.`);
      this.appendLog(`WebFlash: ${stats.workers.map((w, i) => `worker ${i + 1}: ${w.jobs} runs, ${duration(w.busy)} busy` +
        `${w.peakMemory ? `, ${formatBytes(w.peakMemory)} peak memory` : ""}`).join("; ")}.`);
    }
    return build;
  }

  // The builds that worked go to session.builds (a slot built before and not
  // built again keeps its record), with one "build" change.
  publish(done) {
    if (!Object.keys(done).length) return;
    const s = this.session;
    s.builds = { ...(s.builds || { fw: null, katapult: null }), ...done };
    s._changed("build", "build");
  }

  finishOk(done, jobs) {
    const total = now() - this.clockStart;
    this.finishOpen(null);
    const builds = jobs.map((j) => done[j.slot]).filter(Boolean);
    const engine = builds.reduce((n, b) => n + b.timing.engine, 0);
    for (const b of builds) b.timing.total = total;
    // The time the clock showed: the wait from the click, downloads included.
    const each = builds.length > 1 ? ` (${builds.map((b) => `${b.project === "katapult" ? "Katapult" : projectTitle(this.session.index, b.project)} ${seconds(b.timing.engine)}`).join(", ")})` : "";
    this.setClock(`Built in ${seconds(total)}, downloads included.`, `Compiling took ${seconds(engine)}${each}.`);
    this.setTitle("Built");
    this.appendLog(`WebFlash: done in ${seconds(total)} (compiling ${seconds(engine)}).`);
    this.flushLog();
    this.renderMemoryTables();
    this.publish(done);
  }

  finishCancelled(jobs) {
    this.finishOpen("cancelled");
    for (const j of jobs) {
      const job = this.jobs.get(j.slot);
      if (job && job.state !== "done") this.setJob(j.slot, { state: "cancelled" });
    }
    this.setTitle("Cancelled");
    this.setClock("Cancelled.");
    this.renderMemoryTables();
  }

  finishFailed(job, error, jobs) {
    const message = (job && job.failed) || runtime.pythonMessage(error);
    this.finishOpen("failed");
    for (const j of jobs) {
      const row = this.jobs.get(j.slot);
      if (!row || row.state === "done") continue;
      this.setJob(j.slot, { state: j === job ? "failed" : "cancelled" });
    }
    this.setTitle("Build failed");
    this.setClock(message.split("\n")[0]);
    const row = job ? this.jobs.get(job.slot) : null;
    this.showFailure(row ? row.parts.error : this.els.error, "The build failed", message);
    this.els.logBox.open = true;
    this.renderMemoryTables();
  }

  showFailure(el, title, message) {
    const { command, code, output } = splitFailure(message);
    el.hidden = false;
    el.innerHTML = `<strong>${esc(title)}</strong>` +
      (command ? `<p class="build-error-what">This command failed${code !== null ? ` (exit code ${code})` : ""}:</p>` +
        `<pre class="build-cmd">${esc(command)}</pre>` : "") +
      (output ? `<pre class="build-out">${esc(output)}</pre>` : "");
  }

  clearError() {
    for (const el of [this.els.error, ...[...this.jobs.values()].map((j) => j.parts.error)]) {
      el.hidden = true;
      el.replaceChildren();
    }
  }

  async cancel() {
    if (!this.running || this.cancelled) return;
    this.cancelled = true;
    this.render();
    this.setClock("Cancelling…", "Stopping the compiler workers and the build");
    // The engine stops at its next step; compiles in flight stop with their
    // workers, which start again with the next build.
    await this.builder.cancel("the build was cancelled");
    this.renderPill();
  }

  // Each project's memory table, in build order, under the folded Memory.
  renderMemoryTables() {
    const box = this.els.memory;
    box.replaceChildren();
    const builds = ["katapult", "fw"].map((slot) => this.lastBuilds[slot]).filter((b) => b && b.memory && this.jobs.has(b.slot));
    for (const b of builds) {
      const table = document.createElement("table");
      table.className = "memory";
      renderMemory(table, b.memory);
      const caption = table.querySelector("caption");
      if (caption) caption.textContent = b.project === "katapult" ? "Katapult" : projectTitle(this.session.index, b.project) || b.project;
      box.appendChild(table);
    }
    this.els.memoryBox.hidden = !builds.length;
  }

  resetView(jobs) {
    const { list, log, logCount, logCopy } = this.els;
    this.rows = [];
    list.replaceChildren();
    this.clearError();
    for (const slot of [...this.jobs.keys()]) if (!jobs.some((j) => j.slot === slot)) this.dropJob(slot);
    for (const j of jobs) {
      const job = this.job(j.slot);
      Object.assign(job, { state: "waiting", step: "", done: null, total: null, stale: false });
      this.drawJob(job);
    }
    this.els.memoryBox.hidden = true;
    this.setTitle("Building…");
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

  setTitle(text) {
    if (this.els.title) this.els.title.textContent = text;
  }

  setClock(text, title = "") {
    const el = this.els.clock;
    el.textContent = text;
    el.title = title;
  }

  startClock() {
    this.clockStart = now();
    const tick = () => this.setClock(`${this.cancelled ? "Cancelling" : "Building"} · ${seconds(now() - this.clockStart)}`);
    tick();
    clearInterval(this._clock);
    this._clock = setInterval(tick, 200);
  }

  stopClock() {
    clearInterval(this._clock);
    this._clock = null;
  }

  // ── About ────────────────────────────────────────────────────────

  /** The Compiler row of About. */
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
      `<tr><td>Compiler workers</td><td><select id="about-workers" title="How many compiles run at once; each worker holds its own compiler and a copy of the sources.">${options.join("")}</select>` +
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
    this.renderPre();
  }
}

export { clearCache };
