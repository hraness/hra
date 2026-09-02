/**
 * Bounded OpenType CFF outline reader for the social card.
 *
 * The public site renders its social card as a PNG at build time without a
 * native rasterizer. This module reads only what the card needs from the
 * vendored Nebula Sans OTF payloads: the character map, horizontal advances,
 * and Type 2 charstring outlines for a small set of code points. Every table
 * read is bounds-checked against the font buffer, and charstring execution is
 * bounded in depth, stack size, and operator count, so a malformed font fails
 * closed instead of looping or reading past the buffer.
 */

export type OutlineCommand =
  | Readonly<{ kind: "close" }>
  | Readonly<{ kind: "cubic"; x1: number; y1: number; x2: number; y2: number; x: number; y: number }>
  | Readonly<{ kind: "line"; x: number; y: number }>
  | Readonly<{ kind: "move"; x: number; y: number }>;

export interface GlyphOutline {
  /** Horizontal advance in font units. */
  readonly advance: number;
  /** Outline commands in font units with y pointing up. */
  readonly commands: readonly OutlineCommand[];
}

export interface OutlineFont {
  readonly ascender: number;
  readonly descender: number;
  readonly unitsPerEm: number;
  /** Returns the outline for one code point, or undefined when the font has no glyph for it. */
  glyph(codePoint: number): GlyphOutline | undefined;
}

export class SocialCardFontError extends Error {
  constructor(
    readonly code:
      | "CHARSTRING_BOUND"
      | "CHARSTRING_OPERATOR"
      | "FONT_BOUND"
      | "FONT_TABLE"
      | "FONT_UNSUPPORTED",
    detail: string,
  ) {
    super(`Social card font rejected: ${code} (${detail}).`);
    this.name = "SocialCardFontError";
  }
}

const MAX_FONT_BYTES = 4_000_000;
const MAX_TABLES = 64;
const MAX_INDEX_COUNT = 65_535;
const MAX_CMAP_SEGMENTS = 8_192;
const MAX_SUBROUTINE_DEPTH = 10;
const MAX_CHARSTRING_OPERATIONS = 20_000;
const MAX_OPERAND_STACK = 48;
const MAX_STEM_HINTS = 96;

class FontReader {
  private readonly view: DataView;

  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get length(): number {
    return this.bytes.byteLength;
  }

  private check(offset: number, size: number, what: string): void {
    if (!Number.isInteger(offset) || offset < 0 || offset + size > this.bytes.byteLength) {
      throw new SocialCardFontError("FONT_BOUND", what);
    }
  }

  u8(offset: number): number {
    this.check(offset, 1, "u8");
    return this.view.getUint8(offset);
  }

  u16(offset: number): number {
    this.check(offset, 2, "u16");
    return this.view.getUint16(offset);
  }

  i16(offset: number): number {
    this.check(offset, 2, "i16");
    return this.view.getInt16(offset);
  }

  u32(offset: number): number {
    this.check(offset, 4, "u32");
    return this.view.getUint32(offset);
  }

  i32(offset: number): number {
    this.check(offset, 4, "i32");
    return this.view.getInt32(offset);
  }

  tag(offset: number): string {
    this.check(offset, 4, "tag");
    return String.fromCharCode(
      this.view.getUint8(offset),
      this.view.getUint8(offset + 1),
      this.view.getUint8(offset + 2),
      this.view.getUint8(offset + 3),
    );
  }

  offsetOfSize(offset: number, size: number): number {
    this.check(offset, size, "offset");
    let value = 0;
    for (let index = 0; index < size; index += 1) {
      value = value * 256 + this.view.getUint8(offset + index);
    }
    return value;
  }

  slice(start: number, end: number, what: string): Uint8Array {
    if (end < start) throw new SocialCardFontError("FONT_BOUND", what);
    this.check(start, end - start, what);
    return this.bytes.subarray(start, end);
  }
}

interface TableRecord {
  readonly length: number;
  readonly offset: number;
}

