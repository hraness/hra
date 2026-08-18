import type {
  PinnedCodexConfigRequirementsRead,
  PinnedCodexThreadAdmissionResponse,
  PinnedCodexThreadResumeInput,
  PinnedCodexThreadStartInput,
  PinnedCodexTurnStartInput,
} from "./pinned-codecs";
import type { CodexStreamPosition } from "./rpc-core";

const productionExecutionPolicyProofBrand: unique symbol = Symbol(
  "hra.production-execution-policy-proof",
);
const productionExecutionPolicyReceiptBrand: unique symbol = Symbol(
  "hra.production-execution-policy-receipt",
);

export const HRA_PRODUCTION_EXECUTION_POLICY = Object.freeze({
  id: "hra.full-access.v1" as const,
  approvalPolicy: "never" as const,
  approvalsReviewer: "auto_review" as const,
  threadSandbox: "danger-full-access" as const,
  turnSandboxPolicy: Object.freeze({ type: "dangerFullAccess" as const }),
});

export type ProductionExecutionPolicyProof = Readonly<{
  readonly policyId: typeof HRA_PRODUCTION_EXECUTION_POLICY.id;
  readonly generation: number;
  readonly requirementsPosition: CodexStreamPosition;
  readonly [productionExecutionPolicyProofBrand]: true;
}>;

/**
 * Opaque evidence that one mutation used the immutable production policy in
 * the same process generation as its managed-requirements preflight.
 */
export type ProductionExecutionPolicyReceipt = Readonly<{
  readonly policyId: typeof HRA_PRODUCTION_EXECUTION_POLICY.id;
  readonly generation: number;
  readonly requirementsPosition: CodexStreamPosition;
  readonly admissionPosition: CodexStreamPosition;
  readonly [productionExecutionPolicyReceiptBrand]: true;
}>;

export class ProductionExecutionPolicyError extends Error {
  readonly reason:
    | "generation_mismatch"
    | "managed_requirements_rejected_policy"
    | "position_mismatch"
    | "proof_mismatch"
    | "request_policy_mismatch"
    | "response_policy_mismatch";

  constructor(reason: ProductionExecutionPolicyError["reason"]) {
    super("Codex cannot honor HRA's immutable production execution policy.");
    this.name = "ProductionExecutionPolicyError";
    this.reason = reason;
  }
}

/** Fail closed when effective managed requirements exclude any policy field. */
export function verifyProductionExecutionPolicyRequirements(input: Readonly<{
  readonly generation: number;
  readonly streamPosition: CodexStreamPosition;
  readonly output: PinnedCodexConfigRequirementsRead;
}>): ProductionExecutionPolicyProof {
  requirePositiveGeneration(input.generation);
  requireStreamPosition(input.streamPosition);
  const requirements = input.output.requirements;
  if (
    requirements !== null &&
    (
      !admits(requirements.allowedApprovalPolicies, "never") ||
      !admits(requirements.allowedApprovalsReviewers, "auto_review") ||
      !admits(requirements.allowedSandboxModes, "danger-full-access")
    )
  ) {
    throw new ProductionExecutionPolicyError(
      "managed_requirements_rejected_policy",
    );
  }
  return Object.freeze({
    policyId: HRA_PRODUCTION_EXECUTION_POLICY.id,
    generation: input.generation,
    requirementsPosition: input.streamPosition,
    [productionExecutionPolicyProofBrand]: true as const,
  });
}

/** Verify both the outbound policy and the settings returned by Codex. */
export function verifyProductionThreadAdmission(input: Readonly<{
  readonly proof: ProductionExecutionPolicyProof;
  readonly generation: number;
  readonly streamPosition: CodexStreamPosition;
  readonly request: PinnedCodexThreadStartInput | PinnedCodexThreadResumeInput;
  readonly response: PinnedCodexThreadAdmissionResponse;
}>): ProductionExecutionPolicyReceipt {
  requireSameGeneration(input.proof, input.generation);
  requireAdmissionAfterPreflight(input.proof, input.streamPosition);
  if (
    input.request.approvalPolicy !== HRA_PRODUCTION_EXECUTION_POLICY.approvalPolicy ||
    input.request.approvalsReviewer !== HRA_PRODUCTION_EXECUTION_POLICY.approvalsReviewer ||
    input.request.sandbox !== HRA_PRODUCTION_EXECUTION_POLICY.threadSandbox
  ) {
    throw new ProductionExecutionPolicyError("request_policy_mismatch");
  }
  if (
    input.response.approvalPolicy !== HRA_PRODUCTION_EXECUTION_POLICY.approvalPolicy ||
    input.response.approvalsReviewer !== HRA_PRODUCTION_EXECUTION_POLICY.approvalsReviewer ||
    input.response.sandbox.type !== "dangerFullAccess"
  ) {
    throw new ProductionExecutionPolicyError("response_policy_mismatch");
  }
  return receipt(input.proof, input.streamPosition);
}

