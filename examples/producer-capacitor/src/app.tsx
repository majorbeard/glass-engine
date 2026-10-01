import { useEffect, useRef, useState } from "preact/hooks";
import QRCode from "qrcode";
import { startProducer, type ProducerHandle, type ProducerState, type ProducerStats } from "./producer";

const STORAGE_KEY = "glass-producer-server-url";
const TOKEN_STORAGE_KEY = "glass-producer-api-token";
const TURN_URL_STORAGE_KEY = "glass-producer-turn-url";
const TURN_USER_STORAGE_KEY = "glass-producer-turn-username";
const TURN_CRED_STORAGE_KEY = "glass-producer-turn-credential";
// A hosted viewer (e.g. examples/viewer-preact deployed to Vercel) - not
// the Glass server itself. Configurable rather than hardcoded since which
// viewer deployment to point at is a real per-tester choice, not a fixed
// product default (Glass has no product frontend - see viewer-preact's own
// header comment).
const VIEWER_URL_STORAGE_KEY = "glass-producer-viewer-url";
// Cap on the upload bitrate (kbps). Blank = the producer's default (1000); 0 = uncapped. Set it below the
// link's real uplink capacity - see GlassProducerOptions.maxBitrateKbps in @glass/client.
const MAX_BITRATE_STORAGE_KEY = "glass-producer-max-bitrate-kbps";

