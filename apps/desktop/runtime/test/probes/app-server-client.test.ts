import { afterEach, describe, expect, test } from "bun:test";
import { CodexAppServerClient } from "./app-server-client";

const clients = new Set<CodexAppServerClient>();

afterEach(async () => {
  await Promise.all([...clients].map((client) => client.close()));
  clients.clear();
});

describe("CodexAppServerClient", () => {
  test("correlates responses and exposes server requests and notifications", async () => {
    const client = launchFixture();
    const initialized = await client.request("initialize", {});
    expect(initialized).toMatchObject({ userAgent: "probe-app-server/1" });

    client.notify("initialized");
    const ready = await client.waitForMessage(
      (message) => message.value.method === "fixture/ready",
    );
    expect(ready.value.params).toEqual({ ready: true });

    expect(await client.request("probe/echo", { text: "hello" })).toEqual({ text: "hello" });

    const beforeRequest = client.lastOrdinal;
    const response = client.request("probe/server-request", {});
    const serverRequest = await client.waitForMessage(
      (message) => message.value.method === "item/tool/requestUserInput",
      { afterOrdinal: beforeRequest },
    );
    expect(serverRequest.value.id).toBe("fixture-3");
    client.respondResult("fixture-3", { answers: {} });
    expect(await response).toEqual({ serverResponse: { answers: {} } });

    expect(client.messagesAfter(beforeRequest)).toHaveLength(1);
  });

  test("rejects pending requests when stdout is malformed", async () => {
    const client = launchFixture();
    await expectRejection(client.request("probe/malformed", {}), "malformed JSON");
  });

  test("rejects pending requests when the child exits unexpectedly", async () => {
    const client = launchFixture();
    await expectRejection(
      client.request("probe/exit", {}),
      "app-server exited unexpectedly with code 23",
    );
  });
});

function launchFixture(): CodexAppServerClient {
  const client = CodexAppServerClient.launch({
    command: [process.execPath, `${import.meta.dir}/fixtures/probe-app-server.ts`],
    cwd: import.meta.dir,
    env: fixtureEnvironment(),
  });
  clients.add(client);
  return client;
}

function fixtureEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {
    CODEX_HOME: import.meta.dir,
    NO_COLOR: "1",
  };
  if (typeof process.env.PATH === "string") {
    environment.PATH = process.env.PATH;
  }
  return environment;
}

async function expectRejection(promise: Promise<unknown>, expectedMessage: string): Promise<void> {
  try {
    await promise;
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(Error);
    expect(error instanceof Error ? error.message : String(error)).toContain(expectedMessage);
    return;
  }
  throw new Error(`expected rejection containing ${expectedMessage}`);
}
