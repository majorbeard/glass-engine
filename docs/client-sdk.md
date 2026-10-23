# Client SDK: `@glass/client`

The SDK has three parts:

| Import | What it is |
|---|---|
| `GlassClient` (`@glass/client`) | Connects to any session as a viewer: video, audio, input, control handoff, reconnects. No DOM dependency. |
| `GlassProducer` (`@glass/client`) | Publishes a `MediaStream` into a relay session and keeps it there across network drops. |
| `mountGlassViewer` (`@glass/client/viewer`) | Optional. Renders a `GlassClient`'s video and captures mouse, keyboard, touch, scroll, gamepad and viewport input. |

**Installing.** The package isn't published to npm yet. Clone this repository,
run `npm install && npm run build` at its root, then add it to your app with
`npm install <path-to-glass-engine>/packages/client`.

The full typed surface is in [`packages/client/api/`](../packages/client/api),
which the package's build checks against, so it is always current.

## Session helpers

These call the HTTP API directly. In production, call the API from your
backend instead, so the API token never reaches a browser. The helpers are
for development and for backends written in TypeScript.

```ts
createGlassSession(baseUrl?, apiToken?, options?): Promise<GlassSession>
deleteGlassSession(id, baseUrl?, apiToken?): void
mintConnectionGrant(sessionId, capabilities, baseUrl?, apiToken?): Promise<GlassConnectionGrant>
```

`createGlassSession`'s third argument is either `true` (the
microphone-capable browser, as before) or an options object,
`GlassCreateSessionOptions`: `{ audioInput?: boolean, contentHint?: "detail" | "motion", codec?: "h264" | "vp8" | "av1", inputMode?: "floor" | "free", inspect?: boolean }`.
`contentHint` (`GlassContentHint`) chooses what the session protects when
bitrate or CPU is short: `"detail"` keeps the size and lowers the frame rate
(text, interfaces), `"motion"` keeps the frame rate and lowers the size
(video, games). Absent, the runtime's default (`GLASS_CONTENT_HINT`) applies;
the returned `GlassSession` carries the hint in effect.

`codec` (`GlassVideoCodec`) is the session's video codec, fixed for its life.
Absent, the runtime's default applies. A codec the runtime cannot serve is
refused: the promise rejects with the runtime's reason, and no session is
created. `GET /v1/info`'s `codecs` lists what it serves; the returned
`GlassSession` carries the codec in `codec`. AV1 has the sharpest picture at
low bitrates; check that the viewer can decode it before asking (Safari only
can on devices with AV1 hardware).

