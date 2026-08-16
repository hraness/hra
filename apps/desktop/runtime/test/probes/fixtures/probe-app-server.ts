import { JsonLineDecoder, isJsonObject, isJsonRpcId } from "../jsonl";

const decoder = new JsonLineDecoder();
const pendingServerRequests = new Map<string, string | number>();
const reader = Bun.stdin.stream().getReader();

while (true) {
  const next = await reader.read();
  if (next.done) {
    break;
  }
  for (const line of decoder.push(next.value)) {
    handleLine(line);
  }
}
for (const line of decoder.finish()) {
  handleLine(line);
}

function handleLine(line: string): void {
  const message = JSON.parse(line) as unknown;
  if (!isJsonObject(message)) {
    return;
  }

  if (typeof message.method === "string" && isJsonRpcId(message.id)) {
    switch (message.method) {
      case "initialize":
        write({
          id: message.id,
          result: {
            userAgent: "probe-app-server/1",
            codexHome: process.env.CODEX_HOME ?? process.cwd(),
            platformFamily: "unix",
            platformOs: "macos",
          },
        });
        return;
      case "probe/echo":
        write({ id: message.id, result: message.params });
        return;
      case "probe/server-request": {
        const serverRequestId = `fixture-${String(message.id)}`;
        pendingServerRequests.set(serverRequestId, message.id);
        write({
          id: serverRequestId,
          method: "item/tool/requestUserInput",
          params: {
            threadId: "fixture-thread",
            turnId: "fixture-turn",
            itemId: "fixture-item",
            questions: [],
            autoResolutionMs: null,
          },
        });
        return;
      }
      case "probe/malformed":
        process.stdout.write("{malformed\n");
        return;
      case "probe/exit":
        process.exit(23);
    }
  }

  if (message.method === "initialized") {
    write({ method: "fixture/ready", params: { ready: true } });
    return;
  }

  if (isJsonRpcId(message.id) && Object.hasOwn(message, "result")) {
    const originalId = pendingServerRequests.get(String(message.id));
    if (originalId !== undefined) {
      pendingServerRequests.delete(String(message.id));
      write({ id: originalId, result: { serverResponse: message.result } });
    }
  }
}

function write(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
