import { useCallback, useEffect, useState } from "preact/hooks";
import type { GlassClient } from "@glass/client";
import type { Notify } from "./useGlassSession";

type NavigationDeps = {
  client: GlassClient | null;
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
export function useNavigation({ client, isActive, setIsActive, setError, setIsLoading, notify, closeContextMenu, viewerReady, sessionEpoch }: NavigationDeps) {
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
      if (!client || !client.isConnected()) {
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
        client.navigate(url);
      }
    },
    [client, isActive]
  );

  useEffect(() => {
    if (viewerReady && pendingUrl && client) {
      client.navigate(pendingUrl);
      setPendingUrl(null);
    }
  }, [viewerReady, pendingUrl, client]);

  const handleNavigateBack = useCallback(() => {
    if (client?.isConnected()) client.navigateBack();
  }, [client]);
  const handleNavigateForward = useCallback(() => {
    if (client?.isConnected()) client.navigateForward();
  }, [client]);
  const handleRefresh = useCallback(() => {
    if (client?.isConnected()) client.refresh();
  }, [client]);

  return { handleNavigate, handleNavigateBack, handleNavigateForward, handleRefresh };
}
