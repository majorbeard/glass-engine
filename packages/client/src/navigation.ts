// Navigation and the initial viewport, over signaling or the
// DataChannel. See GlassClient (index.ts) for the public API.

import type { ClientCore } from "./core";
import * as drops from "./drops";
import * as transport from "./transport";
import type { UserAgentClientHints } from "./types";

// See GlassClient.navigate.
export function navigate(c: ClientCore, url: string): void {
  if (!drops.allowed(c, "navigate", true)) return;
  if (c.ws && c.signalingConnected) {
    c.ws.send(JSON.stringify({ type: "navigate", sdp: url }));
  }
}

// See GlassClient.sendInitialViewport.
export function sendInitialViewport(
  c: ClientCore,
  width: number,
  height: number,
  isMobile?: boolean,
  userAgent?: string,
  userAgentData?: UserAgentClientHints
): void {
  if (!c.ws || !c.signalingConnected) return;
  c.ws.send(
    JSON.stringify({
      type: "initial_viewport",
      width,
      height,
      isMobile: !!isMobile,
      userAgent: userAgent || "",
      // Omitted (not sent as null/undefined) when the client's browser has
      // no userAgentData - see UserAgentClientHints doc comment.
      ...(userAgentData ? { userAgentData } : {}),
    })
  );
}

// See GlassClient.navigateBack.
export function navigateBack(c: ClientCore): void {
  if (!drops.allowed(c, "back", true)) return;
  transport.sendInput(c, "back", {});
}

// See GlassClient.navigateForward.
export function navigateForward(c: ClientCore): void {
  if (!drops.allowed(c, "forward", true)) return;
  transport.sendInput(c, "forward", {});
}

// See GlassClient.refresh.
export function refresh(c: ClientCore): void {
  if (!drops.allowed(c, "refresh", true)) return;
  transport.sendInput(c, "refresh", {});
}
