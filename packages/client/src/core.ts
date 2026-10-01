// ClientCore holds one GlassClient's state and configuration; the
// modules (lifecycle, transport, input, ...) operate on it. Internal:
// not exported from the package.

import type { GlassClientOptions, GlassClientEventMap } from "./index";
import { DEFAULT_RECONNECT_DELAYS_MS, DEFAULT_MAX_RECONNECT_ATTEMPTS, originOf } from "./internal";
import type { GlassRosterEntry, GlassSlotState } from "./types";
import { InputLatencyTracker } from "./input_latency";
import type { ReceiverCounters } from "./input_latency";
import { EncodedStreamChecker } from "./encoded_stream_check";

// @internal Not part of GlassClientOptions - deliberately undocumented and
// excluded from the public options surface (see GlassClient's
// traceReportIntervalMs field doc comment for why). Read via an inline cast
// at construction, e.g. `new GlassClient({...options, __internalTraceReportIntervalMs: 5000})`.
export interface InternalGlassClientOptions {
  __internalTraceReportIntervalMs?: number;
  // Enables the viewer's PixelTraceSampler (see pixel_trace.ts) - read by
  // mountGlassViewer via GlassClient.pixelTraceEnabled, since the sampler
  // itself needs a <video> element GlassClient (DOM-free by design, see
  // index.ts's header) never touches.
  __internalPixelTraceEnabled?: boolean;
  // Enables EncodedStreamChecker (see encoded_stream_check.ts) - unlike
  // __internalPixelTraceEnabled above, this needs no <video> element (only
  // the RTCRtpReceiver ontrack already hands GlassClient), so GlassClient
  // owns its whole lifecycle itself rather than delegating to
  // mountGlassViewer. See encoded_stream_check.ts's own header comment for
  // why this stays opt-in rather than becoming a default-on diagnostic.
  __internalEncodedStreamCheckEnabled?: boolean;
  // Enables DecodeReadbackOverlay (see decode_readback_check.ts) - like
  // __internalPixelTraceEnabled, needs the viewer's <video> element, so
  // read via mountGlassViewer through the decodeReadbackEnabled getter
  // below, same pattern.
  __internalDecodeReadbackEnabled?: boolean;
  // Overrides the receiver's jitterBufferTarget/playoutDelayHint,
  // normally hardcoded to 0 for near-zero playout delay - see pc.ontrack's
  // own doc comment for why 0 is the deliberate default (this is a
  // real-time interactive stream, not prerecorded video; low input-to-paint
  // latency is core to the product). Exists ONLY to test the leading
  // mitigation theory from a video-corruption investigation:
  // a larger jitter buffer gives NACK retransmissions more time to land
  // before a frame's playout deadline, directly targeting the "late
  // retransmission -> frame silently dropped -> decoder drift" mechanism
  // all four reviewers converged on. Real product tradeoff, not a free
  // fix - raising this measurably increases felt latency; live-tested
  // 2026-08-17 at 1000ms against a real degraded network: packet
  // loss/NACKs dropped to zero (the mechanism is confirmed real), but
  // felt latency was judged unacceptable for interactive use. Not
  // intended to become the shipped default without deciding that
  // tradeoff explicitly.
  //
  // A number sets both hints to that fixed value (ms) unconditionally,
  // same as before. The string "native" does something different: it
  // skips setting either hint at all, leaving Chromium's own adaptive
  // jitter-buffer logic in control - the previous hardcoded-0 default
  // forces a fixed near-zero delay always, which disables that adaptive
  // behavior entirely (Chromium never gets to grow the buffer on its own
  // when it detects real loss). "native" tests whether Chromium's own
  // built-in adaptation gets meaningfully more loss-robustness than fixed
  // 0ms without paying a fixed large-latency cost all the time the way a
  // large fixed number does.
  __internalJitterBufferTargetMs?: number | "native";
}

// Emit forwards to GlassClient's (protected) emit.
export type Emit = <K extends keyof GlassClientEventMap>(event: K, ...args: GlassClientEventMap[K]) => void;

