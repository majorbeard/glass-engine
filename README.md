# Glass Engine

Glass is a self-hosted engine for live streaming and remote control, built
to run inside your own product. It carries video and audio from a **source**
to any number of **viewers** over WebRTC, and carries input back from a
viewer to the source. You run it on your servers and build your app on its
HTTP API and SDK; your product, your users and your service terms stay yours.

A session holds sources, and a source can be:

| Source | What it is | Make it with |
|---|---|---|
| **Hosted browser** | A Chrome that Glass runs for you, on a display of its own. Viewers see it and drive it: mouse, keyboard, touch, scroll, navigation, clipboard, files, audio and microphone. | `POST /v1/sessions` with `{"sources": [{"kind": "browser"}]}` |
| **A published track** | Anything that can send WebRTC: a phone camera, a desktop capture, a hardware encoder, your own app. A member publishes it into the session and Glass forwards it to the others without decoding it; with simulcast (opt-in) each viewer gets the layer its own link carries. Two people who see and hear each other are two members publishing. | `POST /v1/sessions` with no sources, and a link that publishes |
| **A recording's playback** | A recorded session, played back as a session of its own. | `POST /v1/recordings/{id}/play` |

Whatever the sources, the model is the same: people join a session as
members, each with a link whose rights say what it may watch, publish and
control; control of each source can be handed between members; and dropped
connections resume inside a reconnect grace window. You build your product on the HTTP API and
[`@glass/client`](packages/client); Glass has no user interface of its own.

```text
              ┌──────────────────────── Glass ────────────────────────┐
 hosted       │                                                       │
 browser ─────┤                                                       │      viewer
              │  sessions · sources · links · control handoff ·       ├────► viewer
 published    │  reconnect grace · bandwidth estimation · TURN        │      viewer
 tracks ──────┤                                                       │
 (camera,     │                                                       │◄──── input
  desktop,…)  └───────────────────────────────────────────────────────┘
```

The engine itself (the Go server) is closed-source. It ships only as the
`ghcr.io/majorbeard/glass` Docker image (linux/amd64 and linux/arm64), which
contains everything it needs or downloads it from its publisher at start.
This repository holds the public pieces: the client SDK, the example apps
and these docs.

## What to expect

Measured on real machines and real links; each figure's version, hardware,
page and method are in [docs/performance.md](docs/performance.md). Your pages
and your network decide most of it, so measure your own workload too.

