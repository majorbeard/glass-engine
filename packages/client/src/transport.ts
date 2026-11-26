// The peer connection, its DataChannels, and the two inbound paths:
// binary DataChannel messages and signaling messages. See GlassClient (index.ts) for the public API.

import type { ClientCore, SourceState } from "./core";
import * as drops from "./drops";
import * as lifecycle from "./lifecycle";
import * as handoff from "./handoff";
import * as mic from "./mic";
import * as statsTrace from "./stats_trace";
import type { ElementState, GlassDialog, GlassMember, GlassRights, GlassSourceInfo, GlassTimelineEvent, InteractiveElement, NavigationState } from "./types";
import { EncodedStreamChecker } from "./encoded_stream_check";
import { startRepairWait } from "./repair_wait";
import * as publish from "./publish";
import { withStartBitrate } from "./sdp";

// Binary DataChannel message types pushed from the engine. Must match
// docs/protocol.md.
const enum MessageType {
  ElementStateUpdate = 0x05,
  NavigationState = 0x06,
  // Which numbered inputs a frame followed (see input_latency.ts).
  InputFrame = 0x04,
  ViewportSize = 0x07,
  // Glass asks for this client's clock reading (answerClockProbe).
  ClockProbe = 0x08,
  ClipboardText = 0x09,
  InteractiveElements = 0x0a,
  ConsoleMessage = 0x0b,
  // Carries filename+guid only - never the file itself.
  DownloadReady = 0x0c,
  FileChooserOpened = 0x0d,
  FileChooserClosed = 0x0e,
  MicAccessRequested = 0x0f,
  InputDropped = 0x10,
  // The page's JavaScript dialog opened or closed.
  Dialog = 0x11,
  Error = 0xff,
}

export function initPeerConnection(c: ClientCore, onConnectedThisAttempt: () => void): void {
  if (c.pc) return;
  const pc = new RTCPeerConnection({
    iceServers: c.iceServersGiven ? c.iceServers : (c.serverIceServers ?? c.iceServers),
    ...(c.iceTransportPolicy
      ? { iceTransportPolicy: c.iceTransportPolicy }
      : {}),
  });
  c.pc = pc;

  pc.ontrack = (event) => {
    // Chromium buffers a few frames by default even in low-latency mode;
    // these non-standard receiver hints ask for near-zero playout delay,
    // appropriate for a genuinely real-time (not prerecorded) track.
    const receiver = event.receiver as RTCRtpReceiver & {
      playoutDelayHint?: number;
      jitterBufferTarget?: number;
    };
    if (receiver && c.jitterBufferTargetMs !== "native") {
      try {
        receiver.playoutDelayHint = c.jitterBufferTargetMs / 1000;
        receiver.jitterBufferTarget = c.jitterBufferTargetMs;
      } catch {
        // non-Chromium browser - ignore
      }
    }
    // "native": deliberately does nothing here - see
    // InternalGlassClientOptions.__internalJitterBufferTargetMs's own
    // doc comment for why leaving both hints untouched is the point.
    // The repair wait raises the video target from 0 only on a long, lossy
    // path; an internal override of the target turns it off.
    if (event.track.kind === "video" && c.repairWait && c.jitterBufferTargetMs === 0) {
      startRepairWait(c, event.receiver);
    }
    // Video-only: EncodedStreamChecker inspects encoded frame hashes for
    // the video-decode-corruption detection it exists for (see its own
    // doc comment) - meaningless against an Opus receiver. Without this
    // guard, whichever track's ontrack fires first (now that a session
    // can carry both) would claim the "only one checker, ever" slot via
    // !this.encodedStreamChecker, silently starving video of it forever
    // if audio's ontrack happened to fire first.
    if (
      event.track.kind === "video" &&
      c._encodedStreamCheckEnabled &&
      event.receiver &&
      !c.encodedStreamChecker
    ) {
      c.encodedStreamChecker = new EncodedStreamChecker(event.receiver, (reports) => {
        sendInput(c, "encoded_frame_report", { reports });
      });
      c.encodedStreamChecker.start();
    }
    // An idle receive line fires a track too: only a line Glass has mapped to
    // a source ("tracks") joins that source's stream; one not yet mapped
    // waits for its mapping.
    const mid = event.transceiver?.mid;
    if (!mid) return;
    const source = c.mids.get(mid);
    if (source === undefined) {
      c.pendingTracks.set(mid, event.track);
      return;
    }
    addToSource(c, source, event.track);
  };

  pc.ondatachannel = (event) => {
    // Two channels arrive here ("frames" and "frames-input-fast") -
    // key by label rather than assuming arrival order, which isn't
    // guaranteed between two independently-created channels. The fast
    // channel is send-only from this side (backend never writes to it),
    // so it gets no setupDataChannel()/onmessage wiring.
    if (event.channel.label === "frames-input-fast") {
      c.fastDataChannel = event.channel;
    } else {
      c.dataChannel = event.channel;
      setupDataChannel(c);
    }
  };

  pc.onicecandidate = (event) => {
    if (event.candidate && c.ws && c.signalingConnected) {
      c.ws.send(
        JSON.stringify({
          type: "ice-candidate",
          candidate: event.candidate.toJSON(),
        })
      );
    }
  };

  pc.onconnectionstatechange = () => {
    const state = c.pc?.connectionState;
    if (state === "connected") {
      // Recovered (or connected for the first time) - cancel any pending
      // give-up timer armed by an earlier "disconnected".
      lifecycle.cancelDisconnectedGrace(c);
      if (!c.peerConnected) {
        c.peerConnected = true;
        c.reconnectAttempt = 0;
        c.emit("connected");
        publish.onConnected(c);
        onConnectedThisAttempt();
        statsTrace.startStatsPollingIfEnabled(c);
        statsTrace.startInternalTraceReportingIfEnabled(c);
      }
    } else if (state === "failed") {
      // Terminal per spec - no point waiting.
      lifecycle.cancelDisconnectedGrace(c);
      if (c.peerConnected) {
        lifecycle.onTerminalDrop(c);
      }
    } else if (state === "disconnected") {
      // Usually transient. Give it a bounded window to recover on its own
      // before falling back to a full reconnect.
      if (c.peerConnected) {
        lifecycle.scheduleDisconnectedGrace(c);
      }
    } else if (state === "closed") {
      lifecycle.cancelDisconnectedGrace(c);
      if (c.peerConnected) {
        lifecycle.onTerminalDrop(c);
      }
    }
  };
}

