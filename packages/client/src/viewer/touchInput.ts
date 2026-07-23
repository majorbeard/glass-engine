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
  onTouchPoints: (type: TouchDispatchType, points: TouchPoint[]) => void;
  // Fired once per qualifying tap (short, low-movement). Arms the keyboard.
  onTap?: () => void;
}

const TAP_MAX_DURATION_MS = 300;
const TAP_MAX_MOVEMENT_PX = 10;

export class TouchInputController {
  private touchStart: { clientX: number; clientY: number; time: number } | null =
    null;

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
    const first = e.changedTouches[0];
    if (first) {
      this.touchStart = {
        clientX: first.clientX,
        clientY: first.clientY,
        time: Date.now(),
      };
    }
    this.callbacks.onTouchPoints("touchstart", this.toPoints(e.changedTouches));
  };

  private handleTouchMove = (e: TouchEvent): void => {
    e.preventDefault();
    this.callbacks.onTouchPoints("touchmove", this.toPoints(e.changedTouches));
  };

  private handleTouchEnd = (e: TouchEvent): void => {
    e.preventDefault();
    const start = this.touchStart;
    this.touchStart = null;
    if (start) {
      const last = e.changedTouches[0];
      const elapsed = Date.now() - start.time;
      const moved = last
        ? Math.hypot(last.clientX - start.clientX, last.clientY - start.clientY)
        : Infinity;
      if (elapsed <= TAP_MAX_DURATION_MS && moved <= TAP_MAX_MOVEMENT_PX) {
        this.callbacks.onTap?.();
      }
    }
    this.callbacks.onTouchPoints("touchend", []);
  };

  private handleTouchCancel = (e: TouchEvent): void => {
    e.preventDefault();
    this.touchStart = null;
    this.callbacks.onTouchPoints("touchcancel", []);
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
