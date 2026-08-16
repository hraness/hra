import {
  CodexJsonlWriter,
  PinnedCodexProtocol,
  isPinnedCodexDynamicToolProbeWitness,
  type CodexGenerationEndReason,
  type PinnedCodexDynamicToolProtocolCapability,
  type PinnedCodexRequestOutput,
  type CodexRpcCallbacks,
  type CodexServerRequest,
  type SupervisedCodexGeneration,
} from "./codex";
import { hraReleaseIdentity } from "../release-identity";
import { childEnvironment, type RuntimePaths } from "./runtime-paths";

export type InitializedCodex = PinnedCodexRequestOutput<"clientInitialize">;

export interface CodexAppServerProcessOptions {
  readonly callbacks?: CodexRpcCallbacks;
  readonly dynamicToolCapability?: PinnedCodexDynamicToolProtocolCapability;
  readonly onServerRequest?: (
    process: CodexAppServerProcess,
    request: CodexServerRequest,
  ) => void | Promise<void>;
}

export interface CodexAppServerShutdownSteps {
  readonly expireProtocol: () => void | Promise<void>;
  readonly closeWriter: () => void | Promise<void>;
  readonly endStdin: () => void | Promise<void>;
  readonly exited: Promise<unknown>;
  readonly kill: (signal: "SIGTERM" | "SIGKILL") => void;
}

export interface CodexAppServerShutdownPolicy {
  readonly stepTimeoutMs?: number;
  readonly gracefulExitTimeoutMs?: number;
  readonly terminateExitTimeoutMs?: number;
}

/**
 * Finalize every process-owned resource before the generation may be treated
 * as fenced. Individual protocol, writer, stdin, and signal failures are
 * remembered, but none can skip the remaining cleanup or the final child-exit
 * proof.
 */
export async function finalizeCodexAppServerProcess(
  steps: CodexAppServerShutdownSteps,
  policy: CodexAppServerShutdownPolicy = {},
): Promise<void> {
  const stepTimeoutMs = positiveShutdownTimeout(policy.stepTimeoutMs, 1_000);
  const gracefulExitTimeoutMs = positiveShutdownTimeout(
    policy.gracefulExitTimeoutMs,
    1_000,
  );
  const terminateExitTimeoutMs = positiveShutdownTimeout(
    policy.terminateExitTimeoutMs,
    1_000,
  );
  const failures = new Set<string>();
  let exited = false;
  const exitProof = Promise.resolve(steps.exited).then(
    () => { exited = true; },
    () => {
      exited = true;
      failures.add("child_exit");
    },
  );

  await boundedShutdownStep("protocol", steps.expireProtocol, stepTimeoutMs, failures);
  await boundedShutdownStep("writer", steps.closeWriter, stepTimeoutMs, failures);
  await boundedShutdownStep("stdin", steps.endStdin, stepTimeoutMs, failures);

  if (!exited && !(await settlesWithin(exitProof, gracefulExitTimeoutMs))) {
    try {
      steps.kill("SIGTERM");
    } catch {
      failures.add("sigterm");
    }
    if (!exited && !(await settlesWithin(exitProof, terminateExitTimeoutMs))) {
      try {
        steps.kill("SIGKILL");
      } catch {
        failures.add("sigkill");
      }
    }
  }

  // This is the generation fence. Never resolve or reject before the child is
  // actually gone, including when every preceding shutdown step failed.
  await exitProof;
  if (failures.size > 0) {
    throw new Error(
      `Codex app-server shutdown completed with ${[...failures].sort().join(",")}`,
    );
  }
}

export class CodexAppServerProcess implements SupervisedCodexGeneration {
  readonly generation: number;
  readonly faulted: Promise<"process_exited" | "protocol_fault">;
  readonly #child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  readonly #dynamicToolCapability: PinnedCodexDynamicToolProtocolCapability | undefined;
  readonly #protocol: PinnedCodexProtocol;
  readonly #stdin: Bun.FileSink;
  readonly #writer: CodexJsonlWriter;
  #closePromise: Promise<void> | null = null;
  #initialized: InitializedCodex | null = null;
  #resolveFault: (reason: "process_exited" | "protocol_fault") => void = () => undefined;
  #stopping = false;

