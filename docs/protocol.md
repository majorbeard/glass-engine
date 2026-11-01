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
which accept the per-session `?token=` from the URLs Glass returns, and
`POST /v1/tickets`, which takes a [session ticket](#session-tickets) instead.
`/healthz` and `/readyz` are always open.

### Runtime

| Method | Path | Response |
|---|---|---|
| `GET` | `/healthz` | `200 {"status":"ok"}` whenever the process is up. |
| `GET` | `/readyz` | `200` when at least one pooled browser answers, else `503`. Body: `{"status","browsers":{…},"diskFreeMB":{…},"diskLow"}`. Disk fields are informational. |
| `GET` | `/v1/info` | `{"sessions":{"active","relayActive","callActive","capacity"},"capacity":{"licensedMax","configuredCap","effectiveCeiling","hardCapEnabled","currentCpuPercent",…},"license":{"tier","sessionLimit"},"protocolVersion","uptimeSeconds","codecs":{"available","default"},"build":{…},"security":{…}}`. `build` and `security` are described in [deployment.md](deployment.md#monitoring-what-runs). `codecs` lists the video codecs a browser session may ask for, and the one it gets without asking. `license.tier` is the tier actually in effect; `capacity.effectiveCeiling` is how many sessions can be admitted right now. |

### Browser sessions

| Method | Path | Response |
|---|---|---|
| `POST` | `/v1/sessions` | `201` with `{id, signalingUrl, protocolVersion, sourceType, capabilities, contentHint, codec, linksExpireAt?}`. Optional body fields: `"audioInput": true`; `"contentHint": "detail"` or `"motion"` (anything else is `400`); `"codec": "h264"`, `"vp8"` or `"av1"` (one this host cannot serve is `400` with the reason, never served as another codec); `"inputMode": "floor"` (the default) or `"free"` (anything else is `400`; see [concepts.md](concepts.md#several-people-in-control)); `"inspect": true` allows [page inspection](page-inspection.md) (off by default; `400` for a source that cannot be inspected). `"linkExpiresIn"`: seconds until the session's link stops admitting new connections, `0` for never (see [link expiry](#link-expiry)). The response also carries `inputMode` and `inspect`. `503` at capacity. `429` past [the creation rate limit](#rate-limits). |
| `POST` | `/v1/tickets` | Redeem a [session ticket](#session-tickets): `{"ticket": "…"}`. Creates one browser session; `201` as `POST /v1/sessions`, plus `watchUrls`. Takes no API token. Exists only when `GLASS_TICKET_SECRET` is set. `429` past [the ticket rate limit](#rate-limits), which every attempt counts toward. |
| `GET` | `/v1/sessions` | Every running browser session, oldest first: `{"sessions": [...]}`, each as `GET /v1/sessions/{id}` plus `connections` (how many are connected now). Never a link. API token only. |
| `GET` | `/v1/sessions/{id}` | `{id, state: "pending"\|"active"\|"closed", createdAt, connectedAt?, codec?, inputMode?}`, or `404`. |
| `DELETE` | `/v1/sessions/{id}` | `204`, or `404`. |
| `GET` | `/v1/sessions/{id}/signaling` | WebSocket upgrade. |
| `POST` | `/v1/sessions/{id}/connections` | Mint a grant. Body: any of `consumesMedia`, `producesMedia`, `producesInput` (booleans), and `expiresIn` (seconds, `0` for never; see [link expiry](#link-expiry)). `201 {signalingUrl, connectionCapabilities, linkId, expiresAt?}`; `linkId` names the link for revoking it. `consumesInput` is reserved: `400`. |
| `DELETE` | `/v1/sessions/{id}/connections/{linkId}` | Revoke one link: it admits nothing again, a reconnect included, and every connection that joined with it is closed with `4403`. The session goes on for everyone else. `204` (also when already revoked); `404` for an unknown session or link; `400` for the session's own link (close the session instead). API token only. `linkId` is the one the link was minted with, or the first 16 hex digits of the SHA-256 of the link's `token` (`glass session revoke <URL>` works it out). |
| `POST` | `/v1/sessions/{id}/input` | Server-side input: `{"type", "data"}` as in the DataChannel input table. Not subject to the session's input mode, unless `"floor": true`: then it takes the page as one more controller, waiting up to `"wait"` ms (default 2000, at most 10000) for a person to pause, and is `409` (`floor_taken`, with `holder`) if they don't; keys and buttons it holds are released after 5 s without input from it; not for `set_viewport`. `202`; `400` for an unknown or invalid event, and `400` (`navigation_not_allowed`) for a `navigate` to a URL the navigation rules refuse (a scheme other than `http` or `https`, loopback, a private or link-local address), answered before anything runs; `429` when rate limited. |
| `GET` | `/v1/sessions/{id}/page/snapshot` | The page's accessibility tree: `scope`, `prune`, `values`, `root`, `maxNodes`. See [page-inspection.md](page-inspection.md); every `/page` route takes the API token only, on a session created with `"inspect": true` (else `403`, `inspect_off`); a stale ref is `409` (`stale_ref`). |
| `POST` | `/v1/sessions/{id}/page/query` | Nodes matching `{role?, name?, exact?, scope?, values?, maxResults?}`. |
| `GET` | `/v1/sessions/{id}/page/at?x&y` | The node at a viewport point and its ancestors. |
| `GET` | `/v1/sessions/{id}/page/node?ref` | Where a node is now: quads, bounds, `inViewport`. |
| `POST` | `/v1/sessions/{id}/page/scroll` | `{"ref"}`: scroll it into view. |
| `GET` | `/v1/sessions/{id}/page/state` | URL, title, viewport, scroll position, focused node. `409` (`dialog_open`) while a JavaScript dialog is open. |
| `POST` | `/v1/sessions/{id}/page/dialog` | Answers the page's open JavaScript dialog: `{"accept", "text"?, "floor"?, "wait"?}`. `200`; `409` (`no_dialog`) when none is open. |
| `GET` | `/v1/sessions/{id}/page/events?kinds` | Server-Sent Events: the page's state as counters, on each change. |
| `GET` | `/v1/sessions/{id}/downloads/{guid}` | A finished download (see `DownloadReady`). The API token, or the link of a connection that has control of the page now; a watch link gets `403` until it is given control. |
| `POST` | `/v1/sessions/{id}/upload` | `multipart/form-data` answer to `FileChooserOpened`. Same rule as downloads. |
| `GET` | `/v1/sessions/{id}/stats/stream` | Server-Sent Events: frame, transport and resource statistics, for operators. Same rule as downloads. |

### Relay sessions

| Method | Path | Response |
|---|---|---|
| `POST` | `/v1/relay-sessions` | `201` with `{id, signalingUrl, produceUrl, videoCodec, protocolVersion, sourceType, capabilities, linksExpireAt?}`, plus `slots` and `produceUrls` when the body declares `{"slots": [...]}`. Optional `"linkExpiresIn"` for every link it returns. `429` past [the creation rate limit](#rate-limits). |
| `GET` | `/v1/relay-sessions` | Every running relay session, as `GET /v1/sessions`. |
| `GET` | `/v1/relay-sessions/{id}` | As for browser sessions. |
| `DELETE` | `/v1/relay-sessions/{id}` | As for browser sessions. |
| `GET` | `/v1/relay-sessions/{id}/signaling` | Viewer WebSocket. The `signalingUrl` is a watch link; the producer's link may watch too. |
| `GET` | `/v1/relay-sessions/{id}/produce` | Producer WebSocket. Only with a link minted to produce (the `produceUrl`, or a grant with `producesMedia`) or the API token; any other link is `403`. `409` while the slot has another producer. |
| `POST` | `/v1/relay-sessions/{id}/connections` | Mint a grant; the response has `produceUrl` only when `producesMedia` was requested. `expiresIn` as for browser sessions. A non-empty `slots` field is reserved: `400`. |
| `DELETE` | `/v1/relay-sessions/{id}/connections/{linkId}` | Revoke one link, as for browser sessions: the `signalingUrl` (a watch link), a producer's link, or one minted later. |
| `GET` | `/v1/relay-sessions/{id}/stats/stream` | Server-Sent Events. The API token only. |

### Calls

| Method | Path | Response |
|---|---|---|
| `POST` | `/v1/calls` | `201 {id, peerAUrl, peerBUrl, videoCodec, protocolVersion, sourceType, linksExpireAt?}`. Optional body `{"linkExpiresIn"}` for both peer links. `429` past [the creation rate limit](#rate-limits). |
| `GET` | `/v1/calls` | Every running call, as `GET /v1/sessions`. |
| `GET` | `/v1/calls/{id}` | As for browser sessions. A call's peer links end with the call. |
| `DELETE` | `/v1/calls/{id}` | As for browser sessions. |
| `GET` | `/v1/calls/{id}/peers/{a\|b}/signaling` | Peer WebSocket. The token must belong to that peer (`403` otherwise); the API token is not a peer. |

### Session-creation fields

- `capabilities`: what this session's source can do: `video`, `navigation`,
  `viewport`, `clipboard`, `pauseResume`, `mobileEmulation`, and
  `inputActions` (the exact input `type`s the source accepts). Unknown keys are
  additions, not errors.
- `sourceType`: `"browser"`, `"relay"` or `"call"`.
- `videoCodec` (relay, call): `"h264"` or `"vp8"`, the host's default
  codec. Producers and call peers must send it.
- `contentHint` (browser): the hint in effect, `"detail"` or `"motion"`:
  what the session protects when bitrate or CPU is short (the size, or the
  frame rate). The request's own, or the runtime's default
  (`GLASS_CONTENT_HINT`).
- `codec` (browser): the session's video codec, `"h264"`, `"vp8"` or
  `"av1"`, fixed for its life: the request's own, or the runtime's default
  (`GLASS_DEFAULT_CODEC`). The runtime cannot know what the viewer decodes:
  a client that asks for AV1 checks first (Safari decodes AV1 only on
  devices with AV1 hardware).

### Session statistics

`GET /v1/sessions/{id}/stats/stream` sends one Server-Sent Event every 2 s,
`data:` and a JSON object of running totals since the session started. The
frame fields:

| Field | Meaning |
|---|---|
| `framesCaptured` | frames the capture delivered |
| `framesEmitted` | captured frames that carried a picture and went on toward the encoder; the drops below and the encoder's own skips come after this count |
| `framesDroppedCongestion` | captured frames not encoded because a viewer's path could not carry them: the sum of the three below |
| `framesDroppedForWindow` | dropped while more data was in flight than the path's congestion window allows |
| `framesDroppedByDropper` | dropped to hold an encoder that runs over its target bitrate to it |
| `framesPausedForQueue` | held back while a viewer's send queue would take over 2 s to leave; the newest is encoded once it drains |
| `framesDroppedPacing` | always 0, kept for readers that sum it |
| `encodedBytes`, `keyframesEncoded` | the encoder's whole output; every encoded frame is sent |
| `targetBitrateBps` | the congestion controller's send-rate target, the lowest across the session's viewers; 0 with no estimate |

Frames are dropped before they are encoded, never after, so every encoded
frame is sent to the viewers and a drop never needs a keyframe to recover. The
encoder can also skip frames on its own to keep to its bitrate; those are not
counted here. The object carries more fields (transport, input latency,
memory, `encoderBackend`, `audio` when audio is on); new fields are
additions, not errors.

### Errors

Every error an HTTP route returns, a refused WebSocket handshake included,
is JSON:

```json
{ "error": "a sentence for people", "code": "a_code_for_programs" }
```

The message may change between releases; the code does not, so branch on
the code. A body may carry more fields beside these two (`floor_taken`'s
`holder`). The codes:

| `code` | Status | Meaning |
|---|---|---|
| `bad_request` | 400 | The request is malformed, or a field is out of range. |
| `navigation_not_allowed` | 400 | A `navigate` input to a URL the navigation rules refuse: a scheme other than `http` or `https`, loopback, a private or link-local address. |
| `unauthorized` | 401 | No credential, or one the runtime does not know. |
| `ticket_invalid`, `ticket_expired`, `ticket_used` | 401 | A session ticket refused (`POST /v1/tickets`). |
| `link_expired`, `link_revoked` | 401 | A link past its expiry, or revoked. |
| `origin_not_allowed` | 403 | A browser origin the runtime does not allow. |
| `link_not_allowed` | 403 | A valid link without the right this needs: control of the page, producing, the statistics, the other peer's place. |
| `link_used` | 403 | A single-use link already used. |
| `inspect_off` | 403 | A page route on a session created without `"inspect": true`. |
| `session_not_found` | 404 | No such session, or it has ended. |
| `not_found` | 404 | No such thing inside the session: a download, a link id, a call peer. |
| `unsupported` | 400, 404, 501 | The session's source cannot do this (no downloads, no inspection, no page events). |
| `session_closed` | 409 | The session is closing. |
| `slot_in_use` | 409 | A relay slot another producer holds. |
| `no_page`, `stale_ref`, `no_dialog`, `dialog_open` | 409 | Page routes: no page; a node reference from an earlier snapshot; no dialog open; a dialog blocks the page. |
| `floor_taken` | 409 | Another connection has the page (input mode `floor`); the body also carries `holder`. |
| `no_file_chooser` | 409 | Files uploaded when no file chooser is waiting for them. |
| `too_large` | 413 | A file, a batch or the session's uploads over their limit. |
| `rate_limited` | 429 | Too many requests or inputs from this client; see `Retry-After`. |
| `internal_error` | 500 | A fault in the runtime; the detail is in its log, never in the body. |
| `at_capacity`, `hard_cap_reached`, `shutting_down`, `unavailable` | 503 | No session slot; no CPU headroom; the runtime is stopping; not available on this session now. |
| `source_failed` | (signaling only) | The session's browser stopped; the session has ended. Sent in the signaling `error` message, never by an HTTP route. |

### WebSocket close codes

| Code | Sent by | Meaning |
|---|---|---|
| `1000` | Client | Deliberate leave. The connection ends; no reconnect grace. |
| `4001` | Glass | Relay producer sent no media. Held for grace; resume. |
| `4401` | Glass | The link has expired: it admits no new connection ([link expiry](#link-expiry)). Don't retry; get a new link. |
| `4403` | Glass | The link was revoked: this connection is closed, and the link admits nothing again. Don't retry; get a new link. |
| `4404` | Glass | The session doesn't exist (never created, closed or expired). Don't retry. |
| `1011` | Glass | The session's browser stopped; sent after the signaling `error` message (`source_failed`). The session has ended: don't retry it. |
| anything else | either | Treated as a lost connection: held for the reconnect grace. |

Glass also sends WebSocket pings; a client that doesn't answer within 30 s is
treated as disconnected. Browsers answer automatically.

### Rate limits

Creating sessions, relay sessions and calls is limited per client to
`GLASS_CREATE_RATE_PER_MINUTE` (default 120 a minute, in bursts of up to
40), and redeeming tickets to `GLASS_TICKET_RATE_PER_MINUTE` (default 10, in
bursts of up to 4; every attempt counts, valid or not). The client is the
address Glass sees, or behind a trusted proxy the one it forwards
(`GLASS_TRUSTED_PROXIES`). Past the limit: `429` with `Retry-After` (whole
seconds) and `{"error", "code": "rate_limited"}`. A request refused for
its credential doesn't count. `0` turns a limit off.

### Link expiry

Every link Glass returns expires: a session's own link, minted grants, a
relay session's viewer and producer links, and a call's peer links. The
default is `GLASS_LINK_TTL_HOURS` (24 h; `0` is never). A request sets its
own lifetime in seconds, `0` for never: `linkExpiresIn` when creating a
session, relay session or call (every link it returns), `expiresIn` when
minting a grant. A negative value is `400`. The response says when, as
RFC 3339 UTC: `linksExpireAt` on creation, `expiresAt` on a grant; absent
for a link that never expires.

An expired link only stops **joining**: its WebSocket is accepted and closed
at once with `4401`. The session goes on, connections already in it are not
cut off, and a connection that joined with the link can still resume after
a drop, within the reconnect grace. Your backend can mint a fresh link at
any time.

### Session tickets

A ticket lets a browser start a session without the API token ever leaving
your backend. Set `GLASS_TICKET_SECRET` (comma-separated to rotate: every
listed secret verifies). Your backend signs a ticket and hands it to the
page; the page sends `POST /v1/tickets` with `{"ticket": "<ticket>"}`.

A ticket is a JWT signed with HMAC-SHA-256, as any JWT library makes one.
The header must say `"alg": "HS256"` (a `typ` of `JWT` is fine, `crit` is
not); any other algorithm is refused. Claims:

| Claim | |
|---|---|
| `exp` | Required. At most 10 minutes ahead; 30 s of clock skew is allowed. |
| `jti` | Required, up to 128 bytes. Each ticket is accepted once. |
| `nbf` | Optional, honoured. |
| `glass` | Optional: the session's `audioInput`, `contentHint`, `codec`, `inputMode` and `linkExpiresIn`, as for `POST /v1/sessions`, and `watchLinks` (0 to 10). Any other field, `inspect` included, is refused. |

Other registered claims (`iss`, `sub`, `aud`, `iat`) are ignored.

```js
// Node, on your backend: any JWT library works.
import jwt from "jsonwebtoken";
const ticket = jwt.sign(
  { jti: crypto.randomUUID(), glass: { watchLinks: 1 } },
  process.env.GLASS_TICKET_SECRET,
  { algorithm: "HS256", expiresIn: "5m" },
);
```

`201` is the `POST /v1/sessions` body, plus `watchUrls` (watch-only links)
when `watchLinks` asked for them. The session's own link controls the
session. `401` with `code`: `ticket_invalid` (malformed, wrong signature or
header, missing claim), `ticket_expired` (expired, not yet valid, or longer
than 10 minutes) or `ticket_used`. `400` for options the session would
refuse; a ticket refused that way, or at capacity (`503`), is not spent.

A ticket opens only this route: it is not accepted as a token anywhere
else, and the API token is not accepted here.

## Signaling: viewers

This applies to browser-session and relay-session viewers
(`…/signaling`). Producers and call peers use the shorter exchange in
[sources/producers.md](sources/producers.md#connecting) and
[sources/calls.md](sources/calls.md#joining).

Every message is JSON with a `type`. On connect, Glass sends `ice_config`,
then **the offer**; the client answers.

### Glass → client

| `type` | Fields | Meaning |
|---|---|---|
| `ice_config` | `iceServers: [{urls, username?, credential?}]` | First message on every signaling connection, viewers, producers and call peers alike: the STUN and TURN servers to use, as an `RTCConfiguration`'s `iceServers`. With `GLASS_TURN_SECRET` set, the TURN entry carries a credential for this connection alone, valid `GLASS_TURN_CREDENTIAL_TTL_HOURS`; every reconnect gets a fresh one. Use these unless your application has its own. |
| `offer` | `sdp`, `connectionId`, `producesInput`, `isOwner` | Right after `ice_config`. Identifies this connection and its starting rights. The booleans are always present. |
| `ice-candidate` | `candidate` | Trickled ICE. Never sent before `offer`. |
| `capabilities_changed` | `connectionId`, `producesInput` | Someone's control changed. Sent to every connection, including the one it concerns. |
| `input_requested` | `connectionId` | Sent to the control holder when a request can't be granted outright. |
| `input_floor` | `connectionId` (or `null`) | Browser only, input mode `floor`: whose input reaches the page. Once after `offer`, then to every connection on each change. Names the controller until someone else takes the page, even after it pauses; `null` once it leaves. |
| `roster` | `connections: [{connectionId, producesInput, isOwner}]` | Owner only, once after `offer`: everyone else already connected. |
| `connection_joined` | `connectionId`, `producesInput`, `isOwner` | Owner only. Not sent when a connection resumes. |
| `connection_left` | `connectionId` | Owner only. |
| `slot_state` | `slots: {name: "empty"\|"live"\|"stalled"}` | Relay only. Once after `offer`, then on every change. |
| `new_tab_request` | `url` | Browser only: the page tried to open a popup or tab. |
| `clock_probe` | `id` | Clock calibration before the DataChannel opens. Reply `clock_probe_reply`. |
| `error` | `code`, `error` | The source failed for good (`code` is `source_failed`; `error` is a sentence for people). Glass closes the socket next with `1011`; don't reconnect. |

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

Each message is a JSON string: `{"type": "<action>", "data": {…}}`. Input Glass can't accept is dropped and reported back
(see [Dropped input](#dropped-input)). Coordinates are in the remote
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
| `dialog_answer` | `accept`, `text?` | Answers the page's open JavaScript dialog (`Dialog`, `0x11`) as OK (`accept: true`) or Cancel; `text` is a prompt's answer. Ordinary input: it needs `producesInput` and goes through the input mode's floor. Ignored when no dialog is open. |

`modifiers` is a bitmask: Alt = 1, Ctrl = 2, Meta = 4, Shift = 8. Interaction
messages may carry `s`, a per-connection sequence number used for latency
measurement.

Five diagnostic messages are accepted from every connection, watch-only
included. All are optional. `@glass/client` sends the first two by itself:

- `input_latency_report`: the client's measured input-to-display latency
  and receiver statistics, every 5 s;
- `clock_probe_reply`: the answer to a `clock_probe`.

It sends the other three only when its diagnostic options are on:

- `client_stats_report`: the viewer's frame, packet and freeze counters, at the
  trace-report interval;
- `pixel_trace_sample` (`samples: [{rtpTimestamp, paintedAtMs}]`): when
  frames reached the screen; the engine ignores it unless its own
  pixel tracing is on;
- `encoded_frame_report` (`reports: [{rtpTimestamp, type, size, hash}]`):
  what the viewer's decoder was given for each frame, compared with what
  was sent.

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
| `0x10` | `InputDropped` | `{code, eventType, count, s?}` | Glass discarded this connection's input. See [Dropped input](#dropped-input). |
| `0x11` | `Dialog` | `{open, type?, message?, defaultPrompt?, inPicture}` | The page's JavaScript dialog (`alert`, `confirm`, `prompt`, `beforeunload`) opened or closed; also sent on joining while one is open. The page waits until it is answered with `dialog_answer`. `inPicture` is true when the dialog is drawn in the video (on a display, not the screencast), so a person can answer it with ordinary input; when false, show it yourself. |
| `0xFF` | `Error` | `{error}` | The video encoder failed. |

Types `0x01`–`0x1F` are control and state; `0xF0`–`0xFF` are errors and
reserved.

### Dropped input

Glass never drops input silently. It sends `InputDropped` (`0x10`) on the
reliable DataChannel:

| `code` | Meaning | What to do |
|---|---|---|
| `rate_limited` | The connection is sending this event type too fast. | Send less. |
| `not_authorized` | The connection has no `producesInput`. | Request control, or use a grant that has it. |
| `owner_only` | Only the session owner may do this (navigation). | Nothing; ask the owner. |
| `floor_taken` | Input mode `floor`: another connection has the page, or this connection's window doesn't set the page size. | Wait for them to pause (`input_floor` says who). |
| `unsupported` | The source doesn't accept this event type, or accepts no input. | Don't retry. Check `capabilities.inputActions`. |
| `invalid` | The message was malformed or failed validation (out-of-range coordinates, too many touch points). | Fix the sender. |

- `eventType` is the dropped event's type when the source knows it, and empty
  otherwise. Glass doesn't echo a type it doesn't recognise.
- Reports are coalesced per `code` and `eventType`: the first drop is reported
  at once, then at most one report every 2 s. `count` is the number of drops
  since the previous report.
- `s` is the sequence number of the first dropped event in the report, when
  the client numbered its input.

A client knows its own rights from the `offer` and `capabilities_changed`, so
it shouldn't send input it has no right to send. `@glass/client` withholds it
and reports it through the same `inputDropped` event.