const readTableDirectory = (reader: FontReader): ReadonlyMap<string, TableRecord> => {
  if (reader.tag(0) !== "OTTO") {
    throw new SocialCardFontError("FONT_UNSUPPORTED", "sfnt version");
  }
  const tableCount = reader.u16(4);
  if (tableCount === 0 || tableCount > MAX_TABLES) {
    throw new SocialCardFontError("FONT_TABLE", "table count");
  }
  const tables = new Map<string, TableRecord>();
  for (let index = 0; index < tableCount; index += 1) {
    const record = 12 + index * 16;
    const tag = reader.tag(record);
    const offset = reader.u32(record + 8);
    const length = reader.u32(record + 12);
    if (offset + length > reader.length) {
      throw new SocialCardFontError("FONT_BOUND", `table ${tag}`);
    }
    tables.set(tag, { length, offset });
  }
  return tables;
};

const requireTable = (tables: ReadonlyMap<string, TableRecord>, tag: string): TableRecord => {
  const table = tables.get(tag);
  if (table === undefined) throw new SocialCardFontError("FONT_TABLE", `missing ${tag}`);
  return table;
};

interface CffIndex {
  readonly end: number;
  readonly items: readonly Uint8Array[];
}

const readIndex = (reader: FontReader, start: number): CffIndex => {
  const count = reader.u16(start);
  if (count === 0) return { end: start + 2, items: [] };
  if (count > MAX_INDEX_COUNT) throw new SocialCardFontError("FONT_BOUND", "index count");
  const offsetSize = reader.u8(start + 2);
  if (offsetSize < 1 || offsetSize > 4) throw new SocialCardFontError("FONT_TABLE", "index offset size");
  const offsetArray = start + 3;
  const dataStart = offsetArray + (count + 1) * offsetSize - 1;
  const items: Uint8Array[] = [];
  let previous = reader.offsetOfSize(offsetArray, offsetSize);
  for (let index = 1; index <= count; index += 1) {
    const next = reader.offsetOfSize(offsetArray + index * offsetSize, offsetSize);
    if (next < previous) throw new SocialCardFontError("FONT_TABLE", "index order");
    items.push(reader.slice(dataStart + previous, dataStart + next, "index item"));
    previous = next;
  }
  return { end: dataStart + previous, items };
};

type DictOperands = ReadonlyMap<number, readonly number[]>;

const parseDict = (bytes: Uint8Array): DictOperands => {
  const reader = new FontReader(bytes);
  const entries = new Map<number, readonly number[]>();
  let operands: number[] = [];
  let index = 0;
  while (index < reader.length) {
    const b0 = reader.u8(index);
    if (b0 <= 21) {
      let operator = b0;
      index += 1;
      if (b0 === 12) {
        operator = 1200 + reader.u8(index);
        index += 1;
      }
      entries.set(operator, operands);
      operands = [];
    } else if (b0 === 28) {
      operands.push(reader.i16(index + 1));
      index += 3;
    } else if (b0 === 29) {
      operands.push(reader.i32(index + 1));
      index += 5;
    } else if (b0 === 30) {
      let text = "";
      index += 1;
      let finished = false;
      while (!finished) {
        const byte = reader.u8(index);
        index += 1;
        for (const nibble of [byte >> 4, byte & 15]) {
          if (nibble === 15) {
            finished = true;
            break;
          }
          if (nibble <= 9) text += String(nibble);
          else if (nibble === 10) text += ".";
          else if (nibble === 11) text += "E";
          else if (nibble === 12) text += "E-";
          else if (nibble === 14) text += "-";
        }
      }
      const value = Number(text);
      if (!Number.isFinite(value)) throw new SocialCardFontError("FONT_TABLE", "real operand");
      operands.push(value);
    } else if (b0 >= 32 && b0 <= 246) {
      operands.push(b0 - 139);
      index += 1;
    } else if (b0 >= 247 && b0 <= 250) {
      operands.push((b0 - 247) * 256 + reader.u8(index + 1) + 108);
      index += 2;
    } else if (b0 >= 251 && b0 <= 254) {
      operands.push(-(b0 - 251) * 256 - reader.u8(index + 1) - 108);
      index += 2;
    } else {
      throw new SocialCardFontError("FONT_TABLE", "dict byte");
    }
    if (operands.length > MAX_OPERAND_STACK) throw new SocialCardFontError("FONT_BOUND", "dict operands");
  }
  return entries;
};

