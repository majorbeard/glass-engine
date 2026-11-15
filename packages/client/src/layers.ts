// Layers on demand, the producer's side: with simulcast, GlassProducer starts with only its
// full-size encoding on, reports once a second what it has (its uplink estimate and each
// encoding's name, size and state), and turns encodings on and off when Glass sends
// layers_wanted. A server that never asks leaves the full encoding alone, a single stream.

/** How often the producer reports its layers to Glass. */
export const LAYER_REPORT_INTERVAL_MS = 1000;

/**
 * Turns a simulcast sender's encodings on and off, one setParameters call at a time (a
 * browser refuses a second call while one is under way), and reports its layers.
 */
export class LayerControl {
  private queue: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;
  /** The sender's preference before a second layer was turned on, given back when one remains. */
  private ownPreference: RTCDegradationPreference | undefined;

  constructor(
    private readonly pc: RTCPeerConnection,
    private readonly sender: RTCRtpSender,
    private readonly track: MediaStreamTrack,
    private readonly send: (message: object) => void
  ) {}

  /** Runs fn after every earlier call on this sender has finished. */
  run(fn: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(fn, fn).catch(() => undefined);
    return this.queue;
  }

  /** Starts the reports; a second call (the connection came back) changes nothing. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.report(), LAYER_REPORT_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Sends only the encodings named. With more than one on, the sender keeps its picture size
   * ("maintain-resolution"): a browser that has shrunk a lone encoding's input otherwise
   * keeps fewer layers than asked, dropping the full one. One again, and its own preference
   * comes back.
   */
  apply(rids: string[]): Promise<void> {
    return this.run(async () => {
      const params = this.sender.getParameters();
      const encodings = params.encodings ?? [];
      if (!encodings.some((e) => e.rid && rids.includes(e.rid))) return; // nothing of ours: keep what is sent
      for (const e of encodings) if (e.rid) e.active = rids.includes(e.rid);
      if (this.ownPreference === undefined) this.ownPreference = params.degradationPreference ?? "maintain-framerate";
      params.degradationPreference = encodings.filter((e) => e.active !== false).length > 1 ? "maintain-resolution" : this.ownPreference;
      try {
        await this.sender.setParameters(params);
      } catch {
        // Refused (the connection is closing, or the browser can't): the next ask tries again.
      }
    });
  }

  /** The report: the browser's own uplink estimate, and each encoding, smallest first. */
  async report(): Promise<void> {
    let uplinkKbps = 0;
    const sizes = new Map<string, { width: number; height: number }>();
    try {
      (await this.pc.getStats()).forEach((s: any) => {
        if (s.type === "candidate-pair" && s.nominated && s.state === "succeeded" && typeof s.availableOutgoingBitrate === "number") {
          uplinkKbps = Math.round(s.availableOutgoingBitrate / 1000);
        } else if (s.type === "outbound-rtp" && s.kind === "video" && s.rid && s.frameWidth && s.frameHeight) {
          sizes.set(s.rid, { width: s.frameWidth, height: s.frameHeight });
        }
      });
    } catch {
      return; // a closing connection: no report this time
    }
    const settings = this.track.getSettings?.() ?? {};
    const layers = (this.sender.getParameters().encodings ?? [])
      .filter((e) => e.rid)
      .map((e) => {
        const scale = Math.max(e.scaleResolutionDownBy ?? 1, 1);
        // A layer that is off has no sending size: the size it would have, from the camera's.
        const size = sizes.get(e.rid!) ?? {
          width: Math.round((settings.width ?? 0) / scale),
          height: Math.round((settings.height ?? 0) / scale),
        };
        return { rid: e.rid!, active: e.active !== false, width: size.width, height: size.height, scale };
      })
      .sort((a, b) => b.scale - a.scale)
      .map(({ scale: _scale, ...l }) => l);
    if (layers.length > 0) this.send({ type: "producer_report", uplinkKbps, layers });
  }
}
