import { resolve } from "node:path";

import { z } from "zod";

import { isUuidV7 } from "../src/cloud/contracts";
import {
  isAuthorityContainmentUnavailable,
  renderAuthorityContainmentUnavailable,
} from "./authority-containment";
import {
  BoundedProcessInvocationGuard,
  isBoundedProcessCleanupUnprovenError,
  isBoundedProcessRecoveryJournalError,
  recoverBoundedProcessJournal,
} from "./bounded-process";
import {
  buildConvexChildEnvironment,
  runCommand,
  type CommandRequest,
  type CommandResult,
  type CommandRunner,
} from "./configure-hosted-sync";
import {
  ConvexTargetError,
  HRA_CONVEX_PROJECT_ID,
  HRA_CONVEX_TEAM_ID,
  parseConvexTarget,
  parseConvexTargetArguments,
  type ConvexTarget,
} from "./convex-target";
import {
  canonicalDigest,
  readProtectedJson,
  ReleaseEvidenceError,
  withSelfDigest,
  writeProtectedJsonNoReplace,
} from "./release-evidence";

const providerOutputMaximumBytes = 16 * 1024;
const providerTimeoutMs = 90_000;
const repositoryRoot = resolve(import.meta.dir, "..");
const managementChild = resolve(import.meta.dir, "convex-management-child.ts");

const targetSchema = z.object({
  deploymentId: z.number().int().positive().safe(),
  deploymentName: z.string().regex(/^[a-z][a-z0-9]*-[a-z][a-z0-9]*-[0-9]+$/u),
  deploymentUrl: z.string().url().refine((value) => {
    const parsed = new URL(value);
    return parsed.protocol === "https:"
      && parsed.username === ""
      && parsed.password === ""
      && parsed.origin === value
      && parsed.hostname.endsWith(".convex.cloud");
  }),
  projectId: z.literal(HRA_CONVEX_PROJECT_ID),
  teamId: z.literal(HRA_CONVEX_TEAM_ID),
}).strict();

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const replacementIdSchema = z.string().refine(isUuidV7);
const replacementReferenceSchema = z.string().regex(/^hra-replace-[0-9a-f]{32}$/u);

const createIntentSchema = z.object({
  kind: z.literal("convex-target-replacement-create-intent"),
  previousTarget: targetSchema,
  previousTargetDigest: digestSchema,
  reference: replacementReferenceSchema,
  replacementId: replacementIdSchema,
  schemaVersion: z.literal(1),
  selfDigest: digestSchema,
}).strict().superRefine((value, context) => {
  if (
    value.previousTargetDigest !== canonicalDigest(value.previousTarget)
    || value.reference !== replacementReference(value.replacementId)
  ) context.addIssue({ code: "custom", message: "replacement_create_intent_invalid" });
});

const createDispatchSchema = z.object({
  createIntentDigest: digestSchema,
  kind: z.literal("convex-target-replacement-create-dispatch"),
  schemaVersion: z.literal(1),
  selfDigest: digestSchema,
}).strict();

const createReceiptSchema = z.object({
  createIntentDigest: digestSchema,
  kind: z.literal("convex-target-replacement-create"),
  previousTarget: targetSchema,
  previousTargetDigest: digestSchema,
  reference: replacementReferenceSchema,
  replacementId: replacementIdSchema,
  schemaVersion: z.literal(1),
  selfDigest: digestSchema,
  target: targetSchema,
  targetDigest: digestSchema,
}).strict().superRefine((value, context) => {
  if (
    value.previousTargetDigest !== canonicalDigest(value.previousTarget)
    || value.targetDigest !== canonicalDigest(value.target)
    || value.reference !== replacementReference(value.replacementId)
    || !targetsAreDistinct(value.previousTarget, value.target)
  ) context.addIssue({ code: "custom", message: "replacement_create_receipt_invalid" });
});

const switchIntentSchema = z.object({
  createReceiptDigest: digestSchema,
  kind: z.literal("convex-target-replacement-switch-intent"),
  previousTarget: targetSchema,
  previousTargetDigest: digestSchema,
  replacementId: replacementIdSchema,
  schemaVersion: z.literal(1),
  selfDigest: digestSchema,
  target: targetSchema,
  targetDigest: digestSchema,
}).strict().superRefine((value, context) => {
  if (
    value.previousTargetDigest !== canonicalDigest(value.previousTarget)
    || value.targetDigest !== canonicalDigest(value.target)
    || !targetsAreDistinct(value.previousTarget, value.target)
  ) context.addIssue({ code: "custom", message: "replacement_switch_intent_invalid" });
});

const switchDemoteDispatchSchema = z.object({
  kind: z.literal("convex-target-replacement-switch-demote-dispatch"),
  schemaVersion: z.literal(1),
  selfDigest: digestSchema,
  switchIntentDigest: digestSchema,
}).strict();

const switchDemoteReceiptSchema = z.object({
  kind: z.literal("convex-target-replacement-switch-demote"),
  previousTarget: targetSchema,
  previousTargetDigest: digestSchema,
  schemaVersion: z.literal(1),
  selfDigest: digestSchema,
  switchIntentDigest: digestSchema,
  target: targetSchema,
  targetDigest: digestSchema,
}).strict().superRefine((value, context) => {
  if (
    value.previousTargetDigest !== canonicalDigest(value.previousTarget)
    || value.targetDigest !== canonicalDigest(value.target)
    || !targetsAreDistinct(value.previousTarget, value.target)
  ) context.addIssue({ code: "custom", message: "replacement_switch_demote_receipt_invalid" });
});

