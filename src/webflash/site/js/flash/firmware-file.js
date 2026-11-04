// The firmware image model: what every flasher takes, and the parsers that
// make one from a build output or an uploaded file (SPEC 11.3).
//
// A FirmwareImage is a sorted list of address ranges with their bytes. It
// comes from a raw .bin plus its address, an Intel HEX file (klipper.elf.hex),
// a UF2 (klipper.uf2, which also names the chip family) or an ELF
// (klipper.elf, program headers at their physical addresses). Gaps stay
// gaps: the UF2 and PICOBOOT paths write only the pages that hold data, and
// the Katapult and DFU paths flatten the image with 0xFF fill, which is
// what a .bin would have had anyway.
//
// This module imports only errors.js, so it runs in Node tests and in the
// embed runtime alike.

import { FlashError, fail } from "./errors.js";

// UF2 constants (pico-sdk boot/uf2.h).
export const UF2_MAGIC_START0 = 0x0A324655;
export const UF2_MAGIC_START1 = 0x9E5D5157;
export const UF2_MAGIC_END = 0x0AB16F30;
export const UF2_FLAG_NOT_MAIN_FLASH = 0x00000001;
export const UF2_FLAG_FILE_CONTAINER = 0x00001000;
export const UF2_FLAG_FAMILY_ID_PRESENT = 0x00002000;
export const UF2_FLAG_MD5_PRESENT = 0x00004000;
export const UF2_FLAG_EXTENSION_FLAGS_PRESENT = 0x00008000;
export const UF2_BLOCK_SIZE = 512;
export const UF2_PAYLOAD_MAX = 476;

/** UF2 family ids the RP2 boot ROMs accept, by the name used in this project. */
export const UF2_FAMILIES = {
  rp2040: 0xe48bff56,
  absolute: 0xe48bff57,
  data: 0xe48bff58,
  "rp2350-arm-s": 0xe48bff59,
  "rp2350-riscv": 0xe48bff5a,
  "rp2350-arm-ns": 0xe48bff5b,
};

const FAMILY_NAMES = {
  rp2040: "RP2040",
  absolute: "RP2 absolute",
  data: "RP2 data",
  "rp2350-arm-s": "RP2350 (Arm, secure)",
  "rp2350-riscv": "RP2350 (RISC-V)",
  "rp2350-arm-ns": "RP2350 (Arm, non-secure)",
};

/** The family name for a UF2 family id, or the id in hex when unknown. */
export function familyFromId(id) {
  for (const [name, value] of Object.entries(UF2_FAMILIES)) if (value === id) return name;
  return `0x${(id >>> 0).toString(16).padStart(8, "0")}`;
}

/** The chip a UF2 family belongs to: "rp2040", "rp2350" or null. */
export function chipOfFamily(family) {
  if (!family) return null;
  if (family === "rp2040") return "rp2040";
  if (family.startsWith("rp2350")) return "rp2350";
  return null;
}

/**
 * Whether a UF2 family is one the RP2 boot ROMs do not take: a family id
 * outside UF2_FAMILIES (a SAMD51 or ESP32 UF2, say), which familyFromId
 * gives in hex. The ROM skips such blocks, so nothing would be written.
 */
export function isForeignFamily(family) {
  return typeof family === "string" && family !== "" && !(family in UF2_FAMILIES) && !chipOfFamily(family);
}

export function familyLabel(family) {
  return FAMILY_NAMES[family] || family || "";
}

export class FirmwareImage {
  /**
   * @param {{segments: {address: number, data: Uint8Array}[], family?: string|null, families?: string[],
   *          source?: "build"|"upload", name?: string, format?: string, entry?: number|null, dict?: object|null}} init
   */
  constructor({ segments, family = null, families = null, source = "upload", name = "", format = "bin", entry = null, dict = null }) {
    this.segments = mergeSegments(segments);
    this.family = family;
    this.families = families || (family ? [family] : []);
    this.source = source;
    this.name = name;
    this.format = format;
    this.entry = entry;
    this.dict = dict;        // Klipper's command dictionary when found in the image
  }

