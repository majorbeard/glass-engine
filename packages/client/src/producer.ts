// GlassProducer: send a MediaStream into a Glass relay session, following
// the producer contract (docs/sources/producers.md in glass-engine), and
// keep sending across network changes.

import { Emitter } from "./emitter";
import { withStartBitrate } from "./sdp";

export type ProducerState =
  | "idle"
  | "creating-session"
  | "connecting"
  | "streaming"
  /** The connection dropped after streaming started; resuming, or making a new session. */
  | "reconnecting"
  | "error"
  | "stopped";

/** The relay session a producer is sending into. */
export interface ProducerSession {
  id: string;
  /** Consumer signaling URL: what a viewer needs to watch this session. Empty when joining an existing session via produceUrl. */
  signalingUrl: string;
  /** The produce URL this producer uses for its slot. */
  produceUrl: string;
  /** The named stream slot this producer fills. */
  slot: string;
  /**
   * Every slot's produce URL, when this producer created the session: hand the others to other
   * producers (each joins with `produceUrl`). Absent when joining an existing session.
   */
  produceUrls?: Record<string, string>;
}

/** Send-side telemetry, polled every 2 s while connected. */
export interface ProducerStats {
  capturedAt: number;
  /** Frames per second the source track delivers, before encoding. */
  sourceFps: number | null;
  uploadBitrateKbps: number;
  framesSent: number;
  frameWidth: number | null;
  frameHeight: number | null;
  rttMs: number | null;
  /** From remote-inbound-rtp; null when the browser doesn't report it (0 is a real value). */
  packetsLost: number | null;
  /** Battery Status API, where the browser has it. */
  battery: { level: number; charging: boolean } | null;
  /** Network Information API, where the browser has it. */
  network: { type: string | null; effectiveType: string | null; downlinkMbps: number | null } | null;
}

export interface GlassProducerOptions {
  /** What to send: its first video track, and its first audio track if it has one. The caller owns it. */
  stream: MediaStream;
  /** Base HTTP(S) URL of the Glass server. Required unless produceUrl is given. */
  serverUrl?: string;
  /** GLASS_API_TOKEN, if the server requires one. */
  apiToken?: string;
  /** Slots to declare when creating the session (must include "main"). Default: one slot, "main". */
  slots?: string[];
  /** Which slot this producer fills. Default "main". */
  slot?: string;
  /**
   * Produce into an existing session instead of creating one: the slot's produce URL from
   * POST /v1/relay-sessions. The producer then only ever resumes that session; if the resume window
   * passes it ends in "error", because it can't replace a session it doesn't own.
   */
  produceUrl?: string;
  /** ICE servers for this producer's own peer connection. Default: a public STUN server. */
  iceServers?: RTCIceServer[];
  /** Cap on the video sender's bitrate in kbps (default 1000; 0 = uncapped). Keep it below the uplink's capacity. */
  maxBitrateKbps?: number;
  /** Chromium's starting-bitrate hint in kbps (default min(500, cap)). Other browsers ignore it. */
  startBitrateKbps?: number;
  /** Re-establish the connection after a drop (default true). */
  reconnect?: boolean;
  /** How long to keep resuming the same session before giving up on it (default 45000 ms). */
  resumeWindowMs?: number;
}

export type GlassProducerEvents = {
  state: [state: ProducerState, detail?: string];
  /** The session this producer sends into. Fires again if a drop led to a new session. */
  session: [session: ProducerSession];
  stats: [stats: ProducerStats];
};

/** Deadline for POST /v1/relay-sessions: a request made during an outage must not stall the retry loop. */
const CREATE_SESSION_TIMEOUT_MS = 10000;
/** How long a peer connection may stay "disconnected" before it counts as dropped. */
const DISCONNECT_GRACE_MS = 6000;
/** How long one attempt, WebSocket handshake included, may take to reach "connected". */
const CONNECT_TIMEOUT_MS = 20000;
const DEFAULT_RESUME_WINDOW_MS = 45000;
const DEFAULT_MAX_BITRATE_KBPS = 1000;
const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
const STATS_INTERVAL_MS = 2000;

/** WebSocket close code for a drop: anything but 1000 makes Glass hold the producer's slot for a resume. */
const CLOSE_RESUMABLE = 4000;
/** WebSocket close code for stop(): Glass closes the session. */
const CLOSE_STOPPED = 1000;

