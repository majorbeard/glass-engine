# Relay producers

A relay session carries a stream that something else produces: a phone
camera, a desktop capture, a drone, a hardware encoder, your own app. The
producer publishes to Glass over WebRTC; Glass forwards the encoded stream to
every viewer **without decoding or re-encoding it**. Relay sessions start no
browser and use almost no CPU per stream.

Read [concepts.md](../concepts.md) first; this page is the contract a producer
must follow.

## The easy way: `GlassProducer`

If your producer can run a browser engine (a web page, a Capacitor or
Electron app, a WebView), use `GlassProducer` from `@glass/client`. It
implements everything on this page, including reconnects:

```ts
import { GlassProducer } from "@glass/client";

const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });

const producer = new GlassProducer({
  stream,
  produceUrl,            // from your backend (POST /v1/relay-sessions)
  maxBitrateKbps: 1000,  // keep below the uplink
});
producer.on("state", (state, detail) => console.log(state, detail));
producer.on("stats", (s) => console.log(s.uploadBitrateKbps, s.frameWidth, s.encoder));
await producer.start();
```

States: `idle` → `creating-session` → `connecting` → `streaming`, then
`reconnecting` on a drop, `error` or `stopped`. For quick prototypes it can
create the session itself (`serverUrl` and `apiToken` instead of
`produceUrl`), but that puts your API token in the producer. Don't ship it.

The `stream` can be anything that yields a video track: a camera,
`getDisplayMedia()` screen capture, a `<canvas>` capture. The caller owns the
tracks: `stop()` closes the session slot but doesn't stop them.

[`examples/producer-capacitor`](../../examples/producer-capacitor) is a
complete Android app built this way: it publishes the phone's camera and
microphone, caps its bitrate, survives network changes, and shows a QR code
with a watch link.

The rest of this page is for producers that implement the contract
themselves (a native app, GStreamer, pion, a hardware device).

## Creating a session

```sh
curl -X POST -H "Authorization: Bearer $GLASS_API_TOKEN" \
  http://glass.example.com/v1/relay-sessions
```

```json
{
  "id": "9ee60523-…",
  "signalingUrl": "wss://glass.example.com/v1/relay-sessions/9ee6…/signaling?token=…",
  "produceUrl": "wss://glass.example.com/v1/relay-sessions/9ee6…/produce?token=…",
  "codec": "h264",
  "protocolVersion": 2,
  "sourceType": "relay",
  "capabilities": { "video": true, "navigation": false, "…": "…" }
}
```

- `produceUrl` is for the producer. It is single-use: bound to the first
  producer that connects, which can later resume on it.
- `signalingUrl` is for viewers. They connect exactly as they would to any
  other session ([client-sdk.md](../client-sdk.md)). To hand out a watch-only
  link, mint a grant with `POST /v1/relay-sessions/{id}/connections` and
  `{"consumesMedia": true}`.
- `codec` is the one video codec this Glass instance accepts: `h264`, or
  `vp8` when the operator enables VP8. **The producer must send it.**

### Several streams in one session: slots

A session can hold several streams at once, for example the cameras on one
vehicle feeding one dashboard. Declare **named slots** when creating the
session:

```json
{ "slots": ["main", "forward", "rear"] }
```

The response then also has `slots` and `produceUrls`, one per slot;
`produceUrl` is still `main`'s.

- The link is the slot. Each produce URL is bound to its slot, and nobody
  holding one slot's link can publish into another.
- `main` must be one of the names.
- Slots may stay empty; an empty slot costs nothing.
- One session is one seat against the license limit, however many slots it
  has.
- At most 4 slots by default (`GLASS_MAX_STREAM_SLOTS`).
- Viewers receive every slot that has a producer.
- Sessions with more than one slot don't accept producer audio yet. An offer
  with audio gets `audio_not_supported_multi_slot`.

