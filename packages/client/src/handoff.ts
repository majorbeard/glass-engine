// Input control handoff and the roster (docs/protocol.md's "Control
// handoff" section). See GlassClient (index.ts) for the public API.

import type { ClientCore } from "./core";
import type { GlassControlAnswer, GlassRosterEntry, GlassSlotState } from "./types";

type ControlAction = GlassControlAnswer["action"];

// sendControl sends one control request and resolves with Glass's answer to
// it, matched by id. Glass answers every request once; a connection that goes
// first resolves it as "disconnected".
function sendControl(c: ClientCore, action: ControlAction, connectionId?: string): Promise<GlassControlAnswer> {
  if (!c.ws || !c.signalingConnected) {
    return Promise.resolve({ action, outcome: "refused", reason: "not_connected", ...(connectionId ? { connectionId } : {}) });
  }
  const id = c.controlNextId++;
  return new Promise((resolve) => {
    c.controlPending.set(id, { action, connectionId, resolve });
    c.ws!.send(JSON.stringify({ type: action, id, ...(connectionId ? { connectionId } : {}) }));
  });
}

// answerControl resolves the request a control_answer is for.
export function answerControl(c: ClientCore, signal: Record<string, unknown>): void {
  const id = typeof signal.id === "number" ? signal.id : undefined;
  const pending = id === undefined ? undefined : c.controlPending.get(id);
  if (!pending) return;
  c.controlPending.delete(id!);
  const answer: GlassControlAnswer = {
    action: pending.action,
    outcome: signal.outcome as GlassControlAnswer["outcome"],
  };
  if (typeof signal.reason === "string") answer.reason = signal.reason;
  const target = typeof signal.connectionId === "string" ? signal.connectionId : pending.connectionId;
  if (target) answer.connectionId = target;
  pending.resolve(answer);
}

// dropControlRequests resolves every request still waiting, when the
// connection that sent them goes.
export function dropControlRequests(c: ClientCore): void {
  const pending = [...c.controlPending.values()];
  c.controlPending.clear();
  for (const p of pending) {
    p.resolve({ action: p.action, outcome: "refused", reason: "disconnected", ...(p.connectionId ? { connectionId: p.connectionId } : {}) });
  }
}

// See GlassClient.requestInput.
export function requestInput(c: ClientCore): Promise<GlassControlAnswer> {
  return sendControl(c, "request_input");
}

// See GlassClient.releaseInput.
export function releaseInput(c: ClientCore): Promise<GlassControlAnswer> {
  return sendControl(c, "release_input");
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
export function grantInput(c: ClientCore, connectionId: string): Promise<GlassControlAnswer> {
  return sendControl(c, "grant_input", connectionId);
}

// See GlassClient.revokeInput.
export function revokeInput(c: ClientCore, connectionId: string): Promise<GlassControlAnswer> {
  return sendControl(c, "revoke_input", connectionId);
}
