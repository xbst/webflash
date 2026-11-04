// Page 1 of the wizard, Firmware: what to flash and which versions.
//
// The firmware switch (Klipper, Kalico, None) and the Katapult checkbox are
// the session's [firmware] project (Klipper or Kalico, or Katapult when it is
// picked alone) and its [katapult] table: Katapult beside a firmware is
// session.katapult, configured in the engine's second slot. Ticking it once
// configuring has started loads it at once (its shared options follow the
// firmware's); unticking it lets the slot go.
//
// Next is the consent the site asks for before downloading: it starts Python
// and the sources of the picked projects (configurator.load) and the compiler
// (in the background), then moves on to Configure. The footer's hint names
// what that downloads and its size, from the sources index and the compiler's
// manifest, or says everything is in this browser already.

import { mountVersionPicker } from "../configure/version-picker.js";
import { blobUrl, formatBytes, resolveVersionAsync } from "../configure/sources.js";
import { isCached } from "../workers/blob-cache.js";
import * as runtime from "../runtime.js";

// Pyodide and the packages the engine loads, from jsDelivr: about 7 MB.
const PYTHON_SIZE = 7 * 1048576;

/**
 * The footer's hint for what Next downloads: items are [{what, size,
 * cached}] ("Python", "the sources", "the compiler"); a size may be null.
 */
export function downloadHint(items) {
  const todo = items.filter((i) => !i.cached);
  if (!todo.length) return "Everything is in this browser already.";
  const names = todo.map((i) => i.what);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const known = todo.filter((i) => Number.isFinite(i.size));
  const total = known.reduce((n, i) => n + i.size, 0);
  const size = !known.length ? "" : total >= 1048576 ? `about ${Math.max(1, Math.round(total / 1048576))} MB, ` : `${formatBytes(total)}, `;
  return `Next downloads ${list} (${size}once).`;
}

/**
 * The page's picks from the session's project and the Katapult checkbox:
 * {fw: "klipper" | "kalico" | "none", katapult}. Katapult as the project is
 * None with Katapult ticked.
 */
export function picksFor(project, katapult) {
  if (project === "katapult") return { fw: "none", katapult: true };
  return { fw: project || "klipper", katapult: Boolean(katapult) };
}

const PROJECT_NAMES = { klipper: "Klipper", kalico: "Kalico", katapult: "Katapult" };

/**
 * Mount or update a version picker (U04's combobox: older commits, a pasted
 * Mainsail version) in host. Returns the picker.
 */
function renderPicker(picker, host, { index, project, version, busy, onChange }) {
  const opts = { project, index: index || null, value: version, disabled: busy, label: `${PROJECT_NAMES[project] || project} version` };
  if (!picker) return mountVersionPicker(host, { ...opts, onChange });
  const o = picker.opts || {};
  if (o.project !== opts.project || o.index !== opts.index || o.value !== opts.value || o.disabled !== opts.disabled) picker.update(opts);
  return picker;
}

export class FirmwarePage {
  /**
   * els: {fwButtons (the switch's buttons, data-fw), fwVersion (the
   * version picker's host), fwVersionRow, katapult (the checkbox), katVersion,
   * katVersionRow, prebuilt, hint}. actions: {switchProject(project,
   * version?), switchVersion(version), loadKatapult(reason) (load
   * session.katapult once configuring has started), start() (load the
   * configuration), consent() (the compiler and the build's downloads),
   * compiler() (resolves to {size} or null), sourcesStarted()}.
   */
  constructor(session, configurator, wizard, els, actions) {
    this.session = session;
    this.configurator = configurator;
    this.wizard = wizard;
    this.els = els;
    this.actions = actions;
    this.indexError = "";
    this.katapult = false;
    // Katapult's version while it is not in the tables (unticked, or picked alone).
    this.katapultVersion = "latest";
    this.fw = picksFor(session.project, false).fw;
    this._hintCount = 0;
    this.sync();

    for (const b of els.fwButtons) b.addEventListener("click", () => this.pickFirmware(b.dataset.fw));
    els.katapult.addEventListener("change", () => this.pickKatapult(els.katapult.checked));
    this.fwPicker = null;
    this.katPicker = null;
    session.on("change", ({ what }) => {
      if (["project", "open", "undo", "katapult", "setup"].includes(what)) this.sync();
      if (["index", "project", "version", "firmware", "ref", "open", "lock", "prebuilt", "sources", "undo",
        "katapult", "katapult-sources", "setup"].includes(what)) this.render();
    });
    wizard.onNext("firmware", () => this.next());
    wizard.onEnter("firmware", () => this.render());
    this.render();
  }

