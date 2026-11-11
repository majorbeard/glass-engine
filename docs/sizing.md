# Sizing

How much machine Glass needs depends almost entirely on which sources you
run. A hosted browser renders and encodes video, and costs real CPU for as long
as its page changes. Relay streams and calls are forwarded without decoding,
so they cost little CPU; your network's upload capacity usually runs out first.

The numbers below were measured on AWS Graviton instances (c6g, c7g). Use
them to pick a starting point, then measure your own workload.

## Hosted browser sessions

Each browser session runs Chrome plus a video encoder. On a heavy, ad-dense
news site, the CPU split was **Chrome 81%, encoder 15%, the Glass engine 4%**.

| Resource | Budget per busy session |
|---|---|
| CPU | Varies with the page. A single session on a heavy page can use most of a core for Chrome, plus 0.3–0.8 of a core for the encoder. Static or idle pages use very little: a page that stops painting stops costing CPU. |
| Memory | About 500 MB a session on an animated page with a display (the full Chrome and its display), about 300 MB with `GLASS_CAPTURE=screencast` (the headless browser). Measured as proportional set size, which counts shared pages once. |
| Shared memory (`--shm-size`) | About 200 MB. Chrome keeps scratch files there. |
| Disk | Downloads and uploads are buffered on disk (up to 500 MB per file) and removed when the session ends. A page's download is canceled while it runs past 500 MB, or when under 512 MB is left where it is written (`/tmp` in the hardened run); a session keeps at most five downloads running or waiting to be saved, and five saved ones, each for 10 minutes. |

- **Start at 4 vCPU** (for example AWS `c6g.xlarge`) for a handful of
  concurrent sessions. At 2 vCPU a single session on a heavy page can starve
  the encoder, and the stream freezes.
- **Avoid burstable instances** (AWS T-series and equivalents). Sustained
  encoding drains CPU credits, and the instance throttles mid-session.
- **Size for your heaviest page,** not your average one.
- **Memory or CPU.** A display costs about 200 MB more a session than the
  screencast, and about half the CPU for capture and encoding. On a host
  short of memory, `GLASS_CAPTURE=screencast` trades the one for the other.
