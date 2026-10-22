# Deployment

Running Glass anywhere other than your own laptop. The short version:

1. Run the Docker image with an API token, a restart policy and enough
   shared memory.
2. Open TCP 8080 (or your TLS port) **and UDP 50000**.
3. Put TLS in front if any HTTPS page will talk to Glass.
4. Add TURN if viewers or producers are on mobile or corporate networks.

## Docker

The image `ghcr.io/majorbeard/glass` (linux/amd64 and linux/arm64) contains
the engine, the video and audio encoders, and the system libraries Chrome
needs. Chrome itself and Cisco's OpenH264 library are downloaded by each
container at start (below). It runs as an unprivileged user with an init
process that reaps Chrome's child processes.

```sh
docker run -d --name glass \
  --restart unless-stopped \
  --shm-size=2g \
  -p 8080:8080 \
  -p 50000:50000/udp \
  -v glass-cache:/home/glass/.cache/glass \
  --env-file /etc/glass/env \
  ghcr.io/majorbeard/glass:<version>
```

with `/etc/glass/env` (mode `0600`):

```sh
GLASS_API_TOKEN=<openssl rand -hex 32>
GLASS_LICENSE_KEY=<your license key, if any>
```

Or with Compose:

```yaml
services:
  glass:
    image: ghcr.io/majorbeard/glass:<version>
    restart: unless-stopped
    shm_size: "2gb"
    ports:
      - "8080:8080"
      - "50000:50000/udp"
    volumes:
      - glass-cache:/home/glass/.cache/glass
    env_file: /etc/glass/env
volumes:
  glass-cache:
```

