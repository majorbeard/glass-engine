# Monitoring and attacks

Glass says what it is refusing and dropping, where, and who the refusals came
from, so you can tell an attack on your server from an attack on your app, and
either from one of your users at their limits. It reports and keeps its own
limits; it blocks no one beyond them. Stopping a flood that fills your link is
your network's or your provider's job.

Everything here is a kind, a count or a session ID: no client address, token,
credential, URL or content.

## Where to read it

| Where | What | For |
|---|---|---|
| `GET /v1/info`, `pressure` | Each part of the engine over the last minute: `normal`, `elevated` or `limiting`, and the counts behind it | A quick look, a health check |
| `GET /v1/metrics` | The same counts as Prometheus text, since the engine started | Your monitoring and alerting |
| A session's statistics, `cpuPressure` | Whether that session stepped down for CPU, and why | One session that looks slow |
| [The audit stream](deployment.md#the-audit-stream) | One line per refusal kind, with its reason | What happened, and when |

All of them take the API token.

## The monitoring port

A flood that fills the engine's public connections refuses your own reads of
`/v1/info` too, at the moment you want them. Give monitoring a port of its own:

```sh
docker run ... -e GLASS_MONITOR_ADDR=:9100 -p 10.0.0.5:9100:9100 ...
```

`GLASS_MONITOR_ADDR` opens a listener that answers `/healthz`, `/readyz`, and
`/v1/info` and `/v1/metrics` with the API token; everything else is `404`. It
has its own connection limit (64 in total, 16 from one address), apart from
the public ports, so a flood there can't keep you out, and one on it costs
little. Glass refuses to start with it set and no `GLASS_API_TOKEN`.

It is plain HTTP, and your token crosses it. **Publish it only on an address
your monitoring reaches and the internet doesn't**: a private address, as
above, or `127.0.0.1` for a scraper on the same host.

A Prometheus scrape:

```yaml
scrape_configs:
  - job_name: glass
    authorization:
      credentials_file: /etc/prometheus/glass-token   # the API token, and nothing else
    static_configs:
      - targets: ["10.0.0.5:9100"]
```

With TLS on in the engine itself, `GLASS_ADDR`'s port on the container's own
loopback answers the same two routes, for `docker exec` and health checks.

## Is my server being attacked?

Every refusal belongs to one of three stages of the engine, and the stage
answers the question:

| Question | What shows it | What to do |
|---|---|---|
| **Is my server being attacked?** Someone with no credential at all. | `pressure.stages.stranger` rising; `connections`, `tls`, `relay` or `mediaPort` past `normal`; audit lines `net.too-many-connections`, `tls.handshake-failed`, `turn.requests-limited` | Glass is holding its limits; its cost is in the [reserve](sizing.md#keep-a-reserve-for-floods). Block the sources in your firewall or at your provider, which sees the addresses. A flood that fills the link only the provider can stop. |
| **Is my app being attacked?** Valid credentials used at scale: someone is getting links or relay credentials from your app. | `pressure.stages.credential` rising; `relayAllocations` limiting; many `link.refused` or `ticket.refused`; `pressure.sessions` listing many sessions, or `unknown` | Find how they get them: who your app hands links to, and how often. If relay credentials are being forged, the TURN secret has leaked: replace it. With the embedded relay, recreating the container with a new `GLASS_TURN_SECRET` ends every relayed connection. See [incident response](incident-response.md). |
| **Is one of my users doing something?** One session at its own limits. | `pressure.stages.session`; `pressure.sessions` naming one session; audit `turn.credential-refused session=<id>` | Look at that session, and close it if you need to: `docker exec glass glass session close <id>`. |

Two signals aren't attacks at all:

- **`admission`** elevated or limiting: your host is busy. Sessions are
  stepping down for CPU, or being refused for capacity. See [sizing](sizing.md).
- **`descriptors`** elevated: the process is near its file-descriptor limit.
  Raise it (`--ulimit nofile=...`), or find what holds them.

## The summary: `pressure` in `/v1/info`

```json
"pressure": {
  "state": "limiting",
  "windowSeconds": 60,
  "stages": {"stranger": 5911},
  "surfaces": {
    "connections": {"state": "limiting", "refused": 5911, "open": 512, "max": 1536},
    "tls":         {"state": "normal", "failed": 0},
    "mediaPort":   {"state": "normal", "packetsPerSecond": 0, "explainedPerSecond": 20000},
    "api":         {"state": "normal", "refused": 0},
    "admission":   {"state": "normal", "refused": 0},
    "descriptors": {"state": "normal", "open": 44, "max": 2048},
    "relay":            {"state": "normal", "refused": 0, "dropped": 0},
    "relayAllocations": {"state": "normal", "refused": 0, "open": 0, "max": 2000}
  },
  "captureLevels": {"1": 3},
  "degraded": {"host-cpu": 1},
  "sessions": [{"id": "4d82acf8-…", "refused": 28}]
}
```

Counts are over `windowSeconds`, the last minute; until the engine has run a
minute, since it started. Figures with `open` and `max` are now.

| Surface | What it covers |
|---|---|
| `connections` | Connections on the public ports against their limits: per address, in total, and new ones a second |
| `tls` | TLS handshakes that failed, or never sent a byte |
| `mediaPort` | The shared UDP media port: packets a second against what its connections explain |
| `api` | Requests refused for a bad token, an unknown session or route, a refused link or ticket, or the rate limit |
| `admission` | Sessions refused for capacity, and sessions stepped down for CPU |
| `descriptors` | The process's file descriptors against its limit |
| `relay` | With the embedded relay: its UDP socket's drops (requests over its limits, junk), and refused credentials and peers |
| `relayAllocations` | With the embedded relay: allocations against its limits (12 per credential, 64 per client address, 2,000 in total) |

| State | When |
|---|---|
| `limiting` | A limit refused something in the window: connections, the relay's UDP limit, allocations, the API rate limit, or a session for capacity |
| `elevated` | A limit is 75% full or more (connections, allocations, descriptors); refusals no limit made (failed handshakes, bad tokens, junk) come at one a second or more; the media port receives far more than its connections explain; or a session has stepped down for CPU |
| `normal` | Otherwise. A few failed handshakes and bad tokens a minute are normal for any address on the internet. |

`state` is the worst surface's. `stages` counts the window's refusals by who
they came from: `stranger`, `credential`, `session`, `engine` (the relay's own
problems), and `unattributed` (the API rate limit, which goes by client address
on any route). `captureLevels` and `degraded` are sessions now, as in
[`cpuPressure`](#a-session-stepping-down-cpupressure). `sessions` lists up to
five sessions whose relay credentials were refused in the window, most first;
`unknown` stands for credentials this engine didn't hand out.

## Metrics: `GET /v1/metrics`

Prometheus text format. Counters run from the engine's start; gauges are now.
Labels take values from fixed lists only, never an address or a session ID.

| Metric | Type | Labels |
|---|---|---|
| `glass_refusals_total` | counter | `process` (engine, relay), `kind` (the audit event, with its reason where it has one), `stage` |
| `glass_session_refusals_total` | counter | `reason`: `at-capacity`, `cpu`, `memory`, `gpu`, `gpu-encoder`, `other` |
| `glass_pressure_level` | gauge | `surface`; 0 normal, 1 elevated, 2 limiting |
| `glass_media_port_packets_per_second`, `glass_media_port_explained_packets_per_second` | gauge | |
| `glass_sessions_by_capture_level` | gauge | `level`; 1 is full rate |
| `glass_sessions_degraded` | gauge | `reason` |
| `glass_connections`, `glass_connections_limit` | gauge | `process` |
| `glass_descriptors`, `glass_descriptors_limit` | gauge | `process` |
| `glass_relay_up`, `glass_relay_restarts_total`, `glass_relay_allocations`, `glass_relay_allocations_limit` | gauge, counter | with the embedded relay |
| `glass_relay_udp_dropped_total` | counter | `reason`: `over-limit`, `junk` |

Alerts worth having to start with:

```yaml
- alert: GlassLimiting
  expr: max(glass_pressure_level) == 2
  for: 2m
- alert: GlassRelayRestarting
  expr: increase(glass_relay_restarts_total[15m]) > 2
- alert: GlassStrangersRising
  expr: sum(rate(glass_refusals_total{stage="stranger"}[5m])) > 100
```

## A session stepping down: `cpuPressure`

A browser session's [statistics](protocol.md#session-statistics) carry
`cpuPressure`: how far it has stepped down to spare the host's CPU, and why.

| Field | Meaning |
|---|---|
| `captureLevel` | 1 captures every frame; each level above lowers the frame rate |
| `resolutionScale` | Percent of full size the picture is captured at |
| `reason` | What caused the last step down, while the session is below full: `host-cpu` (the host is busy, and this session's encoder is much of it), `encoder-saturated` (its encoder is busy nearly all the time), `encoder-backpressure` (its encoder falls behind and frames wait). Empty at full. |
| `changedAt` | When the level or scale last changed |

A viewer sees a lower frame rate; this says it was the engine's choice, and
why. Sessions step back up on their own when the pressure goes.

## The refusals in the audit stream

Besides the events in [the audit stream](deployment.md#the-audit-stream), these
are the refusals the summary counts. Each kind writes at most 30 lines a
minute; the rest are counted (`audit.suppressed`), and `/v1/metrics` counts
every one.

| Event | Fields | Means |
|---|---|---|
| `net.too-many-connections` | `limit client` | A connection past a limit, closed before TLS. `limit`: `client`, `total`, `new-client`, `new-total` |
| `net.accept-failed` | `kind` | The process couldn't accept a connection, as when it is out of descriptors |
| `tls.handshake-failed` | `kind client` | `kind`: `closed`, `timeout`, `unknown-name`, `old-client`, `not-tls`, `client-refused`, `other` |
| `tls.no-first-byte` | `client` | A TLS connection that sent nothing |
| `http.plain-request`, `http.unknown-route`, `http.no-session` | `route` | Plain HTTP on the TLS port; a path that doesn't exist; a session that doesn't |
| `rate.limited` | `route client` | The API's rate limit |
| `turn.auth-refused` | `reason method client` | A relay credential refused: `expired`, `malformed` or `wrong-key` |
| `turn.quota-refused` | `limit client` | An allocation past a limit: `credential`, `client`, `total` |
| `turn.requests-limited` | `dropped sources` | The relay's UDP limit, once a second with a count |
| `turn.no-allocation` | `client` | A relay connection that allocated nothing in 60 s |
| `turn.peer-refused` | `direction` | `out`: a client tried to relay somewhere other than Glass; `in`: packets at a relay socket from elsewhere |
| `turn.credential-refused` | `session kind count` | Refusals made with relay credentials handed out for `session`, every 5 s while there are any; `session=unknown` for credentials this engine didn't hand out |
| `turn.relay-exited`, `turn.relay-restarted` | `how`, `restarts` | The embedded relay's process ended, and was started again |
| `turn.relay-problem` | `scope what` | A warning from the relay, named without its values; most are ordinary endings |

`client` is the salted hash the audit stream always uses: it lets you follow
one client's lines within a run, and changes when the engine restarts.
