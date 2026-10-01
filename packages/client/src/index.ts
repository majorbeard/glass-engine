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
import { authHeaders } from "./internal";
import * as lifecycle from "./lifecycle";
import * as transport from "./transport";
import * as inputs from "./input";
import * as handoff from "./handoff";
import * as mic from "./mic";
import * as navigation from "./navigation";
import * as fileTransfer from "./files";
import * as statsTrace from "./stats_trace";
import type {
  ElementState,
  GlassCapabilities,
  GlassConnectionCapabilities,
  GlassConnectionGrant,
  GlassInputDrop,
  GlassInputDropCode,
  GlassRosterEntry,
  GlassSlotState,
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

export { GlassProducer } from "./producer";
import type { InputLatencySample, InputLatencyStats } from "./input_latency";
export type { InputLatencySample, InputLatencyStats, InputLatencySummary } from "./input_latency";
export type {
  GlassProducerEvents,
  GlassProducerOptions,
  ProducerSession,
  ProducerState,
  ProducerStats,
} from "./producer";

export type {
  ElementState,
  GlassCapabilities,
  GlassConnectionCapabilities,
  GlassConnectionGrant,
  GlassInputDrop,
  GlassInputDropCode,
  GlassRosterEntry,
  GlassSlotState,
  GlassSession,
  GlassStats,
  InteractiveElement,
  KeyEvent,
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
  // The session's signaling WebSocket URL - typically obtained from your own
  // backend (which called POST /v1/sessions), or from createGlassSession().
  signalingUrl: string;
  // Optional session id, used only to DELETE the session on final close.
  sessionId?: string;
  // ICE servers for the RTCPeerConnection. Defaults to a public STUN server.
  iceServers?: RTCIceServer[];
  // Forces ICE candidate gathering/use to "relay" only (TURN) instead of the
  // browser default "all". Not needed for normal operation - exists so a
  // TURN deployment can be verified end-to-end: with "relay", this peer can
  // only ever connect via a TURN relay candidate, so a successful connection
  // actually proves the TURN server works rather than just being configured
  // and silently unused because a direct/STUN path happened to succeed
  // first (the common case on a LAN or same-machine test).
  iceTransportPolicy?: RTCIceTransportPolicy;
  // Reconnection behavior. true (default) uses defaults; false disables it;
  // an object customizes attempts/backoff.
  reconnect?: boolean | GlassReconnectOptions;
  // If > 0, emit a "stats" event this often (ms). Off by default; getStats()
  // is always available for one-shot snapshots regardless.
  statsIntervalMs?: number;
  // DELETE the session (best-effort) when the client is closed for good.
  // Defaults to true when sessionId is provided.
  deleteSessionOnClose?: boolean;
  // Base URL (origin) for the session DELETE call. Defaults to the origin
  // derived from signalingUrl.
  sessionBaseUrl?: string;
  // GLASS_API_TOKEN, only needed if this session was created against a
  // runtime that has it set - used solely for this client's own DELETE
  // calls (sendDeleteBeacon, the final close in disconnect()); the
  // signaling WebSocket needs no separate handling since the runtime
  // already embeds the token in signalingUrl when it hands that back from
  // POST /v1/sessions. See createGlassSession's doc comment for the trust
  // model this assumes (a real deployment's token lives in your own
  // backend, not a browser bundle).
  apiToken?: string;
}


// A `type` (not `interface`) so it satisfies the Emitter's
// Record<string, unknown[]> constraint - interfaces don't get an implicit
// index signature.
export type GlassClientEventMap = {
  // A remote video track arrived - bind it to a <video> element's srcObject.
  videoTrack: [stream: MediaStream];
  // Cursor / editable-focus state from the remote page.
  state: [state: ElementState];
  // URL-bar / navigation state from the remote page.
  navigation: [nav: NavigationState];
  // Text-editable candidate bounding boxes on the remote page, mobile-only,
  // full-snapshot-replace (see mobileKeyboard.ts's three-case handleTap).
  interactiveElements: [elements: InteractiveElement[]];
  // The remote page's selected text, in response to copyText(). May be an
  // empty string if nothing was selected - callers should check before
  // writing to the OS clipboard.
  clipboardText: [text: string];
  // One real console.*() call (or uncaught exception, level "error") from
  // the remote page's own JS - the "dev console" feature. level is Chrome's
  // own console-method vocabulary verbatim ("log"/"warning"/"error"/
  // "info"/"debug"/...), not remapped. text is a shallow, best-effort
  // flattening of the call's arguments - see docs/protocol.md's
  // ConsoleMessage row for why deep object inspection isn't attempted.
  consoleMessage: [level: string, text: string];
  // A remote-page-triggered download finished server-side and is ready to
  // be pulled down. This is
  // the prompt signal, not the file (prompt-then-save, not auto-save): GlassClient never fetches it on its own. The
  // app is expected to surface filename to the operator and, only on their
  // explicit click, use downloadUrl(guid) to trigger a real browser save
  // (e.g. as an <a href> or window.open target).
  downloadReady: [filename: string, guid: string];
  // The remote page just opened a file input. The app is expected to raise
  // the *operator's own* local file picker (a real <input type="file">,
  // with its `multiple` attribute matching this event's argument) and,
  // once they've picked something, call uploadFiles() with the result.
  // Glass never opens anything server-side.
  fileChooserOpened: [multiple: boolean];
  // A previously-announced fileChooserOpened prompt is no longer valid -
  // the operator's 60s window to respond elapsed, or a second file
  // chooser opened before the first was answered. The app should dismiss
  // whatever prompt UI it raised for fileChooserOpened. Not fired for the
  // ordinary success path (a completed uploadFiles() call) - the app
  // already knows that outcome from the promise it awaited.
  fileChooserClosed: [];
  // The remote page just called getUserMedia({audio:true}). Unlike every other event
  // here, the remote page's own JS is genuinely blocked waiting for an
  // answer: the app must call grantMicAccess() or denyMicAccess() within
  // 60s, or the request is denied automatically (silence never grants -
  // a live mic feed is privacy-sensitive). origin is the requesting
  // page's own origin, for the app's own prompt UI only.
  micAccessRequested: [origin: string];
  // A fatal, session-level backend error (e.g. the encoder died). Distinct
  // from a transport drop - there is no recovery, video is gone.
  error: [message: string];
  // The peer connection reached "connected" (initial connect or a reconnect).
  connected: [];
  // A transport drop occurred. May be followed by "reconnecting" then
  // "connected", or by "closed" if recovery is disabled/exhausted.
  disconnected: [];
  // A full reconnect attempt is about to run.
  reconnecting: [attempt: number, maxAttempts: number];
  // Optional periodic transport/quality snapshot (see statsIntervalMs).
  stats: [stats: GlassStats];
  // A connection's live producesInput actually changed (docs/protocol.md's
  // "Control handoff" section) - broadcast to every connection on the
  // session, including this one. isSelf is true when connectionId matches
  // this client's own (see the connectionId() getter); producesInput()
  // already reflects the new value by the time this fires.
  capabilitiesChanged: [
    connectionId: string,
    producesInput: boolean,
    isSelf: boolean
  ];
  // Someone without producesInput called requestInput() while this client
  // already held it, and there was no fresh capacity to grant them one
  // immediately - Glass relayed the ask here instead of deciding anything.
  // Nothing changed server-side; it's entirely up to this app whether to
  // prompt a human, auto-decline, or ignore it (see requestInput's own doc
  // comment - Glass never queues, prompts, or auto-preempts on its own).
  // Only ever fires for a connection that currently produces input.
  inputRequested: [connectionId: string];
  // Owner-only roster (docs/protocol.md's Control handoff section) - fires
  // whenever the known set of other connections changes: someone joined,
  // left, or had their producesInput granted/revoked. Never fires for a
  // non-owner connection (see isOwner()) - it has no grantInput()/
  // revokeInput() authority to act on this anyway. connections() already
  // reflects the new state by the time this fires; the event exists so the
  // app doesn't have to poll.
  rosterChanged: [connections: GlassRosterEntry[]];
  // Relay sessions only: every slot's state (docs/protocol.md, slot_state),
  // once on connect and again whenever one changes. Use it to show "source
  // paused" over a frozen frame while a producer is stalled. slotStates()
  // already reflects it.
  slotStateChanged: [slots: Record<string, GlassSlotState>];
  // Input was dropped: either this client withheld it (drop.local, when the
  // connection has no control or isn't the owner) or Glass discarded it
  // (rate limit, unsupported or invalid event). Coalesced: at most one
  // report every 2 s per code and event type, with a count.
  inputDropped: [drop: GlassInputDrop];
  // One input-latency sample, measured on this client's monotonic clock
  // (see input_latency.ts): from sending a click/key/tap to displaying the
  // first eligible frame after it, or, for drags and scrolls
  // (continuous: true), how old the input behind the displayed frame was.
  // Needs a mounted viewer or calls to notePresentedFrame().
  inputLatency: [sample: InputLatencySample];
  // Terminal: reconnection was exhausted/disabled, or disconnect() was called.
  // No further events will fire.
  closed: [reason: string];
  // The remote page tried to open a popup/new tab (window.open(),
  // target="_blank", etc.) - the browser popup was blocked server-side
  // and the URL it would have opened is handed to the app instead
  // (docs/protocol.md's new_tab_request). Glass never opens it on its
  // own; it's entirely up to the app whether to surface it, navigate the
  // remote page there itself, or open it locally for the operator.
  newTabRequested: [url: string];
};


/**
 * WebSocket close code Glass sends for a session that doesn't exist: never created, closed, or swept
 * before anyone connected. Retrying can't help.
 */
export const CLOSE_SESSION_NOT_FOUND = 4404;
// Highest wire-contract major this client understands. Must track the
// engine's protocol version (docs/protocol.md, "Versioning"); see
// createGlassSession for the fail-closed check and why absent means 1.
export const SUPPORTED_PROTOCOL_VERSION = 1;


// Creates a session via the runtime's REST API (POST {baseUrl}/v1/sessions)
// and returns its id + signaling URL. A dev-convenience helper - in a real
// app your own backend creates the session so auth/quota stay server-side, and
// hands the client only the signalingUrl. baseUrl defaults to same-origin.
//
// apiToken is only relevant if the runtime has GLASS_API_TOKEN set - passed here purely for local testing symmetry;
// a real deployment's actual token belongs in your own backend, never
// shipped to a browser bundle. When a session is created with a token, the
// returned signalingUrl already has it embedded as a query param (the
// runtime does this server-side), so GlassClient needs no separate token
// handling to open the signaling WebSocket - only this helper's own
// follow-up REST calls (deleteGlassSession) need it passed again.
// audioInput requests the mic-capable browser pool - false by default,
// since it costs real, measured extra CPU/memory
// and most sessions don't need it. Only takes effect if the runtime was
// actually started with GLASS_MIC_POOL_CHROME_BIN configured - otherwise
// the flag is accepted and the session uses the default pool, not an
// error.
export async function createGlassSession(
  baseUrl = "",
  apiToken?: string,
  audioInput = false
): Promise<GlassSession> {
  const res = await fetch(`${baseUrl}/v1/sessions`, {
    method: "POST",
    headers: audioInput
      ? { ...authHeaders(apiToken), "Content-Type": "application/json" }
      : authHeaders(apiToken),
    body: audioInput ? JSON.stringify({ audioInput: true }) : undefined,
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.json()).error;
    } catch {
      // ignore parse failure, fall back to status text
    }
    throw new Error(
      `Failed to create session (${res.status}): ${detail || res.statusText}`
    );
  }
  const session: GlassSession = await res.json();

  // Fail closed on a wire contract we don't understand. A runtime that predates
  // the handshake sends no protocolVersion at all, so an absent value means
  // "1", not "unsupported" - that keeps this client working against an older
  // backend. A HIGHER major means the runtime has made a breaking change to
  // the signaling shape or DataChannel messages, and proceeding would produce a
  // black screen or silently-dropped input with nothing pointing at the cause.
  // Better to say so here, at the one call every client makes first.
  const version = session.protocolVersion ?? 1;
  if (version > SUPPORTED_PROTOCOL_VERSION) {
    throw new Error(
      `Glass runtime speaks protocol v${version}, but this client only supports v${SUPPORTED_PROTOCOL_VERSION}. Upgrade @glass/client.`
    );
  }
  return session;
}

