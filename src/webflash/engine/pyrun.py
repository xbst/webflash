"""Running the project's own Python scripts in process.

``scripts/buildcommands.py``, kconfiglib's ``genconfig.py``,
``olddefconfig.py`` and ``savedefconfig.py``, pico-sdk's ``pad_checksum`` and
Katapult's ``buildbinary.py`` are run as ``__main__`` inside this interpreter,
with ``sys.argv``, the working directory, the environment and ``sys.path[0]``
set for the call and restored after, their stdout and stderr captured and a
``SystemExit`` turned into an exit code. The browser has no processes, so this
is the only way to run them under Pyodide; CPython uses the same path so CI
and the browser agree.

``subprocess`` is unavailable under Pyodide. The scripts reach it only through
``buildcommands.py``'s ``check_output`` (``<tool> --version``, ``git
describe``, ``cat klippy/.version``), so :class:`PyRunner` installs a
``subprocess.Popen`` shim for the duration of a run that answers those three
shapes and refuses anything else.
"""
from __future__ import annotations

import contextlib
import io
import os
import runpy
import shlex
import subprocess
import sys
import traceback
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

from .shell import ShellError


@dataclass
class ScriptResult:
    code: int
    stdout: str
    stderr: str


# The real Popen, for the toolchain backends to run processes while a
# script runs with the shim installed.
_REAL_POPEN = subprocess.Popen


