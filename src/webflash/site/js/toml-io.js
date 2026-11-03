// Reading and writing board TOMLs in the browser.
//
// parseToml reads TOML text into plain objects: enough of TOML 1.0 for board
// TOMLs and themes (every string form, integers in every base, floats,
// booleans, arrays, inline tables, tables and arrays of tables; dates are
// refused). parseWithMap also records where each value sits, so patchValue
// changes one value and keeps everything else, comments included.
// writeBoardToml writes a fresh board TOML from its tables, the same text as
// webflash's config.dump_board for the same tables.
//
// The authority on what a board TOML may hold is webflash's loader, which the
// site reaches through the bridge (check_board); this module only reads the
// text for the controls and writes it back.

export class TomlParseError extends Error {
  constructor(message, line) {
    super(line ? `line ${line}: ${message}` : message);
    this.line = line;
  }
}

const BARE_KEY = /^[A-Za-z0-9_-]+$/;
const BARE_KEY_CHAR = /[A-Za-z0-9_-]/;
const NUMBER = /^[+-]?(?:0x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*|0o[0-7](?:_?[0-7])*|0b[01](?:_?[01])*|inf|nan|(?:0|[1-9](?:_?[0-9])*)(?:\.[0-9](?:_?[0-9])*)?(?:[eE][+-]?[0-9](?:_?[0-9])*)?)$/;
const DATE_LIKE = /^\d{4}-\d{2}-\d{2}|^\d{2}:\d{2}/;

// A table defined by a [header] or a dotted key, as opposed to one created
// on the way to a deeper header, which a later [header] may still define.
const DEFINED = Symbol("defined");
const IMPLICIT = Symbol("implicit");

class Parser {
  constructor(text) {
    this.s = text;
    this.i = 0;
    this.root = {};
    this.current = this.root;
    this.currentName = "";
    // Every key = value: {table, key, start, valueStart, valueEnd, end}, with
    // start/end the offsets of its whole lines and valueStart/valueEnd the
    // value's own text. table names a table as patchValue does: "board",
    // "flash.instructions", "option#0" for the first [[option]].
    this.entries = [];
    // Every [header]: {name, start, headerEnd, end}; end is just past the
    // table's last key line, or headerEnd when it has none.
    this.tables = [];
    this.arrayCounts = new Map();
  }

  get line() {
    let n = 1;
    for (let k = 0; k < this.i && k < this.s.length; k++) if (this.s[k] === "\n") n++;
    return n;
  }

  fail(message) { throw new TomlParseError(message, this.line); }
  peek(n = 0) { return this.s[this.i + n]; }
  startsWith(t) { return this.s.startsWith(t, this.i); }

  skipSpaces() {
    while (this.peek() === " " || this.peek() === "\t") this.i++;
  }

  skipComment() {
    if (this.peek() !== "#") return;
    while (this.i < this.s.length && this.peek() !== "\n") {
      const c = this.s.charCodeAt(this.i);
      if ((c < 0x20 && c !== 0x09 && c !== 0x0d) || c === 0x7f) this.fail("control character in a comment");
      this.i++;
    }
  }

  // Past the end of the current line, which may hold only spaces and a comment.
  endOfLine() {
    this.skipSpaces();
    this.skipComment();
    if (this.i >= this.s.length) return;
    if (this.startsWith("\r\n")) { this.i += 2; return; }
    if (this.peek() === "\n") { this.i++; return; }
    this.fail(`unexpected ${JSON.stringify(this.peek())} after a value`);
  }

  // Spaces, newlines and comments, as allowed between array items.
  skipBlank() {
    for (;;) {
      this.skipSpaces();
      this.skipComment();
      if (this.startsWith("\r\n")) this.i += 2;
      else if (this.peek() === "\n") this.i++;
      else return;
    }
  }

  parse() {
    for (;;) {
      this.skipBlank();
      if (this.i >= this.s.length) break;
      const start = this.i;
      if (this.startsWith("[[")) this.arrayHeader(start);
      else if (this.peek() === "[") this.tableHeader(start);
      else this.keyValue(start);
    }
    return this;
  }

