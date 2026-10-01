import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileKeyboardController, type KeyboardTarget } from "./mobileKeyboard.js";

function makeTarget(overrides: Partial<KeyboardTarget> = {}): KeyboardTarget {
  return {
    isConnected: () => true,
    pasteText: vi.fn(),
    dispatchKeyEvent: vi.fn(),
    // Resolves null by default: setRttMs(null) is a harmless no-op (see its
    // own guard), so the fire-and-forget refresh in handleTap doesn't
    // interfere with tests that drive RTT directly via setRttMs().
    getStats: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

function setup(enabled = true, target: KeyboardTarget = makeTarget()) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const controller = new MobileKeyboardController(container, target, enabled);
  const input = container.querySelector("input");
  return { container, controller, input, target };
}

describe("MobileKeyboardController", () => {
  beforeEach(() => {
    // Both files call Date.now() directly (not performance.now()), and
    // mobileKeyboard.ts uses setTimeout/clearTimeout for the confirm timer.
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("enabled=false creates no input and handleTap is a no-op", () => {
    const { container, controller } = setup(false);
    expect(container.querySelector("input")).toBeNull();
    expect(() => controller.handleTap(null)).not.toThrow();
  });

  it("enabled=true synchronously focuses the hidden input on tap", () => {
    const { controller, input } = setup(true);
    expect(input).not.toBeNull();
    controller.handleTap(null);
    expect(document.activeElement).toBe(input);
  });

  it("blurs if not confirmed before the timeout", () => {
    const { controller, input } = setup(true);
    controller.handleTap(null);
    vi.advanceTimersByTime(600);
    expect(document.activeElement).not.toBe(input);
  });

  it("stays focused if confirmed before the timeout", () => {
    const { controller, input } = setup(true);
    controller.handleTap(null);
    vi.advanceTimersByTime(300);
    controller.setEditableFocused(true);
    vi.advanceTimersByTime(600);
    expect(document.activeElement).toBe(input);
  });

  it("setEditableFocused(false) blurs immediately regardless of timer state", () => {
    const { controller, input } = setup(true);
    controller.handleTap(null);
    controller.setEditableFocused(true);
    controller.setEditableFocused(false);
    expect(document.activeElement).not.toBe(input);
  });

  describe("RTT-adaptive confirm timeout", () => {
    it("boundary: still focused just before 600ms, blurred at 600ms with no RTT sample", () => {
      const { controller, input } = setup(true);
      controller.handleTap(null);
      vi.advanceTimersByTime(599);
      expect(document.activeElement).toBe(input);
      vi.advanceTimersByTime(1);
      expect(document.activeElement).not.toBe(input);
    });

    it("low RTT still floors at 600ms - never shorter than today's baseline", () => {
      const { controller, input } = setup(true);
      controller.setRttMs(10);
      controller.handleTap(null);
      vi.advanceTimersByTime(599);
      expect(document.activeElement).toBe(input);
      vi.advanceTimersByTime(1);
      expect(document.activeElement).not.toBe(input);
    });

    it("high RTT keeps a late-but-genuine confirmation from being wrongly dismissed", () => {
      const { controller, input } = setup(true);
      controller.setRttMs(500); // -> clamp(3*500+200, 600, 2500) = 1700ms window
      controller.handleTap(null);
      // Past the OLD flat 600ms floor - under today's baseline this
      // confirmation would already have been dismissed - but within the
      // new RTT-stretched window, so it lands correctly. This is the
      // end-to-end regression test for the actual bug being fixed.
      vi.advanceTimersByTime(650);
      controller.setEditableFocused(true);
      vi.advanceTimersByTime(2000);
      expect(document.activeElement).toBe(input);
    });

    it("a stale RTT sample falls back to exactly 600ms", () => {
      const { controller, input } = setup(true);
      controller.setRttMs(500);
      vi.advanceTimersByTime(30_001); // past RTT_SAMPLE_MAX_AGE_MS
      controller.handleTap(null);
      vi.advanceTimersByTime(599);
      expect(document.activeElement).toBe(input);
      vi.advanceTimersByTime(1);
      expect(document.activeElement).not.toBe(input);
    });

    it("does not throw or block focus when getStats() rejects", async () => {
      const target = makeTarget({
        getStats: vi.fn().mockRejectedValue(new Error("boom")),
      });
      const { controller, input } = setup(true, target);
      expect(() => controller.handleTap(null)).not.toThrow();
      expect(document.activeElement).toBe(input);
      // Let the rejected promise's .catch() run; if it weren't handled,
      // vitest would report an unhandled rejection and fail this test.
      await Promise.resolve();
      await Promise.resolve();
    });

    it("rejects NaN/negative/Infinity RTT values - floor behavior unchanged", () => {
      const { controller, input } = setup(true);
      controller.setRttMs(Number.NaN);
      controller.setRttMs(-5);
      controller.setRttMs(Number.POSITIVE_INFINITY);
      controller.handleTap(null);
      vi.advanceTimersByTime(599);
      expect(document.activeElement).toBe(input);
      vi.advanceTimersByTime(1);
      expect(document.activeElement).not.toBe(input);
    });
  });

  describe("stats fetch throttling", () => {
    it("does not re-fetch stats on a second tap within the throttle window", () => {
      const target = makeTarget();
      const { controller } = setup(true, target);
      controller.handleTap(null);
      vi.advanceTimersByTime(1000); // well under RTT_REFRESH_MIN_INTERVAL_MS
      controller.handleTap(null);
      expect(target.getStats).toHaveBeenCalledTimes(1);
    });

    it("re-fetches stats once the throttle window elapses", () => {
      const target = makeTarget();
      const { controller } = setup(true, target);
      controller.handleTap(null);
      vi.advanceTimersByTime(3000); // >= RTT_REFRESH_MIN_INTERVAL_MS
      controller.handleTap(null);
      expect(target.getStats).toHaveBeenCalledTimes(2);
    });
  });

  describe("interactive-element hit-testing", () => {
    it("a confident hit still uses the normal (longer) confirm window, not the short miss timeout", () => {
      const { controller, input } = setup(true);
      controller.setInteractiveElements([{ x: 0, y: 0, width: 100, height: 100 }]);
      controller.handleTap({ x: 50, y: 50 }); // inside the cached rect
      vi.advanceTimersByTime(150); // MISS_CONFIRM_TIMEOUT_MS - must NOT have fired
      expect(document.activeElement).toBe(input);
      vi.advanceTimersByTime(450); // total 600 - the normal floor
      expect(document.activeElement).not.toBe(input);
    });

    it("a confident miss still focuses (unconditional), but dismisses on the short timeout", () => {
      const { controller, input } = setup(true);
      controller.setInteractiveElements([{ x: 1000, y: 1000, width: 10, height: 10 }]);
      controller.handleTap({ x: 50, y: 50 }); // nowhere near the cached rect
      expect(document.activeElement).toBe(input); // focus() is unconditional
      vi.advanceTimersByTime(149);
      expect(document.activeElement).toBe(input);
      vi.advanceTimersByTime(1); // total 150 - MISS_CONFIRM_TIMEOUT_MS
      expect(document.activeElement).not.toBe(input);
    });

    it("no point (geometry unavailable) falls back to the normal window even with a fresh cache", () => {
      const { controller, input } = setup(true);
      controller.setInteractiveElements([{ x: 1000, y: 1000, width: 10, height: 10 }]);
      controller.handleTap(null);
      vi.advanceTimersByTime(150); // would have fired if the short timeout applied
      expect(document.activeElement).toBe(input);
      vi.advanceTimersByTime(450); // total 600 - the normal floor
      expect(document.activeElement).not.toBe(input);
    });

    it("a stale cache falls back to the normal window even for a miss point", () => {
      const { controller, input } = setup(true);
      controller.setInteractiveElements([{ x: 1000, y: 1000, width: 10, height: 10 }]);
      vi.advanceTimersByTime(5001); // past INTERACTIVE_ELEMENTS_MAX_AGE_MS
      controller.handleTap({ x: 50, y: 50 });
      vi.advanceTimersByTime(150);
      expect(document.activeElement).toBe(input);
      vi.advanceTimersByTime(450);
      expect(document.activeElement).not.toBe(input);
    });

    it("an empty cache (never received a push) falls back to the normal window", () => {
      const { controller, input } = setup(true);
      controller.handleTap({ x: 50, y: 50 });
      vi.advanceTimersByTime(150);
      expect(document.activeElement).toBe(input);
      vi.advanceTimersByTime(450);
      expect(document.activeElement).not.toBe(input);
    });

    it("setInteractiveElements drops individually malformed entries but keeps valid ones", () => {
      const { controller, input } = setup(true);
      controller.setInteractiveElements([
        { x: Number.NaN, y: 0, width: 10, height: 10 },
        { x: 0, y: 0, width: 10, height: 10 },
      ]);
      controller.handleTap({ x: 5, y: 5 }); // inside the valid second element
      vi.advanceTimersByTime(150); // would have fired if treated as a miss
      expect(document.activeElement).toBe(input);
    });

    it("a cache left with zero valid entries (all malformed) is a confident miss for any point", () => {
      const { controller, input } = setup(true);
      controller.setInteractiveElements([{ x: Number.NaN, y: 0, width: 10, height: 10 }]);
      controller.handleTap({ x: 5, y: 5 });
      vi.advanceTimersByTime(150);
      expect(document.activeElement).not.toBe(input);
    });
  });

  it("destroy() clears the pending confirm timer", () => {
    const { controller, input } = setup(true);
    expect(input).not.toBeNull();
    controller.handleTap(null);
    const blurSpy = vi.spyOn(input as HTMLInputElement, "blur");
    controller.destroy();
    vi.advanceTimersByTime(1000);
    expect(blurSpy).not.toHaveBeenCalled();
  });
});
