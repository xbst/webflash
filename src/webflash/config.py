"""The board TOML and theme loaders.

``load_board`` reads a board TOML, the file a docs author writes (or the site
saves): what to build and flash, and which settings the reader of the card may
change. ``load_theme`` reads a theme TOML: how the card looks. The board loader
is strict, since a typo there builds the wrong firmware: unknown keys, wrong
types and values outside their list are errors, which read
``<file>: <table>: <message>``. The theme loader is lenient where PinConnect's
and 3DStep's are: unknown behavior keys and tables are warnings, unknown color
tokens pass through as CSS variables.
"""
from __future__ import annotations

import base64
import math
import re
import sys
from dataclasses import dataclass, field, fields
from pathlib import Path, PurePosixPath

if sys.version_info >= (3, 11):
    import tomllib
else:
    try:
        import tomllib
    except ModuleNotFoundError:
        import tomli as tomllib  # type: ignore[no-redef]


# ── Board TOML ───────────────────────────────────────────────────────

PROJECTS = ("klipper", "kalico", "katapult")
# The flashing methods, in the order the site lists them.
METHODS = ("dfu", "picoboot", "uf2", "katapult", "katapult-can", "download")
VERSION_SETS = ("all", "releases")
PREBUILT_SUFFIXES = (".bin", ".hex", ".uf2", ".elf")
DEFAULT_ENGINE_URL = "https://webflash.isiks.tech/engine/v1/"

_TOP_TABLES = ("board", "firmware", "config", "option", "flash", "prebuilt")
_TOP_WRITTEN = "[board], [firmware], [config], [[option]], [flash], [prebuilt]"
_BOARD_KEYS = ("title", "description", "image", "theme", "theme_dir", "engine_url")
_FIRMWARE_KEYS = ("project", "projects", "version", "versions")
_CONFIG_KEYS = ("defconfig",)
_OPTION_KEYS = ("symbol", "label", "values", "labels", "help")
_FLASH_KEYS = ("methods", "instructions")
_PREBUILT_KEYS = ("file", "address", "mcu")

# A Kconfig symbol, as [[option]] names it: without the CONFIG_ prefix.
_SYMBOL_RE = re.compile(r"[A-Za-z0-9_]+")
_URL_RE = re.compile(r"https?://[^\s/?#]+(/[^\s?#]*)?", re.IGNORECASE)


@dataclass
class Board:
    title: str
    description: str = ""
    image: str = ""
    theme: str = "default"
    theme_dir: str = "./themes"
    engine_url: str = DEFAULT_ENGINE_URL


@dataclass
class Firmware:
    project: str
    projects: list[str] = field(default_factory=list)
    version: str = "latest"
    # "all", "releases", or the ref ids the reader may pick.
    versions: str | list[str] = "all"


@dataclass
class Option:
    """One setting the reader may change; everything else stays as the defconfig says."""
    symbol: str
    label: str = ""
    # None: the default (every visible member of a choice, free input within the
    # Kconfig range for int/hex/string). Integers in the TOML arrive as strings.
    values: list[str] | None = None
    labels: dict[str, str] = field(default_factory=dict)
    help: str = ""


@dataclass
class Flash:
    # None: inferred from the configuration at run time.
    methods: list[str] | None = None
    instructions: dict[str, str] = field(default_factory=dict)


@dataclass
class Prebuilt:
    file: str
    address: int | None = None       # required for .bin, absent otherwise
    mcu: str = ""


@dataclass
class BoardConfig:
    """A loaded board TOML: [firmware] and [config], or [prebuilt]."""
    board: Board
    firmware: Firmware | None = None
    defconfig: str = ""
    options: list[Option] = field(default_factory=list)
    flash: Flash = field(default_factory=Flash)
    prebuilt: Prebuilt | None = None
    # Non-fatal complaints, e.g. a label for a value the option does not offer.
    # The CLI prints these; the site shows them in the Generate dialog.
    warnings: list[str] = field(default_factory=list)
    path: Path | None = None
    # The TOML text as read, LF newlines and no BOM: what the page's
    # "#toml=" link carries, so the site opens the same configuration.
    text: str = ""


def _fail(where: str, message: str):
    raise ValueError(f"{where}: {message}")


def _check_keys(table: dict, allowed: tuple[str, ...], where: str) -> None:
    unknown = sorted(str(k) for k in table if k not in allowed)
    if unknown:
        _fail(where, f"unknown key(s): {', '.join(unknown)} (valid: {', '.join(allowed)})")


def _table(value: object, where: str, written: str) -> dict:
    if not isinstance(value, dict):
        _fail(where, f"must be a table, written as '{written}'")
    return value


def _tables(value: object, where: str, name: str) -> list[dict]:
    """An array of tables such as ``[[option]]``.

    A single ``[option]`` instead of ``[[option]]`` is a classic TOML slip, which
    tomllib parses as one dict rather than a list of them.
    """
    if isinstance(value, dict):
        _fail(where, f"write '[[{name}]]' (an array of tables), not '[{name}]'")
    if not isinstance(value, list) or not all(isinstance(t, dict) for t in value):
        _fail(where, f"'{name}' must be written as [[{name}]] tables")
    return value


def _text(value: object, where: str, key: str) -> str:
    if not isinstance(value, str):
        _fail(where, f"{key} must be a string (got {value!r})")
    # tomllib already turns CRLF inside multi-line strings into LF; a stray
    # "\r" escape would still reach the page, which is LF only.
    return value.replace("\r\n", "\n").replace("\r", "\n")


