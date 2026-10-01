// Dropped input: what this client withheld because it has no right to send
// it, and what Glass reports having discarded. Both raise "inputDropped".
// See GlassClient (index.ts) for the public API.

import type { ClientCore } from "./core";
import type { GlassInputDropCode } from "./types";

// A withheld input is reported at once, then counted and reported at most
// this often per (code, event type): a watch-only viewer's pointer would
// otherwise raise an event per mouse move. Glass coalesces its own reports
// the same way.
const LOCAL_DROP_REPORT_INTERVAL_MS = 2000;

// allowed reports whether this connection may send an input action. When it
// may not, nothing is sent and "inputDropped" fires with local: true.
// Before the offer arrives the client doesn't know its rights yet; nothing
// can be sent then anyway, so there is nothing to report.
export function allowed(c: ClientCore, eventType: string, ownerOnly = false): boolean {
  if (c._connectionId === null) return true;
  if (!c._producesInput) {
    noteLocalDrop(c, "not_authorized", eventType);
    return false;
  }
  if (ownerOnly && !c._isOwner) {
    noteLocalDrop(c, "owner_only", eventType);
    return false;
  }
  return true;
}

function noteLocalDrop(c: ClientCore, code: GlassInputDropCode, eventType: string): void {
  const key = `${code}:${eventType}`;
  let entry = c.localDrops.get(key);
  if (!entry) {
    entry = { reportedAt: null, pending: 0 };
    c.localDrops.set(key, entry);
  }
  const now = Date.now();
  entry.pending++;
  if (entry.reportedAt !== null && now - entry.reportedAt < LOCAL_DROP_REPORT_INTERVAL_MS) return;
  c.emit("inputDropped", { code, eventType, count: entry.pending, local: true });
  entry.reportedAt = now;
  entry.pending = 0;
}

// onServerDrop handles an InputDropped message (docs/protocol.md).
export function onServerDrop(c: ClientCore, payload: { code?: string; eventType?: string; count?: number; s?: number }): void {
  c.emit("inputDropped", {
    code: payload.code ?? "invalid",
    eventType: payload.eventType ?? "",
    count: typeof payload.count === "number" ? payload.count : 1,
    local: false,
    ...(typeof payload.s === "number" ? { seq: payload.s } : {}),
  });
}
