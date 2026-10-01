// Pure SDP helpers for GlassProducer (producer.ts), free of DOM and WebRTC types
// so sdp.test.ts can exercise them directly.

/**
 * withStartBitrate adds Chromium's `x-google-start-bitrate=<kbps>` to the video codecs' fmtp lines in
 * the ANSWER SDP. Chrome's sender starts probing from a low default bitrate and takes several seconds
 * to ramp; on a weak uplink the ramp overshoots the link and bloats the router's queue. The start
 * hint is read from the REMOTE description's fmtp parameters (the sender honours what the answer
 * suggests). Best-effort and Chromium-specific: any other stack ignores an unknown fmtp parameter.
 *
 * Only H264 and VP8 payload types inside the m=video section get the parameter, and a payload type
 * that already carries one is left alone. RTX/RED/FEC entries are never touched.
 */
export function withStartBitrate(sdp: string, startKbps: number): string {
  if (!(startKbps > 0)) return sdp;
  const eol = sdp.includes("\r\n") ? "\r\n" : "\n";
  const lines = sdp.split(/\r?\n/);
  const out: string[] = [];
  let inVideo = false;
  const wanted = new Set<string>();

  // Pass 1: which payload types in m=video are H264/VP8 (from their rtpmap lines).
  for (const line of lines) {
    if (line.startsWith("m=")) inVideo = line.startsWith("m=video");
    else if (inVideo) {
      const m = /^a=rtpmap:(\d+) ([A-Za-z0-9-]+)\//.exec(line);
      if (m?.[1] && m[2] && /^(h264|vp8)$/i.test(m[2])) wanted.add(m[1]);
    }
  }

  // Pass 2: append the parameter to those payload types' fmtp lines.
  inVideo = false;
  for (const line of lines) {
    if (line.startsWith("m=")) inVideo = line.startsWith("m=video");
    if (inVideo) {
      const m = /^a=fmtp:(\d+) (.*)$/.exec(line);
      if (m?.[1] && m[2] !== undefined && wanted.has(m[1]) && !/x-google-start-bitrate=/.test(m[2])) {
        out.push(`${line};x-google-start-bitrate=${Math.round(startKbps)}`);
        continue;
      }
    }
    out.push(line);
  }
  return out.join(eol);
}
