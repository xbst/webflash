"""The maintainer subcommands: ``webflash build``, ``make-check``, ``inspect``
and ``parity`` (SPEC 9.7). ``webflash.cli`` hands them the whole argument
list starting with the command name; ``main`` returns the exit code.
"""
from __future__ import annotations

import argparse
import difflib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Optional

if sys.version_info >= (3, 11):
    import tomllib
else:  # pragma: no cover
    try:
        import tomllib
    except ModuleNotFoundError:
        import tomli as tomllib  # type: ignore[no-redef]

from .build import Build, BuildError
from .driver import DriverError
from .kconfig import Session, detect_project
from .make import Evaluator, MakeError, run_sync
from .shell import Shell, ShellError
from .toolchain import NativeToolchain, WasmNodeToolchain

DEFAULT_MATRIX = Path(__file__).resolve().parents[3] / "tools" / "parity" / "matrix.toml"

# Variables of the environment that would change what make does; the
# comparison runs both sides without them.
_MAKE_ENV_BLOCK = {
    "MAKEFLAGS", "MFLAGS", "MAKELEVEL", "MAKE", "MAKEOVERRIDES", "MAKE_TERMOUT", "MAKE_TERMERR",
    "V", "OUT", "KCONFIG_CONFIG", "KCONFIG_AUTOHEADER", "CROSS_PREFIX", "CC", "CPP", "AS", "LD",
    "OBJCOPY", "OBJDUMP", "STRIP", "PYTHON", "CFLAGS", "EXTRA_CFLAGS", "NOSUDO", "FLASH_DEVICE",
    "srctree",
}


def _error(message: object) -> int:
    for line in str(message).splitlines() or [""]:
        print(f"Error: {line}", file=sys.stderr)
    return 1


# ── The matrix ───────────────────────────────────────────────────────

def load_matrix(path: Path) -> list[dict]:
    """The rows of ``matrix.toml``: ``name``, ``projects``, ``defconfig``, ``why``."""
    try:
        data = tomllib.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as e:
        raise ValueError(f"cannot read the matrix {path}: {e}") from None
    rows = data.get("row")
    if not isinstance(rows, list) or not rows:
        raise ValueError(f"{path}: no [[row]] tables")
    out = []
    for i, row in enumerate(rows, 1):
        for key in ("name", "projects", "defconfig"):
            if key not in row:
                raise ValueError(f"{path}: [[row]] #{i} has no '{key}'")
        out.append({"name": row["name"], "projects": list(row["projects"]),
                    "defconfig": row["defconfig"], "why": row.get("why", "")})
    return out


def matrix_rows(path: Path, project: str, names: Optional[list[str]] = None) -> list[dict]:
    rows = [r for r in load_matrix(path) if project in r["projects"]]
    if names:
        wanted = set(names)
        rows = [r for r in rows if r["name"] in wanted]
        missing = wanted - {r["name"] for r in rows}
        if missing:
            raise ValueError(f"no row named {', '.join(sorted(missing))} for {project} in {path}")
    return rows


# ── make-check ───────────────────────────────────────────────────────

def _normalize_lines(lines: list[str], make_exe: str, substitutions: Optional[dict[str, str]] = None) -> list[str]:
    """Make's stdout as compared: its own messages dropped, the make binary's
    path reduced to ``make``, whitespace collapsed, tool names substituted."""
    make_names = {make_exe, make_exe.replace("\\", "/"), os.path.basename(make_exe)}
    resolved = shutil.which(make_exe)
    if resolved:
        make_names.update({resolved, resolved.replace("\\", "/")})
    out = []
    for raw in lines:
        line = raw.rstrip("\r\n")
        if line.startswith("make[") or line.startswith("make:"):
            continue
        for name in sorted(make_names, key=len, reverse=True):
            if name and name in line:
                line = line.replace(name, "make")
        line = re.sub(r"\bmake\.exe\b", "make", line)
        words = line.split()
        if substitutions:
            words = [substitutions.get(w, w) for w in words]
        out.append(" ".join(words))
    return out


