// Runs the WebAssembly toolchain release under Node for the engine's
// WasmNodeToolchain: one JSON request per line on stdin, one JSON reply per
// line on stdout. The engine starts one of these per job slot.
//
//   node wasm-node-runner.mjs <release dir>/manifest.json
//
// Request:  {argv, cwd, env, files: {abs path: base64}, symlinks: {abs link: target},
//            inputs: [tree-relative paths], include_dirs: [tree-relative dirs]}
// Reply:    {code, stdout, stderr, outputs: {abs path: base64}, time, memory}
//
// The source tree is on disk at `cwd`: the runner mounts the files the command
// can read (the inputs it names, every file under its include directories,
// the generated files the engine sends) at the same absolute path inside the
// instance, so `-iquote out/`, `#include "board/..."` through the out/board
// symlink and the `.d` paths all work as they do on a developer's machine.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { join, resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";

const manifestPath = process.argv[2];
if (!manifestPath) {
  console.error("usage: node wasm-node-runner.mjs <release dir>/manifest.json");
  process.exit(2);
}
const releaseDir = dirname(resolve(manifestPath));
const { createToolchain } = await import(pathToFileURL(join(releaseDir, "toolchain.js")).href);
const tc = await createToolchain({ manifestUrl: pathToFileURL(resolve(manifestPath)).href });

const dirCache = new Map(); // absolute dir -> [[abs path, Uint8Array], ...]

function posix(p) {
  return p.replace(/\\/g, "/");
}

function readDir(dir, out) {
  let names;
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) {
    const path = join(dir, name);
    let st;
    try { st = statSync(path); } catch { continue; }
    if (st.isDirectory()) readDir(path, out);
    else if (st.isFile()) out.push([posix(path), new Uint8Array(readFileSync(path))]);
  }
}

function mountDir(dir) {
  const key = posix(resolve(dir));
  if (!dirCache.has(key)) {
    const files = [];
    readDir(dir, files);
    dirCache.set(key, files);
  }
  return dirCache.get(key);
}

async function handle(req) {
  const cwd = posix(resolve(req.cwd));
  const files = new Map();
  // Everything under the include directories (headers, and the sources
  // beside them), from the tree on disk.
  for (const dir of req.include_dirs || []) {
    const abs = resolve(cwd, dir);
    if (posix(abs).startsWith(posix(resolve(cwd, "out")))) continue; // the engine sends generated files
    for (const [path, data] of mountDir(abs)) files.set(path, data);
  }
  // Source directories: a compile's own folder and src/ for quote includes.
  for (const rel of req.inputs || []) {
    const abs = resolve(cwd, rel);
    if (posix(abs).startsWith(posix(resolve(cwd, "out")))) continue;
    try {
      files.set(posix(abs), new Uint8Array(readFileSync(abs)));
    } catch { /* an input the engine sends, or a missing file the tool reports */ }
  }
  for (const [path, b64] of Object.entries(req.files || {})) {
    files.set(posix(path), new Uint8Array(Buffer.from(b64, "base64")));
  }
  for (const [link, target] of Object.entries(req.symlinks || {})) {
    files.set(posix(link), { symlink: posix(target) });
    // The link's target directory must be present too: mount it.
    for (const [path, data] of mountDir(target)) files.set(path, data);
  }
  const r = await tc.run({ argv: req.argv, cwd, env: req.env || {}, files });
  const outputs = {};
  for (const [path, data] of r.outputs) outputs[path] = Buffer.from(data).toString("base64");
  return { code: r.code, stdout: r.stdout, stderr: r.stderr, outputs, time: r.time, memory: r.memory };
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  let reply;
  try {
    reply = await handle(JSON.parse(line));
  } catch (e) {
    reply = { code: 134, stdout: "", stderr: `wasm-node-runner: ${e && e.stack ? e.stack : e}`, outputs: {} };
  }
  process.stdout.write(JSON.stringify(reply) + "\n");
}
