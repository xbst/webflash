"""Source snapshots: the bundles and the index the site builds firmware from.

The site never fetches from GitHub itself: codeload tarballs and release assets
carry no CORS headers, and the API allows 60 requests an hour. Instead the
Pages workflow publishes, under ``/sources/`` on the site's own origin, a
snapshot of every ref that ``sources.toml`` selects, as immutable bundles:

- ``index.json``, the only file that changes: every project, its refs in the
  order the site lists them (the default branch, then tags newest first, then
  other branches), and for each ref its commit, its ``git describe`` label,
  its bundles, its architectures and the result of the snapshot gate;
- ``blobs/<sha256>.tar.gz``: one core bundle per snapshot (what configuring
  needs, and everything outside ``lib/`` that a build needs) and one bundle per
  ``lib/<dir>``, named by the SHA-256 of its bytes, so identical trees share
  one file across refs and projects (Kalico's ``lib/stm32f4`` is Klipper's);
- ``<project>/<sha>/ref.json`` (the snapshot's manifest) and
  ``<project>/<sha>/make-check.json`` (the gate's report);
- ``history/<project>.json``, for a project with ``history_days``: a snapshot
  of every first-parent commit of the default branch from that many days,
  newest first, each listed under its ``git describe`` string (what Mainsail
  and Fluidd show for the host's Klipper), apart from the index so that it
  stays small; the index names the file and its count. Most of these commits
  change only what no bundle holds (the host's ``klippy/``, docs), so they
  share their bundles, and a snapshot with the same bundles as one already
  gated takes that gate's verdict.

``webflash sources build`` keeps its work in a cache folder, which the
workflow restores and saves with ``actions/cache``: a full bare clone per
project (``git/``, or the ``--clones`` folder, which the workflow points
outside the saved cache), the
bundles, a manifest per snapshot, a record per bundled ``lib/<dir>`` tree
(``trees/``, so an unchanged vendor tree is never read or compressed again) and
``state.json``, which remembers what each ref pointed at and when the policy
last selected it. A ref whose commit already has a snapshot costs one
``git ls-remote``; nothing is cloned unless something is new.

Bundles are built from git's objects, never from a checkout, so line-ending
settings cannot change a byte: entries are sorted, regular files only (a
symbolic link is replaced by what it points at), mode 0644 or 0755 as git
records it, owner 0 with no names, mtime 0, gzip with no name and mtime 0.
The same tree always gives the same blob, which is what makes a second run
change nothing.

The ``git describe`` label is computed in the full clone, exactly as ``make``
computes it in a fresh clone of the project (``git describe --tags --long
--always``), so the firmware reports the same version string, abbreviation
length included, as a user's own build of that commit. A shallow or treeless
clone cannot do that: it lacks the history to count commits since the tag, or
the objects that make git pick its abbreviation length. A tag is labeled
``<tag>-0-g<abbrev>``.

The snapshot gate builds from the bundles, not the clone: it extracts a new
snapshot into a temporary tree and runs ``webflash make-check`` and ``webflash
build --toolchain gcc`` (the build engine's commands) for every row of the
parity matrix that applies to the project. Without the engine the gate
records ``checked: null`` and says why.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import functools
import gzip
import hashlib
import importlib.util
import io
import json
import os
import posixpath
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
from dataclasses import dataclass, field
from fnmatch import fnmatchcase
from pathlib import Path

if sys.version_info >= (3, 11):
    import tomllib
else:
    try:
        import tomllib
    except ModuleNotFoundError:
        import tomli as tomllib  # type: ignore[no-redef]

from . import __version__

# The index's schema (SPEC 7.1), and the bundle format: bump FORMAT whenever
# the bytes of a bundle built from the same tree would change, so every
# snapshot built before is rebuilt.
SCHEMA = 1
FORMAT = 1

INDEX_FILE = "index.json"
REF_FILE = "ref.json"
REPORT_FILE = "make-check.json"
BLOBS = "blobs"
HISTORY = "history"
_STATE_FILE = "state.json"
_GIT = "git"
_TREES = "trees"

DEFAULT_MATRIX = Path("tools") / "parity" / "matrix.toml"

# Exit codes of `webflash sources build`: 2 means everything was written and
# published, but a listed snapshot failed the gate (so the workflow can deploy
# and still mark the run failed).
EXIT_GATE_FAILED = 2

_HEX40 = re.compile(r"[0-9a-f]{40}")
_BLOB_RE = re.compile(r"blobs/[0-9a-f]{64}\.tar\.gz")
_DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")
_STAMP_RE = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z")


class SourcesError(Exception):
    """A problem with the outside world (git, the network, the cache)."""


# ── Policy (sources.toml) ────────────────────────────────────────────

_TOP_KEYS = ("age_days", "superseded_days", "history_gate")
_TABLES = ("core", "prune")
_PROJECT_KEYS = ("title", "repo", "default_branch", "branches", "tags", "tag_pattern", "pin",
                 "history_days", "history_max")
# How the gate checks a history snapshot: "full" builds every row that applies,
# like a ref's gate; "reduced" runs make-check on every row and builds one row
# per architecture.
HISTORY_GATES = ("full", "reduced")
_CORE_KEYS = ("include",)
_PRUNE_KEYS = ("keep", "drop", "always")
_NAME_RE = re.compile(r"[a-z][a-z0-9-]*")
# A ref name as the policy may write it: what git allows, minus anything that
# could escape a URL or a path.
_REF_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/+-]*")
# A core pattern naming a whole lib/<dir>: that folder is in the core bundle.
_CORE_LIB_RE = re.compile(r"lib/([A-Za-z0-9._+-]+)/\*\*")


@dataclass
class ProjectPolicy:
    name: str
    title: str
    repo: str
    default_branch: str
    branches: list[str] = field(default_factory=list)
    tags: int = 0
    tag_pattern: str = ""
    pin: list[str] = field(default_factory=list)
    history_days: int = 0
    history_max: int = 0


@dataclass
class Policy:
    projects: dict[str, ProjectPolicy]
    core: list[str]
    keep: list[str]
    drop: list[str]
    always: list[str]
    age_days: int = 30
    superseded_days: int = 2
    history_gate: str = "full"
    path: Path | None = None

    def digest(self) -> str:
        """What a snapshot's bundles depend on besides the tree: the bundle
        format and the selection rules. A snapshot built under another digest
        is rebuilt."""
        rules = {"format": FORMAT, "core": self.core, "keep": self.keep,
                 "drop": self.drop, "always": self.always}
        text = json.dumps(rules, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(text.encode("utf-8")).hexdigest()

    def core_libs(self) -> list[str]:
        """The lib/<dir> folders the core bundle holds whole."""
        return sorted(f"lib/{m.group(1)}" for m in map(_CORE_LIB_RE.fullmatch, self.core) if m)


def _fail(where: str, message: str):
    raise ValueError(f"{where}: {message}")


def _check_keys(table: dict, allowed: tuple[str, ...], where: str) -> None:
    unknown = sorted(str(k) for k in table if k not in allowed)
    if unknown:
        _fail(where, f"unknown key(s): {', '.join(unknown)} (valid: {', '.join(allowed)})")


def _str(table: dict, key: str, where: str, *, required: bool = True, default: str = "") -> str:
    if key not in table:
        if required:
            _fail(where, f"missing required key '{key}'")
        return default
    value = table[key]
    if not isinstance(value, str) or not value.strip():
        _fail(where, f"{key} must be a non-empty string (got {value!r})")
    return value.strip()


def _str_list(table: dict, key: str, where: str) -> list[str]:
    value = table.get(key, [])
    if not isinstance(value, list) or not all(isinstance(v, str) and v.strip() for v in value):
        _fail(where, f"{key} must be a list of non-empty strings (got {value!r})")
    if len(set(value)) != len(value):
        _fail(where, f"{key} lists a value twice")
    return [v.strip() for v in value]


def _count(table: dict, key: str, where: str, default: int) -> int:
    value = table.get(key, default)
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        _fail(where, f"{key} must be a whole number of 0 or more (got {value!r})")
    return value


def _load_project(name: str, table: object, fname: str) -> ProjectPolicy:
    where = f"{fname}: [{name}]"
    if not isinstance(table, dict):
        _fail(f"{fname}", f"'{name}' must be a table, written as '[{name}]'")
    if not _NAME_RE.fullmatch(name):
        _fail(where, "a project name is lowercase letters, digits and dashes, starting with a letter")
    if name in (_GIT, BLOBS, _TREES, HISTORY):
        _fail(where, f"'{name}' is a folder name the cache uses; name the project otherwise")
    _check_keys(table, _PROJECT_KEYS, where)
    repo = _str(table, "repo", where)
    # A local path is accepted too, for tests and mirrors; anything else must
    # be https, which is what the workflow can clone without credentials.
    if not (repo.startswith("https://") or Path(repo).is_absolute()):
        _fail(where, f"repo must be an https URL (got {repo!r})")
    project = ProjectPolicy(
        name=name,
        title=_str(table, "title", where),
        repo=repo,
        default_branch=_str(table, "default_branch", where),
        branches=_str_list(table, "branches", where),
        tags=_count(table, "tags", where, 0),
        tag_pattern=_str(table, "tag_pattern", where, required=False),
        pin=_str_list(table, "pin", where),
        history_days=_count(table, "history_days", where, 0),
        history_max=_count(table, "history_max", where, 0),
    )
    for ref in [project.default_branch, *project.branches, *project.pin]:
        if not _REF_RE.fullmatch(ref) or ".." in ref:
            _fail(where, f"not a usable ref name: {ref!r}")
    if project.default_branch in project.branches:
        _fail(where, f"branches lists the default branch {project.default_branch!r}, which is always published")
    if project.tag_pattern:
        try:
            re.compile(project.tag_pattern)
        except re.error as e:
            _fail(where, f"tag_pattern is not a valid regular expression: {e}")
    return project


def _patterns(table: dict, key: str, where: str, *, folder_only_slash: bool) -> list[str]:
    values = _str_list(table, key, where)
    for value in values:
        if folder_only_slash and "/" in value.rstrip("/"):
            _fail(where, f"{key}: {value!r}: a prune pattern names a file or a folder ('name/'), not a path")
        if not folder_only_slash and (value.startswith("/") or ".." in value.split("/")):
            _fail(where, f"{key}: {value!r} must be a path relative to the repository root")
    return values


def load_policy(path: Path) -> Policy:
    """Read ``sources.toml``. Unknown keys are errors, as in a board TOML."""
    path = Path(path)
    fname = path.name
    try:
        text = path.read_bytes().decode("utf-8-sig")
    except OSError as e:
        raise ValueError(f"cannot read the snapshot policy: {e}") from None
    except UnicodeDecodeError as e:
        raise ValueError(f"{fname} is not UTF-8 text: {e}") from None
    try:
        raw = tomllib.loads(text)
    except tomllib.TOMLDecodeError as e:
        raise ValueError(f"invalid TOML in {fname}: {e}") from None

    for key in _TOP_KEYS:
        if key in raw and isinstance(raw[key], dict):
            _fail(fname, f"'{key}' is a setting, not a table")
    history_gate = _str(raw, "history_gate", fname, required=False, default="full")
    if history_gate not in HISTORY_GATES:
        _fail(fname, f"history_gate must be one of {', '.join(HISTORY_GATES)} (got {history_gate!r})")
    projects = {}
    for name, value in raw.items():
        if name in _TOP_KEYS or name in _TABLES:
            continue
        if not isinstance(value, dict):
            _fail(fname, f"unknown top-level key {name!r} (valid: {', '.join(_TOP_KEYS)}, "
                         "[core], [prune] and one table per project)")
        projects[name] = _load_project(name, value, fname)
    if not projects:
        _fail(fname, "no projects: add a table per project, such as [klipper]")

    core = raw.get("core")
    if not isinstance(core, dict):
        _fail(fname, "missing required [core] table (what the core bundle holds)")
    _check_keys(core, _CORE_KEYS, f"{fname}: [core]")
    include = _patterns(core, "include", f"{fname}: [core]", folder_only_slash=False)
    if not include:
        _fail(f"{fname}: [core]", "include must name at least the Makefile and src/**")

    prune = raw.get("prune")
    if not isinstance(prune, dict):
        _fail(fname, "missing required [prune] table (what the lib/<dir> bundles keep)")
    _check_keys(prune, _PRUNE_KEYS, f"{fname}: [prune]")
    where = f"{fname}: [prune]"
    return Policy(
        projects=projects,
        core=include,
        keep=_patterns(prune, "keep", where, folder_only_slash=True),
        drop=_patterns(prune, "drop", where, folder_only_slash=True),
        always=_patterns(prune, "always", where, folder_only_slash=True),
        age_days=_count(raw, "age_days", fname, 30),
        superseded_days=_count(raw, "superseded_days", fname, 2),
        history_gate=history_gate,
        path=path,
    )


# ── Matching ─────────────────────────────────────────────────────────

def _glob_regex(pattern: str) -> re.Pattern:
    """A path glob as a regular expression: ``*`` and ``?`` stay inside one
    folder, ``**`` spans any number of them (``a/**/b`` matches ``a/b``)."""
    out = []
    i = 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            out.append("(?:.*/)?")
            i += 3
        elif pattern.startswith("/**", i) and i + 3 == len(pattern):
            out.append("/.+")       # everything under the folder, not the folder
            i += 3
        elif pattern.startswith("**", i):
            out.append(".*")
            i += 2
        elif pattern[i] == "*":
            out.append("[^/]*")
            i += 1
        elif pattern[i] == "?":
            out.append("[^/]")
            i += 1
        else:
            out.append(re.escape(pattern[i]))
            i += 1
    return re.compile("".join(out))


def core_matcher(policy: Policy):
    """A function telling whether a repository path belongs in the core."""
    regexes = [_glob_regex(p) for p in policy.core]
    return lambda path: any(r.fullmatch(path) for r in regexes)


def _prune_match(pattern: str, folders: list[str], name: str) -> bool:
    if pattern.endswith("/"):
        return any(fnmatchcase(folder, pattern[:-1]) for folder in folders)
    return fnmatchcase(name, pattern)


def prune_keeps(policy: Policy, rel: str) -> bool:
    """Whether a lib bundle keeps the file at ``rel`` (relative to its
    ``lib/<dir>/``): ``always`` wins, then ``drop``, then ``keep``; a file no
    rule names is left out."""
    *folders, name = rel.split("/")
    if any(_prune_match(p, folders, name) for p in policy.always):
        return True
    if any(_prune_match(p, folders, name) for p in policy.drop):
        return False
    return any(_prune_match(p, folders, name) for p in policy.keep)


# ── Refs ─────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class RemoteRef:
    name: str        # the ref id the site shows: "master", "v0.13.0"
    kind: str        # "branch" or "tag"
    sha: str         # the commit (a tag is peeled to the commit it names)


_VERSION_RE = re.compile(r"[vV]?(\d+(?:\.\d+)*)(.*)", re.S)
_CHUNK_RE = re.compile(r"(\d+)")


def _natural(text: str) -> tuple:
    return tuple((1, int(part), "") if i % 2 else (0, 0, part)
                 for i, part in enumerate(_CHUNK_RE.split(text)) if part)


def version_key(tag: str) -> tuple:
    """Sort key for tags, larger is newer: ``v0.13.0`` > ``v0.9.1``,
    ``v2026.11.00`` > ``v2026.10.00``. A leading version compares numerically,
    a release sorts above its own pre-releases (``v1.0.0`` > ``v1.0.0-rc1``),
    and a tag that does not start with a version sorts below every one that
    does, in natural order."""
    m = _VERSION_RE.fullmatch(tag)
    if not m:
        return ((), 0, _natural(tag))
    numbers = tuple(int(n) for n in m.group(1).split("."))
    rest = m.group(2)
    return (numbers, 0 if rest else 1, _natural(rest))


def _env() -> dict:
    # No credential prompt (a typo in a URL must fail, not hang a CI job), and
    # git's messages in English for the error lines.
    return dict(os.environ, GIT_TERMINAL_PROMPT="0", LC_ALL="C", LANGUAGE="C")


def _git(args: list[str], *, cwd: Path | None = None, input: bytes | None = None) -> bytes:
    try:
        p = subprocess.run(["git", *args], cwd=cwd, input=input, env=_env(),
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except FileNotFoundError:
        raise SourcesError("git is not installed or not on PATH") from None
    if p.returncode:
        message = p.stderr.decode("utf-8", "replace").strip().splitlines()
        raise SourcesError(f"git {' '.join(args[:2])} failed: {message[-1] if message else f'exit {p.returncode}'}")
    return p.stdout


def list_refs(project: ProjectPolicy) -> list[RemoteRef]:
    """Every branch and tag of the project's repository (``git ls-remote``).
    An annotated tag is reported with the commit it names."""
    out = _git(["ls-remote", "--heads", "--tags", project.repo]).decode("utf-8", "replace")
    heads: dict[str, str] = {}
    tags: dict[str, str] = {}
    peeled: dict[str, str] = {}
    for line in out.splitlines():
        sha, _, ref = line.strip().partition("\t")
        if ref.startswith("refs/heads/"):
            heads[ref[len("refs/heads/"):]] = sha
        elif ref.startswith("refs/tags/"):
            name = ref[len("refs/tags/"):]
            if name.endswith("^{}"):
                peeled[name[:-3]] = sha
            else:
                tags[name] = sha
    tags.update(peeled)
    return ([RemoteRef(n, "branch", s) for n, s in sorted(heads.items())]
            + [RemoteRef(n, "tag", s) for n, s in sorted(tags.items())])


def select_refs(project: ProjectPolicy, remote: list[RemoteRef],
                warnings: list[str] | None = None) -> list[RemoteRef]:
    """The refs the policy publishes, in index order: the default branch, the
    newest ``tags`` tags matching ``tag_pattern`` (and pinned tags), newest
    first, then ``branches`` and pinned branches in the policy's order."""
    warnings = warnings if warnings is not None else []
    heads = {r.name: r for r in remote if r.kind == "branch"}
    tags = {r.name: r for r in remote if r.kind == "tag"}
    if project.default_branch not in heads:
        raise SourcesError(f"{project.name}: the default branch {project.default_branch!r} "
                           f"does not exist in {project.repo}")
    pattern = re.compile(project.tag_pattern) if project.tag_pattern else None
    candidates = [t for t in tags.values() if pattern is None or pattern.fullmatch(t.name)]
    candidates.sort(key=lambda r: version_key(r.name), reverse=True)
    chosen_tags = {t.name: t for t in candidates[:project.tags]}
    branches = []
    for name in project.branches:
        if name in heads:
            branches.append(heads[name])
        else:
            warnings.append(f"{project.name}: branch {name!r} does not exist upstream")
    for name in project.pin:
        if name in tags:
            chosen_tags.setdefault(name, tags[name])
        elif name in heads:
            if name != project.default_branch and heads[name] not in branches:
                branches.append(heads[name])
        else:
            warnings.append(f"{project.name}: pinned ref {name!r} does not exist upstream")
    ordered_tags = sorted(chosen_tags.values(), key=lambda r: version_key(r.name), reverse=True)
    return [heads[project.default_branch], *ordered_tags, *branches]


