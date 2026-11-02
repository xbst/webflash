// The toolbar's Project and Version selects.
//
// Version lists the project's refs from the sources index, grouped "Latest"
// (the default branch, with its describe string and date), "Releases" (tags,
// newest first, with "Newest release" on top) and "Branches". The selected
// value is [firmware] version itself: "latest", "release" or a ref id, so
// what the toolbar shows is what Save TOML writes. Refs whose snapshot did not
// pass the gate say so in their label, and a badge beside the select says so
// for the one selected; resolveVersion never picks them for "latest".

import { PROJECTS } from "../state.js";
import { groupRefs, refDetail, resolveVersion, projectTitle, isChecked, uncheckedText } from "./sources.js";

/**
 * The Version select's content for a project: [{label, options: [{value,
 * label, unchecked, title}]}], plus the value to select. Pure, for tests.
 */
export function versionOptions(index, project, version) {
  const groups = groupRefs(index, project);
  if (!groups) return { groups: [], value: null };
  const mark = (ref) => (isChecked(ref) ? "" : ` · ${uncheckedText(ref)}`);
  const out = [];

  const latest = resolveVersion(index, project, "latest");
  if (latest.ref) {
    const def = groups.defaultBranch;
    const shown = latest.ref;
    const head = def && shown === def ? def.id : `${shown.id}`;
    out.push({
      label: "Latest",
      options: [{
        value: "latest",
        label: `${head} · ${refDetail(shown)}${mark(shown)}`,
        unchecked: !isChecked(shown),
        title: latest.note || `The newest checked snapshot of ${projectTitle(index, project)}'s default branch.`,
      }],
    });
  }

  const releases = groups.releases.map((ref) => ({
    value: ref.id, label: `${ref.id} · ${refDetail(ref)}${mark(ref)}`, unchecked: !isChecked(ref),
    title: isChecked(ref) ? "" : `This snapshot ${uncheckedText(ref)}: it may not build.`,
  }));
  if (groups.releases.length) {
    const newest = resolveVersion(index, project, "release").ref;
    releases.unshift({
      value: "release", label: `Newest release (${newest.id})${mark(newest)}`, unchecked: !isChecked(newest),
      title: "Follows the newest checked release: a saved board TOML moves to the next release when it is published.",
    });
    out.push({ label: "Releases", options: releases });
  }

  const branchRefs = [...groups.branches];
  // A board TOML may name the default branch itself; list it so the select can show it.
  if (groups.defaultBranch && version === groups.defaultBranch.id) branchRefs.unshift(groups.defaultBranch);
  if (branchRefs.length) {
    out.push({
      label: "Branches",
      options: branchRefs.map((ref) => ({
        value: ref.id, label: `${ref.id} · ${refDetail(ref)}${mark(ref)}`, unchecked: !isChecked(ref),
        title: isChecked(ref) ? "" : `This snapshot ${uncheckedText(ref)}: it may not build.`,
      })),
    });
  }

  const values = out.flatMap((g) => g.options.map((o) => o.value));
  return { groups: out, value: values.includes(version) ? version : null };
}

export class VersionPicker {
  /**
   * projectSelect and versionSelect are the toolbar's selects, badge the
   * element beside Version. onProject(project) and onVersion(version) are
   * called when the user picks one.
   */
  constructor({ projectSelect, versionSelect, badge }, session, { onProject, onVersion }) {
    this.project = projectSelect;
    this.version = versionSelect;
    this.badge = badge;
    this.session = session;
    this.error = "";
    this.project.addEventListener("change", () => {
      if (PROJECTS.includes(this.project.value)) onProject(this.project.value);
    });
    this.version.addEventListener("change", () => {
      if (this.version.value) onVersion(this.version.value);
    });
    session.on("change", ({ what }) => {
      if (["index", "project", "version", "firmware", "ref", "open", "lock", "prebuilt"].includes(what)) this.render();
    });
    this.render();
  }

  /** Show why there is no version list (the index did not load). */
  setError(message) {
    this.error = message || "";
    this.render();
  }

  render() {
    const s = this.session;
    const index = s.index;
    const busy = Boolean(s.locked);
    const firmware = s.firmware;
    this.project.disabled = busy || !firmware;
    if (firmware && this.project.value !== firmware.project) this.project.value = firmware.project;

    this.version.replaceChildren();
    if (!firmware) {
      this.version.append(new Option("No firmware (prebuilt file)", ""));
      this.version.disabled = true;
      this._badge(null);
      return;
    }
    if (!index) {
      this.version.append(new Option(this.error ? "Versions unavailable" : "Loading versions…", ""));
      this.version.disabled = true;
      this.version.title = this.error || "Loading the list of versions (sources/index.json)…";
      this._badge(null);
      return;
    }
    const { groups, value } = versionOptions(index, firmware.project, firmware.version);
    if (!groups.length) {
      this.version.append(new Option(`No ${projectTitle(index, firmware.project)} versions`, ""));
      this.version.disabled = true;
      this._badge(null);
      return;
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
      this.version.append(group);
    }
    if (value === null) {
      // A version the index does not have (a TOML pinned to an old ref): say so
      // in the select rather than show another version as selected.
      const missing = new Option(`${firmware.version} (not in the index)`, firmware.version);
      missing.disabled = true;
      this.version.prepend(missing);
    }
    this.version.value = firmware.version;
    this.version.disabled = busy;
    const resolved = resolveVersion(index, firmware.project, firmware.version);
    this.version.title = resolved.ref
      ? `${projectTitle(index, firmware.project)} ${resolved.ref.id}: ${resolved.ref.describe || ""}${resolved.note ? `\n${resolved.note}` : ""}`
      : resolved.error;
    this._badge(resolved.ref);
  }

  _badge(ref) {
    if (!this.badge) return;
    const show = Boolean(ref) && !isChecked(ref);
    this.badge.hidden = !show;
    if (show) {
      this.badge.textContent = "unchecked";
      this.badge.title = `This snapshot (${ref.id}, ${ref.describe || ref.sha}) ${uncheckedText(ref)}: ` +
        "WebFlash could not confirm that it builds. It may still work.";
    }
  }
}
