// @glass/client/viewer - vanilla-DOM rendering + input-capture layer.
//
// mountGlassViewer(container, client) renders a Glass session's video into a
// container element and wires mouse, touch, keyboard, scroll, and viewport-
// resize input back through the client. Framework-free, so it works from React,
// Vue, Svelte, or plain HTML. It imposes no application UI: navigation state and
// context-menu requests are surfaced via callbacks so the host builds its own
// URL bar / menu.
//
// Call mountGlassViewer BEFORE client.connect() when possible: the viewer sends
// the initial viewport/mobile declaration from its own "connected" handler, and
// mounting first ensures that runs before any navigation the host triggers after
// connect (the backend needs the mobile/UA declaration in hand at page creation).

import type { GlassClient } from "../index.js";
import type { NavigationState } from "../types.js";
import {
  TouchInputController,
  clientToVideoPoint,
  type TouchInputGeometry,
} from "./touchInput.js";
import { MobileKeyboardController } from "./mobileKeyboard.js";

export interface GlassViewerOptions {
  // Navigation/URL-bar state updates, for the host to render its own URL bar.
  onNavigation?: (nav: NavigationState) => void;
  // The user requested a context menu (right-click / long-press) at the given
  // viewport coordinates. The default browser menu is always prevented; provide
  // this to show your own.
  onContextMenu?: (x: number, y: number) => void;
  // Override mobile detection. Default: auto (maxTouchPoints + coarse pointer).
  isMobile?: boolean;
  // Capture the physical keyboard at the window level (default true). Set false
  // to own keyboard handling in the host.
  captureKeyboard?: boolean;
}

export interface GlassViewer {
  // The <video> element the session renders into (for advanced host needs).
  readonly video: HTMLVideoElement;
  // Tear down: remove DOM, listeners, observers, and client subscriptions.
  // Does NOT disconnect the client - the host owns the client's lifecycle.
  destroy(): void;
}

const VIEWPORT_DEBOUNCE_MS = 500;

