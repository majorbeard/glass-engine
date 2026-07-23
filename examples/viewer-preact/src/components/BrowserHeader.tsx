import type { ComponentChildren } from "preact";
import { useState, useRef, useEffect } from "preact/hooks";

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
}: BrowserHeaderProps) {
  const [inputUrl, setInputUrl] = useState("");
  const [isStatsMenuOpen, setIsStatsMenuOpen] = useState(false);
  const statsMenuRef = useRef<HTMLDivElement>(null);

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

    const isUrl =
      (rawInput.includes(".") && !rawInput.includes(" ")) ||
      rawInput.startsWith("http://") ||
      rawInput.startsWith("https://");

    if (isUrl) {
      if (!/^(https?:\/\/)/i.test(rawInput)) {
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
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div class="browser-header">
      <div class="nav-buttons">
        {/* MODIFIED: Disable buttons based on actual navigation state */}
        <NavButton onClick={onNavigateBack} disabled={disabled || !canGoBack}>
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
          disabled={disabled || !canGoForward}
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
        <NavButton onClick={onRefresh} disabled={isLoading || disabled}>
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

      <div class="header-actions" ref={statsMenuRef}>
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
