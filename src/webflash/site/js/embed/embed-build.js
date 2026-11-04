// The steps of a generated page's card for a board built from source (SPEC
// 2.2 of the guided UI): Firmware (what to flash, the versions and, with one
// setup, the reader's options), Setup (which [[setup]], when the TOML offers
// several), Build and the firmware the Flash step gets. It drives the site's
// own flow through the site's own modules: the session (state.js) holds the
// tables for what the reader picked (embed-model.js's cardTables), the
// configurator loads the firmware and Katapult into the engine worker's two
// slots and pairs them, and the Build step is the site's (build-panel.js),
// so a card builds what the site builds from the same TOML.
//
// Nothing heavy loads before the reader asks for it. Page 1's footer says
// what Next downloads and how big it is; Next is the consent: it starts
// Python, the sources of each picked project and the compiler (in the
// background). Until the configuration loads, the options read from the
// TOML (a value list, the defconfig's value, "Default" where only the
// Kconfig knows). Every load ends with the reader's choices for the setup
// (kept per setup, the source of truth: a switch of version or setup loads
// the setup's own defconfigs and sets them again), and the Build step builds
// once the engine holds all of it.

import * as runtime from "./runtime.js";
import { renderAbout } from "./dialogs.js";
import { Session } from "./state.js";
import { Configurator } from "./configure/configurator.js";
import { blobUrl, isChecked, loadHistory, projectTitle, resolveVersion, uncheckedText } from "./configure/sources.js";
import { mountVersionPicker } from "./configure/version-picker.js";
import { checkNumber } from "./configure/kconfig-tree.js";
import { BuildPanel } from "./build/build-panel.js";
import { buildsMatch } from "./build/artifacts.js";
import { isCached } from "./workers/blob-cache.js";
import { renderInline } from "./flash/flash-ui.js";
import { firmwareFromPair } from "./flash/pair.js";
import { openInSiteUrl } from "./toml-io.js";
import { downloadHint } from "./wizard/firmware-page.js";
import {
  allowedSetup, cardTables, firmwareChoices, firmwareFromBuild, initialPicks, isCurrent, linkToml, liveOption,
  offsetLocked, optionModel, optionsFor, picksTitle, picksValid, projectLabel, samePicks, setupBlock,
} from "./embed-model.js";

// Pyodide and the packages the engine loads, from jsDelivr: about 7 MB.
const PYTHON_SIZE = 7 * 1048576;
const ALIASES = ["latest", "release"];

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "html") node.innerHTML = v;
    else if (v === true) node.setAttribute(k, "");
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) node.append(c);
  return node;
}

/** A ref as the card names it: a tag by its name, a branch or an older commit by its describe string. */
function refText(ref) {
  return ref.kind === "tag" ? ref.id : (ref.describe || ref.id);
}

/** Whether the TOML's versions setting leaves the reader a choice. */
function offersChoice(versions) {
  return versions === "all" || versions === "releases" || (Array.isArray(versions) && versions.length > 1);
}

export class FirmwareFlow {
  /**
   * config: readConfig's; env: embed.js's runtimeLocation; wizard: the
   * card's Wizard; els: {pick (page 1's "What to flash"), options (page 1's
   * options, with one setup), about (page 1's "Versions and licenses"),
   * setups (the Setup step's list), build (the Build step's body), cancel
   * and rebuild (its footer's buttons)}. onFirmware(fw | null, {empty})
   * gets the flash panel's firmware whenever the builds change;
   * onLink(href) the "Open in WebFlash" link; onTitle(text) what the reader
   * flashes ("Klipper and Katapult"); onRelayout() runs after a change the
   * page's height script cannot see.
   */
  constructor(config, env, { behavior, wizard, els, onFirmware = () => {}, onLink = () => {}, onTitle = () => {}, onRelayout = () => {} }) {
    runtime.configure({ assetsBase: env.assets, payloadUrl: env.payloadUrl });
    this.config = config;
    this.env = env;
    this.behavior = behavior;
    this.wizard = wizard;
    this.els = els;
    this.onFirmware = onFirmware;
    this.onLink = onLink;
    this.onTitle = onTitle;
    this.onRelayout = onRelayout;

    this.initial = initialPicks(config);
    this.picks = { ...this.initial };
    this.choices = new Map();       // setup index -> Map(option symbol -> value): the reader's choices
    this.optionErrors = new Map();  // setup index -> Map(option symbol -> why the value was refused)
    this.indexError = "";
    this.started = false;           // Next (or Change) agreed to the downloads
    this.dirty = false;             // the engine is behind the picks or the choices
    this._sync = null;              // the running sync, while one runs
    this.syncError = "";
    this.engine = { fw: null, katapult: null };   // what each slot holds, as _syncPass keys it
    this.autoBuild = false;
    this._shown = undefined;        // the builds the flash panel got last
    this._hint = 0;

    this.session = new Session();
    this._applied = cardTables(config, this.picks);
    this.session.openTables(this._applied, { origin: "embed" });
    if (this.picks.setupIndex) this.session.setSetupIndex(this.picks.setupIndex);
    this.configurator = new Configurator(this.session);
    this._buildDom();
    this.buildPanel = new BuildPanel(this.session, this.configurator, this.buildEls);
    this.buildPanel.els.logBox.open = Boolean(behavior.showLog);

    this.session.on("change", ({ what }) => this._changed(what));
    this.configurator.onNotice((notice) => this._renderNotice(notice));
    this.configurator.loadIndex().catch((e) => {
      this.indexError = e.message;
      this.render();
    });

    wizard.onNext("firmware", () => this.next());
    wizard.onEnter("build", (from) => {
      this.autoBuild = !from || wizard.indexOf(from) < wizard.indexOf("build");
      this.tryAutoBuild();
    });
    wizard.onLeave("build", () => { this.autoBuild = false; });
    wizard.onStep(() => this.render());
    this.render();
    this.renderLink();
    this.renderFirmware();
  }

