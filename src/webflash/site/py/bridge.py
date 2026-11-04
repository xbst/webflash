"""The site's bridge into webflash, running in the engine worker under Pyodide.

Everything crossing into JavaScript is a JSON string, plain text or bytes, so
the browser side never holds a Python proxy it has to free.  This module is
the only Python the site adds: a thin shim over the package, so the renderer,
the loaders and the build engine stay the same code the command line runs.

The engine methods (sources, Kconfig, plan, build, method inference) run the
build engine on a source snapshot extracted under ``/webflash/src``: the
project's own kconfiglib, Makefiles and scripts, with the compiler commands
handed to the page's toolchain workers through ``webflash_js.run_tool``.
They take a slot first ("fw" or "katapult"): the engine holds the firmware
and Katapult side by side, and ``pair_*`` keeps the options they share in
step. Progress goes through ``webflash_js.progress(phase, detail)``.
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

# The engine holds up to two configurations at once, one per slot: "fw" (the
# firmware: Klipper, Kalico, or Katapult when it is the only pick) and
# "katapult" (Katapult beside a firmware). Each slot has its snapshot
# ({"project", "sha", "describe", "ref", "tree"}), its Kconfig session (node
# ids prefixed "<slot>:") and its last build.
SLOTS = ("fw", "katapult")
_slots: dict = {}
_pair_cache: dict = {}
_toolchain_manifest: dict | None = None


def _slot(slot: str) -> dict:
    if slot not in SLOTS:
        raise ValueError(f"unknown slot {slot!r}: the engine's slots are {', '.join(SLOTS)}")
    return _slots.setdefault(slot, {"sources": {}, "session": None, "last_build": None})


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


def _tree(slot: str) -> Path:
    tree = _slot(slot)["sources"].get("tree")
    if not tree:
        raise RuntimeError(f"no sources loaded in slot {slot!r}: call load_sources first")
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


def load_sources(slot: str, project: str, ref_json: str, core_bytes: bytes) -> str:
    """Extract a ref's core bundle into ``/webflash/src/<project>/<sha>/`` and
    make it the slot's tree. ``ref_json`` is the ref's entry of the sources
    index (``sha``, ``describe``, ``libs``, ...). Only this slot is replaced:
    a tree path the other slot also holds is extracted over, keeping the lib
    bundles it added. Returns ``{"slot", "tree", "project", "sha", "describe",
    "files"}``."""
    state = _slot(slot)
    if slot == "katapult" and project != "katapult":
        raise ValueError(f"the katapult slot holds Katapult, not {project}")
    ref = json.loads(ref_json) if ref_json else {}
    sha = str(ref.get("sha") or "local")
    tree = SRC / project / sha
    _progress("sources", f"extracting {project} {ref.get('id') or sha}")
    shared = any(other is not state and other["sources"].get("tree") == str(tree) for other in _slots.values())
    if tree.exists() and not shared:
        shutil.rmtree(tree)
    tree.mkdir(parents=True, exist_ok=True)
    count = _extract(bytes(core_bytes), tree)
    state["sources"] = {"project": project, "sha": sha, "describe": str(ref.get("describe") or sha),
                        "ref": ref, "tree": str(tree)}
    state["session"] = None
    state["last_build"] = None
    return json.dumps({"slot": slot, "tree": str(tree), "project": project, "sha": sha,
                       "describe": state["sources"]["describe"], "files": count})


def drop_slot(slot: str) -> str:
    """Forget a slot's sources, configuration and build (Katapult unticked).
    The extracted tree stays on disk for a later load of the same ref."""
    _slot(slot)
    _slots.pop(slot, None)
    return json.dumps({"slot": slot})


def _get_session(slot: str):
    state = _slot(slot)
    if state["session"] is None:
        from webflash.engine.kconfig import Session
        sources = state["sources"]
        state["session"] = Session(_tree(slot), sources["project"], sources["describe"], id_prefix=f"{slot}:")
    return state["session"]


def _pair():
    """The pairing of the two slots, while both hold a configuration and the
    firmware slot is not Katapult itself; None otherwise."""
    fw, kat = _slots.get("fw"), _slots.get("katapult")
    if not fw or not kat or not fw["sources"].get("tree") or not kat["sources"].get("tree"):
        return None
    if fw["sources"].get("project") == "katapult":
        return None
    fw_session, kat_session = _get_session("fw"), _get_session("katapult")
    pair = _pair_cache.get("pair")
    if pair is None or pair.fw is not fw_session or pair.katapult is not kat_session:
        from webflash.engine.pair import Pair
        pair = _pair_cache["pair"] = Pair(fw_session, kat_session)
    return pair


def _need_pair():
    pair = _pair()
    if pair is None:
        raise ValueError("pairing needs a firmware in slot fw and Katapult in slot katapult")
    return pair


def _paired(pair, slot: str, notes: list, before: dict, link: dict) -> dict:
    """What a paired call reports beside the slot's own answer: the notes,
    the offset link, and the other slot's tree when it changed."""
    other = pair.other(slot)
    trees = {}
    if pair.session(other).values() != before[other]:
        trees[other] = pair.session(other).tree_json()
    return {"notes": notes, "offset": link, "trees": trees}


