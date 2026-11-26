// Control of a source's input track, members and rights (docs/protocol.md's
// "Control handoff" and "Owner-controlled handoff" sections). See GlassClient
// (index.ts) for the public API.

import type { ClientCore } from "./core";
import type { GlassControlAnswer, GlassMember, GlassRights } from "./types";

type ControlAction = GlassControlAnswer["action"];

// sendControl sends one control request about source and resolves with
// Glass's answer to it, matched by id. Glass answers every request once; a
// connection that goes first resolves it as "disconnected".
function sendControl(c: ClientCore, action: ControlAction, source: string, connectionId?: string): Promise<GlassControlAnswer> {
  const target = connectionId ? { connectionId } : {};
  if (!c.ws || !c.signalingConnected) {
    return Promise.resolve({ action, outcome: "refused", reason: "not_connected", source, ...target });
  }
  const id = c.controlNextId++;
  return new Promise((resolve) => {
    c.controlPending.set(id, { action, source, connectionId, resolve });
    c.ws!.send(JSON.stringify({ type: action, id, source, ...target }));
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
    source: typeof signal.source === "string" && signal.source !== "" ? signal.source : pending.source,
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
    p.resolve({ action: p.action, outcome: "refused", reason: "disconnected", source: p.source, ...(p.connectionId ? { connectionId: p.connectionId } : {}) });
  }
}

export function requestInput(c: ClientCore, source: string): Promise<GlassControlAnswer> {
  return sendControl(c, "request_input", source);
}

export function releaseInput(c: ClientCore, source: string): Promise<GlassControlAnswer> {
  return sendControl(c, "release_input", source);
}

export function grantInput(c: ClientCore, source: string, connectionId: string): Promise<GlassControlAnswer> {
  return sendControl(c, "grant_input", source, connectionId);
}

export function revokeInput(c: ClientCore, source: string, connectionId: string): Promise<GlassControlAnswer> {
  return sendControl(c, "revoke_input", source, connectionId);
}

export function grantWatch(c: ClientCore, source: string, connectionId: string): Promise<GlassControlAnswer> {
  return sendControl(c, "grant_watch", source, connectionId);
}

export function denyWatch(c: ClientCore, source: string, connectionId: string): Promise<GlassControlAnswer> {
  return sendControl(c, "deny_watch", source, connectionId);
}

// holdsInput reports whether this connection holds source's input track, by
// the last input_holders.
export function holdsInput(c: ClientCore, source: string): boolean {
  const id = c._connectionId;
  return id !== null && (c.sources.get(source)?.holders.includes(id) ?? false);
}

export function members(c: ClientCore): GlassMember[] {
  return Array.from(c._members.values());
}

// rights is what this connection's link may do, with the sources the owner
// denied it; null before hello.
export function rights(c: ClientCore): (GlassRights & { denied: { watch: string[]; control: string[] } }) | null {
  if (!c._rights) return null;
  return { ...c._rights, denied: { watch: [...c._deniedWatch], control: [...c._deniedControl] } };
}