  // ── State ──────────────────────────────────────────────────────────

  get setupIndex() {
    return this.picks.setupIndex;
  }

  /** The setup picked, as the TOML gives it. */
  get setup() {
    return this.config.setups[this.picks.setupIndex];
  }

  /** The reader's choices for a setup (default: the one picked). */
  choicesFor(i = this.picks.setupIndex) {
    if (!this.choices.has(i)) this.choices.set(i, new Map());
    return this.choices.get(i);
  }

  /** Why an option's value was refused, by symbol, for a setup (default: the one picked). */
  errorsFor(i = this.picks.setupIndex) {
    if (!this.optionErrors.has(i)) this.optionErrors.set(i, new Map());
    return this.optionErrors.get(i);
  }

  /** The options the reader sets for the setup picked. */
  options() {
    return optionsFor(this.config, this.setup, this.picks);
  }

  /** The defconfig the options read from before the configuration loads: the session's for the setup. */
  baseDefconfig() {
    return this._applied.setups[this.picks.setupIndex].defconfig;
  }

  /** The reader changed something the TOML sets: the picks, or an option of the setup picked. */
  get changed() {
    return !samePicks(this.picks, this.initial) || this.choicesFor().size > 0;
  }

  /** Whether the engine holds the setup picked, for its options to follow the Kconfig tree. */
  get live() {
    const s = this.session;
    return this.started && !this._sync && !this.syncError && Boolean(s.tree) && s.sources.state === "ready" &&
      this.engine.fw === this._fwKey();
  }

  _fwKey() {
    const s = this.session;
    const at = this.picks.setupIndex;
    return JSON.stringify([s.project, s.version, at, this._applied.setups[at].defconfig]);
  }

  _katapultKey() {
    const k = this.session.katapult;
    const at = this.picks.setupIndex;
    return k ? JSON.stringify([k.version, at, this._applied.setups[at].katapult]) : null;
  }

  // ── The reader's picks ───────────────────────────────────────────

  /**
   * Bring the session's tables to the picks (cardTables), and the engine
   * after them once Next has been pressed. The setup picked keeps the
   * engine's defconfigs (the reader's choices, as the engine normalized
   * them) while what they come from is the same.
   */
  applyPicks() {
    const s = this.session;
    this.render();
    this.renderLink();
    if (!picksValid(this.picks)) return;
    const want = cardTables(this.config, this.picks);
    const prev = this._applied;
    const at = this.picks.setupIndex;
    if (JSON.stringify(want) === JSON.stringify(prev) && s.setupIndex === at) return;
    const cur = s.setup;
    const fwSame = prev.firmware.project === want.firmware.project && prev.firmware.version === want.firmware.version &&
      prev.setups[at].defconfig === want.setups[at].defconfig && s.setupIndex === at;
    const kSame = Boolean(prev.katapult && want.katapult) && prev.katapult.version === want.katapult.version &&
      prev.setups[at].katapult === want.setups[at].katapult && s.setupIndex === at;
    const setups = want.setups.map((x, i) => (i !== at || !cur ? x : {
      ...x, defconfig: fwSame ? cur.defconfig : x.defconfig, katapult: kSame ? cur.katapult : x.katapult,
    }));
    this._applied = want;
    const f = want.firmware;
    if (s.project !== f.project) s.setProject(f.project, { version: f.version, undoable: false });
    s.setFirmware({ projects: f.projects, version: f.version, versions: f.versions }, { undoable: false });
    s.setSetups({ setups, katapult: want.katapult }, { selected: at, undoable: false });
    this.requestSync();
  }

