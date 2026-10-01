# Hosted browser

Glass runs a headless Chrome per session, streams its screen and audio to
viewers, and dispatches their input as real browser input events. Pages behave
as they would on a local machine: `wheel` events are real wheel events, touch
is real touch, a double-click is a real double-click.

Read [concepts.md](../concepts.md) first; this page covers only what is
specific to browser sessions.

## Creating a session

```sh
curl -X POST -H "Authorization: Bearer $GLASS_API_TOKEN" \
  http://glass.example.com/v1/sessions
```

```json
{
  "id": "9ee60523-4129-4f4a-b43a-89e14189e89f",
  "signalingUrl": "wss://glass.example.com/v1/sessions/9ee6…/signaling?token=…",
  "protocolVersion": 1,
  "sourceType": "browser",
  "capabilities": {
    "video": true, "navigation": true, "viewport": true, "clipboard": true,
    "pauseResume": true, "mobileEmulation": true,
    "inputActions": ["back", "forward", "keydown", "keyup", "mousedown", "…"]
  }
}
```

Each session reserves a browser from a pool. Glass keeps a few browsers warm
(`GLASS_POOL_WARM_FLOOR`, default 2) and starts more on demand up to the
session limit. A session that nobody connects to within 30 s is closed so it
can't hold a browser.

Send `{"audioInput": true}` as the body to get a browser that can receive the
viewer's microphone (see [Microphone](#microphone)).

## Connecting a viewer

```ts
import { createGlassClient } from "@glass/client";
import { mountGlassViewer } from "@glass/client/viewer";

const client = createGlassClient({ sessionId: id, signalingUrl });
mountGlassViewer(stage, client, {
  onNavigation: (nav) => updateAddressBar(nav.url),
});
await client.connect();
client.navigate("https://example.com");
```

`mountGlassViewer` renders the video, maps pointer coordinates to the remote
page, and captures mouse, keyboard, touch, scroll, gamepad and viewport
changes. Mount it **before** `connect()`, so the initial viewport (and whether
the viewer is a phone) reaches Glass before the first page loads.

If you build your own renderer instead, use the `videoTrack` event and the
input methods on `GlassClient` (`mouseDown`, `dispatchKeyEvent`,
`dispatchTouch`, …). See [client-sdk.md](../client-sdk.md).

## Navigation

- `navigate(url)`, `navigateBack()`, `navigateForward()`, `refresh()`.
- The `navigation` event reports `{ url, loading, canGoBack, canGoForward }`.
- Only the session **owner** can navigate: navigation changes the page for
  every viewer. A viewer that holds control can interact with the current page
  but can't navigate away from it.
- When a page opens a popup or a new tab, Glass doesn't open it. It emits
  `newTabRequested(url)` and leaves the decision to your app (for example,
  navigate the current session there, or ignore it).
