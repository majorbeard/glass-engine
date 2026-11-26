// GlassClient behavior through its public API only, against fake WebSocket
// and RTCPeerConnection globals (see testing/fakes.ts), playing the engine's
// side of protocol v3: hello first, the client offers, the engine answers.
// Message type bytes are the wire protocol's (docs/protocol.md), not internal
// names.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLOSE_LINK_EXPIRED, CLOSE_LINK_REVOKED, CLOSE_VIEWER_LIMIT, GlassClient, LINK_EXPIRED_MESSAGE, LINK_REVOKED_MESSAGE, SESSION_NOT_FOUND_MESSAGE, VIEWER_LIMIT_MESSAGE } from "./index";
import { browserSource, connectedClient, FakePeerConnection, FakeWebSocket, flush, handshake, hello, installFakes, SRC, TEST_URL, type FakeDataChannel } from "./testing/fakes";

const URL = TEST_URL;

beforeEach(() => installFakes());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const connected = connectedClient;

describe("connect", () => {
  // hello comes first, with the engine's ICE servers; the peer connection
  // uses them unless the application gave its own.
  it("uses the engine's ICE servers, sent in hello", async () => {
    const engineIce = [{ urls: ["turn:turn.example:3478"], username: "1:abc", credential: "minted" }];
    const client = new GlassClient({ link: URL, reconnect: false });
    void client.connect();
    const ws = FakeWebSocket.last();
    ws.open();
    ws.receive(hello({ iceServers: engineIce }));
    await flush();
    expect(FakePeerConnection.last().config.iceServers).toEqual(engineIce);
    client.disconnect();
  });

  it("keeps the application's own ICE servers over the engine's", async () => {
    const own = [{ urls: "stun:own.example:3478" }];
    const client = new GlassClient({ link: URL, reconnect: false, iceServers: own });
    void client.connect();
    const ws = FakeWebSocket.last();
    ws.open();
    ws.receive(hello({ iceServers: [{ urls: ["turn:turn.example:3478"] }] }));
    await flush();
    expect(FakePeerConnection.last().config.iceServers).toEqual(own);
    client.disconnect();
  });

  it("offers on hello, takes the answer, and resolves once the peer connects", async () => {
    const client = new GlassClient({ link: URL, reconnect: false });
    const events: string[] = [];
    client.on("connected", () => events.push("connected"));
    const done = client.connect();
    const ws = FakeWebSocket.last();
    expect(ws.url).toBe(URL);
    ws.open();
    ws.receive(hello({ owner: false, connectionId: "c9" }));
    await flush();
    const pc = FakePeerConnection.last();
    expect(ws.sentOfType("offer")).toEqual([{ type: "offer", sdp: "offer-sdp-1" }]);
    // Three receive lines of each kind, and the client's data channel.
    expect(pc.transceivers.filter((t) => t.direction === "recvonly").map((t) => t.kind)).toEqual(["video", "video", "video", "audio", "audio", "audio"]);
    expect(pc.createdChannels).toEqual(["glass-client"]);
    ws.receive({ type: "answer", sdp: "answer-sdp" });
    await flush();
    expect(pc.remoteDescription).toEqual({ type: "answer", sdp: "answer-sdp" });
    pc.openChannels();
    pc.setState("connected");
    await done;
    expect(events).toEqual(["connected"]);
    expect(client.connectionId()).toBe("c9");
    expect(client.isOwner()).toBe(false);
    expect(client.isConnected()).toBe(true);
    client.disconnect();
  });

  it("opens no receive lines for a link that watches nothing", async () => {
    const client = new GlassClient({ link: URL, reconnect: false });
    void client.connect();
    const ws = FakeWebSocket.last();
    ws.open();
    ws.receive(hello({ owner: false, rights: { watch: "none", publish: ["camera"], control: [], owner: false }, sources: [] }));
    await flush();
    expect(FakePeerConnection.last().transceivers.filter((t) => t.direction === "recvonly")).toEqual([]);
    client.disconnect();
  });

  it("offers again with more lines when Glass asks for them", async () => {
    const { client, ws, pc } = await connected();
    ws.receive({ type: "slots_needed", video: 1, audio: 0 });
    await flush();
    expect(ws.sentOfType("offer").map((o) => o.sdp)).toEqual(["offer-sdp-1", "offer-sdp-2"]);
    expect(pc.transceivers.filter((t) => t.direction === "recvonly" && t.kind === "video")).toHaveLength(4);
    client.disconnect();
  });

  it("holds a candidate that arrives before the answer, then adds it", async () => {
    const client = new GlassClient({ link: URL, reconnect: false });
    void client.connect();
    const ws = FakeWebSocket.last();
    ws.open();
    ws.receive(hello());
    ws.receive({ type: "ice-candidate", candidate: { candidate: "candidate:early" } });
    await flush();
    expect(FakePeerConnection.last().addedCandidates).toEqual([]);
    ws.receive({ type: "answer", sdp: "answer-sdp" });
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

  it("rejects and closes on a signaling error that ends the session", async () => {
    const client = new GlassClient({ link: URL, reconnect: false });
    const closed = vi.fn();
    client.on("closed", closed);
    const done = client.connect();
    const ws = FakeWebSocket.last();
    ws.open();
    ws.receive({ type: "error", code: "source_failed", error: "session ended: boom" });
    ws.drop(1000);
    await expect(done).rejects.toThrow();
    expect(closed).toHaveBeenCalledWith("session ended: boom", "source_failed");
  });
});

describe("sources", () => {
  it("knows the session's sources from hello, and their changes", async () => {
    const client = new GlassClient({ link: URL, reconnect: false });
    const events: string[] = [];
    client.on("sourceAdded", (s) => events.push(`added ${s.id} ${s.kind}`));
    client.on("sourceUpdated", (s) => events.push(`updated ${s.id} ${s.state}`));
    client.on("sourceRemoved", (id, reason) => events.push(`removed ${id} ${reason}`));
    const done = client.connect();
    await handshake(FakeWebSocket.last());
    await done;
    const ws = FakeWebSocket.last();
    expect(client.sources().map((s) => s.id)).toEqual([SRC]);
    ws.receive({ type: "source_added", source: { id: "cam1", kind: "camera", state: "live", capabilities: {}, inputMode: "floor", inspect: false } });
    ws.receive({ type: "source_updated", source: { id: "cam1", kind: "camera", state: "stalled", capabilities: {}, inputMode: "floor", inspect: false } });
    ws.receive({ type: "source_removed", id: "cam1", reason: "unpublished" });
    await flush();
    expect(events).toEqual([`added ${SRC} browser`, "added cam1 camera", "updated cam1 stalled", "removed cam1 unpublished"]);
    expect(client.sources().map((s) => s.id)).toEqual([SRC]);
    expect(client.source(SRC).info()?.capabilities.navigation).toBe(true);
    expect(client.source("cam1").info()).toBeNull();
    client.disconnect();
  });

  it("puts a line's track into its source's stream, once Glass maps the line", async () => {
    const { client, ws, pc } = await connected();
    const got: string[] = [];
    client.on("track", (id) => got.push(id));
    const video = { kind: "video", id: "v" };
    pc.deliverTrack("0", video); // not mapped yet: held
    expect(got).toEqual([]);
    expect(client.source(SRC).stream()).toBeNull();
    ws.receive({ type: "tracks", tracks: [{ mid: "0", kind: "video", source: SRC }] });
    await flush();
    expect(got).toEqual([SRC]);
    expect((client.source(SRC).stream() as unknown as { tracks: unknown[] }).tracks).toEqual([video]);
    const audio = { kind: "audio", id: "a" };
    ws.receive({ type: "tracks", tracks: [{ mid: "1", kind: "audio", source: SRC }] });
    await flush();
    pc.deliverTrack("1", audio);
    expect((client.source(SRC).stream() as unknown as { tracks: unknown[] }).tracks).toEqual([video, audio]);
    client.disconnect();
  });

  it("drops a source the next hello no longer lists, and keeps the rest", async () => {
    const two = hello({ sources: [browserSource(), browserSource("src2")] });
    const { client, ws } = await connected({ reconnect: { maxAttempts: 2, delaysMs: [10] } }, two);
    const removed = vi.fn();
    client.on("sourceRemoved", removed);
    ws.drop(1006);
    await handshake(FakeWebSocket.last());
    await flush();
    expect(removed).toHaveBeenCalledWith("src2", "gone");
    expect(client.sources().map((s) => s.id)).toEqual([SRC]);
    client.disconnect();
  });

  it("pauses and resumes receiving a source", async () => {
    const { client, ws, source } = await connected();
    source.receive(true);
    source.receive(false);
    expect(ws.sentOfType("receive")).toEqual([
      { type: "receive", source: SRC, paused: true },
      { type: "receive", source: SRC, paused: false },
    ]);
    client.disconnect();
  });
});

describe("members and rights", () => {
  it("gives the owner the members from hello, then their comings and goings", async () => {
    const rights = { watch: "all", publish: [], control: [], owner: false };
    const { client, ws } = await connected({}, hello({ members: [{ connectionId: "c2", owner: false, rights }] }));
    const changes = vi.fn();
    client.on("membersChanged", changes);
    expect(client.members()).toEqual([{ connectionId: "c2", owner: false, rights }]);
    ws.receive({ type: "member_joined", connectionId: "c3", owner: false, rights });
    ws.receive({ type: "member_left", connectionId: "c2" });
    await flush();
    expect(client.members().map((m) => m.connectionId)).toEqual(["c3"]);
    expect(changes).toHaveBeenCalledTimes(2);
    client.disconnect();
  });

  it("keeps the link's rights, and what the owner denied", async () => {
    const { client, ws } = await connected();
    expect(client.rights()).toMatchObject({ watch: "all", control: "all", owner: true, denied: { watch: [], control: [] } });
    const changed = vi.fn();
    client.on("rightsChanged", changed);
    ws.receive({ type: "rights_changed", rights: { watch: "all", publish: [], control: [], owner: false }, denied: { watch: ["cam1"], control: [] } });
    await flush();
    expect(client.rights()).toEqual({ watch: "all", publish: [], control: [], owner: false, denied: { watch: ["cam1"], control: [] } });
    expect(changed).toHaveBeenCalledTimes(1);
    client.disconnect();
  });

  it("follows who holds a source's input track and its floor", async () => {
    const { client, ws, source } = await connected();
    const got = vi.fn();
    client.on("inputHolders", got);
    expect(source.holdsInput()).toBe(true);
    ws.receive({ type: "input_holders", source: SRC, holders: ["c2"], floor: "c2" });
    await flush();
    expect(source.holdsInput()).toBe(false);
    expect(source.holders()).toEqual(["c2"]);
    expect(source.floorHolder()).toBe("c2");
    expect(got).toHaveBeenCalledWith(SRC, ["c2"], "c2");
    client.disconnect();
  });
});

describe("DataChannel messages", () => {
  const cases: Array<[string, number, Record<string, unknown> | undefined, string, unknown[]]> = [
    ["navigation", 0x06, { url: "https://a.test/", canGoBack: true }, "navigation", [{ url: "https://a.test/", canGoBack: true }, SRC]],
    ["element state", 0x05, { cursor: "pointer" }, "elementState", [{ cursor: "pointer" }, SRC]],
    ["interactive elements", 0x0a, { elements: [{ x: 1, y: 2, width: 3, height: 4 }] }, "interactiveElements", [[{ x: 1, y: 2, width: 3, height: 4 }], SRC]],
    ["clipboard", 0x09, { text: "hi" }, "clipboardText", ["hi", SRC]],
    ["console", 0x0b, { level: "warn", text: "careful" }, "consoleMessage", ["warn", "careful", SRC]],
    ["download ready", 0x0c, { filename: "a.pdf", guid: "g1" }, "downloadReady", ["a.pdf", "g1", SRC]],
    ["file chooser opened", 0x0d, { multiple: true }, "fileChooserOpened", [true, SRC]],
    ["file chooser closed", 0x0e, {}, "fileChooserClosed", [SRC]],
    ["mic access requested", 0x0f, { origin: "https://m.test" }, "micAccessRequested", ["https://m.test", SRC]],
    ["error", 0xff, { error: "bad", code: "encoder_failed" }, "error", ["bad", "encoder_failed"]],
  ];
  for (const [name, type, body, event, args] of cases) {
    it(`emits ${event} for ${name} (0x${type.toString(16)}), naming its source`, async () => {
      const { client, reliable } = await connected();
      const got = vi.fn();
      client.on(event as any, got);
      reliable.receive(type, body && event !== "error" ? { source: SRC, ...body } : body);
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

  it("keeps a source's open dialog, then clears it when it closes", async () => {
    const { client, reliable, source } = await connected();
    const got = vi.fn();
    client.on("dialog", got);
    reliable.receive(0x11, { source: SRC, open: true, type: "prompt", message: "name?", defaultPrompt: "x", inPicture: false });
    expect(got).toHaveBeenCalledWith({ open: true, type: "prompt", message: "name?", defaultPrompt: "x", inPicture: false }, SRC);
    expect(source.dialog()?.message).toBe("name?");
    source.answerDialog(true, "glass");
    expect(reliable.sent[reliable.sent.length - 1]).toMatchObject({ type: "dialog_answer", data: { accept: true, text: "glass" }, source: SRC });
    reliable.receive(0x11, { source: SRC, open: false, inPicture: false });
    expect(source.dialog()).toBeNull();
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

  it("sends clicks and keys on the reliable channel with a send time and the source", async () => {
    const { client, reliable, source } = await connected();
    vi.spyOn(Date, "now").mockReturnValue(1000);
    source.mouseDown(10, 20, "right", 2, 1);
    expect(last(reliable)).toEqual({ type: "mousedown", data: { x: 10, y: 20, button: "right", modifiers: 2, clickCount: 1, t: 1000, s: expect.any(Number) }, source: SRC });
    source.dispatchKeyEvent({ type: "keydown", key: "a", code: "KeyA", shiftKey: true, ctrlKey: true } as any);
    expect(last(reliable)).toMatchObject({ type: "keydown", data: { key: "a", code: "KeyA", modifiers: 10 }, source: SRC });
    client.disconnect();
  });

  it("withholds input to a source this connection doesn't hold, and says so", async () => {
    const { client, reliable } = await connected({}, hello({ sources: [browserSource(), browserSource("src2")] }));
    const drops = vi.fn();
    client.on("inputDropped", drops);
    const before = reliable.sent.length;
    client.source("src2").mouseDown(1, 1);
    expect(reliable.sent.length).toBe(before);
    expect(drops).toHaveBeenCalledWith(expect.objectContaining({ code: "not_authorized", eventType: "mousedown", local: true, source: "src2" }));
    client.disconnect();
  });

  it("sends touchmove and scroll on the fast channel, other touches on the reliable one", async () => {
    const { client, reliable, fast, source } = await connected();
    const pts = [{ id: 1, x: 5, y: 6 }];
    source.dispatchTouch("touchstart", pts, 7);
    source.dispatchTouch("touchmove", pts, 7);
    source.dispatchTouch("touchend", [], 7, 1);
    source.scroll(120, 0, 0);
    expect(reliable.sent.map((m) => m.type)).toEqual(expect.arrayContaining(["touchstart", "touchend"]));
    expect(reliable.sent.find((m) => m.type === "touchend").data).toMatchObject({ gestureId: 7, moveCount: 1 });
    expect(fast.sent.map((m) => m.type)).toEqual(["touchmove", "scroll"]);
    expect(fast.sent.every((m) => m.source === SRC)).toBe(true);
    client.disconnect();
  });

  it("batches hover moves and sends only the latest", async () => {
    const { client, fast, source } = await connected();
    vi.useFakeTimers();
    source.mouseMove(1, 1, false);
    source.mouseMove(2, 2, false);
    source.mouseMove(3, 3, false);
    expect(fast.sent).toEqual([]);
    vi.advanceTimersByTime(20);
    expect(fast.sent).toHaveLength(1);
    expect(fast.sent[0]).toMatchObject({ type: "mousemove", data: { x: 3, y: 3, dragging: false }, source: SRC });
    client.disconnect();
  });

  it("stops the batch timer once idle and restarts it on the next move", async () => {
    const { client, fast, source } = await connected();
    vi.useFakeTimers();
    const clear = vi.spyOn(globalThis, "clearInterval");
    source.mouseMove(1, 1, false);
    vi.advanceTimersByTime(20); // sends
    vi.advanceTimersByTime(20); // empty tick: stops
    expect(clear).toHaveBeenCalled();
    const idleTimers = vi.getTimerCount();
    vi.advanceTimersByTime(1000);
    expect(vi.getTimerCount()).toBe(idleTimers);
    source.mouseMove(2, 2, false);
    vi.advanceTimersByTime(20);
    expect(fast.sent.map((m) => m.data.x)).toEqual([1, 2]);
    client.disconnect();
  });

  it("caps drag moves to about 60 Hz", async () => {
    const { client, fast, source } = await connected();
    let now = 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    source.mouseMove(1, 1, true);
    now += 5;
    source.mouseMove(2, 2, true); // inside the window: dropped
    now += 15;
    source.mouseMove(3, 3, true);
    expect(fast.sent.map((m) => m.data.x)).toEqual([1, 3]);
    client.disconnect();
  });

  it("sends navigation, naming its source, and the viewport over signaling", async () => {
    const { client, ws, source } = await connected();
    source.navigate("https://b.test/");
    client.sendInitialViewport(800, 600, true, "UA");
    expect(ws.sentOfType("navigate")).toEqual([{ type: "navigate", url: "https://b.test/", source: SRC }]);
    expect(ws.sentOfType("initial_viewport")).toEqual([{ type: "initial_viewport", width: 800, height: 600, isMobile: true, userAgent: "UA" }]);
    client.disconnect();
  });

  it("builds a source's download and upload routes with the link's token", async () => {
    const { client, source } = await connected();
    expect(source.downloadUrl("g1")).toBe(`http://glass.test/v1/sessions/s1/sources/${SRC}/downloads/g1?token=tok`);
    await source.uploadFiles([new File(["x"], "a.txt")]);
    expect(fetch).toHaveBeenCalledWith(`http://glass.test/v1/sessions/s1/sources/${SRC}/upload?token=tok`, expect.objectContaining({ method: "POST" }));
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
    await handshake(FakeWebSocket.last());
    await flush();
    expect(events[events.length - 1]).toBe("connected");
    client.disconnect();
  });

  it("keeps retrying through a link that drops everything", async () => {
    const { client, ws } = await connected({ reconnect: { maxAttempts: 4, delaysMs: [1000, 2000] } });
    vi.useFakeTimers();
    const events: string[] = [];
    client.on("reconnecting", (n: number, max: number) => events.push(`reconnecting ${n}/${max}`));
    client.on("closed", (r: string) => events.push(`closed ${r}`));
    ws.drop(1006);
    // Every attempt's socket neither opens nor closes, as when every packet
    // is dropped: each attempt ends on its own timers, and an earlier
    // attempt's timer must not settle a later one.
    for (let s = 0; s < 120; s++) {
      vi.advanceTimersByTime(1000);
      await flush();
    }
    expect(events).toEqual(["reconnecting 1/4", "reconnecting 2/4", "reconnecting 3/4", "reconnecting 4/4", "closed reconnection attempts exhausted"]);
  });

  it("connects on a slow attempt after a fast failure", async () => {
    const { client, ws } = await connected({ reconnect: { maxAttempts: 3, delaysMs: [100] } });
    vi.useFakeTimers();
    const events: string[] = [];
    client.on("connected", () => events.push("connected"));
    ws.drop(1006);
    FakeWebSocket.last().drop(1006); // attempt 1 fails at once; its timers would fire at 10 s and 15 s
    await flush();
    vi.advanceTimersByTime(100);
    await flush();
    const attempt2 = FakeWebSocket.last();
    attempt2.open();
    attempt2.receive(hello());
    await flush();
    // 15.05 s in: past attempt 1's peer timer (15 s from its start), not yet
    // attempt 2's own (15 s from 0.1 s). Attempt 2 must still be up.
    vi.advanceTimersByTime(14950);
    await flush();
    expect(attempt2.closedWith).toBeNull();
    FakePeerConnection.last().setState("connected");
    await flush();
    expect(events).toEqual(["connected"]);
    client.disconnect();
  });

  it("keeps a source and its viewer across a reconnect, with fresh tracks", async () => {
    const { client, ws, pc } = await connected({ reconnect: { maxAttempts: 2, delaysMs: [10] } });
    ws.receive({ type: "tracks", tracks: [{ mid: "0", kind: "video", source: SRC }] });
    pc.deliverTrack("0", { kind: "video" });
    expect(client.source(SRC).stream()).not.toBeNull();
    ws.drop(1006);
    // The old connection's tracks went with it.
    expect(client.source(SRC).stream()).toBeNull();
    expect(client.sources().map((s) => s.id)).toEqual([SRC]);
    const { pc: pc2 } = await handshake(FakeWebSocket.last());
    FakeWebSocket.last().receive({ type: "tracks", tracks: [{ mid: "0", kind: "video", source: SRC }] });
    pc2.deliverTrack("0", { kind: "video" });
    expect(client.source(SRC).stream()).not.toBeNull();
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
    expect(closed).toHaveBeenCalledWith("reconnection attempts exhausted", "reconnect_exhausted");
  });

  // A client never makes a session: on a 4404 it says
  // the session ended, and the application's backend decides what next.
  it("closes without retrying when the server says the session is gone", async () => {
    const { client, ws } = await connected({ reconnect: { maxAttempts: 5, delaysMs: [10] } });
    const closed = vi.fn();
    client.on("closed", closed);
    ws.drop(1006);
    FakeWebSocket.last().drop(4404);
    await flush();
    expect(closed).toHaveBeenCalledWith(SESSION_NOT_FOUND_MESSAGE, "session_not_found");
    expect(fetch).not.toHaveBeenCalled();
  });

  // The engine ends each live connection with 4404 when it closes the session; the client stops
  // with that reason instead of reconnecting to a session that is gone.
  it("closes without retrying when the session ends while connected", async () => {
    const { client, ws } = await connected({ reconnect: { maxAttempts: 5, delaysMs: [10] } });
    const events: string[] = [];
    client.on("reconnecting", (n: number, max: number) => events.push(`reconnecting ${n}/${max}`));
    client.on("closed", (r: string) => events.push(`closed ${r}`));
    ws.drop(4404);
    await flush();
    expect(events).toEqual([`closed ${SESSION_NOT_FOUND_MESSAGE}`]);
  });

  it("closes without retrying when the server says the link has expired", async () => {
    const { client, ws } = await connected({ reconnect: { maxAttempts: 5, delaysMs: [10] } });
    const closed = vi.fn();
    client.on("closed", closed);
    ws.drop(1006);
    FakeWebSocket.last().drop(CLOSE_LINK_EXPIRED);
    await flush();
    expect(closed).toHaveBeenCalledWith(LINK_EXPIRED_MESSAGE, "link_expired");
  });

  // A viewer refused at the engine's viewer limit is told why on a first connect, and a reconnect
  // keeps trying: a place can free up.
  it("fails a first connect at the viewer limit with its reason", async () => {
    const client = new GlassClient({ link: URL, reconnect: false });
    const done = client.connect();
    const ws = FakeWebSocket.last();
    ws.open();
    ws.drop(CLOSE_VIEWER_LIMIT);
    await expect(done).rejects.toThrow(VIEWER_LIMIT_MESSAGE);
  });

  it("says why while reconnecting at the viewer limit, and keeps trying", async () => {
    const { client, ws } = await connected({ reconnect: { maxAttempts: 3, delaysMs: [10] } });
    const events: string[] = [];
    client.on("refused", (r: string) => events.push(`refused ${r}`));
    client.on("reconnecting", (n: number, max: number) => events.push(`reconnecting ${n}/${max}`));
    client.on("closed", (r: string) => events.push(`closed ${r}`));
    ws.drop(1006);
    await flush();
    FakeWebSocket.last().drop(CLOSE_VIEWER_LIMIT);
    await flush();
    expect(events).toEqual(["reconnecting 1/3", `refused ${VIEWER_LIMIT_MESSAGE}`]);
    client.disconnect();
  });

  // The default: retrying on. A refused first connect says why before each retry, instead of
  // retrying in silence.
  it("says why before retrying a first connect refused at the viewer limit", async () => {
    const client = new GlassClient({ link: URL, reconnect: { maxAttempts: 3, delaysMs: [10] } });
    const events: string[] = [];
    client.on("refused", (r: string) => events.push(`refused ${r}`));
    client.on("reconnecting", (n: number, max: number) => events.push(`reconnecting ${n}/${max}`));
    client.on("closed", (r: string) => events.push(`closed ${r}`));
    void client.connect().catch(() => undefined);
    const ws = FakeWebSocket.last();
    ws.open();
    ws.drop(CLOSE_VIEWER_LIMIT);
    await flush();
    expect(events).toEqual([`refused ${VIEWER_LIMIT_MESSAGE}`, "reconnecting 1/3"]);
    client.disconnect();
  });

  // An `error` without a final code is a report, not the end of the
  // session, not_connected included: the client stays, and may still recover.
  it("reconnects after the engine reports a lost transport", async () => {
    const { client, ws } = await connected({ reconnect: { maxAttempts: 3, delaysMs: [10] } });
    const events: string[] = [];
    client.on("error", (m: string) => events.push(`error ${m}`));
    client.on("reconnecting", (n: number, max: number) => events.push(`reconnecting ${n}/${max}`));
    client.on("closed", (r: string) => events.push(`closed ${r}`));
    ws.receive({ type: "error", code: "not_connected", error: "the connection did not come up" });
    ws.drop(1006);
    await flush();
    expect(events).toEqual(["error the connection did not come up", "reconnecting 1/3"]);
    client.disconnect();
  });

  it("still reconnects after an earlier error that left the session running", async () => {
    const { client, ws } = await connected({ reconnect: { maxAttempts: 3, delaysMs: [10] } });
    const events: string[] = [];
    client.on("reconnecting", (n: number, max: number) => events.push(`reconnecting ${n}/${max}`));
    client.on("closed", (r: string) => events.push(`closed ${r}`));
    ws.receive({ type: "error", error: "navigation not supported by this source" });
    await flush();
    ws.drop(1006);
    await flush();
    expect(events).toEqual(["reconnecting 1/3"]);
    client.disconnect();
  });

  it("closes without retrying on an error whose code ends the session", async () => {
    const { client, ws } = await connected({ reconnect: { maxAttempts: 5, delaysMs: [10] } });
    const closed = vi.fn();
    client.on("closed", closed);
    const sockets = FakeWebSocket.instances.length;
    ws.receive({ type: "error", code: "source_failed", error: "the browser stopped" });
    ws.drop(1011);
    await flush();
    expect(closed).toHaveBeenCalledWith("the browser stopped", "source_failed");
    expect(FakeWebSocket.instances).toHaveLength(sockets);
  });

  it("stops retrying when a reconnect attempt is told the session can't resume", async () => {
    const { client, ws } = await connected({ reconnect: { maxAttempts: 5, delaysMs: [10] } });
    const closed = vi.fn();
    client.on("closed", closed);
    ws.drop(1006);
    const attempt = FakeWebSocket.last();
    attempt.open();
    attempt.receive({ type: "error", code: "session_not_resumable", error: "session cannot be resumed" });
    attempt.drop(1006);
    await flush();
    const sockets = FakeWebSocket.instances.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(closed).toHaveBeenCalledWith("session cannot be resumed", "session_not_resumable");
    expect(FakeWebSocket.instances).toHaveLength(sockets);
  });

  it("closes without retrying when the link is revoked mid-session", async () => {
    const { client, ws } = await connected({ reconnect: { maxAttempts: 5, delaysMs: [10] } });
    const closed = vi.fn();
    client.on("closed", closed);
    const sockets = FakeWebSocket.instances.length;
    ws.drop(CLOSE_LINK_REVOKED);
    await flush();
    await new Promise((r) => setTimeout(r, 50));
    expect(closed).toHaveBeenCalledWith(LINK_REVOKED_MESSAGE, "link_revoked");
    expect(FakeWebSocket.instances).toHaveLength(sockets);
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

describe("page unload", () => {
  it("sends nothing, so the member's place is held for the same tab to reconnect", async () => {
    const { client, ws } = await connected();
    window.dispatchEvent(new Event("pagehide"));
    window.dispatchEvent(new Event("beforeunload"));
    await flush();
    expect(fetch).not.toHaveBeenCalled();
    expect(ws.closedWith).toBeNull();
    client.disconnect();
  });
});

describe("disconnect", () => {
  it("leaves once, emits closed, then goes quiet, ending nothing for anyone else", async () => {
    const { client, ws, pc } = await connected();
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
    expect(fetch).not.toHaveBeenCalled();
    expect(later).not.toHaveBeenCalled();
  });
});

describe("connection quality", () => {
  it("reports Glass's connection_quality and keeps the last one", async () => {
    const { client, ws } = await connected();
    expect(client.connectionQuality()).toBeNull();
    const got: Array<[string, number]> = [];
    client.on("connectionQuality", (q: string, score: number) => got.push([q, score]));
    ws.receive({ type: "connection_quality", quality: "poor", score: 30 });
    ws.receive({ type: "connection_quality", quality: "weird", score: 1 }); // not a level: ignored
    ws.receive({ type: "connection_quality", quality: "good", score: 58 });
    await flush();
    expect(got).toEqual([["poor", 30], ["good", 58]]);
    expect(client.connectionQuality()).toEqual({ quality: "good", score: 58 });
    client.disconnect();
  });
});

describe("protocol version", () => {
  // A client that joined by link alone learns the engine's protocol version
  // from hello, and refuses one it doesn't speak.
  it("closes, without retrying, on an engine that speaks another version", async () => {
    const client = new GlassClient({ link: URL, reconnect: { maxAttempts: 3, delaysMs: [1] } });
    const closed = vi.fn();
    client.on("closed", closed);
    const done = client.connect();
    const ws = FakeWebSocket.last();
    ws.open();
    ws.receive(hello({ protocolVersion: 2 }));
    await expect(done).rejects.toThrow("protocol v2");
    expect(closed).toHaveBeenCalledWith(expect.stringContaining("protocol v2"), "protocol_mismatch");
    expect(ws.closedWith?.code).toBe(1000);
    expect(FakeWebSocket.instances.length).toBe(1);
    expect(FakePeerConnection.instances.length).toBe(0);
  });
});

describe("control answers", () => {
  it("resolves each request on a source with Glass's answer to it", async () => {
    const { client, ws, source } = await connected();
    const asked = source.requestInput();
    const granted = source.grantInput("c2");
    const denied = source.denyWatch("c3");
    const [req, grant, deny] = [ws.sentOfType("request_input")[0], ws.sentOfType("grant_input")[0], ws.sentOfType("deny_watch")[0]];
    expect(grant).toMatchObject({ connectionId: "c2", source: SRC });
    expect(deny).toMatchObject({ connectionId: "c3", source: SRC });
    expect(req.id).not.toBe(grant.id);
    ws.receive({ type: "control_answer", action: "grant_input", outcome: "refused", reason: "no_capacity", connectionId: "c2", source: SRC, id: grant.id });
    ws.receive({ type: "control_answer", action: "request_input", outcome: "relayed", source: SRC, id: req.id });
    ws.receive({ type: "control_answer", action: "deny_watch", outcome: "revoked", source: SRC, connectionId: "c3", id: deny.id });
    await expect(asked).resolves.toEqual({ action: "request_input", outcome: "relayed", source: SRC });
    await expect(granted).resolves.toEqual({ action: "grant_input", outcome: "refused", reason: "no_capacity", connectionId: "c2", source: SRC });
    await expect(denied).resolves.toEqual({ action: "deny_watch", outcome: "revoked", connectionId: "c3", source: SRC });
    client.disconnect();
  });

  it("resolves a request still waiting as disconnected when the connection goes", async () => {
    const { client, source } = await connected();
    const released = source.releaseInput();
    client.disconnect();
    await expect(released).resolves.toEqual({ action: "release_input", outcome: "refused", reason: "disconnected", source: SRC });
  });

  it("refuses at once when not connected", async () => {
    const client = new GlassClient({ link: URL, reconnect: false });
    await expect(client.source(SRC).revokeInput("c2")).resolves.toEqual({ action: "revoke_input", outcome: "refused", reason: "not_connected", connectionId: "c2", source: SRC });
  });
});
