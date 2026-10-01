import type { CapacitorConfig } from "@capacitor/cli";

// Example-only app ID -
// this is a demo of how to build a producer, not a Glass-branded product,
// same status as examples/viewer-preact.
const config: CapacitorConfig = {
  appId: "com.glass.example.producer",
  appName: "Glass Producer Example",
  webDir: "dist",
  // Capacitor's default Android scheme serves the app's own page over
  // https://localhost. A plain-http Glass backend (the normal case for a
  // self-hosted LAN dev/test target) then gets blocked as mixed content by
  // the WebView's own rendering engine before any request is even sent -
  // silently, with no network trace and no useful error beyond "failed to
  // fetch". Matching the page's own scheme to http avoids that entirely.
  server: {
    androidScheme: "http",
  },
};

export default config;