def _get_text(table: dict, key: str, where: str, default: str = "") -> str:
    return _text(table[key], where, key) if key in table else default


def _required_text(table: dict, key: str, where: str, hint: str = "") -> str:
    if key not in table:
        _fail(where, f"missing required key '{key}'{hint}")
    value = _text(table[key], where, key)
    if not value.strip():
        _fail(where, f"{key} must not be empty")
    return value


# ── .config text ─────────────────────────────────────────────────────

_SET_RE = re.compile(r"CONFIG_([A-Za-z0-9_]+)=(.*)")
# kconfiglib's own form, one space after the "#"; it takes "#CONFIG_X is not
# set" for a comment and leaves X as it was.
_UNSET_RE = re.compile(r"# CONFIG_([A-Za-z0-9_]+) is not set")
_LOOSE_UNSET_RE = re.compile(r"#\s*CONFIG_[A-Za-z0-9_]+\s+is\s+not\s+set.*")
# What a .config line may hold: a bool or tristate, a decimal or hex number,
# or a quoted string with backslash escapes.
_VALUE_RE = re.compile(r'[ymn]|-?[0-9]+|0[xX][0-9a-fA-F]+|"(?:[^"\\]|\\.)*"')


def parse_defconfig(text: str) -> list[tuple[str, str | None]]:
    """The settings of a defconfig (or a full ``.config``), in order.

    Each entry is ``(symbol, value)``: the symbol without ``CONFIG_`` and the
    value as written (``"y"``, ``"1000000"``, ``"0x8000"``, ``'"PA13"'`` with its
    quotes), or None for ``# CONFIG_X is not set``. Blank lines and other
    comments are skipped. Raises ValueError naming the line for anything else:
    an indented setting, which kconfiglib skips (it reads only lines that start
    at column 0), an unset line not written exactly as kconfiglib writes it,
    and a symbol set twice, which kconfiglib would take the last of without a
    word. Symbols are not checked against a Kconfig: there is none here.
    """
    entries: list[tuple[str, str | None]] = []
    seen: dict[str, int] = {}
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    for number, raw in enumerate(lines, 1):
        # kconfiglib drops trailing whitespace, as the C tools do.
        line = raw.rstrip()
        if not line:
            continue
        if line[0].isspace():
            body = line.lstrip()
            if body.startswith("#") and not _LOOSE_UNSET_RE.fullmatch(body):
                continue
            raise ValueError(
                f"line {number}: {body!r} starts with whitespace; Kconfig ignores an "
                "indented line, so start each .config line at column 0"
            )
        unset = _UNSET_RE.fullmatch(line)
        if unset:
            name, value = unset.group(1), None
        elif _LOOSE_UNSET_RE.fullmatch(line):
            raise ValueError(
                f"line {number}: {line!r} is not read by Kconfig; "
                "write it as # CONFIG_NAME is not set"
            )
        elif line.startswith("#"):
            continue
        else:
            match = _SET_RE.fullmatch(line)
            if not match:
                raise ValueError(
                    f"line {number}: {line!r} is not a .config line "
                    "(CONFIG_NAME=value, or # CONFIG_NAME is not set)"
                )
            name, value = match.group(1), match.group(2)
            if not _VALUE_RE.fullmatch(value):
                raise ValueError(
                    f"line {number}: CONFIG_{name}={value} is not y, n, m, a number, "
                    "a hex number or a quoted string"
                )
        if name in seen:
            raise ValueError(f"line {number}: CONFIG_{name} is already set on line {seen[name]}")
        seen[name] = number
        entries.append((name, value))
    return entries


# ── Loading a board TOML ─────────────────────────────────────────────

def _engine_url(value: str, where: str) -> str:
    url = value.strip()
    if not _URL_RE.fullmatch(url):
        _fail(where, f"engine_url must be an http:// or https:// URL like {DEFAULT_ENGINE_URL} "
                     f"(got {value!r})")
    # The page loads "<engine_url>embed.js", so the URL names a folder.
    return url if url.endswith("/") else url + "/"


def _load_board_table(raw: dict, fname: str) -> Board:
    if "board" not in raw:
        raise ValueError(f"{fname}: missing required [board] table")
    where = f"{fname}: [board]"
    b = _table(raw["board"], where, "[board]")
    _check_keys(b, _BOARD_KEYS, where)
    theme = _get_text(b, "theme", where, "default").strip()
    if not theme:
        _fail(where, "theme must not be empty (leave it out for the default theme)")
    return Board(
        title=_required_text(b, "title", where, " (the card's heading and the page title)"),
        description=_get_text(b, "description", where),
        image=_get_text(b, "image", where).strip(),
        theme=theme,
        theme_dir=_get_text(b, "theme_dir", where, "./themes"),
        engine_url=_engine_url(_get_text(b, "engine_url", where, DEFAULT_ENGINE_URL), where),
    )


def _project(value: object, where: str, key: str) -> str:
    if not isinstance(value, str) or value not in PROJECTS:
        _fail(where, f"{key}: unknown project {value!r} (valid: {', '.join(PROJECTS)})")
    return value