def kconfig_load(slot: str, config_text: str) -> str:
    """Load the slot's Kconfig with a ``.config`` or a defconfig (new symbols
    take their defaults, as ``olddefconfig`` does); an empty text resets to
    the defaults. Returns ``{"warnings": [...], "missing", "tree": <tree
    JSON>}``, and ``pair`` (see ``kconfig_set``) while the slots are paired:
    a load applies the offset link, never copies the shared options
    (``pair_sync`` does)."""
    session = _get_session(slot)
    warnings = session.load(config_text if config_text else None)
    out = {"warnings": warnings, "missing": session.missing}
    pair = _pair()
    if pair is not None:
        before = {s: pair.session(s).values() for s in SLOTS}
        out["pair"] = _paired(pair, slot, [], before, pair.link())
    out["tree"] = session.tree_json()
    return json.dumps(out)


def kconfig_tree(slot: str) -> str:
    """The slot's Kconfig tree as node JSON (SPEC 10): ``{"root", "nodes", "title"}``."""
    return json.dumps(_get_session(slot).tree_json())


def kconfig_set(slot: str, name: str, value: str) -> str:
    """Set a symbol (``y``/``n``, a number, text) or a choice (``name`` is its
    node id, ``value`` the member symbol) in a slot, returning the slot's new
    tree. While the slots are paired, a shared option is set in both, the
    firmware's bootloader offset follows Katapult's (setting it in ``fw`` is
    refused), and the answer gains ``pair``: ``{"notes": [what the other
    tree refused], "offset": <the link>, "trees": {other slot: its tree, when
    it changed}}``."""
    from webflash.engine.kconfig import KconfigError
    session = _get_session(slot)
    pair = _pair()
    if pair is not None and pair.is_locked(slot, name, value):
        raise ValueError(f"{pair.title('fw')}'s bootloader offset follows Katapult's application offset: "
                         "change it in Katapult.")
    before = {s: pair.session(s).values() for s in SLOTS} if pair is not None else None
    try:
        session.assign(name, value)
    except KconfigError as e:
        raise ValueError(str(e)) from None
    out = {}
    if pair is not None:
        notes = pair.mirror(slot, name, value)
        notes += [n for n in pair.sync() if n not in notes]
        out["pair"] = _paired(pair, slot, notes, before, pair.link())
    return json.dumps({**session.tree_json(), **out})


def kconfig_config(slot: str) -> str:
    """The slot's full ``.config`` text."""
    return _get_session(slot).config_text()


def kconfig_defconfig(slot: str) -> str:
    """The slot's minimal configuration, as ``make savedefconfig`` writes it."""
    return _get_session(slot).defconfig_text()


def kconfig_symbol(slot: str, name: str) -> str:
    """One symbol's node JSON, or ``null``."""
    return json.dumps(_get_session(slot).symbol(name))


def kconfig_search(slot: str, text: str) -> str:
    """The ids of the slot's nodes whose name, prompt or help mention the text."""
    return json.dumps(_get_session(slot).search(text))


# ── Pairing (engine/pair.py) ─────────────────────────────────────────

