"""The generated page: one themed HTML file for one board, the embed.

``generate_html`` writes the theme's CSS, PinConnect's theme-sync script, the
height script md-iframe listens to, the board's configuration as JSON, a
static fallback card (readable with no script, and shown until the runtime
loads), and the ``<script type="module">`` that loads the embed runtime from
``engine_url``. ``build_page`` is the one sequence the command line and the
site's bridge both run, so the site's Generate and ``webflash board.toml``
give the same bytes; nothing here may depend on the platform, the clock or the
environment.
"""
from __future__ import annotations

import base64
import html
import json
import re
import urllib.parse
from dataclasses import fields
from pathlib import Path, PurePosixPath

from . import __version__
from .config import (
    BoardConfig,
    Theme,
    ThemeBehavior,
    asset_parts,
    board_data,
    is_asset_url,
    load_board,
    load_theme,
)

# Bumped only for a change the embed runtime must know about; the runtime
# under /engine/v1/ reads schema 1.
CONFIG_SCHEMA = 1


# ── Inline markup ────────────────────────────────────────────────────

def _escape(text: str) -> str:
    """HTML-escape as the embed runtime's escapeHtml does (3DStep's viewer)."""
    return (text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;").replace("'", "&#39;"))


_SCHEME_RE = re.compile(r"^[a-z][a-z0-9+.\-]*:", re.IGNORECASE)
_HTTP_RE = re.compile(r"^https?://", re.IGNORECASE)
_CODE_RE = re.compile(r"`([^`\n]+)`")
_BOLD_RE = re.compile(r"\*\*([^*\n]+?)\*\*")
_LINK_RE = re.compile(r"\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)")
_SLOT_RE = re.compile("\u0000(\\d+)\u0000")


def _safe_url(url: str) -> bool:
    """http(s) and relative links only: no javascript:, data: or other schemes."""
    return bool(_HTTP_RE.match(url)) or not _SCHEME_RE.match(url)


def _render_inline(text: str) -> str:
    """``**bold**``, ```code``` and ``[links](url)`` in an escaped paragraph."""
    codes: list[str] = []

    def code(m: re.Match) -> str:
        codes.append(f"<code>{m.group(1)}</code>")
        return f"\u0000{len(codes) - 1}\u0000"

    def link(m: re.Match) -> str:
        label, url = m.group(1), m.group(2)
        if not _safe_url(url):
            return label
        return f'<a href="{url}" target="_blank" rel="noopener">{label}</a>'

    s = _CODE_RE.sub(code, text)
    s = _BOLD_RE.sub(r"<strong>\1</strong>", s)
    s = _LINK_RE.sub(link, s)
    s = s.replace("\n", "<br>")
    return _SLOT_RE.sub(lambda m: codes[int(m.group(1))], s)


def render_text(text: str) -> str:
    """The board TOML's text markup as safe HTML: the text is escaped first, then
    blank lines split paragraphs, ``**x**`` is bold, ```x``` is code,
    ``[label](url)`` a link (http, https and relative URLs only) and a single
    newline a line break. Nothing else, and never raw HTML.

    The same rules as 3DStep's ``renderText``, and as ``renderInline`` in the
    site's ``js/flash/flash-ui.js``, which the embed runtime and the flash
    panel use for ``description``, ``help``, ``labels`` and ``instructions``:
    change both or neither. A NUL character (a TOML ``\\u0000``) is dropped,
    since the code spans are set aside behind NUL markers.
    """
    clean = str(text).replace("\x00", "").replace("\r\n", "\n").replace("\r", "\n").strip()
    if not clean:
        return ""
    paragraphs = (p.strip() for p in re.split(r"\n[ \t]*\n+", clean))
    return "".join(f"<p>{_render_inline(_escape(p))}</p>" for p in paragraphs if p)


# ── Theme CSS ────────────────────────────────────────────────────────

def _theme_fonts(theme: Theme) -> list:
    """The theme's fonts: the text font, then the monospace one."""
    return [theme.font, theme.mono_font]


def _render_font_head(theme: Theme) -> str:
    """<head> markup to load the theme's Google fonts (preconnect + one css2
    link).  Bundled fonts ship as @font-face in the main stylesheet and system
    fonts need nothing, so those contribute no head markup here."""
    specs: list[str] = []
    seen: set[str] = set()
    for f in _theme_fonts(theme):
        if f.source != "google" or f.family in seen:
            continue
        seen.add(f.family)
        fam = urllib.parse.quote_plus(f.family)
        weights = urllib.parse.quote(f.weights, safe=";,.")
        specs.append(f"{fam}:wght@{weights}" if weights else fam)
    if not specs:
        return ""
    href = "https://fonts.googleapis.com/css2?family=" + "&family=".join(specs) + "&display=swap"
    return (
        '<link rel="preconnect" href="https://fonts.googleapis.com">\n'
        '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n'
        f'<link href="{html.escape(href)}" rel="stylesheet">'
    )


def _render_theme_css(theme: Theme) -> str:
    """Emit a theme's CSS: @font-face for any bundled fonts, the font-family
    variables (--ui-font, --mono-font), then the color custom-property blocks
    (light on :root, dark under both prefers-color-scheme and [data-theme=dark],
    an explicit [data-theme=light] override), then any raw extra CSS.

    Each color block also declares ``color-scheme``.  A browser only lets an
    iframe's canvas stay transparent while the embedded document's used
    color-scheme matches the embedder's, so without this a ``bg`` of
    ``transparent`` paints opaque white inside a dark host page."""
    def block(selector: str, colors: dict[str, str], scheme: str) -> str:
        decls = "".join(f"--{k}:{v};" for k, v in colors.items())
        return f"{selector}{{{decls}color-scheme:{scheme}}}"

    parts: list[str] = []

    seen_faces: set[str] = set()
    for f in _theme_fonts(theme):
        if f.source == "bundled" and f.data_uri and f.family not in seen_faces:
            seen_faces.add(f.family)
            parts.append(
                f"@font-face{{font-family:'{f.family}';"
                f"src:url({f.data_uri}) format('{f.fmt}');font-display:swap}}"
            )

    ui_font = theme.font.css_family("system-ui,sans-serif")
    mono_font = theme.mono_font.css_family("ui-monospace,Consolas,monospace")
    parts.append(f":root{{--ui-font:{ui_font};--mono-font:{mono_font}}}")

    light, dark = theme.colors_light, theme.colors_dark
    parts.extend([
        block(":root", light, "light"),
        f"@media(prefers-color-scheme:dark){{{block(':root', dark, 'dark')}}}",
        block(':root[data-theme="dark"]', dark, "dark"),
        block(':root[data-theme="light"]', light, "light"),
    ])
    css = "\n".join(parts)
    if theme.extra_css.strip():
        css += "\n" + theme.extra_css.strip()
    return css


def _num(value: float) -> str:
    """A number as CSS and data attributes carry it: 720.0 -> "720", 1.1 -> "1.1"."""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return repr(value)


def _render_behavior_css(theme: Theme) -> str:
    """The behavior variables the card's stylesheet reads, emitted after it."""
    b = theme.behavior
    return f":root{{--font-scale:{_num(b.font_scale)};--max-width:{b.max_width}px}}"


def _behavior_attrs(behavior: ThemeBehavior) -> str:
    """Every behavior as a ``data-*`` attribute on ``.wf-card`` (``show_log``
    becomes ``data-show-log``), so the runtime reads switches and numbers from
    its root element instead of parsing CSS. Booleans are "true" / "false"."""
    out = []
    for f in fields(behavior):
        value = getattr(behavior, f.name)
        if isinstance(value, bool):
            text = "true" if value else "false"
        elif isinstance(value, (int, float)):
            text = _num(value)
        else:
            text = str(value)
        out.append(f' data-{f.name.replace("_", "-")}="{html.escape(text)}"')
    return "".join(out)


# The card and its static fallback. The embed runtime styles its own controls;
# these rules give the fallback (and the card box the runtime fills) its look.
_BASE_CSS = """\
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
html,body{margin:0;background:var(--bg);color:var(--text)}
body{padding:8px;font-family:var(--ui-font);font-size:calc(15px*var(--font-scale));line-height:1.5}
.wf-card{max-width:var(--max-width);margin:0 auto;padding:16px 18px;background:var(--panel-bg);
  border:1px solid var(--panel-border);border-radius:10px;box-shadow:0 1px 3px var(--panel-shadow)}
.wf-card a{color:var(--accent)}
.wf-card code{font-family:var(--mono-font);font-size:.9em;padding:0 4px;background:var(--control-bg);
  border:1px solid var(--control-border);border-radius:4px}
.wf-title{margin:0 0 8px;font-size:1.35em;font-weight:600;line-height:1.25}
.wf-desc p{margin:0 0 8px}
.wf-image{display:block;max-width:100%;height:auto;margin:8px auto 12px;border-radius:6px}
.wf-notice{margin:12px 0 0;padding-top:10px;border-top:1px solid var(--divider);color:var(--text-muted);font-size:.93em}
.wf-card[data-show-image="false"] .wf-image{display:none}
.wf-card[data-compact="true"] .wf-desc{display:none}"""


def _theme_sync_script() -> str:
    """PinConnect's theme-sync script, verbatim but for this comment.

    It sets ``data-theme`` on <html>, which the theme CSS keys its palettes on.
    The message key ``pinconnectTheme`` is PinConnect's on purpose: one host
    script drives the scheme of every embedded tool."""
    return """\
/* Theme sync: ?theme=dark|light forces a theme; otherwise follow the embedding
   page's toggle (MkDocs Material / Zensical set data-md-color-scheme on body,
   "slate" = dark) via same-origin parent access + MutationObserver, or a
   {pinconnectTheme:"dark"|"light"} postMessage for cross-origin embeds (the
   key PinConnect uses, so one host script drives every tool).
   With no signal, data-theme stays unset and prefers-color-scheme applies. */
(function(){
  var root=document.documentElement;
  function apply(t){
    if(t==='dark'||t==='light')root.setAttribute('data-theme',t);
    else root.removeAttribute('data-theme');
  }
  window.addEventListener('message',function(e){
    if(e.data&&typeof e.data==='object'&&'pinconnectTheme' in e.data)apply(e.data.pinconnectTheme);
  });
  var forced=null;
  try{forced=new URLSearchParams(location.search).get('theme')}catch(err){}
  if(forced==='dark'||forced==='light'){apply(forced);return}
  function fromParent(){
    try{
      if(window.parent===window)return null;
      var pd=window.parent.document;
      var md=(pd.body&&pd.body.getAttribute('data-md-color-scheme'))||
             pd.documentElement.getAttribute('data-md-color-scheme');
      if(md)return md==='slate'?'dark':'light';
      var dt=pd.documentElement.getAttribute('data-theme')||
             (pd.body&&pd.body.getAttribute('data-theme'));
      if(dt==='dark'||dt==='light')return dt;
      if(pd.documentElement.classList.contains('dark')||
         (pd.body&&pd.body.classList.contains('dark')))return 'dark';
      return null;
    }catch(err){return null}
  }
  function sync(){var t=fromParent();if(t)apply(t)}
  sync();
  try{
    if(window.parent!==window){
      var pd=window.parent.document;
      var mo=new MutationObserver(sync);
      mo.observe(pd.documentElement,{attributes:true});
      if(pd.body)mo.observe(pd.body,{attributes:true});
    }
  }catch(err){}
})();"""


def _height_script() -> str:
    """md-iframe's auto-height protocol, adapted from PinConnect's and 3DStep's.

    The card grows and shrinks as it builds and flashes (the log, the
    progress, the result), so the page reports ``document.body.scrollHeight``
    whenever the card's size changes, as ``{mdIframeHeight: h}``. It never
    posts 0, which would restore the frame's authored height. Embedded, it
    hides its own scrollbar: the frame grows to fit, and a scrollbar would only
    narrow the card and make it taller. The runtime fires ``webflash-relayout``
    for a change the observer cannot see."""
    return """\
(function(){
  var card=document.getElementById('wf-card'),last=-1,embedded=(window.parent!==window);
  function report(){
    if(!embedded)return;
    document.documentElement.style.overflow='hidden';
    var b=document.body,v=b?Math.ceil(b.scrollHeight):0;
    if(v<=0||Math.abs(v-last)<=2)return;
    last=v;
    try{parent.postMessage({mdIframeHeight:v},'*');}catch(e){}
  }
  addEventListener('load',report);addEventListener('resize',report);
  addEventListener('webflash-relayout',report);
  if(window.ResizeObserver&&card){try{new ResizeObserver(report).observe(card);}catch(e){}}
  report();
})();"""


def _inline_js(code: str) -> str:
    # "</script" anywhere inside a script element ends it, even in a string or
    # a comment. "<\/script" means the same to JavaScript.
    return re.sub(r"</(script)", r"<\\/\1", code, flags=re.IGNORECASE)


def _inline_css(css: str) -> str:
    return re.sub(r"</(style)", r"<\\/\1", css, flags=re.IGNORECASE)


# ── Config JSON and links ────────────────────────────────────────────

def config_json(data: dict) -> str:
    """The page's ``#webflash-config`` text. Sorted keys and ASCII only, so the
    bytes never depend on dict order or an encoder's choices; <, > and &
    escaped so no string (a description holding "</script>", say) can end or
    inject into the script element."""
    return (
        json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
        .replace("&", "\\u0026").replace("<", "\\u003c").replace(">", "\\u003e")
    )


# The engine folder as whole path segments: "/engine/v1/" after a host or a
# folder, so neither a folder that only ends in "engine" (myengine/v1/) nor a
# host named "engine" counts.
_ENGINE_TAIL_RE = re.compile(r"(?<=[^/]/)engine/v[0-9]+/$")


def site_url(engine_url: str) -> str:
    """The WebFlash site an ``engine_url`` belongs to: the URL with its
    ``engine/vN/`` folder taken off (a site hosted under a path keeps it), or
    the origin's root for any other runtime location."""
    if _ENGINE_TAIL_RE.search(engine_url):
        return _ENGINE_TAIL_RE.sub("", engine_url)
    parts = urllib.parse.urlsplit(engine_url)
    return f"{parts.scheme}://{parts.netloc}/"


def toml_fragment(text: str) -> str:
    """``#toml=`` and the TOML text as base64url (RFC 4648 section 5, no
    padding) of its UTF-8 bytes: only letters, digits, '-' and '_', so the
    hash survives any URL handling. The site's Open reads it back."""
    data = base64.urlsafe_b64encode(text.encode("utf-8")).decode("ascii").rstrip("=")
    return f"#toml={data}"


def open_in_site_url(config: BoardConfig) -> str:
    """The link that opens this board's configuration in the WebFlash site."""
    return site_url(config.board.engine_url) + toml_fragment(config.text)


# ── Page ─────────────────────────────────────────────────────────────

_NOTICE_SENTENCE = "Flashing from the browser needs Chrome or Edge on a computer."


def _render_fallback(config: BoardConfig, inline: dict[str, str]) -> str:
    """The card as it reads with no script: the title, the description, the
    photo and where to get the firmware. The embed runtime replaces it with
    the card's controls, keeping the photo's element (with ``-i`` its only
    copy)."""
    esc = html.escape
    b = config.board
    lines = ['<div class="wf-static">', f'<h1 class="wf-title">{esc(b.title)}</h1>']
    description = render_text(b.description)
    if description:
        lines.append(f'<div class="wf-desc">{description}</div>')
    image = inline.get("image") or b.image
    if image:
        lines.append(f'<img class="wf-image" src="{esc(image)}" alt="{esc(b.title)}">')
    if config.prebuilt is not None:
        name = PurePosixPath(config.prebuilt.file.replace("\\", "/")).name
        href = inline.get("prebuilt") or config.prebuilt.file
        lines.append(f'<p class="wf-notice">{_NOTICE_SENTENCE} Download the firmware: '
                     f'<a href="{esc(href)}" download="{esc(name)}">{esc(name)}</a>.</p>')
    else:
        site = site_url(b.engine_url)
        host = urllib.parse.urlsplit(site).netloc
        lines.append(f'<p class="wf-notice">{_NOTICE_SENTENCE} Download the firmware from '
                     f'<a href="{esc(open_in_site_url(config))}" target="_blank" rel="noopener">'
                     f'{esc(host)}</a>.</p>')
    lines.append("</div>")
    return "\n".join(lines)


_TOKEN_RE = re.compile(r"@@([A-Z_]+)@@")

# An inline icon (a lightning bolt), so a page opened on its own shows one and
# the browser never asks the host for a /favicon.ico it may not have, which
# would log an error.
_ICON = ("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E"
         "%3Cpath d='M9.5 1L3 9.2h4.2L6.3 15 13 6.6H8.7z' fill='%23f59e0b'/%3E%3C/svg%3E")

# Tokens are replaced in one pass, so nothing inserted is scanned again: a
# description or a script that happens to contain "@@CONFIG@@" stays as it is.
# The inlined CSS and JavaScript need no brace escaping either.
_HTML_TEMPLATE = """\
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>@@TITLE@@</title>
<link rel="icon" href="@@ICON@@">
@@HEAD@@<style>
@@STYLE@@
</style>
<script>
@@THEME_SYNC@@
</script>
</head>
<body>
<div class="wf-card" id="wf-card"@@ATTRS@@>
@@FALLBACK@@
</div>
<script type="application/json" id="webflash-config">@@CONFIG@@</script>
<script>
@@HEIGHT@@
</script>
<script type="module" src="@@ENGINE@@embed.js"></script>
<!-- @@NOTICE@@ -->
</body>
</html>
"""


def page_config(config: BoardConfig, inline: dict[str, str] | None = None) -> dict:
    """What the page's ``#webflash-config`` holds (schema 1): the board TOML's
    tables (``board_data``), ``schema``, ``toml`` (the TOML text, which "Open
    in WebFlash" carries to the site), and with ``-i`` on a ``[prebuilt]``
    board ``inline: {"prebuilt": <data URL>}``. An inlined image is only in
    the fallback's ``<img>``, which the runtime keeps: a photo would otherwise
    weigh twice."""
    data = board_data(config)
    data["schema"] = CONFIG_SCHEMA
    data["toml"] = config.text
    prebuilt = (inline or {}).get("prebuilt")
    if prebuilt:
        data["inline"] = {"prebuilt": prebuilt}
    return data


def generate_html(config: BoardConfig, theme: Theme | None = None, *,
                  inline: dict[str, str] | None = None) -> str:
    """The page for a board (SPEC 13). ``inline`` maps ``image`` and
    ``prebuilt`` to data URLs (``webflash -i``); without it the page references
    both by their paths relative to the TOML."""
    if theme is None:
        theme = Theme()
    inline = {k: v for k, v in (inline or {}).items() if v}

    data = page_config(config, inline)

    head = _render_font_head(theme)
    values = {
        "TITLE": html.escape(config.board.title),
        "ICON": _ICON,
        "HEAD": head + "\n" if head else "",
        "STYLE": _inline_css("\n".join(
            part for part in (_render_theme_css(theme), _BASE_CSS, _render_behavior_css(theme)) if part
        )),
        "THEME_SYNC": _theme_sync_script(),
        "ATTRS": _behavior_attrs(theme.behavior),
        "FALLBACK": _render_fallback(config, inline),
        "CONFIG": config_json(data),
        "HEIGHT": _inline_js(_height_script()),
        "ENGINE": html.escape(config.board.engine_url),
        "NOTICE": f"WebFlash {__version__} (https://github.com/xbst/webflash), GPL-3.0.",
    }
    return _TOKEN_RE.sub(lambda m: values[m.group(1)], _HTML_TEMPLATE)


# ── Rendering a board file ───────────────────────────────────────────

# Fixed rather than from mimetypes, which reads the Windows registry: the same
# file must give the same data URL on every machine.
_MEDIA_TYPES = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
    ".webp": "image/webp", ".avif": "image/avif", ".svg": "image/svg+xml",
}


