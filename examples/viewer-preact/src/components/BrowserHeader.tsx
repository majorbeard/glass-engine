import type { ComponentChildren } from "preact";
import { useState, useRef, useEffect } from "preact/hooks";
import type { GlassRosterEntry } from "@glass/client";

export interface PerformanceStats {
  memAllocMB: number;
  totalBytesSentMB: number;
  framesSent: number;
  framesSkipped: number;
  largeChangePercent: number;
}

interface BrowserHeaderProps {
  onNavigate: (url: string) => void;
  onNavigateBack: () => void;
  onNavigateForward: () => void;
  onRefresh: () => void;
  disabled: boolean;
  isLoading: boolean;
  isConnected: boolean;
  fps: number;
  viewportSize: { width: number; height: number };
  canvasScale: { x: number; y: number; offsetX: number; offsetY: number };
  performanceStats: PerformanceStats | null;
  // ADDED: Props for navigation state
  currentURL: string;
  canGoBack: boolean;
  canGoForward: boolean;
  // Input handoff - read-only here by this example's own policy choice
  // (see the header-actions render below for why): producesInput reflects
  // current state, but nothing in this component ever calls
  // @glass/client's requestInput()/releaseInput() - only the owner's
  // grantInput()/revokeInput() (below) ever change it.
  producesInput: boolean;
  onShareWatchOnlyLink: () => void;
  // Owner-controlled handoff (docs/protocol.md's "Owner-controlled
  // handoff" section) - see @glass/client's isOwner()/connections()/
  // grantInput()/revokeInput(). connections is always empty for a
  // non-owner (see isOwner()'s own doc comment), so isOwner is really
  // just an early-out to skip rendering the panel at all.
  isOwner: boolean;
  connections: GlassRosterEntry[];
  onGrantInput: (connectionId: string) => void;
  onRevokeInput: (connectionId: string) => void;
}

const NavButton = ({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  children: ComponentChildren;
}) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    class="p-2 rounded-full hover:bg-black/10 disabled:opacity-40 disabled:hover:bg-transparent transition-colors"
  >
    {children}
  </button>
);

function StatsMenu({
  stats,
  fps,
  viewport,
  scale,
}: {
  stats: PerformanceStats | null;
  fps: number;
  viewport: { width: number; height: number };
  scale: { x: number };
}) {
  const frameEfficiency =
    stats && stats.framesSent + stats.framesSkipped > 0
      ? (
          (stats.framesSkipped / (stats.framesSent + stats.framesSkipped)) *
          100
        ).toFixed(1)
      : "0.0";

  return (
    <div class="absolute top-full right-0 mt-2 w-64 bg-white rounded-lg shadow-xl border border-slate-200 p-3 z-30 animate-fade-in-fast">
      <h3 class="font-bold text-sm mb-2 border-b border-slate-200 pb-1 text-slate-700">
        Live Metrics
      </h3>
      <div class="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-xs text-slate-600">
        <span>FPS:</span>
        <span class="text-right">{fps}</span>
        <span>Viewport:</span>
        <span class="text-right">
          {viewport.width}×{viewport.height}
        </span>
        <span>Zoom:</span>
        <span class="text-right">{(scale.x * 100).toFixed(0)}%</span>
        {stats && (
          <>
            <div class="col-span-2 my-1 border-t border-slate-200"></div>
            <span>Mem Alloc:</span>
            <span class="text-right">{stats.memAllocMB} MB</span>
            <span>Bandwidth:</span>
            <span class="text-right">
              {stats.totalBytesSentMB.toFixed(2)} MB
            </span>
            <span>Frames Sent:</span>
            <span class="text-right">{stats.framesSent}</span>
            <span>Frames Skip:</span>
            <span class="text-right">{frameEfficiency}%</span>
          </>
        )}
      </div>
    </div>
  );
}

