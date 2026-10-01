# Architecture

How media and input move through a Glass process. You don't need this to use
Glass; it helps when you are sizing a deployment or working out why something
behaves the way it does.

## One process, three layers

```text
 HTTP API ─┐
 signaling ┤  sessions: browser · relay · call     ┌─ license limit
 (WebSocket)│  connections, grants, control,        ├─ CPU-headroom admission
            │  reconnect grace                      └─ per-session viewer ceiling
            │
            ├─ sources ──────────────────────────────────────────────┐
            │   hosted browser:  Chrome → encoder → shared track     │
            │   relay:           producer RTP → shared track         │
            │   call:            peer A ⇄ peer B                     │
            │                                                        │
            └─ WebRTC transport: one UDP port for every peer, ICE,   │
                congestion control per viewer, retransmission, pacing ┘
```

**The session layer** is the same for every source. It tracks connections,
their capabilities and the owner, runs control handoff, holds dropped
connections for the reconnect grace, and closes sessions nobody uses. Each
source type has its own session manager, so browser, relay and call sessions
are limited separately.

**Sources** differ only in where media comes from and where input goes. Each
source says what it can do (video, audio, navigation, the input actions it
accepts), and the engine advertises exactly that in `capabilities`. Nothing
above the source layer assumes a browser.

**The transport** is one WebRTC stack for everything. Every peer connection
(viewer, producer, call peer) shares a single UDP port, so the port count
doesn't cap connections. Each viewer gets its own bandwidth estimate (Google
Congestion Control), lost packets are retransmitted (NACK), and a pacer
smooths bursts onto the network.

## Hosted browser

```text
Chrome (headless) ──screen frames──► encoder process ──H.264/VP8──► shared video track ──► viewers
       ▲                                                                   │
       └──── input events ◄── validation ◄── DataChannel ◄─────────────────┘
```

- **Capture.** Chrome paints; Glass receives each changed frame from Chrome's
  DevTools protocol. A page that isn't changing produces no frames; Glass
  sends periodic keyframes so a joining or recovering viewer still gets a
  picture.
- **Encode.** Frames go to an encoder that runs as a separate process:
  OpenH264 by default, VP8 when enabled, NVIDIA NVENC when a GPU is configured.
  Keeping encoders out of process means an encoder crash restarts only that
  encoder, with backoff, while the session stays up.
- **Fan-out.** One encode per session, shared by every viewer. Quality
  follows the weakest viewer's bandwidth estimate and the host's CPU: under
  CPU pressure Glass captures fewer frames and lowers resolution before it
  refuses work.
- **Input.** DataChannel messages are checked (ranges, types, rights) and
  dispatched to Chrome as real input events: mouse, wheel, keyboard and touch.
- **Audio** (optional). Each browser plays into its own virtual sound device;
  Glass encodes it to Opus and shares it with every viewer.
- **Isolation.** Browsers come from a pool and are reused, but each session
  runs in its own browser context, wiped at the end. Outbound traffic goes
  through a filtering proxy that blocks private networks.
- **Watchdogs.** A browser that stops responding is detected and its session
  closed cleanly with an `error` to the viewer, instead of freezing.

The browser is the expensive source: Chrome's rendering and the encoder both
use CPU for as long as the page changes. See [sizing.md](sizing.md).

## Relay

```text
producer ──RTP──► reassemble frames (no decode) ──► shared track ──► viewers
    ▲                                                      │
    └──── keyframe requests, NACK, congestion feedback ◄───┘
```

- Glass is a real WebRTC receiver toward the producer: it sends congestion
  feedback, retransmission requests and keyframe requests, so the producer's
  own encoder adapts.
- Frames are forwarded without decoding or re-encoding. CPU cost per stream is
  small, and bandwidth dominates.
- When a viewer joins, Glass asks the producer for a keyframe, so the new
  viewer's picture starts within moments.
- Each slot of a session is its own stream with its own producer. Glass
  tracks each slot's liveness (`live`, `stalled`, `empty`) from the media
  actually arriving.

## Calls

Each peer is a producer and a viewer at once, on one peer connection. Glass
forwards A's media to B and B's to A, without decoding. Each peer's link has
its own identity, so a reconnect resumes the right side of the call.

## Admission

A new session is admitted only when all of these allow it:

1. **The license limit** for that session type.
2. **CPU headroom** (browser sessions): when host CPU is above a threshold
   (85% by default), new sessions wait briefly, then are refused with `503`.
   Each new session reserves headroom until its own load shows up, so a burst
   of requests can't oversubscribe the host.
3. **The browser pool** (browser sessions): its size follows the session limit
   unless the operator caps it.

A viewer that takes control counts against the license limit the same way a
session does; watch-only viewers are limited only by the per-session viewer
ceiling.

## Failure handling

- A crash inside one session's code is contained to that session; the process
  and other sessions keep running.
- Browser, encoder and transport failures end the affected session with a
  clear signal (`error` message, close code) rather than a silent freeze.
- Dropped connections are held for the reconnect grace; nothing is torn down
  until the grace runs out.
- The process shuts down gracefully on `SIGTERM`: it stops accepting sessions,
  closes existing ones and stops its browsers.