  closeTable() {
    const t = this.tables[this.tables.length - 1];
    if (t) {
      const last = [...this.entries].reverse().find((e) => e.table === t.name);
      t.end = last ? last.end : t.headerEnd;
    }
  }

  tableHeader(start) {
    this.i++;
    this.skipSpaces();
    const path = this.key();
    this.skipSpaces();
    if (this.peek() !== "]") this.fail("a table header ends with ]");
    this.i++;
    this.endOfLine();
    let table = this.root;
    path.forEach((part, n) => {
      const last = n === path.length - 1;
      let next = table[part];
      if (next === undefined) {
        next = {};
        next[last ? DEFINED : IMPLICIT] = true;
        table[part] = next;
      } else if (Array.isArray(next) && !last) {
        next = next[next.length - 1];
      } else if (!isTable(next)) {
        this.fail(`'${path.join(".")}' is already a value`);
      } else if (last) {
        if (next[DEFINED]) this.fail(`[${path.join(".")}] is defined twice`);
        next[DEFINED] = true;
      }
      table = next;
    });
    this.closeTable();
    this.current = table;
    this.currentName = this.tableName(path);
    this.tables.push({ name: this.currentName, start, headerEnd: this.i, end: this.i });
  }

  arrayHeader(start) {
    this.i += 2;
    this.skipSpaces();
    const path = this.key();
    this.skipSpaces();
    if (!this.startsWith("]]")) this.fail("an array of tables header ends with ]]");
    this.i += 2;
    this.endOfLine();
    let table = this.root;
    path.forEach((part, n) => {
      const last = n === path.length - 1;
      let next = table[part];
      if (last) {
        if (next === undefined) {
          next = [];
          table[part] = next;
        } else if (!Array.isArray(next)) {
          this.fail(`'${path.join(".")}' is not an array of tables`);
        }
        const entry = { [DEFINED]: true };
        next.push(entry);
        next = entry;
      } else if (next === undefined) {
        next = { [IMPLICIT]: true };
        table[part] = next;
      } else if (Array.isArray(next)) {
        next = next[next.length - 1];
      } else if (!isTable(next)) {
        this.fail(`'${path.join(".")}' is already a value`);
      }
      table = next;
    });
    this.closeTable();
    this.current = table;
    const base = path.join(".");
    const index = this.arrayCounts.get(base) || 0;
    this.arrayCounts.set(base, index + 1);
    this.currentName = `${base}#${index}`;
    this.tables.push({ name: this.currentName, start, headerEnd: this.i, end: this.i });
  }

  tableName(path) {
    // A header under an array of tables names the array's last entry.
    let name = "";
    let table = this.root;
    path.forEach((part, n) => {
      name = name ? `${name}.${part}` : part;
      const next = table[part];
      if (Array.isArray(next) && n < path.length - 1) {
        name = `${name}#${next.length - 1}`;
        table = next[next.length - 1];
      } else {
        table = next;
      }
    });
    return name;
  }

  keyValue(start) {
    const path = this.key();
    this.skipSpaces();
    if (this.peek() !== "=") this.fail(`expected = after ${path.join(".")}`);
    this.i++;
    this.skipSpaces();
    const valueStart = this.i;
    const value = this.value();
    const valueEnd = this.i;
    this.endOfLine();
    let table = this.current;
    for (const part of path.slice(0, -1)) {
      if (table[part] === undefined) table[part] = { [DEFINED]: true };
      else if (!isTable(table[part])) this.fail(`'${part}' is already a value`);
      table = table[part];
    }
    const last = path[path.length - 1];
    if (Object.prototype.hasOwnProperty.call(table, last)) this.fail(`'${path.join(".")}' is set twice`);
    table[last] = value;
    this.entries.push({ table: this.currentName, key: path.join("."), start, valueStart, valueEnd, end: this.i });
  }

  key() {
    const parts = [];
    for (;;) {
      this.skipSpaces();
      const c = this.peek();
      if (c === '"') parts.push(this.basicString());
      else if (c === "'") parts.push(this.literalString());
      else {
        const begin = this.i;
        while (this.i < this.s.length && BARE_KEY_CHAR.test(this.peek())) this.i++;
        if (begin === this.i) this.fail("expected a key");
        parts.push(this.s.slice(begin, this.i));
      }
      this.skipSpaces();
      if (this.peek() !== ".") return parts;
      this.i++;
    }
  }