export function setupDataChannel(c: ClientCore): void {
  const dc = c.dataChannel;
  if (!dc) return;
  dc.binaryType = "arraybuffer";
  dc.onmessage = (event) => {
    if (event.data instanceof ArrayBuffer) {
      handleBinaryMessage(c, event.data);
    }
  };
}

// sourceOf is the source a DataChannel message names (protocol v3: each
// message about a source names it, the first source's included).
function sourceOf(body: unknown): string {
  const s = (body as { source?: unknown } | null)?.source;
  return typeof s === "string" ? s : "";
}

export function handleBinaryMessage(c: ClientCore, data: ArrayBuffer): void {
  if (data.byteLength < 1) return;
  const view = new DataView(data);
  const messageType = view.getUint8(0);
  const offset = 1;
  const decoder = new TextDecoder();
  try {
    switch (messageType) {
      case MessageType.NavigationState:
        if (data.byteLength > offset) {
          const nav: NavigationState & { source?: string } = JSON.parse(
            decoder.decode(new Uint8Array(view.buffer, offset))
          );
          const source = sourceOf(nav);
          delete nav.source;
          c.emit("navigation", nav, source);
        }
        break;
      case MessageType.ElementStateUpdate:
        if (data.byteLength > offset) {
          const state: ElementState & { source?: string } = JSON.parse(
            decoder.decode(new Uint8Array(view.buffer, offset))
          );
          const source = sourceOf(state);
          delete state.source;
          c.emit("elementState", state, source);
        }
        break;
      case MessageType.ViewportSize:
        // Backend echo of the applied viewport; not surfaced today.
        break;
      case MessageType.InteractiveElements:
        if (data.byteLength > offset) {
          const parsed: { elements?: InteractiveElement[] } = JSON.parse(
            decoder.decode(new Uint8Array(view.buffer, offset))
          );
          c.emit("interactiveElements", parsed.elements || [], sourceOf(parsed));
        }
        break;
      case MessageType.ClipboardText:
        if (data.byteLength > offset) {
          const parsed: { text?: string } = JSON.parse(
            decoder.decode(new Uint8Array(view.buffer, offset))
          );
          c.emit("clipboardText", parsed.text || "", sourceOf(parsed));
        }
        break;
      case MessageType.ConsoleMessage:
        if (data.byteLength > offset) {
          const parsed: { level?: string; text?: string } = JSON.parse(
            decoder.decode(new Uint8Array(view.buffer, offset))
          );
          c.emit("consoleMessage", parsed.level || "log", parsed.text || "", sourceOf(parsed));
        }
        break;
      case MessageType.DownloadReady:
        if (data.byteLength > offset) {
          const parsed: { filename?: string; guid?: string } = JSON.parse(
            decoder.decode(new Uint8Array(view.buffer, offset))
          );
          if (parsed.guid) {
            c.emit("downloadReady", parsed.filename || "download", parsed.guid, sourceOf(parsed));
          }
        }
        break;
      case MessageType.FileChooserOpened:
        if (data.byteLength > offset) {
          const parsed: { multiple?: boolean } = JSON.parse(
            decoder.decode(new Uint8Array(view.buffer, offset))
          );
          c.emit("fileChooserOpened", !!parsed.multiple, sourceOf(parsed));
        }
        break;
      case MessageType.FileChooserClosed: {
        const parsed = data.byteLength > offset ? JSON.parse(decoder.decode(new Uint8Array(view.buffer, offset))) : {};
        c.emit("fileChooserClosed", sourceOf(parsed));
        break;
      }
      case MessageType.InputFrame:
        if (data.byteLength > offset) {
          const parsed: { f?: number; i?: { s: number }[] } = JSON.parse(
            decoder.decode(new Uint8Array(view.buffer, offset))
          );
          if (typeof parsed.f === "number" && Array.isArray(parsed.i)) {
            c.inputLatency.onInputFrame(parsed.f, parsed.i);
          }
        }
        break;
      case MessageType.ClockProbe:
        if (data.byteLength > offset) {
          const parsed: { id?: number } = JSON.parse(
            decoder.decode(new Uint8Array(view.buffer, offset))
          );
          answerClockProbe(c, "datachannel", Number(parsed.id));
        }
        break;
      case MessageType.MicAccessRequested:
        if (data.byteLength > offset) {
          const parsed: { origin?: string } = JSON.parse(
            decoder.decode(new Uint8Array(view.buffer, offset))
          );
          c.emit("micAccessRequested", parsed.origin || "", sourceOf(parsed));
        }
        break;
      case MessageType.InputDropped:
        if (data.byteLength > offset) {
          drops.onServerDrop(c, JSON.parse(decoder.decode(new Uint8Array(view.buffer, offset))));
        }
        break;
      case MessageType.Dialog:
        if (data.byteLength > offset) {
          const parsed: GlassDialog & { source?: string } = JSON.parse(decoder.decode(new Uint8Array(view.buffer, offset)));
          const source = sourceOf(parsed);
          delete parsed.source;
          const d: GlassDialog = { ...parsed, open: !!parsed.open, inPicture: !!parsed.inPicture };
          const st = c.sources.get(source);
          if (st) st.dialog = d.open ? d : null;
          c.emit("dialog", d, source);
        }
        break;
      case MessageType.Error:
        if (data.byteLength > offset) {
          const parsed: { error?: string; code?: string } = JSON.parse(
            decoder.decode(new Uint8Array(view.buffer, offset))
          );
          c.emit("error", parsed.error || "Unknown server error", parsed.code);
        }
        break;
    }
  } catch {
    // malformed message - ignore rather than tear down the channel
  }
}

