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
    const sender = { replaceTrack: vi.fn(async () => {}) };
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

export const TEST_URL = "ws://glass.test/v1/sessions/s1/signaling?token=tok";

// connectedClient drives one full handshake and returns the client plus
// the server-side fakes.
export async function connectedClient(opts: Partial<GlassClientOptions> = {}) {
  const client = new GlassClient({ signalingUrl: TEST_URL, reconnect: false, ...opts });
  const done = client.connect();
  const ws = FakeWebSocket.last();
  ws.open();
  ws.receive({ type: "offer", sdp: "offer-sdp", connectionId: "c1", producesInput: true, isOwner: true });
  await flush();
  const pc = FakePeerConnection.last();
  const { reliable, fast } = pc.openChannels();
  pc.setState("connected");
  await done;
  return { client, ws, pc, reliable, fast };
}
