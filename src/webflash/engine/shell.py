"""Recipe command emulation: the handful of shell commands the Makefiles use.

A recipe line is split with POSIX shell quoting, then taken apart into an
environment prefix (``KCONFIG_AUTOHEADER=$@ python3 ...``), at most one pipe
(``cat ... | tr -s '\\0' '\\n' > file``) and a ``>`` redirection. The commands
are emulated on the tree's filesystem (``echo``, ``mkdir -p``, ``rm -f``,
``cp``, ``ln -sf``, ``cat``, ``tr``, ``test``), run in process (``python3``,
``pad_checksum``), virtualized (``g++`` building elf2uf2, ``elf2uf2`` itself,
``check-gcc.sh``, ``find-firmware-extras.sh``), re-entered (``make``) or sent
to the toolchain through the driver (the compiler, the linker, objcopy).
Anything else is a :class:`ShellError`, so an upstream Makefile change that
needs a new command fails loudly rather than silently.

``$(shell ...)`` is emulated too, for exactly the forms the Makefiles use.
"""
from __future__ import annotations

import os
import re
import shlex
import shutil
import stat
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable, Optional

if TYPE_CHECKING:  # pragma: no cover
    from .make import Evaluator


class ShellError(Exception):
    """A command, option or shape the emulation does not support."""


@dataclass
class CommandResult:
    code: int
    stdout: str = ""
    stderr: str = ""
    argv: Optional[list[str]] = None   # the command as the toolchain ran it, for tool commands


@dataclass
class Links:
    """How ``ln -sf`` was realized for each link, so a toolchain that mirrors
    the tree (the JavaScript worker) can recreate it as a symlink."""
    targets: dict[str, str] = field(default_factory=dict)   # link path -> target
    kinds: dict[str, str] = field(default_factory=dict)     # link path -> symlink|junction|copy


_ENV_PREFIX_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*=.*")
_CC_OPTION_RE = re.compile(
    r'^if test -z "`(?P<cc>\S+) (?P<flag>\S+) -S -o /dev/null -xc /dev/null 2>&1`"\s*;'
    r' then echo "(?P=flag)"; else echo "(?P<alt>[^"]*)"; fi\s*;?\s*$')

# Tools that reach the toolchain through the driver, by basename.
_TOOL_SUFFIXES = ("gcc", "g++", "cc", "c++", "cpp", "as", "ld", "objcopy", "objdump", "strip",
                  "ar", "nm", "size", "readelf", "clang", "clang++")


def find_firmware_extras(tree: Path) -> None:
    """Kalico's ``scripts/find-firmware-extras.sh``: list ``src/extras/*/Kconfig``
    and ``Makefile`` and write ``src/extras/Kconfig`` (a "Firmware Extras" menu
    sourcing each) and ``src/extras/Makefile`` (including each), or empty files
    when there are none. A no-op without ``src/extras``."""
    extras = Path(tree) / "src" / "extras"
    if not extras.is_dir():
        return
    kconfigs = sorted(p for p in extras.glob("*/Kconfig") if p.is_file())
    makefiles = sorted(p for p in extras.glob("*/Makefile") if p.is_file())
    if kconfigs:
        lines = ['menu "Firmware Extras"']
        lines += [f'source "src/extras/{p.parent.name}/Kconfig"' for p in kconfigs]
        lines.append("endmenu")
        kconfig_text = "\n".join(lines) + "\n"
        makefile_text = "".join(f"include src/extras/{p.parent.name}/Makefile\n" for p in makefiles)
    else:
        kconfig_text = makefile_text = ""
    for path, text in ((extras / "Kconfig", kconfig_text), (extras / "Makefile", makefile_text)):
        if not path.is_file() or path.read_bytes() != text.encode("utf-8"):
            path.write_bytes(text.encode("utf-8"))


