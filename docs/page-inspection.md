# Page inspection

A hosted-browser session streams pixels. Page inspection lets your backend
also read what is on the page (its controls, their names, where they are, what
has focus) and watch what happens on it, through Glass's API.

Glass gives you **primitives**: read the page, find what is at a point, scroll
something into view, send input, watch events. It makes no decisions about the
page. How to click reliably, when a page counts as settled, what to do about a
cookie banner: that is yours, built from these calls. The recipes at the end
show how.

Read [concepts.md](concepts.md) and [sources/browser.md](sources/browser.md)
first.

## Turning it on

Inspection is **off** unless you ask for it, per session:

```http
POST /v1/sessions
{"inspect": true}
```

or `createGlassSession(baseUrl, apiToken, { inspect: true })`. The session's
`capabilities.inspect` says whether its source can be inspected at all (the
hosted browser can).

- Every `/page` route takes the **API token** only. A session's own URL, or a
  viewer's grant, never opens it: inspection is for your backend, not for the
  people watching.
- Nothing runs between calls. A snapshot reads the page once and stops; an
  event kind that costs anything is watched only while a stream asks for it.

## Reading the page

### Snapshot

```http
GET /v1/sessions/{id}/page/snapshot?scope=viewport
```

The page's accessibility tree: what the page means (a button named "Log in",
a text field named "Email") rather than how its HTML is built. It is Chrome's
own computed tree, the one screen readers use, for the page and every frame in
it, cross-origin frames included.

```json
{
  "root": {"ref": "e1", "role": "RootWebArea", "name": "Sign in",
           "bounds": {"x": 0, "y": 0, "width": 1280, "height": 800},
           "children": [
             {"ref": "e6", "role": "textbox", "name": "Email", "states": {"focused": true},
              "bounds": {"x": 40, "y": 180, "width": 320, "height": 36}},
             {"ref": "e9", "role": "button", "name": "Log in",
              "bounds": {"x": 40, "y": 240, "width": 120, "height": 36}}
           ]},
  "viewport": {"x": 0, "y": 0, "width": 1280, "height": 800},
  "scope": "viewport",
  "nodeCount": 3
}
```

Each node has a `ref`, a `role`, a `name` and `description`, `states`
(`focused`, `disabled`, `checked`, `expanded`, `selected`, `level`, `url`, ...)
and `bounds` in CSS pixels **on the viewport**, the same coordinates as the
streamed picture and as input.

| Parameter | |
|---|---|
| `scope` | `viewport` (default): only what is on screen. `page`: the whole document. |
| `prune` | Default: only what a person would perceive or use (controls, landmarks, headings, text). `none`: every node, ignored ones marked `"ignored": true`. |
| `values` | `true`: form fields' current values. Off by default. |
| `root` | A ref: only that subtree. |
| `maxNodes` | 1 to 5000, default 1000. A snapshot cut short says so in `truncated` (`maxNodes`, or `time` past its 5 s budget). |

**What a snapshot never contains:**

- **A password**, even with `values=true`: not its value, and not its masked
  length.
- **What a person typed**, unless you ask with `values=true`: a field's text is
  its value.

### Refs

A `ref` names one node for later calls. It stays the same while the node
exists and keeps its role and name, and it is never reused. Once the page
navigates, or the node is removed or changes what it is, the ref is **stale**:
calls with it answer `409` with `"code": "stale_ref"`. A stale ref is never
quietly matched to another node.

### Query

```http
POST /v1/sessions/{id}/page/query
{"role": "button", "name": "log in"}
```

The snapshot's nodes that match a role, a name, or both (the name is a
case-insensitive substring unless `"exact": true`), without their children.
`scope` defaults to `page` here; `values` and `maxResults` (default 50) as
above.

## Primitives

Each is one mechanical step.

| Call | Answers |
|---|---|
| `GET /page/at?x=&y=` | The node at that point of the viewport, then its ancestors up to the page's root, through frames: `{"x", "y", "path": [...]}`. |
| `GET /page/node?ref=` | Where the node is now: `{"node", "quads", "bounds", "inViewport"}`. `quads` are its boxes, each `[x1, y1, x2, y2, x3, y3, x4, y4]`; an element that wraps across lines or is clipped has several. |
| `POST /page/scroll {"ref"}` | Scrolls the node into view (and its frames into theirs), then answers as `/page/node`. |
| `GET /page/state` | `{"url", "title", "viewport", "scrollX", "scrollY", "focus"}`; `focus` is the focused node, through frames. While a JavaScript dialog is open it answers `409` with `"code": "dialog_open"` at once: the dialog blocks the page's script. |

All are under `/v1/sessions/{id}`, with the same rules as the snapshot.

## Acting

There is no "click this ref" call. You act with **real input**, the same input
a person's mouse and keyboard produce, so the page cannot tell the difference
and everyone watching the stream sees it happen:

```http
POST /v1/sessions/{id}/input
{"type": "mousedown", "data": {"x": 100, "y": 258, "button": "left", "clickCount": 1},
 "floor": true, "wait": 2000}
```

The event types and their fields are the input messages in
[protocol.md](protocol.md). `"floor": true` makes your backend one more
controller of the page:

