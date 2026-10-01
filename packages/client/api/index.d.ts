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
}
interface GlassRosterEntry {
    connectionId: string;
    producesInput: boolean;
    isOwner: boolean;
}
type GlassSlotState = "empty" | "live" | "stalled";
interface GlassSession {
    id: string;
    signalingUrl: string;
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
    /** Cap on the video sender's bitrate in kbps (default 1000; 0 = uncapped). Keep it below the uplink's capacity. */
    maxBitrateKbps?: number;
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
    /** Sleeps for ms, or less if the page comes back online or into view. */
    /** One connection attempt: resolves once connected, rejects if it can't get there. */
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
    statsIntervalMs?: number;
    deleteSessionOnClose?: boolean;
    sessionBaseUrl?: string;
    apiToken?: string;
}
type GlassClientEventMap = {
    videoTrack: [stream: MediaStream];
    state: [state: ElementState];
    navigation: [nav: NavigationState];
    interactiveElements: [elements: InteractiveElement[]];
    clipboardText: [text: string];
    consoleMessage: [level: string, text: string];
    downloadReady: [filename: string, guid: string];
    fileChooserOpened: [multiple: boolean];
    fileChooserClosed: [];
    micAccessRequested: [origin: string];
    error: [message: string];
    connected: [];
    disconnected: [];
    reconnecting: [attempt: number, maxAttempts: number];
    stats: [stats: GlassStats];
    capabilitiesChanged: [
        connectionId: string,
        producesInput: boolean,
        isSelf: boolean
    ];
    inputRequested: [connectionId: string];
    rosterChanged: [connections: GlassRosterEntry[]];
    slotStateChanged: [slots: Record<string, GlassSlotState>];
    inputLatency: [sample: InputLatencySample];
    closed: [reason: string];
    newTabRequested: [url: string];
};
/**
 * WebSocket close code Glass sends for a session that doesn't exist: never created, closed, or swept
 * before anyone connected. Retrying can't help.
 */
declare const CLOSE_SESSION_NOT_FOUND = 4404;
declare const SUPPORTED_PROTOCOL_VERSION = 1;
declare function createGlassSession(baseUrl?: string, apiToken?: string, audioInput?: boolean): Promise<GlassSession>;
declare function deleteGlassSession(id: string, baseUrl?: string, apiToken?: string): void;
declare function mintConnectionGrant(sessionId: string, capabilities: Partial<GlassConnectionCapabilities>, baseUrl?: string, apiToken?: string): Promise<GlassConnectionGrant>;
declare class GlassClient extends Emitter<GlassClientEventMap> {
    constructor(options: GlassClientOptions);
    connect(): Promise<void>;
    get pixelTraceEnabled(): boolean;
    get decodeReadbackEnabled(): boolean;
    reportPixelTraceSamples(samples: {
        rtpTimestamp: number;
        paintedAtMs: number;
    }[]): void;
    navigate(url: string): void;
    requestInput(): void;
    grantMicAccess(): Promise<void>;
    denyMicAccess(): void;
    releaseInput(): void;
    connectionId(): string | null;
    producesInput(): boolean;
    isOwner(): boolean;
    connections(): GlassRosterEntry[];
    notePresentedFrame(rtpTimestamp: number, expectedDisplayTime: number): void;
    inputLatencyStats(): InputLatencyStats;
    slotStates(): Record<string, GlassSlotState>;
    grantInput(connectionId: string): void;
    revokeInput(connectionId: string): void;
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
    CLOSE_SESSION_NOT_FOUND,
    type ElementState,
    type GlassCapabilities,
    GlassClient,
    type GlassClientEventMap,
    type GlassClientOptions,
    type GlassConnectionCapabilities,
    type GlassConnectionGrant,
    GlassProducer,
    type GlassProducerEvents,
    type GlassProducerOptions,
    type GlassReconnectOptions,
    type GlassRosterEntry,
    type GlassSession,
    type GlassSlotState,
    type GlassStats,
    type InputLatencySample,
    type InputLatencyStats,
    type InputLatencySummary,
    type InteractiveElement,
    type KeyEvent,
    type NavigationState,
    type ProducerSession,
    type ProducerState,
    type ProducerStats,
    SUPPORTED_PROTOCOL_VERSION,
    type TouchDispatchType,
    type TouchPoint,
    type UserAgentClientHints,
    createGlassClient,
    createGlassSession,
    deleteGlassSession,
    mintConnectionGrant,
};
