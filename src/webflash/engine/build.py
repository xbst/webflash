"""One firmware build, start to finish.

:class:`Build` loads the configuration through the project's kconfiglib,
writes ``.config``, ``klippy/.version`` and the ``.git`` marker that keeps
``buildcommands.py`` reporting the snapshot's version, empties ``out/``,
reads the Makefiles through the interpreter (which creates ``out/board``),
plans the targets of ``all`` into waves and runs them: compiles of a wave
concurrently through the toolchain, everything else in make's order. The
result holds every output file, the memory table from the link (with the
flash region's use taken from the image where the linker counts less), the log,
the commands and the duration.
"""
from __future__ import annotations

import asyncio
import shutil
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

from .driver import Driver, parse_memory_usage
from .inspect import image_memory, linker_memory, parse_elf
from .kconfig import Session
from .make import Evaluator, MakeError, Target, run_sync
from .pyrun import PyRunner
from .shell import Shell, ShellError
from .uf2 import elf2uf2, family_for_config

ProgressFn = Callable[[str, str], None]


class BuildError(Exception):
    """The build failed; the message carries the failing command's output."""


def check_tree_path(tree: Path) -> None:
    """Raise :class:`BuildError` for a tree whose path holds whitespace: the
    Makefiles put ``$(CURDIR)`` in make targets, where a space splits the
    path into two words and the ``.config`` rule never comes up to date."""
    if any(c.isspace() for c in str(tree)):
        raise BuildError("the source tree's path must not contain spaces (the Makefiles put it in make "
                         f"targets); move or link the tree to a path without spaces: {tree}")


@dataclass
class BuildResult:
    outputs: dict[str, bytes]
    memory: Optional[dict[str, dict[str, int]]]
    log: str
    commands: list[list[str]]
    duration: float
    version: str
    config: str
    defconfig: str
    project: str
    targets: list[str] = field(default_factory=list)


