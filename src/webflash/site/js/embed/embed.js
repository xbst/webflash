// The embed runtime: what every generated page loads, as the module
// <engine_url>embed.js. It reads the board's configuration (the
// #webflash-config JSON the renderer wrote), loads its stylesheet and
// replaces the card's static fallback with the controls (embed-ui.js). The
// page's own inline scripts keep the color scheme (data-theme on <html>) and
// report the card's height to the host page; the runtime only fires
// "webflash-relayout" when it changes something they cannot see.
//
// It runs from /engine/v1/ of a WebFlash site, where its imports reach the
// site's modules (serve.py's engine_files lays them out), and everything
// heavy comes from that site by CORS: the Python payload, toolchain/ and
// sources/. The local server writes its --assets URL between the quotes
// below; empty, as the hosted site serves this file, means the runtime's own
// site.

import { readConfig } from "./embed-model.js";
import { siteUrl } from "./toml-io.js";

const ASSETS = "" /* webflash-assets */;

/** Where this runtime is and what goes with it: {engine, site, assets, payloadUrl}. */
export function runtimeLocation(moduleUrl = import.meta.url, assets = ASSETS) {
  const engine = new URL("./", moduleUrl).href;
  const site = siteUrl(engine);
  return { engine, site, assets: assets || site, payloadUrl: new URL("webflash.zip", site).href };
}

function loadStyles(href) {
  return new Promise((resolve) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.addEventListener("load", () => resolve(true));
    link.addEventListener("error", () => resolve(false));
    document.head.appendChild(link);
  });
}

// The fallback stays, with what went wrong under it: it still says where to
// get the firmware.
function showProblem(card, message) {
  const p = document.createElement("p");
  p.className = "wf-notice wf-problem";
  p.textContent = message;
  (card.querySelector(".wf-static") || card).appendChild(p);
  dispatchEvent(new Event("webflash-relayout"));
}

async function start() {
  const card = document.getElementById("wf-card");
  const script = document.getElementById("webflash-config");
  if (!card || !script) return;
  const { config, error } = readConfig(script.textContent);
  if (!config) {
    showProblem(card, error);
    return;
  }
  const env = runtimeLocation();
  const styled = await loadStyles(new URL("css/embed.css", env.engine).href);
  let ui;
  try {
    ui = await import("./embed-ui.js");
  } catch (e) {
    showProblem(card, `The WebFlash runtime could not load from ${env.engine} (${e.message}).`);
    return;
  }
  if (!styled) console.warn(`WebFlash: ${env.engine}css/embed.css did not load; the card shows unstyled.`);
  await ui.mountCard(card, config, env);
  dispatchEvent(new Event("webflash-relayout"));
}

if (typeof document !== "undefined") {
  start().catch((e) => {
    const card = document.getElementById("wf-card");
    if (card) showProblem(card, `The card could not start: ${e && e.message ? e.message : e}`);
    console.error(e);
  });
}
