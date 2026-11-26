# Concepts

This page describes the model every Glass session shares. The source pages
([hosted browser](sources/browser.md), [publishing](sources/producers.md),
[calls](sources/calls.md)) describe only what differs.

## Sessions and sources

A **session** holds **sources**. A source is where media comes from:

| Kind | Where it comes from |
|---|---|
| `browser` | A browser Glass runs for the session. |
| `playback` | A [recording](recording.md) played back. |
| `camera`, `microphone`, `screen`, `device` | A track a member publishes into the session. |

Each source has an id, a kind, a state (`live`, `stalled`, `ended`) and
`capabilities`: what it can do (video, navigation, viewport, clipboard, the
input actions it takes). A client reads `capabilities` instead of guessing
from the kind.

You make a session over HTTP:

| What | Make it with |
|---|---|
| A hosted browser | `POST /v1/sessions` with `{"sources": [{"kind": "browser"}]}` |
| A session whose members publish (a phone's camera, a call) | `POST /v1/sessions` with no `sources` |
| A recording's playback | `POST /v1/recordings/{id}/play` |

Every one answers the same shape: `{id, protocolVersion, link, sources}`. A
browser added to a running session (`POST /v1/sessions/{id}/sources`) and a
track a member publishes join the session's sources while it runs; every
member who may watch them is told.

### Lifecycle

- A new session is `pending`. If nobody connects within 30 s it is closed, so
  an abandoned session holds no browser.
- The first connection makes it `active`. It stays active while anyone is
  connected.
- It ends when you `DELETE` it, or when its last member has left: closed
  deliberately, or gone for longer than the reconnect grace.
- A source can end alone (removed, or its browser failed, or its publisher
  left): the session goes on.

`GET /v1/sessions/{id}` reports the state and the sources.

## Members and links

A session accepts many connections at once, each a **member**. A member joins
with a **link**: a URL whose **rights** say what it may do.

| Right | Meaning |
|---|---|
| `watch` | The sources it receives: `"all"`, `"none"`, or a list of kinds. |
| `publish` | The kinds it may publish. |
| `control` | The kinds whose input it may hold (mouse, keyboard, touch, navigation for the owner). |

The link returned when the session is made is the session's own: the
**owner's**. It watches and controls everything. To hand out narrower access,
**mint a link**:

```sh
curl -X POST -H "Authorization: Bearer $GLASS_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"watch": "all"}' \
  https://glass.example.com/v1/sessions/$ID/links
```

The answer is `{id, url, rights, expiresAt}`. The limits are enforced by the
server: input from a member that doesn't hold a source's input is dropped by
Glass, not merely hidden by the client, and the sender is told why. Revoke a
link with `DELETE /v1/sessions/{id}/links/{linkId}`: it admits nobody again,
and its connections are closed.

A watch link watches, and nothing more, until someone gives it control: it
can't download or upload files, answer the page's microphone request, or read
the session's statistics. Treat one as public once shared. A session admits at
most 50 connections by default (`GLASS_MAX_VIEWERS_PER_SESSION`), or the
session's own `maxMembers`.

Every link expires for joining after 24 hours by default
(`GLASS_LINK_TTL_HOURS`), so one published by mistake stops working on its
own; set your own lifetime per link, or none. A member already in the session
is never cut off. See [protocol.md](protocol.md#link-expiry).

### Tokens in URLs

A link's URL ends in `?token=…`. That token is **not** the API token: it is a
credential for one session, that opens only its connection, its statistics
stream and its file routes, and stops working when the session ends. It lives
in the URL because a browser's `WebSocket` can't send an `Authorization`
header. Treat links as secrets anyway: anyone holding one gets its rights.

Keep the API token on your backend. The intended flow:

1. Your backend makes the session (and any further links) with the API token.
2. It gives each person only the link they should have.
3. It ends the session when the people are done, or lets it end when the last
   one leaves.

Or, when the browser should start the session itself: your backend signs a
[session ticket](protocol.md#session-tickets), and the browser redeems it once
for the session (`redeemGlassTicket`). `glass gate` does this for you.

## Owner and control handoff

The member that joined with the session's own link is the **owner**. The owner
can navigate a hosted browser, sees who else is there, and can move control
between members.

Each source that takes input has its own **input**: the members that hold it.
Any member can:

- `request_input`: ask to hold a source's input. If it can be admitted, Glass
  grants it at once and tells everyone (`input_holders`). If not, Glass passes
  the request to whoever holds it now (`input_requested`) and changes nothing.
  Your app decides whether to ask a person or decline. Glass never queues or
  takes control on its own.
- `release_input`: give it back.

The owner can also:

- `grant_input` / `revoke_input`: give a member a source's input, or take it.
- `deny_watch` / `grant_watch`: stop a member receiving a source, or let it
  again.
- see the members: in `hello`, then `member_joined` and `member_left`.

A member holding a browser's input uses a seat from the license's session
limit, as a session does. Watch-only members use none.

## Several people in control

Any number of members can hold one hosted browser's input. The page they share
has one pointer, one keyboard focus and one set of held keys, so the source's
**input mode** decides whose input reaches it. Choose it when you make the
source (`inputMode`); a source with one holder behaves the same in both.

- **`floor` (the default): one at a time.** The first member to send input has
  the page. It keeps it while it holds anything down (a key, a mouse button, a
  finger) and until it pauses: 100 ms after a pointer or touch event, 1 s after
  a key or wheel event, so no one can take over between two keystrokes.
  Meanwhile everyone else's input is dropped and reported to them
  (`floor_taken`), and every member is told who has the page
  (`input_holders`' `floor`), so your app can show "Ana is in control". The
  page frees at once when its controller leaves, gives up the input or has it
  revoked.
- **`free`: everyone at once.** Every holder's input reaches the page as it
  arrives. **With more than one active person this is chaos:** the one pointer
  jumps between them, one person's drag is moved by another's pointer, and keys
  land in whichever field was focused last. Use it only where that is the point
  (a demo, a party game).

Two rules hold in both modes:

- **One member sets the page size**: the owner's while it holds the input,
  otherwise the holder connected longest. When that member leaves or loses the
  input, the page takes the next one's size.
- **Held keys and buttons are released per member.** When a member leaves,
  gives up the input or has it revoked, Glass releases what it was holding
  down, and nothing anyone else holds.

Navigation stays the owner's in both modes. Input your backend sends with
`POST /v1/sessions/{id}/sources/{sourceId}/input` is not arbitrated: it
reaches the page in either mode and takes it from no one (unless it asks for
the floor).

`@glass/client` exposes all of this on a source's handle (`requestInput()`,
`releaseInput()`, `grantInput()`, `revokeInput()`, `grantWatch()`,
`denyWatch()`, `holders()`, `floorHolder()`) and on the client (`isOwner()`,
`members()`, and the `inputHolders`, `inputRequested`, `membersChanged` and
`rightsChanged` events). Glass provides the mechanism; the policy (who should
get control, and when) belongs to your app.

## Reconnects

Networks drop: phones lock, Wi-Fi hands over to cellular. Glass treats a
connection that ends without a deliberate close as **lost, not finished**:

- A WebSocket closed with code `1000` is a deliberate leave. The member is
  gone at once, and so are the sources it published.
- Any other ending (another close code, a TCP reset, a timeout) holds the
  member for the **reconnect grace**, 60 s by default
  (`GLASS_RECONNECT_GRACE_SECONDS`). Reconnecting with the same link resumes
  it: a hosted browser keeps its page and history, and a publisher publishes
  again as the same member.
- While every member of a session is in grace, Glass pauses a hosted
  browser's encoding.
- When the session no longer exists, Glass closes the WebSocket with code
  `4404`. Don't retry that link.

`@glass/client` handles all of this for you: it retries at once, then after
1, 2, 4, 8 and 16 s, up to 8 attempts by default, and emits `reconnecting`,
`connected` and `closed`.

## Media

- Video arrives as a normal WebRTC video track, one per source, in the
  session's codec: H.264 by default, VP8 or AV1 where the operator enables
  them (`codec` when making a browser source; `GET /v1/info` lists what the
  host serves). A publisher sends what the session takes.
- Audio, when present, is an Opus track, again one per source.
- Input and state messages travel on a WebRTC DataChannel; video never does.
- Each viewer gets its own bandwidth estimate (Google Congestion Control), and
  lost packets are retransmitted. A hosted browser adapts its encoding to the
  viewers' bandwidth: when a viewer's path can't carry what's captured, frames
  are dropped before they're encoded, never after, so every encoded frame is
  sent. Published tracks are forwarded as the publisher sent them; with
  simulcast, each viewer gets the layer its own link carries.

The wire-level detail is in [protocol.md](protocol.md), and the path media
takes through the engine is in [architecture.md](architecture.md).