`inputMode` (`GlassInputMode`) decides how several connections with control
share the page: `"floor"` (the default) gives it to one at a time, `"free"`
to everyone at once, which is chaos with more than one active person. See
[concepts.md](concepts.md#several-people-in-control).

`inspect: true` allows page inspection on the session, for your backend with
the API token; see [page-inspection.md](page-inspection.md).

`createGlassSession` refuses a server whose `protocolVersion` is newer than
`SUPPORTED_PROTOCOL_VERSION`, rather than connecting and failing in confusing
ways.

## `GlassClient`

```ts
import { createGlassClient } from "@glass/client";

const client = createGlassClient({
  signalingUrl,             // required: from session creation or a grant
  sessionId,                // optional: used for deleteSessionOnClose
  iceServers,               // optional: add TURN here for restrictive networks
  reconnect: true,          // or { maxAttempts, delaysMs }
});
client.on("videoTrack", (stream) => (video.srcObject = stream));
await client.connect();
```

### Options

| Option | Default | Meaning |
|---|---|---|
| `signalingUrl` | required | The WebSocket URL to connect to. |
| `sessionId` | none | The session's ID. |
| `iceServers` | public STUN | The viewer's ICE servers. Add TURN for viewers behind strict firewalls. |
| `iceTransportPolicy` | `"all"` | `"relay"` forces TURN. |
| `reconnect` | `true` | `false`, or `{ maxAttempts: 8, delaysMs: [1000, 2000, 4000, 8000, 16000] }`. The first retry is immediate. |
| `statsIntervalMs` | off | Emit a `stats` event at this interval. |
| `deleteSessionOnClose` | `false` | Delete the session when this client disconnects. Needs `sessionBaseUrl` and `apiToken`: development only. |

### Connection

| Method | |
|---|---|
| `connect()` | Connect; resolves once the WebRTC connection is up. |
| `disconnect()` | Leave deliberately (close code 1000). Not resumed. |
| `isConnected()`, `getVideoStream()`, `getStats()` | Current state. |

| Event | |
|---|---|
| `videoTrack(stream)` | The media stream (video, plus audio when the session has it). |
| `connected`, `disconnected` | Transport up or down. |
| `reconnecting(attempt, maxAttempts)` | A retry is scheduled. |
| `closed(reason)` | Final: the session ended, doesn't exist (`4404`), or retries ran out. |
| `error(message)` | A non-fatal error from Glass (for example, the encoder failed). |
| `stats(stats)` | RTT, throughput, jitter buffer, decoded and dropped frames. |

### A session's lifetime

- A session lives until `disconnect()` is called (which also deletes it when
  `deleteSessionOnClose` is on), `DELETE /v1/sessions/{id}` is sent, or its
  last connection has been gone for the reconnect grace
  (`GLASS_RECONNECT_GRACE_SECONDS`, 60 s by default).
- **Leaving the page does not end the session.** A reload, a closed tab or
  navigating away closes the connection the same way a network drop does, so
  Glass holds the session for the grace. While it is held, its remote page is
  kept as it was and hidden, so it costs little CPU, but it still counts
  against the session limit.
- Connecting to the same `signalingUrl` within the grace resumes the session,
  page and all. That is how a reloaded tab gets back to its session: keep the
  session's `id` and `signalingUrl` (in `sessionStorage`, which is per tab),
  connect with them on load, and create a new session only if that fails.
  After the grace, connecting fails with `closed` (`4404`, session not found).
  The reference viewer does exactly this.
- To end a session at once (the user signs out, the app is done with it),
  call `disconnect()` while the page is still in use; a page that is
  unloading can't reliably send anything.

### Control and sharing

| Method / event | |
|---|---|
| `connectionId()`, `producesInput()`, `isOwner()` | This connection's identity and rights. |
| `inputDropped(drop)` | Input was dropped. See below. |
| `requestInput()`, `releaseInput()` | Ask for or give up control. |
| `grantInput(id)`, `revokeInput(id)` | Owner only. |
| `connections()` | Owner only: everyone else on the session. |
| `capabilitiesChanged(id, producesInput, isSelf)` | Someone's control changed. |
| `inputRequested(id)` | Someone asked for control you hold. |
| `rosterChanged(connections)` | Owner only. |
| `floorHolder()` | Input mode `floor`: the connection whose input reaches the page, or `null`. |
| `floorChanged(id, isSelf)` | Who has the page changed (`id` is `null` when no one has it). |

See [concepts.md](concepts.md#owner-and-control-handoff).

**Dropped input.** The client doesn't send input its connection has no right
to send: nothing when it has no control, and no navigation unless it is the
owner. Instead it fires `inputDropped`, and it fires the same event when
Glass reports a drop:

```ts
client.on("inputDropped", (drop) => {
  // drop.code: "not_authorized" | "owner_only" | "floor_taken" | "rate_limited" | "unsupported" | "invalid"
  // drop.eventType: e.g. "mousedown" ("" when Glass doesn't know the type)
  // drop.count: drops since the previous report for this code and type
  // drop.local: true if this client withheld it, false if Glass dropped it
  if (drop.code === "not_authorized" && drop.eventType === "mousedown") showViewOnlyHint();
});
```

Reports are coalesced: the first drop fires at once, then at most one event
every 2 s per code and event type. See
[protocol.md](protocol.md#dropped-input).

### Hosted-browser input and state

| Method | |
|---|---|
| `navigate(url)`, `navigateBack()`, `navigateForward()`, `refresh()` | Owner only. |
| `mouseMove`, `mouseDown`, `mouseUp`, `scroll` | Coordinates are in the remote page's CSS pixels. |
| `dispatchKeyEvent(e)`, `dispatchTouch(type, points, gestureId)` | |
| `sendInitialViewport(w, h, isMobile?, userAgent?)`, `setViewport(w, h)` | |
| `copyText()`, `pasteText(text)` | |
| `downloadUrl(guid)`, `uploadFiles(files)` | |
| `grantMicAccess()`, `denyMicAccess()` | |

| Event | |
|---|---|
| `navigation(nav)` | URL, loading, back and forward availability. |
| `state(el)` | Cursor shape, and whether a text field has focus. |
| `interactiveElements(els)` | Phones only: text-field positions, for the on-screen keyboard. |
| `clipboardText(text)` | Answer to `copyText()`. |
| `newTabRequested(url)` | The page tried to open a popup or tab. |
| `downloadReady(filename, guid)`, `fileChooserOpened(multiple)`, `fileChooserClosed` | File transfer. |
| `micAccessRequested(origin)` | The page wants the microphone. |
| `consoleMessage(level, text)` | The page's console output. |

The feature behind each is described in [sources/browser.md](sources/browser.md).

### Relay sessions

| Method / event | |
|---|---|
| `slotStates()` | Every slot's state: `live`, `stalled` or `empty`. |
| `slotStateChanged(slots)` | Fired when any slot changes. |

## `GlassProducer`

```ts
import { GlassProducer } from "@glass/client";

const producer = new GlassProducer({ stream, produceUrl, maxBitrateKbps: 1000 });
producer.on("state", (state, detail) => {});
producer.on("session", (s) => shareWatchLink(s.signalingUrl));
producer.on("stats", (s) => {});
await producer.start();
// later
producer.stop();
```

| Option | Default | Meaning |
|---|---|---|
| `stream` | required | What to send: its first video track, and its first audio track if any. |
| `produceUrl` | none | Produce into an existing session (recommended). |
| `serverUrl`, `apiToken`, `slots` | none | Create the session itself instead (development only). |
| `slot` | `"main"` | Which slot this producer fills. |
| `iceServers` | public STUN | |
| `maxBitrateKbps` | `1000` | Video bitrate cap; keep it below the uplink. `0` is uncapped. |
| `startBitrateKbps` | `min(500, cap)` | Starting bitrate hint (Chromium only). |
| `reconnect` | `true` | Recover from drops. |
| `resumeWindowMs` | `45000` | How long to resume the same session before starting a new one (only when the producer created it). |

`stats` reports source frame rate, upload bitrate, frames sent, resolution,
RTT, packets lost, and battery and network information where the browser
provides them. The reconnect behavior is described in
[sources/producers.md](sources/producers.md#disconnecting-and-reconnecting).

## `mountGlassViewer`

```ts
import { mountGlassViewer } from "@glass/client/viewer";

const viewer = mountGlassViewer(container, client, {
  onNavigation: (nav) => {},
  onContextMenu: (x, y, shiftKey) => {},  // replace the browser's context menu
  isMobile,                               // default: detected
  captureKeyboard: true,
  gamepadMapping: {},                     // override the default gamepad mapping
});
// viewer.video is the <video> element; viewer.destroy() removes it.
```

Mount it before `client.connect()`, so the initial viewport is sent first. The
viewer package also exports its building blocks (`TouchInputController`,
`MobileKeyboardController`, `GamepadInputController`, `clientToVideoPoint`)
for custom renderers.

## Reference viewer

[`examples/viewer-preact`](../examples/viewer-preact) is a complete viewer
built on the SDK: address bar, loading and error states, downloads, uploads
and microphone prompts. By default it creates a browser session; to watch an
existing session (a relay stream, say), open it with
`?attachSessionId=<id>&attachSignalingUrl=<url-encoded signalingUrl>`.
A reload rejoins the tab's own session (see
[A session's lifetime](#a-sessions-lifetime)). `?contentHint=detail` or
`?contentHint=motion` (or `VITE_GLASS_CONTENT_HINT`) creates its session with
that hint, and `?codec=h264`, `vp8` or `av1` (or `VITE_GLASS_CODEC`) with
that codec; a reload keeps the session's codec, so open a new tab to switch.
`?inputMode=free` (or `VITE_GLASS_INPUT_MODE`) creates its session in input
mode `free`. While another viewer has the page, the header shows "Another
viewer is in control", and a dropped click or key says so.
Configure it with `VITE_GLASS_ADDR` and, for local testing only,
`VITE_GLASS_API_TOKEN`.
