// GlassClient's private constants and helpers, shared by its modules.

export const DEFAULT_RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];

// How often measured input latency is sent to Glass for its log.
export const INPUT_LATENCY_REPORT_MS = 5000;

export const SESSION_NOT_FOUND_MESSAGE = "session not found or expired";

// The reason a failed HTTP response gives. Glass answers every error with
// {"error": message, "code": code}; anything else (a proxy's page, an empty
// body) falls back to its text, then to the status text.
export async function errorDetail(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const body = JSON.parse(text);
    if (body && typeof body.error === "string") {
      return body.code ? `${body.error} (${body.code})` : body.error;
    }
  } catch {
    // Not JSON.
  }
  return text || res.statusText;
}

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
// every call site that needs one (the session and link helpers), so a change
// to the auth scheme reaches them all.
export function authHeaders(apiToken?: string): HeadersInit {
  return apiToken ? { Authorization: `Bearer ${apiToken}` } : {};
}

// originOf is the http(s) origin of a ws(s):// link, for the source routes
// (downloads, uploads). "" (same origin) if it can't be parsed.
export function originOf(link: string): string {
  try {
    const u = new URL(link);
    const httpProto = u.protocol === "wss:" ? "https:" : "http:";
    return `${httpProto}//${u.host}`;
  } catch {
    return "";
  }
}

// linkParts is the session id and token of a link,
// .../v1/sessions/{id}/connect?token=..., or null for anything else.
export function linkParts(link: string): { sessionId: string; token: string | null } | null {
  try {
    const u = new URL(link);
    const match = u.pathname.match(/\/v1\/sessions\/([^/]+)\/connect$/);
    return match?.[1] ? { sessionId: decodeURIComponent(match[1]), token: u.searchParams.get("token") } : null;
  } catch {
    return null;
  }
}
