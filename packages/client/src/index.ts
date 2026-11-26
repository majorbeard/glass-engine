// @glass/client - DOM-free transport core.
//
// createGlassClient() owns the entire client-side transport loop against a
// Glass session: the signaling WebSocket handshake, the RTCPeerConnection and
// input DataChannel, low-latency receiver tuning, and - unlike the old example,
// where this lived in app.tsx - built-in reconnection with backoff to the SAME
// session. Subscribe with client.on(event, cb); send input with the typed
// methods. This module never touches the DOM (no document); the optional
// "@glass/client/viewer" entry provides the rendering + input-capture layer.
//
// Recovery is deliberately full-reconnect only, with no client-side ICE
// restart: the backend's signaling loop has no "offer" handler, so a
// renegotiation offer went unanswered and left the peer connection wedged in
// have-local-offer forever. See scheduleDisconnectedGrace.

import { Emitter } from "./emitter.js";
import { ClientCore, type Emit } from "./core";
import { authHeaders, errorDetail } from "./internal";
import * as lifecycle from "./lifecycle";
import * as transport from "./transport";
import * as handoff from "./handoff";
import * as mic from "./mic";
import * as navigation from "./navigation";
import * as statsTrace from "./stats_trace";
import { GlassSource } from "./source";
import * as publish from "./publish";
import { GlassPublication, type GlassPublishKind, type GlassPublishOptions } from "./publish";
import type {
  ElementState,
  GlassCapabilities,
  GlassControlAnswer,
  GlassInputDrop,
  GlassInputDropCode,
  GlassConnectionQuality,
  GlassConnectionQualityLevel,
  GlassContentHint,
  GlassCreateSessionOptions,
  GlassEngine,
  GlassLink,
  GlassLinkRequest,
  GlassMember,
  GlassRights,
  GlassSourceInfo,
  GlassSourceKind,
  GlassSourceRequest,
  GlassSourceState,
  GlassVideoCodec,
  GlassInputMode,
  GlassDialog,
  GlassPlaybackState,
  GlassTimelineEvent,
  GlassSession,
  GlassStats,
  InteractiveElement,
  KeyEvent,
  MouseButton,
  NavigationState,
  TouchDispatchType,
  TouchPoint,
  UserAgentClientHints,
} from "./types.js";

export { GlassSource, GlassPublication };
export type { GlassPublishKind, GlassPublishOptions };
export type { GlassPublicationEvents } from "./publish";
import type { InputLatencySample, InputLatencyStats } from "./input_latency";
export type { InputLatencySample, InputLatencyStats, InputLatencySummary } from "./input_latency";

export type {
  ElementState,
  GlassCapabilities,
  GlassControlAnswer,
  GlassInputDrop,
  GlassInputDropCode,
  GlassConnectionQuality,
  GlassConnectionQualityLevel,
  GlassContentHint,
  GlassCreateSessionOptions,
  GlassEngine,
  GlassLink,
  GlassLinkRequest,
  GlassMember,
  GlassRights,
  GlassSourceInfo,
  GlassSourceKind,
  GlassSourceRequest,
  GlassSourceState,
  GlassVideoCodec,
  GlassInputMode,
  GlassDialog,
  GlassPlaybackState,
  GlassTimelineEvent,
  GlassSession,
  GlassStats,
  InteractiveElement,
  KeyEvent,
  MouseButton,
  NavigationState,
  TouchDispatchType,
  TouchPoint,
  UserAgentClientHints,
};

export interface GlassReconnectOptions {
  // Max full-reconnect attempts before giving up (emitting "closed").
  maxAttempts?: number;
  // Backoff schedule: the wait after each failed attempt (a first retry
  // after a drop is immediate); the last value repeats beyond its length.
  delaysMs?: number[];
}

