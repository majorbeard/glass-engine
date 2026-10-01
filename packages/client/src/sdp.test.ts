import { expect, test } from "vitest";
import { withStartBitrate } from "./sdp";

const ANSWER = [
  "v=0",
  "o=- 1 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "a=rtpmap:111 opus/48000/2",
  "a=fmtp:111 minptime=10;useinbandfec=1",
  "m=video 9 UDP/TLS/RTP/SAVPF 106 107 108",
  "a=rtpmap:106 H264/90000",
  "a=fmtp:106 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
  "a=rtpmap:107 rtx/90000",
  "a=fmtp:107 apt=106",
  "a=rtpmap:108 VP8/90000",
  "",
].join("\r\n");

test("adds the start bitrate to H264 (and VP8) fmtp lines in m=video only", () => {
  const out = withStartBitrate(ANSWER, 500);
  expect(out).toMatch(/a=fmtp:106 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f;x-google-start-bitrate=500\r\n/);
});

test("never touches audio, RTX or non-video sections", () => {
  const out = withStartBitrate(ANSWER, 500);
  expect(out).toMatch(/a=fmtp:111 minptime=10;useinbandfec=1\r\n/);
  expect(out).toMatch(/a=fmtp:107 apt=106\r\n/);
  expect((out.match(/x-google-start-bitrate/g) ?? []).length).toBe(1);
});

test("is idempotent and keeps the line-ending style", () => {
  const once = withStartBitrate(ANSWER, 500);
  expect(withStartBitrate(once, 500)).toBe(once);
  expect(once.includes("\r\n") && !/[^\r]\n/.test(once)).toBe(true);
  const lf = ANSWER.replace(/\r\n/g, "\n");
  expect(!withStartBitrate(lf, 500).includes("\r")).toBe(true);
});

test("a non-positive start bitrate returns the SDP unchanged", () => {
  expect(withStartBitrate(ANSWER, 0)).toBe(ANSWER);
  expect(withStartBitrate(ANSWER, -5)).toBe(ANSWER);
});

test("an SDP with no video section is returned unchanged", () => {
  const audioOnly = ["v=0", "m=audio 9 UDP/TLS/RTP/SAVPF 111", "a=rtpmap:111 opus/48000/2", "a=fmtp:111 minptime=10", ""].join("\r\n");
  expect(withStartBitrate(audioOnly, 500)).toBe(audioOnly);
});