def run_real_make(tree: Path, make_exe: str, goals: list[str], gcc_dir: Optional[Path],
                  extra: Optional[list[str]] = None) -> list[str]:
    """``make -n V=1 <goals>`` in the tree with a clean environment, returning
    its stdout lines. ``gcc_dir`` goes in front of PATH so the Makefile's
    ``cc-option`` probe finds the compiler, as it does on a developer's machine."""
    env = {k: v for k, v in os.environ.items() if k not in _MAKE_ENV_BLOCK}
    path = env.get("PATH", "")
    if gcc_dir is not None:
        path = str(Path(gcc_dir)) + os.pathsep + path
    if sys.platform == "win32":
        sh = shutil.which("sh")
        if sh:
            path = str(Path(sh).parent) + os.pathsep + path
    env["PATH"] = path
    cmd = [make_exe, "-n", "V=1", *(extra or []), *goals]
    try:
        proc = subprocess.run(cmd, cwd=str(tree), env=env, capture_output=True, text=True,
                              encoding="utf-8", errors="replace")
    except OSError as e:
        raise RuntimeError(f"cannot run {make_exe}: {e}") from None
    if proc.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd)} failed ({proc.returncode}):\n{proc.stderr.strip()}")
    return proc.stdout.splitlines()


def probe_cc_option(cc: str, flag: str) -> bool:
    """What the Makefiles' ``cc-option`` probe finds on this machine: whether
    ``cc`` exists and accepts ``flag`` without a word on stderr. Klipper probes
    the host ``gcc`` (``CROSS_PREFIX`` is set only after ``CFLAGS``), so the
    answer depends on the machine, as it does for GNU make."""
    exe = shutil.which(cc)
    if exe is None:
        return False
    try:
        proc = subprocess.run([exe, flag, "-S", "-o", os.devnull, "-xc", os.devnull],
                              capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.SubprocessError):
        return False
    return not (proc.stdout + proc.stderr).strip()


def interpreter_dry_run(tree: Path, goals: list[str], env: Optional[dict[str, str]] = None,
                        cc_option=None) -> list[str]:
    """The interpreter's ``make -n V=1 <goals>`` on the tree."""
    shell = Shell(tree, cc_option=cc_option)
    ev = Evaluator(tree, shell, command_line={"V": "1"}, env=env or {})
    return run_sync(ev.dry_run(goals))


def _fresh_out(tree: Path) -> None:
    out = tree / "out"
    if out.exists():
        shutil.rmtree(out)


def olddefconfig_check(tree: Path, config_text: str, session: Session) -> list[str]:
    """Run the tree's own ``olddefconfig.py`` (what ``make olddefconfig`` runs)
    on the configuration in a real interpreter and diff its ``.config``
    against the session's; empty when identical."""
    check = tree / "out" / ".webflash.olddefconfig"
    check.parent.mkdir(parents=True, exist_ok=True)
    check.write_bytes(config_text.encode("utf-8"))
    env = {k: v for k, v in os.environ.items() if k not in _MAKE_ENV_BLOCK}
    env["KCONFIG_CONFIG"] = str(check)
    proc = subprocess.run([sys.executable, "-E", "-s", "lib/kconfiglib/olddefconfig.py", "src/Kconfig"],
                          cwd=str(tree), env=env, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"olddefconfig.py failed:\n{proc.stderr.strip()}")
    # KATAPULT_VERSION comes from $(shell, ./scripts/make-version.sh), which
    # the session answers with the snapshot's version while the raw script
    # gives whatever this machine's shell and git say: not compared.
    theirs = [l for l in check.read_text(encoding="utf-8").splitlines() if "KATAPULT_VERSION" not in l]
    mine = [l for l in session.config_text().splitlines() if "KATAPULT_VERSION" not in l]
    return list(difflib.unified_diff(theirs, mine, "olddefconfig.py", "kconfig.Session", lineterm="", n=1))


