// The example's build-time configuration (Vite env vars).

// This example runs standalone (`npm run dev`), a genuinely different origin
// from the `glass start` backend it talks to - Glass has no product frontend
// and never serves this itself. VITE_GLASS_ADDR overrides the default for
// anyone not running the backend on localhost:8080; the backend's CORS
// policy allows any loopback/private-LAN origin, not
// just this one, so this doesn't need to match any specific dev-server port.
export const GLASS_ADDR = import.meta.env.VITE_GLASS_ADDR ?? "http://localhost:8080";

// Optional TURN/STUN override for this browser peer's own RTCPeerConnection -
// mirrors the backend's GLASS_STUN_URLS/GLASS_TURN_URLS/etc. Unset by default, falling back to @glass/client's own public-
// STUN default - only matters when testing/deploying against a real TURN
// server, since the backend and this browser peer each gather their own ICE
// candidates independently and need to agree on where the TURN server is.
// VITE_GLASS_ICE_TRANSPORT_POLICY=relay forces this peer to relay-only ICE -
// useful to prove a TURN server actually relays media, since on a LAN or
// same-machine test a direct/STUN path would otherwise succeed first and
// mask a broken TURN config entirely.
function iceServersFromEnv(): RTCIceServer[] | undefined {
  const stunURLs = import.meta.env.VITE_GLASS_STUN_URLS as string | undefined;
  const turnURLs = import.meta.env.VITE_GLASS_TURN_URLS as string | undefined;
  if (!stunURLs && !turnURLs) return undefined;

  const servers: RTCIceServer[] = [];
  if (stunURLs) {
    servers.push({ urls: stunURLs.split(",").map((u) => u.trim()) });
  }
  if (turnURLs) {
    servers.push({
      urls: turnURLs.split(",").map((u) => u.trim()),
      username: import.meta.env.VITE_GLASS_TURN_USERNAME,
      credential: import.meta.env.VITE_GLASS_TURN_CREDENTIAL,
    });
  }
  return servers;
}

export const ICE_SERVERS = iceServersFromEnv();
export const ICE_TRANSPORT_POLICY = import.meta.env
  .VITE_GLASS_ICE_TRANSPORT_POLICY as RTCIceTransportPolicy | undefined;

// Optional dev-testing convenience, mirroring the backend's GLASS_API_TOKEN
// - unset by default (auth off,
// unchanged behavior). NOT how a real deployment should work: a genuine
// GLASS_API_TOKEN is a server-side secret that belongs in your own backend,
// which creates the session and hands this app only the resulting
// signalingUrl (already carrying whatever the runtime needs - see
// createGlassSession's doc comment in @glass/client) - never in a value
// baked into a browser bundle via VITE_*, which anyone can read from the
// shipped JS. This exists purely so this standalone example can be
// exercised end-to-end against a token-gated runtime during local testing.
export const API_TOKEN = import.meta.env.VITE_GLASS_API_TOKEN as string | undefined;

// Requests the mic-capable browser pool at session-creation time (see
// createGlassSession's own audioInput param) - a build-time flag
// rather than a runtime UI toggle for now, same reasoning as API_TOKEN
// above: this is a local-testing knob for exercising AudioInput
// end-to-end, not a real product setting.
export const AUDIO_INPUT = import.meta.env.VITE_GLASS_AUDIO_INPUT === "true";

// Dev-testing-only knobs for @glass/client's internal, undocumented trace
// diagnostics (see index.ts's InternalGlassClientOptions/
// traceReportIntervalMs/pixelTraceEnabled doc comments - deliberately not
// part of the public GlassClientOptions surface yet). Not real env vars a
// production deployment would ever set; this example app exposes them
// purely so a live verification pass can flip them on without editing
// @glass/client itself.
export const TRACE_REPORT_INTERVAL_MS = import.meta.env
  .VITE_GLASS_TRACE_REPORT_INTERVAL_MS
  ? Number(import.meta.env.VITE_GLASS_TRACE_REPORT_INTERVAL_MS)
  : undefined;
export const PIXEL_TRACE_ENABLED =
  import.meta.env.VITE_GLASS_PIXEL_TRACE_ENABLED === "true";
// Mirrors PIXEL_TRACE_ENABLED exactly - see encoded_stream_check.ts's own
// header comment for why this one carries real per-frame CPU cost and
// should only ever be flipped on for a deliberate live-verification pass,
// never left on. Also needs the backend's GLASS_DEBUG_ENCODED_FRAME_CHECK=true
// set - the two
// flags are independent, both required for either side's log lines to
// produce anything.
export const ENCODED_STREAM_CHECK_ENABLED =
  import.meta.env.VITE_GLASS_ENCODED_STREAM_CHECK_ENABLED === "true";
// Mirrors PIXEL_TRACE_ENABLED/ENCODED_STREAM_CHECK_ENABLED exactly - see
// decode_readback_check.ts's own header comment. Renders a small on-screen
// canvas mirroring the video element's actual decoded frames, for a human
// to visually compare against the real video during a live-verification
// pass - purely a visual aid, reports nothing back to the backend.
export const DECODE_READBACK_ENABLED =
  import.meta.env.VITE_GLASS_DECODE_READBACK_ENABLED === "true";
// See index.ts's InternalGlassClientOptions.__internalJitterBufferTargetMs
// doc comment - a real product-latency tradeoff being tested, not a
// default change. Unset preserves today's fixed-near-zero-latency default.
// The literal string "native" (not a number) skips the override entirely,
// leaving Chromium's own adaptive jitter buffer in control - see that same
// doc comment for why that's a materially different test from any fixed
// number.
const rawJitterBufferTarget = import.meta.env.VITE_GLASS_JITTER_BUFFER_TARGET_MS;
export const JITTER_BUFFER_TARGET_MS: number | "native" | undefined =
  rawJitterBufferTarget === "native"
    ? "native"
    : rawJitterBufferTarget
      ? Number(rawJitterBufferTarget)
      : undefined;