const switchPromoteDispatchSchema = z.object({
  demoteReceiptDigest: digestSchema,
  kind: z.literal("convex-target-replacement-switch-promote-dispatch"),
  schemaVersion: z.literal(1),
  selfDigest: digestSchema,
  switchIntentDigest: digestSchema,
}).strict();

const replacementEvidenceSchema = z.object({
  createReceiptDigest: digestSchema,
  demoteReceiptDigest: digestSchema,
  kind: z.literal("convex-target-replacement"),
  previousTarget: targetSchema,
  previousTargetDigest: digestSchema,
  replacementId: replacementIdSchema,
  schemaVersion: z.literal(1),
  selfDigest: digestSchema,
  switchIntentDigest: digestSchema,
  target: targetSchema,
  targetDigest: digestSchema,
}).strict().superRefine((value, context) => {
  if (
    value.previousTargetDigest !== canonicalDigest(value.previousTarget)
    || value.targetDigest !== canonicalDigest(value.target)
    || !targetsAreDistinct(value.previousTarget, value.target)
  ) context.addIssue({ code: "custom", message: "replacement_evidence_invalid" });
});

const managementResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("created"), target: targetSchema }).strict(),
  z.object({ kind: z.literal("demoted"), target: targetSchema }).strict(),
  z.object({ kind: z.literal("reference_missing") }).strict(),
  z.object({ kind: z.literal("switched"), target: targetSchema }).strict(),
  z.object({ kind: z.literal("verified_default"), target: targetSchema }).strict(),
  z.object({ kind: z.literal("verified_demoted"), target: targetSchema }).strict(),
  z.object({ kind: z.literal("verified_switch_preconditions"), target: targetSchema }).strict(),
]);

type CreateIntent = z.infer<typeof createIntentSchema>;
type CreateReceipt = z.infer<typeof createReceiptSchema>;
type DemoteReceipt = z.infer<typeof switchDemoteReceiptSchema>;
type ReplacementEvidence = z.infer<typeof replacementEvidenceSchema>;
type SwitchIntent = z.infer<typeof switchIntentSchema>;
type ManagementResult = z.infer<typeof managementResultSchema>;

type ReplacementAction = "create" | "status" | "switch";

type ReplacementArguments = Readonly<{
  action: ReplacementAction;
  evidencePath: string;
  execute: boolean;
  previousTarget: ConvexTarget;
  replacementId: string;
}>;

type ReplacementPaths = Readonly<{
  createDispatch: string;
  createIntent: string;
  createReceipt: string;
  final: string;
  switchDemoteDispatch: string;
  switchDemoteReceipt: string;
  switchIntent: string;
  switchPromoteDispatch: string;
}>;

export type HostedConvexReplacementResult = Readonly<
  | {
    evidenceDigest: string;
    state: "complete";
    target: ConvexTarget;
  }
  | {
    createReceiptDigest: string;
    state: "created_receipted";
    target: ConvexTarget;
  }
  | { state: "create_dispatched_reconciliation_required" }
  | { state: "create_intent_prepared" }
  | {
    demoteReceiptDigest: string;
    state: "demoted_receipted";
    target: ConvexTarget;
  }
  | { state: "not_started" }
  | { state: "switch_demote_dispatched_reconciliation_required" }
  | { state: "switch_intent_prepared" }
  | { state: "switch_promote_dispatched_reconciliation_required" }
>;

type ReplacementFailureCode =
  | "create_indeterminate"
  | "create_required"
  | "demote_indeterminate"
  | "evidence_refused"
  | "promote_indeterminate"
  | "provider_result_invalid"
  | "target_refused"
  | "usage_invalid";

class HostedConvexReplacementError extends Error {
  constructor(readonly code: ReplacementFailureCode) {
    super(code);
    this.name = "HostedConvexReplacementError";
  }
}

const replacementReference = (replacementId: string): string =>
  `hra-replace-${replacementId.replaceAll("-", "")}`;

const targetsAreDistinct = (left: ConvexTarget, right: ConvexTarget): boolean => (
  left.deploymentId !== right.deploymentId
  && left.deploymentName !== right.deploymentName
  && left.deploymentUrl !== right.deploymentUrl
);

const sameTarget = (left: ConvexTarget, right: ConvexTarget): boolean => (
  left.deploymentId === right.deploymentId
  && left.deploymentName === right.deploymentName
  && left.deploymentUrl === right.deploymentUrl
);

const parseAbsoluteEvidencePath = (value: string | undefined): string => {
  if (
    value === undefined
    || value.length === 0
    || value.length > 4_000
    || !value.startsWith("/")
    || resolve(value) !== value
  ) throw new HostedConvexReplacementError("usage_invalid");
  return value;
};

const takeOption = (values: string[], name: string): string | undefined => {
  const index = values.indexOf(name);
  if (index < 0) return undefined;
  const value = values[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new HostedConvexReplacementError("usage_invalid");
  }
  values.splice(index, 2);
  return value;
};

const takeFlag = (values: string[], name: string): boolean => {
  const index = values.indexOf(name);
  if (index < 0) return false;
  values.splice(index, 1);
  return true;
};

export function parseHostedConvexReplacementArguments(
  arguments_: readonly string[],
): ReplacementArguments {
  let parsedTarget: ReturnType<typeof parseConvexTargetArguments>;
  try {
    parsedTarget = parseConvexTargetArguments(arguments_);
  } catch {
    throw new HostedConvexReplacementError("usage_invalid");
  }
  const values = [...parsedTarget.otherArguments];
  const action = values.shift();
  if (action !== "create" && action !== "status" && action !== "switch") {
    throw new HostedConvexReplacementError("usage_invalid");
  }
  const evidencePath = parseAbsoluteEvidencePath(takeOption(values, "--evidence-path"));
  const replacementId = takeOption(values, "--replacement-id");
  const execute = takeFlag(values, "--execute");
  if (
    values.length !== 0
    || replacementId === undefined
    || !replacementIdSchema.safeParse(replacementId).success
    || (action === "status" ? execute : !execute)
  ) throw new HostedConvexReplacementError("usage_invalid");
  return {
    action,
    evidencePath,
    execute,
    previousTarget: parsedTarget.target,
    replacementId,
  };
}

