// Touch-input controller for the viewer (raw-touch passthrough).
//
// Forwards real touch points to the backend, which enables Chrome touch
// emulation so Chrome's own compositor does the gesture recognition - scroll,
// pan, tap->click, pinch-zoom - exactly as on a real phone. We do NOT translate
// gestures into synthesized mouse/scroll here (that would kill momentum scroll,
// pinch-zoom, and touch-native site behavior). The only intent inferred locally
// is "was that a tap?", used solely to drive the mobile keyboard.

import type { TouchDispatchType, TouchPoint } from "../types.js";

// Maps a viewport (clientX/clientY) coordinate to intrinsic video-space,
// accounting for object-fit: contain letterboxing. Shared by the mouse path
// (see index.ts) and the touch path so the two can't drift. Returns null when
// the video has no decoded frame yet (intrinsic size 0).
export function clientToVideoPoint(
  clientX: number,
  clientY: number,
  containerRect: DOMRect,
  videoWidth: number,
  videoHeight: number
): { x: number; y: number } | null {
  if (videoWidth === 0 || videoHeight === 0) return null;
  const scaleX = videoWidth / containerRect.width;
  const scaleY = videoHeight / containerRect.height;
  const x = Math.max(
    0,
    Math.min((clientX - containerRect.left) * scaleX, videoWidth)
  );
  const y = Math.max(
    0,
    Math.min((clientY - containerRect.top) * scaleY, videoHeight)
  );
  return { x, y };
}

export interface TouchInputGeometry {
  getContainerRect: () => DOMRect | null;
  getVideoSize: () => { width: number; height: number } | null;
}

export interface TouchInputCallbacks {
  // Raw passthrough. Per CDP's contract, touchend/touchcancel carry zero
  // points - the controller enforces that so callers don't have to.
  // gestureId is a monotonically increasing, per-controller-instance
  // counter, unique per gesture (never reused, unlike the browser's own
  // Touch.identifier - see gestureSeq) - present on every call so the
  // backend can gate touchmove against whichever gesture is actually
  // active right now. Needed because touchmove travels over a separate,
  // unordered/unreliable DataChannel from touchstart/touchend (see
  // index.ts's sendInputFast) - without this, a stale touchmove delayed
  // behind network loss could arrive after the *next* gesture's touchstart
  // and, since real touch IDs are commonly reused across gestures, get
  // silently applied as if it belonged to the new one.
  // moveCount is set only on "touchend" - the number of touchmove events
  // this controller actually sent during the gesture that just ended (see
  // moveSendCount). Diagnostic-only: lets the backend log its own received
  // count alongside the client's sent count on the same line, to check for
  // DataChannel-level loss on a fast gesture without needing phone devtools
  // access. See project notes on the YouTube-Shorts-scroll investigation.
  onTouchPoints: (
    type: TouchDispatchType,
    points: TouchPoint[],
    gestureId: number,
    moveCount?: number
  ) => void;
  // Fired once per qualifying tap (short, low-movement). Arms the keyboard.
  // point is the tap's location in the same video-space coordinates
  // toPoints() uses (via clientToVideoPoint) - null when unavailable (e.g.
  // the video has no decoded frame yet), which the keyboard controller
  // treats as "unknown," not "confidently elsewhere."
  onTap?: (point: { x: number; y: number } | null) => void;
}

const TAP_MAX_DURATION_MS = 300;
const TAP_MAX_MOVEMENT_PX = 10;
// A tap's displacement/duration alone can't see post-release momentum: a
// fast, short flick that barely moves before release but keeps scrolling
// afterward via the remote page's own momentum still qualifies as "a tap" by
// those two checks alone. This vetoes that case using the velocity of the
// last touchmove sample right before release.
const TAP_MAX_RELEASE_VELOCITY_PX_MS = 0.5; // ~500 px/s - a starting point,
// not validated on real devices yet, like every other new tunable in this
// project; needs real-phone tuning against genuine tap release jitter vs. an
// actual flick's release speed.
const TAP_VELOCITY_SAMPLE_MAX_AGE_MS = 100; // a touchmove sample older than
// this relative to touchend is too stale to trust (e.g. main-thread
// contention during video decode delaying delivery) - falls back to the
// existing displacement/duration-only check rather than vetoing on stale data.

