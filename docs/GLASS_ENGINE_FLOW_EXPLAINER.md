# Glass Runtime: Engine, Server, And Frontend Flow

This document gives a high-level explanation of how Glass works from back to
front, with extra detail on how the engine streams the browser image to the
viewer.

Glass is a remote browser runtime. The backend launches real headless binary Chromium
instances, the frontend connects to one browser session, and WebRTC is used to
stream pixels back while sending mouse, keyboard, scroll, navigation, and
viewport events forward.

## Big Picture Flow

At a high level, the flow is:

```text
User opens frontend
  -> frontend creates a session over HTTP
  -> backend reserves a Chromium browser from the pool
  -> frontend connects to the session signaling WebSocket
  -> backend and frontend negotiate WebRTC
  -> frontend sends input and navigation commands
  -> backend drives Chromium through Chrome DevTools Protocol
  -> backend captures browser frames
  -> backend encodes and streams frames over WebRTC
  -> frontend renders frames onto a canvas
```

The backend is the actual browser host. The frontend is a lightweight viewer
and controller for that remote browser.

## Server Runtime

The server starts in `backend/cmd/main.go`. That entry point is intentionally
thin: it reads configuration, creates the runtime, starts the HTTP server, and
handles graceful shutdown.

The main orchestration lives in `backend/internal/runtime`. The runtime owns:

- `BrowserPool`: launches and maintains a pool of headless Chromium instances.
- `sessions.Manager`: creates, tracks, expires, and closes browser sessions.
- HTTP server: exposes the API and serves the built frontend files.

The key HTTP routes are:

```text
GET    /healthz
GET    /v1/info
POST   /v1/sessions
GET    /v1/sessions/{id}
DELETE /v1/sessions/{id}
GET    /v1/sessions/{id}/signaling
```

When the frontend calls `POST /v1/sessions`, the backend immediately reserves a
browser from the pool and creates a pending session. The response includes:

```json
{
  "id": "...",
  "signalingUrl": "ws://.../v1/sessions/{id}/signaling"
}
```

The frontend is expected to connect to that signaling URL promptly. If it does
not, the pending session is automatically cleaned up after a timeout so a
browser is not held forever.

Once the signaling WebSocket connects, the session becomes active. When that
WebSocket closes, the session is closed and the browser is released back to the
pool.

## Browser Session Engine

Each active session owns a `BrowserManager`. The `BrowserManager` is the main
engine object for a single remote browser session.

It is responsible for:

- Creating and closing Chromium pages.
- Navigating to URLs.
- Tracking page state such as current URL, loading status, cursor, and
  back/forward availability.
- Receiving input from the frontend.
- Validating client input.
- Dispatching input into Chromium through Chrome DevTools Protocol.
- Starting and stopping the screencast pipeline.

When a user navigates to a URL, the engine roughly does this:

```text
validate URL
  -> close any existing page
  -> create a new Chromium page
  -> start navigation/page monitoring
  -> start the WebRTC stream coordinator
  -> navigate the page
  -> start screencasting once the page is ready
```

The backend does not render HTML itself. Chromium renders the page normally.
Glass captures Chromium's visual output and sends it to the frontend.

## WebRTC Connection

Glass uses WebRTC as the live transport, but the setup starts with a WebSocket.

There are two phases:

1. Signaling WebSocket
2. WebRTC DataChannel

The signaling WebSocket is used for the offer/answer/ICE handshake. That is the
negotiation step that lets the browser frontend and Go backend establish a
WebRTC peer connection.

After WebRTC is connected, the main live traffic moves over a DataChannel named
for frames and input.

Client to server over DataChannel:

- Mouse movement
- Mouse down/up
- Scroll
- Keyboard events
- Back/forward/refresh
- Viewport resize
- Copy/paste requests

Server to client over DataChannel:

- Encoded frame data
- Navigation state
- Cursor state
- Viewport state

So the WebRTC DataChannel is the realtime pipe in both directions.

## Screencast And Image Streaming

The image streaming path is:

```text
BrowserManager
  -> ScreencastEngineWebRTC
  -> Chrome DevTools Page.startScreencast
  -> optional FFmpeg H.264 encoder
  -> Glass binary protocol message
  -> WebRTC DataChannel
  -> frontend WebRTCService
  -> GPU worker
  -> canvas renderer
```

### 1. Chromium Produces Frames

Once a page is ready to stream, the backend calls Chrome DevTools Protocol's
`Page.startScreencast`.

That tells Chromium to send screenshots of the current page viewport as it
changes. Those screencast frames arrive at the backend as JPEG image data.

For every frame, the backend acknowledges it back to Chromium using
`Page.screencastFrameAck`. This ACK is important because the Chrome screencast
flow expects confirmation that frames have been received.