- **Downloads at start.** A container downloads what the image does not
  ship, directly from the publisher, into `/home/glass/.cache/glass`:
  - Google's Chrome for Testing, at the version the image pins, from
    `storage.googleapis.com`, under
    [Google's terms](https://www.google.com/chrome/terms/): the full
    browser (about 190 MB), which every capture method but the screencast
    draws with, and the headless browser (about 120 MB) only with
    `GLASS_CAPTURE=screencast`. The full browser's Widevine module is
    removed, so DRM-protected video does not play.
  - On an NVIDIA GPU host, NVIDIA's X driver modules for the host's own
    driver version, for the `nvidia` capture method: taken from the
    driver's installer on NVIDIA's download site (about 380 MB, once per
    driver version; `GLASS_NVIDIA_XORG_FETCH=off` to mount your own instead). If
    they can't be had, Glass uses its other capture methods.
  - Cisco's OpenH264 library from `ciscobinary.openh264.org`, as Cisco's
    licensing of that binary requires (not with `GLASS_OPENH264_MODE=off`).

  Every download is checked against checksums the image carries, and every
  start checks the cached Chrome file by file against the image's record of
  it; anything that differs is downloaded again. With the `glass-cache`
  volume a host downloads each version once (the first start takes about
  half a minute longer on a fast link); without it, every new container
  downloads again. A host whose network comes up late is retried for about
  six minutes before the container gives up.
- **No internet at start.** Fill the cache volume on a host that can reach
  Google and Cisco, then use that volume (or a copy of it) on the host that
  can't:

  ```sh
  docker run --rm -v glass-cache:/home/glass/.cache/glass ghcr.io/majorbeard/glass:<version> download
  ```

  `download` fetches both Chrome builds and OpenH264, then exits. Or set
  `GLASS_CHROME_BIN` to a Chrome you provide; nothing is downloaded for it.
- **License check at startup.** If the license server can't be reached when
  the container starts, Glass retries for about 30 s, then keeps the tier it
  last validated (up to 7 days old) from `GLASS_LICENSE_CACHE_PATH`, which by
  default is in the same cache folder. The `glass-cache` volume therefore
  also carries a paid tier across re-creating the container during an outage.
- **Pin a version** in production rather than `latest`.
- **`--shm-size` matters.** Docker's default 64 MB of shared memory is far too
  little for Chrome: video-heavy pages crash the browser a few seconds in.
  Allow about 200 MB per concurrent busy browser session (`2g` for 8). Relay
  and call sessions don't need it.
- **Stopping.** Glass drains within 8 s of `SIGTERM` (Docker waits 10 s by
  default), closing sessions and browsers cleanly.
- **Health checks.** `/healthz` is liveness; `/readyz` is readiness (it
  returns `503` until a browser answers). The image's own health check uses
  `/readyz`, and counts failures only after a 15-minute start period, to
  allow for a first start's downloads on a slow link; it reports healthy as
  soon as a check passes.
- **Third-party notices** are in the image at
  `/usr/share/doc/glass/THIRD_PARTY_NOTICES`, which says where each one is.
- **Upgrading.** Pull the new tag and recreate the container with the same
  environment. Recreate, don't restart, after changing environment variables.

### GPU hosts

On a host with an NVIDIA GPU, give the container the GPU and NVIDIA's
capture and encoding libraries:

```sh
docker run -d --name glass --gpus all -e NVIDIA_DRIVER_CAPABILITIES=all   --restart unless-stopped --shm-size=2g -p 8080:8080 -p 50000:50000/udp   -v glass-cache:/home/glass/.cache/glass --env-file /etc/glass/env   ghcr.io/majorbeard/glass:<version>
```

Nothing else is needed: with `GLASS_CAPTURE` unset, Glass picks the `nvidia`
capture method, Chrome draws on the GPU, and the GPU encodes every session.
`glass doctor` (`docker exec glass docker-entrypoint.sh doctor`) shows the
method chosen and why any above it was refused. See
[sources/browser.md](sources/browser.md#how-the-picture-is-captured).

## Authentication

Without `GLASS_API_TOKEN`, anyone who can reach the port can start browsers
and browse the internet from your server. So **Glass refuses to start** when
no token is set and it listens on anything other than loopback. The ways out:

| Setting | When |
|---|---|
| `GLASS_API_TOKEN=<random>` | Always, for anything reachable from another machine. |
| `GLASS_ADDR=127.0.0.1:8080` | Binary install, local use only. |
| `-p 127.0.0.1:8080:8080` plus `GLASS_INSECURE_LOCAL_DEV=true` | Docker, local use only. Inside the container Glass must listen on all interfaces; the `-p` binding keeps it local. |

`GLASS_API_TOKEN` and `GLASS_LICENSE_KEY` are unrelated secrets. Never use
one as the other: a license key gets pasted into support tickets and
screenshots, and the API token grants full control of your instance.

Keep the API token on your backend. Clients get only the per-session URLs
Glass returns ([concepts.md](concepts.md#tokens-in-urls)).

## Ports

| Traffic | Port | |
|---|---|---|
| HTTP API and signaling | TCP 8080 (`GLASS_ADDR`) | Or 443 through a TLS proxy. |
| WebRTC media and data | **UDP 50000** (`GLASS_WEBRTC_UDP_PORT`) | Every peer connection shares this one port. |

Opening only the TCP port is the most common mistake: signaling works, and
the connection then hangs at ICE `checking` forever. Open UDP 50000 in
Docker (`-p 50000:50000/udp`), the host firewall **and** the cloud security
group.

`GLASS_WEBRTC_UDP_PORT_MIN`/`_MAX` (a port per connection) are deprecated.
They still work when set on their own, and they cap a host at about as many
connections as ports. Existing firewall rules for `50000-50100/udp` keep
working, because they include 50000.

## Public address and NAT

Clients must be able to reach the address Glass advertises. At startup Glass
asks its STUN server for the host's public address and advertises it on the
shared UDP port. Look for one of these lines in the log:

```text
[WebRTC] Public address 203.0.113.10 discovered via STUN; advertised on the shared UDP port …
[WebRTC] Public address: this host's own address is public; no extra candidate needed
[WebRTC] Public address discovery failed (…); only local host candidates are advertised …
```

That covers a cloud VM, with or without Docker, as long as a port forward
keeps the port number (`-p 50000:50000/udp`). Set the address yourself with
`GLASS_WEBRTC_NAT_1TO1_IPS` when:

- discovery failed (no STUN server reachable);
- the forward changes the port number;
- clients reach Glass on an address other than the public one. Examples:
  `127.0.0.1` for Docker Desktop on your own machine, or the host's LAN IP
  for a phone on the same Wi-Fi.

```sh
GLASS_WEBRTC_NAT_1TO1_IPS=203.0.113.10      # comma-separated for several
```

On a cloud host, give the machine a fixed public IP (an AWS Elastic IP, for
example). Otherwise a stop and start changes it, and everything tied to the
old one (DNS, the TLS certificate, this setting, your frontend's configuration)
breaks at once.

## TURN

STUN finds a direct path through most home routers. It can't get through
symmetric NAT (common on mobile carriers) or firewalls that block UDP. For
those clients, a TURN server relays the traffic. If your users are on phones
or corporate networks, you need one.

Configure it for Glass:

```sh
GLASS_TURN_URLS=turn:turn.example.com:3478,turns:turn.example.com:5349
GLASS_TURN_USERNAME=glass
GLASS_TURN_CREDENTIAL=<password>
```

and pass the same servers to your clients (`iceServers` in `GlassClient`,
`GlassProducer` and your call peers). Both ends of a connection may need it.

**Self-hosting with [coturn](https://github.com/coturn/coturn)** is the usual
choice. Install the distribution package (`apt-get install coturn`) and set
`/etc/turnserver.conf`:

```ini
listening-port=3478
tls-listening-port=5349
realm=turn.example.com
user=glass:<password>
min-port=49152
max-port=65535
# Behind cloud NAT (EC2 and similar), also:
external-ip=<public-ip>/<private-ip>
listening-ip=<private-ip>
relay-ip=<private-ip>
```

Open UDP and TCP 3478, TCP 5349, and UDP 49152–65535. Without `external-ip`
on a cloud host, allocation succeeds but relayed media never arrives.

Managed TURN (Cloudflare, Twilio, Xirsys) also works. Free public TURN
services are rate-limited or time-limited: some cut connections after a few
minutes. They're fine for a smoke test, not for users.

## TLS

Glass speaks plain HTTP and WebSocket. A page served over HTTPS can't talk
to it (browsers block mixed content), so put a reverse proxy in front.
[Caddy](https://caddyserver.com) gets and renews certificates by itself:

```text
# /etc/caddy/Caddyfile
glass.example.com {
    reverse_proxy localhost:8080
}
```

Open TCP 80 and 443. Media still goes directly to UDP 50000; the proxy only
carries HTTP and signaling. Glass returns `wss://` URLs when the proxy sets
`X-Forwarded-Proto: https` (Caddy does).

No domain? `203-0-113-10.nip.io` resolves to `203.0.113.10` and works with
Caddy's automatic certificates. Let's Encrypt refuses certificates for
`*.amazonaws.com` hostnames.

### Proxies and client addresses

Glass rate-limits per client address. Behind a proxy, it trusts
`X-Forwarded-For` only from trusted proxies: loopback by default, which fits
Caddy on the same host. For a proxy or load balancer on another machine, list
the address Glass sees it connect from (inside a VPC, its **private** address
or subnet):

```sh
GLASS_TRUSTED_PROXIES=127.0.0.1,::1,10.0.1.0/24
```

Setting it replaces the default. If every client seems to share one rate
limit, this is usually what's missing; Glass logs a warning naming the
untrusted peer.

### The address viewers are given

Creating a session returns a `signalingUrl` for the viewer to connect to.
Glass builds it from, in order:

1. `GLASS_PUBLIC_URL`, when set, for example
   `GLASS_PUBLIC_URL=https://glass.example.com`. Only its scheme and host
   are used (`https` gives `wss://`): clients reach the whole API at that
   origin.
2. `X-Forwarded-Host`, when the request came through a trusted proxy (above).
3. The request's own `Host`.

A proxy that keeps the original `Host`, as Caddy's `reverse_proxy` does,
needs neither. Set `GLASS_PUBLIC_URL` behind a proxy that rewrites `Host` to
its own upstream address, such as a hosting provider's built-in HTTPS
proxy. The sign that you need it: sessions are created, but viewers never
connect, and the `signalingUrl` names an internal address.

## Allowing your frontend (CORS)

Glass accepts browser requests and WebSockets from loopback and private-network
origins by default. For a frontend on a public origin, list it exactly
(scheme, host, port, no trailing slash, no wildcards):

```sh
GLASS_CORS_ORIGINS=https://app.example.com
```

## Security posture

- **Egress filter** (on by default): browsers can't reach loopback, private or
  link-local addresses, including cloud metadata endpoints. Every connection a
  page makes is checked, not only navigations, and the resolved address is
  pinned, which defeats DNS rebinding. Only disable it
  (`GLASS_EGRESS_FILTER=false`) if sessions must reach internal services on
  purpose.
- **Chrome sandbox.** Active in the official image, which runs as a non-root
  user; the log says `Chrome sandbox active`. If you build your own image,
  don't run Glass as root: Chrome's sandbox can't start under root, and Glass
  then runs without it and logs a loud warning.
- **Threat model.** Each session has its own Chrome process while it runs and
  its own storage, but Chrome processes are reused by later sessions. Chrome's
  sandbox is what stops a compromised page from persisting into the next
  session on that process, or reaching the host. That fits a deployment whose
  users you trust, or a single operator. For untrusted users who must not
  affect each other, run separate Glass instances (or containers) per trust
  boundary.
- **Logs** contain no user content: no typed text, no clipboard, no page paths
  or queries (origins only), no file names, no tokens. Client IP addresses
  appear only as a short salted hash that changes per process run.

## The `glass` CLI

Glass ships only as the Docker image; the `glass` command is inside it.
`glass doctor` checks the environment and says what is missing, and
`glass doctor --env` lists every setting with its current value and default
(see [configuration.md](configuration.md)):

```sh
docker run --rm --env-file /etc/glass/env ghcr.io/majorbeard/glass doctor --env
docker exec glass docker-entrypoint.sh doctor   # inside a running container
```
