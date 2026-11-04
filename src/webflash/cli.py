"""Command-line interface: the ``webflash`` command.

The first argument picks the mode: none opens the WebFlash site on a local
server, a ``.toml`` board renders its embeddable page, and a maintainer
command (``build``, ``make-check``, ``inspect``, ``parity``, ``sources``) hands
the rest of the command line to the module that implements it. Flags that
belong to another mode are usage errors rather than silently ignored.
"""
from __future__ import annotations

import argparse
import importlib
import os
import sys
from pathlib import Path

from . import __version__

DEFAULT_ASSETS = "https://webflash.isiks.tech/"

_MODES = """\
modes:
  webflash                 open the WebFlash site in a browser
  webflash board.toml      render board.toml to board.webflash.html

maintainer commands (webflash <command> --help for their options):
  build        build a firmware natively with the engine and a toolchain
  make-check   compare the engine's make with GNU make on a source tree
  inspect      show a firmware file's sections, sizes and vector table
  parity       build the parity matrix with several toolchains and compare
  sources      build the source snapshots and their index for the site
"""

# Maintainer commands: the module that implements each one, imported only
# when the command runs, and the chunk of the build-out that provides it.
_ENGINE_COMMANDS = ("build", "make-check", "inspect", "parity")
_SOURCES_COMMAND = "sources"
_COMMANDS = _ENGINE_COMMANDS + (_SOURCES_COMMAND,)


def _error(message: object, code: int = 1) -> None:
    """Print a runtime problem as ``Error:`` lines and exit. A message with
    several lines gets the prefix on each."""
    for line in str(message).splitlines() or [""]:
        print(f"Error: {line}", file=sys.stderr)
    sys.exit(code)


def _same_file(a: Path, b: Path) -> bool:
    """Whether two paths name one existing file. Comparing the paths would miss
    a case variant, a short name or a link on Windows; samefile does not."""
    try:
        return os.path.samefile(a, b)
    except OSError:
        return False


def _check_not_a_folder(out_path: Path, default_name: str) -> None:
    """Refuse an output path that names a folder. Opening one fails with
    "Permission denied" on Windows, which reads like a permissions problem."""
    if out_path.is_dir():
        _error(f"the output is a folder, not a file: {out_path} "
               f"(give a file name, such as {out_path / default_name})")


def _render_inputs(config_path: Path, theme_name: str) -> list[tuple[str, Path]]:
    """The files a render reads that an output path must not replace: the board
    TOML, its image and prebuilt file, and the theme file, if one was found."""
    from .config import load_board, theme_path

    config = load_board(config_path)
    inputs = [("the board TOML", config_path)]
    if config.board.image:
        inputs.append(("the board image", (config_path.parent / config.board.image).resolve()))
    if config.prebuilt is not None:
        inputs.append(("the firmware file", (config_path.parent / config.prebuilt.file).resolve()))
    found = theme_path(theme_name or config.board.theme, config_path, config.board.theme_dir)
    if found is not None:
        inputs.append(("the theme file", found))
    return inputs


def _size(n: int) -> str:
    return f"{n / 1024:.0f} KB" if n < 1048576 else f"{n / 1048576:.2f} MB"


def _render(args: argparse.Namespace) -> None:
    from .renderer import build_page

    config_path: Path = args.file.resolve()
    if not config_path.exists():
        _error(f"board TOML not found: {config_path}")
    try:
        page, warnings = build_page(config_path, theme=args.theme, inline=args.inline)
    except (ValueError, OSError) as e:
        # OSError covers more than a missing file: a TOML path that is a
        # directory, or one the user cannot read.
        _error(e)
    for warning in warnings:
        print(f"Warning: {warning}", file=sys.stderr)

    default_name = config_path.with_suffix(".webflash.html").name
    out_path: Path = args.output or config_path.parent / default_name
    _check_not_a_folder(out_path, default_name)
    # build_page has read every input already, so writing over one would
    # succeed and silently destroy the author's TOML, photo, firmware or theme.
    for what, source in _render_inputs(config_path, args.theme or ""):
        if _same_file(out_path, source):
            _error(f"the output would overwrite {what}: {source}")
    # Write LF explicitly. Text mode translates to CRLF on Windows, so the same
    # board rendered on two machines would produce two different files, and the
    # site (which always writes LF) would disagree with the CLI byte for byte.
    # Path.write_text only grew a newline argument in 3.10, and this supports 3.9.
    try:
        with open(out_path, "w", encoding="utf-8", newline="\n") as f:
            f.write(page)
    except OSError as e:
        # A missing output directory is the common case; -o says it must exist.
        _error(f"cannot write output file: {out_path}: {e}")
    print(f"Generated: {out_path}  ({_size(len(page.encode('utf-8')))})")


def _serve_site(port: int, open_browser: bool, assets: str) -> None:
    from .serve import serve
    try:
        serve(port, open_browser=open_browser, assets=assets)
    except (FileNotFoundError, ValueError, OSError) as e:
        # A bad port, an unwritable install and a missing site all deserve a
        # message rather than a traceback.
        _error(e)