// Best-effort session close via DELETE {baseUrl}/v1/sessions/{id}. The backend
// also closes a session when its signaling socket drops, so failures are
// non-fatal. See createGlassSession's doc comment for apiToken's caveats.
export function deleteGlassSession(
  id: string,
  baseUrl = "",
  apiToken?: string
): void {
  fetch(`${baseUrl}/v1/sessions/${id}`, {
    method: "DELETE",
    headers: authHeaders(apiToken),
  }).catch(() => {
    // best-effort
  });
}

// Mints a fresh, capability-scoped connection to an already-created session
// (POST {baseUrl}/v1/sessions/{id}/connections) - see docs/protocol.md's
// "Connection capabilities" section. The returned signalingUrl connects
// with exactly `capabilities`, nothing more, structurally: e.g.
// `{ consumesMedia: true }` for a watch-only viewer that can never gain
// input control no matter what it does, unless it later calls
// requestInput() and the resolved license tier admits it (see
// docs/protocol.md's "Control handoff" section) - minting a grant and
// requesting input at runtime are two independent mechanisms.
//
// Same dev-convenience/trust-model caveat as createGlassSession: a real app
// mints grants from its own backend (which already holds whatever auth this
// call needs), not from a browser bundle carrying apiToken.
export async function mintConnectionGrant(
  sessionId: string,
  capabilities: Partial<GlassConnectionCapabilities>,
  baseUrl = "",
  apiToken?: string
): Promise<GlassConnectionGrant> {
  const res = await fetch(`${baseUrl}/v1/sessions/${sessionId}/connections`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(apiToken),
    },
    body: JSON.stringify(capabilities),
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.json()).error;
    } catch {
      // ignore parse failure, fall back to status text
    }
    throw new Error(
      `Failed to mint connection grant (${res.status}): ${detail || res.statusText}`
    );
  }
  return res.json();
}

