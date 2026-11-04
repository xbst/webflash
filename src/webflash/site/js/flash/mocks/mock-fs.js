// A scripted File System Access directory: the BOOTSEL drive for the UF2
// tests and the ?mock= mode. Files are strings or bytes; a drive that
// "vanishes" throws after a number of bytes have been written, as the real
// one does when the ROM restarts the chip.

export class MockFileHandle {
  constructor(dir, name) {
    this.kind = "file";
    this.dir = dir;
    this.name = name;
  }
  async getFile() {
    const data = this.dir.files.get(this.name);
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    return {
      name: this.name, size: bytes.length,
      text: async () => new TextDecoder().decode(bytes),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  }
  async createWritable() {
    const dir = this.dir;
    const name = this.name;
    const parts = [];
    let written = 0;
    const check = () => {
      if (dir.gone) throw domError("NotFoundError", "A requested file or directory could not be found at the time an operation was processed.");
    };
    return {
      async write(chunk) {
        check();
        const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        if (dir.vanishAfterBytes !== null && written + bytes.length >= dir.vanishAfterBytes) {
          // The chip restarts with the last block: the drive is gone.
          const keep = bytes.subarray(0, Math.max(0, dir.vanishAfterBytes - written));
          parts.push(keep.slice());
          written += keep.length;
          dir.writes.push([name, written]);
          dir.gone = true;
          dir.received = concat(parts);
          throw domError("NotFoundError", "The drive was removed.");
        }
        parts.push(bytes.slice());
        written += bytes.length;
        dir.writes.push([name, written]);
      },
      async close() {
        check();
        dir.files.set(name, concat(parts));
        dir.received = concat(parts);
      },
      async abort() {},
    };
  }
}

export class MockDirectoryHandle {
  constructor({ name = "RPI-RP2", files = {}, vanishAfterBytes = null } = {}) {
    this.kind = "directory";
    this.name = name;
    this.files = new Map(Object.entries(files));
    this.vanishAfterBytes = vanishAfterBytes;
    this.gone = false;
    this.writes = [];
    this.received = null;
  }
  async getFileHandle(name, { create = false } = {}) {
    if (this.gone) throw domError("NotFoundError", "The drive was removed.");
    if (!this.files.has(name)) {
      if (!create) throw domError("NotFoundError", `${name} not found`);
      this.files.set(name, new Uint8Array(0));
    }
    return new MockFileHandle(this, name);
  }
  async queryPermission() { return "granted"; }
  async requestPermission() { return "granted"; }
}

export const RP2040_INFO = "UF2 Bootloader v3.0\r\nModel: Raspberry Pi RP2\r\nBoard-ID: RPI-RP2\r\n";
export const RP2350_INFO = "UF2 Bootloader v3.0\r\nModel: Raspberry Pi RP2350\r\nBoard-ID: RP2350\r\n";

export function bootselDrive({ chip = "rp2040", vanishAfterBytes = null } = {}) {
  return new MockDirectoryHandle({
    name: chip === "rp2350" ? "RP2350" : "RPI-RP2",
    files: { "INFO_UF2.TXT": chip === "rp2350" ? RP2350_INFO : RP2040_INFO, "INDEX.HTM": "<html></html>" },
    vanishAfterBytes,
  });
}

function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return out;
}

export function domError(name, message) {
  let e;
  if (typeof DOMException !== "undefined") e = new DOMException(message, name);
  else { e = new Error(message); e.name = name; }
  return e;
}
