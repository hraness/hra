import { describe, expect, test } from "bun:test";

import { HRA_VERSION } from "../version.ts";
import { CodexAppServerClient, type CodexAppServerClientOptions } from "./client.ts";
import { CodexError } from "./errors.ts";
import type { CodexProcess } from "./process.ts";
import type { CodexFact, FencedCodexValue } from "./protocol.ts";

const CONNECTION_ID = "018f1f55-3f10-7c1a-8f7b-c6dc608bcd3b";
const CREDENTIAL_STORE_PREFLIGHT = Object.freeze({
  cliAuth: "file",
  cwd: "/tmp/hra-control-plane/project",
  mcpOauth: "file",
} as const);

type TestClientOptions = Omit<CodexAppServerClientOptions, "credentialStorePreflight">
  & Partial<Pick<CodexAppServerClientOptions, "credentialStorePreflight">>;

function createClient(options: TestClientOptions): CodexAppServerClient {
  return new CodexAppServerClient({
    credentialStorePreflight: CREDENTIAL_STORE_PREFLIGHT,
    ...options,
  });
}

const commandApprovalParams = (reason = "Need network access") => ({
  threadId: "thread-1",
  turnId: "turn-1",
  itemId: "item-1",
  startedAtMs: 1,
  approvalId: null,
  environmentId: null,
  reason,
  networkApprovalContext: null,
  command: "git push origin main",
  cwd: "/workspace/project",
  commandActions: [],
  additionalPermissions: null,
  proposedExecpolicyAmendment: null,
  proposedNetworkPolicyAmendments: null,
  availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
});

class ByteQueue implements AsyncIterable<Uint8Array> {
  readonly #items: Uint8Array[] = [];
  readonly #waiters: ((result: IteratorResult<Uint8Array>) => void)[] = [];
  #closed = false;

  push(value: string): void {
    const bytes = new TextEncoder().encode(value);
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#items.push(bytes);
    else waiter({ done: false, value: bytes });
  }

  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: async () => {
        const item = this.#items.shift();
        if (item !== undefined) return { done: false, value: item };
        if (this.#closed) return { done: true, value: undefined };
        return await new Promise<IteratorResult<Uint8Array>>((resolve) => {
          this.#waiters.push(resolve);
        });
      },
    };
  }
}

class FakeProcess implements CodexProcess {
  readonly stdoutQueue = new ByteQueue();
  readonly stderrQueue = new ByteQueue();
  readonly stdout = this.stdoutQueue;
  readonly stderr = this.stderrQueue;
  readonly writes: unknown[] = [];
  readonly signals: ("SIGTERM" | "SIGKILL")[] = [];
  writeError: Error | undefined;
  writeSettlementGate: Promise<void> | undefined;
  readonly exited: Promise<number>;
  #responseCount = 0;
  #resolveExit!: (code: number) => void;

  constructor(
    readonly onWrite: (message: Record<string, unknown>, process: FakeProcess) => void,
    readonly shutdown: {
      readonly autoCredentialStorePreflight?: boolean;
      readonly ignoreTerm?: boolean;
      readonly leaveStreamsOpenAfterKill?: boolean;
    } = {},
  ) {
    this.exited = new Promise((resolve) => {
      this.#resolveExit = resolve;
    });
  }

  async write(bytes: Uint8Array): Promise<void> {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    this.writes.push(parsed);
    if (this.writeError !== undefined) {
      const error = this.writeError;
      this.writeError = undefined;
      throw error;
    }
    const responseCountBeforeWrite = this.#responseCount;
    this.onWrite(parsed as Record<string, unknown>, this);
    if (
      (parsed as Record<string, unknown>).method === "config/read"
      && this.shutdown.autoCredentialStorePreflight !== false
      && this.#responseCount === responseCountBeforeWrite
    ) {
      this.respond({
        id: (parsed as Record<string, unknown>).id,
        result: {
          config: {
            cli_auth_credentials_store: "file",
            mcp_oauth_credentials_store: "file",
          },
          origins: {},
        },
      });
    }
    const gate = this.writeSettlementGate;
    this.writeSettlementGate = undefined;
    if (gate !== undefined) await gate;
  }

  respond(value: unknown): void {
    this.#responseCount += 1;
    this.stdoutQueue.push(`${JSON.stringify(value)}\n`);
  }

  terminate(): void {
    this.signals.push("SIGTERM");
    if (this.shutdown.ignoreTerm === true) return;
    this.stdoutQueue.close();
    this.stderrQueue.close();
    this.#resolveExit(0);
  }

  forceTerminate(): void {
    this.signals.push("SIGKILL");
    if (this.shutdown.leaveStreamsOpenAfterKill !== true) {
      this.stdoutQueue.close();
      this.stderrQueue.close();
    }
    this.#resolveExit(137);
  }
}

