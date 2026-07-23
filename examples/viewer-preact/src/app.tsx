import { useState, useEffect, useRef, useCallback } from "preact/hooks";
import { lazy, Suspense } from "preact/compat";
import {
  createGlassClient,
  createGlassSession,
  deleteGlassSession,
  type GlassClient,
} from "@glass/client";
import { mountGlassViewer, type GlassViewer } from "@glass/client/viewer";
import { Toast } from "./components/Toast";
import { BrowserHeader } from "./components/BrowserHeader";
import { URLBar } from "./components/URLBar";

// This example is a thin consumer of the Glass client SDK: @glass/client owns
// the transport + reconnection, and @glass/client/viewer owns video rendering
// and all mouse/touch/keyboard/scroll/viewport input capture. Everything below
// is just app-chrome (URL bar, header, context menu, toasts) wired to the
// client's events - the reusable engine loop lives in the package, not here.

// This example runs standalone (`npm run dev`), a genuinely different origin
// from the `glass start` backend it talks to - Glass has no product frontend
// and never serves this itself. VITE_GLASS_ADDR overrides the default for
// anyone not running the backend on localhost:8080; the backend's CORS
// middleware (runtime/routes.go) allows any loopback/private-LAN origin, not
// just this one, so this doesn't need to match any specific dev-server port.
const GLASS_ADDR = import.meta.env.VITE_GLASS_ADDR ?? "http://localhost:8080";

// Optional TURN/STUN override for this browser peer's own RTCPeerConnection -
// mirrors the backend's GLASS_STUN_URLS/GLASS_TURN_URLS/etc (runtime/
// runtime.go). Unset by default, falling back to @glass/client's own public-
// STUN default - only matters when testing/deploying against a real TURN
// server, since the backend and this browser peer each gather their own ICE
// candidates independently and need to agree on where the TURN server is.
// VITE_GLASS_ICE_TRANSPORT_POLICY=relay forces this peer to relay-only ICE -
// useful to prove a TURN server actually relays media, since on a LAN or
// same-machine test a direct/STUN path would otherwise succeed first and
// mask a broken TURN config entirely.
function iceServersFromEnv(): RTCIceServer[] | undefined {
  const stunURLs = import.meta.env.VITE_GLASS_STUN_URLS as string | undefined;
  const turnURLs = import.meta.env.VITE_GLASS_TURN_URLS as string | undefined;
  if (!stunURLs && !turnURLs) return undefined;

  const servers: RTCIceServer[] = [];
  if (stunURLs) {
    servers.push({ urls: stunURLs.split(",").map((u) => u.trim()) });
  }
  if (turnURLs) {
    servers.push({
      urls: turnURLs.split(",").map((u) => u.trim()),
      username: import.meta.env.VITE_GLASS_TURN_USERNAME,
      credential: import.meta.env.VITE_GLASS_TURN_CREDENTIAL,
    });
  }
  return servers;
}

const ICE_SERVERS = iceServersFromEnv();
const ICE_TRANSPORT_POLICY = import.meta.env
  .VITE_GLASS_ICE_TRANSPORT_POLICY as RTCIceTransportPolicy | undefined;

// Optional dev-testing convenience, mirroring the backend's GLASS_API_TOKEN
// (runtime/runtime.go's Config.APIToken) - unset by default (auth off,
// unchanged behavior). NOT how a real deployment should work: a genuine
// GLASS_API_TOKEN is a server-side secret that belongs in your own backend,
// which creates the session and hands this app only the resulting
// signalingUrl (already carrying whatever the runtime needs - see
// createGlassSession's doc comment in @glass/client) - never in a value
// baked into a browser bundle via VITE_*, which anyone can read from the
// shipped JS. This exists purely so this standalone example can be
// exercised end-to-end against a token-gated runtime during local testing.
const API_TOKEN = import.meta.env.VITE_GLASS_API_TOKEN as string | undefined;

const ContextMenu = lazy(() =>
  import("./components/ContextMenu").then((mod) => ({
    default: mod.ContextMenu,
  }))
);

// --- Loader component ---
const CustomLoader = () => (
  <div class="flex flex-col items-center justify-center gap-4">
    <div class="text-lg font-semibold text-slate-700">Loading Session...</div>
    <div class="flex items-center gap-2">
      <div class="w-3 h-3 bg-blue-500 rounded-full animate-bounce [animation-delay:-0.3s]"></div>
      <div class="w-3 h-3 bg-slate-600 rounded-full animate-bounce [animation-delay:-0.15s]"></div>
      <div class="w-3 h-3 bg-blue-500 rounded-full animate-bounce"></div>
    </div>
  </div>
);

