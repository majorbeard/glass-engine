import { useCallback, useEffect, useState } from "preact/hooks";
import type { GlassClient } from "@glass/client";
import type { Notify } from "./useGlassSession";

type NavigationDeps = {
  client: GlassClient | null;
  // The source the URL bar drives: the shown browser.
  sourceId: string | null;
  isActive: boolean;
  setIsActive: (active: boolean) => void;
  setError: (error: string | null) => void;
  setIsLoading: (loading: boolean) => void;
  notify: Notify;
  closeContextMenu: () => void;
  // viewerReady: the viewer is mounted (see the mount effect in app.tsx).
  viewerReady: boolean;
  // sessionEpoch changes when a fresh session replaces a closed one.
  sessionEpoch: number;
};

// useNavigation returns the URL bar's handlers. The first navigate waits for
// the viewer to mount (pendingUrl).
export function useNavigation({ client, sourceId, isActive, setIsActive, setError, setIsLoading, notify, closeContextMenu, viewerReady, sessionEpoch }: NavigationDeps) {
  // The viewer must exist before the first navigation so its on-connect
  // initial-viewport/mobile declaration reaches the backend before the page is
  // created (see mountGlassViewer's doc comment). handleNavigate flips isActive
  // - which mounts the viewer - and stashes the URL here; a post-mount effect
  // then issues the navigate.
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);

  // A fresh session starts from the landing screen; a navigate queued for
  // the old one is dropped.
  useEffect(() => {
    if (sessionEpoch > 0) setPendingUrl(null);
  }, [sessionEpoch]);

  const handleNavigate = useCallback(
    (url: string) => {
      if (!client || !sourceId || !client.isConnected()) {
        setError("Cannot navigate: Not connected");
        notify({ message: "Connection lost.", type: "error" });
        return;
      }
      closeContextMenu();
      setError(null);
      setIsLoading(true);
      if (!isActive) {
        // Defer the navigate until the viewer has mounted (see pendingUrl).
        setIsActive(true);
        setPendingUrl(url);
      } else {
        client.source(sourceId).navigate(url);
      }
    },
    [client, sourceId, isActive]
  );

  useEffect(() => {
    if (viewerReady && pendingUrl && client && sourceId) {
      client.source(sourceId).navigate(pendingUrl);
      setPendingUrl(null);
    }
  }, [viewerReady, pendingUrl, client, sourceId]);

  const handleNavigateBack = useCallback(() => {
    if (client?.isConnected() && sourceId) client.source(sourceId).navigateBack();
  }, [client, sourceId]);
  const handleNavigateForward = useCallback(() => {
    if (client?.isConnected() && sourceId) client.source(sourceId).navigateForward();
  }, [client, sourceId]);
  const handleRefresh = useCallback(() => {
    if (client?.isConnected() && sourceId) client.source(sourceId).refresh();
  }, [client, sourceId]);

  return { handleNavigate, handleNavigateBack, handleNavigateForward, handleRefresh };
}
