// Shared public types for the Glass client SDK. Imported (as types) by both
// the core and the viewer entry points.

// Returned by createGlassSession / the backend's POST /v1/sessions.
export interface GlassSession {
  id: string;
  signalingUrl: string;
}

// Element/cursor state pushed from the backend (protocol 0x05).
export interface ElementState {
  cursor: string;
  // Whether the remote page's focused element is text-editable - drives the
  // mobile on-screen keyboard in the viewer.
  editableFocused?: boolean;
}

// Navigation/URL-bar state pushed from the backend (protocol 0x06).
export interface NavigationState {
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

// One finger's contact point for a touch event, in intrinsic video-space
// coordinates (see clientToVideoPoint in the viewer).
export interface TouchPoint {
  x: number;
  y: number;
  id: number;
}

export type TouchDispatchType =
  | "touchstart"
  | "touchmove"
  | "touchend"
  | "touchcancel";

// A key event to forward to the remote page.
export interface KeyEvent {
  type: string; // "keydown" | "keyup"
  key: string;
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

// A point-in-time transport/quality snapshot from getStats() / the "stats"
// event. All fields are best-effort; a value is null when the underlying
// WebRTC stat isn't available yet.
export interface GlassStats {
  rttMs: number | null;
  throughputKbps: number | null;
  availableOutgoingBitrateKbps: number | null;
  jitterBufferMs: number | null;
  framesDecoded: number | null;
  framesDropped: number | null;
  dataChannelBufferedAmount: number | null;
}