  value() {
    const c = this.peek();
    if (this.startsWith('"""')) return this.multilineBasic();
    if (this.startsWith("'''")) return this.multilineLiteral();
    if (c === '"') return this.basicString();
    if (c === "'") return this.literalString();
    if (c === "[") return this.array();
    if (c === "{") return this.inlineTable();
    const begin = this.i;
    while (this.i < this.s.length && !/[\s,\]}#]/.test(this.peek())) this.i++;
    const word = this.s.slice(begin, this.i);
    if (!word) this.fail("expected a value");
    if (word === "true") return true;
    if (word === "false") return false;
    if (NUMBER.test(word)) return toNumber(word);
    if (DATE_LIKE.test(word)) this.fail("dates and times are not supported here");
    this.fail(`cannot read the value ${JSON.stringify(word)}`);
  }

  escape() {
    // At the character after a backslash.
    const c = this.peek();
    this.i++;
    switch (c) {
      case "b": return "\b";
      case "t": return "\t";
      case "n": return "\n";
      case "f": return "\f";
      case "r": return "\r";
      case '"': return '"';
      case "\\": return "\\";
      case "u":
      case "U": {
        const n = c === "u" ? 4 : 8;
        const hex = this.s.slice(this.i, this.i + n);
        if (!new RegExp(`^[0-9A-Fa-f]{${n}}$`).test(hex)) this.fail("bad unicode escape");
        this.i += n;
        const point = parseInt(hex, 16);
        if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) this.fail("bad unicode escape");
        return String.fromCodePoint(point);
      }
      default:
        this.fail(`bad escape \\${c === undefined ? "" : c}`);
    }
  }

  checkChar(c, multiline) {
    const code = c.charCodeAt(0);
    if ((code < 0x20 && code !== 0x09 && !(multiline && (code === 0x0a || code === 0x0d))) || code === 0x7f) {
      this.fail("control character in a string (escape it)");
    }
  }

  basicString() {
    this.i++;
    let out = "";
    for (;;) {
      if (this.i >= this.s.length || this.peek() === "\n") this.fail("unterminated string");
      const c = this.peek();
      if (c === '"') { this.i++; return out; }
      if (c === "\\") { this.i++; out += this.escape(); continue; }
      this.checkChar(c, false);
      out += c;
      this.i++;
    }
  }

  literalString() {
    this.i++;
    const begin = this.i;
    for (;;) {
      if (this.i >= this.s.length || this.peek() === "\n") this.fail("unterminated string");
      if (this.peek() === "'") break;
      this.checkChar(this.peek(), false);
      this.i++;
    }
    const out = this.s.slice(begin, this.i);
    this.i++;
    return out;
  }

  // The newline right after an opening """ or ''' is not part of the string.
  skipFirstNewline() {
    if (this.startsWith("\r\n")) this.i += 2;
    else if (this.peek() === "\n") this.i++;
  }

  // A run of quotes at the end: up to two belong to the string, three close it.
  closing(q) {
    let run = 0;
    while (this.peek(run) === q) run++;
    if (run < 3) return -1;
    if (run > 5) this.fail("too many quotes at the end of a string");
    return run - 3;
  }

  multilineBasic() {
    this.i += 3;
    this.skipFirstNewline();
    let out = "";
    for (;;) {
      if (this.i >= this.s.length) this.fail("unterminated multi-line string");
      const c = this.peek();
      if (c === '"') {
        const extra = this.closing('"');
        if (extra >= 0) {
          out += '"'.repeat(extra);
          this.i += extra + 3;
          return out;
        }
        out += c;
        this.i++;
        continue;
      }
      if (c === "\\") {
        // A backslash at the end of a line trims the newline and every space
        // and newline after it.
        let k = this.i + 1;
        while (this.s[k] === " " || this.s[k] === "\t") k++;
        if (this.s[k] === "\n" || this.s.startsWith("\r\n", k)) {
          this.i = k;
          while (/[ \t\r\n]/.test(this.peek() || "")) this.i++;
          continue;
        }
        this.i++;
        out += this.escape();
        continue;
      }
      if (this.startsWith("\r\n")) { out += "\n"; this.i += 2; continue; }
      this.checkChar(c, true);
      out += c;
      this.i++;
    }
  }

  multilineLiteral() {
    this.i += 3;
    this.skipFirstNewline();
    let out = "";
    for (;;) {
      if (this.i >= this.s.length) this.fail("unterminated multi-line string");
      const c = this.peek();
      if (c === "'") {
        const extra = this.closing("'");
        if (extra >= 0) {
          out += "'".repeat(extra);
          this.i += extra + 3;
          return out;
        }
      }
      if (this.startsWith("\r\n")) { out += "\n"; this.i += 2; continue; }
      this.checkChar(c, true);
      out += c;
      this.i++;
    }
  }

  array() {
    this.i++;
    const out = [];
    for (;;) {
      this.skipBlank();
      if (this.peek() === "]") { this.i++; return out; }
      out.push(this.value());
      this.skipBlank();
      if (this.peek() === ",") { this.i++; continue; }
      if (this.peek() === "]") { this.i++; return out; }
      this.fail("expected , or ] in an array");
    }
  }

  inlineTable() {
    this.i++;
    const out = {};
    this.skipSpaces();
    if (this.peek() === "}") { this.i++; return out; }
    for (;;) {
      this.skipSpaces();
      const path = this.key();
      this.skipSpaces();
      if (this.peek() !== "=") this.fail("expected = in an inline table");
      this.i++;
      this.skipSpaces();
      const value = this.value();
      let table = out;
      for (const part of path.slice(0, -1)) {
        if (table[part] === undefined) table[part] = {};
        else if (!isTable(table[part])) this.fail(`'${part}' is already a value`);
        table = table[part];
      }
      const last = path[path.length - 1];
      if (Object.prototype.hasOwnProperty.call(table, last)) this.fail(`'${path.join(".")}' is set twice`);
      table[last] = value;
      this.skipSpaces();
      if (this.peek() === ",") { this.i++; continue; }
      if (this.peek() === "}") { this.i++; return out; }
      this.fail("expected , or } in an inline table (an inline table stays on one line)");
    }
  }
}

