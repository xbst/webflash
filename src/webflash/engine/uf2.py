"""``elf2uf2`` in Python: a port of Klipper's ``lib/elf2uf2/main.cpp`` (the
pico-sdk tool, BSD-3-Clause), so that the browser never has to build the C++
tool. It writes exactly the bytes the C++ tool writes: the LOAD segments of a
32-bit little-endian ARM ELF cut into 256-byte pages, each page one 512-byte
UF2 block with the RP2040 family id, which is what Klipper's copy of the tool
writes for every RP2 chip.
"""
from __future__ import annotations

import struct
from pathlib import Path
from typing import Union

PAGE_SIZE = 256
UF2_MAGIC_START0 = 0x0A324655
UF2_MAGIC_START1 = 0x9E5D5157
UF2_MAGIC_END = 0x0AB16F30
UF2_FLAG_FAMILY_ID_PRESENT = 0x00002000
RP2040_FAMILY_ID = 0xE48BFF56
RP2350_ARM_S_FAMILY_ID = 0xE48BFF59

MAIN_RAM_START = 0x20000000
MAIN_RAM_END = 0x20042000
FLASH_START = 0x10000000
FLASH_END = 0x15000000
XIP_SRAM_START = 0x15000000
XIP_SRAM_END = 0x15004000
MAIN_RAM_BANKED_START = 0x21000000
MAIN_RAM_BANKED_END = 0x21040000

CONTENTS, NO_CONTENTS, IGNORE = 0, 1, 2

_RANGES_FLASH = [
    (FLASH_START, FLASH_END, CONTENTS),
    (MAIN_RAM_START, MAIN_RAM_END, NO_CONTENTS),
    (MAIN_RAM_BANKED_START, MAIN_RAM_BANKED_END, NO_CONTENTS),
]
_RANGES_RAM = [
    (MAIN_RAM_START, MAIN_RAM_END, CONTENTS),
    (XIP_SRAM_START, XIP_SRAM_END, CONTENTS),
    (0x00000000, 0x00004000, IGNORE),
]

EM_ARM = 0x28
PT_LOAD = 1
EF_ARM_ABI_FLOAT_HARD = 0x400


class Uf2Error(ValueError):
    """What the C++ tool prints after ``ERROR:``."""


def _check_range(ranges, addr: int, size: int, uninitialized: bool):
    for start, end, kind in ranges:
        if start <= addr and end >= addr + size:
            if kind == NO_CONTENTS and not uninitialized:
                raise Uf2Error("ELF contains memory contents for uninitialized memory")
            return kind
    raise Uf2Error("Memory segment %08x->%08x is outside of valid address range for device" % (addr, addr + size))


def _in_ranges(ranges, addr: int, want_contents: bool) -> bool:
    for start, end, kind in ranges:
        if start <= addr < end:
            return kind == CONTENTS if want_contents else True
    return False


def elf_pages(data: bytes) -> tuple[dict[int, list[tuple[int, int, int]]], bool]:
    """The 256-byte pages of an ELF's LOAD segments: ``{page address:
    [(file offset, page offset, length)]}``, and whether it is a RAM binary."""
    if len(data) < 52:
        raise Uf2Error("Unable to read ELF header")
    if data[:4] != b"\x7fELF":
        raise Uf2Error("Not an ELF file")
    (ei_class, ei_data, ei_version, ei_abi) = data[4], data[5], data[6], data[7]
    (e_type, e_machine, e_version, e_entry, e_phoff, e_shoff, e_flags, e_ehsize,
     e_phentsize, e_phnum) = struct.unpack_from("<HHIIIIIHHH", data, 16)
    if ei_version != 1 or e_version != 1:
        raise Uf2Error("Unrecognized ELF version")
    if ei_class != 1 or ei_data != 1:
        raise Uf2Error("Require 32 bit little-endian ELF")
    if e_ehsize != 52:
        raise Uf2Error("Invalid ELF32 format")
    if e_machine != EM_ARM:
        raise Uf2Error("Not an ARM executable")
    if ei_abi != 0:
        raise Uf2Error("Unrecognized ABI")
    if e_flags & EF_ARM_ABI_FLOAT_HARD:
        raise Uf2Error("HARD-FLOAT not supported")
    ram_style = _in_ranges(_RANGES_RAM, e_entry, True)
    ranges = _RANGES_RAM if ram_style else _RANGES_FLASH
    if e_phentsize != 32:
        raise Uf2Error("Invalid ELF32 program header")
    pages: dict[int, list[tuple[int, int, int]]] = {}
    for n in range(e_phnum):
        off = e_phoff + n * 32
        if off + 32 > len(data):
            raise Uf2Error("Failed to read input file")
        p_type, p_offset, p_vaddr, p_paddr, p_filesz, p_memsz, _p_flags, _p_align = struct.unpack_from("<IIIIIIII", data, off)
        if p_type != PT_LOAD or not p_memsz:
            continue
        mapped = min(p_filesz, p_memsz)
        if mapped:
            kind = _check_range(ranges, p_paddr, mapped, False)
            if kind == CONTENTS:
                addr = p_paddr
                remaining = mapped
                file_offset = p_offset
                while remaining:
                    page_off = addr & (PAGE_SIZE - 1)
                    length = min(remaining, PAGE_SIZE - page_off)
                    pages.setdefault(addr - page_off, []).append((file_offset, page_off, length))
                    addr += length
                    file_offset += length
                    remaining -= length
        if p_memsz > p_filesz:
            _check_range(ranges, p_paddr + p_filesz, p_memsz - p_filesz, True)
    return pages, ram_style