// Owner-controlled handoff (docs/protocol.md's "Owner-controlled handoff"
// section) - lists every other connection on the session and lets the
// owner grant/revoke each one's producesInput individually. Only ever
// rendered when isOwner is true (see BrowserHeader's own render below) -
// connections is always empty for a non-owner anyway.
function RosterMenu({
  connections,
  onGrantInput,
  onRevokeInput,
}: {
  connections: GlassRosterEntry[];
  onGrantInput: (connectionId: string) => void;
  onRevokeInput: (connectionId: string) => void;
}) {
  return (
    <div class="absolute top-full right-0 mt-2 w-72 bg-white rounded-lg shadow-xl border border-slate-200 p-3 z-30 animate-fade-in-fast">
      <h3 class="font-bold text-sm mb-2 border-b border-slate-200 pb-1 text-slate-700">
        Connected viewers
      </h3>
      {connections.length === 0 ? (
        <p class="text-xs text-slate-500 py-2">
          No one else is connected yet.
        </p>
      ) : (
        <ul class="flex flex-col gap-1.5">
          {connections.map((c) => (
            <li
              key={c.connectionId}
              class="flex items-center justify-between gap-2 text-xs"
            >
              <span class="flex items-center gap-1.5 min-w-0">
                <span
                  class={`w-2 h-2 rounded-full flex-shrink-0 ${
                    c.producesInput ? "bg-blue-600" : "bg-slate-300"
                  }`}
                />
                <span class="font-mono truncate text-slate-600">
                  {c.connectionId.slice(0, 8)}
                  {c.isOwner ? " (owner)" : ""}
                </span>
              </span>
              <button
                type="button"
                onClick={() =>
                  c.producesInput
                    ? onRevokeInput(c.connectionId)
                    : onGrantInput(c.connectionId)
                }
                class={`flex-shrink-0 px-2 py-0.5 rounded text-xs font-semibold transition-colors ${
                  c.producesInput
                    ? "bg-red-50 text-red-600 hover:bg-red-100"
                    : "bg-blue-50 text-blue-600 hover:bg-blue-100"
                }`}
              >
                {c.producesInput ? "Revoke" : "Grant"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function BrowserHeader({
  onNavigate,
  onNavigateBack,
  onNavigateForward,
  onRefresh,
  disabled,
  isLoading,
  isConnected,
  fps,
  viewportSize,
  canvasScale,
  performanceStats,
  // ADDED: Destructure new props
  currentURL,
  canGoBack,
  canGoForward,
  producesInput,
  onShareWatchOnlyLink,
  isOwner,
  connections,
  onGrantInput,
  onRevokeInput,
}: BrowserHeaderProps) {
  const [inputUrl, setInputUrl] = useState("");
  const [isStatsMenuOpen, setIsStatsMenuOpen] = useState(false);
  const statsMenuRef = useRef<HTMLDivElement>(null);
  const [isRosterMenuOpen, setIsRosterMenuOpen] = useState(false);
  const rosterMenuRef = useRef<HTMLDivElement>(null);

  // MODIFIED: Sync input with the actual URL from the backend
  useEffect(() => {
    setInputUrl(currentURL);
  }, [currentURL]);

  const handleSubmit = (e: Event) => {
    e.preventDefault();
    const rawInput = inputUrl.trim();
    if (!rawInput) return;

    let finalUrl = "";
    const searchEngineUrl = "https://www.google.com/search?q=";

    // schemeRegex mirrors URLBar.tsx's own fix (see that component's doc
    // comment): a real, live-found bug (2026-09-04, GPU-rendering research)
    // - this component's isUrl check only recognized a bare "." or an
    // explicit http(s):// prefix, so a real scheme like "chrome://gpu" (no
    // dot, no http prefix) fell through to the search-query branch,
    // silently becoming a Google search instead of navigating. URLBar.tsx
    // got this exact fix already; this component never did, since the two
    // are separate implementations of the same "turn raw input into a
    // navigable URL" job for the pre-connection vs. connected UI states.
    const schemeRegex = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;
    const isUrl =
      (rawInput.includes(".") && !rawInput.includes(" ")) ||
      schemeRegex.test(rawInput);

    if (isUrl) {
      if (!schemeRegex.test(rawInput)) {
        finalUrl = "https://" + rawInput;
      } else {
        finalUrl = rawInput;
      }
    } else {
      finalUrl = searchEngineUrl + encodeURIComponent(rawInput);
    }

    onNavigate(finalUrl);
  };

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        statsMenuRef.current &&
        !statsMenuRef.current.contains(event.target as Node)
      ) {
        setIsStatsMenuOpen(false);
      }
      if (
        rosterMenuRef.current &&
        !rosterMenuRef.current.contains(event.target as Node)
      ) {
        setIsRosterMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div class="browser-header">
      <div class="nav-buttons">
        {/* Owner-only, same reasoning as the URL bar below - the backend
            now rejects a non-owner's back/forward/refresh regardless of
            producesInput, so these must be disabled here too or a
            non-owner interactive-control holder (one who CAN otherwise
            click/type/scroll on the shared page) would see live-looking
            buttons that silently do nothing - the exact confusing-dead-
            control problem the URL bar fix below already solved for typing
            a URL directly. Disabled, not hidden (unlike the URL bar): a
            greyed-out icon reads clearly as "not available to you" without
            needing a layout-preserving empty placeholder. */}
        <NavButton
          onClick={onNavigateBack}
          disabled={disabled || !canGoBack || !isOwner}
        >
          <svg
            class="w-5 h-5 text-slate-600"
            viewBox="0 0 20 20"
            fill="currentColor"
          >
            <path
              fill-rule="evenodd"
              d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z"
              clip-rule="evenodd"
            />
          </svg>
        </NavButton>
        <NavButton
          onClick={onNavigateForward}
          disabled={disabled || !canGoForward || !isOwner}
        >
          <svg
            class="w-5 h-5 text-slate-600"
            viewBox="0 0 20 20"
            fill="currentColor"
          >
            <path
              fill-rule="evenodd"
              d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z"
              clip-rule="evenodd"
            />
          </svg>
        </NavButton>
        <NavButton onClick={onRefresh} disabled={isLoading || disabled || !isOwner}>
          <svg
            class="w-5 h-5 text-slate-600"
            viewBox="0 0 20 20"
            fill="currentColor"
          >
            <path
              fill-rule="evenodd"
              d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 110 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z"
              clip-rule="evenodd"
            />
          </svg>
        </NavButton>
      </div>

      {/* Owner-only, deliberately - not just disabled. A share-link viewer
          (watch-only or currently granted interactive control - see
          producesInput above) must never be able to navigate this session
          to a different URL at all: that's an owner-level action (changing
          what's being shared with everyone), distinct from interacting
          WITH the currently-shared page. A real, live-found gap (2026-09-07
          dogfooding) found this input rendered and enabled for every
          viewer, letting a watch-only (or even interactively-controlled-
          but-non-owner) share-link recipient type a URL and submit it -
          at the time, that request actually reached the backend's
          signaling-socket "navigate" handler with NO authorization check
          at all (a separate gap, since fixed in the engine), so
          this UI-only fix was, for months, the *only* thing stopping a
          non-owner from actually navigating the shared session, not a
          defense-in-depth layer on top of an already-enforced backend rule
          as originally assumed here. Both layers are real now. Rendering
          it only for isOwner still removes the confusing-dead-input
          problem this was written for, independent of the backend gate's
          own history. The empty .url-bar-form below (an intentional no-op
          div) preserves this element's flex-grow spacer role in the header
          layout for non-owners rather than collapsing the nav buttons and
          header-actions together. */}
      {isOwner ? (
        <form onSubmit={handleSubmit} class="url-bar-form">
          <div class="url-input-wrapper">
            <input
              type="text"
              value={inputUrl}
              onInput={(e) => setInputUrl((e.target as HTMLInputElement).value)}
              disabled={disabled}
              placeholder="Search Google or type a URL"
              class="url-input"
            />
          </div>
        </form>
      ) : (
        <div class="url-bar-form" />
      )}

      <div class="header-actions" ref={statsMenuRef}>
        {/* Input handoff, owner-controlled by policy (this example's own
            choice, not something Glass enforces - see docs/protocol.md's
            "Control handoff" section for the self-service requestInput()/
            releaseInput() primitives this deliberately doesn't expose):
            only the owner can mint a shareable link, and only the owner
            can grant/revoke who gets to interact (via the roster panel
            below) - a viewer can never request control or release the
            owner's own, and the owner can never release its own control
            either. This control-status indicator is read-only for
            everyone; the roster panel is the only way this state ever
            changes. */}
        {isOwner && (
          <button
            type="button"
            onClick={onShareWatchOnlyLink}
            disabled={!isConnected}
            title="Copy a watch-only link for this session"
            class="p-2 rounded-full hover:bg-black/10 disabled:opacity-40 disabled:hover:bg-transparent transition-colors"
          >
            <svg class="w-5 h-5 text-slate-600" viewBox="0 0 20 20" fill="currentColor">
              <path d="M15 8a3 3 0 10-2.977-2.63l-4.94 2.47a3 3 0 100 4.319l4.94 2.47a3 3 0 10.895-1.789l-4.94-2.47a3.027 3.027 0 000-.74l4.94-2.47C13.456 7.68 14.19 8 15 8z" />
            </svg>
          </button>
        )}
        <div
          title={isOwner ? "Owner" : producesInput ? "In control" : "Watch-only"}
          class={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-semibold ${
            isOwner || producesInput
              ? "bg-blue-100 text-blue-700"
              : "text-slate-700"
          }`}
        >
          <div
            class={`w-2 h-2 rounded-full ${
              isOwner || producesInput ? "bg-blue-600" : "bg-slate-400"
            }`}
          />
          <span class="hidden sm:block">
            {isOwner ? "Owner" : producesInput ? "In control" : "Watch-only"}
          </span>
        </div>
        {/* Owner-controlled handoff (docs/protocol.md's "Owner-controlled
            handoff" section) - only the session owner ever sees this. */}
        {isOwner && (
          <div class="relative" ref={rosterMenuRef}>
            <button
              type="button"
              onClick={() => setIsRosterMenuOpen((prev) => !prev)}
              disabled={!isConnected}
              title="Connected viewers - grant or revoke control"
              class="flex items-center gap-1.5 px-2 py-2 rounded-lg hover:bg-black/10 disabled:opacity-40 transition-colors"
            >
              <svg
                class="w-5 h-5 text-slate-600"
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path d="M9 6a3 3 0 11-6 0 3 3 0 016 0zM17 6a3 3 0 11-6 0 3 3 0 016 0zM12.93 17c.046-.327.07-.66.07-1a6.97 6.97 0 00-1.5-4.33A5 5 0 0119 16v1h-6.07zM6 11a5 5 0 015 5v1H1v-1a5 5 0 015-5z" />
              </svg>
              {connections.length > 0 && (
                <span class="text-xs font-semibold text-slate-600">
                  {connections.length}
                </span>
              )}
            </button>
            {isRosterMenuOpen && (
              <RosterMenu
                connections={connections}
                onGrantInput={onGrantInput}
                onRevokeInput={onRevokeInput}
              />
            )}
          </div>
        )}
        <button
          onClick={() => setIsStatsMenuOpen((prev) => !prev)}
          class="flex items-center gap-2 p-2 rounded-lg hover:bg-black/10 transition-colors"
          title="Connection Status & Metrics"
        >
          <div
            class={`w-2.5 h-2.5 rounded-full ${
              isConnected ? "bg-green-500" : "bg-red-500"
            }`}
          />
          <span class="text-sm font-semibold text-slate-700 hidden sm:block">
            {isConnected ? "Connected" : "Offline"}
          </span>
        </button>
        {isStatsMenuOpen && (
          <StatsMenu
            stats={performanceStats}
            fps={fps}
            viewport={viewportSize}
            scale={canvasScale}
          />
        )}
      </div>
    </div>
  );
}
