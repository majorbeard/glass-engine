# Concepts

This page describes the model every Glass source shares. The source-specific
pages ([hosted browser](sources/browser.md), [relay producers](sources/producers.md),
[calls](sources/calls.md)) describe only what differs.

## Sources and sessions

A **source** is where the media comes from: a browser Glass runs, an external
producer, or the two peers of a call. A **session** is one running source plus
everyone connected to it. You create a session over HTTP; the response gives
you URLs to connect to it:

| Session type | Create | You get back |
|---|---|---|
| Hosted browser | `POST /v1/sessions` | `signalingUrl` |
| Relay | `POST /v1/relay-sessions` | `signalingUrl` for viewers, `produceUrl` (one per slot) for producers |
| Call | `POST /v1/calls` | `peerAUrl`, `peerBUrl` |

Every response also carries `protocolVersion`, `sourceType` (`"browser"`,
`"relay"`, `"call"`) and, for browser and relay sessions, `capabilities`: what
this source can do (video, navigation, viewport, clipboard, the input actions it
accepts). A client reads `capabilities` instead of guessing from the source type.

### Lifecycle

- A new session is `pending`. If nobody connects in time it is closed: 30 s for
  a browser session (it holds a browser), 10 min for relay and call sessions.
- The first connection makes it `active`. It stays active while anyone is
  connected.
- It is `closed` when you `DELETE` it, or when its last connection is gone
  and that connection's reconnect grace has run out.

`GET /v1/sessions/{id}` (and the relay and call equivalents) report the state.

## Connections and capabilities

A session accepts many connections at once. Each connection has four
capabilities:

| Capability | Meaning |
|---|---|
| `consumesMedia` | Receives the session's video and audio. |
| `producesInput` | May send input to the source (mouse, keyboard, touch, …). |
| `producesMedia` | May publish media into the session (relay producers, call peers). |
| `consumesInput` | Reserved. Refused with `400` until the source-side control direction exists. |

The URL returned at session creation carries the **default** capabilities for
its role: full control for a hosted browser's `signalingUrl`, publish for a
`produceUrl`, send and receive for a call peer.

To hand out narrower access, **mint a grant**:

```sh
curl -X POST -H "Authorization: Bearer $GLASS_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"consumesMedia": true}' \
  http://glass.example.com/v1/sessions/$ID/connections
```

The response has its own `signalingUrl`, limited to what you asked for. The
limits are enforced by the server: input from a connection without
`producesInput` is dropped by Glass, not merely hidden by the client. For relay
sessions, use `POST /v1/relay-sessions/{id}/connections`; the response includes
a `produceUrl` only if you asked for `producesMedia`.

Watch-only links can be shared freely and reused. A session admits at most 50
connections by default (`GLASS_MAX_VIEWERS_PER_SESSION`).

### Tokens in URLs

When `GLASS_API_TOKEN` is set, every URL Glass returns ends in `?token=…`. That
token is **not** the API token. It is a per-session (or per-grant) credential
that only opens that session's WebSocket, stats stream and file endpoints, and
stops working when the session closes. It lives in the URL because a browser's
`WebSocket` can't send an `Authorization` header. Treat these URLs as secrets
anyway: anyone holding one gets its capabilities.

Keep the API token on your backend. The intended flow:

1. Your backend creates the session (and any grants) with the API token.
2. It gives each client only the URL that client should have.
3. Your backend deletes the session when the user is done.

## Owner and control handoff

The connection that uses the session's own URL, rather than a minted grant, is
the session's **owner**. The owner can navigate (hosted browser), sees who
else is connected, and can move control between connections.

Any connection can:

- `request_input`: ask for control. If it can be admitted, Glass grants it at
  once and tells every connection (`capabilities_changed`). If not, Glass
  forwards the request to whoever holds control now (`input_requested`) and
  changes nothing. Your app decides whether to prompt a person or decline.
  Glass never queues or preempts on its own.
- `release_input`: give control back.

The owner can also:

- `grant_input` / `revoke_input`: give control to, or take it from, a specific
  connection.
- receive the roster: `roster` once on connect, then `connection_joined` and
  `connection_left`.

A viewer that holds control uses a seat from the license's session limit, the
same as a session does. Watch-only viewers use none.

`@glass/client` exposes all of this as `requestInput()`, `releaseInput()`,
`grantInput()`, `revokeInput()`, `isOwner()`, `connections()` and the
`capabilitiesChanged`, `inputRequested` and `rosterChanged` events. Glass
provides the mechanism; the policy (who should get control, and when) belongs
to your app.

## Reconnects

Networks drop: phones lock, Wi-Fi hands over to cellular. Glass treats a
connection that ends without a deliberate close as **lost, not finished**:

- A WebSocket closed with code `1000` is a deliberate leave. The connection is
  gone at once.
- Any other ending (another close code, a TCP reset, a timeout) holds the
  connection for the **reconnect grace**, 60 s by default
  (`GLASS_RECONNECT_GRACE_SECONDS`). Reopening the same URL resumes it. A
  hosted browser keeps its page and history; a relay slot stays reserved for
  its producer.
- While every connection of a session is in grace, Glass pauses the source's
  encoding.
- When the session no longer exists, Glass closes the WebSocket with code
  `4404`. Don't retry that URL.

`@glass/client` handles all of this for you: it retries at once, then after
1, 2, 4, 8 and 16 s, up to 8 attempts by default, and emits `reconnecting`,
`connected` and `closed`.
`GlassProducer` does the same for producers, and starts a new relay session if
the old one can't be resumed.

## Media

- Video arrives as a normal WebRTC video track: H.264 by default, VP8 when the
  operator enables it. Relay and call sessions report the codec as
  `videoCodec`, and producers must send that codec.
- Audio, when present, is an Opus track.
- Input and state messages travel on a WebRTC DataChannel; video never does.
- Each viewer gets its own bandwidth estimate (Google Congestion Control), and
  lost packets are retransmitted. A hosted browser adapts its encoding to the
  viewers' bandwidth. Relay streams are forwarded as the producer sent them.

The wire-level detail is in [protocol.md](protocol.md), and the path media takes
through the engine is in [architecture.md](architecture.md).