def _run_command(argv: list[str]) -> None:
    """A maintainer command: ``argv`` starts with its name. The module that
    implements it takes the whole of ``argv`` and returns an exit code."""
    command = argv[0]
    if command == _SOURCES_COMMAND:
        name, missing = "webflash.sources", ("webflash.sources",)
    else:
        name, missing = "webflash.engine.cli", ("webflash.engine", "webflash.engine.cli")
    try:
        # import_module, not "from . import": that raises a bare ImportError
        # for a missing submodule, which cannot be told from a broken one.
        module = importlib.import_module(name)
    except ModuleNotFoundError as e:
        # Only the module itself being absent: a module that exists and fails
        # to import is a bug to see, not a missing command.
        if e.name not in missing:
            raise
        _error(f"this installation of webflash has no {name}, which runs this command")
    code = module.main(argv)
    if code:
        sys.exit(code)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="webflash",
        # Wrapped by hand: the raw formatter keeps the epilog's columns, and
        # it applies to the description too.
        description="Render a board TOML to an embeddable page that builds and flashes "
                    "Klipper\nfirmware from the browser.  Without a file, open the "
                    "WebFlash site, which\nconfigures, builds and flashes firmware "
                    "and writes board TOMLs.",
        epilog=_MODES,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "file",
        nargs="?",
        type=Path,
        default=None,
        metavar="board.toml",
        help="A board TOML to render.",
    )
    parser.add_argument(
        "-o", "--output",
        type=Path,
        default=None,
        metavar="OUT",
        help="Render only: the output file.  Defaults to <stem>.webflash.html "
             "beside the board TOML.",
    )
    parser.add_argument(
        "-t", "--theme",
        default=None,
        metavar="NAME",
        help="Render only: the theme to apply, overriding [board] theme.  "
             "Resolved from the board's theme_dir, then the bundled themes.",
    )
    parser.add_argument(
        "-i", "--inline",
        action="store_true",
        help="Render only: embed the board image and the [prebuilt] firmware "
             "file in the page as data URLs, instead of referencing them beside it.",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=None,
        metavar="N",
        help="Site only: serve on this port.  Without it, a free port is chosen.",
    )
    parser.add_argument(
        "--no-browser",
        action="store_true",
        help="Site only: do not open a browser window.",
    )
    parser.add_argument(
        "--assets",
        default=None,
        metavar="URL|DIR",
        help="Site only: where the toolchain and the source snapshots come from: "
             f"a URL (default {DEFAULT_ASSETS}), or a folder holding toolchain/ "
             "and sources/, served by this server.",
    )
    parser.add_argument(
        "--version",
        action="version",
        version=f"webflash {__version__}",
    )
    return parser


def _given(args: argparse.Namespace, names: tuple[str, ...]) -> list[str]:
    flags = {
        "--output": args.output is not None,
        "--theme": args.theme is not None,
        "--inline": args.inline,
        "--port": args.port is not None,
        "--no-browser": args.no_browser,
        "--assets": args.assets is not None,
    }
    return [name for name in names if flags[name]]


def _verb(flags: list[str], one: str, many: str) -> str:
    return f"{' and '.join(flags)} {one if len(flags) == 1 else many}"


_SITE_FLAGS = ("--port", "--no-browser", "--assets")
_RENDER_FLAGS = ("--output", "--theme", "--inline")


def _assets(parser: argparse.ArgumentParser, value: str | None) -> str:
    """``--assets`` as the server takes it: an http(s) URL ending in "/", or a
    folder that exists."""
    if value is None:
        return DEFAULT_ASSETS
    if value.lower().startswith(("http://", "https://")):
        return value if value.endswith("/") else value + "/"
    folder = Path(value)
    if not folder.is_dir():
        parser.error(f"--assets must be an http(s) URL or a folder that exists, got {value!r}")
    return str(folder.resolve())


def main(argv: list[str] | None = None) -> None:
    """The ``webflash`` command: open the site, render a board TOML, or run a
    maintainer command."""
    # A piped stdout on Windows (a CI log, `> log.txt`) gets the ANSI code page
    # with strict errors, so printing a path it cannot encode (a CJK folder)
    # would fail after the page was written. Escape such characters instead,
    # as Python already does on stderr.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="backslashreplace")
    argv = sys.argv[1:] if argv is None else list(argv)
    # Commands of their own with their own flags. None of their names can be a
    # board TOML, which needs its suffix.
    if argv[:1] and argv[0] in _COMMANDS:
        _run_command(argv)
        return
    parser = _build_parser()
    args = parser.parse_args(argv)

    if args.file is None:
        flags = _given(args, _RENDER_FLAGS)
        if flags:
            parser.error(f"{_verb(flags, 'needs', 'need')} a board TOML to render")
        _serve_site(args.port or 0, open_browser=not args.no_browser,
                    assets=_assets(parser, args.assets))
        return

    if args.file.suffix.lower() != ".toml":
        parser.error(f"expected a board TOML (.toml) or a command ({', '.join(_COMMANDS)}), "
                     f"got {str(args.file)!r}")
    site = _given(args, _SITE_FLAGS)
    if site:
        parser.error(f"{_verb(site, 'applies', 'apply')} only to the site, which opens "
                     "when no file is given")
    _render(args)


if __name__ == "__main__":
    main()
