# Glass Engine

Glass is a self-hosted engine for live streaming and remote control. It
carries video and audio from a **source** to any number of **viewers** over
WebRTC, and carries input back from a viewer to the source.

A source can be:

| Source | What it is | Create it with |
|---|---|---|
| **Hosted browser** | A Chrome that Glass runs for you, on a display of its own. Viewers see it and drive it: mouse, keyboard, touch, scroll, navigation, clipboard, files, audio and microphone. | `POST /v1/sessions` |
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
contains everything it needs or downloads it from its publisher at start.
This repository holds the public pieces: the client SDK, the example apps
and these docs.

## Performance

Measured on real machines and real links; each figure's version, hardware,
page and method are in [docs/performance.md](docs/performance.md).

| | |
|---|---|
| **40,000 sessions** on one 8-vCPU machine | no errors; 25,000 held for an hour under constant churn, no leak |
| **3 to 5 millicores** per 30 fps stream | the engine's own cost, linear from 50 to 800 streams |
| **WebGL at 43 fps, 1280x720** on a GPU | against 10 fps at 640x360 in software, CPU full |
| **19% of the CPU instead of 31.5%** | eight sessions encoded on the GPU (NVENC) |
| **159 to 188 ms** click to picture | cloud machine to a PC on home 4G, median; within about 30 ms of Chrome's own WebRTC sender |
| **Sound within -61 to +30 ms** of its picture | a phone on cellular |

## Status

Pre-1.0. The wire protocol carries a version number so breaking changes are
detectable, but they are still allowed. See [docs/protocol.md](docs/protocol.md#versioning).

## Quick start

You need Docker. Start Glass for local development (loopback only, no
token):

```sh
docker run --rm ghcr.io/majorbeard/glass seccomp-profile > glass-seccomp.json
docker run -d --name glass \
  --security-opt seccomp=glass-seccomp.json \
  -p 127.0.0.1:8080:8080 \
  -p 50000:50000/udp \
  --shm-size=1g \
  -v glass-cache:/home/glass/.cache/glass \
  -e GLASS_INSECURE_LOCAL_DEV=true \
  -e GLASS_WEBRTC_NAT_1TO1_IPS=127.0.0.1 \
  ghcr.io/majorbeard/glass

curl http://localhost:8080/healthz      # {"status":"ok"}
```

The first start downloads Chrome from Google and the OpenH264 encoder from
Cisco into the `glass-cache` volume (about 120 MB), so it takes a little
longer; later starts reuse them.

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

### Third-party software

The image carries the notices of the open-source software it contains in
`/usr/share/doc/glass/THIRD_PARTY_NOTICES`, which says where each one is.
Two components are not in the image; each container downloads them from
their publishers when it starts:

- **Chrome:** Google's Chrome for Testing, from Google, under
  [Google's terms](https://www.google.com/chrome/terms/). Its own notices come
  with it. Its Widevine module is removed, so DRM-protected video does not
  play in a hosted browser.
- **OpenH264:** OpenH264 Video Codec provided by Cisco Systems, Inc., from
  Cisco, under Cisco's binary licence (reproduced in the image at
  `/usr/share/doc/glass/licenses/openh264/BINARY_LICENSE.txt`). To leave it
  out, set `GLASS_OPENH264_MODE=off` with `GLASS_VP8_SHIM_MODE=on` or
  `GLASS_AV1_SHIM_MODE=on`; Glass then downloads nothing from Cisco and
  encodes VP8 or AV1. See
  [docs/configuration.md](docs/configuration.md#encoding).

## Built on

Glass stands on open-source work. Thank you to everyone behind these
projects.

| Project | What Glass uses it for | Licence |
|---|---|---|
| [Go](https://go.dev) and its standard library | the engine | BSD-3-Clause |
| [Pion](https://github.com/pion) (webrtc, ice, interceptor, rtp, rtcp, stun, transport) | WebRTC: peers, ICE, RTP and RTCP; Glass carries a patched copy of `interceptor` for its congestion control | MIT |
| [WebRTC](https://webrtc.googlesource.com/src/) | the reference for congestion control and pacing; some of Glass's patched code is derived from it | BSD-3-Clause |
| [Rod](https://github.com/go-rod/rod) and [gson](https://github.com/ysmood/gson) | driving Chrome over the DevTools protocol | MIT |
| [Gorilla WebSocket](https://github.com/gorilla/websocket) | signaling | BSD-2-Clause |
| [google/uuid](https://github.com/google/uuid), [golang.org/x/sys](https://github.com/golang/sys) | IDs, system calls | BSD-3-Clause |
| [Chromium](https://www.chromium.org) / [Chrome for Testing](https://googlechromelabs.github.io/chrome-for-testing/) | the hosted browser (downloaded from Google at start) | BSD-3-Clause and its components; Google's terms for Chrome for Testing |
| [OpenH264](https://www.openh264.org) | H.264 encoding (the library is downloaded from Cisco at start) | BSD-2-Clause; Cisco's binary licence |
| [libvpx](https://chromium.googlesource.com/webm/libvpx) | VP8 encoding | BSD-3-Clause |
| [SVT-AV1](https://gitlab.com/AOMediaCodec/SVT-AV1) | AV1 encoding | BSD-3-Clause-Clear; Alliance for Open Media Patent License 1.0 |
| [Opus](https://opus-codec.org) | audio encoding and decoding | BSD-3-Clause |
| [libjpeg-turbo](https://libjpeg-turbo.org) | decoding the browser's captured frames | IJG, BSD-3-Clause, zlib |
| [NVIDIA Video Codec SDK](https://developer.nvidia.com/video-codec-sdk) headers, via [nv-codec-headers](https://github.com/FFmpeg/nv-codec-headers) | GPU encoding (NVENC) | MIT |
| [PulseAudio](https://www.freedesktop.org/wiki/Software/PulseAudio/) | capturing the browser's sound | LGPL-2.1-or-later |
| [tini](https://github.com/krallin/tini) | the container's init process | MIT |
| [Debian](https://www.debian.org) | the image's base and system libraries | each package's own |
| [Preact](https://preactjs.com) and [Vite](https://vitejs.dev) | the reference viewer | MIT |

The image carries each one's licence text; `/usr/share/doc/glass/THIRD_PARTY_NOTICES`
says where.

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
| [Page inspection](docs/page-inspection.md) | Integrators | Reading a hosted page's structure, acting on it with real input, watching its events |
| [Relay producers](docs/sources/producers.md) | Integrators | The producer contract, stream slots, `GlassProducer` |
| [Calls](docs/sources/calls.md) | Integrators | Two-party calling |
| [Client SDK](docs/client-sdk.md) | Integrators | `GlassClient`, `GlassProducer`, the viewer layer |
| [Protocol](docs/protocol.md) | Integrators | HTTP API, signaling and DataChannel messages |
| [Architecture](docs/architecture.md) | Everyone | How media and input move through the engine |
| [Deployment](docs/deployment.md) | Operators | Ports, NAT, TURN, TLS, auth, Docker |
| [Incident response](docs/incident-response.md) | Operators | A leaked link, token or secret: what to do; rotation schedule |
| [Performance](docs/performance.md) | Everyone | What Glass measured, on what, and how |
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
