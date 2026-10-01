// Connecting, retrying, the disconnected grace, the page-unload
// delete, and teardown. See GlassClient (index.ts) for the public API.

import type { ClientCore } from "./core";
import * as transport from "./transport";
import * as mic from "./mic";
import { CLOSE_SESSION_NOT_FOUND, deleteGlassSession } from "./index";
import { DEFAULT_RECONNECT_DELAYS_MS, SESSION_NOT_FOUND_MESSAGE, SIGNALING_TIMEOUT_MS, PEER_TIMEOUT_MS, DISCONNECTED_GRACE_MS, authHeaders } from "./internal";

// A deliberate page unload (reload, tab close, navigate away) closes the
// signaling socket, which the backend can't tell apart from a network drop -
// so it holds the session open for the whole reconnect grace before freeing
// its pool slot. That's correct for a real drop, but wasteful for a reload:
// the slot is blocked (and at small pool sizes, new sessions get 503) for up
// to a minute. So on a real page discard we proactively DELETE the session.
//
// Guarded so it never fires on a backgrounding that the reconnect machinery
// SHOULD handle: `event.persisted` means the page is going into the bfcache
// (e.g. a mobile app-switch / screen lock - exactly the reconnect case), so
// we skip the delete there and let the grace period do its job.
export function installUnloadHandler(c: ClientCore): void {
  if (typeof window === "undefined") return;
  if (!c.sessionId || !c.deleteOnClose) return;
  c.unloadHandler = (event: PageTransitionEvent) => {
    if (event.persisted) return;
    sendDeleteBeacon(c);
  };
  window.addEventListener("pagehide", c.unloadHandler);
}

export function sendDeleteBeacon(c: ClientCore): void {
  if (!c.sessionId) return;
  try {
    // keepalive lets this request outlive the unloading page. DELETE (rather
    // than navigator.sendBeacon, which is POST-only) matches the runtime's
    // session API.
    //
    // connectionId (when known) routes this through the backend's
    // per-connection close path instead of an unconditional session-wide
    // delete - the runtime only actually tears the session down if this
    // was its last connection, otherwise a no-op, same as an ordinary
    // WebSocket close. Without it, this tab's own reload used to delete
    // the whole shared session out from under every other connected
    // viewer (shared sessions / owner-controlled handoff) - real, reported
    // live 2026-09-01. Omitted (falls back to the old unconditional
    // delete) only if pagehide fires before the first "offer" ever
    // assigned _connectionId, which shouldn't happen in practice since
    // deleteOnClose implies this tab already has a live connection.
    const url = c._connectionId
      ? `${c.sessionBaseUrl}/v1/sessions/${c.sessionId}?connectionId=${encodeURIComponent(c._connectionId)}`
      : `${c.sessionBaseUrl}/v1/sessions/${c.sessionId}`;
    void fetch(url, {
      method: "DELETE",
      keepalive: true,
      headers: authHeaders(c.apiToken),
    });
  } catch {
    // best-effort; the reconnect grace is the fallback
  }
}

// See GlassClient.connect.
export async function connect(c: ClientCore): Promise<void> {
  c.userClosed = false;
  c.reconnectAttempt = 0;
  for (;;) {
    try {
      await establish(c);
      return;
    } catch (err) {
      if (c.serverTerminalError) {
        const reason = c.serverTerminalError;
        c.serverTerminalError = null;
        if (!c.userClosed) c.emit("closed", reason);
        throw err;
      }
      if (
        c.userClosed ||
        !c.reconnectEnabled ||
        c.reconnectAttempt >= c.maxAttempts
      ) {
        if (!c.userClosed) c.emit("closed", `failed to connect: ${err}`);
        throw err;
      }
      c.reconnectAttempt++;
      c.emit("reconnecting", c.reconnectAttempt, c.maxAttempts);
      await c.wait(nextDelayMs(c));
      if (c.userClosed) throw new Error("connect aborted");
    }
  }
}