function isTable(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function toNumber(word) {
  const w = word.replace(/_/g, "");
  if (/^[+-]?inf$/.test(w)) return w.startsWith("-") ? -Infinity : Infinity;
  if (/^[+-]?nan$/.test(w)) return NaN;
  if (/^0x/.test(w)) return parseInt(w.slice(2), 16);
  if (/^0o/.test(w)) return parseInt(w.slice(2), 8);
  if (/^0b/.test(w)) return parseInt(w.slice(2), 2);
  return /[.eE]/.test(w) ? parseFloat(w) : parseInt(w, 10);
}

/** TOML text to plain objects. Throws TomlParseError, naming the line. */
export function parseToml(text) {
  return new Parser(String(text)).parse().root;
}

/** parseToml, plus where every key = value and every [header] sits. */
export function parseWithMap(text) {
  const p = new Parser(String(text)).parse();
  p.closeTable();
  return { data: p.root, entries: p.entries, tables: p.tables };
}

// ── Writing values ──────────────────────────────────────────────────

function hex4(ch) {
  return `\\u${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`;
}

/** A TOML basic string on one line. */
export function tomlString(text) {
  let out = "";
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\n";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\r") out += "\\r";
    else if (code < 0x20 || code === 0x7f) out += hex4(ch);
    else out += ch;
  }
  return `"${out}"`;
}

/**
 * A TOML multi-line basic string that starts on the next line, so the text
 * reads as written: quotes stay bare except a third in a row (which would end
 * the string) and a last one (which would join the delimiter).
 */
export function tomlMultiline(text) {
  const chars = [...String(text)];
  let out = "";
  let run = 0;
  chars.forEach((ch, i) => {
    if (ch === '"') {
      if (run === 2 || i === chars.length - 1) {
        out += '\\"';
        run = 0;
      } else {
        out += '"';
        run++;
      }
      return;
    }
    run = 0;
    const code = ch.codePointAt(0);
    if (ch === "\\") out += "\\\\";
    else if (ch === "\n" || ch === "\t") out += ch;
    else if (code < 0x20 || code === 0x7f) out += hex4(ch);
    else out += ch;
  });
  return `"""\n${out}"""`;
}

