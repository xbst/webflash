"""Firmware file inspection: ELF program headers, sections and symbols, the
vector table, sizes, and the segments of ``.bin``, ``.hex`` and ``.uf2``
files. Used by ``webflash inspect`` and by the parity checks.
"""
from __future__ import annotations

import json
import re
import struct
from pathlib import Path
from typing import Optional, Union

from .uf2 import uf2_blocks

PT_LOAD = 1
SHF_WRITE, SHF_ALLOC, SHF_EXECINSTR = 0x1, 0x2, 0x4
SHT_NOBITS = 8
SHT_SYMTAB = 2
SHT_STRTAB = 3

_SYMBOLS = ("_text_vectortable_start", "_text_vectortable_end", "_stack_end", "_stack_start", "_data_flash",
            "_data_start", "_data_end", "_bss_start", "_bss_end", "VectorTable", "ResetHandler", "main")


class InspectError(ValueError):
    pass


def _c_string(data: bytes, offset: int) -> str:
    end = data.find(b"\0", offset)
    return data[offset:end if end >= 0 else len(data)].decode("utf-8", errors="replace")


def _need(data: bytes, offset: int, size: int, what: str) -> None:
    if offset + size > len(data):
        raise InspectError(f"truncated ELF ({what} at offset {offset} is beyond the end of the file)")