// nextDelayMs is the wait after failed attempt number reconnectAttempt:
// delaysMs[0] after the first, and so on (the first retry after a drop is
// immediate).
export function nextDelayMs(c: ClientCore): number {
  const i = Math.max(0, Math.min(c.reconnectAttempt - 1, c.delaysMs.length - 1));
  return c.delaysMs[i] ?? DEFAULT_RECONNECT_DELAYS_MS[0]!;
}

// One full connection attempt: signaling WS -> offer/answer -> PC/DC. Resolves
// when the PC reaches "connected"; rejects on any failure/timeout during the
// handshake. Once resolved, a later drop is handled by the state-change
// handlers (ICE restart for a transient PC drop, background full reconnect
// for a lost signaling socket), NOT by rejecting this settled promise.
export function establish(c: ClientCore): Promise<void> {
  teardownInternals(c);
  c.signalingConnected = false;
  c.peerConnected = false;
  c.iceCandidateQueue = [];
  // Reset here, not just left stale, for the same reason iceCandidateQueue
  // is cleared above - the fresh "offer" this attempt is about to request
  // reports the authoritative current values immediately (see handleSignal's
  // "offer" case), whether this resumes the same backend Connection (same
  // id, current producesInput) or joins as a genuinely new one.
  c._connectionId = null;
  c._producesInput = false;
  c._isOwner = false;
  // Cleared, not carried over - a fresh "roster" snapshot always follows
  // the next offer for an owner connection (see HandleSessionSignaling's
  // own doc comment on this), even on a reconnect, specifically so stale
  // entries from before a reconnect gap (someone left/joined/changed
  // state while this connection was down) never linger.
  c._connections = new Map();
  c.attemptSettled = false;

  return new Promise<void>((resolve, reject) => {
    const settle = (fn: () => void) => {
      if (c.attemptSettled) return;
      c.attemptSettled = true;
      fn();
    };

    let ws: WebSocket;
    try {
      ws = new WebSocket(c.signalingUrl);
    } catch (err) {
      settle(() => reject(err));
      return;
    }
    c.ws = ws;

    const signalingTimeout = c.timeout(() => {
      if (!c.signalingConnected) {
        settle(() => reject(new Error("signaling connection timed out")));
        teardownInternals(c);
      }
    }, SIGNALING_TIMEOUT_MS);

    const peerTimeout = c.timeout(() => {
      if (!c.peerConnected) {
        settle(() => reject(new Error("peer connection timed out")));
        teardownInternals(c);
      }
    }, PEER_TIMEOUT_MS);

    ws.onopen = () => {
      c.signalingConnected = true;
      c.clearTimeoutTracked(signalingTimeout);
    };

    ws.onmessage = async (event) => {
      try {
        const signal = JSON.parse(event.data);
        if (signal.type === "error") {
          const reason: string = signal.error || "server reported an error";
          c.serverTerminalError = reason;
          c.emit("error", reason);
          return;
        }
        if (!c.pc && signal.type === "offer") {
          transport.initPeerConnection(c, () => {
            // onConnected for this attempt
            c.clearTimeoutTracked(peerTimeout);
            settle(() => resolve());
          });
        }
        if (c.pc) {
          await transport.handleSignal(c, signal);
        }
      } catch (err) {
        settle(() => reject(err as Error));
      }
    };

    ws.onerror = () => {
      if (c.peerConnected) {
        onTerminalDrop(c);
      } else {
        settle(() => reject(new Error("signaling socket error")));
      }
    };

    ws.onclose = (event) => {
      c.signalingConnected = false;
      if (event?.code === CLOSE_SESSION_NOT_FOUND) {
        c.sessionGone = true;
        c.serverTerminalError = SESSION_NOT_FOUND_MESSAGE;
      }
      if (c.peerConnected) {
        onTerminalDrop(c);
      } else {
        settle(() => reject(new Error(c.sessionGone ? SESSION_NOT_FOUND_MESSAGE : "signaling socket closed")));
      }
    };
  });
}