  get start() { return this.segments.length ? this.segments[0].address : 0; }
  /** One past the last byte. */
  get end() {
    if (!this.segments.length) return 0;
    const last = this.segments[this.segments.length - 1];
    return last.address + last.data.length;
  }
  /** Bytes of data (gaps not counted). */
  get size() { return this.segments.reduce((n, s) => n + s.data.length, 0); }
  /** Bytes from start to end, gaps included. */
  get span() { return this.end - this.start; }
  get isEmpty() { return this.segments.length === 0; }

  /** The MCU the firmware was built for, when its dictionary says. */
  get mcu() {
    return (this.dict && this.dict.config && this.dict.config.MCU) || null;
  }

  get version() {
    return (this.dict && this.dict.version) || null;
  }
}

/** Sort, drop empty, merge touching or overlapping segments (later data wins). */
export function mergeSegments(segments) {
  const list = segments.filter((s) => s && s.data && s.data.length)
    .map((s) => ({ address: s.address >>> 0, data: s.data instanceof Uint8Array ? s.data : new Uint8Array(s.data) }))
    .sort((a, b) => a.address - b.address);
  const out = [];
  for (const seg of list) {
    const prev = out[out.length - 1];
    if (prev && seg.address <= prev.address + prev.data.length) {
      const end = Math.max(prev.address + prev.data.length, seg.address + seg.data.length);
      const merged = new Uint8Array(end - prev.address);
      merged.set(prev.data, 0);
      merged.set(seg.data, seg.address - prev.address);
      prev.data = merged;
    } else {
      out.push({ address: seg.address, data: seg.data.slice() });
    }
  }
  return out;
}

// ── Builders ────────────────────────────────────────────────────────

/** A raw binary at an address (the build's CONFIG_FLASH_APPLICATION_ADDRESS or [prebuilt].address). */
export function fromBin(bytes, address, { source = "upload", name = "", family = null } = {}) {
  if (!Number.isInteger(address) || address < 0 || address > 0xffffffff) {
    fail("address", "A .bin file needs the flash address it belongs at (for example 0x08002000 for an STM32 with an 8 KiB bootloader).");
  }
  const data = asBytes(bytes);
  if (!data.length) fail("address", `${name || "The file"} is empty.`);
  return new FirmwareImage({ segments: [{ address, data }], source, name, format: "bin", family });
}

/**
 * Intel HEX (records 00 data, 01 EOF, 02 extended segment, 03 start segment,
 * 04 extended linear, 05 start linear). Checksums are verified; gaps between
 * data records stay separate segments.
 */