def real_output(argv: list[str], timeout: float = 60) -> str:
    """Run a real process and return its stdout (CPython only)."""
    proc = _REAL_POPEN(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    out, _err = proc.communicate(timeout=timeout)
    return out.decode("utf-8", errors="replace")


class _FakePopen:
    """What ``buildcommands.py``'s ``check_output`` needs of ``Popen``: the
    output and the return code of one of three commands."""

    def __init__(self, runner: "PyRunner", args, *_a, **_kw) -> None:
        if isinstance(args, str):
            args = shlex.split(args)
        args = [str(a) for a in args]
        self.returncode: Optional[int] = None
        self._output = runner.answer(args)

    def communicate(self, *_a, **_kw):
        self.returncode = 0
        return self._output.encode("utf-8"), b""

    def poll(self):
        return self.returncode

    def wait(self, *_a, **_kw):
        self.returncode = 0
        return 0


class TreeModules:
    """Modules imported from a source tree (``kconfiglib``, ``msgproto``),
    kept between runs because importing them takes a moment, but dropped when
    another tree's script runs, so two projects in one process never share a
    module. One registry serves every runner and Kconfig session."""

    def __init__(self) -> None:
        self._modules: dict[str, list[str]] = {}
        self._current: Optional[str] = None

    @staticmethod
    def key(tree: Path) -> str:
        return os.path.normcase(str(Path(tree).resolve()))

    def switch(self, tree: Path) -> str:
        key = self.key(tree)
        if self._current != key:
            for other, names in self._modules.items():
                if other != key:
                    for name in names:
                        sys.modules.pop(name, None)
                    names.clear()
            self._current = key
        return key

    def record(self, tree_key: str, before: set[str]) -> None:
        names = self._modules.setdefault(tree_key, [])
        prefix = os.path.normcase(os.path.abspath(tree_key)) + os.sep
        for name, module in list(sys.modules.items()):
            if name in before or name == "__main__" or name in names:
                continue
            path = getattr(module, "__file__", None)
            if path and os.path.normcase(os.path.abspath(path)).startswith(prefix):
                names.append(name)

    def import_module(self, tree: Path, subdir: str, name: str):
        """Import ``name`` from ``<tree>/<subdir>`` (``kconfiglib`` from
        ``lib/kconfiglib``), the tree's own copy, never one of ours."""
        import importlib
        key = self.switch(tree)
        folder = str((Path(tree) / subdir).resolve())
        before = set(sys.modules)
        sys.path.insert(0, folder)
        try:
            module = sys.modules.get(name)
            if module is not None:
                path = getattr(module, "__file__", "") or ""
                if not os.path.normcase(os.path.abspath(path)).startswith(os.path.normcase(folder)):
                    del sys.modules[name]
                    module = None
            if module is None:
                module = importlib.import_module(name)
        finally:
            try:
                sys.path.remove(folder)
            except ValueError:
                pass
        self.record(key, before)
        return module


MODULES = TreeModules()


class PyRunner:
    """Runs the project's scripts; ``version`` answers ``git describe`` and
    ``cat klippy/.version``, ``tool_version(tool)`` answers ``<tool> --version``
    with the first line a toolchain would print."""

    def __init__(self, version: str = "?", tool_version: Optional[Callable[[str], str]] = None) -> None:
        self.version = version
        self.tool_version = tool_version

    # ── The subprocess shim ───────────────────────────────────────────

    def answer(self, args: list[str]) -> str:
        if len(args) == 2 and args[1] == "--version":
            if self.tool_version is None:
                raise ShellError(f"no toolchain to answer '{' '.join(args)}'")
            return self.tool_version(args[0]) + "\n"
        if args[:2] == ["git", "describe"]:
            return self.version + "\n"
        if args and args[0].replace("\\", "/").endswith("scripts/make-version.sh"):
            # Katapult's Kconfig asks the shell for the version (through
            # kconfiglib's $(shell,...) in genconfig.py and savedefconfig.py).
            return self.version + "\n"
        if args == ["cat", "klippy/.version"]:
            path = Path("klippy/.version")
            if path.is_file():
                return path.read_text(encoding="utf-8")
            return self.version + "\n"
        raise ShellError(f"unsupported command from a script: {' '.join(args)}")

    # ── Running ───────────────────────────────────────────────────────

    def run(self, script: str, argv: list[str], *, cwd: Path, env: dict[str, str]) -> ScriptResult:
        """Run ``script`` (relative to ``cwd``) as ``__main__`` with ``argv``."""
        cwd = Path(cwd)
        tree_key = MODULES.switch(cwd)
        script_path = cwd / script
        if not script_path.is_file():
            return ScriptResult(127, "", f"python3: can't open file '{script}': No such file or directory\n")
        script_dir = str(script_path.parent.resolve())

        out = io.StringIO()
        err = io.StringIO()
        old_argv = sys.argv
        old_path = list(sys.path)
        old_cwd = os.getcwd()
        old_environ = dict(os.environ)
        old_popen = subprocess.Popen
        old_main = sys.modules.get("__main__")
        modules_before = set(sys.modules)
        code = 0
        runner = self
        try:
            os.chdir(cwd)
            os.environ.update(env)
            sys.argv = [script, *argv]
            sys.path.insert(0, script_dir)
            subprocess.Popen = lambda args, *a, **kw: _FakePopen(runner, args, *a, **kw)  # type: ignore[assignment]
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                try:
                    # The relative name, so sys.argv[0] reads as the Makefile wrote it.
                    runpy.run_path(script, run_name="__main__")
                except SystemExit as e:
                    code = _exit_code(e.code)
                except ShellError:
                    raise
                except BaseException:  # noqa: BLE001 - the script's own failure
                    err.write(traceback.format_exc())
                    code = 1
        finally:
            subprocess.Popen = old_popen  # type: ignore[assignment]
            sys.argv = old_argv
            sys.path[:] = old_path
            os.chdir(old_cwd)
            for key in list(os.environ):
                if key not in old_environ:
                    del os.environ[key]
            os.environ.update(old_environ)
            if old_main is not None:
                sys.modules["__main__"] = old_main
            MODULES.record(tree_key, modules_before)
        return ScriptResult(code, out.getvalue(), err.getvalue())


def _exit_code(value) -> int:
    if value is None:
        return 0
    if isinstance(value, int):
        return value & 0xFF if value >= 0 else (value % 256) or 1
    return 1