// Arm the give-up timer for a peer connection that just went "disconnected".
// If it hasn't recovered by the time this fires, fall back to a full
// reconnect (onTerminalDrop -> reconnectLoop -> establish), which resumes the
// SAME backend session - the server holds it open, streaming paused, for its
// reconnect grace, so page state survives.
//
// This deliberately replaces a client-side ICE restart. That path generated a
// fresh offer and sent it over signaling, but the backend's signaling loop has
// no "offer" case at all - it logged "unknown signaling message type" and did
// nothing. The client was left in have-local-offer forever, and because the
// old code guarded on signalingState === "stable", every subsequent state
// change returned early WITHOUT falling back to onTerminalDrop() - so the
// reconnect machinery never ran and the session hung permanently with a live
// signaling socket. A dead socket was always recoverable (ws.onclose ->
// onTerminalDrop); the unrecoverable case was media-path-only failure with
// signaling intact: NAT rebind, TURN switch, mobile network handover.
export function scheduleDisconnectedGrace(c: ClientCore): void {
  if (c.disconnectedGraceTimer !== null) return; // already armed
  c.disconnectedGraceTimer = c.timeout(() => {
    c.disconnectedGraceTimer = null;
    const state = c.pc?.connectionState;
    // Recheck rather than trusting the state at arm time - it may have gone
    // back to "connected" without us (that handler cancels this timer, but a
    // race between the callback firing and being cleared is cheap to cover).
    if (state === "disconnected" || state === "failed") {
      onTerminalDrop(c);
    }
  }, DISCONNECTED_GRACE_MS);
}

export function cancelDisconnectedGrace(c: ClientCore): void {
  if (c.disconnectedGraceTimer === null) return;
  c.clearTimeoutTracked(c.disconnectedGraceTimer);
  c.disconnectedGraceTimer = null;
}

// A terminal drop (signaling socket lost, or PC closed) after having been
// connected. Emit "disconnected", then run a background reconnect loop to the
// same session unless disabled/aborted.
export function onTerminalDrop(c: ClientCore): void {
  if (c.userClosed) return;
  if (!c.peerConnected && c.supervising) return; // already recovering
  c.peerConnected = false;
  c.emit("disconnected");
  teardownInternals(c);
  if (c.serverTerminalError) {
    // The server already told us this session is gone for good (fatal
    // source error, clean Close - not held for reconnect). Retrying the
    // same session ID via reconnectLoop can never succeed here, so skip
    // straight to "closed" instead of burning through maxAttempts first.
    const reason = c.serverTerminalError;
    c.serverTerminalError = null;
    c.emit("closed", reason);
    return;
  }
  if (!c.reconnectEnabled) {
    c.emit("closed", "connection lost");
    return;
  }
  if (c.supervising) return;
  c.supervising = true;
  c.reconnectAttempt = 0;
  void reconnectLoop(c);
}

export async function reconnectLoop(c: ClientCore): Promise<void> {
  try {
    for (;;) {
      if (c.userClosed) return;
      c.reconnectAttempt++;
      if (c.reconnectAttempt > c.maxAttempts) {
        c.emit("closed", "reconnection attempts exhausted");
        return;
      }
      c.emit("reconnecting", c.reconnectAttempt, c.maxAttempts);
      try {
        await establish(c);
        return; // reconnected; "connected" already emitted
      } catch {
        if (c.sessionGone) {
          c.serverTerminalError = null;
          c.emit("closed", SESSION_NOT_FOUND_MESSAGE);
          return;
        }
        await c.wait(nextDelayMs(c));
      }
    }
  } finally {
    c.supervising = false;
  }
}

// See GlassClient.disconnect.
export function disconnect(c: ClientCore): void {
  if (c.userClosed) return;
  c.userClosed = true;
  if (c.unloadHandler && typeof window !== "undefined") {
    window.removeEventListener("pagehide", c.unloadHandler);
    c.unloadHandler = null;
  }
  for (const t of c.pendingTimeouts) clearTimeout(t);
  c.pendingTimeouts.clear();
  teardownInternals(c);
  if (c.ws) {
    try {
      c.ws.close(1000, "client disconnecting");
    } catch {
      // ignore
    }
    detachWs(c);
  }
  if (c.sessionId && c.deleteOnClose) {
    deleteGlassSession(c.sessionId, c.sessionBaseUrl, c.apiToken);
  }
  c.emit("closed", "client disconnected");
}

