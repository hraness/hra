import { createHash } from "node:crypto";

import { z } from "zod";

import type { CodexAccountProjection, ProfileAuthority } from "../daemon/ports.ts";
import { profileIdSchema } from "../domain/values.ts";
import { CODEX_ELECTRON_USER_DATA_PATH, CODEX_HOME } from "./bundle.ts";
import { deriveDesktopProfilePaths } from "./profile.ts";
import type {
  DesktopBundlePort,
  DesktopProcessIdentity,
  DesktopProcessPort,
  DesktopSwitchLockPort,
} from "./switch.ts";

const diagnosticSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/u);

const environmentEntrySchema = z
  .object({
    name: z.enum([CODEX_HOME, CODEX_ELECTRON_USER_DATA_PATH]),
    value: z.string().min(1).max(4096),
  })
  .strict();

export const desktopRecoveryInstanceSchema = z
  .object({
    pid: z.number().int().positive(),
    uid: z.number().int().nonnegative(),
    executablePath: z.string().min(1).max(4096),
    identityToken: z.string().regex(/^[a-f0-9]{64}$/u),
    environment: z.array(environmentEntrySchema).max(4),
  })
  .strict();

const accountSchema = z
  .object({
    signedIn: z.boolean(),
    email: z.string().trim().email().max(320).optional(),
    plan: z.string().trim().min(1).max(160).optional(),
  })
  .strict();

const accountObservationSchema = z
  .object({
    status: z.literal("observed"),
    desktopPid: z.number().int().positive(),
    uid: z.number().int().nonnegative(),
    identityToken: z.string().regex(/^[a-f0-9]{64}$/u),
    executablePath: z.string().min(1).max(4096),
    bundleCdHash: z.string().regex(/^[a-f0-9]{40,128}$/u),
    codexHome: z.string().min(1).max(4096),
    desktopUserData: z.string().min(1).max(4096),
    account: accountSchema,
  })
  .strict();

const bindingShape = {
  attemptId: z.string().regex(/^attempt_[a-f0-9]{32}$/u),
  idempotencyKey: z.string().uuid(),
  switchGeneration: z.number().int().positive(),
  sourceProfileId: profileIdSchema.nullable(),
  sourceProcessGeneration: z.number().int().positive().nullable(),
  targetProfileId: profileIdSchema,
  targetProcessGeneration: z.number().int().positive(),
} as const;

const recoveryRequiredPlanSchema = z
  .object({
    status: z.literal("recovery_required"),
    ...bindingShape,
    originalPhase: z.enum([
      "prepared",
      "quit_started",
      "quit_confirmed",
      "launch_started",
      "verify_started",
      "ambiguous",
    ]),
    diagnostic: diagnosticSchema,
    recoveryDeadlineAt: z.number().int().nonnegative(),
    bundleCdHash: z.string().regex(/^[a-f0-9]{40,128}$/u),
    sourcePid: z.number().int().positive().nullable(),
    launchedPid: z.number().int().positive().nullable(),
    expectedAccountKey: z.string().trim().email().max(320),
  })
  .strict();

const resolvedPlanSchema = z
  .object({
    status: z.enum(["resolved_applied", "resolved_not_applied"]),
    ...bindingShape,
    diagnostic: diagnosticSchema,
    observationDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    resolvedAt: z.number().int().nonnegative(),
    activeAccount: accountSchema.optional(),
  })
  .strict();

const recoveryPlanSchema = z.union([
  z.object({ status: z.literal("none") }).strict(),
  z
    .object({
      status: z.literal("in_progress"),
      idempotencyKey: z.string().uuid(),
      switchGeneration: z.number().int().positive(),
      targetProfileId: profileIdSchema,
      phase: z.enum(["prepared", "quit_started", "quit_confirmed", "launch_started", "verify_started"]),
    })
    .strict(),
  recoveryRequiredPlanSchema,
  resolvedPlanSchema,
]);

export type DesktopRecoveryBinding = Pick<
  z.infer<typeof recoveryRequiredPlanSchema>,
  | "attemptId"
  | "idempotencyKey"
  | "switchGeneration"
  | "sourceProfileId"
  | "sourceProcessGeneration"
  | "targetProfileId"
  | "targetProcessGeneration"
>;

export type DesktopRecoveryResolution = "resolved_applied" | "resolved_not_applied";

export interface DesktopRecoveryStorePort {
  readCurrentDesktopSwitchRecovery(): unknown;
  resolveDesktopSwitchRecovery(input: DesktopRecoveryBinding & {
    readonly resolution: DesktopRecoveryResolution;
    readonly diagnostic: string;
    readonly observationDigest: string;
    readonly activeAccount?: CodexAccountProjection;
  }): unknown;
  quarantineDesktopSwitchTarget(input: DesktopRecoveryBinding): boolean | Promise<boolean>;
}