const replacementPaths = (evidencePath: string): ReplacementPaths => ({
  createDispatch: `${evidencePath}.create.dispatch`,
  createIntent: `${evidencePath}.create.intent`,
  createReceipt: `${evidencePath}.create`,
  final: evidencePath,
  switchDemoteDispatch: `${evidencePath}.switch.demote.dispatch`,
  switchDemoteReceipt: `${evidencePath}.switch.demote`,
  switchIntent: `${evidencePath}.switch.intent`,
  switchPromoteDispatch: `${evidencePath}.switch.promote.dispatch`,
});

const optionalEvidence = <T>(path: string, schema: z.ZodType<T>): T | undefined => {
  try {
    return readProtectedJson(path, schema, { recoverInterruptedPublication: true });
  } catch (error: unknown) {
    if (error instanceof ReleaseEvidenceError && error.code === "evidence_not_found") return undefined;
    throw new HostedConvexReplacementError("evidence_refused");
  }
};

const createIntent = (arguments_: ReplacementArguments): CreateIntent => withSelfDigest({
  kind: "convex-target-replacement-create-intent" as const,
  previousTarget: arguments_.previousTarget,
  previousTargetDigest: canonicalDigest(arguments_.previousTarget),
  reference: replacementReference(arguments_.replacementId),
  replacementId: arguments_.replacementId,
  schemaVersion: 1 as const,
});

const assertCreateIntent = (intent: CreateIntent, arguments_: ReplacementArguments): void => {
  if (
    intent.replacementId !== arguments_.replacementId
    || intent.reference !== replacementReference(arguments_.replacementId)
    || !sameTarget(intent.previousTarget, arguments_.previousTarget)
  ) throw new HostedConvexReplacementError("evidence_refused");
};

const assertCreateReceipt = (receipt: CreateReceipt, intent: CreateIntent): void => {
  if (
    receipt.createIntentDigest !== intent.selfDigest
    || receipt.replacementId !== intent.replacementId
    || receipt.reference !== intent.reference
    || !sameTarget(receipt.previousTarget, intent.previousTarget)
  ) throw new HostedConvexReplacementError("evidence_refused");
};

const assertCreateDispatch = (
  dispatch: z.infer<typeof createDispatchSchema>,
  intent: CreateIntent,
): void => {
  if (dispatch.createIntentDigest !== intent.selfDigest) {
    throw new HostedConvexReplacementError("evidence_refused");
  }
};

const createReceipt = (intent: CreateIntent, target: ConvexTarget): CreateReceipt => {
  if (!targetsAreDistinct(intent.previousTarget, target)) {
    throw new HostedConvexReplacementError("target_refused");
  }
  return withSelfDigest({
    createIntentDigest: intent.selfDigest,
    kind: "convex-target-replacement-create" as const,
    previousTarget: intent.previousTarget,
    previousTargetDigest: canonicalDigest(intent.previousTarget),
    reference: intent.reference,
    replacementId: intent.replacementId,
    schemaVersion: 1 as const,
    target,
    targetDigest: canonicalDigest(target),
  });
};

const switchIntent = (receipt: CreateReceipt): SwitchIntent => withSelfDigest({
  createReceiptDigest: receipt.selfDigest,
  kind: "convex-target-replacement-switch-intent" as const,
  previousTarget: receipt.previousTarget,
  previousTargetDigest: canonicalDigest(receipt.previousTarget),
  replacementId: receipt.replacementId,
  schemaVersion: 1 as const,
  target: receipt.target,
  targetDigest: canonicalDigest(receipt.target),
});

const assertSwitchIntent = (intent: SwitchIntent, receipt: CreateReceipt): void => {
  if (
    intent.createReceiptDigest !== receipt.selfDigest
    || intent.replacementId !== receipt.replacementId
    || !sameTarget(intent.previousTarget, receipt.previousTarget)
    || !sameTarget(intent.target, receipt.target)
  ) throw new HostedConvexReplacementError("evidence_refused");
};

const assertSwitchDemoteDispatch = (
  dispatch: z.infer<typeof switchDemoteDispatchSchema>,
  intent: SwitchIntent,
): void => {
  if (dispatch.switchIntentDigest !== intent.selfDigest) {
    throw new HostedConvexReplacementError("evidence_refused");
  }
};

const demoteReceipt = (intent: SwitchIntent): DemoteReceipt => withSelfDigest({
  kind: "convex-target-replacement-switch-demote" as const,
  previousTarget: intent.previousTarget,
  previousTargetDigest: canonicalDigest(intent.previousTarget),
  schemaVersion: 1 as const,
  switchIntentDigest: intent.selfDigest,
  target: intent.target,
  targetDigest: canonicalDigest(intent.target),
});

const assertDemoteReceipt = (receipt: DemoteReceipt, intent: SwitchIntent): void => {
  if (
    receipt.switchIntentDigest !== intent.selfDigest
    || !sameTarget(receipt.previousTarget, intent.previousTarget)
    || !sameTarget(receipt.target, intent.target)
  ) throw new HostedConvexReplacementError("evidence_refused");
};

