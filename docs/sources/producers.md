# Publishing

A member of a session can publish tracks into it: a camera, a microphone, a
screen, or a device's own picture. Each published track becomes a **source**
of the session, and every member whose link may watch it receives it. Glass
forwards what arrives; it never decodes or re-encodes a published track.

**Coming from 0.1?** Relay sessions, produce URLs, slots and `GlassProducer`
are gone. A publisher is a member like any other, joined with a link that may
publish. See [Migrating from 0.1](../migrating-from-0.1.md).

## The easy way: `GlassClient.publish()`

```ts
import { GlassClient } from "@glass/client";

const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
const client = new GlassClient({ link: publishLink });   // from your backend
const cam = client.publish(stream.getVideoTracks()[0], { kind: "camera" });
const mic = client.publish(stream.getAudioTracks()[0], { kind: "microphone" });
mic.on("silent", () => warn("your microphone is sending silence"));
await client.connect();
```

It announces each track, offers, applies a start bitrate, caps the picture's
bitrate (1000 kbit/s by default), runs simulcast's layers if asked, reports
silence, and publishes everything again after a reconnect.
[`examples/producer-capacitor`](../../examples/producer-capacitor) is a
complete Android app built on it, and
[`examples/quickstart/publish.html`](../../examples/quickstart/publish.html)
a single page. The options are in [client-sdk.md](../client-sdk.md#publishing).

## A session, and a link that publishes

Your backend, with the API token, makes a session whose members publish and
mints each publisher a link:

```http
POST /v1/sessions                     {"maxMembers"?, "simulcast"?, "linkExpiresIn"?}
POST /v1/sessions/{id}/links          {"publish": ["camera", "microphone"]}
POST /v1/sessions/{id}/links          {"watch": "all"}
```

A session made with no `sources` is one whose members publish. Hand the
publishing link to the device, never the API token; hand watch links to
viewers. A link may publish only the kinds it was minted with, and may also
watch: two people seeing and hearing each other are two links that both
watch and publish, on a session of `maxMembers: 2` (see
[Calls](calls.md)).

## Connecting your own publisher

For anyone writing a publisher of their own (pion, GStreamer, a native SDK).
The messages are in [the protocol](../protocol.md#signaling).

1. Open a WebSocket to the link's `url`. The first message is `hello`: the
   protocol version (refuse any but 3), the ICE servers to use, this
   connection's id and what its link may do.
2. Add a send-only transceiver for each track you publish (with simulcast,
   with its encodings, below), make an offer and set it as the local
   description.
3. For each send-only line, send
   `{"type": "publish", "mid": "<its mid>", "kind": "camera" | "microphone" | "screen" | "device"}`
   **before** the offer that carries it. Glass takes a line as a source only
   when it was announced.
4. Send the offer. Glass answers (`answer`); trickle ICE candidates both
   ways.
5. A line Glass takes becomes a source: every member who may watch it gets
   `source_added`. A line it does not take is answered `inactive`, and you get
   `publish_refused {mid, reason}`: `invalid` (no mid, or an unknown kind),
   `not_allowed` (the link may not publish that kind) or `codec_mismatch` (no
   codec the session can send on).
6. To stop publishing a track, send `{"type": "unpublish", "mid": …}`: its
   source ends for everyone.

You may publish more later on the same connection: add the line, announce
it, offer again. One offer is in flight at a time; wait for its answer.

## Media

**Video.** H.264 or VP8 (and AV1 where the engine has it): a browser lists
every codec it has, and Glass answers with the one it sends on. Glass
behaves as a normal WebRTC receiver, and your sender must respond like one:

- **NACK:** resend lost packets.
- **PLI:** produce a keyframe when asked. Glass asks every 3 s, and when a
  viewer joins or can't decode (at most twice a second); a simulcast
  session makes no periodic request.
- **Congestion feedback (TWCC):** adapt your bitrate to it. Browser WebRTC
  does all three by default; lower-level libraries may need configuring.
- **Cap your bitrate below your uplink.** Glass reports congestion but can't
  fix an uplink that is too small. An uncapped phone climbs to about
  1.6 Mbit/s; on a slower uplink the router's queue fills and latency swings
  by seconds while no packet is lost, so nothing looks wrong. `@glass/client`
  caps at 1000 kbit/s by default.
- **Start bitrate:** a browser starts its congestion control low and takes
  seconds to climb. `@glass/client` sets Chromium's start bitrate (500 kbit/s
  by default) in Glass's answer.

**Audio.** A microphone is a source of its own: Opus, 48 kHz, forwarded as it
arrives.

**A silent microphone is not noticed by Glass.** A track that sends silence,
or almost nothing, looks healthy to the engine. `@glass/client` checks a
published microphone once as it is published, as LiveKit's SDK does, and
fires the publication's `silent` event: show it, so a person whose
microphone is muted at the system level, or broken, finds out.

## Simulcast: several layers of the same picture

Opt-in, off by default. A publisher can send its picture as up to three
layers of different sizes, and Glass gives each viewer the layer its own link
carries: a viewer on a slow link gets a smaller picture without lowering
anyone else's.

**Measure it on your own publishers before you turn it on.** When every
viewer got the same layer (v0.1.117), it cost more than it helped on a phone
with a thin uplink: an Android phone (Chrome, hardware H.264) froze 0.2% of
the time without it against 6% with it on Wi-Fi, and 0.3% against 5% on
mobile data. Since v0.1.118 each viewer has a layer of its own and the
publisher sends only the layers viewers need, which is what simulcast is for;
that has not been measured on phones.

Make the session with `{"simulcast": true}`, and publish with
`simulcast: true` (`@glass/client` picks the layers from the camera's height:
three for 540 high or more, two for 360 or more, one below).

- **Each viewer gets its own layer**, from its own link. A viewer moves down
  only while its link shows congestion, to a layer it can carry. It moves up
  once its estimate has covered the next layer with a quarter to spare for
  3 s, and not within 10 s of a move down; a viewer short of the next layer
  is probed toward it. Each move needs a keyframe of the new layer, so a
  viewer may see a short freeze, usually under a second.
- **A layer counts once it arrives steadily** for 3 s, and stops counting
  after half a second of nothing.
- **The publisher sends only the layers viewers need**, when it sends
  `producer_report` (`@glass/client` does): the layers viewers are on and
  the one below each, so that a move down lands at once. With no viewer,
  the full layer and the one below it. A layer no viewer needs is turned off
  after 5 s, which saves the device's upload and encoders. A publisher that
  never reports sends every layer.
- **It costs the device more upload** (about a quarter more at 720p) and an
  encoder per layer.
- **Keep the full layer's cap modest.** In Chrome, with the uplink squeezed,
  a cap of 1500 kbit/s lost every layer at 500 kbit/s of uplink, and 2000 at
  900, while 1000 (`@glass/client`'s default) held at both.
- **Codecs:** H.264. VP8 travels the same path but is not called supported:
  Chrome's VP8 simulcast has been seen to collapse under a squeezed uplink.
- **A known Chrome limitation:** after a congested stretch, Chrome's H.264
  simulcast can drop its full-size layer for minutes. Under congestion it
  shrinks the picture, and at 640x360 or smaller it sends two layers instead
  of three, bringing the third back only when it grows the picture again.
  Viewers keep the smaller layers meanwhile. A publisher that reconnects
  starts afresh at full size.

`GET /v1/sessions/{id}` reports what arrives and what each viewer gets, in a
`simulcast` block on each published picture.

**Your own simulcast publisher** sends one video track with several
encodings, each with an `a=rid` in its offer (`a=simulcast:send`), as
browsers do:

- **Every packet carries the `mid` and `rid` header extensions**
  (`urn:ietf:params:rtp-hdrext:sdes:mid`,
  `urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id`); without them Glass can't
  tell the layers apart. Browsers add them; pion, as a sender, does not on its
  own.
- **Resends (RTX) carry `repaired-rid`, not `rid`**, as browsers' do. pion
  copies `rid` onto its RTX packets, which a receiver then loses: with pion,
  negotiate no RTX and resend on each layer's own SSRC.
- **Every layer sends RTCP sender reports**: Glass needs each layer's clock
  before it moves a viewer onto it.
- **Answer a keyframe request (PLI) for any layer**, by its SSRC. A keyframe
  on every layer, as Chrome sends, is fine.
- **Layers on demand:** send `producer_report {mid, uplinkKbps, layers}`
  about once a second, and Glass sends `layers_wanted {mid, rids}`. Turn
  encodings on and off with `setParameters`, one call at a time; with two or
  more on, keep the picture size (`degradationPreference:
  "maintain-resolution"`).
- The layers' names are yours: Glass orders them by their measured rate,
  and takes at most three. One encoding into a simulcast session works, as
  one layer.

## While publishing

- **A track that goes quiet** is shown to its viewers as paused
  (`source_updated`, state `stalled`) after 2 s without media, or 10 s after
  joining for one that has sent nothing yet, and live again on its next
  packet. Glass never disconnects a publisher for being quiet.
- **A connection that never comes up** is told so: an `error` with code
  `not_connected` 20 s after the answer, usually the wrong codec or no
  network path to Glass (its UDP port, NAT, TURN). The socket stays open: the
  client may restart ICE or leave.

## Disconnecting and reconnecting

| What happens | |
|---|---|
| You close with `1000` | A deliberate leave: your sources end at once. When you were the last member, the session ends. |
| Any other ending | Your place is held for the reconnect grace (60 s by default). Reconnect with the same link and publish again: the same member resumes, and viewers keep their links. |
| Glass closes with `4404` | The session has ended. Don't reconnect; your backend decides what next. |
| Glass closes with `4401` or `4403` | The link expired or was revoked. Don't reconnect; get a new link. |

`@glass/client` does all of this. A publisher of your own should:

1. Detect the drop: the WebSocket closes, or the peer connection goes
   `failed` (or `disconnected` for more than a few seconds).
2. Close a dead socket with a code other than 1000, which would tell Glass you
   meant to leave. Keep the camera running.
3. Reconnect with the same link with a short backoff (1, 2, 4, 8 s), and
   publish again.
4. Treat a close with `4404`, `4401` or `4403`, and `publish_refused` with
   `not_allowed`, as final.
5. Retry at once when the app returns to the foreground or the network comes
   back.

A publisher never makes a new session itself: that needs the API token. When
the session ends it reports it, and your backend decides.

## Viewers

Viewers join with a link that watches. Each published track is a source: a
viewer gets `source_added`, then its media in a `track` event, and pauses a
source it doesn't want with `source(id).receive(true)`. In a simulcast
session each viewer gets the layer its own link carries.

## Recording

A session whose members publish can't be recorded in this release
(`"record": true` is refused): recording such a session comes in a later
release. A browser session, and a playback, can be; see
[recording.md](../recording.md).

## Known gaps

- **A publisher is not told its source's id:** it knows its publications by
  `mid`. Viewers see the source in `source_added`.
- **A viewer can't send input to a publisher** (a remote-controlled device):
  that is planned.
