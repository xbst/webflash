// The top bar's status chip: one dot and a word for what the site has
// loaded, and a popover listing Python, Sources and Compiler with their
// progress (and Python's Try again).
//
// The three status pills are still what the runtime status code and the
// build card draw (their class says idle, busy, ready, error or off, their
// text and title say what and how far); they live in the popover, and the
// chip sums them up, so nothing that draws a pill needs to know about it.

const NAMES = { "status-python": "Python", "status-sources": "Sources", "status-toolchain": "Compiler" };

function stateOf(cls) {
  for (const s of ["error", "busy", "ready", "off"]) if (cls.includes(s)) return s;
  return "idle";
}

/**
 * What the chip shows for the pills ([{name, state, text}], in the order
 * Python, Sources, Compiler): {state, text}. A failure comes first, then
 * what is loading (by its own words, "Sources: 45%"), then Ready once
 * Python and the sources are, else Not loaded.
 */
export function chipSummary(pills) {
  const failed = pills.find((p) => p.state === "error");
  if (failed) return { state: "error", text: `${failed.name} failed` };
  const busy = pills.find((p) => p.state === "busy");
  if (busy) {
    const detail = busy.text.includes(":") ? busy.text.split(":").slice(1).join(":").trim() : "";
    return { state: "busy", text: detail ? `${busy.name}: ${detail}` : `Loading ${busy.name}` };
  }
  const ready = (name) => pills.some((p) => p.name === name && p.state === "ready");
  if (ready("Python") && ready("Sources")) return { state: "ready", text: "Ready" };
  if (pills.some((p) => p.state === "ready")) return { state: "ready", text: "Partly loaded" };
  return { state: "idle", text: "Not loaded" };
}

/**
 * What a screen reader hears of the chip: its state, and what loads by
 * name, never how far ("Loading Sources", not "Sources: 45%").
 */
export function chipAnnouncement(pills) {
  const sum = chipSummary(pills);
  if (sum.state !== "busy") return sum.text;
  const busy = pills.find((p) => p.state === "busy");
  return `Loading ${busy.name}`;
}

/**
 * Wire the chip (button), its popover and the pills inside it. onRetry
 * is Python's Try again; live, a polite live region, hears the chip's
 * changes of state (the chip's own text follows every percent).
 */
export function mountStatusChip({ chip, popover, pills, retry = null, onRetry = null, live = null }) {
  const label = chip.querySelector(".chip-text");
  const dot = chip.querySelector(".dot");
  let heard = null;

  const read = () => pills.map((pill) => ({
    name: NAMES[pill.id] || pill.id,
    state: stateOf(pill.className),
    text: pill.textContent.trim(),
    title: pill.title || "",
    pill,
  }));

  const render = () => {
    const list = read();
    const sum = chipSummary(list);
    label.textContent = sum.text;
    dot.className = `dot ${sum.state}`;
    chip.title = list.map((p) => `${p.name}: ${p.text.replace(/^[^:]*:\s*/, "") || "not loaded"}`).join("\n");
    for (const p of list) {
      const detail = p.pill.parentElement && p.pill.parentElement.querySelector(".status-detail");
      if (detail) detail.textContent = p.title;
    }
    if (retry) retry.hidden = !list.some((p) => p.name === "Python" && p.state === "error");
    // The first state is the page's own; the changes after it are announced.
    const say = chipAnnouncement(list);
    if (live && heard !== null && say !== heard) live.textContent = say;
    heard = say;
  };

  const observer = new MutationObserver(render);
  for (const pill of pills) observer.observe(pill, { attributes: true, childList: true, characterData: true, subtree: true });

  const open = (show) => {
    popover.hidden = !show;
    chip.setAttribute("aria-expanded", String(show));
  };
  chip.addEventListener("click", () => open(popover.hidden));
  document.addEventListener("click", (e) => {
    if (!popover.hidden && !popover.contains(e.target) && !chip.contains(e.target)) open(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !popover.hidden) {
      open(false);
      chip.focus();
    }
  });
  if (retry && onRetry) retry.addEventListener("click", () => onRetry());
  render();
  return { render, open };
}
