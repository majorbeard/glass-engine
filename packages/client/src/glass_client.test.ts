// GlassClient behavior through its public API only, against fake WebSocket
// and RTCPeerConnection globals (see testing/fakes.ts). It pins public
// behavior, so internal refactors must keep it passing unchanged. Message
// type bytes are the wire protocol's (docs/protocol.md), not internal names.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GlassClient } from "./index";
import { connectedClient, FakePeerConnection, FakeWebSocket, flush, installFakes, type FakeDataChannel } from "./testing/fakes";

const URL = "ws://glass.test/v1/sessions/s1/signaling?token=tok";

beforeEach(() => installFakes());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const connected = connectedClient;

describe("connect", () => {
  it("answers the offer and resolves once the peer connects", async () => {
    const client = new GlassClient({ signalingUrl: URL, reconnect: false });
    const events: string[] = [];
    client.on("connected", () => events.push("connected"));
    const done = client.connect();
    const ws = FakeWebSocket.last();
    expect(ws.url).toBe(URL);
    ws.open();
    ws.receive({ type: "offer", sdp: "offer-sdp", connectionId: "c1", producesInput: true, isOwner: false });
    await flush();
    const pc = FakePeerConnection.last();
    expect(pc.remoteDescription).toEqual({ type: "offer", sdp: "offer-sdp" });
    expect(ws.sentOfType("answer")).toEqual([{ type: "answer", sdp: "answer-sdp" }]);
    pc.openChannels();
    pc.setState("connected");
    await done;
    expect(events).toEqual(["connected"]);
    expect(client.connectionId()).toBe("c1");
    expect(client.producesInput()).toBe(true);
    expect(client.isOwner()).toBe(false);
    expect(client.isConnected()).toBe(true);
    client.disconnect();
  });

  it("holds a candidate that arrives while the offer is applied, then adds it", async () => {
    const client = new GlassClient({ signalingUrl: URL, reconnect: false });
    void client.connect();
    const ws = FakeWebSocket.last();
    ws.open();
    ws.receive({ type: "offer", sdp: "offer-sdp" });
    ws.receive({ type: "ice-candidate", candidate: { candidate: "candidate:early" } });
    await flush();
    expect(FakePeerConnection.last().addedCandidates).toEqual([{ candidate: "candidate:early" }]);
    client.disconnect();
  });

  it("sends its own candidates over signaling", async () => {
    const { client, ws, pc } = await connected();
    pc.gatherCandidate("candidate:local");
    expect(ws.sentOfType("ice-candidate")).toEqual([{ type: "ice-candidate", candidate: { candidate: "candidate:local" } }]);
    client.disconnect();
  });

  it("rejects and closes on a signaling error message", async () => {
    const client = new GlassClient({ signalingUrl: URL, reconnect: false });
    const closed = vi.fn();
    client.on("closed", closed);
    const done = client.connect();
    const ws = FakeWebSocket.last();
    ws.open();
    ws.receive({ type: "error", error: "session ended: boom" });
    ws.drop(1000);
    await expect(done).rejects.toThrow();
    expect(closed).toHaveBeenCalledWith("session ended: boom");
  });
});

describe("DataChannel messages", () => {
  const cases: Array<[string, number, unknown, string, unknown[]]> = [
    ["navigation", 0x06, { url: "https://a.test/", canGoBack: true }, "navigation", [{ url: "https://a.test/", canGoBack: true }]],
    ["element state", 0x05, { cursor: "pointer" }, "state", [{ cursor: "pointer" }]],
    ["interactive elements", 0x0a, { elements: [{ x: 1, y: 2, width: 3, height: 4 }] }, "interactiveElements", [[{ x: 1, y: 2, width: 3, height: 4 }]]],
    ["clipboard", 0x09, { text: "hi" }, "clipboardText", ["hi"]],
    ["console", 0x0b, { level: "warn", text: "careful" }, "consoleMessage", ["warn", "careful"]],
    ["download ready", 0x0c, { filename: "a.pdf", guid: "g1" }, "downloadReady", ["a.pdf", "g1"]],
    ["file chooser opened", 0x0d, { multiple: true }, "fileChooserOpened", [true]],
    ["file chooser closed", 0x0e, undefined, "fileChooserClosed", []],
    ["mic access requested", 0x0f, { origin: "https://m.test" }, "micAccessRequested", ["https://m.test"]],
    ["error", 0xff, { error: "bad" }, "error", ["bad"]],
  ];
  for (const [name, type, body, event, args] of cases) {
    it(`emits ${event} for ${name} (0x${type.toString(16)})`, async () => {
      const { client, reliable } = await connected();
      const got = vi.fn();
      client.on(event as any, got);
      reliable.receive(type, body);
      expect(got).toHaveBeenCalledWith(...args);
      client.disconnect();
    });
  }

  it("answers a clock probe on the DataChannel", async () => {
    const { client, reliable } = await connected();
    vi.spyOn(Date, "now").mockReturnValue(42);
    reliable.receive(0x08, { id: 9 });
    expect(reliable.sent).toContainEqual({ type: "clock_probe_reply", data: { id: 9, clientT: 42 } });
    client.disconnect();
  });

  it("ignores a malformed body without tearing anything down", async () => {
    const { client, reliable } = await connected();
    reliable.receiveRaw(new Uint8Array([0x06, 0x7b, 0x7b]));
    expect(client.isConnected()).toBe(true);
    client.disconnect();
  });
});

