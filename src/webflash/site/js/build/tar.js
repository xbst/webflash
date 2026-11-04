// A small tar reader for the toolchain workers.
//
// The source bundles (sources/blobs/<sha256>.tar.gz) are plain ustar inside
// gzip: regular files only, paths sorted, a pax "path" header only for a path
// over 100 bytes. The worker gunzips one with DecompressionStream and hands
// the tar to readTar, which lists its entries without copying anything: every
// entry's data is a view into the archive. Types 0 (and NUL), 5 and 2 are
// files, directories and symbolic links; the ustar prefix field, pax "path",
// "linkpath" and "size" records and GNU long names are honored; anything else
// (hard links, devices, global pax headers) is skipped.

const BLOCK = 512;
const decoder = new TextDecoder();

function text(bytes, off, len) {
  let end = off;
  const lim = Math.min(off + len, bytes.length);
  while (end < lim && bytes[end] !== 0) end++;
  return decoder.decode(bytes.subarray(off, end));
}

function octal(bytes, off, len) {
  if (bytes[off] & 0x80) {
    // GNU base-256 for values that do not fit the octal field.
    let v = 0;
    for (let i = 1; i < len; i++) v = v * 256 + bytes[off + i];
    return v;
  }
  const s = text(bytes, off, len).trim();
  return s ? parseInt(s, 8) : 0;
}

function zeroBlock(bytes, off) {
  for (let i = 0; i < BLOCK; i++) if (bytes[off + i] !== 0) return false;
  return true;
}

// The header checksum: the sum of its bytes with the checksum field read as
// spaces. A mismatch means this is not a tar (a gzip stream handed over by
// mistake, a truncated download), which must fail rather than mount garbage.
function checksumOk(bytes, off) {
  const stored = octal(bytes, off + 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : bytes[off + i];
  return sum === stored;
}

function paxRecords(data) {
  const out = {};
  const s = decoder.decode(data);
  let i = 0;
  while (i < s.length) {
    const space = s.indexOf(" ", i);
    if (space < 0) break;
    const length = parseInt(s.slice(i, space), 10);
    if (!(length > 0)) break;
    const record = s.slice(space + 1, i + length - 1);
    const eq = record.indexOf("=");
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    i += length;
  }
  return out;
}

/**
 * The entries of a tar archive: [{name, type, mode, size, data, linkname}],
 * type being "file", "dir" or "symlink", data a view into bytes (empty for
 * anything but a file). Names lose a leading "./" and a trailing "/". Throws
 * when bytes is not a tar archive.
 */
export function readTar(bytes) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    throw new Error("this is a gzip stream, not a tar archive: gunzip it first");
  }
  const entries = [];
  let pax = null;
  let longName = null;
  let longLink = null;
  let off = 0;
  while (off + BLOCK <= bytes.length) {
    if (zeroBlock(bytes, off)) break;
    if (!checksumOk(bytes, off)) throw new Error(`not a tar archive (bad header checksum at byte ${off})`);
    let name = text(bytes, off, 100);
    const mode = octal(bytes, off + 100, 8);
    let size = octal(bytes, off + 124, 12);
    const flag = bytes[off + 156];
    let linkname = text(bytes, off + 157, 100);
    // POSIX ustar ("ustar\0") splits a long path into prefix and name; GNU's
    // "ustar  " uses that space for other fields.
    if (text(bytes, off + 257, 6) === "ustar" && bytes[off + 262] === 0) {
      const prefix = text(bytes, off + 345, 155);
      if (prefix) name = `${prefix}/${name}`;
    }
    if (pax && pax.size !== undefined) size = parseInt(pax.size, 10);
    const start = off + BLOCK;
    if (start + size > bytes.length) throw new Error(`the tar archive is truncated (${name})`);
    const data = bytes.subarray(start, start + size);
    off = start + Math.ceil(size / BLOCK) * BLOCK;

    if (flag === 0x78) { pax = paxRecords(data); continue; }               // 'x': for the next entry
    if (flag === 0x67) continue;                                           // 'g': global, nothing we use
    if (flag === 0x4c) { longName = text(data, 0, data.length); continue; } // 'L': GNU long name
    if (flag === 0x4b) { longLink = text(data, 0, data.length); continue; } // 'K': GNU long link
    if (pax) {
      if (pax.path !== undefined) name = pax.path;
      if (pax.linkpath !== undefined) linkname = pax.linkpath;
      pax = null;
    }
    if (longName !== null) { name = longName; longName = null; }
    if (longLink !== null) { linkname = longLink; longLink = null; }
    name = name.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
    if (!name) continue;

    let type;
    if (flag === 0x30 || flag === 0 || flag === 0x37) type = "file";       // '0', NUL, '7' (contiguous)
    else if (flag === 0x35) type = "dir";                                  // '5'
    else if (flag === 0x32) type = "symlink";                              // '2'
    else continue;                                                         // hard links, devices, FIFOs
    entries.push({ name, type, mode, size: type === "file" ? size : 0, data: type === "file" ? data : data.subarray(0, 0), linkname });
  }
  return entries;
}