def history_since(project: ProjectPolicy, today: _dt.date) -> int:
    """The start of the history window, as a Unix time: midnight UTC
    ``history_days`` days before today."""
    start = _dt.datetime.combine(today - _dt.timedelta(days=project.history_days), _dt.time(),
                                 _dt.timezone.utc)
    return int(start.timestamp())


def list_history(repo: Path, head: str, since: int) -> list[tuple[str, int]]:
    """The first-parent commits of ``head`` committed at ``since`` or later,
    newest first, as ``(sha, commit time)``, ``head`` itself included."""
    start = _dt.datetime.fromtimestamp(since, _dt.timezone.utc).strftime("%Y-%m-%d %H:%M:%S +0000")
    out = _git(["rev-list", "--first-parent", f"--since={start}", "--format=%ct", head], cwd=repo)
    commits: list[tuple[str, int]] = []
    sha = None
    for line in out.decode("ascii", "replace").splitlines():
        if line.startswith("commit "):
            sha = line.split()[1]
        elif sha and line.strip().isdigit():
            commits.append((sha, int(line)))
            sha = None
    return commits


def select_history(project: ProjectPolicy, commits: list[tuple[str, int]], head: str,
                   since: int) -> list[tuple[str, int]]:
    """The history snapshots the policy keeps: the default branch's
    first-parent commits from the window (``commits`` as ``list_history``
    gives them, newest first), without the head, which the index lists as
    the default branch, and at most ``history_max`` of them."""
    if not project.history_days:
        return []
    kept = [(sha, ct) for sha, ct in commits if sha != head and ct >= since]
    return kept[:project.history_max] if project.history_max else kept


# ── Files ────────────────────────────────────────────────────────────

