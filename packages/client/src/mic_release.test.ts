import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectedClient, FakePeerConnection, FakeWebSocket, installFakeAudioContext, installFakes } from "./testing/fakes";

// Regression tests: the real microphone track
// from grantMicAccess() must be stopped on teardown, disconnect, deny, a
// repeat grant, and a failed grant, or the device stays open.

function fakeMicTrack() {
  return { kind: "audio", readyState: "live", stop: vi.fn() };
}

function stubGetUserMedia(track: ReturnType<typeof fakeMicTrack>) {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: vi.fn(async () => ({ getAudioTracks: () => [track] })),
    },
  });
}

describe("the real microphone track is released", () => {
  beforeEach(() => {
    installFakes();
    installFakeAudioContext(); // the connection attaches its mic placeholder
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("is stopped by reconnect teardown", async () => {
    const track = fakeMicTrack();
    stubGetUserMedia(track);
    const { client, ws } = await connectedClient({ reconnect: { maxAttempts: 1, delaysMs: [60_000] } });

    await client.grantMicAccess();
    ws.drop(1006); // a lost socket tears the connection down to reconnect

    expect(track.stop).toHaveBeenCalledTimes(1);
    client.disconnect();
  });

  it("is stopped by disconnect()", async () => {
    const track = fakeMicTrack();
    stubGetUserMedia(track);
    const { client } = await connectedClient();

    await client.grantMicAccess();
    client.disconnect();

    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it("is stopped when replaceTrack fails after getUserMedia succeeded", async () => {
    const track = fakeMicTrack();
    stubGetUserMedia(track);
    const { client, pc } = await connectedClient();
    pc.senders[0]!.replaceTrack.mockRejectedValue(new Error("replaceTrack failed"));

    await expect(client.grantMicAccess()).rejects.toThrow("replaceTrack failed");

    expect(track.stop).toHaveBeenCalledTimes(1);
    client.disconnect();
  });

  it("is stopped by denyMicAccess() after a grant", async () => {
    const track = fakeMicTrack();
    stubGetUserMedia(track);
    const { client, ws } = await connectedClient();

    await client.grantMicAccess();
    client.denyMicAccess();

    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(ws.sentOfType("mic_denied")).toHaveLength(1);
    client.disconnect();
  });

  it("stops the previous track on a repeat grant, and only that one", async () => {
    const first = fakeMicTrack();
    stubGetUserMedia(first);
    const { client } = await connectedClient();
    await client.grantMicAccess();

    const second = fakeMicTrack();
    stubGetUserMedia(second);
    await client.grantMicAccess();

    expect(first.stop).toHaveBeenCalledTimes(1);
    expect(second.stop).not.toHaveBeenCalled();
    expect(FakeWebSocket.last().sentOfType("mic_granted")).toHaveLength(2);
    expect(FakePeerConnection.last().senders).toHaveLength(1);
    client.disconnect();
  });
});
