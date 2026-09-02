/**
 * Deterministic software rasterizer and PNG encoder for the social card.
 *
 * The card is a small composition of filled rectangles and glyph outlines, so
 * a scanline polygon filler with vertical supersampling and exact horizontal
 * span coverage is enough for clean anti-aliased text. Everything here is pure
 * arithmetic over typed arrays plus `node:zlib`, which Bun ships, so the build
 * needs no native image dependency.
 */

import { crc32, deflateSync } from "node:zlib";

import type { OutlineCommand, OutlineFont } from "./social-card-font.ts";

export type Rgb = readonly [red: number, green: number, blue: number];

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** One closed polygon in device pixels. */
export type Polygon = readonly Point[];

const SUBSAMPLES_PER_PIXEL = 5;
const CURVE_SEGMENTS = 12;
const MAX_CANVAS_PIXELS = 4_000_000;
const MAX_POLYGON_POINTS = 200_000;

export class SocialCardRasterError extends Error {
  constructor(readonly code: "CANVAS_BOUND" | "GLYPH_MISSING" | "POLYGON_BOUND", detail: string) {
    super(`Social card raster rejected: ${code} (${detail}).`);
    this.name = "SocialCardRasterError";
  }
}

const clampChannel = (value: number): number =>
  Math.max(0, Math.min(255, Math.round(value)));