  pickProject(project) {
    const p = this.picks;
    if (project === p.project) return;
    const f = this.config.firmware;
    if (project === "none") {
      p.katapult = true;
    } else {
      // A ref id belongs to one project; the aliases work for any.
      p.version = project === f.project ? f.version : ALIASES.includes(p.version) ? p.version
        : ALIASES.includes(f.version) ? f.version : "latest";
    }
    p.project = project;
    p.setupIndex = allowedSetup(this.config, p.katapult, p.setupIndex);
    this.applyPicks();
  }

  pickVersion(version) {
    if (!version || version === this.picks.version) return;
    this.picks.version = version;
    this.applyPicks();
  }

  pickKatapult(on) {
    const p = this.picks;
    p.katapult = Boolean(on);
    if (p.katapult) p.setupIndex = allowedSetup(this.config, true, p.setupIndex);
    this.applyPicks();
  }

  pickKatapultVersion(version) {
    if (!version || version === this.picks.katapultVersion) return;
    this.picks.katapultVersion = version;
    this.applyPicks();
  }

  pickSetup(i) {
    if (i === this.picks.setupIndex || setupBlock(this.config.setups[i], this.picks.katapult)) return;
    this.picks.setupIndex = i;
    this.applyPicks();
  }

  /**
   * One option to a value: kept with the setup's choices, and set in the
   * engine at once when it holds the setup (kconfig_set; the tree follows),
   * else when the next load ends.
   */
  async setOption(option, value) {
    const choices = this.choicesFor();
    const errors = this.errorsFor();
    errors.delete(option.symbol);
    const base = optionModel(option, this.baseDefconfig());
    if (value === "" || (base.known && isCurrent(base, value))) choices.delete(option.symbol);
    else choices.set(option.symbol, value);
    this.renderLink();
    const c = this.configurator;
    if (this.live && c.readySlot("fw") && !this.session.locked) {
      const model = liveOption(option, this.session.tree);
      if (!isCurrent(model, value) && value !== "") {
        try {
          await c.set(model.set, value);
        } catch (e) {
          errors.set(option.symbol, runtime.pythonMessage(e));
        }
      }
    } else if (this.started) {
      this.requestSync();
    }
    this.renderOptions();
  }

  // ── Loading ──────────────────────────────────────────────────────

  /** Page 1's Next: the downloads start, and the card moves on (to Setup, or Build). */
  next() {
    if (!picksValid(this.picks)) return false;
    this.start();
    return undefined;
  }

  /** The reader agreed to the downloads: Python, the sources and (in the background) the compiler. */
  start() {
    if (this.started) return;
    this.started = true;
    this.buildPanel.consented = true;
    this.buildPanel.prefetch();
    this.requestSync();
  }

  /** Bring the engine to the picks and the choices, once a running sync ends. */
  requestSync() {
    if (!this.started) return;
    this.dirty = true;
    if (!this._sync) this._sync = this._runSync();
    this.render();
  }

  async _runSync() {
    this.syncError = "";
    try {
      while (this.dirty) {
        this.dirty = false;
        try {
          await this._syncPass();
          this.syncError = "";
        } catch (e) {
          this.syncError = runtime.pythonMessage(e);
          if (!this.dirty) break;
        }
      }
    } finally {
      this._sync = null;
      this.render();
      this.tryAutoBuild();
    }
  }

  // One pass: the firmware's slot (loaded, or its setup's defconfig loaded
  // again), Katapult's (loaded, reloaded or dropped), then the reader's
  // choices. The configurator runs each step in its queue.
  async _syncPass() {
    const s = this.session;
    const c = this.configurator;
    if (!s.firmware || !picksValid(this.picks)) return;
    const fwKey = this._fwKey();
    if (!c.loaded || c.loaded.project !== s.project || c.loaded.version !== s.version) {
      if (!(await c.load({ reason: "start", carry: s.defconfigText }))) {
        throw new Error(s.sources.detail || `${projectLabel(s.project)} did not load.`);
      }
      this.engine.fw = fwKey;
    } else if (this.engine.fw !== fwKey) {
      // Another setup: both slots from its defconfigs (Katapult loaded or let go as it has one).
      await c.reapply();
      this.engine.fw = fwKey;
      if (s.katapult && c.slots.katapult) this.engine.katapult = this._katapultKey();
    }
    const k = s.katapult;
    if (k) {
      const kKey = this._katapultKey();
      if (!c.slots.katapult || c.slots.katapult.version !== k.version) {
        if (!(await c.loadKatapult({ reason: "start" }))) {
          const now = s.katapult;
          throw new Error((now && now.sources.detail) || "Katapult did not load.");
        }
        this.engine.katapult = kKey;
      } else if (this.engine.katapult !== kKey) {
        await c.reapply();
        this.engine.katapult = kKey;
      }
    } else {
      if (c.slots.katapult) await c.dropKatapult();
      this.engine.katapult = null;
    }
    await this._applyChoices();
  }

