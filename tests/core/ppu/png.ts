// Decodificador PNG mínimo para las imágenes de referencia (sin dependencias: zlib de
// Node). Soporta PNG no entrelazados de 8 bits RGB/RGBA/gris y con paleta de 1-8 bits.
import { inflateSync } from "node:zlib";

export interface Image { width: number; height: number; rgba: Uint8Array }

export function decodePng(buf: Uint8Array): Image {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 8;
  let width = 0, height = 0, depth = 0, ctype = 0;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  while (p < buf.length) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(...buf.subarray(p + 4, p + 8));
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") {
      width = dv.getUint32(p + 8); height = dv.getUint32(p + 12);
      depth = data[8]!; ctype = data[9]!;
      if (data[12] !== 0) throw new Error("PNG entrelazado no soportado");
    } else if (type === "PLTE") palette = data;
    else if (type === "tRNS") trns = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const chans = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[ctype];
  if (!chans) throw new Error(`tipo de color ${ctype} no soportado`);
  if (ctype !== 3 && depth !== 8) throw new Error(`profundidad ${depth} no soportada`);
  const bpp = Math.max(1, (chans * depth) >> 3);
  const stride = Math.ceil((width * chans * depth) / 8);
  const lines = new Uint8Array(stride * height);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]!;
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = lines.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp]! : 0, b = prev[i]!, c = i >= bpp ? prev[i - bpp]! : 0;
      let v = src[i]!;
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 0xff;
    }
    prev = cur;
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = lines.subarray(y * stride);
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (ctype === 3) {
        const bit = x * depth;
        const idx = (row[bit >> 3]! >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
        rgba[o] = palette![idx * 3]!; rgba[o + 1] = palette![idx * 3 + 1]!; rgba[o + 2] = palette![idx * 3 + 2]!;
        rgba[o + 3] = trns && idx < trns.length ? trns[idx]! : 255;
      } else if (ctype === 0 || ctype === 4) {
        const g = row[x * chans]!;
        rgba[o] = rgba[o + 1] = rgba[o + 2] = g;
        rgba[o + 3] = ctype === 4 ? row[x * chans + 1]! : 255;
      } else {
        rgba[o] = row[x * chans]!; rgba[o + 1] = row[x * chans + 1]!; rgba[o + 2] = row[x * chans + 2]!;
        rgba[o + 3] = ctype === 6 ? row[x * chans + 3]! : 255;
      }
    }
  }
  return { width, height, rgba };
}
