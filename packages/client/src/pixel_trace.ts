// @internal Sampled per-interaction capture-to-paint latency trace -
// promotes a manual, one-off cross-validation technique into a permanent (still
// internal-only, see index.ts's traceReportIntervalMs doc comment)
// diagnostic. Closes the loop @glass/client's aggregate stats reporting
// (collectAndSendTraceReport) can't: "when did THIS specific frame,
// following THIS specific dispatched input, actually get painted."
//
// Deliberately NOT built on Insertable Streams / RTCRtpScriptTransform -
// requestVideoFrameCallback's own VideoFrameCallbackMetadata already
// exposes an `rtpTimestamp` field for a <video> element whose srcObject is
// a WebRTC MediaStream (a real, standard field added specifically for this
// class of latency measurement, not a guess - see
// https://w3c.github.io/media-latency-hints and the rVFC spec's WebRTC
// extensions). Reading it needs no encoded-frame interception, so there's
// no risk of this diagnostic ever altering/dropping/delaying the actual
// decode pipeline - a real correctness concern an Insertable Streams
// passthrough transform would have carried, avoided entirely by not
// needing that mechanism.
//
// Chrome-primary today (rVFC itself lacks Firefox support; the
// WebRTC-source `rtpTimestamp` metadata field is a further, separate
// Chrome-specific addition on top of rVFC) - supportsPixelTrace() feature-
// detects both and this module simply never samples anything on a browser
// where either is missing.

export interface PixelTraceSample {
  rtpTimestamp: number;
  paintedAtMs: number;
}

// TS's bundled lib.dom.d.ts already types HTMLVideoElement.
// requestVideoFrameCallback/VideoFrameCallbackMetadata (both real, stable
// DOM APIs) - just missing the `rtpTimestamp` field, a further, newer
// WebRTC-source-specific extension to VideoFrameCallbackMetadata not yet
// in TS's bundled types. Extending rather than redefining keeps this
// aligned with the real DOM types instead of a hand-rolled, potentially
// drifting shadow of them.
type RVFCMetadata = VideoFrameCallbackMetadata & { rtpTimestamp?: number };

// supportsPixelTrace checks for requestVideoFrameCallback's existence only
// - the deeper check (whether metadata.rtpTimestamp is actually populated
// for this specific stream) can only happen at the first real callback,
// since that's a per-connection runtime fact, not a static browser
// capability. PixelTraceSampler.start handles that second check itself and
// simply stops sampling (no error, no throw) if the field never shows up.
export function supportsPixelTrace(videoEl: HTMLVideoElement): boolean {
  return typeof videoEl.requestVideoFrameCallback === "function";
}

// MAX_BUFFER_AGE_MS bounds the local sample buffer by real wall-clock age,
// not a fixed count - pruned opportunistically on every frame (see
// onFrame). Generous relative to the default interaction window (500ms)
// so a slightly-late flush still finds its samples, but still bounded -
// matches the engine's own RTP-timestamp ring budget in spirit: dataless,
// session-scoped, not a growing log.
const MAX_BUFFER_AGE_MS = 2000;

interface BufferedSample extends PixelTraceSample {
  localObservedAtMs: number;
}

// PixelTraceSampler runs an ongoing requestVideoFrameCallback loop against
// one <video> element, keeping a small bounded ring of recent
// {rtpTimestamp, paintedAtMs} pairs. Call noteInteraction() right after
// dispatching a real discrete input (mousedown/mouseup/keydown/keyup/
// touchstart/touchend - NOT mousemove/scroll/touchmove, mirroring the
// backend's own inputFrameFIFO doc comment on why continuous, already-
// coalesced input isn't what this exists to trace) - after windowMs, it
// flushes whatever real samples the ring accumulated during that window as
// one batched report, via the onSample callback supplied at construction
// (wired to GlassClient.sendInput("pixel_trace_sample", ...) by the
// viewer - see mountGlassViewer).
export class PixelTraceSampler {
  private readonly video: HTMLVideoElement;
  private readonly onFlush: (samples: PixelTraceSample[]) => void;
  private readonly windowMs: number;

  private buffer: BufferedSample[] = [];
  private rvfcHandle: number | null = null;
  private running = false;
  // Set false the first time a real callback fires with no rtpTimestamp in
  // its metadata - this browser/stream combination doesn't support the
  // field this whole module depends on, so further sampling would be pure
  // overhead for zero benefit.
  private metadataSupported = true;
  private pendingFlushTimer: ReturnType<typeof setTimeout> | null = null;
  // Set by noteInteraction, consumed (and reset) by flush - see
  // noteInteraction's own doc comment.
  private windowStartMs: number | null = null;

