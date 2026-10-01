import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TouchInputController, type TouchInputCallbacks, type TouchInputGeometry } from "./touchInput.js";

// Date.now() control. touchInput.ts calls Date.now() directly (not
// performance.now() - see the plan's "Known limitations" section), so tests
// mock it directly rather than using vitest's fake timers (no setTimeout is
// used anywhere in this file).
let currentTime = 0;
function setNow(ms: number): void {
  currentTime = ms;
}

// jsdom has no real TouchEvent/Touch, and this controller only ever reads
// .changedTouches - a minimal hand-rolled fake is sufficient and more
// controllable than a polyfill.
function fakeTouch(clientX: number, clientY: number, identifier = 0): Touch {
  return { clientX, clientY, identifier } as Touch;
}
function touchEvent(touches: Touch[]): TouchEvent {
  return {
    preventDefault: vi.fn(),
    changedTouches: touches as unknown as TouchList,
  } as unknown as TouchEvent;
}

// getContainerRect/getVideoSize returning null makes toPoints() always
// return [] - onTouchPoints never fires, but tap detection (purely local, by
// design - see the controller's own comment) still runs. This isolates the
// tap-classification logic under test from the coordinate-mapping path,
// which is covered separately by clientToVideoPoint.
const inertGeometry: TouchInputGeometry = {
  getContainerRect: () => null,
  getVideoSize: () => null,
};

function makeController(onTap = vi.fn()) {
  const onTouchPoints = vi.fn();
  const callbacks: TouchInputCallbacks = { onTouchPoints, onTap };
  const controller = new TouchInputController(inertGeometry, callbacks);
  // Private handlers are arrow-function fields; accessing them by name from
  // outside the class is a compile-time-only restriction, not a runtime one.
  const c = controller as unknown as {
    handleTouchStart: (e: TouchEvent) => void;
    handleTouchMove: (e: TouchEvent) => void;
    handleTouchEnd: (e: TouchEvent) => void;
    handleTouchCancel: (e: TouchEvent) => void;
  };
  return { controller, onTap, onTouchPoints, ...c };
}

