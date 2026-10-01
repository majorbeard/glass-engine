// Client-side input latency, measured entirely on this client's monotonic
// clock.
//
// The client numbers each interaction input ("s") and notes performance.now()
// as it sends it. Glass answers with an InputFrame message naming, by RTP
// timestamp, the frame that followed the input; when requestVideoFrameCallback
// reports that frame (or a later one) on screen, the sample is its
// expectedDisplayTime minus the send time. No timestamp crosses between the
// two machines' clocks, and a wall-clock (Date.now) adjustment can't move it.
//
// Two kinds of sample:
// - discrete (click, key, tap): "time to first eligible painted frame".
//   Glass tags a frame only when the input was the sole one pending since the
//   previous frame; it is the first frame after the input, not proof that the
//   input caused it.
// - continuous (mousemove, scroll, touchmove): each frame carries the newest
//   stream input dispatched before its capture, so the sample is how old the
//   input behind what is on screen was when it was shown.

export interface InputLatencySample {
  kind: string;
  ms: number;
  continuous: boolean;
}

export interface InputLatencySummary {
  n: number;
  p50: number | null;
  p95: number | null;
}

export interface InputLatencyStats {
  discrete: InputLatencySummary;
  continuous: InputLatencySummary;
}

const DISCRETE_KINDS = new Set(["mousedown", "mouseup", "keydown", "keyup", "touchstart", "touchend"]);
const CONTINUOUS_KINDS = new Set(["mousemove", "scroll", "touchmove"]);

// A numbered input or a tagged frame older than this is forgotten (Glass
// tags nothing older than 2 s; the extra second covers decode and display).
const FORGET_AFTER_MS = 3000;
// Recent samples kept for inputLatencyStats().
const STATS_WINDOW = 200;
// Pending report samples are capped so a stalled DataChannel can't grow them.
const MAX_REPORT = 200;

interface Sent {
  kind: string;
  at: number;
  continuous: boolean;
}

interface Awaiting extends Sent {
  rtp: number;
}

// True if RTP timestamp a is at or after b, across the 32-bit wrap.
export function rtpAtOrAfter(a: number, b: number): boolean {
  return ((a - b) >>> 0) < 0x80000000;
}

export class InputLatencyTracker {
  private seq = 0;
  private sent = new Map<number, Sent>();
  private awaiting: Awaiting[] = [];
  private recent: InputLatencySample[] = [];
  private report: InputLatencySample[] = [];

  constructor(private readonly now: () => number = () => performance.now()) {}

  // Numbers an outgoing input of this kind, or returns undefined for kinds
  // that aren't measured.
  number(kind: string): number | undefined {
    const continuous = CONTINUOUS_KINDS.has(kind);
    if (!continuous && !DISCRETE_KINDS.has(kind)) return undefined;
    const at = this.now();
    this.forget(at);
    this.seq = (this.seq + 1) >>> 0;
    this.sent.set(this.seq, { kind, at, continuous });
    return this.seq;
  }

  // An InputFrame message: the frame with this RTP timestamp followed these
  // inputs.
  onInputFrame(rtp: number, tags: { s: number }[]): void {
    for (const tag of tags) {
      const sent = this.sent.get(tag.s);
      if (!sent) continue;
      this.sent.delete(tag.s);
      this.awaiting.push({ ...sent, rtp: rtp >>> 0 });
    }
  }

  // A frame was presented: completes every awaited input whose frame is
  // this one or earlier (a frame the decoder skipped still counts once a
  // later one is shown).
  onPresentedFrame(rtp: number, displayTime: number): InputLatencySample[] {
    if (this.awaiting.length === 0) return [];
    const done: InputLatencySample[] = [];
    this.awaiting = this.awaiting.filter((a) => {
      if (!rtpAtOrAfter(rtp >>> 0, a.rtp)) return true;
      const ms = displayTime - a.at;
      if (ms >= 0) done.push({ kind: a.kind, ms, continuous: a.continuous });
      return false;
    });
    for (const s of done) {
      this.recent.push(s);
      if (this.report.length < MAX_REPORT) this.report.push(s);
    }
    if (this.recent.length > STATS_WINDOW) this.recent.splice(0, this.recent.length - STATS_WINDOW);
    this.forget(this.now());
    return done;
  }

