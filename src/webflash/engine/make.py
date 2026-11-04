"""A make interpreter with GNU make's semantics for the Makefiles of Klipper,
Kalico and Katapult.

It reads the project's ``Makefile`` and whatever that includes (``src/Makefile``,
the board directory's Makefile, the ``.config``), evaluates variables with
GNU make's flavors and functions, matches explicit and pattern rules, and runs
or prints recipes in the order GNU make would. Nothing is special-cased for a
project: a construct the interpreter does not know raises :class:`MakeError`
naming the file and line, which is what the snapshot gate relies on.

Recipe commands are not run here: :class:`Evaluator` hands each expanded line
to a :class:`~webflash.engine.shell.Shell`, which emulates the handful of
commands the Makefiles use and sends compiler commands to a toolchain. The
interpreter is asynchronous because the toolchain may be a JavaScript promise
under Pyodide; :func:`run_sync` wraps a call for CPython callers.
"""
from __future__ import annotations

import asyncio
import fnmatch
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Callable, Optional

if TYPE_CHECKING:  # pragma: no cover
    from .shell import Shell


class MakeError(Exception):
    """A construct the interpreter does not support, or a failure GNU make
    would report (no rule for a target, a recipe that failed, a cycle)."""


# How deep ``$(MAKE)`` may nest: the projects' Makefiles go one level down.
_MAX_MAKE_LEVEL = 20


# ── Text helpers ─────────────────────────────────────────────────────

_WS = " \t\n\r"


def split_words(text: str) -> list[str]:
    """GNU make's word splitting: on spaces, tabs and newlines."""
    return text.split()


def _pattern_match(pattern: str, word: str) -> Optional[str]:
    """Match a make pattern (one ``%`` at most) against a word, returning the
    stem, or ``""`` for a literal match, or None."""
    i = pattern.find("%")
    if i < 0:
        return "" if pattern == word else None
    prefix, suffix = pattern[:i], pattern[i + 1:]
    if len(word) < len(prefix) + len(suffix):
        return None
    if word.startswith(prefix) and word.endswith(suffix):
        return word[len(prefix):len(word) - len(suffix)]
    return None


def _pattern_subst(replacement: str, stem: str) -> str:
    return replacement.replace("%", stem, 1) if "%" in replacement else replacement


def _posix(path: str) -> str:
    return path.replace("\\", "/")


# ── Variables ────────────────────────────────────────────────────────

ORIGIN_DEFAULT = "default"
ORIGIN_ENVIRONMENT = "environment"
ORIGIN_FILE = "file"
ORIGIN_COMMAND_LINE = "command line"
ORIGIN_AUTOMATIC = "automatic"


@dataclass
class Variable:
    name: str
    value: str
    recursive: bool
    origin: str
    exported: bool = False


# GNU make's own defaults that the Makefiles may read before setting them.
_DEFAULT_VARIABLES = {
    "CC": "cc", "CXX": "g++", "CPP": "$(CC) -E", "AS": "as", "LD": "ld", "AR": "ar",
    "RM": "rm -f", "SHELL": "/bin/sh", "MAKE": "make",
}


class Variables:
    """The variable table with GNU make's precedence: a variable from the
    command line is never changed by a makefile assignment."""

    def __init__(self) -> None:
        self._vars: dict[str, Variable] = {}
        for name, value in _DEFAULT_VARIABLES.items():
            self._vars[name] = Variable(name, value, True, ORIGIN_DEFAULT)

    def get(self, name: str) -> Optional[Variable]:
        return self._vars.get(name)

    def names(self) -> list[str]:
        return list(self._vars)

    def set(self, name: str, value: str, recursive: bool, origin: str = ORIGIN_FILE,
            exported: Optional[bool] = None) -> None:
        old = self._vars.get(name)
        if old is not None and old.origin == ORIGIN_COMMAND_LINE and origin != ORIGIN_COMMAND_LINE:
            if exported:
                old.exported = True
            return
        exp = old.exported if (old is not None and exported is None) else bool(exported)
        self._vars[name] = Variable(name, value, recursive, origin, exp)

    def export(self, name: str, state: bool = True) -> None:
        var = self._vars.get(name)
        if var is None:
            self._vars[name] = Variable(name, "", True, ORIGIN_FILE, state)
        else:
            var.exported = state

    def exported(self) -> list[Variable]:
        return [v for v in self._vars.values() if v.exported or v.origin in (ORIGIN_ENVIRONMENT, ORIGIN_COMMAND_LINE)]


# ── Rules ────────────────────────────────────────────────────────────

@dataclass
class RecipeLine:
    text: str
    file: str
    lineno: int


@dataclass
class Rule:
    targets: list[str]
    prereqs: list[str]
    recipe: list[RecipeLine]
    file: str
    lineno: int
    pattern: bool = False


@dataclass
class Target:
    """A target as the interpreter resolved it: its prerequisites in order and
    the rule whose recipe builds it (None when it has none)."""
    name: str
    prereqs: list[str]
    rule: Optional[Rule]
    stem: str = ""
    phony: bool = False

    @property
    def recipe(self) -> list[RecipeLine]:
        return self.rule.recipe if self.rule else []


# ── Functions ────────────────────────────────────────────────────────

# name: (min args, max args or None for unlimited)
_FUNCTIONS: dict[str, tuple[int, Optional[int]]] = {
    "subst": (3, 3), "patsubst": (3, 3), "strip": (1, 1), "findstring": (2, 2),
    "filter": (2, 2), "filter-out": (2, 2), "sort": (1, 1), "word": (2, 2),
    "wordlist": (3, 3), "words": (1, 1), "firstword": (1, 1), "lastword": (1, 1),
    "dir": (1, 1), "notdir": (1, 1), "suffix": (1, 1), "basename": (1, 1),
    "addsuffix": (2, 2), "addprefix": (2, 2), "join": (2, 2), "wildcard": (1, 1),
    "realpath": (1, 1), "abspath": (1, 1), "if": (2, 3), "or": (1, None),
    "and": (1, None), "foreach": (3, 3), "call": (1, None), "value": (1, 1),
    "eval": (1, 1), "origin": (1, 1), "flavor": (1, 1), "shell": (1, 1),
    "error": (1, 1), "warning": (1, 1), "info": (1, 1),
    "file": (1, 2), "let": (3, 3), "intcmp": (2, 5), "guile": (1, 1),
}