// addToSource adds a received track to its source's stream and tells the
// application. The stream is the source's own, kept across tracks, so a
// <video> bound to it plays its picture and its sound alike.
function addToSource(c: ClientCore, sourceId: string, track: MediaStreamTrack): void {
  const st = c.sources.get(sourceId);
  if (!st) return;
  if (!st.stream) st.stream = new MediaStream();
  st.stream.addTrack(track);
  c.emit("track", sourceId, st.stream);
}

// Receive lines a connection opens with: three of each kind, as LiveKit's
// single connection does; Glass asks for more with slots_needed.
const START_VIDEO = 3;
const START_AUDIO = 3;

function addReceiveLines(pc: RTCPeerConnection, video: number, audio: number): void {
  for (let i = 0; i < video; i++) pc.addTransceiver("video", { direction: "recvonly" });
  for (let i = 0; i < audio; i++) pc.addTransceiver("audio", { direction: "recvonly" });
}

// offer makes and sends an offer, after any offer before it: on hello, when
// Glass asks for more lines, and when this client publishes.
export function offer(c: ClientCore): void {
  c.negotiation = c.negotiation
    .then(async () => {
      const pc = c.pc;
      if (!pc) return;
      const o = await pc.createOffer();
      await pc.setLocalDescription(o);
      // What this connection publishes is announced before the offer that
      // carries it: the microphone a hosted browser takes, and each track
      // published.
      const micLine = c.micSender && pc.getTransceivers().find((t) => t.sender === c.micSender);
      if (micLine?.mid) c.ws?.send(JSON.stringify({ type: "publish", mid: micLine.mid, kind: "microphone" }));
      publish.announce(c);
      c.ws?.send(JSON.stringify({ type: "offer", sdp: o.sdp || "" }));
    })
    .catch(() => undefined);
}