def _write_bytes(path: Path, data: bytes) -> None:
    """Write a file whole or not at all: a run stopped halfway (a cancelled
    job, a full disk) must never leave a truncated bundle under its final name."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    try:
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            tmp.unlink()


def _json_bytes(data: object) -> bytes:
    return (json.dumps(data, indent=1, ensure_ascii=True) + "\n").encode("utf-8")


def _write_json(path: Path, data: object) -> None:
    _write_bytes(path, _json_bytes(data))


def _history_bytes(history: dict) -> bytes:
    """A history file: one snapshot per line, so it stays readable while
    hundreds of entries keep it small."""
    head = {k: v for k, v in history.items() if k not in ("refs", "blobs")}
    dump = lambda v: json.dumps(v, separators=(",", ":"), ensure_ascii=True)
    lines = [dump(head)[:-1] + ',"refs":[']
    lines += [dump(ref) + ("," if i < len(history["refs"]) - 1 else "")
              for i, ref in enumerate(history["refs"])]
    lines.append('],"blobs":{')
    items = list(history["blobs"].items())
    lines += [f"{dump(k)}:{dump(v)}" + ("," if i < len(items) - 1 else "") for i, (k, v) in enumerate(items)]
    lines.append("}}")
    return ("\n".join(lines) + "\n").encode("utf-8")


def _read_json(path: Path) -> dict | None:
    try:
        return json.loads(path.read_bytes())
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as e:
        raise SourcesError(f"cannot read {path}: {e}") from None


def _rmtree(path: Path) -> None:
    """``shutil.rmtree`` that also removes read-only files, which git makes of
    its pack files and Windows refuses to delete."""
    def retry(func, p, _exc):
        os.chmod(p, stat.S_IWRITE)
        func(p)
    if not path.exists():
        return
    if sys.version_info >= (3, 12):
        shutil.rmtree(path, onexc=retry)
    else:
        shutil.rmtree(path, onerror=retry)


# ── Bundles ──────────────────────────────────────────────────────────

def tar_gz(files: list[tuple[str, int, bytes]]) -> bytes:
    """A deterministic tar.gz of ``(path, mode, data)`` entries.

    Paths are sorted and use forward slashes; every entry is a regular file
    owned by uid and gid 0 with empty owner names and mtime 0; the gzip header
    has no file name and mtime 0. The bytes are written as given, never as
    text, so a CRLF file stays CRLF and an LF file LF on every platform. Plain
    ustar headers, with a pax header only for a path over 100 bytes.
    """
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.PAX_FORMAT) as tf:
        for path, mode, data in sorted(files, key=lambda f: f[0].encode("utf-8")):
            info = tarfile.TarInfo(path)
            info.size = len(data)
            info.mode = mode
            info.mtime = 0
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            info.type = tarfile.REGTYPE
            tf.addfile(info, io.BytesIO(data))
    out = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=out, compresslevel=9, mtime=0) as gz:
        gz.write(raw.getvalue())
    return out.getvalue()


def _store_blob(cache: Path, data: bytes) -> str:
    """Store a bundle under the SHA-256 of its bytes; returns its path
    relative to the sources root (``blobs/<sha256>.tar.gz``)."""
    rel = f"{BLOBS}/{hashlib.sha256(data).hexdigest()}.tar.gz"
    path = cache / rel
    if not (path.is_file() and path.stat().st_size == len(data)):
        _write_bytes(path, data)
    return rel


@dataclass
class _File:
    path: str
    mode: int
    oid: str


def _read_blobs(repo: Path, oids) -> dict[str, bytes]:
    """The contents of git blobs, read in one ``git cat-file --batch``."""
    unique = sorted(set(oids))
    if not unique:
        return {}
    out = _git(["cat-file", "--batch"], cwd=repo, input=("\n".join(unique) + "\n").encode("ascii"))
    blobs: dict[str, bytes] = {}
    pos = 0
    for oid in unique:
        end = out.index(b"\n", pos)
        header = out[pos:end].split()
        if len(header) != 3 or header[1] != b"blob":
            raise SourcesError(f"cannot read git object {oid}: {out[pos:end].decode('ascii', 'replace')}")
        size = int(header[2])
        blobs[oid] = out[end + 1:end + 1 + size]
        pos = end + 1 + size + 1
    return blobs


def _tree(repo: Path, sha: str, warnings: list[str]) -> tuple[dict[str, _File], dict[str, str], set[str]]:
    """The files of a commit, with symbolic links materialized, the tree ids
    of its ``lib/<dir>`` folders, and the folders that held a link (their
    content depends on more than their own tree)."""
    raw = _git(["ls-tree", "-r", "-t", "-z", "--full-tree", sha], cwd=repo)
    files: dict[str, _File] = {}
    links: dict[str, str] = {}
    trees: dict[str, str] = {}
    for record in raw.split(b"\0"):
        if not record:
            continue
        meta, _, name_bytes = record.partition(b"\t")
        mode, kind, oid = meta.decode("ascii").split()
        try:
            name = name_bytes.decode("utf-8")
        except UnicodeDecodeError:
            raise SourcesError(f"{sha[:12]}: a path is not UTF-8: {name_bytes!r}") from None
        if kind == "tree":
            trees[name] = oid
        elif kind == "blob" and mode == "120000":
            links[name] = oid
        elif kind == "blob":
            files[name] = _File(name, 0o755 if mode == "100755" else 0o644, oid)
        else:
            warnings.append(f"{sha[:12]}: {name}: skipped a {kind} (submodules are not bundled)")
    linked: set[str] = set()
    if links:
        contents = _read_blobs(repo, links.values())
        targets = {name: contents[oid].decode("utf-8", "replace") for name, oid in links.items()}
        for name in sorted(links):
            resolved = _resolve_link(name, targets, files, trees)
            if resolved is None:
                warnings.append(f"{sha[:12]}: {name}: skipped a symbolic link to {targets[name]!r}, "
                                "which leads nowhere inside the tree")
                continue
            for path, entry in resolved:
                files.setdefault(path, _File(path, entry.mode, entry.oid))
            linked.add("/".join(name.split("/")[:2]))
    lib_trees = {name: oid for name, oid in trees.items()
                 if name.startswith("lib/") and name.count("/") == 1}
    return files, lib_trees, linked


def _resolve_link(name: str, targets: dict[str, str], files: dict[str, _File],
                  trees: dict[str, str], depth: int = 0) -> list[tuple[str, _File]] | None:
    """What a link stands for: ``[(path, file)]`` with the link's own path for
    a file, or every file of a linked folder under the link's path."""
    if depth > 8:
        return None
    target = posixpath.normpath(posixpath.join(posixpath.dirname(name), targets[name]))
    if target.startswith("../") or target == ".." or target.startswith("/"):
        return None
    if target in files:
        return [(name, files[target])]
    if target in targets:
        chained = _resolve_link(target, targets, files, trees, depth + 1)
        return None if chained is None else [(name + p[len(target):], f) for p, f in chained]
    if target in trees:
        prefix = target + "/"
        return [(name + "/" + p[len(prefix):], f) for p, f in sorted(files.items()) if p.startswith(prefix)]
    return None


def _board_directories(texts: dict[str, bytes]) -> list[str]:
    """The architectures a tree supports, in menuconfig's order: the
    ``BOARD_DIRECTORY`` each ``src/<x>/Kconfig`` sourced from ``src/Kconfig``
    sets (``stm32``, ``rp2040``, ...)."""
    main = texts.get("src/Kconfig", b"").decode("utf-8", "replace")
    archs: list[str] = []
    for folder in re.findall(r'^\s*source\s+"src/([^/"]+)/Kconfig"', main, re.M):
        lines = texts.get(f"src/{folder}/Kconfig", b"").decode("utf-8", "replace").splitlines()
        board = None
        for i, line in enumerate(lines):
            if re.fullmatch(r"\s*config\s+BOARD_DIRECTORY\s*", line):
                for follow in lines[i + 1:]:
                    m = re.fullmatch(r'\s*default\s+"([^"]+)"\s*', follow)
                    if m:
                        board = m.group(1)
                        break
                    if re.match(r"\s*(config|menuconfig|choice|endchoice|menu|endmenu|if|endif|source)\b", follow):
                        break
                break
        if board and board not in archs:
            archs.append(board)
    return archs


@dataclass
class _Repos:
    """The full bare clone of each project, in ``folder``, cloned or fetched
    once per run and only when a snapshot needs building."""
    folder: Path
    log: object
    ready: dict[str, Path] = field(default_factory=dict)

    def get(self, project: ProjectPolicy) -> Path:
        if project.name in self.ready:
            return self.ready[project.name]
        path = self.folder / f"{project.name}.git"
        current = None
        if (path / "HEAD").is_file():
            try:
                current = _git(["config", "--get", "remote.origin.url"], cwd=path).decode().strip()
            except SourcesError:
                current = None
        if current == project.repo:
            self.log(f"  fetching {project.repo}")
            _git(["fetch", "--quiet", "--prune", "--force", "origin",
                  "+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"], cwd=path)
        else:
            _rmtree(path)
            self.log(f"  cloning {project.repo} (a full clone: git describe needs the history)")
            tmp = path.with_name(path.name + ".partial")
            _rmtree(tmp)
            path.parent.mkdir(parents=True, exist_ok=True)
            _git(["clone", "--bare", "--quiet", project.repo, str(tmp)])
            os.replace(tmp, path)
        self.ready[project.name] = path
        return path


def _has_commit(repo: Path, sha: str) -> bool:
    try:
        _git(["cat-file", "-e", f"{sha}^{{commit}}"], cwd=repo)
        return True
    except SourcesError:
        return False


def snapshot_dir(cache: Path, project: str, sha: str) -> Path:
    return cache / project / sha


def snapshot_current(policy: Policy, cache: Path, project: str, sha: str) -> dict | None:
    """The cached manifest of a snapshot if it is complete and was built under
    the current rules, else None."""
    manifest = _read_json(snapshot_dir(cache, project, sha) / REF_FILE)
    if not manifest or manifest.get("digest") != policy.digest():
        return None
    blobs = [manifest["core"]["blob"]] + [lib["blob"] for lib in manifest["libs"].values()]
    if not all((cache / blob).is_file() for blob in blobs):
        return None
    return manifest


def build_snapshot(policy: Policy, project: ProjectPolicy, sha: str, cache: Path, repo: Path,
                   log, warnings: list[str]) -> dict:
    """Bundle one commit: the core bundle, one bundle per lib/<dir> (reused
    from an earlier snapshot when the folder's git tree is unchanged), and the
    manifest ``<project>/<sha>/ref.json``. Returns the manifest."""
    if not _has_commit(repo, sha):
        _git(["fetch", "--quiet", "origin", sha], cwd=repo)
    files, lib_trees, linked = _tree(repo, sha, warnings)
    in_core = core_matcher(policy)
    core_libs = policy.core_libs()
    digest = policy.digest()

    core_files = [f for f in files.values() if in_core(f.path)]
    core_data = _read_blobs(repo, [f.oid for f in core_files])
    entries = [(f.path, f.mode, core_data[f.oid]) for f in core_files]
    core_blob = tar_gz(entries)
    core = {"blob": _store_blob(cache, core_blob), "size": len(core_blob),
            "unpacked": sum(len(e[2]) for e in entries), "files": len(entries)}
    texts = {f.path: core_data[f.oid] for f in core_files if f.path.endswith("Kconfig")}

    libs: dict[str, dict] = {}
    built = reused = 0
    for folder, tree in sorted(lib_trees.items()):
        if folder in core_libs:
            continue
        record_path = cache / _TREES / f"{tree}-{digest[:16]}.json"
        record = None if folder in linked else _read_json(record_path)
        if record and (cache / record["blob"]).is_file():
            libs[folder] = dict(record, tree=tree)
            reused += 1
            continue
        prefix = folder + "/"
        chosen = [f for f in files.values()
                  if f.path.startswith(prefix) and prune_keeps(policy, f.path[len(prefix):])]
        if not chosen:
            continue        # a folder with nothing to build from (a host tool)
        data = _read_blobs(repo, [f.oid for f in chosen])
        lib_entries = [(f.path, f.mode, data[f.oid]) for f in chosen]
        blob = tar_gz(lib_entries)
        info = {"blob": _store_blob(cache, blob), "size": len(blob),
                "unpacked": sum(len(e[2]) for e in lib_entries), "files": len(lib_entries)}
        if folder not in linked:
            _write_json(record_path, info)
        libs[folder] = dict(info, tree=tree)
        built += 1

    date = _dt.datetime.fromtimestamp(int(_git(["show", "-s", "--format=%ct", sha], cwd=repo)),
                                      _dt.timezone.utc).strftime("%Y-%m-%d")
    manifest = {
        "schema": SCHEMA,
        "format": FORMAT,
        "digest": digest,
        "project": project.name,
        "sha": sha,
        "date": date,
        "describe": _git(["describe", "--tags", "--long", "--always", sha], cwd=repo).decode().strip(),
        "abbrev": _git(["rev-parse", "--short", sha], cwd=repo).decode().strip(),
        "archs": _board_directories(texts),
        "core": core,
        "core_libs": [lib for lib in core_libs if lib in lib_trees],
        "libs": libs,
    }
    _write_json(snapshot_dir(cache, project.name, sha) / REF_FILE, manifest)
    log(f"  core {_size(core['size'])} ({core['files']} files), {len(libs)} lib bundles "
        f"({built} new, {reused} reused by tree)")
    return manifest


