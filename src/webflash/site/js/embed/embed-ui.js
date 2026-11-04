// The card a generated page shows once its runtime runs: the site's wizard,
// sized for a frame in a docs page (SPEC 2.2 of the guided UI). A step bar
// (on a phone only the current step's name), then one step at a time, each
// with its footer: Firmware (the board's title, description and photo, the
// fallback's own image element, kept: with -i it is the image's only copy;
// notices for what this browser or this frame cannot do; what to flash),
// Setup (when the TOML offers several), Build and Flash (the flash panel,
// js/flash/flash-ui.js, compact, and "Open in WebFlash"). The firmware steps
// are embed-build.js's, loaded only for a board built from source. A
// [prebuilt] board has Firmware (the board and its file) and Flash: its file
// comes from the page (-i) or from beside it, and nothing of the build loads
// for it: no Python, no compiler.
//
// The steps move without the browser's history (the card lives in someone
// else's page), and every move asks the page to report its height.
//
// ?mock=<katapult|dfu|picoboot|can|uf2>[&fail=...] on the page's URL runs the
// flash panel against the scripted devices of js/flash/mocks/, as on the site.

import { createFlashPanel, renderInline } from "./flash/flash-ui.js";
import { capabilities, explainError } from "./flash/errors.js";
import { describe as describeImage, extractKlipperDict, parseFirmware } from "./flash/firmware-file.js";
import { Wizard } from "./wizard/wizard.js";
import { behaviorOf, firmwareFromPrebuilt, frameNotice, framePermissions, platformFor } from "./embed-model.js";

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
  for (const c of [].concat(children)) if (c) node.append(c);
  return node;
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const relayout = () => dispatchEvent(new Event("webflash-relayout"));

export const CARD_STEPS = [
  { id: "firmware", label: "Firmware" },
  { id: "setup", label: "Setup" },
  { id: "build", label: "Build" },
  { id: "flash", label: "Flash" },
];

/** What flashing from this page cannot do, as notices: [{kind, html}]. */
function platformNotices(perms, caps, { mocked }) {
  const out = [];
  const nav = typeof navigator !== "undefined" ? navigator : {};
  const framed = mocked ? null : frameNotice(perms, nav, location.href);
  if (framed) {
    out.push({ kind: "warn", html: framed });
  } else if (!caps.usb && !caps.serial) {
    const which = caps.browser === "firefox" ? "Firefox" : caps.browser === "safari" ? "Safari" : "This browser";
    out.push({
      kind: "warn",
      html: `<p>${which} cannot flash from a web page: build here, download the files, then flash them with Chrome or Edge, or your usual tools.</p>`,
    });
  }
  return out;
}

async function prebuiltBytes(config) {
  const inline = config.inline && config.inline.prebuilt;
  const url = inline || new URL(config.prebuilt.file, document.baseURI).href;
  let resp;
  try {
    resp = await fetch(url);
  } catch (e) {
    throw new Error(`${config.prebuilt.file} could not be downloaded: the request failed.`);
  }
  if (!resp.ok) throw new Error(`${config.prebuilt.file} could not be downloaded from beside this page (HTTP ${resp.status}).`);
  return new Uint8Array(await resp.arrayBuffer());
}

// One step: <section data-step> with its body and footer, as wizard.js
// expects them. foot lists the footer's parts in order.
function stepSection(id, { title = null, foot = [] } = {}) {
  const body = el("div", { class: "wiz-body" });
  if (title) body.append(title);
  const section = el("section", { class: "wiz-step", "data-step": id, hidden: true }, [body, el("div", { class: "wiz-foot" }, foot)]);
  return { section, body };
}

/**
 * Replace the card's fallback with the steps for config (readConfig's) and
 * env (embed.js's runtimeLocation). Resolves once the card is in place, to
 * {wizard, flow (embed-build.js's FirmwareFlow, null for [prebuilt]),
 * panel (the flash panel)}; the firmware steps keep loading the list of
 * versions after that.
 */
