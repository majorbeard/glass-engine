// The phone-camera publisher: opens the camera and publishes it, with the
// microphone, into a Glass session on @glass/client's one connection. The
// client resumes across network changes. This file owns what is specific to
// the app: getting the camera, making a session when it has the API token,
// the stats it shows, and releasing the camera on stop.

import { createGlassSession, GlassClient, mintGlassLink, type GlassPublication } from "@glass/client";

/** The app's states: the camera prompt, then the connection's. */
export type ProducerState = "idle" | "requesting-media" | "creating-session" | "connecting" | "streaming" | "reconnecting" | "stopped" | "error";

export interface ProducerHandle {
  stop(): void;
}

export interface StartProducerOptions {
  /** Base HTTP(S) URL of the Glass server, e.g. "http://192.168.1.20:8080". Not needed with publishLink. */
  serverUrl?: string;
  /**
   * A link to a session your backend made, with the right to publish a camera and a microphone: the
   * phone then needs no API token, only this one link.
   */
  publishLink?: string;
  /** Send the camera as simulcast layers (the session must be a simulcast one). */
  simulcast?: boolean;
  /** GLASS_API_TOKEN, to make a session here (development). */
  apiToken?: string;
  /** TURN server for this phone's own peer connection. Entered at runtime: it's credential material. */
  turnServer?: { url: string; username: string; credential: string };
  /** The camera's bitrate cap and starting rate, kbit/s. */
  maxBitrateKbps?: number;
  startBitrateKbps?: number;
  reconnect?: boolean;
  onStateChange: (state: ProducerState, detail?: string) => void;
  /** Called once the camera is open, for the preview. */
  onLocalStream: (stream: MediaStream) => void;
  /** Called with the session and a watch link to share with viewers, when this app made the session. */
  onSessionCreated?: (session: { id: string; watchLink: string }) => void;
  onStats?: (stats: ProducerStats) => void;
}

export interface ProducerLayerStats {
  rid: string;
  width: number | null;
  height: number | null;
  framesPerSecond: number | null;
  bitrateKbps: number;
}

export interface ProducerStats {
  capturedAt: number;
  /** Frames per second the camera delivers, before encoding. */
  sourceFps: number | null;
  uploadBitrateKbps: number;
  framesSent: number;
  frameWidth: number | null;
  frameHeight: number | null;
  rttMs: number | null;
  /** From remote-inbound-rtp; null when the browser doesn't report it (0 is a real value). */
  packetsLost: number | null;
  /** With simulcast, each layer the browser sends, smallest first; null with one encoding. */
  layers: ProducerLayerStats[] | null;
  /** The video encoder the browser reports, and whether it is a hardware one; null when it doesn't say. */
  encoder: string | null;
  hardwareEncoder: boolean | null;
  /** Battery Status API, where the browser has it. */
  battery: { level: number; charging: boolean } | null;
  /** Network Information API, where the browser has it. */
  network: { type: string | null; effectiveType: string | null; downlinkMbps: number | null } | null;
}

// 720p where the camera has it: a phone's default for `video: true` is often 640x480, which gives simulcast
// two layers instead of three.
const VIDEO: MediaTrackConstraints = { width: { ideal: 1280 }, height: { ideal: 720 } };
const STATS_INTERVAL_MS = 1000;

