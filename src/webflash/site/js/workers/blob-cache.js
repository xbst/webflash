// Downloads with progress, kept in Cache Storage when their URL names their
// content.
//
// Source bundles (sources/blobs/<sha256>.tar.gz) and toolchain files
// (toolchain/<id>/...) never change once published, so they are cached
// forever and a repeat visit reads them from disk; a bundle is checked
// against the SHA-256 its name carries before it is kept, so a broken
// download is never cached. Everything else (sources/index.json,
// toolchain/current.json) is fetched with cache: "no-cache", which
// revalidates with the server every time.
//
// Plain module with no worker-only APIs: the engine worker, the toolchain
// workers and the page can all import it. Cache Storage is per origin, so
// they share one cache.

export const CACHE_NAME = "webflash-v1";

const BLOB_RE = /\/sources\/blobs\/([0-9a-f]{64})\.tar\.gz$/;
const IMMUTABLE_RE = [BLOB_RE, /\/sources\/[^/]+\/[0-9a-f]{7,40}\//, /\/toolchain\/(?!current\.json$)[^/]+\/./];

/** Whether a URL's content can never change (it is named by its content or by a release id). */
export function isImmutable(url) {
  const path = new URL(url, self.location.href).pathname;
  return IMMUTABLE_RE.some((re) => re.test(path));
}

async function openCache() {
  try {
    return self.caches ? await self.caches.open(CACHE_NAME) : null;
  } catch (e) {
    return null;   // private windows and some embedded contexts have no Cache Storage
  }
}

function concat(chunks, length) {
  const out = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Download a file into memory, reporting progress as onProgress(done, total)
 * in bytes (total null when the server does not say).
 */
async function download(url, { revalidate, onProgress }) {
  let resp;
  try {
    resp = await fetch(url, { cache: revalidate ? "no-cache" : "default" });
  } catch (e) {
    throw new Error(`Could not download ${url}: the network request failed. Check your connection.`);
  }
  if (!resp.ok) throw new Error(`Could not download ${url} (HTTP ${resp.status}).`);
  // A Content-Length of a compressed transfer counts other bytes than the
  // body yields, so only trust it for an identity transfer.
  const encoded = (resp.headers.get("Content-Encoding") || "identity") !== "identity";
  const total = encoded ? null : Number(resp.headers.get("Content-Length")) || null;
  if (!resp.body || !resp.body.getReader) {
    const bytes = new Uint8Array(await resp.arrayBuffer());
    if (onProgress) onProgress(bytes.length, bytes.length);
    return { bytes, type: resp.headers.get("Content-Type") || "" };
  }
  const reader = resp.body.getReader();
  const chunks = [];
  let done = 0;
  if (onProgress) onProgress(0, total);
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    chunks.push(value);
    done += value.length;
    if (onProgress) onProgress(done, total);
  }
  return { bytes: concat(chunks, done), type: resp.headers.get("Content-Type") || "" };
}

/**
 * The bytes of a URL: from Cache Storage when its content is immutable and
 * cached, else downloaded (and cached when immutable). Resolves to
 * {bytes: Uint8Array, size, cached}. onProgress(done, total) reports bytes.
 */
export async function fetchBlob(url, { onProgress = null } = {}) {
  const href = new URL(url, self.location.href).href;
  const immutable = isImmutable(href);
  const cache = immutable ? await openCache() : null;
  if (cache) {
    try {
      const hit = await cache.match(href);
      if (hit) {
        const bytes = new Uint8Array(await hit.arrayBuffer());
        if (onProgress) onProgress(bytes.length, bytes.length);
        return { bytes, size: bytes.length, cached: true };
      }
    } catch (e) { /* a damaged cache entry: download it again */ }
  }
  const { bytes, type } = await download(href, { revalidate: !immutable, onProgress });
  const named = BLOB_RE.exec(new URL(href).pathname);
  if (named && crypto.subtle && (await sha256Hex(bytes)) !== named[1]) {
    throw new Error(`${href} did not download completely (its content does not match its name). Try again.`);
  }
  if (cache) {
    try {
      await cache.put(href, new Response(bytes, { headers: { "Content-Type": type || "application/octet-stream" } }));
    } catch (e) { /* storage full or blocked: the download still works, it is just not kept */ }
  }
  return { bytes, size: bytes.length, cached: false };
}

/** Whether an immutable URL is already in the cache (for "cached" labels before a download). */
export async function isCached(url) {
  const href = new URL(url, self.location.href).href;
  const cache = isImmutable(href) ? await openCache() : null;
  if (!cache) return false;
  try {
    return Boolean(await cache.match(href));
  } catch (e) {
    return false;
  }
}

/** Remove everything this cache holds. Resolves to whether there was anything. */
export async function clearCache() {
  try {
    return self.caches ? await self.caches.delete(CACHE_NAME) : false;
  } catch (e) {
    return false;
  }
}

/** gunzip with the browser's own DecompressionStream. */
export async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