describe("input", () => {
  function last(dc: FakeDataChannel) {
    return dc.sent[dc.sent.length - 1];
  }

  it("sends clicks and keys on the reliable channel with a send time", async () => {
    const { client, reliable } = await connected();
    vi.spyOn(Date, "now").mockReturnValue(1000);
    client.mouseDown(10, 20, "right", 2, 1);
    expect(last(reliable)).toMatchObject({ type: "mousedown", data: { x: 10, y: 20, button: "right", modifiers: 2, clickCount: 1, t: 1000 } });
    client.dispatchKeyEvent({ type: "keydown", key: "a", code: "KeyA", shiftKey: true, ctrlKey: true } as any);
    expect(last(reliable)).toMatchObject({ type: "keydown", data: { key: "a", code: "KeyA", modifiers: 10 } });
    client.disconnect();
  });

  it("sends touchmove and scroll on the fast channel, other touches on the reliable one", async () => {
    const { client, reliable, fast } = await connected();
    const pts = [{ id: 1, x: 5, y: 6 }];
    client.dispatchTouch("touchstart", pts, 7);
    client.dispatchTouch("touchmove", pts, 7);
    client.dispatchTouch("touchend", [], 7, 1);
    client.scroll(120, 0, 0);
    expect(reliable.sent.map((m) => m.type)).toEqual(expect.arrayContaining(["touchstart", "touchend"]));
    expect(reliable.sent.find((m) => m.type === "touchend").data).toMatchObject({ gestureId: 7, moveCount: 1 });
    expect(fast.sent.map((m) => m.type)).toEqual(["touchmove", "scroll"]);
    client.disconnect();
  });

  it("batches hover moves and sends only the latest", async () => {
    const { client, fast } = await connected();
    vi.useFakeTimers();
    client.mouseMove(1, 1, false);
    client.mouseMove(2, 2, false);
    client.mouseMove(3, 3, false);
    expect(fast.sent).toEqual([]);
    vi.advanceTimersByTime(20);
    expect(fast.sent).toHaveLength(1);
    expect(fast.sent[0]).toMatchObject({ type: "mousemove", data: { x: 3, y: 3, dragging: false } });
    client.disconnect();
  });

  it("stops the batch timer once idle and restarts it on the next move", async () => {
    const { client, fast } = await connected();
    vi.useFakeTimers();
    const clear = vi.spyOn(globalThis, "clearInterval");
    client.mouseMove(1, 1, false);
    vi.advanceTimersByTime(20); // sends
    vi.advanceTimersByTime(20); // empty tick: stops
    expect(clear).toHaveBeenCalled();
    const idleTimers = vi.getTimerCount();
    vi.advanceTimersByTime(1000);
    expect(vi.getTimerCount()).toBe(idleTimers);
    client.mouseMove(2, 2, false);
    vi.advanceTimersByTime(20);
    expect(fast.sent.map((m) => m.data.x)).toEqual([1, 2]);
    client.disconnect();
  });

  it("caps drag moves to about 60 Hz", async () => {
    const { client, fast } = await connected();
    let now = 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    client.mouseMove(1, 1, true);
    now += 5;
    client.mouseMove(2, 2, true); // inside the window: dropped
    now += 15;
    client.mouseMove(3, 3, true);
    expect(fast.sent.map((m) => m.data.x)).toEqual([1, 3]);
    client.disconnect();
  });

  it("sends navigation and viewport over signaling", async () => {
    const { client, ws } = await connected();
    client.navigate("https://b.test/");
    client.sendInitialViewport(800, 600, true, "UA");
    expect(ws.sentOfType("navigate")).toEqual([{ type: "navigate", sdp: "https://b.test/" }]);
    expect(ws.sentOfType("initial_viewport")).toEqual([{ type: "initial_viewport", width: 800, height: 600, isMobile: true, userAgent: "UA" }]);
    client.disconnect();
  });
});

