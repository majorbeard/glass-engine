# Glass protocol

The wire contract between Glass and its clients. `@glass/client` implements
all of it; read this page to build a client in another language or to debug
one. For the model behind the messages, read [concepts.md](concepts.md) first.

There are three layers:

- **HTTP API**: create, inspect and close sessions; mint grants; health.
- **Signaling**: a WebSocket per connection. Negotiates WebRTC, then stays
  open for control messages for the connection's whole life.
- **WebRTC**: media as normal RTP tracks; input and state as messages on a
  DataChannel. Video never travels on the DataChannel.

## Versioning

Session-creation responses and `GET /v1/info` carry `protocolVersion`, the
major version of everything on this page. It is currently **1**.

- It changes only for a breaking change: a removed or repurposed message, a
  changed message shape, a changed meaning for a capability.
- Additions don't change it: new capabilities, new messages, new optional
  fields. **Ignore what you don't recognise.**
- **Refuse a higher major version** than you support instead of trying to
  proceed; guessing wrong looks like a black screen or silently lost input.
- A missing `protocolVersion` means 1.

## HTTP API

When `GLASS_API_TOKEN` is set, every `/v1/*` request needs
`Authorization: Bearer <token>`, except the WebSocket, stats and file routes,
which accept the per-session `?token=` from the URLs Glass returns.
`/healthz` and `/readyz` are always open.

### Runtime

| Method | Path | Response |
|---|---|---|
| `GET` | `/healthz` | `200 {"status":"ok"}` whenever the process is up. |
| `GET` | `/readyz` | `200` when at least one pooled browser answers, else `503`. Body: `{"status","browsers":{…},"diskFreeMB":{…},"diskLow"}`. Disk fields are informational. |
| `GET` | `/v1/info` | `{"sessions":{"active","relayActive","callActive","capacity"},"capacity":{"licensedMax","configuredCap","effectiveCeiling","hardCapEnabled","currentCpuPercent",…},"license":{"tier","sessionLimit"},"protocolVersion","uptimeSeconds"}`. `license.tier` is the tier actually in effect; `capacity.effectiveCeiling` is how many sessions can be admitted right now. |

### Browser sessions

| Method | Path | Response |
|---|---|---|
| `POST` | `/v1/sessions` | `201` with `{id, signalingUrl, protocolVersion, sourceType, capabilities}`. Optional body `{"audioInput": true}`. `503` at capacity. |
| `GET` | `/v1/sessions/{id}` | `{id, state: "pending"\|"active"\|"closed", createdAt, connectedAt?}`, or `404`. |
| `DELETE` | `/v1/sessions/{id}` | `204`, or `404`. |
| `GET` | `/v1/sessions/{id}/signaling` | WebSocket upgrade. |
| `POST` | `/v1/sessions/{id}/connections` | Mint a grant. Body: any of `consumesMedia`, `producesMedia`, `producesInput` (booleans). `201 {signalingUrl, connectionCapabilities}`. `consumesInput` is reserved: `400`. |
| `POST` | `/v1/sessions/{id}/input` | Server-side input: `{"type", "data"}` as in the DataChannel input table. `202`. |
| `GET` | `/v1/sessions/{id}/downloads/{guid}` | A finished download (see `DownloadReady`). |
| `POST` | `/v1/sessions/{id}/upload` | `multipart/form-data` answer to `FileChooserOpened`. |
| `GET` | `/v1/sessions/{id}/stats/stream` | Server-Sent Events: frame, transport and resource statistics, for operators. |

### Relay sessions

| Method | Path | Response |
|---|---|---|
| `POST` | `/v1/relay-sessions` | `201` with `{id, signalingUrl, produceUrl, videoCodec, protocolVersion, sourceType, capabilities}`, plus `slots` and `produceUrls` when the body declares `{"slots": [...]}`. |
| `GET` | `/v1/relay-sessions/{id}` | As for browser sessions. |
| `DELETE` | `/v1/relay-sessions/{id}` | As for browser sessions. |
| `GET` | `/v1/relay-sessions/{id}/signaling` | Viewer WebSocket. |
| `GET` | `/v1/relay-sessions/{id}/produce` | Producer WebSocket. `409` while the slot has another producer. |
| `POST` | `/v1/relay-sessions/{id}/connections` | Mint a grant; the response has `produceUrl` only when `producesMedia` was requested. A non-empty `slots` field is reserved: `400`. |
| `GET` | `/v1/relay-sessions/{id}/stats/stream` | Server-Sent Events. |

