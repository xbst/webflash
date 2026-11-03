"""Toolchain backends: how one translated tool command is run.

:class:`NativeToolchain` runs subprocesses (the Arm GNU Toolchain for the
``gcc`` kind, Arm Toolchain for Embedded for ``clang``); :class:`JsToolchain`
calls a JavaScript function the page registers (the WebAssembly toolchain in
its workers) and mirrors the generated files under ``out/`` to it;
:class:`WasmNodeToolchain` runs the release's ``toolchain.js`` under Node
through ``tools/parity/wasm-node-runner.mjs``, so CI can test the real
browser toolchain headlessly. Every backend is asynchronous and runs up to
``jobs`` commands at once.
"""
from __future__ import annotations

import asyncio
import base64
import collections
import json
import os
import queue
import shutil
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Optional, Protocol

from .driver import COMPAT_DIR, Command, DriverError, Sysroot, tool_family
from .pyrun import real_output


@dataclass
class ToolResult:
    code: int
    stdout: str = ""
    stderr: str = ""
    time: float = 0.0       # seconds the tool ran
    memory: int = 0         # bytes of linear memory (WebAssembly only)


class Toolchain(Protocol):
    """What the build needs of a toolchain."""
    name: str
    kind: str            # "gcc" or "clang": which driver translates for it
    version: str         # the compiler's version, e.g. "14.3.1" or "23.1.0"
    sysroot: Optional[Sysroot]

    async def run(self, command: Command, *, cwd: Path, env: dict[str, str], links: Any = None) -> ToolResult: ...

    def tool_version(self, tool: str) -> str: ...


def synthetic_tool_version(tool: str, version: str, label: str = "webflash") -> str:
    """The ``--version`` first line reported for an LLVM-backed tool: a
    compiler line, or a ``GNU``-prefixed binutils line, consistent across the
    tools so ``buildcommands.py`` sees a clean build."""
    family = tool_family(tool) or tool
    if family in ("as", "ld", "objcopy", "objdump", "strip", "ar", "nm", "size", "readelf"):
        return f"GNU {family} llvm {version} ({label})"
    return f"{family} clang {version} ({label})"


def _exe_suffixes() -> tuple[str, ...]:
    return (".exe", "") if sys.platform == "win32" else ("",)


class _Limiter:
    """A semaphore created on first use, so a toolchain can be built outside
    an event loop."""

    def __init__(self, jobs: int) -> None:
        self.jobs = max(1, int(jobs))
        self._sem: Optional[asyncio.Semaphore] = None

    def get(self) -> asyncio.Semaphore:
        if self._sem is None:
            self._sem = asyncio.Semaphore(self.jobs)
        return self._sem


# ── Native ───────────────────────────────────────────────────────────

class NativeToolchain:
    """Subprocesses from a toolchain's ``bin`` directory (CPython only).

    ``kind`` is ``"gcc"`` (the Makefiles' own tool names are run as they are)
    or ``"clang"`` (the translated ``clang``/``ld.lld``/``llvm-*`` commands;
    the sysroot comes from the ATfE installation above ``bindir`` unless a
    manifest-style sysroot is given).
    """

    def __init__(self, kind: str, bindir: Path, *, sysroot: Optional[Sysroot] = None, jobs: int = 1,
                 label: str = "webflash") -> None:
        if kind not in ("gcc", "clang"):
            raise DriverError(f"unknown toolchain kind {kind!r}")
        self.kind = kind
        self.bindir = Path(bindir)
        if not self.bindir.is_dir():
            raise DriverError(f"not a directory: {self.bindir}")
        self.name = "gcc" if kind == "gcc" else "clang-native"
        self.label = label
        self._limit = _Limiter(jobs)
        self._exes: dict[str, str] = {}
        if kind == "clang":
            self.sysroot = sysroot or Sysroot.from_atfe(self.bindir.parent)
            self.version = self._detect_version("clang", r"clang version (\S+)")
        else:
            self.sysroot = None
            self.version = self._detect_version("arm-none-eabi-gcc", r"\) ([0-9][\w.]*)")

    def _detect_version(self, tool: str, pattern: str) -> str:
        import re
        try:
            out = real_output([self.exe(tool), "--version"])
        except (OSError, subprocess.SubprocessError, DriverError) as e:
            raise DriverError(f"cannot run {tool} from {self.bindir}: {e}") from None
        m = re.search(pattern, out.splitlines()[0] if out else "")
        return m.group(1) if m else "0"

    def exe(self, tool: str) -> str:
        """The executable for a tool name: ``<bindir>/<tool>[.exe]``, else the
        ``arm-none-eabi-`` prefixed one (the Makefiles' bare ``cpp``)."""
        if tool in self._exes:
            return self._exes[tool]
        base = os.path.basename(tool)
        candidates = [base]
        if "-" not in base:
            candidates.append("arm-none-eabi-" + base)
        for name in candidates:
            for suffix in _exe_suffixes():
                path = self.bindir / (name + suffix)
                if path.is_file():
                    self._exes[tool] = str(path)
                    return str(path)
        raise DriverError(f"{tool} is not in {self.bindir}")

    def tool_version(self, tool: str) -> str:
        if self.kind == "clang":
            return synthetic_tool_version(tool, self.version, self.label)
        try:
            out = real_output([self.exe(tool), "--version"])
        except (OSError, subprocess.SubprocessError, DriverError):
            return ""
        return out.splitlines()[0] if out else ""

    async def run(self, command: Command, *, cwd: Path, env: dict[str, str], links: Any = None) -> ToolResult:
        if command.kind == "version":
            return ToolResult(0, self.tool_version(command.tool) + "\n")
        exe = self.exe(command.tool)
        argv = [exe, *command.argv[1:]]
        run_env = dict(os.environ)
        run_env.update(env)
        run_env["PATH"] = str(self.bindir) + os.pathsep + run_env.get("PATH", "")

        def work() -> ToolResult:
            started = time.perf_counter()
            try:
                proc = subprocess.run(argv, cwd=str(cwd), env=run_env, capture_output=True, text=True,
                                      encoding="utf-8", errors="replace")
            except OSError as e:
                return ToolResult(127, "", f"cannot run {exe}: {e}\n")
            return ToolResult(proc.returncode, proc.stdout, proc.stderr, time.perf_counter() - started)

        async with self._limit.get():
            return await asyncio.get_running_loop().run_in_executor(None, work)


