// GlassClient's private constants and helpers, shared by its modules.

export const DEFAULT_RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];

// How often measured input latency is sent to Glass for its log.
export const INPUT_LATENCY_REPORT_MS = 5000;

export const SESSION_NOT_FOUND_MESSAGE = "session not found or expired";

export const DEFAULT_MAX_RECONNECT_ATTEMPTS = 8;

export const MOUSE_BATCH_INTERVAL_MS = 16; // ~60fps

// Real, live-found bug (2026-09-04, low-CPU stutter investigation): a
// strict `elapsed < MOUSE_BATCH_INTERVAL_MS` comparison against Date.now()
// (1ms resolution) aliases against setInterval's own real-world jitter -
// browsers commonly fire a 16ms interval at 16.6-17ms, but occasionally at
// 15.x, which Date.now() truncates down to a reported 15ms elapsed. That
// single-ms miss fails the guard and skips the whole tick, doubling that
// gap to ~32ms - producing a bimodal 16/32ms send cadence (choppy cursor
// tracking) instead of a clean 16ms one, at zero CPU cost either way. This
// tolerance absorbs exactly that truncation without meaningfully loosening
// the real rate limit either guard exists for.
export const MOUSE_BATCH_TOLERANCE_MS = 2;

export const SIGNALING_TIMEOUT_MS = 10000;

export const PEER_TIMEOUT_MS = 15000;

// How long a peer connection may sit in "disconnected" before we give up on it
// self-healing and fall back to a full reconnect. Per the WebRTC spec
// "disconnected" is explicitly a transient state - ICE consent checks have gone
// quiet but the agent is still trying, and it very often recovers on its own
// (a brief WiFi blip, a NAT rebind). Tearing down immediately would turn every
// such blip into a visible reconnect; waiting forever is what the old ICE-restart
// path effectively did. "failed" is terminal per spec and is NOT debounced.
export const DISCONNECTED_GRACE_MS = 4000;

// authHeaders builds the Authorization header for a REST call, shared by
// every call site that needs one (createGlassSession, deleteGlassSession,
// GlassClient's page-unload beacon) - found by code review (reuse angle):
// the same `if (apiToken) headers["Authorization"] = \`Bearer ${apiToken}\`;`
// line was previously repeated verbatim at all three, which meant a future
// change to the auth scheme (a different header name, an extra required
// header) could easily be applied to two of the three and silently miss
// the third - most plausibly the page-unload beacon, the least likely path
// to be exercised during manual testing.
export function authHeaders(apiToken?: string): HeadersInit {
  return apiToken ? { Authorization: `Bearer ${apiToken}` } : {};
}

// Derives the http(s) origin from a ws(s):// signaling URL, for the session
// DELETE call. Falls back to same-origin ("") if it can't be parsed.
export function originOf(signalingUrl: string): string {
  try {
    const u = new URL(signalingUrl);
    const httpProto = u.protocol === "wss:" ? "https:" : "http:";
    return `${httpProto}//${u.host}`;
  } catch {
    return "";
  }
}

// Extracts {id} out of a .../v1/sessions/{id}/signaling signaling URL, for
// downloadUrl() - see that method's own doc comment for why this is
// preferred over the optional GlassClientOptions.sessionId field. Returns
// null if signalingUrl doesn't match the expected shape (unparseable, or a
// relay-sessions/produce URL some other caller passed in) rather than
// guessing.
export function sessionIdFromSignalingUrl(signalingUrl: string): string | null {
  try {
    const u = new URL(signalingUrl);
    const match = u.pathname.match(/\/v1\/sessions\/([^/]+)\/signaling$/);
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}
