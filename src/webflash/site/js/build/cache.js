// What the build keeps in the browser: the compiler release and the source
// bundles, in Cache Storage (workers/blob-cache.js), so a second visit
// downloads nothing but the two small files that say what is current.
//
// The compiler's files are checked against the release's manifest (size and
// SHA-256) before they are used; a copy that does not match (a download cut
// short, a damaged cache entry) is dropped and fetched once more, so a bad
// file can never stay cached. About shows how much the site keeps
// (navigator.storage.estimate) and empties the cache.

import { CACHE_NAME, clearCache, fetchBlob, isCached } from "../workers/blob-cache.js";

export { clearCache, isCached };

/**
 * The files of a toolchain release a build downloads, from its manifest:
 * [{name, url, size, sha256, uncompressed}] (the module's JavaScript and
 * WebAssembly, toolchain.js and the sysroot). The libc++ headers are left
 * out: the first clang++ fetches them, and only Kalico's C++ needs them.
 */
export function toolchainFiles(manifest, base) {
  const module = manifest.module || {};
  const names = [module.js || "llvm.js", module.wasm || "llvm.wasm.gz", "toolchain.js", "sysroot.tar.gz"];
  return [...new Set(names)].map((name) => {
    const f = (manifest.files || {})[name];
    if (!f) throw new Error(`the toolchain manifest lists no ${name}`);
    return { name, url: new URL(name, base).href, size: f.size, sha256: f.sha256 || null, uncompressed: f.uncompressed || null };
  });
}

async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Remove one URL from the cache (a copy that failed its check). */
export async function forget(url) {
  try {
    const cache = self.caches ? await self.caches.open(CACHE_NAME) : null;
    if (cache) await cache.delete(new URL(url, self.location.href).href);
  } catch (e) { /* nothing to remove */ }
}

async function problemWith(bytes, { size, sha256 }) {
  if (Number.isFinite(size) && bytes.length !== size) return `is ${bytes.length} bytes, the manifest says ${size}`;
  if (sha256 && typeof crypto !== "undefined" && crypto.subtle && (await sha256Hex(bytes)) !== sha256) {
    return "does not match the manifest's SHA-256";
  }
  return null;
}

/**
 * The bytes of a release file, through Cache Storage, checked against its
 * size and SHA-256: {bytes, size, cached}. A copy that fails the check is
 * removed from the cache and downloaded again, once.
 */
export async function fetchVerified(url, { size = null, sha256 = null, onProgress = null } = {}) {
  let last = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const got = await fetchBlob(url, { size, onProgress });
    const problem = await problemWith(got.bytes, { size, sha256 });
    if (!problem) return got;
    await forget(url);
    last = `${url} ${problem}${got.cached ? " (the cached copy)" : ""}`;
  }
  throw new Error(`${last}. Try again; if it keeps happening, the published compiler is damaged.`);
}

/** For each file ({url}), whether it is in the cache: [true, false, ...]. */
export function cachedFlags(files) {
  return Promise.all(files.map((f) => isCached(f.url)));
}

/**
 * How much this site keeps in the browser: {usage, quota, caches} in bytes
 * (caches only where the browser breaks the total down), or null where the
 * browser does not say.
 */
export async function storageEstimate() {
  try {
    if (typeof navigator === "undefined" || !navigator.storage || !navigator.storage.estimate) return null;
    const e = await navigator.storage.estimate();
    const details = e.usageDetails || {};
    return {
      usage: Number.isFinite(e.usage) ? e.usage : null,
      quota: Number.isFinite(e.quota) ? e.quota : null,
      caches: Number.isFinite(details.caches) ? details.caches : null,
    };
  } catch (e) {
    return null;
  }
}
