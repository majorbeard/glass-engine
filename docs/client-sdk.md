# Client SDK: `@glass/client`

The SDK has two parts:

| Import | What it is |
|---|---|
| `GlassClient` (`@glass/client`) | One member of a session on one connection: it watches the session's sources, controls them, and publishes tracks into it, and reconnects across drops. No DOM dependency. |
| `mountGlassViewer` (`@glass/client/viewer`) | Optional. Renders one source's video and captures mouse, keyboard, touch, scroll, gamepad and viewport input for it. |

**Installing.** The package isn't published to npm yet. Clone this repository,
run `npm install && npm run build` at its root, then add it to your app with
`npm install <path-to-glass-engine>/packages/client`.

The full typed surface is in [`packages/client/api/`](../packages/client/api),
which the package's build checks against, so it is always current.

**Coming from 0.1?** `GlassProducer`, `signalingUrl` and `mintConnectionGrant`
are gone; see [Migrating from 0.1](migrating-from-0.1.md).

## The model in one paragraph

A **session** holds **sources** (a hosted browser, a recording's playback,
the cameras and microphones its members publish). You join it with a
**link**, a URL whose rights say what you may watch, publish and control.
A `GlassClient` is one member on one link. Everything you do to a source goes
through its handle, `client.source(id)`. See [Concepts](concepts.md).

```ts
import { createGlassSession, GlassClient } from "@glass/client";
import { mountGlassViewer } from "@glass/client/viewer";

// Your backend makes the session and hands the page its link.
const session = await createGlassSession({ baseUrl, apiToken, sources: [{ kind: "browser" }] });

const client = new GlassClient({ link: session.link.url });
const browser = session.sources[0]!.id;
mountGlassViewer(container, client, { source: browser });   // before connect()
await client.connect();
client.source(browser).navigate("https://example.com");
```

## Session helpers