  // The reader's choices for the setup, set in the engine. A choice the tree
  // hides may be shown by a later one (a bitrate listed before the interface
  // that needs it), so they go in passes, in the TOML's order, until a pass
  // sets nothing; one still hidden then shows its option's note.
  async _applyChoices() {
    const s = this.session;
    const left = new Map(this.choicesFor());
    const errors = this.errorsFor();
    let applied = true;
    while (applied && left.size) {
      applied = false;
      for (const option of this.options()) {
        if (!left.has(option.symbol) || offsetLocked(option, this.picks)) continue;
        const model = liveOption(option, s.tree);
        if (!model.enabled) continue;
        const value = left.get(option.symbol);
        left.delete(option.symbol);
        if (isCurrent(model, value)) continue;
        try {
          await this.configurator.set(model.set, value);
          errors.delete(option.symbol);
          applied = true;
        } catch (e) {
          errors.set(option.symbol, runtime.pythonMessage(e));
        }
      }
    }
  }

  // ── Building ─────────────────────────────────────────────────────

  /**
   * The Build step builds on arrival from a step before it (Back from Flash
   * starts nothing), once the engine holds the picks and the choices, unless
   * the builds on record still match. It waits while the step is shown and
   * starts at most once per arrival.
   */
  tryAutoBuild() {
    const bp = this.buildPanel;
    if (!this.autoBuild) return;
    if (this.wizard.current !== "build" || bp.running || bp.current) {
      this.autoBuild = false;
      return;
    }
    if (!this.started) this.start();
    if (this._sync || this.syncError || !bp.check().ok) return;
    this.autoBuild = false;
    bp.onBuild();
  }

  // The firmware the flash panel gets: the builds while they match the
  // picks and the choices, Katapult and the firmware together for a pair.
  renderFirmware() {
    const s = this.session;
    const b = s.builds || {};
    const match = buildsMatch(s);
    const key = match ? [b.fw, s.katapult ? b.katapult : null] : null;
    const same = this._shown !== undefined && (key === null ? this._shown === null
      : this._shown !== null && key[0] === this._shown[0] && key[1] === this._shown[1]);
    if (same) return;
    this._shown = key;
    if (!match) {
      const any = Boolean(b.fw || b.katapult);
      this.onFirmware(null, { empty: any ? "The settings changed since the build: build again." : "Build first." });
      return;
    }
    const setup = this.setup;
    const methods = setup && setup.methods ? setup.methods : this.config.flash.methods;
    try {
      const fw = s.katapult
        ? firmwareFromPair({ fw: b.fw, katapult: b.katapult }, { methods, instructions: this.config.flash.instructions })
        : firmwareFromBuild(b.fw, this.config, { methods });
      this.onFirmware(fw, {});
    } catch (e) {
      this.onFirmware(null, { empty: e.message });
    }
  }

  // ── The view ─────────────────────────────────────────────────────