- In the default input mode, one controller drives at a time
  ([concepts.md](concepts.md#several-people-in-control)). If a person is
  driving, your input waits up to `wait` ms (default 2000, at most 10000) for
  them to pause, then answers `409` with `"code": "floor_taken"` and who holds
  the page. A person in the middle of a drag is never interrupted.
- Keys or buttons your backend holds down are released after 5 s without
  input from it.
- Without `"floor": true`, input goes straight to the page, whoever is driving:
  an operator's override.

## Watching

```http
GET /v1/sessions/{id}/page/events?kinds=navigation,pixels,network,structure
```

Server-Sent Events. Each event is the page's **current state** for the kinds
you asked for, as counters and values, with `seq` counting changes. Changes are
coalesced to at most one event every 100 ms, and each event carries the current
values, so a missed event or a reconnect loses nothing.

```json
{"seq": 41,
 "navigation": {"seq": 2, "url": "https://example.com/next", "loading": false, "loads": 2},
 "pixels": {"version": 318},
 "network": {"inflight": 0, "started": 24, "finished": 24},
 "structure": {"version": 12}}
```

| Kind | Fields | Counts |
|---|---|---|
| `navigation` | `seq`, `url`, `loading`, `loads` | navigations of the page, and their loads |
| `pixels` | `version` | changes of the picture itself (on a display, the X server's own damage reports): a still page does not count up |
| `network` | `inflight`, `started`, `finished` | the page's requests |
| `structure` | `version` | changes to the page's DOM |
| `focus` | `version` | focus moving |
| `dialog` | `open`, `type`, `message`, `defaultPrompt`, `seq` | `alert`, `confirm`, `prompt` and leave-page (`beforeunload`) dialogs |
| `popups` | `version` | new tabs the page asked for |
| `floor` | `holder` | who is driving the page |

Without `kinds` you get navigation, pixels, dialog, popups and floor, which cost
nothing extra. `network`, `structure` and `focus` are watched only while a
stream asks for them; `structure` and `focus` are observed out of the page's
reach, so its scripts cannot see the observer, and it changes nothing. They
cover the main page, not its frames.

## Recipes

### A reliable click

```text
1. POST /page/scroll {ref}          -> quads, inViewport
2. pick a point: the centre of the first quad with real area
3. GET /page/at?x&y                 -> path
4. is ref in the path?  no -> something covers it (see below)
5. POST /input mousedown + mouseup at the point, "floor": true
```

Why each step: the element may be off screen; its first box may be a sliver
(a link wrapping across two lines has two boxes, and the gap between them
belongs to nothing); and something may be drawn on top of it: a badge over
part of a card, a banner, a full-screen backdrop.

### When something covers the element

`path[0]` is what is on top. Your options, by what it is:

- A small badge over part of the element: try other points across its quad
  (edges, corners) and click the first whose path contains your ref.
- A dialog or banner: it is in the snapshot with its buttons; close it (or
  accept it) by clicking one, if that is the right thing for your app.
- A full-screen backdrop: clicking near its corner often dismisses it.

Glass does none of these for you, on purpose: each is a decision about the
page.

### Typing into a field

Click the field (as above), then send `keydown`/`keyup` per character. A real
key event matters: some sites act only on trusted input, so pressing Enter by
script does nothing where a real Enter submits. Confirm with `/page/state`
(focus on your field) and a query with `"values": true`.

### Waiting until the page has settled

A page is not ready when its load event fires: content arrives by request
after it, and menus fill in bursts. One rule that works, from the events
stream:

- `navigation.loading` is `false`, and
- `network.inflight` has been `0` for 500 ms (cap the wait at about 5 s, as
  some pages poll forever), and
- `structure.version` has not changed across three reads 400 ms apart. Two can
  catch a half-loaded menu between its two bursts.

Other clients will want other rules; the stream gives you the numbers for any
of them. `pixels` tells you when the picture itself has stopped changing.

### Dialogs

`dialog.open` turns `true` when the page opens an `alert`, `confirm`, `prompt`
or leave-page dialog, with its `type`, the page's `message` and, for a
prompt, its `defaultPrompt`. The page's scripts wait until it is answered.
Dialogs opened by the page's frames, cross-origin ones included, are reported
the same way.

```http
POST /v1/sessions/{id}/page/dialog
{"accept": true, "text": "an answer"}
```

`accept` is OK (`true`) or Cancel (`false`); `text` answers a prompt. `200`
when answered, `409` with `"code": "no_dialog"` when none is open (someone
else may have answered first). Like input, it can take the floor first:
`"floor": true`, with `"wait"`, answers `409` `floor_taken` if a person is
driving the page. On a display (every capture method but the screencast) a
viewer sees Chrome's own dialog and may be answering it too.

What to answer is your decision; Glass never answers on its own. A
leave-page dialog has an empty `message` (browsers show their own text). It
appears when the page leaves by itself, for a link or a script; when you
navigate the session, Glass replaces the page without asking it.

## Limits

- Hosted-browser sessions only; relay and call sessions have no page.
- A snapshot of a very large page costs up to a few hundred milliseconds (a
  long encyclopedia article: about 0.5 s for 865 nodes).
- Clickable elements with no link, button or role (a card with only a script
  click handler) are not kept as their own nodes by the default pruning; their
  text and images are. `prune=none` returns them.
- The events stream's `network`, `structure` and `focus` cover the main page,
  not its frames.