def _load_firmware(raw: dict, fname: str) -> Firmware:
    where = f"{fname}: [firmware]"
    f = _table(raw["firmware"], where, "[firmware]")
    _check_keys(f, _FIRMWARE_KEYS, where)
    if "project" not in f:
        _fail(where, f"missing required key 'project' (one of {', '.join(PROJECTS)})")
    project = _project(f["project"], where, "project")

    projects = [project]
    if "projects" in f:
        value = f["projects"]
        if not isinstance(value, list) or not value:
            _fail(where, f"projects must be a nonempty list like [\"klipper\", \"kalico\"] (got {value!r})")
        projects = []
        for item in value:
            name = _project(item, where, "projects")
            if name in projects:
                _fail(where, f"projects lists '{name}' twice")
            projects.append(name)
        if project not in projects:
            _fail(where, f"projects must include '{project}', the project the card starts with")
        if "katapult" in projects and len(projects) > 1:
            _fail(where, "projects cannot mix katapult with klipper or kalico: the bootloader's "
                         "configuration is not the firmware's")

    version = _get_text(f, "version", where, "latest").strip()
    if not version:
        _fail(where, "version must not be empty (\"latest\", \"release\" or a ref id like \"v0.13.0\")")

    versions = f.get("versions", "all")
    if isinstance(versions, str):
        if versions not in VERSION_SETS:
            _fail(where, f"versions must be \"all\", \"releases\" or a list of ref ids (got {versions!r})")
    elif isinstance(versions, list) and versions:
        refs: list[str] = []
        for item in versions:
            if not isinstance(item, str) or not item.strip():
                _fail(where, f"versions must list ref ids like \"v0.13.0\" (got {item!r})")
            if item in refs:
                _fail(where, f"versions lists '{item}' twice")
            refs.append(item)
        if version not in ("latest", "release") and version not in refs:
            _fail(where, f"version '{version}' must be one of versions, which the reader picks from")
        versions = refs
    else:
        _fail(where, f"versions must be \"all\", \"releases\" or a nonempty list of ref ids (got {versions!r})")
    return Firmware(project=project, projects=projects, version=version, versions=versions)


def _load_config(raw: dict, fname: str) -> str:
    where = f"{fname}: [config]"
    c = _table(raw["config"], where, "[config]")
    _check_keys(c, _CONFIG_KEYS, where)
    if "defconfig" not in c:
        _fail(where, "missing required key 'defconfig' (the text make savedefconfig writes)")
    text = _text(c["defconfig"], where, "defconfig")
    try:
        parse_defconfig(text)
    except ValueError as e:
        _fail(where, f"defconfig {e}")
    return text


def _option_value(item: object, where: str) -> str:
    if isinstance(item, bool) or not isinstance(item, (str, int)):
        _fail(where, f"values must hold strings or integers (got {item!r})")
    return item if isinstance(item, str) else str(item)


def _load_options(raw: dict, fname: str, warnings: list[str]) -> list[Option]:
    if "option" not in raw:
        return []
    options: list[Option] = []
    for i, t in enumerate(_tables(raw["option"], f"{fname}: [[option]]", "option"), 1):
        where = f"{fname}: [[option]] #{i}"
        _check_keys(t, _OPTION_KEYS, where)
        if "symbol" not in t:
            _fail(where, "missing required key 'symbol' (a Kconfig symbol like \"STM32_FLASH_START_2000\")")
        symbol = t["symbol"]
        if not isinstance(symbol, str) or not _SYMBOL_RE.fullmatch(symbol):
            _fail(where, f"symbol must be a Kconfig symbol like \"STM32_FLASH_START_2000\" (got {symbol!r})")
        if symbol.startswith("CONFIG_"):
            _fail(where, f"symbol is written without CONFIG_: \"{symbol[len('CONFIG_'):]}\" (got {symbol!r})")
        if any(o.symbol == symbol for o in options):
            _fail(where, f"symbol {symbol} is already an option")
        where = f"{fname}: [[option]] #{i} ({symbol})"

        values: list[str] | None = None
        if "values" in t:
            value = t["values"]
            if not isinstance(value, list) or not value:
                _fail(where, f"values must be a nonempty list like [\"STM32_FLASH_START_0000\", "
                             f"\"STM32_FLASH_START_2000\"] (got {value!r})")
            values = []
            for item in value:
                text = _option_value(item, where)
                if text in values:
                    _fail(where, f"values lists {text!r} twice")
                values.append(text)

        labels: dict[str, str] = {}
        if "labels" in t:
            value = t["labels"]
            if not isinstance(value, dict):
                _fail(where, "labels must be a table like { STM32_FLASH_START_0000 = \"No bootloader\" }")
            for key, label in value.items():
                labels[str(key)] = _text(label, where, f"labels.{key}")
            if values is not None:
                for key in labels:
                    if key not in values:
                        warnings.append(f"{where}: labels names '{key}', which is not one of values, "
                                        "so it is never shown")

        options.append(Option(
            symbol=symbol,
            label=_get_text(t, "label", where),
            values=values,
            labels=labels,
            help=_get_text(t, "help", where),
        ))
    return options


def _method(value: object, where: str, key: str) -> str:
    if not isinstance(value, str) or value not in METHODS:
        _fail(where, f"{key}: unknown method {value!r} (valid: {', '.join(METHODS)})")
    return value


def _load_flash(raw: dict, fname: str, warnings: list[str]) -> Flash:
    if "flash" not in raw:
        return Flash()
    where = f"{fname}: [flash]"
    fl = _table(raw["flash"], where, "[flash]")
    _check_keys(fl, _FLASH_KEYS, where)

    methods: list[str] | None = None
    if "methods" in fl:
        value = fl["methods"]
        if not isinstance(value, list) or not value:
            _fail(where, f"methods must be a nonempty list like [\"katapult\", \"dfu\", \"download\"] "
                         f"(got {value!r})")
        methods = []
        for item in value:
            name = _method(item, where, "methods")
            if name in methods:
                _fail(where, f"methods lists '{name}' twice")
            methods.append(name)

    instructions: dict[str, str] = {}
    if "instructions" in fl:
        iwhere = f"{fname}: [flash.instructions]"
        table = _table(fl["instructions"], iwhere, "[flash.instructions]")
        for key, value in table.items():
            instructions[_method(key, iwhere, "key")] = _text(value, iwhere, key)
        if methods is not None:
            for key in instructions:
                if key not in methods:
                    warnings.append(f"{iwhere}: '{key}' is not one of [flash] methods, so its "
                                    "instructions are never shown")
    return Flash(methods=methods, instructions=instructions)


