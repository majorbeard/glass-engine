// Navigation and the initial viewport, over signaling or the
// DataChannel. See GlassClient (index.ts) for the public API.

import type { ClientCore } from "./core";
import * as drops from "./drops";
import * as transport from "./transport";
import type { UserAgentClientHints } from "./types";

// See GlassClient.navigate.
export function navigate(c: ClientCore, src: string, url: string): void {
  if (!drops.allowed(c, src, "navigate", true)) return;
  if (c.ws && c.signalingConnected) {
    c.ws.send(JSON.stringify({ type: "navigate", url, source: src }));
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
export function navigateBack(c: ClientCore, src: string): void {
  if (!drops.allowed(c, src, "back")) return;
  transport.sendInput(c, "back", {}, src);
}

// See GlassClient.navigateForward.
export function navigateForward(c: ClientCore, src: string): void {
  if (!drops.allowed(c, src, "forward")) return;
  transport.sendInput(c, "forward", {}, src);
}

// See GlassClient.refresh.
export function refresh(c: ClientCore, src: string): void {
  if (!drops.allowed(c, src, "refresh")) return;
  transport.sendInput(c, "refresh", {}, src);
}
