import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountGlassViewer, type GlassViewer } from "./index";

// The viewer's viewport reporting: the initial declaration is sent whenever
// signaling is open, a wrong first reading is corrected by a settled
// re-measure, and a size is only counted as sent once it was sent.

let rect = { width: 1278, height: 744 };
let observerCallback: (() => void) | null = null;

function fakeClient(connected: boolean) {
  return {
    isConnected: vi.fn(() => connected),
    on: vi.fn(() => () => {}),
    getVideoStream: vi.fn(() => null),
    sendInitialViewport: vi.fn(),
    setViewport: vi.fn(),
    reportPixelTraceSamples: vi.fn(),
  };
}

// One resize the observer reports, as a browser does after a layout change.
function observedResize() {
  observerCallback?.();
}

describe("viewport reporting", () => {
  let container: HTMLElement;
  let viewer: GlassViewer | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    rect = { width: 1278, height: 744 };
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () =>
        ({
          x: 0, y: 0, left: 0, top: 0, right: rect.width, bottom: rect.height,
          width: rect.width, height: rect.height, toJSON: () => ({}),
        }) as DOMRect
    );
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: (entries: { contentRect: { width: number; height: number } }[]) => void) {
          observerCallback = () => cb([{ contentRect: { width: rect.width, height: rect.height } }]);
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    viewer?.destroy();
    viewer = undefined;
    container.remove();
    observerCallback = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("declares the viewport at mount before the input channel is open", () => {
    // Mounted after "connected" fired but before the input channel opened:
    // isConnected() is still false, and "connected" won't fire again.
    const client = fakeClient(false);
    viewer = mountGlassViewer(container, client as any, { isMobile: false });
    expect(client.sendInitialViewport).toHaveBeenCalledTimes(1);
    expect(client.sendInitialViewport.mock.calls[0]!.slice(0, 2)).toEqual([1278, 744]);
  });

  it("corrects a wrong first reading even when the stage never resizes", () => {
    rect = { width: 1265, height: 200 };
    const client = fakeClient(true);
    viewer = mountGlassViewer(container, client as any, { isMobile: false });
    expect(client.sendInitialViewport.mock.calls[0]!.slice(0, 2)).toEqual([1264, 240]);

    // The layout settles; no resize is reported.
    rect = { width: 1278, height: 744 };
    vi.advanceTimersByTime(600);
    expect(client.setViewport).toHaveBeenCalledTimes(1);
    expect(client.setViewport).toHaveBeenCalledWith(1278, 744);
  });

  it("sends nothing more when the first reading was right", () => {
    const client = fakeClient(true);
    viewer = mountGlassViewer(container, client as any, { isMobile: false });
    vi.advanceTimersByTime(600);
    observedResize();
    vi.advanceTimersByTime(600);
    expect(client.setViewport).not.toHaveBeenCalled();
  });

  it("does not count a size as sent before the input channel is open", () => {
    let connected = false;
    const client = fakeClient(false);
    client.isConnected.mockImplementation(() => connected);
    viewer = mountGlassViewer(container, client as any, { isMobile: false });

    // A resize while the input channel is still closed: nothing can be sent.
    rect = { width: 1000, height: 600 };
    observedResize();
    vi.advanceTimersByTime(600);
    expect(client.setViewport).not.toHaveBeenCalled();

    // The channel opens, and the next resize report sends the size.
    connected = true;
    observedResize();
    vi.advanceTimersByTime(600);
    expect(client.setViewport).toHaveBeenCalledWith(1000, 600);
  });
});
