import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  EncodedStreamChecker,
  supportsEncodedStreamCheck,
  fnv1a32,
  type EncodedFrameReport,
} from "./encoded_stream_check.js";

// fakeReceiver builds a minimal stand-in for an RTCRtpReceiver whose
// createEncodedStreams() returns a real ReadableStream/WritableStream pair
// (jsdom lacks the real WebRTC API, but Node's native Streams
// implementation is available under vitest's jsdom environment - see this
// file's sibling test run confirming that before this suite was written).
// __push feeds a fake encoded frame into the readable side, as Chrome's own
// WebRTC receive pipeline would; __written records whatever the transform
// re-enqueues onto the writable side, so a test can assert passthrough
// happened unchanged.
function fakeReceiver(supportsCreateEncodedStreams = true) {
  let controllerRef: ReadableStreamDefaultController<unknown> | null = null;
  const written: unknown[] = [];
  const receiver = {} as RTCRtpReceiver & {
    __push: (frame: unknown) => void;
    __written: unknown[];
  };

  if (supportsCreateEncodedStreams) {
    (receiver as unknown as Record<string, unknown>).createEncodedStreams = () => {
      const readable = new ReadableStream({
        start(controller) {
          controllerRef = controller;
        },
      });
      const writable = new WritableStream({
        write(chunk) {
          written.push(chunk);
        },
      });
      return { readable, writable };
    };
  }

  receiver.__push = (frame) => controllerRef?.enqueue(frame);
  receiver.__written = written;
  return receiver;
}

describe("fnv1a32", () => {
  it("returns the untouched offset basis for empty input", () => {
    expect(fnv1a32(new Uint8Array())).toBe(0x811c9dc5);
  });

  it("is deterministic and sensitive to single-byte differences", () => {
    const a = fnv1a32(new Uint8Array([1, 2, 3]));
    const b = fnv1a32(new Uint8Array([1, 2, 3]));
    const c = fnv1a32(new Uint8Array([1, 2, 4]));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("always returns an unsigned 32-bit value", () => {
    // A input long/adversarial enough to exercise the >>> 0 wraparound path
    // at least once across the multiply chain.
    const data = new Uint8Array(64).map((_, i) => (i * 37) & 0xff);
    const h = fnv1a32(data);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
    expect(Number.isInteger(h)).toBe(true);
  });
});

describe("supportsEncodedStreamCheck", () => {
  it("is true when createEncodedStreams exists", () => {
    expect(supportsEncodedStreamCheck(fakeReceiver(true))).toBe(true);
  });

  it("is false when createEncodedStreams is absent", () => {
    expect(supportsEncodedStreamCheck(fakeReceiver(false))).toBe(false);
  });
});

describe("EncodedStreamChecker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("re-enqueues every frame unchanged and reports its {rtpTimestamp, type, size, hash}", async () => {
    const receiver = fakeReceiver();
    const flushed: EncodedFrameReport[][] = [];
    const checker = new EncodedStreamChecker(receiver, (reports) => flushed.push(reports));
    checker.start();

    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    receiver.__push({ type: "key", timestamp: 1000, data: bytes.buffer });

    // Let the real (non-fake-timer) microtask chain driving
    // pipeThrough/pipeTo actually run.
    await vi.waitFor(() => expect(receiver.__written.length).toBe(1));

    // Passthrough: the exact same frame object reached the writable side,
    // unchanged - a stalled/dropped frame here would freeze real video.
    expect(receiver.__written[0]).toEqual({ type: "key", timestamp: 1000, data: bytes.buffer });

    vi.advanceTimersByTime(1000); // FLUSH_INTERVAL_MS
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toEqual([
      { rtpTimestamp: 1000, type: "key", size: 4, hash: fnv1a32(bytes) },
    ]);

    checker.stop();
  });

  it("does nothing (no throw, no flush) when the receiver doesn't support createEncodedStreams", () => {
    const receiver = fakeReceiver(false);
    const onFlush = vi.fn();
    const checker = new EncodedStreamChecker(receiver, onFlush);

    expect(() => checker.start()).not.toThrow();
    vi.advanceTimersByTime(5000);
    expect(onFlush).not.toHaveBeenCalled();

    checker.stop();
  });

  it("does not flush an empty batch", () => {
    const receiver = fakeReceiver();
    const onFlush = vi.fn();
    const checker = new EncodedStreamChecker(receiver, onFlush);
    checker.start();

    vi.advanceTimersByTime(1000);
    expect(onFlush).not.toHaveBeenCalled();

    checker.stop();
  });

  it("stop() prevents any further flush even if more frames arrive", async () => {
    const receiver = fakeReceiver();
    const onFlush = vi.fn();
    const checker = new EncodedStreamChecker(receiver, onFlush);
    checker.start();

    receiver.__push({ type: "delta", timestamp: 1, data: new Uint8Array([1]).buffer });
    await vi.waitFor(() => expect(receiver.__written.length).toBe(1));

    checker.stop();
    vi.advanceTimersByTime(5000);
    expect(onFlush).not.toHaveBeenCalled();
  });
});
