// Vanilla-DOM mobile on-screen keyboard controller.
//
// The hard problem: there's no reliable local DOM event for "a text field was
// focused" in a *remote* page, and both iOS Safari and Android Chrome only
// raise the OS keyboard if focus() runs synchronously inside the original
// trusted touch-gesture call stack - confirmed for both platforms, not an
// iOS-only quirk. Strategy (works on Android and iOS):
//   1. On a tap, OPTIMISTICALLY focus a hidden local input synchronously, inside
//      the touchend gesture - satisfies the platform constraint above and
//      raises the keyboard immediately.
//   2. Reconcile against the backend's editableFocused signal (ElementState): if
//      the tap didn't hit a remote editable, editableFocused never becomes true,
//      and after a short window we blur (keyboard closes). When the remote
//      editable later loses focus, editableFocused flips false and we blur.
// Accepted tradeoff: a tap on a non-editable briefly shows then dismisses the
// keyboard - standard for browser remote-desktop keyboards, and structurally
// necessary given the synchronous-focus constraint above (there's no
// reliable way to know in advance, before focusing, whether a given tap will
// land on a remote editable). The confirm-timeout and tap-classification
// tuning below narrow how often this happens and how often a real edit gets
// wrongly dismissed under network jitter, but neither eliminates it - only a
// different UX (e.g. an explicit, always-visible "show keyboard" control,
// considered and deliberately deferred rather than built here) could do
// that.
//
// A third signal narrows the flash further, without ever eliminating it:
// interactiveElements (backend-scanned text-editable candidate bounding
// boxes, see setInteractiveElements) lets handleTap classify a tap against
// real DOM geometry instead of touch heuristics alone. A confident miss
// against a fresh cache does NOT skip focus() - see handleTap's own comment
// for why a stale cache (most commonly: the user just scrolled) makes that
// unsafe - it only shortens the confirm window. The remaining cases
// (unknown/stale data, or a rare cache false-positive - occlusion isn't
// modeled) still fall
// back to the original behavior above.

import type { GlassStats, InteractiveElement, KeyEvent } from "../types.js";

// The subset of GlassClient this controller needs.
export interface KeyboardTarget {
  isConnected(): boolean;
  pasteText(text: string): void;
  dispatchKeyEvent(event: KeyEvent): void;
  getStats(): Promise<GlassStats | null>;
}

const FOCUS_CONFIRM_TIMEOUT_MS = 600;

// RTT-adaptive confirm timeout: the fixed 600ms budget above doesn't account
// for real network latency (measured wire delays spiking to 200-400ms+ under
// real degraded WiFi) - against that flat budget for touch-forward + CDP
// dispatch + up to one backend poll tick + state-push-back, a genuine tap on
// a real input can fail to confirm in time under exactly the conditions this
// product needs to handle gracefully. When a recent RTT sample is available,
// stretch the confirm window relative to it instead of using the flat floor.
const RTT_TIMEOUT_MULTIPLIER = 3; // ~2-3 network legs: tap -> backend,
// backend's next state-poll tick, backend -> client.
const RTT_TIMEOUT_MARGIN_MS = 200; // CDP dispatch + poll-interval worst case.
const RTT_TIMEOUT_MAX_MS = 2500; // ceiling - bounds how long a genuine
// non-edit tap's flash-then-dismiss can visibly hang on a garbage/pathological RTT.
const RTT_SAMPLE_MAX_AGE_MS = 30_000; // a cached sample this old is untrusted
// (conditions may have changed) - falls back to the floor.
const RTT_REFRESH_MIN_INTERVAL_MS = 3000; // don't kick off a new getStats()
// call on literally every tap - found via live phone testing: a native
// RTCPeerConnection.getStats() call has real per-invocation cost, and firing
// it unconditionally per tap competes with touch/scroll handling and video
// decode on the same main thread, felt live as scroll jank. RTT doesn't
// swing fast enough under normal conditions to need a fresher sample than
// this between refreshes.

// interactiveElements cache staleness/miss-handling. See handleTap's own
// comment for why a confident miss shortens the confirm window instead of
// skipping focus() outright - this is a coarse ceiling on top of that
// safety mechanism, not a substitute for it.
const INTERACTIVE_ELEMENTS_MAX_AGE_MS = 5000; // a bit more than 2x the
// backend's coarser scan interval (1-3s) so one missed/delayed
// push doesn't immediately revert to the unknown-data fallback.
const MISS_CONFIRM_TIMEOUT_MS = 150; // a starting point, not validated on
// real devices yet, like every other new tunable in this project. Used
// only for a *confident* miss (fresh cache, point outside every cached
// rect) - still shows the keyboard, just dismisses it much sooner than the
// RTT-adaptive window used for a hit or an unknown tap.

