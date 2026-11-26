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
  // Whether the source can be inspected (the page routes); a session allows
  // it only when created with inspect: true.
  inspect?: boolean;
  // The exact input action strings this source accepts - the backend publishes
  // its dispatcher's own vocabulary, so this cannot disagree with what the
  // runtime will really handle.
  inputActions?: string[];
  // Additive keys from a newer runtime land here rather than being dropped.
  [key: string]: unknown;
}

// What a link may do, by kind of source (protocol v3, docs/protocol.md,
// "Links"): watch which kinds, publish which, control which ("all", "none" for
// watch, or a list of kinds), and whether it is the session's own link.
export interface GlassRights {
  watch: "all" | "none" | GlassSourceKind[];
  publish: "all" | GlassSourceKind[];
  control: "all" | GlassSourceKind[];
  owner: boolean;
}

// A session's kinds of source: a hosted browser and a recording's playback,
// which the engine runs, and what a member publishes.
export type GlassSourceKind = "browser" | "playback" | "camera" | "microphone" | "screen" | "device" | (string & {});

// Where a source stands: "live"; "stalled", live but sending nothing for now
// (its publisher dropped or went quiet, and may come back); "ended".
export type GlassSourceState = "live" | "stalled" | "ended";

// One source of a session, as the engine describes it everywhere: the
// session's creation answer, GET /v1/sessions/{id}, and the hello,
// source_added and source_updated messages.
export interface GlassSourceInfo {
  id: string;
  kind: GlassSourceKind;
  state: GlassSourceState;
  // Why it ended, or why it is stalled, when the engine says.
  reason?: string;
  capabilities: GlassCapabilities;
  codec?: GlassVideoCodec;
  contentHint?: GlassContentHint;
  inputMode: GlassInputMode;
  inspect: boolean;
}

// A link to a session: what to share, or connect with. url is the member
// connection's, carrying the link's own token. id names it for revoking.
// expiresAt is when it stops admitting new connections (RFC 3339), absent
// when it never does.
export interface GlassLink {
  id: string;
  url: string;
  rights: GlassRights;
  expiresAt?: string;
}

// What mintGlassLink asks for: the rights by kind, and optionally the link's
// lifetime in seconds (0 for never; absent, the engine's default).
export interface GlassLinkRequest {
  watch?: "all" | GlassSourceKind[];
  publish?: "all" | GlassSourceKind[];
  control?: "all" | GlassSourceKind[];
  expiresIn?: number;
}

// Another member of the session, as its owner sees it: the connection, and
// what its link may do.
export interface GlassMember {
  connectionId: string;
  owner: boolean;
  rights: GlassRights;
}

/**
 * Glass's one answer to a control request on a source: requestInput(),
 * releaseInput(), grantInput(), revokeInput(), grantWatch() or denyWatch().
 * `outcome` is the state the request leaves: asking for what this connection
 * already holds is "granted", not refused. "relayed" means nobody could be
 * given control now, so the request went to whoever holds it (their
 * "inputRequested" event). `reason` says why a refusal: Glass's own
 * (`not_allowed`: this link never included control of that kind; `not_owner`;
 * `no_capacity`; `unknown_connection`; `unknown_source`; `rate_limited`;
 * `invalid`) or this client's (`not_connected`, `disconnected`: the
 * connection went before Glass answered).
 */
export interface GlassControlAnswer {
  action: "request_input" | "release_input" | "grant_input" | "revoke_input" | "grant_watch" | "deny_watch";
  outcome: "granted" | "relayed" | "released" | "revoked" | "refused";
  reason?:
    | "not_allowed"
    | "not_owner"
    | "no_capacity"
    | "unknown_connection"
    | "unknown_source"
    | "rate_limited"
    | "invalid"
    | "not_connected"
    | "disconnected"
    | (string & {});
  /** The source the request was about. */
  source: string;
  /** The connection a grant or revoke was about. */
  connectionId?: string;
}

// This connection's quality as Glass measures it from the video it sends (docs/protocol.md, connection_quality):
// "excellent" and "good" need nothing shown; "poor" is a weak link (a smaller picture, the odd freeze); "lost" is no
// media arriving at all. score runs from 0 to 100.
export type GlassConnectionQualityLevel = "excellent" | "good" | "poor" | "lost";
export interface GlassConnectionQuality {
  quality: GlassConnectionQualityLevel;
  score: number;
}

// Why an input event was dropped (docs/protocol.md, InputDropped).
export type GlassInputDropCode =
  | "rate_limited"
  | "not_authorized"
  | "owner_only"
  | "unsupported"
  | "invalid"
  // Another connection has the page (input mode "floor"), or sets its size.
  | "floor_taken";

// One "inputDropped" report. local is true when this client withheld the
// input itself (it has no control, or isn't the owner) and false when Glass
// reported the drop. count is the drops since the previous report for the
// same code and event type. eventType is empty when Glass doesn't know the
// type. seq is the first dropped event's sequence number, when Glass sent it.
export interface GlassInputDrop {
  code: GlassInputDropCode | (string & {});
  eventType: string;
  count: number;
  local: boolean;
  // The source the dropped input was for.
  source: string;
  seq?: number;
}

