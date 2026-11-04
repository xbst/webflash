// The site's wizard: one box, a step bar on top, Back and Next in each step's
// footer (SPEC 2.1 of the guided UI).
//
// Each step is a <section data-step="<id>"> inside the box, holding its own
// .wiz-body and .wiz-foot; only the current one is shown. The step bar is
// drawn from the steps list: the current step, the steps before it as links
// back, the ones after as plain text (a step marked free, Embed, is a link
// from anywhere), and skipped steps (Configure and Build for a [prebuilt]
// board) left out. Moving to a step pushes a history entry
// whose state names it ({webflashStep, webflashN, webflashLoad}) without
// changing the URL, so the browser's Back and Forward move between steps and
// #toml= and ?config= keep working. An entry an earlier load of the page
// pushed (before a reload) shows nothing of its own.
//
// A step's content is mounted by whoever owns it (main.js today; the
// Configure list, the build and flash content and the setups editor later):
// body(id) is the element to fill. A step says whether its Next is enabled
// with setNext(id, {enabled, reason, label}); onNext(id, fn) runs before
// moving on (fn returns false to stay, or a step id to go to instead);
// onEnter(id, fn) and onLeave(id, fn) run when the step is shown and hidden.

export const STEPS = [
  { id: "firmware", label: "Firmware" },
  { id: "configure", label: "Configure", wide: true },
  { id: "build", label: "Build" },
  { id: "flash", label: "Flash" },
  // Embed needs no build: the bar links to it from every step.
  { id: "embed", label: "Embed", wide: true, free: true },
];

export class Wizard {
  /**
   * box: the element holding the step sections (it gets the class "wide" on
   * a wide step); bar: the <ol> the step bar is drawn into. history and win
   * default to the page's own (tests pass stand-ins).
   */
  constructor({ box, bar, steps = STEPS, history = globalThis.history, win = globalThis.window, scroll = true }) {
    this.box = box;
    this.bar = bar;
    this.steps = steps.map((s) => ({ ...s }));
    this.history = history;
    this.win = win;
    this.scroll = scroll;
    this.skipped = new Set();
    this.hooks = { enter: new Map(), leave: new Map(), next: new Map() };
    this.listeners = [];
    this.current = this.steps[0].id;
    this.n = 0;                   // this entry's place in the session history
    this.trail = [this.current];  // the step of each of our history entries, by place
    // This load of the page: the entries an earlier load pushed name another.
    this.load = `${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}`;

    for (const step of this.steps) {
      const section = this.section(step.id);
      if (!section) continue;
      for (const b of section.querySelectorAll("[data-wiz-back]")) b.addEventListener("click", () => this.back());
      for (const b of section.querySelectorAll("[data-wiz-next]")) b.addEventListener("click", () => this.next());
    }
    // Each step starts at the top, also when the browser's Back shows it.
    if (this.history && "scrollRestoration" in this.history && scroll) this.history.scrollRestoration = "manual";
    if (this.history && this.history.replaceState) {
      const state = this.history.state && typeof this.history.state === "object" ? this.history.state : {};
      this.history.replaceState(this._stamp(state, this.current, 0), "");
    }
    if (this.win && this.win.addEventListener) this.win.addEventListener("popstate", (e) => this._popped(e.state));
    this._show(this.current, null);
  }

  // ── Steps ────────────────────────────────────────────────────────

  section(id) {
    return this.box.querySelector(`section[data-step="${id}"]`);
  }

  /** The element a step's content is mounted into: its .wiz-body. */
  body(id) {
    const section = this.section(id);
    return section ? section.querySelector(".wiz-body") || section : null;
  }

  /** The steps shown, in order (the skipped ones left out). */
  visible() {
    return this.steps.filter((s) => !this.skipped.has(s.id));
  }

  indexOf(id) {
    return this.steps.findIndex((s) => s.id === id);
  }

  /**
   * Leave a step out (Configure and Build for a [prebuilt] board), or bring
   * it back. The step shown, left out, gives way to the next one shown (else
   * the one before), which takes over its history entry.
   */
  setSkipped(id, skipped = true) {
    if (skipped === this.skipped.has(id)) return;
    if (skipped) this.skipped.add(id);
    else this.skipped.delete(id);
    const to = skipped && id === this.current ? this.neighbor(id, 1) || this.neighbor(id, -1) : null;
    if (!to) {
      this.renderBar();
      return;
    }
    if (this.history && this.history.replaceState) this.history.replaceState(this._stamp(this.history.state, to, this.n), "");
    this.trail[this.n] = to;
    this._show(to, id);
  }

  /** The step after (dir 1) or before (dir -1) one, skipping the skipped ones, or null. */
  neighbor(id, dir) {
    for (let i = this.indexOf(id) + dir; i >= 0 && i < this.steps.length; i += dir) {
      if (!this.skipped.has(this.steps[i].id)) return this.steps[i].id;
    }
    return null;
  }

  /**
   * A step's Next: {enabled, reason (its tooltip while disabled), label}.
   * Any key left out stays as it is.
   */
  setNext(id, { enabled, reason, label } = {}) {
    const section = this.section(id);
    if (!section) return;
    for (const b of section.querySelectorAll("[data-wiz-next]")) {
      if (enabled !== undefined) b.disabled = !enabled;
      if (label !== undefined) b.textContent = label;
      if (enabled !== undefined || reason !== undefined) b.title = b.disabled ? (reason || "") : "";
    }
  }

  /** The one-line hint in a step's footer ([data-wiz-hint]). */
  setHint(id, text) {
    const section = this.section(id);
    const hint = section && section.querySelector("[data-wiz-hint]");
    if (hint) hint.textContent = text || "";
  }

