import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GlassProducer, type ProducerState } from "./producer";

// GlassProducer's connection lifecycle against fake WebSocket and
// RTCPeerConnection objects the test drives by hand. A producer must resume the same session after a drop, and only replace it
// when it owns it.

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.CONNECTING;
  sent: any[] = [];
  closeCode: number | undefined;
  private listeners: Record<string, ((e: any) => void)[]> = {};
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type: string, fn: (e: any) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  private fire(type: string, e: any = {}) {
    for (const fn of this.listeners[type] ?? []) fn(e);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code = 1000) {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.closeCode = code;
    this.readyState = FakeWebSocket.CLOSED;
    this.fire("close", { code });
  }
  // Test controls.
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.fire("open");
  }
  serverMessage(msg: object) {
    this.fire("message", { data: JSON.stringify(msg) });
  }
  serverClose(code: number) {
    // A browser fires "error" before "close" when the handshake fails.
    if (this.readyState === FakeWebSocket.CONNECTING) this.fire("error");
    this.readyState = FakeWebSocket.CLOSED;
    this.fire("close", { code });
  }
}

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  connectionState = "new";
  closed = false;
  private listeners: Record<string, ((e: any) => void)[]> = {};
  constructor(public config: RTCConfiguration) {
    FakePeerConnection.instances.push(this);
  }
  addEventListener(type: string, fn: (e: any) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  addTransceiver() {
    return {
      sender: { getParameters: () => ({ encodings: [{}] }), setParameters: async () => {} },
      setCodecPreferences: () => {},
    };
  }
  async createOffer() {
    return { type: "offer", sdp: "v=0" };
  }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  async addIceCandidate() {}
  async getStats() {
    return new Map();
  }
  close() {
    this.closed = true;
  }
  // Test control.
  setState(state: string) {
    this.connectionState = state;
    for (const fn of this.listeners["connectionstatechange"] ?? []) fn({});
  }
}

const stream = {
  getVideoTracks: () => [{ kind: "video", stop: vi.fn() }],
  getAudioTracks: () => [],
} as unknown as MediaStream;

function sessionResponse(id: string) {
  return {
    id,
    signalingUrl: `wss://glass/v1/relay-sessions/${id}/signaling?token=c-${id}`,
    produceUrl: `wss://glass/v1/relay-sessions/${id}/produce?token=p-${id}-main`,
    produceUrls: {
      main: `wss://glass/v1/relay-sessions/${id}/produce?token=p-${id}-main`,
      cam: `wss://glass/v1/relay-sessions/${id}/produce?token=p-${id}-cam`,
    },
    videoCodec: "h264",
  };
}