export function mountGlassViewer(
  container: HTMLElement,
  client: GlassClient,
  options: GlassViewerOptions = {}
): GlassViewer {
  const isMobile =
    options.isMobile ??
    (typeof navigator !== "undefined" &&
      navigator.maxTouchPoints > 0 &&
      typeof window !== "undefined" &&
      !!window.matchMedia?.("(pointer: coarse)").matches);
  const captureKeyboard = options.captureKeyboard ?? true;

  // Ensure absolute children position against the container.
  if (getComputedStyle(container).position === "static") {
    container.style.position = "relative";
  }

  // Stage fills the container and centers the (letterboxed) video.
  const stage = document.createElement("div");
  Object.assign(stage.style, {
    position: "absolute",
    inset: "0",
    overflow: "hidden",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#000",
    cursor: "default",
  } satisfies Partial<CSSStyleDeclaration>);

  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  Object.assign(video.style, {
    maxWidth: "100%",
    maxHeight: "100%",
    objectFit: "contain",
    backgroundColor: "#000",
  } satisfies Partial<CSSStyleDeclaration>);
  stage.appendChild(video);
  container.appendChild(stage);

  // --- video track binding ---
  const tryPlay = () =>
    video.play().catch(() => {
      /* autoplay can reject until a gesture; harmless */
    });
  const bindStream = (stream: MediaStream) => {
    video.srcObject = stream;
    tryPlay();
  };
  const offVideoTrack = client.on("videoTrack", bindStream);
  // If the track already arrived before this viewer mounted (the app connects
  // up front and mounts the viewer on first navigation), the "videoTrack" event
  // has already fired - bind the retained stream now so we don't render black.
  const existingStream = client.getVideoStream();
  if (existingStream) bindStream(existingStream);
  tryPlay();

  // --- coordinate mapping helpers ---
  const stageRect = () => stage.getBoundingClientRect();
  const videoSize = () =>
    video.videoWidth === 0 || video.videoHeight === 0
      ? null
      : { width: video.videoWidth, height: video.videoHeight };
  const toVideoPoint = (clientX: number, clientY: number) => {
    const size = videoSize();
    if (!size) return null;
    return clientToVideoPoint(
      clientX,
      clientY,
      stageRect(),
      size.width,
      size.height
    );
  };

  // --- mouse ---
  let dragging = false;
  const onMouseMove = (e: MouseEvent) => {
    const p = toVideoPoint(e.clientX, e.clientY);
    if (p && client.isConnected()) client.mouseMove(p.x, p.y, dragging);
  };
  const onMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    const p = toVideoPoint(e.clientX, e.clientY);
    if (p) {
      dragging = true;
      if (client.isConnected()) client.mouseDown(p.x, p.y);
    }
  };
  const onMouseUp = (e: MouseEvent) => {
    if (e.button !== 0) return;
    const p = toVideoPoint(e.clientX, e.clientY);
    if (dragging) {
      dragging = false;
      if (p && client.isConnected()) client.mouseUp(p.x, p.y);
    }
  };
  const onMouseLeave = () => {
    dragging = false;
  };
  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    options.onContextMenu?.(e.clientX, e.clientY);
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (client.isConnected()) client.scroll(e.deltaY);
  };
  stage.addEventListener("mousemove", onMouseMove);
  stage.addEventListener("mousedown", onMouseDown);
  stage.addEventListener("mouseup", onMouseUp);
  stage.addEventListener("mouseleave", onMouseLeave);
  stage.addEventListener("contextmenu", onContextMenu);
  stage.addEventListener("wheel", onWheel, { passive: false });

  // --- mobile keyboard (created before touch so onTap can drive it) ---
  const keyboard = new MobileKeyboardController(stage, client, isMobile);

  // --- touch ---
  const geometry: TouchInputGeometry = {
    getContainerRect: () => stageRect(),
    getVideoSize: () => videoSize(),
  };
  const touch = new TouchInputController(geometry, {
    onTouchPoints: (type, points) => {
      if (client.isConnected()) client.dispatchTouch(type, points);
    },
    onTap: keyboard.handleTap,
  });
  const detachTouch = touch.attach(stage);

  // --- physical keyboard (window-level) ---
  const onKey = (e: KeyboardEvent) => {
    const active = document.activeElement;
    // Let a focused field (including our hidden mobile-keyboard input) own its
    // keys, so we don't double-send.
    if (
      active &&
      (active.tagName === "INPUT" || active.tagName === "TEXTAREA")
    ) {
      return;
    }
    // Prevent the local browser from hijacking common combos we forward.
    if ((e.ctrlKey || e.metaKey) && "cvxazyrlt".includes(e.key.toLowerCase())) {
      e.preventDefault();
    }
    if (e.key.startsWith("F") && e.key.length > 1) e.preventDefault();
    if (client.isConnected()) {
      client.dispatchKeyEvent({
        type: e.type,
        key: e.key,
        code: e.code,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        metaKey: e.metaKey,
      });
    }
  };
  if (captureKeyboard) {
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
  }

  // --- state / navigation ---
  const offState = client.on("state", (state) => {
    stage.style.cursor = state.cursor || "default";
    keyboard.setEditableFocused(!!state.editableFocused);
  });
  const offNav = client.on("navigation", (nav) => options.onNavigation?.(nav));

  // --- viewport size reporting ---
  const computeViewport = (): { width: number; height: number } => {
    const rect = stageRect();
    const dpr = window.devicePixelRatio || 1;
    let w = Math.floor(rect.width * dpr);
    let h = Math.floor(rect.height * dpr);
    w = w % 2 === 0 ? w : Math.max(0, w - 1);
    h = h % 2 === 0 ? h : Math.max(0, h - 1);
    w = Math.max(320, w);
    h = Math.max(240, h);
    return { width: w, height: h };
  };

  // Each distinct viewport size the backend receives triggers a screencast +
  // H.264 encoder restart, so we work hard to send as few as possible:
  //  - re-measure at *send* time (not when the change was observed), so a storm
  //    of intermediate sizes during a layout settle collapses to the final one;
  //  - ignore sub-pixel / rounding churn below a threshold;
  //  - skip the layout jitter in the first moments after mount, since the
  //    initial declaration (below) already covered the mount size;
  //  - only advance lastSent when we actually send, so dedup compares against
  //    what the backend last received.
  const MIN_DELTA_PX = 4;
  const SETTLE_MS = 400;
  const mountedAt = Date.now();
  let lastSent = { width: 0, height: 0 };
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const significantChange = (w: number, h: number) =>
    Math.abs(w - lastSent.width) > MIN_DELTA_PX ||
    Math.abs(h - lastSent.height) > MIN_DELTA_PX;

  const scheduleViewport = () => {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      const { width, height } = computeViewport(); // settled measurement
      if (!significantChange(width, height)) return;
      lastSent = { width, height };
      if (client.isConnected()) client.setViewport(width, height);
    }, VIEWPORT_DEBOUNCE_MS);
  };

  const observer = new ResizeObserver((entries) => {
    const first = entries[0];
    if (!first) return;
    const { width, height } = first.contentRect;
    if (width === 0 || height === 0) return;
    if (Date.now() - mountedAt < SETTLE_MS) return; // covered by initial declare
    const measured = computeViewport();
    if (!significantChange(measured.width, measured.height)) return;
    scheduleViewport();
  });
  observer.observe(stage);

  // Declare the initial viewport + mobile identity to the backend, before any
  // host-triggered navigation, so the page is created with the right device
  // identity. Covers both mount orderings:
  //  - viewer mounted before connect: the "connected" handler fires it.
  //  - viewer mounted after the client already connected (common - the app
  //    connects up front and mounts the viewer on first navigation): the
  //    "connected" event already fired, so send it immediately here.
  // Re-declaring on each reconnect is harmless.
  const declareViewport = () => {
    const { width, height } = computeViewport();
    client.sendInitialViewport(
      width,
      height,
      isMobile,
      isMobile ? navigator.userAgent : undefined
    );
    lastSent = { width, height };
  };
  const offConnected = client.on("connected", declareViewport);
  if (client.isConnected()) declareViewport();

  return {
    video,
    destroy() {
      offVideoTrack();
      offState();
      offNav();
      offConnected();
      stage.removeEventListener("mousemove", onMouseMove);
      stage.removeEventListener("mousedown", onMouseDown);
      stage.removeEventListener("mouseup", onMouseUp);
      stage.removeEventListener("mouseleave", onMouseLeave);
      stage.removeEventListener("contextmenu", onContextMenu);
      stage.removeEventListener("wheel", onWheel);
      if (captureKeyboard) {
        window.removeEventListener("keydown", onKey);
        window.removeEventListener("keyup", onKey);
      }
      detachTouch();
      keyboard.destroy();
      observer.disconnect();
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      video.srcObject = null;
      stage.remove();
    },
  };
}

export {
  TouchInputController,
  clientToVideoPoint,
  type TouchInputGeometry,
} from "./touchInput.js";
export { MobileKeyboardController } from "./mobileKeyboard.js";
