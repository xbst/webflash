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
    throw new Error(`Could not load the list of versions from ${url}: check your connection.`);
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
    throw new Error(`${where} is not a schema 1 sources index; this copy of the site is too old to read it.`);
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
  // An older commit (a history id, its describe string): from the history
  // file once loadHistory has it, matched by its commit so that another
  // abbreviation length of the same hash names it too.
  const parsed = parseVersionString(version);
  if (parsed) {
    const history = historyRefs(index, project);
    const hit = [...refs, ...(history || [])].find((r) => shaMatches(r, parsed.hash));
    if (hit) return { ref: hit };
    if (!history && historyInfo(index, project)) {
      return { ref: null, pending: true, error: `${title} ${version} is an older commit; the list of older commits has not loaded yet.` };
    }
  }
  return {
    ref: null,
    error: `${title} has no version "${version}" in the sources index. It has: ${refs.map((r) => r.id).join(", ")}` +
      (historyInfo(index, project) ? ", and older commits." : "."),
  };
}

/**
 * resolveVersion, loading the project's history file first when the
 * version names an older commit that is not loaded yet.
 */
export async function resolveVersionAsync(index, project, version, base = sourcesBase()) {
  const first = resolveVersion(index, project, version);
  if (!first.pending) return first;
  try {
    await loadHistory(index, project, base);
  } catch (e) {
    return { ref: null, error: e.message };
  }
  return resolveVersion(index, project, version);
}

// ── Older commits (sources/history/<project>.json) ─────────────────────

// The history files loaded for an index object: index → Map(project →
// {refs, blobs}, or the promise of them while they load). Kept beside the
// index rather than in it, so the session's index never changes behind its back.
const histories = new WeakMap();

/** The index's note on a project's older commits: {file, count}, or null. */
export function historyInfo(index, project) {
  const p = index && index.projects && index.projects[project];
  const h = p && p.history;
  return h && typeof h.file === "string" && h.count > 0 ? h : null;
}

/** The older commits of a project, newest first, once loadHistory has them; else null. */
export function historyRefs(index, project) {
  const map = index && histories.get(index);
  const entry = map && map.get(project);
  return entry && !(entry instanceof Promise) ? entry.refs : null;
}

/**
 * Load a project's older commits (history/<project>.json, revalidated) for
 * this index. Resolves to the list, newest first ([] when the project keeps
 * none). One download per index and project; a failed one can be tried again.
 */
export async function loadHistory(index, project, base = sourcesBase()) {
  const info = historyInfo(index, project);
  if (!info) return [];
  if (!histories.has(index)) histories.set(index, new Map());
  const map = histories.get(index);
  const have = map.get(project);
  if (have) return have instanceof Promise ? have : have.refs;
  const url = new URL(info.file, base).href;
  const title = projectTitle(index, project);
  const pending = (async () => {
    let resp;
    try {
      resp = await fetch(url, { cache: "no-cache" });
    } catch (e) {
      throw new Error(`Could not load the older ${title} commits from ${url}: the request failed.`);
    }
    if (!resp.ok) throw new Error(`Could not load the older ${title} commits from ${url} (HTTP ${resp.status}).`);
    let data;
    try {
      data = await resp.json();
    } catch (e) {
      throw new Error(`${url} is not valid JSON.`);
    }
    if (!data || data.schema !== 1 || !Array.isArray(data.refs)) throw new Error(`${url} is not a schema 1 history file.`);
    map.set(project, { refs: data.refs, blobs: data.blobs || {} });
    return data.refs;
  })();
  map.set(project, pending);
  try {
    return await pending;
  } catch (e) {
    map.delete(project);
    throw e;
  }
}

const DESCRIBE_RE = /^(.+)-(\d+)-g([0-9a-f]{4,40})(?:-dirty)?$/i;
const HASH_RE = /^g?([0-9a-f]{7,40})(?:-dirty)?$/i;

/**
 * What Mainsail or Fluidd shows as a Klipper version, read: a git describe
 * string ("v0.13.0-245-g61c0c8d", "-dirty" or not) gives {tag, count, hash,
 * dirty}; a bare commit hash (7 to 40 hex digits) gives {hash, dirty}. null
 * for anything else.
 */
export function parseVersionString(text) {
  const s = String(text || "").trim();
  const dirty = /-dirty$/i.test(s);
  let m = DESCRIBE_RE.exec(s);
  if (m) return { tag: m[1], count: Number(m[2]), hash: m[3].toLowerCase(), dirty };
  m = HASH_RE.exec(s);
  if (m) return { hash: m[1].toLowerCase(), dirty };
  return null;
}

const shaMatches = (ref, hash) => typeof ref.sha === "string" && ref.sha.startsWith(hash);

/**
 * The kept version a pasted Mainsail/Fluidd version names, among the refs
 * of the index and the loaded older commits: the commit itself when it is
 * kept (exact), else the closest older kept commit on the same tag (the
 * largest commit count not above it), with a one-line note. Returns {ref,
 * exact, note} or {ref: null, error}; null when the text is no version string.
 */
export function findVersion(index, project, text) {
  const parsed = parseVersionString(text);
  if (!parsed) return null;
  const p = index && index.projects && index.projects[project];
  const refs = [...((p && p.refs) || []), ...(historyRefs(index, project) || [])];
  const dirty = parsed.dirty ? "The host has local changes (-dirty); this is the clean commit." : "";
  const hit = refs.find((r) => shaMatches(r, parsed.hash));
  if (hit) return { ref: hit, exact: true, note: dirty };
  if (parsed.tag === undefined) {
    return { ref: null, error: `No kept ${projectTitle(index, project)} commit starts with ${parsed.hash}.` };
  }
  let best = null;
  let bestCount = -1;
  for (const r of refs) {
    const d = parseVersionString(r.describe);
    if (d && d.tag === parsed.tag && d.count <= parsed.count && d.count > bestCount) {
      best = r;
      bestCount = d.count;
    }
  }
  if (best) return { ref: best, exact: false, note: `Closest kept: ${best.describe}.${dirty ? ` ${dirty}` : ""}` };
  const sameTag = refs.some((r) => { const d = parseVersionString(r.describe); return d && d.tag === parsed.tag; });
  return {
    ref: null,
    error: sameTag
      ? `${String(text).trim()} is older than every kept ${parsed.tag} commit.`
      : `No kept ${projectTitle(index, project)} commit is on ${parsed.tag}.`,
  };
}

export function uncheckedText(ref) {
  return ref.checked === false ? "failed the snapshot check" : "not checked";
}

/**
 * The size of a blob in bytes, from the index's blobs table ({path: {size,
 * unpacked, files}}), or null when it does not say.
 */
export function blobSize(index, path) {
  let entry = index && index.blobs && path ? index.blobs[path] : undefined;
  // An older commit's bundles are in its history file's table.
  if (!entry && index && path && histories.has(index)) {
    for (const h of histories.get(index).values()) {
      if (!(h instanceof Promise) && h.blobs[path]) { entry = h.blobs[path]; break; }
    }
  }
  const n = entry ? entry.size : undefined;
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