  _buildDom() {
    const e = this.els;
    // Page 1: what to flash.
    this.fwRow = el("div", { class: "wf-fw" });
    this.fwName = el("span", { class: "name", text: "Firmware" });
    this.fwSub = el("span", { class: "sub" });
    this.fwSwitch = el("span", { class: "wf-seg", role: "radiogroup", "aria-label": "Firmware" });
    this.fwFixed = el("span", { class: "wf-fixedname" });
    this.fwVer = el("div", { class: "ver" });
    this.fwPickerHost = el("div", { class: "wf-picker" });
    this.fwVerFixed = el("p", { class: "wf-fixed" });
    this.fwVer.append(el("span", { class: "wf-ver-label", text: "Version" }), this.fwPickerHost, this.fwVerFixed);
    this.fwRow.append(el("div", { class: "what" }, [this.fwName, this.fwSub]), this.fwSwitch, this.fwFixed, this.fwVer);
    this.fwButtons = firmwareChoices(this.config).map((c) => {
      const b = el("button", { type: "button", role: "radio", "data-fw": c.id, text: c.label });
      b.addEventListener("click", () => this.pickProject(c.id));
      this.fwSwitch.append(b);
      return b;
    });
    e.pick.append(el("h2", { class: "wf-sec", text: "What to flash" }), this.fwRow);

    if (this.config.katapult) {
      this.katRow = el("div", { class: "wf-fw" });
      this.katBox = el("input", { type: "checkbox", id: "wf-katapult" });
      this.katBox.addEventListener("change", () => this.pickKatapult(this.katBox.checked));
      this.katVer = el("div", { class: "ver" });
      this.katPickerHost = el("div", { class: "wf-picker" });
      this.katVerFixed = el("p", { class: "wf-fixed" });
      this.katVer.append(el("span", { class: "wf-ver-label", text: "Version" }), this.katPickerHost, this.katVerFixed);
      this.katRow.append(el("div", { class: "what" }, [
        el("label", { class: "check name", for: "wf-katapult" }, [this.katBox, " Katapult bootloader"]),
        el("span", { class: "sub", text: "Lets you update the firmware later without pressing buttons." }),
      ]), this.katVer);
      e.pick.append(this.katRow);
    }
    this.pickNote = el("p", { class: "wf-muted wf-pick-note", hidden: true });
    e.pick.append(this.pickNote);

    // Page 1's options (one setup) or the Setup step's cards.
    this.optionsHead = el("h2", { class: "wf-sec", text: "Options" });
    this.optionsEl = el("div", { class: "wf-options" });
    if (this.config.setups.length > 1) {
      this.setupCards = this.config.setups.map((setup, i) => {
        const radio = el("input", { type: "radio", name: "wf-setup", id: `wf-setup-${i}` });
        radio.addEventListener("change", () => { if (radio.checked) this.pickSetup(i); });
        const sub = el("div", { class: "sub" });
        const opts = el("div", { class: "wf-choice-opts" });
        const card = el("label", { class: "wf-choice", for: `wf-setup-${i}` }, [
          radio, el("div", { class: "wf-choice-main" }, [el("div", { class: "name", text: setup.title || `Setup ${i + 1}` }), sub, opts]),
        ]);
        e.setups.append(card);
        return { card, radio, sub, opts };
      });
    } else {
      e.options.append(this.optionsHead, this.optionsEl);
    }

    // Page 1's "Versions and licenses", filled when opened.
    if (e.about) {
      const inner = el("div", { class: "wf-about" });
      const fold = el("details", { class: "wf-more wf-about-fold" }, [el("summary", { text: "Versions and licenses" }), inner]);
      fold.addEventListener("toggle", () => {
        if (fold.open) {
          const bp = this.buildPanel;
          renderAbout(inner, {
            sources: this._sourcesText(),
            toolchain: () => bp.aboutText(),
            extend: (box) => bp.extendAbout(box),
            onClearCache: () => bp.cacheCleared(),
          });
        }
        this.onRelayout();
      });
      e.about.append(fold);
    }

    // The Build step: the site's Build panel, its parts made here.
    const b = e.build;
    this.noticeEl = el("div", { class: "wf-box wf-info", hidden: true });
    this.problemEl = el("div", { class: "wf-box wf-error", hidden: true, role: "alert" });
    const title = el("h2", { class: "wf-page", id: "wf-build-title", tabindex: "-1", "data-wiz-title": true, text: "Build" });
    const clock = el("p", { class: "wf-lead wf-clock", "aria-live": "polite" });
    const pre = el("ul", { class: "build-pre", "aria-label": "What the build needs" });
    const start = el("div", { class: "wf-box wf-info build-start", hidden: true });
    const jobs = el("div", { class: "build-jobs" });
    const error = el("div", { class: "wf-box wf-error build-error", role: "alert", hidden: true });
    const memory = el("div", { class: "build-memory" });
    const memoryBox = el("details", { class: "wf-more wf-mem", hidden: true }, [el("summary", { text: "Memory" }), memory]);
    const logCount = el("span", { class: "wf-muted log-count" });
    const logCopy = el("button", { type: "button", class: "mini", disabled: true, title: "Copy the build log", text: "Copy" });
    const list = el("ol", { class: "progress-list", "aria-label": "Build steps" });
    const log = el("pre", { class: "log", tabindex: "0", "aria-label": "Build log" });
    const logBox = el("details", { class: "wf-more log-box" }, [el("summary", {}, ["Log ", logCount, " ", logCopy]), list, log]);
    for (const box of [memoryBox, logBox]) box.addEventListener("toggle", () => this.onRelayout());
    b.append(title, clock, this.noticeEl, this.problemEl, pre, start, jobs, error, memoryBox, logBox);
    this.buildEls = {
      title, clock, pre, jobs, error, start, list, memoryBox, memory, logBox, log, logCopy, logCount,
      button: e.rebuild, cancel: e.cancel,
    };
    this.clockEl = clock;
  }

  _changed(what) {
    if (what === "build") this._shown = undefined;
    this.render();
    if (["build", "config", "katapult-config", "ref", "katapult-ref", "katapult", "setup", "project", "version"].includes(what)) {
      this.renderFirmware();
    }
    if (this.autoBuild) this.tryAutoBuild();
  }

  render() {
    this.renderPick();
    this.renderOptions();
    this.renderSetups();
    this.renderSteps();
    this.renderHint();
    this.onTitle(picksTitle(this.picks));
    this.onRelayout();
  }

