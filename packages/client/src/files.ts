// Download URLs and uploads. See GlassClient (index.ts) for the public API.

import type { ClientCore } from "./core";
import { sessionIdFromSignalingUrl } from "./internal";

// See GlassClient.downloadUrl.
export function downloadUrl(c: ClientCore, guid: string): string {
  const sessionId = sessionIdFromSignalingUrl(c.signalingUrl) ?? c.sessionId ?? "";
  let path = `${c.sessionBaseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/downloads/${encodeURIComponent(guid)}`;
  try {
    const token = new URL(c.signalingUrl).searchParams.get("token");
    if (token) path += `?token=${encodeURIComponent(token)}`;
  } catch {
    // signalingUrl not absolute/parseable - fall back to no token param
  }
  return path;
}

// See GlassClient.uploadFiles.
export async function uploadFiles(c: ClientCore, files: FileList | File[]): Promise<void> {
  const sessionId = sessionIdFromSignalingUrl(c.signalingUrl) ?? c.sessionId ?? "";
  let url = `${c.sessionBaseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/upload`;
  try {
    const token = new URL(c.signalingUrl).searchParams.get("token");
    if (token) url += `?token=${encodeURIComponent(token)}`;
  } catch {
    // signalingUrl not absolute/parseable - fall back to no token param
  }

  const form = new FormData();
  for (const file of Array.from(files)) {
    form.append("file", file, file.name);
  }

  const res = await fetch(url, { method: "POST", body: form });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`upload failed (${res.status}): ${text || res.statusText}`);
  }
}