def _tr_set(spec: str) -> list[int]:
    """The bytes of a ``tr`` set: C escapes, octal escapes and ``a-z`` ranges."""
    chars: list[int] = []
    i = 0
    while i < len(spec):
        c = spec[i]
        if c == "\\" and i + 1 < len(spec):
            nxt = spec[i + 1]
            if nxt in "01234567":
                j = i + 1
                digits = ""
                while j < len(spec) and len(digits) < 3 and spec[j] in "01234567":
                    digits += spec[j]
                    j += 1
                chars.append(int(digits, 8))
                i = j
                continue
            escapes = {"n": 10, "t": 9, "r": 13, "\\": 92, "a": 7, "b": 8, "f": 12, "v": 11}
            chars.append(escapes.get(nxt, ord(nxt)))
            i += 2
            continue
        if i + 2 < len(spec) and spec[i + 1] == "-":
            lo, hi = ord(c), ord(spec[i + 2])
            if hi < lo:
                raise ShellError(f"tr: range {c}-{spec[i + 2]} is reversed")
            chars.extend(range(lo, hi + 1))
            i += 3
            continue
        chars.append(ord(c))
        i += 1
    return chars


def tr(args: list[str], data: bytes) -> bytes:
    """``tr [-s] [-d] SET1 [SET2]`` on bytes."""
    squeeze = delete = False
    sets: list[str] = []
    for a in args:
        if a.startswith("-") and len(a) > 1 and not sets:
            for ch in a[1:]:
                if ch == "s":
                    squeeze = True
                elif ch == "d":
                    delete = True
                else:
                    raise ShellError(f"tr: unsupported option -{ch}")
        else:
            sets.append(a)
    if not sets or len(sets) > 2:
        raise ShellError("tr: expected one or two sets")
    set1 = _tr_set(sets[0])
    if delete:
        if len(sets) != 1:
            raise ShellError("tr: -d takes one set")
        out = bytes(b for b in data if b not in set1)
        squeeze_set = set()
    elif squeeze and len(sets) == 1:
        out = data
        squeeze_set = set(set1)
    else:
        if len(sets) != 2:
            raise ShellError("tr: two sets are needed")
        set2 = _tr_set(sets[1])
        if not set2:
            raise ShellError("tr: the second set is empty")
        if len(set2) < len(set1):
            set2 = set2 + [set2[-1]] * (len(set1) - len(set2))
        table = bytes(range(256))
        mapping = bytearray(table)
        for a, b in zip(set1, set2):
            mapping[a] = b
        out = data.translate(bytes(mapping))
        squeeze_set = set(set2[:len(set1)])
    if squeeze:
        result = bytearray()
        last = -1
        for b in out:
            if b in squeeze_set and b == last:
                continue
            result.append(b)
            last = b
        out = bytes(result)
    return out


