// The UF2 path: write the firmware onto the RP2 BOOTSEL drive with the File
// System Access API, or hand the .uf2 over as a download (SPEC 11.1 "uf2").
//
// The BOOTSEL drive holds INFO_UF2.TXT ("UF2 Bootloader v3.0", "Model:
// Raspberry Pi RP2", "Board-ID: RPI-RP2"; the RP2350 says "RP2350"), which
// is how the picked folder is checked before anything is written. The ROM
// restarts the chip as soon as the last block arrives, so the drive
// disappears under the write: an error after the first bytes went out is
// the expected end, not a failure, and the device's re-enumeration (or the
// user) confirms the result.

import { FlashError, fail } from "./errors.js";
import { toUf2, chipOfFamily, UF2_FAMILIES, formatSize } from "./firmware-file.js";

export const INFO_FILE = "INFO_UF2.TXT";
export const WRITE_CHUNK = 64 * 1024;

export function hasFileSystemAccess(win = typeof window !== "undefined" ? window : null) {
  return !!(win && typeof win.showDirectoryPicker === "function");
}

/** The browser's folder picker, for the BOOTSEL drive. Throws "cancelled" when dismissed, "no-api" without the API. */
export async function pickBootselDrive({ win = typeof window !== "undefined" ? window : null } = {}) {
  if (!hasFileSystemAccess(win)) fail("no-api", "This browser cannot write to a drive from a web page.");
  try {
    return await win.showDirectoryPicker({ mode: "readwrite", id: "webflash-bootsel" });
  } catch (e) {
    if (e && e.name === "AbortError") fail("cancelled", "No drive was picked.", { cause: e });
    if (e && e.name === "SecurityError") fail("permission", `The browser refused the folder: ${e.message}`, { cause: e });
    throw e;
  }
}

/** Parse INFO_UF2.TXT: {bootloader, model, boardId, chip: "rp2040"|"rp2350"|null, raw}. */
export function parseInfoUf2(text) {
  const info = { bootloader: "", model: "", boardId: "", chip: null, raw: text };
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = /^([^:]+):\s*(.*)$/.exec(line.trim());
    if (!m) {
      if (/UF2 Bootloader/i.test(line)) info.bootloader = line.trim();
      continue;
    }
    const key = m[1].trim().toLowerCase();
    if (key === "model") info.model = m[2].trim();
    else if (key === "board-id") info.boardId = m[2].trim();
  }
  if (/^RPI-RP2$/i.test(info.boardId) || /RP2040/i.test(info.model)) info.chip = "rp2040";
  else if (/RP2350/i.test(info.boardId) || /RP2350/i.test(info.model)) info.chip = "rp2350";
  return info;
}

/** Read and parse the drive's INFO_UF2.TXT, or null when there is none. */
export async function readInfoUf2(handle) {
  let fileHandle;
  try {
    fileHandle = await handle.getFileHandle(INFO_FILE);
  } catch (e) {
    if (e && (e.name === "NotFoundError" || e.name === "TypeMismatchError")) return null;
    throw e;
  }
  const file = await fileHandle.getFile();
  return parseInfoUf2(await file.text());
}

/**
 * Check that the picked folder is a BOOTSEL drive for the right chip.
 * family is the image's UF2 family or "rp2040" / "rp2350"; null skips the
 * chip check. Returns the parsed info.
 */
export async function checkBootselDrive(handle, { family = null } = {}) {
  const info = await readInfoUf2(handle);
  if (!info) {
    const n = meaningfulDriveName(handle.name);
    fail("drive", `${n ? `The folder "${n}"` : "The picked folder"} has no ${INFO_FILE}, so it is not a BOOTSEL drive. Hold BOOTSEL while plugging the board in and pick the drive named RPI-RP2 (or RP2350).`);
  }
  if (!info.chip) {
    fail("drive", `The drive's ${INFO_FILE} names a board WebFlash does not know ("${info.boardId || info.model}"); only the RP2040 and RP2350 BOOTSEL drives are supported.`);
  }
  const wanted = chipOfFamily(family) || (family === "rp2040" || family === "rp2350" ? family : null);
  if (wanted && wanted !== info.chip) {
    fail("wrong-family", `This firmware is for the ${wanted.toUpperCase()}, but the drive belongs to an ${info.chip.toUpperCase()} (${info.boardId}).`);
  }
  return info;
}

/** A folder handle's name when it says something: Chrome on Windows names a drive root "\" (STOP 3 saw `drive "\"` in the confirmation). */
export function meaningfulDriveName(name) {
  const n = String(name || "").trim();
  return n && n !== "\\" && n !== "/" ? n : null;
}