export function fromHex(textOrBytes, { source = "upload", name = "", family = null } = {}) {
  const text = typeof textOrBytes === "string" ? textOrBytes : new TextDecoder("latin1").decode(asBytes(textOrBytes));
  const segments = [];
  let base = 0;         // from type 02 (<<4) or 04 (<<16)
  let entry = null;
  let lineNo = 0;
  let sawEof = false;
  let cur = null;       // {address, parts: [Uint8Array]} being accumulated
  const flush = () => {
    if (cur) {
      segments.push({ address: cur.address, data: concat(cur.parts) });
      cur = null;
    }
  };
  for (const rawLine of text.split(/\r?\n/)) {
    lineNo++;
    const line = rawLine.trim();
    if (!line) continue;
    if (sawEof) break;
    if (line[0] !== ":") fail("protocol", `${name || "The HEX file"}: line ${lineNo} does not start with ':'.`, { code: "format" });
    if (line.length < 11 || (line.length - 1) % 2) fail("format", `${name || "The HEX file"}: line ${lineNo} has an odd length.`);
    const bytes = new Uint8Array((line.length - 1) / 2);
    for (let i = 0; i < bytes.length; i++) {
      const v = parseInt(line.substr(1 + i * 2, 2), 16);
      if (Number.isNaN(v)) fail("format", `${name || "The HEX file"}: line ${lineNo} is not hexadecimal.`);
      bytes[i] = v;
    }
    const count = bytes[0];
    if (bytes.length !== count + 5) fail("format", `${name || "The HEX file"}: line ${lineNo} has ${bytes.length - 5} data bytes but says ${count}.`);
    let sum = 0;
    for (const b of bytes) sum = (sum + b) & 0xff;
    if (sum !== 0) fail("format", `${name || "The HEX file"}: line ${lineNo} has a bad checksum.`);
    const offset = (bytes[1] << 8) | bytes[2];
    const type = bytes[3];
    const data = bytes.subarray(4, 4 + count);
    switch (type) {
      case 0x00: {
        const address = (base + offset) >>> 0;
        if (cur && cur.address + cur.length === address) {
          cur.parts.push(data.slice());
          cur.length += data.length;
        } else {
          flush();
          cur = { address, parts: [data.slice()], length: data.length };
        }
        break;
      }
      case 0x01:
        sawEof = true;
        break;
      case 0x02:
        if (count !== 2) fail("format", `${name || "The HEX file"}: line ${lineNo}: a type 02 record needs 2 bytes.`);
        base = ((data[0] << 8) | data[1]) << 4;
        break;
      case 0x03:
        // Start segment address (CS:IP): nothing to place.
        break;
      case 0x04:
        if (count !== 2) fail("format", `${name || "The HEX file"}: line ${lineNo}: a type 04 record needs 2 bytes.`);
        base = (((data[0] << 8) | data[1]) << 16) >>> 0;
        break;
      case 0x05:
        if (count !== 4) fail("format", `${name || "The HEX file"}: line ${lineNo}: a type 05 record needs 4 bytes.`);
        entry = ((data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3]) >>> 0;
        break;
      default:
        fail("format", `${name || "The HEX file"}: line ${lineNo} has an unknown record type ${type}.`);
    }
  }
  flush();
  if (!sawEof) fail("format", `${name || "The HEX file"} has no end-of-file record; it is probably cut short.`);
  if (!segments.length) fail("format", `${name || "The HEX file"} holds no data.`);
  return new FirmwareImage({ segments, source, name, format: "hex", entry, family });
}

/**
 * UF2: 512-byte blocks, both magic words checked, blocks flagged "not main
 * flash" skipped, the family taken from the first block that carries one.
 * blockNo and numBlocks are checked for consistency.
 */
