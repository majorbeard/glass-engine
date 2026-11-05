import { useEffect, useState } from "preact/hooks";
import type { GlassPlaybackState } from "@glass/client";

// The controls of a playback session: play or pause, a seek bar and the
// time. A seek lands on the recording's keyframe at or before the point
// chosen. Shown to every viewer; only a viewer with control can use them.

function clock(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function PlaybackBar({
  state,
  canControl,
  onControl,
}: {
  state: GlassPlaybackState;
  canControl: boolean;
  onControl: (action: "play" | "pause" | "seek", positionMs?: number) => void;
}) {
  // While dragging, the bar shows the drag, not the playing position.
  const [dragMs, setDragMs] = useState<number | null>(null);
  useEffect(() => setDragMs(null), [state.positionMs]);
  const shown = dragMs ?? state.positionMs;
  return (
    <div
      class="absolute bottom-4 left-1/2 -translate-x-1/2 z-30 flex items-center gap-3 px-4 py-2 rounded-full bg-black/70 text-white text-sm shadow w-[min(36rem,calc(100%-8rem))]"
      role="group"
      aria-label="Playback"
    >
      <button
        type="button"
        class="px-2 py-1 rounded hover:bg-white/20 disabled:opacity-50"
        disabled={!canControl}
        onClick={() => onControl(state.playing ? "pause" : "play")}
        aria-label={state.playing ? "Pause" : "Play"}
      >
        {state.playing ? "Pause" : state.ended ? "Replay" : "Play"}
      </button>
      <input
        type="range"
        class="flex-1"
        min={0}
        max={Math.max(state.durationMs, 1)}
        value={shown}
        disabled={!canControl}
        aria-label="Position"
        onInput={(e) => setDragMs(Number((e.target as HTMLInputElement).value))}
        onChange={(e) => onControl("seek", Number((e.target as HTMLInputElement).value))}
      />
      <span class="tabular-nums whitespace-nowrap">
        {clock(shown)} / {clock(state.durationMs)}
      </span>
    </div>
  );
}