const assertSwitchPromoteDispatch = (
  dispatch: z.infer<typeof switchPromoteDispatchSchema>,
  intent: SwitchIntent,
  receipt: DemoteReceipt,
): void => {
  if (
    dispatch.switchIntentDigest !== intent.selfDigest
    || dispatch.demoteReceiptDigest !== receipt.selfDigest
  ) throw new HostedConvexReplacementError("evidence_refused");
};

const replacementEvidence = (
  receipt: CreateReceipt,
  intent: SwitchIntent,
  demotion: DemoteReceipt,
): ReplacementEvidence => withSelfDigest({
  createReceiptDigest: receipt.selfDigest,
  demoteReceiptDigest: demotion.selfDigest,
  kind: "convex-target-replacement" as const,
  previousTarget: receipt.previousTarget,
  previousTargetDigest: canonicalDigest(receipt.previousTarget),
  replacementId: receipt.replacementId,
  schemaVersion: 1 as const,
  switchIntentDigest: intent.selfDigest,
  target: receipt.target,
  targetDigest: canonicalDigest(receipt.target),
});

const assertFinalEvidence = (
  evidence: ReplacementEvidence,
  arguments_: ReplacementArguments,
  receipt: CreateReceipt,
  intent: SwitchIntent,
  demotion: DemoteReceipt,
): void => {
  if (
    evidence.replacementId !== arguments_.replacementId
    || !sameTarget(evidence.previousTarget, arguments_.previousTarget)
    || evidence.createReceiptDigest !== receipt.selfDigest
    || evidence.demoteReceiptDigest !== demotion.selfDigest
    || evidence.switchIntentDigest !== intent.selfDigest
    || !sameTarget(evidence.previousTarget, receipt.previousTarget)
    || !sameTarget(evidence.target, receipt.target)
  ) throw new HostedConvexReplacementError("evidence_refused");
};

const persist = <T>(path: string, value: T, schema: z.ZodType<T>): void => {
  try {
    writeProtectedJsonNoReplace(path, value, schema, { allowExactReplay: true });
  } catch {
    throw new HostedConvexReplacementError("evidence_refused");
  }
};

const parseManagementResult = (output: string): ManagementResult => {
  if (
    output.trim().length === 0
    || Buffer.byteLength(output, "utf8") > providerOutputMaximumBytes
  ) throw new HostedConvexReplacementError("provider_result_invalid");
  try {
    return managementResultSchema.parse(JSON.parse(output) as unknown);
  } catch {
    throw new HostedConvexReplacementError("provider_result_invalid");
  }
};

type ManagementRequest = Readonly<
  | { kind: "create_nondefault"; previousTarget: ConvexTarget; reference: string }
  | { kind: "reconcile_create"; previousTarget: ConvexTarget; reference: string }
  | { kind: "demote_default"; previousTarget: ConvexTarget; target: ConvexTarget }
  | { kind: "promote_default"; previousTarget: ConvexTarget; target: ConvexTarget }
  | { kind: "reconcile_demotion"; previousTarget: ConvexTarget; target: ConvexTarget }
  | { kind: "reconcile_promotion"; previousTarget: ConvexTarget; target: ConvexTarget }
  | { kind: "verify_default"; target: ConvexTarget }
  | { kind: "verify_demoted"; previousTarget: ConvexTarget; target: ConvexTarget }
  | { kind: "verify_switch_preconditions"; previousTarget: ConvexTarget; target: ConvexTarget }
>;

type ReplacementOptions = Readonly<{
  arguments: ReplacementArguments;
  environment?: Readonly<NodeJS.ProcessEnv>;
  runner?: CommandRunner;
}>;

type LocalReplacementStatus = Readonly<{
  result: HostedConvexReplacementResult;
  verification?: ManagementRequest;
}>;