/**
 * One line for the log and the confirmation: the board the drive belongs
 * to, from its INFO_UF2.TXT, plus the picked name when it adds something.
 * Without info (before the drive was read) only the name, or "the picked
 * drive".
 */
export function describeDrive(info, name = null) {
  const n = meaningfulDriveName(name);
  if (!info) return n ? `drive "${n}"` : "the picked drive";
  const board = info.boardId || info.model || "BOOTSEL";
  const details = [info.model && info.model !== info.boardId ? info.model : null, info.bootloader || null].filter(Boolean).join(", ");
  return `${board} BOOTSEL drive${details ? ` (${details})` : ""}${n && n !== board ? `, picked as "${n}"` : ""}`;
}

/** The family to encode a non-UF2 image with, from the drive's chip. */
export function familyForChip(chip) {
  return chip === "rp2350" ? "rp2350-arm-s" : "rp2040";
}

/**
 * The bytes to write: a UF2 upload as it was, anything else encoded for
 * the family (the image's own, else the drive's chip).
 */
export function uf2Bytes(image, { family = null, chip = null } = {}) {
  if (image.format === "uf2" && image.raw) return image.raw;
  const fam = family || image.family || (chip ? familyForChip(chip) : null);
  if (!fam || !(fam in UF2_FAMILIES)) {
    fail("wrong-family", "The chip family is unknown, so the .uf2 cannot be built: pick the BOOTSEL drive (its name says which chip) or build for the board.");
  }
  return toUf2(image, fam);
}

/**
 * Write the .uf2 into the drive. Returns {written, disappeared}: disappeared
 * is true when the drive went away mid-write, which is what a successful
 * flash looks like from the host.
 */
export async function writeUf2ToDrive(handle, bytes, { name = "firmware.uf2", log = null, progress = null } = {}) {
  let written = 0;
  let writable = null;
  try {
    const fileHandle = await handle.getFileHandle(name, { create: true });
    writable = await fileHandle.createWritable({ keepExistingData: false });
  } catch (e) {
    throw new FlashError(`The file could not be created on the drive: ${e && e.message ? e.message : e}`, { code: "drive", cause: e });
  }
  try {
    for (let off = 0; off < bytes.length; off += WRITE_CHUNK) {
      const chunk = bytes.subarray(off, Math.min(off + WRITE_CHUNK, bytes.length));
      await writable.write(chunk);
      written += chunk.length;
      if (progress) progress("write", written, bytes.length);
    }
    await writable.close();
    if (log) log(`Wrote ${formatSize(written)} to ${name}; the board restarts when its bootloader has taken the last block`);
    return { written, disappeared: false };
  } catch (e) {
    if (written > 0) {
      if (log) log(`The drive went away after ${formatSize(written)} of ${formatSize(bytes.length)}: the board took the file and restarted (${e && e.message ? e.message : e})`);
      try { await writable.abort(); } catch (e2) { /* gone */ }
      return { written, disappeared: true };
    }
    throw new FlashError(`Writing to the drive failed before any data went out: ${e && e.message ? e.message : e}`, { code: "drive", cause: e });
  }
}

/**
 * The whole UF2 drive path: check the drive, encode, write. Returns
 * {info, bytes, written, disappeared, fileName}.
 */
export async function flashUf2(handle, image, { family = null, fileName = null } = {}, { log = null, progress = null } = {}) {
  const info = await checkBootselDrive(handle, { family: family || image.family });
  if (log) log(`BOOTSEL drive: ${info.model || info.boardId} (${info.bootloader || "UF2 bootloader"})`);
  const bytes = uf2Bytes(image, { family, chip: info.chip });
  const name = fileName || (image.name ? image.name.replace(/\.(bin|elf|hex|uf2)$/i, "") + ".uf2" : "firmware.uf2");
  const result = await writeUf2ToDrive(handle, bytes, { name, log, progress });
  return { info, bytes: bytes.length, written: result.written, disappeared: result.disappeared, fileName: name, chip: info.chip };
}

/** For the download fallback: the .uf2 bytes and a file name. */
export function uf2Download(image, { family = null } = {}) {
  const bytes = uf2Bytes(image, { family: family || image.family || "rp2040" });
  const name = image.name ? image.name.replace(/\.(bin|elf|hex|uf2)$/i, "") + ".uf2" : "firmware.uf2";
  return { bytes, name };
}