def _load_prebuilt(raw: dict, fname: str) -> Prebuilt:
    where = f"{fname}: [prebuilt]"
    p = _table(raw["prebuilt"], where, "[prebuilt]")
    _check_keys(p, _PREBUILT_KEYS, where)
    file = _required_text(p, "file", where, " (the firmware file, relative to this TOML)").strip()
    suffix = PurePosixPath(file.replace("\\", "/")).suffix.lower()
    if suffix not in PREBUILT_SUFFIXES:
        _fail(where, f"file must be a .bin, .hex, .uf2 or .elf firmware file (got {file!r})")
    address: int | None = None
    if suffix == ".bin":
        if "address" not in p:
            _fail(where, "address is required for a .bin file, which carries no address of its own "
                         "(for example address = 0x08000000)")
        address = p["address"]
        if isinstance(address, bool) or not isinstance(address, int) or not 0 <= address <= 0xFFFFFFFF:
            _fail(where, f"address must be a 32-bit address like 0x08000000 (got {address!r})")
    elif "address" in p:
        _fail(where, f"address is only for a .bin file: a {suffix} file carries its own addresses")
    return Prebuilt(file=file, address=address, mcu=_get_text(p, "mcu", where).strip())


def read_text(path: Path) -> str:
    """A text file as the loaders read it: UTF-8, any BOM dropped, LF newlines.

    Notepad and some Windows tools start a file with a BOM, which TOML does not
    allow but which carries no meaning either; and a CRLF checkout must give
    the same page as an LF one.
    """
    data = Path(path).read_bytes()
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError as e:
        raise ValueError(f"{Path(path).name} is not UTF-8 text: {e}") from None
    return text.replace("\r\n", "\n").replace("\r", "\n")


def load_board(path: Path) -> BoardConfig:
    """Load a board TOML and check every rule that needs no Kconfig.

    Symbols are not checked against a Kconfig (there is none here), and
    ``version`` / ``versions`` not against the sources index: the site does both
    when it loads the TOML against a version.
    """
    path = Path(path)
    fname = path.name
    text = read_text(path)
    try:
        raw = tomllib.loads(text)
    except tomllib.TOMLDecodeError as e:
        raise ValueError(f"invalid TOML in {fname}: {e}") from None

    unknown = sorted(k for k in raw if k not in _TOP_TABLES)
    if unknown:
        raise ValueError(f"{fname}: unknown top-level key(s) or table(s): {', '.join(unknown)} "
                         f"(valid: {_TOP_WRITTEN})")

    warnings: list[str] = []
    board = _load_board_table(raw, fname)
    if "prebuilt" in raw:
        for key, written in (("firmware", "[firmware]"), ("config", "[config]")):
            if key in raw:
                raise ValueError(f"{fname}: {written} cannot be used with [prebuilt]: a board TOML "
                                 "builds from source ([firmware] and [config]) or flashes a file "
                                 "([prebuilt]), not both")
        if "option" in raw:
            raise ValueError(f"{fname}: [[option]] cannot be used with [prebuilt]: a firmware file "
                             "has nothing to configure")
        return BoardConfig(
            board=board,
            flash=_load_flash(raw, fname, warnings),
            prebuilt=_load_prebuilt(raw, fname),
            warnings=warnings,
            path=path,
            text=text,
        )

    if "firmware" not in raw and "config" not in raw:
        raise ValueError(f"{fname}: a board TOML needs [firmware] and [config] (to build from "
                         "source) or [prebuilt] (to flash a file)")
    if "firmware" not in raw:
        raise ValueError(f"{fname}: missing required [firmware] table (the project to build)")
    if "config" not in raw:
        raise ValueError(f"{fname}: missing required [config] table (the defconfig to build)")
    return BoardConfig(
        board=board,
        firmware=_load_firmware(raw, fname),
        defconfig=_load_config(raw, fname),
        options=_load_options(raw, fname, warnings),
        flash=_load_flash(raw, fname, warnings),
        warnings=warnings,
        path=path,
        text=text,
    )


def board_data(config: BoardConfig) -> dict:
    """The board TOML's tables, normalized, with every default applied: what the
    generated page's config JSON carries and what the site's Open reads."""
    b = config.board
    data: dict = {
        "board": {
            "title": b.title,
            "description": b.description,
            "image": b.image,
            "theme": b.theme,
            "theme_dir": b.theme_dir,
            "engine_url": b.engine_url,
        },
        "firmware": None,
        "config": None,
        "options": [{
            "symbol": o.symbol,
            "label": o.label,
            "values": list(o.values) if o.values is not None else None,
            "labels": dict(o.labels),
            "help": o.help,
        } for o in config.options],
        "flash": {
            "methods": list(config.flash.methods) if config.flash.methods is not None else None,
            "instructions": dict(config.flash.instructions),
        },
        "prebuilt": None,
    }
    if config.firmware is not None:
        f = config.firmware
        data["firmware"] = {
            "project": f.project,
            "projects": list(f.projects),
            "version": f.version,
            "versions": f.versions if isinstance(f.versions, str) else list(f.versions),
        }
        data["config"] = {"defconfig": config.defconfig}
    if config.prebuilt is not None:
        p = config.prebuilt
        data["prebuilt"] = {"file": p.file, "address": p.address, "mcu": p.mcu}
    return data