_UNSUPPORTED_FUNCTIONS = {"file", "let", "intcmp", "guile"}

_ASSIGN_OPS = ("::=", ":::=", ":=", "?=", "+=", "!=", "=")

# GNU make's built-in .SUFFIXES list, which $* of an explicit rule's target
# drops a suffix of.
_DEFAULT_SUFFIXES = (
    ".out .a .ln .o .c .cc .C .cpp .p .f .F .m .r .y .l .ym .yl .s .S .mod .sym .def .h"
    " .info .dvi .tex .texinfo .texi .txinfo .w .ch .web .sh .elc .el"
).split()

_SPECIAL_TARGETS_IGNORED = {
    ".PRECIOUS", ".SECONDARY", ".INTERMEDIATE", ".NOTINTERMEDIATE",
    ".SECONDEXPANSION", ".IGNORE", ".SILENT", ".EXPORT_ALL_VARIABLES",
    ".NOTPARALLEL", ".ONESHELL", ".POSIX", ".LOW_RESOLUTION_TIME", ".WAIT",
}


def _find_assignment(line: str) -> Optional[tuple[int, str]]:
    """The position and text of the assignment operator of a makefile line,
    if the line is a variable assignment rather than a rule: the first
    top-level operator, unless a rule's colon comes first."""
    depth = 0
    i = 0
    n = len(line)
    while i < n:
        c = line[i]
        if c == "$" and i + 1 < n and line[i + 1] in "({":
            depth += 1
            i += 2
            continue
        if depth:
            if c in ")}":
                depth -= 1
            i += 1
            continue
        for op in _ASSIGN_OPS:
            if line.startswith(op, i):
                return i, op
        if c == ":":
            return None
        i += 1
    return None


def _split_rule_colon(line: str) -> int:
    """The index of the colon that separates targets from prerequisites,
    skipping a DOS drive letter (``C:/``) the way GNU make on Windows does."""
    for i, c in enumerate(line):
        if c != ":":
            continue
        if i >= 1 and line[i - 1].isalpha() and i + 1 < len(line) and line[i + 1] in "/\\" \
                and (i == 1 or line[i - 2] in _WS):
            continue
        return i
    return -1


# ── The evaluator ────────────────────────────────────────────────────

