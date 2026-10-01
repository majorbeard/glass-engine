// The phone-camera producer: opens the camera and hands it to @glass/client's
// GlassProducer, which implements the producer contract and resumes across
// network changes. This file only owns
// what is specific to the app: getting the camera, and releasing it on stop.

import { GlassProducer, type ProducerState as SdkState, type ProducerStats } from "@glass/client";

export type { ProducerStats };

/** GlassProducer's states, plus the camera prompt before it starts. */
export type ProducerState = SdkState | "requesting-media";

export interface ProducerHandle {
  stop(): void;
}

export interface StartProducerOptions {
  /** Base HTTP(S) URL of the Glass server, e.g. "http://192.168.1.20:8080". */
  serverUrl: string;
  /** GLASS_API_TOKEN, if the server requires one. */
  apiToken?: string;
  /** TURN server for this phone's own peer connection. Entered at runtime: it's credential material. */
  turnServer?: { url: string; username: string; credential: string };
  /** Passed through to GlassProducer; see GlassProducerOptions. */
  maxBitrateKbps?: number;
  startBitrateKbps?: number;
  reconnect?: boolean;
  resumeWindowMs?: number;
  onStateChange: (state: ProducerState, detail?: string) => void;
  /** Called once the camera is open, for the preview. */
  onLocalStream: (stream: MediaStream) => void;
  /** Called with the session to share with viewers; again if a drop led to a new session. */
  onSessionCreated?: (session: { id: string; signalingUrl: string }) => void;
  onStats?: (stats: ProducerStats) => void;
}

// Synchronous on purpose: the caller gets a working stop() before the camera prompt or any network
// work starts, so Stop pressed during setup aborts it.
export function startProducer(options: StartProducerOptions): ProducerHandle {
  let stopped = false;
  let camera: MediaStream | undefined;
  let producer: GlassProducer | undefined;

  const releaseCamera = () => camera?.getTracks().forEach((t) => t.stop());

  void (async () => {
    try {
      options.onStateChange("requesting-media");
      // getUserMedia rejects the whole call if any requested kind fails, so a missing or denied mic
      // falls back to video only instead of refusing to stream.
      try {
        camera = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      } catch {
        camera = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }
      if (stopped) return releaseCamera();
      options.onLocalStream(camera);

      const iceServers: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
      const turn = options.turnServer;
      if (turn?.url) iceServers.push({ urls: turn.url, username: turn.username, credential: turn.credential });

      producer = new GlassProducer({
        stream: camera,
        serverUrl: options.serverUrl,
        apiToken: options.apiToken,
        iceServers,
        maxBitrateKbps: options.maxBitrateKbps,
        startBitrateKbps: options.startBitrateKbps,
        reconnect: options.reconnect,
        resumeWindowMs: options.resumeWindowMs,
      });
      producer.on("state", (state, detail) => {
        options.onStateChange(state, detail);
        if (state === "error") releaseCamera();
      });
      producer.on("session", (s) => options.onSessionCreated?.({ id: s.id, signalingUrl: s.signalingUrl }));
      if (options.onStats) producer.on("stats", options.onStats);
      await producer.start();
      if (stopped) producer.stop();
    } catch (err) {
      if (stopped) return;
      releaseCamera();
      // producer.start() has already reported "error"; a camera failure hasn't.
      if (!producer) options.onStateChange("error", err instanceof Error ? err.message : String(err));
    }
  })();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      producer?.stop();
      releaseCamera();
      if (!producer) options.onStateChange("stopped");
    },
  };
}