describe("TouchInputController tap classification", () => {
  beforeEach(() => {
    currentTime = 0;
    vi.spyOn(Date, "now").mockImplementation(() => currentTime);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fires onTap for a stationary tap with no touchmove", () => {
    const { handleTouchStart, handleTouchEnd, onTap } = makeController();
    setNow(0);
    handleTouchStart(touchEvent([fakeTouch(100, 100)]));
    setNow(100);
    handleTouchEnd(touchEvent([fakeTouch(100, 100)]));
    expect(onTap).toHaveBeenCalledTimes(1);
  });

  it("fires onTap for a tap with small jitter within the movement threshold", () => {
    const { handleTouchStart, handleTouchMove, handleTouchEnd, onTap } = makeController();
    setNow(0);
    handleTouchStart(touchEvent([fakeTouch(100, 100)]));
    setNow(20);
    handleTouchMove(touchEvent([fakeTouch(102, 101)]));
    setNow(50);
    handleTouchEnd(touchEvent([fakeTouch(103, 102)]));
    expect(onTap).toHaveBeenCalledTimes(1);
  });

  it("falls back to displacement/duration only when the last touchmove sample is stale", () => {
    const { handleTouchStart, handleTouchMove, handleTouchEnd, onTap } = makeController();
    setNow(0);
    handleTouchStart(touchEvent([fakeTouch(100, 100)]));
    // A touchmove far away, but old enough (> TAP_VELOCITY_SAMPLE_MAX_AGE_MS
    // relative to touchend) that it must NOT feed the velocity veto.
    setNow(10);
    handleTouchMove(touchEvent([fakeTouch(300, 300)]));
    setNow(250);
    handleTouchEnd(touchEvent([fakeTouch(100, 105)]));
    expect(onTap).toHaveBeenCalledTimes(1);
  });

  it("fires onTap at the movement boundary when release velocity is low", () => {
    const { handleTouchStart, handleTouchMove, handleTouchEnd, onTap } = makeController();
    setNow(0);
    handleTouchStart(touchEvent([fakeTouch(0, 0)]));
    setNow(50);
    handleTouchMove(touchEvent([fakeTouch(0, 0)]));
    setNow(100);
    // Exactly at TAP_MAX_MOVEMENT_PX (10px), all of it in the final segment.
    handleTouchEnd(touchEvent([fakeTouch(10, 0)]));
    expect(onTap).toHaveBeenCalledTimes(1);
  });

  it("does not fire onTap for a short flick with a fast final segment", () => {
    const { handleTouchStart, handleTouchMove, handleTouchEnd, onTap } = makeController();
    setNow(0);
    handleTouchStart(touchEvent([fakeTouch(100, 100)]));
    // Passes elapsed/moved alone (100ms, 8px net) but the last 5ms covered
    // 8px - well above TAP_MAX_RELEASE_VELOCITY_PX_MS.
    setNow(95);
    handleTouchMove(touchEvent([fakeTouch(100, 100)]));
    setNow(100);
    handleTouchEnd(touchEvent([fakeTouch(108, 100)]));
    expect(onTap).not.toHaveBeenCalled();
  });

  it("does not fire onTap for a large-displacement drag", () => {
    const { handleTouchStart, handleTouchEnd, onTap } = makeController();
    setNow(0);
    handleTouchStart(touchEvent([fakeTouch(0, 0)]));
    setNow(100);
    handleTouchEnd(touchEvent([fakeTouch(50, 0)]));
    expect(onTap).not.toHaveBeenCalled();
  });

  it("does not fire onTap for a long press regardless of release velocity", () => {
    const { handleTouchStart, handleTouchMove, handleTouchEnd, onTap } = makeController();
    setNow(0);
    handleTouchStart(touchEvent([fakeTouch(100, 100)]));
    setNow(350);
    handleTouchMove(touchEvent([fakeTouch(100, 100)]));
    setNow(400);
    handleTouchEnd(touchEvent([fakeTouch(100, 100)]));
    expect(onTap).not.toHaveBeenCalled();
  });

  it("does not let a same-millisecond sample (dt=0) explode into a wrongful veto", () => {
    const { handleTouchStart, handleTouchMove, handleTouchEnd, onTap } = makeController();
    setNow(0);
    handleTouchStart(touchEvent([fakeTouch(100, 100)]));
    setNow(100);
    handleTouchMove(touchEvent([fakeTouch(100, 100)]));
    // Same timestamp as the touchmove above (dt=0) and same position
    // (dist=0). Without the Math.max(dt, 1) guard this is 0/0 = NaN, and
    // `NaN <= threshold` is false - which would wrongly veto a genuinely
    // stationary tap.
    handleTouchEnd(touchEvent([fakeTouch(100, 100)]));
    expect(onTap).toHaveBeenCalledTimes(1);
  });

  it("clears touchStart/lastMove on touchcancel so a stray touchend is ignored", () => {
    const { handleTouchStart, handleTouchMove, handleTouchCancel, handleTouchEnd, onTap } =
      makeController();
    setNow(0);
    handleTouchStart(touchEvent([fakeTouch(100, 100)]));
    setNow(10);
    handleTouchMove(touchEvent([fakeTouch(100, 100)]));
    setNow(20);
    handleTouchCancel(touchEvent([]));
    setNow(30);
    handleTouchEnd(touchEvent([fakeTouch(100, 100)]));
    expect(onTap).not.toHaveBeenCalled();
  });

  it("still classifies a dropped gesture (zero-point touchstart) locally, without forwarding it", () => {
    const { handleTouchStart, handleTouchEnd, onTap, onTouchPoints } = makeController();
    setNow(0);
    // inertGeometry means toPoints() is always [] regardless, so every
    // gesture in this suite is already "dropped" from the backend's
    // perspective - this test asserts that explicitly.
    handleTouchStart(touchEvent([fakeTouch(100, 100)]));
    setNow(50);
    handleTouchEnd(touchEvent([fakeTouch(100, 100)]));
    expect(onTap).toHaveBeenCalledTimes(1);
    expect(onTouchPoints).not.toHaveBeenCalled();
  });

  it("passes null to onTap when geometry is unavailable (inertGeometry, every test above)", () => {
    const { handleTouchStart, handleTouchEnd, onTap } = makeController();
    setNow(0);
    handleTouchStart(touchEvent([fakeTouch(100, 100)]));
    setNow(50);
    handleTouchEnd(touchEvent([fakeTouch(100, 100)]));
    expect(onTap).toHaveBeenCalledWith(null);
  });

  it("computes and passes the tap's video-space point when geometry is available", () => {
    // containerRect 200x100 at origin, video 400x200 -> 2x scale on both axes.
    const geometry: TouchInputGeometry = {
      getContainerRect: () => ({ left: 0, top: 0, width: 200, height: 100 }) as DOMRect,
      getVideoSize: () => ({ width: 400, height: 200 }),
    };
    const onTap = vi.fn();
    const controller = new TouchInputController(geometry, { onTouchPoints: vi.fn(), onTap });
    const c = controller as unknown as {
      handleTouchStart: (e: TouchEvent) => void;
      handleTouchEnd: (e: TouchEvent) => void;
    };
    setNow(0);
    c.handleTouchStart(touchEvent([fakeTouch(50, 25)]));
    setNow(50);
    c.handleTouchEnd(touchEvent([fakeTouch(50, 25)]));
    expect(onTap).toHaveBeenCalledWith({ x: 100, y: 50 });
  });
});
