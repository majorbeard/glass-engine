// Gamepad-input controller for the viewer. It lives entirely client-side.
//
// A gamepad is an input DEVICE, not a new input action type: it drives the
// exact same mouse/keyboard actions a real mouse and keyboard already
// produce (via the callbacks below, which the viewer wires to
// client.mouseMove/mouseDown/mouseUp/scroll/dispatchKeyEvent - the same
// calls real mouse/touch/keyboard input already use). The backend never
// needs to know a gamepad exists.
//
// Single-controller only for v1 (the first one connected) - multi-controller
// support is an open question in the design doc, not decided.

// The engine's "scroll" rate-limit bucket is 1000/min (~16.7/sec). 75ms
// (~13.3/sec) leaves real margin under that rather than sitting right at
// the edge where normal timer jitter could still occasionally trip it.
const SCROLL_SEND_INTERVAL_MS = 75;

// --- Mapping ---

export interface GamepadButtonMapping {
  // Button indices (W3C Standard Gamepad layout) that fire a left/right
  // click at the current cursor position. Two indices each by default (a
  // face button and a trigger) since real controllers commonly offer both.
  leftClick: number[];
  rightClick: number[];
  dpadUp: number;
  dpadDown: number;
  dpadLeft: number;
  dpadRight: number;
  enter: number; // Start
  escape: number; // Back/Select
}

export interface GamepadAxisMapping {
  cursorX: number; // right stick X - default axis 2
  cursorY: number; // right stick Y - default axis 3
  scrollX: number; // left stick X - default axis 0
  scrollY: number; // left stick Y - default axis 1
}

export interface GamepadMapping {
  // Fraction (0..1) of stick travel near center ignored, to avoid
  // drift/twitchiness from imprecise analog sticks at rest.
  deadZone: number;
  // Pixels/second of cursor movement at full stick deflection (after the
  // dead zone + acceleration curve below are applied).
  cursorSensitivity: number;
  // Scroll units/second at full stick deflection.
  scrollSensitivity: number;
  buttons: GamepadButtonMapping;
  axes: GamepadAxisMapping;
}

export const DEFAULT_GAMEPAD_MAPPING: GamepadMapping = {
  deadZone: 0.15,
  cursorSensitivity: 900,
  scrollSensitivity: 700,
  buttons: {
    leftClick: [0, 7], // A / Cross, RT / R2
    rightClick: [1, 6], // B / Circle, LT / L2
    dpadUp: 12,
    dpadDown: 13,
    dpadLeft: 14,
    dpadRight: 15,
    enter: 9, // Start
    escape: 8, // Back / Select
  },
  axes: { cursorX: 2, cursorY: 3, scrollX: 0, scrollY: 1 },
};

function mergeMapping(override?: Partial<GamepadMapping>): GamepadMapping {
  if (!override) return DEFAULT_GAMEPAD_MAPPING;
  return {
    ...DEFAULT_GAMEPAD_MAPPING,
    ...override,
    buttons: { ...DEFAULT_GAMEPAD_MAPPING.buttons, ...override.buttons },
    axes: { ...DEFAULT_GAMEPAD_MAPPING.axes, ...override.axes },
  };
}

// Pure, independently testable: dead zone + a quadratic acceleration curve.
// A raw linear deflection-to-speed mapping feels twitchy near center and
// sluggish at full deflection - see gamepad_input.md's own reasoning.
// Returns a signed value in [-1, 1], 0 within the dead zone.
export function applyStickCurve(raw: number, deadZone: number): number {
  const magnitude = Math.abs(raw);
  if (magnitude <= deadZone) return 0;
  if (deadZone >= 1) return 0;
  const rescaled = (magnitude - deadZone) / (1 - deadZone);
  const curved = rescaled * rescaled;
  return raw < 0 ? -curved : curved;
}

// --- Controller ---

export interface GamepadInputGeometry {
  getVideoSize: () => { width: number; height: number } | null;
}

export interface GamepadInputCallbacks {
  onCursorMove: (x: number, y: number, dragging: boolean) => void;
  onMouseDown: (x: number, y: number, button: "left" | "right") => void;
  onMouseUp: (x: number, y: number, button: "left" | "right") => void;
  onScroll: (deltaY: number, deltaX: number) => void;
  onKeyDown: (key: string, code: string) => void;
  onKeyUp: (key: string, code: string) => void;
}

// One controller only (the first connected) - a second gamepadconnected
// while one is already active is ignored, matching the "single controller
// for v1" decision. gamepaddisconnected always releases every currently-
// held button/key first, so a controller yanked mid-press never leaves a
// stuck mouse button or key down on the remote page.
export class GamepadInputController {
  private readonly mapping: GamepadMapping;
  private readonly geometry: GamepadInputGeometry;
  private readonly callbacks: GamepadInputCallbacks;