class Shell:
    """Runs recipe lines against ``tree``.

    ``toolchain`` runs the compiler commands the ``driver`` translated;
    ``python`` runs the project's scripts; ``uf2`` converts an ELF to UF2 in
    place of the C++ tool. The commands that create files touch the real
    filesystem (Pyodide's MEMFS in the browser).
    """

    def __init__(self, tree: Path, *, toolchain: Any = None, driver: Any = None,
                 python: Any = None, uf2: Optional[Callable[[Path, Path], None]] = None,
                 log: Optional[Callable[[str], None]] = None,
                 cc_option: Optional[Callable[[str, str], bool]] = None) -> None:
        self.tree = Path(tree)
        self.toolchain = toolchain
        self.driver = driver
        self.python = python
        self.uf2 = uf2
        self.log = log or (lambda line: None)
        self.cc_option = cc_option
        self.links = Links()
        self.virtual: set[str] = set()   # paths "built" by virtual commands (elf2uf2)

    # ── $(shell ...) ──────────────────────────────────────────────────

    def shell_function(self, command: str, env: dict[str, str], where: str = "") -> str:
        """The restricted ``$(shell ...)``: ``echo`` (with ``tr`` pipes), the
        ``find-firmware-extras.sh`` run, ``<cc> -dumpversion`` and the
        ``cc-option`` idiom."""
        text = command.strip()
        if not text:
            return ""
        m = _CC_OPTION_RE.match(text)
        if m:
            supported = True
            if self.cc_option is not None:
                supported = self.cc_option(m.group("cc"), m.group("flag"))
            return m.group("flag") if supported else m.group("alt")
        if text == "./scripts/find-firmware-extras.sh":
            find_firmware_extras(self.tree)
            return ""
        try:
            tokens = shlex.split(text)
        except ValueError as e:
            raise ShellError(f"{where}: cannot parse $(shell {command}): {e}") from None
        stages = _split_pipeline(tokens)
        if stages and stages[0] and stages[0][0] == "echo":
            data = (" ".join(stages[0][1:]) + "\n").encode("utf-8")
            for stage in stages[1:]:
                if not stage or stage[0] != "tr":
                    raise ShellError(f"{where}: unsupported $(shell) pipeline stage: {' '.join(stage)}")
                data = tr(stage[1:], data)
            return data.decode("utf-8", errors="replace")
        if len(tokens) == 2 and tokens[1] == "-dumpversion" and self.driver is not None:
            return self.driver.dumpversion(tokens[0])
        raise ShellError(f"{where}: unsupported: $(shell {command})")

    # ── Recipe lines ──────────────────────────────────────────────────

    async def run(self, line: str, env: dict[str, str], *, dry_run: bool = False, where: str = "",
                  make: Optional["Evaluator"] = None) -> CommandResult:
        """Run one recipe line. In a dry run only ``$(MAKE)`` lines are run
        (as GNU make does), and the sub-make prints instead of building."""
        if line.lstrip(" 	").startswith("#"):
            # A comment line of a recipe: sh ignores it.
            return CommandResult(0)
        try:
            tokens = shlex.split(line)
        except ValueError as e:
            raise ShellError(f"{where}: cannot parse command: {e}") from None
        env = dict(env)
        while tokens and _ENV_PREFIX_RE.fullmatch(tokens[0]) and not tokens[0].startswith("="):
            name, value = tokens.pop(0).split("=", 1)
            env[name] = value
        if not tokens:
            return CommandResult(0)
        stages = _split_pipeline(tokens)
        if len(stages) > 2:
            raise ShellError(f"{where}: unsupported: a pipeline with {len(stages)} commands")
        if len(stages) == 2:
            first, redirect = _take_redirect(stages[0])
            if redirect is not None:
                raise ShellError(f"{where}: unsupported: a redirection before a pipe")
            second, redirect = _take_redirect(stages[1])
            if not first or first[0] != "cat" or not second or second[0] != "tr":
                raise ShellError(f"{where}: unsupported pipeline: {line}")
            data = self._cat(first[1:], where)
            data = tr(second[1:], data)
            return self._deliver(data, redirect)
        argv, redirect = _take_redirect(stages[0])
        if not argv:
            return CommandResult(0)
        name = argv[0]
        base = name.rsplit("/", 1)[-1]

        if base == "make" or (make is not None and name == make.expand("$(MAKE)")):
            if make is None:
                raise ShellError(f"{where}: $(MAKE) outside a make run")
            await make.submake(argv[1:], dry_run=dry_run)
            return CommandResult(0)
        if dry_run:
            return CommandResult(0)

        if base == "echo":
            text = " ".join(argv[1:]) + "\n"
            if argv[1:2] == ["-n"]:
                text = " ".join(argv[2:])
            return self._deliver(text.encode("utf-8"), redirect)
        if base == "mkdir":
            return self._mkdir(argv[1:], where)
        if base == "rm":
            return self._rm(argv[1:], where)
        if base == "cp":
            return self._cp(argv[1:], where)
        if base == "ln":
            return self._ln(argv[1:], where)
        if base == "cat":
            return self._deliver(self._cat(argv[1:], where), redirect)
        if base == "tr":
            raise ShellError(f"{where}: unsupported: tr without a pipe")
        if base in ("test", "["):
            return CommandResult(0 if self._test(argv[1:], where) else 1)
        if base in ("python3", "python"):
            if len(argv) < 2:
                raise ShellError(f"{where}: unsupported: an interactive {base}")
            return self._python(argv[1], argv[2:], env, redirect, where)
        if base == "pad_checksum":
            return self._python(name, argv[1:], env, redirect, where)
        if base == "check-gcc.sh":
            return CommandResult(0)
        if base == "find-firmware-extras.sh":
            find_firmware_extras(self.tree)
            return CommandResult(0)
        if base == "elf2uf2":
            return self._elf2uf2(argv, where)
        if base == "g++" and any(a.endswith("elf2uf2/main.cpp") for a in argv):
            return self._virtual_g_plus_plus(argv, where)
        if self.driver is not None and self.driver.classify(argv) is not None:
            return await self._tool(argv, env, redirect, where)
        if base.endswith(_TOOL_SUFFIXES):
            raise ShellError(f"{where}: no toolchain to run {name}")
        raise ShellError(f"{where}: unsupported command: {line}")

    # ── Commands ──────────────────────────────────────────────────────

    def _path(self, name: str) -> Path:
        p = Path(name)
        return p if p.is_absolute() else self.tree / name

    def _deliver(self, data: bytes, redirect: Optional[str]) -> CommandResult:
        if redirect is None:
            return CommandResult(0, data.decode("utf-8", errors="replace"))
        path = self._path(redirect)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return CommandResult(0)

    def _glob_args(self, args: list[str]) -> list[str]:
        import glob as _glob
        out: list[str] = []
        for a in args:
            if any(ch in a for ch in "*?["):
                matches = sorted(_glob.glob(str(self._path(a))))
                if matches:
                    for m in matches:
                        rel = m if Path(a).is_absolute() else os.path.relpath(m, self.tree)
                        out.append(rel.replace("\\", "/"))
                    continue
            out.append(a)
        return out

    def _mkdir(self, args: list[str], where: str) -> CommandResult:
        parents = False
        for a in args:
            if a == "-p":
                parents = True
            elif a.startswith("-"):
                raise ShellError(f"{where}: unsupported: mkdir {a}")
        for a in args:
            if a.startswith("-"):
                continue
            path = self._path(a)
            if parents:
                path.mkdir(parents=True, exist_ok=True)
            elif path.exists():
                return CommandResult(1, "", f"mkdir: cannot create directory '{a}': File exists\n")
            else:
                path.mkdir()
        return CommandResult(0)

    def _rm(self, args: list[str], where: str) -> CommandResult:
        force = recursive = False
        names = []
        for a in args:
            if a.startswith("-") and len(a) > 1:
                for ch in a[1:]:
                    if ch == "f":
                        force = True
                    elif ch in "rR":
                        recursive = True
                    else:
                        raise ShellError(f"{where}: unsupported: rm -{ch}")
            else:
                names.append(a)
        for a in self._glob_args(names):
            path = self._path(a)
            if not os.path.lexists(path):
                if force:
                    continue
                return CommandResult(1, "", f"rm: cannot remove '{a}': No such file or directory\n")
            key = _posix_rel(path, self.tree)
            if _is_link(path):
                _remove_link(path)
            elif path.is_dir():
                if not recursive and key not in self.links.kinds:
                    return CommandResult(1, "", f"rm: cannot remove '{a}': Is a directory\n")
                shutil.rmtree(path)
            else:
                path.unlink()
            self.links.targets.pop(key, None)
            self.links.kinds.pop(key, None)
        return CommandResult(0)

    def _cp(self, args: list[str], where: str) -> CommandResult:
        names = [a for a in args if not a.startswith("-")]
        for a in args:
            if a.startswith("-"):
                raise ShellError(f"{where}: unsupported: cp {a}")
        if len(names) != 2:
            raise ShellError(f"{where}: unsupported: cp with {len(names)} operands")
        src, dst = self._path(names[0]), self._path(names[1])
        if not src.is_file():
            return CommandResult(1, "", f"cp: cannot stat '{names[0]}': No such file or directory\n")
        if dst.is_dir():
            dst = dst / src.name
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dst)
        return CommandResult(0)

    def _ln(self, args: list[str], where: str) -> CommandResult:
        symbolic = force = False
        names = []
        for a in args:
            if a.startswith("-") and len(a) > 1:
                for ch in a[1:]:
                    if ch == "s":
                        symbolic = True
                    elif ch == "f":
                        force = True
                    else:
                        raise ShellError(f"{where}: unsupported: ln -{ch}")
            else:
                names.append(a)
        if not symbolic or len(names) != 2:
            raise ShellError(f"{where}: unsupported: ln without -s or with {len(names)} operands")
        target, link = names
        link_path = self._path(link)
        if os.path.lexists(link_path):
            if not force:
                return CommandResult(1, "", f"ln: failed to create symbolic link '{link}': File exists\n")
            if _is_link(link_path):
                _remove_link(link_path)
            elif link_path.is_dir():
                shutil.rmtree(link_path)
            else:
                link_path.unlink()
        link_path.parent.mkdir(parents=True, exist_ok=True)
        target_path = Path(target) if Path(target).is_absolute() else link_path.parent / target
        kind = make_link(target_path, link_path, target)
        key = _posix_rel(link_path, self.tree)
        self.links.targets[key] = target
        self.links.kinds[key] = kind
        return CommandResult(0)

    def _cat(self, args: list[str], where: str) -> bytes:
        chunks = []
        for a in self._glob_args([a for a in args if not a.startswith("-")]):
            path = self._path(a)
            if not path.is_file():
                raise ShellError(f"{where}: cat: {a}: No such file or directory")
            chunks.append(path.read_bytes())
        return b"".join(chunks)

    def _test(self, args: list[str], where: str) -> bool:
        if args and args[-1] == "]":
            args = args[:-1]
        if len(args) == 2 and args[0] in ("-z", "-n", "-d", "-f", "-e", "-s"):
            op, arg = args
            if op == "-z":
                return arg == ""
            if op == "-n":
                return arg != ""
            path = self._path(arg)
            if op == "-d":
                return path.is_dir()
            if op == "-f":
                return path.is_file()
            if op == "-e":
                return path.exists()
            return path.is_file() and path.stat().st_size > 0
        if len(args) == 3 and args[1] in ("=", "!="):
            return (args[0] == args[2]) == (args[1] == "=")
        raise ShellError(f"{where}: unsupported: test {' '.join(args)}")

    def _python(self, script: str, args: list[str], env: dict[str, str], redirect: Optional[str],
                where: str) -> CommandResult:
        if self.python is None:
            raise ShellError(f"{where}: no Python runner for {script}")
        result = self.python.run(script, args, cwd=self.tree, env=env)
        for line in result.stderr.rstrip("\n").split("\n"):
            if line:
                self.log(line)
        if redirect is not None:
            self._deliver(result.stdout.encode("utf-8"), redirect)
            return CommandResult(result.code, "", result.stderr)
        return CommandResult(result.code, result.stdout, result.stderr)

    def _virtual_g_plus_plus(self, argv: list[str], where: str) -> CommandResult:
        """``g++ ... lib/elf2uf2/main.cpp -o out/lib/elf2uf2/elf2uf2``: the C++
        tool is never built; a marker file stands in for the executable and
        ``elf2uf2`` runs the Python port."""
        if "-o" not in argv:
            raise ShellError(f"{where}: unsupported: g++ without -o")
        out = argv[argv.index("-o") + 1]
        path = self._path(out)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"#!/bin/sh\n# WebFlash: elf2uf2 is webflash.engine.uf2, this file is a marker\n")
        self.virtual.add(_posix_rel(path, self.tree))
        return CommandResult(0)

    def _elf2uf2(self, argv: list[str], where: str) -> CommandResult:
        args = [a for a in argv[1:] if a != "-v"]
        if len(args) != 2:
            raise ShellError(f"{where}: elf2uf2 needs an input ELF and an output file")
        if self.uf2 is None:
            raise ShellError(f"{where}: no elf2uf2 port installed")
        try:
            self.uf2(self._path(args[0]), self._path(args[1]))
        except ValueError as e:
            return CommandResult(1, "", f"ERROR: {e}\n")
        return CommandResult(0)

    async def _tool(self, argv: list[str], env: dict[str, str], redirect: Optional[str],
                    where: str) -> CommandResult:
        if self.toolchain is None:
            raise ShellError(f"{where}: no toolchain to run {argv[0]}")
        command = self.driver.translate(argv, tree=self.tree)
        result = await self.toolchain.run(command, cwd=self.tree, env=env, links=self.links)
        if redirect is not None:
            self._deliver(result.stdout.encode("utf-8"), redirect)
            return CommandResult(result.code, "", result.stderr, list(command.argv))
        return CommandResult(result.code, result.stdout, result.stderr, list(command.argv))