def make_check(tree: Path, config_text: str, *, make_exe: str, gcc_dir: Optional[Path],
               goals: Optional[list[str]] = None, version: str = "?") -> tuple[list[str], int]:
    """Compare the interpreter with GNU make on one configuration, and the
    Kconfig session with ``olddefconfig.py``. Returns the unified diff (empty
    when identical) and the number of make lines compared."""
    goals = goals or ["all"]
    session = Session(tree, version=version)
    warnings = session.load(config_text)
    for w in warnings:
        print(f"Warning: {w}", file=sys.stderr)
    session.write_config()
    kconfig_diff = olddefconfig_check(tree, config_text, session)
    if kconfig_diff:
        return kconfig_diff, 0
    _fresh_out(tree)
    theirs = _normalize_lines(run_real_make(tree, make_exe, goals, gcc_dir), make_exe)
    _fresh_out(tree)
    # The interpreter answers the cc-option probe the way this machine would,
    # so the comparison tests the interpreter and not the host compiler.
    path = os.environ.get("PATH", "")
    if gcc_dir is not None:
        path = str(Path(gcc_dir)) + os.pathsep + path
    old_path = os.environ.get("PATH")
    os.environ["PATH"] = path
    try:
        mine = _normalize_lines(interpreter_dry_run(tree, goals, env={"PATH": path}, cc_option=probe_cc_option),
                                make_exe)
    finally:
        os.environ["PATH"] = old_path or ""
    diff = list(difflib.unified_diff(theirs, mine, "make -n V=1", "webflash", lineterm="", n=2))
    return diff, len(theirs)


def cmd_make_check(args: argparse.Namespace) -> int:
    tree = Path(args.tree).resolve()
    if not (tree / "Makefile").is_file():
        return _error(f"not a source tree (no Makefile): {tree}")
    project = args.project or detect_project(tree)
    goals = args.goal or ["all"]
    try:
        if args.config:
            configs = [(Path(args.config).stem, Path(args.config).read_text(encoding="utf-8"))]
        else:
            rows = matrix_rows(Path(args.matrix), project, args.row)
            configs = [(r["name"], r["defconfig"]) for r in rows]
    except (OSError, ValueError) as e:
        return _error(e)
    if not configs:
        return _error(f"no matrix row applies to {project}")
    failed = 0
    for name, text in configs:
        try:
            diff, count = make_check(tree, text, make_exe=args.make, gcc_dir=args.gcc_dir, goals=goals)
        except (MakeError, ShellError, RuntimeError, OSError) as e:
            print(f"{project} {name}: ERROR {e}")
            failed += 1
            continue
        if diff:
            failed += 1
            print(f"{project} {name}: DIFFERENT")
            print("\n".join(diff))
        else:
            print(f"{project} {name}: identical ({count} lines)")
    return 1 if failed else 0


# ── build ────────────────────────────────────────────────────────────

def git_describe(tree: Path) -> str:
    """``git describe --always --tags --long --dirty`` of a tree, or ``?``."""
    try:
        proc = subprocess.run(["git", "-C", str(tree), "describe", "--always", "--tags", "--long", "--dirty"],
                              capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.SubprocessError):
        return "?"
    return proc.stdout.strip() or "?"


def _bindir(path: Path) -> Path:
    path = Path(path)
    return path / "bin" if (path / "bin").is_dir() else path


def make_toolchain(name: str, toolchain_dir: Optional[Path], jobs: int):
    """A toolchain backend by its command-line name."""
    if name == "gcc":
        if toolchain_dir is None:
            exe = shutil.which("arm-none-eabi-gcc")
            if exe is None:
                raise DriverError("--toolchain-dir is needed: arm-none-eabi-gcc is not on PATH")
            toolchain_dir = Path(exe).parent
        return NativeToolchain("gcc", _bindir(toolchain_dir), jobs=jobs)
    if name == "clang-native":
        if toolchain_dir is None:
            exe = shutil.which("clang")
            if exe is None:
                raise DriverError("--toolchain-dir is needed: clang is not on PATH")
            toolchain_dir = Path(exe).parent
        return NativeToolchain("clang", _bindir(toolchain_dir), jobs=jobs)
    if name == "wasm-node":
        if toolchain_dir is None:
            raise DriverError("--toolchain-dir is needed: the unpacked toolchain release")
        return WasmNodeToolchain(toolchain_dir, jobs=jobs)
    raise DriverError(f"unknown toolchain {name!r}")


def _size(n: int) -> str:
    return f"{n:,} bytes"


def print_memory(memory: Optional[dict]) -> None:
    if not memory:
        return
    print("Memory:")
    for region, use in memory.items():
        pct = 100.0 * use["used"] / use["size"] if use["size"] else 0.0
        print(f"  {region:>6}: {use['used']:>9,} of {use['size']:>9,} bytes ({pct:.1f}%)")