interface CreatedSession {
  id: string;
  signalingUrl: string;
  produceUrl: string;
  produceUrls?: Record<string, string>;
  videoCodec: "h264" | "vp8";
}

/** A failure retrying can't fix. */
class FatalError extends Error {}

/** Glass says the session is gone (close code 4404): resuming it can't work. */
class SessionGoneError extends Error {}

/** WebSocket close code Glass sends for a session that doesn't exist (see CLOSE_SESSION_NOT_FOUND). */
const CLOSE_SESSION_GONE = 4404;

interface Drop {
  fatal: boolean;
  /** The session itself is gone, not just this connection. */
  gone?: boolean;
  detail: string;
}

interface Attempt {
  /** Resolves once, when this connection drops. Never rejects. */
  closed: Promise<Drop>;
  /** Close the connection: resumable (non-1000) or a deliberate stop (1000). */
  teardown(resumable: boolean): void;
}

/**
 * GlassProducer sends a MediaStream into one slot of a Glass relay session and keeps it there across
 * network changes: on a drop it resumes the same session within the reconnect grace, then (when it
 * created the session) falls back to a new one. See docs/sources/producers.md in glass-engine.
 */
export class GlassProducer extends Emitter<GlassProducerEvents> {
  private readonly opts: GlassProducerOptions;
  private readonly slot: string;
  private readonly maxBitrateKbps: number;
  private readonly startBitrateKbps: number;
  private stopped = false;
  private started = false;
  private current: Attempt | undefined;
  private wakeSleep: (() => void) | undefined;
  private readonly wake = () => this.wakeSleep?.();
  private readonly onVisible = () => {
    if (typeof document !== "undefined" && document.visibilityState === "visible") this.wake();
  };
  private _state: ProducerState = "idle";
  private _session: ProducerSession | undefined;

  constructor(options: GlassProducerOptions) {
    super();
    if (!options.produceUrl && !options.serverUrl) {
      throw new Error("GlassProducer needs serverUrl (to create a session) or produceUrl (to join one)");
    }
    if (!options.stream.getVideoTracks()[0]) {
      throw new Error("GlassProducer's stream has no video track");
    }
    this.opts = options;
    this.slot = options.slot ?? "main";
    this.maxBitrateKbps = options.maxBitrateKbps ?? DEFAULT_MAX_BITRATE_KBPS;
    this.startBitrateKbps =
      options.startBitrateKbps ?? Math.min(500, this.maxBitrateKbps > 0 ? this.maxBitrateKbps : 500);
  }

  get state(): ProducerState {
    return this._state;
  }

  /** The current session, once known. */
  get session(): ProducerSession | undefined {
    return this._session;
  }