# ── Writing a board TOML ─────────────────────────────────────────────

_BARE_KEY_RE = re.compile(r"[A-Za-z0-9_-]+")


def _toml_char(ch: str) -> str:
    """A control character as a basic string escapes it."""
    return f"\\u{ord(ch):04X}"


def _toml_string(text: str) -> str:
    """A TOML basic string on one line."""
    out = []
    for ch in text:
        if ch == "\\":
            out.append("\\\\")
        elif ch == '"':
            out.append('\\"')
        elif ch == "\n":
            out.append("\\n")
        elif ch == "\t":
            out.append("\\t")
        elif ch == "\r":
            out.append("\\r")
        elif ord(ch) < 0x20 or ord(ch) == 0x7F:
            out.append(_toml_char(ch))
        else:
            out.append(ch)
    return '"' + "".join(out) + '"'


def _toml_multiline(text: str) -> str:
    """A TOML multi-line basic string that starts on the next line, so the
    text reads as written: quotes stay bare except a third in a row (which
    would end the string) and a last one (which would join the delimiter)."""
    out = []
    run = 0
    for i, ch in enumerate(text):
        if ch == '"':
            if run == 2 or i == len(text) - 1:
                out.append('\\"')
                run = 0
            else:
                out.append('"')
                run += 1
            continue
        run = 0
        if ch == "\\":
            out.append("\\\\")
        elif ch in "\n\t":
            out.append(ch)
        elif ord(ch) < 0x20 or ord(ch) == 0x7F:
            out.append(_toml_char(ch))
        else:
            out.append(ch)
    return '"""\n' + "".join(out) + '"""'


def _toml_text(text: str) -> str:
    """Prose (a description, a help text, instructions): multi-line when it has
    line breaks, so the TOML reads like the text."""
    return _toml_multiline(text) if "\n" in text else _toml_string(text)


def _toml_key(key: str) -> str:
    return key if _BARE_KEY_RE.fullmatch(key) else _toml_string(key)


def _toml_array(items: list) -> str:
    return "[" + ", ".join(_toml_string(str(item)) for item in items) + "]"


def _toml_inline_table(table: dict) -> str:
    body = ", ".join(f"{_toml_key(str(k))} = {_toml_string(str(v))}" for k, v in table.items())
    return "{ " + body + " }" if body else "{}"


def _label_order(labels: dict, values: list | None) -> dict:
    """An option's labels in the order the writers use: the order of values,
    then any other keys sorted by UTF-16 code unit, as JavaScript sorts
    strings (a key above U+FFFF sorts before U+E000 to U+FFFF). Not the TOML's
    own order, which JavaScript cannot keep (an object lists integer-like keys
    such as "500000" first, in numeric order), so that toml-io.js writes the
    same text."""
    keys = [k for k in (values or []) if k in labels]
    keys += sorted((k for k in labels if k not in keys),
                   key=lambda k: k.encode("utf-16-be", "surrogatepass"))
    return {k: labels[k] for k in keys}


def dump_board(data: dict) -> str:
    """A board TOML from its tables, in the shape :func:`board_data` returns
    (the site's session has the same shape): the tables in the order of the
    board TOML reference, every key that holds its default left out except
    ``[firmware] version``, which a reader of the file should see. The site's
    ``toml-io.js`` writes the same text for the same tables."""
    lines: list[str] = []
    b = data.get("board") or {}
    lines += ["[board]", f"title = {_toml_string(b.get('title') or '')}"]
    for key, default in (("description", ""), ("image", ""), ("theme", "default"),
                         ("theme_dir", "./themes"), ("engine_url", DEFAULT_ENGINE_URL)):
        value = b.get(key)
        if value is not None and value != default:
            lines.append(f"{key} = {_toml_text(str(value))}")

    firmware = data.get("firmware")
    if firmware:
        project = firmware.get("project") or ""
        lines += ["", "[firmware]", f"project = {_toml_string(project)}"]
        projects = firmware.get("projects") or [project]
        if list(projects) != [project]:
            lines.append(f"projects = {_toml_array(projects)}")
        lines.append(f"version = {_toml_string(firmware.get('version') or 'latest')}")
        versions = firmware.get("versions", "all")
        if isinstance(versions, list):
            lines.append(f"versions = {_toml_array(versions)}")
        elif versions and versions != "all":
            lines.append(f"versions = {_toml_string(versions)}")

        text = (data.get("config") or {}).get("defconfig") or ""
        if text and not text.endswith("\n"):
            text += "\n"
        lines += ["", "[config]", f"defconfig = {_toml_multiline(text) if text else _toml_string('')}"]

        for option in data.get("options") or []:
            lines += ["", "[[option]]", f"symbol = {_toml_string(option.get('symbol') or '')}"]
            if option.get("label"):
                lines.append(f"label = {_toml_text(option['label'])}")
            if option.get("values") is not None:
                lines.append(f"values = {_toml_array(option['values'])}")
            if option.get("labels"):
                labels = _label_order(option["labels"], option.get("values"))
                lines.append(f"labels = {_toml_inline_table(labels)}")
            if option.get("help"):
                lines.append(f"help = {_toml_text(option['help'])}")

    flash = data.get("flash") or {}
    methods = flash.get("methods")
    instructions = flash.get("instructions") or {}
    if methods is not None:
        lines += ["", "[flash]", f"methods = {_toml_array(methods)}"]
    if instructions:
        lines += ["", "[flash.instructions]"]
        lines += [f"{_toml_key(str(k))} = {_toml_text(str(v))}" for k, v in instructions.items()]

    prebuilt = data.get("prebuilt")
    if prebuilt and not firmware:
        lines += ["", "[prebuilt]", f"file = {_toml_string(prebuilt.get('file') or '')}"]
        if prebuilt.get("address") is not None:
            lines.append(f"address = 0x{int(prebuilt['address']):08X}")
        if prebuilt.get("mcu"):
            lines.append(f"mcu = {_toml_string(prebuilt['mcu'])}")
    return "\n".join(lines) + "\n"


