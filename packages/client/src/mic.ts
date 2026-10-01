// AudioInput: the operator's microphone. See GlassClient (index.ts) for the public API.

import type { ClientCore } from "./core";

// AudioInput - attaches a real, silent
// placeholder audio track to pc BEFORE this connection's answer is
// created, on EVERY connection, not just ones the app expects to use
// AudioInput for. This is not an optimization or a nicety - proven
// live that skipping this
// and only attaching a real track later (once grantMicAccess() is
// actually called) does NOT work: an answer created with no local
// audio track negotiates recvonly, and replaceTrack() on an already-
// recvonly sender can't upgrade that direction afterward - real RTP
// never flows. Attaching a silent placeholder up front makes the
// answer negotiate sendrecv from the very first round trip, so
// grantMicAccess()'s later replaceTrack() delivers real audio
// immediately, with zero renegotiation.
//
// A muted oscillator through a MediaStreamDestination (not
// `getUserMedia` itself) - genuinely silent, and needs no real
// microphone or operator permission just to exist as a negotiation
// placeholder.
export function attachMicPlaceholder(c: ClientCore, pc: RTCPeerConnection): void {
  try {
    const ctx = new AudioContext();
    const dst = ctx.createMediaStreamDestination();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0;
    osc.connect(gain).connect(dst);
    osc.start();
    const track = dst.stream.getAudioTracks()[0];
    if (!track) throw new Error("MediaStreamDestination produced no audio track");
    c.micSender = pc.addTrack(track, dst.stream);
    c.micPlaceholderCtx = ctx;
  } catch (err) {
    // Non-fatal: AudioInput simply won't work for this connection (no
    // sendrecv negotiated for audio), but video/input/everything else
    // is unaffected - matches this SDK's own "degrade, don't break the
    // whole session" posture elsewhere (e.g. downloadReady/uploads).
    console.warn("[GlassClient] Failed to attach mic placeholder track - AudioInput unavailable this connection:", err);
  }
}

// See GlassClient.grantMicAccess.
export async function grantMicAccess(c: ClientCore): Promise<void> {
  if (!c.micSender) {
    denyMicAccess(c);
    throw new Error("no pending mic access request to grant");
  }
  let track: MediaStreamTrack | undefined;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    track = stream.getAudioTracks()[0];
    if (!track) throw new Error("getUserMedia({audio:true}) produced no audio track");
    await c.micSender.replaceTrack(track);
  } catch (err) {
    track?.stop();
    denyMicAccess(c);
    throw err;
  }
  // A repeat grant replaces the previous track on the sender; release it.
  stopMicTrack(c);
  c.micTrack = track;
  if (c.ws && c.signalingConnected) {
    c.ws.send(JSON.stringify({ type: "mic_granted" }));
  }
}

// See GlassClient.denyMicAccess.
export function denyMicAccess(c: ClientCore): void {
  stopMicTrack(c);
  if (c.ws && c.signalingConnected) {
    c.ws.send(JSON.stringify({ type: "mic_denied" }));
  }
}

export function stopMicTrack(c: ClientCore): void {
  if (c.micTrack) {
    c.micTrack.stop();
    c.micTrack = null;
  }
}