const TOP_DICT_CHARSTRINGS = 17;
const TOP_DICT_PRIVATE = 18;
const TOP_DICT_ROS = 1230;
const TOP_DICT_CHARSTRING_TYPE = 1206;
const PRIVATE_DICT_SUBRS = 19;

const subroutineBias = (count: number): number =>
  count < 1240 ? 107 : count < 33_900 ? 1131 : 32_768;

const readCmapFormat4 = (reader: FontReader, table: TableRecord): ReadonlyMap<number, number> => {
  const base = table.offset;
  const subtableCount = reader.u16(base + 2);
  if (subtableCount === 0 || subtableCount > 32) throw new SocialCardFontError("FONT_TABLE", "cmap count");
  let subtable: number | undefined;
  for (let index = 0; index < subtableCount; index += 1) {
    const record = base + 4 + index * 8;
    const platform = reader.u16(record);
    const encoding = reader.u16(record + 2);
    const offset = reader.u32(record + 4);
    const candidate = base + offset;
    if (reader.u16(candidate) !== 4) continue;
    if ((platform === 3 && encoding === 1) || (platform === 0 && subtable === undefined)) {
      subtable = candidate;
    }
  }
  if (subtable === undefined) throw new SocialCardFontError("FONT_UNSUPPORTED", "cmap format");
  const segmentCount = reader.u16(subtable + 6) / 2;
  if (!Number.isInteger(segmentCount) || segmentCount === 0 || segmentCount > MAX_CMAP_SEGMENTS) {
    throw new SocialCardFontError("FONT_TABLE", "cmap segments");
  }
  const endCodes = subtable + 14;
  const startCodes = endCodes + segmentCount * 2 + 2;
  const idDeltas = startCodes + segmentCount * 2;
  const idRangeOffsets = idDeltas + segmentCount * 2;
  const mapping = new Map<number, number>();
  for (let segment = 0; segment < segmentCount; segment += 1) {
    const end = reader.u16(endCodes + segment * 2);
    const start = reader.u16(startCodes + segment * 2);
    const delta = reader.u16(idDeltas + segment * 2);
    const rangeOffsetAddress = idRangeOffsets + segment * 2;
    const rangeOffset = reader.u16(rangeOffsetAddress);
    if (start > end) throw new SocialCardFontError("FONT_TABLE", "cmap segment order");
    if (start === 0xffff) continue;
    for (let code = start; code <= end && code !== 0xffff; code += 1) {
      let glyphId: number;
      if (rangeOffset === 0) {
        glyphId = (code + delta) & 0xffff;
      } else {
        const glyphAddress = rangeOffsetAddress + rangeOffset + (code - start) * 2;
        const raw = reader.u16(glyphAddress);
        glyphId = raw === 0 ? 0 : (raw + delta) & 0xffff;
      }
      if (glyphId !== 0 && !mapping.has(code)) mapping.set(code, glyphId);
    }
  }
  return mapping;
};

interface CharstringContext {
  readonly charstrings: readonly Uint8Array[];
  readonly globalSubrs: readonly Uint8Array[];
  readonly localSubrs: readonly Uint8Array[];
}

class CharstringInterpreter {
  private readonly commands: OutlineCommand[] = [];
  private readonly stack: number[] = [];
  private readonly transient: number[] = new Array<number>(32).fill(0);
  private x = 0;
  private y = 0;
  private stemHints = 0;
  private widthParsed = false;
  private open = false;
  private operations = 0;

  constructor(private readonly context: CharstringContext) {}

  run(charstring: Uint8Array): readonly OutlineCommand[] {
    this.execute(charstring, 0);
    this.closePath();
    return this.commands;
  }

  private moveTo(x: number, y: number): void {
    this.closePath();
    this.commands.push({ kind: "move", x, y });
    this.open = true;
  }

  private lineTo(x: number, y: number): void {
    if (!this.open) this.moveTo(this.x, this.y);
    this.commands.push({ kind: "line", x, y });
  }

