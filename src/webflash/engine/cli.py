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

from .kconfig import Session, detect_project
from .make import Evaluator, MakeError, run_sync
from .shell import Shell, ShellError

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


def make_check(tree: Path, config_text: str, *, make_exe: str, gcc_dir: Optional[Path],
               goals: Optional[list[str]] = None, version: str = "?") -> tuple[list[str], int]:
    """Compare the interpreter with GNU make on one configuration. Returns
    the unified diff (empty when identical) and the number of lines compared."""
    goals = goals or ["all"]
    session = Session(tree, version=version)
    warnings = session.load(config_text)
    for w in warnings:
        print(f"Warning: {w}", file=sys.stderr)
    session.write_config()
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
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args) or 0)


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
