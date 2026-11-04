"""The site's bridge into webflash, running in the engine worker under Pyodide.

Everything crossing into JavaScript is a JSON string, plain text or bytes, so
the browser side never holds a Python proxy it has to free.  This module is
the only Python the site adds: a thin shim over the package, so the renderer,
the loaders and the build engine stay the same code the command line runs.

The engine methods (sources, Kconfig, plan, build, method inference) run the
build engine on a source snapshot extracted under ``/webflash/src``: the
project's own kconfiglib, Makefiles and scripts, with the compiler commands
handed to the page's toolchain workers through ``webflash_js.run_tool``.
Progress goes through ``webflash_js.progress(phase, detail)``.
"""
from __future__ import annotations

import base64
import binascii
import io
import json
import shutil
import sys
import tarfile
from pathlib import Path, PurePosixPath

import webflash
import webflash.config as _config
from webflash.config import BoardConfig, board_data, dump_board, load_board, load_theme
from webflash.renderer import build_page

_PKG = Path(_config.__file__).resolve().parent
_BUNDLED_THEMES = _PKG / "themes"

# Where a board TOML (and the files that go with it) is written before
# loading.  Nothing else lives here, so the board's default relative theme_dir
# resolves to nothing and falls through to the bundled themes, exactly as it
# does for a board file saved somewhere with no themes folder beside it.
WORK = Path("/webflash/work")
BOARD_NAME = "board.toml"

# Where source snapshots are extracted: /webflash/src/<project>/<sha>/.
SRC = Path("/webflash/src")

_DEFAULT_THEME_DIR = "./themes"
_CUSTOM_THEME_HINT = (
    "The site can only use the themes bundled with WebFlash. A board whose "
    "theme_dir points at its own theme files has to be rendered with the "
    "webflash command line tool, or with a bundled theme picked here."
)

_assets_origin = ""


def _board_path() -> Path:
    return WORK / BOARD_NAME


def _fresh_work() -> Path:
    """An empty work folder, so files from an earlier call never leak into this one."""
    if WORK.exists():
        shutil.rmtree(WORK)
    WORK.mkdir(parents=True)
    return _board_path()


# ── Session ──────────────────────────────────────────────────────────

def init(assets_origin: str = "") -> str:
    """Remember where the toolchain and the sources come from ("" is the site's
    own origin) and report the versions the About dialog shows."""
    global _assets_origin
    _assets_origin = assets_origin
    return json.dumps({
        "webflash": webflash.__version__,
        "python": ".".join(str(n) for n in sys.version_info[:3]),
    })


def theme_catalog() -> str:
    """Bundled theme names and display names, default first."""
    themes = []
    for path in sorted(_BUNDLED_THEMES.glob("*.toml"), key=lambda p: p.stem.lower()):
        theme = load_theme(path.stem, _board_path())
        themes.append({"name": path.stem, "display": theme.name or path.stem})
    themes.sort(key=lambda t: (t["name"] != "default", t["display"].lower()))
    return json.dumps(themes)


# ── Board TOML ───────────────────────────────────────────────────────

def _write_toml(toml_text: str) -> Path:
    path = _fresh_work()
    # Bytes, not text: text mode would turn every "\n" into "\r\n" where the
    # platform does that, and a "\r\n" the browser kept into "\r\r\n".
    path.write_bytes(toml_text.encode("utf-8"))
    return path


def _load(toml_text: str) -> BoardConfig:
    return load_board(_write_toml(toml_text))


def check_board(toml_text: str) -> str:
    """The loader's view of a board TOML, for the site's Open: the normalized
    tables, or the error that stops it loading, and the warnings."""
    try:
        config = _load(toml_text)
    except ValueError as e:
        return json.dumps({"errors": [str(e)], "warnings": [], "board": None})
    return json.dumps({"errors": [], "warnings": config.warnings, "board": board_data(config)})


def save_toml(state_json: str) -> str:
    """A board TOML written fresh from the session's tables (the shape
    ``check_board`` returns as ``board``), in the order of the board TOML
    reference."""
    return dump_board(json.loads(state_json))