// answerSdp is Glass's answer with the rate a published picture's congestion
// control starts from (Chromium's x-google-start-bitrate): without it a
// camera starts low and takes seconds to climb.
function answerSdp(c: ClientCore, sdp: string): string {
  const pictures = c.publications.filter((p) => p.track.kind === "video");
  if (pictures.length === 0) return sdp;
  return withStartBitrate(sdp, Math.min(...pictures.map((p) => p.startBitrateKbps)));
}

// sourceInfo reads a source as the engine describes it, or null for one
// without an id.
function sourceInfo(raw: unknown): GlassSourceInfo | null {
  const r = raw as Partial<GlassSourceInfo> | null;
  if (!r || typeof r.id !== "string" || r.id === "") return null;
  return {
    ...r,
    id: r.id,
    kind: String(r.kind ?? ""),
    state: r.state === "stalled" || r.state === "ended" ? r.state : "live",
    capabilities: r.capabilities ?? {},
    inputMode: r.inputMode === "free" ? "free" : "floor",
    inspect: !!r.inspect,
  };
}

// putSource adds a source or updates its description, telling the
// application which.
function putSource(c: ClientCore, info: GlassSourceInfo): void {
  const st = c.sources.get(info.id);
  if (st) {
    st.info = info;
    c.emit("sourceUpdated", { ...info });
    return;
  }
  const fresh: SourceState = { info, stream: null, holders: [], floor: null, dialog: null, playback: null };
  c.sources.set(info.id, fresh);
  c.emit("sourceAdded", { ...info });
}

function removeSource(c: ClientCore, id: string, reason: string): void {
  const st = c.sources.get(id);
  if (!st) return;
  c.sources.delete(id);
  for (const [mid, src] of c.mids) if (src === id) c.mids.delete(mid);
  c.emit("sourceRemoved", id, reason);
}

// onHello takes the first message: who this connection is, what its link may
// do, the session's sources, and for an owner the other members. A
// reconnect's hello replaces what the last one said: a source the engine no
// longer lists has gone.
function onHello(c: ClientCore, pc: RTCPeerConnection, signal: any): void {
  if (typeof signal.connectionId === "string") c._connectionId = signal.connectionId;
  c._owner = signal.owner === true;
  c._rights = (signal.rights ?? null) as GlassRights | null;
  const listed = new Set<string>();
  for (const raw of Array.isArray(signal.sources) ? signal.sources : []) {
    const info = sourceInfo(raw);
    if (!info) continue;
    listed.add(info.id);
    putSource(c, info);
  }
  for (const id of [...c.sources.keys()]) if (!listed.has(id)) removeSource(c, id, "gone");
  c._members = new Map();
  for (const raw of Array.isArray(signal.members) ? signal.members : []) {
    const m = raw as GlassMember;
    if (m && typeof m.connectionId === "string") c._members.set(m.connectionId, { connectionId: m.connectionId, owner: !!m.owner, rights: m.rights });
  }
  c.emit("hello", c._connectionId ?? "", c._owner);
  if (c._owner) c.emit("membersChanged", handoff.members(c));
  if (c._rights?.watch !== "none") addReceiveLines(pc, START_VIDEO, START_AUDIO);
  // The microphone a hosted browser takes from its member: a silent
  // placeholder, published as this member's microphone, that grantMicAccess()
  // replaces with the real one. Only where a browser is there to take it.
  if ([...c.sources.values()].some((st) => st.info.kind === "browser")) mic.attachMicPlaceholder(c, pc, true);
  // What this client publishes, on the new connection.
  for (const pub of c.publications) publish.attach(c, pub);
  // Glass opens its data channels on the client's data section; this one makes it.
  pc.createDataChannel("glass-client");
  offer(c);
}

