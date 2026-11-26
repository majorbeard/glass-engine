// Dropped input: what this client withheld because it has no right to send
// it, and what Glass reports having discarded. Both raise "inputDropped".
// See GlassClient (index.ts) for the public API.

import type { ClientCore } from "./core";
import * as handoff from "./handoff";
import type { GlassInputDropCode } from "./types";

// A withheld input is reported at once, then counted and reported at most
// this often per (code, event type): a watch-only viewer's pointer would
// otherwise raise an event per mouse move. Glass coalesces its own reports
// the same way.
const LOCAL_DROP_REPORT_INTERVAL_MS = 2000;

// allowed reports whether this connection may send an input action to
// source: it holds the source's input track, and is the owner for what only
// the owner may do. When it may not, nothing is sent and "inputDropped" fires
// with local: true. Before hello the client doesn't know its rights yet;
// nothing can be sent then anyway, so there is nothing to report.
export function allowed(c: ClientCore, source: string, eventType: string, ownerOnly = false): boolean {
  if (c._connectionId === null) return true;
  if (!handoff.holdsInput(c, source)) {
    noteLocalDrop(c, "not_authorized", eventType, source);
    return false;
  }
  if (ownerOnly && !c._owner) {
    noteLocalDrop(c, "owner_only", eventType, source);
    return false;
  }
  return true;
}

function noteLocalDrop(c: ClientCore, code: GlassInputDropCode, eventType: string, source: string): void {
  const key = `${code}:${eventType}:${source}`;
  let entry = c.localDrops.get(key);
  if (!entry) {
    entry = { reportedAt: null, pending: 0 };
    c.localDrops.set(key, entry);
  }
  const now = Date.now();
  entry.pending++;
  if (entry.reportedAt !== null && now - entry.reportedAt < LOCAL_DROP_REPORT_INTERVAL_MS) return;
  c.emit("inputDropped", { code, eventType, count: entry.pending, local: true, source });
  entry.reportedAt = now;
  entry.pending = 0;
}

// onServerDrop handles an InputDropped message (docs/protocol.md).
export function onServerDrop(c: ClientCore, payload: { code?: string; eventType?: string; count?: number; s?: number; source?: string }): void {
  c.emit("inputDropped", {
    code: payload.code ?? "invalid",
    eventType: payload.eventType ?? "",
    count: typeof payload.count === "number" ? payload.count : 1,
    local: false,
    source: typeof payload.source === "string" ? payload.source : "",
    ...(typeof payload.s === "number" ? { seq: payload.s } : {}),
  });
}
