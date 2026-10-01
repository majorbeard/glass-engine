import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectedClient, installFakes } from "./testing/fakes";
import { InputLatencyTracker, receiverWindow, rtpAtOrAfter } from "./input_latency";

function clockAt(start: number) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

afterEach(() => vi.restoreAllMocks());

describe("InputLatencyTracker", () => {
  it("times a click from send to the tagged frame's display", () => {
    const clock = clockAt(1000);
    const tr = new InputLatencyTracker(clock.now);
    const s = tr.number("mousedown")!;
    tr.onInputFrame(90_000, [{ s }]);
    expect(tr.onPresentedFrame(89_000, 1030)).toEqual([]); // an earlier frame
    expect(tr.onPresentedFrame(90_000, 1042.5)).toEqual([{ kind: "mousedown", ms: 42.5, continuous: false }]);
  });

  // Required test: a wall-clock adjustment between send and paint doesn't
  // change the result, for either kind of sample.
  it("is unaffected by a wall-clock jump", () => {
    const clock = clockAt(500);
    const tr = new InputLatencyTracker(clock.now);
    const click = tr.number("keydown")!;
    const drag = tr.number("mousemove")!;
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3_600_000);
    tr.onInputFrame(7, [{ s: click }, { s: drag }]);
    const done = tr.onPresentedFrame(7, 560);
    expect(done).toEqual([
      { kind: "keydown", ms: 60, continuous: false },
      { kind: "mousemove", ms: 60, continuous: true },
    ]);
  });

  it("completes on a later frame when the tagged one was never shown", () => {
    const clock = clockAt(0);
    const tr = new InputLatencyTracker(clock.now);
    const s = tr.number("touchstart")!;
    tr.onInputFrame(3000, [{ s }]);
    expect(tr.onPresentedFrame(6000, 50)).toHaveLength(1);
  });

  it("orders RTP timestamps across the 32-bit wrap", () => {
    expect(rtpAtOrAfter(10, 0xffff_fff0)).toBe(true);
    expect(rtpAtOrAfter(0xffff_fff0, 10)).toBe(false);
    const clock = clockAt(0);
    const tr = new InputLatencyTracker(clock.now);
    const s = tr.number("mouseup")!;
    tr.onInputFrame(0xffff_fff0, [{ s }]);
    expect(tr.onPresentedFrame(100, 20)).toHaveLength(1);
  });

  it("numbers only interaction inputs", () => {
    const tr = new InputLatencyTracker(() => 0);
    expect(tr.number("set_viewport")).toBeUndefined();
    expect(tr.number("paste_text")).toBeUndefined();
    expect(tr.number("scroll")).toBe(1);
  });

  it("ignores tags for unknown inputs and forgets old ones", () => {
    const clock = clockAt(0);
    const tr = new InputLatencyTracker(clock.now);
    tr.onInputFrame(1, [{ s: 99 }]);
    expect(tr.onPresentedFrame(1, 10)).toEqual([]);
    const s = tr.number("mousedown")!;
    clock.advance(5000);
    tr.number("mousedown"); // triggers forgetting
    tr.onInputFrame(2, [{ s }]);
    expect(tr.onPresentedFrame(2, 5010)).toEqual([]);
  });

  it("summarizes recent samples and hands each to one report", () => {
    const clock = clockAt(0);
    const tr = new InputLatencyTracker(clock.now);
    for (const ms of [10, 20, 30]) {
      const s = tr.number("mousedown")!;
      tr.onInputFrame(ms, [{ s }]);
      tr.onPresentedFrame(ms, clock.now() + ms);
    }
    expect(tr.stats().discrete).toEqual({ n: 3, p50: 20, p95: 30 });
    expect(tr.stats().continuous).toEqual({ n: 0, p50: null, p95: null });
    expect(tr.takeReport()).toHaveLength(3);
    expect(tr.takeReport()).toHaveLength(0);
  });
});

describe("GlassClient input latency", () => {
  beforeEach(() => installFakes());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("numbers interaction inputs on the wire", async () => {
    const { client, reliable } = await connectedClient();
    client.mouseDown(1, 2);
    client.setViewport(1, 1);
    expect(reliable.sent[0].data.s).toBe(1);
    expect(reliable.sent[1].data.s).toBeUndefined();
    client.disconnect();
  });

  it("turns an InputFrame message and a presented frame into a sample and a report", async () => {
    const { client, reliable } = await connectedClient();
    vi.spyOn(performance, "now").mockReturnValue(100);
    client.dispatchKeyEvent({ type: "keydown", key: "a", code: "KeyA" } as any);
    const s = reliable.sent[0].data.s;
    reliable.receive(0x04, { f: 4242, i: [{ s }] });

    const seen = vi.fn();
    client.on("inputLatency", seen);
    vi.spyOn(performance, "now").mockReturnValue(10_000);
    client.notePresentedFrame(4242, 135);
    expect(seen).toHaveBeenCalledWith({ kind: "keydown", ms: 35, continuous: false });
    await vi.waitFor(() => expect(reliable.sent.find((m) => m.type === "input_latency_report")).toBeDefined());
    const report = reliable.sent.find((m) => m.type === "input_latency_report");
    expect(report.data.samples).toEqual([{ k: "keydown", ms: 35, c: false }]);
    expect(report.data.rx).toBeUndefined(); // the fake peer reports no receiver stats
    expect(client.inputLatencyStats().discrete.n).toBe(1);
    client.disconnect();
  });
});

describe("receiverWindow", () => {
  it("turns two counter reads into per-frame receiver delays", () => {
    const prev = { at: 0, jitterBufferDelay: 1, jitterBufferEmittedCount: 100, totalDecodeTime: 0.5, framesDecoded: 100, framesDropped: 2 };
    const cur = { at: 5000, jitterBufferDelay: 13, jitterBufferEmittedCount: 200, totalDecodeTime: 1.3, framesDecoded: 200, framesDropped: 5 };
    expect(receiverWindow(prev, cur)).toEqual({ jb: 120, dec: 8, fps: 20, drop: 3 });
  });

  it("leaves out what it can't compute, including counters that reset", () => {
    expect(receiverWindow({ at: 0 }, { at: 5000 })).toEqual({});
    const prev = { at: 0, jitterBufferDelay: 9, jitterBufferEmittedCount: 900, framesDecoded: 900 };
    const cur = { at: 5000, jitterBufferDelay: 1, jitterBufferEmittedCount: 50, framesDecoded: 50 };
    expect(receiverWindow(prev, cur)).toEqual({});
  });
});