export const parseHexColor = (hex: string): Rgb => {
  const match = /^#([0-9a-f]{6})$/iu.exec(hex);
  if (match?.[1] === undefined) {
    throw new SocialCardRasterError("CANVAS_BOUND", "color format");
  }
  const value = Number.parseInt(match[1], 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
};

interface Edge {
  readonly direction: 1 | -1;
  readonly x0: number;
  readonly x1: number;
  readonly yBottom: number;
  readonly yTop: number;
}

const edgesOf = (polygons: readonly Polygon[]): readonly Edge[] => {
  const edges: Edge[] = [];
  let points = 0;
  for (const polygon of polygons) {
    points += polygon.length;
    if (points > MAX_POLYGON_POINTS) throw new SocialCardRasterError("POLYGON_BOUND", "point count");
    for (let index = 0; index < polygon.length; index += 1) {
      const start = polygon[index];
      const end = polygon[(index + 1) % polygon.length];
      if (start === undefined || end === undefined || start.y === end.y) continue;
      if (start.y < end.y) {
        edges.push({ direction: 1, x0: start.x, x1: end.x, yBottom: end.y, yTop: start.y });
      } else {
        edges.push({ direction: -1, x0: end.x, x1: start.x, yBottom: start.y, yTop: end.y });
      }
    }
  }
  return edges;
};

export class Canvas {
  readonly pixels: Uint8ClampedArray;

  constructor(readonly width: number, readonly height: number, background: Rgb) {
    if (
      !Number.isInteger(width) || !Number.isInteger(height)
      || width <= 0 || height <= 0 || width * height > MAX_CANVAS_PIXELS
    ) {
      throw new SocialCardRasterError("CANVAS_BOUND", "canvas size");
    }
    this.pixels = new Uint8ClampedArray(width * height * 3);
    for (let index = 0; index < this.pixels.length; index += 3) {
      this.pixels[index] = background[0];
      this.pixels[index + 1] = background[1];
      this.pixels[index + 2] = background[2];
    }
  }

  private blend(x: number, y: number, color: Rgb, coverage: number): void {
    if (coverage <= 0 || x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const alpha = Math.min(1, coverage);
    const offset = (y * this.width + x) * 3;
    for (let channel = 0; channel < 3; channel += 1) {
      const existing = this.pixels[offset + channel] ?? 0;
      const target = color[channel] ?? 0;
      this.pixels[offset + channel] = clampChannel(existing + (target - existing) * alpha);
    }
  }

  /** Fills polygons with the nonzero winding rule and anti-aliased edges. */
  fillPolygons(polygons: readonly Polygon[], color: Rgb): void {
    const edges = edgesOf(polygons);
    if (edges.length === 0) return;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    for (const edge of edges) {
      minY = Math.min(minY, edge.yTop);
      maxY = Math.max(maxY, edge.yBottom);
      minX = Math.min(minX, edge.x0, edge.x1);
      maxX = Math.max(maxX, edge.x0, edge.x1);
    }
    const rowStart = Math.max(0, Math.floor(minY));
    const rowEnd = Math.min(this.height - 1, Math.ceil(maxY));
    const columnStart = Math.max(0, Math.floor(minX));
    const columnEnd = Math.min(this.width - 1, Math.ceil(maxX));
    if (rowEnd < rowStart || columnEnd < columnStart) return;
    const columns = columnEnd - columnStart + 1;
    const coverage = new Float64Array(columns);
    const crossings: { x: number; direction: number }[] = [];
    const sampleWeight = 1 / SUBSAMPLES_PER_PIXEL;

    for (let row = rowStart; row <= rowEnd; row += 1) {
      coverage.fill(0);
      let touched = false;
      for (let sample = 0; sample < SUBSAMPLES_PER_PIXEL; sample += 1) {
        const sampleY = row + (sample + 0.5) * sampleWeight;
        crossings.length = 0;
        for (const edge of edges) {
          if (sampleY < edge.yTop || sampleY >= edge.yBottom) continue;
          const t = (sampleY - edge.yTop) / (edge.yBottom - edge.yTop);
          crossings.push({ direction: edge.direction, x: edge.x0 + (edge.x1 - edge.x0) * t });
        }
        if (crossings.length < 2) continue;
        crossings.sort((left, right) => left.x - right.x);
        let winding = 0;
        for (let index = 0; index < crossings.length - 1; index += 1) {
          const crossing = crossings[index];
          const next = crossings[index + 1];
          if (crossing === undefined || next === undefined) break;
          winding += crossing.direction;
          if (winding === 0) continue;
          const spanStart = Math.max(crossing.x, columnStart);
          const spanEnd = Math.min(next.x, columnEnd + 1);
          if (spanEnd <= spanStart) continue;
          touched = true;
          const firstColumn = Math.floor(spanStart);
          const lastColumn = Math.min(columnEnd, Math.ceil(spanEnd) - 1);
          for (let column = firstColumn; column <= lastColumn; column += 1) {
            const overlap = Math.min(spanEnd, column + 1) - Math.max(spanStart, column);
            if (overlap > 0) {
              const slot = column - columnStart;
              coverage[slot] = (coverage[slot] ?? 0) + overlap * sampleWeight;
            }
          }
        }
      }
      if (!touched) continue;
      for (let slot = 0; slot < columns; slot += 1) {
        const value = coverage[slot] ?? 0;
        if (value > 0) this.blend(columnStart + slot, row, color, value);
      }
    }
  }

  fillRect(x: number, y: number, width: number, height: number, color: Rgb): void {
    this.fillPolygons([[
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height },
    ]], color);
  }

  fillRoundedRect(x: number, y: number, width: number, height: number, radius: number, color: Rgb): void {
    const r = Math.max(0, Math.min(radius, width / 2, height / 2));
    const points: Point[] = [];
    const corner = (cx: number, cy: number, startAngle: number): void => {
      for (let step = 0; step <= CURVE_SEGMENTS; step += 1) {
        const angle = startAngle + (Math.PI / 2) * (step / CURVE_SEGMENTS);
        points.push({ x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
      }
    };
    corner(x + width - r, y + r, -Math.PI / 2);
    corner(x + width - r, y + height - r, 0);
    corner(x + r, y + height - r, Math.PI / 2);
    corner(x + r, y + r, Math.PI);
    this.fillPolygons([points], color);
  }

  toRgbBytes(): Uint8Array {
    return new Uint8Array(this.pixels.buffer, this.pixels.byteOffset, this.pixels.byteLength);
  }
}

const flattenOutline = (
  commands: readonly OutlineCommand[],
  scale: number,
  originX: number,
  baselineY: number,
): readonly Polygon[] => {
  const polygons: Point[][] = [];
  let current: Point[] = [];
  let last: Point = { x: 0, y: 0 };
  const place = (x: number, y: number): Point => ({ x: originX + x * scale, y: baselineY - y * scale });
  for (const command of commands) {
    switch (command.kind) {
      case "move":
        if (current.length > 2) polygons.push(current);
        current = [];
        last = place(command.x, command.y);
        current.push(last);
        break;
      case "line":
        last = place(command.x, command.y);
        current.push(last);
        break;
      case "cubic": {
        const start = last;
        const control1 = place(command.x1, command.y1);
        const control2 = place(command.x2, command.y2);
        const end = place(command.x, command.y);
        for (let step = 1; step <= CURVE_SEGMENTS; step += 1) {
          const t = step / CURVE_SEGMENTS;
          const mt = 1 - t;
          const a = mt * mt * mt;
          const b = 3 * mt * mt * t;
          const c = 3 * mt * t * t;
          const d = t * t * t;
          current.push({
            x: a * start.x + b * control1.x + c * control2.x + d * end.x,
            y: a * start.y + b * control1.y + c * control2.y + d * end.y,
          });
        }
        last = end;
        break;
      }
      case "close":
        if (current.length > 2) polygons.push(current);
        current = [];
        break;
    }
  }
  if (current.length > 2) polygons.push(current);
  return polygons;
};

const codePointsOf = (text: string): readonly number[] =>
  Array.from(text, (character) => {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) throw new SocialCardRasterError("GLYPH_MISSING", "empty character");
    return codePoint;
  });

/** Measures the advance width of `text` at `fontSize` device pixels. */
export const measureText = (font: OutlineFont, text: string, fontSize: number): number => {
  const scale = fontSize / font.unitsPerEm;
  let width = 0;
  for (const codePoint of codePointsOf(text)) {
    const glyph = font.glyph(codePoint);
    if (glyph === undefined) {
      throw new SocialCardRasterError("GLYPH_MISSING", `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`);
    }
    width += glyph.advance * scale;
  }
  return width;
};

/** Draws `text` with its left edge at `x` and its baseline at `baselineY`. */
export const drawText = (
  canvas: Canvas,
  font: OutlineFont,
  text: string,
  x: number,
  baselineY: number,
  fontSize: number,
  color: Rgb,
): number => {
  const scale = fontSize / font.unitsPerEm;
  let penX = x;
  for (const codePoint of codePointsOf(text)) {
    const glyph = font.glyph(codePoint);
    if (glyph === undefined) {
      throw new SocialCardRasterError("GLYPH_MISSING", `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`);
    }
    if (glyph.commands.length > 0) {
      canvas.fillPolygons(flattenOutline(glyph.commands, scale, penX, baselineY), color);
    }
    penX += glyph.advance * scale;
  }
  return penX;
};

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const pngChunk = (type: string, data: Uint8Array): Uint8Array => {
  const typeBytes = new TextEncoder().encode(type);
  const chunk = new Uint8Array(12 + data.byteLength);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.byteLength);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  const crcInput = new Uint8Array(4 + data.byteLength);
  crcInput.set(typeBytes, 0);
  crcInput.set(data, 4);
  view.setUint32(8 + data.byteLength, crc32(crcInput) >>> 0);
  return chunk;
};

/** Encodes 8-bit RGB pixels as a non-interlaced PNG with filter type 0 rows. */
export const encodePng = (width: number, height: number, rgb: Uint8Array): Uint8Array => {
  if (rgb.byteLength !== width * height * 3) {
    throw new SocialCardRasterError("CANVAS_BOUND", "pixel buffer length");
  }
  const stride = width * 3;
  const raw = new Uint8Array((stride + 1) * height);
  for (let row = 0; row < height; row += 1) {
    raw[row * (stride + 1)] = 0;
    raw.set(rgb.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1);
  }
  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width);
  headerView.setUint32(4, height);
  header[8] = 8;
  header[9] = 2;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  const compressed = new Uint8Array(deflateSync(raw, { level: 9 }));
  const chunks = [
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const png = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    png.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return png;
};

/** Reads the width and height from a PNG header; used by tests and the build check. */
export const readPngDimensions = (png: Uint8Array): { readonly height: number; readonly width: number } => {
  if (png.byteLength < 24) throw new SocialCardRasterError("CANVAS_BOUND", "png header");
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (png[index] !== PNG_SIGNATURE[index]) throw new SocialCardRasterError("CANVAS_BOUND", "png signature");
  }
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  if (view.getUint32(8) !== 13 || new TextDecoder().decode(png.subarray(12, 16)) !== "IHDR") {
    throw new SocialCardRasterError("CANVAS_BOUND", "png ihdr");
  }
  return { height: view.getUint32(20), width: view.getUint32(16) };
};