# ── Gate ─────────────────────────────────────────────────────────────

def gate_unavailable() -> str | None:
    """Why the gate cannot run here, or None when it can: it needs the build
    engine's ``webflash make-check`` and ``webflash build``."""
    try:
        spec = importlib.util.find_spec("webflash.engine.cli")
    except ModuleNotFoundError:
        spec = None
    if spec is None:
        return ("the build engine is not installed, so webflash make-check and webflash build "
                "cannot run")
    return None


@functools.lru_cache(maxsize=None)
def _engine_identity(matrix: Path) -> str:
    """A digest of the engine's code, the gate's own (this module) and the
    parity matrix: a snapshot that failed the gate is checked again when any
    of them changes."""
    digest = hashlib.sha256(__version__.encode() + b"\0" + Path(__file__).read_bytes())
    try:
        spec = importlib.util.find_spec("webflash.engine")
    except ModuleNotFoundError:
        spec = None
    for folder in (spec.submodule_search_locations if spec else None) or []:
        for path in sorted(Path(folder).rglob("*.py"), key=lambda p: p.as_posix()):
            digest.update(path.relative_to(folder).as_posix().encode() + b"\0" + path.read_bytes())
    if matrix.is_file():
        digest.update(b"matrix\0" + matrix.read_bytes())
    return digest.hexdigest()[:16]


def _matrix_rows(matrix: Path, project: str) -> list[dict]:
    """The parity matrix rows (``[[row]]`` with ``name``, ``projects`` and
    ``defconfig``, and optionally ``unless``) that name this project."""
    raw = tomllib.loads(matrix.read_bytes().decode("utf-8-sig"))
    rows = raw.get("row")
    if not isinstance(rows, list):
        raise ValueError(f"{matrix}: expected [[row]] tables")
    out = []
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("name"), str):
            raise ValueError(f"{matrix}: every [[row]] needs a name")
        projects = row.get("projects", [row.get("project")])
        if project in projects:
            if not isinstance(row.get("defconfig"), str):
                raise ValueError(f"{matrix}: row {row['name']!r} needs a defconfig")
            unless = row.get("unless", [])
            if not (isinstance(unless, list)
                    and all(isinstance(s, str) and _SYMBOL_RE.fullmatch(s) for s in unless)):
                raise ValueError(f"{matrix}: row {row['name']!r}: unless must be a list of Kconfig "
                                 "symbol names without CONFIG_, such as \"MACH_RPXXXX\"")
            out.append(row)
    return out


_KCONFIG_SYMBOL_RE = re.compile(r"^\s*(?:menu)?config\s+([A-Za-z0-9_]+)", re.M)
_DEFCONFIG_SYMBOL_RE = re.compile(r"^\s*(?:#\s*)?CONFIG_([A-Za-z0-9_]+)", re.M)
_SYMBOL_RE = re.compile(r"(?!CONFIG_)[A-Za-z0-9_]+")


def _defined_symbols(tree: Path) -> set[str]:
    """Every symbol this tree's Kconfig files define."""
    defined: set[str] = set()
    for path in tree.rglob("Kconfig*"):
        # The name test again, case-sensitive: on Windows the glob is not, and
        # would also read lib/kconfiglib/kconfiglib.py.
        if path.is_file() and path.name.startswith("Kconfig"):
            defined.update(_KCONFIG_SYMBOL_RE.findall(path.read_text("utf-8", "replace")))
    return defined


def _missing_symbols(tree: Path, defconfig: str, defined: set[str] | None = None) -> list[str]:
    """The symbols a row sets that this tree's Kconfig files never define: a
    row for an MCU an old tag predates does not apply to that tag."""
    if defined is None:
        defined = _defined_symbols(tree)
    wanted = _DEFCONFIG_SYMBOL_RE.findall(defconfig)
    return sorted({s for s in wanted if s not in defined})


def _row_skip_reason(tree: Path, row: dict, defined: set[str] | None = None) -> str | None:
    """Why a matrix row does not apply to this tree, or None when it does: it
    sets a symbol the tree's Kconfig never defines, or the tree defines a
    symbol the row's ``unless`` names (the newer layout an older row stands in
    for, such as MACH_RPXXXX for a row of Klipper's MACH_RP2040)."""
    if defined is None:
        defined = _defined_symbols(tree)
    missing = _missing_symbols(tree, row["defconfig"], defined)
    if missing:
        return f"this tree's Kconfig does not define {', '.join(missing)}"
    present = sorted(s for s in row.get("unless", []) if s in defined)
    if present:
        return f"the row is for trees without {', '.join(present)}, which this tree's Kconfig defines"
    return None


def _extract(cache: Path, manifest: dict, tree: Path) -> None:
    for blob in [manifest["core"]["blob"]] + [lib["blob"] for lib in manifest["libs"].values()]:
        with tarfile.open(cache / blob, "r:gz") as tf:
            if sys.version_info >= (3, 12):
                tf.extractall(tree, filter="data")
            else:
                tf.extractall(tree)
    # The bundles store mtime 0, which GNU make for Windows reads as out of
    # range and so newer than anything: make-check's real make would then
    # remake .config from src/Kconfig on every level. One ordinary time for
    # the whole tree, a minute back, so whatever is written next is newer.
    stamp = time.time() - 60
    for path in tree.rglob("*"):
        os.utime(path, (stamp, stamp))


def _run(argv: list[str], cwd: Path, timeout: int) -> dict:
    start = time.monotonic()
    try:
        p = subprocess.run(argv, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                           timeout=timeout)
        code, output = p.returncode, p.stdout
    except subprocess.TimeoutExpired as e:
        code, output = None, (e.stdout or b"") + f"\n[timed out after {timeout} s]".encode()
    text = output.decode("utf-8", "replace").replace("\r\n", "\n")
    # The tail is what explains a failure; the whole log of a build is long.
    if len(text) > 12000:
        text = "[...]\n" + text[-12000:]
    return {"ok": code == 0, "code": code, "seconds": round(time.monotonic() - start, 1),
            "command": " ".join(["webflash", *argv[3:]]), "output": text}


_ARCH_RE = re.compile(r"^CONFIG_(MACH_[A-Za-z0-9_]+)=y\s*$", re.M)


def _row_arch(row: dict) -> str:
    """The architecture a matrix row builds for: the first ``CONFIG_MACH_*``
    its defconfig sets (``MACH_STM32``), else the project's default."""
    m = _ARCH_RE.search(row["defconfig"])
    return m.group(1) if m else ""


def run_gate(cache: Path, manifest: dict, describe: str, matrix: Path, log,
             *, now: _dt.datetime, skip: str | None = None, run: str | None = None,
             mode: str = "full") -> dict:
    """Run the snapshot gate on a snapshot's bundles and write its report,
    ``<project>/<sha>/make-check.json``. ``checked`` is True when every row of
    the matrix that applies passed both commands, False when one failed, and
    None when the gate did not run (``skip`` or no engine) or no row applies.
    ``run`` names the run, recorded so that a re-run can tell its own failures.
    ``mode`` "reduced" (history snapshots, see ``HISTORY_GATES``) builds only
    the first row that applies for each architecture; the other rows' builds
    are recorded as skipped, and ``gate`` in the report says which it was."""
    project, sha = manifest["project"], manifest["sha"]
    report = {"schema": SCHEMA, "project": project, "sha": sha, "describe": describe,
              "checked": None, "note": "", "webflash": __version__, "ran": _stamp(now),
              "gate": mode}
    if run is not None:
        report["run"] = run
    report["rows"] = []
    reason = skip or gate_unavailable()
    if reason is None and not matrix.is_file():
        reason = f"there is no parity matrix at {matrix.as_posix()}"
    rows: list[dict] = []
    if reason is None:
        try:
            rows = _matrix_rows(matrix, project)
        except (ValueError, tomllib.TOMLDecodeError) as e:
            reason = f"the parity matrix cannot be read: {e}"
    if reason is None and not rows:
        reason = f"the parity matrix has no row for {project}"
    if reason is not None:
        report["note"] = f"The snapshot gate did not run: {reason}."
        log(f"  gate: not run ({reason})")
        path = snapshot_dir(cache, project, sha) / REPORT_FILE
        old = _read_json(path)
        # The same verdict for the same reason leaves the file alone, so a run
        # that changes nothing writes nothing.
        if not (old and old.get("checked") is None and old.get("note") == report["note"]):
            _write_json(path, report)
        return report

    report["engine"] = _engine_identity(matrix)
    work = Path(tempfile.mkdtemp(prefix="webflash-gate-"))
    try:
        tree = work / "tree"
        _extract(cache, manifest, tree)
        results = []
        defined = _defined_symbols(tree)
        built_archs: dict[str, str] = {}
        for row in rows:
            name = row["name"]
            result = {"row": name}
            why_not = _row_skip_reason(tree, row, defined)
            if why_not:
                result["applies"] = False
                result["note"] = why_not
                log(f"  gate: {name}: does not apply ({result['note']})")
                results.append(result)
                continue
            result["applies"] = True
            config = work / f"{name}.config"
            config.write_bytes(row["defconfig"].encode("utf-8"))
            base = [sys.executable, "-m", "webflash"]
            result["make_check"] = _run([*base, "make-check", str(tree), "--config", str(config),
                                         "--project", project], work, 900)
            arch = _row_arch(row)
            if mode == "reduced" and arch in built_archs:
                result["build"] = {"ok": True, "skipped": True, "seconds": 0.0,
                                   "note": f"reduced gate: the row {built_archs[arch]} built this architecture"}
            else:
                built_archs.setdefault(arch, name)
                result["build"] = _run([*base, "build", str(tree), "--config", str(config),
                                        "--toolchain", "gcc", "--version", describe,
                                        "-j", str(os.cpu_count() or 2), "--out", str(work / f"out-{name}")],
                                       work, 1800)
            ok = result["make_check"]["ok"] and result["build"]["ok"]
            log(f"  gate: {name}: {'passed' if ok else 'FAILED'} "
                f"(make-check {result['make_check']['seconds']} s, build {result['build']['seconds']} s)")
            results.append(result)
    finally:
        _rmtree(work)
    report["rows"] = results
    applied = [r for r in results if r["applies"]]
    if not applied:
        report["note"] = "No row of the parity matrix applies to this tree."
    else:
        report["checked"] = all(r["make_check"]["ok"] and r["build"]["ok"] for r in applied)
    _write_json(snapshot_dir(cache, project, sha) / REPORT_FILE, report)
    return report