const readLocalStatus = (
  paths: ReplacementPaths,
  arguments_: ReplacementArguments,
): LocalReplacementStatus => {
  const createIntentDocument = optionalEvidence(paths.createIntent, createIntentSchema);
  const createDispatchDocument = optionalEvidence(paths.createDispatch, createDispatchSchema);
  const createReceiptDocument = optionalEvidence(paths.createReceipt, createReceiptSchema);
  const switchIntentDocument = optionalEvidence(paths.switchIntent, switchIntentSchema);
  const switchDemoteDispatchDocument = optionalEvidence(
    paths.switchDemoteDispatch,
    switchDemoteDispatchSchema,
  );
  const switchDemoteReceiptDocument = optionalEvidence(
    paths.switchDemoteReceipt,
    switchDemoteReceiptSchema,
  );
  const switchPromoteDispatchDocument = optionalEvidence(
    paths.switchPromoteDispatch,
    switchPromoteDispatchSchema,
  );
  const final = optionalEvidence(paths.final, replacementEvidenceSchema);

  if (final !== undefined) {
    if (
      createIntentDocument === undefined
      || createDispatchDocument === undefined
      || createReceiptDocument === undefined
      || switchIntentDocument === undefined
      || switchDemoteDispatchDocument === undefined
      || switchDemoteReceiptDocument === undefined
      || switchPromoteDispatchDocument === undefined
    ) throw new HostedConvexReplacementError("evidence_refused");
    assertCreateIntent(createIntentDocument, arguments_);
    assertCreateDispatch(createDispatchDocument, createIntentDocument);
    assertCreateReceipt(createReceiptDocument, createIntentDocument);
    assertSwitchIntent(switchIntentDocument, createReceiptDocument);
    assertSwitchDemoteDispatch(switchDemoteDispatchDocument, switchIntentDocument);
    assertDemoteReceipt(switchDemoteReceiptDocument, switchIntentDocument);
    assertSwitchPromoteDispatch(
      switchPromoteDispatchDocument,
      switchIntentDocument,
      switchDemoteReceiptDocument,
    );
    assertFinalEvidence(
      final,
      arguments_,
      createReceiptDocument,
      switchIntentDocument,
      switchDemoteReceiptDocument,
    );
    return {
      result: { evidenceDigest: final.selfDigest, state: "complete", target: final.target },
      verification: { kind: "verify_default", target: final.target },
    };
  }

  if (createReceiptDocument !== undefined) {
    if (createIntentDocument === undefined || createDispatchDocument === undefined) {
      throw new HostedConvexReplacementError("evidence_refused");
    }
    assertCreateIntent(createIntentDocument, arguments_);
    assertCreateDispatch(createDispatchDocument, createIntentDocument);
    assertCreateReceipt(createReceiptDocument, createIntentDocument);
    if (switchIntentDocument === undefined) {
      if (
        switchDemoteDispatchDocument !== undefined
        || switchDemoteReceiptDocument !== undefined
        || switchPromoteDispatchDocument !== undefined
      ) {
        throw new HostedConvexReplacementError("evidence_refused");
      }
      return {
        result: {
          createReceiptDigest: createReceiptDocument.selfDigest,
          state: "created_receipted",
          target: createReceiptDocument.target,
        },
        verification: {
          kind: "verify_switch_preconditions",
          previousTarget: createReceiptDocument.previousTarget,
          target: createReceiptDocument.target,
        },
      };
    }
    assertSwitchIntent(switchIntentDocument, createReceiptDocument);
    if (switchDemoteDispatchDocument === undefined) {
      if (
        switchDemoteReceiptDocument !== undefined
        || switchPromoteDispatchDocument !== undefined
      ) throw new HostedConvexReplacementError("evidence_refused");
      return { result: { state: "switch_intent_prepared" } };
    }
    assertSwitchDemoteDispatch(switchDemoteDispatchDocument, switchIntentDocument);
    if (switchDemoteReceiptDocument === undefined) {
      if (switchPromoteDispatchDocument !== undefined) {
        throw new HostedConvexReplacementError("evidence_refused");
      }
      return { result: { state: "switch_demote_dispatched_reconciliation_required" } };
    }
    assertDemoteReceipt(switchDemoteReceiptDocument, switchIntentDocument);
    if (switchPromoteDispatchDocument === undefined) {
      return {
        result: {
          demoteReceiptDigest: switchDemoteReceiptDocument.selfDigest,
          state: "demoted_receipted",
          target: switchDemoteReceiptDocument.target,
        },
        verification: {
          kind: "verify_demoted",
          previousTarget: switchDemoteReceiptDocument.previousTarget,
          target: switchDemoteReceiptDocument.target,
        },
      };
    }
    assertSwitchPromoteDispatch(
      switchPromoteDispatchDocument,
      switchIntentDocument,
      switchDemoteReceiptDocument,
    );
    return {
      result: { state: "switch_promote_dispatched_reconciliation_required" },
    };
  }

  if (
    switchIntentDocument !== undefined
    || switchDemoteDispatchDocument !== undefined
    || switchDemoteReceiptDocument !== undefined
    || switchPromoteDispatchDocument !== undefined
  ) {
    throw new HostedConvexReplacementError("evidence_refused");
  }
  if (createIntentDocument === undefined) {
    if (createDispatchDocument !== undefined) throw new HostedConvexReplacementError("evidence_refused");
    return { result: { state: "not_started" } };
  }
  assertCreateIntent(createIntentDocument, arguments_);
  if (createDispatchDocument !== undefined) {
    assertCreateDispatch(createDispatchDocument, createIntentDocument);
  }
  return {
    result: createDispatchDocument === undefined
      ? { state: "create_intent_prepared" }
      : { state: "create_dispatched_reconciliation_required" },
  };
};

const invokeManagement = async (
  guard: BoundedProcessInvocationGuard,
  runner: CommandRunner,
  environment: Readonly<Record<string, string>>,
  request: ManagementRequest,
  phase: string,
): Promise<ManagementResult> => {
  const encoded = JSON.stringify(request);
  const result = await guard.observe(async () => await runner({
    arguments: [managementChild],
    containment: "authority",
    cwd: repositoryRoot,
    environment,
    executable: process.execPath,
    outputMaximumBytes: providerOutputMaximumBytes,
    phase,
    stdin: encoded,
    timeoutMs: providerTimeoutMs,
  }));
  if (result.exitCode !== 0) throw new HostedConvexReplacementError("provider_result_invalid");
  return parseManagementResult(result.stdout);
};

const requireManagementResult = <Kind extends ManagementResult["kind"]>(
  result: ManagementResult,
  kind: Kind,
): Extract<ManagementResult, { kind: Kind }> => {
  if (result.kind !== kind) throw new HostedConvexReplacementError("provider_result_invalid");
  return result as Extract<ManagementResult, { kind: Kind }>;
};

const verifyLocalStatus = async (
  status: LocalReplacementStatus,
  invoke: (request: ManagementRequest, phase: string) => Promise<ManagementResult>,
): Promise<HostedConvexReplacementResult> => {
  const request = status.verification;
  if (request === undefined) return status.result;
  const expected = request.kind === "verify_default"
    ? "verified_default"
    : request.kind === "verify_demoted"
      ? "verified_demoted"
      : "verified_switch_preconditions";
  requireManagementResult(
    await invoke(request, "convex-replacement-status-verify"),
    expected,
  );
  return status.result;
};

