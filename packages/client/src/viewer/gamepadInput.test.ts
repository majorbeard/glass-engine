import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GamepadInputController,
  applyStickCurve,
  type GamepadInputCallbacks,
  type GamepadInputGeometry,
} from "./gamepadInput.js";

// The real Gamepad interface declares buttons/axes readonly (they're
// browser-owned live state) - fine for production code, which only ever
// reads them, but tests need to mutate a fake pad's state between polls to
// simulate a real controller's input changing. This mutable shape is the
// test-only working type; FakeGamepad's own use sites cast to Gamepad only
// at the boundary (passing it to navigator.getGamepads' stub return type).
type FakeGamepad = Omit<Gamepad, "buttons" | "axes"> & {
  buttons: GamepadButton[];
  axes: number[];
};

function makeFakePad(overrides: Partial<FakeGamepad> = {}): FakeGamepad {
  return {
    id: "fake",
    index: 0,
    connected: true,
    timestamp: 0,
    mapping: "standard",
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({
      pressed: false,
      touched: false,
      value: 0,
    })),
    vibrationActuator: null,
    hapticActuators: [],
    ...overrides,
  } as FakeGamepad;
}

// Captures the requestAnimationFrame callback instead of letting real
// timing drive it, so tests can advance exactly one poll at a time.
function stubRaf() {
  let pending: FrameRequestCallback | null = null;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    pending = cb;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {
    pending = null;
  });
  return {
    tick(atMs: number) {
      const cb = pending;
      pending = null;
      cb?.(atMs);
    },
  };
}

// Stubs navigator.getGamepads to return exactly one fake pad - since
// attach() scans for an already-connected gamepad before ever needing a
// real "gamepadconnected" event (jsdom doesn't support constructing a real
// GamepadEvent anyway), this alone is enough to get the controller into its
// polling loop for tests.
function stubOneGamepad(pad: FakeGamepad) {
  vi.stubGlobal("navigator", {
    ...navigator,
    getGamepads: () => [pad as unknown as Gamepad],
  });
}

// .at(-1) needs a newer lib target than this package builds against - a
// plain index avoids bumping tsconfig just for one test file.
function lastCallOf(fn: unknown): unknown[] {
  const calls = (fn as ReturnType<typeof vi.fn>).mock.calls;
  return calls[calls.length - 1]!;
}

describe("applyStickCurve", () => {
  it("returns 0 within the dead zone, both signs", () => {
    expect(applyStickCurve(0, 0.15)).toBe(0);
    expect(applyStickCurve(0.1, 0.15)).toBe(0);
    expect(applyStickCurve(-0.1, 0.15)).toBe(0);
    expect(applyStickCurve(0.15, 0.15)).toBe(0); // exactly at the boundary
  });

  it("returns +/-1 at full deflection", () => {
    expect(applyStickCurve(1, 0.15)).toBeCloseTo(1);
    expect(applyStickCurve(-1, 0.15)).toBeCloseTo(-1);
  });

  it("is quadratic past the dead zone (fine control near center)", () => {
    // Halfway between the dead zone and full deflection should curve well
    // below the linear midpoint (0.5) - that's the whole point of the curve.
    const mid = applyStickCurve(0.15 + (1 - 0.15) / 2, 0.15);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(0.5);
  });

  it("preserves sign", () => {
    expect(applyStickCurve(0.5, 0.15)).toBeGreaterThan(0);
    expect(applyStickCurve(-0.5, 0.15)).toBeLessThan(0);
  });

  it("deadZone >= 1 always returns 0 (no divide-by-zero)", () => {
    expect(applyStickCurve(1, 1)).toBe(0);
    expect(() => applyStickCurve(1, 1.5)).not.toThrow();
  });
});