export interface GlassClientOptions {
  // The link to join with: the member connection's URL, carrying the link's
  // own token. Your backend mints it (createGlassSession's link, or
  // mintGlassLink) and hands each person theirs.
  link: string;
  // ICE servers for the RTCPeerConnection. Without them the engine's are
  // used: it hands every connection its STUN and TURN servers, with a
  // short-lived TURN credential of its own when the engine mints them. Give
  // them only to use servers of your own instead.
  iceServers?: RTCIceServer[];
  // Forces ICE to "relay" (TURN) only instead of the browser default "all",
  // so a successful connection proves the TURN server works rather than a
  // direct path having been used.
  iceTransportPolicy?: RTCIceTransportPolicy;
  // Reconnection behavior. true (default) uses defaults; false disables it;
  // an object customizes attempts/backoff.
  reconnect?: boolean | GlassReconnectOptions;
  // On a long, lossy path (a round trip over 200 ms with packets being
  // resent), let the browser hold video for about one round trip so a
  // resent packet arrives in time, instead of the picture freezing for a
  // round trip at every loss. It never engages on a short or loss-free
  // path, and costs that much delay while engaged. Default true; false
  // keeps the lowest delay whatever the path.
  repairWait?: boolean;
  // If > 0, emit a "stats" event this often (ms). Off by default; getStats()
  // is always available for one-shot snapshots regardless.
  statsIntervalMs?: number;
}