  private curveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): void {
    if (!this.open) this.moveTo(this.x, this.y);
    this.commands.push({ kind: "cubic", x1, y1, x2, y2, x, y });
  }

  private closePath(): void {
    if (this.open) {
      this.commands.push({ kind: "close" });
      this.open = false;
    }
  }

  private takeWidth(evenArguments: number): void {
    if (this.widthParsed) return;
    this.widthParsed = true;
    if (this.stack.length % 2 === 1 && evenArguments === 0) this.stack.shift();
    else if (evenArguments > 0 && this.stack.length > evenArguments) this.stack.shift();
  }

  private countStems(): void {
    this.takeWidth(0);
    this.stemHints += Math.floor(this.stack.length / 2);
    if (this.stemHints > MAX_STEM_HINTS) throw new SocialCardFontError("CHARSTRING_BOUND", "stem hints");
    this.stack.length = 0;
  }

  private at(index: number): number {
    const value = this.stack[index];
    if (value === undefined) throw new SocialCardFontError("CHARSTRING_OPERATOR", "operand");
    return value;
  }

  private rrcurveto(): void {
    let index = 0;
    while (index + 6 <= this.stack.length) {
      const x1 = this.x + this.at(index);
      const y1 = this.y + this.at(index + 1);
      const x2 = x1 + this.at(index + 2);
      const y2 = y1 + this.at(index + 3);
      this.x = x2 + this.at(index + 4);
      this.y = y2 + this.at(index + 5);
      this.curveTo(x1, y1, x2, y2, this.x, this.y);
      index += 6;
    }
    this.stack.length = 0;
  }

  private alternatingCurves(horizontalFirst: boolean): void {
    let horizontal = horizontalFirst;
    let index = 0;
    while (index + 4 <= this.stack.length) {
      const last = index + 8 > this.stack.length;
      const tail = last && index + 5 === this.stack.length ? this.at(index + 4) : 0;
      let x1: number;
      let y1: number;
      if (horizontal) {
        x1 = this.x + this.at(index);
        y1 = this.y;
      } else {
        x1 = this.x;
        y1 = this.y + this.at(index);
      }
      const x2 = x1 + this.at(index + 1);
      const y2 = y1 + this.at(index + 2);
      if (horizontal) {
        this.y = y2 + this.at(index + 3);
        this.x = x2 + tail;
      } else {
        this.x = x2 + this.at(index + 3);
        this.y = y2 + tail;
      }
      this.curveTo(x1, y1, x2, y2, this.x, this.y);
      horizontal = !horizontal;
      index += 4;
    }
    this.stack.length = 0;
  }

  private alternatingLines(horizontalFirst: boolean): void {
    let horizontal = horizontalFirst;
    for (let index = 0; index < this.stack.length; index += 1) {
      if (horizontal) this.x += this.at(index);
      else this.y += this.at(index);
      this.lineTo(this.x, this.y);
      horizontal = !horizontal;
    }
    this.stack.length = 0;
  }

  /** Runs one subroutine; returns true when it reached endchar. */
  private callSubroutine(subroutines: readonly Uint8Array[], depth: number): boolean {
    const indexOperand = this.stack.pop();
    if (indexOperand === undefined) throw new SocialCardFontError("CHARSTRING_OPERATOR", "subr index");
    const subroutine = subroutines[indexOperand + subroutineBias(subroutines.length)];
    if (subroutine === undefined) throw new SocialCardFontError("CHARSTRING_BOUND", "subr range");
    if (depth + 1 > MAX_SUBROUTINE_DEPTH) throw new SocialCardFontError("CHARSTRING_BOUND", "subr depth");
    return this.execute(subroutine, depth + 1);
  }

  /** Executes one charstring; returns true when endchar ended it. */
  private execute(charstring: Uint8Array, depth: number): boolean {
    const reader = new FontReader(charstring);
    let index = 0;
    while (index < reader.length) {
      this.operations += 1;
      if (this.operations > MAX_CHARSTRING_OPERATIONS) {
        throw new SocialCardFontError("CHARSTRING_BOUND", "operation count");
      }
      const b0 = reader.u8(index);
      index += 1;
      if (b0 >= 32 || b0 === 28) {
        let value: number;
        if (b0 === 28) {
          value = reader.i16(index);
          index += 2;
        } else if (b0 <= 246) {
          value = b0 - 139;
        } else if (b0 <= 250) {
          value = (b0 - 247) * 256 + reader.u8(index) + 108;
          index += 1;
        } else if (b0 <= 254) {
          value = -(b0 - 251) * 256 - reader.u8(index) - 108;
          index += 1;
        } else {
          value = reader.i32(index) / 65_536;
          index += 4;
        }
        this.stack.push(value);
        if (this.stack.length > MAX_OPERAND_STACK) {
          throw new SocialCardFontError("CHARSTRING_BOUND", "operand stack");
        }
        continue;
      }
      switch (b0) {
        case 1:
        case 3:
        case 18:
        case 23:
          this.countStems();
          break;
        case 19:
        case 20:
          this.countStems();
          index += Math.ceil(this.stemHints / 8);
          break;
        case 21:
          this.takeWidth(2);
          this.x += this.at(0);
          this.y += this.at(1);
          this.moveTo(this.x, this.y);
          this.stack.length = 0;
          break;
        case 22:
          this.takeWidth(1);
          this.x += this.at(0);
          this.moveTo(this.x, this.y);
          this.stack.length = 0;
          break;
        case 4:
          this.takeWidth(1);
          this.y += this.at(0);
          this.moveTo(this.x, this.y);
          this.stack.length = 0;
          break;
        case 5:
          for (let position = 0; position + 2 <= this.stack.length; position += 2) {
            this.x += this.at(position);
            this.y += this.at(position + 1);
            this.lineTo(this.x, this.y);
          }
          this.stack.length = 0;
          break;
        case 6:
          this.alternatingLines(true);
          break;
        case 7:
          this.alternatingLines(false);
          break;
        case 8:
          this.rrcurveto();
          break;
        case 24: {
          let position = 0;
          while (position + 6 <= this.stack.length - 2) {
            const x1 = this.x + this.at(position);
            const y1 = this.y + this.at(position + 1);
            const x2 = x1 + this.at(position + 2);
            const y2 = y1 + this.at(position + 3);
            this.x = x2 + this.at(position + 4);
            this.y = y2 + this.at(position + 5);
            this.curveTo(x1, y1, x2, y2, this.x, this.y);
            position += 6;
          }
          this.x += this.at(position);
          this.y += this.at(position + 1);
          this.lineTo(this.x, this.y);
          this.stack.length = 0;
          break;
        }
        case 25: {
          let position = 0;
          while (position + 2 <= this.stack.length - 6) {
            this.x += this.at(position);
            this.y += this.at(position + 1);
            this.lineTo(this.x, this.y);
            position += 2;
          }
          const x1 = this.x + this.at(position);
          const y1 = this.y + this.at(position + 1);
          const x2 = x1 + this.at(position + 2);
          const y2 = y1 + this.at(position + 3);
          this.x = x2 + this.at(position + 4);
          this.y = y2 + this.at(position + 5);
          this.curveTo(x1, y1, x2, y2, this.x, this.y);
          this.stack.length = 0;
          break;
        }
        case 26:
        case 27: {
          const vertical = b0 === 26;
          let position = 0;
          let firstDelta = 0;
          if (this.stack.length % 4 === 1) {
            firstDelta = this.at(0);
            position = 1;
          }
          while (position + 4 <= this.stack.length) {
            const x1 = this.x + (vertical ? firstDelta : this.at(position));
            const y1 = this.y + (vertical ? this.at(position) : firstDelta);
            const x2 = x1 + this.at(position + 1);
            const y2 = y1 + this.at(position + 2);
            if (vertical) {
              this.x = x2;
              this.y = y2 + this.at(position + 3);
            } else {
              this.x = x2 + this.at(position + 3);
              this.y = y2;
            }
            this.curveTo(x1, y1, x2, y2, this.x, this.y);
            firstDelta = 0;
            position += 4;
          }
          this.stack.length = 0;
          break;
        }
        case 30:
          this.alternatingCurves(false);
          break;
        case 31:
          this.alternatingCurves(true);
          break;
        case 10:
          if (this.callSubroutine(this.context.localSubrs, depth)) return true;
          break;
        case 29:
          if (this.callSubroutine(this.context.globalSubrs, depth)) return true;
          break;
        case 11:
          return false;
        case 14:
          this.takeWidth(0);
          if (this.stack.length >= 4) {
            throw new SocialCardFontError("FONT_UNSUPPORTED", "seac accent composition");
          }
          this.closePath();
          return true;
        case 12: {
          const b1 = reader.u8(index);
          index += 1;
          if (b1 === 35) {
            this.flex();
          } else if (b1 === 34) {
            this.hflex();
          } else if (b1 === 36) {
            this.hflex1();
          } else if (b1 === 37) {
            this.flex1();
          } else {
            throw new SocialCardFontError("CHARSTRING_OPERATOR", `escape ${b1}`);
          }
          this.stack.length = 0;
          break;
        }
        default:
          throw new SocialCardFontError("CHARSTRING_OPERATOR", `operator ${b0}`);
      }
    }
    return false;
  }

  private flex(): void {
    if (this.stack.length < 13) throw new SocialCardFontError("CHARSTRING_OPERATOR", "flex");
    for (let curve = 0; curve < 2; curve += 1) {
      const base = curve * 6;
      const x1 = this.x + this.at(base);
      const y1 = this.y + this.at(base + 1);
      const x2 = x1 + this.at(base + 2);
      const y2 = y1 + this.at(base + 3);
      this.x = x2 + this.at(base + 4);
      this.y = y2 + this.at(base + 5);
      this.curveTo(x1, y1, x2, y2, this.x, this.y);
    }
  }

  private hflex(): void {
    if (this.stack.length < 7) throw new SocialCardFontError("CHARSTRING_OPERATOR", "hflex");
    const startY = this.y;
    const x1 = this.x + this.at(0);
    const y1 = this.y;
    const x2 = x1 + this.at(1);
    const y2 = y1 + this.at(2);
    const x3 = x2 + this.at(3);
    const y3 = y2;
    this.curveTo(x1, y1, x2, y2, x3, y3);
    const x4 = x3 + this.at(4);
    const y4 = y2;
    const x5 = x4 + this.at(5);
    const y5 = startY;
    this.x = x5 + this.at(6);
    this.y = startY;
    this.curveTo(x4, y4, x5, y5, this.x, this.y);
  }

  private hflex1(): void {
    if (this.stack.length < 9) throw new SocialCardFontError("CHARSTRING_OPERATOR", "hflex1");
    const startY = this.y;
    const x1 = this.x + this.at(0);
    const y1 = this.y + this.at(1);
    const x2 = x1 + this.at(2);
    const y2 = y1 + this.at(3);
    const x3 = x2 + this.at(4);
    const y3 = y2;
    this.curveTo(x1, y1, x2, y2, x3, y3);
    const x4 = x3 + this.at(5);
    const y4 = y2;
    const x5 = x4 + this.at(6);
    const y5 = y4 + this.at(7);
    this.x = x5 + this.at(8);
    this.y = startY;
    this.curveTo(x4, y4, x5, y5, this.x, this.y);
  }

  private flex1(): void {
    if (this.stack.length < 11) throw new SocialCardFontError("CHARSTRING_OPERATOR", "flex1");
    const startX = this.x;
    const startY = this.y;
    let dx = 0;
    let dy = 0;
    for (let position = 0; position < 10; position += 2) {
      dx += this.at(position);
      dy += this.at(position + 1);
    }
    const x1 = this.x + this.at(0);
    const y1 = this.y + this.at(1);
    const x2 = x1 + this.at(2);
    const y2 = y1 + this.at(3);
    const x3 = x2 + this.at(4);
    const y3 = y2 + this.at(5);
    this.curveTo(x1, y1, x2, y2, x3, y3);
    const x4 = x3 + this.at(6);
    const y4 = y3 + this.at(7);
    const x5 = x4 + this.at(8);
    const y5 = y4 + this.at(9);
    if (Math.abs(dx) > Math.abs(dy)) {
      this.x = x5 + this.at(10);
      this.y = startY;
    } else {
      this.x = startX;
      this.y = y5 + this.at(10);
    }
    this.curveTo(x4, y4, x5, y5, this.x, this.y);
  }
}