const readOrCreateIntent = async (
  arguments_: ReplacementArguments,
  paths: ReplacementPaths,
  invoke: (request: ManagementRequest, phase: string) => Promise<ManagementResult>,
): Promise<CreateIntent> => {
  const existing = optionalEvidence(paths.createIntent, createIntentSchema);
  if (existing !== undefined) {
    assertCreateIntent(existing, arguments_);
    return existing;
  }
  requireManagementResult(await invoke({
    kind: "verify_default",
    target: arguments_.previousTarget,
  }, "convex-replacement-create-preflight"), "verified_default");
  const intent = createIntent(arguments_);
  persist(paths.createIntent, intent, createIntentSchema);
  return intent;
};

const persistCreateReceipt = (
  paths: ReplacementPaths,
  intent: CreateIntent,
  target: ConvexTarget,
): CreateReceipt => {
  const expected = createReceipt(intent, target);
  const existing = optionalEvidence(paths.createReceipt, createReceiptSchema);
  if (existing !== undefined) {
    assertCreateReceipt(existing, intent);
    if (!sameTarget(existing.target, expected.target)) {
      throw new HostedConvexReplacementError("evidence_refused");
    }
    return existing;
  }
  persist(paths.createReceipt, expected, createReceiptSchema);
  return expected;
};

const createTarget = async (
  arguments_: ReplacementArguments,
  paths: ReplacementPaths,
  invoke: (request: ManagementRequest, phase: string) => Promise<ManagementResult>,
): Promise<HostedConvexReplacementResult> => {
  const intent = await readOrCreateIntent(arguments_, paths, invoke);
  const existing = optionalEvidence(paths.createReceipt, createReceiptSchema);
  if (existing !== undefined) {
    assertCreateReceipt(existing, intent);
    requireManagementResult(await invoke({
      kind: "verify_switch_preconditions",
      previousTarget: existing.previousTarget,
      target: existing.target,
    }, "convex-replacement-create-reverify"), "verified_switch_preconditions");
    return {
      createReceiptDigest: existing.selfDigest,
      state: "created_receipted",
      target: existing.target,
    };
  }
  const dispatched = optionalEvidence(paths.createDispatch, createDispatchSchema);
  if (dispatched !== undefined) {
    assertCreateDispatch(dispatched, intent);
    let reconciled: Extract<ManagementResult, { kind: "created" }>;
    try {
      reconciled = requireManagementResult(await invoke({
        kind: "reconcile_create",
        previousTarget: intent.previousTarget,
        reference: intent.reference,
      }, "convex-replacement-create-reconcile"), "created");
    } catch (error: unknown) {
      if (
        isAuthorityContainmentUnavailable(error)
        || isBoundedProcessCleanupUnprovenError(error)
        || isBoundedProcessRecoveryJournalError(error)
      ) throw error;
      throw new HostedConvexReplacementError("create_indeterminate");
    }
    const receipt = persistCreateReceipt(paths, intent, parseConvexTarget(reconciled.target));
    return {
      createReceiptDigest: receipt.selfDigest,
      state: "created_receipted",
      target: receipt.target,
    };
  }
  persist(paths.createDispatch, withSelfDigest({
    createIntentDigest: intent.selfDigest,
    kind: "convex-target-replacement-create-dispatch" as const,
    schemaVersion: 1 as const,
  }), createDispatchSchema);
  let created: Extract<ManagementResult, { kind: "created" }>;
  try {
    created = requireManagementResult(await invoke({
      kind: "create_nondefault",
      previousTarget: intent.previousTarget,
      reference: intent.reference,
    }, "convex-replacement-create"), "created");
  } catch (error: unknown) {
    if (
      isAuthorityContainmentUnavailable(error)
      || isBoundedProcessCleanupUnprovenError(error)
      || isBoundedProcessRecoveryJournalError(error)
    ) throw error;
    throw new HostedConvexReplacementError("create_indeterminate");
  }
  const receipt = persistCreateReceipt(paths, intent, parseConvexTarget(created.target));
  return {
    createReceiptDigest: receipt.selfDigest,
    state: "created_receipted",
    target: receipt.target,
  };
};

const readOrCreateSwitchIntent = async (
  paths: ReplacementPaths,
  receipt: CreateReceipt,
  invoke: (request: ManagementRequest, phase: string) => Promise<ManagementResult>,
): Promise<SwitchIntent> => {
  const existing = optionalEvidence(paths.switchIntent, switchIntentSchema);
  if (existing !== undefined) {
    assertSwitchIntent(existing, receipt);
    return existing;
  }
  requireManagementResult(await invoke({
    kind: "verify_switch_preconditions",
    previousTarget: receipt.previousTarget,
    target: receipt.target,
  }, "convex-replacement-switch-preflight"), "verified_switch_preconditions");
  const intent = switchIntent(receipt);
  persist(paths.switchIntent, intent, switchIntentSchema);
  return intent;
};

const persistFinalEvidence = (
  paths: ReplacementPaths,
  receipt: CreateReceipt,
  intent: SwitchIntent,
  demotion: DemoteReceipt,
  arguments_: ReplacementArguments,
): ReplacementEvidence => {
  const expected = replacementEvidence(receipt, intent, demotion);
  const existing = optionalEvidence(paths.final, replacementEvidenceSchema);
  if (existing !== undefined) {
    assertFinalEvidence(existing, arguments_, receipt, intent, demotion);
    return existing;
  }
  persist(paths.final, expected, replacementEvidenceSchema);
  return expected;
};

const persistDemoteReceipt = (
  paths: ReplacementPaths,
  intent: SwitchIntent,
): DemoteReceipt => {
  const expected = demoteReceipt(intent);
  const existing = optionalEvidence(paths.switchDemoteReceipt, switchDemoteReceiptSchema);
  if (existing !== undefined) {
    assertDemoteReceipt(existing, intent);
    return existing;
  }
  persist(paths.switchDemoteReceipt, expected, switchDemoteReceiptSchema);
  return expected;
};

