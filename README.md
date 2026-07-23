# Glass Engine

Glass is a self-hosted runtime for interactive remote rendering. It launches
renderers, streams pixels, delivers input, manages sessions, and exposes a
stable protocol so you don't have to deal with Chromium lifecycle
management, WebRTC, encoding, or transport details yourself.

This repository holds the public-facing pieces: the installer, downloadable
binaries (via [Releases](https://github.com/majorbeard/glass-engine/releases)),
the client SDK, an example viewer built on it, and operator-facing docs. The
Glass engine itself (the Go server that launches browsers, encodes video,
and speaks the protocol) is closed-source - you get it as the `glass`
binary or Docker image below, not as source in this repo.

## Status

Pre-1.0. The wire protocol may change without a compatibility shim - see
[docs/protocol.md](docs/protocol.md).

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/majorbeard/glass-engine/main/install.sh | sh
```

Downloads the `glass` binary for your platform and runs `glass doctor` to
confirm your machine has what it needs (ffmpeg, Chrome/Chromium).

**On Windows**, `install.sh` needs a POSIX shell (WSL or Git Bash) - a plain
PowerShell/cmd prompt can't run it. Native Windows also has no equivalent of
`apt`/`brew` for ffmpeg, so unless you're already set up with WSL, the Docker
option just below is the easier path (Docker Desktop runs a real Linux VM,
so everything here just works regardless of host OS).

Or, with `chrome-headless-shell` bundled in a container — no host
dependency for the browser side:

```sh
docker run -p 8080:8080 ghcr.io/majorbeard/glass
```

This image does not bundle ffmpeg (see "FFmpeg and licensing" below) - by
default `glass start` in the container will fail its ffmpeg check at boot
just like a bare-metal install without ffmpeg would. Either build your own
image `FROM ghcr.io/majorbeard/glass` with ffmpeg installed, or pass
`-e GLASS_AUTO_FETCH_FFMPEG=true` to have it fetch a checksum-verified
static build itself on startup.

### FFmpeg and licensing

Glass shells out to a separately-installed `ffmpeg` binary for H.264
encoding - it never links or bundles FFmpeg or libx264 into the `glass`
binary itself, and the bundled Docker image doesn't include a compiled
ffmpeg either. Consumer applications only ever talk to Glass over the
network (REST/WebSocket, `@glass/client`), so their own codebases never
touch FFmpeg or any codec code directly.

`glass doctor` and `glass start` both check for a working ffmpeg+libx264
install at boot and fail with clear instructions if it's missing.
`install.sh` will try to install one for you (Homebrew on macOS, a
checksum-verified static build on Linux, skippable via
`GLASS_SKIP_FFMPEG_INSTALL=1`); in Docker, set `GLASS_AUTO_FETCH_FFMPEG=true`
if you'd rather Glass fetch one at startup than provide your own image.

This isn't legal advice: FFmpeg's own licensing depends on how a given build
is compiled, and encoding H.264 in production may carry its own
patent-licensing considerations for whoever operates it, independent of
Glass. If you're scaling a product on Glass, get your own counsel's read on
your specific situation rather than relying on this note.

## Repo layout

- `install.sh` — the installer behind the one-liner above.
- `packages/client/` — `@glass/client`, the client SDK. A DOM-free transport
  core (`@glass/client`: connect, reconnection, input) plus an optional
  vanilla-DOM viewer (`@glass/client/viewer`: renders the video and captures
  mouse/touch/keyboard/scroll/viewport input). This is the reusable client
  engine — the thing you build a viewer on top of, in any framework or none.
- `examples/viewer-preact/` — a reference Preact viewer built on
  `@glass/client`. Not the product — an example client, kept deliberately
  simple.
- `docs/` — protocol reference, architecture overview, and deployment notes.

## Using the client SDK

```ts
import { createGlassClient, createGlassSession } from "@glass/client";
import { mountGlassViewer } from "@glass/client/viewer";

// In a real app your own backend creates the session (auth/quota stay
// server-side) and hands the client only the signalingUrl. createGlassSession
// is a dev convenience - pass the glass instance's address (Glass has no
// product frontend, so your client is almost always a different origin, and
// the backend's CORS policy allows any loopback/private-LAN origin).
const session = await createGlassSession("http://localhost:8080");
const client = createGlassClient({
  signalingUrl: session.signalingUrl,
  sessionId: session.id,
});

// Mount the viewer BEFORE connecting so its initial viewport/mobile
// declaration reaches the backend before the first navigation.
mountGlassViewer(document.getElementById("stage")!, client);

client.on("navigation", (nav) => {
  /* update your own URL bar */
});
await client.connect();
client.navigate("https://example.com");
```

The core (`@glass/client`) has no DOM dependency and can be used with a custom
renderer; `@glass/client/viewer` is the ready-made rendering + input layer.

## Running the example viewer

Against a running `glass start` instance (see Install above):

```sh
npm install                              # from the repo root - builds @glass/client too
npm run build --workspace @glass/client  # keep the SDK's dist/ fresh if you change it
cd examples/viewer-preact
npm run dev
```

Open the URL Vite prints (typically `http://localhost:5173`). It talks to
the backend at `http://localhost:8080` by default; set `VITE_GLASS_ADDR` to
point it elsewhere.

## Configuration

The `glass` binary/image reads these environment variables at startup (all
optional):

| Variable | Default | Purpose |
|---|---|---|
| `GLASS_ADDR` | `:8080` | HTTP listen address. |
| `GLASS_POOL_SIZE` | `5` | Number of browser instances to launch. |
| `GLASS_SESSION_CAP` | same as pool size | Max concurrent sessions. |
| `GLASS_CHROME_BIN` | *(auto-detected)* | Path to a specific Chrome/Chromium/`chrome-headless-shell` binary. |
| `GLASS_RECONNECT_GRACE_SECONDS` | `60` | How long a session whose signaling connection drops abnormally (network loss, phone screen lock — not an intentional client close) is held open, streaming paused, before being closed if the client never reconnects. |
| `GLASS_DEBUG_PPROF` | off | Set to `true` to expose `net/http/pprof` under `/debug/pprof/`. Off by default — don't enable on a shared/public machine. |
| `GLASS_LICENSE_KEY` | unset (free tier) | License key from your Polar purchase. Validated once at startup; missing/invalid keys, or Polar being unreachable, all fall back to the free tier rather than blocking startup. Clamps `GLASS_SESSION_CAP` to the tier's limit — never raises it. |
| `GLASS_STUN_URLS` | Google's public STUN | Comma-separated STUN server URL(s), e.g. `stun:stun.example.com:19302`. |
| `GLASS_TURN_URLS` | unset (no TURN) | Comma-separated TURN/TURNS server URL(s), e.g. `turn:turn.example.com:3478,turns:turn.example.com:5349`. STUN alone cannot connect a client behind symmetric NAT or a restrictive firewall — see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#turn-nat-traversal-for-real-world-networks) for free/paid/self-hosted options. `glass doctor` reports whether this is set. |
| `GLASS_TURN_USERNAME` / `GLASS_TURN_CREDENTIAL` | unset | Long-term credentials for `GLASS_TURN_URLS` — required by virtually every real TURN server. |
| `GLASS_API_TOKEN` | unset (no auth) | Requires every `/v1/*` request (`Authorization: Bearer <token>` or `?token=<token>` — the latter for the signaling WebSocket/SSE stats stream, which can't set a custom header) to present it. `/healthz` stays open. Off by default — see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#exposure-authentication) before binding to anything but localhost. `glass doctor` reports whether this is set. |
| `GLASS_EGRESS_FILTER` | `true` (enabled) | Every pooled Chrome instance is launched pointed at a local forward proxy that blocks any outbound connection — not just the explicit navigate action — to a loopback/private/link-local destination. Set to `false` to disable (not recommended — see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#egress-filtering-ssrf-protection)). `glass doctor` reports its status. |

Glass has no product frontend and serves none — its REST/WebSocket routes
are CORS-enabled for any loopback/private-LAN origin, so your own client
(the example viewer, or your own frontend) just needs to know the
instance's address.

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for keeping the process itself
running (systemd/Docker restart policies), and
[docs/GLASS_ENGINE_FLOW_EXPLAINER.md](docs/GLASS_ENGINE_FLOW_EXPLAINER.md)
for a high-level architecture walkthrough.