async function flushCandidates(c: ClientCore, pc: RTCPeerConnection): Promise<void> {
  while (c.iceCandidateQueue.length > 0) {
    const candidate = c.iceCandidateQueue.shift();
    if (candidate) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch {
        // ignore a single bad queued candidate
      }
    }
  }
}

export async function handleSignal(c: ClientCore, signal: any): Promise<void> {
  const pc = c.pc;
  if (!pc) return;
  try {
    switch (signal.type) {
      case "hello":
        onHello(c, pc, signal);
        break;
      case "answer":
        c.negotiation = c.negotiation.then(async () => {
          await pc.setRemoteDescription({ type: "answer", sdp: answerSdp(c, String(signal.sdp ?? "")) });
          await flushCandidates(c, pc);
        }).catch(() => undefined);
        break;
      case "tracks":
        if (Array.isArray(signal.tracks)) {
          for (const t of signal.tracks) {
            if (t && typeof t.mid === "string") c.mids.set(t.mid, String(t.source ?? ""));
          }
          for (const [mid, track] of c.pendingTracks) {
            const source = c.mids.get(mid);
            if (source !== undefined) {
              c.pendingTracks.delete(mid);
              addToSource(c, source, track);
            }
          }
        }
        break;
      case "slots_needed":
        addReceiveLines(pc, Number(signal.video) || 0, Number(signal.audio) || 0);
        offer(c);
        break;
      case "ice-candidate":
        if (signal.candidate && signal.candidate.candidate) {
          const candidate = new RTCIceCandidate(signal.candidate);
          if (pc.remoteDescription) {
            try {
              await pc.addIceCandidate(candidate);
            } catch {
              // ignore
            }
          } else {
            c.iceCandidateQueue.push(signal.candidate);
          }
        }
        break;
      case "source_added":
      case "source_updated": {
        const info = sourceInfo(signal.source);
        if (info) putSource(c, info);
        break;
      }
      case "source_removed":
        removeSource(c, String(signal.id ?? ""), String(signal.reason ?? ""));
        break;
      case "rights_changed":
        c._rights = (signal.rights ?? c._rights) as GlassRights | null;
        c._deniedWatch = Array.isArray(signal.denied?.watch) ? signal.denied.watch.map(String) : [];
        c._deniedControl = Array.isArray(signal.denied?.control) ? signal.denied.control.map(String) : [];
        {
          const r = handoff.rights(c);
          if (r) c.emit("rightsChanged", r);
        }
        break;
      // docs/protocol.md's "Control handoff" section.
      case "input_holders": {
        const source = String(signal.source ?? "");
        const st = c.sources.get(source);
        if (!st) break;
        st.holders = Array.isArray(signal.holders) ? signal.holders.map(String) : [];
        st.floor = typeof signal.floor === "string" && signal.floor !== "" ? signal.floor : null;
        c.emit("inputHolders", source, [...st.holders], st.floor);
        break;
      }
      case "input_requested":
        c.emit("inputRequested", String(signal.connectionId ?? ""), String(signal.source ?? ""));
        break;
      case "control_answer":
        handoff.answerControl(c, signal);
        break;
      case "member_joined": {
        const m = signal as GlassMember;
        if (typeof m.connectionId === "string" && m.connectionId !== "") {
          c._members.set(m.connectionId, { connectionId: m.connectionId, owner: !!m.owner, rights: m.rights });
          c.emit("membersChanged", handoff.members(c));
        }
        break;
      }
      case "member_left":
        if (c._members.delete(String(signal.connectionId ?? ""))) c.emit("membersChanged", handoff.members(c));
        break;
      case "recording":
        c._recording = signal.active === true;
        c.emit("recording", c._recording);
        break;
      case "playback": {
        const source = String(signal.source ?? "");
        const st = c.sources.get(source);
        const state = {
          playing: signal.playing === true,
          positionMs: Number(signal.positionMs) || 0,
          durationMs: Number(signal.durationMs) || 0,
          ended: signal.ended === true,
        };
        if (st) st.playback = state;
        c.emit("playback", state, source);
        break;
      }
      case "timeline":
        if (signal.event && typeof signal.event === "object") {
          c.emit("timeline", signal.event as GlassTimelineEvent, String(signal.source ?? ""));
        }
        break;
      case "new_tab_request":
        if (typeof signal.url === "string") {
          c.emit("newTabRequested", signal.url, String(signal.source ?? ""));
        }
        break;
      case "clock_probe":
        answerClockProbe(c, "signaling", Number(signal.id));
        break;
      case "layers_wanted":
        if (Array.isArray(signal.rids)) {
          publish.onLayersWanted(c, typeof signal.mid === "string" ? signal.mid : undefined, signal.rids.map(String));
        }
        break;
      case "publish_refused":
        publish.onRefused(c, String(signal.mid ?? ""), String(signal.reason ?? ""));
        break;
      case "connection_quality": {
        const quality = signal.quality;
        if (quality === "excellent" || quality === "good" || quality === "poor" || quality === "lost") {
          const score = Number(signal.score);
          c._connectionQuality = { quality, score: Number.isFinite(score) ? score : 0 };
          c.emit("connectionQuality", quality, c._connectionQuality.score);
        }
        break;
      }
    }
  } catch {
    // A signaling-level failure will surface as a PC state change; don't
    // tear down here.
  }
}