def pair_shared() -> str:
    """The options the firmware and Katapult share: ``[{"kind", "name",
    "prompt", "type", "fw": node id, "katapult": node id, "members"}]``."""
    return json.dumps(_need_pair().shared_json())


def pair_sync() -> str:
    """Copy the firmware's shared values into Katapult and apply the offset
    link (after loading either slot). Returns ``{"notes", "offset", "trees":
    {"fw", "katapult"}}``."""
    pair = _need_pair()
    notes = pair.sync()
    link = pair.link()
    return json.dumps({"notes": notes, "offset": link,
                       "trees": {s: pair.session(s).tree_json() for s in SLOTS}})


def pair_tree() -> str:
    """Both slots' trees in one, grouped: the shared options (the firmware's
    nodes), the firmware's own, Katapult's own (``engine/pair.py``'s
    ``Pair.tree``)."""
    return json.dumps(_need_pair().tree())


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


async def plan(slot: str, config_text: str) -> str:
    """Evaluate the slot's Makefiles for a configuration and name the ``lib/``
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
    tree = _tree(slot)
    session = _get_session(slot)
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


def add_lib(slot: str, name: str, data: bytes) -> str:
    """Extract one ``lib/<dir>`` bundle into the slot's tree. Returns
    ``{"name", "files"}``."""
    tree = _tree(slot)
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


async def build(slot: str, config_text: str, version: str = "", jobs: int = 1) -> str:
    """Build the slot's firmware for a configuration with the page's
    toolchain workers (``webflash_js.run_tool``). A coroutine: the worker
    awaits it. Returns ``{"slot", "outputs": {name: size}, "memory", "log",
    "duration", "version", "config", "defconfig", "project", "methods",
    "commands"}``; the output files come from ``build_output(slot, name)``.
    Afterwards the slot's Kconfig session holds the built ``.config``, which
    pins every symbol: the page loads the defconfig again."""
    from webflash.engine.build import Build, BuildError
    from webflash.engine.methods import infer_methods as _infer
    from webflash.engine.toolchain import JsToolchain
    state = _slot(slot)
    tree = _tree(slot)
    run_tool = _run_tool_js()
    if run_tool is None:
        raise RuntimeError("no toolchain: the page has not registered webflash_js.run_tool")
    if _toolchain_manifest is None:
        raise RuntimeError("no toolchain manifest: call set_toolchain first")
    toolchain = JsToolchain(run_tool, _toolchain_manifest, jobs=max(1, int(jobs)))
    version = version or state["sources"].get("describe") or "?"
    b = Build(tree, config_text, toolchain=toolchain, version=version, jobs=max(1, int(jobs)),
              log=lambda line: _progress("log", line), progress=_progress, cancelled=_cancelled)
    try:
        result = await b.run_async()
    except BuildError as e:
        _progress("failed", str(e))
        raise RuntimeError(str(e)) from None
    state["last_build"] = result
    session = _get_session(slot)
    session.load(result.config)
    values = session.values()
    methods = _infer(values, result.project)
    _progress("finished", "")
    return json.dumps({
        "slot": slot,
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


def build_output(slot: str, name: str) -> bytes:
    """One output file of the slot's last build (``klipper.bin``,
    ``klipper.uf2``, ``klipper.dict``, ``.config``, ...)."""
    last = _slot(slot)["last_build"]
    if last is None:
        raise RuntimeError(f"nothing built yet in slot {slot!r}")
    try:
        return last.outputs[name]
    except KeyError:
        raise ValueError(f"the last build has no output named {name!r} "
                         f"(it has {', '.join(last.outputs)})") from None


def infer_methods(slot: str, config_text: str) -> str:
    """The flashing methods a configuration can use, best first (SPEC 11.2):
    the text (a ``.config`` or a defconfig) is resolved through the slot's
    Kconfig first. Returns a JSON list of ``{"id", "reason"}``, the shape of
    ``devices.js``'s ``inferMethods``."""
    from webflash.engine.methods import infer_methods as _infer
    session = _get_session(slot)
    session.load(config_text if config_text else None)
    return json.dumps(_infer(session.values(), _slot(slot)["sources"].get("project", "klipper")))