def cmd_build(args: argparse.Namespace) -> int:
    tree = Path(args.tree).resolve()
    if not (tree / "Makefile").is_file():
        return _error(f"not a source tree (no Makefile): {tree}")
    try:
        config_text = Path(args.config).read_text(encoding="utf-8")
    except OSError as e:
        return _error(e)
    version = args.version or git_describe(tree)
    try:
        toolchain = make_toolchain(args.toolchain, args.toolchain_dir, args.jobs)
    except DriverError as e:
        return _error(e)
    build = Build(tree, config_text, toolchain=toolchain, version=version, jobs=args.jobs, lto=args.lto,
                  log=(lambda line: print(line)) if args.verbose else None,
                  trace=(lambda argv: print("$ " + " ".join(argv))) if args.verbose else None)
    started = time.perf_counter()
    try:
        result = build.run()
    except (BuildError, MakeError, ShellError, DriverError, ValueError) as e:
        if not args.verbose:
            print("\n".join(build.log_lines))
        return _error(e)
    finally:
        close = getattr(toolchain, "close", None)
        if close is not None:
            run_sync(close())
    if not args.verbose:
        for line in result.log.splitlines():
            if line.startswith("  ") or line.startswith("Version:"):
                print(line)
    print_memory(result.memory)
    print("Outputs:")
    for name, data in result.outputs.items():
        print(f"  {name}: {_size(len(data))}")
    if args.out:
        out_dir = Path(args.out)
        out_dir.mkdir(parents=True, exist_ok=True)
        for name, data in result.outputs.items():
            (out_dir / name).write_bytes(data)
        print(f"Copied to {out_dir}")
    print(f"Built {result.project} {result.version} with {toolchain.name} in {time.perf_counter() - started:.1f} s")
    return 0


# ── inspect ──────────────────────────────────────────────────────────

def cmd_inspect(args: argparse.Namespace) -> int:
    from .inspect import InspectError, format_report, inspect
    try:
        info = inspect(Path(args.file), Path(args.ld) if args.ld else None)
    except (OSError, InspectError, ValueError) as e:
        return _error(e)
    if args.json:
        safe = {k: v for k, v in info.items() if k != "data"}
        print(json.dumps(safe, indent=1, default=str))
    else:
        print(format_report(info))
    return 0


# ── parity ───────────────────────────────────────────────────────────

VARIANTS = {
    "gcc": ("gcc", "on"),
    "clang-native": ("clang-native", "on"),
    "clang-native-nolto": ("clang-native", "off"),
    "wasm-node": ("wasm-node", "on"),
    "wasm-node-nolto": ("wasm-node", "off"),
}


def _variant_dir(name: str, args: argparse.Namespace) -> Optional[Path]:
    backend = VARIANTS[name][0]
    return {"gcc": args.gcc_dir, "clang-native": args.clang_dir, "wasm-node": args.wasm_dir}[backend]


def _dict_core(data: bytes) -> dict:
    """A ``klipper.dict`` as the parity check compares it: without
    ``build_versions``, and with the message ids reduced to the sets of
    messages. ``buildcommands.py`` numbers the commands, responses and static
    strings in the order the compiler laid the ``.compile_time_request``
    strings out, and clang orders them differently from GCC; the host reads
    the numbering from the firmware's own dictionary, so the firmware is
    equivalent even though the numbers differ."""
    d = json.loads(data.decode("utf-8"))
    d.pop("build_versions", None)
    for key in ("commands", "responses", "output"):
        if isinstance(d.get(key), dict):
            d[key] = sorted(d[key])
    enums = d.get("enumerations")
    if isinstance(enums, dict) and isinstance(enums.get("static_string_id"), dict):
        # The strings of shutdown() calls the compiler kept: a branch one
        # compiler proves dead drops its string; compared as a subset below.
        d["static_strings"] = sorted(enums.pop("static_string_id"))
    return d


def dicts_equivalent(base: Optional[dict], other: Optional[dict]) -> bool:
    """Whether two normalized dictionaries describe the same firmware: equal
    apart from the static strings, which may be a subset of the base's. A
    project without a dictionary (Katapult) compares equal to itself."""
    if base is None or other is None:
        return base is None and other is None
    a = dict(base)
    b = dict(other)
    strings_a = set(a.pop("static_strings", []))
    strings_b = set(b.pop("static_strings", []))
    return a == b and strings_b <= strings_a


