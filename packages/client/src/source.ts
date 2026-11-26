// GlassSource: one of a session's sources, as a handle on a GlassClient's
// connection. Every action on a source goes through it, naming the source on
// the wire (protocol v3); its state is what the engine last said of it.

import type { ClientCore } from "./core";
import * as inputs from "./input";
import * as navigation from "./navigation";
import * as handoff from "./handoff";
import * as fileTransfer from "./files";
import * as transport from "./transport";
import type {
  GlassControlAnswer,
  GlassDialog,
  GlassPlaybackState,
  GlassSourceInfo,
  KeyEvent,
  MouseButton,
  TouchDispatchType,
  TouchPoint,
} from "./types";

export class GlassSource {
  /** @internal */
  constructor(
    private readonly c: ClientCore,
    readonly id: string,
  ) {}

  // The engine's description of the source, or null once it has gone (or
  // for an id that was never one of the session's).
  info(): GlassSourceInfo | null {
    const st = this.c.sources.get(this.id);
    return st ? { ...st.info } : null;
  }

  // The stream of the tracks this connection receives of the source, its
  // picture and its sound; null before the first arrives. Bind it to a
  // <video>; a "track" event says when it gains one.
  stream(): MediaStream | null {
    return transport.sourceStream(this.c, this.id);
  }

  // --- Control of its input track ---

  // Whether this connection holds the source's input track (its input reaches
  // the source), by the last "inputHolders".
  holdsInput(): boolean {
    return handoff.holdsInput(this.c, this.id);
  }

  // The connections holding the source's input track.
  holders(): string[] {
    return [...(this.c.sources.get(this.id)?.holders ?? [])];
  }

  // Input mode "floor": the connection whose input reaches the source now, or
  // null when no one has it.
  floorHolder(): string | null {
    return this.c.sources.get(this.id)?.floor ?? null;
  }

  // Asks for the source's input track. Resolves with Glass's answer:
  // "granted" (an "inputHolders" event follows), "relayed" (there was no
  // room, so whoever holds it got an "inputRequested" event and decides), or
  // "refused" with the reason. Glass never queues, prompts or takes control
  // from anyone on its own.
  requestInput(): Promise<GlassControlAnswer> {
    return handoff.requestInput(this.c, this.id);
  }

  // Gives up the source's input track at once. Resolves "released", whether
  // this connection held it or not.
  releaseInput(): Promise<GlassControlAnswer> {
    return handoff.releaseInput(this.c, this.id);
  }

  // The owner gives the source's input track to another connection, with the
  // same license and capacity check as requestInput().
  grantInput(connectionId: string): Promise<GlassControlAnswer> {
    return handoff.grantInput(this.c, this.id, connectionId);
  }

  // The owner takes the source's input track from another connection.
  revokeInput(connectionId: string): Promise<GlassControlAnswer> {
    return handoff.revokeInput(this.c, this.id, connectionId);
  }

  // The owner lets another connection watch the source again, after
  // denyWatch().
  grantWatch(connectionId: string): Promise<GlassControlAnswer> {
    return handoff.grantWatch(this.c, this.id, connectionId);
  }

  // The owner stops another connection watching the source, whatever its
  // link allows.
  denyWatch(connectionId: string): Promise<GlassControlAnswer> {
    return handoff.denyWatch(this.c, this.id, connectionId);
  }

  // Pauses or resumes receiving the source: a paused source sends this
  // connection nothing, freeing its share of the link, and comes back on a
  // fresh keyframe.
  receive(paused: boolean): void {
    if (this.c.ws && this.c.signalingConnected) {
      this.c.ws.send(JSON.stringify({ type: "receive", source: this.id, paused }));
    }
  }

  // --- A hosted browser's page ---

  // Navigation is the owner's: the session's own link.
  navigate(url: string): void {
    navigation.navigate(this.c, this.id, url);
  }

  navigateBack(): void {
    navigation.navigateBack(this.c, this.id);
  }

  navigateForward(): void {
    navigation.navigateForward(this.c, this.id);
  }

  refresh(): void {
    navigation.refresh(this.c, this.id);
  }

  mouseMove(x: number, y: number, dragging: boolean): void {
    inputs.mouseMove(this.c, this.id, x, y, dragging);
  }

  // button defaults to "left", modifiers to 0, clickCount to 1. modifiers is
  // the Alt=1/Ctrl=2/Meta=4/Shift=8 bitmask; clickCount the browser's own
  // click-run counter (MouseEvent.detail), for a real double click.
  mouseDown(x: number, y: number, button: MouseButton = "left", modifiers = 0, clickCount = 1): void {
    inputs.mouseDown(this.c, this.id, x, y, button, modifiers, clickCount);
  }

  mouseUp(x: number, y: number, button: MouseButton = "left", modifiers = 0, clickCount = 1): void {
    inputs.mouseUp(this.c, this.id, x, y, button, modifiers, clickCount);
  }

  // A wheel event: the page scrolls, or pans and zooms on its own wheel
  // handler. modifiers as mouseDown's.
  scroll(deltaY: number, deltaX = 0, modifiers = 0): void {
    inputs.scroll(this.c, this.id, deltaY, deltaX, modifiers);
  }

  setViewport(width: number, height: number): void {
    inputs.setViewport(this.c, this.id, width, height);
  }

  // Asks for the page's selected text: a "clipboardText" event answers.
  copyText(): void {
    inputs.copyText(this.c, this.id);
  }

  pasteText(text: string): void {
    inputs.pasteText(this.c, this.id, text);
  }

  dispatchKeyEvent(keyEvent: KeyEvent): void {
    inputs.dispatchKeyEvent(this.c, this.id, keyEvent);
  }

  // gestureId on every call, so Glass ties a touchmove to the gesture it
  // belongs to; moveCount only on "touchend". touchmove alone travels on the
  // unreliable channel, where a lost one costs nothing.
  dispatchTouch(type: TouchDispatchType, points: TouchPoint[], gestureId: number, moveCount?: number): void {
    inputs.dispatchTouch(this.c, this.id, type, points, gestureId, moveCount);
  }

  // The page's open JavaScript dialog, or null (see the "dialog" event).
  dialog(): GlassDialog | null {
    const d = this.c.sources.get(this.id)?.dialog;
    return d ? { ...d } : null;
  }

  // Answers the page's open dialog, as its OK (accept true) or Cancel
  // button; text is a prompt's answer. Input like any other: in input mode
  // "floor" it needs the floor.
  answerDialog(accept: boolean, text?: string): void {
    inputs.answerDialog(this.c, this.id, accept, text);
  }

  // The retrieval URL of a finished download announced by "downloadReady",
  // with this connection's link as its credential: for an <a download> the
  // person clicks.
  downloadUrl(guid: string): string {
    return fileTransfer.downloadUrl(this.c, this.id, guid);
  }

  // Uploads the person's own picked file(s) in answer to "fileChooserOpened".
  // Rejects if Glass refuses (no chooser waiting, size limits).
  async uploadFiles(files: FileList | File[]): Promise<void> {
    return fileTransfer.uploadFiles(this.c, this.id, files);
  }

  // --- A recording's playback ---

  // The playback's state, or null before the first "playback" event.
  playbackState(): GlassPlaybackState | null {
    const p = this.c.sources.get(this.id)?.playback;
    return p ? { ...p } : null;
  }

  // Plays, pauses or seeks; a seek lands on the recording's keyframe at or
  // before positionMs. Needs control of the playback.
  controlPlayback(action: "play" | "pause" | "seek", positionMs?: number): void {
    inputs.controlPlayback(this.c, this.id, action, positionMs);
  }
}