  /** The list of versions did not load: say so in the selects. */
  setIndexError(message) {
    this.indexError = message || "";
    this.render();
  }

  // The page follows the session (an opened TOML, ?project=, undo, the Setup
  // select): None with nothing ticked is the page's own until a pick.
  sync() {
    const s = this.session;
    if (this.fw === "none" && !this.katapult && s.project !== "katapult") return;
    const k = s.katapult;
    if (k) this.katapultVersion = k.version;
    else if (s.project === "katapult" && s.version) this.katapultVersion = s.version;
    const picks = picksFor(s.project, Boolean(k));
    this.fw = picks.fw;
    this.katapult = picks.katapult;
  }

  get picked() {
    return this.fw !== "none" || this.katapult;
  }

  /** The project Next sets up: the firmware, else Katapult alone. */
  get project() {
    return this.fw !== "none" ? this.fw : this.katapult ? "katapult" : null;
  }

  pickFirmware(fw) {
    const s = this.session;
    const katapult = this.katapult;
    const alone = s.project === "katapult";
    this.fw = fw;
    const project = this.project;
    if (project && project !== s.project) {
      this.actions.switchProject(project, project === "katapult" ? this.katapultVersion : null);
    }
    // From Katapult alone to a firmware: Katapult stays ticked, beside it
    // (the switch made the page follow the session). The session brings back
    // the Katapult the firmware had, as configured alone: load it, or let it
    // go when it was unticked.
    this.katapult = katapult;
    if (fw !== "none" && katapult && !s.katapult) this._tickKatapult(true);
    else if (fw !== "none" && alone && katapult) this.actions.loadKatapult("start");
    else if (fw !== "none" && alone && s.katapult) s.setKatapult({ on: false });
    this.render();
  }

  pickKatapult(on) {
    const s = this.session;
    this.katapult = on;
    if (this.fw !== "none") {
      this._tickKatapult(on);
    } else if (on && s.project !== "katapult") {
      this.actions.switchProject("katapult", this.katapultVersion);
    }
    this.render();
  }

  // Katapult beside the firmware on or off: [katapult] in the tables, and
  // its slot in the engine once configuring has started.
  _tickKatapult(on) {
    const s = this.session;
    if (on) {
      s.setKatapult({ on: true, version: this.katapultVersion });
      this.actions.loadKatapult("start");
    } else {
      if (s.katapult) this.katapultVersion = s.katapult.version;
      s.setKatapult({ on: false });
    }
  }

  pickKatapultVersion(version) {
    const s = this.session;
    if (!version) return;
    this.katapultVersion = version;
    if (s.project === "katapult") this.actions.switchVersion(version);
    else if (s.katapult && s.katapult.version !== version) {
      s.setKatapult({ version });
      this.actions.loadKatapult("switch");
    }
  }

