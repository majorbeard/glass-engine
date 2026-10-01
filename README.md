# Glass Engine

Glass is a self-hosted engine for live streaming and remote control. It
carries video and audio from a **source** to any number of **viewers** over
WebRTC, and carries input back from a viewer to the source.

A source can be:

| Source | What it is | Create it with |
|---|---|---|
| **Hosted browser** | A headless Chrome that Glass runs for you. Viewers see it and drive it: mouse, keyboard, touch, scroll, navigation, clipboard, files, audio and microphone. | `POST /v1/sessions` |
| **Relay producer** | Anything that can send WebRTC video: a phone camera, a desktop capture, a hardware encoder, your own app. Glass forwards its stream to viewers without decoding it. One session can hold several producers. | `POST /v1/relay-sessions` |
| **Two-party call** | Two peers, each sending and receiving video and audio through Glass. | `POST /v1/calls` |

Whatever the source, the session model is the same: a session has
connections, each connection has capabilities (watch, control, publish),
control can be handed between viewers, and dropped connections resume inside
a reconnect grace window. You build your product on the HTTP API and
[`@glass/client`](packages/client); Glass has no user interface of its own.

```text
              ┌──────────────────────── Glass ────────────────────────┐
 hosted       │                                                       │
 browser ─────┤                                                       │      viewer
              │  sessions · capabilities · control handoff ·          ├────► viewer
 relay        │  reconnect grace · bandwidth estimation · TURN        │      viewer
 producer ────┤                                                       │
 (camera,     │                                                       │◄──── input
  desktop,…)  └───────────────────────────────────────────────────────┘
```

The engine itself (the Go server) is closed-source. It ships only as the
`ghcr.io/majorbeard/glass` Docker image (linux/amd64 and linux/arm64), which
contains everything it needs. This repository holds the public
pieces: the client SDK, a reference viewer, the installer and these docs.

## Status

Pre-1.0. The wire protocol carries a version number so breaking changes are
detectable, but they are still allowed. See [docs/protocol.md](docs/protocol.md#versioning).

## Quick start

You need Docker. Start Glass for local development (loopback only, no
token):

```sh
docker run -d --name glass \
  -p 127.0.0.1:8080:8080 \
  -p 50000:50000/udp \
  --shm-size=1g \
  -e GLASS_INSECURE_LOCAL_DEV=true \
  -e GLASS_WEBRTC_NAT_1TO1_IPS=127.0.0.1 \
  ghcr.io/majorbeard/glass

curl http://localhost:8080/healthz      # {"status":"ok"}
```

Then run the reference viewer from this repository:

```sh
npm install
npm run build
cd examples/viewer-preact
VITE_GLASS_ADDR=http://localhost:8080 npm run dev
```

Open the URL Vite prints (normally `http://localhost:5173`). You are driving
a browser that runs inside the container.

[docs/getting-started.md](docs/getting-started.md) walks through the same
setup with an API token, and adds a relay producer and a call.
[docs/deployment.md](docs/deployment.md) covers running Glass on a server.

## Using the SDK

`@glass/client` isn't published to npm yet. Build it from this repository and
depend on it by path:

```sh
git clone https://github.com/majorbeard/glass-engine
cd glass-engine && npm install && npm run build
# in your app:
npm install ../glass-engine/packages/client
```

**Watch and drive a hosted browser:**

```ts
import { createGlassClient } from "@glass/client";
import { mountGlassViewer } from "@glass/client/viewer";

// Your backend calls POST /v1/sessions with the API token and hands the
// browser only { id, signalingUrl }.
const { id, signalingUrl } = await fetch("/api/glass-session").then((r) => r.json());

const client = createGlassClient({ sessionId: id, signalingUrl });
mountGlassViewer(document.getElementById("stage")!, client); // video + input
await client.connect();
client.navigate("https://example.com");
```

**Publish a camera (or any `MediaStream`) as a relay producer:**

```ts
import { GlassProducer } from "@glass/client";

const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
const producer = new GlassProducer({ stream, produceUrl }); // produceUrl from your backend
producer.on("state", (s) => console.log("producer:", s));
await producer.start(); // reconnects on its own after network drops
```

A viewer watches a relay session with the same `createGlassClient` call as
above, using the relay session's `signalingUrl`.

**Calls** use a plain `RTCPeerConnection` and a WebSocket; see
[docs/sources/calls.md](docs/sources/calls.md).

## Licensing

Glass runs without a license key on the Free tier. A license key
(`GLASS_LICENSE_KEY`) raises the number of concurrent sessions:

| Tier | Concurrent sessions per Glass process |
|---|---|
| Free | 2 |
| Pro | 20 |
| Pro+ | 50 |

The limit applies to each session type separately: a Pro instance can run 20
browser sessions, 20 relay sessions and 20 calls at the same time. Watch-only
viewers don't count against it. Glass also refuses new sessions when the host
runs out of CPU headroom, whatever the tier. See [docs/sizing.md](docs/sizing.md).

## Direction

What is being built next. None of it exists yet, and there are no dates.

- **Per-viewer quality for relay streams.** Producers send several quality
  layers (simulcast); Glass picks one per viewer from that viewer's own
  bandwidth, so one slow viewer doesn't lower quality for everyone.
- **Streams across several Glass nodes.** A node near a viewer pulls a stream
  from the node that owns it and serves it locally.
- **Device agents.** Small apps that publish a computer's or phone's screen
  as a relay producer and, where the platform allows it, accept remote input.
  Only mechanisms each platform permits for shipping software are used, so
  anything built on Glass stays sellable. On iOS that means view-only.

## Documentation

| Doc | For | What's in it |
|---|---|---|
| [Getting started](docs/getting-started.md) | Everyone | First working setup for each source |
| [Concepts](docs/concepts.md) | Integrators | Sessions, connections, capabilities, control handoff, reconnects |
| [Hosted browser](docs/sources/browser.md) | Integrators | Navigation, viewport, clipboard, files, audio, microphone |
| [Relay producers](docs/sources/producers.md) | Integrators | The producer contract, stream slots, `GlassProducer` |
| [Calls](docs/sources/calls.md) | Integrators | Two-party calling |
| [Client SDK](docs/client-sdk.md) | Integrators | `GlassClient`, `GlassProducer`, the viewer layer |
| [Protocol](docs/protocol.md) | Integrators | HTTP API, signaling and DataChannel messages |
| [Architecture](docs/architecture.md) | Everyone | How media and input move through the engine |
| [Deployment](docs/deployment.md) | Operators | Ports, NAT, TURN, TLS, auth, Docker |
| [Sizing](docs/sizing.md) | Operators | Capacity, memory, instance choice |
| [Configuration](docs/configuration.md) | Operators | Every operator setting |

## Repository layout

- `packages/client/`: `@glass/client`, the TypeScript SDK. The core has no
  DOM dependency; `@glass/client/viewer` is the optional video and input
  layer.
- `examples/viewer-preact/`: the reference viewer for hosted-browser and
  relay sessions.
- `examples/producer-capacitor/`: an Android app that publishes the phone's
  camera and microphone as a relay producer and shares a watch link.
- `examples/call-capacitor/`: an Android app for two-party calls.
- `examples/quickstart/`: the single-page relay and call examples used by
  the getting-started guide.
- `docs/`: everything above.