# ── JavaScript (Pyodide) ─────────────────────────────────────────────

def _to_py(value: Any) -> Any:
    """A JavaScript result as Python data (a no-op for Python data)."""
    if hasattr(value, "to_py"):
        value = value.to_py()
    if isinstance(value, dict):
        return {str(k): _to_py(v) for k, v in value.items()}
    if isinstance(value, memoryview):
        return value.tobytes()
    if isinstance(value, (bytearray,)):
        return bytes(value)
    if isinstance(value, list):
        return [_to_py(v) for v in value]
    return value


def _inside(path: Path, folder: Path) -> bool:
    try:
        return path.resolve().is_relative_to(folder.resolve())
    except AttributeError:  # pragma: no cover - Python 3.8
        return str(path.resolve()).startswith(str(folder.resolve()))


def job_inputs(command: Command, cwd: Path, links: Any = None) -> tuple[dict[str, bytes], dict[str, str]]:
    """The generated files a command reads, for a toolchain that holds the
    source tree already (the browser's workers): the files the command names
    under ``out/``, the generated headers and sources in the ``out/`` include
    directories it searches (the patched header copies under
    ``out/webflash-compat/`` with their subfolders, since a vendor's headers
    include ``component/x.h``), and the ``out/board`` links as symlinks.
    Everything is keyed by absolute path."""
    cwd = Path(cwd)
    out_dir = cwd / "out"
    compat_dir = cwd / COMPAT_DIR
    files: dict[str, bytes] = {}
    symlinks: dict[str, str] = {}

    def add(rel: str) -> None:
        path = cwd / rel
        if path.is_file():
            files[path.as_posix()] = path.read_bytes()

    for rel in command.inputs:
        if rel.startswith("out/") or rel.startswith("out\\") or Path(rel).is_absolute():
            add(rel)
    for inc in getattr(command, "include_dirs", []):
        inc_path = cwd / inc
        if not inc_path.is_dir() or not _inside(inc_path, out_dir):
            continue
        found = inc_path.rglob("*") if _inside(inc_path, compat_dir) else inc_path.iterdir()
        for p in sorted(found):
            if p.is_file() and p.suffix in (".h", ".hpp", ".hh", ".inc", ".c", ".S", ".s", ".ld", ".lds"):
                files[p.as_posix()] = p.read_bytes()
    if links is not None:
        for link, target in links.targets.items():
            link_path = (cwd / link).as_posix()
            target_path = target if Path(target).is_absolute() else (cwd / link).parent.joinpath(target).as_posix()
            symlinks[link_path] = str(target_path).replace("\\", "/")
    return files, symlinks