  onEnter(id, fn) { this._hook("enter", id, fn); }
  onLeave(id, fn) { this._hook("leave", id, fn); }
  /** fn() before moving on from a step: false stays, a step id goes there instead. May be async. */
  onNext(id, fn) { this.hooks.next.set(id, fn); }
  /** fn({from, to}) after every move. */
  onStep(fn) { this.listeners.push(fn); }

  _hook(kind, id, fn) {
    const list = this.hooks[kind].get(id) || [];
    list.push(fn);
    this.hooks[kind].set(id, list);
  }

  // ── Moving ───────────────────────────────────────────────────────

  /**
   * Show a step. push (the default) adds a history entry, so the browser's
   * Back returns here; a skipped or unknown step is refused (false).
   */
  go(id, { push = true } = {}) {
    if (this.indexOf(id) < 0 || this.skipped.has(id)) return false;
    if (id === this.current) return true;
    const from = this.current;
    if (push && this.history && this.history.pushState) {
      this.n += 1;
      this.trail.length = this.n;
      this.trail.push(id);
      const state = this.history.state && typeof this.history.state === "object" ? this.history.state : {};
      this.history.pushState(this._stamp(state, id, this.n), "");
    }
    this._show(id, from);
    return true;
  }

  // A history entry's state, naming its step, its place and this load.
  _stamp(state, step, n) {
    return { ...(state && typeof state === "object" ? state : {}), webflashStep: step, webflashN: n, webflashLoad: this.load };
  }

  /** The footer's Next: the step's onNext, then the next step. */
  async next() {
    const from = this.current;
    const fn = this.hooks.next.get(from);
    let target = this.neighbor(from, 1);
    if (fn) {
      const out = await fn();
      if (out === false) return false;
      if (typeof out === "string") target = out;
    }
    if (this.current !== from || !target) return false;
    return this.go(target);
  }

  /**
   * The footer's Back: the step before this one. When the history entry
   * before this one is that step, it is the browser's Back, so the two
   * never disagree about where Forward goes.
   */
  back() {
    const target = this.neighbor(this.current, -1);
    if (!target) return false;
    if (this.n > 0 && this.trail[this.n - 1] === target && this.history && this.history.back) {
      this.history.back();
      return true;
    }
    return this.go(target);
  }

  _popped(state) {
    // A hash change (a new #toml=) makes an entry of its own with no state:
    // it keeps the step shown, and becomes that step's entry, so Back to it
    // and the footer's Back still move between steps.
    if (!state || typeof state !== "object" || typeof state.webflashStep !== "string") {
      if (!this.history || !this.history.replaceState) return;
      this.n += 1;
      this.trail.length = this.n;
      this.trail.push(this.current);
      this.history.replaceState(this._stamp(state, this.current, this.n), "");
      return;
    }
    // An entry an earlier load of the page pushed (Back past a reload): its
    // step is not this load's to show, so it becomes an entry of the step
    // shown, in this one's place.
    if (state.webflashLoad !== this.load) {
      if (this.history && this.history.replaceState) this.history.replaceState(this._stamp(state, this.current, this.n), "");
      return;
    }
    const n = Number.isInteger(state.webflashN) ? state.webflashN : 0;
    const from = this.n;
    this.n = n;
    this.trail[n] = state.webflashStep;
    let id = state.webflashStep;
    // A step skipped since (a [prebuilt] TOML opened): the nearest one shown.
    if (this.indexOf(id) < 0) id = this.steps[0].id;
    if (this.skipped.has(id)) {
      id = this.neighbor(id, -1) || this.neighbor(id, 1) || this.current;
      // Its entry would show the step shown already: go on past it, the way
      // the browser was going (the first step, never skipped, ends a Back).
      if (id === this.current && n !== from && this.history) {
        if (n < from && this.history.back) this.history.back();
        else if (n > from && this.history.forward) this.history.forward();
        return;
      }
    }
    if (id !== this.current) this._show(id, this.current);
  }

  _show(id, from) {
    if (from) for (const fn of this.hooks.leave.get(from) || []) this._call(fn, id);
    this.current = id;
    for (const step of this.steps) {
      const section = this.section(step.id);
      if (section) section.hidden = step.id !== id;
    }
    const step = this.steps[this.indexOf(id)];
    if (this.box.classList) this.box.classList.toggle("wide", Boolean(step.wide));
    this.renderBar();
    if (from) {
      if (this.scroll && this.win && this.win.scrollTo) this.win.scrollTo(0, 0);
      // Where a keyboard user is: the new step's title.
      const section = this.section(id);
      const title = section && section.querySelector("[data-wiz-title]");
      if (title && title.focus) title.focus({ preventScroll: true });
    }
    for (const fn of this.hooks.enter.get(id) || []) this._call(fn, from);
    for (const fn of this.listeners) this._call(fn, { from, to: id });
  }

  _call(fn, arg) {
    try { fn(arg); } catch (e) { console.error(e); }
  }

  renderBar() {
    if (!this.bar) return;
    const doc = this.bar.ownerDocument || globalThis.document;
    const here = this.indexOf(this.current);
    const items = this.visible().map((step) => {
      const i = this.indexOf(step.id);
      const li = doc.createElement("li");
      li.className = i === here ? "now" : i < here ? "done" : "";
      li.dataset.for = step.id;
      if (i < here || (step.free && i !== here)) {
        const b = doc.createElement("button");
        b.setAttribute("type", "button");
        b.textContent = step.label;
        b.title = i < here ? `Back to ${step.label}` : `Go to ${step.label}`;
        b.addEventListener("click", () => this.go(step.id));
        li.append(b);
      } else {
        const span = doc.createElement("span");
        span.textContent = step.label;
        li.append(span);
        if (i === here) li.setAttribute("aria-current", "step");
      }
      return li;
    });
    this.bar.replaceChildren(...items);
  }
}