export class ClientCore {
  pc: RTCPeerConnection | null = null;
  ws: WebSocket | null = null;
  dataChannel: RTCDataChannel | null = null;
  // "frames-input-fast" - unordered, zero-retransmit, carries only
  // touchmove (see sendInputFast/dispatchTouch). Backend-created like
  // dataChannel above; never sends anything back on it, receive side is
  // unused here on purpose - see setupDataChannel's absence for this one.
  fastDataChannel: RTCDataChannel | null = null;
  // AudioInput - the sender created by
  // attachMicPlaceholder's silent placeholder track, kept so
  // grantMicAccess() can replaceTrack() the operator's real microphone
  // onto it later. micPlaceholderCtx is the AudioContext generating the
  // placeholder's silence, kept only so it can be closed (releases real
  // OS audio resources) once a real track replaces it or the connection
  // tears down.
  micSender: RTCRtpSender | null = null;
  micPlaceholderCtx: AudioContext | null = null;
  // The operator's real microphone track from grantMicAccess(). It must be
  // stopped (stopMicTrack) on deny and teardown, or the device stays open
  // and the browser's mic indicator stays on.
  micTrack: MediaStreamTrack | null = null;
  iceCandidateQueue: RTCIceCandidateInit[] = [];
  // The latest received video stream, retained so a viewer that subscribes
  // AFTER the track already arrived (very common: the app connects up front and
  // mounts the viewer only on first navigation, long after ontrack fired) can
  // still bind it via getVideoStream(). Without this, the "videoTrack" event is
  // fire-and-forget and a late subscriber renders black.
  currentStream: MediaStream | null = null;
  // This connection's own identity + starting input-control state, learned
  // from the server's very first "offer" message (its
  // connectionId/producesInput fields, docs/protocol.md). Reset
  // on every fresh establish() attempt (a reconnect gets a NEW connection
  // ID server-side, unless the engine resumes the same one) and updated live thereafter by
  // "capabilities_changed" (see handleSignal). _connectionId stays null
  // only in the brief window before the first offer has ever arrived.
  _connectionId: string | null = null;
  _producesInput = false;
  // Whether THIS connection authenticated with the session's own unscoped
  // credential rather than a minted, capability-scoped grant - see
  // the offer's isOwner field (docs/protocol.md) for what this
  // authorizes. Reset alongside _connectionId/_producesInput on every
  // fresh establish() attempt, for the same reason.
  _isOwner = false;
  // Owner-only roster of every OTHER connection currently on this session -
  // see docs/protocol.md's Control handoff section (connection_joined/
  // connection_left/roster) and the "rosterChanged" event. Keyed by
  // connectionId. Stays empty for a non-owner connection (isOwner() false)
  // - it never receives roster traffic at all.
  _connections = new Map<string, GlassRosterEntry>();
  // Client-side input latency (input_latency.ts); samples are reported to
  // Glass at most every INPUT_LATENCY_REPORT_MS.
  inputLatency = new InputLatencyTracker();
  lastInputLatencyReportAt = 0;
  // The receiver counters read with the last input_latency_report.
  lastReceiverCounters: ReceiverCounters | null = null;
  // Last slot_state snapshot; empty for non-relay sessions.
  _slotStates: Record<string, GlassSlotState> = {};
  unloadHandler: ((event: PageTransitionEvent) => void) | null = null;
  // Owns createEncodedStreams() against the current receiver - see
  // InternalGlassClientOptions.__internalEncodedStreamCheckEnabled. One per
  // receiver (a fresh receiver arrives on every reconnect's "ontrack"),
  // torn down in teardownInternals alongside everything else PC-scoped.
  encodedStreamChecker: EncodedStreamChecker | null = null;

  readonly signalingUrl: string;
  readonly sessionId?: string;
  readonly iceServers: RTCIceServer[];
  readonly iceTransportPolicy?: RTCIceTransportPolicy;
  readonly reconnectEnabled: boolean;
  readonly maxAttempts: number;
  readonly delaysMs: number[];
  readonly statsIntervalMs: number;
  // Internal-only (see InternalGlassClientOptions): a permanent, opt-in
  // diagnostic channel promoting a one-off test technique into real
  // product code -
  // periodically reports real RTCPeerConnection.getStats()-derived numbers
  // back to the backend over the existing reliable DataChannel, which the
  // engine cross-validates against its own self-reported GCC numbers. Kept out of the public
  // GlassClientOptions/exports for now - confirmed cheap to promote later
  // (same underlying plumbing either way, only a typed public surface +
  // docs would need adding) - not because the mechanism itself is
  // unstable.
  readonly traceReportIntervalMs: number;
  // @internal Read by mountGlassViewer (see pixelTraceEnabled getter below)
  // to decide whether to instantiate PixelTraceSampler against its <video>
  // element - see InternalGlassClientOptions.__internalPixelTraceEnabled.
  readonly _pixelTraceEnabled: boolean;
  // @internal See InternalGlassClientOptions.__internalEncodedStreamCheckEnabled.
  readonly _encodedStreamCheckEnabled: boolean;
  // @internal Read by mountGlassViewer via decodeReadbackEnabled below,
  // mirroring pixelTraceEnabled exactly - see
  // InternalGlassClientOptions.__internalDecodeReadbackEnabled.
  readonly _decodeReadbackEnabled: boolean;
  // @internal See InternalGlassClientOptions.__internalJitterBufferTargetMs.
  readonly jitterBufferTargetMs: number | "native";
  readonly deleteOnClose: boolean;
  readonly sessionBaseUrl: string;
  readonly apiToken?: string;