export class GlassClient extends Emitter<GlassClientEventMap> {
  private readonly core: ClientCore;

  constructor(options: GlassClientOptions) {
    super();
    this.core = new ClientCore(options, ((event: keyof GlassClientEventMap, ...args: unknown[]) =>
      (this.emit as (e: keyof GlassClientEventMap, ...a: unknown[]) => void)(event, ...args)) as Emit);
    lifecycle.installUnloadHandler(this.core);
  }

  // Connect to the session. Resolves once the peer connection is established
  // (after transparent retries if the first attempts fail and reconnection is
  // enabled); rejects only if it can't connect and retries are exhausted or
  // disabled. Subsequent mid-session drops are recovered in the background.
  async connect(): Promise<void> {
    return lifecycle.connect(this.core);
  }

  // --- Input sending ---
  // @internal Whether mountGlassViewer should instantiate PixelTraceSampler
  // against its <video> element - see InternalGlassClientOptions'
  // __internalPixelTraceEnabled doc comment for why this lives here rather
  // than the viewer owning its own separate opt-in flag (GlassClient is
  // this whole SDK's single source of truth for what diagnostics are
  // enabled for a given session).
  get pixelTraceEnabled(): boolean {
    return this.core._pixelTraceEnabled;
  }

  // @internal Mirrors pixelTraceEnabled exactly - see
  // InternalGlassClientOptions.__internalDecodeReadbackEnabled.
  get decodeReadbackEnabled(): boolean {
    return this.core._decodeReadbackEnabled;
  }