def build_row(tree: Path, row: dict, variant: str, toolchain, version: str, jobs: int) -> dict:
    """Build one row with one toolchain variant and measure the result."""
    from .inspect import elf_sizes, linker_memory, parse_elf, vector_table
    backend, lto = VARIANTS[variant]
    build = Build(tree, row["defconfig"], toolchain=toolchain, version=version, jobs=jobs, lto=lto)
    started = time.perf_counter()
    result = build.run()
    elapsed = time.perf_counter() - started
    elf_name = next((n for n in result.outputs if n.endswith(".elf") and not n.startswith("deployer")), None)
    info: dict = {"row": row["name"], "variant": variant, "seconds": elapsed, "outputs": {n: len(b) for n, b in result.outputs.items()},
                  "memory": result.memory, "dict": None, "sizes": None, "vector_table": None, "regions": {}}
    if elf_name:
        elf = parse_elf(result.outputs[elf_name])
        info["sizes"] = elf_sizes(elf)
        info["vector_table"] = vector_table(elf, result.outputs[elf_name])
        info["elf"] = elf_name
    # The regions of the linker script the main ELF was linked with (Katapult
    # has a second script for the deployer).
    scripts = []
    for command in result.commands:
        if elf_name and "-o" in command and command[command.index("-o") + 1].endswith(elf_name) and "-T" in command:
            scripts.append(command[command.index("-T") + 1])
    for ld in scripts + [str(p) for p in sorted((tree / "out").glob("src/*/*.ld"))]:
        path = Path(ld) if Path(ld).is_absolute() else tree / ld
        if not path.is_file():
            continue
        regions = linker_memory(path.read_text(encoding="utf-8", errors="replace"))
        if regions and ("rom" in regions or "ram" in regions):
            info["regions"] = regions
            break
    dict_name = next((n for n in result.outputs if n.endswith(".dict")), None)
    if dict_name:
        info["dict"] = _dict_core(result.outputs[dict_name])
    info["result"] = result
    return info


def check_parity(rows: list[dict], builds: dict[tuple[str, str], dict], variants: list[str]) -> list[str]:
    """The failures of SPEC 9.7's rules over the builds (empty when all pass)."""
    failures: list[str] = []
    for row in rows:
        name = row["name"]
        base = builds.get((name, variants[0]))
        for variant in variants:
            b = builds.get((name, variant))
            if b is None or "error" in b:
                failures.append(f"{name}/{variant}: build failed: {b.get('error') if b else 'missing'}")
                continue
            regions = b["regions"]
            vt = b["vector_table"]
            sizes = b["sizes"]
            rom = regions.get("rom")
            ram = regions.get("ram")
            if vt is None:
                failures.append(f"{name}/{variant}: no vector table found")
            else:
                if ram and not (ram["origin"] < vt["stack"] <= ram["origin"] + ram["length"]):
                    failures.append(f"{name}/{variant}: stack 0x{vt['stack']:08x} is outside RAM")
                if not vt["reset"] & 1:
                    failures.append(f"{name}/{variant}: reset vector 0x{vt['reset']:08x} is not a Thumb address")
                if rom and not (rom["origin"] <= vt["reset"] < rom["origin"] + rom["length"]):
                    failures.append(f"{name}/{variant}: reset vector 0x{vt['reset']:08x} is outside flash")
            if rom and sizes and sizes["flash"] > rom["length"]:
                failures.append(f"{name}/{variant}: flash image {sizes['flash']} exceeds the {rom['length']} byte region")
            if base is not None and "error" not in base and b is not base:
                if not dicts_equivalent(base["dict"], b["dict"]):
                    failures.append(f"{name}/{variant}: the dictionary differs from {variants[0]}'s")
                if base["vector_table"] and vt and base["vector_table"]["stack"] != vt["stack"]:
                    failures.append(f"{name}/{variant}: initial stack differs from {variants[0]}'s")
    return failures