class Evaluator:
    """One make run: the makefiles read against ``tree``, the variables from
    the command line and the environment, and the goals to update.

    ``shell`` runs recipe commands and ``$(shell)``; ``command_line`` holds the
    ``VAR=value`` pairs of the make command line (``V``, ``OUT``, ...); ``env``
    is the process environment the recipes see (nothing is read from the real
    environment). ``transcript`` collects the lines GNU make would print to
    stdout: every recipe line it echoes, plus the output of the commands it ran
    while remaking makefiles.
    """

    def __init__(self, tree: Path, shell: "Shell", *, command_line: Optional[dict[str, str]] = None,
                 env: Optional[dict[str, str]] = None, makefile: str = "Makefile",
                 level: int = 0, log: Optional[Callable[[str], None]] = None) -> None:
        self.tree = Path(tree)
        self.shell = shell
        self.makefile = makefile
        self.command_line = dict(command_line or {})
        self.env = dict(env or {})
        self.level = level
        self.log = log or (lambda line: None)
        self.transcript: list[str] = []
        self.commands: list[str] = []
        self.vars = Variables()
        self.rules: list[Rule] = []
        self.pattern_rules: list[Rule] = []
        self.explicit: dict[str, list[Rule]] = {}
        self.phony: set[str] = set()
        self.delete_on_error = False
        self.suffixes: list[str] = list(_DEFAULT_SUFFIXES)
        self.default_goal: Optional[str] = None
        self.included: list[tuple[str, bool]] = []
        self.makefiles: list[str] = []
        self._frames: list[dict[str, str]] = []
        self._expanding: set[str] = set()
        self._building_env = False
        self._done: dict[str, bool] = {}
        self._updating: list[str] = []
        self._mentioned_cache: Optional[set[str]] = None
        self._loaded = False

    # ── Loading ───────────────────────────────────────────────────────

    def _reset(self) -> None:
        self.vars = Variables()
        self.rules = []
        self.pattern_rules = []
        self.explicit = {}
        self.phony = set()
        self.delete_on_error = False
        self.suffixes = list(_DEFAULT_SUFFIXES)
        self.default_goal = None
        self.included = []
        self.makefiles = []
        self._frames = []
        self._done = {}
        self._mentioned_cache: Optional[set[str]] = None
        for name, value in self.env.items():
            self.vars.set(name, value, False, ORIGIN_ENVIRONMENT, exported=True)
        for name, value in self.command_line.items():
            self.vars.set(name, value, False, ORIGIN_COMMAND_LINE, exported=True)
        self.vars.set("CURDIR", _posix(str(self.tree.resolve())), False, ORIGIN_FILE)
        self.vars.set("MAKELEVEL", str(self.level), False, ORIGIN_FILE, exported=True)
        self.vars.set("MAKEFLAGS", "", True, ORIGIN_FILE, exported=True)
        self.vars.set("MAKE", "make", True, ORIGIN_DEFAULT)

    async def load(self) -> None:
        """Read the makefiles, remaking an included makefile that has a rule
        (Klipper's ``$(OUT)board-link``) and reading everything again when one
        was remade, as GNU make does."""
        for _attempt in range(10):
            self._reset()
            self._read_makefile(self.makefile, optional=False)
            remade = False
            for name, optional in self.included:
                if self._resolve(name) is None:
                    if not optional and not self._exists(name):
                        raise MakeError(f"{self.makefile}: No rule to make target '{name}'")
                    continue
                if await self._update(name, dry_run=False, remaking_makefiles=True):
                    remade = True
            self._done = {}
            if not remade:
                self._loaded = True
                return
        raise MakeError("the makefiles were remade ten times in a row")

    def _read_makefile(self, name: str, optional: bool) -> None:
        path = self._path(name)
        if not path.is_file():
            # A missing makefile is not an error yet: GNU make tries to remake
            # it after reading everything (load() does), and only a required
            # one that still cannot be made fails.
            if not optional and name == self.makefile:
                raise MakeError(f"{name}: No such file or directory")
            return
        text = path.read_bytes().decode("utf-8", errors="surrogateescape")
        self.makefiles.append(name)
        self._parse(text.replace("\r\n", "\n").replace("\r", "\n"), name)

    # ── Parsing ───────────────────────────────────────────────────────

    def _parse(self, text: str, fname: str) -> None:
        lines = text.split("\n")
        cond: list[list] = []  # stack of [taking, any_taken, else_seen]
        current_rule: Optional[Rule] = None
        i = 0
        n = len(lines)
        while i < n:
            raw = lines[i]
            lineno = i + 1
            if raw.startswith("\t") and current_rule is not None:
                # A recipe line; a backslash-newline continues it into the shell.
                body = raw[1:]
                while body.endswith("\\") and i + 1 < n:
                    i += 1
                    nxt = lines[i]
                    body = body + "\n" + (nxt[1:] if nxt.startswith("\t") else nxt)
                i += 1
                if all(c[0] for c in cond):
                    # A "#" line stays a recipe line: GNU make echoes it and
                    # hands it to the shell, which ignores it.
                    if body.strip():
                        current_rule.recipe.append(RecipeLine(body, fname, lineno))
                continue
            # A makefile line: join continuations, condensing the whitespace.
            line = raw
            while line.rstrip().endswith("\\") and not line.rstrip().endswith("\\\\") and i + 1 < n:
                i += 1
                line = line.rstrip()[:-1].rstrip() + " " + lines[i].lstrip()
            i += 1
            line = self._strip_comment(line)
            stripped = line.strip()
            if not stripped:
                continue
            words = stripped.split(None, 1)
            word = words[0]
            rest = words[1] if len(words) > 1 else ""
            where = f"{fname}:{lineno}"

            # Conditionals, evaluated even when not taking, to keep nesting.
            if word in ("ifeq", "ifneq", "ifdef", "ifndef"):
                taking = all(c[0] for c in cond)
                result = self._conditional(word, rest, where) if taking else False
                cond.append([taking and result, result, False])
                continue
            if word == "else":
                if not cond:
                    raise MakeError(f"{where}: else without a conditional")
                top = cond[-1]
                if top[2]:
                    raise MakeError(f"{where}: more than one else")
                parent_taking = all(c[0] for c in cond[:-1])
                if rest:
                    sub = rest.split(None, 1)
                    if sub[0] not in ("ifeq", "ifneq", "ifdef", "ifndef"):
                        raise MakeError(f"{where}: unsupported: else {sub[0]}")
                    arg = sub[1] if len(sub) > 1 else ""
                    result = (not top[1]) and parent_taking and self._conditional(sub[0], arg, where)
                    top[0] = result
                    top[1] = top[1] or result
                else:
                    top[0] = parent_taking and not top[1]
                    top[1] = True
                    top[2] = True
                continue
            if word == "endif":
                if not cond:
                    raise MakeError(f"{where}: endif without a conditional")
                cond.pop()
                continue
            if not all(c[0] for c in cond):
                continue

            if word in ("include", "-include", "sinclude"):
                current_rule = None
                optional = word != "include"
                for pattern in split_words(self.expand(rest, where=where)):
                    names = self._glob(pattern) if any(ch in pattern for ch in "*?[") else [pattern]
                    if not names and not optional:
                        raise MakeError(f"{where}: No rule to make target '{pattern}'")
                    for name in names:
                        # GNU make drops a leading ./ from an included name
                        # (read.c, parse_file_seq), so it names the same file
                        # as a rule's target does.
                        while name.startswith("./") and len(name) > 2:
                            name = name[2:].lstrip("/")
                        self.included.append((name, optional))
                        self._read_makefile(name, optional)
                continue
            if word in ("define", "override", "vpath", "undefine", "private", "load", "unexport"):
                raise MakeError(f"{where}: unsupported: {word}")
            if word == "export":
                current_rule = None
                if not rest:
                    raise MakeError(f"{where}: unsupported: export of every variable")
                assignment = _find_assignment(rest)
                if assignment is None:
                    for name in split_words(self.expand(rest, where=where)):
                        self.vars.export(name)
                else:
                    self._assign(rest, assignment, where, exported=True)
                continue
            assignment = _find_assignment(line.lstrip())
            if assignment is not None:
                current_rule = None
                self._assign(line.lstrip(), assignment, where)
                continue
            current_rule = self._rule_line(line, where, fname, lineno)
        if cond:
            raise MakeError(f"{fname}: missing endif")

    @staticmethod
    def _strip_comment(line: str) -> str:
        out = []
        i = 0
        n = len(line)
        while i < n:
            c = line[i]
            if c == "\\" and i + 1 < n and line[i + 1] == "#":
                out.append("#")
                i += 2
                continue
            if c == "#":
                break
            out.append(c)
            i += 1
        return "".join(out)

    def _conditional(self, word: str, rest: str, where: str) -> bool:
        if word in ("ifdef", "ifndef"):
            name = self.expand(rest, where=where).strip()
            var = self.vars.get(name)
            defined = var is not None and var.value != ""
            return defined if word == "ifdef" else not defined
        rest = rest.strip()
        if rest.startswith("("):
            depth = 0
            comma = -1
            end = -1
            for j, c in enumerate(rest):
                if c == "(":
                    depth += 1
                elif c == ")":
                    depth -= 1
                    if depth == 0:
                        end = j
                        break
                elif c == "," and depth == 1 and comma < 0:
                    comma = j
            if end < 0 or comma < 0:
                raise MakeError(f"{where}: invalid syntax in conditional")
            left = rest[1:comma].rstrip()
            # GNU make (read.c, conditional_line) strips the blanks after the
            # first argument and before the second, and keeps the rest.
            right = rest[comma + 1:end].lstrip(" \t")
        else:
            parts = []
            j = 0
            for _ in range(2):
                while j < len(rest) and rest[j] in " \t":
                    j += 1
                if j >= len(rest) or rest[j] not in "\"'":
                    raise MakeError(f"{where}: invalid syntax in conditional")
                quote = rest[j]
                k = rest.find(quote, j + 1)
                if k < 0:
                    raise MakeError(f"{where}: invalid syntax in conditional")
                parts.append(rest[j + 1:k])
                j = k + 1
            left, right = parts
        a = self.expand(left, where=where)
        b = self.expand(right, where=where)
        return (a == b) if word == "ifeq" else (a != b)

    def _assign(self, line: str, assignment: tuple[int, str], where: str, exported: bool = False) -> None:
        pos, op = assignment
        name = self.expand(line[:pos], where=where).strip()
        value = line[pos + len(op):].lstrip(" \t")
        if not name:
            raise MakeError(f"{where}: empty variable name")
        if op in ("!=", ":::="):
            raise MakeError(f"{where}: unsupported: {op} assignment")
        old = self.vars.get(name)
        if op in (":=", "::="):
            self.vars.set(name, self.expand(value, where=where), False, exported=exported or None)
        elif op == "=":
            self.vars.set(name, value, True, exported=exported or None)
        elif op == "?=":
            if old is None:
                self.vars.set(name, value, True, exported=exported or None)
            elif exported:
                self.vars.export(name)
        elif op == "+=":
            if old is None:
                self.vars.set(name, value, True, exported=exported or None)
            elif old.recursive:
                self.vars.set(name, (old.value + " " + value) if old.value else value, True,
                              exported=exported or None)
            else:
                expanded = self.expand(value, where=where)
                self.vars.set(name, (old.value + " " + expanded) if old.value else expanded, False,
                              exported=exported or None)
        else:  # pragma: no cover
            raise MakeError(f"{where}: unsupported: {op}")

    def _rule_line(self, line: str, where: str, fname: str, lineno: int) -> Optional[Rule]:
        expanded = self.expand(line, where=where)
        if not expanded.strip():
            # A line that expands to nothing (Kalico's bare
            # $(shell ./scripts/find-firmware-extras.sh)) is ignored.
            return None
        colon = _split_rule_colon(expanded)
        if colon < 0:
            raise MakeError(f"{where}: missing separator")
        targets_text = expanded[:colon]
        rest = expanded[colon + 1:]
        if rest.startswith(":"):
            raise MakeError(f"{where}: unsupported: double-colon rule")
        if ";" in rest:
            raise MakeError(f"{where}: unsupported: recipe on the rule line")
        if "|" in rest:
            raise MakeError(f"{where}: unsupported: order-only prerequisites")
        if _split_rule_colon(rest) >= 0:
            raise MakeError(f"{where}: unsupported: static pattern rule")
        if "=" in rest:
            raise MakeError(f"{where}: unsupported: target-specific variable")
        targets = split_words(targets_text)
        prereqs = split_words(rest)
        if not targets:
            raise MakeError(f"{where}: missing target")
        if targets[0] == ".PHONY":
            self.phony.update(prereqs)
            return None
        if targets[0] == ".DELETE_ON_ERROR":
            self.delete_on_error = True
            return None
        if targets[0] == ".SUFFIXES":
            # With no prerequisites the list is cleared; with some, they are
            # appended to it.
            if prereqs:
                self.suffixes.extend(p for p in prereqs if p not in self.suffixes)
            else:
                self.suffixes = []
            return None
        if targets[0] in _SPECIAL_TARGETS_IGNORED:
            return None
        if targets[0] == ".DEFAULT":
            raise MakeError(f"{where}: unsupported: .DEFAULT")
        is_pattern = any("%" in t for t in targets)
        if is_pattern and not all("%" in t for t in targets):
            raise MakeError(f"{where}: mixed implicit and normal rules")
        rule = Rule(targets, prereqs, [], fname, lineno, pattern=is_pattern)
        self.rules.append(rule)
        if is_pattern:
            self.pattern_rules.append(rule)
        else:
            for t in targets:
                self.explicit.setdefault(t, []).append(rule)
                if not (t.startswith(".") and "/" not in t):
                    # As GNU make does, the first ordinary target becomes
                    # .DEFAULT_GOAL while the variable is unset or empty.
                    goal_var = self.vars.get(".DEFAULT_GOAL")
                    if goal_var is None or not goal_var.value:
                        self.vars.set(".DEFAULT_GOAL", t, False, ORIGIN_FILE)
                    if self.default_goal is None:
                        self.default_goal = t
        return rule

    # ── Expansion ─────────────────────────────────────────────────────

    def expand(self, text: str, auto: Optional[dict[str, str]] = None, where: str = "") -> str:
        """Expand every ``$`` reference in ``text`` with GNU make's rules."""
        if "$" not in text:
            return text
        out: list[str] = []
        i = 0
        n = len(text)
        while i < n:
            c = text[i]
            if c != "$":
                out.append(c)
                i += 1
                continue
            i += 1
            if i >= n:
                out.append("$")
                break
            c = text[i]
            if c == "$":
                out.append("$")
                i += 1
                continue
            if c in "({":
                close = ")" if c == "(" else "}"
                j = self._matching(text, i, c, close)
                if j < 0:
                    raise MakeError(f"{where}: unterminated variable reference")
                out.append(self._reference(text[i + 1:j], auto, where))
                i = j + 1
                continue
            out.append(self._lookup(c, auto, where))
            i += 1
        return "".join(out)

    @staticmethod
    def _matching(text: str, start: int, open_ch: str, close_ch: str) -> int:
        depth = 0
        for j in range(start, len(text)):
            c = text[j]
            if c == open_ch:
                depth += 1
            elif c == close_ch:
                depth -= 1
                if depth == 0:
                    return j
        return -1

    def _reference(self, inner: str, auto: Optional[dict[str, str]], where: str) -> str:
        # A function call: a known name followed by whitespace.
        m = re.match(r"([-a-zA-Z]+)([ \t\n]+|$)", inner)
        if m and m.group(1) in _FUNCTIONS and (m.group(2) or inner == m.group(1)):
            name = m.group(1)
            args_text = inner[m.end():]
            return self._function(name, args_text, auto, where)
        name = self.expand(inner, auto, where)
        # A substitution reference: $(var:a=b)
        colon = name.find(":")
        if colon > 0 and "=" in name[colon:]:
            var_name = name[:colon]
            a, b = name[colon + 1:].split("=", 1)
            value = self._lookup(var_name, auto, where)
            if "%" not in a:
                a, b = "%" + a, "%" + b
            return " ".join(_pattern_subst(b, s) if (s := _pattern_match(a, w)) is not None else w
                            for w in split_words(value))
        return self._lookup(name, auto, where)

    def _lookup(self, name: str, auto: Optional[dict[str, str]], where: str) -> str:
        if auto and name in auto:
            return auto[name]
        if auto and len(name) == 2 and name[1] in "DF" and name[0] in auto:
            value = auto[name[0]]
            words = split_words(value)
            if name[1] == "D":
                return " ".join(self._dir(w).rstrip("/") or "." for w in words)
            return " ".join(self._notdir(w) for w in words)
        for frame in reversed(self._frames):
            if name in frame:
                return frame[name]
        var = self.vars.get(name)
        if var is None:
            return ""
        if not var.recursive:
            return var.value
        if name in self._expanding:
            raise MakeError(f"{where}: Recursive variable '{name}' references itself (eventually)")
        self._expanding.add(name)
        try:
            return self.expand(var.value, auto, where)
        finally:
            self._expanding.discard(name)

    @staticmethod
    def _split_args(text: str, max_args: Optional[int]) -> list[str]:
        args: list[str] = []
        depth = 0
        start = 0
        i = 0
        n = len(text)
        while i < n:
            c = text[i]
            if c == "$" and i + 1 < n and text[i + 1] in "({":
                depth += 1
                i += 2
                continue
            if depth:
                if c in ")}":
                    depth -= 1
            elif c == "," and (max_args is None or len(args) < max_args - 1):
                args.append(text[start:i])
                start = i + 1
            i += 1
        args.append(text[start:])
        return args

    def _function(self, name: str, args_text: str, auto: Optional[dict[str, str]], where: str) -> str:
        if name in _UNSUPPORTED_FUNCTIONS:
            raise MakeError(f"{where}: unsupported: $({name})")
        lo, hi = _FUNCTIONS[name]
        raw = self._split_args(args_text, hi)
        if len(raw) < lo:
            raise MakeError(f"{where}: insufficient number of arguments ({len(raw)}) to function '{name}'")
        ex = lambda s: self.expand(s, auto, where)  # noqa: E731

        if name == "if":
            cond = ex(raw[0]).strip()
            if cond:
                return ex(raw[1])
            return ex(raw[2]) if len(raw) > 2 else ""
        if name == "or":
            for a in raw:
                v = ex(a).strip()
                if v:
                    return v
            return ""
        if name == "and":
            v = ""
            for a in raw:
                v = ex(a).strip()
                if not v:
                    return ""
            return v
        if name == "foreach":
            var = ex(raw[0]).strip()
            words = split_words(ex(raw[1]))
            results = []
            for w in words:
                self._frames.append({var: w})
                try:
                    results.append(ex(raw[2]))
                finally:
                    self._frames.pop()
            return " ".join(results)
        if name == "call":
            fn_name = ex(raw[0]).strip()
            call_args = [ex(a) for a in raw[1:]]
            if fn_name in _FUNCTIONS:
                return self._function(fn_name, ",".join(call_args), auto, where)
            var = self.vars.get(fn_name)
            if var is None:
                return ""
            frame = {"0": fn_name}
            for k, a in enumerate(call_args, 1):
                frame[str(k)] = a
            self._frames.append(frame)
            try:
                return self.expand(var.value, auto, where) if var.recursive else var.value
            finally:
                self._frames.pop()
        if name == "value":
            var = self.vars.get(ex(raw[0]).strip())
            return var.value if var is not None else ""
        if name == "origin":
            var = self.vars.get(ex(raw[0]).strip())
            return var.origin if var is not None else "undefined"
        if name == "flavor":
            var = self.vars.get(ex(raw[0]).strip())
            if var is None:
                return "undefined"
            return "recursive" if var.recursive else "simple"
        if name == "eval":
            text = ex(raw[0])
            if text.strip():
                raise MakeError(f"{where}: unsupported: $(eval) with content")
            return ""
        if name == "shell":
            command = ex(raw[0])
            output = self.shell.shell_function(command, self._recipe_env(), where)
            return output.replace("\r\n", "\n").rstrip("\n").replace("\n", " ")
        if name == "error":
            raise MakeError(f"{where}: *** {ex(raw[0])}.  Stop.")
        if name in ("warning", "info"):
            text = ex(raw[0])
            self.log(f"{where}: {text}" if name == "warning" else text)
            return ""

        args = [ex(a) for a in raw]
        if name == "subst":
            # An empty from-string matches once, at the end (function.c, subst_expand).
            return args[2].replace(args[0], args[1]) if args[0] else args[2] + args[1]
        if name == "patsubst":
            pattern, repl, text = args
            if "%" not in pattern:
                # Without a % the pattern matches whole words and the
                # replacement is taken as written, % and all (function.c).
                return " ".join(repl if w == pattern else w for w in split_words(text))
            return " ".join(_pattern_subst(repl, s) if (s := _pattern_match(pattern, w)) is not None else w
                            for w in split_words(text))
        if name == "strip":
            return " ".join(split_words(args[0]))
        if name == "findstring":
            return args[0] if args[0] in args[1] else ""
        if name in ("filter", "filter-out"):
            patterns = split_words(args[0])
            words = split_words(args[1])
            keep = name == "filter"
            return " ".join(w for w in words
                            if any(_pattern_match(p, w) is not None for p in patterns) == keep)
        if name == "sort":
            return " ".join(sorted(set(split_words(args[0]))))
        if name == "word":
            idx = self._int(args[0], where, "word")
            if idx < 1:
                raise MakeError(f"{where}: first argument to 'word' function must be greater than 0")
            words = split_words(args[1])
            return words[idx - 1] if idx <= len(words) else ""
        if name == "wordlist":
            s = self._int(args[0], where, "wordlist")
            e = self._int(args[1], where, "wordlist")
            words = split_words(args[2])
            if s < 1:
                raise MakeError(f"{where}: invalid first argument to 'wordlist' function")
            return " ".join(words[s - 1:e]) if e >= s else ""
        if name == "words":
            return str(len(split_words(args[0])))
        if name == "firstword":
            words = split_words(args[0])
            return words[0] if words else ""
        if name == "lastword":
            words = split_words(args[0])
            return words[-1] if words else ""
        if name == "dir":
            return " ".join(self._dir(w) for w in split_words(args[0]))
        if name == "notdir":
            return " ".join(self._notdir(w) for w in split_words(args[0]))
        if name == "suffix":
            return " ".join(s for w in split_words(args[0]) if (s := self._suffix(w)))
        if name == "basename":
            return " ".join(self._basename(w) for w in split_words(args[0]))
        if name == "addsuffix":
            return " ".join(w + args[0] for w in split_words(args[1]))
        if name == "addprefix":
            return " ".join(args[0] + w for w in split_words(args[1]))
        if name == "join":
            a = split_words(args[0])
            b = split_words(args[1])
            return " ".join((a[k] if k < len(a) else "") + (b[k] if k < len(b) else "")
                            for k in range(max(len(a), len(b))))
        if name == "wildcard":
            out = []
            for pattern in split_words(args[0]):
                if any(ch in pattern for ch in "*?["):
                    out.extend(self._glob(pattern))
                elif self._exists(pattern):
                    out.append(pattern)
            return " ".join(out)
        if name in ("realpath", "abspath"):
            out = []
            for w in split_words(args[0]):
                p = self._path(w)
                if name == "realpath":
                    if not p.exists():
                        continue
                    p = p.resolve()
                else:
                    p = Path(os.path.abspath(p))
                out.append(_posix(str(p)))
            return " ".join(out)
        raise MakeError(f"{where}: unsupported: $({name})")  # pragma: no cover

    @staticmethod
    def _int(text: str, where: str, fn: str) -> int:
        try:
            return int(text.strip())
        except ValueError:
            raise MakeError(f"{where}: non-numeric argument to '{fn}' function: '{text}'") from None

    @staticmethod
    def _dir(word: str) -> str:
        i = word.rfind("/")
        return word[:i + 1] if i >= 0 else "./"

    @staticmethod
    def _notdir(word: str) -> str:
        i = word.rfind("/")
        return word[i + 1:] if i >= 0 else word

    @staticmethod
    def _suffix(word: str) -> str:
        base = Evaluator._notdir(word)
        i = base.rfind(".")
        return base[i:] if i >= 0 else ""

    @staticmethod
    def _basename(word: str) -> str:
        i = word.rfind(".")
        j = word.rfind("/")
        return word[:i] if i > j else word

    # ── Files ─────────────────────────────────────────────────────────

    def _path(self, name: str) -> Path:
        p = Path(name)
        return p if p.is_absolute() else self.tree / name

    def _exists(self, name: str) -> bool:
        return os.path.lexists(self._path(name))

    def _mtime(self, name: str) -> Optional[float]:
        try:
            return os.stat(self._path(name)).st_mtime
        except OSError:
            return None

    def _glob(self, pattern: str) -> list[str]:
        """Expand a wildcard relative to the tree, sorted, keeping the
        pattern's own spelling of the directory part."""
        import glob as _glob
        if Path(pattern).is_absolute():
            return [_posix(m) for m in sorted(_glob.glob(pattern))]
        # The directories before the first component with a wildcard are kept
        # as the pattern spells them (./, ../ and // included, as GNU make
        # keeps them); only what the wildcard matched is appended to them.
        parts = pattern.split("/")
        first = next((i for i, part in enumerate(parts) if any(ch in part for ch in "*?[")), len(parts))
        prefix = "".join(part + "/" for part in parts[:first])
        rest = "/".join(parts[first:])
        base = os.path.join(str(self.tree), prefix)
        if not rest:
            return [pattern] if os.path.lexists(base) else []
        matches = _glob.glob(os.path.join(_glob.escape(base), rest))
        return sorted(prefix + _posix(os.path.relpath(m, base)) for m in matches)

    # ── Rules ─────────────────────────────────────────────────────────

    def _resolve(self, name: str) -> Optional[Target]:
        """Resolve a target: its explicit rules merged, with a pattern rule
        supplying the recipe (and its prerequisites) when no explicit rule has
        one, searched the way GNU make searches implicit rules. The rule that
        supplies the recipe, explicit or pattern, lists its prerequisites
        first."""
        rules = self.explicit.get(name, [])
        prereqs: list[str] = []
        recipe_rule: Optional[Rule] = None
        for r in rules:
            if r.recipe:
                if recipe_rule is not None:
                    self.log(f"{r.file}:{r.lineno}: warning: overriding recipe for target '{name}'")
                recipe_rule = r
                # The rule that carries the recipe puts its prerequisites
                # first, so $< and $^ are what that rule expects (GNU make
                # read.c, record_files); the other rules' prerequisites follow.
                prereqs = list(r.prereqs) + [p for p in prereqs if p not in r.prereqs]
            else:
                for p in r.prereqs:
                    if p not in prereqs:
                        prereqs.append(p)
        phony = name in self.phony
        if recipe_rule is not None:
            return Target(name, prereqs, recipe_rule, phony=phony)
        found = self._implicit(name, depth=0)
        if found is not None:
            rule, stem, pattern_prereqs = found
            # As for an explicit rule with a recipe, the pattern rule that
            # supplies the recipe puts its prerequisites first (GNU make
            # implicit.c, pattern_search), so $< is the rule's own source.
            merged = list(dict.fromkeys(pattern_prereqs))
            for p in prereqs:
                if p not in merged:
                    merged.append(p)
            return Target(name, merged, rule, stem=stem, phony=phony)
        if rules or phony:
            return Target(name, prereqs, None, phony=phony)
        return None

    def _implicit(self, name: str, depth: int) -> Optional[tuple[Rule, str, list[str]]]:
        if depth > 4:
            return None
        candidates: list[tuple[int, int, Rule, str]] = []
        for order, rule in enumerate(self.pattern_rules):
            if not rule.recipe:
                continue
            for pattern in rule.targets:
                if "/" not in pattern:
                    stem = _pattern_match(pattern, self._notdir(name))
                    if stem is not None and "/" in name:
                        stem = self._dir(name) + stem
                else:
                    stem = _pattern_match(pattern, name)
                if stem is not None:
                    candidates.append((len(stem), order, rule, stem))
                    break
        candidates.sort(key=lambda c: (c[0], c[1]))
        for _, _, rule, stem in candidates:
            prereqs = [_pattern_subst(p, stem) for p in rule.prereqs]
            if all(self._exists(p) or self._ought_to_exist(p) or self._implicit(p, depth + 1) is not None
                   for p in prereqs):
                return rule, stem, prereqs
        return None

    def _ought_to_exist(self, name: str) -> bool:
        """GNU make's "ought to exist": the file is a target or an explicit
        prerequisite somewhere in the makefiles."""
        if name in self.explicit:
            return True
        if self._mentioned_cache is None:
            s: set[str] = set()
            for r in self.rules:
                if not r.pattern:
                    s.update(r.prereqs)
            self._mentioned_cache = s
        return name in self._mentioned_cache

    # ── Updating ──────────────────────────────────────────────────────

    def _auto(self, target: Target) -> dict[str, str]:
        prereqs = target.prereqs
        return {
            "@": target.name,
            "<": prereqs[0] if prereqs else "",
            "^": " ".join(dict.fromkeys(prereqs)),
            "+": " ".join(prereqs),
            "*": target.stem if target.rule is not None and target.rule.pattern else self._suffix_stem(target.name),
            "?": " ".join(prereqs),
            "|": "",
        }

    def _suffix_stem(self, name: str) -> str:
        """$* of a target an explicit rule builds: the name without the first
        .SUFFIXES entry it ends with (GNU make commands.c,
        set_file_variables), else empty."""
        for suffix in self.suffixes:
            if len(name) > len(suffix) and name.endswith(suffix):
                return name[:-len(suffix)]
        return ""

    def _recipe_env(self) -> dict[str, str]:
        """The environment of a recipe or a ``$(shell)``: the exported
        variables, expanded. A variable being expanded is left out, as GNU
        make leaves it out, and a ``$(shell)`` reached while the environment
        is being built gets only the simple variables, so an exported
        variable whose value runs ``$(shell)`` does not recurse."""
        env = dict(self.env)
        nested = self._building_env
        self._building_env = True
        try:
            for var in self.vars.exported():
                if var.origin == ORIGIN_AUTOMATIC or var.name in self._expanding:
                    continue
                if not var.recursive:
                    env[var.name] = var.value
                    continue
                if nested:
                    continue
                self._expanding.add(var.name)
                try:
                    env[var.name] = self.expand(var.value)
                finally:
                    self._expanding.discard(var.name)
        finally:
            self._building_env = nested
        return env

    async def _update(self, name: str, dry_run: bool, remaking_makefiles: bool = False) -> bool:
        """Bring ``name`` up to date, returning whether it was (or, in a dry
        run, would be) remade."""
        if name in self._done:
            return self._done[name]
        if name in self._updating:
            raise MakeError(f"Circular {self._updating[-1]} <- {name} dependency dropped")
        target = self._resolve(name)
        if target is None:
            if self._exists(name):
                self._done[name] = False
                return False
            needed = f", needed by '{self._updating[-1]}'" if self._updating else ""
            raise MakeError(f"No rule to make target '{name}'{needed}.  Stop.")
        self._updating.append(name)
        try:
            remade_prereq = False
            newest: Optional[float] = None
            for p in target.prereqs:
                if await self._update(p, dry_run, remaking_makefiles):
                    remade_prereq = True
                m = self._mtime(p)
                if m is not None and (newest is None or m > newest):
                    newest = m
            own = self._mtime(name)
            needs = (target.phony or own is None or remade_prereq
                     or (newest is not None and newest > own))
            if needs and target.rule is not None and target.recipe:
                await self._run_recipe(target, dry_run and not remaking_makefiles)
            self._done[name] = bool(needs)
            return bool(needs)
        finally:
            self._updating.pop()

    async def _run_recipe(self, target: Target, dry_run: bool) -> None:
        auto = self._auto(target)
        env = self._recipe_env()
        for line in target.recipe:
            where = f"{line.file}:{line.lineno}"
            text = self.expand(line.text, auto, where)
            silent = ignore = always = False
            text = text.lstrip(" \t")
            while text and text[0] in "@-+":
                if text[0] == "@":
                    silent = True
                elif text[0] == "-":
                    ignore = True
                else:
                    always = True
                text = text[1:].lstrip(" \t")
            if not text.strip():
                continue
            if "$(MAKE)" in line.text or "${MAKE}" in line.text:
                always = True
            if dry_run or not silent:
                self.transcript.append(text)
            if text.startswith("#"):
                # A comment for the shell: echoed, never run.
                continue
            if dry_run and not always:
                continue
            self.commands.append(text)
            result = await self.shell.run(text, env, dry_run=dry_run, where=where, make=self)
            if result.stdout:
                self.transcript.extend(result.stdout.replace("\r\n", "\n").rstrip("\n").split("\n"))
            if result.code != 0 and not ignore:
                if self.delete_on_error and not target.phony and self._exists(target.name):
                    try:
                        self._path(target.name).unlink()
                    except OSError:
                        pass
                detail = result.stderr.strip()
                raise MakeError(f"*** [{where}: {target.name}] Error {result.code}"
                                + (f"\n{detail}" if detail else ""))

    # ── Public entry points ───────────────────────────────────────────

    async def ensure_loaded(self) -> None:
        if not self._loaded:
            await self.load()

    async def update(self, goals: Optional[list[str]] = None, dry_run: bool = False) -> None:
        """Update the goals (the default goal when none), running recipes
        through the shell, or only printing them to the transcript."""
        await self.ensure_loaded()
        self._done = {}
        if not goals:
            goal_var = self.vars.get(".DEFAULT_GOAL")
            words = split_words(self._lookup(".DEFAULT_GOAL", None, "")) if goal_var is not None else []
            if len(words) > 1:
                raise MakeError("*** .DEFAULT_GOAL contains more than one target.  Stop.")
            goals = words
        else:
            goals = list(goals)
        if not goals or not goals[0]:
            raise MakeError("No targets.  Stop.")
        for goal in goals:
            await self._update(goal, dry_run)

    async def dry_run(self, goals: Optional[list[str]] = None) -> list[str]:
        """The lines ``make -n`` would print for the goals: every recipe line
        after expansion, in GNU make's order, plus the output of the commands
        run while remaking makefiles."""
        await self.update(goals, dry_run=True)
        return list(self.transcript)

    def resolve(self, name: str) -> Optional[Target]:
        """The target as the rules resolve it, without updating anything."""
        return self._resolve(name)

    def graph(self, goals: list[str]) -> dict[str, Target]:
        """Every target reachable from the goals, with its prerequisites and
        rule; a prerequisite with no rule that does not exist is an error."""
        nodes: dict[str, Target] = {}
        stack: list[str] = []

        def visit(name: str, parent: str) -> None:
            if name in nodes:
                return
            if name in stack:
                raise MakeError(f"Circular {parent} <- {name} dependency dropped")
            t = self._resolve(name)
            if t is None:
                if self._exists(name):
                    nodes[name] = Target(name, [], None)
                    return
                raise MakeError(f"No rule to make target '{name}', needed by '{parent}'.  Stop.")
            stack.append(name)
            for p in t.prereqs:
                visit(p, name)
            stack.pop()
            nodes[name] = t

        for g in goals:
            visit(g, "the command line")
        return nodes

    def plan(self, goals: list[str]) -> list[list[Target]]:
        """The targets with recipes that the goals need, grouped into waves:
        every target of a wave depends only on earlier waves, so a wave's
        recipes may run concurrently. Within a wave the order is the order
        GNU make would reach the targets."""
        nodes = self.graph(goals)
        order: list[str] = []
        seen: set[str] = set()

        def walk(name: str) -> None:
            if name in seen:
                return
            seen.add(name)
            for p in nodes[name].prereqs:
                walk(p)
            order.append(name)

        for g in goals:
            walk(g)
        depth: dict[str, int] = {}
        for name in order:
            t = nodes[name]
            d = 0
            for p in t.prereqs:
                pd = depth.get(p, -1)
                if nodes[p].recipe:
                    pd += 1
                d = max(d, pd)
            depth[name] = d
        waves: dict[int, list[Target]] = {}
        for name in order:
            t = nodes[name]
            if t.recipe:
                waves.setdefault(depth[name], []).append(t)
        return [waves[k] for k in sorted(waves)]

    async def submake(self, args: list[str], dry_run: bool) -> "Evaluator":
        """Run ``$(MAKE) args`` as GNU make would: a fresh evaluator over the
        same makefiles with the same command-line variables plus the ones in
        ``args``, updating the goals in ``args``."""
        command_line = dict(self.command_line)
        goals = []
        for a in args:
            if a.startswith("-"):
                raise MakeError(f"unsupported: $(MAKE) option {a}")
            if "=" in a:
                k, v = a.split("=", 1)
                command_line[k] = v
            else:
                goals.append(a)
        if self.level >= _MAX_MAKE_LEVEL:
            # GNU make would go on starting sub-makes forever; Python would
            # stop at its recursion limit, in whatever code ran last.
            raise MakeError(f"recursive $(MAKE) nested more than {_MAX_MAKE_LEVEL} levels deep "
                            "(a rule that never becomes up to date)")
        sub = Evaluator(self.tree, self.shell, command_line=command_line, env=self.env,
                        makefile=self.makefile, level=self.level + 1, log=self.log)
        await sub.load()
        await sub.update(goals or None, dry_run=dry_run)
        self.transcript.extend(sub.transcript)
        self.commands.extend(sub.commands)
        return sub


def run_sync(coro):
    """Run a coroutine to completion from synchronous code (CPython)."""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)
    raise RuntimeError("run_sync() cannot be used inside a running event loop; await the coroutine")