// --- Main App Component ---
export function App() {
  // --- State ---
  const [isActive, setIsActive] = useState(false);
  const [client, setClient] = useState<GlassClient | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState({ show: false, x: 0, y: 0 });
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const [toastMessage, setToastMessage] = useState<{
    message: string;
    type: "success" | "error" | "info";
  } | null>(null);
  const [hijackedUrl, setHijackedUrl] = useState<string | null>(null);
  const [currentURL, setCurrentURL] = useState("");
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [hasError, setHasError] = useState(false);

  // The viewer must exist before the first navigation so its on-connect
  // initial-viewport/mobile declaration reaches the backend before the page is
  // created (see mountGlassViewer's doc comment). handleNavigate flips isActive
  // - which mounts the viewer - and stashes the URL here; a post-mount effect
  // then issues the navigate.
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);
  const [viewerReady, setViewerReady] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<GlassViewer | null>(null);

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

  // --- Client lifecycle: create a session, build the client, connect. The SDK
  // owns reconnection/backoff internally - the app just reflects its events. ---
  useEffect(() => {
    let cancelled = false;
    let c: GlassClient | null = null;

    (async () => {
      let session: { id: string; signalingUrl: string };
      try {
        session = await createGlassSession(GLASS_ADDR, API_TOKEN);
      } catch (err: any) {
        if (!cancelled) setError(`Failed to create session: ${err.message}`);
        return;
      }
      if (cancelled) {
        deleteGlassSession(session.id, GLASS_ADDR, API_TOKEN);
        return;
      }

      c = createGlassClient({
        signalingUrl: session.signalingUrl,
        sessionId: session.id,
        ...(ICE_SERVERS ? { iceServers: ICE_SERVERS } : {}),
        ...(ICE_TRANSPORT_POLICY
          ? { iceTransportPolicy: ICE_TRANSPORT_POLICY }
          : {}),
        ...(API_TOKEN ? { apiToken: API_TOKEN } : {}),
      });

      c.on("connected", () => {
        if (cancelled) return;
        setIsConnected(true);
        setError(null);
      });
      c.on("disconnected", () => {
        if (!cancelled) setIsConnected(false);
      });
      c.on("reconnecting", (attempt, max) => {
        if (!cancelled) setError(`Reconnecting… (attempt ${attempt}/${max})`);
      });
      c.on("navigation", (nav) => {
        if (cancelled) return;
        setCurrentURL(nav.url || "");
        setCanGoBack(nav.canGoBack || false);
        setCanGoForward(nav.canGoForward || false);
        setIsLoading(nav.loading || false);
      });
      c.on("error", (message) => {
        if (!cancelled) setError(message);
      });
      c.on("closed", (reason) => {
        if (cancelled) return;
        setIsConnected(false);
        // A user-initiated disconnect closes silently; a lost/exhausted
        // connection surfaces an actionable message.
        if (!reason.includes("client disconnected")) {
          setError("Connection lost and could not be restored. Please reload.");
        }
      });

      setClient(c);
      try {
        await c.connect();
      } catch {
        // The "closed" handler above already surfaced the failure.
      }
    })();

    return () => {
      cancelled = true;
      c?.disconnect();
      setClient(null);
      setIsConnected(false);
    };
  }, []);

  // --- Mount the viewer into the content area once the client + container
  // exist. The viewer captures all input and renders the video itself. ---
  useEffect(() => {
    if (!client || !isActive || !containerRef.current) return;
    const viewer = mountGlassViewer(containerRef.current, client, {
      onContextMenu: (x, y) => setContextMenu({ show: true, x, y }),
    });
    viewerRef.current = viewer;
    setViewerReady(true);
    return () => {
      viewer.destroy();
      viewerRef.current = null;
      setViewerReady(false);
    };
  }, [client, isActive]);

  // --- Navigation ---
  const handleNavigate = useCallback(
    (url: string) => {
      if (!client || !client.isConnected()) {
        setError("Cannot navigate: Not connected");
        setToastMessage({ message: "Connection lost.", type: "error" });
        return;
      }
      setContextMenu({ show: false, x: 0, y: 0 });
      setError(null);
      setIsLoading(true);
      if (!isActive) {
        // Defer the navigate until the viewer has mounted (see pendingUrl).
        setIsActive(true);
        setPendingUrl(url);
      } else {
        client.navigate(url);
      }
    },
    [client, isActive]
  );

  useEffect(() => {
    if (viewerReady && pendingUrl && client) {
      client.navigate(pendingUrl);
      setPendingUrl(null);
    }
  }, [viewerReady, pendingUrl, client]);

  const handleNavigateBack = useCallback(() => {
    if (client?.isConnected()) client.navigateBack();
  }, [client]);
  const handleNavigateForward = useCallback(() => {
    if (client?.isConnected()) client.navigateForward();
  }, [client]);
  const handleRefresh = useCallback(() => {
    if (client?.isConnected()) client.refresh();
  }, [client]);

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
  if (hasError) {
    return (
      <div class="h-screen flex items-center justify-center bg-red-50">
        <div class="text-center p-8">
          <h1 class="text-2xl font-bold text-red-600 mb-4">
            Something went wrong
          </h1>
          <p class="text-slate-700 mb-6">
            An application error occurred. Please try reloading the page.
          </p>
          <button
            onClick={() => window.location.reload()}
            class="px-5 py-2 bg-red-600 text-white rounded-lg font-semibold shadow hover:bg-red-700 transition-colors"
          >
            Reload Page
          </button>
          {error && (
            <p class="text-xs text-red-500 mt-4 p-2 bg-red-100 rounded">
              {error}
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      class={`h-screen overflow-hidden ${
        !isActive ? "aurora-background" : "bg-slate-200"
      }`}
    >
      {!isActive ? (
        // --- Welcome / URL Entry View ---
        <div class="w-full h-full flex flex-col items-center justify-center gap-6 p-4">
          <h1 class="text-7xl font-thin tracking-[0.2em] text-white/90">
            Glass
          </h1>
          <div class="w-full max-w-xl">
            <URLBar
              onNavigate={handleNavigate}
              onNavigateBack={() => {}}
              onNavigateForward={() => {}}
              onRefresh={() => {}}
              disabled={!isConnected && !error}
              isLoading={isLoading || (!isConnected && !error)}
              isActive={false}
            />
          </div>
          {!isConnected && !error && (
            <div class="absolute bottom-4 right-4 text-sm text-white/80 bg-black/30 px-3 py-1 rounded-full animate-pulse">
              Connecting...
            </div>
          )}
          {error && (
            <div class="absolute bottom-4 right-4 text-sm text-red-100 bg-red-600/80 px-3 py-1 rounded-full">
              {error}
            </div>
          )}
        </div>
      ) : (
        // --- Browser View ---
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
              fps={0}
              viewportSize={{ width: 0, height: 0 }}
              canvasScale={{ x: 1, y: 1, offsetX: 0, offsetY: 0 }}
              performanceStats={null}
              currentURL={currentURL}
              canGoBack={canGoBack}
              canGoForward={canGoForward}
            />
            {/* Content area - the SDK viewer mounts its <video> + input capture
                into this container (see the mount effect above). */}
            <main ref={containerRef} class="content-area">
              {(isLoading || !isConnected) && (
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

      {/* --- Hijacked URL Popup --- */}
      {hijackedUrl && (
        <div
          class="fixed bottom-6 right-6 z-50 cursor-pointer animate-fade-in"
          onClick={handleHijackedUrlClick}
        >
          <div class="flex items-center gap-4 px-4 py-3 rounded-lg border-2 border-black shadow-lg bg-yellow-100 text-yellow-800">
            <div class="flex-shrink-0">
              <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                <path
                  fill-rule="evenodd"
                  d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.428a1 1 0 00.475 0l5 1.428a1 1 0 001.17-1.409l-7-14zM10 4.868L12.89 10.612 10 9.788l-2.89 2.824L10 4.868z"
                  clip-rule="evenodd"
                />
              </svg>
            </div>
            <div class="text-sm font-bold">
              <p>Blocked navigation to a new URL.</p>
              <p class="font-mono text-xs truncate max-w-xs">{hijackedUrl}</p>
              <p class="font-semibold text-blue-600 hover:underline">
                Click here to open in a new tab.
              </p>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                setHijackedUrl(null);
              }}
              class="flex-shrink-0 text-current opacity-70 hover:opacity-100"
            >
              {" "}
              &times;{" "}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
