// @glass/client - DOM-free transport core.
//
// createGlassClient() owns the entire client-side transport loop against a
// Glass session: the signaling WebSocket handshake, the RTCPeerConnection and
// input DataChannel, low-latency receiver tuning, ICE restart, and - unlike the
// old example, where this lived in app.tsx - built-in reconnection with backoff
// to the SAME session. Subscribe with client.on(event, cb); send input with the
// typed methods. This module never touches the DOM (no document); the optional
// "@glass/client/viewer" entry provides the rendering + input-capture layer.

import { Emitter } from "./emitter.js";
import type {
  ElementState,
  GlassSession,
  GlassStats,
  KeyEvent,
  NavigationState,
  TouchDispatchType,
  TouchPoint,
} from "./types.js";

export type {
  ElementState,
  GlassSession,
  GlassStats,
  KeyEvent,
  NavigationState,
  TouchDispatchType,
  TouchPoint,
};

// Binary DataChannel message types pushed from the backend. Must match
// backend/internal/protocol/protocol.go. See docs/protocol.md.
const enum MessageType {
  ElementStateUpdate = 0x05,
  NavigationState = 0x06,
  ViewportSize = 0x07,
  Error = 0xff,
}

export interface GlassReconnectOptions {
  // Max full-reconnect attempts before giving up (emitting "closed").
  maxAttempts?: number;
  // Backoff schedule; the last value repeats for attempts beyond its length.
  delaysMs?: number[];
}

export interface GlassClientOptions {
  // The session's signaling WebSocket URL - typically obtained from your own
  // backend (which called POST /v1/sessions), or from createGlassSession().
  signalingUrl: string;
  // Optional session id, used only to DELETE the session on final close.
  sessionId?: string;
  // ICE servers for the RTCPeerConnection. Defaults to a public STUN server.
  iceServers?: RTCIceServer[];
  // Forces ICE candidate gathering/use to "relay" only (TURN) instead of the
  // browser default "all". Not needed for normal operation - exists so a
  // TURN deployment can be verified end-to-end: with "relay", this peer can
  // only ever connect via a TURN relay candidate, so a successful connection
  // actually proves the TURN server works rather than just being configured
  // and silently unused because a direct/STUN path happened to succeed
  // first (the common case on a LAN or same-machine test).
  iceTransportPolicy?: RTCIceTransportPolicy;
  // Reconnection behavior. true (default) uses defaults; false disables it;
  // an object customizes attempts/backoff.
  reconnect?: boolean | GlassReconnectOptions;
  // If > 0, emit a "stats" event this often (ms). Off by default; getStats()
  // is always available for one-shot snapshots regardless.
  statsIntervalMs?: number;
  // DELETE the session (best-effort) when the client is closed for good.
  // Defaults to true when sessionId is provided.
  deleteSessionOnClose?: boolean;
  // Base URL (origin) for the session DELETE call. Defaults to the origin
  // derived from signalingUrl.
  sessionBaseUrl?: string;
  // GLASS_API_TOKEN, only needed if this session was created against a
  // runtime that has it set - used solely for this client's own DELETE
  // calls (sendDeleteBeacon, the final close in disconnect()); the
  // signaling WebSocket needs no separate handling since the runtime
  // already embeds the token in signalingUrl when it hands that back from
  // POST /v1/sessions. See createGlassSession's doc comment for the trust
  // model this assumes (a real deployment's token lives in your own
  // backend, not a browser bundle).
  apiToken?: string;
}

// A `type` (not `interface`) so it satisfies the Emitter's
// Record<string, unknown[]> constraint - interfaces don't get an implicit
// index signature.
export type GlassClientEventMap = {
  // A remote video track arrived - bind it to a <video> element's srcObject.
  videoTrack: [stream: MediaStream];
  // Cursor / editable-focus state from the remote page.
  state: [state: ElementState];
  // URL-bar / navigation state from the remote page.
  navigation: [nav: NavigationState];
  // A fatal, session-level backend error (e.g. the encoder died). Distinct
  // from a transport drop - there is no recovery, video is gone.
  error: [message: string];
  // The peer connection reached "connected" (initial connect or a reconnect).
  connected: [];
  // A transport drop occurred. May be followed by "reconnecting" then
  // "connected", or by "closed" if recovery is disabled/exhausted.
  disconnected: [];
  // A full reconnect attempt is about to run.
  reconnecting: [attempt: number, maxAttempts: number];
  // Optional periodic transport/quality snapshot (see statsIntervalMs).
  stats: [stats: GlassStats];
  // Terminal: reconnection was exhausted/disabled, or disconnect() was called.
  // No further events will fire.
  closed: [reason: string];
};

