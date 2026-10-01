import type { CapacitorConfig } from "@capacitor/cli";

// Example-only app ID - a demo of how
// to build a real bidirectional call client against Glass's /v1/calls API,
// not a Glass-branded product, same status as examples/producer-capacitor
// and examples/viewer-preact. Cloned from examples/producer-capacitor's own
// native scaffolding (camera/mic permission handling, the foreground
// service) since that plumbing is identical regardless of which direction
// media flows.
const config: CapacitorConfig = {
  appId: "com.glass.example.call",
  appName: "Glass Call Example",
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