export function App() {
  const [serverUrl, setServerUrl] = useState(() => localStorage.getItem(STORAGE_KEY) ?? "");
  const [apiToken, setApiToken] = useState(() => localStorage.getItem(TOKEN_STORAGE_KEY) ?? "");
  const [turnUrl, setTurnUrl] = useState(() => localStorage.getItem(TURN_URL_STORAGE_KEY) ?? "");
  const [turnUsername, setTurnUsername] = useState(() => localStorage.getItem(TURN_USER_STORAGE_KEY) ?? "");
  const [turnCredential, setTurnCredential] = useState(() => localStorage.getItem(TURN_CRED_STORAGE_KEY) ?? "");
  const [viewerUrl, setViewerUrl] = useState(() => localStorage.getItem(VIEWER_URL_STORAGE_KEY) ?? "");
  const [maxBitrate, setMaxBitrate] = useState(() => localStorage.getItem(MAX_BITRATE_STORAGE_KEY) ?? "1000");
  const [state, setState] = useState<ProducerState>("idle");
  const [detail, setDetail] = useState("");
  const [session, setSession] = useState<{ id: string; signalingUrl: string } | null>(null);
  const [stats, setStats] = useState<ProducerStats | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const qrCanvasRef = useRef<HTMLCanvasElement>(null);
  const handleRef = useRef<ProducerHandle | null>(null);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, serverUrl);
  }, [serverUrl]);

  useEffect(() => {
    localStorage.setItem(TOKEN_STORAGE_KEY, apiToken);
  }, [apiToken]);

  useEffect(() => {
    localStorage.setItem(TURN_URL_STORAGE_KEY, turnUrl);
  }, [turnUrl]);
  useEffect(() => {
    localStorage.setItem(TURN_USER_STORAGE_KEY, turnUsername);
  }, [turnUsername]);
  useEffect(() => {
    localStorage.setItem(TURN_CRED_STORAGE_KEY, turnCredential);
  }, [turnCredential]);
  useEffect(() => {
    localStorage.setItem(VIEWER_URL_STORAGE_KEY, viewerUrl);
  }, [viewerUrl]);
  useEffect(() => {
    localStorage.setItem(MAX_BITRATE_STORAGE_KEY, maxBitrate);
  }, [maxBitrate]);

  // The link a hosted viewer needs to attach to this exact session
  // (examples/viewer-preact's ?attachSessionId=&attachSignalingUrl=
  // escape hatch) - built as soon as the session exists, since the whole
  // point of showing this as a QR code is letting a *different* device
  // open it without ever backgrounding this app (which drops the camera
  // connection - Android suspends a backgrounded WebView's WebRTC/socket
  // activity almost immediately, confirmed live). Undefined until both a
  // session exists and a viewer URL is configured.
  const watchUrl =
    session && viewerUrl
      ? `${viewerUrl.replace(/\/$/, "")}/?attachSessionId=${encodeURIComponent(
          session.id
        )}&attachSignalingUrl=${encodeURIComponent(session.signalingUrl)}`
      : undefined;

  useEffect(() => {
    if (!watchUrl || !qrCanvasRef.current) return;
    QRCode.toCanvas(qrCanvasRef.current, watchUrl, { width: 220 }).catch((err) => {
      console.error("failed to render watch-link QR code", err);
    });
  }, [watchUrl]);

  // Stop the camera/peer connection if the page itself goes away - a
  // Capacitor WebView can be backgrounded/killed like any app, and this at
  // least covers a normal navigate-away/reload during dev iteration.
  useEffect(() => () => handleRef.current?.stop(), []);

  const start = async () => {
    if (!serverUrl) {
      setState("error");
      setDetail("enter a server URL first");
      return;
    }
    setDetail("");
    setSession(null);
    setStats(null);
    // startProducer() is synchronous and returns its handle immediately
    // (the actual connect work runs internally) - see its own doc comment
    // for why: assigning handleRef here, before anything async has run,
    // is what makes a Stop click during setup actually able to reach it.
    handleRef.current = startProducer({
      serverUrl,
      apiToken: apiToken || undefined,
      turnServer: turnUrl
        ? { url: turnUrl, username: turnUsername, credential: turnCredential }
        : undefined,
      maxBitrateKbps: maxBitrate.trim() === "" || Number.isNaN(Number(maxBitrate)) ? undefined : Number(maxBitrate),
      onStateChange: (s, d) => {
        setState(s);
        setDetail(d ?? "");
      },
      onLocalStream: (stream) => {
        if (videoRef.current) videoRef.current.srcObject = stream;
      },
      onSessionCreated: setSession,
      onStats: setStats,
    });
  };

  const stop = () => {
    handleRef.current?.stop();
    handleRef.current = null;
  };

  const isActive = state !== "idle" && state !== "stopped" && state !== "error";

  return (
    <div
      style={{
        padding: "1rem",
        fontFamily: "sans-serif",
        color: "#fff",
        background: "#111",
        minHeight: "100vh",
        boxSizing: "border-box",
      }}
    >
      <h1 style={{ fontSize: "1.2rem", margin: 0 }}>Glass Producer Example</h1>
      <p style={{ opacity: 0.7, fontSize: "0.85rem" }}>
        Streams this device's camera into a Glass relay session.
      </p>

      <label style={{ display: "block", marginTop: "1rem" }}>
        Glass server URL
        <input
          type="text"
          value={serverUrl}
          onInput={(e) => setServerUrl((e.target as HTMLInputElement).value)}
          placeholder="http://192.168.1.20:8080"
          disabled={isActive}
          style={{
            display: "block",
            width: "100%",
            padding: "0.5rem",
            marginTop: "0.25rem",
            boxSizing: "border-box",
          }}
        />
      </label>

      <label style={{ display: "block", marginTop: "0.75rem" }}>
        API token (only if the server requires one)
        <input
          type="text"
          value={apiToken}
          onInput={(e) => setApiToken((e.target as HTMLInputElement).value)}
          placeholder="leave blank if none"
          disabled={isActive}
          style={{
            display: "block",
            width: "100%",
            padding: "0.5rem",
            marginTop: "0.25rem",
            boxSizing: "border-box",
          }}
        />
      </label>

      <label style={{ display: "block", marginTop: "0.75rem" }}>
        Viewer URL (for the watch-link QR code, optional)
        <input
          type="text"
          value={viewerUrl}
          onInput={(e) => setViewerUrl((e.target as HTMLInputElement).value)}
          placeholder="https://your-viewer.vercel.app"
          disabled={isActive}
          style={{
            display: "block",
            width: "100%",
            padding: "0.5rem",
            marginTop: "0.25rem",
            boxSizing: "border-box",
          }}
        />
      </label>

      <label style={{ display: "block", marginTop: "0.75rem" }}>
        Max upload bitrate, kbps (0 = uncapped; keep below your uplink speed)
        <input
          type="number"
          inputMode="numeric"
          min="0"
          value={maxBitrate}
          onInput={(e) => setMaxBitrate((e.target as HTMLInputElement).value)}
          placeholder="1000"
          disabled={isActive}
          style={{
            display: "block",
            width: "100%",
            padding: "0.5rem",
            marginTop: "0.25rem",
            boxSizing: "border-box",
          }}
        />
      </label>

      <details style={{ marginTop: "0.75rem" }}>
        <summary style={{ cursor: "pointer", opacity: 0.85 }}>
          TURN server (optional — needed across real, separate networks)
        </summary>
        <label style={{ display: "block", marginTop: "0.5rem" }}>
          TURN URL
          <input
            type="text"
            value={turnUrl}
            onInput={(e) => setTurnUrl((e.target as HTMLInputElement).value)}
            placeholder="turn:host:port"
            disabled={isActive}
            style={{ display: "block", width: "100%", padding: "0.5rem", marginTop: "0.25rem", boxSizing: "border-box" }}
          />
        </label>
        <label style={{ display: "block", marginTop: "0.5rem" }}>
          TURN username
          <input
            type="text"
            value={turnUsername}
            onInput={(e) => setTurnUsername((e.target as HTMLInputElement).value)}
            disabled={isActive}
            style={{ display: "block", width: "100%", padding: "0.5rem", marginTop: "0.25rem", boxSizing: "border-box" }}
          />
        </label>
        <label style={{ display: "block", marginTop: "0.5rem" }}>
          TURN credential
          <input
            type="password"
            value={turnCredential}
            onInput={(e) => setTurnCredential((e.target as HTMLInputElement).value)}
            disabled={isActive}
            style={{ display: "block", width: "100%", padding: "0.5rem", marginTop: "0.25rem", boxSizing: "border-box" }}
          />
        </label>
      </details>

      <div style={{ marginTop: "1rem" }}>
        {isActive ? (
          <button onClick={stop} style={{ padding: "0.75rem 1.5rem" }}>
            Stop
          </button>
        ) : (
          <button onClick={start} style={{ padding: "0.75rem 1.5rem" }}>
            Start streaming
          </button>
        )}
      </div>

      <p style={{ marginTop: "1rem" }}>
        status:{" "}
        <strong style={{ color: state === "reconnecting" ? "#fa0" : state === "streaming" ? "#4c4" : undefined }}>
          {state}
        </strong>{" "}
        {detail && <span style={{ opacity: 0.7 }}>({detail})</span>}
      </p>

      {session && (
        <p style={{ fontSize: "0.8rem", wordBreak: "break-all", opacity: 0.8 }}>
          session <code>{session.id}</code>
          {watchUrl ? (
            // watchUrl (the wrapped ?attachSessionId=&attachSignalingUrl=
            // link a hosted viewer actually understands), not the bare
            // session.signalingUrl below - a real bug found live
            // (2026-09-10): this used to show the raw wss:// signaling
            // endpoint here, which isn't a URL any browser can navigate to
            // on its own. Copying/sharing that directly just produced
            // ERR_UNKNOWN_URL_SCHEME for whoever opened it.
            <>
              <br />
              watch it: <code>{watchUrl}</code>
            </>
          ) : (
            <>
              <br />
              <span style={{ opacity: 0.7 }}>
                set a Viewer URL above to get a shareable watch link (shown here instead of
                the raw signaling endpoint below, which isn't itself openable in a browser)
              </span>
              <br />
              raw signaling endpoint: <code>{session.signalingUrl}</code>
            </>
          )}
        </p>
      )}

      {watchUrl && (
        <div style={{ marginTop: "1rem", textAlign: "center" }}>
          <p style={{ fontSize: "0.85rem", opacity: 0.85, marginBottom: "0.5rem" }}>
            Scan to watch — no need to leave this app:
          </p>
          <canvas
            ref={qrCanvasRef}
            style={{ background: "#fff", padding: "0.5rem", borderRadius: "8px" }}
          />
          <p style={{ marginTop: "0.5rem" }}>
            <button
              onClick={() => {
                navigator.clipboard.writeText(watchUrl).catch((err) => {
                  console.error("failed to copy watch link", err);
                });
              }}
              style={{ padding: "0.5rem 1rem" }}
            >
              Copy watch link
            </button>
          </p>
        </div>
      )}

      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        style={{
          width: "100%",
          marginTop: "1rem",
          background: "#000",
          borderRadius: "8px",
        }}
      />

      {stats && (
        <div
          style={{
            marginTop: "1rem",
            padding: "0.75rem",
            background: "#1c1c1c",
            borderRadius: "8px",
            fontSize: "0.8rem",
            fontFamily: "monospace",
            lineHeight: 1.6,
          }}
        >
          <div>
            camera: {stats.sourceFps?.toFixed(1) ?? "—"} fps
            {stats.frameWidth && stats.frameHeight
              ? ` @ ${stats.frameWidth}x${stats.frameHeight}`
              : ""}
          </div>
          <div>upload: {stats.uploadBitrateKbps.toFixed(0)} kbps</div>
          <div>rtt: {stats.rttMs !== null ? `${stats.rttMs.toFixed(0)}ms` : "—"}</div>
          <div>
            packets lost: {stats.packetsLost !== null ? stats.packetsLost : "—"}
          </div>
          <div>
            battery:{" "}
            {stats.battery
              ? `${(stats.battery.level * 100).toFixed(0)}%${stats.battery.charging ? " (charging)" : ""}`
              : "unavailable"}
          </div>
          <div>
            network:{" "}
            {stats.network
              ? `${stats.network.type ?? stats.network.effectiveType ?? "unknown"}${
                  stats.network.downlinkMbps !== null ? ` (~${stats.network.downlinkMbps}Mbps)` : ""
                }`
              : "unavailable"}
          </div>
        </div>
      )}
    </div>
  );
}