const DEFAULT_RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 8;
const MOUSE_BATCH_INTERVAL_MS = 16; // ~60fps
const SIGNALING_TIMEOUT_MS = 10000;
const PEER_TIMEOUT_MS = 15000;

// authHeaders builds the Authorization header for a REST call, shared by
// every call site that needs one (createGlassSession, deleteGlassSession,
// GlassClient's page-unload beacon) - found by code review (reuse angle):
// the same `if (apiToken) headers["Authorization"] = \`Bearer ${apiToken}\`;`
// line was previously repeated verbatim at all three, which meant a future
// change to the auth scheme (a different header name, an extra required
// header) could easily be applied to two of the three and silently miss
// the third - most plausibly the page-unload beacon, the least likely path
// to be exercised during manual testing.
function authHeaders(apiToken?: string): HeadersInit {
  return apiToken ? { Authorization: `Bearer ${apiToken}` } : {};
}

// Creates a session via the runtime's REST API (POST {baseUrl}/v1/sessions)
// and returns its id + signaling URL. A dev-convenience helper - in a real
// app your own backend creates the session so auth/quota stay server-side, and
// hands the client only the signalingUrl. baseUrl defaults to same-origin.
//
// apiToken is only relevant if the runtime has GLASS_API_TOKEN set (see
// runtime.Config.APIToken) - passed here purely for local testing symmetry;
// a real deployment's actual token belongs in your own backend, never
// shipped to a browser bundle. When a session is created with a token, the
// returned signalingUrl already has it embedded as a query param (the
// runtime does this server-side), so GlassClient needs no separate token
// handling to open the signaling WebSocket - only this helper's own
// follow-up REST calls (deleteGlassSession) need it passed again.
export async function createGlassSession(
  baseUrl = "",
  apiToken?: string
): Promise<GlassSession> {
  const res = await fetch(`${baseUrl}/v1/sessions`, {
    method: "POST",
    headers: authHeaders(apiToken),
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.json()).error;
    } catch {
      // ignore parse failure, fall back to status text
    }
    throw new Error(
      `Failed to create session (${res.status}): ${detail || res.statusText}`
    );
  }
  return res.json();
}

// Best-effort session close via DELETE {baseUrl}/v1/sessions/{id}. The backend
// also closes a session when its signaling socket drops, so failures are
// non-fatal. See createGlassSession's doc comment for apiToken's caveats.
export function deleteGlassSession(
  id: string,
  baseUrl = "",
  apiToken?: string
): void {
  fetch(`${baseUrl}/v1/sessions/${id}`, {
    method: "DELETE",
    headers: authHeaders(apiToken),
  }).catch(() => {
    // best-effort
  });
}

export class GlassClient extends Emitter<GlassClientEventMap> {
  private pc: RTCPeerConnection | null = null;
  private ws: WebSocket | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private iceCandidateQueue: RTCIceCandidateInit[] = [];
  // The latest received video stream, retained so a viewer that subscribes
  // AFTER the track already arrived (very common: the app connects up front and
  // mounts the viewer only on first navigation, long after ontrack fired) can
  // still bind it via getVideoStream(). Without this, the "videoTrack" event is
  // fire-and-forget and a late subscriber renders black.
  private currentStream: MediaStream | null = null;
  private unloadHandler: ((event: PageTransitionEvent) => void) | null = null;