  private padIndex: number | null = null;
  private rafId: number | null = null;
  private lastFrameAt: number | null = null;

  private cursorX = 0;
  private cursorY = 0;
  private cursorInitialized = false;

  private leftHeld = false;
  private rightHeld = false;

  // Scroll throttle state - see pollScroll's own doc comment for why this
  // exists: real, live-found (2026-09-09 dogfooding) bug. client.scroll()
  // has no throttling of its own (built for sparse, human-timed wheel
  // notches, unlike mouseMove which already batches), and this
  // controller's ~60Hz poll loop was calling it on every single frame
  // while a stick stayed deflected - up to 4x the backend's own "scroll"
  // rate-limit bucket (1000/min = ~16.7/sec), so the server started dropping the excess outright,
  // observed live as the whole engine appearing to "brick" under sustained
  // stick-held scrolling before eventually recovering.
  private pendingScrollX = 0;
  private pendingScrollY = 0;
  // -Infinity, not 0: requestAnimationFrame timestamps start near 0 too, so
  // initializing this to 0 would make the very first poll look like it just
  // sent (0 - 0 < interval) and delay the first real scroll response by up
  // to a full SCROLL_SEND_INTERVAL_MS for no reason.
  private lastScrollSentAt = -Infinity;
  // Edge-detected digital buttons (d-pad/start/back) - tracks which are
  // currently held so a keydown fires once on press and a keyup once on
  // release, not every animation frame while held.
  private heldDigital = new Set<"up" | "down" | "left" | "right" | "enter" | "escape">();

  constructor(
    geometry: GamepadInputGeometry,
    callbacks: GamepadInputCallbacks,
    mapping?: Partial<GamepadMapping>
  ) {
    this.geometry = geometry;
    this.callbacks = callbacks;
    this.mapping = mergeMapping(mapping);
  }

  // Returns a detach function, mirroring TouchInputController.attach's own
  // convention.
  attach(): () => void {
    const onConnect = (e: GamepadEvent) => {
      if (this.padIndex !== null) return; // already have one - v1 is single-controller
      this.padIndex = e.gamepad.index;
      this.startLoop();
    };
    const onDisconnect = (e: GamepadEvent) => {
      if (e.gamepad.index !== this.padIndex) return;
      this.stopLoop();
      this.padIndex = null;
      this.cursorInitialized = false;
    };
    window.addEventListener("gamepadconnected", onConnect);
    window.addEventListener("gamepaddisconnected", onDisconnect);

    // A controller already connected (and already used, per the Gamepad API's
    // own real-user-gesture requirement) before this controller attached -
    // e.g. mountGlassViewer called after the operator already pressed a
    // button - never fires its own gamepadconnected event again for us to
    // catch. Pick it up now if present.
    const existing = navigator.getGamepads?.() ?? [];
    for (const pad of existing) {
      if (pad) {
        this.padIndex = pad.index;
        this.startLoop();
        break;
      }
    }

    return () => {
      window.removeEventListener("gamepadconnected", onConnect);
      window.removeEventListener("gamepaddisconnected", onDisconnect);
      this.stopLoop();
    };
  }