const establishDemotionReceipt = async (
  paths: ReplacementPaths,
  intent: SwitchIntent,
  invoke: (request: ManagementRequest, phase: string) => Promise<ManagementResult>,
): Promise<DemoteReceipt> => {
  const existing = optionalEvidence(paths.switchDemoteReceipt, switchDemoteReceiptSchema);
  if (existing !== undefined) {
    assertDemoteReceipt(existing, intent);
    return existing;
  }
  const dispatched = optionalEvidence(paths.switchDemoteDispatch, switchDemoteDispatchSchema);
  if (dispatched !== undefined) {
    assertSwitchDemoteDispatch(dispatched, intent);
    try {
      requireManagementResult(await invoke({
        kind: "reconcile_demotion",
        previousTarget: intent.previousTarget,
        target: intent.target,
      }, "convex-replacement-demote-reconcile"), "demoted");
    } catch (error: unknown) {
      if (
        isAuthorityContainmentUnavailable(error)
        || isBoundedProcessCleanupUnprovenError(error)
        || isBoundedProcessRecoveryJournalError(error)
      ) throw error;
      throw new HostedConvexReplacementError("demote_indeterminate");
    }
    return persistDemoteReceipt(paths, intent);
  }
  requireManagementResult(await invoke({
    kind: "verify_switch_preconditions",
    previousTarget: intent.previousTarget,
    target: intent.target,
  }, "convex-replacement-demote-preflight"), "verified_switch_preconditions");
  persist(paths.switchDemoteDispatch, withSelfDigest({
    kind: "convex-target-replacement-switch-demote-dispatch" as const,
    schemaVersion: 1 as const,
    switchIntentDigest: intent.selfDigest,
  }), switchDemoteDispatchSchema);
  try {
    requireManagementResult(await invoke({
      kind: "demote_default",
      previousTarget: intent.previousTarget,
      target: intent.target,
    }, "convex-replacement-demote"), "demoted");
  } catch (error: unknown) {
    if (
      isAuthorityContainmentUnavailable(error)
      || isBoundedProcessCleanupUnprovenError(error)
      || isBoundedProcessRecoveryJournalError(error)
    ) throw error;
    throw new HostedConvexReplacementError("demote_indeterminate");
  }
  return persistDemoteReceipt(paths, intent);
};

const promoteTarget = async (
  arguments_: ReplacementArguments,
  paths: ReplacementPaths,
  receipt: CreateReceipt,
  intent: SwitchIntent,
  demotion: DemoteReceipt,
  invoke: (request: ManagementRequest, phase: string) => Promise<ManagementResult>,
): Promise<HostedConvexReplacementResult> => {
  const dispatched = optionalEvidence(paths.switchPromoteDispatch, switchPromoteDispatchSchema);
  if (dispatched !== undefined) {
    assertSwitchPromoteDispatch(dispatched, intent, demotion);
    try {
      requireManagementResult(await invoke({
        kind: "reconcile_promotion",
        previousTarget: intent.previousTarget,
        target: intent.target,
      }, "convex-replacement-promote-reconcile"), "switched");
    } catch (error: unknown) {
      if (
        isAuthorityContainmentUnavailable(error)
        || isBoundedProcessCleanupUnprovenError(error)
        || isBoundedProcessRecoveryJournalError(error)
      ) throw error;
      throw new HostedConvexReplacementError("promote_indeterminate");
    }
    const final = persistFinalEvidence(paths, receipt, intent, demotion, arguments_);
    return { evidenceDigest: final.selfDigest, state: "complete", target: final.target };
  }
  requireManagementResult(await invoke({
    kind: "verify_demoted",
    previousTarget: intent.previousTarget,
    target: intent.target,
  }, "convex-replacement-promote-preflight"), "verified_demoted");
  persist(paths.switchPromoteDispatch, withSelfDigest({
    demoteReceiptDigest: demotion.selfDigest,
    kind: "convex-target-replacement-switch-promote-dispatch" as const,
    schemaVersion: 1 as const,
    switchIntentDigest: intent.selfDigest,
  }), switchPromoteDispatchSchema);
  try {
    requireManagementResult(await invoke({
      kind: "promote_default",
      previousTarget: intent.previousTarget,
      target: intent.target,
    }, "convex-replacement-promote"), "switched");
  } catch (error: unknown) {
    if (
      isAuthorityContainmentUnavailable(error)
      || isBoundedProcessCleanupUnprovenError(error)
      || isBoundedProcessRecoveryJournalError(error)
    ) throw error;
    throw new HostedConvexReplacementError("promote_indeterminate");
  }
  const final = persistFinalEvidence(paths, receipt, intent, demotion, arguments_);
  return { evidenceDigest: final.selfDigest, state: "complete", target: final.target };
};

const switchTarget = async (
  arguments_: ReplacementArguments,
  paths: ReplacementPaths,
  invoke: (request: ManagementRequest, phase: string) => Promise<ManagementResult>,
): Promise<HostedConvexReplacementResult> => {
  const receipt = optionalEvidence(paths.createReceipt, createReceiptSchema);
  const create = optionalEvidence(paths.createIntent, createIntentSchema);
  if (receipt === undefined || create === undefined) {
    throw new HostedConvexReplacementError("create_required");
  }
  assertCreateIntent(create, arguments_);
  assertCreateReceipt(receipt, create);
  const intent = await readOrCreateSwitchIntent(paths, receipt, invoke);
  const demotion = await establishDemotionReceipt(paths, intent, invoke);
  return await promoteTarget(arguments_, paths, receipt, intent, demotion, invoke);
};

