import { useEffect, useRef, useState } from "preact/hooks";
import {
  createGlassClient,
  createGlassSession,
  deleteGlassSession,
  type GlassClient,
  type GlassRosterEntry,
  type GlassSession,
} from "@glass/client";
import {
  API_TOKEN,
  AUDIO_INPUT,
  DECODE_READBACK_ENABLED,
  ENCODED_STREAM_CHECK_ENABLED,
  GLASS_ADDR,
  ICE_SERVERS,
  ICE_TRANSPORT_POLICY,
  JITTER_BUFFER_TARGET_MS,
  PIXEL_TRACE_ENABLED,
  TRACE_REPORT_INTERVAL_MS,
} from "../config";

export type Notify = (toast: { message: string; type: "success" | "error" | "info" }) => void;

// useGlassSession creates a session, builds the client, connects it, and
// reflects the client's events as state. A fresh session is created (and
// sessionEpoch bumped) when the server closes the old one outright; see the
// "closed" handler below.
export function useGlassSession(notify: Notify) {
  const [isActive, setIsActive] = useState(false);
  const [client, setClient] = useState<GlassClient | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hijackedUrl, setHijackedUrl] = useState<string | null>(null);
  // Pending, not-yet-claimed downloads (see client.on("downloadReady")
  // below) - a list, not a single value, since the remote page can trigger
  // several in quick succession and each needs its own explicit-click
  // prompt (prompt-then-save, not auto-save - unlike toastMessage, this must NOT
  // auto-dismiss, or an operator who glances away for 3s could miss the
  // only chance to save a file the backend will delete after 10 minutes).
  const [pendingDownloads, setPendingDownloads] = useState<
    { filename: string; guid: string; url: string }[]
  >([]);
  // Upload direction's counterpart:
  // null = no active prompt, otherwise whether the remote page's file input
  // accepts multiple files - controls the hidden <input type="file">'s own
  // `multiple` attribute below. Unlike pendingDownloads there's only ever
  // one of these at a time (a real browser can only show one native file
  // picker at once - see uploadManager's own doc comment), and
  // "uploading"/"uploadError" track the one in-flight request's own state
  // for the prompt UI to reflect.
  const [fileChooserMultiple, setFileChooserMultiple] = useState<boolean | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // Mic access prompt - the
  // remote page's own getUserMedia({audio:true}) call is genuinely
  // blocked server-side until this operator answers via
  // client.grantMicAccess()/denyMicAccess(). null = no request pending;
  // the origin string doubles as both "a request is pending" and "which
  // site is asking" for the prompt text below. micError surfaces a real
  // device/permission failure from grantMicAccess() itself (no mic
  // present, the browser's own native prompt denied) - grantMicAccess()
  // already falls back to denying the remote page automatically in that
  // case, this is purely so the operator sees why.
  const [micAccessOrigin, setMicAccessOrigin] = useState<string | null>(null);
  const [micError, setMicError] = useState<string | null>(null);
  const [micGranting, setMicGranting] = useState(false);
  const [currentURL, setCurrentURL] = useState("");
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  // Input handoff (docs/protocol.md's "Control handoff" section) - see the
  // client.on("capabilitiesChanged"/"inputRequested") wiring below.
  // sessionId is stashed separately from the `session` local the connect
  // effect otherwise keeps to itself, purely so handleShareWatchOnlyLink
  // (triggered by a later user click, well after that effect has run) can
  // still mint a grant for the right session.
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [producesInput, setProducesInput] = useState(false);
  // Owner-controlled handoff (docs/protocol.md's "Owner-controlled
  // handoff" section) - see client.on("rosterChanged") wiring below.
  const [isOwner, setIsOwner] = useState(false);
  const [connections, setConnections] = useState<GlassRosterEntry[]>([]);
  // Relay watch links: the producer feeding the main slot dropped or went
  // silent (docs/protocol.md, slot_state). The frozen last frame stays up.
  const [sourceStalled, setSourceStalled] = useState(false);
  // Bumped to force the session-lifecycle effect below to re-run and create
  // a brand new session - the SDK's own reconnectLoop already handles a
  // recoverable drop (same session ID, held for reconnect server-side), but
  // has no path for a session the server closed outright (e.g. Glass's own
  // zombie-detection killing a hung Chrome process): the client just
  // had nothing left to talk to and sat there. autoRetryCountRef bounds how
  // many times this fires in a row before giving up and asking the user to
  // reload - a backend that's genuinely down shouldn't retry forever.
  const [sessionEpoch, setSessionEpoch] = useState(0);
  const autoRetryCountRef = useRef(0);
  const maxAutoRetries = 3;

  // --- Client lifecycle: create a session, build the client, connect. The SDK
  // owns reconnection/backoff internally - the app just reflects its events. ---
  useEffect(() => {
    let cancelled = false;
    let c: GlassClient | null = null;

    (async () => {
      // Typed as the full GlassSession rather than an inline {id, signalingUrl}
      // subset, so the runtime's advertised protocolVersion/sourceType/
      // capabilities are visible to anyone reading this as the reference
      // consumer. createGlassSession already rejects a protocol major it
      // doesn't understand, so nothing here needs to check the version itself.
      //
      // attachSessionId/attachSignalingUrl: test-only escape hatch, not a
      // real product feature. Backend-simulated interaction tooling
      // creates a session via the API
      // directly so it can drive it via POST /v1/sessions/{id}/input, and
      // needs a way for a human to actually watch that exact session rather
      // than the viewer silently creating its own separate one - a runtime
      // query param, not a build-time env var, since the session ID/URL
      // differ on every validation run. Absent in every normal use of this
      // viewer, which keeps creating its own session exactly as before.
      const attachSessionId = new URLSearchParams(window.location.search).get("attachSessionId");
      const attachSignalingUrl = new URLSearchParams(window.location.search).get("attachSignalingUrl");

      // A non-zero sessionEpoch means this run was triggered by an
      // auto-retry after the previous session was closed out from under us
      // (see the "closed" handler below) - the old session's
      // URL/navigation/active state is meaningless for the fresh one about
      // to be created.
      if (sessionEpoch > 0) {
        setIsActive(false);
        setCurrentURL("");
        setCanGoBack(false);
        setCanGoForward(false);
      }

      let session: GlassSession;
      if (attachSessionId && attachSignalingUrl) {
        session = { id: attachSessionId, signalingUrl: attachSignalingUrl };
      } else {
        try {
          session = await createGlassSession(GLASS_ADDR, API_TOKEN, AUDIO_INPUT);
        } catch (err: any) {
          if (!cancelled) setError(`Failed to create session: ${err.message}`);
          return;
        }
      }
      if (cancelled) {
        if (!attachSessionId) deleteGlassSession(session.id, GLASS_ADDR, API_TOKEN);
        return;
      }
      setSessionId(session.id);

      c = createGlassClient({
        signalingUrl: session.signalingUrl,
        sessionId: session.id,
        // deleteSessionOnClose defaults to true whenever sessionId is set
        // (see @glass/client's installUnloadHandler) - correct for the
        // session's own creator (this tab closing SHOULD free the pool slot
        // immediately rather than waiting out the reconnect grace), but
        // never correct for an attached viewer: that tab doesn't own
        // this session, and closing it must not delete it out from under
        // the primary connection or any other viewer still watching. Real,
        // live-confirmed bug - every attached
        // viewer defaulted to true here, so closing ANY watch-only tab
        // killed the whole shared session for everyone.
        deleteSessionOnClose: !attachSessionId,
        ...(ICE_SERVERS ? { iceServers: ICE_SERVERS } : {}),
        ...(ICE_TRANSPORT_POLICY
          ? { iceTransportPolicy: ICE_TRANSPORT_POLICY }
          : {}),
        ...(API_TOKEN ? { apiToken: API_TOKEN } : {}),
        // @internal trace diagnostics - see TRACE_REPORT_INTERVAL_MS/
        // PIXEL_TRACE_ENABLED's own doc comment above. Cast needed since
        // these fields are deliberately not part of the exported
        // GlassClientOptions type.
        ...(TRACE_REPORT_INTERVAL_MS
          ? { __internalTraceReportIntervalMs: TRACE_REPORT_INTERVAL_MS }
          : {}),
        ...(PIXEL_TRACE_ENABLED ? { __internalPixelTraceEnabled: true } : {}),
        ...(ENCODED_STREAM_CHECK_ENABLED
          ? { __internalEncodedStreamCheckEnabled: true }
          : {}),
        ...(DECODE_READBACK_ENABLED
          ? { __internalDecodeReadbackEnabled: true }
          : {}),
        ...(JITTER_BUFFER_TARGET_MS
          ? { __internalJitterBufferTargetMs: JITTER_BUFFER_TARGET_MS }
          : {}),
      } as Parameters<typeof createGlassClient>[0]);

      c.on("connected", () => {
        if (cancelled) return;
        autoRetryCountRef.current = 0;
        setIsConnected(true);
        setError(null);
        // Attached sessions (watchers of a shared browser session, relay
        // viewers) never navigate themselves - a shared browser's controller
        // is some other tab, and a relay stream has no
        // navigation concept at all - so waiting for a "navigation" event
        // to leave the URL-bar landing screen (see the effect below) would
        // hang forever even though the connection and video are live.
        // Attach mode always means "something else owns this session's
        // content"; activate immediately on connect instead.
        if (attachSessionId) setIsActive(true);
        // producesInput()/isOwner() only reflect real values once the
        // first "offer" has been processed (see @glass/client's own doc
        // comment on _connectionId/_producesInput/_isOwner) - "connected"
        // fires after that, so reading them here is safe.
        setProducesInput(c!.producesInput());
        setIsOwner(c!.isOwner());
      });
      c.on("disconnected", () => {
        if (!cancelled) setIsConnected(false);
      });
      // docs/protocol.md's "Control handoff" section.
      c.on("capabilitiesChanged", (_connectionId, nowProducesInput, isSelf) => {
        if (cancelled || !isSelf) return;
        setProducesInput(nowProducesInput);
        notify({
          message: nowProducesInput
            ? "You now have control"
            : "You released control",
          type: "info",
        });
      });
      // docs/protocol.md's "Owner-controlled handoff" section - only ever
      // fires for an owner connection (see isOwner()); connections() is
      // already up to date by the time this fires.
      c.on("rosterChanged", (roster) => {
        if (cancelled) return;
        setConnections(roster);
      });
      c.on("slotStateChanged", (slots) => {
        if (!cancelled) setSourceStalled(slots.main === "stalled");
      });
      c.on("inputRequested", () => {
        if (cancelled) return;
        notify({
          message: "Another viewer is requesting control",
          type: "info",
        });
      });
      c.on("reconnecting", (attempt, max) => {
        if (!cancelled) setError(`Reconnecting… (attempt ${attempt}/${max})`);
      });
      c.on("newTabRequested", (url) => {
        if (!cancelled) setHijackedUrl(url);
      });
      c.on("navigation", (nav) => {
        if (cancelled) return;
        setCurrentURL(nav.url || "");
        setCanGoBack(nav.canGoBack || false);
        setCanGoForward(nav.canGoForward || false);
        setIsLoading(nav.loading || false);
        // A real navigation update means the session has real content to
        // show, regardless of whether THIS tab was the one that triggered
        // it - real gap found live (2026-08-24): attachSessionId's whole
        // point is watching a session navigated by something else (e.g.
        // server-side test tooling's own
        // navigation), but isActive was previously only ever flipped by
        // handleNavigate's own local click, leaving an attached viewer
        // stuck on the landing screen forever even though connected and
        // receiving real state. A no-op for normal same-tab navigation,
        // which already sets isActive itself before this event ever fires.
        if (nav.url) setIsActive(true);
      });
      c.on("clipboardText", (text) => {
        if (cancelled) return;
        if (!text) {
          notify({ message: "Nothing selected to copy", type: "info" });
          return;
        }
        navigator.clipboard.writeText(text).then(
          () => notify({ message: "Copied to clipboard", type: "success" }),
          (e) => {
            console.error("Clipboard write failed", e);
            notify({ message: "Copy failed", type: "error" });
          }
        );
      });
      c.on("error", (message) => {
        if (!cancelled) setError(message);
      });
      // Dev console: forward the remote page's own console.*() calls into
      // this tab's real DevTools console, tagged so they're distinguishable
      // from this app's own logging - the simplest possible integration of
      // the "dev console" feature, matching level to the real console
      // method where one exists (console[level] falls back to console.log
      // for anything unrecognized, e.g. Chrome's "startGroup"/"table").
      c.on("consoleMessage", (level, text) => {
        if (cancelled) return;
        const fn = (console as unknown as Record<string, (...args: unknown[]) => void>)[level] ?? console.log;
        fn(`[remote console:${level}]`, text);
      });
      // File download prompt -
      // surfaces a persistent, explicit-click prompt rather than fetching
      // c.downloadUrl(guid) automatically. See pendingDownloads' own doc
      // comment for why this doesn't reuse the auto-dismissing Toast.
      c.on("downloadReady", (filename, guid) => {
        if (cancelled) return;
        setPendingDownloads((prev) => [...prev, { filename, guid, url: c!.downloadUrl(guid) }]);
      });
      // File upload prompt - the
      // other direction's counterpart to downloadReady above. Opens no
      // native dialog itself; it just arms the hidden file input rendered
      // below, which is what actually raises the operator's OS file picker
      // once they click the visible prompt button.
      c.on("fileChooserOpened", (multiple) => {
        if (cancelled) return;
        setUploadError(null);
        setFileChooserMultiple(multiple);
      });
      c.on("fileChooserClosed", () => {
        if (cancelled) return;
        setFileChooserMultiple(null);
        setUploading(false);
      });
      // Mic access prompt - see
      // micAccessOrigin's own doc comment. A fresh request always replaces
      // any stale prompt state from a previous one.
      c.on("micAccessRequested", (origin) => {
        if (cancelled) return;
        setMicError(null);
        setMicGranting(false);
        setMicAccessOrigin(origin);
      });
      c.on("closed", (reason) => {
        if (cancelled) return;
        setIsConnected(false);
        // A user-initiated disconnect closes silently; a lost/exhausted
        // connection surfaces an actionable message.
        const userInitiated = reason.includes("client disconnected");
        if (userInitiated) return;
        // attachSessionId viewers don't own the session (see its own doc
        // comment above) - if it's gone, that's the owner's session to
        // recreate, not this watch-only tab's.
        if (attachSessionId) {
          setError("Connection lost and could not be restored. Please reload.");
          return;
        }
        if (autoRetryCountRef.current >= maxAutoRetries) {
          setError("Connection lost and could not be restored. Please reload.");
          return;
        }
        autoRetryCountRef.current += 1;
        setError("Connection lost - starting a new session…");
        setSessionEpoch((e) => e + 1);
      });

      setClient(c);
      try {
        await c.connect();
      } catch (connectErr: any) {
        // The "closed" handler above already surfaced the failure.
      }
    })();

    return () => {
      cancelled = true;
      c?.disconnect();
      setClient(null);
      setIsConnected(false);
    };
  }, [sessionEpoch]);

  return {
    isActive,
    setIsActive,
    client,
    isConnected,
    isLoading,
    setIsLoading,
    error,
    setError,
    hijackedUrl,
    setHijackedUrl,
    pendingDownloads,
    setPendingDownloads,
    fileChooserMultiple,
    setFileChooserMultiple,
    uploading,
    setUploading,
    uploadError,
    setUploadError,
    micAccessOrigin,
    setMicAccessOrigin,
    micError,
    setMicError,
    micGranting,
    setMicGranting,
    currentURL,
    canGoBack,
    canGoForward,
    sessionId,
    producesInput,
    isOwner,
    connections,
    sourceStalled,
    sessionEpoch,
  };
}
