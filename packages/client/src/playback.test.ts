import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectedClient, hello, installFakes } from "./testing/fakes";

// A playback session (docs/protocol.md, "Recordings"): its state and the
// recording's timeline come as signaling messages naming the playback
// source; a connection with control plays, pauses and seeks it with a
// "playback" input event to that source.

const PB = "pb1";
const playback = () =>
  connectedClient({}, hello({ sources: [{ id: PB, kind: "playback", state: "live", capabilities: { video: true }, inputMode: "floor", inspect: false }] }), [PB]);

beforeEach(() => installFakes());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("playback", () => {
  it("emits the state and keeps playbackState() current", async () => {
    const { client, ws } = await playback();
    const seen = vi.fn();
    client.on("playback", seen);
    ws.receive({ type: "playback", source: PB, playing: true, positionMs: 1500, durationMs: 9000, ended: false });
    await vi.waitFor(() => expect(seen).toHaveBeenCalledWith({ playing: true, positionMs: 1500, durationMs: 9000, ended: false }, PB));
    expect(client.source(PB).playbackState()).toEqual({ playing: true, positionMs: 1500, durationMs: 9000, ended: false });
    client.disconnect();
  });

  it("emits the timeline's events", async () => {
    const { client, ws } = await playback();
    const seen = vi.fn();
    client.on("timeline", seen);
    ws.receive({ type: "timeline", source: PB, event: { t: 2500, type: "navigation", origin: "https://example.com" } });
    await vi.waitFor(() => expect(seen).toHaveBeenCalledWith({ t: 2500, type: "navigation", origin: "https://example.com" }, PB));
    client.disconnect();
  });

  it("sends play, pause and seek as input", async () => {
    const { client, reliable } = await playback();
    const pb = client.source(PB);
    pb.controlPlayback("seek", 4000);
    expect(reliable.sent[reliable.sent.length - 1]).toMatchObject({ type: "playback", data: { action: "seek", positionMs: 4000 }, source: PB });
    pb.controlPlayback("pause");
    expect(reliable.sent[reliable.sent.length - 1]).toMatchObject({ type: "playback", data: { action: "pause" }, source: PB });
    client.disconnect();
  });

  it("is null for a source that is not a playback", async () => {
    const { client, source } = await connectedClient();
    expect(source.playbackState()).toBeNull();
    client.disconnect();
  });
});
