// Browser WebRTC/WebSocket fakes for GlassClient tests. installFakes()
// replaces the globals GlassClient constructs (WebSocket, RTCPeerConnection,
// RTCIceCandidate, MediaStream) so tests drive the client only through its
// public API, playing the server's side through the fakes. Test-only: not a
// build entry.
import { vi } from "vitest";
import { GlassClient, type GlassClientOptions } from "../index";

export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static last(): FakeWebSocket {
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    if (!ws) throw new Error("no WebSocket created");
    return ws;
  }

  readyState = 0;
  sent: any[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((e: { code?: number }) => void) | null = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(msg: string): void {
    this.sent.push(JSON.parse(msg));
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.closedWith = { code, reason };
  }

  // Server side.
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  drop(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }

  sentOfType(type: string): any[] {
    return this.sent.filter((m) => m.type === type);
  }
}

export class FakeDataChannel {
  readyState: RTCDataChannelState = "open";
  binaryType = "blob";
  bufferedAmount = 0;
  sent: any[] = [];
  onmessage: ((e: { data: ArrayBuffer }) => void) | null = null;

  constructor(public label: string) {}

  send(msg: string): void {
    this.sent.push(JSON.parse(msg));
  }

  close(): void {
    this.readyState = "closed";
  }

  // Server side: one binary message, [type][JSON body].
  receive(type: number, body?: unknown): void {
    const json = body === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(body));
    const msg = new Uint8Array(json.length + 1);
    msg[0] = type;
    msg.set(json, 1);
    this.onmessage?.({ data: msg.buffer });
  }

  receiveRaw(bytes: Uint8Array): void {
    this.onmessage?.({ data: bytes.buffer as ArrayBuffer });
  }
}

// FakeSender is a line's sender: its encodings, as setParameters leaves them.
export class FakeSender {
  replaceTrack = vi.fn(async () => {});
  params: { encodings: RTCRtpEncodingParameters[]; degradationPreference?: string };
  setParametersCalls = 0;
  constructor(encodings: RTCRtpEncodingParameters[]) {
    this.params = { encodings: encodings.map((e) => ({ ...e })) };
  }
  getParameters() {
    return { ...this.params, encodings: this.params.encodings.map((e) => ({ ...e })) };
  }
  async setParameters(p: { encodings: RTCRtpEncodingParameters[]; degradationPreference?: string }) {
    this.setParametersCalls++;
    this.params = { ...p, encodings: p.encodings.map((e) => ({ ...e })) };
  }
  async getStats(): Promise<Map<string, unknown>> {
    return new Map();
  }
}

export class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  static last(): FakePeerConnection {
    const pc = FakePeerConnection.instances[FakePeerConnection.instances.length - 1];
    if (!pc) throw new Error("no RTCPeerConnection created");
    return pc;
  }

  connectionState: RTCPeerConnectionState = "new";
  remoteDescription: RTCSessionDescriptionInit | null = null;
  localDescription: RTCSessionDescriptionInit | null = null;
  addedCandidates: RTCIceCandidateInit[] = [];
  closed = false;
  ontrack: ((e: unknown) => void) | null = null;
  ondatachannel: ((e: { channel: FakeDataChannel }) => void) | null = null;
  onicecandidate: ((e: { candidate: { toJSON(): RTCIceCandidateInit } | null }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;

  constructor(public config: RTCConfiguration) {
    FakePeerConnection.instances.push(this);
  }

  async setRemoteDescription(d: RTCSessionDescriptionInit): Promise<void> {
    await Promise.resolve(); // lets a candidate arrive while the offer is applied
    this.remoteDescription = d;
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: "answer", sdp: "answer-sdp" };
  }

  // The client offers (protocol v3): its lines, numbered by mid as added.
  offers = 0;
  async createOffer(): Promise<RTCSessionDescriptionInit> {
    this.offers++;
    return { type: "offer", sdp: `offer-sdp-${this.offers}` };
  }

  transceivers: Array<{ mid: string; kind: string; direction: string; sender: FakeSender; receiver: object }> = [];
  addTransceiver(trackOrKind: unknown, init?: { direction?: string; sendEncodings?: RTCRtpEncodingParameters[] }): { mid: string; sender: FakeSender } {
    const sender = new FakeSender(init?.sendEncodings ?? [{}]);
    const kind = typeof trackOrKind === "string" ? trackOrKind : ((trackOrKind as { kind?: string }).kind ?? "audio");
    const t = { mid: String(this.transceivers.length), kind, direction: init?.direction ?? "sendrecv", sender, receiver: {} };
    this.transceivers.push(t);
    if (typeof trackOrKind !== "string") this.senders.push(sender);
    return t;
  }

  getTransceivers(): Array<{ mid: string; sender: unknown }> {
    return this.transceivers;
  }

  createdChannels: string[] = [];
  createDataChannel(label: string): FakeDataChannel {
    this.createdChannels.push(label);
    return new FakeDataChannel(label);
  }

  // Server side: a track arriving on the line mid.
  deliverTrack(mid: string, track: { kind: string; id?: string }): void {
    const transceiver = this.transceivers.find((t) => t.mid === mid) ?? { mid };
    this.ontrack?.({ track, transceiver, receiver: {}, streams: [] });
  }

  async setLocalDescription(d: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = d;
  }

  async addIceCandidate(c: RTCIceCandidateInit): Promise<void> {
    this.addedCandidates.push({ candidate: c.candidate });
  }

  // senders are what addTrack returned (the mic placeholder's); a test can
  // make replaceTrack fail through them.
  senders: Array<{ replaceTrack: ReturnType<typeof vi.fn> }> = [];
  addTrack(): unknown {
    const sender = new FakeSender([{}]);
    this.senders.push(sender);
    return sender;
  }

  async getStats(): Promise<Map<string, unknown>> {
    return new Map();
  }

  close(): void {
    this.closed = true;
    this.connectionState = "closed";
  }

  // Server side / network.
  setState(state: RTCPeerConnectionState): void {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }

  openChannels(): { reliable: FakeDataChannel; fast: FakeDataChannel } {
    const reliable = new FakeDataChannel("frames-input");
    const fast = new FakeDataChannel("frames-input-fast");
    this.ondatachannel?.({ channel: reliable });
    this.ondatachannel?.({ channel: fast });
    return { reliable, fast };
  }

  gatherCandidate(candidate: string): void {
    this.onicecandidate?.({ candidate: { toJSON: () => ({ candidate }) } });
  }
}

