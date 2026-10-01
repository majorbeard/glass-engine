import { useState, useEffect, useRef, useCallback } from "preact/hooks";
import { lazy, Suspense } from "preact/compat";
import { mintConnectionGrant } from "@glass/client";
import { mountGlassViewer, type GlassViewer } from "@glass/client/viewer";
import { Toast } from "./components/Toast";
import { BrowserHeader } from "./components/BrowserHeader";
import { CustomLoader } from "./components/CustomLoader";
import { ErrorScreen } from "./components/ErrorScreen";
import { WelcomeView } from "./components/WelcomeView";
import { DownloadPrompts, HijackedUrlPrompt, MicPrompt, UploadPrompt } from "./components/Prompts";
import { API_TOKEN, GLASS_ADDR } from "./config";
import { useGlassSession } from "./hooks/useGlassSession";
import { useNavigation } from "./hooks/useNavigation";
import { useStatsStream } from "./hooks/useStatsStream";

// This example is a thin consumer of the Glass client SDK: @glass/client owns
// the transport + reconnection, and @glass/client/viewer owns video rendering
// and all mouse/touch/keyboard/scroll/viewport input capture. Everything below
// is just app-chrome (URL bar, header, context menu, toasts) wired to the
// client's events - the reusable engine loop lives in the package, not here.

// Configuration (VITE_GLASS_* env vars) is in config.ts; the session
// lifecycle, navigation and stats stream are hooks in hooks/.

const ContextMenu = lazy(() =>
  import("./components/ContextMenu").then((mod) => ({
    default: mod.ContextMenu,
  }))
);

