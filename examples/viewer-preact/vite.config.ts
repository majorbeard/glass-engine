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
});