const CONTROL_KEYS = new Set([
  "Backspace",
  "Delete",
  "Enter",
  "Tab",
  "Escape",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
]);

export class MobileKeyboardController {
  private input: HTMLInputElement | null = null;
  private confirmTimer: ReturnType<typeof setTimeout> | null = null;
  private editableFocused = false;
  private lastRtt: { ms: number; sampledAt: number } | null = null;
  private lastStatsFetchAt: number | null = null;
  private interactiveElements: InteractiveElement[] = [];
  private elementsUpdatedAt: number | null = null;

  // container is where the (visually hidden, off-screen) input is appended.
  // enabled=false makes the controller inert (desktop): no input is created and
  // handleTap does nothing.
  constructor(
    container: HTMLElement,
    private target: KeyboardTarget,
    private enabled: boolean
  ) {
    if (!enabled) return;
    const input = document.createElement("input");
    input.type = "text";
    input.setAttribute("autocomplete", "off");
    input.setAttribute("autocorrect", "off");
    input.setAttribute("autocapitalize", "off");
    input.spellcheck = false;
    // Off-screen but focusable: iOS won't focus (and so won't show a keyboard
    // for) a display:none input, so we hide it via size/opacity instead.
    Object.assign(input.style, {
      position: "absolute",
      top: "0",
      left: "0",
      width: "1px",
      height: "1px",
      opacity: "0",
      border: "none",
      padding: "0",
      pointerEvents: "none",
    } satisfies Partial<CSSStyleDeclaration>);
    input.addEventListener("input", this.handleInput);
    input.addEventListener("keydown", this.handleKeyDown);
    container.appendChild(input);
    this.input = input;
  }

  // Call from the touch layer's onTap. Synchronously focuses the hidden input
  // (this is what makes iOS raise the keyboard) - UNCONDITIONALLY, regardless
  // of what the interactive-elements cache says. A confident cache miss only
  // shortens the confirm window (see computeTapConfirmTimeoutMs) - it can
  // never skip focus() outright, because getBoundingClientRect() is
  // viewport-relative and there's no scroll-position signal reported back to
  // the backend anywhere in this codebase: the user can scroll (including
  // real compositor momentum scroll that continues after touchend) a genuine
  // editable into a position the cache still thinks is empty. Skipping focus
  // on that miss would silently do nothing on a real tap - worse than
  // today's flash-then-dismiss, not better.
  handleTap = (point: { x: number; y: number } | null): void => {
    if (!this.enabled) return;
    const input = this.input;
    if (!input) return;
    input.focus();
    this.clearConfirmTimer();
    this.confirmTimer = setTimeout(() => {
      this.confirmTimer = null;
      if (!this.editableFocused && document.activeElement === input) {
        input.blur();
      }
    }, this.computeTapConfirmTimeoutMs(point));
    // Fire-and-forget: refreshes the RTT sample used by a *future* tap's
    // computeConfirmTimeoutMs() call above. Never awaited - must not delay
    // focus() or timer-arming on this tap. Throttled (see
    // RTT_REFRESH_MIN_INTERVAL_MS) rather than fired on every tap.
    const now = Date.now();
    if (
      this.lastStatsFetchAt === null ||
      now - this.lastStatsFetchAt >= RTT_REFRESH_MIN_INTERVAL_MS
    ) {
      this.lastStatsFetchAt = now;
      void this.target
        .getStats()
        .then((stats) => this.setRttMs(stats?.rttMs ?? null))
        .catch(() => {
          // A failed stats lookup just leaves lastRtt as-is (falls back to
          // the flat floor via staleness) - not fatal to the tap itself.
        });
    }
  };

  // No sample, or the cached sample is stale -> the flat FOCUS_CONFIRM_TIMEOUT_MS
  // floor (today's exact behavior). Otherwise stretches the window relative
  // to the last known RTT, clamped to [FOCUS_CONFIRM_TIMEOUT_MS, RTT_TIMEOUT_MAX_MS].
  private computeConfirmTimeoutMs(): number {
    const sample = this.lastRtt;
    if (!sample) return FOCUS_CONFIRM_TIMEOUT_MS;
    if (Date.now() - sample.sampledAt > RTT_SAMPLE_MAX_AGE_MS) {
      return FOCUS_CONFIRM_TIMEOUT_MS;
    }
    const stretched = RTT_TIMEOUT_MULTIPLIER * sample.ms + RTT_TIMEOUT_MARGIN_MS;
    return Math.min(Math.max(stretched, FOCUS_CONFIRM_TIMEOUT_MS), RTT_TIMEOUT_MAX_MS);
  }

