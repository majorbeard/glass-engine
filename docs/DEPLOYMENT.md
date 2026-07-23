# Deployment

This covers one specific, narrow thing: **making sure Glass restarts itself
automatically if the process ever dies outright** (an OS-level OOM kill, a
panic that somehow isn't recovered, a host reboot). It is not a general
deployment guide - Glass has no opinion on how you build, ship, or run your
own image beyond this.

This is a different concern from Glass's own in-process resilience: a
goroutine panic is now recovered and logged instead of crashing the process,
and a browser process dying mid-session now closes just that one session
instead of hanging forever. Neither of those needs anything below - this
page is specifically for the remaining case where the whole Glass process
itself stops running.

## systemd (Linux)

The standard, well-understood answer. Example unit file:

```ini
# /etc/systemd/system/glass-runtime.service
[Unit]
Description=Glass Runtime
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/glass start
Restart=on-failure
RestartSec=2

# Uncomment and adjust as needed - see the Configuration table in the
# root README for the full list of GLASS_* environment variables.
# Environment=GLASS_POOL_SIZE=8
# Environment=GLASS_CHROME_BIN=/usr/bin/chrome-headless-shell
# EnvironmentFile=/etc/glass-runtime/env

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now glass-runtime
sudo systemctl status glass-runtime   # check it's running
journalctl -u glass-runtime -f        # follow its logs
```

`Restart=on-failure` covers a crash or non-zero exit; add `Restart=always`
instead if you also want it to restart after an intentional clean stop
(`Type=simple`'s default meaning of "exit code 0" is treated as success and
won't restart under `on-failure`).

## Docker

If you're running Glass in a container, the restart policy is the
container runtime's job, not systemd's - use whichever of these matches
how you already run containers. Substitute `ghcr.io/majorbeard/glass` (the
official bundled image - see the root README's Install section) or your
own derived image below.

`docker run`:

```sh
docker run -d \
  --name glass-runtime \
  --restart unless-stopped \
  -p 8080:8080 \
  -e GLASS_POOL_SIZE=8 \
  -e GLASS_AUTO_FETCH_FFMPEG=true \
  ghcr.io/majorbeard/glass
```

`docker-compose.yml`:

```yaml
services:
  glass-runtime:
    image: ghcr.io/majorbeard/glass
    restart: unless-stopped
    ports:
      - "8080:8080"
    environment:
      - GLASS_POOL_SIZE=8
      - GLASS_AUTO_FETCH_FFMPEG=true
```

`restart: unless-stopped` (or `--restart unless-stopped`) restarts on crash
and on host reboot, but respects an explicit `docker stop` - generally the
right default. `on-failure` is the narrower option if you specifically
don't want a restart after a clean exit either.

## TURN: NAT traversal for real-world networks

By default Glass's ICE configuration is STUN-only (Google's public STUN
server). STUN alone is enough to connect two peers on the same LAN, or
across most home-router NATs — nearly all of this project's own load/soak
testing has been exactly that — but it cannot establish a path for a client
behind **symmetric NAT** (common on
mobile carrier networks and some corporate VPNs) or a **restrictive/corporate
firewall** that blocks the direct peer-to-peer UDP path STUN would otherwise
find. Without a TURN server as a relay of last resort, those clients fail to
connect with no clearer symptom than an ICE-gathering timeout on the browser
side. The moment Glass is reached over the open internet rather than a LAN,
this stops being an edge case.

### Plumbing

Three environment variables, read once at startup (`runtime.NewRuntime`) and
applied to every session's `PeerConnection` — never re-read per connection:

| Variable | Purpose |
|---|---|
| `GLASS_STUN_URLS` | Comma-separated STUN URL(s). Empty uses Google's public STUN server (unchanged default). |
| `GLASS_TURN_URLS` | Comma-separated TURN/TURNS URL(s), e.g. `turn:turn.example.com:3478,turns:turn.example.com:5349`. Empty means no TURN server at all. |
| `GLASS_TURN_USERNAME` / `GLASS_TURN_CREDENTIAL` | Long-term credentials for every URL in `GLASS_TURN_URLS`. |

`glass doctor` reports whether TURN is configured (never prints the
credential); the runtime also logs an explicit STUN-only warning at startup
if `GLASS_TURN_URLS` is unset, for the same reason the telemetry disclosure
line exists — this is the one place a self-hoster can confirm what's
actually wired up.

### Options, roughly cheapest-to-set-up first

**Free, for testing only** — shared, rate-limited, not something to point a
real deployment at long-term:
- **Open Relay Project** (`openrelay.metered.ca`, run by Metered) publishes a
  free public TURN server with static test credentials, commonly used for
  exactly this kind of quick WebRTC verification. Check their site
  (metered.ca/tools/openrelay) for the current host/credential values before
  using them — free shared credentials like this do get rotated or rate-limited.
- **Cloudflare Calls** and **Twilio's Network Traversal Service** both have a
  free tier / trial credit and issue short-lived, per-request credentials via
  an API call rather than a static username/password — a meaningfully better
  security posture than a shared static credential, worth preferring even for
  testing if you're already touching either platform.

**Paid / managed**, for a real deployment without running your own TURN
infrastructure:
- **Twilio Network Traversal Service** (pay-as-you-go beyond trial credit).
- **Xirsys** (WebRTC-focused, freemium tiers scaling to paid).
- **Cloudflare Calls** (usage-based pricing beyond its free tier).

All three generate time-limited credentials via an API call — if you adopt
one of these, the natural integration point is generating a fresh
short-lived credential per session (e.g. inside `handleCreateSession`) rather
than putting one static long-lived credential in `GLASS_TURN_CREDENTIAL` —
today's plumbing supports the static case first since it's the zero-code-change
option; per-session credential minting would be a small follow-up if you go
this route.

**Self-hosted, open source: [coturn](https://github.com/coturn/coturn)** —
the standard answer if you'd rather run your own and not depend on a third
party relaying your users' traffic:

```sh
# Debian/Ubuntu
sudo apt-get install coturn

# or via Docker
docker run -d --name coturn --network host \
  coturn/coturn \
  -n --log-file=stdout \
  --listening-port=3478 \
  --realm=your-domain.example.com \
  --use-auth-secret --static-auth-secret=<a-long-random-secret>
```

Minimal `turnserver.conf` for a static single credential (fine for a small
self-hosted Glass deployment):

```ini
listening-port=3478
tls-listening-port=5349
realm=your-domain.example.com
user=glassuser:a-long-random-password
# min/max relay port range - must match what's opened on the firewall/security group
min-port=49152
max-port=65535
```

Point Glass at it: `GLASS_TURN_URLS=turn:your-domain.example.com:3478`,
`GLASS_TURN_USERNAME=glassuser`, `GLASS_TURN_CREDENTIAL=a-long-random-password`.

Firewall/security-group ports to open: `3478` UDP+TCP (TURN), `5349` TCP (TURNS/TLS,
if configured), and the full relay port range (`min-port`–`max-port` above,
UDP) — coturn needs that whole range reachable, not just the control port.

For anything beyond quick testing, prefer coturn's `--use-auth-secret`
(HMAC-based, time-limited credentials minted per session) over a single
static `user=` entry — a leaked static credential is a standing relay any
client can use indefinitely; a leaked time-limited one expires.

## Exposure: authentication

By default, every `/v1/*` route is unauthenticated - `POST /v1/sessions`
creates a session and drives a real Chrome instance for **any** client that
can reach the port, with no notion of caller identity anywhere in the
session abstraction (by design: the embedding app is meant to own all
policy, including auth). That's fine
behind `localhost` for local dev, or a free-tier single-session instance
nobody else can reach - it stops being fine the moment `-p 8080:8080` (or
any equivalent) puts the port on a network anyone else can address. Without
auth, that's an open remote-browsing proxy: anyone who can reach the port
can create sessions and browse the internet through your server's egress IP.

Set `GLASS_API_TOKEN` to close this:

```sh
GLASS_API_TOKEN=$(openssl rand -hex 32) glass start
```

Once set, every `/v1/*` request must present it as either
`Authorization: Bearer <token>` or `?token=<token>` - the query-param form
exists because a browser's native `WebSocket` and `EventSource` constructors
can't set a custom header at all, so the signaling connection and the SSE
stats stream have no other way to carry it. `/healthz` always stays open
(a supervisor's health check can't be expected to carry a token).
`POST /v1/sessions`'s response embeds the token into the returned
`signalingUrl` automatically, so whoever already authenticated to create a
session doesn't need to separately wire it into the WebSocket connection.

**Where the token should actually live**: in your own backend, not in a
browser bundle. The intended shape (per `@glass/client`'s own
`createGlassSession` doc comment) is: your backend calls
`POST {glass}/v1/sessions` with the token, server-side, and hands its own
frontend only the resulting `signalingUrl` - which is scoped to that one
session and already carries whatever the runtime needs. `glass doctor`
reports whether `GLASS_API_TOKEN` is set (never the value itself); the
example viewer's `VITE_GLASS_API_TOKEN` env var exists purely so that
standalone example can be exercised end-to-end against a token-gated
runtime during local testing - baking a real token into `VITE_*` (which
ships in the browser's JS bundle for anyone to read) is not something a
real deployment should do.

## Egress filtering (SSRF protection)

Glass's job is rendering arbitrary, potentially adversarial web content, and
that content runs inside a real Chrome process with (by default) the full
network reachability of wherever Glass is deployed. `security.
ValidateNavigationURL` blocks the one explicit "navigate to this URL"
action from targeting localhost/private/link-local addresses (including
cloud metadata endpoints like `169.254.169.254`) - but that check only ever
sees that one action. Everything the loaded page does on its own afterward
- a JS `fetch`/`XHR`/`WebSocket` to an internal service, an
`<iframe src="http://10.x.x.x">`, a redirect, an ad/analytics/tracking
subresource a real page loads by the dozen - runs completely outside that
check's view.

By default (`GLASS_EGRESS_FILTER` unset, or anything other than `false`),
every pooled Chrome instance is launched pointed at a local forward proxy
(`internal/egressproxy`) via `--proxy-server`, with
`--proxy-bypass-list=<-loopback>` to remove Chrome's own default exemption
for loopback addresses (added upstream for developer convenience - exactly
the wrong default here). Every single outbound connection - not just ones
this project's own code initiates - gets the same check:
`security.ResolveAndBlockPrivate` resolves the destination host exactly
once and hands back the literal IP to dial, already confirmed not to be
loopback/private/link-local; that literal IP is what actually gets dialed,
never the hostname again, which is what closes the DNS-rebinding TOCTOU gap
an app-layer-only URL check has (a domain can resolve to a public IP on one
lookup and a private/metadata IP moments later).

This has been verified against real traffic, not just unit tests: driving a
real session to a real page shows dozens of real third-party ad-network/
analytics/tracking domains (`doubleclick.net`, `googlesyndication.com`,
`google-analytics.com`, etc. - exactly the class of in-page JS-initiated
request the app-layer check never saw) tunneled through the proxy
successfully, alongside confirmed blocking of loopback and link-local
(`169.254.169.254`) targets at both the plain-HTTP and HTTPS-CONNECT layers.

`glass doctor` reports whether this is enabled. Disabling it
(`GLASS_EGRESS_FILTER=false`) removes a real security boundary - only do
this deliberately (e.g. a deployment that intentionally needs sessions to
reach internal services), and prefer a narrower fix (a specific allowlist
exception) if you find yourself wanting to turn it off entirely.

## Chrome sandbox

Glass's whole job is rendering arbitrary, potentially adversarial web
content, so Chrome's own sandbox (a real layer of defense-in-depth against
a renderer exploit) matters more here than in most Chrome-automation
projects. Every pooled Chrome instance now launches with the sandbox
**active by default** - `--no-sandbox` is no longer set unconditionally for
every "cloud" deployment (`CLOUD_DEPLOYMENT=true`) the way it used to be;
it's only added when actually required:

- **Running as root (uid 0)**: Chrome's sandbox refuses to even initialize
  under root, so `--no-sandbox` is added automatically, with a loud warning
  in the log. Prefer running this process as a non-root user instead -
  that's the real fix, not this fallback. A container that runs Glass as
  root should add a dedicated unprivileged user (a `USER` directive in your
  Dockerfile).
- **A restrictive container/seccomp profile**: some hardened container
  setups block the unprivileged user-namespace mechanism Chrome's sandbox
  relies on, even for a non-root process. If a normal sandboxed launch
  fails, Glass retries once with `--no-sandbox` and logs why - this keeps
  Glass running rather than refusing to start, but the real fix is relaxing
  whatever's blocking user namespaces for this container, not relying on
  the fallback long-term.

`glass start`'s log reports which case applies (`🛡️ Chrome sandbox active`
vs. the root/fallback warnings above) every time a browser instance
launches.

**What this does not fix**: every session's incognito context still runs
inside the same pooled OS process as every other concurrent session on that
Chrome instance (see `sessions.Manager.Create` / `BrowserPool.Isolate` for
the per-session storage isolation that *is* in place - cookies/localStorage/
IndexedDB/cache, not process boundaries). A renderer exploit that escapes
Chrome's sandbox still has a direct run at every other session sharing that
process, not just the host. Real per-session isolation would mean separate
OS processes or microVMs per session (gVisor/Firecracker-style) - a bigger
deployment-model change, not something this fix attempts. Re-enabling the
sandbox closes the "no sandbox at all" gap; it does not by itself close the
"shared process between sessions" one.

## What this does not cover

- **Zero-downtime deploys / rolling restarts** - out of scope, not
  attempted here.
- **Health-check-driven restarts** (restarting a process that's technically
  still running but stuck) - `GET /healthz` exists and returns `200
  {"status":"ok"}` for this purpose, but wiring it into a supervisor's
  health-check mechanism (systemd's `WatchdogSec`, Docker's `HEALTHCHECK`,
  a Kubernetes liveness probe) is left to whoever operates a given
  deployment, matching Glass's own stated refusal to be an opinionated
  hosted platform.