// Glass estimates this client's clock offset from probe round trips and
// uses it to put the input "t" timestamps on its own clock. The reply carries
// Date.now(), the clock "t" uses, and goes back on the transport the
// probe came on so the round trip measures one path.
export function answerClockProbe(c: ClientCore, transport: "datachannel" | "signaling", id: number): void {
  if (!Number.isFinite(id)) return;
  const clientT = Date.now();
  try {
    if (transport === "datachannel") {
      const dc = c.dataChannel;
      if (dc && dc.readyState === "open") {
        dc.send(JSON.stringify({ type: "clock_probe_reply", data: { id, clientT } }));
      }
    } else if (c.ws && c.signalingConnected) {
      c.ws.send(JSON.stringify({ type: "clock_probe_reply", id, clientT }));
    }
  } catch {
    // A lost reply only costs one sample.
  }
}

// source names the session source the input is for (protocol v3); "" sends
// none, for what is about no source (telemetry).
export function sendInput(c: ClientCore, type: string, data: Record<string, unknown>, source = ""): void {
  const dc = c.dataChannel;
  if (!dc || dc.readyState !== "open") return;
  // `t`: client send time (epoch ms). Glass converts it onto its own clock
  // with the offset answerClockProbe lets it measure.
  try {
    const s = c.inputLatency.number(type);
    dc.send(JSON.stringify({ type, data: { ...data, t: Date.now(), ...(s === undefined ? {} : { s }) }, ...(source ? { source } : {}) }));
  } catch {
    // drop on transient send failure
  }
}

// Mirrors sendInput exactly but targets fastDataChannel - used for
// touchmove (see dispatchTouch), and since 2026-09-04 also mousemove/
// scroll (see their own doc comments) - any input the backend already
// coalesces server-side (overwrite-latest / accumulate-delta), where a
// dropped or reordered intermediate is harmless. Deliberately no
// fallback to the reliable dataChannel if this one isn't open/ready:
// silently dropping is the whole point of an unreliable channel, and
// falling back would reintroduce the queuing-under-loss behavior this
// exists to avoid.
export function sendInputFast(c: ClientCore, type: string, data: Record<string, unknown>, source = ""): void {
  const dc = c.fastDataChannel;
  if (!dc || dc.readyState !== "open") return;
  try {
    const s = c.inputLatency.number(type);
    dc.send(JSON.stringify({ type, data: { ...data, t: Date.now(), ...(s === undefined ? {} : { s }) }, ...(source ? { source } : {}) }));
  } catch {
    // drop on transient send failure
  }
}

// See GlassClient.isConnected.
export function isConnected(c: ClientCore): boolean {
  return c.peerConnected && c.dataChannel?.readyState === "open";
}

// The stream of one source's received tracks, or null before the first.
export function sourceStream(c: ClientCore, sourceId: string): MediaStream | null {
  return c.sources.get(sourceId)?.stream ?? null;
}