def _local_file(base: Path, name: str, key: str, where: str) -> Path:
    """A file the TOML names, below its folder: -i never reads anything else."""
    parts = asset_parts(name)
    if parts is None:
        raise ValueError(f"{where}: {key} must be a path relative to this TOML, without '..' "
                         f"(got {name!r})")
    return base.joinpath(*parts)


def _data_url(path: Path, what: str, where: str) -> str:
    if not path.is_file():
        raise ValueError(f"{where}: {what} not found: {path}")
    media = _MEDIA_TYPES.get(path.suffix.lower(), "application/octet-stream")
    return f"data:{media};base64,{base64.b64encode(path.read_bytes()).decode('ascii')}"


def inline_assets(config: BoardConfig) -> tuple[dict[str, str], list[str]]:
    """The image and the prebuilt file as data URLs, read from beside the TOML
    (``webflash -i``), and any warnings. A missing file is an error: the page
    would otherwise ship without what -i promised."""
    base = config.path.parent if config.path is not None else Path(".")
    fname = config.path.name if config.path is not None else "board.toml"
    assets: dict[str, str] = {}
    warnings: list[str] = []
    image = config.board.image
    if image:
        if is_asset_url(image):
            warnings.append(f"{fname}: [board]: image is a URL, so -i leaves it as it is")
        else:
            assets["image"] = _data_url(_local_file(base, image, "image", f"{fname}: [board]"),
                                        "image file", f"{fname}: [board]")
    if config.prebuilt is not None:
        where = f"{fname}: [prebuilt]"
        if is_asset_url(config.prebuilt.file):
            raise ValueError(f"{where}: file must be a path relative to this TOML, not a URL "
                             f"(got {config.prebuilt.file!r})")
        assets["prebuilt"] = _data_url(_local_file(base, config.prebuilt.file, "file", where),
                                       "firmware file", where)
    return assets, warnings


def build_page(config_path: Path, *, theme: str | None = None,
               inline: bool = False) -> tuple[str, list[str]]:
    """Load a board TOML and its theme, and render the page.

    The ``webflash`` command and the site's bridge both call this, so the
    site's Generate and the command line produce the same bytes for the same
    files. ``theme`` overrides ``[board] theme``; ``inline`` embeds the image
    and the prebuilt file. Returns the page and every warning. Raises
    ValueError for a problem in the board TOML or the theme, and
    FileNotFoundError for a theme that does not exist.
    """
    path = Path(config_path)
    config = load_board(path)
    th = load_theme(theme or config.board.theme, path, config.board.theme_dir)
    assets: dict[str, str] = {}
    asset_warnings: list[str] = []
    if inline:
        assets, asset_warnings = inline_assets(config)
    page = generate_html(config, th, inline=assets)
    return page, config.warnings + th.warnings + asset_warnings