  /**
   * Start producing. Resolves once the first connection is streaming; rejects if that first attempt
   * fails (a bad URL, token or network is the caller's to see). After that, drops are handled
   * internally and reported through "state".
   */
  start(): Promise<void> {
    if (this.started) return Promise.reject(new Error("GlassProducer already started"));
    this.started = true;
    if (typeof window !== "undefined") window.addEventListener("online", this.wake);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.onVisible);
    return new Promise<void>((resolve, reject) => {
      void this.run(resolve, reject);
    });
  }

  /** Stop producing and close the session's producer slot deliberately. Doesn't stop the stream's tracks. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.current?.teardown(false);
    this.current = undefined;
    this.detachWakeListeners();
    this.wake();
    this.setState("stopped");
  }

  private setState(state: ProducerState, detail?: string) {
    this._state = state;
    this.emit("state", state, detail);
  }

  private detachWakeListeners() {
    if (typeof window !== "undefined") window.removeEventListener("online", this.wake);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onVisible);
  }

  private fail(err: unknown) {
    if (this.stopped) return;
    this.stopped = true;
    this.current?.teardown(false);
    this.current = undefined;
    this.detachWakeListeners();
    this.setState("error", err instanceof Error ? err.message : String(err));
  }

  /** Sleeps for ms, or less if the page comes back online or into view. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        if (this.wakeSleep === done) this.wakeSleep = undefined;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wakeSleep = done;
    });
  }

  private publishSession(created: CreatedSession | undefined, produceUrl: string) {
    const id = created?.id ?? sessionIdFromProduceUrl(produceUrl) ?? "";
    this._session = { id, signalingUrl: created?.signalingUrl ?? "", produceUrl, slot: this.slot };
    if (created) this._session.produceUrls = created.produceUrls ?? { main: created.produceUrl };
    this.emit("session", this._session);
  }

  private async createSession(): Promise<{ created: CreatedSession; produceUrl: string }> {
    const created = await createRelaySession(this.opts.serverUrl!, this.opts.apiToken, this.opts.slots);
    const produceUrl = created.produceUrls?.[this.slot] ?? (this.slot === "main" ? created.produceUrl : undefined);
    if (!produceUrl) throw new FatalError(`the created session has no slot "${this.slot}"`);
    return { created, produceUrl };
  }

  private async run(resolve: () => void, reject: (err: unknown) => void) {
    let firstDone = false;
    try {
      let created: CreatedSession | undefined;
      let produceUrl: string;
      if (this.opts.produceUrl) {
        produceUrl = this.opts.produceUrl;
      } else {
        this.setState("creating-session");
        ({ created, produceUrl } = await this.createSession());
      }
      if (this.stopped) return resolve();
      this.publishSession(created, produceUrl);

      // Glass answers with the codec it registered; an attached producer can't ask, so it
      // offers H.264 (the default) unless the created session said otherwise.
      let codec = created?.videoCodec ?? "h264";
      const connect = () => this.establish(produceUrl, codec);

      this.setState("connecting", this._session?.id);
      let conn = await connect();
      this.current = conn;
      if (this.stopped) {
        conn.teardown(false);
        return resolve();
      }
      firstDone = true;
      this.setState("streaming");
      resolve();

      while (!this.stopped) {
        const drop = await conn.closed;
        conn.teardown(true);
        this.current = undefined;
        if (this.stopped) return;
        if (drop.fatal || this.opts.reconnect === false) return this.fail(new Error(drop.detail));

        const resumeWindowMs = this.opts.resumeWindowMs ?? DEFAULT_RESUME_WINDOW_MS;
        const droppedAt = Date.now();
        let attempt = 0;
        let madeNewSession = false;
        // Once Glass says the session is gone, stop resuming it.
        let sessionGone = drop.gone === true;
        while (!this.stopped) {
          attempt++;
          const resuming = !sessionGone && Date.now() - droppedAt < resumeWindowMs;
          if (!resuming && !madeNewSession && this.opts.produceUrl) {
            return this.fail(
              new Error(sessionGone ? drop.detail : `${drop.detail}; could not resume the session within ${resumeWindowMs / 1000}s`)
            );
          }
          this.setState("reconnecting", `${drop.detail}; ${resuming ? "resuming" : "new session"}, attempt ${attempt}`);
          try {
            if (!resuming && !madeNewSession) {
              ({ created, produceUrl } = await this.createSession());
              codec = created.videoCodec;
              madeNewSession = true;
              if (this.stopped) return;
              this.publishSession(created, produceUrl);
            }
            const next = await connect();
            if (this.stopped) {
              next.teardown(false);
              return;
            }
            conn = next;
            this.current = next;
            this.setState("streaming", madeNewSession ? `new session ${this._session?.id}` : "resumed");
            break;
          } catch (err) {
            if (err instanceof FatalError || isAuthRefusal(err)) return this.fail(err);
            if (err instanceof SessionGoneError) {
              if (this.opts.produceUrl) return this.fail(err);
              sessionGone = true;
              if (!madeNewSession) continue; // make the new session now, not after a backoff
            }
          }
          await this.sleep(backoffMs(attempt));
        }
      }
    } catch (err) {
      if (!firstDone) {
        this.fail(err);
        reject(err);
      } else {
        this.fail(err);
      }
    }
  }

  /** One connection attempt: resolves once connected, rejects if it can't get there. */
  private async establish(produceUrl: string, codec: "h264" | "vp8"): Promise<Attempt> {
    const stream = this.opts.stream;
    const pc = new RTCPeerConnection({ iceServers: this.opts.iceServers ?? DEFAULT_ICE_SERVERS });
    const stopStats = startStatsPolling(pc, (s) => this.emit("stats", s));
    let ws: WebSocket | undefined;
    let disconnectTimer: ReturnType<typeof setTimeout> | undefined;

    let settled = false;
    let resolveClosed!: (d: Drop) => void;
    const closed = new Promise<Drop>((r) => (resolveClosed = r));
    const drop = (fatal: boolean, detail: string, gone = false) => {
      if (settled) return;
      settled = true;
      resolveClosed({ fatal, detail, gone });
    };

    const teardown = (resumable: boolean) => {
      if (disconnectTimer) clearTimeout(disconnectTimer);
      stopStats();
      try {
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
          ws.close(resumable ? CLOSE_RESUMABLE : CLOSE_STOPPED, resumable ? "producer reconnecting" : "producer stopped");
        }
      } catch {
        // already closing
      }
      try {
        pc.close();
      } catch {
        // already closed
      }
    };

    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutTimer = setTimeout(
        () => reject(new Error(`no connection within ${CONNECT_TIMEOUT_MS / 1000}s`)),
        CONNECT_TIMEOUT_MS
      );
    });
    timeout.catch(() => undefined);

    try {
      const videoTrack = stream.getVideoTracks()[0];
      if (!videoTrack) throw new FatalError("the stream has no video track");
      const encoding: RTCRtpEncodingParameters = { maxFramerate: 30 };
      if (this.maxBitrateKbps > 0) encoding.maxBitrate = Math.round(this.maxBitrateKbps * 1000);
      const encodings = [encoding];
      let transceiver: RTCRtpTransceiver;
      try {
        transceiver = pc.addTransceiver(videoTrack, { direction: "sendonly", streams: [stream], sendEncodings: encodings });
      } catch {
        // No sendEncodings support: rely on applyBitrateCap once connected.
        transceiver = pc.addTransceiver(videoTrack, { direction: "sendonly", streams: [stream] });
      }
      lockCodec(transceiver, codec);

      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack) pc.addTransceiver(audioTrack, { direction: "sendonly", streams: [stream] });

      let url = produceUrl;
      if (this.opts.apiToken && !url.includes("token=")) {
        url += (url.includes("?") ? "&" : "?") + `token=${encodeURIComponent(this.opts.apiToken)}`;
      }
      const socket = new WebSocket(url);
      ws = socket;

      const wsOpen = new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", () => reject(new Error("could not open the produce WebSocket")), { once: true });
      });
      let onConnected!: () => void;
      const connected = new Promise<void>((r) => (onConnected = r));

      pc.addEventListener("icecandidate", (e) => {
        if (e.candidate && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "ice-candidate", candidate: e.candidate.toJSON() }));
        }
      });
      pc.addEventListener("connectionstatechange", () => {
        const s = pc.connectionState;
        if (s === "connected") {
          if (disconnectTimer) clearTimeout(disconnectTimer);
          disconnectTimer = undefined;
          void applyBitrateCap(transceiver.sender, this.maxBitrateKbps);
          onConnected();
        } else if (s === "failed" || s === "closed") {
          drop(false, `peer connection ${s}`);
        } else if (s === "disconnected" && !disconnectTimer) {
          disconnectTimer = setTimeout(() => drop(false, "peer connection disconnected"), DISCONNECT_GRACE_MS);
        }
      });

      socket.addEventListener("message", (event) => {
        let msg: { type: string; sdp?: string; candidate?: RTCIceCandidateInit; code?: string; message?: string };
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        if (msg.type === "answer" && msg.sdp) {
          void pc.setRemoteDescription({ type: "answer", sdp: withStartBitrate(msg.sdp, this.startBitrateKbps) });
        } else if (msg.type === "ice-candidate" && msg.candidate) {
          void pc.addIceCandidate(msg.candidate);
        } else if (msg.type === "error") {
          // Retrying can't fix codec_mismatch; it can fix producer_not_connected and the rest.
          const detail = `${msg.code ?? "error"}${msg.message ? `: ${msg.message}` : ""}`;
          drop(msg.code === "codec_mismatch", detail);
        }
      });
      socket.addEventListener("close", (e) => {
        if (e.code === CLOSE_SESSION_GONE) drop(false, "session not found or expired", true);
        else drop(false, `signaling connection closed (code ${e.code})`);
      });

      // Also end the attempt as soon as it drops: a socket can close before it ever opens.
      const dropped = closed.then((d) => {
        throw d.fatal ? new FatalError(d.detail) : d.gone ? new SessionGoneError(d.detail) : new Error(d.detail);
      });
      dropped.catch(() => undefined);

      await Promise.race([wsOpen, timeout, dropped]);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.send(JSON.stringify({ type: "offer", sdp: offer.sdp }));

      try {
        await Promise.race([connected, dropped, timeout]);
      } finally {
        if (timeoutTimer) clearTimeout(timeoutTimer);
      }
      return { closed, teardown };
    } catch (err) {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      teardown(true);
      throw err;
    }
  }
}