# ── Theme ────────────────────────────────────────────────────────────

# Built-in default palette. A theme TOML overrides only the tokens it names;
# unnamed tokens fall back here, so a board with no theme (or a minimal one)
# renders exactly like the bundled "default". Every token is a CSS variable of
# the same name on the page (--accent, --log-bg, ...).
_DEFAULT_COLORS_LIGHT: dict[str, str] = {
    "bg": "#ffffff", "text": "#1a1a1a", "text-muted": "#666666",
    "panel-bg": "#f6f6f6", "panel-border": "#dddddd", "panel-shadow": "rgba(0,0,0,.08)",
    "accent": "#2563eb", "accent-text": "#ffffff",
    "control-bg": "#ffffff", "control-border": "#cccccc", "control-text": "#1a1a1a",
    "log-bg": "#111111", "log-text": "#e0e0e0",
    "ok": "#15803d", "warn": "#b45309", "error": "#b91c1c",
    "divider": "#e5e5e5",
    "scroll-thumb": "rgba(0,0,0,.22)", "scroll-track": "transparent",
}
_DEFAULT_COLORS_DARK: dict[str, str] = {
    "bg": "#131313", "text": "#e0e0e0", "text-muted": "#a3a3a3",
    "panel-bg": "#1c1c1c", "panel-border": "#333333", "panel-shadow": "rgba(0,0,0,.4)",
    "accent": "#60a5fa", "accent-text": "#0b1220",
    "control-bg": "#262626", "control-border": "#444444", "control-text": "#e0e0e0",
    "log-bg": "#0b0b0b", "log-text": "#d4d4d4",
    "ok": "#4ade80", "warn": "#fbbf24", "error": "#f87171",
    "divider": "#333333",
    "scroll-thumb": "rgba(255,255,255,.20)", "scroll-track": "transparent",
}


# The CSS named colors, plus the keywords a color token may legitimately hold.
# Used only to tell a real color from a typo: a value that matches nothing here
# and is not a hex or a function gets a warning, not an error.
_CSS_COLOR_KEYWORDS: frozenset[str] = frozenset("""
aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond
blue blueviolet brown burlywood cadetblue chartreuse chocolate coral
cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray
darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid
darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey
darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue
firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod
gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki
lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan
lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon
lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue
lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue
mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen
mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin
navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod
palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum
powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon
sandybrown seagreen seashell sienna silver skyblue slateblue slategray
slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet
wheat white whitesmoke yellow yellowgreen
transparent currentcolor inherit initial unset revert
""".split())

_BARE_HEX_RE = re.compile(r"^[0-9a-fA-F]+$")
_HEX_RE = re.compile(r"^#[0-9a-fA-F]+$")
# rgb(), hsl(), oklch(), color-mix(), var(), linear-gradient() and friends.
_FUNC_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9-]*\(.*\)$", re.DOTALL)
# A token name as a CSS custom property can carry it.
_TOKEN_RE = re.compile(r"[A-Za-z0-9_-]+")


def _check_color(token: str, value: str, scope: str, known: bool,
                 warnings: list[str]) -> str:
    """Sanity-check one ``[colors.*]`` value, returning the value to emit.

    Colors reach the stylesheet verbatim, and CSS drops a custom property that
    does not parse only where it is *used* -- so a malformed color does not
    fail, it silently turns the element it paints transparent/unstyled.  Two
    checks, both non-fatal, because unknown tokens are a documented extension
    point and the color syntax keeps growing:

    * A bare hex (``f8f8f8``) is never valid CSS in any position, so it is
      unambiguously a missing ``#``: fix it and say so.
    * Anything else that looks like no color at all is reported only for the
      built-in tokens, whose meaning we know.  A custom token may legitimately
      hold any CSS the theme's ``[extra_css]`` cares to use.
    """
    where = f"[colors.{scope}] {token}"
    if not isinstance(value, str):
        warnings.append(f"{where} = {value!r} is not a string; ignoring it.")
        return ""
    v = value.strip()
    if not v:
        # The caller drops an empty value, so the default color stays.
        if known:
            warnings.append(f"{where} is empty; using the default color.")
        return ""
    if any(c in v for c in "{}<>"):
        # The value is written into a style block: these would end the block,
        # or the element.
        warnings.append(f"{where} = \"{v}\" holds a character a color never has "
                        "({ } < >); ignoring it.")
        return ""
    if v.lower() in _CSS_COLOR_KEYWORDS or _FUNC_RE.match(v):
        return v
    if _BARE_HEX_RE.match(v) and len(v) in (3, 4, 6, 8):
        warnings.append(
            f"{where} = \"{v}\" is missing its '#', which makes it invalid CSS "
            f"(the element would render transparent); using \"#{v}\"."
        )
        return f"#{v}"
    if _HEX_RE.match(v):
        if len(v) - 1 in (3, 4, 6, 8):
            return v
        warnings.append(
            f"{where} = \"{v}\" is not a valid hex color "
            "(it needs 3, 4, 6 or 8 digits)."
        )
        return v
    if known:
        warnings.append(
            f"{where} = \"{v}\" is not a recognized CSS color, so the element "
            "it paints will render unstyled."
        )
    return v


