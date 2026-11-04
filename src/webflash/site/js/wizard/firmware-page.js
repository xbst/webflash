// Page 1 of the wizard, Firmware: what to flash and which versions.
//
// The firmware switch (Klipper, Kalico, None) and the Katapult checkbox are
// the session's [firmware] project: Klipper or Kalico, or Katapult when it is
// picked alone. Katapult beside a firmware waits for the engine's second slot
// (chunk U01): until then the checkbox shows "Coming soon" there and Next
// sets up the firmware alone, the Katapult version kept on this page only.
//
// Next is the consent the site asks for before downloading: it starts Python
// and the sources of the picked project (configurator.load) and the compiler
// (in the background), then moves on to Configure. The footer's hint names
// what that downloads and its size, from the sources index and the compiler's
// manifest, or says everything is in this browser already.

import { versionOptions } from "../configure/version-picker.js";
import { blobUrl, formatBytes, projectTitle, resolveVersion, isChecked, uncheckedText } from "../configure/sources.js";
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

/**
 * Fill a version select (and its "unchecked" badge) for a project. The one
 * place the page calls versionOptions, for U04's mountVersionPicker to replace.
 */
export function renderVersionSelect(select, badge, { index, error = "", project, version, busy = false }) {
  select.replaceChildren();
  select.title = "";
  const noBadge = () => { if (badge) badge.hidden = true; };
  if (!index) {
    select.append(new Option(error ? "Versions unavailable" : "Loading versions…", ""));
    select.disabled = true;
    select.title = error || "Loading the list of versions…";
    return noBadge();
  }
  const { groups, value } = versionOptions(index, project, version);
  if (!groups.length) {
    select.append(new Option(`No ${projectTitle(index, project)} versions`, ""));
    select.disabled = true;
    return noBadge();
  }
  for (const g of groups) {
    const group = document.createElement("optgroup");
    group.label = g.label;
    for (const o of g.options) {
      const opt = new Option(o.label, o.value);
      if (o.title) opt.title = o.title;
      if (o.unchecked) opt.className = "unchecked";
      group.append(opt);
    }
    select.append(group);
  }
  if (value === null) {
    // A version the index does not have (a TOML pinned to an old ref).
    const missing = new Option(`${version} (not in the index)`, version);
    missing.disabled = true;
    select.prepend(missing);
  }
  select.value = version;
  select.disabled = busy;
  const resolved = resolveVersion(index, project, version);
  select.title = resolved.ref ? `${resolved.ref.describe || resolved.ref.id}${resolved.note ? `\n${resolved.note}` : ""}` : resolved.error;
  if (!badge) return;
  const show = Boolean(resolved.ref) && !isChecked(resolved.ref);
  badge.hidden = !show;
  if (show) badge.title = `This snapshot ${uncheckedText(resolved.ref)}. It may still build.`;
}

export class FirmwarePage {
  /**
   * els: {fwButtons (the switch's buttons, data-fw), fwVersion, fwBadge,
   * fwVersionRow, katapult (the checkbox), katVersion, katBadge,
   * katVersionRow, soon, prebuilt, hint}. actions: {switchProject(project),
   * switchVersion(version), start() (load the configuration), consent()
   * (the compiler and the build's downloads), compiler() (resolves to {size}
   * or null), sourcesStarted()}.
   */
  constructor(session, configurator, wizard, els, actions) {
    this.session = session;
    this.configurator = configurator;
    this.wizard = wizard;
    this.els = els;
    this.actions = actions;
    this.indexError = "";
    this.katapult = false;
    this.katapultVersion = "latest";
    this.fw = picksFor(session.project, false).fw;
    this._hintCount = 0;

    for (const b of els.fwButtons) b.addEventListener("click", () => this.pickFirmware(b.dataset.fw));
    els.katapult.addEventListener("change", () => this.pickKatapult(els.katapult.checked));
    els.fwVersion.addEventListener("change", () => { if (els.fwVersion.value) actions.switchVersion(els.fwVersion.value); });
    els.katVersion.addEventListener("change", () => {
      if (!els.katVersion.value) return;
      if (this.session.project === "katapult") actions.switchVersion(els.katVersion.value);
      else this.katapultVersion = els.katVersion.value;
    });
    session.on("change", ({ what }) => {
      if (["project", "open", "undo"].includes(what)) this.sync();
      if (["index", "project", "version", "firmware", "ref", "open", "lock", "prebuilt", "sources", "undo"].includes(what)) this.render();
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

  // The page follows a project set elsewhere (an opened TOML, ?project=, undo).
  sync() {
    const picks = picksFor(this.session.project, this.katapult);
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
    this.fw = fw;
    const project = this.project;
    if (project && project !== this.session.project) this.actions.switchProject(project);
    this.render();
  }

  pickKatapult(on) {
    this.katapult = on;
    const project = this.project;
    if (project && project !== this.session.project) this.actions.switchProject(project);
    this.render();
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
    e.soon.hidden = prebuilt || !(this.katapult && this.fw !== "none");
    if (e.soon && !e.soon.hidden) e.soon.textContent = `Coming soon. For now, Next sets up ${projectTitle(s.index, this.fw)} alone.`;
    e.prebuilt.hidden = !prebuilt;
    if (prebuilt) {
      const file = s.toml && s.toml.prebuilt && s.toml.prebuilt.file;
      e.prebuilt.textContent = `This board TOML flashes its own file${file ? `, ${file}` : ""}. Next goes to Flash.`;
    }

    const index = s.index;
    if (!prebuilt && this.fw !== "none") {
      renderVersionSelect(e.fwVersion, e.fwBadge, { index, error: this.indexError, project: s.project, version: s.version, busy });
    }
    if (!prebuilt && this.katapult) {
      const alone = s.project === "katapult";
      renderVersionSelect(e.katVersion, e.katBadge, {
        index, error: this.indexError, project: "katapult", version: alone ? s.version : this.katapultVersion, busy,
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
    const { ref } = resolveVersion(s.index, s.project, s.version);
    if (ref) {
      const on = s.sources.ref || s.ref;
      const loaded = Boolean(on) && on.id === ref.id && ["loading", "ready"].includes(s.sources.state);
      const url = blobUrl(ref.core);
      const cached = loaded || await isCached(url);
      items.push({ what: "the sources", size: this.configurator.coreSize(ref), cached });
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
    this.actions.consent();
    return "configure";
  }
}