export function fromUf2(bytes, { source = "upload", name = "" } = {}) {
  const data = asBytes(bytes);
  if (data.length < UF2_BLOCK_SIZE || data.length % UF2_BLOCK_SIZE) {
    fail("format", `${name || "The UF2 file"} is not a whole number of 512-byte blocks.`);
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const segments = [];
  const families = [];
  let numBlocks = null;
  let count = 0;
  for (let off = 0; off < data.length; off += UF2_BLOCK_SIZE) {
    if (view.getUint32(off, true) !== UF2_MAGIC_START0 || view.getUint32(off + 4, true) !== UF2_MAGIC_START1 ||
        view.getUint32(off + 508, true) !== UF2_MAGIC_END) {
      fail("format", `${name || "The UF2 file"}: block ${off / UF2_BLOCK_SIZE} has bad magic numbers.`);
    }
    const flags = view.getUint32(off + 8, true);
    const target = view.getUint32(off + 12, true);
    const payload = view.getUint32(off + 16, true);
    const blockNo = view.getUint32(off + 20, true);
    const total = view.getUint32(off + 24, true);
    const fileSizeOrFamily = view.getUint32(off + 28, true);
    if (payload > UF2_PAYLOAD_MAX) fail("format", `${name || "The UF2 file"}: block ${blockNo} claims ${payload} payload bytes.`);
    if (numBlocks === null) numBlocks = total;
    else if (total !== numBlocks) fail("format", `${name || "The UF2 file"}: block ${blockNo} says ${total} blocks, earlier blocks said ${numBlocks}.`);
    if (blockNo >= total) fail("format", `${name || "The UF2 file"}: block number ${blockNo} is not below the block count ${total}.`);
    count++;
    if (flags & UF2_FLAG_FAMILY_ID_PRESENT) {
      const fam = familyFromId(fileSizeOrFamily);
      if (!families.includes(fam)) families.push(fam);
    }
    if (flags & UF2_FLAG_NOT_MAIN_FLASH) continue;
    if (flags & UF2_FLAG_FILE_CONTAINER) continue;
    segments.push({ address: target, data: data.slice(off + 32, off + 32 + payload) });
  }
  if (numBlocks !== null && count !== numBlocks) {
    fail("format", `${name || "The UF2 file"} holds ${count} blocks but says ${numBlocks}; it is probably cut short.`);
  }
  if (!segments.length) fail("format", `${name || "The UF2 file"} holds no flash data.`);
  const family = families.length ? families[0] : null;
  const image = new FirmwareImage({ segments, source, name, format: "uf2", family, families });
  image.raw = data.slice();     // written as it was to a BOOTSEL drive
  return image;
}

/**
 * ELF32 little-endian: every PT_LOAD program header with p_filesz > 0,
 * placed at its physical address (the flash address of .data, where its
 * virtual address is in RAM).
 */
export function fromElf(bytes, { source = "upload", name = "", family = null } = {}) {
  const data = asBytes(bytes);
  if (data.length < 52 || data[0] !== 0x7f || data[1] !== 0x45 || data[2] !== 0x4c || data[3] !== 0x46) {
    fail("format", `${name || "The file"} is not an ELF file.`);
  }
  if (data[4] !== 1) fail("format", `${name || "The ELF file"} is 64-bit; firmware for these boards is 32-bit.`);
  if (data[5] !== 1) fail("format", `${name || "The ELF file"} is big-endian; firmware for these boards is little-endian.`);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const type = view.getUint16(16, true);
  const machine = view.getUint16(18, true);
  if (type !== 2) fail("format", `${name || "The ELF file"} is not an executable (type ${type}); link it first.`);
  const entry = view.getUint32(24, true);
  const phoff = view.getUint32(28, true);
  const phentsize = view.getUint16(42, true);
  const phnum = view.getUint16(44, true);
  if (!phnum || phentsize < 32) fail("format", `${name || "The ELF file"} has no program headers.`);
  const segments = [];
  for (let i = 0; i < phnum; i++) {
    const ph = phoff + i * phentsize;
    if (ph + 32 > data.length) fail("format", `${name || "The ELF file"} is cut short in its program headers.`);
    const pType = view.getUint32(ph, true);
    if (pType !== 1) continue;    // PT_LOAD
    const offset = view.getUint32(ph + 4, true);
    const paddr = view.getUint32(ph + 12, true);
    const filesz = view.getUint32(ph + 16, true);
    if (!filesz) continue;
    if (offset + filesz > data.length) fail("format", `${name || "The ELF file"} is cut short in segment ${i}.`);
    segments.push({ address: paddr, data: data.slice(offset, offset + filesz) });
  }
  if (!segments.length) fail("format", `${name || "The ELF file"} has no loadable segments.`);
  const image = new FirmwareImage({ segments, source, name, format: "elf", entry, family });
  image.machine = machine;    // 40 = ARM
  return image;
}

/** "hex" | "uf2" | "elf" | "bin", from the name's extension and the first bytes. */
export function sniffFormat(name, bytes) {
  const data = asBytes(bytes);
  const lower = String(name || "").toLowerCase();
  if (data.length >= 4 && data[0] === 0x7f && data[1] === 0x45 && data[2] === 0x4c && data[3] === 0x46) return "elf";
  if (data.length >= 512 && readU32(data, 0) === UF2_MAGIC_START0 && readU32(data, 4) === UF2_MAGIC_START1) return "uf2";
  if (/\.(hex|ihx|ihex)$/.test(lower)) return "hex";
  if (/\.uf2$/.test(lower)) return "uf2";
  if (/\.elf$/.test(lower)) return "elf";
  if (data.length >= 11 && data[0] === 0x3a && looksLikeHex(data)) return "hex";
  return "bin";
}

function looksLikeHex(data) {
  const n = Math.min(data.length, 64);
  for (let i = 1; i < n; i++) {
    const c = data[i];
    if (c === 0x0d || c === 0x0a) return true;
    if (!((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66))) return false;
  }
  return true;
}

/**
 * True when the first bytes (up to 64) are all printable ASCII or
 * whitespace: a text file, such as a Klipper dictionary or an Intel HEX
 * file with a bad record, that sniffFormat calls "bin". A firmware image
 * starts with its vector table, whose words always hold bytes outside
 * that range.
 */
export function looksLikeText(bytes) {
  const data = asBytes(bytes);
  const n = Math.min(data.length, 64);
  if (!n) return false;
  for (let i = 0; i < n; i++) {
    const c = data[i];
    if (!((c >= 0x20 && c <= 0x7e) || c === 0x09 || c === 0x0a || c === 0x0d)) return false;
  }
  return true;
}

/**
 * Parse a file by name and content. A .bin needs options.address; the
 * other formats carry their addresses (and a given address is ignored).
 */
export function parseFirmware(name, bytes, { address = null, source = "upload", family = null } = {}) {
  const format = sniffFormat(name, bytes);
  switch (format) {
    case "hex": return fromHex(bytes, { source, name, family });
    case "uf2": return fromUf2(bytes, { source, name });
    case "elf": return fromElf(bytes, { source, name, family });
    default: return fromBin(bytes, address, { source, name, family });
  }
}

// ── Describing and reshaping ────────────────────────────────────────

export function hex8(n) {
  return `0x${(n >>> 0).toString(16).padStart(8, "0")}`;
}

/**
 * A flash address as typed: hex digits, with or without 0x, 1 to 8 of
 * them, since addresses are always written in hex. Anything else, such
 * as a value with a stray character or more than 8 digits, is null.
 */
export function parseAddress(text) {
  const m = /^(?:0x)?([0-9a-f]{1,8})$/i.exec(String(text ?? "").trim());
  return m ? parseInt(m[1], 16) : null;
}

export function formatSize(n) {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n % 1024 ? 1 : 0)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
}

