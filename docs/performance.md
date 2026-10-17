# Performance

What Glass does on real hardware, as measured. Every number here comes from
a run we did ourselves, and each section says when, on which version, on
what hardware, against what page, and how it was measured, so you can
judge it and repeat it. Where a result has a limit, the limit is next to it.

## At a glance

| What | Result | Where |
|---|---|---|
| The engine at scale | **40,000 sessions** on one 8-vCPU machine, no errors; **25,000 held for an hour** with 50 created and 50 closed every second, no leak | AWS c7g.2xlarge |
| Streaming cost of the engine | **3 to 5 millicores** per 30 fps stream, linear from 50 to 800 streams | AWS c7g.2xlarge |
| WebGL on a GPU | **43 fps at 1280x720** for one session, where software rendering manages 10 fps at 640x360 with the CPU full | RunPod A40 |
| GPU encoding | eight light sessions at **19% of the CPU quota instead of 31.5%** (NVENC instead of software H.264) | RunPod A40 |
| A click to the picture showing it | **159 to 188 ms** at the median from a 4-vCPU cloud machine to a PC on home 4G (95th percentile 188 to 245 ms), within about 30 ms of Chrome's own WebRTC sender | AWS c6g.xlarge |
| Sound against picture | phone on cellular: every tone within **-61 to +30 ms** of its picture (median -22 ms) | AWS c6g.xlarge |
| Start | container healthy **46 s** after a first start that downloads Chrome; **7 s** with the cache volume | AWS c6g.xlarge |

## The engine at scale (signaling, sessions, streaming)

**What this measures:** the engine itself, without Chrome or the encoder:
the HTTP API, sessions, admission, signaling WebSockets, WebRTC on the
shared UDP port, the pacer and bandwidth estimation, relay fan-out. A test
build replaces the browser and encoder with a source that sends a
pre-encoded H.264 loop at a set frame rate and bitrate, and a load
generator on a separate machine plays the viewers with real WebRTC peers.
The test build is never released; the shipped image can't run in that mode.

**Where:** AWS af-south-1, engine on a c7g.2xlarge (8 vCPU Graviton3, 15 GB usable),
load generator on a c6g.xlarge over the private network,
`GLASS_GOMEMLIMIT_MB=13000`. 2026-09-29 and 2026-09-30, the engine as
released in v0.1.47.

| Sessions held (signaling only), plus 200 streaming at 30 fps | Live | Offer, median / 99th percentile | Engine CPU (8 cores) | Memory (heap / process) |
|---|---|---|---|---|
| 10,000 | 10,000 | 35 / 159 ms | 1.9 cores | 2.6 / 6.0 GB |
| 20,000 | 20,000 | 41 / 89 ms | 2.9 cores | 3.7 / 9.6 GB |
| 30,000 | 30,000 | 58 / 322 ms | 4.0 cores | 7.6 / 12.5 GB |
| 40,000 | 40,000 | 219 / 1,532 ms | 5.2 cores | 7.0 / 12.6 GB |

- **40,000 sessions held with no errors, panics or fatal errors.** The load
  generator peaked at 79% of its CPU, so these are the engine's numbers.
  The 200 streams alongside kept 29.8 fps with 0.84% loss.
- **Memory is the ceiling on this machine,** not CPU: from 30,000 the
  process sat at its 13 GB limit and offer times stretched. Budget about
  0.3 MB per idle session.
- **One hour under churn:** 25,000 sessions held for 64 minutes while 0.2%
  were closed and replaced every second (about 190,000 session lifetimes),
  with 200 sessions streaming for the hour. No errors; threads, file
  descriptors and session counts flat throughout; offer median / 99th
  50 / 327 ms; the streams at 29.8 fps with 0.69% loss. After teardown the
  heap was back to 270 MB with 15 goroutines: no leak.
- **Streaming cost:** 3.2 to 4.7 millicores per stream at 30 fps and
  1 Mbit/s, flat from 50 to 800 streams on 2, 4 and 8 cores; 800 streams
  used 3.4 of 8 cores, all 800 connected, no loss.

**What it doesn't measure:** a real hosted browser costs far more than the
engine (below), so this is the ceiling of the engine, not of a machine full
of browsers. It shows what the relay and the control plane can carry, and
that the engine's own cost stays small and linear. License limits (50
concurrent sessions per process at most) keep real deployments far below
these counts.

## Hosted browsers on a CPU machine

**Where:** AWS af-south-1, c6g.xlarge (4 vCPU Graviton2, 8 GB), the Docker
image on its default settings. Viewers: a PC on a home 4G link and an
Android phone on cellular data, both in the same country as the machine,
running the reference viewer.

**Where the CPU goes,** a news site, 6 sessions on the 8-vCPU c7g.2xlarge
above (v0.1.46): Chrome 81%, the encoder 15%, the Glass engine 4%. Chrome is most of a hosted
browser's cost, and the page decides how much: see [sizing.md](sizing.md).

**The picture held** (v0.1.67, 2026-10-14, three-minute runs): 1280x720 at
30 fps throughout every run, every frame encoded after the first seconds,
no gap in the picture longer than 0.3 s in the first 30 seconds, on the
phone and the PC.