  // Samples not yet reported to Glass; clears them.
  takeReport(): InputLatencySample[] {
    const out = this.report;
    this.report = [];
    return out;
  }

  stats(): InputLatencyStats {
    const summarize = (continuous: boolean): InputLatencySummary => {
      const v = this.recent.filter((s) => s.continuous === continuous).map((s) => s.ms).sort((a, b) => a - b);
      const pct = (p: number): number | null => v[Math.round(p * (v.length - 1))] ?? null;
      return { n: v.length, p50: pct(0.5), p95: pct(0.95) };
    };
    return { discrete: summarize(false), continuous: summarize(true) };
  }

  // Drops in-flight state; a new connection starts clean.
  reset(): void {
    this.sent.clear();
    this.awaiting = [];
  }

  private forget(now: number): void {
    for (const [s, sent] of this.sent) {
      if (now - sent.at > FORGET_AFTER_MS) this.sent.delete(s);
    }
    this.awaiting = this.awaiting.filter((a) => now - a.at <= FORGET_AFTER_MS);
  }
}

// The cumulative inbound-rtp video counters (RTCInboundRtpStreamStats) an
// input_latency_report's receiver window is computed from, plus when they
// were read (performance.now()).
export interface ReceiverCounters {
  at: number;
  jitterBufferDelay?: number;
  jitterBufferEmittedCount?: number;
  totalDecodeTime?: number;
  framesDecoded?: number;
  framesDropped?: number;
}

// What the viewer's receiver did between two reads, sent as the report's
// "rx": jitter-buffer delay and decode time per frame (ms), frames decoded
// per second, frames dropped. It says whether input latency is spent in
// the network or on the client. A field is left out when a counter is
// missing or didn't move.
export interface ReceiverWindow {
  jb?: number;
  dec?: number;
  fps?: number;
  drop?: number;
}

const round1 = (v: number) => Math.round(v * 10) / 10;

export function receiverWindow(prev: ReceiverCounters, cur: ReceiverCounters): ReceiverWindow {
  const d = (k: keyof ReceiverCounters): number | undefined => {
    const a = prev[k];
    const b = cur[k];
    return typeof a === "number" && typeof b === "number" && b >= a ? b - a : undefined;
  };
  const out: ReceiverWindow = {};
  const emitted = d("jitterBufferEmittedCount");
  const jbDelay = d("jitterBufferDelay");
  if (emitted && jbDelay !== undefined) out.jb = round1((jbDelay / emitted) * 1000);
  const decoded = d("framesDecoded");
  const decodeTime = d("totalDecodeTime");
  if (decoded && decodeTime !== undefined) out.dec = round1((decodeTime / decoded) * 1000);
  const seconds = (cur.at - prev.at) / 1000;
  if (decoded !== undefined && seconds > 0) out.fps = round1(decoded / seconds);
  const dropped = d("framesDropped");
  if (dropped !== undefined) out.drop = dropped;
  return out;
}

type RVFCMetadata = VideoFrameCallbackMetadata & { rtpTimestamp?: number };

// Calls onFrame for every frame video presents that carries an RTP
// timestamp (a WebRTC source in a browser with requestVideoFrameCallback).
// Returns a stop function; a no-op where unsupported.
export function watchPresentedFrames(
  video: HTMLVideoElement,
  onFrame: (rtpTimestamp: number, expectedDisplayTime: number) => void
): () => void {
  if (typeof video.requestVideoFrameCallback !== "function") return () => {};
  let handle: number | null = null;
  let stopped = false;
  const next = () => {
    if (stopped) return;
    handle = video.requestVideoFrameCallback((_now, metadata) => {
      handle = null;
      const m = metadata as RVFCMetadata;
      if (m.rtpTimestamp !== undefined) onFrame(m.rtpTimestamp, m.expectedDisplayTime);
      next();
    });
  };
  next();
  return () => {
    stopped = true;
    if (handle !== null) video.cancelVideoFrameCallback(handle);
  };
}