  render() {
    const s = this.session;
    const e = this.els;
    const prebuilt = !s.firmware;
    const busy = Boolean(s.locked);
    for (const b of e.fwButtons) {
      const on = b.dataset.fw === this.fw;
      b.classList.toggle("on", on);
      b.setAttribute("aria-checked", String(on));
      b.disabled = prebuilt || busy;
    }
    e.katapult.checked = this.katapult;
    e.katapult.disabled = prebuilt || busy;
    e.fwVersionRow.hidden = prebuilt || this.fw === "none";
    e.katVersionRow.hidden = prebuilt || !this.katapult;
    e.fwVersionRow.closest(".fw").classList.toggle("off", prebuilt || this.fw === "none");
    e.katVersionRow.closest(".fw").classList.toggle("off", prebuilt || !this.katapult);
    e.prebuilt.hidden = !prebuilt;
    if (prebuilt) {
      const file = s.toml && s.toml.prebuilt && s.toml.prebuilt.file;
      e.prebuilt.textContent = `This board TOML flashes its own file${file ? `, ${file}` : ""}: Next goes to Flash.`;
    }

    const index = s.index;
    // While a picker's own pick reaches the session, the renders it causes
    // would set it back to the old version (and drop its "Closest kept" note).
    const picking = (fn) => (v) => {
      this._picking = true;
      try { fn(v); } finally { this._picking = false; }
      this.render();
    };
    if (!prebuilt && this.fw !== "none" && s.project !== "katapult" && !this._picking) {
      this.fwPicker = renderPicker(this.fwPicker, e.fwVersion, {
        index, project: s.project, version: s.version, busy,
        onChange: picking((v) => { if (v && v !== s.version) this.actions.switchVersion(v); }),
      });
    }
    if (!prebuilt && this.katapult && !this._picking) {
      const version = s.project === "katapult" ? s.version : s.katapult ? s.katapult.version : this.katapultVersion;
      this.katPicker = renderPicker(this.katPicker, e.katVersion, {
        index, project: "katapult", version, busy, onChange: picking((v) => this.pickKatapultVersion(v)),
      });
    }

    this.wizard.setNext("firmware", {
      enabled: prebuilt || this.picked,
      reason: "Pick a firmware or Katapult.",
    });
    this.renderHint();
  }

  async renderHint() {
    const mine = ++this._hintCount;
    const s = this.session;
    const set = (text) => { if (mine === this._hintCount) this.wizard.setHint("firmware", text); };
    if (!s.firmware) return set("");
    if (!this.picked) return set("Pick at least one.");
    if (!s.index) return set(this.indexError ? `The list of versions did not load: ${this.indexError}` : "Loading the list of versions…");
    const items = [];
    if (!runtime.isReady() && !this.configurator.autoStart) items.push({ what: "Python", size: PYTHON_SIZE, cached: false });
    // The sources of each picked project, as one item.
    const parts = [[s.project, s.version, s.sources]];
    const k = s.katapult;
    if (k) parts.push(["katapult", k.version, k.sources]);
    const sources = [];
    for (const [project, version, st] of parts) {
      // An older commit's size is in its history file: wait for it.
      const { ref } = await resolveVersionAsync(s.index, project, version);
      if (mine !== this._hintCount) return;
      if (!ref) continue;
      const on = st.ref;
      const loaded = Boolean(on) && on.id === ref.id && ["loading", "ready"].includes(st.state);
      const cached = loaded || await isCached(blobUrl(ref.core));
      sources.push({ size: this.configurator.coreSize(ref), cached });
    }
    if (sources.length) {
      const todo = sources.filter((x) => !x.cached);
      const size = todo.some((x) => !Number.isFinite(x.size)) ? null : todo.reduce((n, x) => n + x.size, 0);
      items.push({ what: "the sources", size: todo.length ? size : 0, cached: !todo.length });
    }
    let compiler = null;
    try { compiler = await this.actions.compiler(); } catch (e) { compiler = null; }
    if (compiler) items.push({ what: "the compiler", size: compiler.size, cached: false });
    set(downloadHint(items));
  }

  // Next: the downloads start, and the wizard moves on.
  next() {
    const s = this.session;
    if (!s.firmware) return "flash";
    if (!this.picked) return false;
    if (!this.actions.sourcesStarted()) this.actions.start();
    else if (s.katapult && !this.configurator.slots.katapult && s.katapult.sources.state === "idle") this.actions.loadKatapult("start");
    this.actions.consent();
    return "configure";
  }
}