  renderPick() {
    const s = this.session;
    const p = this.picks;
    const busy = Boolean(s.locked);
    // show_versions covers the project too, as the "project/version selects".
    const choices = this.behavior.showVersions ? this.fwButtons.length : 1;
    for (const b of this.fwButtons) {
      const on = b.dataset.fw === p.project;
      b.classList.toggle("on", on);
      b.setAttribute("aria-checked", String(on));
      b.disabled = busy;
    }
    this.fwSwitch.hidden = choices < 2;
    this.fwFixed.hidden = choices >= 2;
    this.fwFixed.textContent = projectLabel(p.project);
    this.fwName.textContent = p.project === "katapult" ? "Bootloader" : "Firmware";
    const none = p.project === "none";
    this.fwRow.classList.toggle("off", none);
    const kalico = this.config.firmware.projects.includes("kalico");
    this.fwSub.textContent = none || p.project === "katapult" ? "" : `Runs the printer${kalico ? "; Kalico is a Klipper fork" : ""}.`;
    this.fwSub.hidden = !this.fwSub.textContent;
    this.fwVer.hidden = none;
    if (!none) {
      this.fwPicker = this._renderVersion(this.fwPicker, this.fwPickerHost, this.fwVerFixed, {
        project: p.project, value: p.version, versions: this.config.firmware.versions, busy,
        onChange: (v) => this.pickVersion(v),
      });
    }
    if (this.katRow) {
      this.katBox.checked = p.katapult;
      this.katBox.disabled = busy;
      this.katRow.classList.toggle("off", !p.katapult);
      this.katVer.hidden = !p.katapult;
      if (p.katapult) {
        this.katPicker = this._renderVersion(this.katPicker, this.katPickerHost, this.katVerFixed, {
          project: "katapult", value: p.katapultVersion, versions: this.config.katapult.versions, busy,
          onChange: (v) => this.pickKatapultVersion(v),
        });
      }
    }
    this.pickNote.hidden = picksValid(p);
    this.pickNote.textContent = "Pick a firmware or Katapult.";
  }

  // A project's version: the picker when the reader may choose, else the
  // version as a line. Returns the picker (made on first use).
  _renderVersion(picker, host, fixed, { project, value, versions, busy, onChange }) {
    const s = this.session;
    const index = s.index;
    const choose = this.behavior.showVersions && offersChoice(versions);
    host.hidden = !choose;
    fixed.hidden = choose;
    if (choose) {
      const opts = { project, index, value, versions, disabled: busy, label: `${projectLabel(project)} version` };
      if (!picker) return mountVersionPicker(host, { ...opts, onChange: (v) => onChange(v) });
      const o = picker.opts || {};
      if (o.project !== project || o.index !== index || o.value !== value || o.versions !== versions || o.disabled !== busy) picker.update(opts);
      return picker;
    }
    const { ref, error } = index ? this._resolve(project, value) : { ref: null, error: "" };
    const why = !index ? (this.indexError ? `The list of versions did not load: ${this.indexError}` : "") : ref ? "" : error;
    fixed.replaceChildren(ref ? refText(ref) : value);
    fixed.title = ref ? `${ref.describe || ref.id}${ref.date ? `, ${ref.date}` : ""}` : why;
    if (ref && !isChecked(ref)) {
      fixed.append(" ", el("span", { class: "wf-badge", text: "unchecked", title: `This snapshot ${uncheckedText(ref)}; it may still build.` }));
    }
    if (why) fixed.append(el("span", { class: "wf-muted wf-why", text: ` ${why}` }));
    return picker;
  }

  // What a version names. An older commit (a describe string) resolves once
  // its project's history file is here: it loads once per index and project,
  // without a picker too, and the card renders again; a failure is kept
  // (Next tries again, as it loads the version).
  _resolve(project, version) {
    const index = this.session.index;
    const resolved = resolveVersion(index, project, version);
    if (!resolved.pending) return resolved;
    if (!this._histories) this._histories = new WeakMap();
    if (!this._histories.has(index)) this._histories.set(index, new Map());
    const loads = this._histories.get(index);
    const had = loads.get(project);
    if (typeof had === "string") return { ref: null, error: had };
    if (!had) {
      const again = () => { if (this.session.index === index) this.render(); };
      loads.set(project, loadHistory(index, project).then(() => { loads.delete(project); again(); },
        (e) => { loads.set(project, e.message); again(); }));
    }
    return { ref: null, pending: true, error: "Loading the list of older commits…" };
  }

  renderSetups() {
    if (!this.setupCards) return;
    const p = this.picks;
    const busy = Boolean(this.session.locked);
    this.config.setups.forEach((setup, i) => {
      const c = this.setupCards[i];
      const block = setupBlock(setup, p.katapult);
      const on = i === p.setupIndex && !block;
      c.card.classList.toggle("on", on);
      c.card.classList.toggle("no", Boolean(block));
      c.radio.checked = on;
      c.radio.disabled = Boolean(block) || busy;
      c.sub.textContent = block || setup.description;
      c.sub.hidden = !c.sub.textContent;
      if (on && this.optionsEl.parentNode !== c.opts) c.opts.replaceChildren(this.optionsEl);
      if (!on) c.opts.replaceChildren();
    });
  }