function backoffMs(attempt: number): number {
  return [1000, 2000, 3000, 5000][Math.min(attempt, 4) - 1] ?? 5000;
}

/** A 401 or 403 from session creation: a bad or forbidden token, which retrying won't fix. */
function isAuthRefusal(err: unknown): boolean {
  return err instanceof Error && / 40[13] /.test(err.message);
}

function sessionIdFromProduceUrl(produceUrl: string): string | null {
  const m = /\/v1\/relay-sessions\/([^/]+)\/produce/.exec(produceUrl);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

async function createRelaySession(serverUrl: string, apiToken?: string, slots?: string[]): Promise<CreatedSession> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), CREATE_SESSION_TIMEOUT_MS);
  const headers: Record<string, string> = {};
  if (apiToken) headers["Authorization"] = `Bearer ${apiToken}`;
  let body: string | undefined;
  if (slots && slots.length > 0) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify({ slots });
  }
  let res: Response;
  try {
    res = await fetch(`${serverUrl.replace(/\/$/, "")}/v1/relay-sessions`, {
      method: "POST",
      headers,
      body,
      signal: ctl.signal,
    });
  } catch (err) {
    throw new Error(
      `create relay session failed: ${ctl.signal.aborted ? `no response within ${CREATE_SESSION_TIMEOUT_MS / 1000}s` : String(err)}`
    );
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 400) throw new FatalError(`create relay session failed: ${res.status} ${text}`);
    throw new Error(`create relay session failed: ${res.status} ${text}`);
  }
  return res.json();
}

