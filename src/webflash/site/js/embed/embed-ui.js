// The card a generated page shows once its runtime runs (SPEC 13): the
// title, the description and the photo (the fallback's own image element,
// kept: with -i it is the image's only copy), notices for what this browser
// or this frame cannot do, the firmware part of a board built from source
// (embed-build.js, loaded only for one), the flash panel (js/flash/
// flash-ui.js, compact) and "Open in WebFlash". A [prebuilt] board's file
// comes from the page (-i) or from beside it, and nothing of the build loads
// for it: no Python, no compiler.
//
// ?mock=<katapult|dfu|picoboot|can|uf2>[&fail=...] on the page's URL runs the
// flash panel against the scripted devices of js/flash/mocks/, as on the site.

import { createFlashPanel, renderInline } from "./flash/flash-ui.js";
import { capabilities, explainError } from "./flash/errors.js";
import { extractKlipperDict, parseFirmware } from "./flash/firmware-file.js";
import { behaviorOf, firmwareFromBuild, firmwareFromPrebuilt, framePermissions, platformFor } from "./embed-model.js";

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

/** What flashing from this page cannot do, as notices: [{kind, html}]. */
function platformNotices(perms, caps, { mocked }) {
  const out = [];
  const nav = typeof navigator !== "undefined" ? navigator : {};
  const own = `<a href="${esc(location.href)}" target="_blank" rel="noopener">open this card in a tab of its own</a>`;
  const blocked = [!perms.usb && nav.usb ? "USB" : "", !perms.serial && nav.serial ? "serial ports" : ""].filter(Boolean);
  if (!mocked && blocked.length) {
    out.push({
      kind: "warn",
      html: `<p>The page this card is embedded in does not let it use ${blocked.join(" or ")}, so it cannot flash from here. ` +
        `Build and download the files, or ${own}. (The site can allow it with <code>allow="usb; serial"</code> on the embed.)</p>`,
    });
  } else if (!caps.usb && !caps.serial) {
    const which = caps.browser === "firefox" ? "Firefox" : caps.browser === "safari" ? "Safari" : "This browser";
    out.push({
      kind: "warn",
      html: `<p>${which} cannot flash a board from a web page (it has neither WebUSB nor Web Serial): build here and download the files, ` +
        `then flash them with Chrome or Edge on a computer, or with the usual tools.</p>`,
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

/**
 * Replace the card's fallback with the controls for config (readConfig's)
 * and env (embed.js's runtimeLocation). Resolves once the card is in place;
 * the firmware part keeps loading the list of versions after that.
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
  const mount = () => {
    card.replaceChildren(app);
    mounted = true;
    relayout();
  };
  const fallback = card.querySelector(".wf-static");
  const app = el("div", { class: "wf-app" });
  app.append(el("h1", { class: "wf-title", text: config.board.title }));
  const description = renderInline(config.board.description);
  if (description) app.append(el("div", { class: "wf-desc", html: description }));
  const image = fallback ? fallback.querySelector(".wf-image") : null;
  if (image) {
    image.addEventListener("load", relayoutMounted);
    app.append(image);
  }
  const notes = el("div", { class: "wf-notes" });
  app.append(notes);
  const note = (kind, html) => {
    notes.append(el("div", { class: `wf-box wf-${kind}`, html }));
    relayoutMounted();
  };

  const perms = framePermissions(document, window);
  const platform = mocks ? { nav: mocks.nav, win: mocks.win } : platformFor(navigator, window, perms);
  const caps = capabilities(platform.nav || navigator, platform.win || window);
  for (const n of platformNotices(perms, caps, { mocked: Boolean(mocks) })) note(n.kind, n.html);

  const flashSection = el("section", { class: "wf-flash", hidden: true });
  const flashHead = el("h2", { class: "wf-section", text: "Flash" });
  const flashRoot = el("div");
  flashSection.append(flashHead, flashRoot);
  let panel = null;
  let shown = null;
  const showFirmware = (fw) => {
    if (fw === shown) return;
    shown = fw;
    flashSection.hidden = !fw;
    if (fw) {
      if (!panel) {
        panel = createFlashPanel(flashRoot, {
          compact: true, title: null, confirmFlash: behavior.confirmFlash, nav: platform.nav, win: platform.win,
        });
      }
      panel.setFirmware(fw);
    }
    relayout();
  };

  if (config.firmware) {
    const firmwareSection = el("section", { class: "wf-fw" });
    const link = el("a", {
      class: "wf-open", target: "_blank", rel: "noopener", text: "Open in WebFlash",
      title: "Open this board's configuration on the WebFlash site, with every option of make menuconfig",
    });
    app.append(firmwareSection, flashSection, el("p", { class: "wf-foot" }, [link]));
    mount();
    const { FirmwareSection } = await import("./embed-build.js");
    // The flash panel follows the build, and lets it go while the settings
    // differ from the build's (the reader would flash what they did not pick).
    let current = { build: null, fw: null };
    new FirmwareSection(firmwareSection, config, env, {
      behavior,
      onLink: (href) => { link.href = href; },
      onBuild: (build) => {
        if (build !== current.build) {
          let fw = null;
          try {
            fw = build ? firmwareFromBuild(build, config) : null;
          } catch (e) {
            note("error", `<p>The build's firmware could not be read: ${esc(e.message)}</p>`);
          }
          current = { build, fw };
        }
        showFirmware(current.fw);
      },
      onRelayout: relayout,
    });
  } else {
    const loading = el("p", { class: "wf-muted", text: `Loading ${config.prebuilt.file}…` });
    app.append(loading, flashSection);
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
      loading.remove();
      showFirmware(firmwareFromPrebuilt(config, image, bytes));
    } catch (e) {
      loading.remove();
      note("error", `<p>${esc(explainError(e, {}).message)}</p>`);
    }
  }
  relayout();
}
