# Calls

A call session connects exactly two peers. Each sends its camera and
microphone to Glass and receives the other's, over one peer connection per
peer. Media is forwarded without decoding. Calls are for two people; for
many-way conferencing, use a dedicated conferencing server.

Read [concepts.md](../concepts.md) first.

## Creating a call

```sh
curl -X POST -H "Authorization: Bearer $GLASS_API_TOKEN" \
  http://glass.example.com/v1/calls
```

```json
{
  "id": "5c0b…",
  "peerAUrl": "wss://glass.example.com/v1/calls/5c0b…/peers/a/signaling?token=…",
  "peerBUrl": "wss://glass.example.com/v1/calls/5c0b…/peers/b/signaling?token=…",
  "videoCodec": "h264",
  "protocolVersion": 1,
  "sourceType": "call"
}
```

Give `peerAUrl` to one participant and `peerBUrl` to the other. Each URL
carries that peer's identity: it only works for its own peer, and only one
connection holds it at a time. There is no unscoped URL for a call. A call
nobody joins is closed after 10 minutes.

`GET /v1/calls/{id}` reports its state; `DELETE /v1/calls/{id}` ends it.

## Joining

[`examples/call-capacitor`](../../examples/call-capacitor) is a complete
Android call app; [`examples/quickstart/call.html`](../../examples/quickstart/call.html)
is the same flow in one web page.

The peer offers, Glass answers, the same as a relay producer
([producers.md](producers.md#connecting)):

```ts
const pc = new RTCPeerConnection({ iceServers });
const local = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
local.getTracks().forEach((t) => pc.addTrack(t, local));

const remote = new MediaStream();
pc.ontrack = (e) => { remote.addTrack(e.track); showRemote(remote); };

const ws = new WebSocket(peerUrl);
pc.onicecandidate = (e) => {
  if (e.candidate) ws.send(JSON.stringify({ type: "ice-candidate", candidate: e.candidate.toJSON() }));
};
ws.onmessage = async (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === "answer") await pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
  if (msg.type === "ice-candidate") await pc.addIceCandidate(msg.candidate);
};
ws.onopen = async () => {                       // only after the socket is open
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  ws.send(JSON.stringify({ type: "offer", sdp: offer.sdp }));
};
```

- Send video in the call's `videoCodec`, and optionally one Opus audio track.
- A peer that joins first sees a silent, black remote track until the other
  peer arrives. No renegotiation is needed when it does.
- Glass sends WebSocket pings; a peer must answer within 30 s or it is treated
  as disconnected. Browsers answer pings automatically; with another WebSocket
  library, make sure it does.

## Dropped connections

The reconnect rules in [concepts.md](../concepts.md#reconnects) apply per
peer. If one peer's network drops, the other stays connected; the dropped
peer reconnects on its own URL within the grace window and the call resumes.
Close with code `1000` only when the user hangs up.