function successfulFake(codexHome: string, userAgent = "codex-cli/0.149.0"): FakeProcess {
  return new FakeProcess((message, process) => {
    if (message.method === "initialize") {
      process.respond({
        id: message.id,
        result: {
          userAgent,
          codexHome,
          platformFamily: "unix",
          platformOs: "macos",
        },
      });
    } else if (message.method === "account/read") {
      process.respond({
        id: message.id,
        result: {
          account: { type: "chatgpt", email: "person@example.com", planType: "pro" },
          requiresOpenaiAuth: true,
        },
      });
    }
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("condition did not settle");
}

function deferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
}> {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

describe("CodexAppServerClient", () => {
  test("requires credential-store proof at the client boundary", () => {
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    const options = {
      process,
      authority: { profileId: "profile-a", processGeneration: 1 },
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      isAuthorityCurrent: () => true,
    } as unknown as CodexAppServerClientOptions;

    expect(() => new CodexAppServerClient(options)).toThrow(
      "credential-store preflight is required",
    );
    expect(process.writes).toEqual([]);
    expect(process.signals).toEqual([]);
  });

  test("preflights both effective credential stores before becoming available", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    let configReads = 0;
    const process = new FakeProcess((message, runtime) => {
      if (message.method === "initialize") {
        runtime.respond({
          id: message.id,
          result: {
            userAgent: "codex-cli/0.149.0",
            codexHome,
            platformFamily: "unix",
            platformOs: "macos",
          },
        });
      } else if (message.method === "config/read") {
        expect(message.params).toEqual({
          cwd: configReads === 0
            ? "/private/tmp/hra-acceptance/project-a"
            : "/private/tmp/hra-acceptance/project-b",
          includeLayers: false,
        });
        configReads += 1;
        runtime.respond({
          id: message.id,
          result: {
            config: {
              cli_auth_credentials_store: "file",
              mcp_oauth_credentials_store: "file",
            },
            origins: {},
          },
        });
      }
    }, { autoCredentialStorePreflight: false });
    const client = createClient({
      process,
      authority: { profileId: "profile-a", processGeneration: 7 },
      credentialStorePreflight: {
        cliAuth: "file",
        cwd: "/private/tmp/hra-acceptance/project-a",
        mcpOauth: "file",
      },
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => true,
    });

    await expect(client.initialize()).resolves.toMatchObject({
      authority: { profileId: "profile-a", processGeneration: 7 },
    });
    await expect(client.assertCredentialStores(
      "/private/tmp/hra-acceptance/project-b",
    )).resolves.toBeUndefined();
    expect(process.writes).toContainEqual({
      id: 2,
      method: "config/read",
      params: {
        cwd: "/private/tmp/hra-acceptance/project-a",
        includeLayers: false,
      },
    });
    expect(configReads).toBe(2);
    await client.close();
  });

  test("fails closed when an effective credential store is not file-backed", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const process = new FakeProcess((message, runtime) => {
      if (message.method === "initialize") {
        runtime.respond({
          id: message.id,
          result: {
            userAgent: "codex-cli/0.149.0",
            codexHome,
            platformFamily: "unix",
            platformOs: "macos",
          },
        });
      } else if (message.method === "config/read") {
        runtime.respond({
          id: message.id,
          result: {
            config: {
              cli_auth_credentials_store: "file",
              mcp_oauth_credentials_store: "keyring",
            },
            origins: {},
          },
        });
      }
    });
    const client = createClient({
      process,
      authority: { profileId: "profile-a", processGeneration: 7 },
      credentialStorePreflight: {
        cliAuth: "file",
        cwd: "/private/tmp/hra-acceptance/project-a",
        mcpOauth: "file",
      },
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => true,
    });

    const error = await client.initialize().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "RUNTIME_MISMATCH" });
    expect(client.state).toBe("failed");
    expect(process.signals).toEqual(["SIGTERM"]);
  });

  test("admits no provider facts or interactions before credential-store proof", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const facts: CodexFact[] = [];
    let configRequestId: unknown;
    const process = new FakeProcess((message, runtime) => {
      if (message.method === "initialize") {
        runtime.respond({
          id: message.id,
          result: {
            userAgent: "codex-cli/0.149.0",
            codexHome,
            platformFamily: "unix",
            platformOs: "macos",
          },
        });
      } else if (message.method === "config/read") {
        configRequestId = message.id;
        runtime.respond({
          method: "account/updated",
          params: { authMode: "chatgpt", planType: "pro" },
        });
        runtime.respond({
          id: 91,
          method: "item/commandExecution/requestApproval",
          params: commandApprovalParams(),
        });
      }
    }, { autoCredentialStorePreflight: false });
    const client = createClient({
      process,
      authority: { profileId: "profile-a", processGeneration: 7 },
      credentialStorePreflight: {
        cliAuth: "file",
        cwd: "/private/tmp/hra-acceptance/project-a",
        mcpOauth: "file",
      },
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => true,
      onFact: ({ value }) => { facts.push(value); },
    });

    const initialization = client.initialize();
    await waitFor(() => configRequestId !== undefined);
    await waitFor(() => process.writes.some((value) =>
      (value as { id?: unknown }).id === 91));
    expect(client.state).toBe("preflighting");
    expect(facts).toEqual([]);

    process.respond({
      id: configRequestId,
      result: {
        config: {
          cli_auth_credentials_store: "file",
          mcp_oauth_credentials_store: "keyring",
        },
        origins: {},
      },
    });
    await expect(initialization).rejects.toMatchObject({ code: "RUNTIME_MISMATCH" });
    await Bun.sleep(1);
    expect(facts).toEqual([]);
    expect(process.writes).toContainEqual({
      id: 91,
      error: {
        code: -32_001,
        message: "HRA has not activated this provider connection",
      },
    });
  });

  test("replays bounded preflight notifications only after the connection is proven", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const facts: CodexFact[] = [];
    const process = new FakeProcess((message, runtime) => {
      if (message.method === "initialize") {
        runtime.respond({
          id: message.id,
          result: {
            userAgent: "codex-cli/0.149.0",
            codexHome,
            platformFamily: "unix",
            platformOs: "macos",
          },
        });
      } else if (message.method === "config/read") {
        runtime.respond({
          method: "account/updated",
          params: { authMode: "chatgpt", planType: "pro" },
        });
        runtime.respond({
          method: "serverRequest/resolved",
          params: { threadId: "thread-1", requestId: 91 },
        });
        runtime.respond({
          id: message.id,
          result: {
            config: {
              cli_auth_credentials_store: "file",
              mcp_oauth_credentials_store: "file",
            },
            origins: {},
          },
        });
      }
    });
    const client = createClient({
      process,
      authority: { profileId: "profile-a", processGeneration: 7 },
      credentialStorePreflight: {
        cliAuth: "file",
        cwd: "/private/tmp/hra-acceptance/project-a",
        mcpOauth: "file",
      },
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => true,
      connectionId: CONNECTION_ID,
      onFact: ({ value }) => { facts.push(value); },
    });

    await client.initialize();
    await waitFor(() => facts.length === 3);
    expect(facts).toEqual([
      { type: "providerConnected", connectionId: CONNECTION_ID },
      {
        type: "accountUpdated",
        authMode: "chatgpt",
        planType: "pro",
        connectionId: CONNECTION_ID,
      },
      {
        type: "protocolNotice",
        method: "serverRequest/resolved",
        connectionId: CONNECTION_ID,
      },
    ]);
    await client.close();
  });

  test("commits ready before providerConnected and preserves a notification at the activation boundary", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const activationGate = deferred<boolean>();
    const facts: Array<Readonly<{ state: string; value: CodexFact }>> = [];
    let authorityChecks = 0;
    const process = successfulFake(codexHome);
    const client = createClient({
      process,
      authority: { profileId: "profile-a", processGeneration: 7 },
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => {
        authorityChecks += 1;
        return authorityChecks === 6 ? activationGate.promise : true;
      },
      connectionId: CONNECTION_ID,
      onFact: ({ value }) => { facts.push({ state: client.state, value }); },
    });

    const initialization = client.initialize();
    await waitFor(() => authorityChecks === 6);
    expect(client.state).toBe("preflighting");
    process.respond({
      method: "account/updated",
      params: { authMode: "chatgpt", planType: "pro" },
    });
    await Bun.sleep(1);
    expect(facts).toEqual([]);

    activationGate.resolve(true);
    await initialization;
    await waitFor(() => facts.length === 2);
    expect(facts).toEqual([
      {
        state: "ready",
        value: { type: "providerConnected", connectionId: CONNECTION_ID },
      },
      {
        state: "ready",
        value: {
          type: "accountUpdated",
          authMode: "chatgpt",
          planType: "pro",
          connectionId: CONNECTION_ID,
        },
      },
    ]);
    await client.close();
  });

  test("emits no connection facts when authority becomes stale at the activation commit", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const activationGate = deferred<boolean>();
    const facts: CodexFact[] = [];
    let authorityChecks = 0;
    const process = successfulFake(codexHome);
    const client = createClient({
      process,
      authority: { profileId: "profile-a", processGeneration: 7 },
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => {
        authorityChecks += 1;
        return authorityChecks === 6 ? activationGate.promise : true;
      },
      onFact: ({ value }) => { facts.push(value); },
    });

    const initialization = client.initialize();
    await waitFor(() => authorityChecks === 6);
    activationGate.resolve(false);
    await expect(initialization).rejects.toMatchObject({ code: "AUTHORITY_STALE" });
    await Bun.sleep(1);
    expect(facts).toEqual([]);
  });

  test("emits no buffered facts when the process exits before the activation commit", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const activationGate = deferred<boolean>();
    const facts: CodexFact[] = [];
    let authorityChecks = 0;
    const process = new FakeProcess((message, runtime) => {
      if (message.method === "initialize") {
        runtime.respond({
          id: message.id,
          result: {
            userAgent: "codex-cli/0.149.0",
            codexHome,
            platformFamily: "unix",
            platformOs: "macos",
          },
        });
      } else if (message.method === "config/read") {
        runtime.respond({
          method: "account/updated",
          params: { authMode: "chatgpt", planType: "pro" },
        });
        runtime.respond({
          id: message.id,
          result: {
            config: {
              cli_auth_credentials_store: "file",
              mcp_oauth_credentials_store: "file",
            },
            origins: {},
          },
        });
      }
    });
    const client = createClient({
      process,
      authority: { profileId: "profile-a", processGeneration: 7 },
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => {
        authorityChecks += 1;
        return authorityChecks === 6 ? activationGate.promise : true;
      },
      onFact: ({ value }) => { facts.push(value); },
    });

    const initialization = client.initialize();
    await waitFor(() => authorityChecks === 6);
    process.terminate();
    await waitFor(() => client.state === "failed");
    activationGate.resolve(true);
    await expect(initialization).rejects.toMatchObject({ code: "PROCESS_EXITED" });
    await Bun.sleep(1);
    expect(facts).toEqual([]);
  });

  test("fails closed on an unknown response id during credential-store preflight", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    let configRequestId: unknown;
    const process = new FakeProcess((message, runtime) => {
      if (message.method === "initialize") {
        runtime.respond({
          id: message.id,
          result: {
            userAgent: "codex-cli/0.149.0",
            codexHome,
            platformFamily: "unix",
            platformOs: "macos",
          },
        });
      } else if (message.method === "config/read") {
        configRequestId = message.id;
      }
    }, { autoCredentialStorePreflight: false });
    const client = createClient({
      process,
      authority: { profileId: "profile-a", processGeneration: 7 },
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => true,
    });

    const initialization = client.initialize();
    await waitFor(() => configRequestId !== undefined);
    process.respond({ id: 999, result: {} });
    await expect(initialization).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    expect(client.state).toBe("failed");
  });

  test("keeps a colliding preflight server-request id distinct from the config response", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    let configRequestId: number | undefined;
    const process = new FakeProcess((message, runtime) => {
      if (message.method === "initialize") {
        runtime.respond({
          id: message.id,
          result: {
            userAgent: "codex-cli/0.149.0",
            codexHome,
            platformFamily: "unix",
            platformOs: "macos",
          },
        });
      } else if (message.method === "config/read") {
        configRequestId = message.id as number;
      }
    }, { autoCredentialStorePreflight: false });
    const client = createClient({
      process,
      authority: { profileId: "profile-a", processGeneration: 7 },
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => true,
    });

    const initialization = client.initialize();
    await waitFor(() => configRequestId !== undefined);
    process.respond({
      id: configRequestId,
      method: "item/commandExecution/requestApproval",
      params: commandApprovalParams(),
    });
    await waitFor(() => process.writes.some((frame) => {
      const value = frame as { error?: unknown; id?: unknown };
      return value.id === configRequestId && value.error !== undefined;
    }));
    process.respond({
      id: configRequestId,
      result: {
        config: {
          cli_auth_credentials_store: "file",
          mcp_oauth_credentials_store: "file",
        },
        origins: {},
      },
    });

    await expect(initialization).resolves.toMatchObject({
      authority: { profileId: "profile-a", processGeneration: 7 },
    });
    expect(process.writes).toContainEqual({
      id: configRequestId,
      error: {
        code: -32_001,
        message: "HRA has not activated this provider connection",
      },
    });
    await client.close();
  });

  test("bounds every inbound frame while credential-store proof is pending", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    let configRequestId: unknown;
    const process = new FakeProcess((message, runtime) => {
      if (message.method === "initialize") {
        runtime.respond({
          id: message.id,
          result: {
            userAgent: "codex-cli/0.149.0",
            codexHome,
            platformFamily: "unix",
            platformOs: "macos",
          },
        });
      } else if (message.method === "config/read") {
        configRequestId = message.id;
      }
    }, { autoCredentialStorePreflight: false });
    const client = createClient({
      process,
      authority: { profileId: "profile-a", processGeneration: 7 },
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => true,
    });

    const initialization = client.initialize();
    await waitFor(() => configRequestId !== undefined);
    for (let index = 0; index < 128; index += 1) {
      process.respond({
        method: "account/updated",
        params: { authMode: "chatgpt", planType: "pro" },
      });
    }
    await expect(initialization).rejects.toMatchObject({ code: "PROTOCOL_LIMIT" });
    expect(client.state).toBe("failed");
  });

  test("bounds projected notification bytes while credential-store proof is pending", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    let configRequestId: unknown;
    const process = new FakeProcess((message, runtime) => {
      if (message.method === "initialize") {
        runtime.respond({
          id: message.id,
          result: {
            userAgent: "codex-cli/0.149.0",
            codexHome,
            platformFamily: "unix",
            platformOs: "macos",
          },
        });
      } else if (message.method === "config/read") {
        configRequestId = message.id;
      }
    }, { autoCredentialStorePreflight: false });
    const client = createClient({
      process,
      authority: { profileId: "profile-a", processGeneration: 7 },
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => true,
    });

    const initialization = client.initialize();
    await waitFor(() => configRequestId !== undefined);
    const delta = "x".repeat(32_768);
    for (let index = 0; index < 33; index += 1) {
      process.respond({
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: `item-${String(index)}`,
          delta,
        },
      });
    }
    await expect(initialization).rejects.toMatchObject({ code: "PROTOCOL_LIMIT" });
    expect(client.state).toBe("failed");
  });

  test("sends the exact pinned login cancellation authority", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const process = new FakeProcess((message, runtime) => {
      if (message.method === "initialize") {
        runtime.respond({
          id: message.id,
          result: {
            userAgent: "codex-cli/0.149.0",
            codexHome,
            platformFamily: "unix",
            platformOs: "macos",
          },
        });
      } else if (message.method === "account/login/cancel") {
        expect(message.params).toEqual({ loginId: "provider-login-exact" });
        runtime.respond({ id: message.id, result: { status: "notFound" } });
      }
    });
    const client = createClient({
      process,
      authority: { profileId: "profile-a", processGeneration: 7 },
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => true,
    });
    await client.initialize();
    await expect(client.cancelManagedLogin("provider-login-exact")).resolves.toEqual({
      authority: { profileId: "profile-a", processGeneration: 7 },
      value: { status: "notFound" },
    });
    expect(process.writes).toContainEqual({
      id: 3,
      method: "account/login/cancel",
      params: { loginId: "provider-login-exact" },
    });
    await client.close();
  });

  test("initializes once and fences returned identity", async () => {
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    const facts: FencedCodexValue<CodexFact>[] = [];
    const client = createClient({
      process,
      authority: { profileId: "profile-a", processGeneration: 7 },
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      isAuthorityCurrent: () => true,
      connectionId: CONNECTION_ID,
      onFact: (fact) => {
        facts.push(fact);
      },
    });
    await client.initialize();
    expect(process.writes[0]).toEqual({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "hra", title: "HRA", version: HRA_VERSION },
        capabilities: {
          experimentalApi: false,
          extensions: { "openai/standard-form-input": {} },
        },
      },
    });
    expect(JSON.stringify(process.writes[0])).not.toContain("openai/form");
    const result = await client.accountRead();
    expect(result.authority).toEqual({ profileId: "profile-a", processGeneration: 7 });
    expect(result.value.account).toEqual({
      type: "chatgpt",
      email: "person@example.com",
      planType: "pro",
    });
    expect((process.writes[1] as Record<string, unknown>).method).toBe("initialized");
    await Bun.sleep(1);
    expect(facts).toEqual([{
      authority: { profileId: "profile-a", processGeneration: 7 },
      value: { type: "providerConnected", connectionId: CONNECTION_ID },
    }]);
    await client.close();
  });

  test("rejects a CODEX_HOME mismatch before becoming ready", async () => {
    const process = successfulFake("/tmp/wrong-home");
    const client = createClient({
      process,
      authority: { profileId: "profile-a", processGeneration: 1 },
      expectedCodexHome: "/tmp/expected-home",
      isAuthorityCurrent: () => true,
    });
    const error = await client.initialize().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "HOME_MISMATCH" });
  });

  test("accepts the pinned desktop user agent and rejects protocol version drift", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const pinned = createClient({
      process: successfulFake(codexHome, "Codex Desktop/0.149.0 (Mac OS 26.5; arm64) dumb (hra; 0.1.0)"),
      authority: { profileId: "profile-a", processGeneration: 1 },
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => true,
    });
    await expect(pinned.initialize()).resolves.toMatchObject({ value: { platformOs: "macos" } });
    await pinned.close();

    const drifted = createClient({
      process: successfulFake(codexHome, "Codex Desktop/0.149.1 (Mac OS 26.5; arm64)"),
      authority: { profileId: "profile-a", processGeneration: 1 },
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => true,
    });
    await expect(drifted.initialize()).rejects.toMatchObject({ code: "RUNTIME_MISMATCH" });
  });

  test("treats private stdio EOF as a dead connection rather than a reconnect", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const process = successfulFake(codexHome);
    const facts: CodexFact[] = [];
    const client = createClient({
      process,
      authority: { profileId: "profile-a", processGeneration: 1 },
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => true,
      connectionId: CONNECTION_ID,
      onFact: ({ value }) => { facts.push(value); },
    });
    await client.initialize();
    process.stdoutQueue.close();
    await waitFor(() => client.state === "failed");
    await waitFor(() => facts.some((fact) => fact.type === "providerDisconnected"));
    expect(facts.filter((fact) => fact.type === "providerDisconnected")).toEqual([{
      type: "providerDisconnected",
      connectionId: CONNECTION_ID,
      reason: "eof",
    }]);
    await client.close();
  });

  test("refuses dispatch after the generation becomes stale", async () => {
    let current = true;
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    const client = createClient({
      process,
      authority: { profileId: "profile-a", processGeneration: 2 },
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      isAuthorityCurrent: () => current,
    });
    await client.initialize();
    current = false;
    const error = await client.accountRead().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CodexError);
    expect(process.writes).toHaveLength(3);
    await client.close();
  });

  test("rejects unsupported legacy prompts instead of treating them as interactions", async () => {
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    const client = createClient({
      process,
      authority: { profileId: "profile-a", processGeneration: 1 },
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      isAuthorityCurrent: () => true,
    });
    await client.initialize();
    process.respond({ id: 900, method: "execCommandApproval", params: {} });
    await Bun.sleep(1);
    expect(process.writes.at(-1)).toEqual({
      id: 900,
      error: {
        code: -32_601,
        message: "HRA does not support this server request",
      },
    });
    await client.close();
  });

  test("rejects file approvals whose pinned callback omits exact changed paths", async () => {
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    const facts: CodexFact[] = [];
    const diagnostics: string[] = [];
    const client = createClient({
      process,
      authority: { profileId: "profile-a", processGeneration: 1 },
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      isAuthorityCurrent: () => true,
      connectionId: CONNECTION_ID,
      onFact: ({ value }) => { facts.push(value); },
      onSafeDiagnostic: (message) => { diagnostics.push(message); },
    });
    await client.initialize();
    const sentinel = "/private/FILE-APPROVAL-REASON-SENTINEL";
    process.respond({
      id: 902,
      method: "item/fileChange/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-file",
        reason: sentinel,
        grantRoot: "/workspace",
      },
    });
    await waitFor(() => facts.some((fact) => fact.type === "protocolNotice"));
    expect(process.writes.at(-1)).toEqual({
      id: 902,
      error: {
        code: -32_601,
        message: "HRA cannot broker this server request capability",
        data: { code: "UNSUPPORTED_CAPABILITY" },
      },
    });
    expect(facts.some((fact) => fact.type === "interactionRequested")).toBe(false);
    expect(JSON.stringify({ writes: process.writes, facts, diagnostics })).not.toContain(sentinel);
    await client.close();
  });

  test("classifies MCP URL elicitation as unsupported without admitting or echoing its URL", async () => {
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    const facts: CodexFact[] = [];
    const diagnostics: string[] = [];
    const client = createClient({
      process,
      authority: { profileId: "profile-a", processGeneration: 1 },
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      isAuthorityCurrent: () => true,
      connectionId: CONNECTION_ID,
      onFact: ({ value }) => { facts.push(value); },
      onSafeDiagnostic: (message) => { diagnostics.push(message); },
    });
    await client.initialize();
    const sentinel = "MCP_CLIENT_URL_SECRET_SENTINEL";
    process.respond({
      id: 901,
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        serverName: "example",
        mode: "url",
        _meta: null,
        message: "Authorize Example",
        url: `https://example.com/oauth?access_token=${sentinel}#${sentinel}`,
        elicitationId: "elicit-url",
      },
    });
    await waitFor(() => facts.some((fact) => fact.type === "protocolNotice"));
    expect(process.writes.at(-1)).toEqual({
      id: 901,
      error: {
        code: -32_601,
        message: "HRA cannot broker this server request capability",
        data: { code: "UNSUPPORTED_CAPABILITY" },
      },
    });
    expect(facts.some((fact) => fact.type === "interactionRequested")).toBe(false);
    expect(diagnostics).toEqual([
      "Codex requested an unsupported capability for mcpServer/elicitation/request",
    ]);
    expect(JSON.stringify({ writes: process.writes, facts, diagnostics })).not.toContain(sentinel);
    await client.close();
  });

  test("fails closed on opaque and unsupported MCP forms without admitting or echoing their schemas", async () => {
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    const facts: CodexFact[] = [];
    const diagnostics: string[] = [];
    const client = createClient({
      process,
      authority: { profileId: "profile-a", processGeneration: 1 },
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      isAuthorityCurrent: () => true,
      connectionId: CONNECTION_ID,
      onFact: ({ value }) => { facts.push(value); },
      onSafeDiagnostic: (message) => { diagnostics.push(message); },
    });
    await client.initialize();
    const sentinel = "MCP_CLIENT_SCHEMA_SECRET_SENTINEL";
    const requests = [
      {
        mode: "openai/form",
        requestedSchema: {
          type: "object",
          properties: { picker: { type: "openai/imagePicker", title: sentinel } },
        },
      },
      {
        mode: "form",
        requestedSchema: {
          type: "object",
          properties: { token: { type: "string", pattern: sentinel } },
        },
      },
      {
        mode: "form",
        _meta: {
          codex_approval_kind: "tool_suggestion",
          persist: "always",
          tool_type: "plugin",
          suggest_type: "install",
          install_url: `https://example.com/install?secret=${sentinel}`,
        },
        requestedSchema: { type: "object", properties: {} },
      },
      {
        mode: "form",
        _meta: {
          codex_approval_kind: "mcp_tool_call",
          codex_request_type: "approval_request",
          connector_name: sentinel,
          tool_name: "delete_records",
          tool_params: { target: sentinel },
          persist: "always",
        },
        requestedSchema: { type: "object", properties: {} },
      },
    ] as const;
    for (const [index, request] of requests.entries()) {
      process.respond({
        id: 910 + index,
        method: "mcpServer/elicitation/request",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          serverName: "example",
          _meta: null,
          message: "Configure Example",
          ...request,
        },
      });
      await waitFor(() => process.writes.some((write) =>
        (write as { id?: unknown }).id === 910 + index));
      expect(process.writes.at(-1)).toEqual({
        id: 910 + index,
        error: {
          code: -32_601,
          message: "HRA cannot broker this server request capability",
          data: { code: "UNSUPPORTED_CAPABILITY" },
        },
      });
    }
    expect(facts.some((fact) => fact.type === "interactionRequested")).toBe(false);
    expect(diagnostics).toEqual([
      "Codex requested an unsupported capability for mcpServer/elicitation/request",
      "Codex requested an unsupported capability for mcpServer/elicitation/request",
      "Codex requested an unsupported capability for mcpServer/elicitation/request",
      "Codex requested an unsupported capability for mcpServer/elicitation/request",
    ]);
    expect(JSON.stringify({ writes: process.writes, facts, diagnostics })).not.toContain(sentinel);
    await client.close();
  });

  test("brokers a standard MCP form and writes only a schema-valid exact response", async () => {
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    const facts: FencedCodexValue<CodexFact>[] = [];
    const client = createClient({
      process,
      authority: { profileId: "profile-a", processGeneration: 4 },
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      isAuthorityCurrent: () => true,
      connectionId: CONNECTION_ID,
      onFact: (fact) => { facts.push(fact); },
    });
    await client.initialize();
    const schemaOnlySentinel = "MCP_CLIENT_PRIVATE_SCHEMA_SENTINEL";
    process.respond({
      id: 911,
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        serverName: "example",
        mode: "form",
        _meta: null,
        message: "Configure Example",
        requestedSchema: {
          type: "object",
          properties: {
            channel: {
              type: "string",
              title: schemaOnlySentinel,
              enum: ["stable", "fast"],
              enumNames: [schemaOnlySentinel, schemaOnlySentinel],
            },
            confirmed: { type: "boolean" },
          },
          required: ["channel", "confirmed"],
        },
      },
    });
    await waitFor(() => facts.some((fact) => fact.value.type === "interactionRequested"));
    const requested = facts.find((fact) => fact.value.type === "interactionRequested")?.value;
    if (requested?.type !== "interactionRequested") throw new Error("MCP form was not admitted.");
    expect(requested.display).toMatchObject({
      kind: "mcp_elicitation",
      mode: "form",
      fields: [
        { name: "channel", type: "single_select", required: true, choices: ["stable", "fast"] },
        { name: "confirmed", type: "boolean", required: true },
      ],
    });
    expect(JSON.stringify(requested.display)).not.toContain(schemaOnlySentinel);
    await Bun.sleep(1);
    const writesBeforeInvalid = process.writes.length;
    const submittedSentinel = "MCP_CLIENT_SUBMISSION_SECRET_SENTINEL";
    await expect(client.validateInteractionResolution({
      provider: requested.provider,
      kind: requested.kind,
      resolution: {
        kind: "mcp_submission",
        action: "accept",
        content: { channel: submittedSentinel, confirmed: true },
      },
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(process.writes).toHaveLength(writesBeforeInvalid);
    await expect(client.validateInteractionResolution({
      provider: requested.provider,
      kind: requested.kind,
      resolution: {
        kind: "mcp_submission",
        action: "accept",
        content: { channel: "fast", confirmed: true },
      },
    })).resolves.toEqual({
      responseDigest: "78cc323d0067a51b626d7e1a37704ffd9f002346cb0707dd3d28c327546510e2",
    });
    expect(process.writes).toHaveLength(writesBeforeInvalid);
    await client.resolveInteraction({
      provider: requested.provider,
      kind: requested.kind,
      deadlineAt: requested.deadlineAt ?? Number.NaN,
      resolution: {
        kind: "mcp_submission",
        action: "accept",
        content: { channel: "fast", confirmed: true },
      },
    });
    expect(process.writes.at(-1)).toEqual({
      id: 911,
      result: {
        action: "accept",
        content: { channel: "fast", confirmed: true },
        _meta: null,
      },
    });
    expect(JSON.stringify(process.writes)).not.toContain(submittedSentinel);
    await client.close();
  });

  test("admits a typed interaction and routes an exact response without granting through text", async () => {
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    const facts: FencedCodexValue<CodexFact>[] = [];
    const client = createClient({
      process,
      authority: { profileId: "profile-a", processGeneration: 4 },
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      isAuthorityCurrent: () => true,
      connectionId: CONNECTION_ID,
      onFact: (fact) => { facts.push(fact); },
    });
    await client.initialize();
    process.respond({
      id: 41,
      method: "item/commandExecution/requestApproval",
      params: commandApprovalParams(),
    });
    await waitFor(() => facts.some((fact) => fact.value.type === "interactionRequested"));
    const requested = facts.find((fact) => fact.value.type === "interactionRequested")?.value;
    if (requested?.type !== "interactionRequested") throw new Error("interaction was not admitted");
    expect(requested.provider).toMatchObject({
      connectionId: CONNECTION_ID,
      requestId: { type: "number", value: 41 },
      method: "item/commandExecution/requestApproval",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
    });
    expect(requested.display).toMatchObject({
      kind: "command_approval",
      commandClass: "git push",
      availableDecisions: ["once" as const, "session" as const, "decline" as const, "cancel" as const],
    });
    await expect(client.inspectInteractionAuthority({
      provider: requested.provider,
      kind: requested.kind,
    })).resolves.toEqual({
      kind: "command_approval",
      command: "git push origin main",
      reason: "Need network access",
      availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
      workingDirectory: "/workspace/project",
      environmentId: null,
      commandActions: [],
      networkApprovalContext: null,
      additionalPermissions: null,
      proposedExecpolicyAmendment: null,
      proposedNetworkPolicyAmendments: null,
    });
    await expect(client.inspectInteractionAuthority({
      provider: { ...requested.provider, connectionId: crypto.randomUUID() },
      kind: requested.kind,
    })).rejects.toMatchObject({ code: "AUTHORITY_STALE" });
    await expect(client.resolveInteraction({
      provider: { ...requested.provider, requestDigest: "b".repeat(64) },
      kind: requested.kind,
      deadlineAt: requested.deadlineAt ?? Number.NaN,
      resolution: { kind: "approval_decision", decision: "once" },
    })).rejects.toMatchObject({ code: "AUTHORITY_STALE" });
    await client.resolveInteraction({
      provider: requested.provider,
      kind: requested.kind,
      deadlineAt: requested.deadlineAt ?? Number.NaN,
      resolution: { kind: "approval_decision", decision: "session" },
    });
    expect(process.writes.at(-1)).toEqual({ id: 41, result: { decision: "acceptForSession" } });
    await expect(client.inspectInteractionAuthority({
      provider: requested.provider,
      kind: requested.kind,
    })).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });

    process.respond({
      method: "serverRequest/resolved",
      params: { threadId: "thread-1", requestId: 41 },
    });
    await waitFor(() => facts.some((fact) => fact.value.type === "interactionResolved"));
    await client.close();
  });

  test("anchors callback deadlines at receipt and writes one provider-neutral timeout error", async () => {
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    const facts: CodexFact[] = [];
    let now = 10_000;
    const client = createClient({
      process,
      authority: { profileId: "profile-a", processGeneration: 1 },
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      isAuthorityCurrent: () => true,
      connectionId: CONNECTION_ID,
      now: () => now,
      onFact: ({ value }) => { facts.push(value); },
    });
    await client.initialize();
    process.respond({
      id: "deadline-request",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-deadline",
        isBlocking: true,
        autoResolutionMs: 5_000,
        questions: [{
          id: "choice",
          header: "Choice",
          question: "Choose",
          isOther: true,
          isSecret: false,
          options: null,
        }],
      },
    });
    await waitFor(() => facts.some((fact) => fact.type === "interactionRequested"));
    now = 14_000;
    const requested = facts.find((fact) => fact.type === "interactionRequested");
    if (requested?.type !== "interactionRequested") throw new Error("Missing deadline interaction.");
    expect(requested).toMatchObject({ requestedAt: 10_000, deadlineAt: 15_000, timeoutMs: 5_000 });
    const validated = await client.validateInteractionTimeout({ provider: requested.provider });
    expect(validated.responseDigest).toMatch(/^[a-f0-9]{64}$/u);
    await expect(client.timeoutInteraction({ provider: requested.provider }))
      .resolves.toEqual({ responseWritten: true });
    expect(process.writes.at(-1)).toEqual({
      id: "deadline-request",
      error: { code: -32_008, message: "HRA interaction deadline expired" },
    });
    process.respond({
      method: "serverRequest/resolved",
      params: { threadId: "thread-1", requestId: "deadline-request" },
    });
    await waitFor(() => facts.some((fact) => fact.type === "interactionResolved"));
    await client.close();
  });

  test("rejects a manual response inside the serialized write boundary at its deadline", async () => {
    let now = 10_000;
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    const facts: CodexFact[] = [];
    const client = createClient({
      process,
      authority: { profileId: "profile-a", processGeneration: 1 },
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      isAuthorityCurrent: () => true,
      connectionId: CONNECTION_ID,
      now: () => now,
      onFact: ({ value }) => { facts.push(value); },
    });
    await client.initialize();
    process.respond({
      id: 72,
      method: "item/commandExecution/requestApproval",
      params: { ...commandApprovalParams(), autoResolutionMs: 1_000 },
    });
    await waitFor(() => facts.some((fact) => fact.type === "interactionRequested"));
    const requested = facts.find((fact) => fact.type === "interactionRequested");
    if (requested?.type !== "interactionRequested" || requested.deadlineAt === undefined) {
      throw new Error("Missing deadline interaction.");
    }

    let releaseWrite!: () => void;
    process.writeSettlementGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const blockingRead = client.accountRead();
    await waitFor(() => process.writes.some((value) =>
      (value as { method?: string }).method === "account/read"));
    now = 10_999;
    const manualResponse = client.resolveInteraction({
      provider: requested.provider,
      kind: requested.kind,
      deadlineAt: requested.deadlineAt,
      resolution: { kind: "approval_decision", decision: "once" },
    });
    await Bun.sleep(1);
    now = 11_000;
    releaseWrite();
    await blockingRead;

    await expect(manualResponse).rejects.toMatchObject({ code: "DEADLINE_EXPIRED" });
    expect(process.writes.filter((value) =>
      (value as { id?: unknown; result?: unknown }).id === 72
      && "result" in (value as object))).toHaveLength(0);
    await expect(client.timeoutInteraction({ provider: requested.provider }))
      .resolves.toEqual({ responseWritten: true });
    expect(process.writes.at(-1)).toEqual({
      id: 72,
      error: { code: -32_008, message: "HRA interaction deadline expired" },
    });
    await client.close();
  });

  test("admits the exact manual response one millisecond before its deadline", async () => {
    let now = 30_000;
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    const facts: CodexFact[] = [];
    const client = createClient({
      process,
      authority: { profileId: "profile-a", processGeneration: 1 },
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      isAuthorityCurrent: () => true,
      connectionId: CONNECTION_ID,
      now: () => now,
      onFact: ({ value }) => { facts.push(value); },
    });
    await client.initialize();
    process.respond({
      id: 74,
      method: "item/commandExecution/requestApproval",
      params: { ...commandApprovalParams(), autoResolutionMs: 1_000 },
    });
    await waitFor(() => facts.some((fact) => fact.type === "interactionRequested"));
    const requested = facts.find((fact) => fact.type === "interactionRequested");
    if (requested?.type !== "interactionRequested" || requested.deadlineAt === undefined) {
      throw new Error("Missing provider interaction.");
    }
    now = requested.deadlineAt - 1;
    await expect(client.resolveInteraction({
      provider: requested.provider,
      kind: requested.kind,
      deadlineAt: requested.deadlineAt,
      resolution: { kind: "approval_decision", decision: "once" },
    })).resolves.toEqual({ responseWritten: true });
    expect(process.writes.at(-1)).toEqual({ id: 74, result: { decision: "accept" } });
    await client.close();
  });

  test("does not write a queued response after the provider resolves the request", async () => {
    let now = 20_000;
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    const facts: CodexFact[] = [];
    const client = createClient({
      process,
      authority: { profileId: "profile-a", processGeneration: 1 },
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      isAuthorityCurrent: () => true,
      connectionId: CONNECTION_ID,
      now: () => now,
      onFact: ({ value }) => { facts.push(value); },
    });
    await client.initialize();
    process.respond({
      id: 73,
      method: "item/commandExecution/requestApproval",
      params: { ...commandApprovalParams(), autoResolutionMs: 1_000 },
    });
    await waitFor(() => facts.some((fact) => fact.type === "interactionRequested"));
    const requested = facts.find((fact) => fact.type === "interactionRequested");
    if (requested?.type !== "interactionRequested" || requested.deadlineAt === undefined) {
      throw new Error("Missing provider interaction.");
    }

    let releaseWrite!: () => void;
    process.writeSettlementGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const blockingRead = client.accountRead();
    await waitFor(() => process.writes.some((value) =>
      (value as { method?: string }).method === "account/read"));
    const manualResponse = client.resolveInteraction({
      provider: requested.provider,
      kind: requested.kind,
      deadlineAt: requested.deadlineAt,
      resolution: { kind: "approval_decision", decision: "once" },
    });
    await Bun.sleep(1);
    process.respond({
      method: "serverRequest/resolved",
      params: { threadId: "thread-1", requestId: 73 },
    });
    await waitFor(() => facts.some((fact) => fact.type === "interactionResolved"));
    now = 20_001;
    releaseWrite();
    await blockingRead;

    await expect(manualResponse).rejects.toMatchObject({ code: "AUTHORITY_STALE" });
    expect(process.writes.filter((value) =>
      (value as { id?: unknown; result?: unknown }).id === 73
      && "result" in (value as object))).toHaveLength(0);
    await client.close();
  });

  test("does not write a queued timeout after the provider resolves the request", async () => {
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    const facts: CodexFact[] = [];
    const client = createClient({
      process,
      authority: { profileId: "profile-a", processGeneration: 1 },
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      isAuthorityCurrent: () => true,
      connectionId: CONNECTION_ID,
      onFact: ({ value }) => { facts.push(value); },
    });
    await client.initialize();
    process.respond({ id: 75, method: "item/commandExecution/requestApproval", params: commandApprovalParams() });
    await waitFor(() => facts.some((fact) => fact.type === "interactionRequested"));
    const requested = facts.find((fact) => fact.type === "interactionRequested");
    if (requested?.type !== "interactionRequested") throw new Error("Missing provider interaction.");

    let releaseWrite!: () => void;
    process.writeSettlementGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const blockingRead = client.accountRead();
    await waitFor(() => process.writes.some((value) =>
      (value as { method?: string }).method === "account/read"));
    const timeout = client.timeoutInteraction({ provider: requested.provider });
    await Bun.sleep(1);
    process.respond({
      method: "serverRequest/resolved",
      params: { threadId: "thread-1", requestId: 75 },
    });
    await waitFor(() => facts.some((fact) => fact.type === "interactionResolved"));
    releaseWrite();
    await blockingRead;
    await expect(timeout).rejects.toMatchObject({ code: "AUTHORITY_STALE" });
    expect(process.writes.filter((value) =>
      (value as { id?: unknown; error?: unknown }).id === 75
      && "error" in (value as object))).toHaveLength(0);
    await client.close();
  });

  test("reserves one response frame across concurrent manual and timeout attempts", async () => {
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    const facts: CodexFact[] = [];
    let race = false;
    let arrivals = 0;
    let releaseRace!: () => void;
    const raceGate = new Promise<void>((resolve) => { releaseRace = resolve; });
    const client = createClient({
      process,
      authority: { profileId: "profile-a", processGeneration: 1 },
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      isAuthorityCurrent: async () => {
        if (!race) return true;
        arrivals += 1;
        if (arrivals === 2) releaseRace();
        await raceGate;
        return true;
      },
      connectionId: CONNECTION_ID,
      onFact: ({ value }) => { facts.push(value); },
    });
    await client.initialize();
    process.respond({ id: 76, method: "item/commandExecution/requestApproval", params: commandApprovalParams() });
    await waitFor(() => facts.some((fact) => fact.type === "interactionRequested"));
    const requested = facts.find((fact) => fact.type === "interactionRequested");
    if (requested?.type !== "interactionRequested" || requested.deadlineAt === undefined) {
      throw new Error("Missing provider interaction.");
    }
    race = true;
    const outcomes = await Promise.allSettled([
      client.resolveInteraction({
        provider: requested.provider,
        kind: requested.kind,
        deadlineAt: requested.deadlineAt,
        resolution: { kind: "approval_decision", decision: "once" },
      }),
      client.timeoutInteraction({ provider: requested.provider }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(process.writes.filter((value) => (value as { id?: unknown }).id === 76)).toHaveLength(1);
    await client.close();
  });

  test("keeps an admitted manual write rejection unknown without dispatching a timeout", async () => {
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    const facts: CodexFact[] = [];
    const client = createClient({
      process,
      authority: { profileId: "profile-a", processGeneration: 1 },
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      isAuthorityCurrent: () => true,
      connectionId: CONNECTION_ID,
      onFact: ({ value }) => { facts.push(value); },
    });
    await client.initialize();
    process.respond({ id: 77, method: "item/commandExecution/requestApproval", params: commandApprovalParams() });
    await waitFor(() => facts.some((fact) => fact.type === "interactionRequested"));
    const requested = facts.find((fact) => fact.type === "interactionRequested");
    if (requested?.type !== "interactionRequested" || requested.deadlineAt === undefined) {
      throw new Error("Missing provider interaction.");
    }
    process.writeError = new Error("uncertain manual response write");
    await expect(client.resolveInteraction({
      provider: requested.provider,
      kind: requested.kind,
      deadlineAt: requested.deadlineAt,
      resolution: { kind: "approval_decision", decision: "once" },
    })).rejects.toMatchObject({ code: "INDETERMINATE_EFFECT" });
    await expect(client.timeoutInteraction({ provider: requested.provider }))
      .rejects.toMatchObject({ code: "AUTHORITY_STALE" });
    expect(process.writes.filter((value) =>
      (value as { id?: unknown; error?: unknown }).id === 77
      && "error" in (value as object))).toHaveLength(0);
    await client.close();
  });

  test("quarantines the provider generation when a timeout write may have escaped", async () => {
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    const facts: CodexFact[] = [];
    const client = createClient({
      process,
      authority: { profileId: "profile-a", processGeneration: 1 },
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      isAuthorityCurrent: () => true,
      connectionId: CONNECTION_ID,
      onFact: ({ value }) => { facts.push(value); },
    });
    await client.initialize();
    process.respond({ id: 52, method: "item/commandExecution/requestApproval", params: commandApprovalParams() });
    await waitFor(() => facts.some((fact) => fact.type === "interactionRequested"));
    const requested = facts.find((fact) => fact.type === "interactionRequested");
    if (requested?.type !== "interactionRequested") throw new Error("Missing interaction.");
    await client.validateInteractionTimeout({ provider: requested.provider });
    process.writeError = new Error("uncertain private pipe write");
    await expect(client.timeoutInteraction({ provider: requested.provider }))
      .rejects.toMatchObject({ code: "INDETERMINATE_EFFECT" });
    expect(client.state).toBe("failed");
    expect(process.signals).toContain("SIGTERM");
    await waitFor(() => facts.some((fact) =>
      fact.type === "providerDisconnected" && fact.reason === "protocol_fault"));
    await expect(client.timeoutInteraction({ provider: requested.provider }))
      .rejects.toMatchObject({ code: "AUTHORITY_STALE" });
    await client.close();
  });

  test("keeps numeric and string server request ids distinct", async () => {
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    const facts: CodexFact[] = [];
    const client = createClient({
      process,
      authority: { profileId: "profile-a", processGeneration: 1 },
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      isAuthorityCurrent: () => true,
      connectionId: CONNECTION_ID,
      onFact: ({ value }) => { facts.push(value); },
    });
    await client.initialize();
    process.respond({ id: 1, method: "item/commandExecution/requestApproval", params: commandApprovalParams("one") });
    process.respond({ id: "1", method: "item/commandExecution/requestApproval", params: { ...commandApprovalParams("two"), itemId: "item-2" } });
    await waitFor(() => facts.filter((fact) => fact.type === "interactionRequested").length === 2);
    expect(facts.filter((fact) => fact.type === "interactionRequested").map((fact) =>
      fact.provider.requestId)).toEqual([
      { type: "number", value: 1 },
      { type: "string", value: "1" },
    ]);
    await client.close();
  });

  test("does not block response reads while durable interaction admission is pending", async () => {
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    let releaseAdmission!: () => void;
    const admissionGate = new Promise<void>((resolve) => { releaseAdmission = resolve; });
    let admissionStarted = false;
    const client = createClient({
      process,
      authority: { profileId: "profile-a", processGeneration: 1 },
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      isAuthorityCurrent: () => true,
      connectionId: CONNECTION_ID,
      onFact: async ({ value }) => {
        if (value.type !== "interactionRequested") return;
        admissionStarted = true;
        await admissionGate;
      },
    });
    await client.initialize();
    process.respond({ id: 50, method: "item/commandExecution/requestApproval", params: commandApprovalParams() });
    await waitFor(() => admissionStarted);
    const account = await client.accountRead();
    expect(account.value.account).toMatchObject({ type: "chatgpt", planType: "pro" });
    releaseAdmission();
    await client.close();
  });

  test("quarantines a mutated same-id replay while accepting canonical key reordering", async () => {
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    const client = createClient({
      process,
      authority: { profileId: "profile-a", processGeneration: 1 },
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      isAuthorityCurrent: () => true,
      connectionId: CONNECTION_ID,
    });
    await client.initialize();
    const params = commandApprovalParams();
    process.respond({ id: 70, method: "item/commandExecution/requestApproval", params });
    process.respond({ id: 70, method: "item/commandExecution/requestApproval", params: Object.fromEntries(Object.entries(params).reverse()) });
    await Bun.sleep(2);
    expect(client.state).toBe("ready");
    process.respond({ id: 70, method: "item/commandExecution/requestApproval", params: commandApprovalParams("mutated") });
    await waitFor(() => client.state === "failed");
    expect(process.writes.at(-1)).toEqual({
      id: 70,
      error: { code: -32_609, message: "Conflicting server request replay" },
    });
    expect(process.signals).toContain("SIGTERM");
    await client.close();
  });

  test("binds feature and app discovery to the exact existing thread", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const process = new FakeProcess((message, target) => {
      if (message.method === "initialize") {
        target.respond({ id: message.id, result: { userAgent: "codex-cli/0.149.0", codexHome, platformFamily: "unix", platformOs: "macos" } });
      } else if (message.method === "model/list" || message.method === "experimentalFeature/list" || message.method === "permissionProfile/list" || message.method === "app/list") {
        target.respond({ id: message.id, result: { data: [], nextCursor: null } });
      }
    });
    const client = createClient({
      process,
      authority: { profileId: "profile-a", processGeneration: 1 },
      expectedCodexHome: codexHome,
      experimentalApi: true,
      isAuthorityCurrent: () => true,
    });
    await client.initialize();
    await client.discoverCapabilities({ cwd: "/workspace/project", threadId: "thread-1", includeExperimental: true });
    expect(process.writes.slice(3)).toEqual([
      { id: 3, method: "model/list", params: { includeHidden: true, limit: 100, cursor: null } },
      { id: 4, method: "experimentalFeature/list", params: { limit: 100, threadId: "thread-1", cursor: null } },
      { id: 5, method: "permissionProfile/list", params: { limit: 100, cwd: "/workspace/project", cursor: null } },
      { id: 6, method: "app/list", params: { limit: 100, forceRefetch: true, threadId: "thread-1", cursor: null } },
    ]);
    await client.close();
  });

  test("discovers plugins through the read-only pinned method and never sends a lifecycle effect", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const process = new FakeProcess((message, target) => {
      if (message.method === "initialize") {
        target.respond({ id: message.id, result: { userAgent: "codex-cli/0.149.0", codexHome, platformFamily: "unix", platformOs: "macos" } });
      } else if (message.method === "plugin/list") {
        target.respond({
          id: message.id,
          result: {
            marketplaces: [{
              name: "official",
              path: null,
              interface: null,
              plugins: [{
                id: "files@official",
                remotePluginId: null,
                version: null,
                localVersion: null,
                name: "files",
                shareContext: null,
                source: { type: "remote" },
                installed: false,
                installedAt: null,
                enabled: false,
                installPolicy: "AVAILABLE",
                installPolicySource: null,
                mustShowInstallationInterstitial: null,
                authPolicy: "ON_USE",
                availability: "AVAILABLE",
                disabledReason: null,
                eligiblePlanTypes: null,
                interface: null,
                keywords: [],
              }],
            }],
            marketplaceLoadErrors: [],
            featuredPluginIds: [],
          },
        });
      }
    });
    const client = createClient({
      process,
      authority: { profileId: "profile-a", processGeneration: 1 },
      expectedCodexHome: codexHome,
      experimentalApi: true,
      isAuthorityCurrent: () => true,
    });
    await client.initialize();
    expect((await client.listPlugins({ cwd: "/workspace/project", forceRefetch: true })).value)
      .toMatchObject({ marketplaces: [{ plugins: [{ id: "files@official" }] }] });
    expect(process.writes.slice(3)).toEqual([{
      id: 3,
      method: "plugin/list",
      params: { cwds: ["/workspace/project"], forceRefetch: true },
    }]);
    const methods = process.writes.map((frame) =>
      typeof frame === "object" && frame !== null && "method" in frame
        ? frame.method
        : undefined);
    expect(methods).not.toContain("plugin/install");
    expect(methods).not.toContain("plugin/enable");
    expect(methods).not.toContain("plugin/disable");
    expect(methods).not.toContain("mcpServer/oauth/login");
    await client.close();
  });

  test("sends exact pinned bounded turn and filtered item list parameters", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    let turnListCalls = 0;
    const process = new FakeProcess((message, target) => {
      if (message.method === "initialize") {
        target.respond({ id: message.id, result: { userAgent: "codex-cli/0.149.0", codexHome, platformFamily: "unix", platformOs: "macos" } });
      } else if (message.method === "thread/turns/list") {
        turnListCalls += 1;
        const turn = { id: "turn", items: [], status: "completed", startedAt: 1, completedAt: 2, durationMs: 1_000 };
        target.respond({ id: message.id, result: { data: turnListCalls === 1 ? [] : [turn, { ...turn, id: "turn-2" }], nextCursor: "older", backwardsCursor: "newer" } });
      } else if (message.method === "thread/items/list") {
        target.respond({ id: message.id, result: { data: [], nextCursor: null, backwardsCursor: "back" } });
      }
    });
    const client = createClient({
      process,
      authority: { profileId: "profile-a", processGeneration: 1 },
      expectedCodexHome: codexHome,
      experimentalApi: true,
      isAuthorityCurrent: () => true,
    });
    await client.initialize();
    await client.listThreadTurns({ threadId: "thread-1", cursor: "cursor", limit: 24, sortDirection: "desc", itemsView: "summary" });
    await client.listThreadItems({ threadId: "thread-1", turnId: "turn-1", cursor: null, limit: 64, sortDirection: "asc" });
    expect(process.writes.slice(3)).toEqual([
      { id: 3, method: "thread/turns/list", params: { threadId: "thread-1", cursor: "cursor", limit: 24, sortDirection: "desc", itemsView: "summary" } },
      { id: 4, method: "thread/items/list", params: { threadId: "thread-1", turnId: "turn-1", cursor: null, limit: 64, sortDirection: "asc" } },
    ]);
    await expect(client.listThreadTurns({ threadId: "thread-1", limit: 1 }))
      .rejects.toMatchObject({ code: "PROTOCOL_LIMIT" });
    await client.close();
  });

  test("fails closed on paginated history when experimental API was not negotiated", async () => {
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    const client = createClient({
      process,
      authority: { profileId: "profile-a", processGeneration: 1 },
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      isAuthorityCurrent: () => true,
    });
    await client.initialize();
    await expect(client.listThreadTurns({ threadId: "thread-1", limit: 24 })).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    expect(process.writes).toHaveLength(3);
    await client.close();
  });

  test("binds the exact named workspace profile and validates the effective thread response", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const thread = {
      id: "thread-1",
      sessionId: "thread-1",
      preview: "",
      ephemeral: false,
      modelProvider: "openai",
      createdAt: 1,
      updatedAt: 1,
      status: { type: "idle" },
      cwd: "/workspace/project",
      name: null,
      turns: [],
    };
    const process = new FakeProcess((message, target) => {
      if (message.method === "initialize") {
        target.respond({ id: message.id, result: { userAgent: "codex-cli/0.149.0", codexHome, platformFamily: "unix", platformOs: "macos" } });
      } else if (message.method === "thread/start") {
        target.respond({
          id: message.id,
          result: {
            thread,
            cwd: "/workspace/project",
            model: "gpt-5.6-sol",
            modelProvider: "openai",
            reasoningEffort: "max",
            serviceTier: "default",
            approvalPolicy: "on-request",
            approvalsReviewer: "auto_review",
            sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
            activePermissionProfile: { id: ":workspace", extends: null },
            runtimeWorkspaceRoots: ["/workspace/project"],
          },
        });
      }
    });
    const client = createClient({
      process,
      authority: { profileId: "profile-a", processGeneration: 1 },
      expectedCodexHome: codexHome,
      experimentalApi: true,
      isAuthorityCurrent: () => true,
    });
    await client.initialize();
    const result = await client.startThread({
      cwd: "/workspace/project",
      preset: { alias: "high", model: "gpt-5.6-sol", effort: "max", serviceTier: null, fast: false },
      policy: { review: "auto_review", permissionProfile: ":workspace", writableRoots: ["/workspace/project"] },
    });
    expect(result.value.activePermissionProfile?.id).toBe(":workspace");
    expect(process.writes.at(-1)).toEqual({
      id: 3,
      method: "thread/start",
      params: {
        model: "gpt-5.6-sol",
        serviceTier: null,
        cwd: "/workspace/project",
        permissions: ":workspace",
        runtimeWorkspaceRoots: ["/workspace/project"],
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        config: { model_reasoning_effort: "max" },
        ephemeral: false,
      },
    });
    await client.close();
  });

  test("classifies a thread response with a broader sandbox root as indeterminate", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const process = new FakeProcess((message, target) => {
      if (message.method === "initialize") {
        target.respond({ id: message.id, result: { userAgent: "codex-cli/0.149.0", codexHome, platformFamily: "unix", platformOs: "macos" } });
      } else if (message.method === "thread/start") {
        target.respond({ id: message.id, result: {
          thread: { id: "thread-unsafe", sessionId: "thread-unsafe", preview: "", ephemeral: false, modelProvider: "openai", createdAt: 1, updatedAt: 1, status: { type: "idle" }, cwd: "/workspace/project", name: null, turns: [] },
          cwd: "/workspace/project",
          model: "gpt-5.6-sol",
          modelProvider: "openai",
          reasoningEffort: "max",
          serviceTier: "default",
          approvalPolicy: "on-request",
          approvalsReviewer: "auto_review",
          sandbox: { type: "workspaceWrite", writableRoots: ["/"], networkAccess: false },
          activePermissionProfile: { id: ":workspace", extends: null },
          runtimeWorkspaceRoots: ["/workspace/project"],
        } });
      }
    });
    const client = createClient({ process, authority: { profileId: "profile-a", processGeneration: 1 }, expectedCodexHome: codexHome, experimentalApi: true, isAuthorityCurrent: () => true });
    await client.initialize();
    await expect(client.startThread({
      cwd: "/workspace/project",
      preset: { alias: "high", model: "gpt-5.6-sol", effort: "max", serviceTier: null, fast: false },
      policy: { review: "auto_review", permissionProfile: ":workspace", writableRoots: ["/workspace/project"] },
    })).rejects.toMatchObject({ code: "INDETERMINATE_EFFECT", operation: "thread/start" });
    await client.close();
  });

  test("bounds shutdown when TERM and stdout settlement are ignored", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const process = new FakeProcess(
      (message, target) => {
        if (message.method === "initialize") {
          target.respond({
            id: message.id,
            result: {
              userAgent: "codex-cli/0.149.0",
              codexHome,
              platformFamily: "unix",
              platformOs: "macos",
            },
          });
        }
      },
      { ignoreTerm: true, leaveStreamsOpenAfterKill: true },
    );
    const diagnostics: string[] = [];
    const client = createClient({
      process,
      authority: { profileId: "profile-a", processGeneration: 3 },
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => true,
      onSafeDiagnostic: (message) => diagnostics.push(message),
      shutdownTermGraceMs: 5,
      shutdownSettlementMs: 5,
    });
    await client.initialize();
    const mutation = client.renameThread("thread-1", "renamed").then(
      () => null,
      (caught: unknown) => caught,
    );
    await Bun.sleep(1);

    const closeOutcome = await Promise.race([
      Promise.all([client.close(), client.close()]).then(() => "closed" as const),
      Bun.sleep(500).then(() => "timed-out" as const),
    ]);
    const mutationError = await mutation;

    expect(closeOutcome).toBe("closed");
    expect(client.state).toBe("closed");
    expect(process.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(mutationError).toMatchObject({
      code: "INDETERMINATE_EFFECT",
      operation: "thread/name/set",
    });
    expect(diagnostics).toContain("Codex stdout did not settle after termination");
  });
});
