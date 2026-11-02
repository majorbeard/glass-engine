import type { ClientCore } from "./core";

// The repair wait: on a long, lossy path, let the browser hold video for
// about one round trip, so a packet resent after a loss arrives before its
// frame is due, instead of the picture freezing for that round trip.
//
// The browser's receiver already waits for a resend on its own, but at most
// 200 ms, so past a round trip of about 220 ms every lost packet freezes the
// picture. Once the round trip is over 200 ms and the viewer has asked for
// a resend 3 times within 60 s, this sets the receiver's jitterBufferTarget
// (a minimum delay) to the round trip plus 30 ms, and sets it back to 0
// after 60 s without a resend request: the same counts the browser uses for
// its own wait. On a short or loss-free path it never engages.
//
// The cost is delay while engaged. An application that wants the lowest
// delay over a smooth picture turns it off (GlassClientOptions.repairWait).

const MIN_RTT_MS = 200;
const NACKS_TO_ENGAGE = 3;
const WINDOW_MS = 60_000;
const MARGIN_MS = 30;
// The browser refuses a jitterBufferTarget above 4 s.
const MAX_TARGET_MS = 4000;
const POLL_MS = 1000;

// RepairWaitPolicy decides the target from what the receiver reports. Kept
// apart from the timer and the receiver so it can be tested on its own.
export class RepairWaitPolicy {
  private nackAt: number[] = [];
  private lastNackCount: number | null = null;
  private rttMs: number | null = null;
  target = 0;

  // update takes one poll's numbers and returns the new target in ms when it
  // changes, or null when it stays. nackCount is the receiver's running
  // total; rttMs the latest round trip it knows, or null.
  update(nowMs: number, nackCount: number, rttMs: number | null): number | null {
    if (this.lastNackCount !== null) {
      for (let i = this.lastNackCount; i < nackCount; i++) this.nackAt.push(nowMs);
    }
    this.lastNackCount = nackCount;
    while (this.nackAt.length > 0 && nowMs - this.nackAt[0]! > WINDOW_MS) this.nackAt.shift();
    if (rttMs !== null) this.rttMs = rttMs;

    let want = 0;
    if (this.rttMs !== null && this.rttMs > MIN_RTT_MS && this.nackAt.length >= NACKS_TO_ENGAGE) {
      want = Math.min(MAX_TARGET_MS, Math.round(this.rttMs + MARGIN_MS));
    }
    // A change of the round trip by 10% or less keeps the target, so the
    // receiver is not re-aimed every second.
    const changed = want === 0 ? this.target !== 0 : Math.abs(want - this.target) > this.target * 0.1;
    if (!changed) return null;
    this.target = want;
    return want;
  }
}

// playoutDelayHint is Chromium's older name for the same hint.
type TargetedReceiver = RTCRtpReceiver & { playoutDelayHint?: number };

export function setReceiverTarget(receiver: TargetedReceiver, ms: number): void {
  try {
    receiver.playoutDelayHint = ms / 1000;
    receiver.jitterBufferTarget = ms;
  } catch {
    // A browser without these receiver hints: nothing to set.
  }
}

// startRepairWait polls the video receiver once a second while the
// connection lives. stopRepairWait (on teardown) ends it.
export function startRepairWait(c: ClientCore, receiver: RTCRtpReceiver): void {
  stopRepairWait(c);
  const policy = new RepairWaitPolicy();
  let busy = false;
  c.repairWaitTimer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const report = await receiver.getStats();
      let nack: number | null = null;
      let rtt: number | null = null;
      report.forEach((r) => {
        if (r.type === "inbound-rtp") nack = r.nackCount ?? 0;
        if (r.type === "remote-outbound-rtp" && r.roundTripTime) rtt = r.roundTripTime * 1000;
      });
      if (nack === null) return;
      const target = policy.update(performance.now(), nack, rtt);
      if (target !== null) setReceiverTarget(receiver, target);
    } catch {
      // getStats on a closing connection: skip this poll.
    } finally {
      busy = false;
    }
  }, POLL_MS);
}

export function stopRepairWait(c: ClientCore): void {
  if (c.repairWaitTimer !== null) {
    clearInterval(c.repairWaitTimer);
    c.repairWaitTimer = null;
  }
}