// Synchronous on purpose: the caller gets a working stop() before the camera prompt or any network
// work starts, so Stop pressed during setup aborts it.
export function startProducer(options: StartProducerOptions): ProducerHandle {
  let stopped = false;
  let camera: MediaStream | undefined;
  let client: GlassClient | undefined;
  let stopStats: (() => void) | undefined;

  const releaseCamera = () => camera?.getTracks().forEach((t) => t.stop());
  const end = (state: ProducerState, detail?: string) => {
    stopStats?.();
    releaseCamera();
    options.onStateChange(state, detail);
  };

  void (async () => {
    try {
      options.onStateChange("requesting-media");
      // getUserMedia rejects the whole call if any requested kind fails, so a missing or denied mic
      // falls back to video only instead of refusing to stream.
      try {
        camera = await navigator.mediaDevices.getUserMedia({ video: VIDEO, audio: true });
      } catch {
        camera = await navigator.mediaDevices.getUserMedia({ video: VIDEO, audio: false });
      }
      if (stopped) return releaseCamera();
      options.onLocalStream(camera);

      // A publish link joins that session. With the API token, this app makes one: a session whose
      // members publish, and a link that publishes for itself and one that watches for others.
      let link = options.publishLink;
      if (!link) {
        options.onStateChange("creating-session");
        const base = { baseUrl: options.serverUrl, apiToken: options.apiToken };
        const session = await createGlassSession({ ...base, ...(options.simulcast ? { simulcast: true } : {}) });
        link = (await mintGlassLink({ ...base, sessionId: session.id, rights: { publish: ["camera", "microphone"] } })).url;
        const watch = await mintGlassLink({ ...base, sessionId: session.id, rights: { watch: "all" } });
        options.onSessionCreated?.({ id: session.id, watchLink: watch.url });
      }
      if (stopped) return releaseCamera();

      // A TURN server of the user's own, if they entered one; otherwise the engine's (sent in hello,
      // with a short-lived TURN credential of its own).
      const turn = options.turnServer;
      const iceServers: RTCIceServer[] | undefined = turn?.url
        ? [{ urls: "stun:stun.l.google.com:19302" }, { urls: turn.url, username: turn.username, credential: turn.credential }]
        : undefined;

      options.onStateChange("connecting");
      client = new GlassClient({ link, ...(iceServers ? { iceServers } : {}), reconnect: options.reconnect ?? true });
      const video = camera.getVideoTracks()[0]!;
      const cam = client.publish(video, {
        kind: "camera",
        simulcast: options.simulcast,
        maxBitrateKbps: options.maxBitrateKbps,
        startBitrateKbps: options.startBitrateKbps,
      });
      const audio = camera.getAudioTracks()[0];
      if (audio) {
        const mic = client.publish(audio, { kind: "microphone" });
        mic.on("silent", () => options.onStateChange("streaming", "the microphone is sending silence"));
      }
      cam.on("refused", (reason) => end("error", `the camera was refused: ${reason}`));
      // A resume keeps the member's connection id; a new id is a fresh join.
      let joinedAs: string | null = null;
      client.on("connected", () => {
        const id = client!.connectionId();
        options.onStateChange("streaming", joinedAs !== null && id === joinedAs ? "resumed" : undefined);
        joinedAs = id;
        stopStats?.();
        if (options.onStats) stopStats = startStatsPolling(cam, options.onStats);
      });
      client.on("reconnecting", (attempt, max) => options.onStateChange("reconnecting", `attempt ${attempt}/${max}`));
      client.on("closed", (reason, code) => {
        if (stopped) return;
        end(code === "client_disconnected" ? "stopped" : "error", reason);
      });
      await client.connect();
      if (stopped) client.disconnect();
    } catch (err) {
      if (stopped) return;
      // A failed connect has already reported "closed"; a camera or session failure hasn't.
      if (!client) end("error", err instanceof Error ? err.message : String(err));
    }
  })();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      client?.disconnect();
      end("stopped");
    },
  };
}

async function getBatteryInfo(): Promise<ProducerStats["battery"]> {
  const nav = typeof navigator !== "undefined" ? (navigator as any) : undefined;
  if (typeof nav?.getBattery !== "function") return null;
  try {
    const battery = await nav.getBattery();
    return { level: battery.level, charging: battery.charging };
  } catch {
    return null;
  }
}

function getNetworkInfo(): ProducerStats["network"] {
  const nav = typeof navigator !== "undefined" ? (navigator as any) : undefined;
  const conn = nav?.connection || nav?.mozConnection || nav?.webkitConnection;
  if (!conn) return null;
  return {
    type: conn.type ?? null,
    effectiveType: conn.effectiveType ?? null,
    downlinkMbps: typeof conn.downlink === "number" ? conn.downlink : null,
  };
}

