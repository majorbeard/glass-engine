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
| `GLASS_API_TOKEN` | unset | Bearer token for the HTTP API. Required unless Glass listens on loopback only. See [deployment.md](deployment.md#authentication). |
| `GLASS_INSECURE_LOCAL_DEV` | `false` | Allow no token on a non-loopback address. Local Docker development only. |
| `GLASS_LICENSE_KEY` | unset (Free) | Your license key. Checked at startup and periodically; if the license server is unreachable, a paid tier is kept for 7 days from its last successful check. `GET /v1/info` shows the tier in effect. |

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

## Network

| Variable | Default | Purpose |
|---|---|---|
| `GLASS_WEBRTC_UDP_PORT` | `50000` | The one UDP port every WebRTC connection shares. |
| `GLASS_WEBRTC_NAT_1TO1_IPS` | discovered | Public address(es) to advertise, comma-separated. By default Glass discovers its public address through STUN at startup. See [deployment.md](deployment.md#public-address-and-nat). |
| `GLASS_STUN_URLS` | Google public STUN | Comma-separated STUN URLs. |
| `GLASS_TURN_URLS` | unset | Comma-separated TURN/TURNS URLs. |
| `GLASS_TURN_USERNAME`, `GLASS_TURN_CREDENTIAL` | unset | TURN credentials. |
| `GLASS_CORS_ORIGINS` | unset | Extra browser origins allowed, exact match, comma-separated. Loopback and private-network origins are always allowed. |
| `GLASS_TRUSTED_PROXIES` | loopback | IPs or CIDRs of reverse proxies whose `X-Forwarded-For` is trusted. |
| `GLASS_WEBRTC_UDP_PORT_MIN`, `_MAX` | unset | Deprecated per-connection port range; used only when set without `GLASS_WEBRTC_UDP_PORT`. |

## Hosted browser

| Variable | Default | Purpose |
|---|---|---|
| `GLASS_CHROME_BIN` | found on `PATH` (bundled in Docker) | Chrome or `chrome-headless-shell` binary. |
| `GLASS_EGRESS_FILTER` | `true` | Block browser connections to private networks. See [deployment.md](deployment.md#security-posture). |
| `GLASS_AUDIO_MODE` | off | `on` streams browser audio. |
| `GLASS_MIC_POOL_CHROME_BIN` | unset | Enables microphone-capable sessions. In Docker: `/usr/local/bin/chrome-full`. |
| `GLASS_MIC_POOL_SIZE` | `1` | Most microphone-capable browsers. |
| `GLASS_MIC_POOL_WARM_FLOOR` | `0` | Microphone-capable browsers kept ready. |

## Encoding

| Variable | Default | Purpose |
|---|---|---|
| `GLASS_VP8_SHIM_MODE` | off | `on` encodes VP8 instead of H.264, for every session in the process. Relay producers and call peers must then send VP8. |
| `GLASS_NVENC_SHIM_MAX_SESSIONS` | `0` | Browser sessions encoded on an NVIDIA GPU. `0` disables GPU encoding. |
| `GLASS_OPENH264_SHIM_BIN_PATH`, `GLASS_OPENH264_LIB_PATH` | set in Docker | The H.264 encoder. Required; there is no fallback. |

## Operations

| Variable | Default | Purpose |
|---|---|---|
| `GLASS_VERBOSE_LOG` | `false` | Log per-event detail that is normally off. |
| `GLASS_DEBUG_PPROF` | `false` | Serve Go profiling at `/debug/pprof/`, behind the API token. Keep it off on public hosts. |
| `GLASS_TELEMETRY_ENABLED` | `false` | Send anonymous engine telemetry. Off unless you turn it on. |