  renderOptions() {
    const s = this.session;
    const options = this.options();
    this.optionsHead.hidden = !options.length;
    this.optionsEl.hidden = !options.length;
    const live = this.live;
    const rows = [...this.optionsEl.children];
    // Another setup's options: start over.
    const sig = options.map((o) => o.symbol).join(",") + `|${this.picks.setupIndex}`;
    if (this.optionsEl.dataset.sig !== sig) {
      this.optionsEl.dataset.sig = sig;
      this.optionsEl.replaceChildren();
      rows.length = 0;
    }
    const choices = this.choicesFor();
    options.forEach((option, i) => {
      let model = live ? liveOption(option, s.tree) : optionModel(option, this.baseDefconfig());
      const locked = offsetLocked(option, this.picks);
      if (!live && choices.has(option.symbol) && !locked) model = { ...model, current: choices.get(option.symbol), known: true };
      if (locked) model = { ...model, locked: true, enabled: false, note: "Set by Katapult." };
      let row = rows[i];
      if (!row) {
        row = el("div", { class: "wf-option" });
        this.optionsEl.append(row);
      }
      this._renderOption(row, option, model, i, live);
    });
  }

  _renderOption(row, option, model, i, live) {
    const id = `wf-opt-${i}`;
    const busy = Boolean(this.session.locked);
    const key = `${model.kind}:${live}`;
    if (row.dataset.key !== key) {
      row.dataset.key = key;
      row.replaceChildren();
      row.append(el("label", { class: "wf-option-label", for: id }), el("span", { class: "wf-option-control" }),
        el("p", { class: "wf-option-note", hidden: true }), el("div", { class: "wf-option-help" }));
    }
    const [label, control, noteEl, helpEl] = row.children;
    label.textContent = model.label;
    const error = this.errorsFor().get(option.symbol) || "";
    const shows = live || model.locked;
    const enabled = shows ? model.enabled : true;
    noteEl.hidden = !(error || (shows && model.note));
    noteEl.className = `wf-option-note${error ? " wf-bad" : ""}`;
    noteEl.textContent = error || (shows ? model.note : "");

    if (model.kind === "choice" || model.kind === "values") {
      let sel = control.querySelector("select");
      if (!sel) {
        sel = el("select", { id });
        sel.addEventListener("change", () => this.setOption(option, sel.value));
        control.replaceChildren(sel);
      }
      const opts = model.values.map((v) => [v.value, v.label]);
      if (!model.known && model.current === null) opts.unshift(["", "Default"]);
      const sig = JSON.stringify(opts);
      if (sel.dataset.sig !== sig) {
        sel.dataset.sig = sig;
        sel.replaceChildren(...opts.map(([v, t]) => new Option(t, v)));
      }
      sel.value = model.current === null ? "" : model.values.find((v) => isCurrent(model, v.value))?.value ?? model.current;
      sel.disabled = busy || !enabled;
      sel.title = model.current === null ? "The version's default, once it loads." : "";
    } else if (model.kind === "bool") {
      let box = control.querySelector("input");
      if (!box) {
        box = el("input", { type: "checkbox", id });
        box.addEventListener("change", () => this.setOption(option, box.checked ? "y" : "n"));
        control.replaceChildren(box);
      }
      box.checked = model.current === "y";
      box.disabled = busy || !enabled;
    } else if (model.kind === "input") {
      let input = control.querySelector("input");
      if (!input) {
        input = el("input", { type: "text", id, spellcheck: "false", autocomplete: "off" });
        input.addEventListener("change", () => {
          const checked = checkNumber({ type: input.dataset.type, range: input.dataset.range ? JSON.parse(input.dataset.range) : null }, input.value);
          if (checked.error) {
            this.errorsFor().set(option.symbol, checked.error);
            this.renderOptions();
            return;
          }
          this.setOption(option, checked.value);
        });
        control.replaceChildren(input);
      }
      input.dataset.type = model.type || "string";
      if (model.range) input.dataset.range = JSON.stringify(model.range);
      else delete input.dataset.range;
      input.placeholder = model.range ? `${model.range[0]} to ${model.range[1]}` : "";
      // A refused value stays, beside the reason, to be corrected.
      if (document.activeElement !== input && !error) input.value = model.current || "";
      input.disabled = busy || !enabled;
    } else if (model.kind === "free") {
      // Only the Kconfig says what may go here: it can change once the configuration loads.
      const shown = model.current !== null && model.current !== "y" && model.current !== "n" ? model.current : "";
      const text = el("span", { class: "wf-muted", text: shown || "as the board's configuration sets it" });
      if (this.started) {
        control.replaceChildren(text, " ", el("span", { class: "wf-muted", text: "· loading…" }));
      } else {
        const change = el("button", { class: "mini", type: "button", text: "Change", title: "Load this version's configuration to change it" });
        change.disabled = busy;
        change.addEventListener("click", () => this.start());
        control.replaceChildren(text, " ", change);
      }
    } else {
      control.replaceChildren(el("span", { class: "wf-muted", text: "not in this version" }));
    }

    const help = option.help ? renderInline(option.help) : "";
    if (help) {
      helpEl.innerHTML = help;
    } else if (live && model.help) {
      if (!helpEl.querySelector("details")) {
        helpEl.replaceChildren(el("details", { class: "wf-more" }, [
          el("summary", { text: "About this option" }),
          ...model.help.split(/\n\s*\n/).map((p) => el("p", { text: p.split("\n").map((l) => l.trim()).join(" ") })),
        ]));
        helpEl.querySelector("details").addEventListener("toggle", () => this.onRelayout());
      }
    } else {
      helpEl.replaceChildren();
    }
  }

