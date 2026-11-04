// The .config tab: the configuration as text, read-only, refreshed after
// every change. Full shows the .config exactly as `make olddefconfig` writes
// it; Minimal shows the defconfig (`make savedefconfig`), which is what a
// board TOML's [config] defconfig holds. Copy and Download take whichever is
// shown.

import { saveFile } from "../dialogs.js";

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

export class ConfigTab {
  constructor({ textarea, minimal, copy, download, note }, session) {
    this.session = session;
    this.textarea = textarea;
    this.minimal = minimal;
    this.copyBtn = copy;
    this.downloadBtn = download;
    this.note = note;
    try { minimal.checked = localStorage.getItem("webflash.config.minimal") === "1"; } catch (e) { /* default */ }
    minimal.disabled = false;
    minimal.addEventListener("change", () => {
      try { localStorage.setItem("webflash.config.minimal", minimal.checked ? "1" : "0"); } catch (e) { /* blocked */ }
      this.render();
    });
    copy.addEventListener("click", () => copyText(this.text(), copy));
    download.addEventListener("click", () => {
      const text = this.text();
      if (text) saveFile(text, this.minimal.checked ? "defconfig" : ".config", "text/plain");
    });
    session.on("change", ({ what }) => {
      if (["config", "ref", "sources", "open", "firmware", "project", "prebuilt"].includes(what)) this.render();
    });
    this.render();
  }

  /** What is shown: the full .config, or the defconfig with Minimal. */
  text() {
    const s = this.session;
    if (!s.firmware) return "";
    if (this.minimal.checked) return s.defconfigText;
    return s.ref ? s.configText : "";
  }

  render() {
    const s = this.session;
    const text = this.text();
    if (this.textarea.value !== text) this.textarea.value = text;
    const loaded = Boolean(s.ref) && s.sources.state === "ready";
    this.copyBtn.disabled = !text;
    this.downloadBtn.disabled = !text;
    this.copyBtn.title = this.minimal.checked ? "Copy the defconfig" : "Copy the .config";
    this.downloadBtn.title = this.minimal.checked ? "Download the defconfig" : "Download the .config";
    if (!s.firmware) {
      this.textarea.placeholder = "A prebuilt firmware file has no configuration.";
    } else if (!loaded && !this.minimal.checked) {
      this.textarea.placeholder = "The full .config appears once the version's sources have loaded (Configure tab).";
    }
    if (this.note) {
      this.note.textContent = loaded
        ? `${this.minimal.checked ? "make savedefconfig" : "make olddefconfig"} output for ${s.ref.id}`
        : this.minimal.checked ? "As the board TOML says (not loaded into a version yet)" : "";
    }
  }
}
