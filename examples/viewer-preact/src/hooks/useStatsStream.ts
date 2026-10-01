import { useEffect, useState } from "preact/hooks";
import type { PerformanceStats } from "../components/BrowserHeader";
import { API_TOKEN, GLASS_ADDR } from "../config";

// useStatsStream follows the backend's per-session SSE stats stream for
// BrowserHeader's stats menu.
export function useStatsStream(sessionId: string | null) {
  // Live performance stats (BrowserHeader's StatsMenu) - previously wired
  // to permanently-hardcoded fps={0}/performanceStats={null}, a dead UI
  // shell with nothing feeding it. Fed by the backend's own SSE stats
  // stream (GET /v1/sessions/{id}/stats/stream, source.Stats JSON every
  // 2s) - same live mechanism
  // benchmarking tooling
  // already scrapes, so this UI and any automated capture see identical
  // numbers.
  const [fps, setFps] = useState(0);
  const [perfStats, setPerfStats] = useState<PerformanceStats | null>(null);

  // Subscribes to the backend's per-session SSE stats stream for as long as
  // a session exists - closes and reopens automatically whenever sessionId
  // changes (a fresh session after reconnect/navigation gets a fresh
  // stream). fps is derived client-side from consecutive FramesEmitted
  // deltas (the backend only reports cumulative counters, not an
  // instantaneous rate) - source.Stats' own JSON field names (PascalCase,
  // matching the Go struct's json tags) are mapped here into
  // BrowserHeader's camelCase PerformanceStats shape.
  useEffect(() => {
    if (!sessionId) {
      setFps(0);
      setPerfStats(null);
      return;
    }
    // EventSource can't send an Authorization header at all - the backend
    // knows this and
    // accepts ?token= on this exact route for that reason. Without it,
    // this request 401s the moment GLASS_API_TOKEN is set (i.e. every real
    // deployment, not just this dev-convenience viewer) - live-found
    // 2026-09-07, silently broken since this stats stream was first wired
    // up, harmless beyond the stats menu never populating (video/input are
    // on a separate, already-authenticated signaling connection).
    const statsStreamUrl = API_TOKEN
      ? `${GLASS_ADDR}/v1/sessions/${sessionId}/stats/stream?token=${encodeURIComponent(API_TOKEN)}`
      : `${GLASS_ADDR}/v1/sessions/${sessionId}/stats/stream`;
    const es = new EventSource(statsStreamUrl);
    let prevFramesEmitted: number | null = null;
    let prevCapturedAt: number | null = null;
    es.onmessage = (ev) => {
      try {
        const stats = JSON.parse(ev.data);
        const capturedAt = new Date(stats.capturedAt).getTime();
        if (prevFramesEmitted !== null && prevCapturedAt !== null) {
          const deltaFrames = stats.framesEmitted - prevFramesEmitted;
          const deltaSec = (capturedAt - prevCapturedAt) / 1000;
          if (deltaSec > 0) setFps(Math.max(0, deltaFrames / deltaSec));
        }
        prevFramesEmitted = stats.framesEmitted;
        prevCapturedAt = capturedAt;
        setPerfStats({
          memAllocMB: stats.memAllocMB ?? 0,
          totalBytesSentMB: (stats.bytesSent ?? 0) / 1024 / 1024,
          framesSent: stats.framesEmitted ?? 0,
          framesSkipped:
            (stats.framesDroppedPacing ?? 0) +
            (stats.framesDroppedCongestion ?? 0),
          // No SSE equivalent, and StatsMenu never renders it.
          largeChangePercent: 0,
        });
      } catch (e) {
        console.error("Failed to parse stats stream message", e);
      }
    };
    es.onerror = () => {
      // EventSource retries connection drops on its own (browser-native
      // reconnect-with-backoff) - nothing to do here beyond not crashing;
      // a session-closed/404 case just stops producing messages until this
      // effect's own cleanup below tears it down on the next sessionId change.
    };
    return () => es.close();
  }, [sessionId]);

  return { fps, perfStats };
}
