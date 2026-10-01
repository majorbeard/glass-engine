// Two-party calling against the /v1/calls API - the reference client for real, bidirectional two-party
// calling, cloned from examples/producer-capacitor/src/producer.ts's own
// getUserMedia/permission handling but genuinely different in shape: both
// sides here send AND receive, there is no producer/consumer split.
//
// Pairing UX: no QR code, unlike the producer example's watch-link flow.
// The person creating a call gets back TWO distinct, already-complete
// signaling URLs (peerAUrl for themselves, peerBUrl for the other party) -
// see handleCreateCall's own doc comment for why they're per-peer grants,
// not one shared token. peerBUrl has to reach a genuinely different
// physical device to be useful, and the two test phones this was built
// against are not guaranteed to be in the same room (an in-app QR scanner
// would be useless across a real distance) - so it's shared the same way
// any other link is: copy it out of this app and paste it into whatever
// channel (chat app, SMS) actually reaches the other phone, then paste it
// into the "Join a call" field there.

export type CallState =
  | "idle"
  | "requesting-media"
  | "creating-call"
  | "connecting"
  | "in-call"
  | "error"
  | "stopped";

export interface CallHandle {
  stop(): void;
}

export interface CallInfo {
  id: string;
  peerAUrl: string;
  peerBUrl: string;
  videoCodec: "h264" | "vp8";
}

export interface StartCallOptions {
  /**
   * "create" mints a brand-new call (POST /v1/calls) and joins it as peer
   * A. "join" connects directly to an already-minted signaling URL (what
   * the OTHER party's "create" call produced as peerBUrl, or peerAUrl if
   * they're the one rejoining) - no server URL needed for this mode, the
   * pasted URL is already a complete ws(s):// endpoint with its own
   * per-peer token embedded.
   */
  mode: "create" | "join";
  /** Required for mode "create": base HTTP(S) URL of the Glass server. */
  serverUrl?: string;
  /** Optional GLASS_API_TOKEN - only relevant to mode "create"'s POST; the signaling URL itself carries its own per-peer grant token and needs no separate bearer auth. */
  apiToken?: string;
  /** Required for mode "join": the full pasted peerAUrl/peerBUrl. */
  signalingUrl?: string;
  turnServer?: { url: string; username: string; credential: string };
  onStateChange: (state: CallState, detail?: string) => void;
  onLocalStream: (stream: MediaStream) => void;
  /** Fires as the other peer's tracks arrive - may fire once or twice (video/audio can arrive as separate ontrack events). */
  onRemoteStream: (stream: MediaStream) => void;
  /** Only fires for mode "create", once the call is minted - this is what the UI needs to show/copy peerBUrl from. */
  onCallCreated?: (info: CallInfo) => void;
}

interface WSSignal {
  type: string;
  sdp?: string;
  candidate?: RTCIceCandidateInit;
}

function authHeaders(apiToken?: string): HeadersInit {
  return apiToken ? { Authorization: `Bearer ${apiToken}` } : {};
}

