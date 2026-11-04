"""The Kconfig model: a session over the project's own ``lib/kconfiglib``.

:class:`Session` imports the kconfiglib the tree bundles (never a copy of
ours), loads ``src/Kconfig`` with Kalico's generated ``src/extras/Kconfig``
and Katapult's ``$(shell, ./scripts/make-version.sh)`` answered, and offers
what the site needs: the menu tree as JSON with menuconfig's visibility, a
``set``, the ``.config``, the minimal ``defconfig`` (what ``savedefconfig``
writes) and ``autoconf.h``, exactly as ``make olddefconfig``, ``make
savedefconfig`` and ``genconfig.py`` would produce them.
"""
from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any, Optional

from .pyrun import MODULES
from .shell import ShellError, find_firmware_extras

_PROJECT_MARKERS = (
    ("katapult", "src/canboot.h"),
    ("katapult", "src/flashcmd.c"),  # the flash command handler: every tag, v0.0.1 included
    ("kalico", "src/extras"),
    ("klipper", "klippy"),
)


def detect_project(tree: Path) -> str:
    """Which project a source tree is, from files only it has."""
    tree = Path(tree)
    for project, marker in _PROJECT_MARKERS:
        if (tree / marker).exists():
            return project
    return "klipper"


class KconfigError(Exception):
    """A Kconfig that does not parse, or a value that is not valid."""


