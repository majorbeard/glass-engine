// Publishing on the client's one connection (protocol v3): each track a
// person publishes is a send-only line, announced with "publish" before the
// offer that carries it, and becomes a source of the session. See
// GlassClient.publish (index.ts) for the public API.

import type { ClientCore } from "./core";
import { Emitter } from "./emitter.js";
import { LayerControl } from "./layers";

/** What a published track is to the session. */
export type GlassPublishKind = "camera" | "microphone" | "screen" | "device";

export interface GlassPublishOptions {
  kind: GlassPublishKind;
  // A camera or screen sent as up to three layers (simulcast: a quarter, a
  // half and the full size), on a session made with simulcast. Glass turns
  // each on as a viewer needs it; the full one alone to begin with.
  simulcast?: boolean;
  // The full layer's highest bitrate, kbit/s; 0 for the browser's own.
  // Default 1000: a higher cap made Chrome's simulcast collapse to one layer
  // on a squeezed uplink.
  maxBitrateKbps?: number;
  // The rate the browser's congestion control starts from, kbit/s. Default
  // the lower of 500 and maxBitrateKbps.
  startBitrateKbps?: number;
}

export type GlassPublicationEvents = {
  // Glass did not take the track: `invalid`, `not_allowed` (the link may not
  // publish this kind) or `codec_mismatch`. The publication has ended.
  refused: [reason: string];
  // The layers Glass asks for now, by rid, simulcast only.
  layers: [rids: string[]];
  // A published microphone carried nothing but silence when it was
  // published: a muted or broken device, or an audio source whose clock has
  // stopped. The session's members would hear nothing. Checked once, at
  // publish, as LiveKit's SDK checks a local microphone.
  silent: [];
};

const DEFAULT_MAX_BITRATE_KBPS = 1000;

/** One track this client publishes. stop() unpublishes it. */
export class GlassPublication extends Emitter<GlassPublicationEvents> {
  /** @internal The line it is on, on the current peer connection. */
  sender: RTCRtpSender | null = null;
  /** @internal */
  layerControl: LayerControl | null = null;
  /** @internal Whether "publish" was sent for the current line. */
  announced = false;
  readonly maxBitrateKbps: number;
  readonly startBitrateKbps: number;

  /** @internal */
  constructor(
    private readonly c: ClientCore,
    readonly track: MediaStreamTrack,
    readonly options: GlassPublishOptions,
  ) {
    super();
    this.maxBitrateKbps = options.maxBitrateKbps ?? DEFAULT_MAX_BITRATE_KBPS;
    this.startBitrateKbps = options.startBitrateKbps ?? Math.min(500, this.maxBitrateKbps > 0 ? this.maxBitrateKbps : 500);
  }

  /** @internal Fires one of the publication's events, for this module. */
  notify<K extends keyof GlassPublicationEvents>(event: K, ...args: GlassPublicationEvents[K]): void {
    this.emit(event, ...args);
  }

  get kind(): GlassPublishKind {
    return this.options.kind;
  }

  // The line's mid on the current connection: null before it is negotiated.
  mid(): string | null {
    const pc = this.c.pc;
    if (!pc || !this.sender) return null;
    return pc.getTransceivers().find((t) => t.sender === this.sender)?.mid ?? null;
  }

  // Unpublishes: Glass removes the source, and the line sends nothing more.
  // The track is the application's, left running.
  stop(): void {
    unpublish(this.c, this);
  }

  // The sender's own WebRTC statistics report, as the browser gives it: its
  // outbound streams (one per simulcast layer), what the far end reports of
  // them, the media source and the candidate pair. Null with no connection.
  async getStatsReport(): Promise<RTCStatsReport | null> {
    if (!this.sender) return null;
    try {
      return await this.sender.getStats();
    } catch {
      return null;
    }
  }