  // Next, the hints and the Build step's waiting line.
  renderSteps() {
    const w = this.wizard;
    const p = this.picks;
    const bp = this.buildPanel;
    const valid = picksValid(p);
    w.setNext("firmware", { enabled: valid, reason: "Pick a firmware or Katapult." });
    const block = setupBlock(this.setup, p.katapult);
    w.setNext("setup", { enabled: valid && !block, reason: block || "Pick a setup.", label: "Build" });
    w.setHint("setup", "Next builds it here, in your browser.");
    if (!bp) return;
    const s = this.session;
    w.setNext("build", { enabled: buildsMatch(s) && !bp.running, reason: "Next is enabled once the build is done." });
    this.problemEl.hidden = !this.syncError;
    if (this.syncError) {
      const retry = el("button", { type: "button", class: "mini", text: "Try again" });
      retry.addEventListener("click", () => {
        this.syncError = "";
        this.requestSync();
        if (this.wizard.current === "build") {
          this.autoBuild = true;
          this.tryAutoBuild();
        }
      });
      this.problemEl.replaceChildren(el("p", {}, [el("strong", { text: "The configuration did not load" })]),
        el("p", { text: this.syncError }), retry);
    }
    // While nothing runs and no build is on record: what the build waits for.
    if (!bp.running && !Object.values(bp.lastBuilds).some(Boolean)) {
      const c = bp.check();
      const waiting = this._sync || (this.started && !this.syncError && !c.ok && /first|Working out/.test(c.reason));
      this.clockEl.textContent = !this.started ? "" : waiting ? `Loading ${picksTitle(p)}…` : this.syncError ? "" : c.ok ? "" : c.reason;
      this.clockEl.title = "";
    }
  }

  // Page 1's hint: what Next downloads. Asked only while page 1 shows, since
  // it looks in the cache.
  async renderHint() {
    if (this.wizard.current !== "firmware") return;
    const mine = ++this._hint;
    const set = (text) => { if (mine === this._hint) this.wizard.setHint("firmware", text); };
    const s = this.session;
    const p = this.picks;
    if (!picksValid(p)) return set("Pick at least one.");
    if (!s.index) return set(this.indexError ? `The list of versions did not load: ${this.indexError}` : "Loading the list of versions…");
    const items = [];
    if (!runtime.isReady()) items.push({ what: "Python", size: PYTHON_SIZE, cached: false });
    const parts = p.project === "none" ? [["katapult", p.katapultVersion, s.sources]]
      : [[p.project, p.version, s.sources], ...(p.katapult && this.config.katapult ? [["katapult", p.katapultVersion, s.katapult ? s.katapult.sources : null]] : [])];
    const sources = [];
    for (const [project, version, st] of parts) {
      const { ref } = this._resolve(project, version);
      if (!ref) continue;
      const on = st && st.ref;
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
    try { compiler = await this.buildPanel.compilerToFetch(); } catch (e) { compiler = null; }
    if (compiler) items.push({ what: "the compiler", size: compiler.size, cached: false });
    set(downloadHint(items));
  }

  renderLink() {
    const text = linkToml(this.config, { changed: this.changed, picks: this.picks, choices: this.choicesFor() });
    this.onLink(openInSiteUrl(this.config.board.engine_url || this.env.engine, text));
  }

  _renderNotice(notice) {
    const box = this.noticeEl;
    box.hidden = !notice;
    if (notice) {
      box.className = `wf-box wf-${notice.kind === "error" ? "error" : notice.kind === "warn" ? "warn" : "info"}`;
      box.replaceChildren(el("p", {}, [el("strong", { text: notice.title })]), ...notice.lines.map((l) => el("p", { text: l })));
      const close = el("button", { class: "mini", type: "button", text: "Dismiss" });
      close.addEventListener("click", () => this.configurator.dismissNotice());
      box.append(close);
    }
    this.onRelayout();
  }

  _sourcesText() {
    const s = this.session;
    const parts = [];
    if (s.ref) parts.push(`${projectTitle(s.index, s.project)} ${s.ref.describe || s.ref.id}`);
    if (s.katapult && s.katapult.ref) parts.push(`Katapult ${s.katapult.ref.describe || s.katapult.ref.id}`);
    return parts.join(", ");
  }
}
