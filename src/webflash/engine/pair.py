"""Pairing a firmware's Kconfig (Klipper or Kalico) with Katapult's.

The site configures Katapult beside the firmware it boots, each in its own
:class:`~webflash.engine.kconfig.Session`. The options both projects define
alike (the chip, its clock, the communication interface, the CAN bus, the USB
ids) are set once and copied into both, and the firmware's bootloader offset
follows Katapult's application offset.

What counts as shared comes from the two trees, not from a list: a symbol both
define with the same type and a prompt in both, or a choice both define with
common member symbols, minus :data:`DENY_SYMBOLS` and the bootloader choices
(same names, other meanings). After a load, one side's values win:
:meth:`Pair.sync` copies them into the other wherever the two differ, the
firmware's by default (a version loaded) and the loaded slot's for a
``.config`` loaded into it.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional

from .kconfig import KconfigError, Session

# Same name in both trees, different meaning: never copied.
#   LOW_LEVEL_OPTIONS  the user's switch in the firmware, always on (and hidden) in Katapult
#   INITIAL_PINS       pins set at startup in the firmware, on bootloader entry in Katapult
#   USB_DEVICE_ID      0x614e for Klipper, 0x6177 for Katapult
#   FLASH_APPLICATION_ADDRESS  where the firmware starts, where Katapult's deployer puts Katapult
DENY_SYMBOLS = ("LOW_LEVEL_OPTIONS", "INITIAL_PINS", "USB_DEVICE_ID", "FLASH_APPLICATION_ADDRESS")

# The members of the firmware's "Bootloader offset" choices, which are
# Katapult's "Build Katapult deployment application" choices by name.
_OFFSET_MEMBER = re.compile(r"^(STM32|RPXXXX|RP2040|LPC)_FLASH_START_([0-9A-F]+)$")

TITLES = {"klipper": "Klipper", "kalico": "Kalico", "katapult": "Katapult"}

SLOTS = ("fw", "katapult")


def title(project: str) -> str:
    return TITLES.get(project, project.capitalize())


def _size(offset: int) -> str:
    """An offset as Klipper's prompts name it: 8KiB, or hex when not whole KiB."""
    return f"{offset // 1024}KiB" if offset % 1024 == 0 else hex(offset)


@dataclass
class Shared:
    """One option both trees define alike: a symbol (by name) or a choice
    (by its common members)."""
    kind: str               # "symbol" or "choice"
    name: str               # the symbol's name, or the firmware choice's prompt
    fw: object              # the kconfiglib Symbol or Choice, in each tree
    katapult: object
    members: tuple = ()     # a choice's member symbols both trees define

    def item(self, slot: str):
        return self.fw if slot == "fw" else self.katapult


def _prompted(item) -> bool:
    return any(node.prompt for node in item.nodes)


def _prompt_node(item):
    return next((n for n in item.nodes if n.prompt), item.nodes[0] if item.nodes else None)


def _fallback(member: str) -> Optional[str]:
    """The member to select when the other tree does not offer one: a USB to
    CAN bus bridge runs Katapult as plain USB on the same pins (Katapult's
    ``HAVE_STM32_USBCANBUS`` is never set), so ``STM32_USBCANBUS_PA11_PA12``
    falls back to ``STM32_USB_PA11_PA12`` and ``RPXXXX_USBCANBUS`` to
    ``RPXXXX_USB``."""
    alias = re.sub(r"_USBCANBUS(_|$)", r"_USB\1", member)
    return alias if alias != member else None


def _canon(name: str) -> str:
    """A symbol's name as the current trees spell it. Klipper v0.12.0 and
    older, and Katapult before its RP2350 support, call the RP2040 layout
    ``MACH_RP2040`` and ``RP2040_*``; since then it is ``MACH_RPXXXX`` and
    ``RPXXXX_*``, with ``MACH_RP2040`` the processor model under it. The
    trees are matched through this spelling, so either pairs with either."""
    if name == "MACH_RP2040":
        return "MACH_RPXXXX"
    return "RPXXXX_" + name[len("RP2040_"):] if name.startswith("RP2040_") else name


def _same(a: Optional[str], b: Optional[str]) -> bool:
    """Whether two choice members stand for each other: the same name in
    either spelling, or one the other falls back to (see _fallback)."""
    if a is None or b is None:
        return a is b
    ca, cb = _canon(a), _canon(b)
    fa, fb = _fallback(a), _fallback(b)
    return ca == cb or (fa is not None and _canon(fa) == cb) or (fb is not None and _canon(fb) == ca)


def _is_offset_choice(choice) -> bool:
    return bool(choice.syms) and all(_OFFSET_MEMBER.match(sym.name) for sym in choice.syms)