// Tears down the PC/DC and detaches the WS handlers WITHOUT ending the
// client - used between reconnect attempts. Does not clear userClosed.
export function teardownInternals(c: ClientCore): void {
  // The PC this timer was watching is about to go away; a stale fire would
  // read connectionState off a replaced (or null) pc.
  cancelDisconnectedGrace(c);
  // Inputs and frame tags belong to the connection going away.
  c.inputLatency.reset();
  if (c.mouseBatchTimer !== null) {
    clearInterval(c.mouseBatchTimer);
    c.mouseBatchTimer = null;
  }
  c.mouseEventQueue = [];
  if (c.statsTimer !== null) {
    clearInterval(c.statsTimer);
    c.statsTimer = null;
  }
  if (c.traceReportTimer !== null) {
    clearInterval(c.traceReportTimer);
    c.traceReportTimer = null;
  }
  c.lastStatsSample = null;
  c.lastJitterSample = null;
  c.lastTraceReportAt = null;
  // Bound to the PC's receiver we're tearing down; a fresh one is created
  // in pc.ontrack when the reconnect completes (see that handler above).
  if (c.encodedStreamChecker) {
    c.encodedStreamChecker.stop();
    c.encodedStreamChecker = null;
  }
  // The stream belongs to the peer connection we're tearing down; drop it so
  // a viewer mounting mid-reconnect doesn't bind a dead track (a fresh
  // ontrack will replace it when the reconnect completes).
  c.currentStream = null;

  if (c.dataChannel) {
    try {
      if (
        c.dataChannel.readyState === "open" ||
        c.dataChannel.readyState === "connecting"
      ) {
        c.dataChannel.close();
      }
    } catch {
      // ignore
    }
    c.dataChannel.onmessage = null;
    c.dataChannel = null;
  }
  if (c.fastDataChannel) {
    try {
      if (
        c.fastDataChannel.readyState === "open" ||
        c.fastDataChannel.readyState === "connecting"
      ) {
        c.fastDataChannel.close();
      }
    } catch {
      // ignore
    }
    // No onmessage to null - this channel is send-only from this side
    // (see the field's own doc comment), never had one wired.
    c.fastDataChannel = null;
  }
  if (c.pc) {
    try {
      if (c.pc.connectionState !== "closed") c.pc.close();
    } catch {
      // ignore
    }
    c.pc.ontrack = null;
    c.pc.ondatachannel = null;
    c.pc.onicecandidate = null;
    c.pc.onconnectionstatechange = null;
    c.pc = null;
  }
  // AudioInput placeholder cleanup (see attachMicPlaceholder) - the
  // AudioContext holds a real OS audio resource until explicitly
  // closed; a reconnect's fresh pc gets its own fresh placeholder.
  if (c.micPlaceholderCtx) {
    void c.micPlaceholderCtx.close().catch(() => {});
    c.micPlaceholderCtx = null;
  }
  c.micSender = null;
  mic.stopMicTrack(c);
  // Detach the WS handlers so a reconnect's fresh socket owns the callbacks,
  // but only close it here if we're not doing a full teardown in disconnect
  // (which closes it explicitly). Between attempts, establish() opens a new
  // socket, so close the old one now.
  if (c.ws && !c.userClosed) {
    const old = c.ws;
    detachWs(c);
    try {
      old.close();
    } catch {
      // ignore
    }
  }
  c.peerConnected = false;
}

export function detachWs(c: ClientCore): void {
  if (!c.ws) return;
  c.ws.onopen = null;
  c.ws.onmessage = null;
  c.ws.onerror = null;
  c.ws.onclose = null;
  c.ws = null;
}