- Navigation to loopback, private and link-local addresses is refused (see
  [Security](#security)).

## Viewport and phones

The viewer reports its size on connect and on every resize; Glass resizes the
browser to match. When the viewer is a phone, it reports that too, and Glass
turns on mobile emulation (touch, mobile viewport, and the phone's own user
agent), so sites serve their mobile layout. `mountGlassViewer` does this
automatically; with a custom renderer, call `sendInitialViewport()` before
connecting and `setViewport()` afterwards.

On phones, Glass also sends the positions of text fields on the page, so the
viewer can raise the on-screen keyboard when the user taps one.

## Input

| Input | Notes |
|---|---|
| Mouse | Left, right and middle buttons; modifier keys; double and triple click. |
| Wheel | Horizontal and vertical, with modifiers, at the cursor position. |
| Keyboard | `key`, `code` and modifiers, as the viewer's browser reports them. |
| Touch | Up to 5 touch points, as real touch events. |
| Gamepad | Mapped to keyboard and mouse input by the viewer (`gamepadMapping` option). |

Input is accepted only from a connection that holds `producesInput`
([concepts.md](../concepts.md#owner-and-control-handoff)). Invalid input
(out-of-range coordinates, non-numeric values, too many touch points) is dropped.

Your backend can also send input to a session without a WebRTC connection:

```sh
curl -X POST -H "Authorization: Bearer $GLASS_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"type": "mousedown", "data": {"x": 100, "y": 200}}' \
  http://glass.example.com/v1/sessions/$ID/input
```

It accepts the same `type` and `data` as the DataChannel input messages in
[protocol.md](../protocol.md#datachannel-input-client--glass) and answers
`202`.

## Clipboard

- `copyText()` asks Glass for the page's current text selection; it arrives
  as the `clipboardText` event.
- `pasteText(text)` inserts text at the page's focus.

Clipboard access always goes through these calls; the remote page never
reads the viewer's clipboard directly.

## Downloads

When a page downloads a file, Glass saves it on the server and emits
`downloadReady(filename, guid)`. Nothing lands on the viewer's device unless
your app acts on it: show a prompt, and on the user's click open
`client.downloadUrl(guid)`. A download nobody collects is deleted after
10 minutes. At most 5 downloads per session can be in progress at once.

## Uploads

When the page opens a file picker (`<input type="file">`), Glass emits
`fileChooserOpened(multiple)`. Show the user a local file picker and pass the
result to `client.uploadFiles(files)`. If nobody answers within 60 s, the
remote picker is cancelled and `fileChooserClosed` fires.

## Audio

Start Glass with `GLASS_AUDIO_MODE=on` to stream the browser's sound. Each
session then gets an Opus audio track, shared by all its viewers. With audio
off, the session has no audio track.

## Microphone

A page can ask for the microphone (`getUserMedia({audio: true})`). With a
microphone-capable session, Glass holds the page's request and asks the
viewers:

1. The operator enables a microphone-capable browser pool:
   `GLASS_MIC_POOL_CHROME_BIN=/usr/local/bin/chrome-full` (included in the
   Docker image) and `GLASS_MIC_POOL_SIZE` (default 1).
2. Your backend creates the session with `{"audioInput": true}`
   (`createGlassSession(baseUrl, apiToken, true)` in the SDK).
3. When the page asks, every viewer gets `micAccessRequested(origin)`. The first
   answer wins: `grantMicAccess()` captures the viewer's own microphone and
   sends it to the page; `denyMicAccess()` refuses. No answer within 60 s
   counts as a refusal.

## Developer console

The page's own `console.log`, `warn`, `error` and uncaught exceptions arrive as
the `consoleMessage(level, text)` event: useful for showing what a site's
scripts are doing without DevTools access.

## Security

- **Egress filter (on by default).** Every browser connects to the network
  through a local proxy that refuses connections to loopback, private and
  link-local addresses, including the cloud metadata endpoint, so a page can't
  reach your internal network. Keep it on unless you trust every page your
  users will open (`GLASS_EGRESS_FILTER=false` disables it).
- **Chrome sandbox.** Chrome runs with its sandbox where the host allows it.
  See [deployment.md](../deployment.md#security-posture).
- **Isolation between sessions.** Each session runs in its own browser
  context (cookies, local storage, cache), which is wiped when the session
  ends. Browser processes are reused across sessions; their storage is not.

## Limits worth knowing

- **Sites that block cloud IP addresses.** Some sites (major video
  platforms in particular) refuse or challenge traffic from datacenter IP
  ranges. This comes from the site, not from Glass; the same page works when
  Glass runs on a residential connection.
- **GPU-heavy pages.** Without a GPU, Chrome renders WebGL in software, which
  costs CPU and can be slow on 3D-heavy pages.
- **Dragging files from the viewer's desktop into the page** isn't supported.
  Use the upload flow above.
- **A right- or middle-button drag** arrives at the page as a left-button
  drag between the correct press and release events.