### Calls

| Method | Path | Response |
|---|---|---|
| `POST` | `/v1/calls` | `201 {id, peerAUrl, peerBUrl, videoCodec, protocolVersion, sourceType}`. |
| `GET` | `/v1/calls/{id}` | As for browser sessions. |
| `DELETE` | `/v1/calls/{id}` | As for browser sessions. |
| `GET` | `/v1/calls/{id}/peers/{a\|b}/signaling` | Peer WebSocket. The token must belong to that peer (`403` otherwise). |

### Session-creation fields

- `capabilities`: what this session's source can do: `video`, `navigation`,
  `viewport`, `clipboard`, `pauseResume`, `mobileEmulation`, and
  `inputActions` (the exact input `type`s the source accepts). Unknown keys are
  additions, not errors.
- `sourceType`: `"browser"`, `"relay"` or `"call"`.
- `videoCodec` (relay, call): `"h264"` or `"vp8"`. Producers and call peers
  must send it.

### WebSocket close codes

| Code | Sent by | Meaning |
|---|---|---|
| `1000` | Client | Deliberate leave. The connection ends; no reconnect grace. |
| `4001` | Glass | Relay producer sent no media. Held for grace; resume. |
| `4404` | Glass | The session doesn't exist (never created, closed or expired). Don't retry. |
| anything else | either | Treated as a lost connection: held for the reconnect grace. |

Glass also sends WebSocket pings; a client that doesn't answer within 30 s is
treated as disconnected. Browsers answer automatically.

## Signaling: viewers