Viewers learn each slot's state from `slot_state` (`slotStateChanged` in the
SDK): `live`, `stalled` or `empty`. A slot is `stalled` when its producer
dropped, or has sent no media for 2 s (`GLASS_RELAY_STALL_THRESHOLD_MS`); the
last frame stays on screen, and the slot is `live` again as soon as media
arrives. A producer silent for 10 s (`GLASS_RELAY_STALL_CLOSE_MS`) is
disconnected so that it reconnects (see [Disconnecting and
reconnecting](#disconnecting-and-reconnecting)).

### Simulcast: several layers of the same picture

Simulcast is opt-in and off by default. A producer can send its video
as up to three layers of the same picture, at different sizes, and Glass
gives each viewer the layer its own link carries: a viewer on a slow link
gets a smaller picture without lowering anyone else's.

**Measure it on your own producers before you turn it on.** In v0.1.117,
when every viewer got the same layer, it cost more than it helped on a
phone with a thin uplink: an Android phone (Chrome, hardware H.264)
streamed better without it on the same links, frozen 0.2% of the time
against 6% on Wi-Fi, and 0.3% against 5% on mobile data. Since v0.1.118,
each viewer has a layer of its own and the producer sends only the layers
viewers need, which is what simulcast is for: viewers on different links.
That has not been measured on phones yet.

Create the session with:

```json
{ "simulcast": true }
```

With `GlassProducer`, set `simulcast: true`: when it creates the session
it asks for one; a `produceUrl` you pass must be from a session created
with `simulcast`. It picks the layers from the
camera's height (three for 540 high or more, two for 360 or more, one
below).

- **One slot only.** A body with both `simulcast` and more than one slot
  gets `400`.
- **Each viewer gets its own layer**, from its own link. A viewer moves
  down only while its link shows congestion, to a layer the link can
  carry. It moves up once its bandwidth estimate has covered the next
  layer with a quarter to spare for 3 s, and not within 10 s of a move
  down; a viewer whose estimate falls short of the next layer is probed
  toward it, so that the estimate can grow. Each move needs a keyframe of
  the new layer, so a viewer may see a short freeze, usually under a
  second.
- **A layer counts once it arrives steadily**: Glass moves no one onto a
  layer until it has arrived steadily for 3 s, and moves everyone off one
  that has sent nothing for half a second.
- **The producer sends only the layers viewers need**, when it sends
  `producer_report` (`GlassProducer` does): the layers viewers are on, and
  the one below each of them, so that a move down lands at once, whatever
  the producer's uplink: when it can't carry them all, the producer's own
  encoder cuts its upper layers. With no viewer, Glass asks for the full
  layer and the one below it, so a recording made with nobody watching gets
  the full picture. A layer no viewer needs is turned off after 5 s.
  `GlassProducer` turns off the layers Glass doesn't ask for, which saves
  the device's upload and encoders. A producer that sends no report
  sends every layer, as before.
- **A recording takes the largest layer any viewer is on.**
- **It costs the device more upload** (about a quarter more at 720p) and an
  encoder per layer.
- **Keep the full layer's cap modest.** A browser's simulcast gets fragile
  on a weak uplink when the full layer may use a lot: in Chrome, with the
  uplink squeezed, a cap of 1500 kbps lost every layer at 500 kbps of
  uplink, and 2000 at 900, while 1000 (`GlassProducer`'s default) held at
  both. `maxBitrateKbps` caps the full layer only.
- **Codecs:** H.264. VP8 travels the same path but is not yet called
  supported: Chrome's VP8 simulcast has been seen to collapse under a
  squeezed uplink.
- **A known Chrome limitation:** after a congested stretch, Chrome's H.264
  simulcast can drop its full-size layer for minutes. Under congestion
  Chrome shrinks the picture it encodes, and at 640x360 or smaller it
  sends two layers instead of three; it brings the third back only when
  it grows the picture again, which can take minutes however much
  bandwidth there is. Viewers keep the smaller layers meanwhile. This is
  the browser's own behaviour. A producer that reconnects starts afresh at
  full size; Glass doesn't disconnect a producer that keeps sending.

`GET /v1/relay-sessions/{id}` reports what arrives and what each viewer
gets, in a `simulcast` block: each layer's rate, loss and whether it is
arriving; each viewer's layer, the layer it is moving to, its link's
estimate and whether it is congested; the producer's own uplink estimate
and the layers asked of it; and the keyframe requests Glass made (see
[Protocol](../protocol.md#relay-sessions)).

**Your own producer** sends one video track with several encodings, each
with an `a=rid` in its offer (`a=simulcast:send`), as browsers do:

- **Every packet carries the `mid` and `rid` header extensions**
  (`urn:ietf:params:rtp-hdrext:sdes:mid`,
  `urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id`); without them Glass
  can't tell the layers apart and drops the stream. Browsers add them;
  pion, as a sender, does not on its own.
- **Every layer sends RTCP sender reports.** Glass needs each layer's
  clock before it moves a viewer onto it.
- **Answer a keyframe request (PLI) for any layer**, by its SSRC.
  Answering with a keyframe on every layer, as Chrome does, is fine: Glass
  asks at most twice a second across all layers, and makes no periodic
  request in a simulcast session.
- The layers' names are yours: Glass orders them by their measured rate.
  It takes at most three; a producer sending one encoding into such a
  session works, as a single layer.

## Connecting

Open a WebSocket to the produce URL. **The producer offers first**:

| Direction | `type` | Fields |
|---|---|---|
| ← Glass | `ice_config` | `iceServers`: apply them (`pc.setConfiguration`) before the offer |
| → Glass | `offer` | `sdp`: one video m-section (plus, optionally, one audio) |
| → Glass | `ice-candidate` | `candidate`: `RTCIceCandidateInit` |
| ← Glass | `answer` | `sdp` |
| ← Glass | `ice-candidate` | `candidate` |
| ← Glass | `error` | `code`, `message` |
| ← Glass | `recording` | `active`: whether the session is being recorded, after the `answer` and on each change |
| → Glass | `producer_report` | Simulcast, optional: `uplinkKbps` (the browser's `availableOutgoingBitrate`), `layers: [{rid, active, width, height}]` |
| ← Glass | `layers_wanted` | Simulcast, to a producer that reports: `rids`, the layers to send; turn the others off |

Wait for the WebSocket's `open` event and for `ice_config` before sending
the offer: `ice_config` carries the TURN credential for this connection
([protocol.md](../protocol.md#glass--client)). If none arrives within 2 s
(an older engine), offer without it. Acquiring a
camera can finish before the socket is open, and sending early fails without
any sign on the server side.

## Media requirements

**Video.** Exactly one video track, in `codec`. Glass behaves as a normal
WebRTC receiver, and your sender must respond to it like one:

- **NACK:** resend lost packets.
- **PLI:** produce a keyframe when asked. Glass asks every 3 s, and also when a
  viewer joins or can't decode (at most once per 500 ms). A
  [simulcast](#simulcast-several-layers-of-the-same-picture) session makes no
  periodic request.
- **Congestion feedback (TWCC):** adapt your bitrate to it. A sender without a
  congestion controller won't degrade gracefully when the network gets worse.
  Browser WebRTC does all three by default; lower-level libraries may need
  configuring.
- **Cap your bitrate below your uplink.** Glass reports congestion but can't
  fix an uplink that is too small. An uncapped phone climbs to about 1.6 Mbps;
  on a slower uplink the router's queue fills, latency swings by seconds, and
  no packets are lost, so nothing looks wrong. Set a `maxBitrate` the link
  can carry (the reference producer defaults to 1000 kbps).

**Audio (optional).** At most one Opus track (48 kHz, stereo). Every viewer
receives it. Viewers of a relay session always get an audio line; if the
producer sends none, it is silent.

## Errors Glass sends

Over the produce WebSocket, as `{"type": "error", "code": "…", "message": "…"}`.
Rely on `code`; `message` is for people.

| `code` | Meaning | What to do |
|---|---|---|
| `codec_mismatch` | The offer doesn't list the session's codec. Sent instead of an answer. | Fix the offer and send it again on the same socket. |
| `audio_not_supported_multi_slot` | Audio offered on a multi-slot session. | Offer without audio. |
| `producer_not_connected` | WebRTC didn't connect within 20 s of the answer. Usually the wrong codec or no network path to Glass (UDP port, NAT, TURN). | Informational; a producer that connects late is still accepted. |

A second producer on a slot that already has one is refused with HTTP `409`
at the produce URL; the first producer is unaffected.

## Disconnecting and reconnecting

| Close | Meaning |
|---|---|
| You close with `1000` | Deliberate stop. The slot is freed at once. |
| Any other ending | The slot is held for the reconnect grace (60 s by default). Resume on the **same** produce URL. |
| Glass closes with `4001` | You sent no media for 10 s (`GLASS_RELAY_STALL_CLOSE_MS`), or none within 10 s of connecting (`GLASS_RELAY_FIRST_MEDIA_GRACE_MS`). The slot is held; resume. |
| Glass closes with `4401` | The produce link has expired. Don't resume; get a new link. |
| Glass closes with `4403` | The produce link was revoked. Don't resume; get a new link. |
| Glass closes with `4404` | The session is gone. Don't resume. |

A producer should reconnect on its own. `GlassProducer` does this:

1. Detect the drop: the WebSocket closes, the peer connection goes `failed`
   (or `disconnected` for more than about 6 s), or `producer_not_connected`
   arrives.
2. Close the dead socket with a code other than 1000 (the reference uses
   4000). A 1000 close tells Glass you meant to stop. Keep the camera
   running.
3. Resume on the same produce URL with a short backoff (1, 2, 3, 5 s), giving
   the WebSocket handshake and negotiation one deadline together (20 s).
   The session ID and every viewer's link stay valid.
4. If resuming hasn't worked after about 45 s and you created the session,
   create a new one and tell your viewers the new link.
5. Treat camera denied, `401`/`403` on session creation, `codec_mismatch`,
   and a close with `4401` or `4403` as fatal.
6. Retry at once, without waiting out the backoff, when the app returns to the
   foreground or the network comes back.

## Recording

A relay session can be recorded: its main slot's video and the audio, whether or
not anyone is watching. `GlassProducer` fires `recording` so your app can show
it. See [recording.md](../recording.md).

## Viewers

Viewers use `createGlassClient` with the relay session's `signalingUrl` (or a
minted watch-only one). Relay sessions have no navigation or page input.
Every viewer receives the stream as the producer sends it, or, in a
[simulcast](#simulcast-several-layers-of-the-same-picture) session, the layer
its own link carries.
