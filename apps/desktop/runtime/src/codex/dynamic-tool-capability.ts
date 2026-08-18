import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";

import { z } from "@hra-internal/schema";

import {
  accountProfileIdSchema,
  type AccountSummary,
} from "../../../contracts/runtime";
import { hraReleaseIdentity } from "../../release-identity";
import { childEnvironment, type RuntimePaths } from "../runtime-paths";
import { classifyCodex01446RemoteError } from "./compatibility-0-144-6";
import {
  MAX_CODEX_DYNAMIC_TOOL_PROBE_EVIDENCE_BYTES,
  HRA_DYNAMIC_TOOL_NAMESPACE,
  HRA_RLM_DYNAMIC_TOOL_NAME,
  HRA_RLM_DYNAMIC_TOOL_SPEC,
  HRA_RLM_DYNAMIC_TOOL_SPEC_SHA256,
  PINNED_CODEX_DYNAMIC_TOOL_PROBE_MAX_AGE_MS,
  PINNED_CODEX_DYNAMIC_TOOL_VERSION,
  PinnedCodexDynamicToolLedger,
  acceptPinnedCodexDynamicToolProbeWitness,
  dynamicToolCallKey,
  parsePinnedCodexDynamicToolCall,
  type PinnedCodexDynamicToolCall,
  type PinnedCodexDynamicToolEvidenceCustody,
} from "./dynamic-tool";
import {
  isCodexNotificationMethod,
  parseCodexNotification,
  pinnedCodexCodecPairs,
  pinnedCodexMethods,
  supportedCodexNotificationMethods,
  type ParsedCodexNotification,
  type PinnedCodexRequestShapes,
} from "./pinned-codecs";
import type { PinnedCodexDynamicToolProtocolCapability } from "./pinned-protocol";
import {
  HRA_PRODUCTION_EXECUTION_POLICY,
  verifyProductionExecutionPolicyRequirements,
  verifyProductionThreadAdmission,
  verifyProductionTurnAdmission,
  type ProductionExecutionPolicyProof,
  type ProductionExecutionPolicyReceipt,
} from "./production-execution-policy";
import {
  CodexRpcCore,
  type CodexProtocolDiagnostic,
  type CodexServerRequest,
  type CodexStreamPosition,
} from "./rpc-core";
import { CodexJsonlWriter } from "./writer";

const SHA_256_PATTERN = /^[a-f0-9]{64}$/u;
const PROBE_PROTOCOL_TIMEOUT_MS = 30_000;
const PROBE_TURN_TIMEOUT_MS = 90_000;
const PROBE_PROCESS_EXIT_TIMEOUT_MS = 2_000;
const VERSION_TIMEOUT_MS = 5_000;
const MAX_VERSION_OUTPUT_BYTES = 4_096;
const MAX_CODEX_BINARY_BYTES = 1_024 * 1_024 * 1_024;
const MAX_PROBE_EVENTS = 4_096;

type AccountProfileId = AccountSummary["id"];
type ProbeRequestKey = keyof PinnedCodexRequestShapes;

const positiveSafeIntegerSchema = z.number().int().positive().safe();
const absolutePathSchema = z.string().min(1).max(16_384).refine(isAbsolute);
const exactRegistrationSchema = z.object({
  initializeExperimentalApi: z.literal(true),
  carrierMethod: z.literal(pinnedCodexMethods.threadStart),
  paramsField: z.literal("dynamicTools"),
  namespace: z.literal(HRA_DYNAMIC_TOOL_NAMESPACE),
  tool: z.literal(HRA_RLM_DYNAMIC_TOOL_NAME),
  specSha256: z.literal(HRA_RLM_DYNAMIC_TOOL_SPEC_SHA256),
}).strict();
const exactObservationsSchema = z.object({
  registrationAccepted: z.literal(true),
  exactThreadAndTurnIdentity: z.literal(true),
  successfulCompletion: z.literal(true),
  failedCompletion: z.literal(true),
  cancellationResolution: z.literal(true),
  duplicateCallObserved: z.literal(true),
  duplicateCallRejected: z.literal(true),
  restartGenerationScoped: z.literal(true),
}).strict();
const lifecycleReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("oprte.codex.dynamic-tool.direct-lifecycle-receipt"),
  source: z.literal("signed-in-real-app-server"),
  runId: z.string().uuid(),
  startedAt: z.string().datetime({ offset: true }),
  finishedAt: z.string().datetime({ offset: true }),
  accountProfileId: accountProfileIdSchema,
  codexBinary: absolutePathSchema,
  codexHome: absolutePathSchema,
  codexVersion: z.literal(PINNED_CODEX_DYNAMIC_TOOL_VERSION),
  binarySha256: z.string().regex(SHA_256_PATTERN),
  processGeneration: positiveSafeIntegerSchema,
  registration: exactRegistrationSchema,
  observations: exactObservationsSchema,
}).strict().superRefine((value, context) => {
  if (Date.parse(value.finishedAt) < Date.parse(value.startedAt)) {
    context.addIssue({ code: "custom", message: "probe finished before it started" });
  }
});

