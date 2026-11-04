// The flash panel's DOM: the method select with its reason, the connect
// step with instructions, the confirmation, the progress, the log and the
// result or the "what went wrong" box (SPEC 12). It knows nothing about the
// site's session or the embed's config: flash-panel.js (the site) and the
// embed runtime feed it a firmware and read back nothing. The panel owns
// the device flows (pick, enter the bootloader from Klipper, CAN node
// choice, address prompt for a .bin).

import { FlashError, explainError, isCancel, capabilities } from "./errors.js";
import { describe as describeImage, hex8, formatSize, extractKlipperDict, fromBin, parseAddress } from "./firmware-file.js";
import { METHODS, familyFromMcu, defaultSteps } from "./devices.js";
import { connectDevice, connectionFor, flashImage, transportOf, methodAvailable, probeConnection } from "./flash.js";
import { enterFromKlipperUsb, enterFromKlipperSerial, expectedAfterTouch, REENUMERATION_TIMEOUT_MS } from "./bootloader-entry.js";
import { uf2Download } from "./uf2.js";
import { imageForMethod, writesFor, projectName } from "./pair.js";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// What Python's str.strip() and \s take for white space, so the text markup
// splits and trims exactly as webflash's renderer.render_text does.
const PY_SPACE = "\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const STRIP_RE = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, "g");
const CODE_RE = /`([^`\n]+)`/g;
const BOLD_RE = /\*\*([^*\n]+?)\*\*/g;
const LINK_RE = new RegExp(`\\[([^\\]\\n]+)\\]\\(((?:[^()${PY_SPACE}]|\\([^()${PY_SPACE}]*\\))+)\\)`, "g");
const SLOT_RE = /\u0000(\d+)\u0000/g;

const strip = (s) => s.replace(STRIP_RE, "");
const escapeText = (s) => esc(s).replace(/'/g, "&#39;");
// http(s) and relative links only: no javascript:, data: or other schemes, and
// no C0 control or DEL, since a browser drops the leading ones before it reads
// the scheme ("\u0001javascript:" would pass the scheme test and still run).
const safeUrl = (url) => !/[\u0000-\u001f\u007f]/.test(url) && (/^https?:\/\//i.test(url) || !/^[a-z][a-z0-9+.-]*:/i.test(url));

function renderSpans(text) {
  const codes = [];
  let s = text.replace(CODE_RE, (m, code) => {
    codes.push(`<code>${code}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = s.replace(BOLD_RE, "<strong>$1</strong>");
  s = s.replace(LINK_RE, (m, label, url) => (safeUrl(url) ? `<a href="${url}" target="_blank" rel="noopener">${label}</a>` : label));
  s = s.replace(/\n/g, "<br>");
  return s.replace(SLOT_RE, (m, i) => codes[Number(i)]);
}

/**
 * The board TOML's text markup as safe HTML (description, help, labels,
 * instructions), with renderer.render_text's rules: the text is escaped
 * first, then blank lines split paragraphs, **x** is bold, `x` is code,
 * [label](url) a link (http, https and relative URLs only) and a single
 * newline a line break. Change both or neither.
 */