class FakeIceCandidate {
  candidate: string;
  constructor(init: RTCIceCandidateInit) {
    this.candidate = init.candidate ?? "";
  }
}

class FakeMediaStream {
  tracks: unknown[] = [];
  addTrack(t: unknown): void {
    this.tracks.push(t);
  }
}

// installFakes swaps the globals in; call it in beforeEach.
export function installFakes(): void {
  FakeWebSocket.instances = [];
  FakePeerConnection.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
  vi.stubGlobal("RTCIceCandidate", FakeIceCandidate);
  vi.stubGlobal("MediaStream", FakeMediaStream);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
  // jsdom has no AudioContext, so the mic placeholder fails; that's logged
  // and non-fatal by design.
  vi.spyOn(console, "warn").mockImplementation(() => {});
}

// flush lets the client's promise chains (offer handling) run.
export async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

// installFakeAudioContext lets GlassClient attach its silent mic
// placeholder, so AudioInput paths (grantMicAccess) run for real.
export function installFakeAudioContext(): void {
  class FakeAudioContext {
    createMediaStreamDestination() {
      return { stream: { getAudioTracks: () => [{ kind: "audio" }] } };
    }
    createOscillator() {
      return { connect: (n: unknown) => n, start() {} };
    }
    createGain() {
      return { gain: { value: 1 }, connect: (n: unknown) => n };
    }
    async close() {}
  }
  vi.stubGlobal("AudioContext", FakeAudioContext);
}

export const TEST_URL = "ws://glass.test/v1/sessions/s1/connect?token=tok";

// The session's one source in the default hello: a hosted browser.
export const SRC = "src1";

export function browserSource(id = SRC, extra: Record<string, unknown> = {}) {
  return { id, kind: "browser", state: "live", capabilities: { video: true, navigation: true }, inputMode: "floor", inspect: false, ...extra };
}

// hello is the engine's first message to a connection (protocol v3): the
// owner's link by default, on a session of one browser.
export function hello(extra: Record<string, unknown> = {}) {
  return {
    type: "hello",
    protocolVersion: 3,
    iceServers: [],
    connectionId: "c1",
    owner: true,
    rights: { watch: "all", publish: [], control: "all", owner: true },
    sources: [browserSource()],
    ...extra,
  };
}

// handshake plays the engine's side of one connection: hello, the answer to
// the client's offer, the data channels and the connected state. holds says
// which sources the connection holds the input track of (input_holders).
export async function handshake(ws: FakeWebSocket, helloMsg = hello(), holds: string[] = [SRC]) {
  ws.open();
  ws.receive(helloMsg);
  await flush();
  const pc = FakePeerConnection.last();
  ws.receive({ type: "answer", sdp: "answer-sdp" });
  await flush();
  for (const source of holds) ws.receive({ type: "input_holders", source, holders: [String(helloMsg.connectionId)], floor: null });
  const { reliable, fast } = pc.openChannels();
  pc.setState("connected");
  return { pc, reliable, fast };
}

// connectedClient drives one full handshake and returns the client plus
// the server-side fakes.
export async function connectedClient(opts: Partial<GlassClientOptions> = {}, helloMsg = hello(), holds: string[] = [SRC]) {
  const client = new GlassClient({ link: TEST_URL, reconnect: false, ...opts });
  const done = client.connect();
  const ws = FakeWebSocket.last();
  const { pc, reliable, fast } = await handshake(ws, helloMsg, holds);
  await done;
  return { client, ws, pc, reliable, fast, source: client.source(SRC) };
}