// --- Main App Component ---
export function App() {
  // --- App-chrome state ---
  const [contextMenu, setContextMenu] = useState({ show: false, x: 0, y: 0 });
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const [toastMessage, setToastMessage] = useState<{
    message: string;
    type: "success" | "error" | "info";
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [hasError, setHasError] = useState(false);
  // Audio: mountGlassViewer's <video>
  // element starts muted unconditionally (audio didn't exist when that
  // default was chosen - see viewer/index.ts's own comment, still correct
  // for guaranteeing autoplay works with zero user interaction). Real
  // sessions can now carry a genuine Opus track, so this example needs
  // its own explicit way to unmute - there was none at all until now.
  // Mirrors GlassViewer's own public surface (`viewer.video` is exposed
  // exactly for host needs like this one) rather than adding a new SDK
  // API just for a mute toggle.
  const [isMuted, setIsMuted] = useState(true);
  const [viewerReady, setViewerReady] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<GlassViewer | null>(null);

  const session = useGlassSession(setToastMessage);
  const {
    client, isActive, isConnected, isLoading, error, setError, sessionId,
    hijackedUrl, setHijackedUrl, pendingDownloads, setPendingDownloads,
    fileChooserMultiple, setFileChooserMultiple, uploading, setUploading, uploadError, setUploadError,
    micAccessOrigin, setMicAccessOrigin, micError, setMicError, micGranting, setMicGranting,
  } = session;
  const { fps, perfStats } = useStatsStream(sessionId);
  const closeContextMenu = useCallback(() => setContextMenu({ show: false, x: 0, y: 0 }), []);
  const { handleNavigate, handleNavigateBack, handleNavigateForward, handleRefresh } = useNavigation({
    client,
    isActive,
    setIsActive: session.setIsActive,
    setError,
    setIsLoading: session.setIsLoading,
    notify: setToastMessage,
    closeContextMenu,
    viewerReady,
    sessionEpoch: session.sessionEpoch,
  });

  // --- Global error boundary (browser-level) ---
  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      setHasError(true);
      setError(`Application error: ${event.error?.message || "Unknown error"}`);
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      setHasError(true);
      setError(`Promise error: ${event.reason?.message || "Unknown error"}`);
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  // --- Mount the viewer into the content area once the client + container
  // exist. The viewer captures all input and renders the video itself. ---
  useEffect(() => {
    if (!client || !isActive || !containerRef.current) return;
    const viewer = mountGlassViewer(containerRef.current, client, {
      // Gated on Shift so a plain right-click reaches the remote page's own
      // context menu (now properly forwarded - see viewer/index.ts's
      // onContextMenu doc comment) instead of this app's local copy/paste
      // popup covering it every time. Shift+right-click is a real, existing
      // convention (e.g. Chrome itself uses it to bypass a page's own
      // contextmenu handler and show its native one).
      onContextMenu: (x, y, shiftKey) => {
        if (shiftKey) setContextMenu({ show: true, x, y });
      },
    });
    viewerRef.current = viewer;
    setViewerReady(true);
    return () => {
      viewer.destroy();
      viewerRef.current = null;
      setViewerReady(false);
    };
  }, [client, isActive]);

  const handleToggleMute = useCallback(() => {
    const video = viewerRef.current?.video;
    if (!video) return;
    video.muted = !video.muted;
    setIsMuted(video.muted);
  }, []);

  const handleCopy = useCallback(() => {
    client?.copyText();
  }, [client]);
  const handlePaste = useCallback(async () => {
    if (!client?.isConnected()) return;
    try {
      const text = await navigator.clipboard.readText();
      client.pasteText(text);
    } catch (e) {
      console.error("Clipboard paste failed", e);
    }
  }, [client]);

  // Fires when the operator picks file(s) from the hidden input the
  // fileChooserOpened prompt below raises. The prompt stays visible
  // (showing an "Uploading…" state) until the POST resolves - only a real
  // success or a "fileChooserClosed" (server-side timeout/supersede)
  // dismisses it, matching how a real native file picker keeps whatever
  // waiting state the page is in until the browser actually delivers the
  // file. A failed upload leaves the prompt up with an error so the
  // operator can retry without having to trigger the remote page's file
  // input a second time.
  const handleFilesPicked = useCallback(
    async (e: Event) => {
      const input = e.currentTarget as HTMLInputElement;
      // input.files is a LIVE FileList tied to the input's own state -
      // resetting input.value below (to allow re-picking the same file
      // next time) clears it out from under us too, since it's the same
      // underlying object, not a snapshot. Array.from() copies the actual
      // File objects out first so clearing the input doesn't also empty
      // what we're about to upload.
      const files = Array.from(input.files ?? []);
      input.value = "";
      if (!client || files.length === 0) return;
      setUploading(true);
      setUploadError(null);
      try {
        await client.uploadFiles(files);
        setFileChooserMultiple(null);
      } catch (err: any) {
        setUploadError(err?.message || "Upload failed");
      } finally {
        setUploading(false);
      }
    },
    [client]
  );

  // Mic access prompt handlers -
  // grantMicAccess() itself does the real work (captures this device's
  // own microphone, swaps it onto the pre-negotiated placeholder track,
  // tells the backend); this is just the prompt's own state bookkeeping
  // around it, same pattern as handleFilesPicked above.
  const handleMicAllow = useCallback(async () => {
    if (!client) return;
    setMicGranting(true);
    setMicError(null);
    try {
      await client.grantMicAccess();
      setMicAccessOrigin(null);
    } catch (err: any) {
      // Real bug found live testing this for the first time: this used to
      // ALSO clear micAccessOrigin here, on the failure path - but that's
      // the exact flag {micAccessOrigin !== null && (...)} gates the whole
      // prompt's visibility on, so the prompt (and the error text just set
      // below) vanished in the same render pass, before it could ever be
      // seen. grantMicAccess() already denies the remote page
      // automatically on its own internal failure regardless - leaving
      // the prompt open here is purely so the operator actually SEES why,
      // instead of the prompt just silently disappearing with no
      // explanation (which is exactly what happened, confirmed live: a
      // real getUserMedia failure was occurring the whole time, but
      // looked like "nothing happened" from the operator's side).
      setMicError(err?.message || "Microphone access failed");
    } finally {
      setMicGranting(false);
    }
  }, [client]);

  const handleMicDeny = useCallback(() => {
    client?.denyMicAccess();
    setMicAccessOrigin(null);
  }, [client]);

  // Owner-controlled handoff (docs/protocol.md's "Owner-controlled
  // handoff" section) - act on a SPECIFIC other connection by ID. This
  // example deliberately never calls @glass/client's self-service
  // requestInput()/releaseInput() at all - by this app's own policy
  // choice (not something Glass enforces), only the owner ever changes
  // who can interact, via the roster panel below; a viewer can't request
  // control for itself, and the owner can't release its own. Also
  // silently denied server-side if this client isn't actually the owner
  // (see grantInput/revokeInput's own doc comments) - the "isOwner &&"
  // guard in the render below is what actually keeps these buttons from
  // showing to a non-owner in the first place.
  const handleGrantInput = useCallback(
    (connectionId: string) => {
      client?.grantInput(connectionId);
    },
    [client]
  );
  const handleRevokeInput = useCallback(
    (connectionId: string) => {
      client?.revokeInput(connectionId);
    },
    [client]
  );

  // Mints a watch-only grant for the current session and turns it into an
  // attach-mode URL for THIS SAME app (see the attachSessionId/
  // attachSignalingUrl handling in useGlassSession) - the
  // simplest way to actually exercise the handoff flow end to end: open
  // the resulting link in a second tab (or hand it to someone else), which
  // connects watch-only and can then click "Request control" there to see
  // this tab receive "Another viewer is requesting control".
  const handleShareWatchOnlyLink = useCallback(async () => {
    if (!sessionId) return;
    try {
      const grant = await mintConnectionGrant(
        sessionId,
        { consumesMedia: true },
        GLASS_ADDR,
        API_TOKEN
      );
      const attachUrl = new URL(window.location.href);
      attachUrl.search = "";
      attachUrl.searchParams.set("attachSessionId", sessionId);
      attachUrl.searchParams.set("attachSignalingUrl", grant.signalingUrl);
      await navigator.clipboard.writeText(attachUrl.toString());
      setToastMessage({
        message: "Watch-only link copied to clipboard",
        type: "success",
      });
    } catch (e: any) {
      console.error("Failed to mint watch-only link", e);
      setToastMessage({
        message: `Failed to create watch-only link: ${e.message}`,
        type: "error",
      });
    }
  }, [sessionId]);

  // --- Misc app-chrome effects ---
  useEffect(() => {
    if (toastMessage) {
      const timer = setTimeout(() => setToastMessage(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [toastMessage]);

  useEffect(() => {
    const handleClickAway = (event: MouseEvent) => {
      if (
        contextMenu.show &&
        contextMenuRef.current &&
        !contextMenuRef.current.contains(event.target as Node)
      ) {
        setContextMenu({ show: false, x: 0, y: 0 });
      }
    };
    window.addEventListener("mousedown", handleClickAway);
    return () => window.removeEventListener("mousedown", handleClickAway);
  }, [contextMenu.show]);

  const handleHijackedUrlClick = () => {
    if (hijackedUrl) {
      const newTabUrl = `${window.location.origin}${window.location.pathname}?navigate_to=${encodeURIComponent(hijackedUrl)}`;
      window.open(newTabUrl, "_blank");
      setHijackedUrl(null);
    }
  };

  // --- Render ---
  if (hasError) return <ErrorScreen error={error} />;

  return (
    <div
      class={`h-screen overflow-hidden ${
        !isActive ? "aurora-background" : "bg-slate-200"
      }`}
    >
      {!isActive ? (
        <WelcomeView onNavigate={handleNavigate} isConnected={isConnected} isLoading={isLoading} error={error} />
      ) : (
        <Suspense
          fallback={
            <div class="w-screen h-screen flex items-center justify-center">
              <CustomLoader />
            </div>
          }
        >
          <div class="browser-frame">
            <BrowserHeader
              onNavigate={handleNavigate}
              onNavigateBack={handleNavigateBack}
              onNavigateForward={handleNavigateForward}
              onRefresh={handleRefresh}
              disabled={!isConnected}
              isLoading={isLoading}
              isConnected={isConnected}
              fps={fps}
              viewportSize={{ width: 0, height: 0 }}
              canvasScale={{ x: 1, y: 1, offsetX: 0, offsetY: 0 }}
              performanceStats={perfStats}
              currentURL={session.currentURL}
              canGoBack={session.canGoBack}
              canGoForward={session.canGoForward}
              producesInput={session.producesInput}
              onShareWatchOnlyLink={handleShareWatchOnlyLink}
              isOwner={session.isOwner}
              connections={session.connections}
              onGrantInput={handleGrantInput}
              onRevokeInput={handleRevokeInput}
            />
            {/* Content area - the SDK viewer mounts its <video> + input capture
                into this container (see the mount effect above). */}
            <main ref={containerRef} class="content-area">
              {/* Gated on isConnected alone, not isLoading - a real,
                  live-found bug (2026-09-04, CNN dogfooding): isLoading
                  tracks the REMOTE PAGE's own navigation/load state, which on a heavy, ad-tech-saturated real site
                  can legitimately stay true for minutes - CNN's own cookie-
                  sync/RTB cascade left it true for 3+ minutes in one live
                  test. This overlay used to block the ENTIRE video behind a
                  translucent blur for that whole window even though
                  isConnected was already true and real video was actively
                  streaming and rendering the page as it loaded - exactly
                  the point of a remote-rendering product is watching the
                  page load live in the video itself, not waiting for the
                  remote page's own load event before showing anything.
                  isConnected (WebRTC transport up, same signal the landing
                  screen's "Connecting..." indicator already uses) is the
                  only thing that should ever hide the video; isLoading
                  still flows to BrowserHeader's own smaller, non-blocking
                  URL-bar indicator below. */}
              {!isConnected && (
                <div class="absolute inset-0 bg-white/30 backdrop-blur-sm flex items-center justify-center z-30">
                  {!isConnected && error ? (
                    <div class="text-center p-4 bg-red-100/80 border border-red-300 rounded-lg shadow">
                      <p class="text-red-700 font-semibold">{error}</p>
                    </div>
                  ) : (
                    <CustomLoader />
                  )}
                </div>
              )}
              {isConnected && session.sourceStalled && (
                <div class="absolute top-4 left-1/2 -translate-x-1/2 z-30 px-4 py-2 rounded-full bg-black/70 text-white text-sm shadow">
                  Source paused, waiting for it to reconnect…
                </div>
              )}
              {/* Mute toggle - the SDK's <video> element starts muted
                  unconditionally (see GlassViewer's own comment: it always
                  did, to guarantee autoplay with zero interaction, from
                  before real audio existed) - now that a session can carry
                  a genuine Opus track, this is the only way to actually
                  hear it. Shown only once connected, same gating as the
                  loading overlay above. */}
              {isConnected && (
                <button
                  type="button"
                  onClick={handleToggleMute}
                  class="absolute bottom-4 right-4 z-30 px-3 py-2 rounded-full bg-black/60 text-white text-sm hover:bg-black/80 transition-colors"
                  title={isMuted ? "Unmute" : "Mute"}
                >
                  {isMuted ? "Unmute" : "Mute"}
                </button>
              )}
            </main>
          </div>
        </Suspense>
      )}

      {/* --- Context Menu --- */}
      <Suspense fallback={<></>}>
        {contextMenu.show && (
          <ContextMenu
            ref={contextMenuRef}
            x={contextMenu.x}
            y={contextMenu.y}
            onCopy={handleCopy}
            onPaste={handlePaste}
            onClose={() => setContextMenu({ show: false, x: 0, y: 0 })}
          />
        )}
      </Suspense>

      {/* --- Toast Notifications --- */}
      {toastMessage && (
        <Toast
          message={toastMessage.message}
          type={toastMessage.type}
          onClose={() => setToastMessage(null)}
        />
      )}

      {hijackedUrl && (
        <HijackedUrlPrompt url={hijackedUrl} onOpen={handleHijackedUrlClick} onDismiss={() => setHijackedUrl(null)} />
      )}
      <DownloadPrompts
        downloads={pendingDownloads}
        onDone={(guid) => setPendingDownloads((prev) => prev.filter((d) => d.guid !== guid))}
      />
      {fileChooserMultiple !== null && (
        <UploadPrompt
          multiple={fileChooserMultiple}
          uploading={uploading}
          uploadError={uploadError}
          offset={pendingDownloads.length}
          fileInputRef={fileInputRef}
          onFilesPicked={handleFilesPicked}
          onDismiss={() => setFileChooserMultiple(null)}
        />
      )}
      {micAccessOrigin !== null && (
        <MicPrompt
          origin={micAccessOrigin}
          micError={micError}
          micGranting={micGranting}
          offset={pendingDownloads.length + (fileChooserMultiple !== null ? 1 : 0)}
          onAllow={handleMicAllow}
          onDeny={handleMicDeny}
          onDismiss={() => setMicAccessOrigin(null)}
        />
      )}
    </div>
  );
}
