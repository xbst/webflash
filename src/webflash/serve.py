"""Serve the WebFlash site locally.

`webflash` with no file serves the site, so it is one command away rather than
a directory change, a separate web server, and a reminder to activate a
virtual environment.  The site has to be served over HTTP because it fetches
its Python payload, so opening index.html from disk does not work.

The site's files are served at ``/``, and the embed runtime at
``/engine/v1/`` laid out as the hosted site deploys it (``engine_files``:
``js/embed/`` at its root beside the shared modules of ``js/``, then
``flash/``, ``build/``, ``configure/``, ``workers/`` and ``css/``), so a board
TOML with ``engine_url = "http://127.0.0.1:<port>/engine/v1/"`` renders a page
that runs against this server. With ``--assets <folder>``, ``/toolchain/`` and
``/sources/`` are served from that folder too; otherwise the page fetches them
from the ``--assets`` URL, which it reads from a ``<meta name="webflash-assets">``
the server writes into ``index.html`` (and the embed runtime from the same
URL written into ``embed.js``). Everything is sent with
``Access-Control-Allow-Origin: *``, as GitHub Pages sends it, so a generated
page served from elsewhere can load the runtime.

The payload is checked against the package each time the site asks for it,
and rebuilt first if a source changed, so an edit to the package (a theme, the
renderer, the bridge, the engine) reaches the site's Generate at its next page
load without restarting the server.
"""
from __future__ import annotations

import html
import io
import json
import shutil
import socket
import sys
import threading
import webbrowser
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .payload import PAYLOAD_NAME, build_payload, site_root

# Where the embed runtime is mounted, and which site folder each part of it
# comes from. Its modules import their neighbors relatively, so the folders
# they reach keep the site's layout: js/embed/ is the root, beside the
# modules of js/ that the build's flow imports (the engine's RPC, the session's
# names, the TOML writer, the save helpers), and the folders below js/ keep
# their names. A file directly under /engine/v1/ is one of js/embed/ unless it
# is one of those modules.
ENGINE_PREFIX = "/engine/v1"
_ENGINE_ROOT = ("js", "embed")
_ENGINE_SHARED = ("runtime.js", "state.js", "toml-io.js", "dialogs.js")
_ENGINE_FOLDERS = {
    "flash": ("js", "flash"),
    "build": ("js", "build"),
    "configure": ("js", "configure"),
    "workers": ("js", "workers"),
    "css": ("css",),
}
# Served from an --assets folder.
_ASSET_PREFIXES = ("/toolchain", "/sources")
# Replaced in index.html by the meta tag naming the assets' origin. The hosted
# site serves index.html untouched: no tag, so the page uses its own origin.
ASSETS_PLACEHOLDER = "<!--webflash-assets-->"
# The same for the embed runtime: embed.js holds an empty string with this
# comment, which the server replaces with the --assets URL. Empty, as the
# hosted site serves it, means the runtime's own site.
ENGINE_ASSETS_PLACEHOLDER = '"" /* webflash-assets */'


def engine_files(site: Path) -> dict[str, Path]:
    """Every file of the embed runtime by its path under ``/engine/v1/``,
    mapped to the site file it is: what the local server serves there and
    what the Pages workflow stages (``stage_engine``)."""
    site = Path(site)
    files: dict[str, Path] = {}

    def add(prefix: str, folder: Path) -> None:
        if not folder.is_dir():
            return
        for path in sorted(folder.rglob("*")):
            if path.is_file() and "__pycache__" not in path.parts:
                files[prefix + path.relative_to(folder).as_posix()] = path

    add("", site.joinpath(*_ENGINE_ROOT))
    for name in _ENGINE_SHARED:
        files[name] = site / "js" / name
    for name, folder in _ENGINE_FOLDERS.items():
        add(f"{name}/", site.joinpath(*folder))
    return files


def stage_engine(site: Path, out: Path) -> int:
    """Copy the embed runtime into ``out`` (``_site/engine/v1``) as the
    local server serves it. Returns the number of files."""
    files = engine_files(site)
    for rel, source in files.items():
        target = Path(out).joinpath(*rel.split("/"))
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
    return len(files)