  private readonly signalingUrl: string;
  private readonly sessionId?: string;
  private readonly iceServers: RTCIceServer[];
  private readonly iceTransportPolicy?: RTCIceTransportPolicy;
  private readonly reconnectEnabled: boolean;
  private readonly maxAttempts: number;
  private readonly delaysMs: number[];
  private readonly statsIntervalMs: number;
  private readonly deleteOnClose: boolean;
  private readonly sessionBaseUrl: string;
  private readonly apiToken?: string;

  // Lifecycle state.
  private userClosed = false;
  private peerConnected = false;
  private signalingConnected = false;
  private reconnectAttempt = 0;
  private supervising = false; // a background reconnect loop is running

  // Per-attempt settle guard (so a late ws/pc event can't resolve/reject an
  // already-settled establish() attempt).
  private attemptSettled = true;

  // Timers we must clear on close (backoff waits, batch timer, stats timer).
  private pendingTimeouts = new Set<ReturnType<typeof setTimeout>>();
  private mouseBatchTimer: ReturnType<typeof setInterval> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;

  // Mouse-move batching.
  private mouseEventQueue: Array<{ x: number; y: number; dragging: boolean }> =
    [];
  private lastMouseSendTime = 0;

  // Stats sampling state.
  private lastStatsSample: { time: number; bytesReceived: number } | null =
    null;
  private lastJitterSample: { delaySec: number; emittedCount: number } | null =
    null;

  constructor(options: GlassClientOptions) {
    super();
    this.signalingUrl = options.signalingUrl;
    this.sessionId = options.sessionId;
    this.iceServers = options.iceServers ?? [
      { urls: "stun:stun.l.google.com:19302" },
    ];
    this.iceTransportPolicy = options.iceTransportPolicy;
    const rc = options.reconnect ?? true;
    this.reconnectEnabled = rc !== false;
    const rcOpts = typeof rc === "object" ? rc : {};
    this.maxAttempts = rcOpts.maxAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
    this.delaysMs = rcOpts.delaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
    this.statsIntervalMs = options.statsIntervalMs ?? 0;
    this.deleteOnClose = options.deleteSessionOnClose ?? !!options.sessionId;
    this.sessionBaseUrl = options.sessionBaseUrl ?? originOf(options.signalingUrl);
    this.apiToken = options.apiToken;
    this.installUnloadHandler();
  }

  // A deliberate page unload (reload, tab close, navigate away) closes the
  // signaling socket, which the backend can't tell apart from a network drop -
  // so it holds the session open for the whole reconnect grace before freeing
  // its pool slot. That's correct for a real drop, but wasteful for a reload:
  // the slot is blocked (and at small pool sizes, new sessions get 503) for up
  // to a minute. So on a real page discard we proactively DELETE the session.
  //
  // Guarded so it never fires on a backgrounding that the reconnect machinery
  // SHOULD handle: `event.persisted` means the page is going into the bfcache
  // (e.g. a mobile app-switch / screen lock - exactly the reconnect case), so
  // we skip the delete there and let the grace period do its job.
  private installUnloadHandler(): void {
    if (typeof window === "undefined") return;
    if (!this.sessionId || !this.deleteOnClose) return;
    this.unloadHandler = (event: PageTransitionEvent) => {
      if (event.persisted) return;
      this.sendDeleteBeacon();
    };
    window.addEventListener("pagehide", this.unloadHandler);
  }

  private sendDeleteBeacon(): void {
    if (!this.sessionId) return;
    try {
      // keepalive lets this request outlive the unloading page. DELETE (rather
      // than navigator.sendBeacon, which is POST-only) matches the runtime's
      // session API.
      void fetch(`${this.sessionBaseUrl}/v1/sessions/${this.sessionId}`, {
        method: "DELETE",
        keepalive: true,
        headers: authHeaders(this.apiToken),
      });
    } catch {
      // best-effort; the reconnect grace is the fallback
    }
  }