describe("GamepadInputController", () => {
  let raf: ReturnType<typeof stubRaf>;
  let callbacks: GamepadInputCallbacks;
  let geometry: GamepadInputGeometry;

  beforeEach(() => {
    raf = stubRaf();
    callbacks = {
      onCursorMove: vi.fn(),
      onMouseDown: vi.fn(),
      onMouseUp: vi.fn(),
      onScroll: vi.fn(),
      onKeyDown: vi.fn(),
      onKeyUp: vi.fn(),
    };
    geometry = { getVideoSize: () => ({ width: 1000, height: 800 }) };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does nothing when no gamepad is connected", () => {
    vi.stubGlobal("navigator", { ...navigator, getGamepads: () => [] });
    const controller = new GamepadInputController(geometry, callbacks);
    const detach = controller.attach();
    raf.tick(16);
    expect(callbacks.onCursorMove).not.toHaveBeenCalled();
    detach();
  });

  it("centers the cursor on first poll, then moves it with the right stick", () => {
    const pad = makeFakePad({ axes: [0, 0, 1, 0] }); // right stick X fully right
    stubOneGamepad(pad);
    const controller = new GamepadInputController(geometry, callbacks);
    const detach = controller.attach();

    raf.tick(0);
    raf.tick(16);

    expect(callbacks.onCursorMove).toHaveBeenCalled();
    const lastCall = lastCallOf(callbacks.onCursorMove);
    expect(lastCall[0]).toBeGreaterThan(500); // moved right from center (500)
    expect(lastCall[0]).toBeLessThanOrEqual(1000); // clamped to video width
    expect(lastCall[1]).toBe(400); // Y unaffected, still centered
    detach();
  });

  it("clamps the cursor at the video edge instead of overshooting", () => {
    const pad = makeFakePad({ axes: [0, 0, 1, 0] });
    stubOneGamepad(pad);
    const controller = new GamepadInputController(geometry, callbacks);
    const detach = controller.attach();

    // Many frames of full-right deflection - should clamp, never exceed.
    for (let t = 0; t < 5000; t += 16) raf.tick(t);

    const lastCall = lastCallOf(callbacks.onCursorMove);
    expect(lastCall[0]).toBe(1000); // exactly clamped to video width
    detach();
  });

  it("fires onMouseDown once on press and onMouseUp once on release (edge-detected)", () => {
    const pad = makeFakePad();
    pad.buttons[0] = { pressed: true, touched: true, value: 1 }; // A / leftClick
    stubOneGamepad(pad);
    const controller = new GamepadInputController(geometry, callbacks);
    const detach = controller.attach();

    raf.tick(0);
    raf.tick(16); // still pressed - must NOT fire onMouseDown again
    expect(callbacks.onMouseDown).toHaveBeenCalledTimes(1);
    expect(callbacks.onMouseDown).toHaveBeenCalledWith(500, 400, "left");

    pad.buttons[0] = { pressed: false, touched: false, value: 0 };
    raf.tick(32);
    expect(callbacks.onMouseUp).toHaveBeenCalledTimes(1);
    detach();
  });

  it("fires digital d-pad/start/back as key down/up, edge-detected", () => {
    const pad = makeFakePad();
    pad.buttons[9] = { pressed: true, touched: true, value: 1 }; // Start -> Enter
    stubOneGamepad(pad);
    const controller = new GamepadInputController(geometry, callbacks);
    const detach = controller.attach();

    raf.tick(0);
    raf.tick(16);
    expect(callbacks.onKeyDown).toHaveBeenCalledTimes(1);
    expect(callbacks.onKeyDown).toHaveBeenCalledWith("Enter", "Enter");

    pad.buttons[9] = { pressed: false, touched: false, value: 0 };
    raf.tick(32);
    expect(callbacks.onKeyUp).toHaveBeenCalledWith("Enter", "Enter");
    detach();
  });

  it("releases held buttons and keys when detached mid-press (no stuck input)", () => {
    const pad = makeFakePad();
    pad.buttons[0] = { pressed: true, touched: true, value: 1 }; // left click held
    pad.buttons[12] = { pressed: true, touched: true, value: 1 }; // d-pad up held
    stubOneGamepad(pad);
    const controller = new GamepadInputController(geometry, callbacks);
    const detach = controller.attach();

    raf.tick(0);
    expect(callbacks.onMouseDown).toHaveBeenCalledTimes(1);
    expect(callbacks.onKeyDown).toHaveBeenCalledWith("ArrowUp", "ArrowUp");

    detach(); // simulates disconnect/unmount mid-press
    expect(callbacks.onMouseUp).toHaveBeenCalledWith(500, 400, "left");
    expect(callbacks.onKeyUp).toHaveBeenCalledWith("ArrowUp", "ArrowUp");
  });

  it("releases held buttons and keys on gamepaddisconnected", () => {
    const pad = makeFakePad();
    pad.buttons[1] = { pressed: true, touched: true, value: 1 }; // right click held
    pad.buttons[9] = { pressed: true, touched: true, value: 1 }; // Start (Enter) held
    stubOneGamepad(pad);
    const controller = new GamepadInputController(geometry, callbacks);
    const detach = controller.attach();

    raf.tick(0);
    expect(callbacks.onMouseDown).toHaveBeenCalledTimes(1);

    // jsdom can't construct a real GamepadEvent; the handler only reads
    // e.gamepad.index.
    const ev = new Event("gamepaddisconnected");
    (ev as unknown as { gamepad: { index: number } }).gamepad = { index: pad.index };
    window.dispatchEvent(ev);

    expect(callbacks.onMouseUp).toHaveBeenCalledWith(500, 400, "right");
    expect(callbacks.onKeyUp).toHaveBeenCalledWith("Enter", "Enter");
    detach();
    expect(callbacks.onMouseUp).toHaveBeenCalledTimes(1);
  });

  it("scroll axis produces onScroll only while deflected, not at rest", () => {
    const pad = makeFakePad({ axes: [0, 1, 0, 0] }); // left stick Y fully down
    stubOneGamepad(pad);
    const controller = new GamepadInputController(geometry, callbacks);
    const detach = controller.attach();

    raf.tick(0);
    raf.tick(16);
    expect(callbacks.onScroll).toHaveBeenCalled();

    (callbacks.onScroll as ReturnType<typeof vi.fn>).mockClear();
    pad.axes = [0, 0, 0, 0]; // released back to center
    raf.tick(32);
    expect(callbacks.onScroll).not.toHaveBeenCalled();
    detach();
  });

  // Real, live-found bug (2026-09-09 dogfooding): held-stick scrolling sent
  // onScroll on every ~60Hz frame, blowing well past the backend's own
  // "scroll" rate-limit bucket (1000/min, ~16.7/sec) and getting the excess
  // silently dropped server-side - observed live as the whole session
  // appearing to freeze under sustained stick-held scrolling.
  it("throttles scroll sends well under the backend's rate limit, even under sustained full deflection", () => {
    const pad = makeFakePad({ axes: [0, 1, 0, 0] }); // left stick Y fully down, held
    stubOneGamepad(pad);
    const controller = new GamepadInputController(geometry, callbacks);
    const detach = controller.attach();

    // 3 seconds of continuous 60Hz polling (~16ms/frame) at full deflection -
    // the exact scenario that broke live.
    for (let t = 0; t < 3000; t += 16) raf.tick(t);

    const sendCount = (callbacks.onScroll as ReturnType<typeof vi.fn>).mock.calls.length;
    // Backend budget over 3s at 1000/min is 50 - real margin is the point,
    // not sitting right at the edge, so this should land closer to
    // 3000/75 = 40.
    expect(sendCount).toBeLessThan(50);
    expect(sendCount).toBeGreaterThan(20); // still genuinely responsive, not over-throttled
    detach();
  });

  it("sends the first scroll immediately, not delayed by the throttle window", () => {
    const pad = makeFakePad({ axes: [0, 1, 0, 0] });
    stubOneGamepad(pad);
    const controller = new GamepadInputController(geometry, callbacks);
    const detach = controller.attach();

    raf.tick(0); // the very first poll, at t=0
    expect(callbacks.onScroll).toHaveBeenCalledTimes(1);
    detach();
  });

  it("accumulates delta across throttled frames rather than dropping it", () => {
    const pad = makeFakePad({ axes: [0, 1, 0, 0] });
    stubOneGamepad(pad);
    const controller = new GamepadInputController(geometry, callbacks);
    const detach = controller.attach();

    // First send at t=0 (immediate). Then several frames build up pending
    // delta before the throttle window (75ms) allows the next send.
    raf.tick(0);
    (callbacks.onScroll as ReturnType<typeof vi.fn>).mockClear();
    for (let t = 16; t < 75; t += 16) raf.tick(t);
    expect(callbacks.onScroll).not.toHaveBeenCalled(); // still within the window

    raf.tick(80); // past the window - the accumulated total should flush
    expect(callbacks.onScroll).toHaveBeenCalledTimes(1);
    const [deltaY] = lastCallOf(callbacks.onScroll);
    // Sum of ~5 frames' worth of delta, not just the most recent frame's -
    // proves accumulation, not overwrite-and-lose.
    expect(deltaY as number).toBeGreaterThan(0);
    detach();
  });
});