class _Payload:
    """The payload as served, rebuilt first whenever the package has changed.

    The site fetches it once per page load, so checking every request costs
    one digest of the package's sources (a few milliseconds) per load.
    ``build_payload`` decides where, as it did at startup: beside the site in a
    source checkout, in the per-user cache for an installed package.

    The check, a rebuild and the read happen under one lock, and the bytes are
    sent from memory: two requests never build at once (the temporary file is
    named after the process), and no thread has the zip open while another
    replaces it, which Windows refuses.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.path = build_payload()
        self.data = self.path.read_bytes()

    def read(self) -> bytes:
        with self._lock:
            path = build_payload()
            data = path.read_bytes()
            if data != self.data:
                print(f"Payload:   rebuilt, the package changed  ({len(data) / 1024:.0f} KB)", flush=True)
            self.path, self.data = path, data
            return data


def _bare(path: str) -> str:
    return path.split("?", 1)[0].split("#", 1)[0]


def _under(path: str, prefix: str) -> str | None:
    """What follows ``prefix`` in a request path, else None."""
    bare = _bare(path)
    if bare == prefix or bare.startswith(prefix + "/"):
        return path[len(prefix):] or "/"
    return None


class _Handler(SimpleHTTPRequestHandler):
    """Static files, never cached.

    The payload is rebuilt whenever the package changes and the site's own
    modules change under anyone editing them, so a cached copy is always the
    wrong answer here.

    The payload is answered from memory (see _Payload), so it does not matter
    that it is not always inside the served directory: for an installed
    package it lives in a per-user cache.
    """

    payload: _Payload | None = None
    site: Path | None = None
    assets_dir: Path | None = None
    # The content of the webflash-assets meta tag: a URL, or "" for this server.
    assets_url: str = ""

    # SimpleHTTPRequestHandler takes its content types from mimetypes, which on
    # Windows consults the registry, where an installed application can have
    # remapped .js to text/plain.  The browser then refuses the module scripts
    # and the site renders as a blank page.  State the few types this app
    # actually serves so that cannot happen.
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".html": "text/html",
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".zip": "application/zip",
        ".wasm": "application/wasm",
        ".gz": "application/gzip",
        ".tar": "application/x-tar",
        ".toml": "text/plain",
        ".svg": "image/svg+xml",
        ".png": "image/png",
    }

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def send_head(self):
        if self.payload is not None and self._asks_for_payload():
            try:
                data = self.payload.read()
            except OSError as e:
                # Never the previous payload instead: Generate would quietly
                # disagree with the command line, which is what the check is for.
                print(f"Could not build the payload: {e}", file=sys.stderr, flush=True)
                self.send_error(HTTPStatus.INTERNAL_SERVER_ERROR, "Could not build the payload", str(e))
                return None
            return self._send_bytes(data, self.extensions_map[".zip"])
        if self._asks_for_index():
            index = Path(self.translate_path(self.path))
            if index.is_dir():
                index = index / "index.html"
            if index.is_file():
                text = index.read_text(encoding="utf-8")
                meta = f'<meta name="webflash-assets" content="{html.escape(self.assets_url)}">'
                return self._send_bytes(text.replace(ASSETS_PLACEHOLDER, meta, 1).encode("utf-8"),
                                        "text/html; charset=utf-8")
        if self.assets_url and _bare(self.path) == f"{ENGINE_PREFIX}/embed.js":
            entry = Path(self.translate_path(self.path))
            if entry.is_file():
                text = entry.read_text(encoding="utf-8")
                named = f"{json.dumps(self.assets_url)} /* webflash-assets */"
                return self._send_bytes(text.replace(ENGINE_ASSETS_PLACEHOLDER, named, 1).encode("utf-8"),
                                        self.extensions_map[".js"])
        return super().send_head()

    def _send_bytes(self, data: bytes, content_type: str):
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        return io.BytesIO(data)

    def _mounted(self, path: str) -> tuple[Path, str] | None:
        """The folder a mounted path is served from and the rest of the path,
        or None for a plain site path."""
        rest = _under(path, ENGINE_PREFIX)
        if rest is not None and self.site is not None:
            parts = _bare(rest).strip("/").split("/", 1)
            folder = _ENGINE_FOLDERS.get(parts[0]) if len(parts) == 2 else None
            if folder is not None:
                return self.site.joinpath(*folder), rest[len(parts[0]) + 1:]
            if len(parts) == 1 and parts[0] in _ENGINE_SHARED:
                return self.site / "js", rest
            return self.site.joinpath(*_ENGINE_ROOT), rest
        if self.assets_dir is not None:
            for prefix in _ASSET_PREFIXES:
                rest = _under(path, prefix)
                if rest is not None:
                    # Resolved against <folder>/toolchain or <folder>/sources,
                    # so a ".." after the prefix stops there rather than
                    # reaching the rest of the folder.
                    return self.assets_dir / prefix.lstrip("/"), rest
        return None

    def _asks_for_payload(self) -> bool:
        # Any site path that names the payload, as the site's relative fetch
        # does from the root.
        return self._mounted(self.path) is None and \
            Path(super().translate_path(self.path)).name == PAYLOAD_NAME

    def _asks_for_index(self) -> bool:
        return self._mounted(self.path) is None and _bare(self.path) in ("/", "/index.html")

    def translate_path(self, path: str) -> str:
        mounted = self._mounted(path)
        if mounted is None:
            return super().translate_path(path)
        # Resolved by the base class against the mounted folder instead of the
        # site's, so it drops ".." the same way and cannot leave it.
        folder, rest = mounted
        served_dir = self.directory
        self.directory = str(folder)
        try:
            return super().translate_path(rest)
        finally:
            self.directory = served_dir

    def log_message(self, fmt: str, *args) -> None:
        pass  # one line per asset is noise; errors still surface below


# On Windows, SO_REUSEADDR lets a socket bind a port another process is already
# listening on, so the site would share a port with some other server and
# report it as its own. SO_EXCLUSIVEADDRUSE is the safe option there; Windows
# does not hold a port in TIME_WAIT against a new listener, so nothing is lost.
_WINDOWS = sys.platform == "win32"


def _set_port_options(s: socket.socket) -> None:
    if _WINDOWS:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
    else:
        # The real server sets allow_reuse_address; without the same option
        # here a port still in TIME_WAIT from the previous run reads as taken
        # on Linux and macOS, and the requested port is abandoned for no reason.
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)


class _Server(ThreadingHTTPServer):
    allow_reuse_address = not _WINDOWS

    def server_bind(self) -> None:
        if _WINDOWS:
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def _answers(port: int) -> bool:
    """Whether something already accepts connections on 127.0.0.1 at this port.

    A bind alone cannot tell on Windows: it succeeds while another server
    listens on all interfaces, as `python -m http.server` does by default. A
    listener accepts within milliseconds; a closed port is only slow to refuse
    (Windows retries the handshake), so a short timeout means free.
    """
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.2):
            return True
    except OSError:
        return False


def _probe(port: int) -> int | None:
    """Bind a port to see whether it is free, returning the number it got."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        _set_port_options(s)
        try:
            s.bind(("127.0.0.1", port))
            got = s.getsockname()[1]
        except OSError:
            return None
    return None if _answers(got) else got


