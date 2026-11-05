# Recording and playback

Glass can keep a session's stream in a file and play that file back to
viewers as a session of its own. Recording is off until you give Glass a place
to keep files, and it never starts by itself: a recording starts only when your
backend asks for one, with the API token, for one session.

## What a recording holds

- **The stream as it was sent.** Nothing is encoded a second time, so a
  recording costs very little and looks exactly as the stream looked. Measured
  on an arm64 CPU host with one H.264 session: about 0.005 of a core.
- **Picture and sound in one file.** `.webm` for VP8 and AV1, `.mkv` (Matroska)
  for H.264. Browsers play the `.webm` files directly. For `.mkv`, use a player
  such as VLC or ffmpeg, or [play it back through Glass](#playing-a-recording-back).
- **A timeline beside it.** One JSON event a line: navigations, loads, viewers
  joining and leaving, input, size changes. See
  [the timeline](protocol.md#recordings).

**The picture and sound are your users' content.** Whatever was on the screen is
in the file, typed text included. Only the API token can list, fetch or delete
recordings. The timeline is different: it holds origins rather than URLs, "a key
was pressed" rather than which key, and never typed text or a dialog's message,
so you can keep and share it without carrying what the picture shows.

**Everyone is told.** Every connection to a recorded session gets a `recording`
message as it joins and whenever the state changes, relay producers included.
The reference viewer shows a "Recording" mark. Whether you need your users'
consent before recording is yours to work out for where you operate.

## Turning it on

Set `GLASS_RECORDING_DIR` to a folder on a volume. The container's root is
read-only, and a new named volume belongs to root, so give it to the image's
`glass` user first:

```sh
docker volume create glass-recordings
docker run --rm --user 0 --entrypoint chown -v glass-recordings:/recordings \
  ghcr.io/majorbeard/glass:<version> 1000:1000 /recordings
```

Then add to [your `docker run`](deployment.md):

```sh
  -v glass-recordings:/recordings \
  -e GLASS_RECORDING_DIR=/recordings \
```

At the 8 Mbit/s ceiling a page that never stops moving is about 60 MB a minute;
a quiet page is far less. **Glass never deletes a recording by itself**: keeping
and removing them is yours, so watch the disk. See
[the settings](configuration.md#recording).

## Recording a session

Ask when you create the session:

```sh
curl -X POST -H "Authorization: Bearer $GLASS_API_TOKEN" \
  -d '{"record": true}' https://glass.example.com/v1/sessions
```

The response carries a `recording` object with the recording's `id`. If the
recording can't start, the session is closed and the error returned, so you never
get a session you believe is recorded and isn't.

Or start and stop one on a running session:

```sh
curl -X POST -H "Authorization: Bearer $GLASS_API_TOKEN" \
  -d '{"action": "start"}' https://glass.example.com/v1/sessions/$ID/recording
curl -X POST -H "Authorization: Bearer $GLASS_API_TOKEN" \
  -d '{"action": "stop"}' https://glass.example.com/v1/sessions/$ID/recording
```

Relay sessions work the same way, under `/v1/relay-sessions`. Viewer links and
session tickets can't start a recording.

A recording stops when asked, when its session ends, or at a limit: its size,
its length, or under 512 MB free on its disk. `stopReason` says which.

Fetch the file once it has stopped, range requests included:

```sh
curl -H "Authorization: Bearer $GLASS_API_TOKEN" -o recording.webm \
  https://glass.example.com/v1/recordings/$RECORDING_ID/file
```

The file is written as it goes. If the engine is killed mid-recording, the file
still plays, up to about its last 5 s, and is listed as `interrupted` when Glass
next starts.

## Playing a recording back

```sh
curl -X POST -H "Authorization: Bearer $GLASS_API_TOKEN" \
  https://glass.example.com/v1/recordings/$RECORDING_ID/play
```

The answer is a session with a `signalingUrl`, and a viewer joins it as it joins
any session. That link can watch and control playback; a link minted with
`consumesMedia` alone can only watch. Playback starts once a viewer's media is
up, and waits when no viewer is left.

```ts
const client = createGlassClient({ signalingUrl });
client.on("videoTrack", (stream) => (video.srcObject = stream));
client.on("playback", ({ playing, positionMs, durationMs, ended }) => {});
client.on("timeline", (event) => {}); // the recording's events, as playback passes them
await client.connect();

client.controlPlayback("pause");
client.controlPlayback("seek", 30_000);
client.controlPlayback("play");
```

Your backend can do the same with `POST /v1/playback-sessions/{id}/control`. The
reference viewer shows a bar with play, pause and seek. See
[the protocol](protocol.md#recordings) for every route.

## Limits worth knowing

- **A browser session records only while someone watches.** With no viewer it
  encodes nothing, so there is nothing to keep; the file simply has less in it. A
  relay records what its producer sends, watched or not.
- **Calls aren't recorded.** A relay records its main slot's video and the audio;
  other slots aren't recorded.
- **Keyframes cost a little while recording.** So that a recording can be sought,
  a browser session sends a keyframe about every 10 s while it records, which
  added about 6.5% to the bitrate of a constantly moving page on an open link. On
  a slow link, where a keyframe would stall the stream, they come as far apart as
  2 minutes, so a recording made there seeks less finely. A relay's keyframes
  come from its producer.
- **A seek lands on a keyframe.** It lands on the one at or before the position
  you asked for, up to about 10 s earlier, or up to 2 minutes for a recording made
  on a slow link.
- **Playback can't adapt to a viewer's link.** Nothing is re-encoded, so the
  bitrate is what was recorded, and a viewer on a slower link than the recording's
  loses packets. When a viewer asks for a keyframe (one joining, or one that lost
  packets), every viewer of that playback goes back to the last keyframe, at most
  once in 3 s.
- **The size limit can be passed slightly.** It counts what has reached the disk;
  the last few seconds and the seek index come on top.