  // @internal Reports one batch of real capture-to-paint samples (see
  // pixel_trace.ts's PixelTraceSampler) to the backend - same wire
  // mechanism as collectAndSendTraceReport (sendInput over the existing
  // reliable DataChannel), just triggered by the viewer right after a
  // discrete input dispatch rather than on a fixed interval. Not part of
  // the documented public API (see traceReportIntervalMs' own doc comment
  // for why this whole diagnostic channel stays internal-only for now).
  reportPixelTraceSamples(samples: { rtpTimestamp: number; paintedAtMs: number }[]): void {
    return statsTrace.reportPixelTraceSamples(this.core, samples);
  }

  // Navigation travels over the signaling socket, not the DataChannel.
  navigate(url: string): void {
    return navigation.navigate(this.core, url);
  }

  // --- Input handoff (docs/protocol.md's "Control handoff" section) ---
  // Asks the backend for producesInput, over the signaling socket (not the
  // DataChannel) - a no-op if this connection already has it. Glass's
  // entire server-side policy: grant immediately (a "capabilitiesChanged"
  // event with isSelf=true follows) if nothing/no one else currently holds
  // it and the resolved license tier admits it; otherwise relay the ask to
  // whoever already holds it (they get an "inputRequested" event - nothing
  // changes here) or drop it if there's no one to relay to and no capacity
  // either. Glass never queues, prompts, or auto-preempts on its own - it's
  // entirely up to this app what to do while waiting, including whether to
  // retry at all. See producesInput()/connectionId() for reading the
  // resulting state, and the "capabilitiesChanged"/"inputRequested" events.
  requestInput(): void {
    return handoff.requestInput(this.core);
  }

