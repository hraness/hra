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
const scheduleInterpreterExecutionPolicyProofBrand: unique symbol = Symbol(
  "hra.schedule-interpreter-execution-policy-proof",
);
const scheduleInterpreterExecutionPolicyReceiptBrand: unique symbol = Symbol(
  "hra.schedule-interpreter-execution-policy-receipt",
);

export const HRA_PRODUCTION_EXECUTION_POLICY = Object.freeze({
  id: "hra.full-access.v1" as const,
  approvalPolicy: "never" as const,
  approvalsReviewer: "auto_review" as const,
  threadSandbox: "danger-full-access" as const,
  turnSandboxPolicy: Object.freeze({ type: "dangerFullAccess" as const }),
});

export const HRA_SCHEDULE_INTERPRETER_EXECUTION_POLICY = Object.freeze({
  id: "hra.schedule-interpreter-no-tools.v1" as const,
  approvalPolicy: "never" as const,
  approvalsReviewer: "auto_review" as const,
  threadSandbox: "read-only" as const,
  turnSandboxPolicy: Object.freeze({
    type: "readOnly" as const,
    networkAccess: false,
  }),
});

const scheduleInterpreterDisabledFeatures = Object.freeze({
  apps: false,
  artifact: false,
  auth_elicitation: false,
  browser_use: false,
  browser_use_external: false,
  browser_use_full_cdp_access: false,
  code_mode: false,
  code_mode_host: false,
  code_mode_only: false,
  computer_use: false,
  current_time_reminder: false,
  deferred_executor: false,
  enable_fanout: false,
  enable_mcp_apps: false,
  exec_permission_approvals: false,
  goals: false,
  guardian_approval: false,
  hooks: false,
  image_generation: false,
  in_app_browser: false,
  memories: false,
  multi_agent: false,
  multi_agent_mode: false,
  multi_agent_v2: false,
  network_proxy: false,
  plugin_hooks: false,
  plugin_sharing: false,
  plugins: false,
  realtime_conversation: false,
  remote_plugin: false,
  request_permissions_tool: false,
  rollout_budget: false,
  shell_snapshot: false,
  shell_tool: false,
  shell_zsh_fork: false,
  skill_mcp_dependency_install: false,
  standalone_web_search: false,
  token_budget: false,
  tool_call_mcp_elicitation: false,
  tool_suggest: false,
  unified_exec: false,
  unified_exec_zsh_fork: false,
  web_search_cached: false,
  web_search_request: false,
  workspace_dependencies: false,
});

export type ScheduleInterpreterExecutionPolicyProof = Readonly<{
  readonly policyId: typeof HRA_SCHEDULE_INTERPRETER_EXECUTION_POLICY.id;
  readonly generation: number;
  readonly requirementsPosition: CodexStreamPosition;
  readonly [scheduleInterpreterExecutionPolicyProofBrand]: true;
}>;

export type ScheduleInterpreterExecutionPolicyReceipt = Readonly<{
  readonly policyId: typeof HRA_SCHEDULE_INTERPRETER_EXECUTION_POLICY.id;
  readonly generation: number;
  readonly requirementsPosition: CodexStreamPosition;
  readonly admissionPosition: CodexStreamPosition;
  readonly isolatedRoot: string;
  readonly [scheduleInterpreterExecutionPolicyReceiptBrand]: true;
}>;

export class ScheduleInterpreterExecutionPolicyError extends Error {
  readonly reason:
    | "generation_mismatch"
    | "managed_requirements_rejected_policy"
    | "position_mismatch"
    | "proof_mismatch"
    | "request_policy_mismatch"
    | "response_policy_mismatch"
    | "workspace_roots_mismatch";

  constructor(reason: ScheduleInterpreterExecutionPolicyError["reason"]) {
    super("Codex cannot honor HRA's no-tool schedule-interpreter policy.");
    this.name = "ScheduleInterpreterExecutionPolicyError";
    this.reason = reason;
  }
}