export interface DesktopRecoveryRuntimePort {
  desktopInstanceObservationCapability?(): Promise<unknown>;
  /** Must reject any PID that is not owned by the current user. */
  inspectDesktopInstance?(pid: number): Promise<unknown>;
  observeDesktopInstanceAccount(input: {
    readonly authority: ProfileAuthority;
    readonly instance: {
      readonly pid: number;
      readonly executablePath: string;
      readonly bundleCdHash: string;
      readonly codexHome: string;
      readonly desktopUserData: string;
    };
    readonly signal: AbortSignal;
  }): Promise<unknown>;
}

export type DesktopRecoveryResult =
  | { readonly status: "none" }
  | {
      readonly status: "in_progress";
      readonly idempotencyKey: string;
      readonly switchGeneration: number;
      readonly targetProfileId: string;
      readonly phase: string;
    }
  | {
      readonly status: DesktopRecoveryResolution;
      readonly idempotencyKey: string;
      readonly switchGeneration: number;
      readonly targetProfileId: string;
      readonly diagnostic: string;
      readonly observationDigest: string;
      readonly resolvedAt: number;
      readonly activeAccount?: CodexAccountProjection;
    }
  | {
      readonly status: "recovery_required";
      readonly idempotencyKey: string;
      readonly switchGeneration: number;
      readonly targetProfileId: string;
      readonly diagnostic: string;
      readonly action: "hra account switch-recover";
    };

export interface DesktopSwitchRecoveryControllerInput {
  readonly stateRoot: string;
  readonly store: DesktopRecoveryStorePort;
  readonly runtime: DesktopRecoveryRuntimePort;
  readonly bundle: DesktopBundlePort;
  readonly process: DesktopProcessPort;
  readonly lock: DesktopSwitchLockPort;
  readonly now?: () => number;
  readonly betweenScans?: () => Promise<void>;
}

/**
 * Read-only reconciliation for the current desktop-switch authority. It never
 * quits, launches, copies, retries, or writes provider credentials. The only
 * writes are a CAS-bound resolution receipt or target-profile quarantine.
 */
export class DesktopSwitchRecoveryController {
  readonly #input: DesktopSwitchRecoveryControllerInput;

  constructor(input: DesktopSwitchRecoveryControllerInput) {
    this.#input = input;
  }

  async recover(signal: AbortSignal): Promise<DesktopRecoveryResult> {
    assertNotAborted(signal);
    return this.#input.lock.withLock(async () => this.#recoverLocked(signal));
  }

  async #recoverLocked(signal: AbortSignal): Promise<DesktopRecoveryResult> {
    const parsedPlan = recoveryPlanSchema.parse(
      await this.#input.store.readCurrentDesktopSwitchRecovery(),
    );
    if (parsedPlan.status === "none" || parsedPlan.status === "in_progress") return parsedPlan;
    if (parsedPlan.status !== "recovery_required") {
      return publicResolved(resolvedPlanSchema.parse(parsedPlan));
    }
    const plan = recoveryRequiredPlanSchema.parse(parsedPlan);

    const unresolved = (diagnostic: string): DesktopRecoveryResult => ({
      status: "recovery_required",
      idempotencyKey: plan.idempotencyKey,
      switchGeneration: plan.switchGeneration,
      targetProfileId: plan.targetProfileId,
      diagnostic: diagnosticSchema.parse(diagnostic),
      action: "hra account switch-recover",
    });

    assertNotAborted(signal);
    const capability = await this.#input.bundle.inspect().catch(() => null);
    if (capability === null || capability.cdHash !== plan.bundleCdHash) {
      return unresolved("REVIEWED_BUNDLE_MISMATCH");
    }
    const runtimeCapability = await this.#input.runtime
      .desktopInstanceObservationCapability?.()
      .catch(() => ({ status: "unsupported" }));
    if (
      runtimeCapability === undefined ||
      !z
        .object({ status: z.literal("supported"), mechanism: z.literal("pid-bound-desktop-account-v1") })
        .strict()
        .safeParse(runtimeCapability).success ||
      this.#input.runtime.inspectDesktopInstance === undefined
    ) {
      return unresolved("INSTANCE_OBSERVATION_UNAVAILABLE");
    }

