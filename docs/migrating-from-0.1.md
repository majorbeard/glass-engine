# Migrating from 0.1

Glass 0.2 speaks **protocol 3**. A 0.1 client can't connect to a 0.2 engine,
and a 0.2 client can't connect to a 0.1 engine: each refuses the other's
version (`protocol_mismatch`) rather than guess. Move the engine, your backend
and your clients together.

## What changed, in one paragraph

0.1 had a kind of session for each kind of source: browser sessions, relay
sessions and calls, each with its own routes and URLs. In 0.2 there is one
kind of session, and it holds **sources**: a hosted browser, a recording's
playback, or a track one of its members publishes. People join as
**members**, each with a **link** whose rights say what it may watch,
publish and control. Everything you do to a source names it. See
[Concepts](concepts.md).

## The HTTP API

| 0.1 | 0.2 |
|---|---|
| `POST /v1/sessions` (a browser session), options at the top level (`codec`, `contentHint`, `inputMode`, `inspect`, `audioInput`) | `POST /v1/sessions` with `{"sources": [{"kind": "browser", "codec", "contentHint", "inputMode", "inspect", "audioInput", "url"}]}`. An empty body makes a session whose members publish. |
| The answer's `signalingUrl`, `capabilities`, `sourceType`, `linksExpireAt` | `link` (`{id, url, rights, expiresAt}`) and `sources` (each with its own `capabilities`) |
| `POST /v1/relay-sessions`, its `produceUrl` and slots | `POST /v1/sessions` with no sources, and a link that publishes: `POST /v1/sessions/{id}/links` with `{"publish": ["camera", "microphone"]}`. Each published track is a source; there are no slots. See [Publishing](sources/producers.md). |
| `POST /v1/calls`, `peerAUrl`, `peerBUrl` | `POST /v1/sessions` with `{"maxMembers": 2}`, and two links that each watch and publish. See [Calls](sources/calls.md). |
| `POST /v1/sessions/{id}/connections` with capabilities (`consumesMedia`, `producesInput`, `producesMedia`) | `POST /v1/sessions/{id}/links` with rights: `{"watch": "all"}`, `{"watch": "all", "control": ["browser"]}`, `{"publish": [...]}` |
| `DELETE /v1/sessions/{id}/connections/{linkId}` | `DELETE /v1/sessions/{id}/links/{linkId}` |
| `POST /v1/sessions/{id}/input`, `/page/…`, `/downloads/{guid}`, `/upload` | The same under the source: `/v1/sessions/{id}/sources/{sourceId}/input`, `/page/…`, `/downloads/{guid}`, `/upload` |
| `POST /v1/recordings/{id}/play` answering a `signalingUrl`; `/v1/playback-sessions/{id}/…` | The same route answers a session with one `playback` source, under `/v1/sessions/{id}`; its controls are `POST /v1/sessions/{id}/sources/{sourceId}/control` |
| A ticket's `watchUrls` | `watchLinks`, each a link |
| A `url` on create waited for the page to load, and a load failure was a `400` | The URL is checked first (a refused one is still `400 navigation_not_allowed`), then the answer, then the page loads; a load failure is reported as any navigation's |
| — | New: `POST /v1/sessions/{id}/sources` and `DELETE …/sources/{sourceId}` add and remove a browser while the session runs |

## Signaling

| 0.1 | 0.2 |
|---|---|
| Connect at `…/signaling`, `…/produce`, or a call peer's URL | Connect at a link's `url` (`…/connect?token=`) |
| Glass sent `ice_config`, then **Glass offered** and the client answered (a producer or call peer offered) | Glass sends `hello` first; **every client offers**, Glass answers, and says which line carries which source (`tracks`) |
| A client attached a silent audio track before answering | A client offers a silent audio line on a session with a browser source |
| `capabilities_changed`, `input_floor` | `input_holders` (per source: its holders and its floor) |
| `roster`, `connection_joined`, `connection_left` | `hello`'s `members`, then `member_joined`, `member_left` |
| `slot_state` | `source_added`, `source_updated` (`live`, `stalled`), `source_removed` |
| — | New: `publish`, `unpublish`, `publish_refused`, `receive`, `rights_changed`, `grant_watch`, `deny_watch` |
| Control messages about "the page" | Each names its `source`; left out, the session's default source |

