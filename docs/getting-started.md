# Getting started

This guide runs Glass on your own machine and tries all three sources: a
hosted browser, a relay stream from your camera, and a call. It takes about
ten minutes.

You need Docker and Node.js 18 or newer.

## 1. Start Glass

```sh
docker run -d --name glass \
  -p 127.0.0.1:8080:8080 \
  -p 50000:50000/udp \
  --shm-size=1g \
  -e GLASS_INSECURE_LOCAL_DEV=true \
  -e GLASS_WEBRTC_NAT_1TO1_IPS=127.0.0.1 \
  ghcr.io/majorbeard/glass
```

What the flags do:

- `-p 127.0.0.1:8080:8080`: the HTTP API, reachable only from this machine.
- `-p 50000:50000/udp`: WebRTC media. Without it, connections hang.
- `--shm-size=1g`: shared memory for Chrome.
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

## 4. A relay stream from your camera

In another terminal, serve the repository root:

```sh
npx serve .     # from the glass-engine directory
```

Open `http://localhost:3000/examples/quickstart/relay.html` and click **Start
camera**. The page creates a relay session, publishes your camera into it with
`GlassProducer`, and shows a watch link. Open the link in another tab: that
tab is a viewer, receiving your camera through Glass.

No browser runs in Glass for this. It forwards the camera's encoded stream to
each viewer as it arrives. Close the producer tab and watch the viewer: its
status changes to `stalled`, and the last frame stays on screen.

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
  -p 8080:8080 -p 50000:50000/udp --shm-size=1g \
  -e GLASS_API_TOKEN \
  -e GLASS_WEBRTC_NAT_1TO1_IPS=127.0.0.1 \
  ghcr.io/majorbeard/glass
```

Now every API call needs the token:

```sh
curl -X POST -H "Authorization: Bearer $GLASS_API_TOKEN" http://localhost:8080/v1/sessions
```

The response's `signalingUrl` carries its own per-session token, and that URL
is all a client needs. That is how a real application is built:

1. Your backend holds `GLASS_API_TOKEN` and creates sessions, relay sessions
   and calls.
2. It gives each client only the URL that client should use: a
   `signalingUrl` for a viewer, a `produceUrl` for a producer, a peer URL for
   a call participant, or a minted watch-only URL for a guest.
3. It deletes sessions when users are done.

The reference viewer can take a token for local testing
(`VITE_GLASS_API_TOKEN`). A real frontend never should: anything in a
frontend bundle is public.

## Next

- [concepts.md](concepts.md): the session model behind all of this.
- [sources/](sources/): the details of each source.
- [deployment.md](deployment.md): running Glass on a server.