  // The sender's own statistics: bytes and packets sent, and for a picture
  // the frames encoded and the size sent. Null with no connection.
  async getStats(): Promise<{ bytesSent: number; packetsSent: number; framesEncoded?: number; width?: number; height?: number } | null> {
    if (!this.sender) return null;
    let out: { bytesSent: number; packetsSent: number; framesEncoded?: number; width?: number; height?: number } | null = null;
    try {
      (await this.sender.getStats()).forEach((s: any) => {
        if (s.type !== "outbound-rtp") return;
        out ??= { bytesSent: 0, packetsSent: 0 };
        out.bytesSent += s.bytesSent ?? 0;
        out.packetsSent += s.packetsSent ?? 0;
        if (typeof s.framesEncoded === "number") out.framesEncoded = (out.framesEncoded ?? 0) + s.framesEncoded;
        if (s.frameWidth && (out.width ?? 0) < s.frameWidth) {
          out.width = s.frameWidth;
          out.height = s.frameHeight;
        }
      });
    } catch {
      return null;
    }
    return out;
  }
}

/**
 * The encodings of a published picture: one, or with simulcast (a camera
 * height given) the layers that height takes, smallest first. The cap goes on
 * the full-size one.
 */
export function sendEncodings(simulcastHeight: number | undefined, maxKbps: number): RTCRtpEncodingParameters[] {
  const layers: { rid?: string; scale: number }[] =
    simulcastHeight === undefined || simulcastHeight < 360
      ? [{ scale: 1 }]
      : simulcastHeight < 540
        ? [{ rid: "h", scale: 2 }, { rid: "f", scale: 1 }]
        : [{ rid: "q", scale: 4 }, { rid: "h", scale: 2 }, { rid: "f", scale: 1 }];
  return layers.map((l) => {
    const e: RTCRtpEncodingParameters = { maxFramerate: 30 };
    if (l.rid) {
      e.rid = l.rid;
      e.scaleResolutionDownBy = l.scale;
    }
    if (l.scale === 1 && maxKbps > 0) e.maxBitrate = Math.round(maxKbps * 1000);
    return e;
  });
}

// attach puts a publication on the current peer connection: on publish(), and
// again on each reconnect's new connection.
export function attach(c: ClientCore, pub: GlassPublication): void {
  const pc = c.pc;
  if (!pc) return;
  pub.announced = false;
  const isPicture = pub.track.kind === "video";
  const stream = new MediaStream([pub.track]);
  let transceiver: RTCRtpTransceiver;
  if (isPicture) {
    // Layers only into a session that takes them: one that doesn't declines
    // simulcast, and a browser then sends just its first, smallest encoding.
    const layered = pub.options.simulcast && c.sessionSimulcast;
    const encodings = sendEncodings(layered ? pub.track.getSettings?.().height : undefined, pub.maxBitrateKbps);
    // With simulcast, the full-size layer alone to begin with: Glass asks for
    // a smaller one when a viewer needs it and the uplink has room.
    if (encodings.length > 1) for (const e of encodings) e.active = !(e.scaleResolutionDownBy && e.scaleResolutionDownBy > 1);
    try {
      transceiver = pc.addTransceiver(pub.track, { direction: "sendonly", streams: [stream], sendEncodings: encodings });
    } catch {
      // No sendEncodings: the cap is applied once connected.
      transceiver = pc.addTransceiver(pub.track, { direction: "sendonly", streams: [stream] });
    }
    pub.layerControl = encodings.length > 1 ? new LayerControl(pc, transceiver.sender, pub.track, (m) => sendSignal(c, { ...m, mid: pub.mid() ?? undefined })) : null;
  } else {
    transceiver = pc.addTransceiver(pub.track, { direction: "sendonly", streams: [stream] });
    pub.layerControl = null;
  }
  pub.sender = transceiver.sender;
}

// announce sends "publish" for each line not yet announced: before the offer
// that carries it, as Glass takes a line as a source only so.
export function announce(c: ClientCore): void {
  for (const pub of c.publications) {
    if (pub.announced) continue;
    const mid = pub.mid();
    if (!mid) continue;
    sendSignal(c, { type: "publish", mid, kind: pub.kind });
    pub.announced = true;
  }
}

// onConnected applies each picture's bitrate cap and starts its layer reports.
export function onConnected(c: ClientCore): void {
  for (const pub of c.publications) {
    if (!pub.sender || pub.track.kind !== "video") continue;
    const sender = pub.sender;
    if (pub.layerControl) {
      void pub.layerControl.run(() => applyBitrateCap(sender, pub.maxBitrateKbps));
      pub.layerControl.start();
    } else {
      void applyBitrateCap(sender, pub.maxBitrateKbps);
    }
  }
}