// A `type` (not `interface`) so it satisfies the Emitter's
// Record<string, unknown[]> constraint - interfaces don't get an implicit
// index signature.
export type GlassClientEventMap = {
  // hello arrived: who this connection is, and whether it is the owner's.
  // On a reconnect it says it again; a resumed connection keeps its id.
  hello: [connectionId: string, owner: boolean];
  // A source joined the session, or one this connection can watch was
  // announced; the hello's sources come this way too.
  sourceAdded: [source: GlassSourceInfo];
  // A source's description changed: its state (live, stalled), its
  // capabilities, its codec.
  sourceUpdated: [source: GlassSourceInfo];
  // A source left the session, with the engine's reason.
  sourceRemoved: [sourceId: string, reason: string];
  // A source's stream gained a track: bind client.source(id).stream() to a
  // <video> (it plays the picture and the sound alike).
  track: [sourceId: string, stream: MediaStream];
  // What this connection's link may do changed (the owner granted or denied
  // it a source). client.rights() already reflects it.
  rightsChanged: [rights: GlassClientRights];
  // Who holds a source's input track changed, and who has its floor (input
  // mode "floor"; null when no one has it). Fires for every source that
  // takes input as the connection joins, then on every change.
  inputHolders: [sourceId: string, holders: string[], floor: string | null];
  // Someone asked for a source's input track that this connection holds,
  // and there was no room to give them one: Glass relayed the ask here and
  // decides nothing. It is the application's to prompt, decline or ignore.
  inputRequested: [connectionId: string, sourceId: string];
  // The owner only: the session's other members changed (one joined or
  // left). members() already reflects it.
  membersChanged: [members: GlassMember[]];
  // Cursor and editable-focus state from a hosted browser's page.
  elementState: [state: ElementState, sourceId: string];
  // A hosted browser's URL-bar and navigation state.
  navigation: [nav: NavigationState, sourceId: string];
  // Text-editable candidates' boxes on a page, mobile only, the whole list
  // each time (see the viewer's mobile keyboard).
  interactiveElements: [elements: InteractiveElement[], sourceId: string];
  // A page's selected text, answering copyText(); possibly empty.
  clipboardText: [text: string, sourceId: string];
  // One console call (or uncaught exception, level "error") from a page's
  // own JavaScript; level is Chrome's own console method name.
  consoleMessage: [level: string, text: string, sourceId: string];
  // A page's download finished and is ready to save. A prompt, not the file:
  // show filename and, on the person's click, open the source's
  // downloadUrl(guid).
  downloadReady: [filename: string, guid: string, sourceId: string];
  // A page opened a file input: raise the person's own file picker
  // (multiple as given) and pass what they pick to the source's
  // uploadFiles().
  fileChooserOpened: [multiple: boolean, sourceId: string];
  // A file chooser announced by fileChooserOpened is no longer waiting: its
  // 60 s ran out, or another replaced it. Dismiss the prompt.
  fileChooserClosed: [sourceId: string];
  // A page asked for the microphone (getUserMedia({audio: true})) and waits
  // for the answer: call grantMicAccess() or denyMicAccess() within 60 s, or
  // it is denied. origin is the page's own, for the prompt.
  micAccessRequested: [origin: string, sourceId: string];
  /** A report from Glass; `code` for programs when it has one (`encoder_failed`, `source_failed`, `not_connected`, …). */
  error: [message: string, code?: string];
  // The peer connection reached "connected" (initial connect or a reconnect).
  connected: [];
  // A transport drop occurred. May be followed by "reconnecting" then
  // "connected", or by "closed" if recovery is disabled/exhausted.
  disconnected: [];
  // A full reconnect attempt is about to run.
  reconnecting: [attempt: number, maxAttempts: number];
  // The engine refused a connect attempt for now, with the reason (its viewer limit:
  // VIEWER_LIMIT_MESSAGE). Not terminal: with reconnecting on, "reconnecting" follows and the
  // client keeps trying; without it, connect() fails with the same reason.
  refused: [reason: string, code: GlassRefusedCode];
  // Optional periodic transport/quality snapshot (see statsIntervalMs).
  stats: [stats: GlassStats];
  // Whether the session is being recorded: on connect, then on every change.
  recording: [active: boolean];
  // A playback's state: on connect, on every change, and once a second
  // while it plays.
  playback: [state: GlassPlaybackState, sourceId: string];
  // A playback passed one event of its recording's timeline.
  timeline: [event: GlassTimelineEvent, sourceId: string];
  // A page's JavaScript dialog opened (dialog.open) or closed; on connect
  // too when one is open. Answer it with the source's answerDialog().
  dialog: [dialog: GlassDialog, sourceId: string];
  // This connection's quality as Glass measures it (docs/protocol.md, connection_quality): once it is known after
  // connecting, then on each change, at most every 5 s. Show "poor" ("Your connection is weak") and "lost"
  // ("Connection lost, reconnecting"); "excellent" and "good" need nothing. connectionQuality() already reflects it.
  connectionQuality: [quality: GlassConnectionQualityLevel, score: number];
  // Input was dropped: either this client withheld it (drop.local, when the
  // connection does not hold the source's input track, or isn't the owner)
  // or Glass discarded it (rate limit, unsupported or invalid event).
  // Coalesced: at most one report every 2 s per code, event type and source,
  // with a count.
  inputDropped: [drop: GlassInputDrop];
  // One input-latency sample, measured on this client's monotonic clock
  // (see input_latency.ts): from sending a click/key/tap to displaying the
  // first eligible frame after it, or, for drags and scrolls
  // (continuous: true), how old the input behind the displayed frame was.
  // Needs a mounted viewer or calls to notePresentedFrame().
  inputLatency: [sample: InputLatencySample];
  // Terminal: reconnection was exhausted/disabled, or disconnect() was called.
  // No further events will fire.
  closed: [reason: string, code: GlassCloseCode];
  // A page tried to open a popup or new tab: it was blocked, and its URL is
  // handed to the application, which decides what to do with it.
  newTabRequested: [url: string, sourceId: string];
};

/** What this connection's link may do, with the sources the owner denied it. */
export type GlassClientRights = GlassRights & { denied: { watch: string[]; control: string[] } };


/**
 * WebSocket close code Glass sends for a session that doesn't exist: never created, closed, or swept
 * before anyone connected. Retrying can't help.
 */
export const CLOSE_SESSION_NOT_FOUND = 4404;
/**
 * The "closed" event's reason when the session is gone (CLOSE_SESSION_NOT_FOUND): it never
 * existed, was swept, or ended while this client was connected.
 */
export { SESSION_NOT_FOUND_MESSAGE } from "./internal";
/**
 * WebSocket close code Glass sends for a link that has expired: it no longer admits a new
 * connection, though a connection that joined with it may still resume after a drop. Retrying
 * can't help; ask whoever shared the link for a new one.
 */
