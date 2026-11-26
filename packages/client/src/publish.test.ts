// Publishing on the client's one connection (protocol v3): each track is a
// send-only line, announced with "publish" before the offer that carries it.
// Through the public API, against the fakes playing the engine's side.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GlassClient } from "./index";
import { connectedClient, FakePeerConnection, FakeWebSocket, flush, handshake, hello, installFakes, TEST_URL, type FakeSender } from "./testing/fakes";

beforeEach(() => installFakes());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// A member's link on a session whose members publish: it watches all and
// publishes cameras and microphones.
const publisher = () => hello({ owner: false, rights: { watch: "all", publish: ["camera", "microphone"], control: [], owner: false }, sources: [] });

const camera = (height = 720) => ({ kind: "video", id: "cam", getSettings: () => ({ width: (height * 16) / 9, height }) }) as unknown as MediaStreamTrack;
const microphone = () => ({ kind: "audio", id: "mic", getSettings: () => ({}) }) as unknown as MediaStreamTrack;

function sendOnly(pc: FakePeerConnection) {
  return pc.transceivers.filter((t) => t.direction === "sendonly");
}

describe("publish", () => {
  it("announces a track published before connecting with its first offer", async () => {
    const client = new GlassClient({ link: TEST_URL, reconnect: false });
    const pub = client.publish(camera(), { kind: "camera" });
    const done = client.connect();
    const ws = FakeWebSocket.last();
    await handshake(ws, publisher(), []);
    await done;
    const pc = FakePeerConnection.last();
    const line = sendOnly(pc)[0]!;
    expect(line.kind).toBe("video");
    expect(pub.mid()).toBe(line.mid);
    // publish comes before the offer that carries the line.
    const order = ws.sent.map((m) => m.type).filter((t) => t === "publish" || t === "offer");
    expect(order).toEqual(["publish", "offer"]);
    expect(ws.sentOfType("publish")).toEqual([{ type: "publish", mid: line.mid, kind: "camera" }]);
    client.disconnect();
  });

  it("publishes a track on a live connection with a fresh offer", async () => {
    const { client, ws, pc } = await connectedClient({}, publisher(), []);
    const offers = ws.sentOfType("offer").length;
    const pub = client.publish(microphone(), { kind: "microphone" });
    await flush();
    expect(ws.sentOfType("offer")).toHaveLength(offers + 1);
    expect(ws.sentOfType("publish")).toEqual([{ type: "publish", mid: pub.mid(), kind: "microphone" }]);
    expect(sendOnly(pc).map((t) => t.kind)).toEqual(["audio"]);
    expect(client.publications()).toEqual([pub]);
    client.disconnect();
  });

  it("adds the start bitrate to the answer when it publishes a picture", async () => {
    const client = new GlassClient({ link: TEST_URL, reconnect: false });
    client.publish(camera(), { kind: "camera", startBitrateKbps: 400 });
    void client.connect();
    const ws = FakeWebSocket.last();
    ws.open();
    ws.receive(publisher());
    await flush();
    const sdp = "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 VP8/90000\r\na=fmtp:96 max-fr=30\r\n";
    ws.receive({ type: "answer", sdp });
    await flush();
    expect(FakePeerConnection.last().remoteDescription?.sdp).toContain("x-google-start-bitrate=400");
    client.disconnect();
  });

  it("sends a simulcast camera as three layers, the full one alone at first, capped", async () => {
    const client = new GlassClient({ link: TEST_URL, reconnect: false });
    client.publish(camera(720), { kind: "camera", simulcast: true, maxBitrateKbps: 900 });
    void client.connect();
    await handshake(FakeWebSocket.last(), publisher(), []);
    const sender = sendOnly(FakePeerConnection.last())[0]!.sender as FakeSender;
    const enc = sender.getParameters().encodings;
    expect(enc.map((e) => e.rid)).toEqual(["q", "h", "f"]);
    expect(enc.map((e) => e.active)).toEqual([false, false, true]);
    expect(enc[2]!.maxBitrate).toBe(900_000);
    client.disconnect();
  });

  it("turns layers on as Glass asks, and reports them once a second with the line's mid", async () => {
    vi.useFakeTimers();
    const client = new GlassClient({ link: TEST_URL, reconnect: false });
    const pub = client.publish(camera(720), { kind: "camera", simulcast: true });
    const done = client.connect();
    const ws = FakeWebSocket.last();
    await handshake(ws, publisher(), []);
    await done;
    const asked = vi.fn();
    pub.on("layers", asked);
    ws.receive({ type: "layers_wanted", rids: ["h", "f"], mid: pub.mid() });
    await vi.advanceTimersByTimeAsync(0);
    const sender = sendOnly(FakePeerConnection.last())[0]!.sender as FakeSender;
    expect(sender.getParameters().encodings.map((e) => e.active)).toEqual([false, true, true]);
    expect(asked).toHaveBeenCalledWith(["h", "f"]);
    await vi.advanceTimersByTimeAsync(1000);
    const report = ws.sentOfType("producer_report")[0];
    expect(report).toMatchObject({ mid: pub.mid(), layers: [{ rid: "q", active: false }, { rid: "h", active: true }, { rid: "f", active: true }] });
    client.disconnect();
  });

  it("tells the application when Glass refuses a track, and forgets it", async () => {
    const { client, ws } = await connectedClient({}, publisher(), []);
    const pub = client.publish(camera(), { kind: "camera" });
    await flush();
    const refused = vi.fn();
    pub.on("refused", refused);
    ws.receive({ type: "publish_refused", mid: pub.mid(), reason: "not_allowed" });
    await flush();
    expect(refused).toHaveBeenCalledWith("not_allowed");
    expect(client.publications()).toEqual([]);
    client.disconnect();
  });

  it("unpublishes on stop, and leaves the application's track running", async () => {
    const { client, ws, pc } = await connectedClient({}, publisher(), []);
    const track = camera();
    const pub = client.publish(track, { kind: "camera" });
    await flush();
    const mid = pub.mid();
    pub.stop();
    expect(ws.sentOfType("unpublish")).toEqual([{ type: "unpublish", mid }]);
    expect(sendOnly(pc)).toEqual([]); // the line went inactive
    expect(client.publications()).toEqual([]);
    client.disconnect();
  });

  it("publishes again on the new connection after a reconnect", async () => {
    const { client, ws } = await connectedClient({ reconnect: { maxAttempts: 2, delaysMs: [10] } }, publisher(), []);
    client.publish(camera(), { kind: "camera" });
    await flush();
    ws.drop(1006);
    const ws2 = FakeWebSocket.last();
    await handshake(ws2, publisher(), []);
    await flush();
    const pc2 = FakePeerConnection.last();
    expect(sendOnly(pc2).map((t) => t.kind)).toEqual(["video"]);
    expect(ws2.sentOfType("publish")).toEqual([{ type: "publish", mid: sendOnly(pc2)[0]!.mid, kind: "camera" }]);
    client.disconnect();
  });
});

