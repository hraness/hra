#!/usr/bin/env bun

import { appendFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is string | number {
  return typeof value === "string" || typeof value === "number";
}

function write(message: JsonObject): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handleLine(line: string): void {
  const message: unknown = JSON.parse(line);
  if (!isJsonObject(message)) return;

  if (message.method === "initialized") {
    writeFileSync(
      join(process.env.CODEX_HOME ?? process.cwd(), ".initialized-notification"),
      "initialized\n",
      { mode: 0o600 },
    );
    return;
  }
  if (typeof message.method !== "string" || !isRequestId(message.id)) return;

  switch (message.method) {
    case "initialize": {
      const requestedCodexHome = process.env.CODEX_HOME ?? process.cwd();
      write({
        id: message.id,
        result: {
          userAgent: "fault-app-server/1",
          codexHome: requestedCodexHome.endsWith("wrong-codex-home")
            ? dirname(requestedCodexHome)
            : requestedCodexHome,
          platformFamily: "unix",
          platformOs: "macos",
        },
      });
      return;
    }
    case "account/read":
      if (isJsonObject(message.params) && message.params.refreshToken === false) {
        write({ id: message.id, result: { account: "invalid" } });
        return;
      }
      process.stderr.write("fixture-secret-path-and-prompt\n");
      process.stdout.write('{"id":"broken","result":\n');
      return;
    case "account/login/cancel":
      appendFileSync(
        join(process.env.CODEX_HOME ?? process.cwd(), ".ignored-mutations.jsonl"),
        `${JSON.stringify({ id: message.id, method: message.method })}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      // Stay alive while deliberately withholding the response. This models a
      // provider process that wedges after accepting an ambiguous mutation.
      return;
    case "turn/interrupt":
      process.stderr.write("fixture-secret-path-and-prompt\n");
      return process.exit(73);
    default:
      write({ id: message.id, result: { accepted: true } });
  }
}

const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line.length > 0) handleLine(line);
    newline = buffer.indexOf("\n");
  }
}

buffer += decoder.decode();
if (buffer.trim().length > 0) handleLine(buffer.trim());
