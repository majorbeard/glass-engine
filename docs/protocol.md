# Glass protocol

The wire contract between the Glass engine and a client, protocol version
**3**. `@glass/client` implements all of it; this page is for anyone writing
their own client, publisher or backend integration.

There are three layers:

- **The HTTP API**: creating sessions, minting links, adding sources,
  recordings, and the operator's routes.
- **Signaling**, a WebSocket at a link's URL
  (`/v1/sessions/{id}/connect?token=…`): `hello`, then the client's offer and
  Glass's answer, then the messages about the session's sources, members and
  control.
- **The DataChannel**, once WebRTC is up: input from the client, and state
  from Glass. Video and audio never travel over it: they are WebRTC media
  tracks, negotiated in the same offer and answer.

**Coming from 0.1?** See [Migrating from 0.1](migrating-from-0.1.md): every
change in version 3, with its replacement.

## The model

A **session** holds **sources**: a hosted browser, a recording played back,
or a track a member publishes (a camera, a microphone, a screen). Each
source has an id, and everything about a source names it.

People and programs join a session as **members**, each with a **link**. A
link carries **rights**: which kinds of source it may watch, publish and
control. The session's own link, returned when it is made, is the
**owner's**: it watches and controls everything, and may act on other
members.

## Versioning

`protocolVersion` is the major version of everything on this page. It is
sent on every answer that makes a session (`POST /v1/sessions`,
`POST /v1/tickets`, `POST /v1/recordings/{id}/play`), by `GET /v1/info`, and
in `hello`, the first message of every connection.

- It changes only for a breaking change: a removed or repurposed message or
  field, a changed shape, a changed meaning.
- Additions do not change it: a new message, field, capability key or input
  action. Clients ignore what they don't recognise.
- **A client refuses any version but its own**, higher or lower, rather than
  guess. `@glass/client` closes with `protocol_mismatch`.

## HTTP API

When the engine has an API token (`GLASS_API_TOKEN`), every `/v1/*` request
needs `Authorization: Bearer <token>` (or `?token=` where a header can't be
set). A link's own `?token=` is a per-session credential, accepted only on
that session's member connection, its statistics stream, and its sources'
upload and download routes. `/healthz` and `/readyz` are always open.

### Sessions