- **NVIDIA GPU hosts.** Run with `--gpus all -e NVIDIA_DRIVER_CAPABILITIES=all`
  ([deployment.md](deployment.md#gpu-hosts)): Chrome draws on the GPU and the
  GPU encodes, so a session's own CPU is mostly Chrome's page work (scripts,
  layout). WebGL pages gain the most.

## Relay streams and calls

The engine forwards packets and doesn't decode them. Measured on 8 vCPU (c7g.2xlarge):

| Resource | Cost |
|---|---|
| CPU | About **4–5 millicores per stream-to-viewer** at 30 fps and 1 Mbit/s: 800 simultaneous viewers of streams used about 3.5 of 8 cores. It grows linearly. Under heavy other load, expect up to about 15 millicores. |
| Memory | A few MB per stream-to-viewer, mostly the retransmission buffer. |
| Network | Upload = stream bitrate × viewers. Ten viewers of a 2 Mbit/s stream need 20 Mbit/s out of the host. |

In practice, **upload bandwidth is the limit** for relay deployments. A 1 Gbit/s
link carries about 500 viewers at 2 Mbit/s, at a fraction of a small
instance's CPU.

## Viewers through the built-in TURN relay

With `GLASS_TURN=embedded` ([deployment.md](deployment.md#turn)), a viewer
that can't reach UDP 50000 directly is relayed by Glass itself. Measured on
AWS c6g (Graviton, arm64), viewers of one hosted browser session at about
1.2 Mbit/s each, from 1 to 8 viewers:

| Resource | Cost |
|---|---|
| CPU, a direct viewer | About **12 millicores** a viewer of a shared session, beside the session's own encoding (about 0.67 of a core on a moving page). |
| CPU, relaying | About **6–8 millicores per relayed Mbit/s** on top, over UDP, TCP and TLS alike: 130 to 160 Mbit/s a core. Over TLS, Glass's own TLS adds about 4 millicores per Mbit/s more. |
| CPU, the relay unused | None measurable. |
| Memory | About 2 MB for the relay's own process, beyond what it shares with the engine; about 9 KB per relay a client holds open. |
| Network | The same as a direct viewer: the relay hands each packet to Glass inside the host, so a relayed viewer crosses the host's link once. |

The encoder leads: relaying a viewer costs a few percent of encoding the
session it watches. Past 8 viewers the figures are extrapolated; measure your
own.

## Glass's relay on its own host

`glass turn` ([deployment.md](deployment.md#glasss-relay-on-its-own-host)),
measured on AWS c6i.xlarge (x86), relaying 1 to 8 viewers over UDP at about
1.1 Mbit/s each:

| Resource | Cost |
|---|---|
| CPU | About **5.5–7.5 millicores per relayed Mbit/s**, falling as viewers are added. |
| Memory | About 26 MB for the process, plus about 9 KB per relay a client holds open. |
| Network | Each relayed viewer crosses the relay's link twice, in from the engine and out to the viewer. |

Past 8 viewers the figures are extrapolated; measure your own.

## Connections and idle sessions

Signaling connections and sessions that aren't streaming are cheap: about
0.1 millicores and 0.3 MB each. In a load test, one 8-vCPU, 15 GB instance
held 40,000 sessions, and memory was the soft limit. License limits (at most
50 sessions per process, 50 viewers per session by default) keep real
deployments far below that.

## Memory limit: `GLASS_GOMEMLIMIT_MB`

The engine's memory manager leaves generous headroom between collections. At
high connection counts, process memory can grow to two to four times the
live data unless a limit is set. Set `GLASS_GOMEMLIMIT_MB` to the memory you
want the **engine** to stay under:

- Container or host memory,
- minus Chrome's own memory for your browser sessions (measure it with your
  pages; heavy sites use far more than simple ones),
- minus shared memory (`--shm-size` is RAM),
- minus a margin for the OS.

For example, on a 16 GB relay-only host, `GLASS_GOMEMLIMIT_MB=12000`. It's a
soft limit: the engine collects garbage harder as it approaches it, and it
doesn't refuse work.

## Admission under load

Glass protects the host itself. A new browser session is admitted only while
host CPU is below 85% (`GLASS_HARD_CAP_CPU_THRESHOLD_PERCENT`). Each new session
reserves a core's worth of headroom until its own load shows, so a burst of
requests can't oversubscribe the host. Refused sessions get `503` after a
short wait. The check reads the container's CPU limit (`--cpus`), not the
host's core count.

Turning it off (`GLASS_HARD_CAP_CPU_THRESHOLD_PERCENT=0`) admits sessions up
to the license limit regardless of load. Nothing crashes, but on an
overloaded host the last session to arrive can take tens of seconds to show a
picture.

## Keep a reserve for floods

When Glass serves TLS itself and runs its embedded relay, it is the first thing
a stranger's traffic reaches. Its limits hold, and refusing costs CPU the
encoders then don't have. What a flood can take is bounded, and this is what it
measured, on AWS c6g (Graviton, arm64), from the engine's own work:

| Flood | Cost |
|---|---|
| UDP packets at the relay | About 5 µs a packet; about one core at 200,000 packets a second, where its read loop tops out |
| New TLS connections | About 1.1 ms a handshake; about 1.1 cores at the engine's limit of 1,000 new connections a second |
| Idle connections held open | About 50 KB of memory each with TLS, about 10 KB without; at most 8,192 a process, fewer under a low descriptor limit |
| Relay allocations | About 9 KB each, at most 2,000 |

**On a host running both, keep about 2 cores spare** for a flood of each at
once. On x86 the same work took about half the time. These figures leave out the
kernel's own work on the packets, so the reserve is a minimum. [Monitoring](monitoring.md)
shows when a flood is drawing on it.

## Other host requirements

- **Disk:** leave room for at least two image versions (about 1.1 GB each)
  when upgrading. 20 GB or more is comfortable.
- **`/tmp` must allow executables.** A `noexec` `/tmp` stops browsers from
  launching; with Docker's `--tmpfs`, use `--tmpfs /tmp:exec`.
- **Cloud IP addresses:** see [sources/browser.md](sources/browser.md#limits-worth-knowing).
- **`/readyz`** reports free disk and shared memory, and Glass logs a warning
  when either runs low.