const resolverInputSchema = z.object({
  accountProfileId: accountProfileIdSchema,
  generation: positiveSafeIntegerSchema,
  paths: z.object({
    codexBinary: absolutePathSchema,
    codexHome: absolutePathSchema,
    gitBinary: absolutePathSchema,
    gitRoot: absolutePathSchema,
  }).strict(),
}).strict();

const probeProgramSchema = z.object({
  probeStage: z.enum([
    "successful-completion",
    "failed-completion",
    "cancellation",
    "duplicate-replay",
    "process-restart",
  ]),
  probeToken: z.string().uuid(),
}).strict();

export interface PinnedCodexDynamicToolLifecycleProbeInput {
  readonly accountProfileId: AccountProfileId;
  readonly binarySha256: string;
  readonly codexVersion: typeof PINNED_CODEX_DYNAMIC_TOOL_VERSION;
  readonly paths: RuntimePaths;
  readonly processGeneration: number;
}

export interface PinnedCodexDynamicToolLifecycleProbe {
  run(input: PinnedCodexDynamicToolLifecycleProbeInput): Promise<unknown>;
}

export interface PinnedCodexDynamicToolCapabilityResolverInput {
  readonly accountProfileId: AccountProfileId;
  readonly generation: number;
  readonly paths: RuntimePaths;
}

export type PinnedCodexDynamicToolBinaryHasher = (
  absoluteBinaryPath: string,
) => Promise<unknown>;

export type PinnedCodexDynamicToolVersionReader = (
  paths: RuntimePaths,
) => Promise<unknown>;

export interface PinnedCodexDynamicToolCapabilityResolverOptions {
  /**
   * Tests may replace this trusted port. Production defaults to the direct,
   * credential-home-bound app-server lifecycle below.
   */
  readonly probe?: PinnedCodexDynamicToolLifecycleProbe;
  readonly hashBinary?: PinnedCodexDynamicToolBinaryHasher;
  readonly now?: () => number;
  readonly readVersion?: PinnedCodexDynamicToolVersionReader;
}

interface CapabilitySlot {
  readonly generation: number;
  readonly pathIdentity: string;
  readonly resolution: Promise<PinnedCodexDynamicToolProtocolCapability | null>;
}

/**
 * Produces at most one immutable capability decision for each account process
 * generation. A failed decision stays failed for that generation; only a
 * durable generation advance may probe again.
 */
export class PinnedCodexDynamicToolCapabilityResolver {
  readonly #hashBinary: PinnedCodexDynamicToolBinaryHasher;
  readonly #now: () => number;
  readonly #probe: PinnedCodexDynamicToolLifecycleProbe;
  readonly #readVersion: PinnedCodexDynamicToolVersionReader;
  readonly #slots = new Map<AccountProfileId, CapabilitySlot>();

