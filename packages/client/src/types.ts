// Shared public types for the Glass client SDK. Imported (as types) by both
// the core and the viewer entry points.

// Which physical mouse button a mousedown/mouseup wire message refers to -
// see docs/protocol.md's mousedown/mouseup rows. Defaults to "left" server-
// side when omitted, for older clients predating this field.
export type MouseButton = "left" | "right" | "middle";

// What a session's source can do, advertised by POST /v1/sessions so a client
// knows before negotiating rather than discovering it from the SDP offer's
// shape or a runtime error. Derived server-side from the source's real
// capability interfaces.
//
// Every field is optional: a runtime older than protocol 1 sends none of this,
// and new keys may be added without a version bump, so treat an absent value
// as "unknown", not as "false".
export interface GlassCapabilities {
  video?: boolean;
  navigation?: boolean;
  viewport?: boolean;
  clipboard?: boolean;
  pauseResume?: boolean;
  mobileEmulation?: boolean;
  // The exact input action strings this source accepts - the backend publishes
  // its dispatcher's own vocabulary, so this cannot disagree with what the
  // runtime will really handle.
  inputActions?: string[];
  // Additive keys from a newer runtime land here rather than being dropped.
  [key: string]: unknown;
}

// What ONE connection to a session is declared to do - a distinct concept
// from GlassCapabilities above (what the SOURCE can do overall). Mirrors
// the engine's connection capabilities exactly (see docs/concepts.md,
// "Connections and capabilities"): producesMedia/consumesMedia/
// producesInput/consumesInput, each independent (a connection can be both
// a media consumer and an input producer at once).
export interface GlassConnectionCapabilities {
  producesMedia: boolean;
  consumesMedia: boolean;
  producesInput: boolean;
  // RESERVED: no endpoint control direction exists yet, so the backend refuses to
  // mint a grant with consumesInput: true (HTTP 400) instead of accepting and
  // ignoring it. Always false on a connection today.
  consumesInput: boolean;
}

// Returned by mintConnectionGrant / the backend's POST
// /v1/sessions/{id}/connections - a fresh, capability-scoped signalingUrl
// for an additional connection to an existing session (e.g. a watch-only
// link). produceUrl is present only for a relay session's grant, never for a browser
// session's.
export interface GlassConnectionGrant {
  signalingUrl: string;
  connectionCapabilities: GlassConnectionCapabilities;
  produceUrl?: string;
}

// One other connection in the session owner's roster - see
// docs/protocol.md's Control handoff section (connection_joined/
// connection_left/roster) and GlassClient.connections(). Owner-only: a
// non-owner connection never receives roster traffic at all, since it has
// no grantInput()/revokeInput() authority to act on it (see
// GlassClient.isOwner()).
export interface GlassRosterEntry {
  connectionId: string;
  producesInput: boolean;
  isOwner: boolean;
}

// A relay slot's state, from the slot_state signaling message
// (docs/protocol.md): "stalled" means its producer dropped or stopped sending
// media and may come back; "empty" means no producer.
export type GlassSlotState = "empty" | "live" | "stalled";

// Returned by createGlassSession / the backend's POST /v1/sessions.
export interface GlassSession {
  id: string;
  signalingUrl: string;
  // Major version of the public wire contract. Absent from runtimes predating
  // the handshake, which are treated as version 1. See createGlassSession.
  protocolVersion?: number;
  // Stable identifier for the kind of source backing this session ("browser",
  // and someday "camera"/"joystick"); "unknown" if the source doesn't say.
  sourceType?: string;
  capabilities?: GlassCapabilities;
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

// One text-editable candidate's bounding box, pushed from the backend
// (protocol 0x0A, mobile-only). In the same viewport-relative CSS px space
// clientToVideoPoint() produces client-side (see mobileKeyboard.ts's
// three-case handleTap for how this is used) - no coordinate transform
// needed. A full list is a full-snapshot-replace, not an incremental diff.
export interface InteractiveElement {
  x: number;
  y: number;
  width: number;
  height: number;
}

// One entry in a Sec-CH-UA brand list (e.g. {brand: "Chromium", version: "124"}).
export interface UserAgentBrand {
  brand: string;
  version: string;
}

// UA Client Hints - the low-entropy fields navigator.userAgentData exposes
// synchronously on browsers that support it (Chromium-based mobile browsers).
// Sent alongside the legacy user-agent string so a site that branches on
// navigator.userAgentData.mobile (rather than parsing the UA string) also
// sees the emulated device correctly. Omitted entirely on browsers without
// userAgentData - notably iOS Safari, which never implemented UA-CH, so a
// real iPhone sends no Sec-CH-UA headers either; leaving this undefined for
// one is the correct emulation, not a missing feature.
export interface UserAgentClientHints {
  brands: UserAgentBrand[];
  mobile: boolean;
  platform: string;
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
