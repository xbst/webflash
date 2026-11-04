// The .config tab: the configuration as text, read-only, refreshed after
// every change. Full shows the .config exactly as `make olddefconfig` writes
// it; Minimal shows the defconfig (`make savedefconfig`), which is what a
// board TOML's [config] defconfig holds. Copy and Download take whichever is
// shown. With Katapult configured beside the firmware, a select picks which
// project's file is shown.

import { saveFile } from "../dialogs.js";
import { projectTitle } from "./sources.js";

export async function copyText(text, button) {
  const done = (label) => {
    if (!button) return;
    const before = button.dataset.label || button.textContent;
    button.dataset.label = before;
    button.textContent = label;
    clearTimeout(button._copyTimer);
    button._copyTimer = setTimeout(() => { button.textContent = before; }, 1400);
  };
  try {
    await navigator.clipboard.writeText(text);
    done("Copied");
  } catch (e) {
    done("Copy failed");
  }
}

/**
 * What the tab shows for a slot: {text, ref, loaded, name} (name the
 * download's file name), from the session's firmware ("fw") or
 * session.katapult ("katapult").
 */
export function configView(session, slot, minimal) {
  const s = session;
  if (!s.firmware) return { text: "", ref: null, loaded: false, name: "" };
  if (slot === "katapult" && s.katapult) {
    const k = s.katapult;
    const loaded = Boolean(k.ref) && k.sources.state === "ready";
    return {
      text: minimal ? k.defconfigText : loaded ? k.configText : "",
      ref: k.ref, loaded, name: minimal ? "katapult.defconfig" : "katapult.config",
    };
  }
  const loaded = Boolean(s.ref) && s.sources.state === "ready";
  return {
    text: minimal ? s.defconfigText : s.ref ? s.configText : "",
    ref: s.ref, loaded, name: minimal ? "defconfig" : ".config",
  };
}

export class ConfigTab {
  constructor({ textarea, minimal, copy, download, note, project = null }, session) {
    this.session = session;
    this.textarea = textarea;
    this.minimal = minimal;
    this.copyBtn = copy;
    this.downloadBtn = download;
    this.note = note;
    this.project = project;
    this.slot = "fw";
    try { minimal.checked = localStorage.getItem("webflash.config.minimal") === "1"; } catch (e) { /* default */ }
    minimal.disabled = false;
    minimal.addEventListener("change", () => {
      try { localStorage.setItem("webflash.config.minimal", minimal.checked ? "1" : "0"); } catch (e) { /* blocked */ }
      this.render();
    });
    if (project) {
      project.addEventListener("change", () => {
        this.slot = project.value === "katapult" ? "katapult" : "fw";
        this.render();
      });
    }
    copy.addEventListener("click", () => copyText(this.text(), copy));
    download.addEventListener("click", () => {
      const view = this._view();
      if (view.text) saveFile(view.text, view.name, "text/plain");
    });
    session.on("change", ({ what }) => {
      if (["config", "ref", "sources", "open", "firmware", "project", "prebuilt", "index", "setup",
        "katapult", "katapult-config", "katapult-ref", "katapult-sources"].includes(what)) this.render();
    });
    this.render();
  }

  _view() {
    const slot = this.slot === "katapult" && this.session.katapult ? "katapult" : "fw";
    return configView(this.session, slot, this.minimal.checked);
  }

  /** What is shown: the full .config, or the defconfig with Minimal. */
  text() {
    return this._view().text;
  }

  // The project select: shown while Katapult is configured beside the firmware.
  _renderProject() {
    const sel = this.project;
    if (!sel) return;
    const s = this.session;
    const two = Boolean(s.firmware && s.katapult);
    sel.hidden = !two;
    if (!two) {
      this.slot = "fw";
      return;
    }
    const fw = projectTitle(s.index, s.project);
    const key = `${fw}\u0001Katapult`;
    if (sel.dataset.key !== key) {
      sel.dataset.key = key;
      sel.replaceChildren(new Option(fw, "fw"), new Option("Katapult", "katapult"));
    }
    sel.value = this.slot;
  }

  render() {
    this._renderProject();
    const s = this.session;
    const view = this._view();
    const text = view.text;
    if (this.textarea.value !== text) this.textarea.value = text;
    this.copyBtn.disabled = !text;
    this.downloadBtn.disabled = !text;
    this.copyBtn.title = this.minimal.checked ? "Copy the defconfig" : "Copy the .config";
    this.downloadBtn.title = this.minimal.checked ? "Download the defconfig" : "Download the .config";
    if (!s.firmware) {
      this.textarea.placeholder = "A prebuilt firmware file has no configuration.";
    } else if (!view.loaded && !this.minimal.checked) {
      this.textarea.placeholder = "The full .config appears once the sources have loaded (Configure step).";
    }
    if (this.note) {
      this.note.textContent = view.loaded
        ? `${this.minimal.checked ? "make savedefconfig" : "make olddefconfig"} output for ${view.ref.id}`
        : this.minimal.checked ? "As the board TOML says (not loaded into a version yet)" : "";
    }
  }
}
