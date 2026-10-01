import { afterEach, describe, expect, it, vi } from "vitest";
import { CLOSE_SESSION_NOT_FOUND, GlassClient } from "./index";

// A link to a session that no longer exists: Glass accepts the signaling
// upgrade and closes it with CLOSE_SESSION_NOT_FOUND. The client must say so
// and stop, not retry.

class ClosingWebSocket {
  static readonly OPEN = 1;
  static instances = 0;
  readyState = 0;
  onopen: ((e: unknown) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onmessage: ((e: unknown) => void) | null = null;
  constructor(public url: string) {
    ClosingWebSocket.instances++;
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.({});
      this.readyState = 3;
      this.onclose?.({ code: CLOSE_SESSION_NOT_FOUND });
    }, 0);
  }
  send() {}
  close() {}
}

afterEach(() => {
  vi.unstubAllGlobals();
  ClosingWebSocket.instances = 0;
});

describe("GlassClient and an expired session", () => {
  it("rejects connect() with a clear reason and doesn't retry", async () => {
    vi.stubGlobal("WebSocket", ClosingWebSocket);
    const client = new GlassClient({
      signalingUrl: "wss://glass/v1/relay-sessions/gone/signaling?token=t",
      reconnect: { maxAttempts: 5 },
    });
    const closed = vi.fn();
    client.on("closed", closed);

    await expect(client.connect()).rejects.toThrow("session not found or expired");
    expect(closed).toHaveBeenCalledWith("session not found or expired");
    expect(ClosingWebSocket.instances).toBe(1);
  });
});
