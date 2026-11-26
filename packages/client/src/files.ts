// A source's downloads and uploads. See GlassSource (source.ts) for the public API.

import type { ClientCore } from "./core";
import { errorDetail, linkParts } from "./internal";

// sourceRoute is a route of one source of the session this client joined,
// with the link's own token: a link reaches its source's downloads and
// uploads while its connection holds the source's input track.
function sourceRoute(c: ClientCore, src: string, rest: string): string {
  const parts = linkParts(c.link);
  const id = encodeURIComponent(parts?.sessionId ?? "");
  let url = `${c.engineOrigin}/v1/sessions/${id}/sources/${encodeURIComponent(src)}/${rest}`;
  if (parts?.token) url += `?token=${encodeURIComponent(parts.token)}`;
  return url;
}

export function downloadUrl(c: ClientCore, src: string, guid: string): string {
  return sourceRoute(c, src, `downloads/${encodeURIComponent(guid)}`);
}

export async function uploadFiles(c: ClientCore, src: string, files: FileList | File[]): Promise<void> {
  const form = new FormData();
  for (const file of Array.from(files)) {
    form.append("file", file, file.name);
  }
  const res = await fetch(sourceRoute(c, src, "upload"), { method: "POST", body: form });
  if (!res.ok) {
    throw new Error(`upload failed (${res.status}): ${await errorDetail(res)}`);
  }
}
