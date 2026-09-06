import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { z } from "zod";

import { HRA_VERSION } from "../src/version";
import {
  BoundedProcessInvocationGuard,
  isBoundedProcessCleanupUnprovenError,
  isBoundedProcessRecoveryJournalError,
} from "./bounded-process";
import { isAuthorityContainmentUnavailable } from "./authority-containment";
import {
  buildConvexChildEnvironment,
  runCommand,
  type CommandRunner,
} from "./configure-hosted-sync";
import {
  parseConvexTarget,
  verifyConvexDefaultTarget,
  type ConvexTarget,
  type ConvexTargetVerifier,
} from "./convex-target";
import {
  memoryReadbackOperationSchema,
  memoryReadbackCursorSchema,
  memoryReadbackUserIdSchema,
  type MemoryReadbackOperation,
} from "./live-acceptance-memory-readback-child";

const repositoryRoot = resolve(import.meta.dir, "..");
const childPath = resolve(import.meta.dir, "live-acceptance-memory-readback-child.ts");
const maximumOutputBytes = 64 * 1024;
const maximumAuditPages = 4;
const countSchema = z.number().int().nonnegative().safe().refine((value) => !Object.is(value, -0));
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const countersSchema = z.object({ logicalBytes: countSchema, records: countSchema }).strict();
const categories = [
  "identity", "device", "account", "session", "chunk", "usage", "command", "custody",
  "receipt", "security", "job", "memory",
] as const;
const categorySchema = countersSchema.extend({
  category: z.enum(categories),
  updatedAt: countSchema,
}).strict();
const categoryRowsSchema = z.array(categorySchema).max(categories.length);
const pageSchema = countersSchema.extend({
  category: z.literal("memory"),
  continueCursor: memoryReadbackCursorSchema,
  isDone: z.boolean(),
  table: z.enum(["memorySpaces", "memoryOperations"]),
}).strict();

export const liveMemoryQuotaObservationSchema = z.object({
  logicalBytes: countSchema.positive(),
  operationRecords: countSchema.min(1).max(32),
  quotaMatches: z.literal(true),
  records: countSchema,
  spaceRecords: z.literal(1),
}).strict().refine((value) => value.records === value.operationRecords + value.spaceRecords);
export type LiveMemoryQuotaObservation = z.infer<typeof liveMemoryQuotaObservationSchema>;
export const liveMemoryErasureObservationSchema = z.object({
  logicalBytes: z.literal(0),
  operationRecords: z.literal(0),
  quotaCategory: z.literal("absent"),
  records: z.literal(0),
  spaceRecords: z.literal(0),
}).strict();
export type LiveMemoryErasureObservation = z.infer<typeof liveMemoryErasureObservationSchema>;

export interface LiveAcceptanceMemoryReadback {
  bindDevices(devicePublicIds: readonly [string, string], signal: AbortSignal): Promise<void>;
  observePopulated(expectedOperations: number, signal: AbortSignal): Promise<LiveMemoryQuotaObservation>;
  observeErased(signal: AbortSignal): Promise<LiveMemoryErasureObservation>;
  close(): void;
}

type ReadbackOptions = Readonly<{
  candidate: Readonly<{ cloudTargetDigest: string; packageVersion: string; sourceRevision: string }>;
  environment?: Readonly<NodeJS.ProcessEnv>;
  runner?: CommandRunner;
  target: ConvexTarget;
  // Required: compares each fresh runtime attestation to the exact deploy evidence.
  verifyRuntime: () => Promise<void>;
  verifyTarget?: ConvexTargetVerifier;
}>;

const refused = (): never => { throw new Error("live_memory_readback_refused"); };