def parse_elf(data: bytes) -> dict:
    """An ELF32 little-endian file: header fields, program headers, sections
    (name, address, size, flags, type) and the symbols the linker scripts and
    the firmware define."""
    if len(data) < 52 or data[:4] != b"\x7fELF":
        raise InspectError("not an ELF file")
    if data[4] != 1 or data[5] != 1:
        raise InspectError("only 32-bit little-endian ELF files are supported")
    (e_type, e_machine, _e_version, e_entry, e_phoff, e_shoff, e_flags, _e_ehsize, e_phentsize, e_phnum,
     e_shentsize, e_shnum, e_shstrndx) = struct.unpack_from("<HHIIIIIHHHHHH", data, 16)
    if e_phnum and e_phentsize < 32:
        raise InspectError(f"malformed ELF (program header entries of {e_phentsize} bytes, at least 32 expected)")
    if e_shnum and e_shentsize < 40:
        raise InspectError(f"malformed ELF (section header entries of {e_shentsize} bytes, at least 40 expected)")
    segments = []
    for n in range(e_phnum):
        off = e_phoff + n * e_phentsize
        _need(data, off, 32, f"program header {n}")
        p_type, p_offset, p_vaddr, p_paddr, p_filesz, p_memsz, p_flags, p_align = struct.unpack_from("<IIIIIIII", data, off)
        _need(data, p_offset, p_filesz, f"the contents of program header {n}")
        segments.append({"type": p_type, "offset": p_offset, "vaddr": p_vaddr, "paddr": p_paddr,
                         "filesz": p_filesz, "memsz": p_memsz, "flags": p_flags, "align": p_align})
    raw_sections = []
    for n in range(e_shnum):
        off = e_shoff + n * e_shentsize
        _need(data, off, 40, f"section header {n}")
        (sh_name, sh_type, sh_flags, sh_addr, sh_offset, sh_size, sh_link, sh_info,
         _sh_addralign, sh_entsize) = struct.unpack_from("<IIIIIIIIII", data, off)
        if sh_type not in (0, SHT_NOBITS):
            _need(data, sh_offset, sh_size, f"the contents of section {n}")
        raw_sections.append({"name_off": sh_name, "type": sh_type, "flags": sh_flags, "addr": sh_addr,
                             "offset": sh_offset, "size": sh_size, "link": sh_link, "info": sh_info,
                             "entsize": sh_entsize})
    names = b""
    if 0 <= e_shstrndx < len(raw_sections):
        s = raw_sections[e_shstrndx]
        names = data[s["offset"]:s["offset"] + s["size"]]
    sections = []
    for s in raw_sections:
        sections.append({"name": _c_string(names, s["name_off"]) if names else "", "type": s["type"],
                         "flags": s["flags"], "addr": s["addr"], "offset": s["offset"], "size": s["size"]})
    symbols: dict[str, int] = {}
    for s in raw_sections:
        if s["type"] != SHT_SYMTAB or s["entsize"] == 0:
            continue
        if s["entsize"] < 16:
            raise InspectError(f"malformed ELF (symbol table entries of {s['entsize']} bytes, at least 16 expected)")
        strtab = raw_sections[s["link"]] if s["link"] < len(raw_sections) else None
        strings = data[strtab["offset"]:strtab["offset"] + strtab["size"]] if strtab else b""
        for n in range(s["size"] // s["entsize"]):
            off = s["offset"] + n * s["entsize"]
            st_name, st_value, _st_size, _st_info, _st_other, _st_shndx = struct.unpack_from("<IIIBBH", data, off)
            name = _c_string(strings, st_name)
            if name in _SYMBOLS and name not in symbols:
                symbols[name] = st_value
    return {"type": e_type, "machine": e_machine, "entry": e_entry, "flags": e_flags,
            "segments": segments, "sections": sections, "symbols": symbols}


def elf_sizes(elf: dict) -> dict[str, int]:
    """``text``, ``data`` and ``bss`` as GNU ``size`` counts them (code and
    read-only data are text, even when LLVM marks a constant table with
    relocations writable), and ``flash``: the bytes a flash image holds (the
    file parts of the LOAD segments that carry sections)."""
    text = data_size = bss = 0
    for s in elf["sections"]:
        if not s["flags"] & SHF_ALLOC or s["size"] == 0:
            continue
        if s["type"] == SHT_NOBITS:
            bss += s["size"]
        elif s["flags"] & SHF_EXECINSTR or not s["flags"] & SHF_WRITE:
            text += s["size"]
        else:
            data_size += s["size"]
    flash = sum(seg["filesz"] for seg in _content_segments(elf))
    return {"text": text, "data": data_size, "bss": bss, "flash": flash}


def _content_segments(elf: dict) -> list[dict]:
    """The LOAD segments that hold a section's bytes, clipped to those bytes.
    lld puts the ELF and program headers in a LOAD segment of their own below
    the first section, and GNU ld may put them in the first section's segment
    when the section's address leaves room, so that the segment starts at the
    flash base, a bootloader's length below the code. objcopy writes
    sections, so an image holds neither the headers nor that gap."""
    out = []
    for seg in elf["segments"]:
        if seg["type"] != PT_LOAD or not seg["filesz"]:
            continue
        lo, hi = seg["offset"], seg["offset"] + seg["filesz"]
        held = [s for s in elf["sections"]
                if s["flags"] & SHF_ALLOC and s["size"] and s["type"] != SHT_NOBITS and lo <= s["offset"] < hi]
        if not held:
            continue
        start = min(s["offset"] for s in held)
        end = min(hi, max(s["offset"] + s["size"] for s in held))
        skip = start - lo
        out.append({**seg, "offset": start, "vaddr": seg["vaddr"] + skip, "paddr": seg["paddr"] + skip,
                    "filesz": end - start, "memsz": max(seg["memsz"] - skip, end - start)})
    return out


def elf_segments(elf: dict, data: bytes) -> list[dict]:
    """The LOAD segments with contents, by physical (load) address; ``vaddr``
    is where the code runs (the SAME70 runs from ITCM, loaded from flash)."""
    out = []
    for seg in _content_segments(elf):
        out.append({"address": seg["paddr"], "vaddr": seg["vaddr"], "size": seg["filesz"],
                    "data": data[seg["offset"]:seg["offset"] + seg["filesz"]]})
    return sorted(out, key=lambda s: s["address"])


def vector_table(elf: dict, data: bytes) -> Optional[dict]:
    """The vector table's address and its first two words (the initial stack
    pointer and the reset handler), from ``_text_vectortable_start`` or the
    first flash segment."""
    addr = elf["symbols"].get("_text_vectortable_start")
    segments = elf_segments(elf, data)
    if addr is None:
        if not segments:
            return None
        addr = segments[0]["address"]
    for seg in segments:
        for base in (seg["address"], seg.get("vaddr", seg["address"])):
            if base <= addr < base + seg["size"] - 7:
                off = addr - base
                sp, reset = struct.unpack_from("<II", seg["data"], off)
                return {"address": addr, "stack": sp, "reset": reset}
    return None


SHT_ARM_ATTRIBUTES = 0x70000003
TAG_FP_ARCH = 10


def _uleb(data: bytes, pos: int, end: int) -> tuple[int, int]:
    value = shift = 0
    while pos < end:
        b = data[pos]
        pos += 1
        value |= (b & 0x7F) << shift
        shift += 7
        if not b & 0x80:
            return value, pos
    raise InspectError("truncated build attribute")


def arm_attributes(elf: dict, data: bytes) -> dict[int, Union[int, str]]:
    """The file-wide ``aeabi`` build attributes of ``.ARM.attributes``
    (``readelf -A``), by tag number: ``Tag_FP_arch`` (10) is there only when
    the code may use the FPU. Empty without the section."""
    out: dict[int, Union[int, str]] = {}
    for s in elf["sections"]:
        if s["type"] != SHT_ARM_ATTRIBUTES or s["size"] < 1:
            continue
        pos, end = s["offset"], s["offset"] + s["size"]
        if data[pos] != ord("A"):
            continue
        pos += 1
        while pos + 4 <= end:
            (length,) = struct.unpack_from("<I", data, pos)
            sub_end = min(pos + length, end)
            if length < 5:
                break
            vendor_end = data.find(b"\0", pos + 4, sub_end)
            if vendor_end < 0:
                break
            vendor = data[pos + 4:vendor_end]
            p = vendor_end + 1
            while vendor == b"aeabi" and p < sub_end:
                kind, q = _uleb(data, p, sub_end)
                if q + 4 > sub_end:
                    break
                (size,) = struct.unpack_from("<I", data, q)
                block_end = min(p + size, sub_end)
                q += 4
                while kind == 1 and q < block_end:   # Tag_File: the attributes of the whole file
                    tag, q = _uleb(data, q, block_end)
                    if tag in (4, 5, 67) or (tag > 32 and tag % 2):
                        stop = data.find(b"\0", q, block_end)
                        stop = block_end if stop < 0 else stop
                        out[tag] = data[q:stop].decode("ascii", errors="replace")
                        q = stop + 1
                    elif tag == 32:   # Tag_compatibility: a flag, then a vendor name
                        _flag, q = _uleb(data, q, block_end)
                        stop = data.find(b"\0", q, block_end)
                        q = (block_end if stop < 0 else stop) + 1
                    else:
                        out[tag], q = _uleb(data, q, block_end)
                if size < 5:
                    break
                p = block_end
            pos = sub_end
    return out


def app_address(elf: dict, data: bytes) -> Optional[int]:
    segments = elf_segments(elf, data)
    return segments[0]["address"] if segments else None


def linker_memory(ld_text: str) -> dict[str, dict[str, int]]:
    """The regions of a preprocessed linker script's ``MEMORY`` block:
    ``{name: {"origin", "length"}}``."""
    m = re.search(r"MEMORY\s*\{(.*?)\}", ld_text, re.S)
    if not m:
        return {}
    regions = {}
    for line in m.group(1).splitlines():
        r = re.match(r"\s*(\w+)\s*(?:\([^)]*\))?\s*:\s*ORIGIN\s*=\s*([^,]+),\s*LENGTH\s*=\s*(\S+)", line)
        if r:
            try:
                regions[r.group(1)] = {"origin": int(r.group(2).strip(), 0), "length": int(r.group(3).strip(), 0)}
            except ValueError:
                continue
    return regions


def image_memory(memory: dict[str, dict[str, int]], elf: dict,
                 regions: dict[str, dict[str, int]]) -> dict[str, dict[str, int]]:
    """The linker's memory table (``{region: {"used", "size"}}``) with each
    region's use taken from the image where that is more. The linker counts
    sections by their run address, so a section loaded from flash with
    ``AT (address)`` and run from RAM is not counted in flash: the RP2040 and
    RP2350 run all their code from RAM, which leaves their flash region with
    the boot code alone, and every build leaves out the initial values of
    ``.data``. The image's use of a region runs from its origin to the end of
    the last load segment whose load address is in it, as the linker counts
    its own. A region corrected so keeps the linker's figure as ``linker``.
    ``regions`` is :func:`linker_memory` of the script the link used."""
    segments = _content_segments(elf)
    out: dict[str, dict[str, int]] = {}
    for name, use in memory.items():
        out[name] = dict(use)
        region = regions.get(name)
        if not region:
            continue
        lo, hi = region["origin"], region["origin"] + region["length"]
        ends = [s["paddr"] + s["filesz"] for s in segments if lo <= s["paddr"] < hi]
        if ends and max(ends) - lo > use["used"]:
            out[name] = {**use, "used": max(ends) - lo, "linker": use["used"]}
    return out


def parse_ihex(text: str) -> list[dict]:
    """Intel HEX records 00, 01, 02, 04 and 05 into contiguous segments."""
    segments: list[dict] = []
    upper = 0
    for number, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line.startswith(":"):
            continue
        try:
            rec = bytes.fromhex(line[1:])
        except ValueError:
            rec = b""
        if len(rec) < 5 or len(rec) != 5 + rec[0]:
            raise InspectError(f"line {number}: malformed Intel HEX record {line!r}")
        if sum(rec) & 0xFF:
            raise InspectError(f"line {number}: Intel HEX checksum error in {line}")
        length, addr, kind = rec[0], (rec[1] << 8) | rec[2], rec[3]
        payload = rec[4:4 + length]
        if kind in (0x02, 0x04) and length < 2:
            raise InspectError(f"line {number}: malformed Intel HEX record {line!r}")
        if kind == 0x04:
            upper = ((payload[0] << 8) | payload[1]) << 16
        elif kind == 0x02:
            upper = ((payload[0] << 8) | payload[1]) << 4
        elif kind == 0x00:
            start = upper + addr
            if segments and segments[-1]["address"] + len(segments[-1]["data"]) == start:
                segments[-1]["data"] += payload
            else:
                segments.append({"address": start, "data": bytearray(payload)})
        elif kind == 0x01:
            break
    return [{"address": s["address"], "size": len(s["data"]), "data": bytes(s["data"])} for s in segments]


def inspect(path: Union[str, Path], ld_path: Optional[Path] = None) -> dict:
    """Everything ``webflash inspect`` shows for a firmware file."""
    path = Path(path)
    data = path.read_bytes()
    try:
        return _inspect(path, data, ld_path)
    except ValueError as e:
        raise InspectError(f"{path.name}: {e}") from e


def _inspect(path: Path, data: bytes, ld_path: Optional[Path]) -> dict:
    suffix = path.suffix.lower()
    info: dict = {"file": path.name, "size": len(data), "kind": suffix.lstrip(".") or "bin"}
    if data[:4] == b"\x7fELF":
        elf = parse_elf(data)
        info["kind"] = "elf"
        info["machine"] = elf["machine"]
        info["entry"] = elf["entry"]
        info["sizes"] = elf_sizes(elf)
        info["sections"] = [s for s in elf["sections"] if s["flags"] & SHF_ALLOC and s["size"]]
        info["segments"] = [{"address": s["address"], "size": s["size"]} for s in elf_segments(elf, data)]
        info["symbols"] = elf["symbols"]
        info["vector_table"] = vector_table(elf, data)
        info["app_address"] = app_address(elf, data)
        dict_path = path.with_name(path.stem + ".dict")
        if dict_path.is_file():
            try:
                d = json.loads(dict_path.read_text(encoding="utf-8"))
                info["dict"] = {k: d.get(k) for k in ("version", "build_versions", "app")}
                info["dict"]["mcu"] = (d.get("config") or {}).get("MCU")
            except (OSError, ValueError):
                pass
        ld = ld_path
        if ld is None:
            candidates = sorted(path.parent.glob("src/*/*.ld")) if (path.parent / "src").is_dir() else []
            ld = candidates[0] if candidates else None
        if ld is not None and Path(ld).is_file():
            info["memory"] = linker_memory(Path(ld).read_text(encoding="utf-8", errors="replace"))
        return info
    if suffix == ".uf2" or data[:4] == struct.pack("<I", 0x0A324655):
        blocks = uf2_blocks(data)
        info["kind"] = "uf2"
        segments: list[dict] = []
        for b in blocks:
            if segments and segments[-1]["address"] + segments[-1]["size"] == b["address"]:
                segments[-1]["size"] += b["size"]
            else:
                segments.append({"address": b["address"], "size": b["size"]})
        info["blocks"] = len(blocks)
        info["family"] = blocks[0]["family"] if blocks else None
        info["segments"] = segments
        return info
    if suffix in (".hex", ".ihex") or data[:1] == b":":
        info["kind"] = "hex"
        info["segments"] = [{"address": s["address"], "size": s["size"]} for s in parse_ihex(data.decode("ascii", errors="replace"))]
        return info
    info["kind"] = "bin"
    info["segments"] = [{"address": None, "size": len(data)}]
    if len(data) >= 8:
        sp, reset = struct.unpack_from("<II", data, 0)
        info["vector_table"] = {"address": None, "stack": sp, "reset": reset}
    return info


def format_report(info: dict) -> str:
    """The human-readable report of :func:`inspect`."""
    lines = [f"{info['file']}: {info['kind']}, {info['size']:,} bytes"]
    if info["kind"] == "elf":
        sizes = info["sizes"]
        lines.append(f"  text {sizes['text']:,}  data {sizes['data']:,}  bss {sizes['bss']:,}  "
                     f"flash image {sizes['flash']:,} bytes")
        if info.get("app_address") is not None:
            lines.append(f"  application address 0x{info['app_address']:08x}, entry 0x{info['entry']:08x}")
        vt = info.get("vector_table")
        if vt:
            lines.append(f"  vector table at 0x{vt['address']:08x}: stack 0x{vt['stack']:08x}, reset 0x{vt['reset']:08x}")
        for region, r in (info.get("memory") or {}).items():
            lines.append(f"  {region}: origin 0x{r['origin']:08x}, length {r['length']:,}")
        lines.append("  segments:")
        for s in info["segments"]:
            lines.append(f"    0x{s['address']:08x}  {s['size']:>8,} bytes")
        lines.append("  sections:")
        for s in info["sections"]:
            lines.append(f"    {s['name']:<20} 0x{s['addr']:08x}  {s['size']:>8,} bytes")
        if info.get("dict"):
            d = info["dict"]
            lines.append(f"  dict: {d.get('app')} {d.get('version')}, mcu {d.get('mcu')}, {d.get('build_versions')}")
        return "\n".join(lines)
    if info["kind"] == "uf2":
        family = f"0x{info['family']:08x}" if info.get("family") is not None else "none"
        lines.append(f"  {info['blocks']} blocks, family {family}")
    for s in info.get("segments", []):
        addr = f"0x{s['address']:08x}" if s["address"] is not None else "(address from the configuration)"
        lines.append(f"    {addr}  {s['size']:>8,} bytes")
    vt = info.get("vector_table")
    if vt and info["kind"] == "bin":
        lines.append(f"  first words: stack 0x{vt['stack']:08x}, reset 0x{vt['reset']:08x}")
    return "\n".join(lines)