/** Prose: multi-line when it has line breaks, so the TOML reads like the text. */
export function tomlText(text) {
  const s = String(text);
  return s.includes("\n") ? tomlMultiline(s) : tomlString(s);
}

export function tomlKey(key) {
  return BARE_KEY.test(key) ? key : tomlString(key);
}

function tomlArray(items) {
  return `[${items.map((item) => tomlString(String(item))).join(", ")}]`;
}

function tomlInlineTable(table, keys = Object.keys(table)) {
  const body = keys.map((k) => `${tomlKey(String(k))} = ${tomlString(String(table[k]))}`).join(", ");
  return body ? `{ ${body} }` : "{}";
}

// An option's labels in the order both writers use: the order of values, then
// any other keys sorted. Not the TOML's own order, which an object cannot keep
// (it lists integer-like keys such as "500000" first, in numeric order).
function labelOrder(labels, values) {
  const keys = (values || []).map(String).filter((k) => Object.prototype.hasOwnProperty.call(labels, k));
  const rest = Object.keys(labels).filter((k) => !keys.includes(k)).sort();
  return [...keys, ...rest];
}

/** Any value patchValue writes: text, a number, a boolean, a list of text. */
export function tomlValue(value) {
  if (typeof value === "string") return tomlText(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (Number.isInteger(value)) return String(value);
    if (Number.isNaN(value)) return "nan";
    if (!Number.isFinite(value)) return value > 0 ? "inf" : "-inf";
    return String(value);
  }
  if (Array.isArray(value)) return tomlArray(value);
  if (isTable(value)) return tomlInlineTable(value);
  throw new Error(`cannot write ${typeof value} as a TOML value`);
}

// ── Patching ────────────────────────────────────────────────────────

function newlineOf(text) {
  return /\r\n/.test(text) ? "\r\n" : "\n";
}

/**
 * Set one value and keep the rest of the text, comments included.
 *
 * table names the table ("board", "flash.instructions", "option#0" for the
 * first [[option]]); value undefined removes the key's lines. A key that is not
 * there is added after the table's last key; a table that is not there is
 * added, [board] at the top and any other at the end. Throws TomlParseError
 * when the text does not parse.
 */
export function patchValue(text, table, key, value) {
  const { entries, tables } = parseWithMap(text);
  const nl = newlineOf(text);
  const entry = entries.find((e) => e.table === table && e.key === key);
  if (value === undefined) {
    if (!entry) return text;
    return text.slice(0, entry.start) + text.slice(entry.end);
  }
  const written = tomlValue(value);
  if (entry) {
    return text.slice(0, entry.valueStart) + written + text.slice(entry.valueEnd);
  }
  const line = `${tomlKey(key)} = ${written}`;
  const t = tables.find((x) => x.name === table);
  if (t) {
    // After the table's last key line; a last line without a newline gets one.
    const at = t.end;
    const before = text.slice(0, at);
    const lead = at > 0 && !before.endsWith("\n") ? nl : "";
    return before + lead + line + nl + text.slice(at);
  }
  if (table.includes("#")) throw new Error(`there is no [[${table.split("#")[0]}]] number ${table.split("#")[1]}`);
  const header = `[${table}]`;
  if (table === "board") {
    return `${header}${nl}${line}${nl}${text.trim() ? nl : ""}${text}`;
  }
  const body = text.replace(/(\r?\n)*$/, "");
  return `${body}${body ? nl + nl : ""}${header}${nl}${line}${nl}`;
}

// ── A fresh board TOML ──────────────────────────────────────────────

export const DEFAULT_ENGINE_URL = "https://webflash.isiks.tech/engine/v1/";

/**
 * A board TOML from its tables, in the shape webflash's board_data returns
 * (and bridge.check_board passes on): the tables in the order of the board
 * TOML reference, every key that holds its default left out except
 * [firmware] version. The same text as config.dump_board in Python.
 */
