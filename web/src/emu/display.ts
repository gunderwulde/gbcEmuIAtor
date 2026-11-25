// Pinta el framebuffer RGBA del núcleo en un canvas de 160×144; el escalado lo hace CSS
// (image-rendering: pixelated), así que cada frame es un único putImageData.
import { FB_H, FB_W } from "./core";

export class Display {
  private ctx: CanvasRenderingContext2D;
  private img: ImageData;

  constructor(readonly canvas: HTMLCanvasElement) {
    canvas.width = FB_W;
    canvas.height = FB_H;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("canvas 2D no disponible");
    this.ctx = ctx;
    this.img = ctx.createImageData(FB_W, FB_H);
    this.clear();
  }

  draw(rgba: Uint8ClampedArray): void {
    this.img.data.set(rgba);
    this.ctx.putImageData(this.img, 0, 0);
  }

  clear(): void {
    this.ctx.fillStyle = "#000";
    this.ctx.fillRect(0, 0, FB_W, FB_H);
  }
}
