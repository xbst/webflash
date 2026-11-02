// The source snapshots: sources/index.json, the refs of each project, and
// what a version names.
//
// The index (SPEC 7.1) lists, per project, its refs in order: the default
// branch first, then tags newest first, then other branches. A ref whose
// snapshot did not pass the gate (checked false, or null when the gate did
// not run) is listed but never chosen for "latest" or "release": those name
// the newest checked snapshot of the default branch and the newest checked
// tag. The core bundle of a ref is fetched by the engine worker (through
// Cache Storage); this module only works out which and from where.

import { assetsBase } from "../runtime.js";
import { PROJECT_TITLES } from "../state.js";

/** Where sources/ is: under the assets origin (the site's own, or --assets). */
export function sourcesBase() {
  return `${assetsBase()}sources/`;
}

/** The URL of a blob path the index names ("blobs/<sha256>.tar.gz"). */
export function blobUrl(path, base = sourcesBase()) {
  return new URL(path, base).href;
}

/** sources/index.json, revalidated with the server each time. */
export async function loadIndex(base = sourcesBase()) {
  const url = `${base}index.json`;
  let resp;
  try {
    resp = await fetch(url, { cache: "no-cache" });
  } catch (e) {
    throw new Error(`Could not load the list of versions from ${url}: the request failed. Check your connection.`);
  }
  if (!resp.ok) throw new Error(`Could not load the list of versions from ${url} (HTTP ${resp.status}).`);
  let index;
  try {
    index = await resp.json();
  } catch (e) {
    throw new Error(`${url} is not valid JSON.`);
  }
  return checkIndex(index, url);
}

/** The index if it has the shape this site reads (schema 1), else an error naming what is wrong. */
export function checkIndex(index, where = "index.json") {
  if (!index || typeof index !== "object" || index.schema !== 1 || !index.projects || typeof index.projects !== "object") {
    throw new Error(`${where} is not a schema 1 sources index; this site needs a newer copy of itself.`);
  }
  for (const [name, p] of Object.entries(index.projects)) {
    if (!p || !Array.isArray(p.refs)) throw new Error(`${where}: project ${name} has no refs list.`);
  }
  return index;
}

export const isChecked = (ref) => Boolean(ref) && ref.checked === true;

export function projectTitle(index, project) {
  const p = index && index.projects && index.projects[project];
  return (p && p.title) || PROJECT_TITLES[project] || project;
}

/**
 * The refs of a project as the Version select groups them: the default
 * branch (the "Latest" entry), the releases (tags, newest first) and the
 * other branches, each in index order. null when the index has no such project.
 */
export function groupRefs(index, project) {
  const p = index && index.projects && index.projects[project];
  if (!p) return null;
  const refs = p.refs;
  const defaultBranch = refs.find((r) => r.kind === "branch" && r.id === p.default_branch) || null;
  return {
    defaultBranch,
    releases: refs.filter((r) => r.kind === "tag"),
    branches: refs.filter((r) => r.kind === "branch" && r !== defaultBranch),
  };
}

/**
 * The ref a [firmware] version names, for a project:
 * - "latest": the default branch's snapshot when it is checked, else the
 *   newest checked ref (in index order), else the default branch anyway,
 *   flagged unchecked;
 * - "release": the newest checked tag, else the newest tag, else latest;
 * - anything else: the ref with that id.
 * Returns {ref, note?} or {ref: null, error}, error naming the refs there are.
 */
export function resolveVersion(index, project, version) {
  const p = index && index.projects && index.projects[project];
  const title = projectTitle(index, project);
  if (!p) return { ref: null, error: `The sources index has no ${title}.` };
  const refs = p.refs;
  if (!refs.length) return { ref: null, error: `The sources index lists no versions of ${title}.` };
  const groups = groupRefs(index, project);
  if (!version || version === "latest") {
    const def = groups.defaultBranch;
    if (isChecked(def)) return { ref: def };
    const checked = refs.find(isChecked);
    if (checked) {
      return {
        ref: checked,
        note: def ? `The newest ${title} ${def.id} snapshot (${def.describe}) did not pass the snapshot check, so Latest is ${checked.id}.` : "",
      };
    }
    const ref = def || refs[0];
    return { ref, note: `No ${title} version has passed the snapshot check; ${ref.id} is unchecked.` };
  }
  if (version === "release") {
    const tag = groups.releases.find(isChecked);
    if (tag) return { ref: tag };
    if (groups.releases.length) {
      return { ref: groups.releases[0], note: `No ${title} release has passed the snapshot check; ${groups.releases[0].id} is unchecked.` };
    }
    const latest = resolveVersion(index, project, "latest");
    return { ...latest, note: `${title} has no releases in the sources index, so the newest release is Latest.` };
  }
  const ref = refs.find((r) => r.id === version);
  if (ref) return { ref };
  return {
    ref: null,
    error: `${title} has no version "${version}" in the sources index. It has: ${refs.map((r) => r.id).join(", ")}.`,
  };
}

/** "v0.13.0-820-g0cee841e · 2026-10-28" for a branch, "2025-04-11" for a tag. */
export function refDetail(ref) {
  const bits = [];
  if (ref.kind !== "tag" && ref.describe) bits.push(ref.describe);
  if (ref.date) bits.push(ref.date);
  return bits.join(" · ");
}

export function uncheckedText(ref) {
  return ref.checked === false ? "failed the snapshot check" : "not checked";
}

/** The size of a blob in bytes, from the index's sizes map, or null when it does not say. */
export function blobSize(index, path) {
  const sizes = index && index.sizes;
  const n = sizes && path ? sizes[path] : undefined;
  return Number.isFinite(n) ? n : null;
}

/** A blob's size from the server (HEAD), for an index without sizes. */
export async function headSize(url) {
  try {
    const resp = await fetch(url, { method: "HEAD", cache: "no-cache" });
    const n = Number(resp.headers.get("Content-Length"));
    return resp.ok && n > 0 ? n : null;
  } catch (e) {
    return null;
  }
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}