export const CLOSE_LINK_EXPIRED = 4401;
/** The "closed" event's reason when the link has expired (CLOSE_LINK_EXPIRED). */
export const LINK_EXPIRED_MESSAGE = "this link has expired";
/**
 * WebSocket close code Glass sends for a link the operator revoked: the connection that joined
 * with it is closed with this code, and the link admits nothing again, a resume included.
 * Retrying can't help; ask whoever shared the link for a new one.
 */
export const CLOSE_LINK_REVOKED = 4403;
/** The "closed" event's reason when the link was revoked (CLOSE_LINK_REVOKED). */
export const LINK_REVOKED_MESSAGE = "this link has been revoked";
/**
 * WebSocket close code Glass sends for a viewer refused at a viewer limit: the engine's limit on
 * relay viewers, or the session's own. Not final: a place can free up, so a reconnect keeps trying
 * with its usual backoff, and a first connect fails with VIEWER_LIMIT_MESSAGE.
 */
export const CLOSE_VIEWER_LIMIT = 4503;
/** The error a first connect fails with when Glass refused it at its viewer limit (CLOSE_VIEWER_LIMIT). */
export const VIEWER_LIMIT_MESSAGE = "at the viewer limit; try again later";
import { SUPPORTED_PROTOCOL_VERSION, protocolMismatchMessage } from "./protocol_version";
export { SUPPORTED_PROTOCOL_VERSION };

/**
 * Why a GlassClient closed, for programs (the "closed" event's second argument); the first
 * argument is a sentence for people. `session_not_found`, `link_expired` and `link_revoked` are
 * Glass's close codes 4404, 4401 and 4403; `source_failed` and `session_not_resumable` are its
 * signaling error codes; `protocol_mismatch` means this client and the engine speak different
 * protocol versions; the rest are this client's own.
 */
export type GlassCloseCode =
  | "session_not_found"
  | "link_expired"
  | "link_revoked"
  | "source_failed"
  | "session_not_resumable"
  | "protocol_mismatch"
  | "connect_failed"
  | "connection_lost"
  | "reconnect_exhausted"
  | "client_disconnected";

/** The "refused" event's code: Glass refused this attempt for now (close code 4503). */
export type GlassRefusedCode = "viewer_limit";