class Session:
    """One Kconfig session over ``tree``.

    ``version`` is the snapshot's describe string: Katapult's Kconfig asks
    the shell for it and bakes it into ``CONFIG_KATAPULT_VERSION``. Node ids
    (``n<k>``) are the nodes' positions in Kconfig definition order, stable
    for the life of the session.
    """

    def __init__(self, tree: Path, project: str = "", version: str = "?") -> None:
        self.tree = Path(tree).resolve()
        self.project = project or detect_project(self.tree)
        self.version = version
        find_firmware_extras(self.tree)
        self.kconfiglib = MODULES.import_module(self.tree, "lib/kconfiglib", "kconfiglib")
        self.kconf = self._load_kconfig()
        self._nodes: list = []
        self._ids: dict[int, str] = {}
        for node in self.kconf.node_iter():
            node_id = f"n{len(self._nodes)}"
            self._nodes.append(node)
            self._ids[id(node)] = node_id
        self._by_id = {self._ids[id(n)]: n for n in self._nodes}

    # ── Loading ───────────────────────────────────────────────────────

    def _load_kconfig(self):
        lib = self.kconfiglib
        version = self.version

        def shell_fn(kconf, _name, command):
            # Katapult asks the shell for its version: through make-version.sh
            # on master, and with git describe itself on v0.0.1.
            text = command.strip()
            if re.fullmatch(r"\./scripts/make-version\.sh(\s+2>\s*/dev/null)?", text) \
                    or re.match(r"git describe\b", text):
                return version
            raise ShellError(f"unsupported Kconfig $(shell,{command})")

        old_shell = lib._shell_fn
        old_cwd = os.getcwd()
        old_srctree = os.environ.get("srctree")
        lib._shell_fn = shell_fn
        try:
            os.chdir(self.tree)
            os.environ.pop("srctree", None)
            try:
                return lib.Kconfig("src/Kconfig", warn=True, warn_to_stderr=False)
            except lib.KconfigError as e:
                raise KconfigError(str(e)) from None
        finally:
            lib._shell_fn = old_shell
            os.chdir(old_cwd)
            if old_srctree is not None:
                os.environ["srctree"] = old_srctree

    def _in_tree(self, fn, *args, **kwargs):
        """Run a kconfiglib call with the tree as the working directory: its
        file names are relative to it."""
        old_cwd = os.getcwd()
        os.chdir(self.tree)
        try:
            return fn(*args, **kwargs)
        finally:
            os.chdir(old_cwd)

    @property
    def missing(self) -> list[list[str]]:
        """The assignments of the last load to symbols this Kconfig does not
        define: ``[[name, value], ...]``."""
        return [[str(n), str(v)] for n, v in getattr(self.kconf, "missing_syms", [])]

    def load(self, text: Optional[str]) -> list[str]:
        """Load a ``.config`` or a defconfig (new symbols take their defaults,
        as ``olddefconfig`` does); None resets every symbol to its default.
        Returns kconfiglib's warnings (an unknown symbol, an invalid value)."""
        self.kconf.warnings = []
        if text is None:
            self.kconf.unset_values()
            self.kconf.missing_syms = []
            return []
        path = self.tree / ".config"
        path.write_bytes(text.replace("\r\n", "\n").replace("\r", "\n").encode("utf-8"))
        self._in_tree(self.kconf.load_config, ".config", True)
        warnings = list(self.kconf.warnings)
        # kconfiglib keeps assignments to undefined symbols quiet unless
        # KCONFIG_WARN_UNDEF is set; the site wants to hear about them.
        for name, value in getattr(self.kconf, "missing_syms", []):
            warnings.append(f"CONFIG_{name} is not a symbol of this version (ignored {name}={value})")
        return warnings

    # ── Output texts ──────────────────────────────────────────────────

    def _written(self, writer, name: str, **kwargs) -> str:
        path = self.tree / "out" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        self._in_tree(writer, str(path), **kwargs)
        # kconfiglib writes in text mode, which is CRLF on Windows; the texts
        # are LF everywhere, as make olddefconfig writes them on Linux.
        return path.read_bytes().decode("utf-8").replace("\r\n", "\n")

    def config_text(self) -> str:
        """The full ``.config`` as ``make olddefconfig`` writes it."""
        return self._written(self.kconf.write_config, ".webflash.config", save_old=False)

    def defconfig_text(self) -> str:
        """The minimal configuration, as ``make savedefconfig`` writes it."""
        return self._written(self.kconf.write_min_config, ".webflash.defconfig")

    def autoconf_text(self) -> str:
        """``autoconf.h`` as ``genconfig.py`` writes it (with Klipper's patch:
        every bool is defined, as 1 or 0)."""
        return self._written(self.kconf.write_autoconf, ".webflash.autoconf.h")

    def write_config(self, path: Optional[Path] = None) -> Path:
        """Write the full ``.config`` into the tree (or to ``path``)."""
        target = Path(path) if path else self.tree / ".config"
        target.write_bytes(self.config_text().encode("utf-8"))
        return target

    # ── Values ────────────────────────────────────────────────────────

    def value(self, name: str) -> Optional[str]:
        """A symbol's current value as a string (``y``/``n`` for bools), or
        None for an unknown symbol."""
        sym = self.kconf.syms.get(name)
        return sym.str_value if sym is not None else None

    def values(self) -> dict[str, str]:
        """Every defined symbol's value."""
        return {s.name: s.str_value for s in self.kconf.unique_defined_syms}

    def set(self, name: str, value: str) -> dict:
        """Set a symbol (``"y"``/``"n"`` for bools, a string for int/hex/string)
        or a choice (``name`` is its node id or its name, ``value`` the member
        symbol to select). Returns the new tree."""
        lib = self.kconfiglib
        node = self._by_id.get(name)
        item = node.item if node is not None else self.kconf.syms.get(name)
        if item is None:
            item = self.kconf.named_choices.get(name)
        if item is None or item in (lib.MENU, lib.COMMENT):
            raise KconfigError(f"unknown symbol or choice: {name}")
        if isinstance(item, lib.Choice):
            member = self.kconf.syms.get(value)
            if member is None or member.choice is not item:
                raise KconfigError(f"{value} is not a member of that choice")
            member.set_value(2)
        elif isinstance(item, lib.Symbol):
            if item.orig_type in (lib.BOOL, lib.TRISTATE):
                if value not in ("y", "n", "m"):
                    raise KconfigError(f"{name} takes y or n, not {value!r}")
                if item.choice is not None and value == "y":
                    item.set_value(2)
                elif not item.set_value(value):
                    raise KconfigError(f"{value!r} is not valid for {name}")
            else:
                if not item.set_value(str(value)):
                    raise KconfigError(f"{value!r} is not a valid {lib.TYPE_TO_STR[item.orig_type]} for {name}")
        return self.tree_json()

    # ── Tree ──────────────────────────────────────────────────────────

    def _visible(self, node) -> bool:
        lib = self.kconfiglib
        return bool(node.prompt and lib.expr_value(node.prompt[1])
                    and not (node.item == lib.MENU and not lib.expr_value(node.visibility)))

    def _shown(self, menu) -> list:
        """menuconfig's ``_shown_nodes``: the nodes shown when entering a menu,
        including invisible symbols whose children are visible."""
        lib = self.kconfiglib

        def rec(node):
            res = []
            while node:
                if self._visible(node):
                    res.append(node)
                    if node.list and not node.is_menuconfig:
                        res += rec(node.list)
                elif node.list and isinstance(node.item, lib.Symbol):
                    shown_children = rec(node.list)
                    if shown_children:
                        res.append(node)
                        if not node.is_menuconfig:
                            res += shown_children
                node = node.next
            return res

        if isinstance(menu.item, lib.Choice):
            seen = {n.item for n in rec(menu.list) if isinstance(n.item, lib.Symbol)}
            res = []
            for choice_node in menu.item.nodes:
                for n in rec(choice_node.list):
                    if n.item not in seen or choice_node is menu:
                        res.append(n)
                        if isinstance(n.item, lib.Symbol):
                            seen.add(n.item)
            return res
        return rec(menu.list)

    def _shown_set(self) -> set[int]:
        shown: set[int] = set()
        stack = [self.kconf.top_node]
        while stack:
            menu = stack.pop()
            for node in self._shown(menu):
                shown.add(id(node))
                if node.is_menuconfig:
                    stack.append(node)
        return shown

    def _changeable(self, node) -> bool:
        """menuconfig's ``_changeable``: whether the node's value can be
        changed (a bool a ``select`` pins, an invisible symbol cannot)."""
        lib = self.kconfiglib
        sc = node.item
        if not isinstance(sc, (lib.Symbol, lib.Choice)):
            return False
        if not (node.prompt and lib.expr_value(node.prompt[1])):
            return False
        if isinstance(sc, lib.Choice):
            # menuconfig enters a choice rather than changing it in place; the
            # site renders it as a dropdown, which is editable when visible.
            return sc.visibility > 0
        y_mode_choice_sym = sc.choice is not None and sc.visibility == 2
        return sc.orig_type in (lib.STRING, lib.INT, lib.HEX) or len(sc.assignable) > 1 or y_mode_choice_sym

    def _range(self, sym) -> Optional[list[str]]:
        lib = self.kconfiglib
        for low, high, cond in sym.ranges:
            if lib.expr_value(cond):
                return [low.str_value, high.str_value]
        return None

    def _node_json(self, node, shown: set[int]) -> dict:
        lib = self.kconfiglib
        item = node.item
        data: dict[str, Any] = {
            "id": self._ids[id(node)],
            "kind": "menu", "name": "", "prompt": node.prompt[0] if node.prompt else "",
            "type": None, "value": None, "user_value": None,
            "visible": id(node) in shown, "menuconfig": bool(node.is_menuconfig),
            "editable": self._changeable(node),
            "range": None, "help": getattr(node, "help", None) or "", "children": [], "members": [],
            "depends": lib.expr_str(node.dep),
        }
        child = node.list
        while child:
            data["children"].append(self._ids[id(child)])
            child = child.next
        if item == lib.MENU:
            return data
        if item == lib.COMMENT:
            data["kind"] = "comment"
            return data
        if isinstance(item, lib.Choice):
            data["kind"] = "choice"
            data["name"] = item.name or ""
            data["type"] = lib.TYPE_TO_STR[item.type] if item.type else None
            data["value"] = item.selection.name if item.selection else ""
            data["user_value"] = item.user_selection.name if item.user_selection else None
            members = []
            for sym in item.syms:
                sym_node = next((n for n in sym.nodes if n.parent is node), None) or (sym.nodes[0] if sym.nodes else None)
                members.append({
                    "name": sym.name,
                    "prompt": sym_node.prompt[0] if sym_node is not None and sym_node.prompt else sym.name,
                    "selected": item.selection is sym,
                    "visible": bool(sym_node is not None and self._visible(sym_node)),
                })
            data["members"] = members
            return data
        data["kind"] = "symbol"
        data["name"] = item.name
        data["type"] = lib.TYPE_TO_STR[item.type] if item.type else None
        data["value"] = item.str_value
        if item.user_value is not None:
            data["user_value"] = (lib.TRI_TO_STR[item.user_value]
                                  if item.orig_type in (lib.BOOL, lib.TRISTATE) else str(item.user_value))
        if item.orig_type in (lib.INT, lib.HEX):
            data["range"] = self._range(item)
        return data

    def tree_json(self) -> dict:
        """The whole menu tree: ``{"root": [ids], "nodes": {id: node}}``."""
        shown = self._shown_set()
        nodes = {self._ids[id(n)]: self._node_json(n, shown) for n in self._nodes}
        root = []
        child = self.kconf.top_node.list
        while child:
            root.append(self._ids[id(child)])
            child = child.next
        return {"root": root, "nodes": nodes, "title": self.kconf.mainmenu_text}

    def symbol(self, name: str) -> Optional[dict]:
        """One symbol's node JSON (its first node), or None."""
        sym = self.kconf.syms.get(name)
        if sym is None or not sym.nodes:
            return None
        return self._node_json(sym.nodes[0], self._shown_set())

    def search(self, text: str) -> list[str]:
        """Ids of the nodes whose name, prompt or help mention ``text``."""
        needle = text.strip().lower()
        if not needle:
            return []
        out = []
        for node in self._nodes:
            name = getattr(node.item, "name", "") or ""
            prompt = node.prompt[0] if node.prompt else ""
            help_text = getattr(node, "help", None) or ""
            if needle in name.lower() or needle in prompt.lower() or needle in help_text.lower():
                out.append(self._ids[id(node)])
        return out
