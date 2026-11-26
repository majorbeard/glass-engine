type Listener<Args extends unknown[]> = (...args: Args) => void;
declare class Emitter<EventMap extends Record<string, unknown[]>> {
    on<K extends keyof EventMap>(event: K, listener: Listener<EventMap[K]>): () => void;
    once<K extends keyof EventMap>(event: K, listener: Listener<EventMap[K]>): () => void;
    off<K extends keyof EventMap>(event: K, listener: Listener<EventMap[K]>): void;
    protected emit<K extends keyof EventMap>(event: K, ...args: EventMap[K]): void;
    protected removeAllListeners(): void;
}

type MouseButton = "left" | "right" | "middle";
interface GlassCapabilities {
    video?: boolean;
    navigation?: boolean;
    viewport?: boolean;
    clipboard?: boolean;
    pauseResume?: boolean;
    mobileEmulation?: boolean;
    inspect?: boolean;
    inputActions?: string[];
    [key: string]: unknown;
}
interface GlassRights {
    watch: "all" | "none" | GlassSourceKind[];
    publish: "all" | GlassSourceKind[];
    control: "all" | GlassSourceKind[];
    owner: boolean;
}
type GlassSourceKind = "browser" | "playback" | "camera" | "microphone" | "screen" | "device" | (string & {});
type GlassSourceState = "live" | "stalled" | "ended";
interface GlassSourceInfo {
    id: string;
    kind: GlassSourceKind;
    state: GlassSourceState;
    reason?: string;
    capabilities: GlassCapabilities;
    codec?: GlassVideoCodec;
    contentHint?: GlassContentHint;
    inputMode: GlassInputMode;
    inspect: boolean;
}
interface GlassLink {
    id: string;
    url: string;
    rights: GlassRights;
    expiresAt?: string;
}
interface GlassLinkRequest {
    watch?: "all" | GlassSourceKind[];
    publish?: "all" | GlassSourceKind[];
    control?: "all" | GlassSourceKind[];
    expiresIn?: number;
}
interface GlassMember {
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
interface GlassControlAnswer {
    action: "request_input" | "release_input" | "grant_input" | "revoke_input" | "grant_watch" | "deny_watch";
    outcome: "granted" | "relayed" | "released" | "revoked" | "refused";
    reason?: "not_allowed" | "not_owner" | "no_capacity" | "unknown_connection" | "unknown_source" | "rate_limited" | "invalid" | "not_connected" | "disconnected" | (string & {});
    /** The source the request was about. */
    source: string;
    /** The connection a grant or revoke was about. */
    connectionId?: string;
}
type GlassConnectionQualityLevel = "excellent" | "good" | "poor" | "lost";
interface GlassConnectionQuality {
    quality: GlassConnectionQualityLevel;
    score: number;
}
type GlassInputDropCode = "rate_limited" | "not_authorized" | "owner_only" | "unsupported" | "invalid" | "floor_taken";
interface GlassInputDrop {
    code: GlassInputDropCode | (string & {});
    eventType: string;
    count: number;
    local: boolean;
    source: string;
    seq?: number;
}
type GlassContentHint = "detail" | "motion";
type GlassVideoCodec = "h264" | "vp8" | "av1";
type GlassInputMode = "floor" | "free";
interface GlassDialog {
    open: boolean;
    type?: "alert" | "confirm" | "prompt" | "beforeunload" | (string & {});
    message?: string;
    defaultPrompt?: string;
    inPicture: boolean;
}
interface GlassPlaybackState {
    playing: boolean;
    positionMs: number;
    durationMs: number;
    ended: boolean;
}
interface GlassTimelineEvent {
    t: number;
    type: string;
    [field: string]: unknown;
}
interface GlassEngine {
    baseUrl?: string;
    apiToken?: string;
}
interface GlassSourceRequest {
    kind: "browser";
    url?: string;
    audioInput?: boolean;
    contentHint?: GlassContentHint;
    codec?: GlassVideoCodec;
    inputMode?: GlassInputMode;
    inspect?: boolean;
}
interface GlassCreateSessionOptions extends GlassEngine {
    sources?: GlassSourceRequest[];
    maxMembers?: number;
    simulcast?: boolean;
    record?: boolean;
    linkExpiresIn?: number;
}
interface GlassSession {
    id: string;
    protocolVersion: number;
    link: GlassLink;
    sources: GlassSourceInfo[];
    watchLinks?: GlassLink[];
    maxMembers?: number;
    simulcast?: boolean;
}
interface ElementState {
    cursor: string;
    editableFocused?: boolean;
}
interface NavigationState {
    url: string;
    loading: boolean;
    canGoBack: boolean;
    canGoForward: boolean;
}
interface InteractiveElement {
    x: number;
    y: number;
    width: number;
    height: number;
}
interface UserAgentBrand {
    brand: string;
    version: string;
}
interface UserAgentClientHints {
    brands: UserAgentBrand[];
    mobile: boolean;
    platform: string;
}
interface TouchPoint {
    x: number;
    y: number;
    id: number;
}
type TouchDispatchType = "touchstart" | "touchmove" | "touchend" | "touchcancel";
interface KeyEvent {
    type: string;
    key: string;
    code: string;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
    metaKey: boolean;
}
interface GlassStats {
    rttMs: number | null;
    throughputKbps: number | null;
    availableOutgoingBitrateKbps: number | null;
    jitterBufferMs: number | null;
    framesDecoded: number | null;
    framesDropped: number | null;
    dataChannelBufferedAmount: number | null;
}

declare class GlassSource {
    readonly id: string;
    info(): GlassSourceInfo | null;
    stream(): MediaStream | null;
    holdsInput(): boolean;
    holders(): string[];
    floorHolder(): string | null;
    requestInput(): Promise<GlassControlAnswer>;
    releaseInput(): Promise<GlassControlAnswer>;
    grantInput(connectionId: string): Promise<GlassControlAnswer>;
    revokeInput(connectionId: string): Promise<GlassControlAnswer>;
    grantWatch(connectionId: string): Promise<GlassControlAnswer>;
    denyWatch(connectionId: string): Promise<GlassControlAnswer>;
    receive(paused: boolean): void;
    navigate(url: string): void;
    navigateBack(): void;
    navigateForward(): void;
    refresh(): void;
    mouseMove(x: number, y: number, dragging: boolean): void;
    mouseDown(x: number, y: number, button?: MouseButton, modifiers?: number, clickCount?: number): void;
    mouseUp(x: number, y: number, button?: MouseButton, modifiers?: number, clickCount?: number): void;
    scroll(deltaY: number, deltaX?: number, modifiers?: number): void;
    setViewport(width: number, height: number): void;
    copyText(): void;
    pasteText(text: string): void;
    dispatchKeyEvent(keyEvent: KeyEvent): void;
    dispatchTouch(type: TouchDispatchType, points: TouchPoint[], gestureId: number, moveCount?: number): void;
    dialog(): GlassDialog | null;
    answerDialog(accept: boolean, text?: string): void;
    downloadUrl(guid: string): string;
    uploadFiles(files: FileList | File[]): Promise<void>;
    playbackState(): GlassPlaybackState | null;
    controlPlayback(action: "play" | "pause" | "seek", positionMs?: number): void;
}

interface InputLatencySample {
    kind: string;
    ms: number;
    continuous: boolean;
}
interface InputLatencySummary {
    n: number;
    p50: number | null;
    p95: number | null;
}
interface InputLatencyStats {
    discrete: InputLatencySummary;
    continuous: InputLatencySummary;
}

/** What a published track is to the session. */
type GlassPublishKind = "camera" | "microphone" | "screen" | "device";
interface GlassPublishOptions {
    kind: GlassPublishKind;
    simulcast?: boolean;
    maxBitrateKbps?: number;
    startBitrateKbps?: number;
}
type GlassPublicationEvents = {
    refused: [reason: string];
    layers: [rids: string[]];
    silent: [];
};
/** One track this client publishes. stop() unpublishes it. */
declare class GlassPublication extends Emitter<GlassPublicationEvents> {
    readonly track: MediaStreamTrack;
    readonly options: GlassPublishOptions;
    readonly maxBitrateKbps: number;
    readonly startBitrateKbps: number;
    get kind(): GlassPublishKind;
    mid(): string | null;
    stop(): void;
    getStatsReport(): Promise<RTCStatsReport | null>;
    getStats(): Promise<{
        bytesSent: number;
        packetsSent: number;
        framesEncoded?: number;
        width?: number;
        height?: number;
    } | null>;
}

declare const SESSION_NOT_FOUND_MESSAGE = "session not found or expired";

declare const SUPPORTED_PROTOCOL_VERSION = 3;

interface GlassReconnectOptions {
    maxAttempts?: number;
    delaysMs?: number[];
}
interface GlassClientOptions {
    link: string;
    iceServers?: RTCIceServer[];
    iceTransportPolicy?: RTCIceTransportPolicy;
    reconnect?: boolean | GlassReconnectOptions;
    repairWait?: boolean;
    statsIntervalMs?: number;
}
type GlassClientEventMap = {
    hello: [connectionId: string, owner: boolean];
    sourceAdded: [source: GlassSourceInfo];
    sourceUpdated: [source: GlassSourceInfo];
    sourceRemoved: [sourceId: string, reason: string];
    track: [sourceId: string, stream: MediaStream];
    rightsChanged: [rights: GlassClientRights];
    inputHolders: [sourceId: string, holders: string[], floor: string | null];
    inputRequested: [connectionId: string, sourceId: string];
    membersChanged: [members: GlassMember[]];
    elementState: [state: ElementState, sourceId: string];
    navigation: [nav: NavigationState, sourceId: string];
    interactiveElements: [elements: InteractiveElement[], sourceId: string];
    clipboardText: [text: string, sourceId: string];
    consoleMessage: [level: string, text: string, sourceId: string];
    downloadReady: [filename: string, guid: string, sourceId: string];
    fileChooserOpened: [multiple: boolean, sourceId: string];
    fileChooserClosed: [sourceId: string];
    micAccessRequested: [origin: string, sourceId: string];
    /** A report from Glass; `code` for programs when it has one (`encoder_failed`, `source_failed`, `not_connected`, …). */
    error: [message: string, code?: string];
    connected: [];
    disconnected: [];
    reconnecting: [attempt: number, maxAttempts: number];
    refused: [reason: string, code: GlassRefusedCode];
    stats: [stats: GlassStats];
    recording: [active: boolean];
    playback: [state: GlassPlaybackState, sourceId: string];
    timeline: [event: GlassTimelineEvent, sourceId: string];
    dialog: [dialog: GlassDialog, sourceId: string];
    connectionQuality: [quality: GlassConnectionQualityLevel, score: number];
    inputDropped: [drop: GlassInputDrop];
    inputLatency: [sample: InputLatencySample];
    closed: [reason: string, code: GlassCloseCode];
    newTabRequested: [url: string, sourceId: string];
};
/** What this connection's link may do, with the sources the owner denied it. */
type GlassClientRights = GlassRights & {
    denied: {
        watch: string[];
        control: string[];
    };
};
/**
 * WebSocket close code Glass sends for a session that doesn't exist: never created, closed, or swept
 * before anyone connected. Retrying can't help.
 */
declare const CLOSE_SESSION_NOT_FOUND = 4404;

/**
 * WebSocket close code Glass sends for a link that has expired: it no longer admits a new
 * connection, though a connection that joined with it may still resume after a drop. Retrying
 * can't help; ask whoever shared the link for a new one.
 */
declare const CLOSE_LINK_EXPIRED = 4401;
/** The "closed" event's reason when the link has expired (CLOSE_LINK_EXPIRED). */
declare const LINK_EXPIRED_MESSAGE = "this link has expired";
/**
 * WebSocket close code Glass sends for a link the operator revoked: the connection that joined
 * with it is closed with this code, and the link admits nothing again, a resume included.
 * Retrying can't help; ask whoever shared the link for a new one.
 */
declare const CLOSE_LINK_REVOKED = 4403;
/** The "closed" event's reason when the link was revoked (CLOSE_LINK_REVOKED). */
declare const LINK_REVOKED_MESSAGE = "this link has been revoked";
/**
 * WebSocket close code Glass sends for a viewer refused at a viewer limit: the engine's limit on
 * relay viewers, or the session's own. Not final: a place can free up, so a reconnect keeps trying
 * with its usual backoff, and a first connect fails with VIEWER_LIMIT_MESSAGE.
 */
declare const CLOSE_VIEWER_LIMIT = 4503;
/** The error a first connect fails with when Glass refused it at its viewer limit (CLOSE_VIEWER_LIMIT). */
declare const VIEWER_LIMIT_MESSAGE = "at the viewer limit; try again later";

/**
 * Why a GlassClient closed, for programs (the "closed" event's second argument); the first
 * argument is a sentence for people. `session_not_found`, `link_expired` and `link_revoked` are
 * Glass's close codes 4404, 4401 and 4403; `source_failed` and `session_not_resumable` are its
 * signaling error codes; `protocol_mismatch` means this client and the engine speak different
 * protocol versions; the rest are this client's own.
 */
type GlassCloseCode = "session_not_found" | "link_expired" | "link_revoked" | "source_failed" | "session_not_resumable" | "protocol_mismatch" | "connect_failed" | "connection_lost" | "reconnect_exhausted" | "client_disconnected";
/** The "refused" event's code: Glass refused this attempt for now (close code 4503). */
type GlassRefusedCode = "viewer_limit";
declare function createGlassSession(options?: GlassCreateSessionOptions): Promise<GlassSession>;
declare function redeemGlassTicket({ ticket, baseUrl }: {
    ticket: string;
    baseUrl?: string;
}): Promise<GlassSession>;
/** A session ticket from glass gate, and the engine to redeem it with. */
interface GlassGateTicket {
    /** The engine's public address: pass it to redeemGlassTicket as baseUrl. */
    engine: string;
    /** A session ticket, good for one session, redeemed at once. */
    ticket: string;
}
/**
 * What glass gate asks for: nothing for an `open` gate, the shared phrase for a
 * `passphrase` gate, a minted link's code for a `links` gate.
 */
interface GlassGateCredentials {
    code?: string;
    passphrase?: string;
}
/** Where glass gate is, and what it asks for. */
interface GlassGateRequest extends GlassGateCredentials {
    /** The gate's address, http(s)://host[:port]. */
    gate: string;
}
/**
 * The gate refused a ticket. `code` is the gate's: `gate_refused` (a wrong
 * passphrase, or a link not valid, expired or used up), `rate_limited` (see
 * retryAfterSeconds), `origin_not_allowed`, `unavailable`.
 */
declare class GlassGateError extends Error {
    readonly status: number;
    readonly code?: string | undefined;
    readonly retryAfterSeconds?: number | undefined;
    constructor(message: string, status: number, code?: string | undefined, retryAfterSeconds?: number | undefined);
}
declare function requestGateTicket({ gate, code, passphrase }: GlassGateRequest): Promise<GlassGateTicket>;
declare function deleteGlassSession({ id, baseUrl, apiToken }: GlassEngine & {
    id: string;
}): Promise<void>;
declare function mintGlassLink({ sessionId, rights, baseUrl, apiToken, }: GlassEngine & {
    sessionId: string;
    rights: GlassLinkRequest;
}): Promise<GlassLink>;
declare function revokeGlassLink({ sessionId, linkId, baseUrl, apiToken }: GlassEngine & {
    sessionId: string;
    linkId: string;
}): Promise<void>;
declare class GlassClient extends Emitter<GlassClientEventMap> {
    constructor(options: GlassClientOptions);
    connect(): Promise<void>;
    sources(): GlassSourceInfo[];
    source(id: string): GlassSource;
    publish(track: MediaStreamTrack, options: GlassPublishOptions): GlassPublication;
    publications(): GlassPublication[];
    connectionId(): string | null;
    isOwner(): boolean;
    rights(): GlassClientRights | null;
    members(): GlassMember[];
    recording(): boolean;
    connectionQuality(): GlassConnectionQuality | null;
    sendInitialViewport(width: number, height: number, isMobile?: boolean, userAgent?: string, userAgentData?: UserAgentClientHints): void;
    grantMicAccess(): Promise<void>;
    denyMicAccess(): void;
    notePresentedFrame(rtpTimestamp: number, expectedDisplayTime: number): void;
    inputLatencyStats(): InputLatencyStats;
    isConnected(): boolean;
    getStats(): Promise<GlassStats | null>;
    disconnect(): void;
}
declare function createGlassClient(options: GlassClientOptions): GlassClient;

export {
    CLOSE_LINK_EXPIRED,
    CLOSE_LINK_REVOKED,
    CLOSE_SESSION_NOT_FOUND,
    CLOSE_VIEWER_LIMIT,
    type ElementState,
    type GlassCapabilities,
    GlassClient,
    type GlassClientEventMap,
    type GlassClientOptions,
    type GlassClientRights,
    type GlassCloseCode,
    type GlassConnectionQuality,
    type GlassConnectionQualityLevel,
    type GlassContentHint,
    type GlassControlAnswer,
    type GlassCreateSessionOptions,
    type GlassDialog,
    type GlassEngine,
    type GlassGateCredentials,
    GlassGateError,
    type GlassGateRequest,
    type GlassGateTicket,
    type GlassInputDrop,
    type GlassInputDropCode,
    type GlassInputMode,
    type GlassLink,
    type GlassLinkRequest,
    type GlassMember,
    type GlassPlaybackState,
    GlassPublication,
    type GlassPublicationEvents,
    type GlassPublishKind,
    type GlassPublishOptions,
    type GlassReconnectOptions,
    type GlassRefusedCode,
    type GlassRights,
    type GlassSession,
    GlassSource,
    type GlassSourceInfo,
    type GlassSourceKind,
    type GlassSourceRequest,
    type GlassSourceState,
    type GlassStats,
    type GlassTimelineEvent,
    type GlassVideoCodec,
    type InputLatencySample,
    type InputLatencyStats,
    type InputLatencySummary,
    type InteractiveElement,
    type KeyEvent,
    LINK_EXPIRED_MESSAGE,
    LINK_REVOKED_MESSAGE,
    type MouseButton,
    type NavigationState,
    SESSION_NOT_FOUND_MESSAGE,
    SUPPORTED_PROTOCOL_VERSION,
    type TouchDispatchType,
    type TouchPoint,
    type UserAgentClientHints,
    VIEWER_LIMIT_MESSAGE,
    createGlassClient,
    createGlassSession,
    deleteGlassSession,
    mintGlassLink,
    redeemGlassTicket,
    requestGateTicket,
    revokeGlassLink,
};
