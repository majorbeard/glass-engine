// The peer connection, its DataChannels, and the two inbound paths:
// binary DataChannel messages and signaling messages. See GlassClient (index.ts) for the public API.

import type { ClientCore } from "./core";
import * as drops from "./drops";
import * as lifecycle from "./lifecycle";
import * as handoff from "./handoff";
import * as mic from "./mic";
import * as statsTrace from "./stats_trace";
import type { ElementState, GlassRosterEntry, GlassSlotState, InteractiveElement, NavigationState } from "./types";
import { EncodedStreamChecker } from "./encoded_stream_check";

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
  Error = 0xff,
}

export function initPeerConnection(c: ClientCore, onConnectedThisAttempt: () => void): void {
  if (c.pc) return;
  const pc = new RTCPeerConnection({
    iceServers: c.iceServers,
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
    // Built from individual tracks, not event.streams[0]: a session with
    // both video and audio has
    // Glass construct each track with its OWN distinct stream
    // ID ("glass-screencast" for video, "glass-audio" for audio) - so the browser delivers
    // them as two SEPARATE ontrack events, each with its own
    // single-track event.streams[0]. Reassigning this.currentStream
    // wholesale to whichever arrived most recently (the original
    // behavior here) meant audio's ontrack firing after video's would
    // silently replace the <video> element's srcObject with an
    // audio-only stream - a real bug, caught before it ever shipped:
    // the element would go blank the instant a session's audio track
    // was negotiated, video track included or not. Instead, every track
    // that arrives (regardless of kind, and regardless of arrival
    // order) is added to one persistent MediaStream this connection
    // owns - video and audio end up in the same stream a <video>
    // element plays both from natively, exactly as if they'd arrived
    // together in one event.streams[0] to begin with.
    if (!c.currentStream) {
      c.currentStream = new MediaStream();
    }
    c.currentStream.addTrack(event.track);
    c.emit("videoTrack", c.currentStream);
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
          const nav: NavigationState = JSON.parse(
            decoder.decode(new Uint8Array(view.buffer, offset))
          );
          c.emit("navigation", nav);
        }
        break;
      case MessageType.ElementStateUpdate:
        if (data.byteLength > offset) {
          const state: ElementState = JSON.parse(
            decoder.decode(new Uint8Array(view.buffer, offset))
          );
          c.emit("state", state);
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
          c.emit("interactiveElements", parsed.elements || []);
        }
        break;
      case MessageType.ClipboardText:
        if (data.byteLength > offset) {
          const parsed: { text?: string } = JSON.parse(
            decoder.decode(new Uint8Array(view.buffer, offset))
          );
          c.emit("clipboardText", parsed.text || "");
        }
        break;
      case MessageType.ConsoleMessage:
        if (data.byteLength > offset) {
          const parsed: { level?: string; text?: string } = JSON.parse(
            decoder.decode(new Uint8Array(view.buffer, offset))
          );
          c.emit("consoleMessage", parsed.level || "log", parsed.text || "");
        }
        break;
      case MessageType.DownloadReady:
        if (data.byteLength > offset) {
          const parsed: { filename?: string; guid?: string } = JSON.parse(
            decoder.decode(new Uint8Array(view.buffer, offset))
          );
          if (parsed.guid) {
            c.emit("downloadReady", parsed.filename || "download", parsed.guid);
          }
        }
        break;
      case MessageType.FileChooserOpened:
        if (data.byteLength > offset) {
          const parsed: { multiple?: boolean } = JSON.parse(
            decoder.decode(new Uint8Array(view.buffer, offset))
          );
          c.emit("fileChooserOpened", !!parsed.multiple);
        }
        break;
      case MessageType.FileChooserClosed:
        c.emit("fileChooserClosed");
        break;
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
          c.emit("micAccessRequested", parsed.origin || "");
        }
        break;
      case MessageType.InputDropped:
        if (data.byteLength > offset) {
          drops.onServerDrop(c, JSON.parse(decoder.decode(new Uint8Array(view.buffer, offset))));
        }
        break;
      case MessageType.Error:
        if (data.byteLength > offset) {
          const parsed: { error?: string } = JSON.parse(
            decoder.decode(new Uint8Array(view.buffer, offset))
          );
          c.emit("error", parsed.error || "Unknown server error");
        }
        break;
    }
  } catch {
    // malformed message - ignore rather than tear down the channel
  }
}

