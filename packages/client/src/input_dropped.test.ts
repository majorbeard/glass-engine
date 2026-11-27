// "inputDropped": the client withholds input it has no right to send to a
// source, and relays the drops Glass reports. Through the public API only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectedClient, hello, installFakes, SRC } from "./testing/fakes";

beforeEach(() => installFakes());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// connectedAs joins holding the source's input track or not, as the owner or
// not.
async function connectedAs(rights: { holds: boolean; owner: boolean }) {
  const { client, ws, reliable, fast, source } = await connectedClient({}, hello({ owner: rights.owner }), rights.holds ? [SRC] : []);
  const drops = vi.fn();
  client.on("inputDropped", drops);
  return { client, ws, reliable, fast, drops, source };
}

const inputs = (ch: { sent: any[] }) => ch.sent.filter((m) => !["clock_probe_reply", "input_latency_report"].includes(m.type));

describe("a watch-only connection", () => {
  it("sends no input and reports each kind once", async () => {
    const { client, reliable, fast, drops, source } = await connectedAs({ holds: false, owner: false });
    source.mouseDown(1, 2);
    source.mouseUp(1, 2);
    source.scroll(10);
    source.mouseMove(3, 4, true);
    source.dispatchKeyEvent({ type: "keydown", key: "a", code: "KeyA", ctrlKey: false, shiftKey: false, altKey: false, metaKey: false });
    source.dispatchTouch("touchstart", [{ x: 1, y: 1, id: 0 }], 1);
    source.setViewport(800, 600);
    source.pasteText("secret");
    source.copyText();
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
    const { client, drops, source } = await connectedAs({ holds: false, owner: false });
    for (let i = 0; i < 40; i++) source.scroll(5);
    expect(drops).toHaveBeenCalledTimes(1);
    vi.setSystemTime(1_002_000);
    source.scroll(5);
    expect(drops).toHaveBeenCalledTimes(2);
    expect(drops.mock.calls[1]![0]).toMatchObject({ code: "not_authorized", eventType: "scroll", count: 40, local: true });
    client.disconnect();
  });

  it("still sends diagnostics", async () => {
    const { client, reliable } = await connectedAs({ holds: false, owner: false });
    vi.spyOn(Date, "now").mockReturnValue(42);
    reliable.receive(0x08, { id: 9 });
    expect(reliable.sent).toContainEqual({ type: "clock_probe_reply", data: { id: 9, clientT: 42 } });
    client.disconnect();
  });

  it("sends again once control is granted", async () => {
    const { client, ws, reliable, drops, source } = await connectedAs({ holds: false, owner: false });
    source.mouseDown(1, 2);
    expect(inputs(reliable)).toEqual([]);
    ws.receive({ type: "input_holders", source: SRC, holders: ["c1"], floor: null });
    source.mouseDown(1, 2);
    expect(inputs(reliable).map((m) => m.type)).toEqual(["mousedown"]);
    expect(drops).toHaveBeenCalledTimes(1);
    client.disconnect();
  });
});

describe("a controlling connection that is not the owner", () => {
  it("can interact, go back, forward and refresh, but not type an address", async () => {
    const { client, ws, reliable, drops, source } = await connectedAs({ holds: true, owner: false });
    source.mouseDown(1, 2);
    source.navigate("https://example.com");
    source.navigateBack();
    source.navigateForward();
    source.refresh();
    expect(inputs(reliable).map((m) => m.type)).toEqual(["mousedown", "back", "forward", "refresh"]);
    expect(ws.sentOfType("navigate")).toEqual([]);
    expect(drops.mock.calls.map(([d]) => [d.code, d.eventType, d.local])).toEqual([["owner_only", "navigate", true]]);
    client.disconnect();
  });
});

describe("the owner", () => {
  it("sends everything and reports nothing", async () => {
    const { client, ws, reliable, fast, drops, source } = await connectedAs({ holds: true, owner: true });
    source.mouseDown(1, 2);
    source.scroll(10);
    source.navigate("https://example.com");
    source.refresh();
    expect(inputs(reliable).map((m) => m.type)).toEqual(["mousedown", "refresh"]);
    expect(inputs(fast).map((m) => m.type)).toEqual(["scroll"]);
    expect(ws.sentOfType("navigate")).toHaveLength(1);
    expect(drops).not.toHaveBeenCalled();
    client.disconnect();
  });
});

describe("a drop reported by Glass (0x10)", () => {
  it("fires inputDropped with local: false", async () => {
    const { client, reliable, drops } = await connectedAs({ holds: true, owner: true });
    reliable.receive(0x10, { code: "rate_limited", eventType: "mousedown", source: SRC, count: 7, s: 31 });
    reliable.receive(0x10, { code: "unsupported", eventType: "", source: SRC, count: 1 });
    expect(drops.mock.calls.map(([d]) => d)).toEqual([
      { code: "rate_limited", eventType: "mousedown", count: 7, local: false, source: SRC, seq: 31 },
      { code: "unsupported", eventType: "", count: 1, local: false, source: SRC },
    ]);
    client.disconnect();
  });
});
