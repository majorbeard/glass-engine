import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import tailwindcss from "@tailwindcss/vite";

// This example runs standalone against a separately-running `glass start`
// (see src/app.tsx's use of VITE_GLASS_ADDR / CORS on the backend) - it is
// never served BY the backend, so no dev-server proxy to it is needed here.
// The signaling WebSocket URL the backend hands back is already a full
// ws://<backend-host>/... URL (constructed server-side from the request),
// so a browser connects to it directly too.
export default defineConfig({
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
});
