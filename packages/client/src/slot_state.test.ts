import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GlassClient } from "./index";
import { connectedClient, installFakes } from "./testing/fakes";

// The slot_state signaling message (docs/protocol.md): a relay consumer learns
// each slot's state, so an app can show "source paused" over a frozen frame.

beforeEach(() => installFakes());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("slot_state", () => {
  it("replaces the snapshot and emits slotStateChanged", async () => {
    const { client, ws } = await connectedClient();
    const seen = vi.fn();
    client.on("slotStateChanged", seen);

    ws.receive({ type: "slot_state", slots: { main: "live", rear: "empty" } });
    ws.receive({ type: "slot_state", slots: { main: "stalled" } });
    await vi.waitFor(() => expect(seen).toHaveBeenCalledTimes(2));

    expect(seen).toHaveBeenNthCalledWith(1, { main: "live", rear: "empty" });
    expect(seen).toHaveBeenNthCalledWith(2, { main: "stalled" });
    expect(client.slotStates()).toEqual({ main: "stalled" });
    client.disconnect();
  });

  it("drops states it doesn't know", async () => {
    const { client, ws } = await connectedClient();
    ws.receive({ type: "slot_state", slots: { main: "live", x: "weird" } });
    await vi.waitFor(() => expect(client.slotStates()).toEqual({ main: "live" }));
    client.disconnect();
  });

  it("is empty before any report", () => {
    const client = new GlassClient({ signalingUrl: "ws://localhost/v1/relay-sessions/test/signaling", reconnect: false });
    expect(client.slotStates()).toEqual({});
  });
});