/** What the UI shows before writing: ranges, sizes, family, format, MCU. */
export function describe(image) {
  const ranges = image.segments.map((s) => ({ start: s.address, end: s.address + s.data.length, size: s.data.length }));
  return {
    format: image.format,
    name: image.name,
    source: image.source,
    family: image.family,
    familyLabel: familyLabel(image.family),
    families: image.families,
    start: image.start,
    end: image.end,
    size: image.size,
    span: image.span,
    ranges,
    rangeText: ranges.map((r) => `${hex8(r.start)} to ${hex8(r.end - 1)} (${formatSize(r.size)})`).join(", "),
    mcu: image.mcu,
    version: image.version,
  };
}

/**
 * The image as one contiguous byte array from start (default the image's
 * first address) to end, gaps filled (0xFF, erased flash). Katapult and DFU
 * write this; the result is what a .bin of the build would hold.
 */
export function flatten(image, { start = null, end = null, fill = 0xff } = {}) {
  const from = start === null ? image.start : start;
  const to = end === null ? image.end : end;
  if (to < from) fail("address", "The image range is empty.");
  if (to - from > 64 * 1024 * 1024) fail("address", "The image spans more than 64 MiB; that is not a firmware image.");
  const out = new Uint8Array(to - from).fill(fill);
  for (const seg of image.segments) {
    const segEnd = seg.address + seg.data.length;
    if (segEnd <= from || seg.address >= to) continue;
    const a = Math.max(seg.address, from);
    const b = Math.min(segEnd, to);
    out.set(seg.data.subarray(a - seg.address, b - seg.address), a - from);
  }
  return out;
}

/** The image's flash pages of pageSize bytes that hold data: [{address, data}] with data padded (0xFF) to the page. */
export function pages(image, pageSize = 256, fill = 0xff) {
  const out = [];
  for (const seg of image.segments) {
    const first = Math.floor(seg.address / pageSize) * pageSize;
    const last = Math.ceil((seg.address + seg.data.length) / pageSize) * pageSize;
    for (let addr = first; addr < last; addr += pageSize) {
      const page = new Uint8Array(pageSize).fill(fill);
      const a = Math.max(addr, seg.address);
      const b = Math.min(addr + pageSize, seg.address + seg.data.length);
      page.set(seg.data.subarray(a - seg.address, b - seg.address), a - addr);
      const prev = out[out.length - 1];
      if (prev && prev.address === addr) {
        // Two segments share a page: overlay the later one.
        for (let i = a - addr; i < b - addr; i++) prev.data[i] = page[i];
      } else {
        out.push({ address: addr, data: page });
      }
    }
  }
  return out;
}

