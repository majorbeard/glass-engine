import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountGlassViewer, type GlassViewer } from "./index";

// Regression tests: every "down" the viewer
// sends must get its "up", even when the release happens outside the video,
// after focus moves, or never reaches the page (blur, destroy).

function fakeClient() {
  return {
    isConnected: vi.fn(() => true),
    on: vi.fn(() => () => {}),
    getVideoStream: vi.fn(() => null),
    mouseMove: vi.fn(),
    mouseDown: vi.fn(),
    mouseUp: vi.fn(),
    scroll: vi.fn(),
    dispatchKeyEvent: vi.fn(),
    dispatchTouch: vi.fn(),
    sendInitialViewport: vi.fn(),
    setViewport: vi.fn(),
    navigate: vi.fn(),
    connect: vi.fn(),
    reportPixelTraceSamples: vi.fn(),
  };
}

describe("remote input is always released", () => {
  let container: HTMLElement;
  let client: ReturnType<typeof fakeClient>;
  let viewer: GlassViewer;
  let stage: HTMLElement;

  beforeEach(() => {
    // jsdom has no layout or media: give the stage a real-looking rect and
    // the <video> a real-looking size so input maps onto the video.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 1280, bottom: 720,
      width: 1280, height: 720, toJSON: () => ({}),
    } as DOMRect);
    vi.spyOn(HTMLVideoElement.prototype, "videoWidth", "get").mockReturnValue(1280);
    vi.spyOn(HTMLVideoElement.prototype, "videoHeight", "get").mockReturnValue(720);
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );

    container = document.createElement("div");
    document.body.appendChild(container);
    client = fakeClient();
    viewer = mountGlassViewer(container, client as any, { isMobile: false });
    stage = viewer.video.parentElement as HTMLElement;
  });

  afterEach(() => {
    viewer?.destroy();
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("mouse released outside the video: the remote button is released", () => {
    stage.dispatchEvent(new MouseEvent("mousedown", { clientX: 100, clientY: 100, button: 0, bubbles: true }));
    expect(client.mouseDown).toHaveBeenCalledTimes(1);

    stage.dispatchEvent(new MouseEvent("mouseleave", { clientX: 1300, clientY: 100 }));
    document.dispatchEvent(new MouseEvent("mouseup", { clientX: 1300, clientY: 100, button: 0, bubbles: true }));

    expect(client.mouseUp).toHaveBeenCalledTimes(1);
    // Released with the same button, at the pointer clamped to the video edge.
    expect(client.mouseUp.mock.calls[0]!.slice(0, 3)).toEqual([1280, 100, "left"]);
  });

  it("window loses focus with a modifier held: the remote modifier is released once", () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", code: "ShiftLeft", shiftKey: true }));
    const downs = client.dispatchKeyEvent.mock.calls.filter(([e]: any[]) => e.type === "keydown");
    expect(downs).toHaveLength(1);

    window.dispatchEvent(new Event("blur"));
    document.dispatchEvent(new Event("visibilitychange"));

    const ups = client.dispatchKeyEvent.mock.calls.filter(([e]: any[]) => e.type === "keyup");
    expect(ups).toHaveLength(1);
  });

  it("focus moves into a local input between keydown and keyup: the keyup still reaches the remote page", () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", code: "KeyA" }));
    expect(client.dispatchKeyEvent.mock.calls.filter(([e]: any[]) => e.type === "keydown")).toHaveLength(1);

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "a", code: "KeyA" }));
    input.remove();

    const ups = client.dispatchKeyEvent.mock.calls.filter(([e]: any[]) => e.type === "keyup");
    expect(ups).toHaveLength(1);
  });

  it("viewer destroyed with a key held: the remote key is released", () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Control", code: "ControlLeft", ctrlKey: true }));
    expect(client.dispatchKeyEvent.mock.calls.filter(([e]: any[]) => e.type === "keydown")).toHaveLength(1);

    viewer.destroy();
    viewer = mountGlassViewer(container, client as any, { isMobile: false });

    const ups = client.dispatchKeyEvent.mock.calls.filter(([e]: any[]) => e.type === "keyup");
    expect(ups).toHaveLength(1);
  });

  it("a key pressed while a local input has focus is not forwarded, down or up", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", code: "KeyB" }));
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "b", code: "KeyB" }));
    window.dispatchEvent(new Event("blur"));
    input.remove();

    expect(client.dispatchKeyEvent).not.toHaveBeenCalled();
  });

  it("a normal click inside the video sends exactly one down and one up", () => {
    stage.dispatchEvent(new MouseEvent("mousedown", { clientX: 200, clientY: 150, button: 0, bubbles: true }));
    stage.dispatchEvent(new MouseEvent("mouseup", { clientX: 210, clientY: 150, button: 0, bubbles: true }));
    window.dispatchEvent(new Event("blur"));

    expect(client.mouseDown).toHaveBeenCalledTimes(1);
    expect(client.mouseUp).toHaveBeenCalledTimes(1);
    expect(client.mouseUp.mock.calls[0]!.slice(0, 3)).toEqual([210, 150, "left"]);
  });
});