The raw capture loop is:

```text
Chromium renders HTML/CSS/JS
  -> CDP screencast captures viewport
  -> backend receives JPEG frame
  -> backend ACKs frame
```

### 2. The Engine Drops Stale Frames

The screencast engine does not blindly send every frame.

It has a target frame rate and also watches the WebRTC DataChannel buffer. If
frames are arriving too quickly, or if the DataChannel is backed up, it drops
some frames rather than building a large queue.

That behavior is intentional. For remote interaction, the newest frame matters
more than old frames. A perfect queue of stale screenshots would make the UI
feel delayed.

The engine's decision loop is roughly:

```text
receive frame
  -> ACK frame to Chrome
  -> drop if it is too soon since the previous processed frame
  -> drop if the WebRTC buffer is congested
  -> otherwise process and send it
```

### 3. Frames Are Encoded

The primary path feeds Chromium's JPEG screencast frames into an FFmpeg process.
FFmpeg reads the JPEG stream from stdin and writes raw H.264 Annex-B bytes to
stdout.

That turns:

```text
Chrome JPEG screencast frames
  -> FFmpeg
  -> H.264 byte stream
```

H.264 is used because it is more video-like and usually better for bandwidth
and latency than sending full JPEG screenshots every time.

There is also a fallback path. If the H.264 encoder cannot start, the engine can
send full JPEG frames directly.

### 4. Frames Are Wrapped In Glass Protocol Messages

Before a frame is sent, the backend wraps it in a small binary protocol. The
first byte tells the frontend what kind of message it is.

Important frame message types:

```text
0x10 = JPEG I-frame
0x12 = chunked frame
0x14 = H.264 frame
```

An H.264 frame message is shaped like:

```text
[message type byte][timestamp][H.264 bytes]
```

A JPEG fallback frame is shaped like:

```text
[message type byte][timestamp][JPEG bytes]
```

Large JPEG payloads can be split into chunked messages. H.264 frames are
currently sent directly rather than through the chunking path.

### 5. WebRTC Sends The Bytes

The backend sends these binary messages through the WebRTC DataChannel.

So the transport flow is:

```text
encoded frame
  -> Glass binary message
  -> WebRTC DataChannel
  -> browser frontend
```

The same DataChannel also carries frontend input in the opposite direction.

## Frontend Viewer

The frontend lives in `examples/viewer-preact`. It is a Preact viewer for the
runtime.

The main frontend flow is:

```text
App mounts
  -> createGlassSession()
  -> POST /v1/sessions
  -> receive session ID and signaling URL
  -> create WebRTCService
  -> connect signaling WebSocket
  -> complete WebRTC negotiation
  -> receive frames and state updates
  -> render remote browser into canvas
```

The app starts with a welcome/URL-entry view. When the user enters a URL, the
frontend sends a navigation request to the backend. Once the backend navigates
and starts streaming, the UI switches into the browser view.

## Frontend Renderer

The frontend does not display the remote page in an iframe. It displays a
canvas.

`WebRTCService` listens for DataChannel messages. When a binary message arrives,
it reads the first byte to determine the message type:

```text
0x14 -> H.264 frame
0x10 -> JPEG frame
0x12 -> chunked frame
0x06 -> navigation state
0x05 -> cursor state
```

For frame messages, it strips off the protocol metadata and forwards the frame
bytes to the app.

The app then sends those frame bytes to a worker. The canvas is transferred to
that worker with `transferControlToOffscreen()`, so rendering can happen away
from the main UI thread.

The renderer path is:

```text
WebRTC DataChannel message
  -> WebRTCService parses message
  -> app forwards frame to GPU worker
  -> worker decodes/renders frame
  -> canvas updates on screen
```

This keeps the main Preact UI responsive while frames are being processed.

## Input Feedback Loop

User input travels in the opposite direction from pixels:

```text
user moves mouse or presses key on canvas
  -> frontend captures event
  -> WebRTCService sends JSON input over DataChannel
  -> backend validates input
  -> BrowserManager dispatches input through CDP
  -> Chromium updates the page
  -> next screencast frame captures the result
  -> frontend renders the updated frame
```

That feedback loop is the heart of Glass. The frontend is not browsing the web
locally; it is controlling a browser running on the backend and displaying its
streamed output.

## Short Mental Model

Think of Glass as a remote-controlled browser:

```text
Backend:
  runs Chromium
  captures its pixels
  encodes them
  streams them to the client

Frontend:
  creates a session
  sends user input
  receives frame data
  paints the remote browser onto canvas
```

The backend is the engine. The frontend is the viewer and controller.