def elf_to_uf2(data: bytes, family_id: int = RP2040_FAMILY_ID) -> bytes:
    """The UF2 image of an ELF, byte for byte what the C++ tool writes."""
    pages, ram_style = elf_pages(data)
    if not pages:
        raise Uf2Error("The input file has no memory pages")
    if ram_style:
        e_entry = struct.unpack_from("<I", data, 24)[0]
        expected_main = expected_xip = 0xFFFFFFFF
        for page in pages:
            if MAIN_RAM_START <= page < MAIN_RAM_END and page < expected_main:
                expected_main = page | 1
            elif XIP_SRAM_START <= page < XIP_SRAM_END and page < expected_xip:
                expected_xip = page | 1
        expected = expected_main if expected_main != 0xFFFFFFFF else expected_xip
        if e_entry == expected_xip:
            raise Uf2Error("B0/B1 Boot ROM does not support direct entry into XIP_SRAM\n")
        if e_entry != expected:
            raise Uf2Error("A RAM binary should have an entry point at the beginning: %08x (not %08x)\n"
                           % (expected, e_entry))
    out = bytearray()
    num_blocks = len(pages)
    for block_no, page in enumerate(sorted(pages)):
        payload = bytearray(PAGE_SIZE)
        for file_offset, page_off, length in pages[page]:
            chunk = data[file_offset:file_offset + length]
            if len(chunk) != length:
                raise Uf2Error("Failed to read input file")
            payload[page_off:page_off + length] = chunk
        out += struct.pack("<IIIIIIII", UF2_MAGIC_START0, UF2_MAGIC_START1, UF2_FLAG_FAMILY_ID_PRESENT,
                           page, PAGE_SIZE, block_no, num_blocks, family_id)
        out += payload
        out += bytes(476 - PAGE_SIZE)
        out += struct.pack("<I", UF2_MAGIC_END)
    return bytes(out)


def elf2uf2(elf_path: Union[str, Path], uf2_path: Union[str, Path]) -> None:
    """``elf2uf2 in.elf out.uf2``: the recipe command, with the tool's own
    behavior of leaving no output behind on an error."""
    elf_path, uf2_path = Path(elf_path), Path(uf2_path)
    try:
        data = elf_path.read_bytes()
    except OSError as e:
        raise Uf2Error(f"Can't open input file '{elf_path}': {e}") from None
    try:
        image = elf_to_uf2(data)
    except Uf2Error:
        if uf2_path.exists():
            uf2_path.unlink()
        raise
    uf2_path.parent.mkdir(parents=True, exist_ok=True)
    uf2_path.write_bytes(image)


def uf2_blocks(data: bytes) -> list[dict]:
    """The blocks of a UF2 file: ``{"address", "size", "block", "blocks", "family"}``."""
    blocks = []
    for off in range(0, len(data) - 511, 512):
        m0, m1, flags, addr, size, block, blocks_total, family = struct.unpack_from("<IIIIIIII", data, off)
        end = struct.unpack_from("<I", data, off + 508)[0]
        if m0 != UF2_MAGIC_START0 or m1 != UF2_MAGIC_START1 or end != UF2_MAGIC_END:
            continue
        if size > 476:
            raise Uf2Error(f"UF2 block {off // 512} claims {size} bytes (at most 476)")
        blocks.append({"address": addr, "size": size, "block": block, "blocks": blocks_total,
                       "family": family if flags & UF2_FLAG_FAMILY_ID_PRESENT else None,
                       "data": data[off + 32:off + 32 + size]})
    return blocks