// detachAll forgets each publication's line, with the connection going.
export function detachAll(c: ClientCore): void {
  for (const pub of c.publications) {
    pub.layerControl?.stop();
    pub.layerControl = null;
    pub.sender = null;
    pub.announced = false;
  }
}

export function onLayersWanted(c: ClientCore, mid: string | undefined, rids: string[]): void {
  const pub = c.publications.find((p) => p.layerControl && (mid === undefined || p.mid() === mid));
  if (!pub?.layerControl) return;
  void pub.layerControl.apply(rids);
  pub.notify("layers", rids);
}

export function onRefused(c: ClientCore, mid: string, reason: string): void {
  const pub = c.publications.find((p) => p.mid() === mid);
  if (!pub) return;
  drop(c, pub);
  pub.notify("refused", reason);
}

export function unpublish(c: ClientCore, pub: GlassPublication): void {
  if (!c.publications.includes(pub)) return;
  const mid = pub.mid();
  if (mid) sendSignal(c, { type: "unpublish", mid });
  drop(c, pub);
}

function drop(c: ClientCore, pub: GlassPublication): void {
  c.publications = c.publications.filter((p) => p !== pub);
  pub.layerControl?.stop();
  pub.layerControl = null;
  const pc = c.pc;
  const t = pc && pub.sender ? pc.getTransceivers().find((x) => x.sender === pub.sender) : undefined;
  if (t) {
    try {
      void pub.sender?.replaceTrack(null);
      t.direction = "inactive";
    } catch {
      // A closing connection: nothing left to stop.
    }
  }
  pub.sender = null;
}

function sendSignal(c: ClientCore, msg: object): void {
  if (c.ws && c.signalingConnected) c.ws.send(JSON.stringify(msg));
}

/** Caps a picture's full-size encoding; see GlassPublishOptions.maxBitrateKbps. */
async function applyBitrateCap(sender: RTCRtpSender, maxKbps: number): Promise<void> {
  if (!(maxKbps > 0)) return;
  try {
    const params = sender.getParameters();
    const encodings = params.encodings?.length ? params.encodings : [{}];
    const full = encodings.findIndex((e) => !(e.scaleResolutionDownBy && e.scaleResolutionDownBy > 1));
    encodings[full < 0 ? encodings.length - 1 : full]!.maxBitrate = Math.round(maxKbps * 1000);
    params.encodings = encodings;
    await sender.setParameters(params);
  } catch {
    // Best effort: sendEncodings already carried the cap where supported.
  }
}

// The silence check, as LiveKit's SDK makes it: one 200 ms look at a
// track through a Web Audio analyser. Silent when every sample sits at the
// midpoint or at zero. A context that will not run reads nothing, so it is
// not taken for silence.
const SILENCE_LOOK_MS = 200;

export async function isSilent(track: MediaStreamTrack): Promise<boolean> {
  if (typeof AudioContext === "undefined") return false;
  let ctx: AudioContext | null = null;
  try {
    ctx = new AudioContext({ latencyHint: "interactive" });
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    const src = ctx.createMediaStreamSource(new MediaStream([track]));
    src.connect(analyser);
    if (ctx.state !== "running") {
      await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, SILENCE_LOOK_MS))]);
      // resume() may have changed it: read it afresh.
      if ((ctx.state as AudioContextState) !== "running") return false;
    }
    await new Promise((r) => setTimeout(r, SILENCE_LOOK_MS));
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteTimeDomainData(data);
    src.disconnect();
    return !data.some((x) => x !== 128 && x !== 0);
  } catch {
    return false;
  } finally {
    void ctx?.close().catch(() => undefined);
  }
}

// checkForSilence tells a microphone's publication if it is silent.
export function checkForSilence(pub: GlassPublication): void {
  if (pub.track.kind !== "audio") return;
  void isSilent(pub.track).then((silent) => {
    if (silent) pub.notify("silent");
  });
}