/** Restrict the offer to the one codec Glass registered (the session's videoCodec). */
function lockCodec(transceiver: RTCRtpTransceiver, codec: "h264" | "vp8") {
  if (typeof transceiver.setCodecPreferences !== "function") return;
  const capabilities = RTCRtpSender.getCapabilities?.("video");
  if (!capabilities) return;
  const mimeType = codec === "vp8" ? "video/vp8" : "video/h264";
  const matching = capabilities.codecs.filter((c) => c.mimeType.toLowerCase() === mimeType);
  if (matching.length === 0) {
    throw new FatalError(`this browser's WebRTC stack has no ${mimeType} encoder`);
  }
  transceiver.setCodecPreferences(matching);
}

/** Cap the video sender's bitrate; see GlassProducerOptions.maxBitrateKbps. */
async function applyBitrateCap(sender: RTCRtpSender, maxKbps: number): Promise<void> {
  if (!(maxKbps > 0)) return;
  try {
    const params = sender.getParameters();
    const first = params.encodings?.[0] ?? {};
    first.maxBitrate = Math.round(maxKbps * 1000);
    params.encodings = [first, ...(params.encodings?.slice(1) ?? [])];
    await sender.setParameters(params);
  } catch {
    // Best effort: sendEncodings already carried the cap where supported.
  }
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

/** Polls pc.getStats() until the returned function is called. Bitrate comes from bytesSent deltas. */
function startStatsPolling(pc: RTCPeerConnection, onStats: (stats: ProducerStats) => void): () => void {
  let prevBytesSent: number | null = null;
  let prevTimestamp: number | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const poll = async () => {
    if (stopped) return;
    try {
      const report = await pc.getStats();
      let framesSent = 0;
      let frameWidth: number | null = null;
      let frameHeight: number | null = null;
      let bytesSent = 0;
      let timestamp = 0;
      let rttMs: number | null = null;
      let packetsLost: number | null = null;
      let sourceFps: number | null = null;
      report.forEach((stat: any) => {
        if (stat.type === "outbound-rtp" && stat.kind === "video") {
          framesSent = stat.framesSent ?? framesSent;
          frameWidth = stat.frameWidth ?? frameWidth;
          frameHeight = stat.frameHeight ?? frameHeight;
          bytesSent = stat.bytesSent ?? bytesSent;
          timestamp = stat.timestamp ?? timestamp;
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
          battery: await getBatteryInfo(),
          network: getNetworkInfo(),
        });
      }
    } catch {
      // getStats on a closing connection: skip this tick.
    }
    if (!stopped) timer = setTimeout(poll, STATS_INTERVAL_MS);
  };
  timer = setTimeout(poll, STATS_INTERVAL_MS);

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
