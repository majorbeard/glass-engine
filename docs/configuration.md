# Configuration

Glass is configured through `GLASS_*` environment variables, read once at
startup. After changing one, recreate the container; a restart keeps the old
environment.

To see every setting, its current value and its default:

```sh
docker run --rm ghcr.io/majorbeard/glass doctor --env
```

Secrets show only as "set". The tables below list the operator settings;
`doctor --env` also lists diagnostic settings, which are for debugging and may
change between releases.

## Essentials

| Variable | Default | Purpose |
|---|---|---|
| `GLASS_ADDR` | `:8080` | HTTP listen address. |
| `GLASS_API_TOKEN` | unset | Bearer token for the HTTP API. Required unless Glass listens on loopback only. Comma-separated to rotate: the current token first, then those being retired; every listed token works. See [deployment.md](deployment.md#authentication). |
| `GLASS_TICKET_SECRET` | unset | Secret your backend signs [session tickets](protocol.md#session-tickets) with, so a browser can start a session without the API token. Comma-separated to rotate. Unset, tickets are off. |
| `GLASS_LINK_TTL_HOURS` | `24` | How long a link Glass returns admits new connections, unless its request sets its own. `0` is never. See [protocol.md](protocol.md#link-expiry). |
| `GLASS_INSECURE_LOCAL_DEV` | `false` | Allow no token on a non-loopback address. Local Docker development only. |
| `GLASS_ALLOW_NO_SANDBOX` | `false` | Run Chrome without its sandbox where the sandbox cannot start (as root, or in a container without Glass's seccomp profile) instead of refusing to start. Removes a layer of defense against a hostile page. See [deployment.md](deployment.md#hardening). |
| `GLASS_LICENSE_KEY` | unset (Free) | Your license key. Checked at startup and periodically; an unreachable license server is retried for about 30 s at startup, and a paid tier is kept for 7 days from its last successful check. `GET /v1/info` shows the tier in effect. |
| `GLASS_LICENSE_CACHE_PATH` | `~/.cache/glass/license-cache.json` | File that keeps the last validated tier (never the key) across restarts. On a persistent volume (the image's `glass-cache` volume covers the default) it also survives re-creating the container. |

## Capacity

| Variable | Default | Purpose |
|---|---|---|
| `GLASS_SESSION_CAP` | the tier's limit | Lower the concurrent-session limit (each session type separately). Can't exceed the tier's limit. |
| `GLASS_POOL_SIZE` | the session cap | Most browser processes. Lower it to cap browser sessions below the session cap. |
| `GLASS_POOL_WARM_FLOOR` | `2` | Browsers started at boot and kept ready. `0` starts them on demand. |
| `GLASS_HARD_CAP_CPU_THRESHOLD_PERCENT` | `85` | Host CPU percent above which new browser sessions are refused. `0` turns CPU admission off. See [sizing.md](sizing.md#admission-under-load). |
| `GLASS_HARD_CAP_SESSION_RESERVE_PERCENT` | one core | CPU each new session reserves until its own load shows. Lower it for light pages. |
| `GLASS_HARD_CAP_MAX_WAIT_MS` | `3000` | How long a new session waits for CPU headroom before `503`. |
| `GLASS_MAX_VIEWERS_PER_SESSION` | `50` | Connections one session admits. |
| `GLASS_MAX_STREAM_SLOTS` | `4` | Named slots one relay session may declare. |
| `GLASS_GOMEMLIMIT_MB` | unset | Soft memory limit for the engine process. See [sizing.md](sizing.md#memory-limit-glass_gomemlimit_mb). |

## Sessions and reconnects

| Variable | Default | Purpose |
|---|---|---|
| `GLASS_RECONNECT_GRACE_SECONDS` | `60` | How long a dropped connection is held for its client to resume. |
| `GLASS_PENDING_TTL_SECONDS` | `30` | How long a new browser session waits for its first connection. |
| `GLASS_RELAY_PENDING_TTL_SECONDS` | `600` | The same, for relay and call sessions. |
| `GLASS_RELAY_STALL_THRESHOLD_MS` | `2000` | A relay producer silent this long is `stalled`, then disconnected (close code 4001). |
| `GLASS_RELAY_FIRST_MEDIA_GRACE_MS` | `10000` | How long a new producer may take to send its first media. |
| `GLASS_INPUT_FLOOR_IDLE_MS` | `100` | Input mode `floor`: how long the controller keeps the page after a pointer or touch event. See [concepts.md](concepts.md#several-people-in-control). |
| `GLASS_INPUT_FLOOR_KEY_IDLE_MS` | `1000` | The same after a key or wheel event. |

## Network

| Variable | Default | Purpose |
|---|---|---|
| `GLASS_WEBRTC_UDP_PORT` | `50000` | The one UDP port every WebRTC connection shares. |
| `GLASS_WEBRTC_NAT_1TO1_IPS` | discovered | Public address(es) to advertise, comma-separated. By default Glass discovers its public address through STUN at startup. See [deployment.md](deployment.md#public-address-and-nat). |
| `GLASS_STUN_URLS` | Google public STUN | Comma-separated STUN URLs. |
| `GLASS_TURN_URLS` | unset | Comma-separated TURN/TURNS URLs. Needs `GLASS_TURN_SECRET`, or both `GLASS_TURN_USERNAME` and `GLASS_TURN_CREDENTIAL`: without a credential no session could connect, so Glass refuses to start and `glass doctor` fails the check. |
| `GLASS_TURN_SECRET` | unset | Secret shared with your TURN server (coturn's `use-auth-secret`). Set, Glass issues every connection its own short-lived TURN credential, for itself and for the client. See [deployment.md](deployment.md#turn). |
| `GLASS_TURN_CREDENTIAL_TTL_HOURS` | `24` | How long an issued TURN credential lasts. |
| `GLASS_TURN_USERNAME`, `GLASS_TURN_CREDENTIAL` | unset | A fixed TURN credential, for Glass's own side only: it is never given to clients. Ignored when `GLASS_TURN_SECRET` is set. |
| `GLASS_CORS_ORIGINS` | unset | Extra browser origins allowed, exact match, comma-separated. Loopback and private-network origins are always allowed. |
| `GLASS_TRUSTED_PROXIES` | loopback | IPs or CIDRs of reverse proxies whose `X-Forwarded-For` and `X-Forwarded-Host` are trusted. |
| `GLASS_PUBLIC_URL` | the request's own host | The address viewers reach Glass at, such as `https://glass.example.com`: the host and scheme of the signaling URLs Glass hands out. Set it behind a proxy that rewrites `Host`. See [deployment.md](deployment.md#the-address-viewers-are-given). |
| `GLASS_WEBRTC_UDP_PORT_MIN`, `_MAX` | unset | Deprecated per-connection port range; used only when set without `GLASS_WEBRTC_UDP_PORT`. |

## Hosted browser

| Variable | Default | Purpose |
|---|---|---|
| `GLASS_CAPTURE` | `auto` | How a session's picture is captured: `auto` (the first method that works on this host, checked at start), `nvidia`, `display-gpu`, `display` or `screencast`. See [sources/browser.md](sources/browser.md#how-the-picture-is-captured). |
| `GLASS_DISPLAY_MAX_VIEWPORT` | `2560x1440` | The largest viewport a session's display holds (`WxH`); a larger one falls back to the screencast. Each display is made this size. |
| `GLASS_CHROME_BIN` | found on `PATH`; in Docker `/usr/local/bin/chrome-headless-shell` | Chrome or `chrome-headless-shell` binary. In Docker, the two image paths (`chrome-headless-shell`, `chrome-full`) are downloaded from Google at start; any other path is used as it is and nothing is downloaded. Every capture method but `screencast` needs the full browser, so in Docker the headless shell is replaced by `chrome-full` for them. See [deployment.md](deployment.md#docker). |
| `GLASS_EGRESS_FILTER` | `true` | Block browser connections to private networks. See [deployment.md](deployment.md#security-posture). |
| `GLASS_AUDIO_MODE` | off | `on` streams browser audio. |
| `GLASS_MIC_POOL_CHROME_BIN` | unset | Enables microphone-capable sessions. In Docker: `/usr/local/bin/chrome-full`. |
| `GLASS_MIC_POOL_SIZE` | `1` | Most microphone-capable browsers. |
| `GLASS_MIC_POOL_WARM_FLOOR` | `0` | Microphone-capable browsers kept ready. |

## Encoding

| Variable | Default | Purpose |
|---|---|---|
| `GLASS_DEFAULT_CODEC` | `vp8` with `GLASS_VP8_SHIM_MODE=on`, else `h264` | The video codec of a browser session whose request names none: `h264`, `vp8` or `av1`. It must be available, or Glass does not start. A session can ask for its own (`codec`, see [protocol.md](protocol.md)); `GET /v1/info` lists what this host can serve. |
| `GLASS_VP8_SHIM_MODE` | off | `on` makes VP8 available to browser sessions, and the default codec when `GLASS_DEFAULT_CODEC` is not set. Relay producers and call peers send the default codec. |
| `GLASS_AV1_SHIM_MODE` | off | `on` makes AV1 available to browser sessions: the sharpest picture at low bitrates, scrolled text above all, for about the CPU of H.264 on a modern host. Not every viewer decodes AV1 (Safari only with AV1 hardware). |
| `GLASS_OPENH264_MODE` | on | `off` leaves out Cisco's OpenH264 (OpenH264 Video Codec provided by Cisco Systems, Inc.): nothing is downloaded from Cisco at start, and H.264 is not available. Another codec must be (`GLASS_VP8_SHIM_MODE=on` or `GLASS_AV1_SHIM_MODE=on`); GPU encoding is then unused (it encodes H.264). |
| `GLASS_NVENC_SHIM_MAX_SESSIONS` | every session with `nvidia` or `display-gpu`, else `0` | Browser sessions encoded on an NVIDIA GPU. The GPU capture methods encode on the GPU by themselves; with `screencast`, set it to encode there (`0` keeps encoding on the CPU). |
| `GLASS_OPENH264_SHIM_BIN_PATH`, `GLASS_OPENH264_LIB_PATH` | set in Docker | The H.264 encoder. Required unless `GLASS_OPENH264_MODE=off`; there is no other fallback. |
| `GLASS_VP8_SHIM_BIN_PATH`, `GLASS_AV1_SHIM_BIN_PATH` | set in Docker | The VP8 and AV1 encoders. |
| `GLASS_CONTENT_HINT` | `detail` | What a browser session protects when bitrate or the encoder's CPU is short: `detail` keeps the size and lowers the frame rate (text, interfaces); `motion` keeps the frame rate and lowers the size (video, games). A session can set its own on creation (`contentHint`, see [protocol.md](protocol.md)). |
| `GLASS_QUALITY_SCALER` | `false` | `true` also adapts the picture when the bitrate can't carry it; `GLASS_CONTENT_HINT` chooses how. |
| `GLASS_QUALITY_SCALER_MIN_PERCENT` | `37` | Lowest resolution scale the quality scaler may choose, in percent. |

## Operations

| Variable | Default | Purpose |
|---|---|---|
| `GLASS_VERBOSE_LOG` | `false` | Log per-event detail that is normally off. |
| `GLASS_DEBUG_PPROF` | `false` | Serve Go profiling at `/debug/pprof/`, behind the API token. Keep it off on public hosts. |
| `GLASS_TELEMETRY_ENABLED` | `false` | Send anonymous engine telemetry. Off unless you turn it on. |