export async function mountCard(card, config, env) {
  const behavior = behaviorOf(card.dataset);

  // What the flash panel may use: the scripted devices with ?mock=, else
  // the browser's, without what the embedding page does not allow. Loaded
  // before the photo leaves the fallback, so the fallback is never shown
  // without it while this waits.
  let mocks = null;
  const params = new URLSearchParams(location.search);
  if (params.get("mock")) {
    try {
      const { installMocks } = await import("./flash/mocks/install.js");
      mocks = await installMocks(params);
    } catch (e) {
      console.error("The flash mocks could not be installed:", e);
    }
  }

  // Nothing reports the card's height until the app replaces the fallback:
  // measured before that, the fallback has lost its photo to the app, and
  // the host's frame would shrink by the photo's height before it grows.
  let mounted = false;
  const relayoutMounted = () => { if (mounted) relayout(); };
  const fallback = card.querySelector(".wf-static");
  const app = el("div", { class: "wf-app" });

  // ── The steps ─────────────────────────────────────────────────────
  const bar = el("ol", { class: "wf-steps", "aria-label": "Steps" });
  const button = (text, attrs = {}) => el("button", { type: "button", ...attrs, text });
  const hint = () => el("span", { class: "wiz-hint", "data-wiz-hint": true });
  const back = () => button("Back", { class: "ghost", "data-wiz-back": true });
  const next = (text = "Next") => button(text, { class: "primary", "data-wiz-next": true });
  const strip = () => el("p", { class: "wf-strip" });
  const strips = [];

  // Page 1: the board.
  const titleEl = el("h1", { class: "wf-title", text: config.board.title, tabindex: "-1", "data-wiz-title": true });
  const head = el("div", { class: "wf-board" });
  const words = el("div", { class: "wf-board-text" }, [titleEl]);
  const description = renderInline(config.board.description);
  if (description) words.append(el("div", { class: "wf-desc", html: description }));
  head.append(words);
  const image = fallback ? fallback.querySelector(".wf-image") : null;
  if (image) {
    image.addEventListener("load", relayoutMounted);
    head.append(image);
    head.classList.add("wf-has-image");
  }
  const notesHome = el("div", { class: "wf-notes" });
  const notesFlash = el("div", { class: "wf-notes" });
  const note = (kind, html, { flash = true } = {}) => {
    notesHome.append(el("div", { class: `wf-box wf-${kind}`, html }));
    if (flash) notesFlash.append(el("div", { class: `wf-box wf-${kind}`, html }));
    relayoutMounted();
  };

  const firmware = stepSection("firmware", { foot: [hint(), next()] });
  firmware.body.append(head, notesHome);
  const setup = stepSection("setup", {
    title: el("h2", { class: "wf-page", tabindex: "-1", "data-wiz-title": true, text: "How is the board connected?" }),
    foot: [back(), hint(), next("Build")],
  });
  const setupList = el("div", { class: "wf-choices", role: "radiogroup", "aria-label": "Setups" });
  setup.body.prepend(strips[strips.push(strip()) - 1]);
  setup.body.append(setupList);
  const cancel = button("Cancel", { hidden: true, title: "Stop the build" });
  const rebuild = button("Build", { class: "ghost" });
  const build = stepSection("build", { foot: [back(), hint(), cancel, rebuild, next()] });
  build.body.append(strips[strips.push(strip()) - 1]);
  const buildBody = el("div", { class: "wf-build" });
  build.body.append(buildBody);
  const link = el("a", {
    class: "wf-open", target: "_blank", rel: "noopener", text: "Open in WebFlash",
    title: "Open this board on the WebFlash site, with every option of make menuconfig",
  });
  const flash = stepSection("flash", {
    title: el("h2", { class: "wf-page", tabindex: "-1", "data-wiz-title": true, text: "Flash" }),
    foot: [back(), hint(), config.firmware ? link : null],
  });
  flash.body.prepend(strips[strips.push(strip()) - 1]);
  const flashRoot = el("div", { class: "wf-flash" });
  flash.body.append(notesFlash, flashRoot);

  const box = el("div", { class: "wf-wizard" }, [bar, firmware.section, setup.section, build.section, flash.section]);
  app.append(box);
  const wizard = new Wizard({ box, bar, steps: CARD_STEPS, history: null, win: null, scroll: false });
  if (!config.firmware || config.setups.length < 2) wizard.setSkipped("setup");
  if (!config.firmware) wizard.setSkipped("build");
  wizard.onStep(() => relayoutMounted());

  const setStrip = (what) => {
    for (const s of strips) {
      s.replaceChildren(el("strong", { text: config.board.title }), what ? ` · ${what}` : "");
    }
  };

  // ── Notices and the flash panel ──────────────────────────────────
  const perms = framePermissions(document, window);
  const platform = mocks ? { nav: mocks.nav, win: mocks.win } : platformFor(navigator, window, perms);
  const caps = capabilities(platform.nav || navigator, platform.win || window);
  for (const n of platformNotices(perms, caps, { mocked: Boolean(mocks) })) note(n.kind, n.html);

  const panel = createFlashPanel(flashRoot, {
    compact: true, title: null, confirmFlash: behavior.confirmFlash, nav: platform.nav, win: platform.win,
  });
  const flashLog = flashRoot.querySelector(".log-box");
  if (flashLog && behavior.showLog) flashLog.open = true;
  for (const d of flashRoot.querySelectorAll("details")) d.addEventListener("toggle", relayoutMounted);
  const showFirmware = (fw, opts = {}) => {
    panel.setFirmware(fw, opts);
    relayoutMounted();
  };

  const mount = () => {
    card.replaceChildren(app);
    mounted = true;
    relayout();
  };

  let flow = null;
  if (config.firmware) {
    const pick = el("div", { class: "wf-pick" });
    const options = el("div", { class: "wf-opts" });
    const about = el("div");
    firmware.body.append(pick, options, about);
    // Next waits for the firmware steps, which load now.
    wizard.setNext("firmware", { enabled: false, reason: "Loading…" });
    mount();
    const { FirmwareFlow } = await import("./embed-build.js");
    flow = new FirmwareFlow(config, env, {
      behavior, wizard,
      els: { pick, options, about, setups: setupList, build: buildBody, cancel, rebuild },
      onFirmware: showFirmware,
      onLink: (href) => { link.href = href; },
      onTitle: setStrip,
      onRelayout: relayoutMounted,
    });
  } else {
    const fileLine = el("p", { class: "wf-file wf-muted", text: `Loading ${config.prebuilt.file}…` });
    firmware.body.append(fileLine);
    setStrip(config.prebuilt.file.split(/[\\/]/).pop());
    showFirmware(null, { empty: `Loading ${config.prebuilt.file}…` });
    mount();
    try {
      const bytes = await prebuiltBytes(config);
      const image = parseFirmware(config.prebuilt.file, bytes, {
        address: Number.isInteger(config.prebuilt.address) ? config.prebuilt.address : null, source: "upload",
      });
      try {
        image.dict = await extractKlipperDict(image);
      } catch (e) {
        image.dict = null;
      }
      const fw = firmwareFromPrebuilt(config, image, bytes);
      const d = describeImage(image);
      fileLine.className = "wf-file";
      fileLine.replaceChildren(el("strong", { text: fw.label }), ` · ${d.rangeText}${fw.mcu ? ` · ${fw.mcu}` : ""}`);
      showFirmware(fw);
    } catch (e) {
      const message = explainError(e, {}).message;
      fileLine.remove();
      note("error", `<p>${esc(message)}</p>`);
      showFirmware(null, { empty: message });
    }
  }
  relayout();
  return { wizard, flow, panel };
}
