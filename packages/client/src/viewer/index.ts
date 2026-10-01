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
import type { MouseButton, NavigationState, UserAgentClientHints } from "../types.js";
import {
  TouchInputController,
  clientToVideoPoint,
  type TouchInputGeometry,
} from "./touchInput.js";
import { MobileKeyboardController } from "./mobileKeyboard.js";
import {
  GamepadInputController,
  type GamepadInputGeometry,
  type GamepadMapping,
} from "./gamepadInput.js";
import { PixelTraceSampler } from "../pixel_trace.js";
import { watchPresentedFrames } from "../input_latency.js";
import { DecodeReadbackOverlay } from "../decode_readback_check.js";

export interface GlassViewerOptions {
  // Navigation/URL-bar state updates, for the host to render its own URL bar.
  onNavigation?: (nav: NavigationState) => void;
  // The user requested a context menu (right-click / long-press) at the given
  // viewport coordinates. The LOCAL browser's own menu is always prevented -
  // this is only a hook for a host that wants its own extra UI alongside the
  // real right-click, which is separately forwarded to the remote page
  // itself (see the doc comment on onContextMenu's implementation). shiftKey
  // lets a host gate its own popup on a modifier (e.g. Shift+right-click)
  // instead of showing it on every plain right-click, which would otherwise
  // sit on top of whatever context menu the remote page itself renders.
  onContextMenu?: (x: number, y: number, shiftKey: boolean) => void;
  // Override mobile detection. Default: auto (maxTouchPoints + coarse pointer).
  isMobile?: boolean;
  // Capture the physical keyboard at the window level (default true). Set false
  // to own keyboard handling in the host.
  captureKeyboard?: boolean;
  // Override the default gamepad button/axis mapping and feel (dead zone,
  // sensitivity). Omit for the
  // built-in default (W3C Standard Gamepad layout). Gamepad support itself
  // is always on - it auto-activates the moment the operator's own browser
  // detects a real controller, no separate enable flag (see that doc's
  // "Activation" section for why).
  gamepadMapping?: Partial<GamepadMapping>;
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
  //
  // touchAction: "none" is a real backstop, not redundant with the touch
  // handlers' own preventDefault() calls below - those only fire for a
  // touch that starts ON this element. A touch that starts just outside it
  // (an edge, a margin, a second finger landing slightly off during a
  // pinch) never reaches those listeners at all, and without this CSS the
  // mobile browser's own native pinch/double-tap zoom takes over instead.
  // Found live 2026-09-13: that native zoom doesn't just look wrong, it
  // corrupts computeViewport()'s own measurement (visualViewport shrinks
  // under active zoom), which gets reported to the backend as a real size
  // change and triggers a genuine screencast/encoder restart - confirmed
  // via server logs showing the same session oscillating between two
  // resolutions (a consistent ~1.18x ratio, matching the zoom level) every
  // time native zoom engaged/disengaged. touch-action:none tells the
  // browser this element handles 100% of its own gestures, closing the gap
  // the per-listener preventDefault calls can't reach alone.
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
    touchAction: "none",
  } satisfies Partial<CSSStyleDeclaration>);

  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  Object.assign(video.style, {
    // width/height 100% (not maxWidth/maxHeight alone) is deliberate: a
    // <video> with no explicit size renders at its own intrinsic
    // resolution capped by max-width/max-height, so it visibly shrinks any
    // time the encoder's resolution-scale CPU-pressure lever drops the track's
    // native resolution - real, live-found 2026-08-19 ("the actual render
    // size decreases as well"). objectFit:contain still letterboxes for
    // aspect-ratio mismatches; width/height:100% is what keeps the
    // *displayed* box pinned to the stage regardless of the track's
    // current native resolution, so a resolution-scale drop reads as
    // softer detail, not a shrinking picture.
    width: "100%",
    height: "100%",
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
  // Internal-only, opt-in (see GlassClient.pixelTraceEnabled's own doc
  // comment) - one PixelTraceSampler per mounted viewer, bound to this
  // viewer's own <video> element. Feature-detected internally
  // (PixelTraceSampler.start no-ops if requestVideoFrameCallback or the
  // WebRTC-source rtpTimestamp metadata field aren't available), so this
  // is always safe to construct even on a browser that can't actually
  // sample anything.
  const pixelTrace = client.pixelTraceEnabled
    ? new PixelTraceSampler(video, (samples) => client.reportPixelTraceSamples(samples))
    : null;

  // Internal-only, opt-in (see GlassClient.decodeReadbackEnabled's own doc
  // comment / decode_readback_check.ts) - a small canvas mirroring the
  // <video> element's actual decoded frames via drawImage, pinned to the
  // corner so a human can watch it alongside the real on-screen video and
  // see directly whether the two ever diverge.
  const decodeReadback = client.decodeReadbackEnabled
    ? new DecodeReadbackOverlay(video)
    : null;
  if (decodeReadback) {
    Object.assign(decodeReadback.canvas.style, {
      position: "absolute",
      bottom: "8px",
      right: "8px",
      width: "35%",
      maxWidth: "480px",
      border: "2px solid #f0c000",
      boxShadow: "0 0 8px rgba(0,0,0,0.6)",
      zIndex: "10",
    } satisfies Partial<CSSStyleDeclaration>);
    stage.appendChild(decodeReadback.canvas);
  }

  // Presented frames complete the client's input-latency samples
  // (input_latency.ts).
  let stopFrameWatch: (() => void) | null = null;
  const bindStream = (stream: MediaStream) => {
    video.srcObject = stream;
    tryPlay();
    pixelTrace?.start();
    decodeReadback?.start();
    stopFrameWatch ??= watchPresentedFrames(video, (rtp, displayAt) => client.notePresentedFrame(rtp, displayAt));
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
  // DOM button (0/1/2) -> the wire protocol's button string. Real gap closed
  // 2026-08-26: mousedown/mouseup used to only ever forward the left button
  // (this file filtered everything else out before it ever reached the
  // client), so a remote page's own right-click contextmenu handling - a
  // custom radial menu, e.g. - was completely unreachable through Glass.
  // See docs/protocol.md's mousedown/mouseup rows and GlassClient.mouseDown's
  // doc comment.
  const buttonName = (b: number): MouseButton =>
    b === 2 ? "right" : b === 1 ? "middle" : "left";
  // Real gap closed 2026-08-27: mousedown/mouseup never forwarded modifier
  // state at all, so Ctrl/Shift/Alt+click never reached the remote page -
  // silently breaking Shift+click multi-select, Ctrl/Cmd+click, and
  // Alt-drag-to-duplicate (found via Figma's own Shift+click multi-select
  // failing). Same bitmask as onKey/onWheel below.
  const clickModifiers = (e: MouseEvent) =>
    (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);

  // Every "down" sent to the remote page must get its "up", even when the
  // release happens outside the video, after focus moves, or never reaches
  // this page at all (Alt-Tab, tab hidden, viewer destroyed). heldButtons
  // and heldKeys record what was sent down; releaseAllHeld sends the ups.
  const heldButtons = new Set<number>();
  const heldKeys = new Map<string, string>(); // code -> key
  let lastPoint: { x: number; y: number } | null = null;
  const onMouseMove = (e: MouseEvent) => {
    const p = toVideoPoint(e.clientX, e.clientY);
    if (p) lastPoint = p;
    if (p && client.isConnected()) client.mouseMove(p.x, p.y, heldButtons.size > 0);
  };
  const onMouseDown = (e: MouseEvent) => {
    const p = toVideoPoint(e.clientX, e.clientY);
    if (p) {
      lastPoint = p;
      heldButtons.add(e.button);
      // e.detail is the browser's own native click-run counter (1/2/3 for
      // single/double/triple click) - real gap closed 2026-08-27: this was
      // never forwarded at all, so a genuine double-click never produced a
      // real multi-click DOM event server-side. See docs/protocol.md.
      if (client.isConnected())
        client.mouseDown(p.x, p.y, buttonName(e.button), clickModifiers(e), e.detail);
      pixelTrace?.noteInteraction();
    }
  };
  // Window-level, so a release outside the video (or outside the stage
  // entirely) still reaches the button it belongs to; toVideoPoint clamps
  // the position to the video's edge.
  const onMouseUp = (e: MouseEvent) => {
    if (!heldButtons.delete(e.button)) return;
    const p = toVideoPoint(e.clientX, e.clientY) ?? lastPoint;
    if (p && client.isConnected())
      client.mouseUp(p.x, p.y, buttonName(e.button), clickModifiers(e), e.detail);
    pixelTrace?.noteInteraction();
  };
  const releaseAllHeld = () => {
    const connected = client.isConnected();
    for (const button of heldButtons) {
      if (connected && lastPoint) client.mouseUp(lastPoint.x, lastPoint.y, buttonName(button));
    }
    heldButtons.clear();
    for (const [code, key] of heldKeys) {
      if (connected)
        client.dispatchKeyEvent({
          type: "keyup",
          key,
          code,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          metaKey: false,
        });
    }
    heldKeys.clear();
  };
  const onWindowBlur = () => releaseAllHeld();
  const onVisibilityChange = () => {
    if (document.visibilityState === "hidden") releaseAllHeld();
  };
  // The local browser's own OS-style context menu (Inspect/Save video as/...)
  // is always suppressed - it has nothing to do with the remote page and
  // would just cover the video. The remote page's OWN context menu (if any)
  // is reached separately: a real right-click already dispatched a real
  // button="right" mousedown/mouseup above, which is enough for the remote
  // page to fire its own native contextmenu handling, rendered as part of
  // the video stream like any other page content - nothing else is needed
  // here for that to work. options.onContextMenu is a distinct, optional
  // hook for a host that wants its OWN local UI (e.g. a copy/paste popup
  // bridging the remote page's clipboard to the real local one) - shiftKey
  // is passed through so a host can gate that on a modifier instead of
  // stacking its own popup on top of the remote page's menu on every
  // plain right-click.
  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    options.onContextMenu?.(e.clientX, e.clientY, e.shiftKey);
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    // deltaX and modifiers (notably Ctrl, which a trackpad pinch-to-zoom
    // gesture also sets synthetically, same as browsers do natively) are
    // forwarded so a real CDP wheel event on the remote page carries the
    // same information a real trackpad/mouse+keyboard combo would - see
    // docs/protocol.md's scroll row for the real gap this closes (a page's
    // own Ctrl+wheel-to-zoom handling never saw the modifier at all before).
    const modifiers =
      (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
    if (client.isConnected()) client.scroll(e.deltaY, e.deltaX, modifiers);
    // Discrete per-event dispatch (one wheel tick = one Scroll() call
    // server-side) - not a continuous stream like mousemove/touchmove, so
    // this belongs in the same noteInteraction() set as mousedown/mouseup/
    // keydown/keyup/touchstart/touchend.
    pixelTrace?.noteInteraction();
  };
  stage.addEventListener("mousemove", onMouseMove);
  stage.addEventListener("mousedown", onMouseDown);
  window.addEventListener("mouseup", onMouseUp);
  window.addEventListener("blur", onWindowBlur);
  document.addEventListener("visibilitychange", onVisibilityChange);
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
    onTouchPoints: (type, points, gestureId, moveCount) => {
      if (client.isConnected())
        client.dispatchTouch(type, points, gestureId, moveCount);
      // touchmove is deliberately excluded - continuous/coalesced input,
      // same reasoning as mousemove's own exclusion. touchstart/touchend/
      // touchcancel are the discrete edges worth tracing.
      if (type !== "touchmove") pixelTrace?.noteInteraction();
    },
    onTap: keyboard.handleTap,
  });
  const detachTouch = touch.attach(stage);

  // --- gamepad ---
  // A gamepad is a new input DEVICE, not a new input action type: every
  // callback below drives the exact same client methods real mouse/
  // keyboard input already uses, so the backend never needs to know a
  // gamepad exists. Shares this file's own video-coordinate mapping
  // (getVideoSize) so gamepad-driven cursor movement lands in the same
  // space as real mouse movement.
  const gamepadGeometry: GamepadInputGeometry = {
    getVideoSize: () => videoSize(),
  };
  const gamepad = new GamepadInputController(
    gamepadGeometry,
    {
      onCursorMove: (x, y, dragging) => {
        if (client.isConnected()) client.mouseMove(x, y, dragging);
      },
      onMouseDown: (x, y, button) => {
        if (client.isConnected()) {
          client.mouseDown(x, y, button);
          pixelTrace?.noteInteraction();
        }
      },
      onMouseUp: (x, y, button) => {
        if (client.isConnected()) client.mouseUp(x, y, button);
      },
      onScroll: (deltaY, deltaX) => {
        if (client.isConnected()) client.scroll(deltaY, deltaX);
      },
      onKeyDown: (key, code) => {
        if (client.isConnected()) {
          client.dispatchKeyEvent({
            type: "keydown",
            key,
            code,
            ctrlKey: false,
            shiftKey: false,
            altKey: false,
            metaKey: false,
          });
          pixelTrace?.noteInteraction();
        }
      },
      onKeyUp: (key, code) => {
        if (client.isConnected()) {
          client.dispatchKeyEvent({
            type: "keyup",
            key,
            code,
            ctrlKey: false,
            shiftKey: false,
            altKey: false,
            metaKey: false,
          });
        }
      },
    },
    options.gamepadMapping
  );
  const detachGamepad = gamepad.attach();

  // --- physical keyboard (window-level) ---
  const onKey = (e: KeyboardEvent) => {
    const active = document.activeElement;
    // Let a focused field (including our hidden mobile-keyboard input) own its
    // keys, so we don't double-send - except the keyup for a key this viewer
    // already sent down, which the remote page must still receive.
    const releasesHeldKey = e.type === "keyup" && heldKeys.has(e.code);
    if (
      !releasesHeldKey &&
      active &&
      (active.tagName === "INPUT" || active.tagName === "TEXTAREA")
    ) {
      return;
    }
    if (e.type === "keydown") heldKeys.set(e.code, e.key);
    else heldKeys.delete(e.code);
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
      pixelTrace?.noteInteraction();
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
  // Additive: only fires if the host enabled statsIntervalMs (default off).
  // Narrows (doesn't eliminate) the "first tap in an RTT-cold streak floors
  // at 600ms" limitation in MobileKeyboardController by keeping lastRtt
  // fresher than the fire-and-forget getStats() call in handleTap alone
  // could.
  const offStats = client.on("stats", (stats) => keyboard.setRttMs(stats.rttMs));
  // Mobile-only, backend-gated (see StateEngine's scanElements) - a no-op
  // subscription on desktop, since the backend never sends this there.
  const offInteractiveElements = client.on("interactiveElements", (elements) =>
    keyboard.setInteractiveElements(elements)
  );

  // --- viewport size reporting ---
  // The engine's set_viewport bounds. Mirrored
  // here so we clamp to a valid request rather than have one silently rejected:
  // a rejected initial_viewport doesn't just skip the resize, it skips the
  // mobile-identity declaration with it, leaving the session on its default
  // desktop viewport.
  const MIN_VIEWPORT_W = 320;
  const MIN_VIEWPORT_H = 240;
  const MAX_VIEWPORT_W = 7680;
  const MAX_VIEWPORT_H = 4320;

  // Reports CSS pixels, NOT device pixels.
  //
  // The backend feeds these straight into Emulation.setDeviceMetricsOverride
  // with DeviceScaleFactor: 1 (see applyDeviceEmulation), so the value is the
  // page's CSS-pixel viewport - the thing that decides whether a site serves
  // its mobile or desktop layout. This used to multiply by devicePixelRatio,
  // which on a DPR-4 phone turned a 688x1221 viewport into a request for
  // 2752x4884: past the backend's 4320 height bound, so it was rejected
  // outright (mobile emulation never applied, desktop site served, taps
  // interpreted as desktop double-tap-to-zoom), and had it been accepted it
  // would have laid the page out as a giant desktop screen AND encoded 13.4
  // megapixels per frame. Found on a real phone.
  //
  // Consequence worth knowing: video is now encoded at CSS resolution, so on a
  // high-DPI display it is upscaled and slightly soft. Fixing that properly
  // means sending devicePixelRatio as a separate field and applying it as
  // DeviceScaleFactor server-side - which is what that CDP parameter is for -
  // rather than folding it into the layout size. Deliberately not done here:
  // it's an additive protocol change, and layout correctness matters more than
  // sharpness.
  const computeViewport = (): { width: number; height: number } => {
    const rect = stageRect();
    let w = Math.floor(rect.width);
    let h = Math.floor(rect.height);
    // Even dimensions keep the H.264 encoder happy downstream.
    w = w % 2 === 0 ? w : Math.max(0, w - 1);
    h = h % 2 === 0 ? h : Math.max(0, h - 1);
    w = Math.min(MAX_VIEWPORT_W, Math.max(MIN_VIEWPORT_W, w));
    h = Math.min(MAX_VIEWPORT_H, Math.max(MIN_VIEWPORT_H, h));
    return { width: w, height: h };
  };

  // Each distinct viewport size the backend receives triggers a screencast +
  // H.264 encoder restart, so we work hard to send as few as possible:
  //  - re-measure at *send* time (not when the change was observed), so a storm
  //    of intermediate sizes during a layout settle collapses to the final one;
  //  - ignore sub-pixel / rounding churn below a threshold;
  //  - only advance lastSent when we actually send, so dedup compares against
  //    what the backend last received.
  //
  // Deliberately does NOT skip the first moments after mount. It used to,
  // on the assumption that declareViewport's own (synchronous, unsettled)
  // measurement already covered the mount size correctly - live-measured on
  // a real phone, that assumption is false: declareViewport can catch a
  // transient bad reading (window.innerWidth genuinely read ~980 CSS px at
  // the instant a URL was submitted from a welcome-screen text input, i.e.
  // right as the on-screen keyboard was closing, then ~384 - confirmed
  // correct - moments later). declareViewport itself can't be delayed to
  // avoid this (see its own comment - app.tsx's first navigate doesn't wait
  // for it), so THIS is where a bad initial reading actually gets corrected:
  // letting the observer fire from the start means a real post-mount size
  // change (like the one above) reaches significantChange() and gets
  // dispatched via the normal debounced path, instead of being silently
  // dropped during exactly the window it's needed most.
  const MIN_DELTA_PX = 4;
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
    const measured = computeViewport();
    if (!significantChange(measured.width, measured.height)) return;
    scheduleViewport();
  });
  observer.observe(stage);

  // navigator.userAgentData isn't in every TS DOM lib yet (experimental,
  // Chromium-only) and doesn't exist at all on browsers without UA-CH
  // support (notably iOS Safari) - both cases fall through to undefined,
  // which sendInitialViewport treats as "omit the field", not "send empty".
  const getUserAgentClientHints = (): UserAgentClientHints | undefined => {
    const uaData = (
      navigator as unknown as {
        userAgentData?: {
          brands?: { brand: string; version: string }[];
          mobile?: boolean;
          platform?: string;
        };
      }
    ).userAgentData;
    if (!uaData) return undefined;
    return {
      brands: uaData.brands ?? [],
      mobile: uaData.mobile ?? true,
      platform: uaData.platform ?? "",
    };
  };

  // Declare the initial viewport + mobile identity to the backend, before any
  // host-triggered navigation, so the page is created with the right device
  // identity. Covers both mount orderings:
  //  - viewer mounted before connect: the "connected" handler fires it.
  //  - viewer mounted after the client already connected (common - the app
  //    connects up front and mounts the viewer on first navigation): the
  //    "connected" event already fired, so send it immediately here.
  // Re-declaring on each reconnect is harmless.
  //
  // Deliberately synchronous, not settle-delayed: app.tsx's pendingUrl
  // effect fires the actual first client.navigate() as soon as
  // mountGlassViewer() returns (viewerReady flips true synchronously in
  // its own effect) - it does not wait for this to actually send. Delaying
  // this call would race that ordering and risk the navigate reaching the
  // backend before the mobile declaration does, for real, on every
  // connection - a worse and more frequent bug than the one below.
  //
  // This value CAN still be transiently wrong at this exact instant - this
  // is typically the FIRST measurement of the session, fired right as a
  // URL is submitted from a welcome-screen text input, i.e. right as the
  // on-screen keyboard is closing and the layout is still transitioning.
  // Live-measured on a real phone: window.innerWidth genuinely read ~980
  // CSS px in that instant, then ~384 (confirmed correct) moments later -
  // every measurement API agreed with itself at each instant, just
  // disagreed between instants. Correcting that without breaking the
  // ordering above is the ResizeObserver's job below, not this function's.
  const declareViewport = () => {
    const { width, height } = computeViewport();
    client.sendInitialViewport(
      width,
      height,
      isMobile,
      isMobile ? navigator.userAgent : undefined,
      isMobile ? getUserAgentClientHints() : undefined
    );
    lastSent = { width, height };
  };
  const offConnected = client.on("connected", declareViewport);
  if (client.isConnected()) declareViewport();

  return {
    video,
    destroy() {
      releaseAllHeld();
      offVideoTrack();
      offState();
      offNav();
      offStats();
      offInteractiveElements();
      offConnected();
      stage.removeEventListener("mousemove", onMouseMove);
      stage.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("blur", onWindowBlur);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      stage.removeEventListener("contextmenu", onContextMenu);
      stage.removeEventListener("wheel", onWheel);
      if (captureKeyboard) {
        window.removeEventListener("keydown", onKey);
        window.removeEventListener("keyup", onKey);
      }
      detachTouch();
      detachGamepad();
      keyboard.destroy();
      observer.disconnect();
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      pixelTrace?.stop();
      stopFrameWatch?.();
      stopFrameWatch = null;
      decodeReadback?.stop();
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
export {
  GamepadInputController,
  DEFAULT_GAMEPAD_MAPPING,
  applyStickCurve,
  type GamepadMapping,
  type GamepadButtonMapping,
  type GamepadAxisMapping,
  type GamepadInputGeometry,
} from "./gamepadInput.js";