  // Connect to the session. Resolves once the peer connection is established
  // (after transparent retries if the first attempts fail and reconnection is
  // enabled); rejects only if it can't connect and retries are exhausted or
  // disabled. Subsequent mid-session drops are recovered in the background.
  async connect(): Promise<void> {
    this.userClosed = false;
    this.reconnectAttempt = 0;
    for (;;) {
      try {
        await this.establish();
        return;
      } catch (err) {
        if (
          this.userClosed ||
          !this.reconnectEnabled ||
          this.reconnectAttempt >= this.maxAttempts
        ) {
          if (!this.userClosed) this.emit("closed", `failed to connect: ${err}`);
          throw err;
        }
        this.reconnectAttempt++;
        this.emit("reconnecting", this.reconnectAttempt, this.maxAttempts);
        await this.wait(this.nextDelayMs());
        if (this.userClosed) throw new Error("connect aborted");
      }
    }
  }

  private nextDelayMs(): number {
    const i = Math.min(this.reconnectAttempt, this.delaysMs.length - 1);
    return this.delaysMs[i] ?? DEFAULT_RECONNECT_DELAYS_MS[0]!;
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.pendingTimeouts.delete(t);
        resolve();
      }, ms);
      this.pendingTimeouts.add(t);
    });
  }

  // One full connection attempt: signaling WS -> offer/answer -> PC/DC. Resolves
  // when the PC reaches "connected"; rejects on any failure/timeout during the
  // handshake. Once resolved, a later drop is handled by the state-change
  // handlers (ICE restart for a transient PC drop, background full reconnect
  // for a lost signaling socket), NOT by rejecting this settled promise.
  private establish(): Promise<void> {
    this.teardownInternals();
    this.signalingConnected = false;
    this.peerConnected = false;
    this.iceCandidateQueue = [];
    this.attemptSettled = false;

    return new Promise<void>((resolve, reject) => {
      const settle = (fn: () => void) => {
        if (this.attemptSettled) return;
        this.attemptSettled = true;
        fn();
      };

      let ws: WebSocket;
      try {
        ws = new WebSocket(this.signalingUrl);
      } catch (err) {
        settle(() => reject(err));
        return;
      }
      this.ws = ws;

      const signalingTimeout = this.timeout(() => {
        if (!this.signalingConnected) {
          settle(() => reject(new Error("signaling connection timed out")));
          this.teardownInternals();
        }
      }, SIGNALING_TIMEOUT_MS);

      const peerTimeout = this.timeout(() => {
        if (!this.peerConnected) {
          settle(() => reject(new Error("peer connection timed out")));
          this.teardownInternals();
        }
      }, PEER_TIMEOUT_MS);

      ws.onopen = () => {
        this.signalingConnected = true;
        this.clearTimeoutTracked(signalingTimeout);
      };

      ws.onmessage = async (event) => {
        try {
          const signal = JSON.parse(event.data);
          if (!this.pc && signal.type === "offer") {
            this.initPeerConnection(() => {
              // onConnected for this attempt
              this.clearTimeoutTracked(peerTimeout);
              settle(() => resolve());
            });
          }
          if (this.pc) {
            await this.handleSignal(signal);
          }
        } catch (err) {
          settle(() => reject(err as Error));
        }
      };

      ws.onerror = () => {
        if (this.peerConnected) {
          this.onTerminalDrop();
        } else {
          settle(() => reject(new Error("signaling socket error")));
        }
      };

      ws.onclose = () => {
        this.signalingConnected = false;
        if (this.peerConnected) {
          this.onTerminalDrop();
        } else {
          settle(() => reject(new Error("signaling socket closed")));
        }
      };
    });
  }

  private initPeerConnection(onConnectedThisAttempt: () => void): void {
    if (this.pc) return;
    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      ...(this.iceTransportPolicy
        ? { iceTransportPolicy: this.iceTransportPolicy }
        : {}),
    });
    this.pc = pc;

    pc.ontrack = (event) => {
      // Chromium buffers a few frames by default even in low-latency mode;
      // these non-standard receiver hints ask for near-zero playout delay,
      // appropriate for a genuinely real-time (not prerecorded) track.
      const receiver = event.receiver as RTCRtpReceiver & {
        playoutDelayHint?: number;
        jitterBufferTarget?: number;
      };
      if (receiver) {
        try {
          receiver.playoutDelayHint = 0;
          receiver.jitterBufferTarget = 0;
        } catch {
          // non-Chromium browser - ignore
        }
      }
      if (event.streams && event.streams[0]) {
        this.currentStream = event.streams[0];
        this.emit("videoTrack", event.streams[0]);
      }
    };

    pc.ondatachannel = (event) => {
      this.dataChannel = event.channel;
      this.setupDataChannel();
    };

    pc.onicecandidate = (event) => {
      if (event.candidate && this.ws && this.signalingConnected) {
        this.ws.send(
          JSON.stringify({
            type: "ice-candidate",
            candidate: event.candidate.toJSON(),
          })
        );
      }
    };

    pc.onconnectionstatechange = () => {
      const state = this.pc?.connectionState;
      if (state === "connected") {
        if (!this.peerConnected) {
          this.peerConnected = true;
          this.reconnectAttempt = 0;
          this.emit("connected");
          onConnectedThisAttempt();
          this.startStatsPollingIfEnabled();
        }
      } else if (state === "failed") {
        if (this.peerConnected) {
          this.triggerIceRestart();
        }
      } else if (state === "disconnected") {
        if (this.peerConnected) {
          this.triggerIceRestart();
        }
      } else if (state === "closed") {
        if (this.peerConnected) {
          this.onTerminalDrop();
        }
      }
    };
  }

  private setupDataChannel(): void {
    const dc = this.dataChannel;
    if (!dc) return;
    dc.binaryType = "arraybuffer";
    dc.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        this.handleBinaryMessage(event.data);
      }
    };
  }

  private handleBinaryMessage(data: ArrayBuffer): void {
    if (data.byteLength < 1) return;
    const view = new DataView(data);
    const messageType = view.getUint8(0);
    const offset = 1;
    const decoder = new TextDecoder();
    try {
      switch (messageType) {
        case MessageType.NavigationState:
          if (data.byteLength > offset) {
            const nav: NavigationState = JSON.parse(
              decoder.decode(new Uint8Array(view.buffer, offset))
            );
            this.emit("navigation", nav);
          }
          break;
        case MessageType.ElementStateUpdate:
          if (data.byteLength > offset) {
            const state: ElementState = JSON.parse(
              decoder.decode(new Uint8Array(view.buffer, offset))
            );
            this.emit("state", state);
          }
          break;
        case MessageType.ViewportSize:
          // Backend echo of the applied viewport; not surfaced today.
          break;
        case MessageType.Error:
          if (data.byteLength > offset) {
            const parsed: { error?: string } = JSON.parse(
              decoder.decode(new Uint8Array(view.buffer, offset))
            );
            this.emit("error", parsed.error || "Unknown server error");
          }
          break;
      }
    } catch {
      // malformed message - ignore rather than tear down the channel
    }
  }

  private async handleSignal(signal: any): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    try {
      switch (signal.type) {
        case "offer": {
          await pc.setRemoteDescription({ type: "offer", sdp: signal.sdp });
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          this.ws?.send(JSON.stringify({ type: "answer", sdp: answer.sdp || "" }));
          while (this.iceCandidateQueue.length > 0) {
            const candidate = this.iceCandidateQueue.shift();
            if (candidate) {
              try {
                await pc.addIceCandidate(new RTCIceCandidate(candidate));
              } catch {
                // ignore a single bad queued candidate
              }
            }
          }
          break;
        }
        case "ice-candidate":
          if (signal.candidate && signal.candidate.candidate) {
            const candidate = new RTCIceCandidate(signal.candidate);
            if (pc.remoteDescription) {
              try {
                await pc.addIceCandidate(candidate);
              } catch {
                // ignore
              }
            } else {
              this.iceCandidateQueue.push(signal.candidate);
            }
          }
          break;
      }
    } catch {
      // A signaling-level failure will surface as a PC state change; don't
      // tear down here.
    }
  }

  private async triggerIceRestart(): Promise<void> {
    const pc = this.pc;
    if (!pc || !this.ws || !this.signalingConnected) {
      this.onTerminalDrop();
      return;
    }
    if (pc.signalingState !== "stable") return; // renegotiation already in flight
    try {
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      this.ws.send(JSON.stringify({ type: "offer", sdp: offer.sdp || "" }));
    } catch {
      this.onTerminalDrop();
    }
  }

  // A terminal drop (signaling socket lost, or PC closed) after having been
  // connected. Emit "disconnected", then run a background reconnect loop to the
  // same session unless disabled/aborted.
  private onTerminalDrop(): void {
    if (this.userClosed) return;
    if (!this.peerConnected && this.supervising) return; // already recovering
    this.peerConnected = false;
    this.emit("disconnected");
    this.teardownInternals();
    if (!this.reconnectEnabled) {
      this.emit("closed", "connection lost");
      return;
    }
    if (this.supervising) return;
    this.supervising = true;
    this.reconnectAttempt = 0;
    void this.reconnectLoop();
  }

  private async reconnectLoop(): Promise<void> {
    try {
      for (;;) {
        if (this.userClosed) return;
        this.reconnectAttempt++;
        if (this.reconnectAttempt > this.maxAttempts) {
          this.emit("closed", "reconnection attempts exhausted");
          return;
        }
        this.emit("reconnecting", this.reconnectAttempt, this.maxAttempts);
        try {
          await this.establish();
          return; // reconnected; "connected" already emitted
        } catch {
          await this.wait(this.nextDelayMs());
        }
      }
    } finally {
      this.supervising = false;
    }
  }

  // --- Input sending ---

  private sendInput(type: string, data: Record<string, unknown>): void {
    const dc = this.dataChannel;
    if (!dc || dc.readyState !== "open") return;
    // `t`: client send time (epoch ms) so the backend can measure true
    // end-to-end input latency. Valid to compare against the backend wall
    // clock only when both run on the same host (true in every tested setup).
    try {
      dc.send(JSON.stringify({ type, data: { ...data, t: Date.now() } }));
    } catch {
      // drop on transient send failure
    }
  }

  // Navigation travels over the signaling socket, not the DataChannel.
  navigate(url: string): void {
    if (this.ws && this.signalingConnected) {
      this.ws.send(JSON.stringify({ type: "navigate", sdp: url }));
    }
  }

  sendInitialViewport(
    width: number,
    height: number,
    isMobile?: boolean,
    userAgent?: string
  ): void {
    if (!this.ws || !this.signalingConnected) return;
    this.ws.send(
      JSON.stringify({
        type: "initial_viewport",
        width,
        height,
        isMobile: !!isMobile,
        userAgent: userAgent || "",
      })
    );
  }

  navigateBack(): void {
    this.sendInput("back", {});
  }
  navigateForward(): void {
    this.sendInput("forward", {});
  }
  refresh(): void {
    this.sendInput("refresh", {});
  }

  mouseMove(x: number, y: number, dragging: boolean): void {
    if (dragging) {
      // 60Hz cap; intermediate positions in the window are dropped, the next
      // allowed send uses the freshest coordinates.
      const now = Date.now();
      if (now - this.lastMouseSendTime < MOUSE_BATCH_INTERVAL_MS) return;
      this.sendInput("mousemove", { x, y, dragging: true });
      this.lastMouseSendTime = now;
      return;
    }
    this.mouseEventQueue.push({ x, y, dragging });
    if (this.mouseEventQueue.length > 3) this.mouseEventQueue.shift();
    if (this.mouseBatchTimer === null) this.startMouseBatching();
  }

  private startMouseBatching(): void {
    this.mouseBatchTimer = setInterval(() => {
      if (this.mouseEventQueue.length === 0) return;
      const now = Date.now();
      if (now - this.lastMouseSendTime < MOUSE_BATCH_INTERVAL_MS) return;
      const latest = this.mouseEventQueue[this.mouseEventQueue.length - 1]!;
      this.sendInput("mousemove", {
        x: latest.x,
        y: latest.y,
        dragging: latest.dragging,
      });
      this.lastMouseSendTime = now;
      this.mouseEventQueue = [];
    }, MOUSE_BATCH_INTERVAL_MS);
  }

  mouseDown(x: number, y: number): void {
    this.sendInput("mousedown", { x, y });
  }
  mouseUp(x: number, y: number): void {
    this.sendInput("mouseup", { x, y });
  }
  scroll(deltaY: number): void {
    this.sendInput("scroll", { deltaY });
  }
  setViewport(width: number, height: number): void {
    this.sendInput("set_viewport", { width, height });
  }
  copyText(): void {
    this.sendInput("copy_text", {});
  }
  pasteText(text: string): void {
    this.sendInput("paste_text", { text });
  }

  dispatchKeyEvent(keyEvent: KeyEvent): void {
    const modifiers =
      (keyEvent.altKey ? 1 : 0) |
      (keyEvent.ctrlKey ? 2 : 0) |
      (keyEvent.metaKey ? 4 : 0) |
      (keyEvent.shiftKey ? 8 : 0);
    this.sendInput(keyEvent.type, {
      key: keyEvent.key,
      code: keyEvent.code,
      modifiers,
    });
  }

  dispatchTouch(type: TouchDispatchType, points: TouchPoint[]): void {
    this.sendInput(type, { points });
  }

  isConnected(): boolean {
    return this.peerConnected && this.dataChannel?.readyState === "open";
  }

  // The current video stream, if a track has arrived. Lets a viewer that mounts
  // after "videoTrack" already fired still bind the video (see currentStream).
  getVideoStream(): MediaStream | null {
    return this.currentStream;
  }

  // --- Stats ---

  private startStatsPollingIfEnabled(): void {
    if (this.statsIntervalMs <= 0 || this.statsTimer !== null) return;
    this.statsTimer = setInterval(async () => {
      const stats = await this.getStats();
      if (stats) this.emit("stats", stats);
    }, this.statsIntervalMs);
  }

  // One-shot transport/quality snapshot from RTCPeerConnection.getStats().
  // Returns null if no peer connection exists.
  async getStats(): Promise<GlassStats | null> {
    const pc = this.pc;
    if (!pc) return null;
    let candidatePair: any = null;
    let inboundVideo: any = null;
    try {
      const report = await pc.getStats();
      report.forEach((stat: any) => {
        if (
          stat.type === "candidate-pair" &&
          stat.state === "succeeded" &&
          (stat.nominated ?? true)
        ) {
          candidatePair = stat;
        } else if (stat.type === "inbound-rtp" && stat.kind === "video") {
          inboundVideo = stat;
        }
      });
    } catch {
      return null;
    }

    const now = Date.now();
    let throughputKbps: number | null = null;
    if (candidatePair && typeof candidatePair.bytesReceived === "number") {
      if (this.lastStatsSample) {
        const dtSec = (now - this.lastStatsSample.time) / 1000;
        const deltaBytes =
          candidatePair.bytesReceived - this.lastStatsSample.bytesReceived;
        throughputKbps = dtSec > 0 ? (deltaBytes * 8) / 1000 / dtSec : null;
      }
      this.lastStatsSample = {
        time: now,
        bytesReceived: candidatePair.bytesReceived,
      };
    }

    let jitterBufferMs: number | null = null;
    if (
      inboundVideo &&
      typeof inboundVideo.jitterBufferDelay === "number" &&
      typeof inboundVideo.jitterBufferEmittedCount === "number"
    ) {
      if (this.lastJitterSample) {
        const deltaDelaySec =
          inboundVideo.jitterBufferDelay - this.lastJitterSample.delaySec;
        const deltaEmitted =
          inboundVideo.jitterBufferEmittedCount -
          this.lastJitterSample.emittedCount;
        if (deltaEmitted > 0) {
          jitterBufferMs = (deltaDelaySec / deltaEmitted) * 1000;
        }
      }
      this.lastJitterSample = {
        delaySec: inboundVideo.jitterBufferDelay,
        emittedCount: inboundVideo.jitterBufferEmittedCount,
      };
    }

    return {
      rttMs:
        candidatePair && typeof candidatePair.currentRoundTripTime === "number"
          ? candidatePair.currentRoundTripTime * 1000
          : null,
      throughputKbps,
      availableOutgoingBitrateKbps:
        candidatePair &&
        typeof candidatePair.availableOutgoingBitrate === "number"
          ? candidatePair.availableOutgoingBitrate / 1000
          : null,
      jitterBufferMs,
      framesDecoded: inboundVideo?.framesDecoded ?? null,
      framesDropped: inboundVideo?.framesDropped ?? null,
      dataChannelBufferedAmount: this.dataChannel?.bufferedAmount ?? null,
    };
  }

  // --- Cleanup ---

  // Permanently closes the client: stops reconnection, tears down the peer
  // connection and signaling socket, and (best-effort) deletes the session.
  // After this, no further events fire. Safe to call more than once.
  disconnect(): void {
    if (this.userClosed) return;
    this.userClosed = true;
    if (this.unloadHandler && typeof window !== "undefined") {
      window.removeEventListener("pagehide", this.unloadHandler);
      this.unloadHandler = null;
    }
    for (const t of this.pendingTimeouts) clearTimeout(t);
    this.pendingTimeouts.clear();
    this.teardownInternals();
    if (this.ws) {
      try {
        this.ws.close(1000, "client disconnecting");
      } catch {
        // ignore
      }
      this.detachWs();
    }
    if (this.sessionId && this.deleteOnClose) {
      deleteGlassSession(this.sessionId, this.sessionBaseUrl, this.apiToken);
    }
    this.emit("closed", "client disconnected");
    this.removeAllListeners();
  }

  // Tears down the PC/DC and detaches the WS handlers WITHOUT ending the
  // client - used between reconnect attempts. Does not clear userClosed.
  private teardownInternals(): void {
    if (this.mouseBatchTimer !== null) {
      clearInterval(this.mouseBatchTimer);
      this.mouseBatchTimer = null;
    }
    this.mouseEventQueue = [];
    if (this.statsTimer !== null) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    this.lastStatsSample = null;
    this.lastJitterSample = null;
    // The stream belongs to the peer connection we're tearing down; drop it so
    // a viewer mounting mid-reconnect doesn't bind a dead track (a fresh
    // ontrack will replace it when the reconnect completes).
    this.currentStream = null;

    if (this.dataChannel) {
      try {
        if (
          this.dataChannel.readyState === "open" ||
          this.dataChannel.readyState === "connecting"
        ) {
          this.dataChannel.close();
        }
      } catch {
        // ignore
      }
      this.dataChannel.onmessage = null;
      this.dataChannel = null;
    }
    if (this.pc) {
      try {
        if (this.pc.connectionState !== "closed") this.pc.close();
      } catch {
        // ignore
      }
      this.pc.ontrack = null;
      this.pc.ondatachannel = null;
      this.pc.onicecandidate = null;
      this.pc.onconnectionstatechange = null;
      this.pc = null;
    }
    // Detach the WS handlers so a reconnect's fresh socket owns the callbacks,
    // but only close it here if we're not doing a full teardown in disconnect
    // (which closes it explicitly). Between attempts, establish() opens a new
    // socket, so close the old one now.
    if (this.ws && !this.userClosed) {
      const old = this.ws;
      this.detachWs();
      try {
        old.close();
      } catch {
        // ignore
      }
    }
    this.peerConnected = false;
  }

  private detachWs(): void {
    if (!this.ws) return;
    this.ws.onopen = null;
    this.ws.onmessage = null;
    this.ws.onerror = null;
    this.ws.onclose = null;
    this.ws = null;
  }

  private timeout(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const t = setTimeout(() => {
      this.pendingTimeouts.delete(t);
      fn();
    }, ms);
    this.pendingTimeouts.add(t);
    return t;
  }

  private clearTimeoutTracked(t: ReturnType<typeof setTimeout>): void {
    clearTimeout(t);
    this.pendingTimeouts.delete(t);
  }
}

// Convenience factory mirroring the rest of the SDK's function-first surface.
export function createGlassClient(options: GlassClientOptions): GlassClient {
  return new GlassClient(options);
}

// Derives the http(s) origin from a ws(s):// signaling URL, for the session
// DELETE call. Falls back to same-origin ("") if it can't be parsed.
function originOf(signalingUrl: string): string {
  try {
    const u = new URL(signalingUrl);
    const httpProto = u.protocol === "wss:" ? "https:" : "http:";
    return `${httpProto}//${u.host}`;
  } catch {
    return "";
  }
}