  constructor(options: PinnedCodexDynamicToolCapabilityResolverOptions = {}) {
    this.#hashBinary = options.hashBinary ?? hashPinnedCodexBinary;
    this.#now = options.now ?? Date.now;
    this.#readVersion = options.readVersion ?? readPinnedCodexVersion;
    this.#probe = options.probe ?? new DirectPinnedCodexDynamicToolLifecycleProbe({
      now: this.#now,
    });
  }

  resolve(
    inputValue: PinnedCodexDynamicToolCapabilityResolverInput,
  ): Promise<PinnedCodexDynamicToolProtocolCapability | null> {
    const parsed = resolverInputSchema.safeParse(inputValue);
    if (!parsed.success) return Promise.resolve(null);
    const input = parsed.data;
    const pathIdentity = `${input.paths.codexBinary}\0${input.paths.codexHome}`;
    const prior = this.#slots.get(input.accountProfileId);
    if (prior !== undefined) {
      if (
        prior.generation === input.generation &&
        prior.pathIdentity === pathIdentity
      ) {
        return prior.resolution;
      }
      if (prior.generation >= input.generation) return Promise.resolve(null);
    }

    const resolution = this.#resolveOnce({
      accountProfileId: input.accountProfileId,
      generation: input.generation,
      paths: Object.freeze({ ...input.paths }),
    });
    this.#slots.set(input.accountProfileId, {
      generation: input.generation,
      pathIdentity,
      resolution,
    });
    return resolution;
  }

  async #resolveOnce(
    input: PinnedCodexDynamicToolCapabilityResolverInput,
  ): Promise<PinnedCodexDynamicToolProtocolCapability | null> {
    try {
      const startedAtMs = exactNow(this.#now);
      const beforeHash = parseSha256(await this.#hashBinary(input.paths.codexBinary));
      if (beforeHash === null) return null;
      const version = parsePinnedVersion(await this.#readVersion(input.paths));
      if (version === null) return null;
      const receiptValue = await this.#probe.run(Object.freeze({
        accountProfileId: input.accountProfileId,
        binarySha256: beforeHash,
        codexVersion: version,
        paths: input.paths,
        processGeneration: input.generation,
      }));
      const finishedAtMs = exactNow(this.#now);
      const receipt = lifecycleReceiptSchema.safeParse(receiptValue);
      if (!receipt.success) return null;
      const afterHash = parseSha256(await this.#hashBinary(input.paths.codexBinary));
      if (
        afterHash === null ||
        afterHash !== beforeHash ||
        receipt.data.accountProfileId !== input.accountProfileId ||
        receipt.data.codexBinary !== input.paths.codexBinary ||
        receipt.data.codexHome !== input.paths.codexHome ||
        receipt.data.binarySha256 !== beforeHash ||
        receipt.data.codexVersion !== version ||
        receipt.data.processGeneration !== input.generation ||
        !receiptTimeIsBounded(receipt.data, startedAtMs, finishedAtMs)
      ) {
        return null;
      }

      const payload = Object.freeze({
        schemaVersion: 1 as const,
        kind: "oprte.codex.dynamic-tool.real-probe-witness" as const,
        source: "signed-in-real-app-server" as const,
        runId: receipt.data.runId,
        startedAt: receipt.data.startedAt,
        finishedAt: receipt.data.finishedAt,
        codexVersion: PINNED_CODEX_DYNAMIC_TOOL_VERSION,
        binarySha256: beforeHash,
        processGeneration: input.generation,
        registration: Object.freeze({ ...receipt.data.registration }),
        observations: Object.freeze({ ...receipt.data.observations }),
      });
      const bytes = new TextEncoder().encode(JSON.stringify(payload));
      if (
        bytes.byteLength === 0 ||
        bytes.byteLength > MAX_CODEX_DYNAMIC_TOOL_PROBE_EVIDENCE_BYTES
      ) {
        return null;
      }
      const digest = createHash("sha256").update(bytes).digest("hex");
      const custody = new GenerationMemoryEvidenceCustody({
        binarySha256: beforeHash,
        bytes,
        digest,
        processGeneration: input.generation,
        runId: receipt.data.runId,
      });
      try {
        const witness = await acceptPinnedCodexDynamicToolProbeWitness(
          { ...payload, evidenceObjectDigest: digest },
          {
            binarySha256: beforeHash,
            processGeneration: input.generation,
            nowMs: finishedAtMs,
          },
          custody,
        );
        return witness === null
          ? null
          : Object.freeze({
              witness,
              caller: Object.freeze({
                accountProfileId: input.accountProfileId,
                accountGeneration: input.generation,
              }),
              runtimeBinarySha256: beforeHash,
            });
      } finally {
        custody.destroy();
      }
    } catch {
      return null;
    }
  }
}

export function createPinnedCodexDynamicToolCapabilityResolver(
  options: PinnedCodexDynamicToolCapabilityResolverOptions = {},
): (
  input: PinnedCodexDynamicToolCapabilityResolverInput,
) => Promise<PinnedCodexDynamicToolProtocolCapability | null> {
  const resolver = new PinnedCodexDynamicToolCapabilityResolver(options);
  return (input) => resolver.resolve(input);
}

interface MemoryEvidenceInput {
  readonly binarySha256: string;
  readonly bytes: Uint8Array;
  readonly digest: string;
  readonly processGeneration: number;
  readonly runId: string;
}

class GenerationMemoryEvidenceCustody
  implements PinnedCodexDynamicToolEvidenceCustody {
  readonly #binarySha256: string;
  readonly #digest: string;
  readonly #processGeneration: number;
  readonly #runId: string;
  #bytes: Uint8Array | null;

  constructor(input: MemoryEvidenceInput) {
    this.#binarySha256 = input.binarySha256;
    this.#bytes = input.bytes.slice();
    this.#digest = input.digest;
    this.#processGeneration = input.processGeneration;
    this.#runId = input.runId;
  }

  readVerifiedProbeEvidence(input: Readonly<{
    digest: string;
    runId: string;
    binarySha256: string;
    processGeneration: number;
  }>): Promise<Readonly<{ digest: string; bytes: Uint8Array }> | null> {
    const bytes = this.#bytes;
    return Promise.resolve(
      bytes !== null &&
        input.digest === this.#digest &&
        input.runId === this.#runId &&
        input.binarySha256 === this.#binarySha256 &&
        input.processGeneration === this.#processGeneration
        ? { digest: this.#digest, bytes: bytes.slice() }
        : null,
    );
  }

  destroy(): void {
    this.#bytes?.fill(0);
    this.#bytes = null;
  }
}

export interface DirectPinnedCodexDynamicToolLifecycleProbeOptions {
  readonly now?: () => number;
  readonly randomUuid?: () => string;
}

/**
 * Credentialed, model-consuming preflight. It is invoked only by explicit
 * runtime composition of the resolver and never by module import, an
 * environment flag, a fixture, or a persisted evidence file.
 */
export class DirectPinnedCodexDynamicToolLifecycleProbe
  implements PinnedCodexDynamicToolLifecycleProbe {
  readonly #now: () => number;
  readonly #randomUuid: () => string;

  constructor(options: DirectPinnedCodexDynamicToolLifecycleProbeOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#randomUuid = options.randomUuid ?? randomUUID;
  }

  async run(input: PinnedCodexDynamicToolLifecycleProbeInput): Promise<unknown> {
    const startedAtMs = exactNow(this.#now);
    const root = await mkdtemp(join(tmpdir(), "hra-dynamic-tool-probe-"));
    const cwd = await realpath(root);
    let threadId: string | null = null;
    let current: DirectProbeGeneration | null = null;
    try {
      current = await DirectProbeGeneration.start(1, input.paths);
      await current.requireSignedIn();
      threadId = await current.startThread(cwd);

      const successful = await current.startCall(
        threadId,
        "successful-completion",
        this.#uuid(),
      );
      await current.completeCall(successful, true);

      const failed = await current.startCall(
        threadId,
        "failed-completion",
        this.#uuid(),
      );
      await current.completeCall(failed, false);

      const cancellation = await current.startCall(
        threadId,
        "cancellation",
        this.#uuid(),
      );
      await current.cancelCall(cancellation);

      const duplicate = await current.startCall(
        threadId,
        "duplicate-replay",
        this.#uuid(),
      );
      await current.rejectDuplicateReplay(duplicate, cwd);
      await current.close();

      current = await DirectProbeGeneration.start(2, input.paths);
      await current.requireSignedIn();
      await current.resumeThread(threadId, cwd);
      const beforeRestart = await current.startCall(
        threadId,
        "process-restart",
        this.#uuid(),
      );
      const expiredGeneration = current;
      await expiredGeneration.close();

      current = await DirectProbeGeneration.start(3, input.paths);
      await current.requireSignedIn();
      const replayAfter = current.eventOrdinal;
      await current.resumeThread(threadId, cwd);
      const afterRestart = await current.waitForSameCall(beforeRestart, replayAfter);
      const staleRejected = await expiredGeneration.staleResponseIsRejected(beforeRestart);
      if (!staleRejected) throw new Error("stale probe generation retained response authority");
      await current.completeCall(afterRestart, true);
      await current.archiveThread(threadId);
      threadId = null;

      const finishedAtMs = exactNow(this.#now);
      return Object.freeze({
        schemaVersion: 1 as const,
        kind: "oprte.codex.dynamic-tool.direct-lifecycle-receipt" as const,
        source: "signed-in-real-app-server" as const,
        runId: this.#uuid(),
        startedAt: new Date(startedAtMs).toISOString(),
        finishedAt: new Date(finishedAtMs).toISOString(),
        accountProfileId: input.accountProfileId,
        codexBinary: input.paths.codexBinary,
        codexHome: input.paths.codexHome,
        codexVersion: input.codexVersion,
        binarySha256: input.binarySha256,
        processGeneration: input.processGeneration,
        registration: Object.freeze({
          initializeExperimentalApi: true as const,
          carrierMethod: pinnedCodexMethods.threadStart,
          paramsField: "dynamicTools" as const,
          namespace: HRA_DYNAMIC_TOOL_NAMESPACE,
          tool: HRA_RLM_DYNAMIC_TOOL_NAME,
          specSha256: HRA_RLM_DYNAMIC_TOOL_SPEC_SHA256,
        }),
        observations: Object.freeze({
          registrationAccepted: true as const,
          exactThreadAndTurnIdentity: true as const,
          successfulCompletion: true as const,
          failedCompletion: true as const,
          cancellationResolution: true as const,
          duplicateCallObserved: true as const,
          duplicateCallRejected: true as const,
          restartGenerationScoped: true as const,
        }),
      });
    } finally {
      if (threadId !== null && current !== null) {
        await current.archiveThread(threadId).catch(() => undefined);
      }
      await current?.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  #uuid(): string {
    return z.string().uuid().parse(this.#randomUuid());
  }
}

interface ProbeDynamicCall {
  readonly call: PinnedCodexDynamicToolCall;
  readonly ordinal: number;
  readonly request: CodexServerRequest;
}

type ProbeEvent =
  | Readonly<{
      kind: "notification";
      ordinal: number;
      notification: ParsedCodexNotification;
    }>
  | Readonly<{ kind: "call"; ordinal: number; value: ProbeDynamicCall }>
  | Readonly<{
      kind: "duplicate_rejected";
      ordinal: number;
      callKey: string;
      requestId: string | number;
    }>;

interface ProbeWaiter {
  readonly afterOrdinal: number;
  readonly predicate: (event: ProbeEvent) => boolean;
  readonly reject: (error: Error) => void;
  readonly resolve: (event: ProbeEvent) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

class DirectProbeGeneration {
  readonly #child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  readonly #core: CodexRpcCore;
  readonly #events: ProbeEvent[] = [];
  readonly #ledger = new PinnedCodexDynamicToolLedger();
  readonly #threadPolicyReceipts = new Map<string, ProductionExecutionPolicyReceipt>();
  readonly #stderrTask: Promise<void>;
  readonly #stdoutTask: Promise<void>;
  readonly #waiters = new Set<ProbeWaiter>();
  readonly #writer: CodexJsonlWriter;
  #closePromise: Promise<void> | null = null;
  #closed = false;
  #failure: Error | null = null;
  #nextOrdinal = 1;
  #permittedDuplicateProtocolFault = false;

  private constructor(generation: number, paths: RuntimePaths) {
    this.#child = Bun.spawn([paths.codexBinary, "app-server", "--stdio"], {
      cwd: paths.codexHome,
      env: childEnvironment(paths),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.#writer = new CodexJsonlWriter({
      write: (bytes) => this.#child.stdin.write(bytes),
      flush: () => this.#child.stdin.flush(),
    });
    this.#core = new CodexRpcCore(
      generation,
      this.#writer,
      {
        onNotification: async (notification) => {
          if (!isCodexNotificationMethod(notification.method)) {
            this.#fail();
            return;
          }
          const parsed = parseCodexNotification(
            notification.method,
            notification.params,
          );
          if (parsed === null) {
            this.#fail();
            return;
          }
          if (parsed.method === "serverRequest/resolved") {
            await this.#core.resolveServerRequest(parsed.params.requestId);
          }
          if (
            parsed.method === "turn/completed" ||
            parsed.method === "serverRequest/resolved"
          ) {
            this.#push({
              kind: "notification",
              ordinal: this.#ordinal(),
              notification: parsed,
            });
          }
        },
        onServerRequest: async (request) => {
          if (request.method !== "item/tool/call") {
            this.#fail();
            return;
          }
          const call = parsePinnedCodexDynamicToolCall(request.params);
          if (call === null) {
            await this.#core.respond(request, {
              type: "error",
              code: -32_602,
              message: "Invalid dynamic tool probe call",
            });
            this.#fail();
            return;
          }
          const admission = this.#ledger.admit(request.generation, call);
          if (admission.kind === "replay_conflict") {
            await this.#core.respond(request, {
              type: "error",
              code: -32_609,
              message: "Conflicting dynamic tool probe replay",
            });
            this.#fail();
            return;
          }
          if (admission.kind === "duplicate") {
            await this.#core.respond(request, {
              type: "error",
              code: -32_609,
              message: "Duplicate dynamic tool probe call",
            });
            this.#push({
              kind: "duplicate_rejected",
              ordinal: this.#ordinal(),
              callKey: admission.key,
              requestId: request.id,
            });
            return;
          }
          const value: ProbeDynamicCall = {
            call,
            ordinal: this.#ordinal(),
            request,
          };
          this.#push({ kind: "call", ordinal: value.ordinal, value });
        },
        onDiagnostic: (diagnostic) => {
          if (!this.#diagnosticIsPermittedDuplicate(diagnostic)) this.#fail();
        },
        onServerRequestExpired: (fault) => {
          if (fault.reason === "duplicate_id") {
            this.#permittedDuplicateProtocolFault = true;
            this.#push({
              kind: "duplicate_rejected",
              ordinal: this.#ordinal(),
              callKey: "same-request-id",
              requestId: fault.requestId ?? "missing",
            });
            return;
          }
          if (fault.reason !== "generation_ended" && fault.reason !== "resolved_elsewhere") {
            this.#fail();
          }
        },
      },
      {
        classifyRemoteError: classifyCodex01446RemoteError,
        notificationMethods: supportedCodexNotificationMethods,
        serverRequestMethods: ["item/tool/call"],
      },
    );
    this.#stdoutTask = this.#readStdout();
    this.#stderrTask = this.#drainStderr();
    void this.#child.exited.then(() => {
      if (!this.#closed) this.#fail();
    });
  }

  static async start(
    generation: number,
    paths: RuntimePaths,
  ): Promise<DirectProbeGeneration> {
    const instance = new DirectProbeGeneration(generation, paths);
    try {
      const initialized = await instance.#request("clientInitialize", {
        clientInfo: {
          name: "hra",
          title: "HRA",
          version: hraReleaseIdentity.version,
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          optOutNotificationMethods: [],
        },
      });
      if (initialized.codexHome !== paths.codexHome) {
        throw new Error("probe initialized against a different credential home");
      }
      await instance.#core.notify("initialized");
      return instance;
    } catch {
      await instance.close().catch(() => undefined);
      throw new Error("dynamic tool probe process did not initialize");
    }
  }

  get eventOrdinal(): number {
    return this.#nextOrdinal - 1;
  }

  async requireSignedIn(): Promise<void> {
    const account = await this.#request("accountRead", { refreshToken: false });
    if (account.account === null) throw new Error("probe account is signed out");
  }

  async startThread(cwd: string): Promise<string> {
    const proof = await this.#preflightProductionPolicy();
    const input = pinnedCodexCodecPairs.threadStart.input.parse({
      cwd,
      approvalPolicy: HRA_PRODUCTION_EXECUTION_POLICY.approvalPolicy,
      approvalsReviewer: HRA_PRODUCTION_EXECUTION_POLICY.approvalsReviewer,
      sandbox: HRA_PRODUCTION_EXECUTION_POLICY.threadSandbox,
      developerInstructions:
        "This is an HRA protocol proof. For each user request, call " +
        "oprte/rlm_run exactly once with the exact JSON arguments provided, " +
        "wait for its result, and do not invoke any other tool.",
      ephemeral: false,
      historyMode: "paginated",
      threadSource: "appServer",
    });
    const raw = await this.#core.requestWithResponsePosition(
      pinnedCodexMethods.threadStart,
      {
        ...input,
        dynamicTools: [HRA_RLM_DYNAMIC_TOOL_SPEC],
      },
      { intent: "ambiguousMutation", timeoutMs: PROBE_PROTOCOL_TIMEOUT_MS },
    );
    const response = pinnedCodexCodecPairs.threadStart.output.parse(raw.result);
    const receipt = verifyProductionThreadAdmission({
      proof,
      generation: raw.generation,
      streamPosition: raw.streamPosition,
      request: input,
      response,
    });
    this.#threadPolicyReceipts.set(response.thread.id, receipt);
    return response.thread.id;
  }

  async resumeThread(threadId: string, cwd: string): Promise<void> {
    const proof = await this.#preflightProductionPolicy();
    const input = pinnedCodexCodecPairs.threadResume.input.parse({
      threadId,
      cwd,
      approvalPolicy: HRA_PRODUCTION_EXECUTION_POLICY.approvalPolicy,
      approvalsReviewer: HRA_PRODUCTION_EXECUTION_POLICY.approvalsReviewer,
      sandbox: HRA_PRODUCTION_EXECUTION_POLICY.threadSandbox,
      developerInstructions:
        "This is an HRA protocol proof. Call oprte/rlm_run exactly as requested.",
    });
    const positioned = await this.#requestWithResponsePosition("threadResume", input);
    const receipt = verifyProductionThreadAdmission({
      proof,
      generation: positioned.generation,
      streamPosition: positioned.streamPosition,
      request: input,
      response: positioned.output,
    });
    this.#threadPolicyReceipts.set(positioned.output.thread.id, receipt);
  }

  async startCall(
    threadId: string,
    stage: z.infer<typeof probeProgramSchema>["probeStage"],
    token: string,
  ): Promise<ProbeDynamicCall> {
    const afterOrdinal = this.eventOrdinal;
    const threadReceipt = this.#threadPolicyReceipts.get(threadId);
    if (threadReceipt === undefined) {
      throw new Error("dynamic tool probe thread lacks a verified production policy");
    }
    const proof = await this.#preflightProductionPolicy();
    const input = pinnedCodexCodecPairs.turnStart.input.parse({
      threadId,
      clientUserMessageId: `hra-dynamic-tool-probe-${token}`,
      input: [{
        type: "text",
        text:
          `Call oprte/rlm_run exactly once with ` +
          `${JSON.stringify({
            schemaVersion: 1,
            action: "submit",
            program: { probeStage: stage, probeToken: token },
          })} and wait for its result.`,
        text_elements: [],
      }],
      approvalPolicy: HRA_PRODUCTION_EXECUTION_POLICY.approvalPolicy,
      approvalsReviewer: HRA_PRODUCTION_EXECUTION_POLICY.approvalsReviewer,
      sandboxPolicy: HRA_PRODUCTION_EXECUTION_POLICY.turnSandboxPolicy,
    });
    const result = await this.#requestWithResponsePosition("turnStart", input);
    verifyProductionTurnAdmission({
      proof,
      threadReceipt,
      generation: result.generation,
      streamPosition: result.streamPosition,
      request: input,
    });
    const event = await this.#waitFor(
      (candidate) =>
        candidate.kind === "call" &&
        candidate.value.call.threadId === threadId &&
        candidate.value.call.turnId === result.output.turn.id,
      afterOrdinal,
      PROBE_TURN_TIMEOUT_MS,
    );
    if (event.kind !== "call") throw new Error("dynamic tool probe call was absent");
    const argumentsValue = event.value.call.arguments;
    if (argumentsValue.action !== "submit") {
      throw new Error("dynamic tool probe used the wrong action");
    }
    const program = probeProgramSchema.safeParse(argumentsValue.program);
    if (
      !program.success ||
      program.data.probeStage !== stage ||
      program.data.probeToken !== token
    ) {
      throw new Error("dynamic tool probe arguments lost exact identity");
    }
    return event.value;
  }

  async completeCall(call: ProbeDynamicCall, success: boolean): Promise<void> {
    await this.#core.respond(call.request, {
      type: "result",
      result: {
        contentItems: [{
          type: "inputText",
          text: success ? "probe-success" : "probe-failure",
        }],
        success,
      },
    });
    const event = await this.#waitFor(
      (candidate) =>
        candidate.kind === "notification" &&
        candidate.notification.method === "turn/completed" &&
        candidate.notification.params.threadId === call.call.threadId &&
        candidate.notification.params.turn.id === call.call.turnId,
      call.ordinal,
      PROBE_TURN_TIMEOUT_MS,
    );
    if (
      event.kind !== "notification" ||
      event.notification.method !== "turn/completed"
    ) {
      throw new Error("dynamic tool probe turn did not terminate");
    }
  }

  async cancelCall(call: ProbeDynamicCall): Promise<void> {
    const afterOrdinal = this.eventOrdinal;
    await this.#request("turnInterrupt", {
      threadId: call.call.threadId,
      turnId: call.call.turnId,
    });
    await this.#waitFor(
      (candidate) =>
        candidate.kind === "notification" &&
        (candidate.notification.method === "turn/completed"
          ? candidate.notification.params.threadId === call.call.threadId &&
            candidate.notification.params.turn.id === call.call.turnId
          : candidate.notification.method === "serverRequest/resolved" &&
            candidate.notification.params.threadId === call.call.threadId &&
            candidate.notification.params.requestId === call.request.id),
      afterOrdinal,
      PROBE_TURN_TIMEOUT_MS,
    );
  }

  async rejectDuplicateReplay(call: ProbeDynamicCall, cwd: string): Promise<void> {
    const afterOrdinal = this.eventOrdinal;
    const expectedCallKey = dynamicToolCallKey(this.#core.generation, call.call);
    const resume = this.resumeThread(call.call.threadId, cwd).catch(() => undefined);
    const event = await this.#waitFor(
      (candidate) =>
        candidate.kind === "duplicate_rejected" &&
        (candidate.callKey === "same-request-id" ||
          candidate.callKey === expectedCallKey),
      afterOrdinal,
      PROBE_PROTOCOL_TIMEOUT_MS,
    );
    await resume;
    if (event.kind !== "duplicate_rejected") {
      throw new Error("dynamic tool duplicate replay was not rejected");
    }
    try {
      await this.cancelCall(call);
    } catch {
      if (!this.#permittedDuplicateProtocolFault) throw new Error(
        "dynamic tool duplicate turn did not terminate",
      );
    }
  }

  waitForSameCall(
    call: ProbeDynamicCall,
    afterOrdinal: number,
  ): Promise<ProbeDynamicCall> {
    return this.#waitFor(
      (candidate) =>
        candidate.kind === "call" &&
        candidate.value.call.threadId === call.call.threadId &&
        candidate.value.call.turnId === call.call.turnId &&
        candidate.value.call.callId === call.call.callId &&
        candidate.value.call.argumentsSha256 === call.call.argumentsSha256,
      afterOrdinal,
      PROBE_TURN_TIMEOUT_MS,
    ).then((event) => {
      if (event.kind !== "call") throw new Error("restart probe call was absent");
      return event.value;
    });
  }

  async staleResponseIsRejected(call: ProbeDynamicCall): Promise<boolean> {
    try {
      await this.#core.respond(call.request, {
        type: "result",
        result: {
          contentItems: [{ type: "inputText", text: "stale-probe-response" }],
          success: true,
        },
      });
      return false;
    } catch {
      return true;
    }
  }

  async archiveThread(threadId: string): Promise<void> {
    const value = await this.#core.request(
      "thread/archive",
      { threadId },
      { intent: "ambiguousMutation", timeoutMs: PROBE_PROTOCOL_TIMEOUT_MS },
    );
    z.object({}).strict().parse(value);
  }

  close(): Promise<void> {
    if (this.#closePromise === null) this.#closePromise = this.#close();
    return this.#closePromise;
  }

  async #request<K extends ProbeRequestKey>(
    key: K,
    input: PinnedCodexRequestShapes[K]["input"],
  ): Promise<PinnedCodexRequestShapes[K]["output"]> {
    return (await this.#requestWithResponsePosition(key, input)).output;
  }

  async #requestWithResponsePosition<K extends ProbeRequestKey>(
    key: K,
    input: PinnedCodexRequestShapes[K]["input"],
  ): Promise<Readonly<{
    readonly generation: number;
    readonly output: PinnedCodexRequestShapes[K]["output"];
    readonly streamPosition: CodexStreamPosition;
  }>> {
    this.#throwIfFailed();
    const params = pinnedCodexCodecPairs[key].input.parse(input);
    const result = await this.#core.requestWithResponsePosition(
      pinnedCodexMethods[key],
      params,
      {
        intent: key === "threadStart" ||
            key === "threadResume" ||
            key === "turnStart" ||
            key === "turnInterrupt"
          ? "ambiguousMutation"
          : "read",
        timeoutMs: PROBE_PROTOCOL_TIMEOUT_MS,
      },
    );
    return {
      generation: result.generation,
      output: pinnedCodexCodecPairs[key].output.parse(result.result),
      streamPosition: result.streamPosition,
    };
  }

  async #preflightProductionPolicy(): Promise<ProductionExecutionPolicyProof> {
    const positioned = await this.#requestWithResponsePosition(
      "configRequirementsRead",
      undefined,
    );
    return verifyProductionExecutionPolicyRequirements({
      generation: positioned.generation,
      streamPosition: positioned.streamPosition,
      output: positioned.output,
    });
  }

  #waitFor(
    predicate: (event: ProbeEvent) => boolean,
    afterOrdinal: number,
    timeoutMs: number,
  ): Promise<ProbeEvent> {
    this.#throwIfFailed();
    const existing = this.#events.find(
      (event) => event.ordinal > afterOrdinal && predicate(event),
    );
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter: ProbeWaiter = {
        afterOrdinal,
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#waiters.delete(waiter);
          reject(new Error("dynamic tool probe observation timed out"));
        }, timeoutMs),
      };
      this.#waiters.add(waiter);
    });
  }

  #push(event: ProbeEvent): void {
    this.#events.push(event);
    if (this.#events.length > MAX_PROBE_EVENTS) {
      this.#fail();
      return;
    }
    for (const waiter of this.#waiters) {
      if (event.ordinal <= waiter.afterOrdinal || !waiter.predicate(event)) continue;
      clearTimeout(waiter.timer);
      this.#waiters.delete(waiter);
      waiter.resolve(event);
    }
  }

  #ordinal(): number {
    const ordinal = this.#nextOrdinal;
    if (!Number.isSafeInteger(ordinal) || ordinal <= 0) {
      this.#fail();
      throw new Error("dynamic tool probe event bound exhausted");
    }
    this.#nextOrdinal += 1;
    return ordinal;
  }

  #diagnosticIsPermittedDuplicate(diagnostic: CodexProtocolDiagnostic): boolean {
    return this.#permittedDuplicateProtocolFault &&
      diagnostic.type === "invalid_inbound_payload" &&
      diagnostic.source === "server_request" &&
      diagnostic.method === "item/tool/call";
  }

  #fail(): void {
    if (this.#failure !== null || this.#closed) return;
    this.#failure = new Error("dynamic tool probe protocol failed");
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(this.#failure);
    }
    this.#waiters.clear();
  }

  #throwIfFailed(): void {
    if (this.#failure !== null) throw this.#failure;
    if (this.#closed) throw new Error("dynamic tool probe generation is closed");
  }

  async #readStdout(): Promise<void> {
    try {
      for await (const chunk of this.#child.stdout) {
        await this.#core.receiveChunk(this.#core.generation, chunk);
      }
      if (!this.#closed) await this.#core.finish(this.#core.generation);
    } catch {
      this.#fail();
    }
  }

  async #drainStderr(): Promise<void> {
    try {
      for await (const chunk of this.#child.stderr) void chunk;
    } catch {
      this.#fail();
    }
  }

  async #close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("dynamic tool probe generation closed"));
    }
    this.#waiters.clear();
    await this.#core.expire("stopped").catch(() => undefined);
    await this.#writer.close().catch(() => undefined);
    try {
      await this.#child.stdin.end();
    } catch {
      // The app-server may already have closed its input.
    }
    if (!(await settlesWithin(this.#child.exited, PROBE_PROCESS_EXIT_TIMEOUT_MS))) {
      this.#child.kill("SIGTERM");
      if (!(await settlesWithin(this.#child.exited, PROBE_PROCESS_EXIT_TIMEOUT_MS))) {
        this.#child.kill("SIGKILL");
      }
    }
    await this.#child.exited;
    await Promise.allSettled([this.#stdoutTask, this.#stderrTask]);
  }
}

async function hashPinnedCodexBinary(path: string): Promise<string | null> {
  try {
    const file = Bun.file(path);
    if (file.size <= 0 || file.size > MAX_CODEX_BINARY_BYTES) return null;
    const hasher = new Bun.CryptoHasher("sha256");
    for await (const chunk of file.stream()) hasher.update(chunk);
    return hasher.digest("hex");
  } catch {
    return null;
  }
}

async function readPinnedCodexVersion(paths: RuntimePaths): Promise<string | null> {
  const child = Bun.spawn([paths.codexBinary, "--version"], {
    cwd: paths.codexHome,
    env: childEnvironment(paths),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = readBounded(child.stdout, MAX_VERSION_OUTPUT_BYTES);
  const stderr = readBounded(child.stderr, MAX_VERSION_OUTPUT_BYTES);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Codex version probe timed out"));
    }, VERSION_TIMEOUT_MS);
  });
  try {
    const [exitCode, bytes] = await Promise.race([
      Promise.all([child.exited, stdout, stderr]).then(([code, output]) => [
        code,
        output,
      ] as const),
      timeout,
    ]);
    if (exitCode !== 0) return null;
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
    const match = /^(?:codex-cli\s+)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u.exec(raw);
    return match?.[1] ?? null;
  } catch {
    child.kill("SIGKILL");
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await child.exited.catch(() => undefined);
  }
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("bounded process output exceeded its limit");
    }
    chunks.push(next.value.slice());
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function parseSha256(value: unknown): string | null {
  return typeof value === "string" && SHA_256_PATTERN.test(value) ? value : null;
}

function parsePinnedVersion(
  value: unknown,
): typeof PINNED_CODEX_DYNAMIC_TOOL_VERSION | null {
  return value === PINNED_CODEX_DYNAMIC_TOOL_VERSION
    ? PINNED_CODEX_DYNAMIC_TOOL_VERSION
    : null;
}

function exactNow(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("dynamic tool capability clock was invalid");
  }
  return value;
}

function receiptTimeIsBounded(
  receipt: z.infer<typeof lifecycleReceiptSchema>,
  resolverStartedAtMs: number,
  resolverFinishedAtMs: number,
): boolean {
  const startedAtMs = Date.parse(receipt.startedAt);
  const finishedAtMs = Date.parse(receipt.finishedAt);
  return Number.isFinite(startedAtMs) &&
    Number.isFinite(finishedAtMs) &&
    startedAtMs >= resolverStartedAtMs &&
    finishedAtMs <= resolverFinishedAtMs &&
    finishedAtMs >= startedAtMs &&
    resolverFinishedAtMs - finishedAtMs <=
      PINNED_CODEX_DYNAMIC_TOOL_PROBE_MAX_AGE_MS;
}

async function settlesWithin(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  return await Promise.race([
    Promise.resolve(promise).then(() => true, () => true),
    timeout,
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
