export type JsonRpcId = number | string;

export type JsonObject = Record<string, unknown>;

export class ProtocolViolation extends Error {
  override readonly name = "ProtocolViolation";
}

export class JsonLineDecoder {
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  #buffer = "";

  push(chunk: Uint8Array): Array<string> {
    this.#buffer += this.#decoder.decode(chunk, { stream: true });
    return this.#drain(false);
  }

  finish(): Array<string> {
    this.#buffer += this.#decoder.decode();
    return this.#drain(true);
  }

  #drain(includeFinalLine: boolean): Array<string> {
    const lines: Array<string> = [];
    let newline = this.#buffer.indexOf("\n");

    while (newline !== -1) {
      const line = this.#buffer.slice(0, newline).replace(/\r$/, "");
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.trim().length > 0) {
        lines.push(line);
      }
      newline = this.#buffer.indexOf("\n");
    }

    if (includeFinalLine) {
      const finalLine = this.#buffer.replace(/\r$/, "");
      this.#buffer = "";
      if (finalLine.trim().length > 0) {
        lines.push(finalLine);
      }
    }

    return lines;
  }
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

export function parseProtocolLine(line: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch (error: unknown) {
    throw new ProtocolViolation(`app-server emitted malformed JSON: ${errorMessage(error)}`);
  }

  if (!isJsonObject(parsed)) {
    throw new ProtocolViolation("app-server message must be a JSON object");
  }

  const hasMethod = typeof parsed.method === "string";
  const hasId = isJsonRpcId(parsed.id);
  const hasResult = Object.hasOwn(parsed, "result");
  const hasError = Object.hasOwn(parsed, "error");

  if (hasMethod) {
    if (Object.hasOwn(parsed, "id") && !hasId) {
      throw new ProtocolViolation("app-server request id must be a finite number or string");
    }
    if (hasResult || hasError) {
      throw new ProtocolViolation("app-server method envelope cannot also be a response");
    }
    return parsed;
  }

  if (!hasId) {
    throw new ProtocolViolation("app-server response must contain an id");
  }
  if (hasResult === hasError) {
    throw new ProtocolViolation("app-server response must contain exactly one of result or error");
  }
  if (hasError && !isJsonObject(parsed.error)) {
    throw new ProtocolViolation("app-server response error must be an object");
  }

  return parsed;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
