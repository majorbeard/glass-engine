# Getting started

This guide runs Glass on your own machine and tries all three sources: a
hosted browser, a relay stream from your camera, and a call. It takes about
ten minutes.

You need Docker and Node.js 18 or newer.

## 1. Start Glass

```sh
docker run --rm ghcr.io/majorbeard/glass seccomp-profile > glass-seccomp.json
docker run -d --name glass \
  --security-opt seccomp=glass-seccomp.json \
  -p 127.0.0.1:8080:8080 \
  -p 50000:50000/udp \
  --shm-size=1g \
  -v glass-cache:/home/glass/.cache/glass \
  -e GLASS_INSECURE_LOCAL_DEV=true \
  -e GLASS_WEBRTC_NAT_1TO1_IPS=127.0.0.1 \
  ghcr.io/majorbeard/glass
```

What the flags do:

- `--security-opt seccomp=glass-seccomp.json`: the seccomp profile the first
  command wrote from the image. Chrome's sandbox needs it; without it Glass
  refuses to start. See [deployment.md](deployment.md#hardening).
- `-p 127.0.0.1:8080:8080`: the HTTP API, reachable only from this machine.
- `-p 50000:50000/udp`: WebRTC media. Without it, connections hang.
- `--shm-size=1g`: shared memory for Chrome.
- `-v glass-cache:...`: keeps what the container downloads at its first
  start, Chrome from Google (about 120 MB) and the OpenH264 encoder from
  Cisco, so later containers don't download them again. `docker logs glass`
  shows the downloads.
- `GLASS_INSECURE_LOCAL_DEV=true`: run without an API token. This is safe only
  because of the `127.0.0.1` binding above.
- `GLASS_WEBRTC_NAT_1TO1_IPS=127.0.0.1`: tells Glass that clients reach it on
  `127.0.0.1`, since they are on the same machine.

Check it:

```sh
curl http://localhost:8080/healthz    # {"status":"ok"}
curl http://localhost:8080/v1/info    # tier, capacity, protocol version
```

Without a license key Glass runs on the Free tier: two concurrent sessions of
each type, which is plenty for this guide.

## 2. Build the SDK and examples

```sh
git clone https://github.com/majorbeard/glass-engine
cd glass-engine
npm install
npm run build
```

## 3. A hosted browser

```sh
cd examples/viewer-preact
VITE_GLASS_ADDR=http://localhost:8080 npm run dev
```

Open the URL Vite prints (normally `http://localhost:5173`), type an address
and browse. The page runs in Chrome inside the container: you are seeing its
video and sending it your mouse and keyboard.

Things to try:

- Download a file. A prompt appears; nothing is saved until you click.
- Start Glass with `-e GLASS_AUDIO_MODE=on` and play a video with sound.

## 4. Publish your camera

In another terminal, serve the repository root:

```sh
npx serve .     # from the glass-engine directory
```

Open `http://localhost:3000/examples/quickstart/publish.html` and click **Start
camera**. The page makes a session whose members publish, publishes your camera
and microphone into it with `GlassClient.publish()`, and shows a watch link.
Open the link in another tab: that tab is a viewer, receiving your camera
through Glass.

No browser runs in Glass for this. It forwards the camera's encoded stream to
each viewer as it arrives. Close the publishing tab and watch the viewer: its
status changes to `stalled`, and the last frame stays on screen; after the
reconnect grace the camera's source ends.

## 5. A call

Open `http://localhost:3000/examples/quickstart/call.html` and click **Start a
call**. Open the **join link** in another tab (or on another device that can
reach Glass). Each side sees the other; Glass forwards the media both ways.

## 6. With an API token

Anything beyond your own machine needs a token. Restart Glass with one:

```sh
docker rm -f glass
export GLASS_API_TOKEN=$(openssl rand -hex 32)
docker run -d --name glass \
  --security-opt seccomp=glass-seccomp.json \
  -p 8080:8080 -p 50000:50000/udp --shm-size=1g \
  -v glass-cache:/home/glass/.cache/glass \
  -e GLASS_API_TOKEN \
  -e GLASS_WEBRTC_NAT_1TO1_IPS=127.0.0.1 \
  ghcr.io/majorbeard/glass
```

Now every API call needs the token:

```sh
curl -X POST -H "Authorization: Bearer $GLASS_API_TOKEN" \
  -H 'Content-Type: application/json' -d '{"sources": [{"kind": "browser"}]}' \
  http://localhost:8080/v1/sessions
```

The response's `link.url` carries its own per-session token, and that link is
all a client needs. That is how a real application is built:

1. Your backend holds `GLASS_API_TOKEN`, makes sessions, and mints links
   (`POST /v1/sessions/{id}/links`).
2. It gives each person only the link they should use: the session's own for
   its owner, a link that watches for a guest, one that publishes for a phone,
   one that does both for each side of a call.
3. It ends sessions when users are done, or lets each end when its last member
   leaves.

The reference viewer can take a token for local testing
(`VITE_GLASS_API_TOKEN`). A real frontend never should: anything in a
frontend bundle is public. The viewer enforces it: it refuses to build
with a token for an engine that is not on your machine or private network,
and pointed at any other engine it only opens the session links it is
given.

## 7. On a server: the engine and `glass gate`

The quickest way to a browser anyone can open: the engine, and `glass gate`
beside it. The gate gives each visitor a browser from the engine's pool, so no
page holds the API token and nobody hands out session links.

You need a host with Docker, a name pointing at it (for the certificate), and
the reference viewer hosted somewhere (`examples/viewer-preact`, built with
`npm run build`; any static host works).

```sh
cd examples/compose
docker run --rm ghcr.io/majorbeard/glass seccomp-profile > glass-seccomp.json
cp .env.example .env     # fill in the name, two random secrets, and your viewer's address
docker compose up -d
docker compose exec gate glass gate link
```

The last command prints a link to your viewer. Open it: the viewer asks the gate
for a ticket and a browser starts. A link works once and for 24 hours by
default (`--uses N`, `--valid 7d`); mint one per person, or whenever you want
to look. A reload rejoins the same browser without spending another use.

For a public demo, or a site behind your own sign-in, set `GLASS_GATE=open`
in `.env`: then anyone opening your viewer gets a browser, within the gate's
limits (10 a minute per visitor, 120 in all), with no link at all. Build the
viewer with `VITE_GLASS_GATE=https://your-glass-domain` for that.
`GLASS_GATE=passphrase` asks visitors for a shared phrase instead.

The engine holds the certificate and forwards the gate's one route
(`GLASS_GATE_UPSTREAM`), so both are reached at the same address. Open TCP 443
and UDP 50000 to the host (and TCP 80 for the redirect to HTTPS, if you
like); the gate itself publishes no port. See
[deployment.md](deployment.md#the-session-service-glass-gate) for a gate on a
host of its own.

## Next

- [concepts.md](concepts.md): the session model behind all of this.
- [sources/](sources/): the details of each source.
- [deployment.md](deployment.md): running Glass on a server.