| | What to expect |
|---|---|
| **Hosted browser, CPU machine** | Chrome is most of the cost (on a news site: Chrome 81%, the encoder 15%, the engine 4%). A busy page can take most of a core; a page that stops painting costs little. Start at 4 vCPU for a handful of sessions. |
| **Hosted browser, GPU machine** | About 1.6 cores per WebGL session and 1 core per full-screen 2D animation. A 32-vCPU host with one RTX PRO 4500 carried 16 WebGL sessions or 20 animations at 60 fps. |
| **Relay streams and calls** | Forwarded without decoding: about 4 to 5 millicores per viewer at 1 Mbit/s. Your upload bandwidth usually runs out before the CPU does. |
| **A click to the picture** | 71 to 89 ms at the median with the viewer near the server; 159 to 188 ms from a cloud machine to a PC on home 4G, within about 30 ms of Chrome's own WebRTC sender on the same page. |
| **Sound against picture** | Within -61 to +30 ms of its picture, on a phone on cellular. |
| **A poor link** | A 200 ms round trip with 2% loss: the picture froze 1 to 3 s in about 50 s of watching. |
| **Start** | 46 s for a first start, which downloads Chrome; 7 s after that. |
| **One process** | Up to 50 sessions of each type, set by the license (see [Licensing](#licensing)). The engine's own overhead is small next to that: idle sessions cost about 0.3 MB each. On real workloads you reach the browsers' CPU, your upload bandwidth or the license limit first. |

## What Glass does, and what you run

Glass takes care of the media engineering: WebRTC, bandwidth estimation and
pacing, encoding, reconnects, input, per-link permissions enforced on the
server, recording, and a TURN relay and TLS certificates built in.

You still run the infrastructure:

- **The servers.** One Docker container per machine, a GPU machine where
  your pages need one, and the firewall rules for its HTTP and UDP ports
  ([docs/deployment.md](docs/deployment.md)).
- **Upgrades, monitoring and incidents.** Glass reports what it refuses and
  why, and exposes metrics ([docs/monitoring.md](docs/monitoring.md)), but
  you watch them. [docs/incident-response.md](docs/incident-response.md)
  covers a leaked link, token or secret.
- **More than one machine.** Each Glass process stands alone. To use several
  machines, your backend chooses the machine for each session; Glass doesn't
  route sessions between machines yet (see [Direction](#direction)).
- **Where the hosted browser browses from.** It reaches the web from your
  server's address, and some sites refuse or challenge datacenter addresses
  ([docs/sources/browser.md](docs/sources/browser.md#limits-worth-knowing)).

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
setup with an API token, and adds a published camera and a call.
[docs/deployment.md](docs/deployment.md) covers running Glass on a server,
where one container serves HTTPS and relays TURN itself (`GLASS_TLS=auto`,
`GLASS_TURN=embedded`).

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
import { GlassClient } from "@glass/client";
import { mountGlassViewer } from "@glass/client/viewer";

// Your backend calls POST /v1/sessions with the API token and hands the
// browser only the session's link and its browser's source id.
const { link, browser } = await fetch("/api/glass-session").then((r) => r.json());

const client = new GlassClient({ link });
mountGlassViewer(document.getElementById("stage")!, client, { source: browser }); // video + input
await client.connect();
client.source(browser).navigate("https://example.com");
```

**Publish a camera (or any track):**

```ts
import { GlassClient } from "@glass/client";

const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
const client = new GlassClient({ link: publishLink }); // a link that publishes, from your backend
client.publish(stream.getVideoTracks()[0], { kind: "camera" });
client.publish(stream.getAudioTracks()[0], { kind: "microphone" });
await client.connect(); // reconnects on its own after network drops
```

A viewer watches with a `GlassClient` on a link that watches; each published
track arrives as a source. **Calls** are the same thing, two members who both
publish and watch; see [docs/sources/calls.md](docs/sources/calls.md).

## Licensing

Glass runs without a license key on the Free tier. A license key
(`GLASS_LICENSE_KEY`) raises the number of concurrent sessions:

| Tier | Concurrent sessions per Glass process |
|---|---|
| Free | 2 |
| Pro | 20 |
| Pro+ | 50 |

The limit applies to browser sessions and to sessions whose members publish
separately: a Pro instance can run 20 of each at the same time. Watch-only
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
  out, set `GLASS_OPENH264_MODE=off` with `GLASS_VP8_SHIM_MODE=on` (AV1 may
  be added, but VP8 is required); Glass then downloads nothing from Cisco and
  encodes VP8, or AV1 for the sessions that ask for it. See
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

- **Streams across several Glass nodes.** A node near a viewer pulls a stream
  from the node that owns it and serves it locally.
- **Device agents.** Small apps that publish a computer's or phone's screen
  into a session and, where the platform allows it, accept remote input.
  Only mechanisms each platform permits for shipping software are used, so
  anything built on Glass stays sellable. On iOS that means view-only.

## Documentation

| Doc | For | What's in it |
|---|---|---|
| [Getting started](docs/getting-started.md) | Everyone | First working setup for each source |
| [Concepts](docs/concepts.md) | Integrators | Sessions, sources, members and links, control handoff, reconnects |
| [Hosted browser](docs/sources/browser.md) | Integrators | Navigation, viewport, clipboard, files, audio, microphone |
| [Page inspection](docs/page-inspection.md) | Integrators | Reading a hosted page's structure, acting on it with real input, watching its events |
| [Publishing](docs/sources/producers.md) | Integrators | Publishing cameras and microphones, simulcast, writing your own publisher |
| [Calls](docs/sources/calls.md) | Integrators | Two-party calling |
| [Recording and playback](docs/recording.md) | Everyone | Keeping a session's stream, playing it back, its timeline |
| [Client SDK](docs/client-sdk.md) | Integrators | `GlassClient`, sources, publishing, the viewer layer |
| [Migrating from 0.1](docs/migrating-from-0.1.md) | Integrators | Every change in protocol 3, and what replaces it |
| [Protocol](docs/protocol.md) | Integrators | HTTP API, signaling and DataChannel messages |
| [Architecture](docs/architecture.md) | Everyone | How media and input move through the engine |
| [Deployment](docs/deployment.md) | Operators | Ports, NAT, TURN, TLS, auth, Docker |
| [Monitoring and attacks](docs/monitoring.md) | Operators | What Glass is refusing and why; is my server being attacked; metrics for Prometheus |
| [Incident response](docs/incident-response.md) | Operators | A leaked link, token or secret: what to do; rotation schedule |
| [Performance](docs/performance.md) | Everyone | What Glass measured, on what, and how |
| [Sizing](docs/sizing.md) | Operators | Capacity, memory, instance choice |
| [Configuration](docs/configuration.md) | Operators | Every operator setting |

## Repository layout

- `packages/client/`: `@glass/client`, the TypeScript SDK. The core has no
  DOM dependency; `@glass/client/viewer` is the optional video and input
  layer.
- `examples/viewer-preact/`: the reference viewer: a hosted browser, a
  playback, or the cameras a session's members publish.
- `examples/producer-capacitor/`: an Android app that publishes the phone's
  camera and microphone and shares a watch link.
- `examples/call-capacitor/`: an Android app for two-party calls.
- `examples/compose/`: the engine and `glass gate` on one host, with Docker
  Compose: see [getting-started.md](docs/getting-started.md#7-on-a-server-the-engine-and-glass-gate).
- `examples/quickstart/`: the single-page publish and call examples used by
  the getting-started guide.
- `docs/`: everything above.