  // Only accepts a finite, non-negative value - not optional polish. An
  // unvalidated NaN poisons the clamp math in computeConfirmTimeoutMs
  // (NaN propagates through both Math.max/Math.min) and setTimeout(fn, NaN)
  // fires as 0 per spec - the keyboard would dismiss almost instantly on
  // every tap, a regression strictly worse than today's baseline. A
  // rejected value leaves lastRtt untouched.
  setRttMs(ms: number | null): void {
    if (ms === null || !Number.isFinite(ms) || ms < 0) return;
    this.lastRtt = { ms, sampledAt: Date.now() };
  }

  // Picks this specific tap's confirm-timeout. Only a *confident* miss
  // (fresh cache, a point was available, and it lands outside every cached
  // rect) gets the short MISS_CONFIRM_TIMEOUT_MS - every other case (no
  // point, empty/stale cache, or a hit) falls back to the normal
  // RTT-adaptive window, unchanged.
  private computeTapConfirmTimeoutMs(point: { x: number; y: number } | null): number {
    const cacheFresh =
      this.elementsUpdatedAt !== null &&
      Date.now() - this.elementsUpdatedAt <= INTERACTIVE_ELEMENTS_MAX_AGE_MS;
    if (cacheFresh && point && !this.hitsKnownElement(point)) {
      return MISS_CONFIRM_TIMEOUT_MS;
    }
    return this.computeConfirmTimeoutMs();
  }

  // Local, synchronous point-in-rect scan - no network, no async work.
  // Cheap at the backend's capped element count (default 150).
  private hitsKnownElement(point: { x: number; y: number }): boolean {
    for (const el of this.interactiveElements) {
      if (
        point.x >= el.x &&
        point.x <= el.x + el.width &&
        point.y >= el.y &&
        point.y <= el.y + el.height
      ) {
        return true;
      }
    }
    return false;
  }

  // Feed the backend's latest interactive-element scan (full-snapshot-
  // replace, protocol 0x0A - see types.ts's InteractiveElement doc comment).
  // Drops individually malformed entries rather than rejecting the whole
  // push - a single bad entry from a wire hiccup shouldn't discard every
  // other real candidate. Stamps elementsUpdatedAt even for a genuinely
  // empty list (a page can legitimately have zero editable elements right
  // now) - that's "fresh, empty" data, distinct from "never received a
  // push" (elementsUpdatedAt stays null until the first push arrives).
  setInteractiveElements(elements: InteractiveElement[]): void {
    this.interactiveElements = elements.filter(
      (el) =>
        Number.isFinite(el.x) &&
        Number.isFinite(el.y) &&
        Number.isFinite(el.width) &&
        Number.isFinite(el.height) &&
        el.width >= 0 &&
        el.height >= 0
    );
    this.elementsUpdatedAt = Date.now();
  }

  // Feed the backend's latest editableFocused (from the client "state" event).
  setEditableFocused(value: boolean): void {
    this.editableFocused = value;
    if (!this.input) return;
    if (value) {
      // Confirmed - keep the keyboard up.
      this.clearConfirmTimer();
    } else if (document.activeElement === this.input) {
      // Remote editable lost focus - dismiss.
      this.input.blur();
    }
  }

  // Character input: the input event's value always reflects what was actually
  // typed/composed/autocompleted (robust against IME and "Unidentified" keys),
  // forwarded via the same PasteText/InsertText path as clipboard paste. Cleared
  // after each event so the next value is just the newly typed text.
  private handleInput = (e: Event): void => {
    const target = e.target as HTMLInputElement;
    const typed = target.value;
    target.value = "";
    if (typed && this.target.isConnected()) {
      this.target.pasteText(typed);
    }
  };

  // Control keys report reliable key/code values even from mobile virtual
  // keyboards and don't show up usefully in the input value diff, so they go
  // through dispatchKeyEvent. Character keys are handled by handleInput above.
  private handleKeyDown = (e: KeyboardEvent): void => {
    if (!CONTROL_KEYS.has(e.key)) return;
    e.preventDefault();
    if (!this.target.isConnected()) return;
    const base = {
      key: e.key,
      code: e.code,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      metaKey: false,
    };
    this.target.dispatchKeyEvent({ ...base, type: "keydown" });
    this.target.dispatchKeyEvent({ ...base, type: "keyup" });
  };

  private clearConfirmTimer(): void {
    if (this.confirmTimer !== null) {
      clearTimeout(this.confirmTimer);
      this.confirmTimer = null;
    }
  }

  destroy(): void {
    this.clearConfirmTimer();
    if (this.input) {
      this.input.removeEventListener("input", this.handleInput);
      this.input.removeEventListener("keydown", this.handleKeyDown);
      this.input.remove();
      this.input = null;
    }
  }
}