  // Lifecycle state.
  userClosed = false;
  peerConnected = false;
  signalingConnected = false;
  reconnectAttempt = 0;
  supervising = false; // a background reconnect loop is running
  // Set when the server sends an explicit {"type":"error"} signaling message
  // (e.g. the backend's fatalSourceError path - a dead browser process, etc.)
  // right before closing the socket. That path is a deliberate clean Close,
  // NOT a reconnect-grace hold - the session is gone for good, so the close that follows must
  // skip reconnectLoop entirely instead of retrying a session ID that can
  // never come back. Cleared once consumed so it can't leak into a later,
  // unrelated connection.
  serverTerminalError: string | null = null;
  // Set when Glass closed the socket with CLOSE_SESSION_NOT_FOUND: stops the reconnect loop.
  sessionGone = false;

  // Per-attempt settle guard (so a late ws/pc event can't resolve/reject an
  // already-settled establish() attempt).
  attemptSettled = true;

  // Timers we must clear on close (backoff waits, batch timer, stats timer).
  pendingTimeouts = new Set<ReturnType<typeof setTimeout>>();
  mouseBatchTimer: ReturnType<typeof setInterval> | null = null;
  statsTimer: ReturnType<typeof setInterval> | null = null;
  traceReportTimer: ReturnType<typeof setInterval> | null = null;
  // Armed while the peer connection sits in "disconnected"; see
  // scheduleDisconnectedGrace. Tracked via this.timeout()/pendingTimeouts so
  // close() clears it like every other timer.
  disconnectedGraceTimer: ReturnType<typeof setTimeout> | null = null;

  // Mouse-move batching.
  mouseEventQueue: Array<{ x: number; y: number; dragging: boolean }> =
    [];
  lastMouseSendTime = 0;

  // Stats sampling state.
  lastStatsSample: { time: number; bytesReceived: number } | null =
    null;
  lastJitterSample: { delaySec: number; emittedCount: number } | null =
    null;
  // windowMs bookkeeping for collectAndSendTraceReport - see its own doc
  // comment.
  lastTraceReportAt: number | null = null;

  constructor(
    options: GlassClientOptions,
    readonly emit: Emit,
  ) {
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
      const internalOpts = options as GlassClientOptions & InternalGlassClientOptions;
      this.traceReportIntervalMs = internalOpts.__internalTraceReportIntervalMs ?? 0;
      this._pixelTraceEnabled = internalOpts.__internalPixelTraceEnabled ?? false;
      this._encodedStreamCheckEnabled = internalOpts.__internalEncodedStreamCheckEnabled ?? false;
      this._decodeReadbackEnabled = internalOpts.__internalDecodeReadbackEnabled ?? false;
      this.jitterBufferTargetMs = internalOpts.__internalJitterBufferTargetMs ?? 0;
      this.deleteOnClose = options.deleteSessionOnClose ?? !!options.sessionId;
      this.sessionBaseUrl = options.sessionBaseUrl ?? originOf(options.signalingUrl);
      this.apiToken = options.apiToken;
  }

  wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.pendingTimeouts.delete(t);
        resolve();
      }, ms);
      this.pendingTimeouts.add(t);
    });
  }

  timeout(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const t = setTimeout(() => {
      this.pendingTimeouts.delete(t);
      fn();
    }, ms);
    this.pendingTimeouts.add(t);
    return t;
  }

  clearTimeoutTracked(t: ReturnType<typeof setTimeout>): void {
    clearTimeout(t);
    this.pendingTimeouts.delete(t);
  }
}
