#!/usr/bin/env bun

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function write(value: JsonObject): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function handle(line: string): void {
  const message: unknown = JSON.parse(line);
  if (!isJsonObject(message)) return;
  if (message.method === "initialized") {
    process.exit(73);
  }
  if (message.method !== "initialize") return;
  const id = message.id;
  if (typeof id !== "string" && typeof id !== "number") return;
  write({
    id,
    result: {
      userAgent: "gateway-fault-fixture/1",
      codexHome: process.env.CODEX_HOME ?? process.cwd(),
      platformFamily: "unix",
      platformOs: "macos",
    },
  });
}

const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line.length > 0) handle(line);
    newline = buffer.indexOf("\n");
  }
}
