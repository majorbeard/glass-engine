import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

// Runs as a Capacitor-wrapped Android app (see capacitor.config.ts) - the
// built dist/ is what `npx cap sync android` copies into the native
// project's assets, not something served by Vite's own dev server on a
// real device. `npm run dev` still works for iterating on the UI/logic in
// a desktop browser first (no camera-permission/native-build round trip
// needed for that part) - see src/producer.ts's own doc comment for what
// that catches versus what still needs a real device.
export default defineConfig({
  plugins: [preact()],
  server: {
    // Reachable from a phone on the same LAN during `npm run dev` -
    // Capacitor's own WebView build doesn't use this, but pointing a
    // phone's browser at the dev server directly (bypassing the native
    // wrapper entirely) is a useful, faster iteration loop while the UI
    // itself is still changing.
    host: true,
  },
});