/** Build the only thread config accepted by the control-plane interpreter. */
export function scheduleInterpreterThreadConfig(
  mcpServerNames: readonly string[],
): NonNullable<PinnedCodexThreadStartInput["config"]> {
  const mcpServers = Object.fromEntries(
    [...new Set(mcpServerNames)].sort().map((name) => [
      name,
      Object.freeze({ enabled: false }),
    ]),
  );
  return Object.freeze({
    model_reasoning_effort: "medium",
    web_search: "disabled",
    include_permissions_instructions: false,
    include_apps_instructions: false,
    include_collaboration_mode_instructions: false,
    include_environment_context: false,
    features: scheduleInterpreterDisabledFeatures,
    tools: Object.freeze({
      experimental_request_user_input: Object.freeze({ enabled: false }),
    }),
    orchestrator: Object.freeze({
      skills: Object.freeze({ enabled: false }),
      mcp: Object.freeze({ enabled: false }),
    }),
    skills: Object.freeze({
      include_instructions: false,
      bundled: Object.freeze({ enabled: false }),
    }),
    mcp_servers: Object.freeze(mcpServers),
  });
}

export function verifyScheduleInterpreterExecutionPolicyRequirements(
  input: Readonly<{
    readonly generation: number;
    readonly streamPosition: CodexStreamPosition;
    readonly output: PinnedCodexConfigRequirementsRead;
  }>,
): ScheduleInterpreterExecutionPolicyProof {
  requireScheduleInterpreterPositiveGeneration(input.generation);
  requireScheduleInterpreterStreamPosition(input.streamPosition);
  const requirements = input.output.requirements;
  if (
    requirements !== null &&
    (
      !admits(requirements.allowedApprovalPolicies, "never") ||
      !admits(requirements.allowedApprovalsReviewers, "auto_review") ||
      !admits(requirements.allowedSandboxModes, "read-only") ||
      !admits(requirements.allowedWebSearchModes ?? null, "disabled") ||
      requirements.hooks != null ||
      Object.values(requirements.featureRequirements ?? {}).some(Boolean)
    )
  ) {
    throw new ScheduleInterpreterExecutionPolicyError(
      "managed_requirements_rejected_policy",
    );
  }
  return Object.freeze({
    policyId: HRA_SCHEDULE_INTERPRETER_EXECUTION_POLICY.id,
    generation: input.generation,
    requirementsPosition: input.streamPosition,
    [scheduleInterpreterExecutionPolicyProofBrand]: true as const,
  });
}

export function verifyScheduleInterpreterThreadAdmission(input: Readonly<{
  readonly proof: ScheduleInterpreterExecutionPolicyProof;
  readonly generation: number;
  readonly streamPosition: CodexStreamPosition;
  readonly isolatedRoot: string;
  readonly disabledMcpServerNames: readonly string[];
  readonly developerInstructions: string;
  readonly request: PinnedCodexThreadStartInput;
  readonly response: PinnedCodexThreadAdmissionResponse;
}>): ScheduleInterpreterExecutionPolicyReceipt {
  requireScheduleInterpreterSameGeneration(input.proof, input.generation);
  requireScheduleInterpreterAdmissionAfterPreflight(input.proof, input.streamPosition);
  const expectedConfig = scheduleInterpreterThreadConfig(input.disabledMcpServerNames);
  if (
    input.request.approvalPolicy !== HRA_SCHEDULE_INTERPRETER_EXECUTION_POLICY.approvalPolicy ||
    input.request.approvalsReviewer !== HRA_SCHEDULE_INTERPRETER_EXECUTION_POLICY.approvalsReviewer ||
    input.request.sandbox !== HRA_SCHEDULE_INTERPRETER_EXECUTION_POLICY.threadSandbox ||
    input.request.cwd !== input.isolatedRoot ||
    input.request.developerInstructions !== input.developerInstructions ||
    input.request.ephemeral !== true ||
    input.request.historyMode !== "paginated" ||
    input.request.threadSource !== "appServer" ||
    !isEmptyTuple(input.request.environments) ||
    !isEmptyTuple(input.request.selectedCapabilityRoots) ||
    !sameJsonValue(input.request.config, expectedConfig)
  ) {
    throw new ScheduleInterpreterExecutionPolicyError("request_policy_mismatch");
  }
  if (
    input.response.approvalPolicy !== HRA_SCHEDULE_INTERPRETER_EXECUTION_POLICY.approvalPolicy ||
    input.response.approvalsReviewer !== HRA_SCHEDULE_INTERPRETER_EXECUTION_POLICY.approvalsReviewer ||
    input.response.sandbox.type !== "readOnly" ||
    input.response.sandbox.networkAccess !== false ||
    input.response.thread.cwd !== input.isolatedRoot ||
    input.response.thread.ephemeral !== true ||
    input.response.thread.turns.length !== 0
  ) {
    throw new ScheduleInterpreterExecutionPolicyError("response_policy_mismatch");
  }
  const roots = input.request.runtimeWorkspaceRoots;
  if (
    roots === undefined ||
    roots === null ||
    roots.length !== 1 ||
    roots[0] !== input.isolatedRoot ||
    !sameStringArray(roots, input.response.runtimeWorkspaceRoots)
  ) {
    throw new ScheduleInterpreterExecutionPolicyError("workspace_roots_mismatch");
  }
  return Object.freeze({
    policyId: input.proof.policyId,
    generation: input.proof.generation,
    requirementsPosition: input.proof.requirementsPosition,
    admissionPosition: input.streamPosition,
    isolatedRoot: input.isolatedRoot,
    [scheduleInterpreterExecutionPolicyReceiptBrand]: true as const,
  });
}

