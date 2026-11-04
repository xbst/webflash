"""The driver: GCC command lines from the Makefiles to the LLVM tools.

The Makefiles are written for ``arm-none-eabi-gcc`` and binutils. With the
clang backend (the WebAssembly toolchain in the browser, Arm Toolchain for
Embedded natively) every command is translated here, with the rules of SPEC
section 9.4: a compile becomes ``clang --target=arm-none-eabi`` with the
manifest's system include directories, GCC-only flags are mapped or dropped,
LTO becomes fat LTO objects, and a link becomes a direct ``ld.lld`` line
(clang cannot spawn the linker in WebAssembly) with the manifest's multilib,
exactly the line ``clang -###`` would print, plus ``-u`` for every symbol the
generated ``compile_time_request.c`` marks ``__visible`` so LTO cannot drop
the vector table. With the GCC backend the commands pass through untouched;
the driver still classifies them so the build can run compiles concurrently
and read the memory table.
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


class DriverError(Exception):
    """A command the driver cannot translate (AVR, an unknown tool)."""


KINDS = ("compile", "assemble", "link", "ld", "objcopy", "cpp", "version", "other")

_LLVM_TOOLS = {
    "gcc": "clang", "cc": "clang", "g++": "clang++", "c++": "clang++",
    "cpp": "clang", "as": "clang", "ld": "ld.lld",
    "objcopy": "llvm-objcopy", "objdump": "llvm-objdump", "strip": "llvm-strip",
    "ar": "llvm-ar", "nm": "llvm-nm", "size": "llvm-size", "readelf": "llvm-readelf",
    "clang": "clang", "clang++": "clang++", "ld.lld": "ld.lld",
}
_BINUTILS = ("as", "ld", "objcopy", "objdump", "strip", "ar", "nm", "size", "readelf")

_CXX_SUFFIXES = (".c++", ".cpp", ".cc", ".cxx", ".C", ".CPP")
_ASM_SUFFIXES = (".S", ".s", ".sx")
_SOURCE_SUFFIXES = (".c",) + _CXX_SUFFIXES + _ASM_SUFFIXES

_VISIBLE_RE = re.compile(r"\b([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s+__visible\b")

# Spellings GNU as accepts and LLVM's integrated assembler does not, with the
# equivalent LLVM accepts. A source that contains one is compiled from a
# patched copy under out/webflash-compat/ (its own folder first on the quote
# include path, so its includes resolve as before); the code is identical.
SOURCE_FIXES: tuple[tuple[str, str, str], ...] = (
    ("mrs %0, psr", "mrs %0, xpsr", "psr is GNU as's alias of xpsr (SYSm 3); LLVM only knows xpsr"),
)
# Header spellings GCC's C++ front end accepts and clang's rejects, applied to
# the include directories of a C++ compile (Kalico's INDX heater, the only C++
# in the three projects): Microchip's SAM headers qualify anonymous padding
# bit-fields (`__I uint8_t :2;`), which C++ forbids and clang refuses. The
# qualifiers mean nothing on padding, so dropping them changes no layout.
HEADER_FIXES: tuple[tuple[str, str, str], ...] = (
    (r"\b(?:__I|__O|__IO)\s+(uint(?:8|16|32|64)_t)(\s+):", r"\1\2:",
     "C++ forbids qualifiers on anonymous bit-fields; GCC allows them as an extension"),
)
COMPAT_DIR = "out/webflash-compat"


@dataclass
class Sysroot:
    """What the driver needs of the toolchain's layout: the system include
    directories (C++ first for C++), and a library directory per CPU, as the
    tool will see them (absolute native paths, or ``/sysroot/...`` inside the
    WebAssembly worker)."""
    include: list[str] = field(default_factory=list)
    include_cxx: list[str] = field(default_factory=list)
    multilibs: dict[str, dict] = field(default_factory=dict)   # variant -> {"cpus": [...], "lib": dir}
    libs: list[str] = field(default_factory=lambda: ["c", "clang_rt.builtins", "c"])

    @classmethod
    def from_manifest(cls, manifest: dict, root: str = "/") -> "Sysroot":
        """The sysroot of a toolchain manifest (SPEC 8.3), mounted at ``root``
        (a path the manifest spells absolutely is used as it is)."""
        def join(p: str) -> str:
            if not root or p.startswith("/") or (len(p) > 1 and p[1] == ":"):
                return p
            return root.rstrip("/") + "/" + p
        multilibs = {name: {"cpus": list(m.get("cpus", [])), "lib": join(m["lib"])}
                     for name, m in manifest.get("multilibs", {}).items()}
        return cls(include=[join(p) for p in manifest.get("include", [])],
                   include_cxx=[join(p) for p in manifest.get("include_cxx", [])],
                   multilibs=multilibs)

    @classmethod
    def from_atfe(cls, root: Path, variants: Optional[dict[str, list[str]]] = None) -> "Sysroot":
        """The sysroot of an Arm Toolchain for Embedded installation, with the
        same three soft-float variants the WebAssembly release ships."""
        root = Path(root)
        clang_dir = root / "lib" / "clang"
        versions = sorted((p for p in clang_dir.iterdir() if p.is_dir()), key=lambda p: p.name) if clang_dir.is_dir() else []
        if not versions:
            raise DriverError(f"no lib/clang/<version> under {root}")
        resource = versions[-1]
        runtimes = root / "lib" / "clang-runtimes" / "arm-none-eabi"
        variants = variants or {
            "armv6m_soft_nofp_size": ["cortex-m0", "cortex-m0plus"],
            "armv7m_soft_nofp_unaligned_size": ["cortex-m3", "cortex-m4", "cortex-m7"],
            "armv8m.main_soft_nofp_unaligned_size": ["cortex-m33"],
        }
        multilibs = {}
        for name, cpus in variants.items():
            lib = runtimes / name / "lib"
            if not lib.is_dir():
                raise DriverError(f"the ATfE installation has no {name} library in {runtimes}")
            multilibs[name] = {"cpus": list(cpus), "lib": _posix(lib)}
        return cls(include=[_posix(resource / "include"), _posix(runtimes / "include")],
                   include_cxx=[_posix(runtimes / "include" / "c++" / "v1")],
                   multilibs=multilibs)

    def lib_dir(self, cpu: str) -> str:
        for name, m in self.multilibs.items():
            if cpu in m["cpus"]:
                return m["lib"]
        raise DriverError(f"no library for -mcpu={cpu} in the toolchain (have: "
                          f"{', '.join(c for m in self.multilibs.values() for c in m['cpus'])})")


@dataclass
class Command:
    """One tool invocation as the toolchain runs it."""
    tool: str                 # the tool name: argv[0] of the command to run
    argv: list[str]           # the whole command line, argv[0] included
    kind: str                 # one of KINDS
    source: list[str]         # the Makefile's original command line
    inputs: list[str] = field(default_factory=list)    # files read, relative to the tree
    outputs: list[str] = field(default_factory=list)   # files written, relative to the tree
    cpu: str = ""


def _posix(path) -> str:
    return str(path).replace("\\", "/")


def _basename(name: str) -> str:
    return name.replace("\\", "/").rsplit("/", 1)[-1]


def tool_family(name: str) -> Optional[str]:
    """``gcc``, ``objcopy``, ... from ``arm-none-eabi-gcc``, ``cpp``,
    ``avr-objcopy``, or None for something that is not a toolchain tool."""
    base = _basename(name)
    if base.endswith(".exe"):
        base = base[:-4]
    if base in _LLVM_TOOLS:
        return base
    for family in ("gcc", "g++", "c++", "cpp", "objcopy", "objdump", "strip", "readelf", "size",
                   "ar", "nm", "as", "ld", "cc"):
        if base.endswith("-" + family):
            return family
    return None


def parse_memory_usage(text: str) -> Optional[dict[str, dict[str, int]]]:
    """``--print-memory-usage``'s table (lld's and GNU ld's) as
    ``{region: {"used": bytes, "size": bytes}}``, or None without one."""
    units = {"B": 1, "KB": 1024, "MB": 1024 ** 2, "GB": 1024 ** 3}
    regions: dict[str, dict[str, int]] = {}
    for line in text.splitlines():
        m = re.match(r"\s*(\S+):\s+(\d+)\s+(B|KB|MB|GB)\s+(\d+)\s+(B|KB|MB|GB)\s+[\d.]+%", line)
        if m:
            regions[m.group(1)] = {"used": int(m.group(2)) * units[m.group(3)],
                                   "size": int(m.group(4)) * units[m.group(5)]}
    return regions or None


def visible_symbols(path: Path) -> list[str]:
    """The symbols ``buildcommands.py`` declared ``__visible`` in a generated
    ``compile_time_request.c`` (``VectorTable``), in order."""
    try:
        text = Path(path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    out: list[str] = []
    for m in _VISIBLE_RE.finditer(text):
        if m.group(1) not in out:
            out.append(m.group(1))
    return out


class Driver:
    """Translates the Makefiles' tool commands for one backend.

    ``kind`` is ``"gcc"`` (pass-through) or ``"clang"``; ``sysroot`` is where
    clang finds headers and libraries; ``lto`` is ``"on"`` (fat LTO objects,
    an LTO link, the upstream default) or ``"off"`` (no LTO at all);
    ``version`` is the toolchain's version string for the ``--version``
    answers; ``label`` names it in ``build_versions``.
    """

    def __init__(self, kind: str = "clang", sysroot: Optional[Sysroot] = None, *, lto: str = "on",
                 version: str = "0", label: str = "webflash", target: str = "arm-none-eabi") -> None:
        if kind not in ("gcc", "clang"):
            raise DriverError(f"unknown driver kind {kind!r}")
        if lto not in ("on", "off"):
            raise DriverError(f"lto must be 'on' or 'off', not {lto!r}")
        self.kind = kind
        self.sysroot = sysroot or Sysroot()
        self.lto = lto
        self.version = version
        self.label = label
        self.target = target
        self._header_dirs: dict[str, Optional[str]] = {}

    # ── Classification ────────────────────────────────────────────────

    @staticmethod
    def classify(argv: list[str]) -> Optional[str]:
        """The kind of a command, or None when it is not a toolchain tool."""
        if not argv:
            return None
        family = tool_family(argv[0])
        if family is None:
            return None
        if len(argv) == 2 and argv[1] == "--version":
            return "version"
        if family in ("gcc", "g++", "cc", "c++", "clang", "clang++"):
            if "-E" in argv:
                return "cpp"
            if "-c" in argv or "-S" in argv:
                inputs = [a for a in argv[1:] if a.endswith(_ASM_SUFFIXES)]
                return "assemble" if inputs and all(a.endswith(_ASM_SUFFIXES) for a in
                                                     [x for x in argv[1:] if x.endswith(_SOURCE_SUFFIXES)]) else "compile"
            return "link"
        if family == "cpp":
            return "cpp"
        if family in ("ld", "ld.lld"):
            return "ld"
        if family == "objcopy":
            return "objcopy"
        return "other"

    def dumpversion(self, tool: str) -> str:
        """``<cc> -dumpversion``: the major version."""
        return self.version.split(".")[0] if self.version else "0"

    def tool_version(self, tool: str) -> str:
        """The first line of ``<tool> --version`` the build reports: for clang
        a compiler line and consistent "GNU" binutils lines, so that
        ``buildcommands.py`` sees a clean build and writes
        ``gcc: clang <ver> (<label>) binutils: llvm <ver> (<label>)``."""
        family = tool_family(tool) or tool
        if family in _BINUTILS:
            return f"GNU {family} llvm {self.version} ({self.label})"
        return f"{family} clang {self.version} ({self.label})"

    # ── Translation ───────────────────────────────────────────────────

    def translate(self, argv: list[str], tree: Optional[Path] = None) -> Command:
        """The command to run for a Makefile command line."""
        kind = self.classify(argv)
        if kind is None:
            raise DriverError(f"not a toolchain command: {argv[0]}")
        base = _basename(argv[0])
        if base.startswith("avr-"):
            raise DriverError("AVR is not supported in the browser build")
        if self.kind == "gcc":
            cmd = Command(argv[0], list(argv), kind, list(argv))
        else:
            cmd = self._translate_clang(argv, kind, tree)
        self._fill_files(cmd)
        return cmd

    def _translate_clang(self, argv: list[str], kind: str, tree: Optional[Path]) -> Command:
        family = tool_family(argv[0]) or ""
        if kind == "version":
            return Command(argv[0], list(argv), kind, list(argv))
        if kind == "objcopy":
            return Command("llvm-objcopy", ["llvm-objcopy", *argv[1:]], kind, list(argv))
        if kind == "other":
            tool = _LLVM_TOOLS.get(family)
            if tool is None:
                raise DriverError(f"no LLVM tool for {argv[0]}")
            return Command(tool, [tool, *argv[1:]], kind, list(argv))
        if kind == "ld":
            return Command("ld.lld", ["ld.lld", *argv[1:]], kind, list(argv))
        if kind == "cpp":
            return self._translate_cpp(argv)
        if kind in ("compile", "assemble"):
            return self._translate_compile(argv, kind, tree)
        return self._translate_link(argv, tree)

    @staticmethod
    def compat_source(rel: str, tree: Path) -> Optional[str]:
        """The patched copy of a source under ``out/webflash-compat/`` when it
        contains a spelling of :data:`SOURCE_FIXES`, else None."""
        path = Path(tree) / rel
        if not path.is_file():
            return None
        original = path.read_bytes()
        patched = original
        for find, repl, _why in SOURCE_FIXES:
            patched = patched.replace(find.encode("utf-8"), repl.encode("utf-8"))
        if patched == original:
            return None
        copy = Path(tree) / COMPAT_DIR / rel
        copy.parent.mkdir(parents=True, exist_ok=True)
        if not copy.is_file() or copy.read_bytes() != patched:
            copy.write_bytes(patched)
        return f"{COMPAT_DIR}/{_posix(rel)}"

    def compat_headers(self, rel: str, tree: Path) -> Optional[str]:
        """For a C++ compile: a copy of an include directory under
        ``out/webflash-compat/`` with :data:`HEADER_FIXES` applied, when any
        header in it needs one, else None. Computed once per directory."""
        key = _posix(rel).rstrip("/")
        if key in self._header_dirs:
            return self._header_dirs[key]
        src = Path(tree) / key
        result: Optional[str] = None
        if src.is_dir():
            patterns = [(re.compile(find.encode("utf-8")), repl.encode("utf-8")) for find, repl, _ in HEADER_FIXES]
            headers = [p for p in src.rglob("*") if p.is_file() and p.suffix.lower() in (".h", ".hpp", ".hh", ".inc")]
            patched: dict[Path, bytes] = {}
            for p in headers:
                data = p.read_bytes()
                fixed = data
                for pattern, repl in patterns:
                    fixed = pattern.sub(repl, fixed)
                if fixed != data:
                    patched[p] = fixed
            if patched:
                dest = Path(tree) / COMPAT_DIR / key
                for p in headers:
                    target = dest / p.relative_to(src)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    content = patched.get(p) or p.read_bytes()
                    if not target.is_file() or target.read_bytes() != content:
                        target.write_bytes(content)
                result = f"{COMPAT_DIR}/{key}"
        self._header_dirs[key] = result
        return result

    def _translate_cpp(self, argv: list[str]) -> Command:
        out: list[str] = ["clang", f"--target={self.target}", "-E", "-P", "-x", "assembler-with-cpp"]
        args = argv[1:]
        i = 0
        while i < len(args):
            a = args[i]
            if a in ("-P", "-E"):
                i += 1
                continue
            if a in ("-MD", "-MMD", "-MP"):
                i += 1
                continue
            if a in ("-MT", "-MF", "-MQ"):
                i += 2
                continue
            if a == "-x":
                i += 2
                continue
            out.append(a)
            i += 1
        return Command("clang", out, "cpp", list(argv))

    def _translate_compile(self, argv: list[str], kind: str, tree: Optional[Path] = None) -> Command:
        args = argv[1:]
        sources = [a for a in args if a.endswith(_SOURCE_SUFFIXES)]
        cxx = any(a.endswith(_CXX_SUFFIXES) for a in sources) or any(a.startswith("-std=c++") or a.startswith("-std=gnu++") for a in args)
        tool = "clang++" if cxx else "clang"
        out: list[str] = [tool, f"--target={self.target}"]
        compat: dict[str, str] = {}
        if tree is not None and not cxx:
            for src in sources:
                copy = self.compat_source(src, tree)
                if copy is not None:
                    compat[src] = copy
        for src, copy in compat.items():
            out.extend(["-iquote", _posix(Path(src).parent) or "."])
        cpu = ""
        lto_seen = False
        for a in args:
            if a.startswith("-mcpu="):
                cpu = a[6:]
                out.append(a)
            elif cxx and tree is not None and a.startswith("-I") and len(a) > 2:
                fixed = self.compat_headers(a[2:], tree)
                if fixed is not None:
                    out.append(f"-I{fixed}")
                out.append(a)
            elif a.startswith("-flto"):
                lto_seen = True
            elif a in ("-fwhole-program", "-fno-use-linker-plugin", "-fuse-linker-plugin"):
                continue
            elif a == "-ggdb3" or a.startswith("-ggdb"):
                out.append("-g")
            elif a in compat:
                out.append(compat[a])
            else:
                out.append(a)
        if lto_seen and self.lto == "on":
            # Fat objects: the native half keeps objcopy -j .compile_time_request
            # working on the object, the bitcode half feeds the LTO link.
            out.extend(["-flto", "-ffat-lto-objects"])
        if any(a.startswith("-W") and not a.startswith("-Wl,") for a in args):
            out.append("-Wno-unknown-warning-option")
        # picolibc's sys/cdefs.h defines __noreturn before compiler.h does
        # (to the same attribute); clang warns, GCC's newlib headers do not.
        out.append("-Wno-macro-redefined")
        if cxx:
            # libstdc++'s <cmath> drags <algorithm> in and Kalico's INDX code
            # relies on it for std::min and std::max; libc++'s does not.
            out.extend(["-include", "algorithm"])
        includes = (self.sysroot.include_cxx if cxx else []) + self.sysroot.include
        for inc in includes:
            out.extend(["-isystem", inc])
        cmd = Command(tool, out, kind, list(argv))
        cmd.cpu = cpu
        return cmd

    def _translate_link(self, argv: list[str], tree: Optional[Path]) -> Command:
        args = argv[1:]
        cpu = ""
        opt = "O2"
        lto = False
        objects: list[str] = []
        output = ""
        script = ""
        libs: list[str] = []
        extra_wl: list[str] = []
        sections: list[str] = []
        i = 0
        while i < len(args):
            a = args[i]
            if a.startswith("-mcpu="):
                cpu = a[6:]
            elif a in ("-ffunction-sections", "-fdata-sections"):
                sections.append(a)
            elif a.startswith("-O"):
                level = a[2:] or "1"
                opt = {"0": "O0", "1": "O1", "g": "O1", "2": "O2", "s": "O2", "z": "O2", "3": "O3", "fast": "O3"}.get(level, "O2")
            elif a.startswith("-flto"):
                lto = True
            elif a == "-o":
                output = args[i + 1]
                i += 2
                continue
            elif a == "-T":
                script = args[i + 1]
                i += 2
                continue
            elif a.startswith("-T") and len(a) > 2:
                script = a[2:]
            elif a.startswith("-Wl,"):
                extra_wl.extend(x for x in a[4:].split(",") if x)
            elif a.startswith("-l"):
                lib = a[2:]
                # GCC's libgcc and newlib-nano become the sysroot's libc and
                # compiler-rt; anything else (Kalico's -lm) is kept.
                if lib not in ("gcc", "c_nano", "c", "nosys", "g_nano", "gcc_nano") and lib not in libs:
                    libs.append(lib)
            elif a in ("-nostdlib", "-nostartfiles", "-nodefaultlibs", "-static", "-mthumb",
                       "-fwhole-program", "-fno-use-linker-plugin", "-ggdb3", "-g", "-MD"):
                pass
            elif a.startswith(("--specs=", "-specs=")):
                # Klipper before v0.13.0 linked with --specs=nano.specs
                # --specs=nosys.specs (newlib-nano and stub syscalls); the
                # sysroot's picolibc -lc is both.
                pass
            elif a.endswith((".o", ".a", ".obj")) or (not a.startswith("-") and "." in _basename(a)):
                objects.append(a)
            elif a.startswith(("-I", "-iquote", "-D", "-std=", "-W", "-f", "-m", "-isystem")):
                if a in ("-I", "-iquote", "-isystem", "-D", "-include", "-x", "-MT", "-MF"):
                    i += 2
                    continue
            else:
                raise DriverError(f"unsupported link argument {a!r} in: {' '.join(argv)}")
            i += 1
        if not output:
            raise DriverError(f"a link without -o: {' '.join(argv)}")
        if not cpu:
            raise DriverError(f"a link without -mcpu: {' '.join(argv)}")
        lib_dir = self.sysroot.lib_dir(cpu)
        out: list[str] = ["ld.lld", "-Bstatic", "-m", "armelf", "-EL", f"-L{lib_dir}"]
        out.extend(objects)
        if script:
            out.extend(["-T", script])
        if lto and self.lto == "on":
            # What clang's driver adds for an LTO link: the fat objects' bitcode,
            # the CPU, the optimization level, and section-per-function code
            # generation so --gc-sections still works after LTO.
            out.extend(["--fat-lto-objects", f"-plugin-opt=mcpu={cpu}", f"-plugin-opt={opt}"])
            if "-ffunction-sections" in sections:
                out.append("-plugin-opt=-function-sections=1")
            if "-fdata-sections" in sections:
                out.append("-plugin-opt=-data-sections=1")
        wl = list(extra_wl)
        if "--print-memory-usage" not in wl:
            wl.append("--print-memory-usage")
        out.extend(wl)
        out.extend(f"-l{lib}" for lib in self.sysroot.libs)
        out.extend(f"-l{lib}" for lib in libs)
        # Keep every __visible symbol of the generated code through LTO's
        # internalization: without this, LTO may drop the vector table.
        for sym in self._visible_symbols(objects, tree):
            if sym not in wl:
                out.extend(["-u", sym])
        if lto and self.lto == "on" and tree is not None:
            # Katapult's reset entry is a top-level asm block that reaches its
            # C continuation with a narrow Thumb `b` (2 KB of range). GNU ld
            # happens to lay the two next to each other; lld's LTO output
            # does not, so the two sections are ordered first explicitly.
            order = Path(tree) / "out" / "webflash-symbol-order.txt"
            order.parent.mkdir(parents=True, exist_ok=True)
            order.write_bytes(b"ResetHandler\nreset_handler_stage_two\n")
            out.extend(["--symbol-ordering-file=out/webflash-symbol-order.txt", "--no-warn-symbol-ordering"])
        if not any(w in ("-e", "--entry") or w.startswith("--entry=") or (w.startswith("-e") and len(w) > 2)
                   for w in wl):
            # The projects' linker scripts name no entry: GNU ld then takes
            # the start of .text without a word, while lld looks for _start
            # and warns on every link. Every armcm_boot.c defines
            # ResetHandler, which the vector table keeps anyway, so the
            # images do not change; only the ELF header's entry does.
            out.append("--entry=ResetHandler")
        out.extend(["--target2=rel", "-o", output])
        cmd = Command("ld.lld", out, "link", list(argv))
        cmd.cpu = cpu
        return cmd

    @staticmethod
    def _visible_symbols(objects: list[str], tree: Optional[Path]) -> list[str]:
        syms: list[str] = []
        for obj in objects:
            if not obj.endswith(".o"):
                continue
            base = _basename(obj)
            if base in ("compile_time_request.o", "deployer_ctr.o"):
                c_file = obj[:-2] + ".c"
                path = Path(c_file) if Path(c_file).is_absolute() or tree is None else Path(tree) / c_file
                for s in visible_symbols(path):
                    if s not in syms:
                        syms.append(s)
        return syms or ["VectorTable"]

    # ── Inputs and outputs ────────────────────────────────────────────

    @staticmethod
    def _fill_files(cmd: Command) -> None:
        """Which tree files the command reads and writes, from its arguments:
        the files it names, and for ``-o`` the output (plus the ``.d`` that
        ``-MD`` writes beside it)."""
        argv = cmd.argv
        inputs: list[str] = []
        outputs: list[str] = []
        include_dirs: list[str] = []
        i = 1
        while i < len(argv):
            a = argv[i]
            if a == "-o":
                if i + 1 < len(argv):
                    outputs.append(_posix(argv[i + 1]))
                i += 2
                continue
            if a in ("-I", "-iquote", "-isystem"):
                if i + 1 < len(argv):
                    include_dirs.append(_posix(argv[i + 1]))
                i += 2
                continue
            if a.startswith(("-I", "-iquote")) and len(a) > 2:
                include_dirs.append(_posix(a[2:] if a.startswith("-I") else a[7:]))
                i += 1
                continue
            if a == "-T" and i + 1 < len(argv):
                inputs.append(_posix(argv[i + 1]))
                i += 2
                continue
            if a.startswith("--script="):
                inputs.append(_posix(a[len("--script="):]))
                i += 1
                continue
            if a.startswith("--symbol-ordering-file="):
                inputs.append(_posix(a.split("=", 1)[1]))
                i += 1
                continue
            if a in ("-D", "-x", "-MT", "-MF", "-u", "-L", "-m", "-j", "-O", "-R", "-include",
                     "--add-section", "--rename-section", "--set-section-flags", "--only-section"):
                i += 2
                continue
            if not a.startswith("-") and "." in _basename(a):
                inputs.append(_posix(a))
            i += 1
        if cmd.kind == "objcopy" and len(inputs) >= 2:
            outputs.append(inputs.pop())
        if cmd.kind in ("compile", "assemble") and "-MD" in argv:
            for o in list(outputs):
                if o.endswith(".o"):
                    outputs.append(o[:-2] + ".d")
        cmd.inputs = [p for p in inputs if p not in outputs]
        cmd.outputs = outputs
        cmd.include_dirs = include_dirs  # type: ignore[attr-defined]