// Creates a session (POST {baseUrl}/v1/sessions) and returns it with its own
// link, the owner's. With sources (a hosted browser) the engine runs them;
// with none, the session's members publish. For TypeScript backends and
// local development: a real application's backend makes sessions, holding
// the API token, and hands each person only their link.
export async function createGlassSession(options: GlassCreateSessionOptions = {}): Promise<GlassSession> {
  const { baseUrl = "", apiToken, sources, maxMembers, simulcast, record, linkExpiresIn } = options;
  const body: Record<string, unknown> = {};
  if (sources) body.sources = sources;
  if (maxMembers !== undefined) body.maxMembers = maxMembers;
  if (simulcast) body.simulcast = true;
  if (record) body.record = true;
  if (linkExpiresIn !== undefined) body.linkExpiresIn = linkExpiresIn;
  const res = await fetch(`${baseUrl}/v1/sessions`, {
    method: "POST",
    headers: { ...authHeaders(apiToken), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return readSession(res, "create session");
}

// Redeems a session ticket (POST {baseUrl}/v1/tickets) for a new session's
// links: the session's own link, which controls it, and any watch links the
// ticket asked for (watchLinks). This is how a browser starts a session with
// no API token anywhere near it: your backend signs a short-lived ticket
// (a JWT, HS256, with the runtime's GLASS_TICKET_SECRET; at most 10 minutes;
// a unique jti, since each ticket is accepted once) and hands it to the page.
// The ticket's "glass" claim carries the session's options (audioInput,
// contentHint, codec, inputMode, linkExpiresIn) and how many watch links to
// make (watchLinks).
export async function redeemGlassTicket({ ticket, baseUrl = "" }: { ticket: string; baseUrl?: string }): Promise<GlassSession> {
  const res = await fetch(`${baseUrl}/v1/tickets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ticket }),
  });
  return readSession(res, "redeem ticket");
}

/** A session ticket from glass gate, and the engine to redeem it with. */
export interface GlassGateTicket {
  /** The engine's public address: pass it to redeemGlassTicket as baseUrl. */
  engine: string;
  /** A session ticket, good for one session, redeemed at once. */
  ticket: string;
}

/**
 * What glass gate asks for: nothing for an `open` gate, the shared phrase for a
 * `passphrase` gate, a minted link's code for a `links` gate.
 */
export interface GlassGateCredentials {
  code?: string;
  passphrase?: string;
}

/** Where glass gate is, and what it asks for. */
export interface GlassGateRequest extends GlassGateCredentials {
  /** The gate's address, http(s)://host[:port]. */
  gate: string;
}

/**
 * The gate refused a ticket. `code` is the gate's: `gate_refused` (a wrong
 * passphrase, or a link not valid, expired or used up), `rate_limited` (see
 * retryAfterSeconds), `origin_not_allowed`, `unavailable`.
 */
export class GlassGateError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = "GlassGateError";
  }
}

// Asks glass gate (POST {gate}/v1/ticket) for a session ticket. With it, a
// website gets a browser from the engine's pool with no API token in the page
// and no link handed out by anyone: the gate answers with a ticket and the
// engine's address, and redeemGlassTicket({ ticket, baseUrl: engine }) starts
// the session. Fails with a GlassGateError carrying the gate's reason.
export async function requestGateTicket({ gate, code, passphrase }: GlassGateRequest): Promise<GlassGateTicket> {
  const body: GlassGateCredentials = {};
  if (code) body.code = code;
  if (passphrase) body.passphrase = passphrase;
  const res = await fetch(`${gate.replace(/\/+$/, "")}/v1/ticket`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let message = `the gate refused (${res.status})`;
    let code: string | undefined;
    try {
      const err = (await res.json()) as { error?: string; code?: string };
      if (err.error) message = err.error;
      code = err.code;
    } catch {
      // not JSON: keep the status
    }
    const after = Number(res.headers.get("Retry-After"));
    throw new GlassGateError(message, res.status, code, Number.isFinite(after) && after > 0 ? after : undefined);
  }
  return (await res.json()) as GlassGateTicket;
}

// Reads a session-creating response, failing with the runtime's reason.
async function readSession(res: Response, what: string): Promise<GlassSession> {
  if (!res.ok) {
    const detail = await errorDetail(res);
    throw new Error(
      `Failed to ${what} (${res.status}): ${detail}`
    );
  }
  const session: GlassSession = await res.json();

  // Fail closed on a wire contract this client doesn't speak: proceeding would
  // give a black screen or silently dropped input with nothing pointing at the
  // cause. An engine that sends no protocolVersion speaks version 1.
  const version = session.protocolVersion ?? 1;
  if (version !== SUPPORTED_PROTOCOL_VERSION) {
    throw new Error(protocolMismatchMessage(version));
  }
  return session;
}

// Ends a session for every connection (DELETE {baseUrl}/v1/sessions/{id}).
// Resolves once it is gone, or was already; fails with the engine's reason
// otherwise. Takes the API token: see GlassEngine.
export async function deleteGlassSession({ id, baseUrl = "", apiToken }: GlassEngine & { id: string }): Promise<void> {
  const res = await fetch(`${baseUrl}/v1/sessions/${id}`, {
    method: "DELETE",
    headers: authHeaders(apiToken),
  });
  if (res.ok || res.status === 404) return;
  throw new Error(`Failed to delete session (${res.status}): ${await errorDetail(res)}`);
}

// Mints a link to a session (POST {baseUrl}/v1/sessions/{id}/links) with the
// rights asked for: watch, publish and control by kind of source, and its
// lifetime (expiresIn, seconds, 0 for never). A link never has more than it
// was minted with; a watch link's holder may still ask for control at
// runtime (a source's requestInput()), which the owner or the license
// decides. Takes the API token: a real application mints links from its own
// backend.
export async function mintGlassLink({
  sessionId,
  rights,
  baseUrl = "",
  apiToken,
}: GlassEngine & { sessionId: string; rights: GlassLinkRequest }): Promise<GlassLink> {
  const res = await fetch(`${baseUrl}/v1/sessions/${sessionId}/links`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(apiToken) },
    body: JSON.stringify(rights),
  });
  if (!res.ok) {
    throw new Error(`Failed to mint link (${res.status}): ${await errorDetail(res)}`);
  }
  return res.json();
}

// Revokes a link (DELETE {baseUrl}/v1/sessions/{id}/links/{linkId}): what
// joined with it is closed, and it admits nothing again, a resume included.
// The session goes on for everyone else. Takes the API token.
export async function revokeGlassLink({ sessionId, linkId, baseUrl = "", apiToken }: GlassEngine & { sessionId: string; linkId: string }): Promise<void> {
  const res = await fetch(`${baseUrl}/v1/sessions/${sessionId}/links/${linkId}`, {
    method: "DELETE",
    headers: authHeaders(apiToken),
  });
  if (!res.ok) {
    throw new Error(`Failed to revoke link (${res.status}): ${await errorDetail(res)}`);
  }
}

// A session's lifetime, as a client sees it:
//
// - A session lives until DELETE /v1/sessions/{id} (deleteGlassSession, from
//   your backend), or until its last member has been gone for the engine's
//   reconnect grace (GLASS_RECONNECT_GRACE_SECONDS, 60 s by default).
//   disconnect() leaves; it does not end the session for anyone else.
// - Leaving the page - a reload, a closed tab, navigating away - is not a
//   leave Glass can tell from a network drop: it holds this member's place
//   for the grace.
// - Connecting with the same link within the grace resumes this member: a
//   reloaded tab gets back to its session by keeping its link (in
//   sessionStorage, say, which is per tab) and connecting with it on load.
//   After the grace, or if the session ended, connecting closes with
//   "session not found" and the application's backend decides what next.
export class GlassClient extends Emitter<GlassClientEventMap> {
  private readonly core: ClientCore;

  constructor(options: GlassClientOptions) {
    super();
    this.core = new ClientCore(options, ((event: keyof GlassClientEventMap, ...args: unknown[]) =>
      (this.emit as (e: keyof GlassClientEventMap, ...a: unknown[]) => void)(event, ...args)) as Emit);
  }

  // Connect to the session. Resolves once the peer connection is established
  // (after transparent retries if the first attempts fail and reconnection is
  // enabled); rejects only if it can't connect and retries are exhausted or
  // disabled. Subsequent mid-session drops are recovered in the background.
  async connect(): Promise<void> {
    return lifecycle.connect(this.core);
  }

  // --- The session's sources ---

  // Every source the engine has told this connection of, in the order it
  // announced them.
  sources(): GlassSourceInfo[] {
    return [...this.core.sources.values()].map((st) => ({ ...st.info }));
  }

  // A handle on one source: its stream, and every action on it.
  source(id: string): GlassSource {
    return new GlassSource(this.core, id);
  }

  // Publishes a track of this person's (a camera, a microphone, a screen)
  // into the session, on this connection: it becomes a source the session's
  // members watch, if this connection's link may publish its kind. Before
  // connect() it waits, and is published as the connection comes up; it
  // stays published across a reconnect. A refused one fires "refused" on the
  // publication. stop() on it unpublishes.
  publish(track: MediaStreamTrack, options: GlassPublishOptions): GlassPublication {
    const pub = new GlassPublication(this.core, track, options);
    this.core.publications.push(pub);
    publish.checkForSilence(pub);
    if (this.core.pc) {
      publish.attach(this.core, pub);
      transport.offer(this.core);
    }
    return pub;
  }

  // What this client publishes now.
  publications(): GlassPublication[] {
    return [...this.core.publications];
  }

  // --- This connection ---

  // This connection's id, from hello; null before it.
  connectionId(): string | null {
    return this.core._connectionId;
  }

  // Whether this connection joined with the session's own link, the owner's:
  // it navigates, grants and revokes, and sees the other members.
  isOwner(): boolean {
    return this.core._owner;
  }

  // What this connection's link may do, by kind of source, with the sources
  // the owner denied it; null before hello.
  rights(): GlassClientRights | null {
    return handoff.rights(this.core);
  }

  // The owner only: the session's other members; empty for anyone else.
  members(): GlassMember[] {
    return handoff.members(this.core);
  }

  // Whether the session is being recorded (see the "recording" event).
  recording(): boolean {
    return this.core._recording;
  }

  // This connection's last reported quality (see "connectionQuality"); null before the first report.
  connectionQuality(): GlassConnectionQuality | null {
    return this.core._connectionQuality ? { ...this.core._connectionQuality } : null;
  }

  // The viewport a hosted browser starts with, and whether to emulate a
  // phone (with the user agent and its client hints), sent before its first
  // picture.
  sendInitialViewport(width: number, height: number, isMobile?: boolean, userAgent?: string, userAgentData?: UserAgentClientHints): void {
    return navigation.sendInitialViewport(this.core, width, height, isMobile, userAgent, userAgentData);
  }

  // Answers a page's "micAccessRequested": captures this person's own
  // microphone (this device's getUserMedia, not the page's) onto the line
  // this connection publishes as its microphone, then tells Glass. A device
  // or permission failure denies the page instead, and rejects with the
  // reason so the application can say why.
  async grantMicAccess(): Promise<void> {
    return mic.grantMicAccess(this.core);
  }

  // Denies a page's "micAccessRequested". A no-op when nothing is waiting.
  denyMicAccess(): void {
    return mic.denyMicAccess(this.core);
  }

  // Reports that the frame with this RTP timestamp was presented at
  // expectedDisplayTime (performance.now() clock), completing any input
  // latency samples waiting on it. mountGlassViewer calls this from its
  // requestVideoFrameCallback loop; an app rendering the video itself can
  // call it the same way.
  notePresentedFrame(rtpTimestamp: number, expectedDisplayTime: number): void {
    return statsTrace.notePresentedFrame(this.core, rtpTimestamp, expectedDisplayTime);
  }

  // Recent input latency (last 200 samples): median and p95 in ms for
  // clicks/keys/taps and for drags/scrolls.
  inputLatencyStats(): InputLatencyStats {
    return statsTrace.inputLatencyStats(this.core);
  }

  isConnected(): boolean {
    return transport.isConnected(this.core);
  }

  // One-shot transport/quality snapshot from RTCPeerConnection.getStats().
  // Returns null if no peer connection exists.
  async getStats(): Promise<GlassStats | null> {
    return statsTrace.getStats(this.core);
  }

  // @internal Whether mountGlassViewer should instantiate PixelTraceSampler
  // against its <video> element (InternalGlassClientOptions).
  /** @internal */
  get pixelTraceEnabled(): boolean {
    return this.core._pixelTraceEnabled;
  }

  /** @internal */
  get decodeReadbackEnabled(): boolean {
    return this.core._decodeReadbackEnabled;
  }

  /** @internal */
  reportPixelTraceSamples(samples: { rtpTimestamp: number; paintedAtMs: number }[]): void {
    return statsTrace.reportPixelTraceSamples(this.core, samples);
  }

  // --- Cleanup ---
  // Leaves the session for good: stops reconnecting and closes this
  // connection (a deliberate leave, so Glass holds nothing for it). The
  // session goes on for everyone else; ending it is DELETE, from your
  // backend. After this, no further events fire. Safe to call more than once.
  disconnect(): void {
    lifecycle.disconnect(this.core);
    this.removeAllListeners();
  }
}

// Convenience factory mirroring the rest of the SDK's function-first surface.
export function createGlassClient(options: GlassClientOptions): GlassClient {
  return new GlassClient(options);
}


