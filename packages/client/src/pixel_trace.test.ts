import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PixelTraceSampler, supportsPixelTrace, type PixelTraceSample } from "./pixel_trace.js";

// fakeVideo builds a minimal stand-in for HTMLVideoElement's rVFC surface -
// jsdom doesn't implement requestVideoFrameCallback at all, and even if it
// did, these tests need full manual control over exactly when/what a
// "frame" delivers, not real animation-frame timing.
function fakeVideo(supportsRVFC = true) {
  let nextHandle = 1;
  const pending = new Map<number, (now: number, metadata: unknown) => void>();
  const video = {
    cancelVideoFrameCallback: vi.fn((handle: number) => {
      pending.delete(handle);
    }),
  } as unknown as HTMLVideoElement & {
    __fireFrame: (metadata: { presentationTime: number; rtpTimestamp?: number }) => void;
    __pendingCount: () => number;
  };

  if (supportsRVFC) {
    (video as unknown as Record<string, unknown>).requestVideoFrameCallback = vi.fn(
      (cb: (now: number, metadata: unknown) => void) => {
        const handle = nextHandle++;
        pending.set(handle, cb);
        return handle;
      }
    );
  }

  // Simulates the browser invoking whichever callback is currently
  // pending (there is at most one at a time, since PixelTraceSampler only
  // ever re-arms after the previous one fires).
  video.__fireFrame = (metadata) => {
    const entry = Array.from(pending.entries())[0];
    if (!entry) throw new Error("__fireFrame called with no pending callback");
    const [handle, cb] = entry;
    pending.delete(handle);
    cb(metadata.presentationTime, metadata);
  };
  video.__pendingCount = () => pending.size;

  return video;
}

describe("supportsPixelTrace", () => {
  it("returns false when requestVideoFrameCallback is missing", () => {
    const video = fakeVideo(false);
    expect(supportsPixelTrace(video)).toBe(false);
  });

  it("returns true when requestVideoFrameCallback exists", () => {
    const video = fakeVideo(true);
    expect(supportsPixelTrace(video)).toBe(true);
  });
});