def _theme_colors(raw: object, scope: str, warnings: list[str]) -> dict[str, str]:
    """Check and normalize one ``[colors.light]`` / ``[colors.dark]`` table."""
    if not isinstance(raw, dict):
        return {}
    out: dict[str, str] = {}
    for token, value in raw.items():
        token = str(token)
        if not _TOKEN_RE.fullmatch(token):
            warnings.append(f"[colors.{scope}] {token!r} cannot be a CSS variable name "
                            "(letters, digits, '-' and '_' only); ignoring it.")
            continue
        known = token in _DEFAULT_COLORS_LIGHT
        checked = _check_color(token, value, scope, known, warnings)
        if checked:
            out[token] = checked
    return out


@dataclass
class ThemeFont:
    """A font a theme uses.  ``source`` is ``google`` (loaded via a Fonts <link>),
    ``bundled`` (a font file embedded as a base64 @font-face, so output stays
    self-contained), or ``system`` (``family`` is used verbatim as a CSS stack).
    ``data_uri``/``fmt`` are filled in by :func:`_parse_font` for bundled fonts."""
    family: str = "Roboto"
    source: str = "google"
    weights: str = "400;500;600"
    data_uri: str = ""
    fmt: str = ""

    def css_family(self, generic: str = "system-ui,sans-serif") -> str:
        """The CSS ``font-family`` value: a system stack verbatim, otherwise the
        quoted family followed by a generic fallback."""
        if self.source == "system":
            return self.family
        return f"'{self.family}',{generic}"


def _default_mono() -> ThemeFont:
    return ThemeFont(family="Roboto Mono", source="google", weights="400;500")


@dataclass
class ThemeBehavior:
    """How the card behaves. The defaults are the built-in look."""
    show_log: bool = False                 # start with the build/flash log expanded
    show_image: bool = True                # the board photo, when the TOML names one
    compact: bool = False                  # hide the description and the memory table
    show_versions: bool = True             # the project/version selects, when the TOML allows them
    confirm_flash: bool = True             # confirm device, address range and method before writing
    font_scale: float = 1.0                # scales the card's text
    max_width: int = 720                   # px, the card's widest


# Inclusive (low, high) clamps; None is unbounded. Values outside are pulled in
# rather than rejected, as PinConnect does: nothing here is worth failing a
# render over, but a zero width or an unreadable text size would break the card.
_BEHAVIOR_CLAMPS: dict[str, tuple[float | None, float | None]] = {
    "font_scale": (0.5, 3.0),
    "max_width": (280, None),
}


def _coerce_behavior(key: str, value: object, kind: type, where: str):
    """Coerce one ``[behavior]`` value to its field's type, then clamp it."""
    def bad(expected: str):
        _fail(where, f"{key} must be {expected} (got {value!r})")

    if kind is bool:
        if not isinstance(value, bool):
            bad("true or false")
        return value
    if isinstance(value, bool):
        bad("a number")
    try:
        number = float(value.strip()) if isinstance(value, str) else float(value)
    except OverflowError:
        bad("a finite number")
    except (TypeError, ValueError):
        bad("a number")
    if not math.isfinite(number):
        bad("a finite number")
    low, high = _BEHAVIOR_CLAMPS.get(key, (None, None))
    if low is not None:
        number = max(low, number)
    if high is not None:
        number = min(high, number)
    return int(round(number)) if kind is int else number


def _load_behavior(raw: object, fname: str, warnings: list[str]) -> ThemeBehavior:
    behavior = ThemeBehavior()
    if not isinstance(raw, dict):
        return behavior
    where = f"{fname}: [behavior]"
    kinds = {f.name: type(f.default) for f in fields(ThemeBehavior)}
    for key, value in raw.items():
        if key not in kinds:
            # A warning rather than an error, so a theme written for another
            # tool (a PinConnect or 3DStep theme, say) still loads.
            warnings.append(f"[behavior] {key} is not a WebFlash behavior; ignoring it.")
            continue
        setattr(behavior, key, _coerce_behavior(key, value, kinds[key], where))
    return behavior


@dataclass
class Theme:
    """A resolved theme.  Field defaults reproduce WebFlash's built-in look, so
    ``Theme()`` == no theme."""
    name: str = "Default"
    colors_light: dict[str, str] = field(default_factory=lambda: dict(_DEFAULT_COLORS_LIGHT))
    colors_dark: dict[str, str] = field(default_factory=lambda: dict(_DEFAULT_COLORS_DARK))
    font: ThemeFont = field(default_factory=ThemeFont)
    # The log, the .config text and inline code.
    mono_font: ThemeFont = field(default_factory=_default_mono)
    behavior: ThemeBehavior = field(default_factory=ThemeBehavior)
    extra_css: str = ""
    # Non-fatal complaints from loading, e.g. a color that will not parse as CSS.
    # The CLI prints these; the site shows them in the Generate dialog.
    warnings: list[str] = field(default_factory=list)


_BUNDLED_THEMES = Path(__file__).parent / "themes"

_THEME_TABLES = ("theme", "font", "behavior", "colors", "extra_css")
_FONT_KEYS = ("family", "source", "weights", "file", "mono")