**A click to the frame that shows it** (two sittings, v0.1.65 and v0.1.66,
2026-10-13, three-minute runs, Glass and the reference alternating):
the viewer page clicks, and the remote page draws a mark that the viewer
reads from the video, so this is the whole loop: input, network, Chrome,
capture, encode, network, decode, display. Median / 95th percentile:

| Device, link | Glass | Chrome's own WebRTC sender, same page and machine |
|---|---|---|
| PC, home 4G (round trip about 21 ms) | 159 to 188 / 188 to 245 ms | 138 to 200 / 514 to 1,491 ms |
| Phone, cellular | 193 to 261 / 222 to 414 ms | 207 to 349 / 726 to 1,660 ms |

One more PC run, on a 115 ms round trip that moment, gave Glass 207 / 361 ms.

- **On medians Glass is within about 30 ms of Chrome's own WebRTC sender**
  streaming the same page from the same machine, run for run. Glass's
  input goes through a real browser's input pipeline; the reference sender
  puts its input straight into the page's script.
- **Glass's tail stayed short where the reference's did not** (95th
  percentile 188 to 414 ms against 514 to 1,660). The runs alternated on
  links that moved, so the tails are not a same-link comparison; but Glass
  held through runs with a weak link and with 0.5% loss.
- **On a calm phone link** (round trip 9 ms) a click took 241 ms at 1280x720
  and 30 fps, and 193 ms with the `motion` content hint (about 60 fps at
  896x504), against 136 ms for the reference sender at 60 fps. The
  difference is mostly the frame rate, the encoder and the phone's decoder;
  [sources/browser.md](sources/browser.md#creating-a-session) explains the
  hint.

**Sound against picture** (v0.1.69, 2026-10-15): a page plays a tone and
flashes at the same moment; the viewer records when each arrives. On the
phone over cellular, all nine tones were within -61 to +30 ms of their
picture (median -22 ms: the sound slightly ahead). On the PC over the home
4G link, with the same build, sound ran 47 to 191 ms behind (median 130 ms), where the link's
jitter keeps the browser's audio buffer at 60 to 170 ms.

## Hosted browsers on a GPU

**Where:** RunPod, NVIDIA A40 pods with a 7.65-CPU quota, the Docker image
(v0.1.73, 2026-10-16), Chrome rendering through Vulkan on the GPU, which
the engine picks on its own when the host has a GPU. Viewers: real Chrome
on an AWS c7i.2xlarge in eu-central-1, one viewer per session, through
TURN; 45-second holds. CPU from the engine's own per-process accounting.

| Page, sessions | GPU rendering | Software rendering, same pod type |
|---|---|---|
| WebGL aquarium, 1 | **42.9 fps, 1280x720**, 59% of the quota | 9.7 fps, 640x360, quota full |
| WebGL aquarium, 2 | **51.7 fps, 640x360**, 91% | 7.1 fps, 640x360, quota full |
| WebGL aquarium, 6 | 9.4 fps, quota full | nothing drawn |
| 2D animation, 1 | 29.7 fps, 1280x720 | 39.3 fps, 1280x720 |
| News article, 8 | 6.9 fps (the page's own rate), 31.5% | 6.9 fps, 31.6% |

- **For WebGL the GPU is decisive.** Chrome costs about 3 cores a session
  rendering on the GPU, against the whole 7.6-core quota in software, where
  from six sessions nothing is drawn at all.
- **For ordinary pages the GPU adds nothing:** 2D animation ran as fast or
  faster in software. Most of a moving page's cost is Chrome capturing
  every frame for the stream (about 1.7 cores a session), which a GPU
  doesn't remove.
- **GPU encoding (NVENC)** with `GLASS_NVENC_SHIM_MAX_SESSIONS`: eight news
  article sessions cost **19% of the quota instead of 31.5%** (the
  encoder's share fell from 1.5 cores to 0.55), and one 2D animation
  session reached 42.8 fps against 29.7. Twelve sessions started six at a
  time with the quota already full all started on NVENC (v0.1.76,
  2026-10-17).
- **Capacity on this pod:** about two moving or WebGL sessions at full
  quality before the CPU quota runs out, GPU or not; then the engine keeps
  the frame rate by lowering the picture's size.

**Hands on** (2026-10-16 and 2026-10-17): the A40 pod, a PC and a phone on
home 4G and cellular, driving three.js's WebGL examples, one session each:
60 fps by eye, a crisp picture; the pod at about 6.1 of its 7.65 cores,
with both pictures at 70% of their size.

## Start

v0.1.76, 2026-10-17, the c6g.xlarge above, with the microphone-capable
browser configured, so both Chrome builds are needed:

- **First start, empty cache volume:** the headless browser downloaded from
  Google and checked in 14.2 s, the full browser in 20.3 s, OpenH264 from
  Cisco; container healthy 46 s after start.
- **Recreated on the same volume:** nothing downloaded; the cached Chrome
  checked file by file in 1.2 s and 1.6 s; `/healthz` up 7 s after start.

## How to read these numbers

- **They are runs, not guarantees.** A different page, machine, link or
  version gives different numbers. The CPU a hosted browser needs is mostly
  Chrome's and depends on the page: size by testing your own pages
  ([sizing.md](sizing.md)).
- **Viewer links are real ones.** The PC numbers are over a home 4G
  connection and the phone's over cellular, not a datacenter network.
- **Older versions are labelled.** Results from an earlier version stay
  until they are re-measured.