export async function handleSignal(c: ClientCore, signal: any): Promise<void> {
  const pc = c.pc;
  if (!pc) return;
  try {
    switch (signal.type) {
      case "offer": {
        if (typeof signal.connectionId === "string") {
          c._connectionId = signal.connectionId;
        }
        if (typeof signal.producesInput === "boolean") {
          c._producesInput = signal.producesInput;
        }
        if (typeof signal.isOwner === "boolean") {
          c._isOwner = signal.isOwner;
        }
        await pc.setRemoteDescription({ type: "offer", sdp: signal.sdp });
        mic.attachMicPlaceholder(c, pc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        c.ws?.send(JSON.stringify({ type: "answer", sdp: answer.sdp || "" }));
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
        break;
      }
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
      // docs/protocol.md's "Control handoff" section.
      case "capabilities_changed": {
        const connectionId = String(signal.connectionId ?? "");
        const producesInput = !!signal.producesInput;
        const isSelf = connectionId !== "" && connectionId === c._connectionId;
        if (isSelf) {
          c._producesInput = producesInput;
        } else {
          // Keep an owner's roster in sync with a change to someone
          // else's producesInput (e.g. their own request_input got
          // granted, or another owner revoked them) - only relevant if
          // this connectionId is already a roster entry (a non-owner
          // never has one to update - this._connections stays empty for
          // it, see the field's own doc comment).
          const existing = c._connections.get(connectionId);
          if (existing) {
            c._connections.set(connectionId, { ...existing, producesInput });
            c.emit("rosterChanged", handoff.connections(c));
          }
        }
        c.emit("capabilitiesChanged", connectionId, producesInput, isSelf);
        break;
      }
      case "input_requested":
        c.emit("inputRequested", String(signal.connectionId ?? ""));
        break;
      case "new_tab_request":
        if (typeof signal.url === "string") {
          c.emit("newTabRequested", signal.url);
        }
        break;
      // Roster (docs/protocol.md's Control handoff section) - owner-only;
      // a non-owner connection never receives any of these three types at
      // all, so
      // this._connections simply stays empty for it rather than needing
      // its own separate gate here.
      case "connection_joined": {
        const entry: GlassRosterEntry = {
          connectionId: String(signal.connectionId ?? ""),
          producesInput: !!signal.producesInput,
          isOwner: !!signal.isOwner,
        };
        if (entry.connectionId) {
          c._connections.set(entry.connectionId, entry);
          c.emit("rosterChanged", handoff.connections(c));
        }
        break;
      }
      case "connection_left": {
        const connectionId = String(signal.connectionId ?? "");
        if (c._connections.delete(connectionId)) {
          c.emit("rosterChanged", handoff.connections(c));
        }
        break;
      }
      case "roster": {
        // A one-time catch-up snapshot, not an incremental update -
        // replaces this._connections outright rather than merging, so a
        // reconnect's fresh snapshot can't leave a stale entry behind
        // from before the gap.
        const fresh = new Map<string, GlassRosterEntry>();
        if (Array.isArray(signal.connections)) {
          for (const raw of signal.connections as Array<Record<string, unknown>>) {
            const connectionId = String(raw?.connectionId ?? "");
            if (!connectionId) continue;
            fresh.set(connectionId, {
              connectionId,
              producesInput: !!raw?.producesInput,
              isOwner: !!raw?.isOwner,
            });
          }
        }
        c._connections = fresh;
        c.emit("rosterChanged", handoff.connections(c));
        break;
      }
      case "clock_probe":
        answerClockProbe(c, "signaling", Number(signal.id));
        break;
      case "slot_state": {
        const fresh: Record<string, GlassSlotState> = {};
        const raw = (signal.slots ?? {}) as Record<string, unknown>;
        for (const [slot, state] of Object.entries(raw)) {
          if (state === "empty" || state === "live" || state === "stalled") {
            fresh[slot] = state;
          }
        }
        c._slotStates = fresh;
        c.emit("slotStateChanged", handoff.slotStates(c));
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

export function sendInput(c: ClientCore, type: string, data: Record<string, unknown>): void {
  const dc = c.dataChannel;
  if (!dc || dc.readyState !== "open") return;
  // `t`: client send time (epoch ms). Glass converts it onto its own clock
  // with the offset answerClockProbe lets it measure.
  try {
    const s = c.inputLatency.number(type);
    dc.send(JSON.stringify({ type, data: { ...data, t: Date.now(), ...(s === undefined ? {} : { s }) } }));
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
export function sendInputFast(c: ClientCore, type: string, data: Record<string, unknown>): void {
  const dc = c.fastDataChannel;
  if (!dc || dc.readyState !== "open") return;
  try {
    const s = c.inputLatency.number(type);
    dc.send(JSON.stringify({ type, data: { ...data, t: Date.now(), ...(s === undefined ? {} : { s }) } }));
  } catch {
    // drop on transient send failure
  }
}

// See GlassClient.isConnected.
export function isConnected(c: ClientCore): boolean {
  return c.peerConnected && c.dataChannel?.readyState === "open";
}

// See GlassClient.getVideoStream.
export function getVideoStream(c: ClientCore): MediaStream | null {
  return c.currentStream;
}
