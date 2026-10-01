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
| Shared memory (`--shm-size`) | About 200 MB. Chrome keeps scratch files there. |
| Disk | Downloads and uploads are buffered on disk (up to 500 MB per file) and removed when the session ends. |

- **Start at 4 vCPU** (for example AWS `c6g.xlarge`) for a handful of
  concurrent sessions. At 2 vCPU a single session on a heavy page can starve
  the encoder, and the stream freezes.
- **Avoid burstable instances** (AWS T-series and equivalents). Sustained
  encoding drains CPU credits, and the instance throttles mid-session.
- **Size for your heaviest page,** not your average one.
- **GPU encoding.** On an NVIDIA GPU host, the image's NVENC encoder moves
  encoding off the CPU: run with `--gpus all -e NVIDIA_DRIVER_CAPABILITIES=all`
  and set `GLASS_NVENC_SHIM_MAX_SESSIONS`. Chrome's own rendering stays on the
  CPU unless Chrome itself has GPU access.

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

## Other host requirements

- **Disk:** leave room for at least two image versions (about 1.1 GB each)
  when upgrading. 20 GB or more is comfortable.
- **`/tmp` must allow executables.** A `noexec` `/tmp` stops browsers from
  launching; with Docker's `--tmpfs`, use `--tmpfs /tmp:exec`.
- **Cloud IP addresses:** see [sources/browser.md](sources/browser.md#limits-worth-knowing).
- **`/readyz`** reports free disk and shared memory, and Glass logs a warning
  when either runs low.