  constructor(
    video: HTMLVideoElement,
    onFlush: (samples: PixelTraceSample[]) => void,
    windowMs = 500
  ) {
    this.video = video;
    this.onFlush = onFlush;
    this.windowMs = windowMs;
  }

  start(): void {
    if (this.running || !supportsPixelTrace(this.video)) return;
    this.running = true;
    this.scheduleNextFrame();
  }

  stop(): void {
    this.running = false;
    if (this.rvfcHandle !== null) {
      this.video.cancelVideoFrameCallback(this.rvfcHandle);
      this.rvfcHandle = null;
    }
    if (this.pendingFlushTimer !== null) {
      clearTimeout(this.pendingFlushTimer);
      this.pendingFlushTimer = null;
    }
    this.buffer = [];
  }

  private scheduleNextFrame(): void {
    if (!this.running) return;
    this.rvfcHandle = this.video.requestVideoFrameCallback((_now, metadata) => {
      // Cleared before onFrame runs, not after: once the browser invokes
      // this callback, its handle is already spent (cancelling it would
      // be a harmless no-op, but stop() shouldn't need to know that - if
      // onFrame decides to stop() this stream, there's genuinely nothing
      // left to cancel).
      this.rvfcHandle = null;
      this.onFrame(metadata);
      this.scheduleNextFrame();
    });
  }

  private onFrame(metadata: RVFCMetadata): void {
    if (metadata.rtpTimestamp === undefined) {
      // First real callback with no rtpTimestamp: this browser/stream
      // doesn't expose it. Stop cleanly rather than spin an rVFC loop
      // forever for a feature that can never work here.
      if (this.metadataSupported) {
        this.metadataSupported = false;
        this.stop();
      }
      return;
    }
    // performance.timeOrigin + a performance.now()-domain timestamp
    // (presentationTime/rVFC's own `now` are both in that domain per spec)
    // gives a real epoch-ms wall-clock moment - no separate anchor scheme
    // needed on either side (see this file's own top-of-file doc comment).
    const paintedAtMs = performance.timeOrigin + metadata.presentationTime;
    const localObservedAtMs = Date.now();

    this.buffer.push({ rtpTimestamp: metadata.rtpTimestamp, paintedAtMs, localObservedAtMs });

    // Prune by real wall-clock age on every frame - bounded memory without
    // a fixed count (a slow/paused stream shouldn't hold onto ancient
    // samples just because few new ones arrived to push them out).
    const cutoff = localObservedAtMs - MAX_BUFFER_AGE_MS;
    while (this.buffer[0] !== undefined && this.buffer[0].localObservedAtMs < cutoff) {
      this.buffer.shift();
    }
  }

  // noteInteraction schedules ONE flush windowMs from now, reporting only
  // the real samples observed BETWEEN this call and that flush (via
  // windowStartMs, not "whatever happens to sit in the buffer") - so a
  // report genuinely reflects "what got painted after this specific
  // interaction," not an arbitrary trailing slice of history. Not a
  // per-frame report, so this stays at human-interaction rate by
  // construction, not 30-60fps. A second interaction inside an
  // already-pending window doesn't schedule a second flush (the first
  // flush's window already covers it) - avoids redundant reports for a
  // rapid burst of clicks, and keeps windowStartMs anchored to the FIRST
  // interaction in the burst, which is the one whose latency actually
  // matters.
  noteInteraction(): void {
    if (!this.running || !this.metadataSupported) return;
    if (this.pendingFlushTimer !== null) return;
    this.windowStartMs = Date.now();
    this.pendingFlushTimer = setTimeout(() => {
      this.pendingFlushTimer = null;
      this.flush();
    }, this.windowMs);
  }

  private flush(): void {
    const since = this.windowStartMs;
    this.windowStartMs = null;
    if (since === null) return;
    const samples = this.buffer
      .filter((s) => s.localObservedAtMs >= since)
      .map((s): PixelTraceSample => ({ rtpTimestamp: s.rtpTimestamp, paintedAtMs: s.paintedAtMs }));
    if (samples.length === 0) return;
    this.onFlush(samples);
  }
}
