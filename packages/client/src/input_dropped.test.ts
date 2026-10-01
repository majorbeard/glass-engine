// "inputDropped": the client withholds input it has no right to send, and
// relays the drops Glass reports. Through the public API only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GlassClient } from "./index";
import { FakePeerConnection, FakeWebSocket, flush, installFakes, TEST_URL } from "./testing/fakes";

beforeEach(() => installFakes());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function connectedAs(rights: { producesInput: boolean; isOwner: boolean }) {
  const client = new GlassClient({ signalingUrl: TEST_URL, reconnect: false });
  const done = client.connect();
  const ws = FakeWebSocket.last();
  ws.open();
  ws.receive({ type: "offer", sdp: "offer-sdp", connectionId: "c1", ...rights });
  await flush();
  const pc = FakePeerConnection.last();
  const { reliable, fast } = pc.openChannels();
  pc.setState("connected");
  await done;
  const drops = vi.fn();
  client.on("inputDropped", drops);
  return { client, ws, reliable, fast, drops };
}

const inputs = (ch: { sent: any[] }) => ch.sent.filter((m) => !["clock_probe_reply", "input_latency_report"].includes(m.type));

describe("a watch-only connection", () => {
  it("sends no input and reports each kind once", async () => {
    const { client, reliable, fast, drops } = await connectedAs({ producesInput: false, isOwner: false });
    client.mouseDown(1, 2);
    client.mouseUp(1, 2);
    client.scroll(10);
    client.mouseMove(3, 4, true);
    client.dispatchKeyEvent({ type: "keydown", key: "a", code: "KeyA", ctrlKey: false, shiftKey: false, altKey: false, metaKey: false });
    client.dispatchTouch("touchstart", [{ x: 1, y: 1, id: 0 }], 1);
    client.setViewport(800, 600);
    client.pasteText("secret");
    client.copyText();
    expect(inputs(reliable)).toEqual([]);
    expect(inputs(fast)).toEqual([]);
    expect(drops.mock.calls.map(([d]) => [d.code, d.eventType, d.count, d.local])).toEqual([
      ["not_authorized", "mousedown", 1, true],
      ["not_authorized", "mouseup", 1, true],
      ["not_authorized", "scroll", 1, true],
      ["not_authorized", "mousemove", 1, true],
      ["not_authorized", "keydown", 1, true],
      ["not_authorized", "touchstart", 1, true],
      ["not_authorized", "set_viewport", 1, true],
      ["not_authorized", "paste_text", 1, true],
      ["not_authorized", "copy_text", 1, true],
    ]);
    client.disconnect();
  });

  it("coalesces a burst: one report at once, then a count after 2 s", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { client, drops } = await connectedAs({ producesInput: false, isOwner: false });
    for (let i = 0; i < 40; i++) client.scroll(5);
    expect(drops).toHaveBeenCalledTimes(1);
    vi.setSystemTime(1_002_000);
    client.scroll(5);
    expect(drops).toHaveBeenCalledTimes(2);
    expect(drops.mock.calls[1]![0]).toMatchObject({ code: "not_authorized", eventType: "scroll", count: 40, local: true });
    client.disconnect();
  });

  it("still sends diagnostics", async () => {
    const { client, reliable } = await connectedAs({ producesInput: false, isOwner: false });
    vi.spyOn(Date, "now").mockReturnValue(42);
    reliable.receive(0x08, { id: 9 });
    expect(reliable.sent).toContainEqual({ type: "clock_probe_reply", data: { id: 9, clientT: 42 } });
    client.disconnect();
  });

  it("sends again once control is granted", async () => {
    const { client, ws, reliable, drops } = await connectedAs({ producesInput: false, isOwner: false });
    client.mouseDown(1, 2);
    expect(inputs(reliable)).toEqual([]);
    ws.receive({ type: "capabilities_changed", connectionId: "c1", producesInput: true });
    client.mouseDown(1, 2);
    expect(inputs(reliable).map((m) => m.type)).toEqual(["mousedown"]);
    expect(drops).toHaveBeenCalledTimes(1);
    client.disconnect();
  });
});

describe("a controlling connection that is not the owner", () => {
  it("can interact but not navigate", async () => {
    const { client, ws, reliable, drops } = await connectedAs({ producesInput: true, isOwner: false });
    client.mouseDown(1, 2);
    client.navigate("https://example.com");
    client.navigateBack();
    client.navigateForward();
    client.refresh();
    expect(inputs(reliable).map((m) => m.type)).toEqual(["mousedown"]);
    expect(ws.sentOfType("navigate")).toEqual([]);
    expect(drops.mock.calls.map(([d]) => [d.code, d.eventType, d.local])).toEqual([
      ["owner_only", "navigate", true],
      ["owner_only", "back", true],
      ["owner_only", "forward", true],
      ["owner_only", "refresh", true],
    ]);
    client.disconnect();
  });
});

describe("the owner", () => {
  it("sends everything and reports nothing", async () => {
    const { client, ws, reliable, fast, drops } = await connectedAs({ producesInput: true, isOwner: true });
    client.mouseDown(1, 2);
    client.scroll(10);
    client.navigate("https://example.com");
    client.refresh();
    expect(inputs(reliable).map((m) => m.type)).toEqual(["mousedown", "refresh"]);
    expect(inputs(fast).map((m) => m.type)).toEqual(["scroll"]);
    expect(ws.sentOfType("navigate")).toHaveLength(1);
    expect(drops).not.toHaveBeenCalled();
    client.disconnect();
  });
});

describe("a drop reported by Glass (0x10)", () => {
  it("fires inputDropped with local: false", async () => {
    const { client, reliable, drops } = await connectedAs({ producesInput: true, isOwner: true });
    reliable.receive(0x10, { code: "rate_limited", eventType: "mousedown", count: 7, s: 31 });
    reliable.receive(0x10, { code: "unsupported", eventType: "", count: 1 });
    expect(drops.mock.calls.map(([d]) => d)).toEqual([
      { code: "rate_limited", eventType: "mousedown", count: 7, local: false, seq: 31 },
      { code: "unsupported", eventType: "", count: 1, local: false },
    ]);
    client.disconnect();
  });
});

describe("a server that doesn't state the connection's rights", () => {
  it("is sent input as before", async () => {
    const client = new GlassClient({ signalingUrl: TEST_URL, reconnect: false });
    const done = client.connect();
    const ws = FakeWebSocket.last();
    ws.open();
    ws.receive({ type: "offer", sdp: "offer-sdp" });
    await flush();
    const pc = FakePeerConnection.last();
    const { reliable } = pc.openChannels();
    pc.setState("connected");
    await done;
    client.mouseDown(1, 2);
    expect(inputs(reliable).map((m) => m.type)).toEqual(["mousedown"]);
    client.disconnect();
  });
});