    const firstProcesses = await safeList(this.#input.process, capability.executablePath);
    if (firstProcesses === null) return unresolved("PROCESS_OBSERVATION_UNAVAILABLE");
    if (firstProcesses.length > 1) return unresolved("MULTIPLE_EXACT_PROCESSES");
    if (firstProcesses.length === 0) {
      await this.#betweenScans();
      const secondProcesses = await safeList(this.#input.process, capability.executablePath);
      if (secondProcesses === null) return unresolved("PROCESS_OBSERVATION_UNAVAILABLE");
      if (secondProcesses.length !== 0) return unresolved("PROCESS_SET_CHANGED");
      if (this.#now() < plan.recoveryDeadlineAt) return unresolved("RECOVERY_DEADLINE_PENDING");
      return this.#resolve(plan, "resolved_not_applied", "ZERO_EXACT_PROCESSES", {
        firstProcesses,
        secondProcesses,
      });
    }

    const firstProcess = firstProcesses[0];
    if (firstProcess === undefined) return unresolved("PROCESS_SET_CHANGED");
    const firstInstance = await this.#inspect(firstProcess);
    if (firstInstance === null) return unresolved("INSTANCE_OBSERVATION_UNAVAILABLE");
    if (firstInstance.executablePath !== capability.executablePath) {
      return unresolved("INSTANCE_EXECUTABLE_MISMATCH");
    }
    const targetPaths = deriveDesktopProfilePaths(this.#input.stateRoot, plan.targetProfileId);
    const profileBinding = profileEnvironment(firstInstance.environment);
    if (profileBinding === null) return unresolved("TARGET_ENVIRONMENT_UNVERIFIABLE");
    const isTarget =
      profileBinding.codexHome === targetPaths.codexHome &&
      profileBinding.desktopUserData === targetPaths.desktopUserData;

    let accountObservation: z.infer<typeof accountObservationSchema> | undefined;
    if (isTarget) {
      try {
        accountObservation = accountObservationSchema.parse(
          await this.#input.runtime.observeDesktopInstanceAccount({
            authority: {
              id: plan.targetProfileId,
              generation: plan.targetProcessGeneration,
              codexHome: targetPaths.codexHome,
              desktopUserData: targetPaths.desktopUserData,
            },
            instance: {
              pid: firstProcess.pid,
              executablePath: capability.executablePath,
              bundleCdHash: capability.cdHash,
              codexHome: targetPaths.codexHome,
              desktopUserData: targetPaths.desktopUserData,
            },
            signal,
          }),
        );
      } catch {
        return unresolved("TARGET_ACCOUNT_OBSERVATION_UNAVAILABLE");
      }
    }

    await this.#betweenScans();
    const secondProcesses = await safeList(this.#input.process, capability.executablePath);
    if (secondProcesses === null) return unresolved("PROCESS_OBSERVATION_UNAVAILABLE");
    if (
      secondProcesses.length !== 1 ||
      secondProcesses[0]?.pid !== firstProcess.pid ||
      secondProcesses[0].executablePath !== firstProcess.executablePath
    ) {
      return unresolved(secondProcesses.length > 1 ? "MULTIPLE_EXACT_PROCESSES" : "PROCESS_SET_CHANGED");
    }
    const secondInstance = await this.#inspect(secondProcesses[0]);
    if (secondInstance === null || !sameInstance(firstInstance, secondInstance)) {
      return unresolved("PROCESS_IDENTITY_CHANGED");
    }

    const evidence = {
      firstProcesses,
      firstInstance,
      accountObservation: accountObservation ?? null,
      secondProcesses,
      secondInstance,
      reviewedCdHash: capability.cdHash,
    };
    if (!isTarget) {
      if (this.#now() < plan.recoveryDeadlineAt) return unresolved("RECOVERY_DEADLINE_PENDING");
      return this.#resolve(plan, "resolved_not_applied", "STABLE_NON_TARGET_PROCESS", evidence);
    }

    if (
      accountObservation === undefined ||
      accountObservation.desktopPid !== firstInstance.pid ||
      accountObservation.uid !== firstInstance.uid ||
      accountObservation.identityToken !== firstInstance.identityToken ||
      accountObservation.executablePath !== capability.executablePath ||
      accountObservation.bundleCdHash !== capability.cdHash ||
      accountObservation.codexHome !== targetPaths.codexHome ||
      accountObservation.desktopUserData !== targetPaths.desktopUserData
    ) {
      return unresolved("TARGET_INSTANCE_BINDING_MISMATCH");
    }
    const observedAccount = toAccountProjection(accountObservation.account);
    const observedKey = normalizedAccountKey(observedAccount);
    if (observedKey !== plan.expectedAccountKey) {
      await this.#input.store.quarantineDesktopSwitchTarget(plan);
      return unresolved("TARGET_ACCOUNT_MISMATCH");
    }
    return this.#resolve(
      plan,
      "resolved_applied",
      "STABLE_TARGET_ACCOUNT_VERIFIED",
      evidence,
      observedAccount,
    );
  }