# ── Helpers ──────────────────────────────────────────────────────────

def _split_pipeline(tokens: list[str]) -> list[list[str]]:
    stages: list[list[str]] = [[]]
    for t in tokens:
        if t == "|":
            stages.append([])
        else:
            stages[-1].append(t)
    return stages


def _take_redirect(tokens: list[str]) -> tuple[list[str], Optional[str]]:
    """Split a ``> file`` (or ``>file``) off a command's tokens."""
    argv: list[str] = []
    redirect: Optional[str] = None
    i = 0
    while i < len(tokens):
        t = tokens[i]
        if t == ">":
            if i + 1 >= len(tokens):
                raise ShellError("redirection without a file")
            redirect = tokens[i + 1]
            i += 2
            continue
        if t.startswith(">") and len(t) > 1 and not t.startswith(">>"):
            redirect = t[1:]
            i += 1
            continue
        if t in ("<", ">>", "2>", "2>&1", "&&", "||", ";"):
            raise ShellError(f"unsupported shell syntax: {t}")
        argv.append(t)
        i += 1
    return argv, redirect


def _posix_rel(path: Path, tree: Path) -> str:
    """A path relative to the tree, without following links (resolving
    ``out/board`` would name its target)."""
    try:
        return os.path.relpath(os.path.abspath(path), os.path.abspath(tree)).replace("\\", "/")
    except ValueError:
        return path.as_posix()


def _is_link(path: Path) -> bool:
    if os.path.islink(path):
        return True
    try:
        st = os.lstat(path)
    except OSError:
        return False
    return bool(getattr(st, "st_reparse_tag", 0))


def _remove_link(path: Path) -> None:
    try:
        os.unlink(path)
    except OSError:
        os.rmdir(path)


def make_link(target: Path, link: Path, target_text: str) -> str:
    """Create ``link`` pointing at ``target`` as a symlink where the platform
    allows one (Linux, macOS, Pyodide's MEMFS, Windows with Developer Mode),
    else as a directory junction (Windows), else as a copy. Returns which."""
    is_dir = target.is_dir()
    try:
        os.symlink(target_text, link, target_is_directory=is_dir)
        return "symlink"
    except (OSError, NotImplementedError):
        pass
    if sys.platform == "win32" and is_dir:
        try:
            import _winapi
            _winapi.CreateJunction(str(target), str(link))
            return "junction"
        except (OSError, ImportError, AttributeError):
            pass
    if is_dir:
        shutil.copytree(target, link)
    else:
        shutil.copyfile(target, link)
    return "copy"