/**
 * A UF2 of the image for the given family ("rp2040", "rp2350-arm-s", ...
 * or a numeric id), one 256-byte page per block, only pages with data.
 */
export function toUf2(image, family, { pageSize = 256 } = {}) {
  const familyId = typeof family === "number" ? family >>> 0 : UF2_FAMILIES[family];
  if (familyId === undefined) fail("wrong-family", `Unknown UF2 family "${family}".`);
  const blocks = pages(image, pageSize);
  const out = new Uint8Array(blocks.length * UF2_BLOCK_SIZE);
  const view = new DataView(out.buffer);
  blocks.forEach((block, i) => {
    const off = i * UF2_BLOCK_SIZE;
    view.setUint32(off, UF2_MAGIC_START0, true);
    view.setUint32(off + 4, UF2_MAGIC_START1, true);
    view.setUint32(off + 8, UF2_FLAG_FAMILY_ID_PRESENT, true);
    view.setUint32(off + 12, block.address, true);
    view.setUint32(off + 16, pageSize, true);
    view.setUint32(off + 20, i, true);
    view.setUint32(off + 24, blocks.length, true);
    view.setUint32(off + 28, familyId, true);
    out.set(block.data, off + 32);
    view.setUint32(off + 508, UF2_MAGIC_END, true);
  });
  return out;
}

// ── Klipper's dictionary inside a binary ────────────────────────────

/**
 * Find the zlib-compressed command dictionary Klipper links into every
 * firmware (what flashtool.py scans for) and return it parsed, or null.
 * Gives the MCU and version of an uploaded klipper.bin for the
 * confirmation and the Katapult MCU check.
 */
export async function extractKlipperDict(image) {
  const data = image instanceof FirmwareImage ? flatten(image) : asBytes(image);
  if (data.length > 8 * 1024 * 1024 || typeof DecompressionStream === "undefined") return null;
  for (let i = 0; i + 1 < data.length; i++) {
    if (data[i] !== 0x78) continue;
    const flg = data[i + 1];
    if (((0x78 << 8) | flg) % 31) continue;
    const text = await inflateZlib(data.subarray(i));
    if (!text || text[0] !== "{") continue;
    try {
      const dict = JSON.parse(text);
      if (dict && typeof dict === "object" && typeof dict.app === "string") return dict;
    } catch (e) {
      // Not JSON: a coincidence, keep looking.
    }
  }
  return null;
}

async function inflateZlib(bytes, limit = 1024 * 1024) {
  let ds;
  try {
    ds = new DecompressionStream("deflate");
  } catch (e) {
    return null;
  }
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  const chunks = [];
  let total = 0;
  const readAll = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.length;
        if (total > limit) { await reader.cancel(); break; }
      }
    } catch (e) {
      // Trailing bytes after the stream end are reported as an error once
      // the stream is complete; what came out before is kept.
    }
  })();
  try {
    const step = 16 * 1024;
    for (let off = 0; off < bytes.length; off += step) {
      await writer.write(bytes.subarray(off, Math.min(off + step, bytes.length)));
    }
    await writer.close();
  } catch (e) {
    // Not a zlib stream, or junk after its end.
  }
  await readAll;
  if (!chunks.length) return null;
  return new TextDecoder().decode(concat(chunks));
}

// ── Bytes ───────────────────────────────────────────────────────────

export function asBytes(x) {
  if (x instanceof Uint8Array) return x;
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  if (Array.isArray(x)) return new Uint8Array(x);
  throw new FlashError("Expected bytes.", { code: "format" });
}

export function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return out;
}

export function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** The first index where a and b differ, or -1. */
export function firstDifference(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

function readU32(data, off) {
  return (data[off] | (data[off + 1] << 8) | (data[off + 2] << 16) | (data[off + 3] << 24)) >>> 0;
}