def _pick_port(preferred: int) -> int:
    if preferred:
        got = _probe(preferred)
        if got is not None:
            return got
        print(f"Port {preferred} is in use, choosing another.")
    # A port the system hands out can still be held on another address, so
    # ask again a few times before giving up.
    for _ in range(10):
        got = _probe(0)
        if got is not None:
            return got
    raise OSError("could not bind a port")


def serve(port: int = 0, *, open_browser: bool = True,
          assets: str = "https://webflash.isiks.tech/") -> None:
    """Serve the site until Ctrl+C. ``assets`` is a URL the page fetches the
    toolchain and the sources from, or a folder this server serves them from."""
    if not 0 <= port <= 65535:
        raise ValueError(f"port must be between 0 and 65535, got {port}")

    root: Path = site_root()
    payload = _Payload()
    print(f"Site:      {root}")
    print(f"Payload:   {payload.path}  ({len(payload.data) / 1024:.0f} KB)")
    if payload.path.parent != root:
        print("           (built in the user cache, outside the installed package)")
    if assets.lower().startswith(("http://", "https://")):
        _Handler.assets_dir, _Handler.assets_url = None, assets
        print(f"Assets:    {assets}")
    else:
        folder = Path(assets).resolve()
        if not folder.is_dir():
            raise FileNotFoundError(f"the assets folder does not exist: {folder}")
        _Handler.assets_dir, _Handler.assets_url = folder, ""
        print(f"Assets:    {folder}  (served at /toolchain/ and /sources/)")

    bound = _pick_port(port)
    handler = partial(_Handler, directory=str(root))
    _Handler.payload = payload
    _Handler.site = root
    # The probe socket is closed by now, so another process could take the port
    # in between. Report that rather than dying on a bare traceback.
    try:
        httpd = _Server(("127.0.0.1", bound), handler)
    except OSError as e:
        raise OSError(f"could not serve on port {bound}: {e}") from None

    url = f"http://127.0.0.1:{bound}"
    # Flushed so a script or tool reading a pipe sees the address before
    # serving blocks.
    print(f"Serving:   {url}\nPress Ctrl+C to stop.", flush=True)
    if open_browser:
        webbrowser.open(url)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        httpd.server_close()