/**
 * Parses a CFF-flavoured OpenType font (an `OTTO` file with a non-CID `CFF `
 * table and a format 4 Unicode cmap) into a bounded outline reader.
 */
export const parseOpenTypeOutlineFont = (data: ArrayBuffer | Uint8Array): OutlineFont => {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength < 12 || bytes.byteLength > MAX_FONT_BYTES) {
    throw new SocialCardFontError("FONT_BOUND", "font size");
  }
  const reader = new FontReader(bytes);
  const tables = readTableDirectory(reader);
  const head = requireTable(tables, "head");
  const hhea = requireTable(tables, "hhea");
  const hmtx = requireTable(tables, "hmtx");
  const maxp = requireTable(tables, "maxp");
  const cff = requireTable(tables, "CFF ");

  const unitsPerEm = reader.u16(head.offset + 18);
  if (unitsPerEm < 16 || unitsPerEm > 16_384) throw new SocialCardFontError("FONT_TABLE", "unitsPerEm");
  const ascender = reader.i16(hhea.offset + 4);
  const descender = reader.i16(hhea.offset + 6);
  const horizontalMetricCount = reader.u16(hhea.offset + 34);
  const glyphCount = reader.u16(maxp.offset + 4);
  if (horizontalMetricCount === 0 || horizontalMetricCount > glyphCount) {
    throw new SocialCardFontError("FONT_TABLE", "hmtx count");
  }

  const cmap = readCmapFormat4(reader, requireTable(tables, "cmap"));

  const headerSize = reader.u8(cff.offset + 2);
  const nameIndex = readIndex(reader, cff.offset + headerSize);
  const topDictIndex = readIndex(reader, nameIndex.end);
  const stringIndex = readIndex(reader, topDictIndex.end);
  const globalSubrIndex = readIndex(reader, stringIndex.end);
  const topDictBytes = topDictIndex.items[0];
  if (topDictBytes === undefined) throw new SocialCardFontError("FONT_TABLE", "top dict");
  const topDict = parseDict(topDictBytes);
  if (topDict.has(TOP_DICT_ROS)) throw new SocialCardFontError("FONT_UNSUPPORTED", "CID-keyed CFF");
  const charstringType = topDict.get(TOP_DICT_CHARSTRING_TYPE)?.[0] ?? 2;
  if (charstringType !== 2) throw new SocialCardFontError("FONT_UNSUPPORTED", "charstring type");
  const charstringsOffset = topDict.get(TOP_DICT_CHARSTRINGS)?.[0];
  if (charstringsOffset === undefined) throw new SocialCardFontError("FONT_TABLE", "charstrings offset");
  const charstrings = readIndex(reader, cff.offset + charstringsOffset).items;
  if (charstrings.length !== glyphCount) throw new SocialCardFontError("FONT_TABLE", "glyph count");

  const privateEntry = topDict.get(TOP_DICT_PRIVATE);
  let localSubrs: readonly Uint8Array[] = [];
  if (privateEntry !== undefined) {
    const [privateSize, privateOffset] = privateEntry;
    if (privateSize === undefined || privateOffset === undefined) {
      throw new SocialCardFontError("FONT_TABLE", "private dict");
    }
    const privateStart = cff.offset + privateOffset;
    const privateDict = parseDict(reader.slice(privateStart, privateStart + privateSize, "private dict"));
    const subrsOffset = privateDict.get(PRIVATE_DICT_SUBRS)?.[0];
    if (subrsOffset !== undefined) {
      localSubrs = readIndex(reader, privateStart + subrsOffset).items;
    }
  }

  const context: CharstringContext = {
    charstrings,
    globalSubrs: globalSubrIndex.items,
    localSubrs,
  };
  const cache = new Map<number, GlyphOutline | undefined>();

  const advanceOf = (glyphId: number): number => {
    const metricIndex = Math.min(glyphId, horizontalMetricCount - 1);
    return reader.u16(hmtx.offset + metricIndex * 4);
  };

  return {
    ascender,
    descender,
    unitsPerEm,
    glyph(codePoint: number): GlyphOutline | undefined {
      if (cache.has(codePoint)) return cache.get(codePoint);
      const glyphId = cmap.get(codePoint);
      let outline: GlyphOutline | undefined;
      if (glyphId !== undefined) {
        const charstring = charstrings[glyphId];
        if (charstring === undefined) throw new SocialCardFontError("FONT_BOUND", "glyph id");
        outline = {
          advance: advanceOf(glyphId),
          commands: new CharstringInterpreter(context).run(charstring),
        };
      }
      cache.set(codePoint, outline);
      return outline;
    },
  };
};
