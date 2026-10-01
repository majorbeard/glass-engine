import { useState } from "preact/hooks";
import type { ComponentChildren } from "preact";

interface URLBarProps {
  onNavigate: (url: string) => void;
  onNavigateBack: () => void;
  onNavigateForward: () => void;
  onRefresh: () => void;
  disabled: boolean;
  isLoading: boolean;
  isActive: boolean;
}

interface NavButtonProps {
  onClick: () => void;
  disabled: boolean;
  children: ComponentChildren;
}

const NavButton = ({ onClick, disabled, children }: NavButtonProps) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    class="flex-shrink-0 p-2 rounded-full hover:bg-black/10 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
  >
    {children}
  </button>
);

export function URLBar({
  onNavigate,
  onNavigateBack,
  onNavigateForward,
  onRefresh,
  disabled,
  isLoading,
  isActive,
}: URLBarProps) {
  const [url, setUrl] = useState("");

  const handleSubmit = (e: Event) => {
    e.preventDefault();
    let finalUrl = url.trim() || "google.com";
    // Only prefix with https:// when there's no scheme at all - a naive
    // startsWith("http") check turned "chrome://gpu" into the malformed
    // "https://chrome://gpu", which Chrome/CDP can't navigate to and falls
    // back to searching for instead (real bug, not a Glass/GPU issue).
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(finalUrl)) {
      finalUrl = "https://" + finalUrl;
    }
    onNavigate(finalUrl);
  };

  if (isActive) {
    return (
      <div class="glass-ui h-[52px] overflow-hidden p-2 flex items-center gap-2">
        <div class="flex items-center">
          <NavButton onClick={onNavigateBack} disabled={disabled}>
            <svg
              class="w-5 h-5 text-slate-700"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M15 19l-7-7 7-7"
              />
            </svg>
          </NavButton>
          <NavButton onClick={onNavigateForward} disabled={disabled}>
            <svg
              class="w-5 h-5 text-slate-700"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M9 5l7 7-7 7"
              />
            </svg>
          </NavButton>
          <NavButton onClick={onRefresh} disabled={isLoading || disabled}>
            <svg
              class="w-5 h-5 text-slate-700"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M4 4v5h5M20 20v-5h-5m-5-1a7.002 7.002 0 00-7-7.002m14.002 0a7.002 7.002 0 00-7 7.002"
              />
            </svg>
          </NavButton>
        </div>

        <form
          onSubmit={handleSubmit}
          class="flex items-center gap-2 h-full flex-1"
        >
          <div class="flex-1 relative h-full">
            <input
              type="text"
              value={url}
              onInput={(e) => setUrl((e.target as HTMLInputElement).value)}
              disabled={disabled}
              placeholder="Go anywhere..."
              class="w-full px-4 h-full text-base rounded-lg focus:outline-none transition-colors duration-200
                           bg-black/5 text-slate-800 placeholder:text-slate-500
                           hover:bg-white hover:text-black hover:placeholder:text-gray-500"
            />
          </div>
          <button
            type="submit"
            disabled={disabled || isLoading}
            class="font-semibold text-white bg-blue-500 rounded-lg hover:bg-blue-600 px-4 h-full transition-colors disabled:bg-slate-400"
          >
            Search
          </button>
        </form>
      </div>
    );
  }

  // --- INACTIVE / WELCOME SCREEN ---
  return (
    <form onSubmit={handleSubmit} class="w-full flex items-center gap-3 group">
      <div class="flex-1 relative">
        <input
          type="text"
          value={url}
          onInput={(e) => setUrl((e.target as HTMLInputElement).value)}
          disabled={disabled}
          placeholder="Start by searching Google or entering a URL"
          class="w-full text-center text-lg text-white bg-transparent border border-white/50 rounded-lg px-6 py-3
                 placeholder:text-white/70 focus:outline-none focus:ring-2 focus:ring-white/80 transition-all duration-300
                 group-hover:bg-white group-hover:text-black group-hover:placeholder:text-gray-500"
        />
      </div>
      <button
        type="submit"
        disabled={disabled || isLoading}
        class="font-semibold text-white bg-blue-600 rounded-lg px-6 py-3 transition-all duration-300 hover:bg-blue-500 disabled:opacity-50 disabled:bg-blue-800"
      >
        Search
      </button>
    </form>
  );
}
