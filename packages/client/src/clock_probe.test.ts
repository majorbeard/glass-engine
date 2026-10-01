import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectedClient, flush, installFakes } from "./testing/fakes";

// The client answers a clock probe with Date.now() on the transport it came on.

beforeEach(() => installFakes());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("clock_probe", () => {
  it("answers on the signaling socket", async () => {
    const { client, ws } = await connectedClient();
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_123);
    ws.receive({ type: "clock_probe", id: 7 });
    await flush();
    expect(ws.sentOfType("clock_probe_reply")).toEqual([
      { type: "clock_probe_reply", id: 7, clientT: 1_700_000_000_123 },
    ]);
    client.disconnect();
  });

  it("answers on the DataChannel", async () => {
    const { client, reliable } = await connectedClient();
    vi.spyOn(Date, "now").mockReturnValue(42);
    reliable.receive(0x08, { id: 9 });
    expect(reliable.sent).toContainEqual({ type: "clock_probe_reply", data: { id: 9, clientT: 42 } });
    client.disconnect();
  });
});