These call the HTTP API. In production, call the API from your backend
instead, so the API token never reaches a browser; the helpers are for
development and for backends written in TypeScript. `baseUrl` (the engine's
address; the page's own origin when absent) and `apiToken` are the same in
each (`GlassEngine`).

```ts
createGlassSession({ baseUrl?, apiToken?, sources?, maxMembers?, simulcast?, record?, linkExpiresIn? }): Promise<GlassSession>
mintGlassLink({ sessionId, rights, baseUrl?, apiToken? }): Promise<GlassLink>
revokeGlassLink({ sessionId, linkId, baseUrl?, apiToken? }): Promise<void>
deleteGlassSession({ id, baseUrl?, apiToken? }): Promise<void>
redeemGlassTicket({ ticket, baseUrl? }): Promise<GlassSession>
requestGateTicket({ gate, code?, passphrase? }): Promise<GlassGateTicket>
```

- **`createGlassSession`**. With `sources` (each `{kind: "browser", url?,
  codec?, contentHint?, inputMode?, inspect?, audioInput?}`), the engine runs
  them; without, the session's members publish. It resolves to a
  `GlassSession`: `{id, protocolVersion, link, sources}`. `link` is the
  session's own, the owner's. The options are described in
  [the protocol](protocol.md#post-v1sessions).
- **`mintGlassLink`** mints another link: `rights` is
  `{watch?, publish?, control?, expiresIn?}`, e.g. `{watch: "all"}` for a
  viewer who only watches. See [Links](protocol.md#links).
- **`revokeGlassLink`** stops a link admitting anyone, and closes the
  connections that joined with it.
- **`deleteGlassSession`** ends a session for everyone. It rejects when the
  delete fails; a session already gone counts as deleted.
- **`redeemGlassTicket`** is how a browser starts a session with no API token
  anywhere near it: your backend signs a short-lived
  [session ticket](protocol.md#session-tickets), the page redeems it once.
  The `GlassSession` carries `watchLinks` when the ticket asked for them.
- **`requestGateTicket`** asks [`glass gate`](deployment.md) for a ticket,
  with what it asks for (`code` for a link, `passphrase`, or neither for an
  open gate), and resolves to `{engine, ticket}`. A refusal rejects with a
  `GlassGateError` (`status`, the gate's `code`, `retryAfterSeconds`).

  ```ts
  const { engine, ticket } = await requestGateTicket({ gate, code });
  const session = await redeemGlassTicket({ ticket, baseUrl: engine });
  const client = new GlassClient({ link: session.link.url });
  ```

The helpers refuse an engine whose `protocolVersion` is not
`SUPPORTED_PROTOCOL_VERSION`, and a `GlassClient` checks it again on connect.

## `GlassClient`

```ts
const client = new GlassClient({
  link,                     // required: a link's url
  iceServers,               // optional: your own; by default Glass's, TURN included
  reconnect: true,          // or { maxAttempts, delaysMs }
});
client.on("sourceAdded", (source) => {});
client.on("track", (sourceId, stream) => {});
await client.connect();
```

### Options

| Option | Default | Meaning |
|---|---|---|
| `link` | required | A link's `url`. |
| `iceServers` | Glass's | Your own ICE servers. Absent, the client uses the ones Glass sends in `hello`: its STUN servers and, with the engine's TURN on, a credential for this connection alone. |
| `iceTransportPolicy` | `"all"` | `"relay"` forces TURN. |
| `reconnect` | `true` | `false`, or `{ maxAttempts: 8, delaysMs: [1000, 2000, 4000, 8000, 16000] }`. The first retry is immediate. |
| `repairWait` | `true` | On a long, lossy path (a round trip over 200 ms with packets being resent), let the browser hold video for about one round trip so a resent packet arrives in time, instead of freezing at every loss. `false` keeps the lowest delay. See [performance.md](performance.md#long-lossy-paths). |
| `statsIntervalMs` | off | Emit a `stats` event at this interval. |

### Connection

| Method | |
|---|---|
| `connect()` | Connect; resolves once the WebRTC connection is up. |
| `disconnect()` | Leave deliberately (close code 1000): not resumed, and this member's published sources end at once. It never ends the session; the session ends when its last member has left. |
| `isConnected()`, `getStats()`, `connectionQuality()` | Current state. |
| `connectionId()`, `isOwner()`, `rights()` | Who this connection is and what its link may do (`rights()` also lists sources the owner denied it). |

| Event | |
|---|---|
| `hello(connectionId, owner)` | Glass's first message arrived; the sources and rights are known. On every reconnect too. |
| `connected`, `disconnected` | Transport up or down. |
| `reconnecting(attempt, maxAttempts)` | A retry is scheduled. |
| `refused(reason, code)` | Glass refused this attempt for now (a viewer limit, code `viewer_limit`). Not final: with reconnecting on, the client keeps trying. Show it. |
| `closed(reason, code)` | Final. Branch on `code`: `session_not_found` (it doesn't exist or has ended), `link_expired`, `link_revoked`, `source_failed` or `session_not_resumable` (the session ended), `protocol_mismatch`, `connect_failed`, `connection_lost` (reconnecting off), `reconnect_exhausted`, `client_disconnected`. |
| `error(message, code?)` | A message from Glass, or `answer_refused`: the browser refused the engine's answer (the reason is in `message`), so this connection can't come up. When it ends the session, `closed` follows. |
| `stats(stats)`, `connectionQuality(quality, score)` | Transport statistics; this connection's quality as Glass measures it (`excellent`, `good`, `poor`, `lost`). Show `poor` and `lost`. |
| `recording(active)` | Whether the session is being recorded: on joining, then on every change. |

**A dropped connection resumes.** Any close but a deliberate one holds this
member's place for the engine's reconnect grace (60 s by default), and the
client reconnects with the same link and resumes as the same member,
`connectionId` and published tracks included. A reload, a closed tab or
navigating away is a drop too: reconnecting with the same link within the
grace gets the same member back. Keep the link in `sessionStorage` (per tab)
for that; the reference viewer does.

### Sources

| Method / event | |
|---|---|
| `sources()` | The session's sources this connection may watch: `{id, kind, state, capabilities, …}` (`GlassSourceInfo`). |
| `source(id)` | The source's handle (`GlassSource`), for everything below. |
| `sourceAdded(source)`, `sourceUpdated(source)`, `sourceRemoved(id, reason)` | Sources come, change state (`live`, `stalled`), and go. |
| `track(sourceId, stream)` | A source's media arrived, or changed: bind `stream` to a `<video>`. Also on `source(id).stream()`. |

Per-source events (`navigation`, `dialog`, `playback`, `downloadReady` and
the rest) carry the source's id as their last argument.

### Publishing

```ts
const cam = client.publish(videoTrack, { kind: "camera", simulcast: true });
const mic = client.publish(audioTrack, { kind: "microphone" });
mic.on("silent", () => warn("your microphone is sending silence"));
cam.on("refused", (reason) => {});
await client.connect();
// later
cam.stop();
```

`publish(track, options)` publishes a track as a source of the session, if
the link may publish that kind; call it before or after `connect()`. It
returns a `GlassPublication`. See [Publishing](sources/producers.md).

| Option | Default | Meaning |
|---|---|---|
| `kind` | required | `"camera"`, `"microphone"`, `"screen"` or `"device"`. |
| `simulcast` | `false` | Send a picture as up to three layers, so each viewer gets the one its link carries. Only into a session made with `simulcast: true`: into one that isn't, the client sends one full-size encoding instead (the session's `hello` says which). The client reports its uplink to Glass about once a second and turns off layers no viewer needs. |
| `maxBitrateKbps` | `1000` | The picture's bitrate cap (the full-size layer, with simulcast); keep it below the uplink. `0` is uncapped. |
| `startBitrateKbps` | `min(500, cap)` | Starting bitrate hint (Chromium only). |

| `GlassPublication` | |
|---|---|
| `kind`, `track`, `mid()` | What it publishes, and its line in the connection. |
| `stop()` | Unpublish: its source ends for everyone. |
| `getStats()`, `getStatsReport()` | Bytes, packets, frames and size sent; or the browser's full sender statistics. |
| `refused(reason)` event | Glass did not take it: `not_allowed` (the link may not publish that kind), `codec_mismatch`, `invalid`. |
| `layers(rids)` event | Simulcast: the layers Glass asked for. |
| `silent` event | A microphone sending only silence, checked once as it is published. |

`publications()` lists them. Publications survive a reconnect: they are
published again on the new connection.

### Control

| `GlassSource` method | |
|---|---|
| `holdsInput()`, `holders()`, `floorHolder()` | Whether this connection holds the source's input; who does; who has its floor now. |
| `requestInput()`, `releaseInput()` | Ask for or give up its input. |
| `grantInput(id)`, `revokeInput(id)` | Owner only: give or take a member's input. |
| `grantWatch(id)`, `denyWatch(id)` | Owner only: let a member see the source, or stop it. |
| `receive(paused)` | Pause or resume this connection's own picture of the source. |

Each control method resolves with Glass's answer, a `GlassControlAnswer`:
`{action, outcome, source, reason?, connectionId?}`. `outcome` is `granted`,
`relayed` (no room now, so the request went to whoever holds it), `released`,
`revoked` or `refused`, with `reason` on a refusal. They never reject.

| Client method / event | |
|---|---|
| `members()`, `membersChanged(members)` | Owner only: the other members, `{connectionId, owner, rights}`. |
| `inputHolders(sourceId, holders, floor)` | Who holds a source's input changed, or who has its floor. |
| `inputRequested(connectionId, sourceId)` | Someone asked for an input you hold. Your app decides what to do. |
| `rightsChanged(rights)` | The owner denied this connection a source, or lifted it. |
| `inputDropped(drop)` | Input was dropped (below). |
| `mayShare()` | Whether this connection may share the session: the owner, on a session made with `ownerMayShare`. |
| `shareLink(rights)`, `revokeSharedLink(linkId)` | Mint a link to the session, or revoke one it minted, with this client's own link: no API token. Rejects when the engine refuses (rights wider than its own, too many links, too fast). See [Owner sharing](protocol.md#owner-sharing). |

See [Concepts](concepts.md#owner-and-control-handoff).

**Dropped input.** The client doesn't send input its connection has no right
to send: none for a source whose input it doesn't hold, and no navigation
unless it is the owner. Instead it fires `inputDropped`, and fires the same
event when Glass reports a drop:

```ts
client.on("inputDropped", (drop) => {
  // drop.code: "not_authorized" | "owner_only" | "floor_taken" | "rate_limited" | "unsupported" | "invalid"
  // drop.source: the source it was for; drop.eventType: e.g. "mousedown"
  // drop.local: true if this client withheld it, false if Glass dropped it
});
```

### A hosted browser

| `GlassSource` method | |
|---|---|
| `navigate(url)`, `navigateBack()`, `navigateForward()`, `refresh()` | Owner only. |
| `mouseMove`, `mouseDown`, `mouseUp`, `scroll` | Coordinates in the page's CSS pixels. |
| `dispatchKeyEvent(e)`, `dispatchTouch(type, points, gestureId)` | |
| `setViewport(w, h)` | A resize; the first size is sent by the viewer (or `client.sendInitialViewport`). |
| `copyText()`, `pasteText(text)` | |
| `downloadUrl(guid)`, `uploadFiles(files)` | |
| `dialog()`, `answerDialog(accept, text?)` | The page's open JavaScript dialog, or `null`; answer it. |

| Event (each with the source's id last) | |
|---|---|
| `navigation(nav)` | URL, loading, back and forward availability. |
| `elementState(el)` | Cursor shape, and whether a text field has focus. |
| `interactiveElements(els)` | Phones only: text-field positions, for the on-screen keyboard. |
| `clipboardText(text)` | Answer to `copyText()`. |
| `newTabRequested(url)` | The page tried to open a popup or tab. |
| `downloadReady(filename, guid)`, `fileChooserOpened(multiple)`, `fileChooserClosed()` | File transfer. |
| `micAccessRequested(origin)` | The page wants a microphone; answer with `client.grantMicAccess()` or `client.denyMicAccess()`. |
| `dialog(dialog)` | The page's dialog opened or closed. When `inPicture` is false, show it yourself. |
| `consoleMessage(level, text)` | The page's console output. |

The feature behind each is described in [sources/browser.md](sources/browser.md).

### Recording and playback

See [recording.md](recording.md). Starting a recording takes the API token,
so it belongs on your backend.

| | |
|---|---|
| `client.recording()`, `recording(active)` event | Whether the session is being recorded. |
| `source(id).playbackState()`, `playback(state, sourceId)` event | A playback source's `{playing, positionMs, durationMs, ended}`. |
| `source(id).controlPlayback(action, positionMs?)` | `"play"`, `"pause"` or `"seek"`, with control of the source. |
| `timeline(event, sourceId)` event | The recording's timeline events as playback passes them. |

### Input latency

`inputLatency(sample)` fires with one input's time from send to the picture
showing it (`kind`, `ms`, `continuous` for a drag or scroll), and
`inputLatencyStats()` gives the median and 95th percentile so far.

## `mountGlassViewer`

```ts
import { mountGlassViewer } from "@glass/client/viewer";

const viewer = mountGlassViewer(container, client, {
  source: sourceId,                       // required: the source to show
  onNavigation: (nav) => {},
  onContextMenu: (x, y, shiftKey) => {},  // replace the browser's context menu
  isMobile,                               // default: detected
  captureKeyboard: true,
  gamepadMapping: {},                     // override the default gamepad mapping
});
// viewer.video is the <video> element; viewer.destroy() removes it.
```

It renders one source and sends its input there. Mount it before
`client.connect()`, so the initial viewport is sent first. The viewer package
also exports its building blocks (`TouchInputController`,
`MobileKeyboardController`, `GamepadInputController`, `clientToVideoPoint`)
for custom renderers.

## Reference viewer

[`examples/viewer-preact`](../examples/viewer-preact) is a complete viewer
built on the SDK: address bar, loading and error states, downloads, uploads,
dialogs and microphone prompts, the member list for the owner, and a share
button that mints watch links (shown when this viewer can share: the session
was made with `ownerMayShare`, or a local development token is set). Joined
to a browser that has not opened a page yet, it waits on its start screen: the
owner gets the address box, anyone else "Waiting for the session to open a
page". By default it makes a browser session (with
`VITE_GLASS_ADDR` and, for local testing only, `VITE_GLASS_API_TOKEN`) and
ends it when the tab is done with it. To join an existing session instead,
open it with `?attachLink=<url-encoded link>`: the session your backend made,
a watch link, a playback, or a session whose members publish (it shows their
cameras). A reload rejoins the same member.

`?contentHint=detail` or `motion`, `?codec=h264`, `vp8` or `av1`, and
`?inputMode=free` (or `VITE_GLASS_CONTENT_HINT`, `VITE_GLASS_CODEC`,
`VITE_GLASS_INPUT_MODE`) make its session with those options. A recorded
session shows a "Recording" mark, and a playback a bar with play, pause and
seek. While another member has the page, the header says so, and a dropped
click or key says why.

Deployed anywhere, the viewer gets its sessions from `glass gate`: opened with
a link from `glass gate link` (`#gate=…&code=…`), or built with
`VITE_GLASS_GATE` set to an `open` or `passphrase` gate, it asks the gate for a
ticket and starts a session on the engine the gate names, with no engine
address and no API token in the page.
