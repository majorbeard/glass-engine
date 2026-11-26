// Two people seeing and hearing each other over Glass: a session of at most
// two members, each with a link that watches and publishes a camera and a
// microphone. Each member publishes its own camera and microphone on
// @glass/client's one connection, and receives the other's (never its own).
//
// Pairing: no QR code. The person starting the call gets two links, one for
// themselves and one for the other person, and shares the other through
// whatever channel reaches them (a chat app, SMS); they paste it into the
// "Join a call" field.

import { createGlassSession, GlassClient, mintGlassLink, type GlassLinkRequest } from "@glass/client";

export type CallState = "idle" | "requesting-media" | "creating-call" | "connecting" | "in-call" | "error" | "stopped";

export interface CallHandle {
  stop(): void;
}

export interface CallInfo {
  id: string;
  /** This person's own link. */
  myLink: string;
  /** The link to send to the other person. */
  otherLink: string;
}

export interface StartCallOptions {
  /**
   * "create" makes a session (POST /v1/sessions, at most two members) and two links, and joins with the
   * first. "join" connects with a link the other person sent; no server URL is needed for it.
   */
  mode: "create" | "join";
  /** Required for mode "create": base HTTP(S) URL of the Glass server. */
  serverUrl?: string;
  /** GLASS_API_TOKEN, for mode "create": making a session takes it; a link needs nothing more. */
  apiToken?: string;
  /** Required for mode "join": the pasted link. */
  link?: string;
  /** A TURN server of your own. Without one, the engine's are used, with a short-lived TURN credential of its own. */
  turnServer?: { url: string; username: string; credential: string };
  onStateChange: (state: CallState, detail?: string) => void;
  onLocalStream: (stream: MediaStream) => void;
  /** Fires as the other person's camera and microphone arrive, with one stream holding both. */
  onRemoteStream: (stream: MediaStream) => void;
  /** Mode "create" only, once the session and its links exist: the UI shows and copies otherLink. */
  onCallCreated?: (info: CallInfo) => void;
}

// Both links watch everything and publish a camera and a microphone.
const MEMBER: GlassLinkRequest = { watch: "all", publish: ["camera", "microphone"] };

// Synchronous on purpose, not async: a caller must have a working stop()
// before any await inside runs, or a Stop click during setup (the camera
// prompt, making the session, connecting) is a no-op on a still-null handle.
export function startCall(options: StartCallOptions): CallHandle {
  const { mode, serverUrl, apiToken, turnServer, onStateChange, onLocalStream, onRemoteStream, onCallCreated } = options;
  let stopped = false;
  let client: GlassClient | undefined;
  let localStream: MediaStream | undefined;

  const cleanup = () => {
    client?.disconnect();
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
      if (mode === "create" && !serverUrl) throw new Error("serverUrl is required to create a call");
      if (mode === "join" && !options.link) throw new Error("a call link is required to join a call");

      onStateChange("requesting-media");
      // getUserMedia rejects the whole call if any requested kind fails, so
      // a missing or denied microphone falls back to video only.
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      } catch (err) {
        console.warn("[call] getUserMedia({video,audio}) failed, retrying video-only:", err);
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }
      onLocalStream(localStream);
      if (stopped) return cleanup();

      let link = options.link;
      if (mode === "create") {
        onStateChange("creating-call");
        const base = { baseUrl: serverUrl!.replace(/\/$/, ""), apiToken };
        const session = await createGlassSession({ ...base, maxMembers: 2 });
        const mine = await mintGlassLink({ ...base, sessionId: session.id, rights: MEMBER });
        const theirs = await mintGlassLink({ ...base, sessionId: session.id, rights: MEMBER });
        if (stopped) return cleanup();
        onCallCreated?.({ id: session.id, myLink: mine.url, otherLink: theirs.url });
        link = mine.url;
      }

      onStateChange("connecting");
      const iceServers: RTCIceServer[] | undefined = turnServer?.url
        ? [{ urls: "stun:stun.l.google.com:19302" }, { urls: turnServer.url, username: turnServer.username, credential: turnServer.credential }]
        : undefined;
      client = new GlassClient({ link: link!, ...(iceServers ? { iceServers } : {}) });

      const video = localStream.getVideoTracks()[0];
      if (video) client.publish(video, { kind: "camera" });
      const audio = localStream.getAudioTracks()[0];
      if (audio) client.publish(audio, { kind: "microphone" });

      // The other person's camera and microphone are two sources, each with
      // its own stream: one stream of both plays them in one <video>.
      const remote = new MediaStream();
      client.on("track", (_source, stream) => {
        for (const t of stream.getTracks()) if (!remote.getTracks().includes(t)) remote.addTrack(t);
        onRemoteStream(remote);
      });
      client.on("connected", () => onStateChange("in-call"));
      client.on("reconnecting", (attempt, max) => onStateChange("connecting", `reconnecting ${attempt}/${max}`));
      client.on("error", (message, code) => {
        if (code === "not_connected") onStateChange("connecting", message);
      });
      client.on("closed", (reason, code) => {
        if (stopped) return;
        onStateChange("error", code === "session_not_found" ? "the call has ended" : reason);
      });
      await client.connect();
      if (stopped) cleanup();
    } catch (err) {
      if (!stopped) onStateChange("error", err instanceof Error ? err.message : String(err));
      cleanup();
    }
  })();

  return handle;
}
