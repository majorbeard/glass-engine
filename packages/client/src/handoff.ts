// Input control handoff and the roster (docs/protocol.md's "Control
// handoff" section). See GlassClient (index.ts) for the public API.

import type { ClientCore } from "./core";
import type { GlassRosterEntry, GlassSlotState } from "./types";

// See GlassClient.requestInput.
export function requestInput(c: ClientCore): void {
  if (c.ws && c.signalingConnected) {
    c.ws.send(JSON.stringify({ type: "request_input" }));
  }
}

// See GlassClient.releaseInput.
export function releaseInput(c: ClientCore): void {
  if (c.ws && c.signalingConnected) {
    c.ws.send(JSON.stringify({ type: "release_input" }));
  }
}

// See GlassClient.connectionId.
export function connectionId(c: ClientCore): string | null {
  return c._connectionId;
}

// See GlassClient.producesInput.
export function producesInput(c: ClientCore): boolean {
  return c._producesInput;
}

// See GlassClient.isOwner.
export function isOwner(c: ClientCore): boolean {
  return c._isOwner;
}

// See GlassClient.connections.
export function connections(c: ClientCore): GlassRosterEntry[] {
  return Array.from(c._connections.values());
}

// See GlassClient.slotStates.
export function slotStates(c: ClientCore): Record<string, GlassSlotState> {
  return { ...c._slotStates };
}

// See GlassClient.grantInput.
export function grantInput(c: ClientCore, connectionId: string): void {
  if (c.ws && c.signalingConnected) {
    c.ws.send(JSON.stringify({ type: "grant_input", connectionId }));
  }
}

// See GlassClient.revokeInput.
export function revokeInput(c: ClientCore, connectionId: string): void {
  if (c.ws && c.signalingConnected) {
    c.ws.send(JSON.stringify({ type: "revoke_input", connectionId }));
  }
}