/** Polls the camera's sender statistics until the returned function is called. Bitrate comes from bytesSent deltas. */
function startStatsPolling(cam: GlassPublication, onStats: (stats: ProducerStats) => void): () => void {
  let prevBytesSent: number | null = null;
  let prevTimestamp: number | null = null;
  const prevByRid = new Map<string, { bytes: number; at: number }>();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const poll = async () => {
    if (stopped) return;
    const report = await cam.getStatsReport();
    if (report) {
      let framesSent = 0;
      let frameWidth: number | null = null;
      let frameHeight: number | null = null;
      let bytesSent = 0;
      let timestamp = 0;
      let rttMs: number | null = null;
      let packetsLost: number | null = null;
      let sourceFps: number | null = null;
      const layers: ProducerLayerStats[] = [];
      let largest = -1;
      let encoder: string | null = null;
      let hardwareEncoder: boolean | null = null;
      report.forEach((stat: any) => {
        if (stat.type === "outbound-rtp" && stat.kind === "video") {
          // One row per layer with simulcast: the upload is all of them, the rest the largest one's.
          bytesSent += stat.bytesSent ?? 0;
          timestamp = stat.timestamp ?? timestamp;
          if ((stat.frameHeight ?? 0) >= largest) {
            largest = stat.frameHeight ?? 0;
            encoder = stat.encoderImplementation ?? encoder;
            if (typeof stat.powerEfficientEncoder === "boolean") hardwareEncoder = stat.powerEfficientEncoder;
            framesSent = stat.framesSent ?? framesSent;
            frameWidth = stat.frameWidth ?? frameWidth;
            frameHeight = stat.frameHeight ?? frameHeight;
          }
          if (stat.rid) {
            const prev = prevByRid.get(stat.rid);
            const at = stat.timestamp ?? 0;
            const bytes = stat.bytesSent ?? 0;
            layers.push({
              rid: stat.rid,
              width: stat.frameWidth ?? null,
              height: stat.frameHeight ?? null,
              framesPerSecond: stat.framesPerSecond ?? null,
              bitrateKbps: prev && at > prev.at ? Math.max(0, ((bytes - prev.bytes) * 8) / (at - prev.at)) : 0,
            });
            prevByRid.set(stat.rid, { bytes, at });
          }
        } else if (stat.type === "remote-inbound-rtp" && stat.kind === "video") {
          packetsLost = stat.packetsLost ?? packetsLost;
          if (typeof stat.roundTripTime === "number") rttMs = stat.roundTripTime * 1000;
        } else if (stat.type === "candidate-pair" && stat.state === "succeeded" && rttMs === null) {
          if (typeof stat.currentRoundTripTime === "number") rttMs = stat.currentRoundTripTime * 1000;
        } else if (stat.type === "media-source" && stat.kind === "video") {
          sourceFps = stat.framesPerSecond ?? sourceFps;
        }
      });
      let uploadBitrateKbps = 0;
      if (prevBytesSent !== null && prevTimestamp !== null && timestamp > prevTimestamp) {
        uploadBitrateKbps = Math.max(0, ((bytesSent - prevBytesSent) * 8) / (timestamp - prevTimestamp));
      }
      prevBytesSent = bytesSent;
      prevTimestamp = timestamp;
      if (!stopped) {
        onStats({
          capturedAt: Date.now(),
          sourceFps,
          uploadBitrateKbps,
          framesSent,
          frameWidth,
          frameHeight,
          rttMs,
          packetsLost,
          layers: layers.length > 0 ? layers.sort((a, b) => (a.height ?? 0) - (b.height ?? 0)) : null,
          encoder,
          hardwareEncoder,
          battery: await getBatteryInfo(),
          network: getNetworkInfo(),
        });
      }
    }
    if (!stopped) timer = setTimeout(poll, STATS_INTERVAL_MS);
  };
  timer = setTimeout(poll, STATS_INTERVAL_MS);

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