This applies to browser-session and relay-session viewers
(`…/signaling`). Producers and call peers use the shorter exchange in
[sources/producers.md](sources/producers.md#connecting) and
[sources/calls.md](sources/calls.md#joining).

Every message is JSON with a `type`. On connect, **Glass sends the offer**;
the client answers.

### Glass → client

| `type` | Fields | Meaning |
|---|---|---|
| `offer` | `sdp`, `connectionId`, `producesInput`, `isOwner` | First message. Identifies this connection and its starting rights. The booleans are always present. |
| `ice-candidate` | `candidate` | Trickled ICE. Never sent before `offer`. |
| `capabilities_changed` | `connectionId`, `producesInput` | Someone's control changed. Sent to every connection, including the one it concerns. |
| `input_requested` | `connectionId` | Sent to the control holder when a request can't be granted outright. |
| `roster` | `connections: [{connectionId, producesInput, isOwner}]` | Owner only, once after `offer`: everyone else already connected. |
| `connection_joined` | `connectionId`, `producesInput`, `isOwner` | Owner only. Not sent when a connection resumes. |
| `connection_left` | `connectionId` | Owner only. |
| `slot_state` | `slots: {name: "empty"\|"live"\|"stalled"}` | Relay only. Once after `offer`, then on every change. |
| `new_tab_request` | `url` | Browser only: the page tried to open a popup or tab. |
| `clock_probe` | `id` | Clock calibration before the DataChannel opens. Reply `clock_probe_reply`. |
| `error` | `error` | The source failed for good. Glass closes the socket next; don't reconnect. |

### Client → Glass

| `type` | Fields | Meaning |
|---|---|---|
| `answer` | `sdp` | Answer to the offer. |
| `ice-candidate` | `candidate` | Trickled ICE. |
| `initial_viewport` | `width`, `height`, `isMobile?`, `userAgent?` | Browser only, right after connect. `isMobile: true` turns on mobile emulation with the given user agent. |
| `navigate` | `sdp` (holds the URL) | Browser only, owner only. Same as the DataChannel `navigate`; the field name is historical. |
| `request_input`, `release_input` | none | Ask for or give up control. |
| `grant_input`, `revoke_input` | `connectionId` | Owner only. |
| `mic_granted`, `mic_denied` | none | Answer to `MicAccessRequested`. |
| `clock_probe_reply` | `id`, `clientT` (epoch ms) | Answer to `clock_probe`. |

### Microphone negotiation

A browser-session client must add a silent placeholder audio track to its
peer connection **before creating its answer**, on every connection. Without
it the answer negotiates receive-only audio, and a microphone can't be added
later without renegotiation, which Glass doesn't do. After sending
`mic_granted`, the client swaps the real microphone into that track with
`replaceTrack`. `@glass/client` does both.

## DataChannel input (client → Glass)

Each message is a JSON string: `{"type": "<action>", "data": {…}}`. Input from a
connection without `producesInput` is dropped. Coordinates are in the remote
page's CSS pixels.

| `type` | `data` | Notes |
|---|---|---|
| `mousemove` | `x`, `y`, `dragging` | |
| `mousedown`, `mouseup` | `x`, `y`, `button?` (`left`\|`right`\|`middle`), `modifiers?`, `clickCount?` | `clickCount` is the browser's own `MouseEvent.detail`. |
| `scroll` | `deltaY`, `deltaX?`, `modifiers?` | Dispatched as a real wheel event. |
| `keydown`, `keyup` | `key`, `code`, `modifiers` | |
| `touchstart`, `touchmove` | `points: [{x, y, id}]` | At most 5 points. |
| `touchend`, `touchcancel` | `points` | Points are ignored. |
| `navigate` | `url` | Owner only. |
| `back`, `forward`, `refresh` | none | Owner only. |
| `set_viewport` | `width`, `height` | |
| `copy_text` | none | Answered with `ClipboardText`. |
| `paste_text` | `text` | |

`modifiers` is a bitmask: Alt = 1, Ctrl = 2, Meta = 4, Shift = 8. Interaction
messages may carry `s`, a per-connection sequence number used for latency
measurement.

Two diagnostic messages are accepted from every connection, watch-only
included: `input_latency_report` (the client's measured input-to-display
latency and receiver statistics, every 5 s) and `clock_probe_reply`. Both are
optional.

## DataChannel messages (Glass → client)

Binary. The first byte is the message type; most carry JSON after it.

| Byte | Name | Payload | Meaning |
|---|---|---|---|
| `0x04` | `InputFrame` | `{f, i: [{s, c?}]}` | The frame (RTP timestamp `f`) that followed the listed inputs. Latency measurement. |
| `0x05` | `ElementStateUpdate` | `{cursor, editableFocused}` | Cursor shape; whether a text field has focus. |
| `0x06` | `NavigationState` | `{url, loading, canGoBack, canGoForward}` | |
| `0x07` | `ViewportSize` | int32 LE width, int32 LE height | The browser's actual size. |
| `0x08` | `ClockProbe` | `{id}` | Reply at once with `clock_probe_reply`. |
| `0x09` | `ClipboardText` | `{text}` | Answer to `copy_text`. |
| `0x0A` | `InteractiveElements` | `{elements: [{x, y, width, height}]}` | Phones only: text-field positions. Replaces the previous list. |
| `0x0B` | `ConsoleMessage` | `{level, text}` | The page's console output. |
| `0x0C` | `DownloadReady` | `{filename, guid}` | Fetch `GET …/downloads/{guid}` when the user chooses to. |
| `0x0D` | `FileChooserOpened` | `{multiple}` | Answer with `POST …/upload` within 60 s. |
| `0x0E` | `FileChooserClosed` | `{}` | The file picker expired or was replaced. |
| `0x0F` | `MicAccessRequested` | `{origin}` | Answer with `mic_granted` or `mic_denied` within 60 s; silence denies. |
| `0xFF` | `Error` | `{error}` | The video encoder failed. |

Types `0x01`–`0x0F` are control and state; `0xF0`–`0xFF` are errors and
reserved.
