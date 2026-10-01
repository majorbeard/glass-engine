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
createGlassSession(baseUrl?, apiToken?, audioInput?): Promise<GlassSession>
deleteGlassSession(id, baseUrl?, apiToken?): void
mintConnectionGrant(sessionId, capabilities, baseUrl?, apiToken?): Promise<GlassConnectionGrant>
```

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

### Control and sharing

| Method / event | |
|---|---|
| `connectionId()`, `producesInput()`, `isOwner()` | This connection's identity and rights. |
| `requestInput()`, `releaseInput()` | Ask for or give up control. |
| `grantInput(id)`, `revokeInput(id)` | Owner only. |
| `connections()` | Owner only: everyone else on the session. |
| `capabilitiesChanged(id, producesInput, isSelf)` | Someone's control changed. |
| `inputRequested(id)` | Someone asked for control you hold. |
| `rosterChanged(connections)` | Owner only. |

See [concepts.md](concepts.md#owner-and-control-handoff).

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
Configure it with `VITE_GLASS_ADDR` and, for local testing only,
`VITE_GLASS_API_TOKEN`.