_FONT_MIME = {"woff2": "font/woff2", "woff": "font/woff", "ttf": "font/ttf", "otf": "font/otf"}
_FONT_FORMAT = {"woff2": "woff2", "woff": "woff", "ttf": "truetype", "otf": "opentype"}


def _parse_font(d: dict, base_dir: Path, default: ThemeFont) -> ThemeFont:
    """Build a ThemeFont from a theme's [font] (or [font.mono]) table.  For a
    bundled font, read the file (relative to the theme file) and embed it as a
    base64 data URI so the generated HTML stays self-contained."""
    source = d.get("source", default.source)
    if source not in ("google", "bundled", "system"):
        raise ValueError(f"font source must be google|bundled|system, got '{source}'")
    for key in ("family", "weights", "file"):
        if key in d and not isinstance(d[key], str):
            hint = ' like "400;700"' if key == "weights" else ""
            raise ValueError(f"{key} must be a string{hint}, got {d[key]!r}")
    font = ThemeFont(
        family=d.get("family", default.family),
        source=source,
        weights=d.get("weights", default.weights),
    )
    # A google or bundled family is written inside single quotes in the CSS,
    # and a system stack verbatim into a declaration.
    bad = "'\\\n" if source != "system" else ";{}<>\\\n"
    if any(c in font.family for c in bad):
        raise ValueError(f"font family must not contain {'quotes, ' if source != 'system' else ''}"
                         f"a backslash, a line break or CSS punctuation, got {font.family!r}")
    if source == "bundled":
        fname = d.get("file", "")
        if not fname:
            raise ValueError(f"bundled font '{font.family}' needs a 'file' path")
        fpath = (base_dir / fname).resolve()
        if not fpath.exists():
            raise FileNotFoundError(f"font file not found: {fpath}")
        ext = fpath.suffix.lower().lstrip(".")
        mime = _FONT_MIME.get(ext, "font/woff2")
        font.fmt = _FONT_FORMAT.get(ext, "woff2")
        b64 = base64.b64encode(fpath.read_bytes()).decode("ascii")
        font.data_uri = f"data:{mime};base64,{b64}"
    return font


def _unknown(table: object, allowed: tuple[str, ...], label: str, warnings: list[str]) -> None:
    if isinstance(table, dict):
        for key in table:
            if key not in allowed:
                warnings.append(f"{label} {key} is not a theme setting; ignoring it.")


def theme_path(name: str, board_path: Path, theme_dir: str = "./themes") -> Path | None:
    """The file ``load_theme`` reads for a name: the board's ``theme_dir`` first,
    then the bundled themes. None when neither has it."""
    search = [
        (Path(board_path).parent / theme_dir).resolve() / f"{name}.toml",
        _BUNDLED_THEMES / f"{name}.toml",
    ]
    return next((p for p in search if p.is_file()), None)


def load_theme(name: str, board_path: Path, theme_dir: str = "./themes") -> Theme:
    """Resolve a theme by name.

    Looks in the board-local ``theme_dir`` first, then the themes bundled with
    the package.  Tokens the file omits fall back to the built-in default
    palette, so a minimal theme only needs to state what differs.  The built-in
    ``default`` needs no file; any other unknown name is an error.
    """
    theme = Theme()
    toml_path = theme_path(name, board_path, theme_dir)
    if toml_path is None:
        if name and name != "default":
            local = (Path(board_path).parent / theme_dir).resolve()
            raise FileNotFoundError(f"Theme '{name}' not found in {local} or {_BUNDLED_THEMES}")
        return theme

    try:
        raw = tomllib.loads(read_text(toml_path))
    except tomllib.TOMLDecodeError as e:
        raise ValueError(f"invalid TOML in {toml_path.name}: {e}") from None

    warnings = theme.warnings
    for key in raw:
        if key not in _THEME_TABLES:
            warnings.append(f"[{key}] is not a theme table; ignoring it.")
    t = raw.get("theme", {})
    _unknown(t, ("name",), "[theme]", warnings)
    theme.name = str(t.get("name", name)) if isinstance(t, dict) else name

    colors = raw.get("colors", {}) if isinstance(raw.get("colors"), dict) else {}
    _unknown(colors, ("light", "dark"), "[colors]", warnings)
    theme.colors_light.update(_theme_colors(colors.get("light"), "light", warnings))
    theme.colors_dark.update(_theme_colors(colors.get("dark"), "dark", warnings))

    fdict = raw.get("font", {})
    if isinstance(fdict, dict) and fdict:
        _unknown(fdict, _FONT_KEYS, "[font]", warnings)
        mono = fdict.get("mono")
        try:
            body = {k: v for k, v in fdict.items() if k != "mono"}
            if body:
                theme.font = _parse_font(body, toml_path.parent, ThemeFont())
            if isinstance(mono, dict):
                _unknown(mono, _FONT_KEYS[:-1], "[font.mono]", warnings)
                theme.mono_font = _parse_font(mono, toml_path.parent, _default_mono())
        except ValueError as e:
            raise ValueError(f"{toml_path.name}: [font]: {e}") from None

    theme.behavior = _load_behavior(raw.get("behavior", {}), toml_path.name, warnings)

    extra = raw.get("extra_css", {})
    if isinstance(extra, dict):
        _unknown(extra, ("css",), "[extra_css]", warnings)
        theme.extra_css = str(extra.get("css", ""))
    elif isinstance(extra, str):
        theme.extra_css = extra
    theme.extra_css = theme.extra_css.replace("\r\n", "\n").replace("\r", "\n")

    theme.warnings = [f"{toml_path.name}: {w}" for w in warnings]
    return theme
