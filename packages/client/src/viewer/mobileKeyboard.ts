// Vanilla-DOM mobile on-screen keyboard controller (framework-free rewrite of
// the example's Preact hook).
//
// The hard problem: there's no reliable local DOM event for "a text field was
// focused" in a *remote* page, and iOS Safari only raises the OS keyboard if
// focus() runs synchronously inside a trusted user-gesture handler. Strategy
// (works on Android and iOS):
//   1. On a tap, OPTIMISTICALLY focus a hidden local input synchronously, inside
//      the touchend gesture - satisfies iOS and raises the keyboard immediately.
//   2. Reconcile against the backend's editableFocused signal (ElementState): if
//      the tap didn't hit a remote editable, editableFocused never becomes true,
//      and after a short window we blur (keyboard closes). When the remote
//      editable later loses focus, editableFocused flips false and we blur.
// Accepted tradeoff: a tap on a non-editable briefly shows then dismisses the
// keyboard on iOS - standard for browser remote-desktop keyboards.

import type { KeyEvent } from "../types.js";

// The subset of GlassClient this controller needs.
export interface KeyboardTarget {
  isConnected(): boolean;
  pasteText(text: string): void;
  dispatchKeyEvent(event: KeyEvent): void;
}

const FOCUS_CONFIRM_TIMEOUT_MS = 600;

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
  // (this is what makes iOS raise the keyboard); if the tap missed a remote
  // editable, the confirm timer dismisses it.
  handleTap = (): void => {
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
    }, FOCUS_CONFIRM_TIMEOUT_MS);
  };

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
