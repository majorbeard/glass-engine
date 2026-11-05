import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GlassClient } from "./index";
import { connectedClient, installFakes } from "./testing/fakes";

// The recording signaling message (docs/protocol.md): every connection is
// told whether its session is being recorded, on connect and on each change.

beforeEach(() => installFakes());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("recording", () => {
  it("emits recording and keeps recording() current", async () => {
    const { client, ws } = await connectedClient();
    const seen = vi.fn();
    client.on("recording", seen);

    ws.receive({ type: "recording", active: true });
    await vi.waitFor(() => expect(client.recording()).toBe(true));
    ws.receive({ type: "recording", active: false });
    await vi.waitFor(() => expect(seen).toHaveBeenCalledTimes(2));

    expect(seen).toHaveBeenNthCalledWith(1, true);
    expect(seen).toHaveBeenNthCalledWith(2, false);
    expect(client.recording()).toBe(false);
    client.disconnect();
  });

  it("is false before any report", () => {
    const client = new GlassClient({ signalingUrl: "ws://localhost/v1/sessions/test/signaling", reconnect: false });
    expect(client.recording()).toBe(false);
  });
});