export function renderInline(text) {
  const clean = strip(String(text ?? "").replace(/\u0000/g, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
  if (!clean) return "";
  return clean.split(/\n[ \t]*\n+/).map(strip).filter(Boolean).map((p) => `<p>${renderSpans(escapeText(p))}</p>`).join("");
}

/** Short steps (devices.js's defaultSteps, with the same markup) as a numbered list. */
export function renderSteps(steps) {
  const items = (steps || []).map((s) => strip(String(s).replace(/\u0000/g, ""))).filter(Boolean);
  return items.length ? `<ol class="flash-steps">${items.map((s) => `<li>${renderSpans(escapeText(s))}</li>`).join("")}</ol>` : "";
}

/**
 * A method's name in the select. On a pair (pair.js), a ROM method
 * writes both images and Katapult's methods the firmware alone.
 */
export function methodLabel(m, firmware = null) {
  const base = METHODS[m.id] ? METHODS[m.id].label : m.id;
  if (m.both) return `${base} · flashes both at once`;
  if (m.appOnly) return `${base} · ${projectName(firmware && firmware.project)} only`;
  return base;
}

/**
 * The progress line for a protocol's progress(phase, done, total, unit):
 * bytes as sizes ("Writing: 42% (12.5 KiB of 30 KiB)"), any other unit
 * ("pages", "sectors", "blocks") as a count ("Erasing: 33% (1 of 3 pages)").
 */
export function progressText(phase, done, total, unit = "bytes") {
  const pct = total ? Math.round((done / total) * 100) : 0;
  const label = { erase: "Erasing", write: "Writing", verify: "Verifying" }[phase] || phase;
  const counts = unit === "bytes" ? `${formatSize(done)} of ${formatSize(total)}` : `${done} of ${total} ${total === 1 ? unit.replace(/s$/, "") : unit}`;
  return `${label}: ${pct}% (${counts})`;
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, "");
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  return node;
}

/**
 * Build the panel inside root. options: confirmFlash (default true),
 * compact (the embed), saveFile(bytes, name, mime), nav and win (mocks),
 * title (the card heading; null for none).
 */
export function createFlashPanel(root, options = {}) {
  const opts = { confirmFlash: true, compact: false, title: "Flash", saveFile: defaultSaveFile, nav: null, win: null, ...options };
  const caps = capabilities(opts.nav || undefined, opts.win || undefined);
  const state = {
    firmware: null,       // what setFirmware gave
    method: null,
    bridgeUuid: null,     // a bridge's own CAN UUID, kept for the flash that follows over its USB port
    phase: "idle",        // idle | ready | connecting | connected | flashing | done | failed
    connection: null,
    result: null,
    error: null,
    log: [],
    countdownTimer: null,
    pending: null,        // {firmware}: what setFirmware gave while a device was picked or written
    empty: "",            // why there is no firmware, when setFirmware said
    written: null,        // {phase, done, total} of the running flash, for the write list
  };
  root.innerHTML = "";
  root.classList.add("flash-panel");
  if (opts.compact) root.classList.add("flash-compact");

  // ── Structure ───────────────────────────────────────────────────
  const methodSelect = el("select", { id: "flash-method", title: "How to write the firmware to the board" });
  const head = el("div", { class: "card-head" }, [
    opts.title ? el("h2", { text: opts.title }) : null,
    el("span", { class: "card-spacer" }),
    el("label", { class: "field" }, ["Method ", methodSelect]),
  ]);
  const firmwareLine = el("div", { class: "flash-firmware", id: "flash-firmware" });
  const reasonLine = el("p", { class: "flash-reason", id: "flash-reason" });
  const notice = el("div", { class: "flash-notice", id: "flash-notice", hidden: true });
  const writes = el("ul", { class: "flash-writes", id: "flash-writes", hidden: true, "aria-label": "What gets written" });
  const instructions = el("div", { class: "flash-instructions", id: "flash-instructions" });
  const actions = el("div", { class: "flash-actions", id: "flash-actions" });
  const prompt = el("div", { class: "flash-prompt", id: "flash-prompt", hidden: true });
  const confirmBox = el("div", { class: "flash-confirm", id: "flash-confirm", hidden: true });
  const progressWrap = el("div", { class: "flash-progress-wrap", id: "flash-progress-wrap", hidden: true }, [
    el("div", { class: "flash-phase", id: "flash-phase" }),
    el("progress", { id: "flash-progress", max: "100", value: "0" }),
  ]);
  const result = el("div", { class: "flash-result", id: "flash-result", hidden: true });
  const logPre = el("pre", { class: "log flash-log", id: "flash-log" });
  const logCopy = el("button", { class: "mini", id: "flash-log-copy", title: "Copy the flash log", onclick: (e) => { e.preventDefault(); copyText(state.log.join("\n")); } }, ["Copy"]);
  const logBox = el("details", { class: "log-box", id: "flash-log-box" }, [el("summary", {}, ["Log ", logCopy]), logPre]);
  const help = el("details", { class: "help-box", id: "flash-help" }, [
    el("summary", { text: "Trouble connecting?" }),
    el("div", { class: "flash-help-body", id: "flash-help-body" }),
  ]);
  root.append(head, firmwareLine, reasonLine, notice, writes, instructions, actions, prompt, confirmBox, progressWrap, result, help, logBox);

  // ── Helpers ─────────────────────────────────────────────────────
  function log(text) {
    const stamp = new Date().toLocaleTimeString([], { hour12: false });
    for (const line of String(text).split("\n")) state.log.push(`${stamp} ${line}`);
    logPre.textContent = state.log.join("\n");
    logPre.scrollTop = logPre.scrollHeight;
  }

  function setProgress(phase, done, total, unit = "bytes") {
    progressWrap.hidden = false;
    const pct = total ? Math.round((done / total) * 100) : 0;
    progressWrap.querySelector("#flash-phase").textContent = progressText(phase, done, total, unit);
    progressWrap.querySelector("#flash-progress").value = pct;
    state.written = { phase, done, total };
    renderWrites();
  }

  function setStatus(text) {
    progressWrap.hidden = false;
    progressWrap.querySelector("#flash-phase").textContent = text;
  }

  // While a device is being picked or written, the method and the connection
  // stay as they are: the running protocol holds the device.
  function busy() {
    return state.phase === "connecting" || state.phase === "flashing";
  }

  function currentMethod() {
    return state.firmware && state.firmware.methods.find((m) => m.id === state.method) || null;
  }

  function family() {
    const fw = state.firmware;
    if (!fw) return null;
    const imageFam = fw.image && fw.image.family;
    // Only the RP2 families name a chip; "absolute", "data" and another chip's family name none.
    const imageChip = imageFam === "rp2040" ? "rp2040" : imageFam && imageFam.startsWith("rp2350") ? "rp2350" : null;
    return fw.family || familyFromMcu(fw.mcu) || imageChip;
  }

  // A firmware that talks over a UART: Katapult is reached through a
  // USB-UART adapter, at the firmware's baud.
  function overUart() {
    return Boolean(state.firmware && state.firmware.iface === "serial");
  }

  function baud() {
    return (state.firmware && state.firmware.baud) || 250000;
  }

  // Whether the firmware may run Klipper on a USB serial port, which the ROM
  // methods' restart (the 1200-baud touch) needs. A UART or CAN build has
  // none, and neither has a USB to CAN bridge, which is a gs_usb device; an
  // unknown interface keeps the restart.
  function klipperOnUsbSerial() {
    const iface = state.firmware && state.firmware.iface;
    return iface !== "serial" && iface !== "can" && iface !== "usbcan";
  }

  function button(label, handler, { primary = false, title = "", id = null } = {}) {
    return el("button", { class: primary ? "primary" : "", title, id, onclick: (e) => { e.preventDefault(); handler().catch(showFailure); } }, [label]);
  }

  // ── Rendering ───────────────────────────────────────────────────
  function renderMethods() {
    const fw = state.firmware;
    methodSelect.innerHTML = "";
    if (!fw) {
      methodSelect.appendChild(el("option", { value: "download", text: "Download" }));
      methodSelect.disabled = true;
      return;
    }
    methodSelect.disabled = busy();
    for (const m of fw.methods) {
      const avail = methodAvailable(m.id, caps);
      const label = methodLabel(m, fw);
      methodSelect.appendChild(el("option", { value: m.id, text: avail.ok ? label : `${label} (not here)` }));
    }
    if (!fw.methods.some((m) => m.id === state.method)) {
      const first = fw.methods.find((m) => methodAvailable(m.id, caps).ok) || fw.methods[0];
      state.method = first ? first.id : "download";
    }
    methodSelect.value = state.method;
  }

  function renderFirmware() {
    const fw = state.firmware;
    if (!fw) {
      firmwareLine.innerHTML = state.empty ? `<span class="flash-warn">${esc(state.empty)}</span>`
        : `<span class="flash-muted">Build first, or use <strong>Upload firmware</strong> to flash a file you have.</span>`;
      reasonLine.textContent = "";
      return;
    }
    const d = describeImage(fw.image);
    const bits = [];
    bits.push(`<strong>${esc(fw.label || fw.image.name || "firmware")}</strong>`);
    // A pair's write list gives the addresses.
    if (!fw.parts) bits.push(esc(d.rangeText));
    if (fw.mcu) bits.push(`MCU ${esc(fw.mcu)}`);
    if (fw.version) bits.push(`version ${esc(fw.version)}`);
    if (d.familyLabel) bits.push(esc(d.familyLabel));
    bits.push(`<span class="flash-muted">${esc(fw.source === "build" ? "from this build" : fw.source === "prebuilt" ? "the board TOML's prebuilt file" : "uploaded")}</span>`);
    firmwareLine.innerHTML = bits.join(" · ");
    if (fw.onClear) {
      const clear = el("button", { class: "mini", title: "Forget the uploaded file", onclick: (e) => { e.preventDefault(); fw.onClear(); } }, ["Forget"]);
      firmwareLine.appendChild(document.createTextNode(" "));
      firmwareLine.appendChild(clear);
    }
    const m = currentMethod();
    reasonLine.textContent = m ? `Why ${METHODS[m.id] ? METHODS[m.id].short : m.id}: ${m.reason}.` : "";
    if (fw.warnings && fw.warnings.length) {
      reasonLine.textContent += ` ${fw.warnings.join(" ")}`;
    }
  }

  function renderStep() {
    const fw = state.firmware;
    actions.innerHTML = "";
    instructions.innerHTML = "";
    notice.hidden = true;
    prompt.hidden = true;
    renderWrites();
    renderHelp();
    if (!fw) {
      instructions.innerHTML = `<p class="flash-muted">Pick a method once a firmware is built or uploaded.</p>`;
      return;
    }
    const method = state.method;
    const avail = methodAvailable(method, caps);
    const fam = family();
    if (!avail.ok) {
      notice.hidden = false;
      notice.innerHTML = `<p><strong>${esc(METHODS[method] ? METHODS[method].short : method)}</strong> ${esc(avail.reason)}. ` +
        `${caps.browser === "firefox" || caps.browser === "safari" ? "Download the files and flash them with Chrome or Edge, or your usual tools." : "Download the files instead."}</p>`;
      renderDownloads(actions, fw);
      return;
    }
    const m = currentMethod();
    if (m && m.appOnly) {
      // A pair over Katapult: only the firmware goes, onto the Katapult already there.
      const rom = fw.methods.find((x) => x.both);
      notice.hidden = false;
      notice.innerHTML = `<p>Katapult has to be on the board already.${rom ? ` Flash it once with ${esc(METHODS[rom.id] ? METHODS[rom.id].short : rom.id)}.` : ""}</p>`;
    }
    if (method === "download") {
      instructions.innerHTML = stepsHtml("download", fam);
      renderDownloads(actions, fw);
      return;
    }
    instructions.innerHTML = stepsHtml(method, fam, { fromKlipper: caps.serial, serial: overUart(), baud: baud() });

    if (state.phase === "connecting" || state.phase === "flashing") {
      actions.appendChild(el("span", { class: "flash-muted", text: state.phase === "connecting" ? "Waiting for the device…" : "Flashing…" }));
      return;
    }
    const transport = transportOf(method);
    if (transport === "serial" && overUart()) {
      // The adapter's port has no Katapult id, so every port is listed; the
      // restart is Klipper's serial bootloader request, not the USB touch.
      actions.appendChild(button("Connect", () => connectAndConfirm("any"), { primary: true, title: "Pick the USB-UART adapter's port in the browser's device list", id: "flash-connect" }));
      actions.appendChild(button("Restart Klipper into Katapult", () => enterFromKlipper(), { title: `Pick the USB-UART adapter's port; WebFlash sends Klipper's serial bootloader request at ${baud()} baud`, id: "flash-from-klipper" }));
    } else if (transport === "serial") {
      actions.appendChild(button("Connect", () => connectAndConfirm("katapult"), { primary: true, title: "Pick the Katapult port in the browser's device list", id: "flash-connect" }));
      actions.appendChild(button("Any serial port", () => connectAndConfirm("any"), { title: "For a USB-UART adapter wired to a board in Katapult's UART mode" }));
      actions.appendChild(button("Restart Klipper into Katapult", () => enterFromKlipper(), { title: "Pick the Klipper port; WebFlash asks it to restart into its bootloader", id: "flash-from-klipper" }));
    } else if (transport === "usb") {
      actions.appendChild(button("Connect", () => connectAndConfirm(), { primary: true, title: `Pick ${expectedAfterTouch(method).label || "the device"} in the browser's device list`, id: "flash-connect" }));
      if (caps.serial && (method === "dfu" || method === "picoboot") && klipperOnUsbSerial()) {
        actions.appendChild(button("Restart Klipper into the bootloader", () => enterFromKlipper(), { title: "Pick the Klipper port; WebFlash asks it to restart into its bootloader", id: "flash-from-klipper" }));
      }
    } else if (transport === "filesystem") {
      actions.appendChild(button("Pick the drive", () => connectAndConfirm(), { primary: true, title: "Pick the BOOTSEL drive (RPI-RP2 or RP2350) in the browser's folder picker", id: "flash-connect" }));
      actions.appendChild(button("Download .uf2", () => downloadUf2(), { title: "Save the .uf2 and copy it onto the drive yourself" }));
    }
  }

  // The method's instructions: the board TOML's own text, else short numbered steps.
  function stepsHtml(method, fam, options = {}) {
    const own = state.firmware && state.firmware.instructions;
    if (own && typeof own === "object" && typeof own[method] === "string" && own[method].trim()) return renderInline(own[method]);
    return renderSteps(defaultSteps(method, fam, options));
  }

  // What the method writes, one row per image (Katapult and the firmware for
  // a pair), each checked off as the running flash gets past it.
  function renderWrites() {
    const fw = state.firmware;
    const method = state.method;
    const rows = fw && method !== "download" && methodAvailable(method, caps).ok ? writesFor(fw, method) : [];
    writes.hidden = !rows.length;
    if (!rows.length) {
      writes.replaceChildren();
      return;
    }
    const total = rows.reduce((n, r) => n + r.size, 0) || 1;
    const w = state.written;
    // How far the flash is, as a fraction of the bytes: rows are written in
    // address order and read back in the same order.
    const at = state.phase === "done" ? 1 : state.phase === "flashing" && w && w.total ? w.done / w.total : 0;
    let before = 0;
    const items = [];
    const m = currentMethod();
    if (m && m.appOnly) {
      items.push(`<li class="flash-write skip"><span class="fw-icon" aria-hidden="true">–</span><span class="fw-name">Katapult</span><span class="fw-addr">already on the board</span></li>`);
    }
    rows.forEach((r, i) => {
      const start = before / total;
      before += r.size;
      const end = before / total;
      let icon = String(i + 1);
      let cls = "";
      // A row is checked once its bytes are written (the read-back that
      // follows covers them all); the row being erased or written spins.
      const written = w && w.phase === "write" ? at : w && w.phase === "verify" ? 1 : 0;
      if (state.phase === "done") { icon = "✓"; cls = "ok"; }
      else if (state.phase === "flashing" && w) {
        if (written >= end - 1e-9) { icon = "✓"; cls = "ok"; }
        else if (w.phase === "erase" ? i === 0 : written >= start - 1e-9) cls = "run";
      } else if (state.phase === "failed" && w && at >= start && at < end) { icon = "✗"; cls = "bad"; }
      items.push(`<li class="flash-write ${cls}"><span class="fw-icon" aria-hidden="true">${cls === "run" ? `<span class="spinner"></span>` : esc(icon)}</span>` +
        `<span class="fw-name">${esc(r.title)}</span><span class="fw-addr">${esc(hex8(r.address))} · ${esc(formatSize(r.size))}</span></li>`);
    });
    writes.innerHTML = items.join("");
  }

  // The folded help: the method's needs until a step fails, then the fixes.
  function renderHelp() {
    if (state.error) return;
    const body = help.querySelector("#flash-help-body");
    const method = state.method;
    const needs = METHODS[method] && METHODS[method].needs;
    const tips = [needs, method === "download" ? "" : "Board not listed? Put it in its bootloader again, plugged in directly (not through a hub)."].filter(Boolean);
    body.innerHTML = tips.map((t) => `<p>${esc(t)}</p>`).join("") || "<p>The fixes for a failed step appear here.</p>";
  }

  function renderDownloads(container, fw) {
    const listed = fw.artifacts && fw.artifacts.length ? fw.artifacts : [{ name: fw.image.name || "firmware.bin", bytes: null }];
    // The files the panel would flash come first, the first as the primary
    // button: the build lists its outputs in the engine's order, the .elf
    // before the .bin. A pair's are katapult.bin, then the firmware's.
    const flashed = fw.parts ? fw.parts.map((p) => p.name) : [fw.image.name];
    const files = [...flashed.map((n) => listed.find((f) => f.name === n)).filter(Boolean), ...listed.filter((f) => !flashed.includes(f.name))];
    for (const f of files) {
      container.appendChild(button(`Download ${f.label || f.name} (${formatSize(f.bytes ? f.bytes.length : fw.image.size)})`, async () => {
        const bytes = f.bytes || (await rawBytes(fw));
        opts.saveFile(bytes, f.saveAs || f.name, "application/octet-stream");
      }, { primary: files[0] === f }));
    }
    const fam = family();
    if ((fam === "rp2040" || fam === "rp2350") && !files.some((f) => /\.uf2$/i.test(f.name))) {
      container.appendChild(button("Download .uf2", () => downloadUf2()));
    }
  }

  async function rawBytes(fw) {
    if (fw.image.format === "uf2" && fw.image.raw) return fw.image.raw;
    const { flatten } = await import("./firmware-file.js");
    return flatten(fw.image);
  }

  async function downloadUf2() {
    const fw = state.firmware;
    const fam = fw.image.family || (family() === "rp2350" ? "rp2350-arm-s" : "rp2040");
    const dl = uf2Download(fw.image, { family: fam });
    opts.saveFile(dl.bytes, dl.name, "application/octet-stream");
    log(`Saved ${dl.name} (${formatSize(dl.bytes.length)}, family ${fam})`);
  }

  function renderConfirm() {
    const fw = state.firmware;
    const c = state.phase === "connected" ? state.connection : null;
    confirmBox.hidden = !c;
    if (!c) return;
    const d = describeImage(imageForMethod(fw, state.method));
    const bits = [c.describe()];
    if (c.uuid) bits.push(`CAN node ${c.uuid}`);
    if (fw.mcu) bits.push(`firmware for ${fw.mcu}`);
    confirmBox.innerHTML = `<p class="flash-device" title="${esc(`Writes ${d.rangeText}, ${formatSize(d.size)}`)}"><span class="flash-dot" aria-hidden="true"></span>${esc(bits.join(" · "))}</p>` +
      `<p class="flash-muted">${esc(state.method === "uf2" ? "The board restarts by itself once the file is on the drive." : "Nothing is written until you click Flash; it is read back afterwards.")}</p>`;
    const names = writesFor(fw, state.method).map((r) => r.title);
    const row = el("div", { class: "flash-actions" });
    row.appendChild(button(`Flash ${names.join(" and ") || "the firmware"}`, () => doFlash(), { primary: true, id: "flash-write", title: "Write and verify" }));
    row.appendChild(button("Cancel", async () => { await dropConnection(); }, { id: "flash-cancel" }));
    confirmBox.appendChild(row);
  }

  function renderAll() {
    renderMethods();
    renderFirmware();
    renderStep();
    renderConfirm();
  }

  // ── Flows ───────────────────────────────────────────────────────
  // Forget state.connection and close its device: probeConnection opened and
  // claimed it, and a device left open blocks other tabs and programs until
  // the page closes. A running flash closes its own device when it ends, so
  // its device is only forgotten here, never closed under the protocol.
  async function closeConnection() {
    const c = state.connection;
    state.connection = null;
    if (!c || state.phase === "flashing") return;
    if (c.kind === "usb" || c.kind === "serial") { try { await c.device.close(); } catch (e) { /* fine */ } }
  }

  async function dropConnection() {
    if (state.phase === "flashing") return;
    await closeConnection();
    state.phase = "ready";
    renderAll();
  }

  async function connectAndConfirm(serialScope = "katapult") {
    result.hidden = true;
    await closeConnection();
    state.phase = "connecting";
    renderAll();
    let connection;
    try {
      connection = await connectDevice(state.method, { nav: opts.nav || undefined, win: opts.win || undefined, serialScope });
    } catch (e) {
      state.phase = "ready";
      if (!applyPending()) renderAll();
      if (isCancel(e)) { log("No device was picked."); return; }
      throw e;
    }
    await adoptConnection(connection);
  }

  async function adoptConnection(connection) {
    if (state.connection && state.connection !== connection) await closeConnection();
    state.connection = connection;
    log(`Connected: ${connection.describe()}`);
    if (connection.kind === "usb" || connection.kind === "filesystem") {
      // Opening and claiming now surfaces driver and permission problems
      // (and a device that is not in its bootloader) before the confirmation;
      // a drive is read for its INFO_UF2.TXT, so the confirmation names the
      // board, not a folder name (Chrome on Windows calls a drive root "\").
      try {
        await probeConnection(connection);
        if (connection.kind === "filesystem") log(`Drive: ${connection.describe()}`);
      } catch (e) {
        state.connection = null;
        state.phase = "ready";
        try { if (connection.device && typeof connection.device.close === "function") await connection.device.close(); } catch (e2) { /* fine */ }
        if (!applyPending()) renderAll();
        throw e;
      }
    }
    state.phase = "connected";
    // A firmware that arrived meanwhile is not what the user connected for:
    // it takes over and the device is released, to be connected again.
    if (applyPending()) return;
    if (!opts.confirmFlash) {
      renderAll();
      await doFlash();
      return;
    }
    renderAll();
  }

  async function enterFromKlipper() {
    result.hidden = true;
    await closeConnection();
    state.phase = "connecting";
    renderAll();
    const method = state.method;
    if (method === "katapult" && overUart()) {
      // Katapult answers on the adapter's port once the board has restarted,
      // so that port is the connection: nothing re-enumerates.
      let link;
      try {
        setStatus("Asking Klipper to restart into Katapult");
        ({ device: link } = await enterFromKlipperSerial({ nav: opts.nav || undefined, log, baud: baud() }));
      } catch (e) {
        state.phase = "ready";
        progressWrap.hidden = true;
        if (!applyPending()) renderAll();
        if (isCancel(e)) { log("No serial port was picked."); return; }
        throw e;
      }
      progressWrap.hidden = true;
      await adoptConnection(connectionFor(method, link));
      return;
    }
    let outcome;
    try {
      outcome = await enterFromKlipperUsb(method, {
        nav: opts.nav || undefined, log,
        onTick: (ms) => setStatus(`The board is restarting into its bootloader; waiting for ${expectedAfterTouch(method).label} (${Math.ceil(ms / 1000)} s)`),
      });
    } catch (e) {
      state.phase = "ready";
      if (!applyPending()) renderAll();
      progressWrap.hidden = true;
      if (isCancel(e)) { log("No Klipper port was picked."); return; }
      throw e;
    }
    progressWrap.hidden = true;
    if (outcome.device) {
      const found = outcome.expect.label;
      log(`${found.charAt(0).toUpperCase()}${found.slice(1)} appeared`);
      await adoptConnection(connectionFor(method, outcome.device));
      return;
    }
    state.phase = "ready";
    if (!applyPending()) renderAll();
    const label = outcome.expect.label || "the device";
    showPrompt(`The board is restarting as ${label}: pick it once.`, [
      button(`Pick ${label}`, () => connectAndConfirm(), { primary: true }),
    ]);
  }

  function showPrompt(text, buttons) {
    prompt.hidden = false;
    prompt.innerHTML = "";
    prompt.appendChild(el("p", { text }));
    const row = el("div", { class: "flash-actions" });
    for (const b of buttons) row.appendChild(b);
    prompt.appendChild(row);
  }

  /** The CAN node choice: a list with radio buttons; resolves with the UUID or null. */
  function pickNode(nodes) {
    return new Promise((resolve) => {
      prompt.hidden = false;
      prompt.innerHTML = "";
      prompt.appendChild(el("p", { text: `${nodes.length} node${nodes.length === 1 ? "" : "s"} answered on the bus. Pick the one to flash:` }));
      const list = el("div", { class: "flash-nodes" });
      nodes.forEach((n, i) => {
        const input = el("input", { type: "radio", name: "flash-node", value: n.uuidHex, id: `flash-node-${i}` });
        if (i === 0) input.checked = true;
        list.appendChild(el("label", { class: "flash-node" }, [input, ` ${n.uuidHex} `, el("span", { class: "flash-muted", text: `(${n.app}${n.app === "Klipper" ? ", will be restarted into Katapult" : ""})` })]));
      });
      prompt.appendChild(list);
      const row = el("div", { class: "flash-actions" });
      row.appendChild(el("button", { class: "primary", onclick: (e) => { e.preventDefault(); const chosen = prompt.querySelector("input[name=flash-node]:checked"); prompt.hidden = true; resolve(chosen ? chosen.value : null); } }, ["Use this node"]));
      row.appendChild(el("button", { onclick: (e) => { e.preventDefault(); prompt.hidden = true; resolve(null); } }, ["Cancel"]));
      prompt.appendChild(row);
    });
  }

  async function doFlash() {
    const fw = state.firmware;
    const connection = state.connection;
    if (!fw || !connection) return;
    state.phase = "flashing";
    state.error = null;
    state.written = null;
    result.hidden = true;
    confirmBox.hidden = true;
    renderMethods();
    renderStep();
    setStatus("Starting");
    const method = state.method;
    // Katapult's methods write a pair's firmware alone; the ROM methods both images.
    const image = imageForMethod(fw, method);
    // A CAN node that turned out to be the bridge itself continues over USB
    // serial; its UUID from the bus goes into that flash's printer.cfg hint.
    const bridgeUuid = state.bridgeUuid;
    state.bridgeUuid = null;
    try {
      const r = await flashImage(method, image, {
        connection, mcu: fw.mcu || null, project: fw.project || "klipper", uuid: fw.uuid || bridgeUuid || null, iface: fw.iface || null,
        baud: fw.baud || 250000, bitrate: fw.bitrate || 1000000, family: image.family || (family() === "rp2350" ? "rp2350-arm-s" : family() === "rp2040" ? "rp2040" : null),
        fileName: image.name ? image.name.replace(/\.(bin|elf|hex|uf2)$/i, "") + ".uf2" : null,
      }, { log, progress: setProgress, status: setStatus, pickNode });
      state.result = r;
      state.phase = "done";
      state.connection = null;
      progressWrap.hidden = true;
      showSuccess(r);
    } catch (e) {
      state.phase = "failed";
      state.connection = null;
      progressWrap.hidden = true;
      showFailure(e, method);
    } finally {
      if (connection.kind === "usb" || connection.kind === "serial") { try { await connection.device.close(); } catch (e) { /* gone */ } }
      // A firmware that arrived during the flash replaces the one flashed, and
      // the result box keeps saying how the flash went.
      if (!applyPending({ keepResult: true })) renderAll();
    }
  }

  function showSuccess(r) {
    result.hidden = false;
    result.className = "flash-result ok";
    const parts = [];
    if (r.reenumerated) {
      parts.push(`<p><strong>The bridge is restarting into Katapult.</strong> Connect again to finish: the method is now Katapult.</p>`);
    } else if (r.method === "uf2") {
      parts.push(`<p><strong>${r.disappeared ? "✓ The board took the file and restarted." : "✓ The .uf2 was written."}</strong> ${r.disappeared ? "" : "Eject the drive if it is still there in a few seconds."}</p>`);
    } else {
      const device = r.deviceText ? `${r.deviceText}${/[.!?]$/.test(r.deviceText) ? "" : "."}` : "";
      parts.push(`<p><strong>✓ Flashed and verified.</strong> ${esc(device)}${r.restarted ? " The board has restarted." : ""}</p>`);
    }
    if (r.hint) {
      // What the hint does not know, it says in a # line of its own.
      parts.push(`<p class="flash-muted">Add this to printer.cfg:</p><pre class="flash-hint">${esc(r.hint)}</pre>`);
    }
    result.innerHTML = parts.join("");
    if (r.hint) result.appendChild(el("button", { class: "mini", onclick: (e) => { e.preventDefault(); copyText(r.hint); } }, ["Copy"]));
    if (r.reenumerated && r.nextMethod && state.firmware.methods.some((m) => m.id === r.nextMethod)) {
      state.method = r.nextMethod;
      state.bridgeUuid = r.uuid || null;
    }
    help.open = false;
  }

  /** Explain an error; method is the one the failed step ran with (a flash's own, not the select's). */
  function showFailure(e, method = state.method) {
    if (isCancel(e)) { log("Cancelled."); renderAll(); return; }
    const ex = explainError(e, { method, os: caps.os, browser: caps.browser });
    state.error = ex;
    log(`Error: ${ex.message}`);
    result.hidden = false;
    result.className = "flash-result error";
    result.innerHTML = `<p><strong>${esc(ex.title)}</strong></p><p>${esc(ex.message)}</p>` +
      (ex.fixes.length ? `<p class="flash-muted">The fixes are under "Trouble connecting?".</p>` : "");
    const body = help.querySelector("#flash-help-body");
    body.innerHTML = `<p><strong>${esc(ex.title)}</strong> (${esc(ex.code)})</p>` +
      (ex.fixes.length ? `<ol class="flash-fixes">${ex.fixes.map((f) => `<li>${esc(f)}</li>`).join("")}</ol>` : "<p>No known fix: the log has the details.</p>");
    help.open = true;
    if (state.phase !== "flashing") state.phase = state.firmware ? "ready" : "idle";
    renderAll();
  }

  // ── Firmware ────────────────────────────────────────────────────
  function applyFirmware(firmware, { keepResult = false } = {}) {
    const dropped = state.connection;
    state.firmware = firmware || null;
    closeConnection();
    if (!keepResult || !firmware) state.phase = firmware ? "ready" : "idle";
    if (!keepResult) {
      result.hidden = true;
      state.error = null;
      state.written = null;
    }
    if (firmware && firmware.preferredMethod && firmware.methods.some((m) => m.id === firmware.preferredMethod)) state.method = firmware.preferredMethod;
    renderAll();
    if (dropped) log("The firmware changed, so the device was released: connect again to flash the new one.");
    if (firmware) {
      const d = describeImage(firmware.image);
      log(`Firmware: ${firmware.label || firmware.image.name || "image"}, ${d.rangeText}${firmware.mcu ? `, MCU ${firmware.mcu}` : ""}; methods: ${firmware.methods.map((m) => m.id).join(", ")}`);
    }
  }

  /** Apply a firmware that setFirmware put off; false when there is none. */
  function applyPending(options) {
    if (!state.pending) return false;
    const { firmware } = state.pending;
    state.pending = null;
    applyFirmware(firmware, options);
    return true;
  }

  // ── Events ──────────────────────────────────────────────────────
  methodSelect.addEventListener("change", async () => {
    if (busy()) { methodSelect.value = state.method; return; }
    state.method = methodSelect.value;
    result.hidden = true;
    state.error = null;
    await dropConnection();
    log(`Method: ${METHODS[state.method] ? METHODS[state.method].label : state.method}`);
  });

  // ── Public API ──────────────────────────────────────────────────
  const api = {
    element: root,
    log,
    /**
     * A firmware to flash: {image, methods: [{id, reason}], warnings, instructions, mcu, project, family, artifacts, source, version, label, uuid, baud, bitrate, onClear}.
     * While a device is being picked or written, the card keeps showing that
     * and the firmware is applied once it ends (the last one given wins).
     */
    setFirmware(firmware, { empty = "" } = {}) {
      state.empty = firmware ? "" : empty;
      if (busy()) { state.pending = { firmware: firmware || null }; return; }
      state.pending = null;
      applyFirmware(firmware);
    },
    get method() { return state.method; },
    set method(id) { if (busy()) return; state.method = id; renderAll(); },
    get state() { return state; },
    capabilities: caps,
    /**
     * Ask for a flash address for a .bin: an inline form; resolves with a
     * number or null. While a device is being picked or written it refuses
     * instead: the form would take the place of the CAN node list, which the
     * running flash waits on.
     */
    askAddress(defaultAddress, { name = "the file" } = {}) {
      if (busy()) {
        return Promise.reject(new FlashError("A flash is running; upload the file again once it has ended.", { code: "busy", fix: "Wait for the flash to end, then upload the file again." }));
      }
      return new Promise((resolve) => {
        prompt.hidden = false;
        prompt.innerHTML = "";
        const input = el("input", { type: "text", id: "flash-address", value: defaultAddress !== null && defaultAddress !== undefined ? hex8(defaultAddress) : "0x08000000", spellcheck: "false" });
        prompt.appendChild(el("p", { text: `${name} is a raw .bin with no address. Where does it go (hex)? STM32: 0x08000000, or 0x08002000 after an 8 KiB Katapult. RP2040: 0x10000100, or 0x10004000 after Katapult.` }));
        const row = el("div", { class: "flash-actions" }, [
          el("label", { class: "field" }, ["Address ", input]),
          el("button", { class: "primary", onclick: (e) => {
            e.preventDefault();
            const n = parseAddress(input.value);
            if (n === null) { input.classList.add("bad"); return; }
            prompt.hidden = true;
            resolve(n);
          } }, ["Use this address"]),
          el("button", { onclick: (e) => { e.preventDefault(); prompt.hidden = true; resolve(null); } }, ["Cancel"]),
        ]);
        prompt.appendChild(row);
        input.focus();
      });
    },
  };
  renderAll();
  return api;
}

function defaultSaveFile(data, name, mime) {
  const blob = new Blob([data], { type: mime || "application/octet-stream" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 0);
}

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).catch(() => {});
}

export { extractKlipperDict, fromBin };