export function verifyScheduleInterpreterTurnAdmission(input: Readonly<{
  readonly proof: ScheduleInterpreterExecutionPolicyProof;
  readonly threadReceipt: ScheduleInterpreterExecutionPolicyReceipt;
  readonly generation: number;
  readonly streamPosition: CodexStreamPosition;
  readonly threadId: string;
  readonly developerInstructions: string;
  readonly request: PinnedCodexTurnStartInput;
}>): ScheduleInterpreterExecutionPolicyReceipt {
  requireScheduleInterpreterSameGeneration(input.proof, input.generation);
  requireScheduleInterpreterAdmissionAfterPreflight(input.proof, input.streamPosition);
  const receipt = input.threadReceipt;
  if (
    receipt[scheduleInterpreterExecutionPolicyReceiptBrand] !== true ||
    receipt.policyId !== HRA_SCHEDULE_INTERPRETER_EXECUTION_POLICY.id ||
    receipt.generation !== input.generation ||
    receipt.admissionPosition <= receipt.requirementsPosition
  ) {
    throw new ScheduleInterpreterExecutionPolicyError("proof_mismatch");
  }
  const roots = input.request.runtimeWorkspaceRoots;
  const collaborationMode = input.request.collaborationMode;
  if (
    input.request.threadId !== input.threadId ||
    input.request.cwd !== receipt.isolatedRoot ||
    roots === undefined ||
    roots === null ||
    roots.length !== 1 ||
    roots[0] !== receipt.isolatedRoot ||
    !isEmptyTuple(input.request.environments) ||
    input.request.approvalPolicy !== HRA_SCHEDULE_INTERPRETER_EXECUTION_POLICY.approvalPolicy ||
    input.request.approvalsReviewer !== HRA_SCHEDULE_INTERPRETER_EXECUTION_POLICY.approvalsReviewer ||
    input.request.sandboxPolicy?.type !== "readOnly" ||
    input.request.sandboxPolicy.networkAccess !== false ||
    collaborationMode?.mode !== "plan" ||
    collaborationMode.settings.developer_instructions !== input.developerInstructions
  ) {
    throw new ScheduleInterpreterExecutionPolicyError("request_policy_mismatch");
  }
  return Object.freeze({
    policyId: input.proof.policyId,
    generation: input.proof.generation,
    requirementsPosition: input.proof.requirementsPosition,
    admissionPosition: input.streamPosition,
    isolatedRoot: receipt.isolatedRoot,
    [scheduleInterpreterExecutionPolicyReceiptBrand]: true as const,
  });
}

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
  readonly executionSettingsRevision: number;
  readonly runtimeWorkspaceRoots: readonly string[];
  readonly [productionExecutionPolicyReceiptBrand]: true;
}>;

