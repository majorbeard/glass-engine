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
interface GlassConnectionCapabilities {
    producesMedia: boolean;
    consumesMedia: boolean;
    producesInput: boolean;
    consumesInput: boolean;
}
interface GlassConnectionGrant {
    signalingUrl: string;
    connectionCapabilities: GlassConnectionCapabilities;
    produceUrl?: string;
    linkId: string;
    expiresAt?: string;
}
type GlassGrantRequest = Partial<GlassConnectionCapabilities> & {
    expiresIn?: number;
};
/**
 * Glass's one answer to a control request: requestInput(), releaseInput(), grantInput() or
 * revokeInput(). `outcome` is the state the request leaves: asking for what this connection
 * already holds is "granted", not refused. "relayed" means nobody could be given control now, so
 * the request went to whoever holds it (their "inputRequested" event). `reason` says why a
 * refusal: Glass's own (`not_allowed`: this link never included control; `not_owner`;
 * `no_capacity`; `unknown_connection`; `rate_limited`; `invalid`) or this client's
 * (`not_connected`, `disconnected`: the connection went before Glass answered).
 */
interface GlassControlAnswer {
    action: "request_input" | "release_input" | "grant_input" | "revoke_input";
    outcome: "granted" | "relayed" | "released" | "revoked" | "refused";
    reason?: "not_allowed" | "not_owner" | "no_capacity" | "unknown_connection" | "rate_limited" | "invalid" | "not_connected" | "disconnected" | (string & {});
    /** The connection a grant or revoke was about. */
    connectionId?: string;
}
interface GlassRosterEntry {
    connectionId: string;
    producesInput: boolean;
    isOwner: boolean;
}
type GlassSlotState = "empty" | "live" | "stalled";
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
interface GlassCreateSessionOptions extends GlassEngine {
    audioInput?: boolean;
    contentHint?: GlassContentHint;
    codec?: GlassVideoCodec;
    inputMode?: GlassInputMode;
    inspect?: boolean;
    linkExpiresIn?: number;
}
interface GlassSession {
    id: string;
    signalingUrl: string;
    linksExpireAt?: string;
    watchUrls?: string[];
    contentHint?: GlassContentHint;
    codec?: GlassVideoCodec;
    inputMode?: GlassInputMode;
    inspect?: boolean;
    protocolVersion?: number;
    sourceType?: string;
    capabilities?: GlassCapabilities;
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

type ProducerState = "idle" | "creating-session" | "connecting" | "streaming"
/** The connection dropped after streaming started; resuming, or making a new session. */
 | "reconnecting" | "error" | "stopped";
/** The relay session a producer is sending into. */
interface ProducerSession {
    id: string;
    /** Consumer signaling URL: what a viewer needs to watch this session. Empty when joining an existing session via produceUrl. */
    signalingUrl: string;
    /** The produce URL this producer uses for its slot. */
    produceUrl: string;
    /** The named stream slot this producer fills. */
    slot: string;
    /**
     * Every slot's produce URL, when this producer created the session: hand the others to other
     * producers (each joins with `produceUrl`). Absent when joining an existing session.
     */
    produceUrls?: Record<string, string>;
}
/** Send-side telemetry, polled every 2 s while connected. */
interface ProducerStats {
    capturedAt: number;
    /** Frames per second the source track delivers, before encoding. */
    sourceFps: number | null;
    uploadBitrateKbps: number;
    framesSent: number;
    frameWidth: number | null;
    frameHeight: number | null;
    rttMs: number | null;
    /** From remote-inbound-rtp; null when the browser doesn't report it (0 is a real value). */
    packetsLost: number | null;
    /**
     * With simulcast, each layer the browser sends, smallest first; null with one encoding. The
     * fields above then describe the largest layer, and uploadBitrateKbps all of them together.
     */
    layers: ProducerLayerStats[] | null;
    /** The video encoder the browser reports (its encoderImplementation), null when it doesn't say. */
    encoder: string | null;
    /** Whether that encoder is a hardware one (the browser's powerEfficientEncoder), null when it doesn't say. */
    hardwareEncoder: boolean | null;
    /** Battery Status API, where the browser has it. */
    battery: {
        level: number;
        charging: boolean;
    } | null;
    /** Network Information API, where the browser has it. */
    network: {
        type: string | null;
        effectiveType: string | null;
        downlinkMbps: number | null;
    } | null;
}
interface ProducerLayerStats {
    rid: string;
    width: number | null;
    height: number | null;
    framesPerSecond: number | null;
    bitrateKbps: number;
}
interface GlassProducerOptions {
    /** What to send: its first video track, and its first audio track if it has one. The caller owns it. */
    stream: MediaStream;
    /** Base HTTP(S) URL of the Glass server. Required unless produceUrl is given. */
    serverUrl?: string;
    /** GLASS_API_TOKEN, if the server requires one. */
    apiToken?: string;
    /** Slots to declare when creating the session (must include "main"). Default: one slot, "main". */
    slots?: string[];
    /** Which slot this producer fills. Default "main". */
    slot?: string;
    /**
     * Produce into an existing session instead of creating one: the slot's produce URL from
     * POST /v1/relay-sessions. The producer then only ever resumes that session; if the resume window
     * passes it ends in "error", because it can't replace a session it doesn't own.
     */
    produceUrl?: string;
    /** ICE servers for this producer's own peer connection. Default: a public STUN server. */
    iceServers?: RTCIceServer[];
    /**
     * Cap on the video sender's bitrate in kbps (default 1000; 0 = uncapped). Keep it below the uplink's capacity.
     * With simulcast it caps the full-size layer only: the smaller layers add their own (about 150 and 350
     * kbit/s at 720p), so the upload is the cap plus those. A higher cap sharpens the full layer on a good
     * link but makes the browser's simulcast fragile on a weak one: in Chrome, with the uplink squeezed, a
     * cap of 1500 lost every layer at 500 kbit/s of uplink and 2000 at 900, while the default 1000 held at both.
     */
    maxBitrateKbps?: number;
    /**
     * Send the video as several layers of the same picture (simulcast), so Glass can send viewers a smaller
     * one while the full one is not arriving steadily (every viewer of a session gets the same layer):
     * three (quarter, half and full size) for a camera 540 high or more, two (half and full)
     * for one 360 high or more, and one below that. Off by default: it costs the device about a quarter more
     * upload and an encoder per layer. The session must be a simulcast one; when this producer creates the
     * session, it asks for one.
     */
    simulcast?: boolean;
    /** Chromium's starting-bitrate hint in kbps (default min(500, cap)). Other browsers ignore it. */
    startBitrateKbps?: number;
    /** Re-establish the connection after a drop (default true). */
    reconnect?: boolean;
    /** How long to keep resuming the same session before giving up on it (default 45000 ms). */
    resumeWindowMs?: number;
}
type GlassProducerEvents = {
    state: [state: ProducerState, detail?: string];
    /** The session this producer sends into. Fires again if a drop led to a new session. */
    session: [session: ProducerSession];
    stats: [stats: ProducerStats];
    /** Whether the session is being recorded: on connect, then on every change. */
    recording: [active: boolean];
};
/**
 * GlassProducer sends a MediaStream into one slot of a Glass relay session and keeps it there across
 * network changes: on a drop it resumes the same session within the reconnect grace, then (when it
 * created the session) falls back to a new one. See docs/sources/producers.md in glass-engine.
 */
declare class GlassProducer extends Emitter<GlassProducerEvents> {
    constructor(options: GlassProducerOptions);
    get state(): ProducerState;
    /** The current session, once known. */
    get session(): ProducerSession | undefined;
    /**
     * Start producing. Resolves once the first connection is streaming; rejects if that first attempt
     * fails (a bad URL, token or network is the caller's to see). After that, drops are handled
     * internally and reported through "state".
     */
    start(): Promise<void>;
    /** Stop producing and close the session's producer slot deliberately. Doesn't stop the stream's tracks. */
    stop(): void;
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

declare const SESSION_NOT_FOUND_MESSAGE = "session not found or expired";

declare const SUPPORTED_PROTOCOL_VERSION = 2;

interface GlassReconnectOptions {
    maxAttempts?: number;
    delaysMs?: number[];
}
interface GlassClientOptions {
    signalingUrl: string;
    sessionId?: string;
    iceServers?: RTCIceServer[];
    iceTransportPolicy?: RTCIceTransportPolicy;
    reconnect?: boolean | GlassReconnectOptions;
    repairWait?: boolean;
    statsIntervalMs?: number;
    deleteSessionOnClose?: boolean;
    sessionBaseUrl?: string;
    apiToken?: string;
}
type GlassClientEventMap = {
    videoTrack: [stream: MediaStream];
    elementState: [state: ElementState];
    navigation: [nav: NavigationState];
    interactiveElements: [elements: InteractiveElement[]];
    clipboardText: [text: string];
    consoleMessage: [level: string, text: string];
    downloadReady: [filename: string, guid: string];
    fileChooserOpened: [multiple: boolean];
    fileChooserClosed: [];
    micAccessRequested: [origin: string];
    /** A report from Glass; `code` for programs when it has one (`encoder_failed`, `source_failed`, …). */
    error: [message: string, code?: string];
    connected: [];
    disconnected: [];
    reconnecting: [attempt: number, maxAttempts: number];
    refused: [reason: string, code: GlassRefusedCode];
    stats: [stats: GlassStats];
    capabilitiesChanged: [
        connectionId: string,
        producesInput: boolean,
        isSelf: boolean
    ];
    inputRequested: [connectionId: string];
    floorChanged: [connectionId: string | null, isSelf: boolean];
    recording: [active: boolean];
    playback: [state: GlassPlaybackState];
    timeline: [event: GlassTimelineEvent];
    dialog: [dialog: GlassDialog];
    rosterChanged: [connections: GlassRosterEntry[]];
    slotStateChanged: [slots: Record<string, GlassSlotState>];
    connectionQuality: [quality: GlassConnectionQualityLevel, score: number];
    inputDropped: [drop: GlassInputDrop];
    inputLatency: [sample: InputLatencySample];
    closed: [reason: string, code: GlassCloseCode];
    newTabRequested: [url: string];
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
declare function mintConnectionGrant({ sessionId, capabilities, baseUrl, apiToken, }: GlassEngine & {
    sessionId: string;
    capabilities: GlassGrantRequest;
}): Promise<GlassConnectionGrant>;
declare class GlassClient extends Emitter<GlassClientEventMap> {
    constructor(options: GlassClientOptions);
    connect(): Promise<void>;
    navigate(url: string): void;
    requestInput(): Promise<GlassControlAnswer>;
    grantMicAccess(): Promise<void>;
    denyMicAccess(): void;
    releaseInput(): Promise<GlassControlAnswer>;
    connectionId(): string | null;
    producesInput(): boolean;
    floorHolder(): string | null;
    playbackState(): GlassPlaybackState | null;
    controlPlayback(action: "play" | "pause" | "seek", positionMs?: number): void;
    recording(): boolean;
    dialog(): GlassDialog | null;
    answerDialog(accept: boolean, text?: string): void;
    isOwner(): boolean;
    connections(): GlassRosterEntry[];
    notePresentedFrame(rtpTimestamp: number, expectedDisplayTime: number): void;
    inputLatencyStats(): InputLatencyStats;
    connectionQuality(): GlassConnectionQuality | null;
    slotStates(): Record<string, GlassSlotState>;
    grantInput(connectionId: string): Promise<GlassControlAnswer>;
    revokeInput(connectionId: string): Promise<GlassControlAnswer>;
    sendInitialViewport(width: number, height: number, isMobile?: boolean, userAgent?: string, userAgentData?: UserAgentClientHints): void;
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
    downloadUrl(guid: string): string;
    uploadFiles(files: FileList | File[]): Promise<void>;
    dispatchKeyEvent(keyEvent: KeyEvent): void;
    dispatchTouch(type: TouchDispatchType, points: TouchPoint[], gestureId: number, moveCount?: number): void;
    isConnected(): boolean;
    getVideoStream(): MediaStream | null;
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
    type GlassCloseCode,
    type GlassConnectionCapabilities,
    type GlassConnectionGrant,
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
    type GlassGrantRequest,
    type GlassInputDrop,
    type GlassInputDropCode,
    type GlassInputMode,
    type GlassPlaybackState,
    GlassProducer,
    type GlassProducerEvents,
    type GlassProducerOptions,
    type GlassReconnectOptions,
    type GlassRefusedCode,
    type GlassRosterEntry,
    type GlassSession,
    type GlassSlotState,
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
    type NavigationState,
    type ProducerLayerStats,
    type ProducerSession,
    type ProducerState,
    type ProducerStats,
    SESSION_NOT_FOUND_MESSAGE,
    SUPPORTED_PROTOCOL_VERSION,
    type TouchDispatchType,
    type TouchPoint,
    type UserAgentClientHints,
    VIEWER_LIMIT_MESSAGE,
    createGlassClient,
    createGlassSession,
    deleteGlassSession,
    mintConnectionGrant,
    redeemGlassTicket,
    requestGateTicket,
};
