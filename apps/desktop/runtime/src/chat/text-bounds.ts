import type { ChatUtf8Tail } from "./types";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

export function utf8Chunks(value: string, maximumBytes: number): readonly string[] {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error("UTF-8 chunk limit must be a positive safe integer");
  }
  if (value.length === 0) return Object.freeze([]);
  if (value.includes("\0")) throw new Error("UTF-8 chunks cannot contain NUL");
  const chunks: string[] = [];
  let chunk = "";
  let chunkBytes = 0;
  for (const character of value) {
    const characterBytes = codePointUtf8Bytes(character.codePointAt(0) ?? 0);
    if (characterBytes > maximumBytes) {
      throw new Error("UTF-8 chunk limit cannot contain one code point");
    }
    if (chunkBytes + characterBytes > maximumBytes) {
      chunks.push(chunk);
      chunk = "";
      chunkBytes = 0;
    }
    chunk += character;
    chunkBytes += characterBytes;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return Object.freeze(chunks);
}

export function assertBoundedUtf8(
  value: string,
  minimumBytes: number,
  maximumBytes: number,
  label: string,
): number {
  if (value.includes("\0")) throw new Error(`${label} cannot contain NUL`);
  const bytes = utf8ByteLength(value);
  if (bytes < minimumBytes || bytes > maximumBytes) {
    throw new Error(`${label} must contain ${String(minimumBytes)}..${String(maximumBytes)} UTF-8 bytes`);
  }
  return bytes;
}

export function utf8Tail(value: string, maximumBytes: number): string {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new Error("UTF-8 tail limit must be a nonnegative safe integer");
  }
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= maximumBytes) return value;
  let start = bytes.byteLength - maximumBytes;
  while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return decoder.decode(bytes.subarray(start));
}

export function initialUtf8Tail(value: string, maximumBytes: number): ChatUtf8Tail {
  const totalUtf8Bytes = utf8ByteLength(value);
  const tail = utf8Tail(value, maximumBytes);
  return {
    tail,
    totalUtf8Bytes,
    truncatedPrefix: utf8ByteLength(tail) < totalUtf8Bytes,
  };
}

export function appendUtf8Tail(
  previous: ChatUtf8Tail,
  delta: string,
  maximumBytes: number,
): ChatUtf8Tail {
  const deltaBytes = utf8ByteLength(delta);
  if (previous.totalUtf8Bytes > Number.MAX_SAFE_INTEGER - deltaBytes) {
    throw new Error("UTF-8 stream byte count exceeded the safe integer range");
  }
  const totalUtf8Bytes = previous.totalUtf8Bytes + deltaBytes;
  const tail = utf8Tail(`${previous.tail}${delta}`, maximumBytes);
  return {
    tail,
    totalUtf8Bytes,
    truncatedPrefix: utf8ByteLength(tail) < totalUtf8Bytes,
  };
}

export function boundedCharacters(value: string, maximumCharacters: number): string {
  if (!Number.isSafeInteger(maximumCharacters) || maximumCharacters < 1) {
    throw new Error("Character limit must be a positive safe integer");
  }
  if (value.length <= maximumCharacters) return value;
  const truncated = value.slice(0, maximumCharacters);
  const finalCodeUnit = truncated.charCodeAt(truncated.length - 1);
  return finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff
    ? truncated.slice(0, -1)
    : truncated;
}

function codePointUtf8Bytes(codePoint: number): number {
  return codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
}
