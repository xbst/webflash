"""Which flashing methods a configuration can use (SPEC 11.2), from the
resolved ``.config`` values: best method first, ``download`` always last,
each with the reason the site shows (the shape of ``devices.js``'s
``inferMethods`` on the JavaScript side).
"""
from __future__ import annotations

import re
from typing import Mapping

METHODS = ("dfu", "picoboot", "uf2", "katapult", "katapult-can", "download")

# The chips whose ROM has a USB DFU bootloader, as the projects' Kconfig lists
# them for STM32_DFU_ROM_ADDRESS. That symbol is 0 for a CAN or serial build
# ("default 0 if !USB", about Klipper restarting itself into the ROM), while
# the board may still have a USB port the ROM answers on.
_DFU_ROM_CHIP = re.compile(r"MACH_STM32(F042|F072|F4\w*|F7\w*|G0\w*|G4\w*|L4\w*|H7\w*)|MACH_AT32F403")


def _flag(values: Mapping[str, str], name: str) -> bool:
    return values.get(name, "n") == "y"


def _number(values: Mapping[str, str], name: str) -> int:
    raw = values.get(name, "0") or "0"
    try:
        return int(raw, 0)
    except ValueError:
        return 0


def _dfu_method(values: Mapping[str, str]) -> dict | None:
    """DFU when the chip's ROM has it, whatever interface the firmware uses."""
    rom = _number(values, "STM32_DFU_ROM_ADDRESS")
    if rom:
        return {"id": "dfu", "reason": f"the STM32's ROM has a USB DFU bootloader at 0x{rom:08x}"}
    usb = _flag(values, "HAVE_STM32_USBFS") or _flag(values, "HAVE_STM32_USBOTG")
    if usb and any(_DFU_ROM_CHIP.fullmatch(name) and value == "y" for name, value in values.items()):
        return {"id": "dfu", "reason": "the STM32's ROM has a USB DFU bootloader, reached over the board's USB port if it has one"}
    return None


def _katapult_methods(values: Mapping[str, str], why: str) -> list[dict]:
    """Katapult over the configured interface: USB or serial give the Web
    Serial method, CAN the gs_usb one, and a USB-to-CAN bridge runs Katapult
    over USB itself."""
    if _flag(values, "CANSERIAL"):
        return [{"id": "katapult-can", "reason": f"{why}; the interface is CAN, so Katapult answers over the bus"}]
    if _flag(values, "USBCANBUS"):
        return [{"id": "katapult", "reason": f"{why}; the bridge itself runs Katapult over USB"}]
    if _flag(values, "USBSERIAL"):
        return [{"id": "katapult", "reason": f"{why}; the interface is USB"}]
    if _flag(values, "SERIAL"):
        return [{"id": "katapult", "reason": f"{why}; the interface is a serial port"}]
    return []


def infer_methods(values: Mapping[str, str], project: str = "klipper") -> list[dict]:
    """The methods for a configuration, in order: ``[{"id", "reason"}]``.
    ``values`` maps symbol names (without ``CONFIG_``) to their string values
    (``y``/``n``, numbers, text), as :meth:`kconfig.Session.values` returns."""
    methods: list[dict] = []
    app = _number(values, "FLASH_APPLICATION_ADDRESS")
    boot = _number(values, "FLASH_BOOT_ADDRESS")
    offset = f"the application starts at 0x{app:08x}, after a bootloader"
    if project == "katapult":
        # The bootloader itself is written by the chip's own ROM method.
        dfu = _dfu_method(values) if _flag(values, "MACH_STM32") else None
        if dfu:
            methods.append(dfu)
        elif _flag(values, "MACH_RPXXXX"):
            methods.append({"id": "picoboot", "reason": "the RP2 ROM's PICOBOOT over USB (BOOTSEL)"})
            methods.append({"id": "uf2", "reason": "a UF2 written to the BOOTSEL drive"})
    elif _flag(values, "MACH_STM32"):
        if app != boot:
            methods += _katapult_methods(values, offset)
        dfu = _dfu_method(values)
        if dfu:
            methods.append(dfu)
    elif _flag(values, "MACH_RPXXXX"):
        if _flag(values, "RPXXXX_FLASH_START_4000"):
            methods += _katapult_methods(values, offset)
        methods.append({"id": "picoboot", "reason": "the RP2 ROM's PICOBOOT over USB (BOOTSEL)"})
        methods.append({"id": "uf2", "reason": "a UF2 written to the BOOTSEL drive"})
    elif _flag(values, "MACH_LPC176X"):
        methods.append({"id": "download", "reason": "LPC176x boards usually flash from an SD card"})
        if _flag(values, "LPC_FLASH_START_4000"):
            methods += _katapult_methods(values, offset)
    methods.append({"id": "download", "reason": "the firmware files, to flash with another tool"})
    out: list[dict] = []
    seen: set[str] = set()
    for m in methods:
        if m["id"] not in seen:
            seen.add(m["id"])
            out.append(m)
    return out


def method_ids(values: Mapping[str, str], project: str = "klipper") -> list[str]:
    """The method ids alone, in order."""
    return [m["id"] for m in infer_methods(values, project)]