describe("reconnect", () => {
  it("reconnects after a lost socket, backing off between failed attempts", async () => {
    const { client, ws } = await connected({ reconnect: { maxAttempts: 3, delaysMs: [100, 300] } });
    vi.useFakeTimers();
    const events: string[] = [];
    client.on("disconnected", () => events.push("disconnected"));
    client.on("reconnecting", (n: number, max: number) => events.push(`reconnecting ${n}/${max}`));
    client.on("connected", () => events.push("connected"));

    ws.drop(1006);
    expect(events).toEqual(["disconnected", "reconnecting 1/3"]);
    const attempt1 = FakeWebSocket.last();
    expect(attempt1).not.toBe(ws);
    attempt1.drop(1006); // fails before connecting
    await flush();
    // The first retry was immediate; the wait after it failing is
    // delaysMs[0].
    const count = FakeWebSocket.instances.length;
    vi.advanceTimersByTime(99);
    await flush();
    expect(FakeWebSocket.instances.length).toBe(count); // still waiting
    vi.advanceTimersByTime(1);
    await flush();
    expect(events).toContain("reconnecting 2/3");
    const attempt2 = FakeWebSocket.last();
    attempt2.open();
    attempt2.receive({ type: "offer", sdp: "offer-sdp", connectionId: "c1" });
    await flush();
    FakePeerConnection.last().setState("connected");
    await flush();
    expect(events[events.length - 1]).toBe("connected");
    client.disconnect();
  });

  it("gives up with closed once attempts run out", async () => {
    const { client, ws } = await connected({ reconnect: { maxAttempts: 1, delaysMs: [10] } });
    vi.useFakeTimers();
    const closed = vi.fn();
    client.on("closed", closed);
    ws.drop(1006);
    FakeWebSocket.last().drop(1006);
    await flush();
    vi.advanceTimersByTime(10);
    await flush();
    expect(closed).toHaveBeenCalledWith("reconnection attempts exhausted");
  });

  it("closes without retrying when the server says the session is gone", async () => {
    const { client, ws } = await connected({ reconnect: { maxAttempts: 5, delaysMs: [10] } });
    const closed = vi.fn();
    client.on("closed", closed);
    ws.drop(1006);
    FakeWebSocket.last().drop(4404);
    await flush();
    expect(closed).toHaveBeenCalledWith("session not found or expired");
  });
});

describe("disconnected grace", () => {
  it("waits before treating a disconnected peer as dropped", async () => {
    const { client, pc } = await connected({ reconnect: { maxAttempts: 2, delaysMs: [10] } });
    vi.useFakeTimers();
    const dropped = vi.fn();
    client.on("disconnected", dropped);
    pc.setState("disconnected");
    vi.advanceTimersByTime(3999);
    expect(dropped).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(dropped).toHaveBeenCalled();
    client.disconnect();
  });

  it("cancels the grace when the peer recovers", async () => {
    const { client, pc } = await connected({ reconnect: { maxAttempts: 2, delaysMs: [10] } });
    vi.useFakeTimers();
    const dropped = vi.fn();
    client.on("disconnected", dropped);
    pc.setState("disconnected");
    vi.advanceTimersByTime(2000);
    pc.setState("connected");
    vi.advanceTimersByTime(10_000);
    expect(dropped).not.toHaveBeenCalled();
    client.disconnect();
  });
});

describe("disconnect", () => {
  it("closes everything once, emits closed, then goes quiet", async () => {
    const { client, ws, pc } = await connected({ sessionId: "s1", deleteSessionOnClose: true });
    const closed = vi.fn();
    const later = vi.fn();
    client.on("closed", closed);
    client.on("navigation", later);
    client.disconnect();
    client.disconnect();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(ws.closedWith).toEqual({ code: 1000, reason: "client disconnecting" });
    expect(pc.closed).toBe(true);
    expect(client.isConnected()).toBe(false);
    expect(fetch).toHaveBeenCalledWith("http://glass.test/v1/sessions/s1", expect.objectContaining({ method: "DELETE" }));
    expect(later).not.toHaveBeenCalled();
  });
});
