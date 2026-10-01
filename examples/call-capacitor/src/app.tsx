import { useEffect, useRef, useState } from "preact/hooks";
import { startCall, type CallHandle, type CallInfo, type CallState } from "./call";

const STORAGE_KEY = "glass-call-server-url";
const TOKEN_STORAGE_KEY = "glass-call-api-token";
const TURN_URL_STORAGE_KEY = "glass-call-turn-url";
const TURN_USER_STORAGE_KEY = "glass-call-turn-username";
const TURN_CRED_STORAGE_KEY = "glass-call-turn-credential";

export function App() {
  const [serverUrl, setServerUrl] = useState(() => localStorage.getItem(STORAGE_KEY) ?? "");
  const [apiToken, setApiToken] = useState(() => localStorage.getItem(TOKEN_STORAGE_KEY) ?? "");
  const [turnUrl, setTurnUrl] = useState(() => localStorage.getItem(TURN_URL_STORAGE_KEY) ?? "");
  const [turnUsername, setTurnUsername] = useState(() => localStorage.getItem(TURN_USER_STORAGE_KEY) ?? "");
  const [turnCredential, setTurnCredential] = useState(() => localStorage.getItem(TURN_CRED_STORAGE_KEY) ?? "");
  const [joinUrl, setJoinUrl] = useState("");
  const [state, setState] = useState<CallState>("idle");
  const [detail, setDetail] = useState("");
  const [call, setCall] = useState<CallInfo | null>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const handleRef = useRef<CallHandle | null>(null);

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

  // Stop media/PC if the page itself goes away - same rationale as
  // producer.tsx's own equivalent cleanup.
  useEffect(() => () => handleRef.current?.stop(), []);

  const turnServer = turnUrl ? { url: turnUrl, username: turnUsername, credential: turnCredential } : undefined;

  const begin = async (mode: "create" | "join") => {
    if (mode === "create" && !serverUrl) {
      setState("error");
      setDetail("enter a server URL first");
      return;
    }
    if (mode === "join" && !joinUrl) {
      setState("error");
      setDetail("paste a call link first");
      return;
    }
    setDetail("");
    setCall(null);
    // startCall() is synchronous and returns its handle immediately - see
    // its own doc comment. Assigning handleRef here, before anything async
    // has run, is what makes a Stop click during setup actually reach it.
    handleRef.current = startCall({
      mode,
      serverUrl: mode === "create" ? serverUrl : undefined,
      apiToken: apiToken || undefined,
      signalingUrl: mode === "join" ? joinUrl : undefined,
      turnServer,
      onStateChange: (s, d) => {
        setState(s);
        setDetail(d ?? "");
      },
      onLocalStream: (stream) => {
        if (localVideoRef.current) localVideoRef.current.srcObject = stream;
      },
      onRemoteStream: (stream) => {
        if (remoteVideoRef.current) remoteVideoRef.current.srcObject = stream;
      },
      onCallCreated: setCall,
    });
  };

  const stop = () => {
    handleRef.current?.stop();
    handleRef.current = null;
  };

  const isActive = state !== "idle" && state !== "stopped" && state !== "error";
  const copy = (text: string) => {
    navigator.clipboard.writeText(text).catch((err) => {
      console.error("failed to copy", err);
    });
  };

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
      <h1 style={{ fontSize: "1.2rem", margin: 0 }}>Glass Call Example</h1>
      <p style={{ opacity: 0.7, fontSize: "0.85rem" }}>
        Two-party video calling over Glass's /v1/calls API. No QR pairing here (the two devices may not
        be in the same room) — share the call link through whatever channel
        actually reaches the other phone.
      </p>

      <label style={{ display: "block", marginTop: "1rem" }}>
        Glass server URL (needed to start a new call)
        <input
          type="text"
          value={serverUrl}
          onInput={(e) => setServerUrl((e.target as HTMLInputElement).value)}
          placeholder="http://192.168.1.20:8080"
          disabled={isActive}
          style={{ display: "block", width: "100%", padding: "0.5rem", marginTop: "0.25rem", boxSizing: "border-box" }}
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
          style={{ display: "block", width: "100%", padding: "0.5rem", marginTop: "0.25rem", boxSizing: "border-box" }}
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

      {!isActive && (
        <>
          <div style={{ marginTop: "1rem" }}>
            <button onClick={() => begin("create")} style={{ padding: "0.75rem 1.5rem" }}>
              Start a new call
            </button>
          </div>

          <p style={{ textAlign: "center", opacity: 0.5, margin: "0.75rem 0" }}>— or —</p>

          <label style={{ display: "block" }}>
            Call link (paste what the other device shared with you)
            <input
              type="text"
              value={joinUrl}
              onInput={(e) => setJoinUrl((e.target as HTMLInputElement).value)}
              placeholder="ws://192.168.1.20:8080/v1/calls/.../peers/b/signaling?token=..."
              style={{ display: "block", width: "100%", padding: "0.5rem", marginTop: "0.25rem", boxSizing: "border-box" }}
            />
          </label>
          <div style={{ marginTop: "0.5rem" }}>
            <button onClick={() => begin("join")} style={{ padding: "0.75rem 1.5rem" }}>
              Join that call
            </button>
          </div>
        </>
      )}

      {isActive && (
        <div style={{ marginTop: "1rem" }}>
          <button onClick={stop} style={{ padding: "0.75rem 1.5rem" }}>
            End call
          </button>
        </div>
      )}

      <p style={{ marginTop: "1rem" }}>
        status: <strong>{state}</strong> {detail && <span style={{ opacity: 0.7 }}>({detail})</span>}
      </p>

      {call && (
        <div style={{ marginTop: "1rem", padding: "0.75rem", background: "#1c1c1c", borderRadius: "8px" }}>
          <p style={{ fontSize: "0.85rem", opacity: 0.9, margin: 0 }}>
            You're peer A on call <code>{call.id}</code>. Send the link below to the other phone — they paste it
            into their app's "Call link" field and tap "Join that call":
          </p>
          <p style={{ fontSize: "0.75rem", wordBreak: "break-all", marginTop: "0.5rem" }}>
            <code>{call.peerBUrl}</code>
          </p>
          <button onClick={() => copy(call.peerBUrl)} style={{ padding: "0.5rem 1rem" }}>
            Copy call link for the other phone
          </button>
        </div>
      )}

      <div style={{ display: "flex", gap: "0.5rem", marginTop: "1rem", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 45%", minWidth: "140px" }}>
          <p style={{ fontSize: "0.75rem", opacity: 0.7, margin: "0 0 0.25rem" }}>you</p>
          <video
            ref={localVideoRef}
            autoPlay
            playsInline
            muted
            style={{ width: "100%", background: "#000", borderRadius: "8px" }}
          />
        </div>
        <div style={{ flex: "1 1 45%", minWidth: "140px" }}>
          <p style={{ fontSize: "0.75rem", opacity: 0.7, margin: "0 0 0.25rem" }}>them</p>
          <video
            ref={remoteVideoRef}
            autoPlay
            playsInline
            style={{ width: "100%", background: "#000", borderRadius: "8px" }}
          />
        </div>
      </div>
    </div>
  );
}
