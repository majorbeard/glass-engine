// Stats polling, the internal trace report, input latency reports and
// pixel-trace samples. See GlassClient (index.ts) for the public API.

import type { ClientCore } from "./core";
import * as transport from "./transport";
import { INPUT_LATENCY_REPORT_MS } from "./internal";
import type { GlassStats } from "./types";
import { receiverWindow } from "./input_latency";
import type { ReceiverCounters, InputLatencyStats } from "./input_latency";

// See GlassClient.reportPixelTraceSamples.
export function reportPixelTraceSamples(c: ClientCore, samples: { rtpTimestamp: number; paintedAtMs: number }[]): void {
  transport.sendInput(c, "pixel_trace_sample", { samples });
}

// See GlassClient.notePresentedFrame.
export function notePresentedFrame(c: ClientCore, rtpTimestamp: number, expectedDisplayTime: number): void {
  const done = c.inputLatency.onPresentedFrame(rtpTimestamp, expectedDisplayTime);
  for (const sample of done) c.emit("inputLatency", sample);
  const now = performance.now();
  if (now - c.lastInputLatencyReportAt >= INPUT_LATENCY_REPORT_MS) {
    const report = c.inputLatency.takeReport();
    if (report.length > 0) {
      c.lastInputLatencyReportAt = now;
      void sendInputLatencyReport(c, 
        report.map((r) => ({ k: r.kind, ms: Math.round(r.ms * 10) / 10, c: r.continuous }))
      );
    }
  }
}

// Sends the samples with what the receiver did since the last report
// ("rx", see receiverWindow) and the current round-trip time ("rtt", ms),
// each left out when getStats() doesn't provide it.
export async function sendInputLatencyReport(c: ClientCore, samples: { k: string; ms: number; c: boolean }[]): Promise<void> {
  const data: Record<string, unknown> = { samples };
  const raw = await collectRawStats(c);
  const v = raw?.inboundVideo;
  if (v) {
    const cur: ReceiverCounters = {
      at: performance.now(),
      jitterBufferDelay: v.jitterBufferDelay,
      jitterBufferEmittedCount: v.jitterBufferEmittedCount,
      totalDecodeTime: v.totalDecodeTime,
      framesDecoded: v.framesDecoded,
      framesDropped: v.framesDropped,
    };
    if (c.lastReceiverCounters) {
      const rx = receiverWindow(c.lastReceiverCounters, cur);
      if (Object.keys(rx).length > 0) data.rx = rx;
    }
    c.lastReceiverCounters = cur;
  }
  const rtt = raw?.candidatePair?.currentRoundTripTime;
  if (typeof rtt === "number") data.rtt = Math.round(rtt * 1000);
  transport.sendInput(c, "input_latency_report", data);
}

// See GlassClient.inputLatencyStats.
export function inputLatencyStats(c: ClientCore): InputLatencyStats {
  return c.inputLatency.stats();
}

// --- Stats ---
export function startStatsPollingIfEnabled(c: ClientCore): void {
  if (c.statsIntervalMs <= 0 || c.statsTimer !== null) return;
  c.statsTimer = setInterval(async () => {
    const stats = await getStats(c);
    if (stats) c.emit("stats", stats);
  }, c.statsIntervalMs);
}

// Internal-only (see traceReportIntervalMs' own doc comment). Mirrors
// startStatsPollingIfEnabled's shape exactly, on its own independent
// timer/interval - the two features are unrelated (one emits a public
// event for the embedding app, this one reports to the backend) and
// shouldn't be coupled just because they both poll getStats()-derived
// data.
export function startInternalTraceReportingIfEnabled(c: ClientCore): void {
  if (c.traceReportIntervalMs <= 0 || c.traceReportTimer !== null)
    return;
  c.traceReportTimer = setInterval(() => {
    void collectAndSendTraceReport(c);
  }, c.traceReportIntervalMs);
}