def shared_options(fw: Session, katapult: Session) -> list[Shared]:
    """The options both trees define alike, in the firmware's menu order."""
    lib_f, lib_k = fw.kconfiglib, katapult.kconfiglib
    out: list[tuple[int, Shared]] = []
    order = {id(node): i for i, node in enumerate(fw._nodes)}

    def position(item) -> int:
        node = _prompt_node(item)
        return order.get(id(node), len(order)) if node is not None else len(order)

    k_syms = katapult.kconf.syms
    k_canon = {_canon(sym.name): sym for sym in katapult.kconf.unique_defined_syms if sym.choice is None}
    for sym in fw.kconf.unique_defined_syms:
        if sym.choice is not None or sym.name in DENY_SYMBOLS or not _prompted(sym):
            continue
        other = k_syms.get(sym.name) or k_canon.get(_canon(sym.name))
        if other is None or not other.nodes or other.choice is not None or not _prompted(other):
            continue
        if lib_f.TYPE_TO_STR[sym.orig_type] != lib_k.TYPE_TO_STR[other.orig_type]:
            continue
        out.append((position(sym), Shared("symbol", sym.name, sym, other)))

    k_choices = [c for c in katapult.kconf.unique_choices if _prompted(c) and not _is_offset_choice(c)]
    for choice in fw.kconf.unique_choices:
        if not _prompted(choice) or _is_offset_choice(choice):
            continue
        names = {_canon(s.name) for s in choice.syms}
        best, common = None, set()
        for other in k_choices:
            both = names & {_canon(s.name) for s in other.syms}
            if len(both) > len(common):
                best, common = other, both
        if best is None:
            continue
        prompt = _prompt_node(choice).prompt[0]
        members = tuple(s.name for s in choice.syms if _canon(s.name) in common)
        out.append((position(choice), Shared("choice", prompt, choice, best, members)))
    out.sort(key=lambda pair: pair[0])
    return [entry for _, entry in out]


def _active(item, lib) -> bool:
    """Whether an option is part of the configuration: its dependencies are
    met (a choice has a selection)."""
    if isinstance(item, lib.Choice):
        return item.selection is not None
    return lib.expr_value(item.direct_dep) > 0


