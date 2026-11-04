// Runs the WebAssembly toolchain release under Node for the engine's
// WasmNodeToolchain: one JSON request per line on stdin, one JSON reply per
// line on stdout. The engine starts one of these per job slot.
//
//   node wasm-node-runner.mjs <release dir>/manifest.json
//
// Request:  {argv, cwd, mount?, env, files: {abs path: base64}, symlinks: {abs link: abs target},
//            inputs: [tree-relative paths], include_dirs: [tree-relative dirs]}
// Reply:    {code, stdout, stderr, outputs: {abs path: base64}, time, memory}
//
// Every path in a request is a path on disk, and `cwd` is the source tree.
// Inside the instance the tree is at one POSIX path, `mount` (default: the
// tree's own path, a Windows drive as /c/...), and every path the instance is
// given goes through that one mapping: the working directory, the tree's
// files, the generated files the engine sends, the out/board symlinks and
// their targets, and the tree's path wherever argv or env spell it (a
// Makefile's $(CURDIR)); a path outside the tree keeps its own, which on
// Windows is its /c/... form, so the instance never sees a drive path it
// would read as relative. Outputs come back as paths on disk. The site mounts
// a snapshot at /webflash/src/<project>/<sha>; with that mount the ELF's
// debug information (its compilation directory) is the browser build's too.
//
// As the site's toolchain worker does, the instance holds the whole tree,
// except out/ (the engine sends what a command reads of it), .git and the
// lib/<dir> folders the command does not name (the site downloads a lib
// bundle only when a build needs it), and the folders the outputs go to are
// made with the worker's own outputDirs rule: the tools create none, and
// MEMFS resolves ".." from the folder it has reached.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { absolute, outputDirs } from "../../src/webflash/site/js/workers/toolchain-worker.js";

const WINDOWS = process.platform === "win32";

/** A path on disk: absolute, forward slashes, a drive letter in upper case. */
export function diskPath(path, base = process.cwd()) {
  let p = resolve(String(base), String(path)).replace(/\\/g, "/");
  if (/^[a-z]:/.test(p)) p = p[0].toUpperCase() + p.slice(1);
  return p.length > 1 && !/^[A-Za-z]:\/$/.test(p) ? p.replace(/\/+$/, "") : p;
}