// What a session should protect when the bitrate cannot carry the picture.
// "detail" keeps the picture's size and lowers the frame rate: text,
// interfaces, anything read. "motion" keeps the frame rate and lowers the
// size: video, games, anything watched. The names are the web standard's
// (the MediaStreamTrack content hint).
export type GlassContentHint = "detail" | "motion";

// The video codec a session is encoded with. Which ones a runtime can
// serve, and its default, are in GET /v1/info's "codecs".
// AV1 has the sharpest picture at low bitrates and costs the most CPU to
// encode; not every viewer can decode it (Safari only with AV1 hardware).
export type GlassVideoCodec = "h264" | "vp8" | "av1";

// How several connections holding input share one browser session's page.
// "floor" (the default): one controller at a time. Whoever sends input first
// has the page until they have been idle (100 ms after the pointer or touch,
// 1 s after a key or the wheel) and hold nothing down; everyone else's input
// is dropped meanwhile ("inputDropped" with code "floor_taken"), and every
// connection is told who has it ("floorChanged").
// "free": everyone's input goes to the page at once. ABSOLUTE CHAOS with more
// than one active person: the one pointer jumps between users, one user's
// drag is moved by another's pointer, and keys land in whichever field was
// focused last. Use it only where that is acceptable.
export type GlassInputMode = "floor" | "free";

// The page's JavaScript dialog (alert, confirm, prompt, or a leave-page
// question). The page's own scripts wait until it is answered.
// inPicture is true when the dialog is drawn in the streamed picture (the
// browser's own dialog, which ordinary input can also answer); when false
// the viewer sees only the page, and the app has to show the dialog itself
// to let anyone answer it. message is the page's own text.
export interface GlassDialog {
  open: boolean;
  type?: "alert" | "confirm" | "prompt" | "beforeunload" | (string & {});
  message?: string;
  defaultPrompt?: string;
  inPicture: boolean;
}

// Where a playback session stands: playing or paused, the position and the
// recording's length in milliseconds, and whether it reached the end.
export interface GlassPlaybackState {
  playing: boolean;
  positionMs: number;
  durationMs: number;
  ended: boolean;
}

// One event of a recording's timeline, as a playback session passes it:
// t is its time in milliseconds, type its kind ("navigation", "input",
// "join", ...). It holds IDs, origins, kinds and numbers only.
export interface GlassTimelineEvent {
  t: number;
  type: string;
  [field: string]: unknown;
}

// Where an engine is, and the credential its API takes, for the session
// helpers. baseUrl defaults to the page's own origin. apiToken is
// GLASS_API_TOKEN, for local testing and TypeScript backends: a token in a
// browser bundle is public.
export interface GlassEngine {
  baseUrl?: string;
  apiToken?: string;
}

// One engine-run source a session is created with (docs/protocol.md,
// "POST /v1/sessions request"). kind is "browser", the one engine-run kind a
// session takes. All the rest are optional.
export interface GlassSourceRequest {
  kind: "browser";
  // A page to open once the browser is up.
  url?: string;
  // Requests the microphone-capable browser pool, where the operator set
  // one up.
  audioInput?: boolean;
  // Absent, the engine's default.
  contentHint?: GlassContentHint;
  // Absent, the engine's default codec. A codec the engine cannot serve is
  // refused (the session is not made), never replaced by another.
  codec?: GlassVideoCodec;
  // Absent, "floor". See GlassInputMode.
  inputMode?: GlassInputMode;
  // Allows page inspection: the page's structure through the API's /page
  // routes, for your backend with the API token. Off by default.
  inspect?: boolean;
}

// Options for createGlassSession. With no sources the session's members
// publish: each joins on a link and publishes what its link allows.
export interface GlassCreateSessionOptions extends GlassEngine {
  sources?: GlassSourceRequest[];
  // The most members connected at once, its own link's included; a join past
  // it is refused. Absent, no limit.
  maxMembers?: number;
  // A session whose members publish: each camera or screen published as
  // layers (simulcast), so each viewer gets the one its link carries.
  simulcast?: boolean;
  // Starts recording at once (the engine needs GLASS_RECORDING_DIR).
  record?: boolean;
  // Seconds until the session's own link stops admitting new connections; 0
  // is never. Absent, the engine's default (24 hours unless the operator
  // changed it).
  linkExpiresIn?: number;
}

// Returned by createGlassSession, redeemGlassTicket and the engine's
// POST /v1/sessions: the session, its own link (the owner's), and its sources.
export interface GlassSession {
  id: string;
  // Major version of the public wire contract (3 for this client).
  protocolVersion: number;
  link: GlassLink;
  sources: GlassSourceInfo[];
  // Watch links to share, as many as the ticket asked for. Only from
  // redeemGlassTicket.
  watchLinks?: GlassLink[];
  maxMembers?: number;
  simulcast?: boolean;
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