/**
 * `turn/start` has no returned settings in 0.144.6, so admission is proven by
 * the exact request, the existing verified thread, and one fresh preflight in
 * the same generation.
 */
export function verifyProductionTurnAdmission(input: Readonly<{
  readonly proof: ProductionExecutionPolicyProof;
  readonly threadReceipt: ProductionExecutionPolicyReceipt;
  readonly generation: number;
  readonly streamPosition: CodexStreamPosition;
  readonly request: PinnedCodexTurnStartInput;
}>): ProductionExecutionPolicyReceipt {
  requireSameGeneration(input.proof, input.generation);
  requireAdmissionAfterPreflight(input.proof, input.streamPosition);
  if (
    input.threadReceipt[productionExecutionPolicyReceiptBrand] !== true ||
    input.threadReceipt.policyId !== HRA_PRODUCTION_EXECUTION_POLICY.id ||
    input.threadReceipt.generation !== input.generation ||
    !Number.isSafeInteger(input.threadReceipt.requirementsPosition) ||
    !Number.isSafeInteger(input.threadReceipt.admissionPosition) ||
    input.threadReceipt.requirementsPosition <= 0 ||
    input.threadReceipt.admissionPosition <= input.threadReceipt.requirementsPosition
  ) {
    throw new ProductionExecutionPolicyError("proof_mismatch");
  }
  if (
    input.request.approvalPolicy !== HRA_PRODUCTION_EXECUTION_POLICY.approvalPolicy ||
    input.request.approvalsReviewer !== HRA_PRODUCTION_EXECUTION_POLICY.approvalsReviewer ||
    input.request.sandboxPolicy?.type !== "dangerFullAccess"
  ) {
    throw new ProductionExecutionPolicyError("request_policy_mismatch");
  }
  return receipt(input.proof, input.streamPosition);
}

export function isProductionApprovalRequestMethod(method: string): boolean {
  return method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval" ||
    method === "item/permissions/requestApproval" ||
    method === "applyPatchApproval" ||
    method === "execCommandApproval";
}

function admits<T>(values: readonly T[] | null, required: T): boolean {
  return values === null || values.some((value) => value === required);
}

function requirePositiveGeneration(generation: number): void {
  if (!Number.isSafeInteger(generation) || generation <= 0) {
    throw new ProductionExecutionPolicyError("generation_mismatch");
  }
}

function requireSameGeneration(
  proof: ProductionExecutionPolicyProof,
  generation: number,
): void {
  requirePositiveGeneration(generation);
  if (
    proof[productionExecutionPolicyProofBrand] !== true ||
    proof.policyId !== HRA_PRODUCTION_EXECUTION_POLICY.id ||
    proof.generation !== generation
  ) {
    throw new ProductionExecutionPolicyError("generation_mismatch");
  }
  requireStreamPosition(proof.requirementsPosition);
}

function requireAdmissionAfterPreflight(
  proof: ProductionExecutionPolicyProof,
  admissionPosition: CodexStreamPosition,
): void {
  requireStreamPosition(admissionPosition);
  if (admissionPosition <= proof.requirementsPosition) {
    throw new ProductionExecutionPolicyError("position_mismatch");
  }
}

function requireStreamPosition(streamPosition: CodexStreamPosition): void {
  if (!Number.isSafeInteger(streamPosition) || streamPosition <= 0) {
    throw new ProductionExecutionPolicyError("position_mismatch");
  }
}

function receipt(
  proof: ProductionExecutionPolicyProof,
  admissionPosition: CodexStreamPosition,
): ProductionExecutionPolicyReceipt {
  return Object.freeze({
    policyId: proof.policyId,
    generation: proof.generation,
    requirementsPosition: proof.requirementsPosition,
    admissionPosition,
    [productionExecutionPolicyReceiptBrand]: true as const,
  });
}