export class TouchInputController {
  private touchStart: { clientX: number; clientY: number; time: number } | null =
    null;
  // The most recent touchmove sample, used to compute release velocity for
  // the flick veto in handleTouchEnd - see TAP_MAX_RELEASE_VELOCITY_PX_MS.
  private lastMove: { clientX: number; clientY: number; time: number } | null =
    null;
  // Whether the backend actually received a touchstart for the gesture in
  // progress. Guards against emitting move/end/cancel for a gesture we chose
  // to drop (see handleTouchStart) - CDP's touch state machine rejects every
  // one of those, one log line each.
  private gestureActive = false;
  // Diagnostic-only: counts touchmove sends for the gesture in progress, so
  // touchend can report it - see TouchInputCallbacks.onTouchPoints.
  private moveSendCount = 0;
  // Monotonically increasing gesture counter - see onTouchPoints's
  // gestureId doc comment. Starts at 0; the first real gesture is 1 (the
  // backend treats 0 as "no active gesture" and needs no separate init to
  // match). Incremented even for
  // a gesture whose touchstart carries zero points and gets dropped below:
  // harmless (just skips an ID), and keeps this simple.
  private gestureSeq = 0;

  constructor(
    private geometry: TouchInputGeometry,
    private callbacks: TouchInputCallbacks
  ) {}

  private toPoints(touches: TouchList): TouchPoint[] {
    const rect = this.geometry.getContainerRect();
    const size = this.geometry.getVideoSize();
    if (!rect || !size) return [];
    const points: TouchPoint[] = [];
    for (let i = 0; i < touches.length; i++) {
      const t = touches[i]!;
      const coords = clientToVideoPoint(
        t.clientX,
        t.clientY,
        rect,
        size.width,
        size.height
      );
      if (coords) points.push({ x: coords.x, y: coords.y, id: t.identifier });
    }
    return points;
  }

  private handleTouchStart = (e: TouchEvent): void => {
    // Stops native scroll/pinch/pull-to-refresh on the local page, and
    // suppresses the synthetic mouse events browsers emit after touch so the
    // mouse handlers don't double-fire on a touch device.
    e.preventDefault();
    this.gestureSeq++;
    // Recorded before the drop check below, so local tap detection (which only
    // arms the mobile keyboard) still works for a gesture the backend never
    // sees - e.g. a tap that lands before the first frame paints.
    const first = e.changedTouches[0];
    this.touchStart = first
      ? { clientX: first.clientX, clientY: first.clientY, time: Date.now() }
      : null;
    this.lastMove = null;

    const points = this.toPoints(e.changedTouches);
    // A touchstart carrying zero points is worse than no touchstart at all:
    // CDP accepts it without error and starts no touch, after which EVERY
    // touchmove/touchend in the gesture fails with "Must send a TouchStart
    // first to start a new touch" - and because successful dispatches are
    // silent, the backend log shows only the downstream failures with no
    // trace of the cause. Found on a real phone, where touch was completely
    // dead and the logs pointed at the wrong event.
    //
    // toPoints() returns empty when the video has no decoded frame yet (see
    // clientToVideoPoint), i.e. when a touch lands before the first frame
    // paints. Dropping the whole gesture is correct there: there is nothing
    // on screen yet to have meaningfully touched.
    if (points.length === 0) {
      this.gestureActive = false;
      return;
    }
    this.gestureActive = true;
    this.moveSendCount = 0;
    this.callbacks.onTouchPoints("touchstart", points, this.gestureSeq);
  };