/** Repo-only operator reads; the account identity never escapes this closure. */
export function createLiveAcceptanceMemoryReadback(options: ReadbackOptions): LiveAcceptanceMemoryReadback {
  const target = parseConvexTarget(options.target);
  const candidate = z.object({
    cloudTargetDigest: digestSchema,
    packageVersion: z.literal(HRA_VERSION),
    sourceRevision: z.string().regex(/^[a-f0-9]{40}$/u),
  }).strict().parse(options.candidate);
  if (candidate.cloudTargetDigest !== createHash("sha256").update(target.deploymentUrl).digest("hex")) {
    return refused();
  }
  const runner = options.runner ?? runCommand;
  const verifyTarget = options.verifyTarget ?? verifyConvexDefaultTarget;
  const guard = new BoundedProcessInvocationGuard();
  let userId: string | undefined;
  let state: "new" | "bound" | "populated" | "closed" = "new";
  let busy = false;
  const close = (): void => { state = "closed"; userId = undefined; };
  const check = (signal: AbortSignal): void => {
    if (state === "closed" || signal.aborted) refused();
    guard.assertMayProceed();
  };
  const verify = async (signal: AbortSignal): Promise<void> => {
    check(signal);
    await guard.observe(async () => await verifyTarget(target));
    check(signal);
    await guard.observe(options.verifyRuntime);
    check(signal);
  };
  const invoke = async <T>(
    operation: MemoryReadbackOperation,
    schema: z.ZodType<T>,
    signal: AbortSignal,
  ): Promise<T> => {
    const parsed = memoryReadbackOperationSchema.parse(operation);
    await verify(signal);
    let unsafePostflight = false;
    let result;
    try {
      result = await guard.observe(async () => await runner({
        arguments: [childPath],
        containment: "authority",
        cwd: repositoryRoot,
        environment: buildConvexChildEnvironment(options.environment ?? process.env,
          "userId" in parsed ? [parsed.userId, ...("cursor" in parsed && parsed.cursor ? [parsed.cursor] : [])] : []),
        executable: process.execPath,
        outputMaximumBytes: maximumOutputBytes,
        phase: `live-memory-${parsed.kind.replaceAll("_", "-")}`,
        stdin: JSON.stringify({ operation: parsed, target, version: 1 }),
        timeoutMs: 60_000,
      }));
    } catch (error: unknown) {
      unsafePostflight = isAuthorityContainmentUnavailable(error)
        || isBoundedProcessCleanupUnprovenError(error)
        || isBoundedProcessRecoveryJournalError(error);
      if (unsafePostflight) throw error;
      return refused();
    } finally {
      if (!unsafePostflight) await verify(signal);
    }
    if (
      result.exitCode !== 0
      || result.stderr.trim().length !== 0
      || Buffer.byteLength(result.stdout, "utf8") > maximumOutputBytes
      || Buffer.byteLength(result.stderr, "utf8") > maximumOutputBytes
    ) return refused();
    try { return schema.parse(JSON.parse(result.stdout) as unknown); } catch { return refused(); }
  };
  const readQuota = async (signal: AbortSignal) => {
    if (userId === undefined) return refused();
    const rows = await invoke({ kind: "read_category", userId }, categoryRowsSchema, signal);
    if (new Set(rows.map((row) => row.category)).size !== rows.length) return refused();
    return rows;
  };
  const audit = async (kind: "audit_memory_spaces" | "audit_memory_operations", signal: AbortSignal) => {
    if (userId === undefined) return refused();
    const table = kind === "audit_memory_spaces" ? "memorySpaces" : "memoryOperations";
    const seen = new Set<string>();
    let cursor: string | null = null;
    let records = 0;
    let logicalBytes = 0;
    for (let pageNumber = 0; pageNumber < maximumAuditPages; pageNumber += 1) {
      const page: z.infer<typeof pageSchema> = await invoke({ cursor, kind, userId }, pageSchema, signal);
      if (page.table !== table || page.records > 200) return refused();
      records += page.records;
      logicalBytes += page.logicalBytes;
      if (!Number.isSafeInteger(records) || !Number.isSafeInteger(logicalBytes)) return refused();
      if (page.isDone) return { logicalBytes, records };
      if (page.continueCursor.length === 0 || seen.has(page.continueCursor)) return refused();
      seen.add(page.continueCursor);
      cursor = page.continueCursor;
    }
    return refused();
  };
  const exclusive = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (busy || state === "closed") { close(); return refused(); }
    busy = true;
    try { return await operation(); } catch (error: unknown) { close(); throw error; } finally { busy = false; }
  };
  return {
    bindDevices: async (devicePublicIds, signal) => await exclusive(async () => {
      if (state !== "new") return refused();
      const row = await invoke({ devicePublicIds: [...devicePublicIds], kind: "bind_devices" },
        z.object({ userId: memoryReadbackUserIdSchema }).strict(), signal);
      userId = row.userId;
      state = "bound";
    }),
    observePopulated: async (expectedOperations, signal) => await exclusive(async () => {
      if (state !== "bound" || !Number.isSafeInteger(expectedOperations)
        || expectedOperations < 1 || expectedOperations > 32) return refused();
      const before = await readQuota(signal);
      const spaces = await audit("audit_memory_spaces", signal);
      const operations = await audit("audit_memory_operations", signal);
      const after = await readQuota(signal);
      const first = before.find((row) => row.category === "memory");
      const last = after.find((row) => row.category === "memory");
      if (first === undefined || last === undefined || before.length !== categories.length
        || after.length !== categories.length || JSON.stringify(first) !== JSON.stringify(last)
        || spaces.records !== 1 || operations.records !== expectedOperations
        || first.records !== spaces.records + operations.records
        || first.logicalBytes !== spaces.logicalBytes + operations.logicalBytes) return refused();
      const observation = liveMemoryQuotaObservationSchema.parse({
        logicalBytes: first.logicalBytes, operationRecords: operations.records,
        quotaMatches: true, records: first.records, spaceRecords: spaces.records,
      });
      state = "populated";
      return observation;
    }),
    observeErased: async (signal) => await exclusive(async () => {
      if (state !== "populated") return refused();
      const before = await readQuota(signal);
      const spaces = await audit("audit_memory_spaces", signal);
      const operations = await audit("audit_memory_operations", signal);
      const after = await readQuota(signal);
      if (before.length !== 0 || after.length !== 0 || spaces.records !== 0
        || spaces.logicalBytes !== 0 || operations.records !== 0 || operations.logicalBytes !== 0) return refused();
      close();
      return liveMemoryErasureObservationSchema.parse({
        logicalBytes: 0, operationRecords: 0, quotaCategory: "absent", records: 0, spaceRecords: 0,
      });
    }),
    close,
  };
}
