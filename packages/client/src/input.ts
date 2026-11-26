// Mouse, keyboard, touch, scroll and clipboard input. See GlassClient (index.ts) for the public API.

import type { ClientCore } from "./core";
import * as drops from "./drops";
import * as transport from "./transport";
import { MOUSE_BATCH_INTERVAL_MS, MOUSE_BATCH_TOLERANCE_MS } from "./internal";
import type { KeyEvent, MouseButton, TouchDispatchType, TouchPoint } from "./types";

// See GlassClient.mouseMove.
export function mouseMove(c: ClientCore, src: string, x: number, y: number, dragging: boolean): void {
  if (!drops.allowed(c, src, "mousemove")) return;
  if (dragging) {
    // 60Hz cap; intermediate positions in the window are dropped, the next
    // allowed send uses the freshest coordinates.
    const now = Date.now();
    if (now - c.lastMouseSendTime < MOUSE_BATCH_INTERVAL_MS - MOUSE_BATCH_TOLERANCE_MS) return;
    // sendInputFast, not sendInput: real, live-found bug (2026-09-04) -
    // mousemove/scroll were riding the ORDERED, reliable channel while
    // touchmove already had the unordered/zero-retransmit
    // "frames-input-fast" channel built and wired for exactly this
    // purpose. The engine already coalesces moves and scrolls
    // server-side (overwrite-latest-position / accumulate-delta),
    // so they're fully tolerant of a dropped or reordered intermediate -
    // the property that makes unreliable delivery safe here. On the
    // ordered channel, one lost packet head-of-line-blocks every
    // subsequent input (including the next mousedown) behind a full SCTP
    // retransmit, for the highest-frequency input in the system.
    transport.sendInputFast(c, "mousemove", { x, y, dragging: true }, src);
    c.lastMouseSendTime = now;
    return;
  }
  // A pointer moving onto another source drops the moves queued for the
  // first, so neither gets the other's position.
  if (c.mouseEventQueue.length > 0 && c.mouseEventQueue[0]!.src !== src) c.mouseEventQueue = [];
  c.mouseEventQueue.push({ x, y, dragging, src });
  if (c.mouseEventQueue.length > 3) c.mouseEventQueue.shift();
  if (c.mouseBatchTimer === null) startMouseBatching(c);
}

export function startMouseBatching(c: ClientCore): void {
  c.mouseBatchTimer = setInterval(() => {
    // Stop while there's nothing to send; the next move restarts it, so an
    // idle pointer costs no timer wakeups.
    if (c.mouseEventQueue.length === 0) {
      if (c.mouseBatchTimer !== null) clearInterval(c.mouseBatchTimer);
      c.mouseBatchTimer = null;
      return;
    }
    const now = Date.now();
    if (now - c.lastMouseSendTime < MOUSE_BATCH_INTERVAL_MS - MOUSE_BATCH_TOLERANCE_MS) return;
    const latest = c.mouseEventQueue[c.mouseEventQueue.length - 1]!;
    transport.sendInputFast(c, "mousemove", {
      x: latest.x,
      y: latest.y,
      dragging: latest.dragging,
    }, latest.src);
    c.lastMouseSendTime = now;
    c.mouseEventQueue = [];
  }, MOUSE_BATCH_INTERVAL_MS);
}

// See GlassClient.mouseDown.
export function mouseDown(c: ClientCore, src: string, x: number, y: number, button: MouseButton = "left", modifiers = 0, clickCount = 1): void {
  if (!drops.allowed(c, src, "mousedown")) return;
  transport.sendInput(c, "mousedown", { x, y, button, modifiers, clickCount }, src);
}

// See GlassClient.mouseUp.
export function mouseUp(c: ClientCore, src: string, x: number, y: number, button: MouseButton = "left", modifiers = 0, clickCount = 1): void {
  if (!drops.allowed(c, src, "mouseup")) return;
  transport.sendInput(c, "mouseup", { x, y, button, modifiers, clickCount }, src);
}

// See GlassClient.scroll.
export function scroll(c: ClientCore, src: string, deltaY: number, deltaX = 0, modifiers = 0): void {
  if (!drops.allowed(c, src, "scroll")) return;
  // sendInputFast, not sendInput - see mouseMove's own doc comment on the
  // same fix. The engine accumulates scroll deltas
  // server-side, so a dropped intermediate just means that one increment
  // doesn't accumulate - already-tolerated loss, not a correctness issue.
  transport.sendInputFast(c, "scroll", { deltaY, deltaX, modifiers }, src);
}

// See GlassClient.setViewport.
export function setViewport(c: ClientCore, src: string, width: number, height: number): void {
  if (!drops.allowed(c, src, "set_viewport")) return;
  transport.sendInput(c, "set_viewport", { width, height }, src);
}

// See GlassClient.copyText.
export function copyText(c: ClientCore, src: string): void {
  if (!drops.allowed(c, src, "copy_text")) return;
  transport.sendInput(c, "copy_text", {}, src);
}

// See GlassClient.pasteText.
export function pasteText(c: ClientCore, src: string, text: string): void {
  if (!drops.allowed(c, src, "paste_text")) return;
  transport.sendInput(c, "paste_text", { text }, src);
}

// See GlassClient.answerDialog.
export function answerDialog(c: ClientCore, src: string, accept: boolean, text?: string): void {
  if (!drops.allowed(c, src, "dialog_answer")) return;
  transport.sendInput(c, "dialog_answer", text === undefined ? { accept } : { accept, text }, src);
}

// See GlassClient.controlPlayback.
export function controlPlayback(c: ClientCore, src: string, action: "play" | "pause" | "seek", positionMs?: number): void {
  if (!drops.allowed(c, src, "playback")) return;
  transport.sendInput(c, "playback", positionMs === undefined ? { action } : { action, positionMs }, src);
}

// See GlassClient.dispatchKeyEvent.
export function dispatchKeyEvent(c: ClientCore, src: string, keyEvent: KeyEvent): void {
  const modifiers =
    (keyEvent.altKey ? 1 : 0) |
    (keyEvent.ctrlKey ? 2 : 0) |
    (keyEvent.metaKey ? 4 : 0) |
    (keyEvent.shiftKey ? 8 : 0);
  if (!drops.allowed(c, src, keyEvent.type)) return;
  transport.sendInput(c, keyEvent.type, {
    key: keyEvent.key,
    code: keyEvent.code,
    modifiers,
  }, src);
}

// See GlassClient.dispatchTouch.
export function dispatchTouch(
  c: ClientCore,
  src: string,
  type: TouchDispatchType,
  points: TouchPoint[],
  gestureId: number,
  moveCount?: number
): void {
  if (!drops.allowed(c, src, type)) return;
  const data =
    moveCount !== undefined ? { points, gestureId, moveCount } : { points, gestureId };
  if (type === "touchmove") {
    transport.sendInputFast(c, type, data, src);
  } else {
    transport.sendInput(c, type, data, src);
  }
}