  private handleTouchMove = (e: TouchEvent): void => {
    e.preventDefault();
    // Recorded before the gestureActive guard below, same reasoning as
    // touchStart: local tap/flick classification must still work for a
    // gesture the backend never saw.
    const move = e.changedTouches[0];
    if (move) {
      this.lastMove = {
        clientX: move.clientX,
        clientY: move.clientY,
        time: Date.now(),
      };
    }
    // Never send a move for a gesture whose touchstart never made it out -
    // CDP has no touch to move and would reject every one of them.
    if (!this.gestureActive) return;
    const points = this.toPoints(e.changedTouches);
    if (points.length === 0) return;
    this.moveSendCount++;
    this.callbacks.onTouchPoints("touchmove", points, this.gestureSeq);
  };

  private handleTouchEnd = (e: TouchEvent): void => {
    e.preventDefault();
    const wasActive = this.gestureActive;
    this.gestureActive = false;
    const start = this.touchStart;
    this.touchStart = null;
    const lastMove = this.lastMove;
    this.lastMove = null;

    // Tap detection runs even for a gesture we dropped: it's purely local and
    // only arms the mobile keyboard, so a tap before the first frame paints
    // should still raise the keyboard.
    if (start) {
      const last = e.changedTouches[0];
      const endTime = Date.now();
      const elapsed = endTime - start.time;
      const moved = last
        ? Math.hypot(last.clientX - start.clientX, last.clientY - start.clientY)
        : Infinity;
      // Additive veto: can only turn a previously-classified tap into a
      // non-tap, never the reverse, so no existing successful-tap case
      // regresses. Skipped (falls back to displacement/duration-only) when
      // there's no lastMove sample, or it's too stale to trust.
      let releaseVelocityOk = true;
      if (last && lastMove && endTime - lastMove.time <= TAP_VELOCITY_SAMPLE_MAX_AGE_MS) {
        const dist = Math.hypot(last.clientX - lastMove.clientX, last.clientY - lastMove.clientY);
        const dt = Math.max(endTime - lastMove.time, 1);
        const releaseVelocity = dist / dt;
        releaseVelocityOk = releaseVelocity <= TAP_MAX_RELEASE_VELOCITY_PX_MS;
      }
      if (
        elapsed <= TAP_MAX_DURATION_MS &&
        moved <= TAP_MAX_MOVEMENT_PX &&
        releaseVelocityOk
      ) {
        // Reuses the same clientToVideoPoint() call toPoints() makes
        // elsewhere in this file - null when geometry isn't ready (e.g. no
        // decoded frame yet), same as toPoints()'s own empty-result case.
        const rect = this.geometry.getContainerRect();
        const size = this.geometry.getVideoSize();
        const point =
          last && rect && size
            ? clientToVideoPoint(last.clientX, last.clientY, rect, size.width, size.height)
            : null;
        this.callbacks.onTap?.(point);
      }
    }

    // The backend, however, must never see an end for a touch it never saw
    // start - that's the CDP rejection this whole guard exists to prevent.
    if (wasActive)
      this.callbacks.onTouchPoints(
        "touchend",
        [],
        this.gestureSeq,
        this.moveSendCount
      );
  };

  private handleTouchCancel = (e: TouchEvent): void => {
    e.preventDefault();
    this.touchStart = null;
    this.lastMove = null;
    if (!this.gestureActive) return;
    this.gestureActive = false;
    this.callbacks.onTouchPoints("touchcancel", [], this.gestureSeq);
  };

  // Binds listeners with { passive: false } (required for preventDefault to
  // take effect). Returns a detach function.
  attach(el: HTMLElement): () => void {
    const opts = { passive: false } as AddEventListenerOptions;
    el.addEventListener("touchstart", this.handleTouchStart, opts);
    el.addEventListener("touchmove", this.handleTouchMove, opts);
    el.addEventListener("touchend", this.handleTouchEnd, opts);
    el.addEventListener("touchcancel", this.handleTouchCancel, opts);
    return () => {
      el.removeEventListener("touchstart", this.handleTouchStart);
      el.removeEventListener("touchmove", this.handleTouchMove);
      el.removeEventListener("touchend", this.handleTouchEnd);
      el.removeEventListener("touchcancel", this.handleTouchCancel);
    };
  }
}