// Pulls real getStats()-derived numbers (via the same collectRawStats
// helper getStats() itself uses - see its doc comment) and reports them
// to the backend over the existing reliable DataChannel via sendInput,
// promoting a one-off test technique to permanent product code. windowMs is the
// real elapsed time since the last report (not always exactly
// traceReportIntervalMs - the backend needs the real window to compute
// rates, not an assumed one). No public event, no return value - this is
// purely a one-way diagnostic report to the backend, not part of the
// client's own observable API surface.
export async function collectAndSendTraceReport(c: ClientCore): Promise<void> {
  const raw = await collectRawStats(c);
  if (!raw) return;
  const { candidatePair, inboundVideo } = raw;

  const now = Date.now();
  const windowMs = c.lastTraceReportAt
    ? now - c.lastTraceReportAt
    : c.traceReportIntervalMs;
  c.lastTraceReportAt = now;

  transport.sendInput(c, "client_stats_report", {
    windowMs,
    framesDecoded: inboundVideo?.framesDecoded ?? null,
    // keyFramesDecoded: real RTCInboundRtpStreamStats field, compared
    // server-side against the engine's own keyframes-sent
    // count (a real, confirmed corruption investigation where every
    // server-side check came back clean).
    keyFramesDecoded: inboundVideo?.keyFramesDecoded ?? null,
    framesDropped: inboundVideo?.framesDropped ?? null,
    packetsReceived: inboundVideo?.packetsReceived ?? null,
    packetsLost: inboundVideo?.packetsLost ?? null,
    jitter: inboundVideo?.jitter ?? null,
    currentRoundTripTimeMs:
      candidatePair && typeof candidatePair.currentRoundTripTime === "number"
        ? candidatePair.currentRoundTripTime * 1000
        : null,
    bytesReceived: candidatePair?.bytesReceived ?? null,
  });
}

// Walks one raw RTCStatsReport and pulls out the two reports every
// consumer here actually needs (the nominated candidate pair, the video
// inbound-rtp report) - shared by getStats() and the internal trace
// reporter (collectAndSendTraceReport) so there's exactly one place that
// knows how to find these, not two independent parsers that could drift
// apart. Returns null on a getStats() failure (e.g. pc already closed).
export async function collectRawStats(c: ClientCore): Promise<{
  candidatePair: any;
  inboundVideo: any;
} | null> {
  const pc = c.pc;
  if (!pc) return null;
  let candidatePair: any = null;
  let inboundVideo: any = null;
  try {
    const report = await pc.getStats();
    report.forEach((stat: any) => {
      if (
        stat.type === "candidate-pair" &&
        stat.state === "succeeded" &&
        (stat.nominated ?? true)
      ) {
        candidatePair = stat;
      } else if (stat.type === "inbound-rtp" && stat.kind === "video") {
        inboundVideo = stat;
      }
    });
  } catch {
    return null;
  }
  return { candidatePair, inboundVideo };
}

// See GlassClient.getStats.
export async function getStats(c: ClientCore): Promise<GlassStats | null> {
  const raw = await collectRawStats(c);
  if (!raw) return null;
  const { candidatePair, inboundVideo } = raw;

  const now = Date.now();
  let throughputKbps: number | null = null;
  if (candidatePair && typeof candidatePair.bytesReceived === "number") {
    if (c.lastStatsSample) {
      const dtSec = (now - c.lastStatsSample.time) / 1000;
      const deltaBytes =
        candidatePair.bytesReceived - c.lastStatsSample.bytesReceived;
      throughputKbps = dtSec > 0 ? (deltaBytes * 8) / 1000 / dtSec : null;
    }
    c.lastStatsSample = {
      time: now,
      bytesReceived: candidatePair.bytesReceived,
    };
  }

  let jitterBufferMs: number | null = null;
  if (
    inboundVideo &&
    typeof inboundVideo.jitterBufferDelay === "number" &&
    typeof inboundVideo.jitterBufferEmittedCount === "number"
  ) {
    if (c.lastJitterSample) {
      const deltaDelaySec =
        inboundVideo.jitterBufferDelay - c.lastJitterSample.delaySec;
      const deltaEmitted =
        inboundVideo.jitterBufferEmittedCount -
        c.lastJitterSample.emittedCount;
      if (deltaEmitted > 0) {
        jitterBufferMs = (deltaDelaySec / deltaEmitted) * 1000;
      }
    }
    c.lastJitterSample = {
      delaySec: inboundVideo.jitterBufferDelay,
      emittedCount: inboundVideo.jitterBufferEmittedCount,
    };
  }

  return {
    rttMs:
      candidatePair && typeof candidatePair.currentRoundTripTime === "number"
        ? candidatePair.currentRoundTripTime * 1000
        : null,
    throughputKbps,
    availableOutgoingBitrateKbps:
      candidatePair &&
      typeof candidatePair.availableOutgoingBitrate === "number"
        ? candidatePair.availableOutgoingBitrate / 1000
        : null,
    jitterBufferMs,
    framesDecoded: inboundVideo?.framesDecoded ?? null,
    framesDropped: inboundVideo?.framesDropped ?? null,
    dataChannelBufferedAmount: c.dataChannel?.bufferedAmount ?? null,
  };
}