class JsToolchain:
    """The browser's toolchain workers, behind a JavaScript function.

    ``run_tool_js(spec_json, files)`` is called with ``spec_json`` =
    ``{"argv", "cwd", "env", "symlinks"}`` (``cwd`` the tree's absolute path,
    the worker mounts the source tree at the same path) and ``files`` an
    object of absolute path to bytes for the generated inputs; it returns a
    promise of ``{code, stdout, stderr, outputs, time, memory}`` with
    ``outputs`` an object or Map of absolute path to bytes, which are written
    into the tree (the ``.d`` dependency files are dropped). ``manifest`` is
    the toolchain's manifest, whose sysroot is mounted at ``/`` in the worker.
    """

    def __init__(self, run_tool_js: Callable[..., Any], manifest: dict, *, jobs: int = 1,
                 label: str = "webflash") -> None:
        self.run_tool_js = run_tool_js
        self.manifest = manifest
        self.kind = "clang"
        self.name = "wasm"
        self.label = label
        self.version = str(manifest.get("llvm", "0"))
        self.sysroot = Sysroot.from_manifest(manifest, root="/")
        self._limit = _Limiter(jobs)

    def tool_version(self, tool: str) -> str:
        return synthetic_tool_version(tool, self.version, self.label)

    async def run(self, command: Command, *, cwd: Path, env: dict[str, str], links: Any = None) -> ToolResult:
        if command.kind == "version":
            return ToolResult(0, self.tool_version(command.tool) + "\n")
        cwd = Path(cwd)
        files, symlinks = job_inputs(command, cwd, links)
        spec = {"argv": command.argv, "cwd": cwd.as_posix(), "env": dict(env), "symlinks": symlinks}
        payload = self._files_to_js(files)
        async with self._limit.get():
            started = time.perf_counter()
            result = self.run_tool_js(json.dumps(spec), payload)
            if hasattr(result, "__await__") or asyncio.isfuture(result) or asyncio.iscoroutine(result):
                result = await result
            elapsed = time.perf_counter() - started
        data = _to_py(result)
        if not isinstance(data, dict):
            data = {"code": int(getattr(result, "code", 1)), "stdout": str(getattr(result, "stdout", "")),
                    "stderr": str(getattr(result, "stderr", "")), "outputs": _to_py(getattr(result, "outputs", {}))}
        outputs = data.get("outputs") or {}
        for path, content in outputs.items():
            if str(path).endswith(".d"):
                continue
            target = Path(str(path))
            if not target.is_absolute():
                target = cwd / target
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(_to_py(content))
        return ToolResult(int(data.get("code", 1)), str(data.get("stdout", "")), str(data.get("stderr", "")),
                          float(data.get("time", elapsed * 1000)) / 1000.0, int(data.get("memory", 0) or 0))

    @staticmethod
    def _files_to_js(files: dict[str, bytes]) -> Any:
        try:
            from pyodide.ffi import to_js  # type: ignore[import-not-found]
            import js  # type: ignore[import-not-found]
        except ImportError:
            return files
        return to_js(files, dict_converter=js.Object.fromEntries)


# ── Node ─────────────────────────────────────────────────────────────

class _NodeRunner:
    """One ``wasm-node-runner.mjs`` process: a request line in, a reply line
    out. Its stderr is read on a thread of its own, so a chatty Node cannot
    fill the pipe, and the last of it explains a runner that died."""

    def __init__(self, argv: list[str]) -> None:
        try:
            self.proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        except OSError as e:
            raise DriverError(f"cannot run {argv[0]}: {e}") from None
        self._stderr: collections.deque = collections.deque(maxlen=200)
        self._reader = threading.Thread(target=self._read_stderr, daemon=True)
        self._reader.start()

    def _read_stderr(self) -> None:
        for line in iter(self.proc.stderr.readline, b""):
            self._stderr.append(line)

    def alive(self) -> bool:
        return self.proc.poll() is None

    def request(self, line: bytes) -> dict:
        try:
            self.proc.stdin.write(line)
            self.proc.stdin.flush()
            reply = self.proc.stdout.readline()
        except OSError:
            reply = b""
        if not reply:
            code = self.proc.wait()
            self._reader.join(5)
            err = b"".join(self._stderr).decode("utf-8", errors="replace").strip()
            raise DriverError(f"the Node runner exited with code {code}" + (f":\n{err}" if err else ""))
        return json.loads(reply.decode("utf-8"))

    def close(self) -> None:
        try:
            self.proc.stdin.close()
            self.proc.wait(10)
        except (OSError, subprocess.TimeoutExpired):
            self.proc.kill()
            self.proc.wait()
        self._reader.join(5)
        self.proc.stdout.close()
        self.proc.stderr.close()


