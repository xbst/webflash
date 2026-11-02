"""Which flashing methods a configuration can use (SPEC 11.2), from the
resolved ``.config`` values: best method first, ``download`` always last.
"""
from __future__ import annotations

from typing import Mapping

METHODS = ("dfu", "picoboot", "uf2", "katapult", "katapult-can", "download")


def _flag(values: Mapping[str, str], name: str) -> bool:
    return values.get(name, "n") == "y"


def _number(values: Mapping[str, str], name: str) -> int:
    raw = values.get(name, "0") or "0"
    try:
        return int(raw, 0)
    except ValueError:
        return 0


def _katapult_methods(values: Mapping[str, str]) -> list[str]:
    """Katapult over the configured interface: USB or serial give the Web
    Serial method, CAN the gs_usb one, and a USB-to-CAN bridge runs Katapult
    over USB itself."""
    if _flag(values, "CANSERIAL"):
        return ["katapult-can"]
    if _flag(values, "USBSERIAL") or _flag(values, "SERIAL") or _flag(values, "USBCANBUS"):
        return ["katapult"]
    return []


def infer_methods(values: Mapping[str, str], project: str = "klipper") -> list[str]:
    """The methods for a configuration, in order. ``values`` maps symbol names
    (without ``CONFIG_``) to their string values (``y``/``n``, numbers, text),
    as :meth:`kconfig.Session.values` returns them."""
    methods: list[str] = []
    bootloader_offset = _number(values, "FLASH_APPLICATION_ADDRESS") != _number(values, "FLASH_BOOT_ADDRESS")
    if project == "katapult":
        # The bootloader itself is written by the chip's own ROM method.
        if _flag(values, "MACH_STM32") and _number(values, "STM32_DFU_ROM_ADDRESS"):
            methods.append("dfu")
        elif _flag(values, "MACH_RPXXXX"):
            methods += ["picoboot", "uf2"]
    elif _flag(values, "MACH_STM32"):
        if bootloader_offset:
            methods += _katapult_methods(values)
        if _number(values, "STM32_DFU_ROM_ADDRESS"):
            methods.append("dfu")
    elif _flag(values, "MACH_RPXXXX"):
        if _flag(values, "RPXXXX_FLASH_START_4000"):
            methods += _katapult_methods(values)
        methods += ["picoboot", "uf2"]
    elif _flag(values, "MACH_LPC176X"):
        methods.append("download")
        if _flag(values, "LPC_FLASH_START_4000"):
            methods += _katapult_methods(values)
    methods.append("download")
    out: list[str] = []
    for m in methods:
        if m not in out:
            out.append(m)
    return out
