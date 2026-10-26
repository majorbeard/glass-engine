import { defineConfig, loadEnv } from "vite";
import preact from "@preact/preset-vite";
import tailwindcss from "@tailwindcss/vite";

// isLocalAddress: the engine is on this machine or this private network
// (localhost, loopback, or an RFC 1918 address). Same rule as
// src/config.ts.
function isLocalAddress(addr: string): boolean {
  let host: string;
  try {
    host = new URL(addr).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  if (host === "localhost" || host === "::1" || /^127\./.test(host)) return true;
  const m = host.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// This example runs standalone against a separately-running `glass start`
// (see src/app.tsx's use of VITE_GLASS_ADDR / CORS on the backend) - it is
// never served BY the backend, so no dev-server proxy to it is needed here.
// The signaling WebSocket URL the backend hands back is already a full
// ws://<backend-host>/... URL (constructed server-side from the request),
// so a browser connects to it directly too.
export default defineConfig(({ mode }) => {
  // Every VITE_ variable ends up in the JavaScript a browser downloads. The
  // engine's API token gives full control of the engine, so it may be set
  // only for an engine on this machine or this private network, never for
  // a build or dev server that faces anyone else. Give the viewer session
  // links instead (see src/config.ts, CAN_CREATE_SESSIONS).
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const addr = env.VITE_GLASS_ADDR || "http://localhost:8080";
  if (env.VITE_GLASS_API_TOKEN && !isLocalAddress(addr)) {
    throw new Error(
      `VITE_GLASS_API_TOKEN is set for a non-local engine (${new URL(addr).host}). ` +
        "It would be readable by anyone who loads this viewer. Remove it; hand the viewer session links instead.",
    );
  }
  return {
    plugins: [preact(), tailwindcss()],
    server: {
      // Vite 5+ rejects any Host header it doesn't recognize by default -
      // fine for a normal local dev loop, but this example is also
      // sometimes reached through a tunnel (ngrok et al.) whose hostname is
      // ephemeral and unknowable in advance, e.g. testing against a real
      // phone/device with no other network path to the dev machine. `true`
      // disables the check entirely - acceptable here since this is dev-only
      // tooling a developer already consciously opted into running, not
      // something ever deployed as-is.
      allowedHosts: true,
    },
  };
});