class WasmNodeToolchain:
    """The WebAssembly release run under Node through ``wasm-node-runner.mjs``
    (JSON lines over stdio), one Node process per job slot. ``toolchain_dir``
    holds an unpacked release (``manifest.json``, ``toolchain.js``, ...).

    ``mount`` is the POSIX path the tree has inside the WebAssembly instance
    (default: the tree's own path, a Windows drive as ``/c/...``). It is what
    the ELF's debug information records as the compilation directory, so a
    build with the site's ``/webflash/src/<project>/<sha>`` gives the browser
    build's bytes.

    The runners are plain subprocesses driven from worker threads rather than
    asyncio subprocesses: each build runs in an ``asyncio.run`` of its own
    (``webflash parity`` builds every row with the same toolchain), and an
    asyncio pipe cannot outlive its event loop.
    """

    def __init__(self, toolchain_dir: Path, *, jobs: int = 1, node: str = "node", runner: Optional[Path] = None,
                 label: str = "webflash", mount: Optional[str] = None) -> None:
        self.toolchain_dir = Path(toolchain_dir)
        manifest_path = self.toolchain_dir / "manifest.json"
        if not manifest_path.is_file():
            raise DriverError(f"no manifest.json in {self.toolchain_dir}")
        self.manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        self.kind = "clang"
        self.name = "wasm-node"
        self.label = label
        self.version = str(self.manifest.get("llvm", "0"))
        self.sysroot = Sysroot.from_manifest(self.manifest, root="/")
        if mount is not None and (not str(mount).startswith("/") or str(mount).strip("/") == ""):
            raise DriverError(f"the mount must be an absolute POSIX path below /, not {mount!r}")
        self.mount = mount
        self.node = shutil.which(node) or node
        if runner:
            self.runner = Path(runner)
        else:
            # tools/parity/wasm-node-runner.mjs of the checkout, else of the
            # current directory (an installed package has no checkout).
            candidates = (Path(__file__).resolve().parents[3] / "tools" / "parity" / "wasm-node-runner.mjs",
                          Path("tools") / "parity" / "wasm-node-runner.mjs")
            self.runner = next((c for c in candidates if c.is_file()), candidates[0])
        self.jobs = max(1, int(jobs))
        self._slots: queue.SimpleQueue = queue.SimpleQueue()
        for _ in range(self.jobs):
            self._slots.put(None)
        self._runners: list[_NodeRunner] = []
        self._lock = threading.Lock()

    def tool_version(self, tool: str) -> str:
        return synthetic_tool_version(tool, self.version, self.label)

    def _exchange(self, line: bytes) -> dict:
        """Send one request on a free runner (started on first need, again
        after one died) and wait for its reply; a worker thread runs this."""
        slot = self._slots.get()
        try:
            if slot is None or not slot.alive():
                slot = _NodeRunner([self.node, str(self.runner), str(self.toolchain_dir / "manifest.json")])
                with self._lock:
                    self._runners.append(slot)
            return slot.request(line)
        finally:
            self._slots.put(slot)

    async def run(self, command: Command, *, cwd: Path, env: dict[str, str], links: Any = None) -> ToolResult:
        if command.kind == "version":
            return ToolResult(0, self.tool_version(command.tool) + "\n")
        cwd = Path(cwd)
        files, symlinks = job_inputs(command, cwd, links)
        request = {
            "argv": command.argv, "cwd": cwd.as_posix(), "env": dict(env), "symlinks": symlinks,
            "files": {p: base64.b64encode(b).decode("ascii") for p, b in files.items()},
            "inputs": command.inputs, "include_dirs": getattr(command, "include_dirs", []),
        }
        if self.mount:
            request["mount"] = self.mount
        line = (json.dumps(request) + "\n").encode("utf-8")
        reply = await asyncio.get_running_loop().run_in_executor(None, self._exchange, line)
        for path, content in (reply.get("outputs") or {}).items():
            if path.endswith(".d"):
                continue
            target = Path(path)
            if not target.is_absolute():
                target = cwd / target
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(base64.b64decode(content))
        return ToolResult(int(reply.get("code", 1)), reply.get("stdout", ""), reply.get("stderr", ""),
                          float(reply.get("time", 0)) / 1000.0, int(reply.get("memory", 0) or 0))

    async def close(self) -> None:
        """Stop every runner; a later ``run`` starts new ones."""
        with self._lock:
            runners, self._runners = self._runners, []
        for runner in runners:
            runner.close()
        self._slots = queue.SimpleQueue()
        for _ in range(self.jobs):
            self._slots.put(None)