| Method | Path | |
|---|---|---|
| `POST` | `/v1/sessions` | Make a session (below). `201` with `{id, protocolVersion, link, sources}`. |
| `GET` | `/v1/sessions` | Every running session, oldest first, each with `connections` (how many are connected now). Never a link or token. |
| `GET` | `/v1/sessions/{id}` | `{id, state, createdAt, connectedAt?, codec?, inputMode?, sources, connectionQuality?}`. `state` is `pending`, `active` or `closed`. A simulcast source carries `simulcast` (its layers and each viewer's). |
| `DELETE` | `/v1/sessions/{id}` | End the session for everyone and release its sources. `204`. |
| `GET` | `/v1/sessions/{id}/connect?token=` | The member connection: a link's `url`. See "Signaling". |
| `POST` | `/v1/sessions/{id}/links` | Mint a link (see "Links"). `201` with the link. |
| `DELETE` | `/v1/sessions/{id}/links/{linkId}` | Revoke a link: it admits nothing again, and every connection that joined with it is closed with `4403`. `204`, also when already revoked. `400` for the session's own link (end the session instead). |
| `POST` | `/v1/sessions/{id}/sources` | Add a browser to a running session: the body is one entry of `sources` below. `201` with the source. `409` (`unsupported`) on a session whose members publish. |
| `DELETE` | `/v1/sessions/{id}/sources/{sourceId}` | Remove a source. The session goes on; its members are told (`source_removed`). `204`. |
| `POST` | `/v1/sessions/{id}/sources/{sourceId}/input` | Send input to a source as the operator (see "Server-side input"). `202`. |
| `POST` | `/v1/sessions/{id}/sources/{sourceId}/control` | A playback source's controls: `{"action": "play" \| "pause" \| "seek", "positionMs"?}`. `202`. |
| `GET` | `/v1/sessions/{id}/sources/{sourceId}/downloads/{guid}` | A finished page download (`DownloadReady`). The API token, or a link whose connection holds that source's input now. |
| `POST` | `/v1/sessions/{id}/sources/{sourceId}/upload` | `multipart/form-data` answer to `FileChooserOpened`. Same rule. |
| `GET` | `/v1/sessions/{id}/stats/stream` | Server-Sent Events: frame, transport and resource statistics, one event a live source. The API token, or a link whose connection controls the page now. |
| `GET`, `POST` | `/v1/sessions/{id}/sources/{sourceId}/page/…` | Page inspection: see [Page inspection](page-inspection.md). |
| `POST` | `/v1/sessions/{id}/recording` | Start or stop recording: see [Recording](recording.md). |

### `POST /v1/sessions`

```json
{
  "sources": [
    {"kind": "browser", "url": "https://example.com", "codec": "vp8", "contentHint": "motion", "inputMode": "floor"}
  ],
  "record": false,
  "linkExpiresIn": 3600
}
```

**With `sources`**, the engine runs them: `kind` is `"browser"`. Each
source's options:

- `url`: a page to open. It is checked by the navigation rules before
  anything is made (a refused URL is `400` `navigation_not_allowed`), and
  opened after the answer: the answer does not wait for the page to load, and
  a page that fails to load is reported as any navigation's failure is.
- `codec`: `"h264"`, `"vp8"` or `"av1"`, fixed for its life; absent, the
  engine's default. A session's pictures share one codec. A codec the engine
  cannot serve (`GET /v1/info`'s `codecs`) is refused, never served as
  another. Check that the viewer can decode it first (Safari decodes AV1 only
  with AV1 hardware).
- `contentHint`: what the picture protects when the bitrate can't carry it.
  `"detail"` keeps its size and lowers the frame rate (text, interfaces);
  `"motion"` keeps the frame rate and lowers the size (video, games).
- `inputMode`: how several holders of its input share it, `"floor"` (the
  default) or `"free"`. See "Input arbitration".
- `inspect`: `true` allows page inspection on it.
- `audioInput`: put the browser where it can be given a microphone.

**Without `sources`** (an empty body), the session's members publish: each
track a member publishes becomes a source. See
[Publishing](sources/producers.md).

The session's own options:

- `maxMembers`: the most connections it admits at once (at least 1). A join
  past it is `409` `session_full`.
- `simulcast`: `true` takes each published camera or screen as up to three
  layers, and gives each viewer the one its link carries. Only for a session
  whose members publish.
- `record`: `true` starts recording as it is made; the answer then carries
  `recording`. Only for a session with sources.
- `linkExpiresIn`: seconds until the session's own link stops admitting new
  connections; `0` for never. See "Link expiry".
- `ownerMayShare`: `true` lets the session's own link mint links, without the
  API token. Off by default. See "Owner sharing".

The answer:

```json
{
  "id": "9ee60523-4129-4f4a-b43a-89e14189e89f",
  "protocolVersion": 3,
  "link": {
    "id": "4776be7c9390e016",
    "url": "wss://glass.example.com/v1/sessions/9ee60523-…/connect?token=…",
    "rights": {"watch": "all", "publish": [], "control": "all", "owner": true},
    "expiresAt": "2026-10-26T16:00:00Z"
  },
  "sources": [
    {
      "id": "0d6c1f4e-9a1b-4b0e-8d6e-7c2f3a1b5e90",
      "kind": "browser",
      "state": "live",
      "codec": "h264",
      "contentHint": "detail",
      "inputMode": "floor",
      "inspect": false,
      "capabilities": {
        "video": true, "navigation": true, "viewport": true, "clipboard": true,
        "pauseResume": true, "mobileEmulation": true, "inspect": true,
        "inputActions": ["back", "forward", "keydown", "mousemove", "…"]
      }
    }
  ]
}
```

**A source** is `{id, kind, state, capabilities, codec?, contentHint?,
inputMode, inspect, reason?}`, the same everywhere it appears: here,
`GET /v1/sessions/{id}`, `POST …/sources`, and signaling's `hello`,
`source_added` and `source_updated`. `kind` is `browser`, `playback`,
`camera`, `microphone`, `screen` or `device`. `state` is `live`, `stalled`
(live, but sending nothing now: its publisher dropped and may resume, or its
track went quiet) or `ended` (with `reason`: `removed`, `failed` or
`session_closed`). `capabilities` is what that source can do, so a client
knows before it negotiates. Treat unknown keys as additions.

**A link's `?token=` is a credential for this session only, not the API
token.** It is in the URL because a browser's `WebSocket` and `EventSource`
take no headers. Hand each person their own link, never the API token.

### The session's life

A new session is `pending`, and is closed if nobody connects within
`GLASS_PENDING_TTL_SECONDS` (30 s by default), so an abandoned create holds
no browser. The first connection makes it `active`; it stays active however
many connections come and go.

**A session takes any number of connections**, each with its own life:

- A close with `1000` (a client's deliberate leave) ends that connection
  alone, and its published sources at once.
- Any other ending (a lost network, a locked phone, a read timeout) holds
  that connection's place for `GLASS_RECONNECT_GRACE_SECONDS` (60 s by
  default): the client reconnects with the same link and resumes as the same
  member.
- **When the last connection is gone** (closed, or its grace over with
  nobody back), the session ends and releases its sources.

A reconnect resumes a dropped connection only when it is unambiguous: one
connection that joined with that link is held, and none is active.
Otherwise it joins as a new member.

### Links

A link is `{id, url, rights, expiresAt?}`. `POST /v1/sessions/{id}/links`
mints one:

```json
{"watch": "all", "control": ["browser"], "expiresIn": 3600}
```

- `watch`: `"all"`, `"none"` (the default) or a list of kinds: the sources a
  connection with it receives.
- `publish`: a list of kinds it may publish.
- `control`: `"all"` or a list of kinds whose input it may hold. A
  connection with it holds the input of every live source of those kinds,
  and may ask for one added later (`request_input`).
- `expiresIn`: as `linkExpiresIn`, for this link.

The kinds are `browser`, `playback`, `camera`, `microphone`, `screen` and
`device`; `owner` is refused: the session's own link is the only owner's.
Beyond a link's rights, the owner may deny a member a source and lift the
denial, and grant or revoke its control of one (see "Owner-controlled
handoff").

### Owner sharing

Minting a link takes the API token: your backend decides who gets which link,
under its own sign-in, seats and records. A session made with
`"ownerMayShare": true` (or a ticket's `glass.ownerMayShare`, which `glass gate`
sets with `GLASS_GATE_OWNER_SHARES=true`) also lets its own link mint and revoke
links, as `?token=` or `Authorization: Bearer`. It is for setups without a
backend: a scoped link is better than handing out the owner's own.

- **What it may mint:** any link within its own rights (watch, control,
  publish), never `owner`, expiring no later than its own link. An
  `expiresIn` that would be later is `400`; absent, it is the owner's.
- **How many:** its live links (not revoked, not expired) at most the
  session's connection ceiling (`maxMembers`, else
  `GLASS_MAX_VIEWERS_PER_SESSION`), and 60 a minute. Past either, `429`
  `rate_limited`. A revoked or expired link frees its place.
- **Revoking:** only the links it minted (`403` `link_not_allowed` otherwise).
- `hello`'s `mayShare` is `true` for the owner of such a session; the session
  and its create answer carry `ownerMayShare`.

Some links, for a browser session:

| Rights | Who it's for |
|---|---|
| `{"watch": "all"}` | A viewer who only watches. |
| `{"watch": "all", "control": ["browser"]}` | A viewer who may also use the page. |
| `{"publish": ["camera", "microphone"]}` | A phone that publishes and watches nothing. |
| `{"watch": "all", "publish": ["camera", "microphone"]}` | One side of a call. |

`GLASS_MAX_VIEWERS_PER_SESSION` (50 by default) caps a session's connections.

### Link expiry

Every link expires: the default is `GLASS_LINK_TTL_HOURS` (24 h; `0` is
never), and a request may set its own (`linkExpiresIn`, `expiresIn`; `0` is
never). `expiresAt` says when, absent for a link that never expires.

An expired link only stops **joining**: its connection is accepted and
closed at once with `4401`. It never ends the session or a connection
already in it, and a connection that joined with it still resumes inside
its reconnect grace. Whoever holds the API token can mint a fresh link at
any time.

### Runtime routes

| Method | Path | |
|---|---|---|
| `GET` | `/healthz` | Liveness. |
| `GET` | `/readyz` | `200` when a pooled browser answers, `503` otherwise. Also reports free disk space (informational). |
| `GET` | `/v1/info` | Sessions, capacity, license tier, `protocolVersion`, the codecs this engine serves, its build and Chrome, its security settings, and `pressure`: what it refused and dropped over the last minute. |
| `GET` | `/v1/metrics` | The same in Prometheus text format. API token only. |
| `POST` | `/v1/tickets` | Redeem a session ticket (below). |

### Recordings

Recording is off unless `GLASS_RECORDING_DIR` is set, and starts only when the
API token asks, for one session: `POST /v1/sessions/{id}/recording` with
`{"action": "start"}` (`201`) or `{"action": "stop"}` (`200`), or
`"record": true` when making it. See [Recording](recording.md). All routes
take the API token only.

| Method | Path | |
|---|---|---|
| `GET` | `/v1/recordings` | Every recording, newest first. |
| `GET` | `/v1/recordings/{id}` | `{id, sessionId, sessionKind, videoCodec, audio, file, timeline, startedAt, stoppedAt?, stopReason?, bytes, durationMs, gaps, active}`. `stopReason`: `api`, `session_closed`, `max_size`, `max_duration`, `disk_low`, `write_error`, `shutdown` or `interrupted`. |
| `GET` | `/v1/recordings/{id}/file` | The media, `video/webm` or `video/x-matroska`, with range requests. `409` while it runs. |
| `GET` | `/v1/recordings/{id}/timeline` | Its timeline (below), `application/x-ndjson`, also while it runs. |
| `DELETE` | `/v1/recordings/{id}` | Delete it. `204`; `409` while it runs. |
| `POST` | `/v1/recordings/{id}/play` | Play it back as a session with one `playback` source: `201 {id, protocolVersion, link, sources, recording}`. Optional body `{"linkExpiresIn"}`. |

**The timeline** is one JSON object a line, `{"t", "type", …}`, `t` in
milliseconds on the media's clock. It holds IDs, origins, kinds, positions,
sizes and counts; never typed or pasted text, a key's value, a URL past its
origin, or a dialog's message.

| `type` | Fields |
|---|---|
| `start` | `sessionKind`, `videoCodec`, `audio` |
| `stop` | `reason` |
| `join`, `leave` | `connectionId`, `producer`; `join`: `caps`, `resumed`; `leave`: `reason` (`left`, `dropped`, `revoked`) |
| `input` | `connectionId` (`api` for the API's own), `kind` (`move`, `button_down`, `button_up`, `scroll`, `key_down`, `key_up`, `touch_start`, `touch_move`, `touch_end`, `touch_cancel`, `navigate` with `origin`, `back`, `forward`, `refresh`, `viewport`, `paste`, `copy`, `dialog_answer`, `other`), and any of `x`, `y`, `deltaX`, `deltaY`, `button`, `width`, `height` |
| `floor` | `connectionId`, or null when no one has the page |
| `navigation` | `origin`, `count` |
| `load` | `loads` |
| `dialog` | `open`; when it opens, `dialogType` |
| `popup` | `count` |
| `size` | `width`, `height`: the picture's size, from each keyframe that changes it |
| `gap` | `gaps`: the disk fell behind and video was dropped up to here |

### Server-side input

`POST /v1/sessions/{id}/sources/{sourceId}/input` with `{"type", "data"}`, as
in the DataChannel input table below. The operator's backend, not a viewer:
it reaches the page in either input mode. With `"floor": true` (and
`"wait"`, ms, default 2000, at most 10000) it takes the source's floor as
the controller `api`, waiting for a person to pause, and is `409`
`floor_taken` (with `holder`) if they don't; what the API holds down is
released after 5 s without API input.

`202`; `400` for an unknown or invalid action; `400`
`navigation_not_allowed` for a `navigate` the navigation rules refuse (a
scheme other than http or https, loopback, a private or link-local address);
`429` when rate limited.

### Session tickets

A ticket lets a browser make a session without the API token. Your backend
signs it with `GLASS_TICKET_SECRET` (comma-separated to rotate) and hands it
to the page, which sends `POST /v1/tickets` with `{"ticket": "<ticket>"}`.

A ticket is a JWT signed with HMAC-SHA-256; the header must be exactly
`{"alg":"HS256"}` (with `"typ":"JWT"` allowed). Claims:

- `exp` (required): at most 10 minutes ahead; 30 s of clock skew allowed.
- `jti` (required, up to 128 bytes): each ticket is accepted once, across
  restarts.
- `nbf` (optional): honoured.
- `glass` (optional): the session's options, `audioInput`, `contentHint`,
  `codec`, `inputMode` and `linkExpiresIn`, and `watchLinks` (0 to 10).

The answer is `POST /v1/sessions`'s, plus `watchLinks` (watch-only links, as
many as asked) when asked for. `401` with `ticket_invalid`, `ticket_expired`
or `ticket_used`. A refusal for options or capacity does not spend the
ticket. A ticket opens only this route.

`glass gate` hands tickets to browsers for you; see
[Deployment](deployment.md).

### The session service: `glass gate`

`glass gate` runs beside the engine and gives a browser a session ticket, so a
website gets a browser from the engine's pool with nobody handing out links
and no API token in the page. The browser redeems the ticket with the engine
(`POST /v1/tickets`), which makes the session then. Setting it up is in
[Deployment](deployment.md).

| Method | Path | |
|---|---|---|
| `POST` | `/v1/ticket` | `{}` for an `open` gate, `{"passphrase"}` for `passphrase`, `{"code"}` for `links`. `201` with `{"engine", "ticket"}`: the engine's public address and a ticket for one session with the engine's defaults, valid 2 minutes. `401` `gate_refused` for a wrong passphrase or a code that is not valid, expired or used up; `429` `rate_limited` with `Retry-After`; `403` `origin_not_allowed`; `503` `unavailable`. |
| `GET` | `/healthz` | `200`. |

### Session statistics

`GET /v1/sessions/{id}/stats/stream` sends one Server-Sent Event every 2 s for
each live source, naming it (`source`): a JSON object of running totals since
the session started. The frame fields:

| Field | Meaning |
|---|---|
| `framesCaptured` | frames the capture delivered |
| `framesEmitted` | captured frames that carried a picture and went on toward the encoder |
| `framesDroppedCongestion` | captured frames not encoded because a viewer's path could not carry them: the sum of the three below |
| `framesDroppedForWindow` | dropped while more data was in flight than the path's congestion window allows |
| `framesDroppedByDropper` | dropped to hold an encoder that runs over its target bitrate to it |
| `framesPausedForQueue` | held back while a viewer's send queue would take over 2 s to leave |
| `encodedBytes`, `keyframesEncoded` | the encoder's whole output; every encoded frame is sent |
| `targetBitrateBps` | the congestion controller's send-rate target, the lowest across the session's viewers; 0 with no estimate |

Frames are dropped before they are encoded, never after, so every encoded
frame is sent and a drop never needs a keyframe to recover. The object carries
more fields (transport, input latency, memory, the encoder in use, audio, and
for a browser its capture level and why it last stepped down for CPU); treat
new fields as additions.

### Rate limits

Making sessions and playing recordings is limited per client to
`GLASS_CREATE_RATE_PER_MINUTE` (120 a minute by default, bursts of 40), and
redeeming tickets to `GLASS_TICKET_RATE_PER_MINUTE` (10, bursts of 4).
Behind a trusted proxy (`GLASS_TRUSTED_PROXIES`) the client is the address
it forwards. Past a limit: `429` `rate_limited` with `Retry-After`. `0` turns
a limit off.

### Errors

Every error from an HTTP route, a refused WebSocket handshake included, is

```json
{ "error": "a sentence for people", "code": "a_code_for_programs" }
```

The sentence may change between releases; the code does not. A body may
carry more fields (`floor_taken`'s `holder`).

| `code` | Status | Meaning |
|---|---|---|
| `bad_request` | 400 | Malformed, or a field out of range. |
| `navigation_not_allowed` | 400 | A URL the navigation rules refuse. |
| `unauthorized` | 401 | No credential, or one the engine does not know. |
| `ticket_invalid`, `ticket_expired`, `ticket_used` | 401 | A session ticket refused. |
| `link_expired`, `link_revoked` | 401 | A link past its expiry, or revoked. |
| `gate_refused` | 401 | `glass gate` refused: its passphrase or link code is not right. |
| `origin_not_allowed` | 403 | A browser origin the engine does not allow. |
| `link_not_allowed` | 403 | A link without the right this needs. |
| `inspect_off` | 403 | A page route on a source made without `"inspect": true`. |
| `session_not_found` | 404 | No such session, or it has ended. |
| `source_not_found` | 404 | No such source in the session, or it has ended. |
| `not_found` | 404 | No such thing in the session: a download, a link id. |
| `unsupported` | 400, 404, 409, 501 | The source or session cannot do this. |
| `session_full` | 409 | The session has `maxMembers` connections already. |
| `no_page`, `stale_ref`, `no_dialog`, `dialog_open` | 409 | Page routes: no page yet; a reference from an earlier snapshot; no dialog open; a dialog blocks the page. |
| `floor_taken` | 409 | Another connection has the page (input mode `floor`); see `holder`. |
| `no_file_chooser` | 409 | Files uploaded with no file chooser waiting. |
| `recording_off` | 409 | Recording asked for with no `GLASS_RECORDING_DIR`. |
| `already_recording`, `not_recording` | 409 | Start while recording; stop while not. |
| `recording_active` | 409 | A recording fetched, played or deleted while it still runs. |
| `recording_unplayable` | 409 | A recording with nothing that can be played. |
| `too_large` | 413 | A file, a batch or a JSON body over its limit. |
| `rate_limited` | 429 | Too many requests or inputs; see `Retry-After`. |
| `internal_error` | 500 | A fault in the engine; the detail is in its log, never the body. |
| `viewer_limit` | 503 | A watching member refused at the engine's viewer limit; not final. |
| `at_capacity`, `hard_cap_reached`, `shutting_down`, `unavailable` | 503 | No session slot; no hardware headroom; the engine is stopping; not available now. |
| `recording_limit` | 503 | Too many recordings already run. |
| `disk_low` | 507 | Too little free disk where recordings are kept. |

Three codes arrive only in signaling's `error` message:

| `code` | Meaning |
|---|---|
| `source_failed` | The connection's source stopped for good (its browser died); the session has ended. The socket closes next with `1011`. |
| `session_not_resumable` | A reconnect found a session that cannot resume; it has ended. |
| `not_connected` | The connection's WebRTC is not up 20 s after Glass's answer: its network may not reach the engine or its TURN server. The socket stays open; the client may restart ICE or leave. |

### WebSocket close codes

| Code | Sent by | Meaning |
|---|---|---|
| `1000` | Client | A deliberate leave: no reconnect grace. |
| `4401` | Glass | The link has expired. Don't retry; get a new link. |
| `4403` | Glass | The link was revoked. Don't retry. |
| `4404` | Glass | The session doesn't exist, or it ended while connected. Don't retry. |
| `4503` | Glass | Refused at a viewer limit. Not final: try again later. |
| `1011` | Glass | The session's source stopped; the session has ended. |
| anything else | either | A lost connection: held for the reconnect grace. |

Every socket is pinged; a client that doesn't answer within 30 s is treated
as gone (browsers answer on their own).

## Signaling

The WebSocket at a link's `url`. Every message is JSON with a `type`.

**The client offers; Glass answers.**

1. Glass's first message is `hello`: the protocol version, the ICE servers to
   use, who this connection is, what it may do, and the session's sources.
2. The client adds its receive slots (three video and three audio, as
   `@glass/client` does, so a join usually needs no second round), a
   DataChannel, and any tracks it publishes (each announced with `publish`
   first), and sends its `offer`.
3. Glass answers (`answer`), and says which slot carries which source
   (`tracks`). ICE candidates go both ways (`ice-candidate`).
4. When Glass has more to send than the client has slots, it says how many
   more (`slots_needed`); the client adds them and offers again. Only one
   offer is in flight at a time.

A source added later is announced (`source_added`) and takes a slot; one
removed is announced (`source_removed`) and stops being sent, with no
renegotiation.

### Client → Glass

| `type` | Fields | |
|---|---|---|
| `offer` | `sdp` | The client's offer: its receive slots, its DataChannel and what it publishes. |
| `ice-candidate` | `candidate` | A trickled ICE candidate. |
| `publish` | `mid`, `kind` | Announce a track before the offer that carries it: `camera`, `microphone`, `screen` or `device`. See [Publishing](sources/producers.md). |
| `unpublish` | `mid` | Stop publishing that track; its source is removed for everyone. |
| `producer_report` | `mid`, `uplinkKbps`, `layers: [{rid, active, width, height}]` | A simulcast publisher, about once a second: its uplink estimate and its layers. Answered with `layers_wanted`. |
| `receive` | `source`, `paused` | Pause or resume this connection's picture of a source. Others go on receiving it. |
| `navigate` | `url`, `source?` | Navigate a browser source. Owner only. |
| `initial_viewport` | `width`, `height`, `isMobile?`, `userAgent?` | Sent once, right after connecting: the viewer's size, and whether to emulate a phone. |
| `request_input`, `release_input` | `source?`, `id?` | Ask to hold a source's input, or give it up. See "Control". |
| `grant_input`, `revoke_input`, `grant_watch`, `deny_watch` | `connectionId`, `source?`, `id?` | The owner acting on another member. See "Owner-controlled handoff". |
| `mic_granted`, `mic_denied` | none | The answer to `MicAccessRequested` (see "The page's microphone"). |
| `clock_probe_reply` | `id`, `clientT` | The answer to a `clock_probe`. |

A message that leaves out `source` is about the session's default source
(its first live one).

### Glass → client

| `type` | Fields | |
|---|---|---|
| `hello` | `protocolVersion`, `iceServers`, `connectionId`, `rights`, `owner`, `sources`, `members?`, `simulcast`, `mayShare` | The first message. `iceServers` is an `RTCConfiguration`'s; with the engine's own TURN it carries a credential minted for this connection, fresh on every reconnect. `members` (the other members, `{connectionId, owner, rights}`) for an owner only. `simulcast`: whether a picture published here is taken as layers (see [Publishing](sources/producers.md)). `mayShare`: whether this connection may mint links (see "Owner sharing"). Nothing is sent before it. |
| `answer` | `sdp` | Glass's answer. |
| `tracks` | `tracks: [{mid, kind, source}]` | Which receive slot carries which source, after every answer. |
| `slots_needed` | `video`, `audio` | Add this many receive slots and offer again. |
| `ice-candidate` | `candidate` | A trickled ICE candidate. |
| `source_added` | `source` | A source this connection may watch joined. |
| `source_updated` | `source` | Its state changed short of ending: `stalled`, or `live` again. |
| `source_removed` | `id`, `reason` | It ended (`removed`, `failed`). Not sent when the whole session ends. |
| `rights_changed` | `rights`, `denied: {watch, control}` | The owner denied this connection a source, or lifted it. |
| `input_holders` | `source`, `holders`, `floor` | Who holds a source's input, and who has its floor now. On joining, then on every change. |
| `input_requested` | `source`, `connectionId` | Sent to the holders when a request can't be granted at once. |
| `control_answer` | `action`, `outcome`, `source`, `reason?`, `connectionId?`, `id?` | The one answer to every control request. |
| `member_joined`, `member_left` | `connectionId`, … | Owners only: a member came or went. |
| `publish_refused` | `mid`, `reason` | A published track Glass did not take: `invalid`, `not_allowed` or `codec_mismatch`. |
| `layers_wanted` | `mid`, `rids` | A simulcast publisher: the layers to send now; turn the others off. |
| `connection_quality` | `quality`, `score` | This connection's quality, `excellent`, `good`, `poor` or `lost` (score 0–100), on each change, at most every 5 s. |
| `recording` | `active` | Whether the session is being recorded; on joining, then on every change. |
| `playback` | `source`, `playing`, `positionMs`, `durationMs`, `ended` | A playback source's state: on joining, on every change, once a second while playing. |
| `timeline` | `source`, `event` | A recording's timeline event, as playback passes it. |
| `new_tab_request` | `url` | The page tried to open a popup or tab; the client decides what to do. |
| `clock_probe` | `id` | Clock calibration before the DataChannel opens; answer at once with `clock_probe_reply`. |
| `error` | `error`, `code?` | A message about this connection. Final only for `source_failed` and `session_not_resumable` (don't reconnect after either). |

A transport failure sends no `error`: the socket closes, and the client
reconnects within the grace.

## Control

Each source that takes input has its own **input**: its holders, and its
floor. A connection whose link may control a kind holds the input of every
live source of that kind as it joins.

- `request_input` asks to hold a source's input. If the engine can admit it
  now (the license tier and capacity), it is granted and `input_holders` is
  sent to everyone. Otherwise Glass sends `input_requested` to the current
  holders and changes nothing: your app decides whether to ask a person,
  decline or ignore it. Glass never queues or takes control on its own. A
  link that never included control of that kind is refused (`not_allowed`):
  **a watch link stays a watch link**.
- `release_input` gives it up.
- `control_answer` answers every control request, a refused one included,
  so a client never waits on silence: `outcome` is `granted`, `relayed`,
  `released`, `revoked` or `refused`, with `reason` on a refusal
  (`not_allowed`, `not_owner`, `no_capacity`, `unknown_connection`,
  `unknown_source`, `rate_limited`, `invalid`), and `id` echoing the
  request's.

Navigation (`navigate`, `back`, `forward`, `refresh`) is the owner's alone,
whoever holds the input: it changes what everyone sees.

### Input arbitration

With several holders, the source's `inputMode` decides whose input reaches
the page. A source with one holder behaves the same in both.

- **`floor` (the default): one at a time.** The first holder to send input
  has the page, while it holds anything down and until it has been idle for
  100 ms after a pointer or touch event, or 1 s after a key or wheel event.
  Others' input meanwhile is dropped (`InputDropped`, `floor_taken`).
  `input_holders`' `floor` names who has it.
- **`free`: everyone at once.** One pointer jumps between people; keys land
  in whichever field was focused last. `floor` is always `null`.

The page size is set by one connection: the owner's while it holds the
input, otherwise the holder connected longest. Keys and buttons a
connection holds down are released when it leaves or loses the input.

### Owner-controlled handoff

The connection that joined with the session's own link is the **owner**. It
acts on other members directly, each answered with `control_answer`:

| `type` | |
|---|---|
| `grant_input` | Give a member a source's input, without it asking. Passes the same license and capacity check as `request_input`. |
| `revoke_input` | Take it away, however it was got. |
| `deny_watch` | Stop a member receiving a source; it is told (`rights_changed`) and cannot resume it itself. |
| `grant_watch` | Lift that denial. |

An owner learns who is there from `hello`'s `members`, then `member_joined`
and `member_left`. Other members never receive these. Glass renders no
member list and decides nobody's control: it gives the owner's app the
information and the authority, and the app decides.

## DataChannel input (client → Glass)

Every input message is a JSON string:

```json
{ "type": "<action>", "data": { … }, "source": "<id>" }
```

`source` names the source it is for; left out, the session's default
source. It is dropped (`not_authorized`) when the connection does not hold
that source's input.

| `type` | `data` | |
|---|---|---|
| `mousemove` | `x, y`, `dragging` | Batched by the client at about 60 a second; sent at once while dragging. |
| `mousedown`, `mouseup` | `x, y`, `button?`, `modifiers?`, `clickCount?` | `button` `"left"` (default), `"right"` or `"middle"`; `clickCount` the browser's own (1, 2, 3). |
| `scroll` | `deltaY`, `deltaX?`, `modifiers?` | A real `wheel` event at the pointer. |
| `touchstart`, `touchmove` | `points: [{x, y, id}]` | Real touch events, at most 5 points. |
| `touchend`, `touchcancel` | | |
| `keydown`, `keyup` | `key`, `code`, `modifiers` | `modifiers`: Alt=1, Ctrl=2, Meta=4, Shift=8. |
| `navigate` | `url` | Owner only. |
| `back`, `forward`, `refresh` | | Owner only. |
| `set_viewport` | `width, height` | A resize after `initial_viewport`. |
| `copy_text` | | Answered with `ClipboardText`. |
| `paste_text` | `text` | |
| `dialog_answer` | `accept`, `text?` | Answer the page's JavaScript dialog (`Dialog`). |
| `playback` | `action`, `positionMs?` | A playback source's controls. |
| `input_latency_report`, `clock_probe_reply`, `client_stats_report` | | Diagnostics, allowed for every connection. |

Interaction inputs may carry `s`, a sequence number the client uses to
match `InputFrame` to its own send times. Coordinates are CSS pixels of the
streamed picture. Every number is range-checked; invalid input is dropped
and reported (`InputDropped`, `invalid`).

## DataChannel messages (Glass → client)

Binary messages, the first byte their type. Each names the source it is
about: a JSON message carries `"source"`, and `ViewportSize` carries the
source's id as UTF-8 after its height.

| Byte | Name | Payload | |
|---|---|---|---|
| `0x04` | `InputFrame` | JSON `{f, i: [{s, c?}]}` | Which of this connection's inputs a frame just sent followed, for its own input-latency measure. |
| `0x05` | `ElementStateUpdate` | JSON `{cursor, editableFocused}` | |
| `0x06` | `NavigationState` | JSON `{url, loading, canGoBack, canGoForward}` | |
| `0x07` | `ViewportSize` | int32 LE width, int32 LE height, source id | |
| `0x08` | `ClockProbe` | JSON `{id}` | Answer with `clock_probe_reply` on the DataChannel. |
| `0x09` | `ClipboardText` | JSON `{text}` | The answer to `copy_text`. |
| `0x0A` | `InteractiveElements` | JSON `{elements: [{x, y, width, height}]}` | Phones only: where the page's text fields are, for the on-screen keyboard. |
| `0x0B` | `ConsoleMessage` | JSON `{level, text}` | The page's own console, at most 2 KB a line and 50 lines a second. |
| `0x0C` | `DownloadReady` | JSON `{filename, guid}` | A page download is ready, to connections that control the page. Show a prompt; fetch it on the person's click. Unclaimed downloads are deleted after 10 minutes. |
| `0x0D` | `FileChooserOpened` | JSON `{multiple}` | The page opened a file picker: raise the person's own and upload the result. |
| `0x0E` | `FileChooserClosed` | JSON `{}` | That picker is no longer waiting (60 s passed, or another opened). |
| `0x0F` | `MicAccessRequested` | JSON `{origin}` | The page asked for a microphone (see below). |
| `0x10` | `InputDropped` | JSON `{code, eventType, source, count, s?}` | Glass dropped this connection's input: `rate_limited`, `not_authorized`, `owner_only`, `floor_taken`, `unsupported` or `invalid`. At most one report per 2 s for each code and type. |
| `0x11` | `Dialog` | JSON `{open, type?, message?, defaultPrompt?, inPicture}` | The page's JavaScript dialog, opened or closed. `inPicture` is true when the dialog is drawn in the stream; otherwise the viewer shows it. |
| `0xFF` | `Error` | JSON `{code, error}` | The source's video encoder stopped for good (`encoder_failed`). |

### The page's microphone

A source made with `"audioInput": true` can be given a microphone. When the
page asks for one, connections that control it get `MicAccessRequested`; the
first to answer wins, and 60 s of silence is a refusal. To grant: capture
the person's microphone, put it on the audio line already in the offer
(`@glass/client` offers a silent placeholder on every connection to a
browser session, so no renegotiation is needed), then send `mic_granted`.
`mic_denied` refuses.