/** A path on disk outside the tree as the instance sees it: itself, a drive as /c/... */
export function posixPath(disk) {
  const m = /^([A-Za-z]):(\/.*)?$/.exec(disk);
  return absolute(m ? `/${m[1].toLowerCase()}${m[2] || ""}` : disk);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A drive path where text can start one: at the start, after an option's
// letters (-IC:/x) or after a separator (=, a comma, a semicolon).
const DRIVE_PATHS = /(^-[A-Za-z]+?|^|[^A-Za-z0-9])([A-Za-z]:[\\/][^,;"'\s]*)/g;

/**
 * The mapping between the tree on disk (`cwd`) and the instance, where the
 * tree is at `mount`: toInstance and toDisk for paths, spell for text that
 * names paths on disk (an argument, an environment value: the tree's path in
 * either slash becomes the mount, and on Windows any other drive path its
 * /c/... form), inTree for a path's place in the tree (null outside it).
 */
export function treeMapping(cwd, mount) {
  const root = diskPath(cwd);
  const inside = mount ? absolute(String(mount)) : posixPath(root);
  if (inside === "/") throw new Error("mount: the tree needs a folder of its own, not /");
  const fold = (p) => (WINDOWS ? p.toLowerCase() : p);
  const below = (path, base) => {
    if (fold(path) === fold(base)) return "";
    return fold(path).startsWith(`${fold(base)}/`) ? path.slice(base.length + 1) : null;
  };
  const inTree = (path) => below(diskPath(path, root), root);
  const toInstance = (path) => {
    const disk = diskPath(path, root);
    const rel = below(disk, root);
    if (rel === null) return posixPath(disk);
    return rel ? `${inside}/${rel}` : inside;
  };
  const toDisk = (path) => {
    const rel = below(absolute(path), inside);
    if (rel === null) return null;
    return rel ? `${root}/${rel}` : root;
  };
  const sep = "[\\\\/]";
  const treeText = new RegExp(`${escapeRegExp(root).replace(/\//g, sep)}((?:${sep}[^,;"'\\s]*)?)(?=$|[,;"'\\s:=])`,
    WINDOWS ? "gi" : "g");
  const spell = (text) => {
    const s = String(text).replace(treeText, (m, rest) => inside + rest.replace(/\\/g, "/"));
    return WINDOWS ? s.replace(DRIVE_PATHS, (m, pre, path) => pre + toInstance(path)) : s;
  };
  return { root, inside, inTree, toInstance, toDisk, spell };
}

/** The lib/<dir> folders of the tree that a command names, in any argument, option value or list. */
export function namedLibs(argv, map, paths = []) {
  const libs = new Set();
  const consider = (p) => {
    if (!p || p.startsWith("-")) return;
    const rel = map.inTree(p);
    const m = rel && /^lib\/([^/]+)/.exec(rel);
    if (m) libs.add(`lib/${m[1]}`);
  };
  for (const arg of argv.slice(1)) {
    const a = String(arg);
    consider(a);
    consider(a.slice(a.indexOf("=") + 1));
    consider(a.replace(/^-(?:I|iquote|isystem|L|T)/, ""));
    for (const part of a.split(",")) consider(part);
  }
  for (const p of paths) consider(p);
  return [...libs].sort();
}

function isDirectory(path) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function readFile(path, rel, out) {
  try { out.push([rel, new Uint8Array(readFileSync(path))]); } catch { /* unreadable: the tool reports it */ }
}

/** Every file under a folder on disk, as [path relative to it, bytes]. */
function readFolder(dir, rel = "", out = []) {
  let names;
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names) {
    const path = join(dir, name);
    const r = rel ? `${rel}/${name}` : name;
    let st;
    try { st = statSync(path); } catch { continue; }
    if (st.isDirectory()) readFolder(path, r, out);
    else if (st.isFile()) readFile(path, r, out);
  }
  return out;
}

// The trees on disk, read once per process: {files: [[tree-relative path,
// bytes]], libs: Map(lib/<dir> -> its files, or null until a command names it)}.
// The engine writes only under out/ (and .config, klippy/.version, .git,
// which no tool reads) once the build has started.
const trees = new Map();
const folders = new Map(); // a folder outside the tree -> its files

function treeOf(root) {
  let tree = trees.get(root);
  if (tree) return tree;
  tree = { files: [], libs: new Map() };
  let names = [];
  try { names = readdirSync(root); } catch { /* the tool reports the files it misses */ }
  for (const name of names) {
    if (name === "out" || name === ".git") continue;
    const path = join(root, name);
    if (name === "lib" && isDirectory(path)) {
      for (const sub of readdirSync(path)) {
        if (isDirectory(join(path, sub))) tree.libs.set(`lib/${sub}`, null);
        else readFile(join(path, sub), `lib/${sub}`, tree.files);
      }
    } else if (isDirectory(path)) {
      readFolder(path, name, tree.files);
    } else {
      readFile(path, name, tree.files);
    }
  }
  trees.set(root, tree);
  return tree;
}

function libFiles(root, tree, lib) {
  let files = tree.libs.get(lib);
  if (files === undefined) return [];
  if (files === null) {
    files = readFolder(join(root, lib), lib);
    tree.libs.set(lib, files);
  }
  return files;
}

function folderOf(dir) {
  if (!folders.has(dir)) folders.set(dir, readFolder(dir));
  return folders.get(dir);
}

/** What the instance holds for one request: {argv, cwd, env, files, dirs}, and the mapping. */
export function prepare(req) {
  const map = treeMapping(req.cwd, req.mount);
  const argv = (req.argv || []).map((a) => map.spell(a));
  const env = {};
  for (const [k, v] of Object.entries(req.env || {})) env[k] = map.spell(v);
  const files = new Map();
  const tree = treeOf(map.root);
  for (const [rel, data] of tree.files) files.set(`${map.inside}/${rel}`, data);
  const links = Object.entries(req.symlinks || {});
  const named = namedLibs(req.argv || [], map, [...(req.inputs || []), ...(req.include_dirs || []), ...links.map(([, t]) => t)]);
  for (const lib of named) {
    for (const [rel, data] of libFiles(map.root, tree, lib)) files.set(`${map.inside}/${rel}`, data);
  }
  // What the command names outside the tree, at its own path.
  for (const dir of req.include_dirs || []) {
    if (map.inTree(dir) !== null) continue;
    const disk = diskPath(dir, map.root);
    for (const [rel, data] of folderOf(disk)) files.set(map.toInstance(`${disk}/${rel}`), data);
  }
  for (const input of req.inputs || []) {
    if (map.inTree(input) !== null) continue;
    try {
      files.set(map.toInstance(input), new Uint8Array(readFileSync(diskPath(input, map.root))));
    } catch { /* a missing file the tool reports */ }
  }
  // The generated files under out/, from the engine.
  for (const [path, b64] of Object.entries(req.files || {})) {
    files.set(map.toInstance(path), new Uint8Array(Buffer.from(b64, "base64")));
  }
  // The out/board links; a target outside the tree is mounted too.
  for (const [link, target] of links) {
    files.set(map.toInstance(link), { symlink: map.toInstance(target) });
    if (map.inTree(target) === null) {
      const disk = diskPath(target, map.root);
      for (const [rel, data] of folderOf(disk)) files.set(map.toInstance(`${disk}/${rel}`), data);
    }
  }
  const cwd = map.inside;
  return { map, argv, cwd, env, files, dirs: outputDirs(argv, cwd), libs: named };
}

async function handle(tc, req) {
  const { map, argv, cwd, env, files, dirs } = prepare(req);
  const r = await tc.run({ argv, cwd, env, files, dirs });
  const outputs = {};
  for (const [path, data] of r.outputs) {
    const disk = map.toDisk(path);
    if (disk) outputs[disk] = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("base64");
  }
  return { code: r.code, stdout: r.stdout, stderr: r.stderr, outputs, time: r.time, memory: r.memory };
}

async function main(manifestPath) {
  if (!manifestPath) {
    console.error("usage: node wasm-node-runner.mjs <release dir>/manifest.json");
    process.exit(2);
  }
  const releaseDir = dirname(resolve(manifestPath));
  const { createToolchain } = await import(pathToFileURL(join(releaseDir, "toolchain.js")).href);
  const tc = await createToolchain({ manifestUrl: pathToFileURL(resolve(manifestPath)).href });
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let reply;
    try {
      reply = await handle(tc, JSON.parse(line));
    } catch (e) {
      reply = { code: 134, stdout: "", stderr: `wasm-node-runner: ${e && e.stack ? e.stack : e}`, outputs: {} };
    }
    process.stdout.write(JSON.stringify(reply) + "\n");
  }
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  const a = resolve(process.argv[1]);
  const b = fileURLToPath(import.meta.url);
  return WINDOWS ? a.toLowerCase() === b.toLowerCase() : a === b;
}

if (invokedDirectly()) await main(process.argv[2]);
