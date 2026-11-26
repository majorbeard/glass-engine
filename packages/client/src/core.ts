// ClientCore holds one GlassClient's state and configuration; the
// modules (lifecycle, transport, input, ...) operate on it. Internal:
// not exported from the package.

import type { GlassClientOptions, GlassClientEventMap, GlassCloseCode } from "./index";
import { DEFAULT_RECONNECT_DELAYS_MS, DEFAULT_MAX_RECONNECT_ATTEMPTS, originOf } from "./internal";
import type { GlassConnectionQuality, GlassControlAnswer, GlassDialog, GlassMember, GlassPlaybackState, GlassRights, GlassSourceInfo } from "./types";
import { InputLatencyTracker } from "./input_latency";
import type { ReceiverCounters } from "./input_latency";
import { EncodedStreamChecker } from "./encoded_stream_check";
import type { GlassPublication } from "./publish";

// Ending is a "closed" event's arguments: a sentence for people, a code for programs.
export interface Ending {
  reason: string;
  code: GlassCloseCode;
}

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

// SourceState is what this client knows of one of the session's sources: the
// engine's description, the stream of the tracks it receives of it, and the
// per-source state its messages carry.
export interface SourceState {
  info: GlassSourceInfo;
  // The tracks this connection receives of the source, in one stream; null
  // until the first arrives.
  stream: MediaStream | null;
  // The connections holding the source's input track, and who has its floor
  // (input mode "floor"), from input_holders.
  holders: string[];
  floor: string | null;
  // The page's open dialog (a browser), and a playback's state.
  dialog: GlassDialog | null;
  playback: GlassPlaybackState | null;
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
  // Each receiving line's source, from Glass's "tracks"; tracks that arrived
  // on a line not yet mapped; offers made one at a time (the client offers,
  // Glass answers: protocol v3).
  mids = new Map<string, string>();
  pendingTracks = new Map<string, MediaStreamTrack>();
  negotiation: Promise<void> = Promise.resolve();
  // Whether the session takes a published picture as simulcast layers, from
  // hello; until then, assumed to.
  sessionSimulcast = true;
  // Whether this connection, the owner of a session that lets it, may mint
  // links with its own link (hello's mayShare).
  mayShare = false;
  // The session's sources, by id, in the order the engine announced them.
  // Kept across a reconnect, so a viewer bound to one keeps it; the new
  // hello replaces their descriptions.
  sources = new Map<string, SourceState>();
  // This connection's identity and what its link may do, from hello; null
  // before the first. A resumed connection keeps its id.
  _connectionId: string | null = null;
  _owner = false;
  _rights: GlassRights | null = null;
  // The sources this connection was denied watching or controlling by the
  // owner, from rights_changed.
  _deniedWatch: string[] = [];
  _deniedControl: string[] = [];
  // The other members, for an owner (hello's members, member_joined and
  // member_left); empty for anyone else.
  _members = new Map<string, GlassMember>();
  // Whether the session is being recorded, from the recording message the
  // engine sends on connect and on every change.
  _recording = false;
  // What this client publishes (publish()), kept across a reconnect: each
  // goes on every new connection's peer connection again.
  publications: GlassPublication[] = [];
  // Control requests waiting for Glass's control_answer, by the id each was sent with.
  controlPending = new Map<number, { action: GlassControlAnswer["action"]; source: string; connectionId?: string; resolve: (answer: GlassControlAnswer) => void }>();
  controlNextId = 1;
  // Client-side input latency (input_latency.ts); samples are reported to
  // Glass at most every INPUT_LATENCY_REPORT_MS.
  inputLatency = new InputLatencyTracker();
  lastInputLatencyReportAt = 0;
  // The receiver counters read with the last input_latency_report.
  lastReceiverCounters: ReceiverCounters | null = null;
  // Last connection_quality Glass sent; null before the first.
  _connectionQuality: GlassConnectionQuality | null = null;
  // Coalescing state for locally withheld input; see drops.ts.
  localDrops = new Map<string, { reportedAt: number | null; pending: number }>();
  // Owns createEncodedStreams() against the current receiver - see
  // InternalGlassClientOptions.__internalEncodedStreamCheckEnabled. One per
  // receiver (a fresh receiver arrives on every reconnect's "ontrack"),
  // torn down in teardownInternals alongside everything else PC-scoped.
  encodedStreamChecker: EncodedStreamChecker | null = null;

  // The link this client joins with: the member connection's URL, carrying
  // the link's token.
  readonly link: string;
  // The engine's origin, for the source routes (downloads, uploads).
  readonly engineOrigin: string;
  readonly iceServers: RTCIceServer[];
  // Whether the application gave its own iceServers. If it did not, the
  // engine's are used: it sends them in hello, the first message of every
  // connection, TURN credential included.
  readonly iceServersGiven: boolean;
  serverIceServers: RTCIceServer[] | null = null;
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
  // See GlassClientOptions.repairWait and repair_wait.ts.
  readonly repairWait: boolean;

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
  serverTerminalError: Ending | null = null;
  // Set, to the "closed" reason, when Glass closed the socket with CLOSE_SESSION_NOT_FOUND,
  // CLOSE_LINK_EXPIRED or CLOSE_LINK_REVOKED, or the protocol versions differ: stops the
  // reconnect loop.
  sessionGone: Ending | null = null;
  // Set, to the reason, when Glass refused the last attempt for now (CLOSE_VIEWER_LIMIT); the retry
  // paths report it as a "refused" event and clear it.
  refusedReason: string | null = null;

  // Timers we must clear on close (backoff waits, batch timer, stats timer).
  pendingTimeouts = new Set<ReturnType<typeof setTimeout>>();
  mouseBatchTimer: ReturnType<typeof setInterval> | null = null;
  statsTimer: ReturnType<typeof setInterval> | null = null;
  traceReportTimer: ReturnType<typeof setInterval> | null = null;
  repairWaitTimer: ReturnType<typeof setInterval> | null = null;
  // Armed while the peer connection sits in "disconnected"; see
  // scheduleDisconnectedGrace. Tracked via this.timeout()/pendingTimeouts so
  // close() clears it like every other timer.
  disconnectedGraceTimer: ReturnType<typeof setTimeout> | null = null;

  // Mouse-move batching.
  mouseEventQueue: Array<{ x: number; y: number; dragging: boolean; src: string }> =
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
      this.link = options.link;
      this.engineOrigin = originOf(options.link);
      this.iceServers = options.iceServers ?? [
        { urls: "stun:stun.l.google.com:19302" },
      ];
      this.iceServersGiven = options.iceServers !== undefined;
      this.iceTransportPolicy = options.iceTransportPolicy;
      const rc = options.reconnect ?? true;
      this.reconnectEnabled = rc !== false;
      const rcOpts = typeof rc === "object" ? rc : {};
      this.maxAttempts = rcOpts.maxAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
      this.delaysMs = rcOpts.delaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
      this.statsIntervalMs = options.statsIntervalMs ?? 0;
      this.repairWait = options.repairWait ?? true;
      const internalOpts = options as GlassClientOptions & InternalGlassClientOptions;
      this.traceReportIntervalMs = internalOpts.__internalTraceReportIntervalMs ?? 0;
      this._pixelTraceEnabled = internalOpts.__internalPixelTraceEnabled ?? false;
      this._encodedStreamCheckEnabled = internalOpts.__internalEncodedStreamCheckEnabled ?? false;
      this._decodeReadbackEnabled = internalOpts.__internalDecodeReadbackEnabled ?? false;
      this.jitterBufferTargetMs = internalOpts.__internalJitterBufferTargetMs ?? 0;
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
