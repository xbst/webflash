// The flash panel's DOM: the method select with its reason, the connect
// step with instructions, the confirmation, the progress, the log and the
// result or the "what went wrong" box (SPEC 12). It knows nothing about the
// site's session or the embed's config: flash-panel.js (the site) and the
// embed runtime feed it a firmware and read back nothing. The panel owns
// the device flows (pick, enter the bootloader from Klipper, CAN node
// choice, address prompt for a .bin).

import { FlashError, explainError, isCancel, capabilities } from "./errors.js";
import { describe as describeImage, hex8, formatSize, extractKlipperDict, fromBin } from "./firmware-file.js";
import { METHODS, familyFromMcu } from "./devices.js";
import { connectDevice, connectionFor, flashImage, transportOf, methodAvailable, probeConnection } from "./flash.js";
import { enterFromKlipperUsb, manualInstructions, expectedAfterTouch, REENUMERATION_TIMEOUT_MS } from "./bootloader-entry.js";
import { uf2Download } from "./uf2.js";

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
// http(s) and relative links only: no javascript:, data: or other schemes.
const safeUrl = (url) => /^https?:\/\//i.test(url) || !/^[a-z][a-z0-9+.-]*:/i.test(url);

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
    el("summary", { text: "What went wrong?" }),
    el("div", { class: "flash-help-body", id: "flash-help-body", html: "<p>When a step fails, the likely causes and their fixes appear here: drivers on Windows, permissions on Linux, a board that is not in its bootloader.</p>" }),
  ]);
  root.append(head, firmwareLine, reasonLine, notice, instructions, actions, prompt, confirmBox, progressWrap, result, logBox, help);

  // ── Helpers ─────────────────────────────────────────────────────
  function log(text) {
    const stamp = new Date().toLocaleTimeString([], { hour12: false });
    for (const line of String(text).split("\n")) state.log.push(`${stamp} ${line}`);
    logPre.textContent = state.log.join("\n");
    logPre.scrollTop = logPre.scrollHeight;
  }

  function setProgress(phase, done, total) {
    progressWrap.hidden = false;
    const pct = total ? Math.round((done / total) * 100) : 0;
    const label = { erase: "Erasing", write: "Writing", verify: "Verifying" }[phase] || phase;
    document.getElementById("flash-phase") && (progressWrap.querySelector("#flash-phase").textContent = `${label}: ${pct}% (${formatSize(done)} of ${formatSize(total)})`);
    progressWrap.querySelector("#flash-progress").value = pct;
  }

  function setStatus(text) {
    progressWrap.hidden = false;
    progressWrap.querySelector("#flash-phase").textContent = text;
  }

  function currentMethod() {
    return state.firmware && state.firmware.methods.find((m) => m.id === state.method) || null;
  }

  function family() {
    const fw = state.firmware;
    if (!fw) return null;
    return fw.family || familyFromMcu(fw.mcu) || (fw.image && fw.image.family ? (fw.image.family.startsWith("rp2350") ? "rp2350" : "rp2040") : null);
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
    methodSelect.disabled = false;
    for (const m of fw.methods) {
      const avail = methodAvailable(m.id, caps);
      const label = METHODS[m.id] ? METHODS[m.id].label : m.id;
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
      firmwareLine.innerHTML = `<span class="flash-muted">Build the firmware, or use <strong>Upload firmware</strong> in the toolbar to flash a file you already have.</span>`;
      reasonLine.textContent = "";
      return;
    }
    const d = describeImage(fw.image);
    const bits = [];
    bits.push(`<strong>${esc(fw.label || fw.image.name || "firmware")}</strong>`);
    bits.push(esc(d.rangeText));
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
        `${caps.browser === "firefox" || caps.browser === "safari" ? "Firefox and Safari cannot flash from a page: download the files below and flash them with Chrome or Edge, or with the usual tools." : "Download the files below instead."}</p>`;
      renderDownloads(actions, fw);
      return;
    }
    if (method === "download") {
      instructions.innerHTML = renderInline(manualInstructions("download", fam, fw.instructions));
      renderDownloads(actions, fw);
      return;
    }
    instructions.innerHTML = renderInline(manualInstructions(method, fam, fw.instructions, { fromKlipper: caps.serial }));
    const needs = METHODS[method] && METHODS[method].needs;
    if (needs) instructions.appendChild(el("p", { class: "flash-needs", text: needs }));

    if (state.phase === "connecting" || state.phase === "flashing") {
      actions.appendChild(el("span", { class: "flash-muted", text: state.phase === "connecting" ? "Waiting for the device…" : "Flashing…" }));
      return;
    }
    const transport = transportOf(method);
    if (transport === "serial") {
      actions.appendChild(button("Connect", () => connectAndConfirm("katapult"), { primary: true, title: "Pick the Katapult port in the browser's device list", id: "flash-connect" }));
      actions.appendChild(button("Any serial port", () => connectAndConfirm("any"), { title: "For a USB-UART adapter wired to a board in Katapult's UART mode" }));
      actions.appendChild(button("Restart Klipper into Katapult", () => enterFromKlipper(), { title: "Pick the Klipper port; WebFlash asks it to restart into its bootloader", id: "flash-from-klipper" }));
    } else if (transport === "usb") {
      actions.appendChild(button("Connect", () => connectAndConfirm(), { primary: true, title: `Pick ${expectedAfterTouch(method).label || "the device"} in the browser's device list`, id: "flash-connect" }));
      if (caps.serial && (method === "dfu" || method === "picoboot")) {
        actions.appendChild(button("Restart Klipper into the bootloader", () => enterFromKlipper(), { title: "Pick the Klipper port; WebFlash asks it to restart into its bootloader", id: "flash-from-klipper" }));
      }
    } else if (transport === "filesystem") {
      actions.appendChild(button("Pick the drive", () => connectAndConfirm(), { primary: true, title: "Pick the BOOTSEL drive (RPI-RP2 or RP2350) in the browser's folder picker", id: "flash-connect" }));
      actions.appendChild(button("Download .uf2", () => downloadUf2(), { title: "Save the .uf2 and copy it onto the drive yourself" }));
    }
  }

  function renderDownloads(container, fw) {
    const files = fw.artifacts && fw.artifacts.length ? fw.artifacts : [{ name: fw.image.name || "firmware.bin", bytes: null }];
    for (const f of files) {
      container.appendChild(button(`Download ${f.name} (${formatSize(f.bytes ? f.bytes.length : fw.image.size)})`, async () => {
        const bytes = f.bytes || (await rawBytes(fw));
        opts.saveFile(bytes, f.name, "application/octet-stream");
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
    const c = state.connection;
    confirmBox.hidden = !c;
    if (!c) return;
    const d = describeImage(fw.image);
    const rows = [
      ["Device", c.describe()],
      ["Method", METHODS[state.method] ? METHODS[state.method].label : state.method],
      ["Writes", d.rangeText],
      ["Size", formatSize(d.size)],
    ];
    if (fw.mcu) rows.push(["Firmware MCU", fw.mcu]);
    if (c.uuid) rows.push(["CAN node", c.uuid]);
    confirmBox.innerHTML = `<table class="flash-table">${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}</table>` +
      `<p class="flash-muted">${esc(state.method === "uf2" ? "The .uf2 is written onto the drive; the board restarts by itself." : "Nothing is written until you click Flash. The flash is read back afterwards.")}</p>`;
    const row = el("div", { class: "flash-actions" });
    row.appendChild(button("Flash", () => doFlash(), { primary: true, id: "flash-write", title: "Write and verify the firmware" }));
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
  async function dropConnection() {
    const c = state.connection;
    state.connection = null;
    if (c && c.kind === "usb") { try { await c.device.close(); } catch (e) { /* fine */ } }
    if (c && c.kind === "serial") { try { await c.device.close(); } catch (e) { /* fine */ } }
    state.phase = "ready";
    renderAll();
  }

  async function connectAndConfirm(serialScope = "katapult") {
    result.hidden = true;
    state.phase = "connecting";
    renderStep();
    let connection;
    try {
      connection = await connectDevice(state.method, { nav: opts.nav || undefined, win: opts.win || undefined, serialScope });
    } catch (e) {
      state.phase = "ready";
      renderStep();
      if (isCancel(e)) { log("No device was picked."); return; }
      throw e;
    }
    await adoptConnection(connection);
  }

  async function adoptConnection(connection) {
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
        renderStep();
        throw e;
      }
    }
    state.phase = "connected";
    if (!opts.confirmFlash) {
      renderAll();
      await doFlash();
      return;
    }
    renderAll();
  }

  async function enterFromKlipper() {
    result.hidden = true;
    state.phase = "connecting";
    renderStep();
    const method = state.method;
    let outcome;
    try {
      outcome = await enterFromKlipperUsb(method, {
        nav: opts.nav || undefined, log,
        onTick: (ms) => setStatus(`The board is restarting into its bootloader; waiting for ${expectedAfterTouch(method).label} (${Math.ceil(ms / 1000)} s)`),
      });
    } catch (e) {
      state.phase = "ready";
      renderStep();
      progressWrap.hidden = true;
      if (isCancel(e)) { log("No Klipper port was picked."); return; }
      throw e;
    }
    progressWrap.hidden = true;
    if (outcome.device) {
      log(`${outcome.expect.label} appeared`);
      await adoptConnection(connectionFor(method, outcome.device));
      return;
    }
    state.phase = "ready";
    renderStep();
    const label = outcome.expect.label || "the device";
    showPrompt(`The touch was sent. The board should now show up as ${label}; the browser needs you to pick it once.`, [
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
    result.hidden = true;
    confirmBox.hidden = true;
    renderStep();
    setStatus("Starting");
    const method = state.method;
    // A CAN node that turned out to be the bridge itself continues over USB
    // serial; its UUID from the bus goes into that flash's printer.cfg hint.
    const bridgeUuid = state.bridgeUuid;
    state.bridgeUuid = null;
    try {
      const r = await flashImage(method, fw.image, {
        connection, mcu: fw.mcu || null, project: fw.project || "klipper", uuid: fw.uuid || bridgeUuid || null, iface: fw.iface || null,
        baud: fw.baud || 250000, bitrate: fw.bitrate || 1000000, family: fw.image.family || (family() === "rp2350" ? "rp2350-arm-s" : family() === "rp2040" ? "rp2040" : null),
        fileName: fw.image.name ? fw.image.name.replace(/\.(bin|elf|hex|uf2)$/i, "") + ".uf2" : null,
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
      showFailure(e);
    } finally {
      if (connection.kind === "usb" || connection.kind === "serial") { try { await connection.device.close(); } catch (e) { /* gone */ } }
      renderAll();
    }
  }

  function showSuccess(r) {
    result.hidden = false;
    result.className = "flash-result ok";
    const parts = [];
    if (r.reenumerated) {
      parts.push(`<p><strong>The bridge board is restarting into Katapult over USB.</strong> Switch the method to Katapult and pick the Katapult port to finish.</p>`);
    } else if (r.method === "uf2") {
      parts.push(`<p><strong>${r.disappeared ? "The board took the file and restarted." : "The .uf2 was written."}</strong> ${r.disappeared ? "" : "The board restarts once its bootloader has read the last block; if the drive is still there after a few seconds, eject it."} Check that it enumerates as Klipper (or Katapult) now.</p>`);
    } else {
      parts.push(`<p><strong>Flashed and verified.</strong> ${esc(r.deviceText || "")}${r.restarted ? " The board has restarted into the new firmware." : ""}</p>`);
    }
    if (r.hint) {
      parts.push(`<p class="flash-muted">For printer.cfg (best effort; the serial name appears once Klipper runs):</p><pre class="flash-hint">${esc(r.hint)}</pre>`);
    }
    result.innerHTML = parts.join("");
    if (r.hint) result.appendChild(el("button", { class: "mini", onclick: (e) => { e.preventDefault(); copyText(r.hint); } }, ["Copy"]));
    if (r.reenumerated && r.nextMethod && state.firmware.methods.some((m) => m.id === r.nextMethod)) {
      state.method = r.nextMethod;
      state.bridgeUuid = r.uuid || null;
    }
    help.open = false;
  }

  function showFailure(e) {
    if (isCancel(e)) { log("Cancelled."); renderAll(); return; }
    const ex = explainError(e, { method: state.method, os: caps.os, browser: caps.browser });
    state.error = ex;
    log(`Error: ${ex.message}`);
    result.hidden = false;
    result.className = "flash-result error";
    result.innerHTML = `<p><strong>${esc(ex.title)}</strong></p><p>${esc(ex.message)}</p>` +
      (ex.fixes.length ? `<p class="flash-muted">See "What went wrong?" below for the fixes.</p>` : "");
    const body = help.querySelector("#flash-help-body");
    body.innerHTML = `<p><strong>${esc(ex.title)}</strong> (${esc(ex.code)})</p>` +
      (ex.fixes.length ? `<ol class="flash-fixes">${ex.fixes.map((f) => `<li>${esc(f)}</li>`).join("")}</ol>` : "<p>No specific fix is known for this one; the log above has the details.</p>");
    help.open = true;
    if (state.phase !== "flashing") state.phase = state.firmware ? "ready" : "idle";
    renderAll();
  }

  // ── Events ──────────────────────────────────────────────────────
  methodSelect.addEventListener("change", async () => {
    state.method = methodSelect.value;
    result.hidden = true;
    await dropConnection();
    log(`Method: ${METHODS[state.method] ? METHODS[state.method].label : state.method}`);
  });

  // ── Public API ──────────────────────────────────────────────────
  const api = {
    element: root,
    log,
    /** A firmware to flash: {image, methods: [{id, reason}], warnings, instructions, mcu, project, family, artifacts, source, version, label, uuid, baud, bitrate, onClear}. */
    setFirmware(firmware) {
      state.firmware = firmware || null;
      state.connection = null;
      state.phase = firmware ? "ready" : "idle";
      result.hidden = true;
      if (firmware && firmware.preferredMethod && firmware.methods.some((m) => m.id === firmware.preferredMethod)) state.method = firmware.preferredMethod;
      renderAll();
      if (firmware) {
        const d = describeImage(firmware.image);
        log(`Firmware: ${firmware.label || firmware.image.name || "image"}, ${d.rangeText}${firmware.mcu ? `, MCU ${firmware.mcu}` : ""}; methods: ${firmware.methods.map((m) => m.id).join(", ")}`);
      }
    },
    get method() { return state.method; },
    set method(id) { state.method = id; renderAll(); },
    get state() { return state; },
    capabilities: caps,
    /** Ask for a flash address for a .bin: an inline form; resolves with a number or null. */
    askAddress(defaultAddress, { name = "the file" } = {}) {
      return new Promise((resolve) => {
        prompt.hidden = false;
        prompt.innerHTML = "";
        const input = el("input", { type: "text", id: "flash-address", value: defaultAddress !== null && defaultAddress !== undefined ? hex8(defaultAddress) : "0x08000000", spellcheck: "false" });
        prompt.appendChild(el("p", { text: `${name} is a raw .bin, which carries no address. Where does it go? For an STM32 that is 0x08000000 without a bootloader or 0x08002000 with an 8 KiB Katapult; for an RP2040 0x10000100 without and 0x10004000 with Katapult.` }));
        const row = el("div", { class: "flash-actions" }, [
          el("label", { class: "field" }, ["Address ", input]),
          el("button", { class: "primary", onclick: (e) => {
            e.preventDefault();
            const v = input.value.trim();
            const n = /^0x/i.test(v) ? parseInt(v, 16) : parseInt(v, 10);
            if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) { input.classList.add("bad"); return; }
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