async function createCall(serverUrl: string, apiToken?: string): Promise<CallInfo> {
  const res = await fetch(`${serverUrl.replace(/\/$/, "")}/v1/calls`, {
    method: "POST",
    headers: authHeaders(apiToken),
  });
  if (!res.ok) {
    throw new Error(`create call failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// Synchronous on purpose - NOT async. See producer.ts's startProducer for
// the full rationale: a caller must have a working stop() before any await
// inside this function runs, or a Stop click during setup (getUserMedia
// prompt, call creation, ICE/TURN negotiation) is a silent no-op on a
// still-null handle ref while the connection races ahead to completion.
export function startCall(options: StartCallOptions): CallHandle {
  const { mode, serverUrl, apiToken, turnServer, onStateChange, onLocalStream, onRemoteStream, onCallCreated } =
    options;
  let signalingUrl = options.signalingUrl;
  let stopped = false;
  let pc: RTCPeerConnection | undefined;
  let ws: WebSocket | undefined;
  let localStream: MediaStream | undefined;

  const cleanup = () => {
    ws?.close(1000, "call ended");
    pc?.close();
    localStream?.getTracks().forEach((t) => t.stop());
  };

  const handle: CallHandle = {
    stop() {
      stopped = true;
      cleanup();
      onStateChange("stopped");
    },
  };

  void (async () => {
  try {
    if (mode === "create" && !serverUrl) {
      throw new Error("serverUrl is required to create a call");
    }
    if (mode === "join" && !signalingUrl) {
      throw new Error("a signaling link is required to join a call");
    }

    onStateChange("requesting-media");
    // getUserMedia rejects the WHOLE call if any requested kind fails, not
    // just the failing one - see producer.ts's own doc comment for the
    // same fallback.
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch (err) {
      console.warn("[call] getUserMedia({video,audio}) failed, retrying video-only:", err);
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    }
    onLocalStream(localStream);
    if (stopped) {
      cleanup();
      return;
    }

    if (mode === "create") {
      onStateChange("creating-call");
      const call = await createCall(serverUrl!, apiToken);
      if (stopped) {
        cleanup();
        return;
      }
      onCallCreated?.(call);
      signalingUrl = call.peerAUrl;
    }

    onStateChange("connecting");
    const iceServers: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
    if (turnServer?.url) {
      iceServers.push({ urls: turnServer.url, username: turnServer.username, credential: turnServer.credential });
    }
    pc = new RTCPeerConnection({ iceServers });
    const activePc = pc;

    // addTrack (not addTransceiver with an explicit direction) - per spec
    // this creates a sendrecv transceiver when no compatible one already
    // exists, matching what the server side expects: it has already bound
    // its own outgoing tracks before it ever sees this offer, so the answer
    // it returns declares sendrecv on both m-lines.
    const videoTrack = localStream.getVideoTracks()[0];
    activePc.addTrack(videoTrack, localStream);
    const audioTrack = localStream.getAudioTracks()[0];
    if (audioTrack) {
      activePc.addTrack(audioTrack, localStream);
    }

    const remoteStream = new MediaStream();
    activePc.addEventListener("track", (e) => {
      remoteStream.addTrack(e.track);
      onRemoteStream(remoteStream);
    });

    ws = new WebSocket(signalingUrl!);
    const activeWs = ws;

    const wsOpen = new Promise<void>((resolve, reject) => {
      activeWs.addEventListener("open", () => resolve(), { once: true });
      activeWs.addEventListener("error", (e) => reject(e), { once: true });
    });

    activePc.addEventListener("icecandidate", (e) => {
      if (e.candidate && activeWs.readyState === WebSocket.OPEN) {
        activeWs.send(JSON.stringify({ type: "ice-candidate", candidate: e.candidate.toJSON() }));
      }
    });
    activePc.addEventListener("connectionstatechange", () => {
      if (activePc.connectionState === "connected") {
        onStateChange("in-call");
      } else if (activePc.connectionState === "failed" || activePc.connectionState === "closed") {
        if (!stopped) onStateChange("error", activePc.connectionState);
      }
    });

    activeWs.addEventListener("message", (event) => {
      const msg: WSSignal = JSON.parse(event.data);
      if (msg.type === "answer" && msg.sdp) {
        void activePc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
      } else if (msg.type === "ice-candidate" && msg.candidate) {
        void activePc.addIceCandidate(msg.candidate);
      }
    });
    activeWs.addEventListener("close", () => {
      if (!stopped) onStateChange("error", "signaling connection closed");
    });

    // See producer.ts's own doc comment - getUserMedia (all local) can
    // finish before the WS handshake does; sending on a not-yet-open
    // socket throws and silently kills the whole attempt.
    await wsOpen;
    if (stopped) {
      cleanup();
      return;
    }

    const offer = await activePc.createOffer();
    await activePc.setLocalDescription(offer);
    activeWs.send(JSON.stringify({ type: "offer", sdp: offer.sdp }));
  } catch (err) {
    if (!stopped) onStateChange("error", err instanceof Error ? err.message : String(err));
    cleanup();
  }
  })();

  return handle;
}
