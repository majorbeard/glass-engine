# Glass Protocol

This document describes the wire contract between the Glass runtime (Go
backend) and a viewer/client, as it exists today. It is the authoritative
reference — if code and docs disagree, that's a bug in one of them.

There are three layers:

- **Session HTTP API**, a REST surface for creating and managing sessions.
  Each session reserves one browser from the pool.
- **Signaling**, over a WebSocket at `/v1/sessions/{id}/signaling`. Used to
  negotiate the WebRTC connection for an already-created session, and to
  carry a handful of control messages that predate the DataChannel being
  open.
- **DataChannel**, once the WebRTC connection is established. Carries input
  (client → server) and JSON state updates (server → client). Video does
  **not** travel over the DataChannel — it arrives as a real WebRTC media
  track (RTP, H.264), negotiated in the same offer/answer exchange as the
  DataChannel but delivered by the browser's own WebRTC stack, not this
  protocol. `backend/internal/browser/frame_sink.go` fans encoded H.264
  access units out to that track.

Versioning: there is no version field on any of these yet, beyond the `/v1`
path prefix on the REST API. The protocol is pre-1.0 and may change without
a compatibility shim. A response version field should be added before the
first external release (see the evolution plan's open decisions).

## Session HTTP API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/healthz` | Liveness check. `200 {"status":"ok"}`. |
| `GET` | `/v1/info` | Runtime status: `{"sessions":{"active":N,"capacity":C},"uptimeSeconds":N}`. |
| `POST` | `/v1/sessions` | Reserve a browser and create a session. `201 {"id":"...","signalingUrl":"ws://.../v1/sessions/{id}/signaling"}`. `503` if at capacity or shutting down. |
| `GET` | `/v1/sessions/{id}` | Session status: `{"id","state":"pending"\|"active"\|"closed","createdAt","connectedAt"?}`. `404` if unknown. |
| `DELETE` | `/v1/sessions/{id}` | Explicitly close a session and release its browser. `204` on success, `404` if unknown. |
| `GET` | `/v1/sessions/{id}/signaling` | Upgrade to the signaling WebSocket for this session (see below). `404` if the session doesn't exist, `409` if it already has a connection. |

Session lifecycle: `POST /v1/sessions` reserves a browser immediately and
returns `pending`. The client is expected to open the returned
`signalingUrl` promptly — a pending session that never connects is
automatically closed after an idle timeout (`Config.PendingTTL`, default
30s) so an abandoned `POST` can't hold a browser hostage. Once the signaling
WebSocket connects, the session moves to `active` and stays that way for the
life of that connection; when the WebSocket closes for any reason, the
session is closed and its browser is released back to the pool. A session
supports exactly one signaling connection — reconnecting requires creating a
new session.

## Signaling (WebSocket, `/v1/sessions/{id}/signaling`)

All signaling messages are JSON with a `type` field. The server upgrades the
HTTP connection, then immediately performs the offer/answer exchange.

### Client → Server

| `type` | Fields | Purpose |
|---|---|---|
| `answer` | `sdp: string` | SDP answer, in response to the server's offer. |
| `ice-candidate` | `candidate: RTCIceCandidateInit` | ICE candidate trickled from the client. |
| `navigate` | `sdp: string` (holds the target URL, not an SDP blob) | Request navigation before/without using the DataChannel. |
| `initial_viewport` | `width, height: number`, `isMobile?: boolean`, `userAgent?: string` | Reported once, right after connect, before the first resize. `isMobile`/`userAgent` are optional — omitted or `isMobile: false` leaves the browser in its default desktop emulation state (`Mobile: false`, no UA override). When `isMobile: true`, the server applies CDP mobile viewport emulation and, if `userAgent` is non-empty, a matching `Network.setUserAgentOverride`. Intended to relay the *client's own* `navigator.userAgent` when it's a real phone, not a fabricated string. |

### Server → Client

| `type` | Fields | Purpose |
|---|---|---|
| `offer` | `sdp: string` | SDP offer, sent immediately after signaling connects. |
| `answer` | `sdp: string` | Only used if the server ever originates an offer/answer itself (not currently exercised). |
| `ice-candidate` | `candidate: RTCIceCandidateInit` | ICE candidate trickled from the server. |
| `new_tab_request` | `url: string` | The page tried to open a popup/new tab; the client decides what to do with the URL. |

There is currently no `error` message on the signaling channel — connection
failures are only logged server-side and surface to the client as a closed
WebSocket. A `session_created` / `session_closed` / explicit `error` message
set is planned (see the evolution plan's Phase 3+), but not implemented yet.

Reusing the `sdp` field to carry a plain URL for `navigate` is a wart, not a
feature — kept as-is here because both sides already agree on it, but a
`url` field would be cleaner if this message is revisited.

## DataChannel input (client → server)

Every input message is a JSON string with the shape:

```json
{ "type": "<action>", "data": { ... } }
```

| `type` | `data` fields | Notes |
|---|---|---|
| `mousemove` | `x, y: number`, `dragging: boolean` | Batched client-side at ~60fps; sent immediately while dragging. |
| `mousedown` | `x, y: number` | |
| `mouseup` | `x, y: number` | |
| `scroll` | `deltaY: number` | |
| `touchstart` / `touchmove` | `points: [{x, y, id: number}, ...]` | Dispatched via CDP's native touch input (`Input.dispatchTouchEvent`), not synthesized mouse events, so pages with touch-specific handling (`ontouchstart`, pointer-type checks) behave as they would on a real device. Capped server-side at 5 points. |
| `touchend` / `touchcancel` | `points: [...]` (ignored) | Per CDP's own contract, `touchEnd`/`touchCancel` are dispatched with zero points regardless of what the client sends — only the *set* of lifted fingers matters, and CDP doesn't want them re-listed. |
| `keydown` / `keyup` | `key, code: string`, `modifiers: number` | `modifiers` is a bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8. |
| `navigate` | `url: string` | Equivalent to the signaling `navigate` message; either path works. |
| `back` | *(none)* | |
| `forward` | *(none)* | |
| `refresh` | *(none)* | |
| `set_viewport` | `width, height: number` | Equivalent to the signaling `initial_viewport` message; used for later resizes. |
| `copy_text` | *(none)* | Reads the page's current text selection server-side. Response delivery back to the client is not implemented yet (see `handleInputEvent` in `webrtc_handler.go`). |
| `paste_text` | `text: string` | |

Every numeric field above (mouse coordinates, scroll delta, viewport
dimensions, touch points) is checked by `internal/security.InputValidator`
before dispatch — range bounds, integer-ness for viewport dimensions, and
NaN/Infinity rejection — via `BrowserManager.ValidateInput`/
`ValidateKeyInput`. Touch points additionally go through
`ValidateTouchInput`, which caps the point count at 5. Invalid
input is still dropped silently today (logged server-side only). The
`0xFF Error` type below is wired up, but only for one specific fatal
condition (the H.264 encoder failing to start/restart) — routine per-message
input validation failures don't use it yet. This also covers
the signaling-layer `initial_viewport` message, which goes through the same
`set_viewport` bounds check. `ValidateNavigationURL` (used by `Navigate`) also
blocks link-local addresses (`169.254.0.0/16`, `fe80::/10`) in addition to
localhost and RFC1918/ULA ranges, closing a cloud-metadata-endpoint SSRF gap.

## DataChannel binary messages (server → client)

Every binary message starts with a one-byte message type, defined once in
`backend/internal/protocol/protocol.go` (`MessageType`). The frontend's
`MessageType` enum in `examples/viewer-preact/src/services/webrtc.ts` must
mirror this exactly — there is no code generation tying them together, so a
change to one must be reflected in the other by hand until that's automated.

Ranges:

```
0x01-0x0F  Control/state messages (JSON)
0xF0-0xFF  Error/reserved
```

The `0x10-0x1F` frame-message range (`IFrame`/`PFrame`/`ChunkedFrame`/
`RawTexture`/`H264Frame`) and `0x20-0x2F` (reserved for chunking) are
retired — video used to travel over the DataChannel as chunked JPEG/H.264
messages, encoded/decoded/reassembled by hand on both ends. The RTP video
migration replaced all of that with a real WebRTC media track (see the
DataChannel section above), so as of that migration the backend never emits
any byte in `0x10-0x2F` and the frontend has no decoder for them. Removed
from both `protocol.go` and `webrtc.ts` rather than kept as dead reserved
values.

| Byte | Name | Layout | Status |
|---|---|---|---|
| `0x05` | `ElementStateUpdate` | `[type][JSON: {cursor}]` | Live |
| `0x06` | `NavigationState` | `[type][JSON: {url, loading, canGoBack, canGoForward}]` | Live |
| `0x07` | `ViewportSize` | `[type][int32 LE width][int32 LE height]` | Live |
| `0x08` | `PerformanceStats` | `[type][JSON: {memAllocMB, totalBytesSentMB, framesSent, framesSkipped, largeChangePercent}]` | Defined, not yet emitted. The frontend `BrowserHeader` stats menu already has a UI slot waiting for this. |
| `0xFF` | `Error` | `[type][JSON: {error}]` | Live, but narrow: the only producer today is the H.264 encoder failing to (re)start (`screencast_webrtc.go`'s `Start()`/`reestablishScreencastLocked()`) — there is no fallback video renderer anymore, so this is how the backend tells the client "video is dead" instead of it just silently freezing. Not yet used for routine input-validation failures (see above). |

## Testing

`backend/internal/protocol/protocol_test.go` covers:

- Every `MessageType` constant is unique (fails loudly if a future change
  reintroduces a collision).
- Round-trip encode → decode for every JSON-carrying message type.
- Byte-exact layout for `ViewportSize` (the one fixed-binary, non-JSON
  control message).

The frame-chunking and H.264/JPEG framing logic in
`internal/browser/screencast_webrtc.go` is not covered by automated tests —
it's exercised through `ScreencastEngineWebRTC`, which owns a live WebRTC
DataChannel and isn't currently mockable without a larger refactor. It's
verified manually today (see the evolution plan's smoke-test checklist).

`backend/internal/sessions/manager_test.go` covers the session lifecycle
against a fake, channel-backed browser pool (`BrowserSource` interface, so
tests don't need to launch real Chrome): capacity enforcement and predictable
rejection once full, close freeing capacity back up, idempotent close, the
pending-session idle sweep (and that an active session survives it),
`MarkConnecting` being exclusive (one signaling connection per session), and
`Shutdown` closing every session and releasing their browsers.