// The silence check, as LiveKit's SDK makes it.
describe("a silent microphone", () => {
  function fakeAudio(samples: number[], state = "running") {
    class FakeCtx {
      state = state;
      createAnalyser() {
        return { fftSize: 0, frequencyBinCount: samples.length, getByteTimeDomainData: (a: Uint8Array) => a.set(samples) };
      }
      createMediaStreamSource() {
        return { connect() {}, disconnect() {} };
      }
      async resume() {}
      async close() {}
    }
    vi.stubGlobal("AudioContext", FakeCtx);
  }

  it("is reported when every sample is silence", async () => {
    fakeAudio([128, 128, 0, 128]);
    const client = new GlassClient({ link: TEST_URL, reconnect: false });
    const pub = client.publish(microphone(), { kind: "microphone" });
    const silent = vi.fn();
    pub.on("silent", silent);
    await vi.waitFor(() => expect(silent).toHaveBeenCalledTimes(1), { timeout: 2000 });
  });

  it("is not reported for sound, nor where the audio context will not run", async () => {
    for (const [samples, state] of [[[128, 131, 125, 128], "running"], [[128, 128], "suspended"]] as const) {
      fakeAudio([...samples], state);
      const client = new GlassClient({ link: TEST_URL, reconnect: false });
      const pub = client.publish(microphone(), { kind: "microphone" });
      const silent = vi.fn();
      pub.on("silent", silent);
      await new Promise((r) => setTimeout(r, 600));
      expect(silent).not.toHaveBeenCalled();
    }
  });
});