  // The real operator consent answer for a pending "micAccessRequested"
  // event - captures the OPERATOR's own
  // real microphone (this device's getUserMedia, NOT the remote page's),
  // swaps it onto the placeholder sender attachMicPlaceholder already
  // negotiated, then tells the backend. Real device/permission failures
  // (no mic, operator denies the browser's own native prompt) fall back
  // to denyMicAccess() automatically - a real "I don't have a working
  // mic" is not different from "I said no" from the remote page's own
  // point of view. Safe to call even if no request is currently pending
  // (the backend's own ResolveMicConsent is itself a no-op then).
  //
  // Rejects (rather than swallowing) a real device/permission failure -
  // the remote page is still denied promptly either way (see the catch
  // below), but the caller gets the real error back to show the operator
  // WHY, instead of a silent no-op that looks identical to success.
  async grantMicAccess(): Promise<void> {
    return mic.grantMicAccess(this.core);
  }

  // Explicit denial for a pending "micAccessRequested" event - see
  // grantMicAccess's own doc comment. A no-op backend-side if nothing is
  // actually pending.
  denyMicAccess(): void {
    return mic.denyMicAccess(this.core);
  }

  // Voluntarily gives up producesInput - a no-op if this connection doesn't
  // currently hold it. Frees whatever interactive-input slot this
  // connection holds immediately (however it was acquired - a mint-time
  // grant or an earlier requestInput()), not just on disconnect, so it's
  // available to someone else in a shared-pool tier right away. A
  // "capabilitiesChanged" event (isSelf=true, producesInput=false) follows.
  releaseInput(): void {
    return handoff.releaseInput(this.core);
  }

  // This connection's own id, as assigned by the backend - null until the
  // first "offer" has arrived (see the field's own doc comment). Compare
  // against a "capabilitiesChanged" event's connectionId yourself if you
  // need to, though isSelf already does that for you.
  connectionId(): string | null {
    return handoff.connectionId(this.core);
  }

  // Whether THIS connection currently produces input - the live state
  // requestInput()/releaseInput() (and a connection's own mint-time grant)
  // control. Starts at whatever the initial "offer" reported and stays
  // current via "capabilitiesChanged".
  producesInput(): boolean {
    return handoff.producesInput(this.core);
  }