let fetchMock: ReturnType<typeof vi.fn>;
let sessionCount = 0;

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  FakePeerConnection.instances = [];
  sessionCount = 0;
  fetchMock = vi.fn(async () => {
    sessionCount++;
    return new Response(JSON.stringify(sessionResponse(`s${sessionCount}`)), { status: 201 });
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
  vi.stubGlobal("RTCRtpSender", { getCapabilities: () => ({ codecs: [{ mimeType: "video/H264" }] }) });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Waits until attempt n (0-based) has a WebSocket, opens it, and brings its peer connection up. */
async function connectAttempt(n: number) {
  await vi.waitFor(() => expect(FakeWebSocket.instances[n]).toBeDefined());
  const ws = FakeWebSocket.instances[n]!;
  ws.open();
  await vi.waitFor(() => expect(ws.sent.some((m) => m.type === "offer")).toBe(true));
  FakePeerConnection.instances[n]!.setState("connected");
  return ws;
}

function recordStates(p: GlassProducer) {
  const states: [ProducerState, string | undefined][] = [];
  p.on("state", (s, d) => states.push([s, d]));
  return states;
}

describe("GlassProducer", () => {
  it("creates a session with the declared slots and produces into the chosen slot", async () => {
    const p = new GlassProducer({ stream, serverUrl: "https://glass", apiToken: "t", slots: ["main", "cam"], slot: "cam" });
    const sessions: any[] = [];
    p.on("session", (s) => sessions.push(s));
    const started = p.start();
    const ws = await connectAttempt(0);
    await started;

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://glass/v1/relay-sessions");
    expect(JSON.parse(init.body)).toEqual({ slots: ["main", "cam"] });
    expect(init.headers.Authorization).toBe("Bearer t");
    expect(ws.url).toContain("token=p-s1-cam");
    expect(sessions).toEqual([
      expect.objectContaining({
        id: "s1",
        slot: "cam",
        signalingUrl: expect.stringContaining("/s1/signaling"),
        produceUrls: expect.objectContaining({ main: expect.stringContaining("p-s1-main") }),
      }),
    ]);
    expect(p.state).toBe("streaming");
    p.stop();
  });

  it("resumes the same produce URL after a drop, closing the dead socket as resumable", async () => {
    const p = new GlassProducer({ stream, serverUrl: "https://glass" });
    const states = recordStates(p);
    const started = p.start();
    const first = await connectAttempt(0);
    await started;

    // The server closes the producer's peer connection (e.g. no media for 2s after a network switch).
    FakePeerConnection.instances[0]!.setState("failed");
    const second = await connectAttempt(1);
    await vi.waitFor(() => expect(p.state).toBe("streaming"));

    expect(first.closeCode).toBe(4000);
    expect(second.url).toBe(first.url);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(states.map(([s]) => s)).toContain("reconnecting");
    expect(states[states.length - 1]).toEqual(["streaming", "resumed"]);
    p.stop();
  });

  it("keeps retrying with backoff while the server is unreachable, then resumes", async () => {
    const p = new GlassProducer({ stream, serverUrl: "https://glass" });
    const started = p.start();
    await connectAttempt(0);
    await started;

    FakeWebSocket.instances[0]!.serverClose(1006);
    // Attempt 2: the socket never opens and errors out.
    await vi.waitFor(() => expect(FakeWebSocket.instances[1]).toBeDefined());
    FakeWebSocket.instances[1]!.serverClose(1006);
    await vi.advanceTimersByTimeAsync(1000); // first backoff
    await connectAttempt(2);
    await vi.waitFor(() => expect(p.state).toBe("streaming"));
    expect(FakeWebSocket.instances[2]!.url).toBe(FakeWebSocket.instances[0]!.url);
    p.stop();
  });

  it("makes a new session once the resume window passes, when it created the session", async () => {
    const p = new GlassProducer({ stream, serverUrl: "https://glass", resumeWindowMs: 5000 });
    const sessions: string[] = [];
    p.on("session", (s) => sessions.push(s.id));
    const started = p.start();
    await connectAttempt(0);
    await started;

    FakeWebSocket.instances[0]!.serverClose(1006);
    // Every resume attempt fails until the window has passed.
    for (let i = 1; FakeWebSocket.instances.length < 20; i++) {
      await vi.waitFor(() => expect(FakeWebSocket.instances[i]).toBeDefined());
      if (fetchMock.mock.calls.length > 1) break;
      FakeWebSocket.instances[i]!.serverClose(1006);
      await vi.advanceTimersByTimeAsync(5000);
    }
    const last = FakeWebSocket.instances.length - 1;
    await connectAttempt(last);
    await vi.waitFor(() => expect(p.state).toBe("streaming"));

    expect(sessions).toEqual(["s1", "s2"]);
    expect(FakeWebSocket.instances[last]!.url).toContain("/s2/produce");
    p.stop();
  });

  it("ends in error when joining an existing session and the resume window passes", async () => {
    const produceUrl = "wss://glass/v1/relay-sessions/x9/produce?token=p";
    const p = new GlassProducer({ stream, produceUrl, resumeWindowMs: 3000 });
    const sessions: any[] = [];
    p.on("session", (s) => sessions.push(s));
    const started = p.start();
    await connectAttempt(0);
    await started;
    expect(sessions[0]).toEqual(expect.objectContaining({ id: "x9", slot: "main" }));

    FakeWebSocket.instances[0]!.serverClose(1006);
    for (let i = 1; p.state !== "error" && i < 20; i++) {
      await vi.waitFor(() => expect(FakeWebSocket.instances[i] !== undefined || p.state === "error").toBe(true));
      FakeWebSocket.instances[i]?.serverClose(1006);
      await vi.advanceTimersByTimeAsync(5000);
    }
    expect(p.state).toBe("error");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stop() closes with 1000 so the server ends the session, and leaves the stream's tracks alone", async () => {
    const p = new GlassProducer({ stream, serverUrl: "https://glass" });
    const started = p.start();
    const ws = await connectAttempt(0);
    await started;

    p.stop();
    expect(ws.closeCode).toBe(1000);
    expect(FakePeerConnection.instances[0]!.closed).toBe(true);
    expect(p.state).toBe("stopped");
    expect(stream.getVideoTracks()[0]!.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("treats codec_mismatch as fatal instead of retrying", async () => {
    const p = new GlassProducer({ stream, serverUrl: "https://glass" });
    const started = p.start();
    const ws = await connectAttempt(0);
    await started;

    ws.serverMessage({ type: "error", code: "codec_mismatch", message: "send H.264" });
    await vi.waitFor(() => expect(p.state).toBe("error"));
    await vi.advanceTimersByTimeAsync(10000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("rejects start() when the first attempt fails", async () => {
    fetchMock.mockResolvedValueOnce(new Response("unauthorized", { status: 401 }));
    const p = new GlassProducer({ stream, serverUrl: "https://glass" });
    await expect(p.start()).rejects.toThrow(/401/);
    expect(p.state).toBe("error");
  });

  it("a joined producer ends in error when Glass says the session is gone (4404)", async () => {
    const p = new GlassProducer({ stream, produceUrl: "wss://glass/v1/relay-sessions/x9/produce?token=p" });
    const states = recordStates(p);
    const started = p.start();
    await connectAttempt(0);
    await started;

    FakeWebSocket.instances[0]!.serverClose(4404);
    await vi.waitFor(() => expect(p.state).toBe("error"));
    expect(states[states.length - 1]).toEqual(["error", "session not found or expired"]);
    await vi.advanceTimersByTimeAsync(10000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("a creating producer makes a new session at once when the old one is gone (4404)", async () => {
    const p = new GlassProducer({ stream, serverUrl: "https://glass" });
    const sessions: string[] = [];
    p.on("session", (s) => sessions.push(s.id));
    const started = p.start();
    await connectAttempt(0);
    await started;

    FakeWebSocket.instances[0]!.serverClose(4404);
    // No resume attempt against the dead session, and no waiting out the resume window.
    await connectAttempt(1);
    await vi.waitFor(() => expect(p.state).toBe("streaming"));
    expect(sessions).toEqual(["s1", "s2"]);
    expect(FakeWebSocket.instances[1]!.url).toContain("/s2/produce");
  });

  it("rejects start() with a clear message when the link's session has expired", async () => {
    const p = new GlassProducer({ stream, produceUrl: "wss://glass/v1/relay-sessions/x9/produce?token=p" });
    const started = p.start();
    await vi.waitFor(() => expect(FakeWebSocket.instances[0]).toBeDefined());
    // Glass accepts the upgrade, then closes it with 4404.
    FakeWebSocket.instances[0]!.open();
    FakeWebSocket.instances[0]!.serverClose(4404);
    await expect(started).rejects.toThrow("session not found or expired");
    expect(p.state).toBe("error");
  });

  it("needs a server URL or a produce URL", () => {
    expect(() => new GlassProducer({ stream })).toThrow(/serverUrl/);
  });
});