def _place_files(files: dict) -> None:
    """Write the files that go with a board (its image, its prebuilt firmware)
    where the TOML names them, relative to it, refusing any path that would
    leave the work folder."""
    for name, data in files.items():
        rel = PurePosixPath(str(name).replace("\\", "/"))
        if rel.is_absolute() or ".." in rel.parts or not rel.parts:
            raise ValueError(f"cannot place '{name}' beside the board TOML: name it relative "
                             "to the TOML, without '..'")
        if rel.as_posix() == BOARD_NAME:
            raise ValueError(f"'{name}' would replace the board TOML itself")
        try:
            raw = base64.b64decode(data, validate=True)
        except (binascii.Error, ValueError, TypeError):
            raise ValueError(f"'{name}' is not base64 data") from None
        target = WORK.joinpath(*rel.parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(raw)


def _theme_warnings(config: BoardConfig, theme_name: str) -> list[str]:
    """Warn when the board points at theme files the browser cannot read.

    A board-local theme silently loses to the bundled theme of the same name
    here, because nothing was copied into the virtual filesystem alongside the
    TOML. The command line, which can read the folder, would produce a
    different file. Say so rather than hand back output that quietly disagrees
    with it.
    """
    if theme_name or config.board.theme_dir == _DEFAULT_THEME_DIR:
        return []
    return [f"This board reads themes from '{config.board.theme_dir}', which the site cannot "
            f"open. Its theme '{config.board.theme}' was replaced by the bundled theme of "
            "that name, so the webflash command would produce a different file."]


def render(toml_text: str, theme_name: str = "", inline_json: str = "") -> str:
    """Render a board TOML to its page, as ``webflash board.toml [-t theme] [-i]``.

    Runs the same ``build_page`` the command line runs, on the TOML written to
    ``/webflash/work/board.toml`` with the files that go with it beside it, so
    the result matches the command line byte for byte for the same input.
    ``inline_json`` is ``{"inline": bool, "files": {name: base64}}``: ``inline``
    is ``-i``, and ``files`` are the board's image and prebuilt firmware under
    the names the TOML gives them. Returns JSON holding the page and every
    warning.
    """
    options = json.loads(inline_json) if inline_json else {}
    path = _write_toml(toml_text)
    _place_files(options.get("files") or {})
    config = load_board(path)
    try:
        html, warnings = build_page(path, theme=theme_name or None,
                                    inline=bool(options.get("inline")))
    except FileNotFoundError as e:
        raise RuntimeError(f"{e}\n\n{_CUSTOM_THEME_HINT}") from None
    return json.dumps({"html": html, "warnings": _theme_warnings(config, theme_name) + warnings})


# ── Build engine ─────────────────────────────────────────────────────

# The current snapshot: {"project", "sha", "describe", "ref", "tree"}.
_sources: dict = {}
_session = None
_toolchain_manifest: dict | None = None
_last_build = None


def _progress(phase: str, detail: str = "", done=None, total=None) -> None:
    """``webflash_js.progress(phase, detail, done, total)`` when the worker
    registered it (Pyodide); nothing under CPython unless a test installs a
    module of that name. A worker whose ``progress`` takes two arguments
    (an older engine worker) gets the two."""
    try:
        import webflash_js  # type: ignore[import-not-found]
    except ImportError:
        return
    fn = getattr(webflash_js, "progress", None)
    if fn is None:
        return
    detail = "" if detail is None else str(detail)
    if done is None and total is None:
        fn(str(phase), detail)
        return
    try:
        fn(str(phase), detail, done, total)
    except TypeError:
        fn(str(phase), detail)


def _cancelled() -> bool:
    """Whether the page cancelled the running call (``webflash_js.cancelled``,
    which the engine worker provides for calls sent with ``long: true``)."""
    try:
        import webflash_js  # type: ignore[import-not-found]
    except ImportError:
        return False
    fn = getattr(webflash_js, "cancelled", None)
    return bool(fn()) if fn is not None else False


def _run_tool_js():
    try:
        import webflash_js  # type: ignore[import-not-found]
    except ImportError:
        return None
    return getattr(webflash_js, "run_tool", None)


def _tree() -> Path:
    tree = _sources.get("tree")
    if not tree:
        raise RuntimeError("no sources loaded: call load_sources first")
    return Path(tree)


def _extract(data: bytes, into: Path) -> int:
    """Extract a bundle (a tar, gzipped or already inflated by the page) under
    ``into``; paths that would leave it are refused. Returns the number of
    files written."""
    count = 0
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:*") as tar:
        for member in tar:
            rel = PurePosixPath(member.name.replace("\\", "/"))
            if rel.is_absolute() or ".." in rel.parts or not rel.parts:
                raise ValueError(f"the bundle holds a path outside the tree: {member.name}")
            target = into.joinpath(*rel.parts)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            elif member.isfile():
                target.parent.mkdir(parents=True, exist_ok=True)
                extracted = tar.extractfile(member)
                target.write_bytes(extracted.read() if extracted else b"")
                count += 1
            elif member.issym() or member.islnk():
                raise ValueError(f"the bundle holds a link, which snapshots never do: {member.name}")
    return count


def load_sources(project: str, ref_json: str, core_bytes: bytes) -> str:
    """Extract a ref's core bundle into ``/webflash/src/<project>/<sha>/`` and
    make it the current tree. ``ref_json`` is the ref's entry of the sources
    index (``sha``, ``describe``, ``libs``, ...). Returns
    ``{"tree", "project", "sha", "describe", "files"}``."""
    global _session, _sources, _last_build
    ref = json.loads(ref_json) if ref_json else {}
    sha = str(ref.get("sha") or "local")
    tree = SRC / project / sha
    _progress("sources", f"extracting {project} {ref.get('id') or sha}")
    if tree.exists():
        shutil.rmtree(tree)
    tree.mkdir(parents=True)
    count = _extract(bytes(core_bytes), tree)
    _sources = {"project": project, "sha": sha, "describe": str(ref.get("describe") or sha),
                "ref": ref, "tree": str(tree)}
    _session = None
    _last_build = None
    return json.dumps({"tree": str(tree), "project": project, "sha": sha,
                       "describe": _sources["describe"], "files": count})


def _get_session():
    global _session
    if _session is None:
        from webflash.engine.kconfig import Session
        _session = Session(_tree(), _sources["project"], _sources["describe"])
    return _session


def kconfig_load(config_text: str) -> str:
    """Load the tree's Kconfig with a ``.config`` or a defconfig (new symbols
    take their defaults, as ``olddefconfig`` does); an empty text resets to
    the defaults. Returns ``{"warnings": [...], "tree": <tree JSON>}``."""
    session = _get_session()
    warnings = session.load(config_text if config_text else None)
    return json.dumps({"warnings": warnings, "missing": session.missing, "tree": session.tree_json()})


def kconfig_tree() -> str:
    """The Kconfig tree as node JSON (SPEC 10): ``{"root", "nodes", "title"}``."""
    return json.dumps(_get_session().tree_json())


def kconfig_set(name: str, value: str) -> str:
    """Set a symbol (``y``/``n``, a number, text) or a choice (``name`` is its
    node id, ``value`` the member symbol), returning the new tree."""
    from webflash.engine.kconfig import KconfigError
    try:
        return json.dumps(_get_session().set(name, value))
    except KconfigError as e:
        raise ValueError(str(e)) from None


def kconfig_config() -> str:
    """The full ``.config`` text."""
    return _get_session().config_text()


def kconfig_defconfig() -> str:
    """The minimal configuration, as ``make savedefconfig`` writes it."""
    return _get_session().defconfig_text()


def kconfig_symbol(name: str) -> str:
    """One symbol's node JSON, or ``null``."""
    return json.dumps(_get_session().symbol(name))


def kconfig_search(text: str) -> str:
    """The ids of the nodes whose name, prompt or help mention the text."""
    return json.dumps(_get_session().search(text))


def _lib_dirs(ev) -> list[str]:
    """The ``lib/<dir>`` directories the evaluated Makefiles refer to: in
    ``dirs-y``, in the include flags of ``CFLAGS`` and in ``src-y``'s
    ``../lib/`` sources, plus the rp2040 stage2 folder."""
    names: list[str] = []

    def add(path: str) -> None:
        parts = path.replace("\\", "/").strip("/").split("/")
        while parts and parts[0] in ("..", ".", "src"):
            parts.pop(0)
        if len(parts) >= 2 and parts[0] == "lib":
            name = "lib/" + parts[1]
            if name not in names:
                names.append(name)

    for word in ev.expand("$(dirs-y)").split():
        add(word)
    for word in ev.expand("$(CFLAGS)").split():
        if word.startswith(("-I", "-iquote")):
            add(word[2:] if word.startswith("-I") else word[7:])
    for word in ev.expand("$(src-y) $(deployer-y) $(mcu-y)").split():
        if word.startswith("../lib/"):
            add(word[3:])
    stage2 = ev.expand("$(STAGE2_FILE)").strip()
    mcu = ev.expand("$(MCU)").strip()
    if stage2 and mcu:
        add(f"lib/pico-sdk/{mcu}/boot_stage2/{stage2}")
    return names


async def plan(config_text: str) -> str:
    """Evaluate the Makefiles for a configuration and name the ``lib/``
    directories the build needs: ``{"dirs": [dirs-y], "libs": [lib/<dir>],
    "missing": [the ones not in the tree yet], "targets": [target-y]}``.
    A coroutine (the make interpreter is asynchronous and Pyodide's loop is
    always running): the worker awaits it, as it does ``build``. An
    architecture WebFlash cannot build (AVR, PRU, AR100, Linux, the
    simulator) raises ValueError with the sentence the site shows, before
    the Makefiles are read."""
    from webflash.engine.make import Evaluator
    from webflash.engine.methods import unsupported_reason
    from webflash.engine.shell import Shell
    tree = _tree()
    session = _get_session()
    session.load(config_text if config_text else None)
    reason = unsupported_reason(session.values())
    if reason:
        raise ValueError(reason)
    session.write_config()
    ev = Evaluator(tree, Shell(tree))
    await ev.load()
    libs = _lib_dirs(ev)
    missing = [name for name in libs if not (tree / name).is_dir()]
    return json.dumps({"dirs": ev.expand("$(dirs-y)").split(), "libs": libs, "missing": missing,
                       "targets": ev.expand("$(target-y)").split()})


def add_lib(name: str, data: bytes) -> str:
    """Extract one ``lib/<dir>`` bundle into the current tree. Returns
    ``{"name", "files"}``."""
    tree = _tree()
    rel = PurePosixPath(name.replace("\\", "/"))
    if rel.is_absolute() or ".." in rel.parts or len(rel.parts) != 2 or rel.parts[0] != "lib":
        raise ValueError(f"a lib bundle is named lib/<dir>, not {name!r}")
    count = _extract(bytes(data), tree)
    if not (tree / name).is_dir():
        raise ValueError(f"the bundle did not create {name}")
    return json.dumps({"name": name, "files": count})


def set_toolchain(manifest_json: str) -> str:
    """Tell the engine which toolchain release the page's workers run: its
    ``manifest.json``. Returns ``{"id", "llvm"}``."""
    global _toolchain_manifest
    manifest = json.loads(manifest_json)
    if manifest.get("schema") != 1:
        raise ValueError(f"toolchain manifest schema {manifest.get('schema')!r} is not supported")
    _toolchain_manifest = manifest
    return json.dumps({"id": manifest.get("id"), "llvm": manifest.get("llvm")})


async def build(config_text: str, version: str = "", jobs: int = 1) -> str:
    """Build the firmware for a configuration with the page's toolchain
    workers (``webflash_js.run_tool``). A coroutine: the worker awaits it.
    Returns ``{"outputs": {name: size}, "memory", "log", "duration", "version",
    "config", "defconfig", "project", "methods", "commands"}``; the output
    files come from ``build_output(name)``."""
    global _last_build
    from webflash.engine.build import Build, BuildError
    from webflash.engine.methods import infer_methods as _infer
    from webflash.engine.toolchain import JsToolchain
    tree = _tree()
    run_tool = _run_tool_js()
    if run_tool is None:
        raise RuntimeError("no toolchain: the page has not registered webflash_js.run_tool")
    if _toolchain_manifest is None:
        raise RuntimeError("no toolchain manifest: call set_toolchain first")
    toolchain = JsToolchain(run_tool, _toolchain_manifest, jobs=max(1, int(jobs)))
    version = version or _sources.get("describe") or "?"
    b = Build(tree, config_text, toolchain=toolchain, version=version, jobs=max(1, int(jobs)),
              log=lambda line: _progress("log", line), progress=_progress, cancelled=_cancelled)
    try:
        result = await b.run_async()
    except BuildError as e:
        _progress("failed", str(e))
        raise RuntimeError(str(e)) from None
    _last_build = result
    session = _get_session()
    session.load(result.config)
    values = session.values()
    methods = _infer(values, result.project)
    _progress("finished", "")
    return json.dumps({
        "outputs": {name: len(data) for name, data in result.outputs.items()},
        "memory": result.memory, "log": result.log, "duration": result.duration,
        "version": result.version, "config": result.config, "defconfig": result.defconfig,
        "project": result.project, "methods": methods, "commands": result.commands,
        "mcu": values.get("MCU", ""),
        "app_address": _address(values, "FLASH_APPLICATION_ADDRESS"),
        "boot_address": _address(values, "FLASH_BOOT_ADDRESS"),
        "flash_start": _address(values, "FLASH_START"),
        "launch_app_address": _address(values, "LAUNCH_APP_ADDRESS"),
    })


def _address(values: dict, name: str):
    raw = values.get(name)
    if not raw:
        return None
    try:
        return int(raw, 0)
    except ValueError:
        return None


def build_output(name: str) -> bytes:
    """One output file of the last build (``klipper.bin``, ``klipper.uf2``,
    ``klipper.dict``, ``.config``, ...)."""
    if _last_build is None:
        raise RuntimeError("nothing built yet")
    try:
        return _last_build.outputs[name]
    except KeyError:
        raise ValueError(f"the last build has no output named {name!r} "
                         f"(it has {', '.join(_last_build.outputs)})") from None


def infer_methods(config_text: str) -> str:
    """The flashing methods a configuration can use, best first (SPEC 11.2):
    the text (a ``.config`` or a defconfig) is resolved through the tree's
    Kconfig first. Returns a JSON list of ``{"id", "reason"}``, the shape of
    ``devices.js``'s ``inferMethods``."""
    from webflash.engine.methods import infer_methods as _infer
    session = _get_session()
    session.load(config_text if config_text else None)
    return json.dumps(_infer(session.values(), _sources.get("project", "klipper")))
