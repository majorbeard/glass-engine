import { URLBar } from "./URLBar";

type WelcomeViewProps = {
  onNavigate: (url: string) => void;
  isConnected: boolean;
  isLoading: boolean;
  error: string | null;
};

// The landing screen: a URL bar, shown until the session has content.
export function WelcomeView({ onNavigate, isConnected, isLoading, error }: WelcomeViewProps) {
  return (
    <div class="w-full h-full flex flex-col items-center justify-center gap-6 p-4">
      <h1 class="text-7xl font-thin tracking-[0.2em] text-white/90">
        Glass
      </h1>
      <div class="w-full max-w-xl">
        <URLBar
          onNavigate={onNavigate}
          onNavigateBack={() => {}}
          onNavigateForward={() => {}}
          onRefresh={() => {}}
          disabled={!isConnected && !error}
          isLoading={isLoading || (!isConnected && !error)}
          isActive={false}
        />
      </div>
      {!isConnected && !error && (
        <div class="absolute bottom-4 right-4 text-sm text-white/80 bg-black/30 px-3 py-1 rounded-full animate-pulse">
          Connecting...
        </div>
      )}
      {error && (
        <div class="absolute bottom-4 right-4 text-sm text-red-100 bg-red-600/80 px-3 py-1 rounded-full">
          {error}
        </div>
      )}
    </div>
  );
}
