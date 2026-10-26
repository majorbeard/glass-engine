# Deployment

Running Glass anywhere other than your own laptop. The short version:

1. Run the Docker image with an API token, Glass's seccomp profile (Chrome's
   sandbox needs it), a restart policy and enough shared memory, its API
   bound to this host only.
2. Put a TLS proxy in front, and open **TCP 443** (and 80, for the
   certificate) **and UDP 50000**, nothing else (see [Ports](#ports)).
3. Add TURN if viewers or producers are on mobile or corporate networks.

## Docker

The image `ghcr.io/majorbeard/glass` (linux/amd64 and linux/arm64) contains
the engine, the video and audio encoders, and the system libraries Chrome
needs. Chrome itself and Cisco's OpenH264 library are downloaded by each
container at start (below). It runs as an unprivileged user with an init
process that reaps Chrome's child processes.

```sh
docker run --rm ghcr.io/majorbeard/glass:<version> seccomp-profile > /etc/glass/seccomp.json

docker run -d --name glass \
  --restart unless-stopped \
  --security-opt seccomp=/etc/glass/seccomp.json \
  --security-opt no-new-privileges \
  --cap-drop=ALL --cap-add=SYS_CHROOT \
  --read-only \
  --tmpfs /tmp:rw,exec,nosuid,nodev,size=2g \
  --tmpfs /home/glass/.config:rw,nosuid,nodev,size=64m \
  --tmpfs /home/glass/.local:rw,nosuid,nodev,size=64m \
  --memory=6g --pids-limit=4096 \
  --shm-size=2g \
  -p 127.0.0.1:8080:8080 \
  -p 50000:50000/udp \
  -v glass-cache:/home/glass/.cache/glass \
  --env-file /etc/glass/env \
  ghcr.io/majorbeard/glass:<version>
```

The first command writes the seccomp profile Chrome's sandbox needs, from
the image itself (it downloads nothing). Without it, or with the
capabilities dropped further, Glass refuses to start: see
[Hardening](#hardening) for what each flag does.

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
    security_opt:
      - seccomp=/etc/glass/seccomp.json
      - no-new-privileges
    cap_drop: [ALL]
    cap_add: [SYS_CHROOT]
    read_only: true
    tmpfs:
      - /tmp:rw,exec,nosuid,nodev,size=2g
      - /home/glass/.config:rw,nosuid,nodev,size=64m
      - /home/glass/.local:rw,nosuid,nodev,size=64m
    mem_limit: 6g
    pids_limit: 4096
    shm_size: "2gb"
    ports:
      - "127.0.0.1:8080:8080"
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
docker run -d --name glass --gpus all -e NVIDIA_DRIVER_CAPABILITIES=all   --restart unless-stopped --shm-size=2g -p 127.0.0.1:8080:8080 -p 50000:50000/udp   -v glass-cache:/home/glass/.cache/glass --env-file /etc/glass/env   ghcr.io/majorbeard/glass:<version>
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
Glass returns ([concepts.md](concepts.md#tokens-in-urls)). For a browser
that should start its own session, give it a
[session ticket](protocol.md#session-tickets) your backend signed
(`GLASS_TICKET_SECRET`), never the token.

**Rotating the token.** `GLASS_API_TOKEN` takes a comma-separated list, and
every listed token works: put the new one first, keep the old one after
it, move your backend over, then remove the old one. Glass logs, at most
hourly, when a token other than the first is still in use (by its position
in the list, never its value), so you can see when the old one stops being
used. `GLASS_TICKET_SECRET` rotates the same way.

When a secret or a link leaks, follow
[incident-response.md](incident-response.md); it also suggests a rotation
schedule.

## Ports

Open these to the internet, and nothing else:

| Traffic | Port | |
|---|---|---|
| HTTPS API and signaling | **TCP 443**, on the TLS proxy ([TLS](#tls)) | Plus TCP 80 if the proxy gets its certificate by HTTP (Caddy does). |
| WebRTC media and data | **UDP 50000** (`GLASS_WEBRTC_UDP_PORT`) | Every peer connection shares this one port. |
| TURN, if you run it on this host | UDP and TCP 3478, TCP 5349, UDP 49152–65535 | See [TURN](#turn). |

Glass's own HTTP port (TCP 8080, `GLASS_ADDR`) stays on this host:
`-p 127.0.0.1:8080:8080`, so only the proxy reaches it. Never open it to
the internet: it is plain HTTP, and session links carry their token in the
URL, so anyone on the path could read and reuse them. On a private network
with no proxy, publish it to that network only (`-p <private-ip>:8080:8080`)
and keep it off the internet in the firewall and the cloud security group.

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

Configure it for Glass with a secret shared with the TURN server:

```sh
GLASS_TURN_URLS=turn:turn.example.com:3478,turns:turn.example.com:5349
GLASS_TURN_SECRET=<openssl rand -hex 32>
```

Glass then issues every connection its own TURN credential, valid 24 hours
(`GLASS_TURN_CREDENTIAL_TTL_HOURS`), and sends it to the client as the first
message on the signaling connection (`ice_config`). `@glass/client` uses it
on its own: there is nothing to pass to `GlassClient` or `GlassProducer`. A
reconnect gets a fresh credential. A credential still lets its holder use
your TURN server as a relay until it expires, so keep the relay out of your
own network (the `denied-peer-ip` lines below).

`GLASS_TURN_USERNAME` and `GLASS_TURN_CREDENTIAL` still work for Glass's own
side, but Glass never hands them to clients; set `GLASS_TURN_SECRET` for
clients behind strict networks.

**Self-hosting with [coturn](https://github.com/coturn/coturn)** is the usual
choice. Install the distribution package (`apt-get install coturn`) and set
`/etc/turnserver.conf`:

```ini
listening-port=3478
tls-listening-port=5349
realm=turn.example.com
# Credentials issued by Glass; the secret lives in coturn's database
# (turnadmin -s, below), so it can be rotated without a restart.
use-auth-secret
min-port=49152
max-port=65535
# Behind cloud NAT (EC2 and similar), also:
external-ip=<public-ip>/<private-ip>
listening-ip=<private-ip>
relay-ip=<private-ip>

# Relay to the internet only, never into this host's own networks
# (coturn relays to private and link-local addresses unless told not to):
no-multicast-peers
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.0.0.0-192.0.0.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=198.18.0.0-198.19.255.255
denied-peer-ip=::1
denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff
# Glass on the same private network, reached at its private address:
# allow that one address (an allowed address wins over a denied range).
# allowed-peer-ip=<glass-private-ip>
```

Then store the secret, the same one as `GLASS_TURN_SECRET`:

```sh
sudo turnadmin -s <secret> -r turn.example.com
```

To rotate it: add the new secret (`turnadmin -s <new> -r …`), switch
`GLASS_TURN_SECRET` to it and recreate the container, wait out
`GLASS_TURN_CREDENTIAL_TTL_HOURS`, then delete the old one
(`turnadmin --delete-secret=<old> -r …`). coturn needs no restart, and
connections relayed with the old secret keep working until their
credentials expire. (`static-auth-secret=<secret>` in the config file also
works, but then a rotation restarts coturn.)

`169.254.0.0/16` holds cloud metadata services
(`169.254.169.254`): without these lines, anyone with the credential could
relay to them, and to every other private address the TURN host can reach.

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

Open TCP 80 and 443, and keep Glass's port 8080 on the host
(`-p 127.0.0.1:8080:8080`, as above): the proxy is the only way in. Media
still goes directly to UDP 50000; the proxy only carries HTTP and
signaling. Glass returns `wss://` URLs when the proxy sets
`X-Forwarded-Proto: https` (Caddy does).

No domain? `203-0-113-10.nip.io` resolves to `203.0.113.10` and works with
Caddy's automatic certificates. Let's Encrypt refuses certificates for
`*.amazonaws.com` hostnames.

### Proxies and client addresses

Glass rate-limits per client address. Behind a proxy, it trusts
`X-Forwarded-For` only from trusted proxies: loopback by default. With Glass
in Docker and Caddy on the host, Glass sees the proxy connect from Docker's
bridge gateway, not loopback: trust that address (usually `172.17.0.1`;
`docker network inspect bridge` shows it):

```sh
GLASS_TRUSTED_PROXIES=172.17.0.1
```

For a proxy or load balancer on another machine, list the address Glass sees
it connect from (inside a VPC, its **private** address or subnet):

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
- **Chrome sandbox.** On when the container runs with Glass's seccomp
  profile, as above; the log says `Chrome sandbox active`, and
  `glass doctor` checks it. Where it cannot start (no profile, capabilities
  dropped further, running as root), Glass refuses to start unless you set
  `GLASS_ALLOW_NO_SANDBOX=true`, which runs Chrome without it. Images before
  v0.1.93 ran Chrome without its sandbox in every container, while logging
  that it was active: upgrade, and add the profile.
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

## Hardening

What the `docker run` above does, measured with real sessions on a
CPU host (arm64, Ubuntu, Docker 29):

| Flag | Why |
|---|---|
| `--security-opt seccomp=/etc/glass/seccomp.json` | Docker's default seccomp profile plus one rule: `clone` and `unshare`, which Chrome's sandbox needs to give each renderer its own user, pid and network namespaces. Docker's default allows them only with `CAP_SYS_ADMIN`, which this avoids. `glass seccomp-profile` prints it; regenerate it when you update the image. |
| `--cap-drop=ALL --cap-add=SYS_CHROOT` | No Linux capabilities but the one the sandbox needs. |
| `--security-opt no-new-privileges` | Nothing in the container can gain privileges (setuid binaries included). |
| `--read-only` and the three `--tmpfs` | The image can't be changed by anything running in it. `/tmp` must allow `exec`: Glass runs a small helper from there. Chrome's downloads stay in the `glass-cache` volume. |
| `--memory`, `--pids-limit` | A runaway page can't take the host down. Size `--memory` to the host: a session with a heavy page costs a few hundred MB. |

Don't add `--security-opt apparmor=unconfined`: on Ubuntu hosts that
restrict user namespaces, it stops Chrome's sandbox from starting.

**GPU hosts** (`--gpus`, the `nvidia` capture method): the capabilities and
the read-only root haven't been measured there yet. Start with the seccomp
profile and `no-new-privileges`, and check `glass doctor`.

**A dedicated network** (`docker network create --subnet 172.30.0.0/24
--gateway 172.30.0.1 glass-net`, then `--network glass-net`) keeps other
containers away from Glass. Requests from your proxy then arrive from that
network's gateway: set `GLASS_TRUSTED_PROXIES=172.30.0.1`, or every client
looks the same in the logs.

**The host:** keep it for Glass (and its proxy and TURN server), apply
security updates, and allow SSH by key only.

### Staying current

Glass renders untrusted pages, so an old Chrome is the largest risk on the
list; a new image comes at least every two weeks with Chrome's security
fixes. Two ways to take them:

- **Pin the digest** (`ghcr.io/majorbeard/glass@sha256:...`) and move it on
  a schedule: you choose when, and every host runs exactly what you
  tested.
- **Follow a tag with an updater:** pull the new image and recreate the
  container at a quiet hour, after waiting until
  `docker exec glass glass session list` shows no sessions. Recreating
  closes any left within Docker's stop timeout, and viewers see the
  session end. Regenerate the seccomp profile with each new image.

## The audit stream

Glass writes one line to its log for each thing you may need to account
for later, marked `[Audit]` so it can be filtered out of everything else:

```sh
docker logs glass 2>&1 | grep '\[Audit\]'
```

```text
[Audit] event=session.created session=4d82acf8-… kind=browser by=api client=ip-e1acb3ce link=d7a916a39018a209 expires=2026-10-27T13:40:16Z
[Audit] event=link.minted session=4d82acf8-… link=7ccc96e109d9b5cc caps=watch by=api client=ip-e1acb3ce expires=2026-10-27T13:40:16Z
[Audit] event=connection.joined session=4d82acf8-… connection=729ace33-… link=own caps=watch+input client=ip-e1acb3ce resumed=false
[Audit] event=link.revoked session=4d82acf8-… link=7ccc96e109d9b5cc closed=1 by=api client=ip-e1acb3ce
[Audit] event=auth.refused route="GET sessions" reason=bad-token client=ip-0b1c9a77
[Audit] event=session.closed session=4d82acf8-… kind=browser reason=api after=17s
```

| Event | Means |
|---|---|
| `session.created`, `session.closed` | A session (`kind`: browser, relay, call) started, by the API token or a ticket (`by`), or ended, with `reason`: `api`, `empty` (its last viewer left), `dropped`, `never-joined`, `grace-expired`, `setup-failed`, `shutdown`. |
| `link.minted`, `link.revoked` | A link was handed out, with what it may do (`caps`: `watch`, `input`, `produce`) and when it expires, or revoked, with how many connections it closed. |
| `connection.joined`, `connection.left` | A viewer or call peer joined (`resumed=true` after a drop) or left (`reason`: `left`, `dropped`, `revoked`). |
| `producer.started`, `producer.stopped` | A relay producer, by `slot`. |
| `control.granted`, `control.released`, `control.revoked` | Control of the page changed hands. |
| `auth.refused`, `link.refused`, `ticket.refused` | A request with no or a wrong API token, a link that expired, was revoked or used, a ticket refused. |
| `auth.retiring-token` | A token you are retiring was used (at most hourly). |
| `audit.suppressed` | More than 30 refusals of one kind in a minute: the rest are counted here. |

`link` is a link's ID, not the link (`own` for a session's own link,
`api` for the API token), and `client` is the salted hash above: the
stream holds no token and no URL. A steady rise in `*.refused` lines is
the one worth an alert: someone is trying tokens or links.

## The `glass` CLI

Glass ships only as the Docker image; the `glass` command is inside it.
`glass doctor` checks the environment and says what is missing, and
`glass doctor --env` lists every setting with its current value and default
(see [configuration.md](configuration.md)):

```sh
docker run --rm --env-file /etc/glass/env ghcr.io/majorbeard/glass doctor --env
docker exec glass docker-entrypoint.sh doctor   # inside a running container
docker run --rm ghcr.io/majorbeard/glass:<version> seccomp-profile   # the seccomp profile, see Hardening
```

`glass session` manages a running instance. Inside the container it sends
the container's own `GLASS_API_TOKEN` (the first, when several are listed);
elsewhere, set `GLASS_API_TOKEN` and pass `--addr`:

```sh
docker exec glass glass session list                  # running sessions, relay sessions and calls; no links
docker exec glass glass session get <id>
docker exec glass glass session close <id>
docker exec glass glass session revoke '<link URL>'   # end one link; its session goes on
docker exec glass glass session revoke --relay <id> <link id>
```
