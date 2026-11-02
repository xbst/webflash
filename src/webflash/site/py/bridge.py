"""The site's bridge into webflash, running in the engine worker under Pyodide.

Everything crossing into JavaScript is a JSON string, plain text or bytes, so
the browser side never holds a Python proxy it has to free.  This module is
the only Python the site adds: a thin shim over the package, so the renderer,
the loaders and the build engine stay the same code the command line runs.

The engine methods (sources, Kconfig, build, method inference) are stubs until
the build engine and the configure UI land (chunks 03 and 05).
"""
from __future__ import annotations

import base64
import binascii
import json
import shutil
import sys
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

def _load(toml_text: str) -> BoardConfig:
    path = _fresh_work()
    path.write_text(toml_text, encoding="utf-8")
    return load_board(path)


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
    path = _fresh_work()
    path.write_text(toml_text, encoding="utf-8")
    _place_files(options.get("files") or {})
    config = load_board(path)
    try:
        html, warnings = build_page(path, theme=theme_name or None,
                                    inline=bool(options.get("inline")))
    except FileNotFoundError as e:
        raise RuntimeError(f"{e}\n\n{_CUSTOM_THEME_HINT}") from None
    return json.dumps({"html": html, "warnings": _theme_warnings(config, theme_name) + warnings})


# ── Build engine (chunks 03 and 05) ──────────────────────────────────

def _not_yet(*_args, **_kwargs):
    raise NotImplementedError("chunk 03/05")


def load_sources(project: str, ref_json: str, core_bytes: bytes) -> str:
    """Extract a ref's core bundle into /webflash/src/<project>/<sha>/."""
    return _not_yet()


def kconfig_load(config_text: str) -> str:
    """Load the tree's Kconfig with a .config or a defconfig (olddefconfig)."""
    return _not_yet()


def kconfig_tree() -> str:
    """The Kconfig tree as node JSON (SPEC 10)."""
    return _not_yet()


def kconfig_set(name: str, value: str) -> str:
    """Set a symbol or a choice, returning the new tree."""
    return _not_yet()


def kconfig_config() -> str:
    """The full .config text."""
    return _not_yet()


def kconfig_defconfig() -> str:
    """The minimal configuration, as make savedefconfig writes it."""
    return _not_yet()


def kconfig_symbol(name: str) -> str:
    """One symbol's node JSON."""
    return _not_yet()


def kconfig_search(text: str) -> str:
    """The ids of the nodes whose name, prompt or help match."""
    return _not_yet()


def plan(config_text: str) -> str:
    """The lib/ directories a build of this configuration needs."""
    return _not_yet()


def add_lib(name: str, data: bytes) -> str:
    """Extract a lib bundle into the current tree."""
    return _not_yet()


def build(config_text: str, version: str, jobs: int = 1) -> str:
    """Build the firmware; progress goes through a JavaScript callback."""
    return _not_yet()


def infer_methods(config_text: str) -> str:
    """The flashing methods a configuration can use, best first (SPEC 11.2)."""
    return _not_yet()