def gate_needed(report: dict | None, matrix: Path, *, gate: bool, run: str | None = None) -> bool:
    """Whether a snapshot's gate should run (again): never ran; did not run
    for want of an engine or a matrix that now exist; failed under an engine
    or matrix that has changed since; or failed in this same ``run``, which is
    then a re-run (GitHub restores the first attempt's cache, failures and
    all), so it checks the failure again rather than passing over it."""
    if report is None:
        return True
    if not gate:
        return False
    if report.get("checked") is None:
        return gate_unavailable() is None and matrix.is_file() and not report.get("rows")
    if report.get("checked") is False:
        return (report.get("engine") != _engine_identity(matrix)
                or (run is not None and report.get("run") == run))
    return False


# ── State, aging and the index ───────────────────────────────────────

def _stamp(moment: _dt.datetime) -> str:
    return moment.astimezone(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _day(text: str) -> _dt.date:
    return _dt.date.fromisoformat(text)


def load_state(cache: Path) -> dict:
    state = _read_json(cache / _STATE_FILE) or {}
    state.setdefault("schema", SCHEMA)
    state.setdefault("projects", {})
    return state


def save_state(cache: Path, state: dict) -> None:
    _write_json(cache / _STATE_FILE, state)


def _project_state(state: dict, name: str) -> dict:
    project = state["projects"].setdefault(name, {})
    project.setdefault("refs", {})
    project.setdefault("superseded", {})
    return project


def record_history(state: dict, project: str, kept: list[tuple[str, int]], today: _dt.date) -> None:
    """Remember that the policy kept these history snapshots today (``(sha,
    commit time)``, as ``select_history`` gives them)."""
    history = _project_state(state, project).setdefault("history", {})
    for sha, ct in kept:
        history[sha] = {"ct": ct, "seen": today.isoformat()}


def _retire(project_state: dict, sha: str, today: _dt.date) -> None:
    """A snapshot no ref points at any more stays published for a while."""
    if all(ref["sha"] != sha for ref in project_state["refs"].values()):
        project_state["superseded"].setdefault(sha, today.isoformat())


def record_ref(state: dict, project: str, ref: RemoteRef, today: _dt.date) -> None:
    """Remember that the policy selected ``ref`` today."""
    project_state = _project_state(state, project)
    previous = project_state["refs"].get(ref.name)
    project_state["refs"][ref.name] = {"kind": ref.kind, "sha": ref.sha, "seen": today.isoformat()}
    project_state["superseded"].pop(ref.sha, None)
    if previous and previous["sha"] != ref.sha:
        _retire(project_state, previous["sha"], today)


_ALL = object()


def age_out(state: dict, today: _dt.date, days: int, superseded_days: int,
            projects: list[str] | None = None, history_projects=_ALL) -> list[str]:
    """Drop refs the policy has not selected for more than ``days`` days, and
    superseded snapshots older than ``superseded_days``. ``projects`` limits
    the refs aged to those projects (whose whole policy ran): None ages every
    project's refs, an empty list (a ``--ref`` run, which records only the
    refs it rebuilt) ages none. Superseded snapshots age in every project.
    History snapshots the policy has not kept for more than ``days`` days
    (they left the window, or ``history_max``) age the same way, in
    ``history_projects`` (default: as ``projects``), the projects whose
    history was listed in this run. Returns what was dropped, for the log."""
    if history_projects is _ALL:
        history_projects = projects
    dropped = []
    for name, project_state in state["projects"].items():
        if projects is None or name in projects:
            for ref_id, ref in list(project_state.get("refs", {}).items()):
                if (today - _day(ref["seen"])).days > days:
                    del project_state["refs"][ref_id]
                    _retire(project_state, ref["sha"], today)
                    dropped.append(f"{name} {ref_id} (last selected {ref['seen']})")
        if history_projects is None or name in history_projects:
            history = project_state.get("history", {})
            old = [sha for sha, entry in history.items() if (today - _day(entry["seen"])).days > days]
            for sha in old:
                del history[sha]
            if old:
                dropped.append(f"{name}: {len(old)} history snapshot{'s' * (len(old) != 1)}")
        for sha, since in list(project_state.get("superseded", {}).items()):
            if (today - _day(since)).days >= superseded_days:
                del project_state["superseded"][sha]
    return dropped


def _ref_order(project: ProjectPolicy, ref_id: str, kind: str) -> tuple:
    """Index order: the default branch, tags newest first, then branches in
    the policy's order (``branches``, then pinned ones), then any others by name."""
    if ref_id == project.default_branch and kind == "branch":
        return (0,)
    if kind == "tag":
        return (1, _Neg(version_key(ref_id)))
    listed = project.branches + [p for p in project.pin if p not in project.branches]
    return (2, listed.index(ref_id) if ref_id in listed else len(listed), ref_id)


class _Neg:
    """Reverses the order of a sort key, for newest-first tags in an
    ascending sort."""
    def __init__(self, key):
        self.key = key

    def __lt__(self, other):
        return self.key > other.key

    def __eq__(self, other):
        return self.key == other.key


def _ref_entry(cache: Path, name: str, ref_id: str, kind: str, sha: str, manifest: dict,
               blobs: dict[str, dict]) -> dict:
    """A ref's entry in the index or a history file; adds its bundles' sizes
    to ``blobs``."""
    report = _read_json(snapshot_dir(cache, name, sha) / REPORT_FILE) or {}
    describe = f"{ref_id}-0-g{manifest['abbrev']}" if kind == "tag" else manifest["describe"]
    for info in [manifest["core"], *manifest["libs"].values()]:
        blobs[info["blob"]] = {"size": info["size"], "unpacked": info["unpacked"],
                               "files": info["files"]}
    return {
        "id": ref_id,
        "kind": kind,
        "sha": sha,
        "describe": describe,
        "date": manifest["date"],
        "core": manifest["core"]["blob"],
        "core_libs": manifest["core_libs"],
        "libs": {lib: info["blob"] for lib, info in sorted(manifest["libs"].items())},
        "archs": manifest["archs"],
        "checked": report.get("checked"),
        "check_report": f"{name}/{sha}/{REPORT_FILE}",
    }


def history_file(project: str) -> str:
    """Where a project's history snapshots are listed, relative to ``/sources/``."""
    return f"{HISTORY}/{project}.json"


def make_histories(policy: Policy, cache: Path, state: dict,
                   warnings: list[str] | None = None) -> dict[str, dict]:
    """The history file of each project that keeps history snapshots
    (``history/<project>.json``): its snapshots newest first, each with the
    fields of an index ref and ``kind`` "commit", its ``id`` being its
    ``git describe`` string, and a ``blobs`` table of their bundles. No time
    stamp, so a run that keeps the same snapshots writes the same bytes."""
    warnings = warnings if warnings is not None else []
    out: dict[str, dict] = {}
    for name in policy.projects:
        project_state = _project_state(state, name)
        history = project_state.get("history", {})
        # Newest first: by day, then in the branch's own (first-parent) order,
        # which commit times within a day do not always follow.
        listed = project_state.get("history_list", {}).get("commits", [])
        place = {sha: i for i, (sha, _ct) in enumerate(listed)}
        order = lambda kv: (-(kv[1]["ct"] // 86400), place.get(kv[0], len(place)), -kv[1]["ct"], kv[0])
        entries = []
        blobs: dict[str, dict] = {}
        for sha, entry in sorted(history.items(), key=order):
            manifest = _read_json(snapshot_dir(cache, name, sha) / REF_FILE)
            if manifest is None:
                warnings.append(f"{name} {sha[:12]}: the history snapshot is missing from the "
                                "cache, so the history file leaves it out")
                continue
            entries.append(_ref_entry(cache, name, manifest["describe"], "commit", sha, manifest, blobs))
        if entries:
            out[name] = {"schema": SCHEMA, "project": name, "refs": entries,
                         "blobs": dict(sorted(blobs.items()))}
    return out


def make_index(policy: Policy, cache: Path, state: dict, now: _dt.datetime,
               warnings: list[str] | None = None, histories: dict[str, dict] | None = None) -> dict:
    """The index (SPEC 7.1) of every ref in the state, in policy order. Two
    additions to the SPEC's fields: each ref's ``core_libs`` (the lib/<dir>
    folders the core bundle holds, so a folder in neither list is missing),
    and a ``blobs`` table giving each bundle's size, unpacked size and file
    count, for the sizes the site shows before a download. A project with
    history snapshots (``histories``, from ``make_histories``) names their
    file and count in ``history``; their bundles are in that file's table."""
    warnings = warnings if warnings is not None else []
    histories = histories or {}
    projects: dict[str, dict] = {}
    blobs: dict[str, dict] = {}
    for name, project in policy.projects.items():
        refs = []
        for ref_id, ref in _project_state(state, name)["refs"].items():
            manifest = _read_json(snapshot_dir(cache, name, ref["sha"]) / REF_FILE)
            if manifest is None:
                warnings.append(f"{name} {ref_id}: the snapshot {ref['sha'][:12]} is missing "
                                "from the cache, so the index leaves it out")
                continue
            refs.append(_ref_entry(cache, name, ref_id, ref["kind"], ref["sha"], manifest, blobs))
        refs.sort(key=lambda r: _ref_order(project, r["id"], r["kind"]))
        projects[name] = {"title": project.title, "repo": project.repo,
                          "default_branch": project.default_branch, "refs": refs}
        if name in histories:
            projects[name]["history"] = {"file": history_file(name),
                                         "count": len(histories[name]["refs"])}
    return {"schema": SCHEMA, "generated": _stamp(now), "projects": projects,
            "blobs": dict(sorted(blobs.items()))}


def _same_index(a: dict, b: dict) -> bool:
    strip = lambda index: {k: v for k, v in index.items() if k != "generated"}
    return strip(a) == strip(b)


def write_index(out: Path, index: dict, last: Path | None = None) -> bool:
    """Write ``index.json``. When nothing but the ``generated`` stamp would
    change, the earlier file is kept byte for byte: the one in ``out``, or
    ``last``, the index the cache remembers publishing (the workflow starts
    each run with an empty ``out``). So ``generated`` says when the content
    last changed, and a run with nothing new deploys the same bytes. Returns
    whether the content changed."""
    path = out / INDEX_FILE
    for earlier in (path, last):
        try:
            data = earlier.read_bytes() if earlier else b""
            old = json.loads(data)
        except (OSError, ValueError):
            continue
        if isinstance(old, dict) and _same_index(old, index):
            if earlier != path:
                _write_bytes(path, data)
            return False
    _write_json(path, index)
    return True


def _superseded_blobs(state: dict, cache: Path) -> set[str]:
    """The bundles of superseded snapshots still in their grace period: no
    longer in the index, still published."""
    blobs: set[str] = set()
    for name, project_state in state["projects"].items():
        for sha in project_state.get("superseded", {}):
            manifest = _read_json(snapshot_dir(cache, name, sha) / REF_FILE)
            if manifest:
                blobs.add(manifest["core"]["blob"])
                blobs.update(lib["blob"] for lib in manifest["libs"].values())
    return blobs


def _copy_if_changed(src: Path, dst: Path) -> None:
    data = src.read_bytes()
    try:
        if dst.read_bytes() == data:
            return
    except OSError:
        pass
    _write_bytes(dst, data)


def publish(cache: Path, out: Path, index: dict, state: dict,
            histories: dict[str, dict] | None = None) -> dict:
    """Make ``out`` hold exactly what the site serves under ``/sources/``:
    the index, the history files, the bundles, and each listed snapshot's
    manifest and report. Files already there with the same bytes are left
    alone; files this command wrote earlier that are no longer published are
    removed (nothing else in ``out`` is touched). Returns counts for the log."""
    histories = histories or {}
    out.mkdir(parents=True, exist_ok=True)
    listed = {(name, ref["sha"]) for name, p in index["projects"].items() for ref in p["refs"]}
    listed |= {(name, ref["sha"]) for name, h in histories.items() for ref in h["refs"]}
    blobs = _superseded_blobs(state, cache) | set(index["blobs"])
    for h in histories.values():
        blobs |= set(h["blobs"])
    wanted: set[Path] = set()
    copied = 0
    for blob in sorted(blobs):
        dst = out / blob
        wanted.add(dst)
        src = cache / blob
        if not (dst.is_file() and dst.stat().st_size == src.stat().st_size):
            _write_bytes(dst, src.read_bytes())
            copied += 1
    for name, sha in sorted(listed):
        for fname in (REF_FILE, REPORT_FILE):
            src = snapshot_dir(cache, name, sha) / fname
            if src.is_file():
                dst = snapshot_dir(out, name, sha) / fname
                wanted.add(dst)
                _copy_if_changed(src, dst)
    for name, history in sorted(histories.items()):
        dst = out / history_file(name)
        wanted.add(dst)
        data = _history_bytes(history)
        try:
            same = dst.read_bytes() == data
        except OSError:
            same = False
        if not same:
            _write_bytes(dst, data)
    changed = write_index(out, index, cache / INDEX_FILE)
    _copy_if_changed(out / INDEX_FILE, cache / INDEX_FILE)
    wanted.add(out / INDEX_FILE)
    removed = 0
    managed = list((out / BLOBS).glob("*.tar.gz")) if (out / BLOBS).is_dir() else []
    managed += [p for p in out.glob("*/*/*.json")
                if _HEX40.fullmatch(p.parent.name) and p.name in (REF_FILE, REPORT_FILE)]
    managed += list((out / HISTORY).glob("*.json")) if (out / HISTORY).is_dir() else []
    for path in managed:
        if path not in wanted:
            path.unlink()
            removed += 1
            if path.parent.name != BLOBS and not any(path.parent.iterdir()):
                path.parent.rmdir()
    return {"copied": copied, "removed": removed, "index_changed": changed}


def collect_garbage(cache: Path, state: dict) -> int:
    """Remove snapshots, bundles and tree records of the cache that nothing in
    the state refers to any more. Returns the number of files removed."""
    keep_snapshots: set[tuple[str, str]] = set()
    for name, project_state in state["projects"].items():
        for ref in project_state.get("refs", {}).values():
            keep_snapshots.add((name, ref["sha"]))
        keep_snapshots.update((name, sha) for sha in project_state.get("superseded", {}))
        keep_snapshots.update((name, sha) for sha in project_state.get("history", {}))
    removed = 0
    keep_blobs: set[str] = set()
    for folder in sorted(p for p in cache.glob("*/*") if p.is_dir() and _HEX40.fullmatch(p.name)):
        if folder.parent.name in (_GIT, BLOBS, _TREES, HISTORY):
            continue
        if (folder.parent.name, folder.name) not in keep_snapshots:
            removed += sum(1 for _ in folder.iterdir())
            _rmtree(folder)
            continue
        manifest = _read_json(folder / REF_FILE)
        if manifest:
            keep_blobs.add(manifest["core"]["blob"])
            keep_blobs.update(lib["blob"] for lib in manifest["libs"].values())
    for path in (cache / BLOBS).glob("*.tar.gz") if (cache / BLOBS).is_dir() else []:
        if f"{BLOBS}/{path.name}" not in keep_blobs:
            path.unlink()
            removed += 1
    for path in (cache / _TREES).glob("*.json") if (cache / _TREES).is_dir() else []:
        record = _read_json(path)
        if not record or not (cache / record["blob"]).is_file():
            path.unlink()
            removed += 1
    return removed


# ── Validation ───────────────────────────────────────────────────────

def validate_index(root: Path, *, hashes: bool = True) -> list[str]:
    """Check ``root/index.json`` against SPEC 7.1 and the files beside it:
    the fields and their types, the ref order, that every bundle exists with
    the size the index gives (and, with ``hashes``, the SHA-256 its name
    says), that every report exists, and each history file the index names
    in the same way. Returns the problems found."""
    problems: list[str] = []
    try:
        index = json.loads((root / INDEX_FILE).read_bytes())
    except (OSError, ValueError) as e:
        return [f"cannot read {INDEX_FILE}: {e}"]
    if not isinstance(index, dict):
        return [f"{INDEX_FILE} is not an object"]
    if index.get("schema") != SCHEMA:
        problems.append(f"schema is {index.get('schema')!r}, expected {SCHEMA}")
    if not isinstance(index.get("generated"), str) or not _STAMP_RE.fullmatch(index["generated"]):
        problems.append(f"generated is not a UTC timestamp: {index.get('generated')!r}")
    blobs = index.get("blobs")
    if not isinstance(blobs, dict):
        problems.append("blobs is not an object")
        blobs = {}
    projects = index.get("projects")
    if not isinstance(projects, dict) or not projects:
        return problems + ["projects is missing or empty"]
    referenced: set[str] = set()
    hashed: set[str] = set()
    for name, project in projects.items():
        where = f"projects.{name}"
        if not isinstance(project, dict):
            problems.append(f"{where} is not an object")
            continue
        for key in ("title", "repo", "default_branch"):
            if not isinstance(project.get(key), str) or not project.get(key):
                problems.append(f"{where}.{key} is missing")
        refs = project.get("refs")
        if not isinstance(refs, list):
            problems.append(f"{where}.refs is not a list")
            continue
        seen_ids: set[str] = set()
        for i, ref in enumerate(refs):
            referenced |= _check_ref(root, name, ref, f"{where}.refs[{i}]", ("branch", "tag"),
                                     seen_ids, problems)
        if "history" in project:
            problems += _check_history(root, name, project["history"], seen_ids, hashed, hashes=hashes)
        # Order: the default branch first, then tags newest first, then branches.
        if refs and isinstance(refs[0], dict):
            first = refs[0]
            if first.get("id") != project.get("default_branch") or first.get("kind") != "branch":
                problems.append(f"{where}: the first ref is not the default branch")
            kinds = [r.get("kind") for r in refs[1:] if isinstance(r, dict)]
            if kinds != sorted(kinds, key=lambda k: 0 if k == "tag" else 1):
                problems.append(f"{where}: a branch is listed before a tag")
            tags = [r.get("id") for r in refs if isinstance(r, dict) and r.get("kind") == "tag"]
            if tags != sorted(tags, key=version_key, reverse=True):
                problems.append(f"{where}: the tags are not newest first")
    problems += _check_blobs(root, referenced, blobs, hashed, hashes=hashes)
    return problems


def _check_ref(root: Path, name: str, ref: object, rwhere: str, kinds: tuple[str, ...],
               seen_ids: set[str], problems: list[str]) -> set[str]:
    """Check one entry of an index's or a history file's ``refs``; returns
    the bundles it names."""
    referenced: set[str] = set()
    if not isinstance(ref, dict):
        problems.append(f"{rwhere} is not an object")
        return referenced
    ref_id = ref.get("id")
    if not isinstance(ref_id, str) or not ref_id:
        problems.append(f"{rwhere}.id is missing")
    elif ref_id in seen_ids:
        problems.append(f"{rwhere}: {ref_id!r} is listed twice")
    seen_ids.add(ref_id)
    if ref.get("kind") not in kinds:
        problems.append(f"{rwhere}.kind is {ref.get('kind')!r}")
    if not isinstance(ref.get("sha"), str) or not _HEX40.fullmatch(ref["sha"]):
        problems.append(f"{rwhere}.sha is not a commit id")
    if not isinstance(ref.get("describe"), str) or not ref.get("describe"):
        problems.append(f"{rwhere}.describe is missing")
    if not isinstance(ref.get("date"), str) or not _DATE_RE.fullmatch(ref["date"]):
        problems.append(f"{rwhere}.date is not YYYY-MM-DD")
    if not isinstance(ref.get("archs"), list) or not all(isinstance(a, str) for a in ref["archs"]):
        problems.append(f"{rwhere}.archs is not a list of names")
    if ref.get("checked") not in (True, False, None):
        problems.append(f"{rwhere}.checked is {ref.get('checked')!r}")
    libs = ref.get("libs")
    if not isinstance(libs, dict) or not all(isinstance(k, str) and k.startswith("lib/")
                                             and k.count("/") == 1 for k in libs):
        problems.append(f"{rwhere}.libs is not a map of lib/<dir> names")
        libs = {}
    core_libs = ref.get("core_libs")
    if not isinstance(core_libs, list) or not all(isinstance(k, str) and k.startswith("lib/")
                                                  for k in core_libs):
        problems.append(f"{rwhere}.core_libs is not a list of lib/<dir> names")
    elif set(core_libs) & set(libs):
        problems.append(f"{rwhere}: {', '.join(sorted(set(core_libs) & set(libs)))} "
                        "is both in the core and a bundle of its own")
    for blob in [ref.get("core"), *libs.values()]:
        if not isinstance(blob, str) or not _BLOB_RE.fullmatch(blob):
            problems.append(f"{rwhere}: not a bundle path: {blob!r}")
            continue
        referenced.add(blob)
    report = ref.get("check_report")
    if report != f"{name}/{ref.get('sha')}/{REPORT_FILE}":
        problems.append(f"{rwhere}.check_report is {report!r}")
    elif not (root / report).is_file():
        problems.append(f"{rwhere}: the report {report} does not exist")
    return referenced


def _check_blobs(root: Path, referenced: set[str], blobs: dict, hashed: set[str], *,
                 hashes: bool, where: str = "") -> list[str]:
    """Every bundle in ``referenced`` exists with the size ``blobs`` gives
    (and the SHA-256 its name says), and ``blobs`` lists nothing else.
    ``hashed`` remembers the bundles already hashed, which the index and the
    history files share."""
    problems = []
    for blob in sorted(referenced):
        path = root / blob
        info = blobs.get(blob)
        if not path.is_file():
            problems.append(f"{where}{blob} is referenced but does not exist")
            continue
        if not isinstance(info, dict) or info.get("size") != path.stat().st_size:
            problems.append(f"{where}{blob}: the blobs table gives no size or the wrong one")
        if hashes and blob not in hashed:
            hashed.add(blob)
            if hashlib.sha256(path.read_bytes()).hexdigest() != blob[len(BLOBS) + 1:-len(".tar.gz")]:
                problems.append(f"{blob}: its SHA-256 does not match its name")
    for blob in sorted(set(blobs) - referenced):
        problems.append(f"{where}blobs lists {blob}, which no ref references")
    return problems


def _check_history(root: Path, name: str, entry: object, ref_ids: set[str], hashed: set[str], *,
                   hashes: bool) -> list[str]:
    """Check a project's ``history`` entry in the index and the history file
    it names: the file's fields, each snapshot as an index ref of kind
    "commit" whose id is its describe string and no current ref's id, newest
    first, the count, and the file's bundles and their table."""
    where = f"projects.{name}.history"
    if not isinstance(entry, dict):
        return [f"{where} is not an object"]
    if entry.get("file") != history_file(name):
        return [f"{where}.file is {entry.get('file')!r}, expected {history_file(name)!r}"]
    fname = entry["file"]
    try:
        history = json.loads((root / fname).read_bytes())
    except (OSError, ValueError) as e:
        return [f"cannot read {fname}: {e}"]
    if not isinstance(history, dict):
        return [f"{fname} is not an object"]
    problems = []
    if history.get("schema") != SCHEMA:
        problems.append(f"{fname}: schema is {history.get('schema')!r}, expected {SCHEMA}")
    if history.get("project") != name:
        problems.append(f"{fname}: project is {history.get('project')!r}, expected {name!r}")
    refs = history.get("refs")
    if not isinstance(refs, list) or not refs:
        return problems + [f"{fname}: refs is missing or empty"]
    if entry.get("count") != len(refs):
        problems.append(f"{where}.count is {entry.get('count')!r}, but {fname} lists {len(refs)}")
    blobs = history.get("blobs")
    if not isinstance(blobs, dict):
        problems.append(f"{fname}: blobs is not an object")
        blobs = {}
    referenced: set[str] = set()
    seen_ids: set[str] = set()
    for i, ref in enumerate(refs):
        rwhere = f"{fname}: refs[{i}]"
        referenced |= _check_ref(root, name, ref, rwhere, ("commit",), seen_ids, problems)
        if isinstance(ref, dict):
            if ref.get("id") != ref.get("describe"):
                problems.append(f"{rwhere}: id {ref.get('id')!r} is not its describe string")
            if ref.get("id") in ref_ids:
                problems.append(f"{rwhere}: {ref.get('id')!r} is also a ref of the index")
    dates = [r.get("date") for r in refs if isinstance(r, dict) and isinstance(r.get("date"), str)]
    if dates != sorted(dates, reverse=True):
        problems.append(f"{fname}: the snapshots are not newest first")
    problems += _check_blobs(root, referenced, blobs, hashed, hashes=hashes, where=f"{fname}: ")
    return problems


# ── Sizes ────────────────────────────────────────────────────────────

def _size(n: int) -> str:
    if n < 1024 * 1024:
        return f"{n / 1024:.0f} KB"
    return f"{n / 1048576:.2f} MB"


def size_summary(index: dict, histories: dict[str, dict] | None = None) -> list[str]:
    """Lines for the log: per project, the bundles its refs and history
    snapshots reference and what they would weigh without sharing; then the
    totals and the cross-project sharing."""
    histories = histories or {}
    sizes = {blob: info["size"] for blob, info in index["blobs"].items()}
    for h in histories.values():
        sizes.update((blob, info["size"]) for blob, info in h["blobs"].items())
    users: dict[str, set[str]] = {}
    lines = []
    naive_total = 0
    for name, project in index["projects"].items():
        own: set[str] = set()
        naive = 0
        history = histories.get(name, {}).get("refs", [])
        if history:
            current = {b for ref in project["refs"] for b in [ref["core"], *ref["libs"].values()]}
            extra = {b for ref in history for b in [ref["core"], *ref["libs"].values()]} - current
            lines.append(f"  {name} history: {len(history)} snapshots, {len(extra)} bundles of "
                         f"their own, {_size(sum(sizes[b] for b in extra))}")
        for ref in project["refs"] + history:
            refs_blobs = [ref["core"], *ref["libs"].values()]
            own.update(refs_blobs)
            naive += sum(sizes[b] for b in refs_blobs)
            for blob in refs_blobs:
                users.setdefault(blob, set()).add(name)
        naive_total += naive
        lines.append(f"  {name}: {len(project['refs'])} refs"
                     + (f" and {len(history)} history snapshots" if history else "") + f", {len(own)} bundles, "
                     f"{_size(sum(sizes[b] for b in own))} (without sharing {_size(naive)})")
    total = sum(sizes.values())
    shared = [b for b, names in users.items() if len(names) > 1]
    lines.append(f"  shared between projects: {len(shared)} bundles, "
                 f"{_size(sum(sizes[b] for b in shared))}")
    lines.append(f"  total: {len(sizes)} bundles, {_size(total)} "
                 f"(without sharing {_size(naive_total)}, saved {_size(naive_total - total)})")
    return lines


# ── Command line ─────────────────────────────────────────────────────

def _log(message: str) -> None:
    print(message, flush=True)


def _check_folders(out: Path, cache: Path) -> None:
    """The cache keeps files the site must not serve (clones, state) and the
    output is pruned to what is published, so they must be two folders."""
    if out.resolve() == cache.resolve():
        raise ValueError("--out and --cache must be different folders")


def _build_history(policy: Policy, project: ProjectPolicy, head: str, cache: Path, repos: _Repos,
                   state: dict, today: _dt.date, now: _dt.datetime, *, gate: bool, matrix: Path,
                   run: str | None, deadline: float | None, gate_minutes: float | None, log,
                   warnings: list[str]) -> list[str]:
    """Snapshot and gate a project's history: the first-parent commits of
    the default branch in its window. The commit list is kept in the state
    with the head it was listed from, so a run whose default branch has not
    moved needs no clone. Returns the snapshots that failed the gate."""
    name = project.name
    project_state = _project_state(state, name)
    if not project.history_days:
        project_state.pop("history_list", None)
        return []
    since = history_since(project, today)
    listed = project_state.get("history_list")
    if listed and listed["head"] == head and listed["since"] <= since:
        commits = [(sha, ct) for sha, ct in listed["commits"]]
    else:
        commits = list_history(repos.get(project), head, since)
        project_state["history_list"] = {"head": head, "since": since,
                                         "commits": [[sha, ct] for sha, ct in commits]}
    kept = select_history(project, commits, head, since)
    window = _dt.datetime.fromtimestamp(since, _dt.timezone.utc).strftime("%Y-%m-%d")
    new = gated = reused = 0
    failed: list[str] = []
    verdicts = None
    for sha, _ct in kept:
        manifest = snapshot_current(policy, cache, name, sha)
        if manifest is None:
            manifest = build_snapshot(policy, project, sha, cache, repos.get(project), lambda _m: None,
                                      warnings)
            new += 1
            log(f"{name} history {manifest['describe']}: new snapshot")
        report = _read_json(snapshot_dir(cache, name, sha) / REPORT_FILE)
        if gate and gate_needed(report, matrix, gate=gate, run=run):
            # Most commits change only what no bundle holds (the host's
            # klippy/, docs/, config/): a snapshot with the same bundles as
            # one already gated builds the same firmware but for the version
            # string, so it takes that verdict.
            if verdicts is None:
                verdicts = _gate_verdicts(cache, name, matrix, run, policy.history_gate)
            same = verdicts.get(_bundle_key(manifest))
            if same:
                report = _reuse_gate(cache, manifest, same, now=now, run=run)
                reused += 1
                if report["checked"] is False:
                    failed.append(f"{name} {manifest['describe']}")
                continue
        if gate_needed(report, matrix, gate=gate, run=run):
            skip = None if gate else "it was skipped (--no-gate)"
            if skip is None and deadline is not None and time.monotonic() > deadline:
                skip = (f"this run's {gate_minutes:g} minutes for the gate ran out; "
                        "a later run gates it")
            if skip is None:
                log(f"{name} history {manifest['describe']}: gate")
                gated += 1
            report = run_gate(cache, manifest, manifest["describe"], matrix,
                              log if skip is None else (lambda _m: None), now=now, skip=skip,
                              run=run, mode=policy.history_gate)
            if report["checked"] is False:
                failed.append(f"{name} {manifest['describe']}")
            if skip is None and verdicts is not None and report.get("rows"):
                verdicts[_bundle_key(manifest)] = report
    record_history(state, name, kept, today)
    log(f"{name}: {len(kept)} history snapshots since {window} ({new} new, {gated} gated"
        + (f", {reused} with the verdict of the same bundles" if reused else "") + ")")
    return failed


def _bundle_key(manifest: dict) -> tuple:
    """What a snapshot's firmware is built from: its core and lib bundles."""
    return (manifest["core"]["blob"], tuple(sorted(lib["blob"] for lib in manifest["libs"].values())))


def _gate_verdicts(cache: Path, project: str, matrix: Path, run: str | None, mode: str) -> dict:
    """The gate reports of a project's cached snapshots that a snapshot with
    the same bundles may take: the gate ran (it has rows), is not due to run
    again (``gate_needed``), and was at least as thorough as ``mode`` (a full
    gate stands for a reduced one). By ``_bundle_key``."""
    verdicts: dict[tuple, dict] = {}
    folder = cache / project
    for path in sorted(folder.glob(f"*/{REPORT_FILE}")) if folder.is_dir() else []:
        report = _read_json(path)
        if not report or not report.get("rows"):
            continue
        if gate_needed(report, matrix, gate=True, run=run):
            continue
        if report.get("gate", "full") not in ("full", mode):
            continue
        manifest = _read_json(path.parent / REF_FILE)
        if manifest:
            verdicts.setdefault(_bundle_key(manifest), report)
    return verdicts


def _reuse_gate(cache: Path, manifest: dict, source: dict, *, now: _dt.datetime,
                run: str | None) -> dict:
    """Give a snapshot the gate report of another with the same bundles,
    naming it in ``same_as``."""
    report = dict(source, sha=manifest["sha"], describe=manifest["describe"], ran=_stamp(now),
                  same_as=source["sha"],
                  note=f"The same bundles as {source['describe']}, whose gate this is.")
    if run is not None:
        report["run"] = run
    else:
        report.pop("run", None)
    _write_json(snapshot_dir(cache, manifest["project"], manifest["sha"]) / REPORT_FILE, report)
    return report


def build(policy: Policy, out: Path, cache: Path, *, projects: list[str] | None = None,
          refs: list[str] | None = None, gate: bool = True, matrix: Path = DEFAULT_MATRIX,
          clones: Path | None = None, run: str | None = None, now: _dt.datetime | None = None,
          history: bool = True, gate_minutes: float | None = None, log=_log) -> int:
    """``webflash sources build``: snapshot what the policy selects, gate the
    new snapshots, age out old refs, and publish into ``out``. The full
    clones go to ``clones`` (default ``<cache>/git``); ``run`` names this run
    (see ``gate_needed``). The refs come first, then the history snapshots
    (``history`` False, or a ``--ref`` run, leaves those as recorded); once
    ``gate_minutes`` have passed since the start, history snapshots are
    published ungated (checked: null) and a later run gates them. Returns the
    exit code: 0, or 2 when a listed snapshot failed the gate in this run."""
    started = time.monotonic()
    now = now or _dt.datetime.now(_dt.timezone.utc)
    today = now.astimezone(_dt.timezone.utc).date()
    _check_folders(out, cache)
    cache.mkdir(parents=True, exist_ok=True)
    state = load_state(cache)
    warnings: list[str] = []
    repos = _Repos(clones or cache / _GIT, log)
    names = projects or list(policy.projects)
    unknown = [n for n in names if n not in policy.projects]
    if unknown:
        raise ValueError(f"no such project in {policy.path.name if policy.path else 'the policy'}: "
                         f"{', '.join(unknown)}")
    for name in [n for n in state["projects"] if n not in policy.projects]:
        log(f"{name}: no longer in the policy, dropped")
        del state["projects"][name]
    matched_refs: set[str] = set()
    failed_now: list[str] = []
    heads: dict[str, str] = {}
    for name in names:
        project = policy.projects[name]
        selected = select_refs(project, list_refs(project), warnings)
        heads[name] = selected[0].sha
        if refs:
            matched_refs.update(r.name for r in selected if r.name in refs)
            selected = [r for r in selected if r.name in refs]
        log(f"{name}: {len(selected)} refs ({', '.join(r.name for r in selected) or 'none'})")
        for ref in selected:
            manifest = snapshot_current(policy, cache, name, ref.sha)
            if manifest is None:
                log(f"{name} {ref.name} {ref.sha[:12]}: new snapshot")
                manifest = build_snapshot(policy, project, ref.sha, cache, repos.get(project),
                                          log, warnings)
            else:
                log(f"{name} {ref.name} {manifest['abbrev']}: unchanged")
            record_ref(state, name, ref, today)
            describe = (f"{ref.name}-0-g{manifest['abbrev']}" if ref.kind == "tag"
                        else manifest["describe"])
            report = _read_json(snapshot_dir(cache, name, ref.sha) / REPORT_FILE)
            if gate_needed(report, matrix, gate=gate, run=run):
                report = run_gate(cache, manifest, describe, matrix, log, now=now,
                                  skip=None if gate else "it was skipped (--no-gate)", run=run)
                if report["checked"] is False:
                    failed_now.append(f"{name} {ref.name}")
    if refs:
        missing = sorted(set(refs) - matched_refs)
        if missing:
            raise ValueError(f"the policy selects no ref named {', '.join(missing)}")
    history_ran = [] if refs or not history else names
    deadline = None if gate_minutes is None else started + gate_minutes * 60
    for name in history_ran:
        failed_now += _build_history(policy, policy.projects[name], heads[name], cache, repos, state,
                                     today, now, gate=gate, matrix=matrix, run=run,
                                     deadline=deadline, gate_minutes=gate_minutes, log=log,
                                     warnings=warnings)
    dropped = age_out(state, today, policy.age_days, policy.superseded_days,
                      [] if refs else names, history_ran)
    for line in dropped:
        log(f"aged out: {line}")
    save_state(cache, state)
    removed = collect_garbage(cache, state)
    histories = make_histories(policy, cache, state, warnings)
    index = make_index(policy, cache, state, now, warnings, histories)
    result = publish(cache, out, index, state, histories)
    for warning in warnings:
        print(f"Warning: {warning}", file=sys.stderr, flush=True)
    log(f"index: {'written' if result['index_changed'] else 'unchanged'}, "
        f"{result['copied']} bundles copied, {result['removed']} files removed from {out}"
        + (f", {removed} cache files dropped" if removed else ""))
    log("sizes:")
    for line in size_summary(index, histories):
        log(line)
    # A run fails for the gate failures it found itself (SPEC 7.5): a ref that
    # failed an earlier run, under the same engine and matrix, is only a
    # warning, so the daily run does not stay red over one old tag. A re-run
    # of the run that found it (the same --run) has checked it again above.
    earlier = [f"{name} {ref['id']}" for name, p in index["projects"].items()
               for ref in p["refs"] if ref["checked"] is False
               and f"{name} {ref['id']}" not in failed_now]
    if earlier:
        print(f"Warning: still checked: false from an earlier run: {', '.join(earlier)}",
              file=sys.stderr, flush=True)
    for name, h in histories.items():
        old = [r for r in h["refs"] if r["checked"] is False and f"{name} {r['id']}" not in failed_now]
        if old:
            print(f"Warning: {name}: {len(old)} history snapshots still checked: false from an earlier "
                  f"run, the newest {old[0]['id']}", file=sys.stderr, flush=True)
    if failed_now:
        print(f"Error: the snapshot gate failed for {', '.join(failed_now)}: published with "
              "checked: false (see each ref's make-check.json)", file=sys.stderr, flush=True)
        return EXIT_GATE_FAILED
    return 0


def rebuild_index(policy: Policy, out: Path, cache: Path, *,
                  now: _dt.datetime | None = None, log=_log) -> int:
    """``webflash sources index``: age out and republish from the cache alone,
    without git or the gate."""
    now = now or _dt.datetime.now(_dt.timezone.utc)
    _check_folders(out, cache)
    state = load_state(cache)
    for name in [n for n in state["projects"] if n not in policy.projects]:
        log(f"{name}: no longer in the policy, dropped")
        del state["projects"][name]
    for line in age_out(state, now.astimezone(_dt.timezone.utc).date(), policy.age_days,
                        policy.superseded_days):
        log(f"aged out: {line}")
    save_state(cache, state)
    warnings: list[str] = []
    histories = make_histories(policy, cache, state, warnings)
    index = make_index(policy, cache, state, now, warnings, histories)
    result = publish(cache, out, index, state, histories)
    for warning in warnings:
        print(f"Warning: {warning}", file=sys.stderr, flush=True)
    log(f"index: {'written' if result['index_changed'] else 'unchanged'}, "
        f"{result['copied']} bundles copied, {result['removed']} files removed from {out}")
    return 0


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="webflash sources",
        description="Build the source snapshots the site builds firmware from: bundles of "
                    "each ref that sources.toml selects, and the index that lists them.")
    sub = parser.add_subparsers(dest="action", metavar="{build,index,check}")
    sub.required = True

    def common(p, *, cache_required=True):
        p.add_argument("--policy", type=Path, default=Path("sources.toml"), metavar="FILE",
                       help="The snapshot policy.  Default: sources.toml")
        p.add_argument("--out", type=Path, required=True, metavar="DIR",
                       help="Where the site's /sources/ folder is written (index.json, blobs/, ...).")
        p.add_argument("--cache", type=Path, required=cache_required, metavar="DIR",
                       help="The work folder kept between runs: clones, bundles, state.")

    b = sub.add_parser("build", help="snapshot new refs, run the gate, write the index",
                       description="Snapshot every ref the policy selects that has no snapshot "
                                   "yet, run the snapshot gate on the new ones, age out old refs, "
                                   "and write the index and the bundles into --out.")
    common(b)
    b.add_argument("--project", action="append", default=None, metavar="P",
                   help="Only this project (repeatable).")
    b.add_argument("--ref", action="append", default=None, metavar="R",
                   help="Only refs with this id, such as master or v0.13.0 (repeatable). "
                        "Refs left out keep what an earlier run recorded.")
    b.add_argument("--clones", type=Path, default=None, metavar="DIR",
                   help="Where the full clones of the projects go.  Default: <cache>/git. "
                        "They are needed only when a ref has a new commit.")
    b.add_argument("--no-gate", action="store_true",
                   help="Do not run the snapshot gate: new snapshots get checked: null.")
    b.add_argument("--matrix", type=Path, default=DEFAULT_MATRIX, metavar="FILE",
                   help=f"The parity matrix the gate builds.  Default: {DEFAULT_MATRIX.as_posix()}")
    b.add_argument("--run", default=None, metavar="ID",
                   help="An id for this run, such as $GITHUB_RUN_ID. A snapshot that failed the "
                        "gate under the same id is checked again, so a re-run of a failed run "
                        "does not pass on the first attempt's cache.")
    b.add_argument("--no-history", action="store_true",
                   help="Leave the history snapshots (history_days) as an earlier run recorded "
                        "them: no listing, no new ones, no aging.")
    b.add_argument("--gate-minutes", type=float, default=None, metavar="M",
                   help="Gate history snapshots only until M minutes have passed since the start; "
                        "the rest are published with checked: null and a later run gates them. "
                        "The refs are always gated.")

    i = sub.add_parser("index", help="rewrite the index from the cache",
                       description="Age out old refs and write the index and the bundles into "
                                   "--out from the cache alone, without git or the gate.")
    common(i)

    c = sub.add_parser("check", help="validate a written sources folder",
                       description="Check index.json in --out against the index format and the "
                                   "files beside it: every bundle and report it names must exist, "
                                   "and every bundle's bytes must match its name.")
    c.add_argument("--out", type=Path, required=True, metavar="DIR",
                   help="The sources folder to check.")
    return parser


def main(argv: list[str]) -> int:
    """``webflash sources ...``: ``argv`` starts with ``sources``."""
    args = _parser().parse_args(argv[1:])
    try:
        if args.action == "check":
            problems = validate_index(args.out)
            for problem in problems:
                print(f"Error: {problem}", file=sys.stderr)
            if problems:
                return 1
            index = json.loads((args.out / INDEX_FILE).read_bytes())
            refs = sum(len(p["refs"]) for p in index["projects"].values())
            history = sum(p["history"]["count"] for p in index["projects"].values() if "history" in p)
            blobs = {blob: info["size"] for blob, info in index["blobs"].items()}
            for p in index["projects"].values():
                if "history" in p:
                    h = json.loads((args.out / p["history"]["file"]).read_bytes())
                    blobs.update((blob, info["size"]) for blob, info in h["blobs"].items())
            print(f"{args.out / INDEX_FILE}: valid, {len(index['projects'])} projects, "
                  f"{refs} refs, {history} history snapshots, {len(blobs)} bundles "
                  f"({_size(sum(blobs.values()))})")
            return 0
        policy = load_policy(args.policy)
        if args.action == "index":
            return rebuild_index(policy, args.out, args.cache)
        return build(policy, args.out, args.cache, projects=args.project, refs=args.ref,
                     gate=not args.no_gate, matrix=args.matrix, clones=args.clones,
                     run=args.run or None, history=not args.no_history,
                     gate_minutes=args.gate_minutes)
    except (ValueError, SourcesError, OSError) as e:
        for line in str(e).splitlines() or [""]:
            print(f"Error: {line}", file=sys.stderr)
        return 1