  // Whether THIS connection is the session owner - the offer's isOwner
  // field (docs/protocol.md) - which (authenticated with the session's own unscoped credential, not a
  // minted grant). Only an owner connection ever receives roster traffic
  // (connections() stays empty otherwise) or has grantInput()/
  // revokeInput() actually take effect server-side - both are still safe
  // to call from a non-owner connection, they just get silently denied
  // (see handleGrantInputMessage/handleRevokeInputMessage's own IsOwner
  // check), so use this to decide whether to show owner-only UI at all.
  isOwner(): boolean {
    return handoff.isOwner(this.core);
  }

  // The current known roster of every OTHER connection on this session -
  // see docs/protocol.md's Control handoff section and the
  // "rosterChanged" event. Always empty for a non-owner connection (see
  // isOwner()). A snapshot at call time, not a live view - listen for
  // "rosterChanged" rather than polling this.
  connections(): GlassRosterEntry[] {
    return handoff.connections(this.core);
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

  // Each relay slot's last reported state (see "slotStateChanged"); empty
  // for a browser session or before the first report.
  slotStates(): Record<string, GlassSlotState> {
    return handoff.slotStates(this.core);
  }

  // Grants producesInput to a SPECIFIC other connection by ID - the
  // owner-driven counterpart to requestInput() (that connection asking for
  // it itself). Routed through the exact same license-tier/capacity gate
  // request_input uses - an owner can't grant
  // more interactive slots than the resolved tier allows. Silently denied
  // (no error, no exception - watch for the resulting "rosterChanged"/
  // "capabilitiesChanged" or their absence) if this connection isn't the
  // owner, or if admission fails.
  grantInput(connectionId: string): void {
    return handoff.grantInput(this.core, connectionId);
  }

  // Forcibly releases a SPECIFIC other connection's producesInput,
  // regardless of how it was acquired (a mint-time grant, its own
  // requestInput(), or an earlier grantInput()) - the owner-driven
  // counterpart to releaseInput() (a connection giving up its own).
  // Silently denied if this connection isn't the owner.
  revokeInput(connectionId: string): void {
    return handoff.revokeInput(this.core, connectionId);
  }

  sendInitialViewport(
    width: number,
    height: number,
    isMobile?: boolean,
    userAgent?: string,
    userAgentData?: UserAgentClientHints
  ): void {
    return navigation.sendInitialViewport(this.core, width, height, isMobile, userAgent, userAgentData);
  }

  navigateBack(): void {
    return navigation.navigateBack(this.core);
  }

  navigateForward(): void {
    return navigation.navigateForward(this.core);
  }

  refresh(): void {
    return navigation.refresh(this.core);
  }

  mouseMove(x: number, y: number, dragging: boolean): void {
    return inputs.mouseMove(this.core, x, y, dragging);
  }

  // button defaults to "left", modifiers to 0, clickCount to 1 - see
  // docs/protocol.md's mousedown/mouseup rows for the three real gaps this
  // closes: right-click never reached the remote page at all before
  // `button` existed, Ctrl/Shift/Alt+click never reached it either before
  // `modifiers` did (silently breaking Shift+click multi-select, Ctrl/Cmd+
  // click, and Alt-drag-to-duplicate), and a real double-click never
  // produced a genuine multi-click DOM event before `clickCount` did.
  // modifiers is the same Alt=1/Ctrl=2/Meta=4/Shift=8 bitmask as
  // dispatchKeyEvent/scroll; clickCount should be the browser's own native
  // click-run counter (DOM MouseEvent.detail).
  mouseDown(x: number, y: number, button: MouseButton = "left", modifiers = 0, clickCount = 1): void {
    return inputs.mouseDown(this.core, x, y, button, modifiers, clickCount);
  }

  mouseUp(x: number, y: number, button: MouseButton = "left", modifiers = 0, clickCount = 1): void {
    return inputs.mouseUp(this.core, x, y, button, modifiers, clickCount);
  }

  // deltaX/modifiers default to 0 - see docs/protocol.md's scroll row for
  // the real gap this closes (a page's own `wheel`-event-driven pan/zoom,
  // e.g. a canvas design tool, never received scroll input through Glass
  // at all before this dispatched a real wheel event). modifiers is the
  // same Alt=1/Ctrl=2/Meta=4/Shift=8 bitmask as dispatchKeyEvent.
  scroll(deltaY: number, deltaX = 0, modifiers = 0): void {
    return inputs.scroll(this.core, deltaY, deltaX, modifiers);
  }

  setViewport(width: number, height: number): void {
    return inputs.setViewport(this.core, width, height);
  }

  copyText(): void {
    return inputs.copyText(this.core);
  }

  pasteText(text: string): void {
    return inputs.pasteText(this.core, text);
  }

  // Builds the retrieval URL for a completed download announced by a
  // "downloadReady" event - see that event's own doc comment for the
  // prompt-then-save flow this is meant to be used in. Session id is parsed
  // out of signalingUrl rather than relying on the options.sessionId field,
  // which is optional and unrelated (used only for the DELETE-on-close
  // call) - signalingUrl always has the real one, since the WS connection
  // couldn't exist without it. Reuses signalingUrl's own ?token= query
  // param, if present, as the retrieval credential - the same session-scoped
  // token that already authorizes this client's signaling/stats routes (see
  // backend's sessionTokenAuthorizes), so a deployment with GLASS_API_TOKEN
  // set doesn't need this SDK to also carry that runtime-wide secret just to
  // let the operator save a file.
  downloadUrl(guid: string): string {
    return fileTransfer.downloadUrl(this.core, guid);
  }

  // Uploads the operator's already-picked local file(s) in response to a
  // "fileChooserOpened" event - see that event's own doc comment for the
  // full flow. Rejects if the backend rejects the request (session
  // gone, no pending prompt - it already timed out or was already
  // answered, size limits) so the caller can surface a real failure
  // instead of assuming success. There's no download-side equivalent of
  // this method (downloadUrl() only builds a URL, letting a real <a
  // download> anchor be the actual save trigger) because there is no
  // similar browser-native mechanism to hand a POST body off to - the
  // fetch here IS the transport, not just a link the operator clicks.
  async uploadFiles(files: FileList | File[]): Promise<void> {
    return fileTransfer.uploadFiles(this.core, files);
  }

  dispatchKeyEvent(keyEvent: KeyEvent): void {
    return inputs.dispatchKeyEvent(this.core, keyEvent);
  }

  // gestureId is required on every call (see TouchInputCallbacks.onTouchPoints
  // in viewer/touchInput.ts) - the backend needs it on touchstart/touchmove/
  // touchend/touchcancel alike to gate touchmove against whichever gesture is
  // actually active. moveCount is
  // diagnostic-only, set only on "touchend".
  //
  // "touchmove" alone travels over the unreliable fast channel - see
  // sendInputFast's doc comment. Every other touch type stays on the
  // reliable channel like all other input, since CDP's touch state machine
  // needs start/end to arrive in order and not be silently dropped.
  dispatchTouch(
    type: TouchDispatchType,
    points: TouchPoint[],
    gestureId: number,
    moveCount?: number
  ): void {
    return inputs.dispatchTouch(this.core, type, points, gestureId, moveCount);
  }

  isConnected(): boolean {
    return transport.isConnected(this.core);
  }

  // The current video stream, if a track has arrived. Lets a viewer that mounts
  // after "videoTrack" already fired still bind the video (see currentStream).
  getVideoStream(): MediaStream | null {
    return transport.getVideoStream(this.core);
  }

  // One-shot transport/quality snapshot from RTCPeerConnection.getStats().
  // Returns null if no peer connection exists.
  async getStats(): Promise<GlassStats | null> {
    return statsTrace.getStats(this.core);
  }

  // --- Cleanup ---
  // Permanently closes the client: stops reconnection, tears down the peer
  // connection and signaling socket, and (best-effort) deletes the session.
  // After this, no further events fire. Safe to call more than once.
  disconnect(): void {
    lifecycle.disconnect(this.core);
    this.removeAllListeners();
  }
}

// Convenience factory mirroring the rest of the SDK's function-first surface.
export function createGlassClient(options: GlassClientOptions): GlassClient {
  return new GlassClient(options);
}