describe("PixelTraceSampler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // performance.timeOrigin isn't meaningfully set by jsdom's fake timers
    // in a fixed way across environments - pin it so paintedAtMs math is
    // deterministic across test runs.
    vi.spyOn(performance, "timeOrigin", "get").mockReturnValue(1_700_000_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("never schedules a frame callback when unsupported", () => {
    const video = fakeVideo(false);
    const onFlush = vi.fn();
    const sampler = new PixelTraceSampler(video, onFlush);
    sampler.start();
    expect(video.__pendingCount()).toBe(0);
  });

  it("reports only samples observed during the noted interaction's window", () => {
    const video = fakeVideo(true);
    const onFlush = vi.fn<(samples: PixelTraceSample[]) => void>();
    const sampler = new PixelTraceSampler(video, onFlush, 500);
    sampler.start();

    // A frame BEFORE any interaction was noted - must never appear in a
    // later flush, even though it's still within MAX_BUFFER_AGE_MS. Real
    // wall-clock time (Date.now()) must actually advance between the two,
    // same as it would in real execution - not just fake-timer-frozen
    // zero, which would make this an ambiguous exact tie instead of a
    // genuine before/after ordering.
    video.__fireFrame({ presentationTime: 100, rtpTimestamp: 111 });
    vi.advanceTimersByTime(1);

    sampler.noteInteraction();

    // Two frames land inside the window.
    video.__fireFrame({ presentationTime: 200, rtpTimestamp: 222 });
    video.__fireFrame({ presentationTime: 250, rtpTimestamp: 233 });

    vi.advanceTimersByTime(500);

    expect(onFlush).toHaveBeenCalledTimes(1);
    const reported = onFlush.mock.calls[0]?.[0] ?? [];
    const ids = reported.map((s) => s.rtpTimestamp).sort();
    expect(ids).toEqual([222, 233]);
  });

  it("does not flush if no interaction was ever noted", () => {
    const video = fakeVideo(true);
    const onFlush = vi.fn();
    const sampler = new PixelTraceSampler(video, onFlush, 500);
    sampler.start();

    video.__fireFrame({ presentationTime: 100, rtpTimestamp: 111 });
    vi.advanceTimersByTime(5000);

    expect(onFlush).not.toHaveBeenCalled();
  });

  it("does not flush an empty window (no frames landed during it)", () => {
    const video = fakeVideo(true);
    const onFlush = vi.fn();
    const sampler = new PixelTraceSampler(video, onFlush, 500);
    sampler.start();

    sampler.noteInteraction();
    vi.advanceTimersByTime(500);

    expect(onFlush).not.toHaveBeenCalled();
  });

  it("collapses a burst of interactions inside one pending window into a single flush", () => {
    const video = fakeVideo(true);
    const onFlush = vi.fn();
    const sampler = new PixelTraceSampler(video, onFlush, 500);
    sampler.start();

    sampler.noteInteraction();
    vi.advanceTimersByTime(100);
    sampler.noteInteraction(); // inside the first window - must not reschedule
    sampler.noteInteraction();

    video.__fireFrame({ presentationTime: 150, rtpTimestamp: 999 });

    vi.advanceTimersByTime(400); // total 500ms from the FIRST noteInteraction
    expect(onFlush).toHaveBeenCalledTimes(1);

    // A later, independent interaction after the first window closed DOES
    // get its own flush.
    sampler.noteInteraction();
    video.__fireFrame({ presentationTime: 700, rtpTimestamp: 1001 });
    vi.advanceTimersByTime(500);
    expect(onFlush).toHaveBeenCalledTimes(2);
  });

  it("stops sampling the first time a real frame arrives with no rtpTimestamp", () => {
    const video = fakeVideo(true);
    const onFlush = vi.fn();
    const sampler = new PixelTraceSampler(video, onFlush, 500);
    sampler.start();

    expect(video.__pendingCount()).toBe(1);
    video.__fireFrame({ presentationTime: 100 }); // no rtpTimestamp - unsupported metadata

    // stop() was called internally - no new callback should have been
    // re-armed, and since the handle is cleared before onFrame runs (see
    // scheduleNextFrame's own comment), there's nothing left to cancel.
    expect(video.__pendingCount()).toBe(0);
    expect(video.cancelVideoFrameCallback).not.toHaveBeenCalled();

    // A later noteInteraction must be a no-op too - this stream can never
    // produce a real sample.
    sampler.noteInteraction();
    vi.advanceTimersByTime(1000);
    expect(onFlush).not.toHaveBeenCalled();
  });

  it("stop() cancels the pending frame callback and clears the buffer", () => {
    const video = fakeVideo(true);
    const onFlush = vi.fn();
    const sampler = new PixelTraceSampler(video, onFlush, 500);
    sampler.start();
    expect(video.__pendingCount()).toBe(1);

    sampler.stop();
    expect(video.cancelVideoFrameCallback).toHaveBeenCalledTimes(1);
    expect(video.__pendingCount()).toBe(0);
  });

  it("computes paintedAtMs as performance.timeOrigin + presentationTime", () => {
    const video = fakeVideo(true);
    const onFlush = vi.fn<(samples: PixelTraceSample[]) => void>();
    const sampler = new PixelTraceSampler(video, onFlush, 500);
    sampler.start();

    sampler.noteInteraction();
    video.__fireFrame({ presentationTime: 42, rtpTimestamp: 7 });
    vi.advanceTimersByTime(500);

    expect(onFlush).toHaveBeenCalledTimes(1);
    const [sample] = onFlush.mock.calls[0]?.[0] ?? [];
    expect(sample?.paintedAtMs).toBe(1_700_000_000_000 + 42);
  });
});