class Pair:
    """A firmware's session and Katapult's, kept in step."""

    def __init__(self, fw: Session, katapult: Session) -> None:
        self.fw = fw
        self.katapult = katapult
        self.shared = shared_options(fw, katapult)
        self._entries = {}
        for entry in self.shared:
            self._entries[("fw", id(entry.fw))] = entry
            self._entries[("katapult", id(entry.katapult))] = entry
        self._offset_choices = [c for c in fw.kconf.unique_choices if _is_offset_choice(c)]

    def session(self, slot: str) -> Session:
        return self.fw if slot == "fw" else self.katapult

    @staticmethod
    def other(slot: str) -> str:
        return "katapult" if slot == "fw" else "fw"

    def title(self, slot: str) -> str:
        return title(self.session(slot).project)

    # ── What the shared options are ───────────────────────────────────

    def shared_json(self) -> list[dict]:
        """``pair_shared()``: one entry per shared option, firmware menu order."""
        out = []
        for e in self.shared:
            lib = self.fw.kconfiglib
            fw_node, k_node = _prompt_node(e.fw), _prompt_node(e.katapult)
            out.append({
                "kind": e.kind, "name": e.name if e.kind == "symbol" else (e.fw.name or ""),
                "prompt": fw_node.prompt[0] if fw_node is not None and fw_node.prompt else e.name,
                "type": lib.TYPE_TO_STR[e.fw.type] if e.fw.type else None,
                "fw": self.fw.node_id(fw_node), "katapult": self.katapult.node_id(k_node),
                "members": list(e.members),
            })
        return out

    # ── Which option a set touches ────────────────────────────────────

    def _target(self, slot: str, name: str, value: str):
        """(choice, member) for a set that selects a choice member, (symbol,
        None) for a symbol, (None, None) for anything else."""
        session = self.session(slot)
        lib = session.kconfiglib
        item = session.item(name)
        if item is None:
            return None, None
        if isinstance(item, lib.Choice):
            return item, value
        if item.choice is not None:
            return (item.choice, item.name) if value == "y" else (None, None)
        return item, None

    def is_locked(self, slot: str, name: str, value: str) -> bool:
        """Whether a set would change the firmware's bootloader offset, which
        follows Katapult's application offset."""
        if slot != "fw":
            return False
        item, _ = self._target(slot, name, value)
        return item is not None and any(item is c for c in self._offset_choices)

    # ── Keeping the two in step ───────────────────────────────────────

    def _member_prompt(self, slot: str, member: str) -> str:
        sym = self.session(slot).kconf.syms.get(member)
        node = _prompt_node(sym) if sym is not None and sym.nodes else None
        return node.prompt[0] if node is not None and node.prompt else member

    def _select(self, slot: str, entry: Shared, member: str, source: str) -> Optional[str]:
        """Select a member of the shared choice in slot; a note when that tree
        lacks it or does not offer it here."""
        session = self.session(slot)
        lib = session.kconfiglib
        choice = entry.item(slot)
        # The tree's own name for a member, in either spelling.
        names = {s.name: s.name for s in choice.syms}
        names.update({_canon(s.name): s.name for s in choice.syms if _canon(s.name) not in names})

        def take(name: str) -> bool:
            if choice.selection is None or choice.selection.name != name:
                session.assign(name, "y")
            return not _active(choice, lib) or (choice.selection is not None and choice.selection.name == name)

        own = names.get(member) or names.get(_canon(member))
        if own is not None and take(own):
            return None
        alias = _fallback(member)
        alias = (names.get(alias) or names.get(_canon(alias))) if alias else None
        if alias is not None and take(alias):
            return None
        if own is None:
            return f"{self.title(slot)} has no {self._member_prompt(source, member)}."
        return f"{self.title(slot)} does not offer {self._member_prompt(source, member)} for this chip."

    def _copy(self, slot: str, entry: Shared, value: str) -> Optional[str]:
        session = self.session(slot)
        try:
            session.assign(entry.item(slot).name, value)
        except KconfigError:
            return f"{self.title(slot)} does not take {entry.name}={value}."
        return None

    def shared_values(self, slot: str) -> dict:
        """What each shared option the slot shows now holds, by the option's
        name: a choice's selected member, a symbol's value. One the slot's
        configuration hides (a CAN bitrate under USB) is not listed."""
        lib = self.session(slot).kconfiglib
        out = {}
        for e in self.shared:
            item = e.item(slot)
            if e.kind == "choice":
                if _active(item, lib):
                    out[e.name] = item.selection.name
            elif item.visibility > 0:
                out[e.name] = item.str_value
        return out

    def mirror(self, slot: str, name: str, value: str) -> list[str]:
        """Copy a set made in slot into the other tree, when it set a shared
        option. Returns the notes for what the other tree refused."""
        item, member = self._target(slot, name, value)
        if item is None:
            return []
        entry = self._entries.get((slot, id(item)))
        if entry is None:
            return []
        other = self.other(slot)
        note = self._select(other, entry, member, slot) if entry.kind == "choice" \
            else self._copy(other, entry, value)
        return [note] if note else []

    def sync(self, source: str = "fw") -> list[str]:
        """Copy one slot's value of every shared option (the firmware's by
        default) into the other where the two differ and both use it. A few
        passes, since a choice made (the processor) shows or hides the
        options after it. A member the other tree stands in for (a USB to
        CAN bridge's Katapult runs as plain USB, see :func:`_fallback`) is
        left as it is, whichever side it is on."""
        target = self.other(source)
        lib_s, lib_t = self.session(source).kconfiglib, self.session(target).kconfiglib
        notes: list[str] = []
        for _ in range(4):
            changed = False
            for e in self.shared:
                src, dst = e.item(source), e.item(target)
                if not (_active(src, lib_s) and _active(dst, lib_t)):
                    continue
                if e.kind == "choice":
                    want = src.selection.name
                    if _same(dst.selection.name, want):
                        continue
                    note = self._select(target, e, want, source)
                    if dst.selection is not None and _same(dst.selection.name, want):
                        changed = True
                else:
                    want = src.str_value
                    if dst.str_value == want:
                        continue
                    note = self._copy(target, e, want)
                    changed = changed or dst.str_value == want
                if note and note not in notes:
                    notes.append(note)
            if not changed:
                break
        return notes

    def link(self) -> dict:
        """The offset link: select the firmware's bootloader offset that
        Katapult's application offset names (STM32 ``STM32_APP_START_X`` sets
        ``STM32_FLASH_START_X``; RP2040/RP2350 and LPC176x start the
        application at a fixed 16 KiB). Returns ``{"offset", "address",
        "choice" (the firmware choice's node id), "member", "prompt",
        "error", "changed"}``; ``error`` says when the firmware offers no such
        offset for the chip, and the firmware's offset is then left alone."""
        kat, fw = self.katapult, self.fw
        lib = fw.kconfiglib
        info = {"offset": None, "address": None, "choice": None, "member": None, "prompt": "",
                "error": None, "changed": False}
        try:
            start = int(kat.value("FLASH_START") or "", 16)
            launch = int(kat.value("LAUNCH_APP_ADDRESS") or "", 16)
        except ValueError:
            info["error"] = "Katapult names no application address for this chip."
            return info
        offset = launch - start
        info["offset"], info["address"] = offset, hex(launch)
        choice = next((c for c in self._offset_choices if c.selection is not None), None)
        if choice is None:
            info["error"] = f"{self.title('fw')} has no bootloader offset for this chip."
            return info
        info["choice"] = fw.node_id(_prompt_node(choice))
        target = next((s for s in choice.syms if int(_OFFSET_MEMBER.match(s.name).group(2), 16) == offset), None)
        if target is None or target.visibility == 0:
            info["error"] = (f"{self.title('fw')} has no {_size(offset)} bootloader for this chip. "
                             "Pick another application offset in Katapult.")
            return info
        if choice.selection is not target:
            fw.assign(target.name, "y")
            info["changed"] = True
        info["member"], info["prompt"] = target.name, self._member_prompt("fw", target.name)
        if not _active(choice, lib) or choice.selection is not target:
            info["error"] = f"{self.title('fw')} did not take the {_size(offset)} bootloader offset."
        return info

    # ── The combined tree ─────────────────────────────────────────────

    def tree(self, link: Optional[dict] = None) -> dict:
        """``pair_tree()``: both trees in one, the shared options first.

        ``{"root": [group node ids], "groups": [{"id", "title", "root"}],
        "nodes", "title", "titles", "offset"}``: three groups, "shared" (the
        firmware's nodes for the shared options, with ``LOW_LEVEL_OPTIONS``,
        which gates options both show), "fw" and "katapult" (the rest of each
        tree, in menuconfig order). Each group is also a menu node
        (``group:<id>``) listed in ``root``, so the tree reads like any other.
        The firmware's bootloader offset choice is marked ``locked:
        "katapult"`` while the link holds."""
        fw_tree, k_tree = self.fw.tree_json(), self.katapult.tree_json()
        nodes = {**fw_tree["nodes"], **k_tree["nodes"]}

        def ids_of(session, items) -> set:
            return {session.node_id(n) for item in items for n in item.nodes}

        def shown(session, item) -> bool:
            node = _prompt_node(item)
            entry = nodes.get(session.node_id(node)) if node is not None else None
            return bool(entry and entry["visible"])

        # A shared option the firmware hides but Katapult shows stays in
        # Katapult's group: an RP2040 Klipper behind Katapult has no stage-2
        # bootloader, so only Katapult's "Flash chip" counts.
        layout = [e for e in self.shared if shown(self.fw, e.fw) or not shown(self.katapult, e.katapult)]
        fw_items = [e.fw for e in layout]
        k_items = [e.katapult for e in layout]
        low = self.fw.kconf.syms.get("LOW_LEVEL_OPTIONS")
        shared_fw_nodes = []
        if low is not None and _prompted(low):
            shared_fw_nodes.append(_prompt_node(low))
            fw_items.append(low)
        k_low = self.katapult.kconf.syms.get("LOW_LEVEL_OPTIONS")
        if k_low is not None:
            k_items.append(k_low)
        shared_fw_nodes += [_prompt_node(e.fw) for e in layout]
        removed = ids_of(self.fw, fw_items) | ids_of(self.katapult, k_items)

        # A removed node keeps its own children; every other node loses the
        # removed ones (they show in the shared group instead).
        for node_id, node in list(nodes.items()):
            if node_id not in removed and any(c in removed for c in node["children"]):
                nodes[node_id] = {**node, "children": [c for c in node["children"] if c not in removed]}

        def nested(node) -> bool:
            parent = node.parent
            while parent is not None and parent is not self.fw.kconf.top_node:
                if self.fw.node_id(parent) in removed:
                    return True
                parent = parent.parent
            return False

        order = {id(n): i for i, n in enumerate(self.fw._nodes)}
        shared_root = [self.fw.node_id(n) for n in sorted(shared_fw_nodes, key=lambda n: order[id(n)])
                       if not nested(n)]
        groups = [
            {"id": "shared", "title": "Board · used by both", "root": shared_root},
            {"id": "fw", "title": f"{self.title('fw')} only", "root": [i for i in fw_tree["root"] if i not in removed]},
            {"id": "katapult", "title": "Katapult only", "root": [i for i in k_tree["root"] if i not in removed]},
        ]
        for group in groups:
            nodes[f"group:{group['id']}"] = {
                "id": f"group:{group['id']}", "kind": "menu", "name": "", "prompt": group["title"],
                "type": None, "value": None, "user_value": None, "visible": True, "menuconfig": False,
                "editable": False, "range": None, "help": "", "children": list(group["root"]),
                "members": [], "depends": "y", "group": group["id"],
            }
        link = link if link is not None else self.link()
        if link.get("choice") and link["choice"] in nodes:
            nodes[link["choice"]] = {**nodes[link["choice"]], "locked": "katapult", "editable": False}
        return {
            "root": [f"group:{g['id']}" for g in groups], "groups": groups, "nodes": nodes,
            "title": fw_tree["title"], "titles": {"fw": fw_tree["title"], "katapult": k_tree["title"]},
            "offset": link,
        }