class Build:
    """``Build(tree, config_text, toolchain=..., version=...)``: run it with
    ``await build.run_async()`` (Pyodide, asyncio) or ``build.run()``.

    ``config_text`` is a full ``.config`` or a defconfig (new symbols take
    their defaults). ``version`` is what the firmware reports. ``jobs`` is how
    many compiles may run at once. ``log`` gets every log line, ``progress``
    gets ``(phase, detail)`` as the build moves: ``configure``, ``plan``,
    ``build`` with the recipe's echo text, ``done`` with the target's name.
    """

    def __init__(self, tree: Path, config_text: str, *, toolchain: Any, version: str, jobs: int = 1,
                 log: Optional[Callable[[str], None]] = None,
                 progress: Optional[ProgressFn] = None, lto: str = "on", goals: Optional[list[str]] = None,
                 env: Optional[dict[str, str]] = None, trace: Optional[Callable[[list[str]], None]] = None,
                 cancelled: Optional[Callable[[], bool]] = None) -> None:
        self.tree = Path(tree).resolve()
        check_tree_path(self.tree)
        self.config_text = config_text
        self.toolchain = toolchain
        self.version = version
        self.jobs = max(1, int(jobs))
        self._log_fn = log
        self._trace_fn = trace
        self._cancelled_fn = cancelled
        self._progress_fn = progress or (lambda phase, detail, done=None, total=None: None)
        self._done_count = 0
        self._total = 0
        self.lto = lto
        self.goals = list(goals) if goals else ["all"]
        self.env = dict(env or {})
        self.log_lines: list[str] = []
        self.commands: list[list[str]] = []
        self.memory: Optional[dict[str, dict[str, int]]] = None
        # The link that printed the memory table: its target and command.
        self._memory_link: Optional[tuple[str, list[str]]] = None
        self.driver = Driver(toolchain.kind, getattr(toolchain, "sysroot", None), lto=lto,
                             version=getattr(toolchain, "version", "0"), label=getattr(toolchain, "label", "webflash"))

    # ── Logging ───────────────────────────────────────────────────────

    def log(self, line: str) -> None:
        for part in line.rstrip("\n").split("\n"):
            self.log_lines.append(part)
            if self._log_fn:
                self._log_fn(part)

    def progress(self, phase: str, detail: str = "") -> None:
        """``(phase, detail, done, total)``: ``done`` and ``total`` count the
        build's targets once they are known, None before that."""
        if self._total:
            try:
                self._progress_fn(phase, detail, self._done_count, self._total)
                return
            except TypeError:
                pass
        self._progress_fn(phase, detail)

    def _check_cancelled(self) -> None:
        if self._cancelled_fn is not None and self._cancelled_fn():
            raise BuildError("the build was cancelled")

    # ── Steps ─────────────────────────────────────────────────────────

    def _configure(self) -> tuple[Session, str, str]:
        self.progress("configure", "")
        session = Session(self.tree, version=self.version)
        for warning in session.load(self.config_text):
            self.log(f"warning: {warning}")
        config = session.config_text()
        defconfig = session.defconfig_text()
        session.write_config()
        return session, config, defconfig

    def _prepare_tree(self) -> None:
        klippy = self.tree / "klippy"
        if klippy.is_dir():
            (klippy / ".version").write_bytes((self.version + "\n").encode("utf-8"))
        marker = self.tree / ".git"
        if not marker.exists():
            # buildcommands.py asks git for the version only when .git exists;
            # the shim answers with the snapshot's version, so the firmware
            # reports it as a clean build would.
            marker.write_bytes(b"# WebFlash marker: the build engine answers 'git describe' itself\n")
        out = self.tree / "out"
        if out.exists():
            shutil.rmtree(out)

    def _make_env(self) -> dict[str, str]:
        env = dict(self.env)
        return env

    async def _run_target(self, ev: Evaluator, target: Target, shell: Shell) -> None:
        auto = ev._auto(target)
        env = ev._recipe_env()
        self._check_cancelled()
        for line in target.recipe:
            where = f"{line.file}:{line.lineno}"
            mark = len(ev.transcript)
            text = ev.expand(line.text, auto, where).lstrip(" \t")
            for info in ev.transcript[mark:]:
                # What $(info) printed while the line was expanded.
                self.log(info)
            silent = ignore = False
            while text and text[0] in "@-+":
                if text[0] == "@":
                    silent = True
                elif text[0] == "-":
                    ignore = True
                text = text[1:].lstrip(" \t")
            if not text.strip():
                continue
            if not silent:
                self.log(text)
            if text.startswith("#"):
                # A comment for the shell: echoed, never run.
                continue
            result = await shell.run(text, env, where=where, make=ev)
            self.commands.append(list(result.argv) if result.argv else text.split())
            if result.argv and self._trace_fn:
                self._trace_fn(result.argv)
            if result.stdout:
                self.log(result.stdout.rstrip("\n"))
                if text.startswith("echo ") and silent:
                    # The Makefiles' progress lines ("  Compiling out/src/sched.o").
                    self.progress("step", result.stdout.strip())
                if "--print-memory-usage" in text or self.memory is None:
                    table = parse_memory_usage(result.stdout)
                    if table:
                        self.memory = table
                        self._memory_link = (target.name, list(result.argv) if result.argv else text.split())
            if result.stderr.strip():
                self.log(result.stderr.rstrip("\n"))
            if result.code != 0 and not ignore:
                if ev.delete_on_error and not target.phony:
                    path = self.tree / target.name
                    if path.exists():
                        path.unlink()
                detail = (result.stderr or result.stdout).strip()
                raise BuildError(f"{text}\nfailed with exit code {result.code}" + (f":\n{detail}" if detail else ""))
        self._done_count += 1
        self.progress("done", target.name)

    async def _run_waves(self, ev: Evaluator, shell: Shell, waves: list[list[Target]]) -> list[str]:
        built: list[str] = []
        sem = asyncio.Semaphore(self.jobs)

        async def one(target: Target) -> None:
            async with sem:
                await self._run_target(ev, target, shell)
            built.append(target.name)

        for wave in waves:
            if len(wave) == 1 or self.jobs == 1:
                for target in wave:
                    await one(target)
            else:
                await asyncio.gather(*(one(t) for t in wave))
        return built

    def _collect(self, ev: Evaluator) -> dict[str, bytes]:
        names = ev.expand("$(target-y)").split()
        wanted = list(dict.fromkeys(names))
        for extra in ("klipper.dict", "defconfig", "katapult.withclear.uf2"):
            path = self.tree / "out" / extra
            if path.is_file():
                wanted.append(f"out/{extra}")
        outputs: dict[str, bytes] = {}
        for name in wanted:
            path = self.tree / name
            if path.is_file():
                outputs[path.name] = path.read_bytes()
        return outputs

    def _correct_memory(self) -> None:
        """Takes each region's use from the linked image where the linker's
        table, which counts run addresses, shows less (inspect.image_memory):
        the RP2040's code runs from RAM, so its flash region would hold the
        boot code alone."""
        if not self.memory or not self._memory_link:
            return
        target, argv = self._memory_link
        output = argv[argv.index("-o") + 1] if "-o" in argv[:-1] else target
        script = argv[argv.index("-T") + 1] if "-T" in argv[:-1] else None
        elf_path, ld_path = self.tree / output, self.tree / script if script else None
        if ld_path is None or not elf_path.is_file() or not ld_path.is_file():
            return
        try:
            regions = linker_memory(ld_path.read_text(encoding="utf-8", errors="replace"))
            memory = image_memory(self.memory, parse_elf(elf_path.read_bytes()), regions)
        except (OSError, ValueError):
            return
        for name, use in memory.items():
            if "linker" in use:
                self.log(f"{name}: {use['used']:,} bytes of the image (the linker's {use['linker']:,} "
                         f"counts only the sections that run from {name})")
        self.memory = memory

    # ── Running ───────────────────────────────────────────────────────

    async def run_async(self) -> BuildResult:
        started = time.perf_counter()
        session, config, defconfig = self._configure()
        self._prepare_tree()
        runner = PyRunner(self.version, self.toolchain.tool_version)
        # Klipper's elf2uf2 writes the RP2040 family for every RP2 chip; an
        # RP2350 build gets the RP2350's, which its boot ROM takes from the drive.
        family_id = family_for_config(config)
        shell = Shell(self.tree, toolchain=self.toolchain, driver=self.driver, python=runner,
                      uf2=lambda elf, out: elf2uf2(elf, out, family_id), log=self.log)
        ev = Evaluator(self.tree, shell, command_line={}, env=self._make_env(), log=self.log)
        try:
            self.progress("plan", "")
            await ev.load()
            self.log("\n".join(ev.transcript)) if ev.transcript else None
            waves = plan_needed(ev, self.goals)
            self._total = sum(len(w) for w in waves)
            self._done_count = 0
            self.progress("build", f"{self._total} targets in {len(waves)} steps")
            targets = await self._run_waves(ev, shell, waves)
        except (MakeError, ShellError) as e:
            raise BuildError(str(e)) from None
        outputs = self._collect(ev)
        self._correct_memory()
        outputs[".config"] = config.encode("utf-8")
        outputs.setdefault("defconfig", defconfig.encode("utf-8"))
        duration = time.perf_counter() - started
        return BuildResult(outputs=outputs, memory=self.memory, log="\n".join(self.log_lines),
                           commands=list(self.commands), duration=duration, version=self.version,
                           config=config, defconfig=defconfig, project=session.project, targets=targets)

    def run(self) -> BuildResult:
        """The synchronous form, for CPython."""
        return run_sync(self.run_async())


def plan_needed(ev: Evaluator, goals: list[str]) -> list[list[Target]]:
    """The waves of :meth:`Evaluator.plan`, keeping only the targets GNU make
    would remake: a target that exists with every prerequisite older and
    unremade (the ``.config`` with its ``olddefconfig`` rule) is left alone."""
    nodes = ev.graph(goals)
    needs: dict[str, bool] = {}

    def need(name: str) -> bool:
        if name in needs:
            return needs[name]
        t = nodes[name]
        remade = False
        newest: Optional[float] = None
        for p in t.prereqs:
            if need(p):
                remade = True
            m = ev._mtime(p)
            if m is not None and (newest is None or m > newest):
                newest = m
        own = ev._mtime(name)
        result = bool(t.recipe) and (t.phony or own is None or remade or (newest is not None and newest > own))
        if not t.recipe:
            result = remade or own is None
        needs[name] = result
        return result

    for g in goals:
        need(g)
    return [[t for t in wave if needs.get(t.name)] for wave in ev.plan(goals) if any(needs.get(t.name) for t in wave)]