DataChannel messages are the same, each now naming its source. See
[the protocol](protocol.md).

## Close codes and errors

| 0.1 | 0.2 |
|---|---|
| A producer silent for 10 s was closed with `4001`, and reconnected | Gone: a quiet track is shown as `stalled` and never disconnected |
| `producer_not_connected` | `not_connected`, for every member |
| `audio_not_supported_multi_slot` | Gone, with slots |
| A second producer on a slot: `409` | Gone, with slots |

## Configuration

| 0.1 | 0.2 |
|---|---|
| `GLASS_RELAY_STALL_CLOSE_MS`, `GLASS_RELAY_FIRST_MEDIA_GRACE_MS` | Removed: Glass no longer disconnects a quiet publisher |
| `GLASS_MAX_STREAM_SLOTS` | Removed, with slots |
| `GLASS_RELAY_MAX_VIEWERS`, `GLASS_RELAY_PENDING_TTL_SECONDS`, `GLASS_RELAY_STALL_THRESHOLD_MS` | Unchanged, and apply to sessions whose members publish |

## `@glass/client`

| 0.1 | 0.2 |
|---|---|
| `createGlassClient({ signalingUrl, sessionId?, deleteSessionOnClose?, apiToken? })` | `new GlassClient({ link })`. A client never makes or deletes a session: your backend does, or the session ends when its last member leaves. |
| `client.on("videoTrack", stream)` | `client.on("track", (sourceId, stream))`, one stream per source; `client.source(id).stream()` |
| `client.navigate(url)`, `mouseDown(…)`, `dispatchKeyEvent(…)`, `copyText()`, `uploadFiles(…)`, `answerDialog(…)`, `controlPlayback(…)` … | The same methods on the source's handle: `client.source(id).navigate(url)` |
| `requestInput()`, `releaseInput()`, `grantInput(id)`, `revokeInput(id)`, `floorHolder()` | The same on the source's handle; and `grantWatch(id)`, `denyWatch(id)`, `holders()`, `receive(paused)` |
| `producesInput()`, `connections()` | `rights()`, `source(id).holdsInput()`, `members()` |
| Events `capabilitiesChanged`, `floorChanged`, `rosterChanged`, `slotStateChanged` | `inputHolders`, `membersChanged`, `rightsChanged`, `sourceAdded`, `sourceUpdated`, `sourceRemoved` |
| Per-source events (`navigation`, `dialog`, `downloadReady` …) | The same, with the source's id as their last argument |
| `GlassProducer({ stream, produceUrl })` | `client.publish(track, { kind, simulcast?, maxBitrateKbps?, startBitrateKbps? })` on a `GlassClient` with a link that publishes, one call a track. It returns a `GlassPublication` (`stop()`, `getStats()`, events `refused`, `layers`, `silent`). |
| `GlassProducer`'s `stats` event (battery, network, encoder) | `publication.getStatsReport()`, the browser's own sender statistics; the phone example shows how to read them |
| `GlassProducer` made a new session after its old one was gone | A client never makes a session: on `closed` with `session_not_found`, your backend decides |
| `mintConnectionGrant({ sessionId, capabilities })` | `mintGlassLink({ sessionId, rights })`; `revokeGlassLink({ sessionId, linkId })` |
| `createGlassSession({ codec, contentHint, … })` | `createGlassSession({ sources: [{ kind: "browser", codec, contentHint, … }] })`, or no sources for a session whose members publish |
| `mountGlassViewer(el, client, options)` | `mountGlassViewer(el, client, { source, ...options })`: it shows one source |
| The reference viewer's `?attachSessionId=&attachSignalingUrl=` | `?attachLink=<url-encoded link>` |

## What 0.2 does not do yet

- **A session whose members publish can't be recorded** (`"record": true` is
  `400`). In 0.1, relay sessions could be. It comes in a later release.
