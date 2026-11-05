import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GlassClient } from "./index";
import { connectedClient, installFakes } from "./testing/fakes";

// A playback session (docs/protocol.md, "Recordings"): its state and the
// recording's timeline come as signaling messages; a connection with
// control plays, pauses and seeks it with a "playback" input event.

beforeEach(() => installFakes());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("playback", () => {
  it("emits the state and keeps playbackState() current", async () => {
    const { client, ws } = await connectedClient();
    const seen = vi.fn();
    client.on("playback", seen);
    ws.receive({ type: "playback", playing: true, positionMs: 1500, durationMs: 9000, ended: false });
    await vi.waitFor(() => expect(seen).toHaveBeenCalledTimes(1));
    expect(client.playbackState()).toEqual({ playing: true, positionMs: 1500, durationMs: 9000, ended: false });
    client.disconnect();
  });

  it("emits the timeline's events", async () => {
    const { client, ws } = await connectedClient();
    const seen = vi.fn();
    client.on("timeline", seen);
    ws.receive({ type: "timeline", event: { t: 2500, type: "navigation", origin: "https://example.com" } });
    await vi.waitFor(() => expect(seen).toHaveBeenCalledWith({ t: 2500, type: "navigation", origin: "https://example.com" }));
    client.disconnect();
  });

  it("sends play, pause and seek as input", async () => {
    const { client, reliable } = await connectedClient();
    client.controlPlayback("seek", 4000);
    expect(reliable.sent[reliable.sent.length - 1]).toMatchObject({ type: "playback", data: { action: "seek", positionMs: 4000 } });
    client.controlPlayback("pause");
    expect(reliable.sent[reliable.sent.length - 1]).toMatchObject({ type: "playback", data: { action: "pause" } });
    client.disconnect();
  });

  it("is null for a session that is not a playback", () => {
    const client = new GlassClient({ signalingUrl: "ws://localhost/v1/sessions/test/signaling", reconnect: false });
    expect(client.playbackState()).toBeNull();
  });
});