def parity_table(rows: list[dict], builds: dict[tuple[str, str], dict], variants: list[str]) -> str:
    lines = ["| Row | Toolchain | text | data | bss | flash used / size | vs " + variants[0] + " | dict | stack / reset |",
             "|---|---|---:|---:|---:|---:|---:|---|---|"]
    for row in rows:
        name = row["name"]
        base = builds.get((name, variants[0]))
        for variant in variants:
            b = builds.get((name, variant))
            if b is None or "error" in b:
                lines.append(f"| {name} | {variant} | | | | | | failed | {b.get('error', '')[:60] if b else ''} |")
                continue
            s = b["sizes"] or {}
            rom = b["regions"].get("rom")
            flash = f"{s.get('flash', 0):,} / {rom['length']:,}" if rom else f"{s.get('flash', 0):,}"
            delta = ""
            if base and "error" not in base and base is not b and base["sizes"]:
                d = s.get("flash", 0) - base["sizes"]["flash"]
                delta = f"{d:+,} ({100.0 * d / base['sizes']['flash']:+.1f}%)" if base["sizes"]["flash"] else f"{d:+,}"
            if b["dict"] is None:
                dict_ok = "none"
            else:
                dict_ok = "same" if (base is None or base is b or dicts_equivalent(base["dict"], b["dict"])) else "DIFFERS"
            vt = b["vector_table"] or {}
            vt_text = f"0x{vt['stack']:08x} / 0x{vt['reset']:08x}" if vt else ""
            lines.append(f"| {name} | {variant} | {s.get('text', 0):,} | {s.get('data', 0):,} | {s.get('bss', 0):,} | "
                         f"{flash} | {delta} | {dict_ok} | {vt_text} |")
    return "\n".join(lines)


def cmd_parity(args: argparse.Namespace) -> int:
    tree = Path(args.tree).resolve()
    if not (tree / "Makefile").is_file():
        return _error(f"not a source tree (no Makefile): {tree}")
    project = args.project or detect_project(tree)
    variants = [v.strip() for v in args.toolchains.split(",") if v.strip()]
    for v in variants:
        if v not in VARIANTS:
            return _error(f"unknown toolchain {v!r} (choose from {', '.join(VARIANTS)})")
    try:
        rows = matrix_rows(Path(args.matrix), project, args.row)
    except (OSError, ValueError) as e:
        return _error(e)
    if not rows:
        return _error(f"no matrix row applies to {project}")
    version = args.version or git_describe(tree)
    toolchains = {}
    try:
        for v in variants:
            backend = VARIANTS[v][0]
            if backend not in toolchains:
                toolchains[backend] = make_toolchain(backend, _variant_dir(v, args), args.jobs)
    except DriverError as e:
        return _error(e)
    builds: dict[tuple[str, str], dict] = {}
    try:
        for row in rows:
            for v in variants:
                backend = VARIANTS[v][0]
                label = f"{project} {row['name']} {v}"
                try:
                    info = build_row(tree, row, v, toolchains[backend], version, args.jobs)
                except (BuildError, MakeError, ShellError, DriverError, ValueError, OSError) as e:
                    builds[(row["name"], v)] = {"row": row["name"], "variant": v, "error": str(e)}
                    print(f"{label}: FAILED\n{e}")
                    continue
                builds[(row["name"], v)] = info
                s = info["sizes"] or {}
                print(f"{label}: flash {s.get('flash', 0):,} bytes in {info['seconds']:.1f} s")
                if args.out:
                    out_dir = Path(args.out) / project / row["name"] / v
                    out_dir.mkdir(parents=True, exist_ok=True)
                    for n, data in info["result"].outputs.items():
                        (out_dir / n).write_bytes(data)
    finally:
        for tc in toolchains.values():
            close = getattr(tc, "close", None)
            if close is not None:
                run_sync(close())
    table = parity_table(rows, builds, variants)
    failures = check_parity(rows, builds, variants)
    print()
    print(table)
    if args.table:
        path = Path(args.table)
        path.parent.mkdir(parents=True, exist_ok=True)
        header = f"# Parity: {project} {version}\n\nToolchains: {', '.join(variants)}.\n\n"
        with open(path, "a" if args.append else "w", encoding="utf-8", newline="\n") as f:
            f.write(header + table + "\n\n")
            if failures:
                f.write("Failures:\n\n" + "\n".join(f"- {x}" for x in failures) + "\n\n")
    if args.json:
        data = {key[0] + "/" + key[1]: {k: v for k, v in b.items() if k != "result"} for key, b in builds.items()}
        Path(args.json).write_text(json.dumps({"project": project, "version": version, "builds": data,
                                               "failures": failures}, indent=1, default=str) + "\n", encoding="utf-8")
    if failures:
        print("\nFailures:")
        for x in failures:
            print(f"  {x}")
        return 1
    print(f"\nParity: {len(rows)} rows x {len(variants)} toolchains passed")
    return 0