  async #inspect(process: DesktopProcessIdentity) {
    try {
      const observed = desktopRecoveryInstanceSchema.parse(
        await this.#input.runtime.inspectDesktopInstance?.(process.pid),
      );
      return observed.pid === process.pid && observed.executablePath === process.executablePath
        ? observed
        : null;
    } catch {
      return null;
    }
  }

  async #resolve(
    plan: z.infer<typeof recoveryRequiredPlanSchema>,
    resolution: DesktopRecoveryResolution,
    diagnostic: string,
    evidence: unknown,
    activeAccount?: CodexAccountProjection,
  ): Promise<DesktopRecoveryResult> {
    const observationDigest = digestEvidence(evidence);
    try {
      const result = recoveryPlanSchema.parse(
        await this.#input.store.resolveDesktopSwitchRecovery({
          ...binding(plan),
          resolution,
          diagnostic,
          observationDigest,
          ...(activeAccount === undefined ? {} : { activeAccount }),
        }),
      );
      if (result.status !== "resolved_applied" && result.status !== "resolved_not_applied") {
        throw new Error("Desktop recovery store did not return a resolution receipt.");
      }
      return publicResolved(result);
    } catch {
      return {
        status: "recovery_required",
        idempotencyKey: plan.idempotencyKey,
        switchGeneration: plan.switchGeneration,
        targetProfileId: plan.targetProfileId,
        diagnostic: "RECOVERY_AUTHORITY_CHANGED",
        action: "hra account switch-recover",
      };
    }
  }

  #now(): number {
    return (this.#input.now ?? Date.now)();
  }

  async #betweenScans(): Promise<void> {
    if (this.#input.betweenScans !== undefined) {
      await this.#input.betweenScans();
      return;
    }
    await Bun.sleep(250);
  }
}

function binding(plan: z.infer<typeof recoveryRequiredPlanSchema>): DesktopRecoveryBinding {
  return {
    attemptId: plan.attemptId,
    idempotencyKey: plan.idempotencyKey,
    switchGeneration: plan.switchGeneration,
    sourceProfileId: plan.sourceProfileId,
    sourceProcessGeneration: plan.sourceProcessGeneration,
    targetProfileId: plan.targetProfileId,
    targetProcessGeneration: plan.targetProcessGeneration,
  };
}

function profileEnvironment(environment: readonly z.infer<typeof environmentEntrySchema>[]): {
  readonly codexHome: string;
  readonly desktopUserData: string;
} | null {
  const homes = environment.filter((entry) => entry.name === CODEX_HOME);
  const userData = environment.filter((entry) => entry.name === CODEX_ELECTRON_USER_DATA_PATH);
  if (homes.length !== 1 || userData.length !== 1) return null;
  const codexHome = homes[0]?.value;
  const desktopUserData = userData[0]?.value;
  if (codexHome === undefined || desktopUserData === undefined) return null;
  return { codexHome, desktopUserData };
}

function sameInstance(
  left: z.infer<typeof desktopRecoveryInstanceSchema>,
  right: z.infer<typeof desktopRecoveryInstanceSchema>,
): boolean {
  return (
    left.pid === right.pid &&
    left.uid === right.uid &&
    left.executablePath === right.executablePath &&
    left.identityToken === right.identityToken &&
    JSON.stringify(left.environment) === JSON.stringify(right.environment)
  );
}

async function safeList(
  process: DesktopProcessPort,
  executablePath: string,
): Promise<readonly DesktopProcessIdentity[] | null> {
  try {
    return await process.listExact(executablePath);
  } catch {
    return null;
  }
}

function digestEvidence(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalizedAccountKey(account: CodexAccountProjection): string | null {
  const parsed = accountSchema.parse(account);
  if (!parsed.signedIn || parsed.email === undefined) return null;
  return parsed.email.normalize("NFKC").toLocaleLowerCase("en-US");
}

function toAccountProjection(value: z.infer<typeof accountSchema>): CodexAccountProjection {
  return {
    signedIn: value.signedIn,
    ...(value.email === undefined ? {} : { email: value.email }),
    ...(value.plan === undefined ? {} : { plan: value.plan }),
  };
}

function publicResolved(plan: z.infer<typeof resolvedPlanSchema>): DesktopRecoveryResult {
  return {
    status: plan.status,
    idempotencyKey: plan.idempotencyKey,
    switchGeneration: plan.switchGeneration,
    targetProfileId: plan.targetProfileId,
    diagnostic: plan.diagnostic,
    observationDigest: plan.observationDigest,
    resolvedAt: plan.resolvedAt,
    ...(plan.activeAccount === undefined
      ? {}
      : { activeAccount: toAccountProjection(plan.activeAccount) }),
  };
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
  }
}
