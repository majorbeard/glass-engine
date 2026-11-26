# Calls

Two people seeing and hearing each other are a session of two members, each
publishing a camera and a microphone and watching the other's. There is no
separate call API: a call is a [session whose members publish](producers.md),
with two links. Media is forwarded without decoding. Glass is built for a
small number of members a session; for many-way conferencing, use a
dedicated conferencing server.

Read [concepts.md](../concepts.md) first.

**Coming from 0.1?** `/v1/calls` and its peer URLs are gone; see
[Migrating from 0.1](../migrating-from-0.1.md).

## Making a call

Your backend, with the API token:

```sh
# A session of at most two members
curl -X POST -H "Authorization: Bearer $GLASS_API_TOKEN" \
  -H 'Content-Type: application/json' -d '{"maxMembers": 2}' \
  https://glass.example.com/v1/sessions

# One link for each person: each watches everything and publishes a camera and a microphone
curl -X POST -H "Authorization: Bearer $GLASS_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"watch": "all", "publish": ["camera", "microphone"]}' \
  https://glass.example.com/v1/sessions/<id>/links
```

Mint the link twice, and give one `url` to each person. A third join is
refused (`409` `session_full`). Each link stops admitting new connections
after the engine's link lifetime (24 h by default; `expiresIn` sets it).
`DELETE /v1/sessions/{id}` ends the call for both; it also ends on its own
when both have left.

## Joining

[`examples/call-capacitor`](../../examples/call-capacitor) is a complete
Android call app, and [`examples/quickstart/call.html`](../../examples/quickstart/call.html)
the same in one web page.

```ts
import { GlassClient } from "@glass/client";

const local = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
const client = new GlassClient({ link });
client.publish(local.getVideoTracks()[0], { kind: "camera" });
client.publish(local.getAudioTracks()[0], { kind: "microphone" });

// The other person's camera and microphone are two sources, each with its
// own stream: one stream of both plays them in one <video>.
const remote = new MediaStream();
client.on("track", (_sourceId, stream) => {
  for (const t of stream.getTracks()) if (!remote.getTracks().includes(t)) remote.addTrack(t);
  remoteVideo.srcObject = remote;
});
await client.connect();
```

Each member receives the other's camera and microphone, never its own. A
member who joins first sees nothing until the other arrives
(`source_added`). Without the SDK, follow
[Connecting your own publisher](producers.md#connecting-your-own-publisher):
it is the same connection, with a link that also watches.

## Dropped connections

The reconnect rules in [concepts.md](../concepts.md#reconnects) apply to
each member. If one person's network drops, the other stays connected; the
dropped one reconnects with the same link within the grace and the call goes
on. Leave with `disconnect()` (close code `1000`) only when the person hangs
up.