export async function replaceHostedConvexTarget(
  options: ReplacementOptions,
): Promise<HostedConvexReplacementResult> {
  const arguments_ = options.arguments;
  const previousTarget = parseConvexTarget(arguments_.previousTarget);
  const normalized = { ...arguments_, previousTarget };
  const paths = replacementPaths(normalized.evidencePath);
  const localStatus = readLocalStatus(paths, normalized);
  if (normalized.action === "status" && localStatus.verification === undefined) {
    return localStatus.result;
  }

  const runner = options.runner ?? runCommand;
  const environment = buildConvexChildEnvironment(options.environment ?? process.env, []);
  const guard = new BoundedProcessInvocationGuard();
  const invoke = async (request: ManagementRequest, phase: string): Promise<ManagementResult> =>
    await invokeManagement(guard, runner, environment, request, phase);
  if (normalized.action === "status" || localStatus.result.state === "complete") {
    return await verifyLocalStatus(localStatus, invoke);
  }
  return normalized.action === "create"
    ? await createTarget(normalized, paths, invoke)
    : await switchTarget(normalized, paths, invoke);
}

type ExecuteOptions = Readonly<{
  arguments: readonly string[];
  environment?: Readonly<NodeJS.ProcessEnv>;
  runner?: CommandRunner;
  stderr: Pick<NodeJS.WriteStream, "write">;
  stdout: Pick<NodeJS.WriteStream, "write">;
}>;

const renderResult = (result: HostedConvexReplacementResult): Readonly<Record<string, unknown>> => {
  switch (result.state) {
    case "complete":
      return {
        evidence: { digest: result.evidenceDigest },
        state: result.state,
        target: result.target,
        version: 1,
      };
    case "created_receipted":
      return {
        evidence: { createDigest: result.createReceiptDigest },
        state: result.state,
        target: result.target,
        version: 1,
      };
    case "demoted_receipted":
      return {
        evidence: { demoteDigest: result.demoteReceiptDigest },
        state: result.state,
        target: result.target,
        version: 1,
      };
    case "create_dispatched_reconciliation_required":
    case "create_intent_prepared":
    case "not_started":
    case "switch_demote_dispatched_reconciliation_required":
    case "switch_intent_prepared":
    case "switch_promote_dispatched_reconciliation_required":
      return { state: result.state, version: 1 };
    default:
      result satisfies never;
      throw new Error("replacement_result_unreachable");
  }
};

const writeRecoveryError = (
  error: Error,
  stderr: Pick<NodeJS.WriteStream, "write">,
): number | undefined => {
  if (isBoundedProcessCleanupUnprovenError(error)) {
    stderr.write(`${JSON.stringify({
      code: "process_cleanup_unproven",
      phase: error.phase,
      processes: error.processes,
      recoveryPaths: error.recoveryPaths,
      schemaVersion: 1,
      status: "recovery_required",
    })}\n`);
    return 75;
  }
  if (isBoundedProcessRecoveryJournalError(error)) {
    stderr.write(`${JSON.stringify({
      code: "process_recovery_journal_blocked",
      reason: error.reason,
      recoveryPaths: error.recoveryPaths,
      schemaVersion: 1,
      status: "recovery_required",
    })}\n`);
    return 75;
  }
  return undefined;
};

export async function executeHostedConvexReplacement(
  options: ExecuteOptions,
): Promise<number> {
  try {
    const arguments_ = parseHostedConvexReplacementArguments(options.arguments);
    const result = await replaceHostedConvexTarget({
      arguments: arguments_,
      ...(options.environment === undefined ? {} : { environment: options.environment }),
      ...(options.runner === undefined ? {} : { runner: options.runner }),
    });
    options.stdout.write(`${JSON.stringify(renderResult(result))}\n`);
    return 0;
  } catch (error: unknown) {
    const authorityUnavailable = renderAuthorityContainmentUnavailable(error);
    if (authorityUnavailable !== undefined) {
      options.stderr.write(authorityUnavailable);
      return 1;
    }
    const recovery = error instanceof Error ? writeRecoveryError(error, options.stderr) : undefined;
    if (recovery !== undefined) return recovery;
    const code = error instanceof HostedConvexReplacementError
      ? error.code
      : error instanceof ConvexTargetError
        ? "target_refused"
        : "provider_result_invalid";
    options.stderr.write(`${JSON.stringify({
      code,
      schemaVersion: 1,
      status: code.endsWith("indeterminate") ? "reconciliation_required" : "refused",
    })}\n`);
    return 1;
  }
}

if (import.meta.main) {
  let exitCode = 75;
  try {
    await recoverBoundedProcessJournal();
    exitCode = await executeHostedConvexReplacement({
      arguments: process.argv.slice(2),
      stderr: process.stderr,
      stdout: process.stdout,
    });
  } catch (error: unknown) {
    const authorityUnavailable = renderAuthorityContainmentUnavailable(error);
    if (authorityUnavailable !== undefined) {
      process.stderr.write(authorityUnavailable);
      exitCode = 1;
    } else {
      const recovery = error instanceof Error ? writeRecoveryError(error, process.stderr) : undefined;
      if (recovery !== undefined) exitCode = recovery;
      else {
        process.stderr.write(`${JSON.stringify({
          code: "provider_result_invalid",
          schemaVersion: 1,
          status: "refused",
        })}\n`);
        exitCode = 1;
      }
    }
  }
  process.exitCode = exitCode;
}

export type { CommandRequest, CommandResult };