export class ProductionExecutionPolicyError extends Error {
  readonly reason:
    | "generation_mismatch"
    | "managed_requirements_rejected_policy"
    | "position_mismatch"
    | "proof_mismatch"
    | "request_policy_mismatch"
    | "response_policy_mismatch"
    | "workspace_roots_mismatch";

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
  readonly executionSettingsRevision?: number;
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
  const roots = input.request.runtimeWorkspaceRoots;
  if (
    roots === undefined
    || roots === null
    || roots.length !== 1
    || !sameStringArray(roots, input.response.runtimeWorkspaceRoots)
  ) {
    throw new ProductionExecutionPolicyError("workspace_roots_mismatch");
  }
  return receipt(
    input.proof,
    input.streamPosition,
    roots,
    input.executionSettingsRevision ?? 0,
  );
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
  readonly executionSettingsRevision?: number;
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
    input.threadReceipt.admissionPosition <= input.threadReceipt.requirementsPosition ||
    input.threadReceipt.executionSettingsRevision !==
      (input.executionSettingsRevision ?? 0)
  ) {
    throw new ProductionExecutionPolicyError("proof_mismatch");
  }
  const roots = input.request.runtimeWorkspaceRoots;
  if (
    roots === undefined
    || roots === null
    || roots.length !== 1
    || !sameStringArray(roots, input.threadReceipt.runtimeWorkspaceRoots)
  ) {
    throw new ProductionExecutionPolicyError("workspace_roots_mismatch");
  }
  if (
    input.request.approvalPolicy !== HRA_PRODUCTION_EXECUTION_POLICY.approvalPolicy ||
    input.request.approvalsReviewer !== HRA_PRODUCTION_EXECUTION_POLICY.approvalsReviewer ||
    input.request.sandboxPolicy?.type !== "dangerFullAccess"
  ) {
    throw new ProductionExecutionPolicyError("request_policy_mismatch");
  }
  return receipt(
    input.proof,
    input.streamPosition,
    roots,
    input.executionSettingsRevision ?? 0,
  );
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
  runtimeWorkspaceRoots: readonly string[],
  executionSettingsRevision: number,
): ProductionExecutionPolicyReceipt {
  if (
    !Number.isSafeInteger(executionSettingsRevision) ||
    executionSettingsRevision < 0
  ) {
    throw new ProductionExecutionPolicyError("proof_mismatch");
  }
  return Object.freeze({
    policyId: proof.policyId,
    generation: proof.generation,
    requirementsPosition: proof.requirementsPosition,
    admissionPosition,
    executionSettingsRevision,
    runtimeWorkspaceRoots: Object.freeze([...runtimeWorkspaceRoots]),
    [productionExecutionPolicyReceiptBrand]: true as const,
  });
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function isEmptyTuple(value: readonly unknown[] | null | undefined): value is readonly [] {
  return Array.isArray(value) && value.length === 0;
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => sameJsonValue(entry, right[index]));
  }
  if (
    typeof left !== "object" || left === null ||
    typeof right !== "object" || right === null
  ) {
    return false;
  }
  const leftRecord = left as Readonly<Record<string, unknown>>;
  const rightRecord = right as Readonly<Record<string, unknown>>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return sameStringArray(leftKeys, rightKeys) &&
    leftKeys.every((key) => sameJsonValue(leftRecord[key], rightRecord[key]));
}

function requireScheduleInterpreterPositiveGeneration(generation: number): void {
  if (!Number.isSafeInteger(generation) || generation <= 0) {
    throw new ScheduleInterpreterExecutionPolicyError("generation_mismatch");
  }
}

function requireScheduleInterpreterSameGeneration(
  proof: ScheduleInterpreterExecutionPolicyProof,
  generation: number,
): void {
  requireScheduleInterpreterPositiveGeneration(generation);
  if (
    proof[scheduleInterpreterExecutionPolicyProofBrand] !== true ||
    proof.policyId !== HRA_SCHEDULE_INTERPRETER_EXECUTION_POLICY.id ||
    proof.generation !== generation
  ) {
    throw new ScheduleInterpreterExecutionPolicyError("generation_mismatch");
  }
  requireScheduleInterpreterStreamPosition(proof.requirementsPosition);
}

function requireScheduleInterpreterAdmissionAfterPreflight(
  proof: ScheduleInterpreterExecutionPolicyProof,
  admissionPosition: CodexStreamPosition,
): void {
  requireScheduleInterpreterStreamPosition(admissionPosition);
  if (admissionPosition <= proof.requirementsPosition) {
    throw new ScheduleInterpreterExecutionPolicyError("position_mismatch");
  }
}

function requireScheduleInterpreterStreamPosition(
  streamPosition: CodexStreamPosition,
): void {
  if (!Number.isSafeInteger(streamPosition) || streamPosition <= 0) {
    throw new ScheduleInterpreterExecutionPolicyError("position_mismatch");
  }
}
