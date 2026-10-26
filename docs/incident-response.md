# Incident response

What to do when a credential leaks, written to be followed under pressure.
Each section starts with the steps, then explains them. The commands assume
the container is named `glass` and runs with the `docker run` command from
[deployment.md](deployment.md#docker), env file `/etc/glass/env`.

**Changing a setting means recreating the container.** Docker reads
`--env-file` only when a container is created, so `docker restart` keeps
the old value. Recreate with the same command you deploy with:

```sh
docker rm -f glass
docker run -d --name glass ... --env-file /etc/glass/env ghcr.io/majorbeard/glass:<version>
```

Recreating ends every session: each viewer sees the session close and needs
a new link. In an incident that is usually what you want.

**The CLI inside the container** sends the container's own API token, so
these work without copying it anywhere:

```sh
docker exec glass glass session list                  # what runs now; no links
docker exec glass glass session revoke '<link URL>'   # end one link
docker exec glass glass session close <id>            # end one session
```

## Which credential leaked?

| What leaked | Reach | Do |
|---|---|---|
| A watch link or other link you minted, a relay session's `signalingUrl` or `produceUrl` | That one session, as far as the link allows | [Revoke the link](#a-link-leaked) |
| A browser session's own link (`signalingUrl` from `POST /v1/sessions`) | Control of that session | [Close the session](#a-sessions-own-link-leaked) |
| The API token (`GLASS_API_TOKEN`) | Everything: create, read and close any session | [Replace the token](#the-api-token-leaked) |
| The ticket secret (`GLASS_TICKET_SECRET`) | Start sessions, as many as capacity allows | [Replace the secret](#the-ticket-secret-leaked) |
| The TURN secret (`GLASS_TURN_SECRET`) | Use your TURN server as a relay | [Replace the secret](#the-turn-secret-leaked) |
| The licence key (`GLASS_LICENSE_KEY`) | Your licence, used elsewhere | [Reissue it](#the-licence-key-leaked) |
| Shell or root on the host | Everything above | [Rebuild the host](#the-host-is-compromised) |

## A link leaked

```sh
docker exec glass glass session revoke '<the leaked URL>'
```

The URL can be the link itself (`wss://…/signaling?token=…`, a `produceUrl`)
or a viewer URL that carries one (`attachSignalingUrl=…`). The link admits
nothing again, a reconnect included. Anyone connected with it is closed with
close code `4403`, which `@glass/client` treats as final ("this link has been
revoked"). Everyone else in the session carries on. If the leaked link was
the session's last connection, the session ends as on any close.

From your backend, without the URL: the response that minted the link
carries its `linkId`; revoke with `DELETE /v1/sessions/{id}/connections/{linkId}`
(or `/v1/relay-sessions/...`). See
[protocol.md](protocol.md#browser-sessions).

A link also stops admitting new connections on its own when it expires
(24 hours by default, [protocol.md](protocol.md#link-expiry)); revoking ends
it now, and ends what already joined with it.

## A session's own link leaked

```sh
docker exec glass glass session list         # find the session
docker exec glass glass session close <id>
```

A browser session's own link is the owner's and can't be revoked
separately: closing the session ends it. A call's peer links end with the
call (`DELETE /v1/calls/{id}`). A relay session's links, its
`signalingUrl` included, are revoked like any other
([A link leaked](#a-link-leaked)).

## The API token leaked

1. Make a new token: `openssl rand -hex 32`.
2. Replace `GLASS_API_TOKEN` in `/etc/glass/env` with it. In an incident,
   replace it outright; don't list the old one after it.
3. Recreate the container. Every session ends, including any the holder of
   the old token created, and so does every link they minted.
4. Give your backend the new token.
5. Check: `docker exec glass glass session list` shows only what your
   backend has started since, and a request with the old token gets `401`.

What the old token could have done until then: start and close sessions,
mint links, inject input and, on sessions created with `"inspect": true`,
read the page. It could not read your other secrets: the ticket secret, the
TURN secret and the licence key are never sent by Glass. Each session's
creation and close is in the log, by session ID
(`docker logs glass | grep -E "(Created|Closed) session"`).

For a planned rotation, see [Rotating the API token](deployment.md#authentication):
the old token stays listed after the new one until your backend has moved.

## The ticket secret leaked

1. Make a new secret and put it in your backend and in
   `GLASS_TICKET_SECRET` (replace it outright).
2. Recreate the container.

Tickets signed with the old secret are refused at once. A ticket was only
ever good for 10 minutes and once, so nothing signed before the leak
outlives the secret. If tickets are not used at all, unset
`GLASS_TICKET_SECRET`: `POST /v1/tickets` then does not exist.

## The TURN secret leaked

On the TURN server (coturn with `use-auth-secret`, as in
[deployment.md](deployment.md#turn)), with a new secret:

```sh
sudo turnadmin -s <new> -r <realm>
```

Then set `GLASS_TURN_SECRET=<new>` in `/etc/glass/env`, recreate the
container, and delete the old secret straight away (in a planned rotation
you would wait out `GLASS_TURN_CREDENTIAL_TTL_HOURS`; here you don't):

```sh
sudo turnadmin --delete-secret=<old> -r <realm>
```

A credential minted from the old secret can then start no new relay, and a
relay already open with one ends at its next refresh (coturn's allocation
lifetime, 10 minutes by default). A TURN credential only relays traffic: it
opens no Glass session.

## The licence key leaked

Reissue the key where you bought it (your licence portal), put the new one
in `GLASS_LICENSE_KEY`, and recreate the container. The key identifies you
to the licensing service; it opens nothing in Glass, and Glass never logs
it.

## The host is compromised

Assume every secret in `/etc/glass/env` and on the TURN server is known.
Build a new host, make new values for all of them (API token, ticket
secret, TURN secret; reissue the licence key), and move your backend to the
new host. Don't reuse the old host's disk.

## Rotating on a schedule

Glass can't expire secrets it doesn't issue, so how often is yours to set.
A reasonable default:

- **Every 90 days**, and whenever someone who knew a secret leaves: the API
  token, the ticket secret and the TURN secret.
- **Do it when you update the image.** An update recreates the container
  anyway, so a rotation then ends no extra sessions. For the API token and
  the ticket secret, list the new value first and the old one after it for
  one update, then drop the old one at the next (both are comma-separated
  lists); for TURN, add the new secret, switch Glass, and delete the old one
  after `GLASS_TURN_CREDENTIAL_TTL_HOURS`.
- **Links need nothing:** they expire on their own (`GLASS_LINK_TTL_HOURS`,
  24 hours by default).