export function writeBoardToml(data) {
  const lines = [];
  const b = data.board || {};
  lines.push("[board]", `title = ${tomlString(b.title || "")}`);
  for (const [key, def] of [["description", ""], ["image", ""], ["theme", "default"],
                            ["theme_dir", "./themes"], ["engine_url", DEFAULT_ENGINE_URL]]) {
    const value = b[key];
    if (value !== undefined && value !== null && value !== def) lines.push(`${key} = ${tomlText(String(value))}`);
  }

  const firmware = data.firmware;
  if (firmware) {
    const project = firmware.project || "";
    lines.push("", "[firmware]", `project = ${tomlString(project)}`);
    const projects = firmware.projects && firmware.projects.length ? firmware.projects : [project];
    if (!(projects.length === 1 && projects[0] === project)) lines.push(`projects = ${tomlArray(projects)}`);
    lines.push(`version = ${tomlString(firmware.version || "latest")}`);
    const versions = firmware.versions === undefined ? "all" : firmware.versions;
    if (Array.isArray(versions)) lines.push(`versions = ${tomlArray(versions)}`);
    else if (versions && versions !== "all") lines.push(`versions = ${tomlString(versions)}`);

    let text = (data.config && data.config.defconfig) || "";
    if (text && !text.endsWith("\n")) text += "\n";
    lines.push("", "[config]", `defconfig = ${text ? tomlMultiline(text) : tomlString("")}`);

    for (const option of data.options || []) {
      lines.push("", "[[option]]", `symbol = ${tomlString(option.symbol || "")}`);
      if (option.label) lines.push(`label = ${tomlText(option.label)}`);
      if (option.values !== undefined && option.values !== null) lines.push(`values = ${tomlArray(option.values)}`);
      if (option.labels && Object.keys(option.labels).length) {
        lines.push(`labels = ${tomlInlineTable(option.labels, labelOrder(option.labels, option.values))}`);
      }
      if (option.help) lines.push(`help = ${tomlText(option.help)}`);
    }
  }

  const flash = data.flash || {};
  const methods = flash.methods;
  const instructions = flash.instructions || {};
  if (methods !== undefined && methods !== null) lines.push("", "[flash]", `methods = ${tomlArray(methods)}`);
  if (Object.keys(instructions).length) {
    lines.push("", "[flash.instructions]");
    for (const [k, v] of Object.entries(instructions)) lines.push(`${tomlKey(String(k))} = ${tomlText(String(v))}`);
  }

  const prebuilt = data.prebuilt;
  if (prebuilt && !firmware) {
    lines.push("", "[prebuilt]", `file = ${tomlString(prebuilt.file || "")}`);
    if (prebuilt.address !== undefined && prebuilt.address !== null) {
      lines.push(`address = 0x${Number(prebuilt.address).toString(16).toUpperCase().padStart(8, "0")}`);
    }
    if (prebuilt.mcu) lines.push(`mcu = ${tomlString(prebuilt.mcu)}`);
  }
  return `${lines.join("\n")}\n`;
}

// ── The "Open in WebFlash" link ─────────────────────────────────────

/**
 * The TOML a "#toml=" fragment carries (what a generated page's link sends),
 * or null when the hash holds none. The data is base64url (RFC 4648 section
 * 5, without padding) of the UTF-8 text, as webflash's renderer writes it.
 */
export function tomlFromHash(hash) {
  const m = /(?:^#|&)toml=([A-Za-z0-9_-]*)/.exec(hash || "");
  if (!m) return null;
  let b64 = m[1].replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** The "#toml=" fragment for a TOML text. */
export function tomlToHash(text) {
  const bytes = new TextEncoder().encode(String(text));
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `#toml=${btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

/**
 * The WebFlash site an engine_url belongs to, as webflash's renderer.site_url
 * says: the URL with its engine/vN/ folder taken off (a site hosted under a
 * path keeps it), or the origin's root for any other runtime location.
 */
export function siteUrl(engineUrl) {
  const url = String(engineUrl);
  if (/engine\/v[0-9]+\/$/.test(url)) return url.replace(/engine\/v[0-9]+\/$/, "");
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)/.exec(url);
  return m ? `${m[1].toLowerCase()}://${m[2]}/` : `${new URL(url).origin}/`;
}

/** "Open in WebFlash": the site of an engine_url with a TOML text in its "#toml=". */
export function openInSiteUrl(engineUrl, text) {
  return siteUrl(engineUrl) + tomlToHash(text);
}