  private constructor(
    generation: number,
    paths: RuntimePaths,
    options: CodexAppServerProcessOptions,
  ) {
    this.generation = generation;
    const dynamicToolCapability = options.dynamicToolCapability;
    const protocolNowMs = Date.now();
    this.#dynamicToolCapability = dynamicToolCapability !== undefined &&
        options.callbacks?.onDynamicToolRequest !== undefined &&
        dynamicToolCapability.caller.accountGeneration === generation &&
        dynamicToolCapability.runtimeBinarySha256 ===
          dynamicToolCapability.witness.binarySha256 &&
        isPinnedCodexDynamicToolProbeWitness(dynamicToolCapability.witness, {
          binarySha256: dynamicToolCapability.runtimeBinarySha256,
          processGeneration: generation,
          nowMs: protocolNowMs,
        })
      ? dynamicToolCapability
      : undefined;
    this.faulted = new Promise((resolve) => {
      this.#resolveFault = resolve;
    });
    this.#child = Bun.spawn([paths.codexBinary, "app-server", "--stdio"], {
      cwd: paths.codexHome,
      env: childEnvironment(paths),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.#stdin = this.#child.stdin;
    this.#writer = new CodexJsonlWriter({
      write: (bytes) => this.#stdin.write(bytes),
      flush: () => this.#stdin.flush(),
    });
    const callbacks = options.callbacks;
    const onServerRequest = options.onServerRequest === undefined
      ? callbacks?.onServerRequest
      : async (request: CodexServerRequest) => {
          await options.onServerRequest?.(this, request);
        };
    const coreCallbacks: CodexRpcCallbacks = {
      ...callbacks,
      ...(onServerRequest === undefined ? {} : { onServerRequest }),
      onDiagnostic: async (diagnostic) => {
        if (
          diagnostic.type === "request_timeout" ||
          diagnostic.type === "invalid_envelope" ||
          diagnostic.type === "invalid_inbound_payload" ||
          diagnostic.type === "stream_position_exhausted"
        ) {
          // Fault before awaiting an observational callback. A callback that
          // stalls must not keep an unresponsive provider generation routable.
          this.#signalFault("protocol_fault");
        }
        await callbacks?.onDiagnostic?.(diagnostic);
      },
    };
    this.#protocol = new PinnedCodexProtocol(
      generation,
      this.#writer,
      coreCallbacks,
      this.#dynamicToolCapability === undefined
        ? {}
        : {
          dynamicTool: this.#dynamicToolCapability,
          now: () => protocolNowMs,
        },
    );
    void this.#readStdout();
    void this.#drainStderr();
    void this.#child.exited.then(() => {
      if (!this.#stopping) this.#signalFault("process_exited");
    });
  }

  static async start(
    generation: number,
    paths: RuntimePaths,
    options: CodexAppServerProcessOptions = {},
  ): Promise<CodexAppServerProcess> {
    const process = new CodexAppServerProcess(generation, paths, options);
    try {
      const initialized = await process.#protocol.request("clientInitialize", {
        clientInfo: {
          name: "hra",
          title: "HRA",
          version: hraReleaseIdentity.version,
        },
        capabilities: {
          experimentalApi: process.#dynamicToolCapability !== undefined,
          requestAttestation: false,
          optOutNotificationMethods: [],
        },
      });
      if (initialized.codexHome !== paths.codexHome) {
        throw new Error("Codex app-server reported an unexpected credential home");
      }
      process.#initialized = initialized;
      await process.#protocol.initialized();
      return process;
    } catch (error: unknown) {
      await process.expire("protocol_fault");
      void error;
      throw new Error("Codex app-server did not initialize");
    }
  }

  get initialized(): InitializedCodex {
    if (this.#initialized === null) throw new Error("Codex app-server is not initialized");
    return this.#initialized;
  }

  get protocol(): PinnedCodexProtocol {
    return this.#protocol;
  }

  expire(reason: CodexGenerationEndReason): Promise<void> {
    if (this.#closePromise === null) {
      this.#stopping = true;
      this.#closePromise = this.#close(reason);
    }
    return this.#closePromise;
  }

  async #readStdout(): Promise<void> {
    try {
      for await (const chunk of this.#child.stdout) {
        await this.#protocol.receiveChunk(this.generation, chunk);
      }
      if (!this.#stopping) await this.#protocol.finish(this.generation);
    } catch {
      if (!this.#stopping) this.#signalFault("protocol_fault");
    }
  }

  async #drainStderr(): Promise<void> {
    try {
      for await (const chunk of this.#child.stderr) {
        // Raw app-server diagnostics can contain paths, prompts, or secrets.
        void chunk;
      }
    } catch {
      // A redacted sink failure must not surface raw stderr bytes.
    }
  }

  #signalFault(reason: "process_exited" | "protocol_fault"): void {
    if (this.#stopping) return;
    this.#stopping = true;
    this.#resolveFault(reason);
    void this.#protocol.expire(reason);
    if (reason === "protocol_fault") this.#child.kill("SIGTERM");
  }

  async #close(reason: CodexGenerationEndReason): Promise<void> {
    await finalizeCodexAppServerProcess({
      expireProtocol: () => this.#protocol.expire(reason),
      closeWriter: () => this.#writer.close(),
      endStdin: async () => {
        try {
          await this.#stdin.end();
        } catch {
          // The child may already have closed its input.
        }
      },
      exited: this.#child.exited,
      kill: (signal) => { this.#child.kill(signal); },
    });
  }
}

function positiveShutdownTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Codex shutdown timeout must be a positive safe integer");
  }
  return value;
}

async function boundedShutdownStep(
  label: string,
  operation: () => void | Promise<void>,
  timeoutMs: number,
  failures: Set<string>,
): Promise<void> {
  const completed = Promise.resolve().then(operation).then(
    () => true,
    () => {
      failures.add(label);
      return true;
    },
  );
  if (!(await settlesWithin(completed, timeoutMs))) failures.add(`${label}_timeout`);
}

async function settlesWithin(task: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return await Promise.race([
    task.then(() => true),
    Bun.sleep(timeoutMs).then(() => false),
  ]);
}
