// @internal Live decode-vs-compositor readback comparison - draws every
// decoded video frame (via requestVideoFrameCallback + canvas.drawImage)
// into a small on-screen canvas, alongside the real <video> element's own
// on-screen (compositor-painted) output. Built to answer round 1's still-
// open question in a video-corruption investigation: when visible corruption appears, is it already present in what
// the decoder produced, or does it only appear in the composited on-screen
// <video> element? canvas.drawImage() on a <video> element forces a
// texture readback of the actual current decoded frame - a different code
// path from Chrome's normal video-element compositing - so if the canvas
// and the on-screen video ever visibly diverge, that's decisive: the
// corruption is presentation-only, not decode.
//
// Deliberately dumb and manual (no automated pixel-diffing) - a human
// watching two adjacent panes is the actual diagnostic here, matching this
// whole investigation's established "human eyes are the ground truth"
// pattern for confirming/denying corruption (screenshots/automated checks
// have repeatedly proven insufficient on their own throughout this
// investigation).

export class DecodeReadbackOverlay {
  private readonly video: HTMLVideoElement;
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private handle: number | null = null;
  private running = false;

  constructor(video: HTMLVideoElement) {
    this.video = video;
    this.canvas = document.createElement("canvas");
    const ctx = this.canvas.getContext("2d");
    if (!ctx) {
      throw new Error("DecodeReadbackOverlay: 2D canvas context unavailable");
    }
    this.ctx = ctx;
  }

  static supported(video: HTMLVideoElement): boolean {
    return typeof video.requestVideoFrameCallback === "function";
  }

  start(): void {
    if (this.running || !DecodeReadbackOverlay.supported(this.video)) return;
    this.running = true;
    this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    if (this.handle !== null) {
      this.video.cancelVideoFrameCallback(this.handle);
      this.handle = null;
    }
  }

  private scheduleNext(): void {
    if (!this.running) return;
    this.handle = this.video.requestVideoFrameCallback(() => {
      this.handle = null;
      this.draw();
      this.scheduleNext();
    });
  }

  // Resizes the canvas to match the video's real decoded dimensions only
  // when they change (not every frame) - avoids clearing/reallocating the
  // canvas backing store on every single draw for no reason.
  private draw(): void {
    const w = this.video.videoWidth;
    const h = this.video.videoHeight;
    if (w === 0 || h === 0) return;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.ctx.drawImage(this.video, 0, 0, w, h);
  }
}