# ── Parser ───────────────────────────────────────────────────────────

def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="webflash", description="WebFlash maintainer commands.")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("make-check", help="compare the make interpreter with GNU make on a tree")
    p.add_argument("tree", help="a Klipper, Kalico or Katapult source tree")
    p.add_argument("--config", help="a .config or defconfig to check (default: the matrix rows)")
    p.add_argument("--matrix", default=str(DEFAULT_MATRIX), help="the parity matrix (tools/parity/matrix.toml)")
    p.add_argument("--row", action="append", help="only this matrix row (repeatable)")
    p.add_argument("--project", choices=("klipper", "kalico", "katapult"), help="which project the tree is (default: detected)")
    p.add_argument("--make", default="make", help="the GNU make to run (default: make)")
    p.add_argument("--gcc-dir", type=Path, help="the arm-none-eabi-gcc bin directory, put in front of PATH for make")
    p.add_argument("--goal", action="append", help="the goal to dry-run (default: all; repeatable)")
    p.set_defaults(func=cmd_make_check)

    p = sub.add_parser("build", help="build a firmware natively with the engine and a toolchain")
    p.add_argument("tree", help="a Klipper, Kalico or Katapult source tree")
    p.add_argument("--config", required=True, help="a .config or defconfig")
    p.add_argument("--toolchain", required=True, choices=("gcc", "clang-native", "wasm-node"))
    p.add_argument("--toolchain-dir", type=Path, help="the toolchain's folder (its bin/, or an unpacked release)")
    p.add_argument("--version", help="the version the firmware reports (default: git describe)")
    p.add_argument("-j", "--jobs", type=int, default=max(1, (os.cpu_count() or 2) - 1), help="compiles at once")
    p.add_argument("--out", help="copy the outputs to this folder")
    p.add_argument("--lto", choices=("on", "off"), default="on", help="link-time optimization (default: on)")
    p.add_argument("-v", "--verbose", action="store_true", help="print every command and its output")
    p.set_defaults(func=cmd_build)

    p = sub.add_parser("inspect", help="show a firmware file's sections, sizes and vector table")
    p.add_argument("file", help="an .elf, .bin, .hex or .uf2 file (a .dict beside an ELF is read too)")
    p.add_argument("--ld", help="the preprocessed linker script, for the memory regions")
    p.add_argument("--json", action="store_true", help="print JSON instead of the report")
    p.set_defaults(func=cmd_inspect)

    p = sub.add_parser("parity", help="build the parity matrix with several toolchains and compare")
    p.add_argument("tree", help="a Klipper, Kalico or Katapult source tree")
    p.add_argument("--matrix", default=str(DEFAULT_MATRIX), help="the parity matrix (tools/parity/matrix.toml)")
    p.add_argument("--row", action="append", help="only this matrix row (repeatable)")
    p.add_argument("--project", choices=("klipper", "kalico", "katapult"), help="which project the tree is (default: detected)")
    p.add_argument("--toolchains", default="gcc,clang-native", help=f"comma-separated, from {', '.join(VARIANTS)}")
    p.add_argument("--gcc-dir", type=Path, help="the Arm GNU Toolchain (its bin/ or its root)")
    p.add_argument("--clang-dir", type=Path, help="Arm Toolchain for Embedded (its bin/ or its root)")
    p.add_argument("--wasm-dir", type=Path, help="an unpacked webflash-toolchain release, for wasm-node")
    p.add_argument("--version", help="the version every build reports (default: git describe)")
    p.add_argument("-j", "--jobs", type=int, default=max(1, (os.cpu_count() or 2) - 1), help="compiles at once")
    p.add_argument("--out", help="keep every build's outputs under this folder")
    p.add_argument("--table", help="write the Markdown table to this file")
    p.add_argument("--append", action="store_true", help="append to --table instead of replacing it")
    p.add_argument("--json", help="write every measurement as JSON to this file")
    p.set_defaults(func=cmd_parity)
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args) or 0)


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
