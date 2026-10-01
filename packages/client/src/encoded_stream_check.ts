// @internal Insertable Streams (WebRTC Encoded Transform) receive-side
// integrity check.
// Intercepts each ENCODED video frame Chrome's own WebRTC receive pipeline
// hands to the decoder (post-jitter-buffer/depacketization, pre-decode) and
// reports its {rtpTimestamp, type, size, hash} back to the backend, which
// compares it against the exact bytes SendSampleWithID originally sent for
// that same frame (the engine's encoded-frame check).
//
// Every other diagnostic built during this investigation instruments
// something ADJACENT to what Chrome's receive pipeline actually does with
// the bytes (RTP fragmentation reassembly server-side, aggregate
// getStats() counters, painted-frame timing). This is the first one that
// observes Chrome's own view of the encoded frame directly - built after
// getStats()'s keyFramesDecoded field turned out to be inconclusive (stuck
// at 0 for an entire session that demonstrably decoded and displayed real
// content).
//
// Deliberately MORE invasive than pixel_trace.ts, which explicitly avoided
// Insertable Streams for exactly this reason (see that file's own doc
// comment: "no risk of this diagnostic ever altering/dropping/delaying the
// actual decode pipeline"). This transform sits inline in the real receive
// path - every frame MUST be re-enqueued unchanged (controller.enqueue) or
// the video stalls - and computing a checksum over every frame's bytes adds
// real per-frame CPU cost Chrome's pipeline wouldn't otherwise pay. Accepted
// here as a temporary, opt-in (see index.ts's
// __internalEncodedStreamCheckEnabled) cost for a genuinely decisive
// vantage point nothing else in this investigation could reach - not a
// tradeoff to make permanent or default-on.

export interface EncodedFrameReport {
  rtpTimestamp: number;
  type: string; // RTCEncodedVideoFrame.type: "key" | "delta"
  size: number;
  hash: number; // FNV-1a 32-bit over frame.data - see backend's matching fnv1a32
}

// fnv1a32 must stay byte-for-byte identical to the engine's own
// fnv1a32 - both sides hash the same conceptual bytes and compare the
// resulting uint32 directly. Math.imul + `>>> 0` reproduce Go's native
// uint32 wraparound multiply/whole-value semantics in a float64-only
// language.
export function fnv1a32(data: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    h ^= data[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Minimal shape of the real, standard RTCEncodedVideoFrame this transform's
// callback receives - not yet in TS's bundled lib.dom.d.ts (same gap
// pixel_trace.ts's RVFCMetadata extension works around for
// VideoFrameCallbackMetadata.rtpTimestamp), so declared by hand here rather
// than pulled from an `any`.
interface EncodedVideoFrameLike {
  readonly type?: string;
  readonly timestamp: number;
  readonly data: ArrayBuffer;
}

// RTCRtpReceiver.createEncodedStreams isn't in TS's bundled RTCRtpReceiver
// type yet either.
interface EncodedStreamsReceiver {
  createEncodedStreams?: () => {
    readable: ReadableStream<EncodedVideoFrameLike>;
    writable: WritableStream<EncodedVideoFrameLike>;
  };
}

export function supportsEncodedStreamCheck(receiver: RTCRtpReceiver): boolean {
  return typeof (receiver as EncodedStreamsReceiver).createEncodedStreams === "function";
}

// FLUSH_INTERVAL_MS batches reports at human-readable-log rate rather than
// sending one DataChannel message per encoded frame (~30/s) - matches this
// diagnostic's own backend-side periodic-log cadence in spirit, not a protocol requirement.
const FLUSH_INTERVAL_MS = 1000;
// MAX_BATCH_SIZE bounds memory between flushes - a genuinely stalled flush
// (e.g. DataChannel briefly backed up) drops the oldest-uncollected excess
// rather than growing the buffer unboundedly; losing a few samples from a
// bounded diagnostic channel is harmless, unlike losing real video frames.
const MAX_BATCH_SIZE = 200;

// EncodedStreamChecker runs one createEncodedStreams() passthrough
// transform against one RTCRtpReceiver for its whole lifetime. Construct
// fresh per receiver (a new one arrives on every reconnect's "ontrack") -
// createEncodedStreams() can only be called once per receiver and throws on
// a second call, so this class makes no attempt to be reusable across
// receivers.
export class EncodedStreamChecker {
  private readonly receiver: RTCRtpReceiver;
  private readonly onFlush: (reports: EncodedFrameReport[]) => void;

  private buffer: EncodedFrameReport[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(receiver: RTCRtpReceiver, onFlush: (reports: EncodedFrameReport[]) => void) {
    this.receiver = receiver;
    this.onFlush = onFlush;
  }

  start(): void {
    if (this.running || !supportsEncodedStreamCheck(this.receiver)) return;

    const createEncodedStreams = (this.receiver as EncodedStreamsReceiver).createEncodedStreams;
    if (!createEncodedStreams) return;

    let readable: ReadableStream<EncodedVideoFrameLike>;
    let writable: WritableStream<EncodedVideoFrameLike>;
    try {
      ({ readable, writable } = createEncodedStreams.call(this.receiver));
    } catch {
      // Already claimed by something else on this receiver, or the browser
      // rejects it for another reason - fail closed, no retry. This
      // diagnostic simply doesn't run for this session.
      return;
    }

    this.running = true;
    const transform = new TransformStream<EncodedVideoFrameLike, EncodedVideoFrameLike>({
      transform: (frame, controller) => {
        this.onEncodedFrame(frame);
        // MUST re-enqueue unchanged - this transform sits inline in the
        // real decode path (see this file's own header comment). Skipping
        // this would stall the video.
        controller.enqueue(frame);
      },
    });
    readable
      .pipeThrough(transform)
      .pipeTo(writable)
      .catch(() => {
        // Stream errored or closed (e.g. connection torn down mid-session)
        // - nothing to clean up beyond what stop() already handles.
      });

    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
  }

  stop(): void {
    this.running = false;
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.buffer = [];
  }

  private onEncodedFrame(frame: EncodedVideoFrameLike): void {
    if (!this.running || this.buffer.length >= MAX_BATCH_SIZE) return;
    const data = new Uint8Array(frame.data);
    this.buffer.push({
      rtpTimestamp: frame.timestamp,
      type: frame.type ?? "unknown",
      size: data.byteLength,
      hash: fnv1a32(data),
    });
  }

  private flush(): void {
    if (this.buffer.length === 0) return;
    const reports = this.buffer;
    this.buffer = [];
    this.onFlush(reports);
  }
}