  private startLoop(): void {
    this.lastFrameAt = null;
    const tick = (now: number) => {
      this.poll(now);
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopLoop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.releaseAllHeld();
  }

  private releaseAllHeld(): void {
    if (this.leftHeld) {
      this.callbacks.onMouseUp(this.cursorX, this.cursorY, "left");
      this.leftHeld = false;
    }
    if (this.rightHeld) {
      this.callbacks.onMouseUp(this.cursorX, this.cursorY, "right");
      this.rightHeld = false;
    }
    for (const held of this.heldDigital) {
      this.fireDigitalUp(held);
    }
    this.heldDigital.clear();
  }

  private poll(now: number): void {
    if (this.padIndex === null) return;
    const pad = (navigator.getGamepads?.() ?? [])[this.padIndex];
    if (!pad) return; // index can go stale between disconnect and our own handler running

    const dt = this.lastFrameAt === null ? 1 / 60 : (now - this.lastFrameAt) / 1000;
    this.lastFrameAt = now;

    this.pollCursorAndClicks(pad, dt);
    this.pollScroll(pad, dt, now);
    this.pollDigital(pad);
  }

  private pollCursorAndClicks(pad: Gamepad, dt: number): void {
    const size = this.geometry.getVideoSize();
    if (!size) return;
    if (!this.cursorInitialized) {
      this.cursorX = size.width / 2;
      this.cursorY = size.height / 2;
      this.cursorInitialized = true;
    }

    const rawX = pad.axes[this.mapping.axes.cursorX] ?? 0;
    const rawY = pad.axes[this.mapping.axes.cursorY] ?? 0;
    const curvedX = applyStickCurve(rawX, this.mapping.deadZone);
    const curvedY = applyStickCurve(rawY, this.mapping.deadZone);

    if (curvedX !== 0 || curvedY !== 0) {
      this.cursorX = clamp(
        this.cursorX + curvedX * this.mapping.cursorSensitivity * dt,
        0,
        size.width
      );
      this.cursorY = clamp(
        this.cursorY + curvedY * this.mapping.cursorSensitivity * dt,
        0,
        size.height
      );
      this.callbacks.onCursorMove(this.cursorX, this.cursorY, this.leftHeld || this.rightHeld);
    }

    this.pollClickButton(pad, this.mapping.buttons.leftClick, "left");
    this.pollClickButton(pad, this.mapping.buttons.rightClick, "right");
  }

  private pollClickButton(pad: Gamepad, indices: number[], button: "left" | "right"): void {
    const pressed = indices.some((i) => pad.buttons[i]?.pressed);
    const heldKey = button === "left" ? "leftHeld" : "rightHeld";
    if (pressed && !this[heldKey]) {
      this[heldKey] = true;
      this.callbacks.onMouseDown(this.cursorX, this.cursorY, button);
    } else if (!pressed && this[heldKey]) {
      this[heldKey] = false;
      this.callbacks.onMouseUp(this.cursorX, this.cursorY, button);
    }
  }

  // Accumulates every frame's delta but only actually calls onScroll once
  // per SCROLL_SEND_INTERVAL_MS - see pendingScrollX/Y's own doc comment
  // for the real bug this fixes. Accumulating (not overwriting) between
  // sends means holding the stick deflected for, say, 75ms and sending
  // once produces the same total scroll distance as sending every 16ms
  // and getting throttled - it changes the message rate, not how far the
  // page actually scrolls.
  private pollScroll(pad: Gamepad, dt: number, now: number): void {
    const rawX = pad.axes[this.mapping.axes.scrollX] ?? 0;
    const rawY = pad.axes[this.mapping.axes.scrollY] ?? 0;
    const curvedX = applyStickCurve(rawX, this.mapping.deadZone);
    const curvedY = applyStickCurve(rawY, this.mapping.deadZone);
    if (curvedX !== 0 || curvedY !== 0) {
      this.pendingScrollX += curvedX * this.mapping.scrollSensitivity * dt;
      this.pendingScrollY += curvedY * this.mapping.scrollSensitivity * dt;
    }
    if (this.pendingScrollX === 0 && this.pendingScrollY === 0) return;
    if (now - this.lastScrollSentAt < SCROLL_SEND_INTERVAL_MS) return;

    this.callbacks.onScroll(this.pendingScrollY, this.pendingScrollX);
    this.pendingScrollX = 0;
    this.pendingScrollY = 0;
    this.lastScrollSentAt = now;
  }

  private pollDigital(pad: Gamepad): void {
    const b = this.mapping.buttons;
    this.pollDigitalButton(pad, b.dpadUp, "up");
    this.pollDigitalButton(pad, b.dpadDown, "down");
    this.pollDigitalButton(pad, b.dpadLeft, "left");
    this.pollDigitalButton(pad, b.dpadRight, "right");
    this.pollDigitalButton(pad, b.enter, "enter");
    this.pollDigitalButton(pad, b.escape, "escape");
  }

  private pollDigitalButton(
    pad: Gamepad,
    index: number,
    action: "up" | "down" | "left" | "right" | "enter" | "escape"
  ): void {
    const pressed = pad.buttons[index]?.pressed ?? false;
    const wasHeld = this.heldDigital.has(action);
    if (pressed && !wasHeld) {
      this.heldDigital.add(action);
      this.fireDigitalDown(action);
    } else if (!pressed && wasHeld) {
      this.heldDigital.delete(action);
      this.fireDigitalUp(action);
    }
  }

  private digitalKeyAndCode(
    action: "up" | "down" | "left" | "right" | "enter" | "escape"
  ): { key: string; code: string } {
    switch (action) {
      case "up":
        return { key: "ArrowUp", code: "ArrowUp" };
      case "down":
        return { key: "ArrowDown", code: "ArrowDown" };
      case "left":
        return { key: "ArrowLeft", code: "ArrowLeft" };
      case "right":
        return { key: "ArrowRight", code: "ArrowRight" };
      case "enter":
        return { key: "Enter", code: "Enter" };
      case "escape":
        return { key: "Escape", code: "Escape" };
    }
  }

  private fireDigitalDown(action: "up" | "down" | "left" | "right" | "enter" | "escape"): void {
    const { key, code } = this.digitalKeyAndCode(action);
    this.callbacks.onKeyDown(key, code);
  }

  private fireDigitalUp(action: "up" | "down" | "left" | "right" | "enter" | "escape"): void {
    const { key, code } = this.digitalKeyAndCode(action);
    this.callbacks.onKeyUp(key, code);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}
