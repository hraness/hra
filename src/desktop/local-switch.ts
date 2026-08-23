import { constants } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { link, lstat, open, realpath, unlink, type FileHandle } from "node:fs/promises";

import { z } from "zod";

import type { CodexAccountProjection, DesktopSwitchPort, ProfileAuthority } from "../daemon/ports.ts";
import { profileIdSchema } from "../domain/values.ts";
import type { StatePaths } from "../storage/paths.ts";
import { inspectChatGptBundle } from "./bundle.ts";
import { DesktopSwitchError } from "./errors.ts";
import { MacOsDesktopProcessPort } from "./macos-process.ts";
import { deriveDesktopProfilePaths } from "./profile.ts";
import {
  DesktopSwitchRecoveryController,
  type DesktopRecoveryResult,
  type DesktopRecoveryRuntimePort,
  type DesktopRecoveryStorePort,
} from "./recovery.ts";
import {
  DesktopSwitchController,
  inspectDesktopSwitchPreflight,
  type DesktopBundlePort,
  type DesktopProcessPort,
  type DesktopSwitchGeneration,
  type DesktopSwitchJournalEntry,
  type DesktopSwitchLockPort,
  type DesktopSwitchStage,
} from "./switch.ts";

const idempotencyKeySchema = z.string().uuid();
const accountKeySchema = z
  .string()
  .trim()
  .email()
  .max(320)
  .transform((value) => value.normalize("NFKC").toLocaleLowerCase("en-US"));
const diagnosticCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/u);

const authorityBindingSchema = z
  .object({
    profileId: profileIdSchema,
    processGeneration: z.number().int().positive(),
  })
  .strict();

const planBindingShape = {
  idempotencyKey: idempotencyKeySchema,
  switchGeneration: z.number().int().positive(),
  sourceProfileId: profileIdSchema.nullable(),
  sourceProcessGeneration: z.number().int().positive().nullable(),
  targetProfileId: profileIdSchema,
  targetProcessGeneration: z.number().int().positive(),
} as const;

const accountProjectionSchema = z
  .object({
    signedIn: z.boolean(),
    email: z.string().trim().email().max(320).optional(),
    plan: z.string().trim().min(1).max(160).optional(),
  })
  .strict();

const desktopInstanceObservationSchema = z
  .object({
    status: z.literal("observed"),
    desktopPid: z.number().int().positive(),
    uid: z.number().int().nonnegative().optional(),
    identityToken: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
    executablePath: z.string().min(1).max(4096),
    bundleCdHash: z.string().regex(/^[a-f0-9]{40,128}$/u),
    codexHome: z.string().min(1).max(4096),
    desktopUserData: z.string().min(1).max(4096),
    account: accountProjectionSchema,
  })
  .strict();

const desktopInstanceObservationCapabilitySchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("supported"),
      mechanism: z.literal("pid-bound-desktop-account-v1"),
    })
    .strict(),
  z.object({ status: z.literal("unsupported") }).strict(),
]);

const readyPlanSchema = z
  .object({
    status: z.literal("ready"),
    ...planBindingShape,
    journalStage: z.enum(["new", "prepared"]),
    expectedAccountKey: accountKeySchema,
  })
  .strict();

const appliedPlanSchema = z
  .object({
    status: z.literal("applied"),
    ...planBindingShape,
    expectedAccountKey: accountKeySchema,
    activeAccount: accountProjectionSchema,
  })
  .strict();

const recoveryPlanSchema = z
  .object({
    status: z.literal("recovery_required"),
    ...planBindingShape,
    diagnostic: diagnosticCodeSchema,
  })
  .strict();

const switchPlanSchema = z.discriminatedUnion("status", [
  readyPlanSchema,
  appliedPlanSchema,
  recoveryPlanSchema,
]);

type SwitchPlan = z.infer<typeof switchPlanSchema>;
type ReadySwitchPlan = z.infer<typeof readyPlanSchema>;

type DesktopSwitchBeginInput = {
  readonly idempotencyKey: string;
  readonly requestedSource?: Readonly<{
    profileId: string;
    processGeneration: number;
  }>;
  readonly target: Readonly<{
    profileId: string;
    processGeneration: number;
  }>;
};

export interface LocalDesktopSwitchStorePort extends DesktopRecoveryStorePort {
  /**
   * Idempotently binds the caller key to the exact source/target generations.
   * Only a brand-new request or a journal that is still at `prepared` may be
   * returned as ready. Every effect-adjacent stage must be collapsed to
   * `recovery_required` by the durable store.
   */
  readDesktopSwitchReplay(input: DesktopSwitchBeginInput): unknown;
  beginDesktopSwitch(input: DesktopSwitchBeginInput): Promise<unknown>;
  prepareDesktopSwitchJournal(entry: DesktopSwitchJournalEntry): Promise<void>;
  advanceDesktopSwitchJournal(input: {
    readonly idempotencyKey: string;
    readonly switchGeneration: number;
    readonly stage: DesktopSwitchStage;
    readonly launchedPid?: number;
    readonly diagnostic?: string;
  }): Promise<void>;
  assertDesktopEffectsSettled(generation: DesktopSwitchGeneration): Promise<void>;
  isDesktopSwitchCurrent(generation: DesktopSwitchGeneration): boolean | Promise<boolean>;
  settlePreparedDesktopSwitch(input: DesktopSwitchGeneration & {
    readonly idempotencyKey: string;
    readonly diagnostic: string;
  }): boolean | Promise<boolean>;
  quarantineDesktopSwitchTargetByGeneration(input: DesktopSwitchGeneration & {
    readonly idempotencyKey: string;
  }): boolean | Promise<boolean>;
}

export interface LocalDesktopAccountRuntimePort extends DesktopRecoveryRuntimePort {
  /**
   * Observe the account through a supported desktop-instance-specific channel.
   * A standalone app-server read against `authority.codexHome` does not satisfy
   * this contract. Implementations must fail if they cannot bind the observation
   * to every supplied launched-instance field.
   */
  desktopInstanceObservationCapability?(): Promise<unknown>;
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

export interface LocalDesktopSwitchInput {
  readonly paths: Pick<StatePaths, "root" | "switchLock">;
  readonly store: LocalDesktopSwitchStorePort;
  readonly runtime: LocalDesktopAccountRuntimePort;
  readonly bundlePath?: string;
  readonly baseEnvironment?: Readonly<Record<string, string | undefined>>;
  readonly bundle?: DesktopBundlePort;
  readonly process?: DesktopProcessPort;
  readonly lock?: DesktopSwitchLockPort;
  readonly now?: () => number;
  readonly betweenRecoveryScans?: () => Promise<void>;
}

type SwitchAccountInput = {
  readonly idempotencyKey: string;
  readonly source?: ProfileAuthority;
  readonly target: ProfileAuthority;
  readonly signal: AbortSignal;
};

/**
 * Root-facing desktop port. Production defaults use exact bundle inspection,
 * direct process control, and a machine-global no-follow file lock. Tests may
 * replace those three effect ports without contacting an installed app.
 */
export class LocalDesktopSwitchPort implements DesktopSwitchPort {
  readonly #paths: Pick<StatePaths, "root" | "switchLock">;
  readonly #store: LocalDesktopSwitchStorePort;
  readonly #runtime: LocalDesktopAccountRuntimePort;
  readonly #baseEnvironment: Readonly<Record<string, string | undefined>>;
  readonly #bundle: DesktopBundlePort;
  readonly #process: DesktopProcessPort;
  readonly #lock: DesktopSwitchLockPort;
  readonly #now: (() => number) | undefined;
  readonly #betweenRecoveryScans: (() => Promise<void>) | undefined;

  constructor(input: LocalDesktopSwitchInput) {
    assertLocalSwitchPaths(input.paths);
    this.#paths = input.paths;
    this.#store = input.store;
    this.#runtime = input.runtime;
    this.#baseEnvironment = input.baseEnvironment ?? process.env;
    this.#bundle =
      input.bundle ??
      new ExactChatGptBundlePort(input.bundlePath ?? "/Applications/ChatGPT.app");
    this.#process = input.process ?? new MacOsDesktopProcessPort();
    this.#lock = input.lock ?? new FileDesktopSwitchLock(input.paths.switchLock);
    this.#now = input.now;
    this.#betweenRecoveryScans = input.betweenRecoveryScans;
  }

  async switchAccount(input: SwitchAccountInput): Promise<{
    status: "applied" | "recovery_required";
    activeAccount?: CodexAccountProjection;
    diagnostic?: string;
    idempotencyKey: string;
  }> {
    const idempotencyKey = idempotencyKeySchema.parse(input.idempotencyKey);
    assertNotAborted(input.signal);
    assertProfileAuthority(this.#paths.root, input.target);
    if (input.source !== undefined) assertProfileAuthority(this.#paths.root, input.source);
    await assertPrivateProfileAuthority(input.target);
    const beginInput = desktopSwitchBeginInput(idempotencyKey, input.source, input.target);
    const replay = await this.#store.readDesktopSwitchReplay(beginInput);
    if (replay !== null) {
      return switchPlanResult(
        switchPlanSchema.parse(replay),
        idempotencyKey,
        input.source,
        input.target,
      );
    }

    return this.#lock.withLock(async () => {
      assertNotAborted(input.signal);
      const observationCapability = desktopInstanceObservationCapabilitySchema.parse(
        this.#runtime.desktopInstanceObservationCapability === undefined
          ? { status: "unsupported" }
          : await this.#runtime.desktopInstanceObservationCapability(),
      );
      if (observationCapability.status !== "supported") {
        throw new DesktopSwitchError(
          "CAPABILITY_MISSING",
          "this runtime cannot observe an account through the launched desktop instance",
        );
      }

      // Bundle identity and exact process cardinality are checked while the
      // machine lock is held and before beginDesktopSwitch reserves authority.
      const preflight = await inspectDesktopSwitchPreflight(this.#bundle, this.#process);
      assertNotAborted(input.signal);
      const plan = switchPlanSchema.parse(await this.#store.beginDesktopSwitch(beginInput));
      assertPlanBinding(plan, idempotencyKey, input.source, input.target);
      if (plan.status !== "ready") {
        return switchPlanResult(plan, idempotencyKey, input.source, input.target);
      }

      const journal = new StoreDesktopSwitchJournal(this.#store);
      let verifiedAccount: CodexAccountProjection | undefined;
      const effectPlan = plan;
      const controller = new DesktopSwitchController({
        bundle: this.#bundle,
        process: this.#process,
        lock: { withLock: async (effect) => effect() },
        journal,
        authority: {
          assertEffectsSettled: (generation) =>
            this.#store.assertDesktopEffectsSettled(generation),
          isCurrent: (generation) => this.#store.isDesktopSwitchCurrent(generation),
        },
        account: {
          readAccountKey: async (observationRequest) => {
            let observation: z.infer<typeof desktopInstanceObservationSchema>;
            try {
              observation = desktopInstanceObservationSchema.parse(
                await this.#runtime.observeDesktopInstanceAccount({
                  authority: input.target,
                  instance: observationRequest.instance,
                  signal: input.signal,
                }),
              );
            } catch (error: unknown) {
              await journal.recovery(effectPlan, "DESKTOP_INSTANCE_OBSERVATION_UNAVAILABLE");
              throw new DesktopSwitchError(
                "RECOVERY_REQUIRED",
                "desktop-instance account observation requires recovery",
                { cause: error },
              );
            }
            if (!sameDesktopInstance(observation, observationRequest.instance)) {
              await journal.recovery(effectPlan, "DESKTOP_INSTANCE_MISMATCH");
              throw new DesktopSwitchError(
                "RECOVERY_REQUIRED",
                "desktop account observation came from a different instance",
              );
            }
            const projection = parseAccountProjection(observation.account);
            verifiedAccount = projection;
            return desktopAccountKey(projection);
          },
        },
      });

      try {
        await controller.switchProfileLocked(
          controllerRequest(plan, this.#paths.root, this.#baseEnvironment),
          preflight,
        );
      } catch (error: unknown) {
        const binding = switchGenerationBinding(plan);
        const settledWithoutEffect = await this.#store.settlePreparedDesktopSwitch({
          ...binding,
          idempotencyKey,
          diagnostic: "PRE_EFFECT_FAILURE",
        });
        const accountBindingMismatch =
          verifiedAccount !== undefined &&
          desktopAccountKey(verifiedAccount) !== plan.expectedAccountKey;
        if (!settledWithoutEffect && accountBindingMismatch) {
          await this.#store.quarantineDesktopSwitchTargetByGeneration({
            ...binding,
            idempotencyKey,
          });
        }
        if (settledWithoutEffect) throw error;
        return {
          status: "recovery_required",
          diagnostic:
            accountBindingMismatch
              ? "TARGET_ACCOUNT_MISMATCH"
              : error instanceof DesktopSwitchError && error.code === "RECOVERY_REQUIRED"
                ? "DESKTOP_SWITCH_RECOVERY_REQUIRED"
                : "DESKTOP_SWITCH_EFFECT_UNSETTLED",
          idempotencyKey,
        };
      }
      if (verifiedAccount === undefined) {
        return {
          status: "recovery_required",
          diagnostic: "ACCOUNT_VERIFICATION_MISSING",
          idempotencyKey,
        };
      }
      return { status: "applied", activeAccount: verifiedAccount, idempotencyKey };
    });
  }

  recoverSwitch(input: { readonly signal: AbortSignal }): Promise<DesktopRecoveryResult> {
    return new DesktopSwitchRecoveryController({
      stateRoot: this.#paths.root,
      store: this.#store,
      runtime: this.#runtime,
      bundle: this.#bundle,
      process: this.#process,
      lock: this.#lock,
      ...(this.#now === undefined ? {} : { now: this.#now }),
      ...(this.#betweenRecoveryScans === undefined
        ? {}
        : { betweenScans: this.#betweenRecoveryScans }),
    }).recover(input.signal);
  }

  currentRecovery(): unknown {
    return this.#store.readCurrentDesktopSwitchRecovery();
  }
}

export function createLocalDesktopSwitchPort(input: LocalDesktopSwitchInput): LocalDesktopSwitchPort {
  return new LocalDesktopSwitchPort(input);
}

export function desktopAccountKey(projection: CodexAccountProjection): string | null {
  const parsed = parseAccountProjection(projection);
  if (!parsed.signedIn || parsed.email === undefined) return null;
  return accountKeySchema.parse(parsed.email);
}

function desktopSwitchBeginInput(
  idempotencyKey: string,
  source: ProfileAuthority | undefined,
  target: ProfileAuthority,
): DesktopSwitchBeginInput {
  return {
    idempotencyKey,
    ...(source === undefined
      ? {}
      : {
          requestedSource: {
            profileId: source.id,
            processGeneration: source.generation,
          },
        }),
    target: {
      profileId: target.id,
      processGeneration: target.generation,
    },
  };
}

function switchGenerationBinding(plan: ReadySwitchPlan): DesktopSwitchGeneration {
  return {
    switchGeneration: plan.switchGeneration,
    sourceProfileId: plan.sourceProfileId,
    sourceProcessGeneration: plan.sourceProcessGeneration,
    targetProfileId: plan.targetProfileId,
    targetProcessGeneration: plan.targetProcessGeneration,
  };
}

function switchPlanResult(
  plan: SwitchPlan,
  idempotencyKey: string,
  source: ProfileAuthority | undefined,
  target: ProfileAuthority,
): {
  status: "applied" | "recovery_required";
  activeAccount?: CodexAccountProjection;
  diagnostic?: string;
  idempotencyKey: string;
} {
  assertPlanBinding(plan, idempotencyKey, source, target);
  if (plan.status === "applied") {
    const activeAccount = parseAccountProjection(plan.activeAccount);
    if (desktopAccountKey(activeAccount) !== plan.expectedAccountKey) {
      return {
        status: "recovery_required",
        diagnostic: "APPLIED_ACCOUNT_BINDING_MISMATCH",
        idempotencyKey,
      };
    }
    return { status: "applied", activeAccount, idempotencyKey };
  }
  if (plan.status === "recovery_required") {
    return {
      status: "recovery_required",
      diagnostic: plan.diagnostic,
      idempotencyKey,
    };
  }
  return {
    status: "recovery_required",
    diagnostic: "PREPARED_SWITCH_REQUIRES_RECOVERY",
    idempotencyKey,
  };
}

function parseAccountProjection(value: unknown): CodexAccountProjection {
  const parsed = accountProjectionSchema.parse(value);
  return {
    signedIn: parsed.signedIn,
    ...(parsed.email === undefined ? {} : { email: parsed.email }),
    ...(parsed.plan === undefined ? {} : { plan: parsed.plan }),
  };
}

function sameDesktopInstance(
  observation: z.infer<typeof desktopInstanceObservationSchema>,
  expected: {
    readonly pid: number;
    readonly executablePath: string;
    readonly bundleCdHash: string;
    readonly codexHome: string;
    readonly desktopUserData: string;
  },
): boolean {
  return (
    observation.desktopPid === expected.pid &&
    observation.executablePath === expected.executablePath &&
    observation.bundleCdHash === expected.bundleCdHash &&
    observation.codexHome === expected.codexHome &&
    observation.desktopUserData === expected.desktopUserData
  );
}

export class ExactChatGptBundlePort implements DesktopBundlePort {
  readonly #bundlePath: string;

  constructor(bundlePath: string) {
    if (!isAbsolute(bundlePath) || resolve(bundlePath) !== bundlePath) {
      throw new DesktopSwitchError(
        "BUNDLE_UNSUPPORTED",
        "ChatGPT bundle path must be normalized and absolute",
      );
    }
    this.#bundlePath = bundlePath;
  }

  inspect() {
    return inspectChatGptBundle(this.#bundlePath);
  }
}

const lockPayloadSchema = z
  .object({
    version: z.literal(1),
    pid: z.number().int().positive(),
    nonce: z.string().uuid(),
  })
  .strict();

/** Machine-global switch lock with inode-fenced stale recovery and release. */
export class FileDesktopSwitchLock implements DesktopSwitchLockPort {
  readonly #path: string;

  constructor(path: string) {
    if (!isAbsolute(path) || resolve(path) !== path) {
      throw new DesktopSwitchError("CAPABILITY_MISSING", "desktop switch lock path is invalid");
    }
    this.#path = path;
  }

  async withLock<T>(effect: () => Promise<T>): Promise<T> {
    const ownership = await acquireSwitchLock(this.#path);
    try {
      return await effect();
    } finally {
      await ownership.release();
    }
  }
}

class SwitchLockOwnership {
  readonly #path: string;
  readonly #handle: FileHandle;
  readonly #device: number;
  readonly #inode: number;
  #released = false;

  constructor(path: string, handle: FileHandle, device: number, inode: number) {
    this.#path = path;
    this.#handle = handle;
    this.#device = device;
    this.#inode = inode;
  }

  async release(): Promise<void> {
    if (this.#released) return;
    this.#released = true;
    try {
      const metadata = await lstat(this.#path);
      if (metadata.dev !== this.#device || metadata.ino !== this.#inode) {
        throw new DesktopSwitchError(
          "RECOVERY_REQUIRED",
          "desktop switch lock identity changed before release",
        );
      }
      await unlink(this.#path);
    } finally {
      await this.#handle.close();
    }
  }
}

class StoreDesktopSwitchJournal {
  readonly #store: LocalDesktopSwitchStorePort;

  constructor(store: LocalDesktopSwitchStorePort) {
    this.#store = store;
  }

  async prepare(entry: DesktopSwitchJournalEntry): Promise<void> {
    try {
      await this.#store.prepareDesktopSwitchJournal(entry);
    } catch (error: unknown) {
      throw new DesktopSwitchError(
        "RECOVERY_REQUIRED",
        "desktop switch journal could not be prepared",
        { cause: error },
      );
    }
  }

  async advance(
    idempotencyKey: string,
    switchGeneration: number,
    stage: DesktopSwitchStage,
    details?: { readonly launchedPid?: number; readonly safeReason?: string },
  ): Promise<void> {
    try {
      await this.#store.advanceDesktopSwitchJournal({
        idempotencyKey,
        switchGeneration,
        stage,
        ...(details?.launchedPid === undefined ? {} : { launchedPid: details.launchedPid }),
        ...(details?.safeReason === undefined
          ? {}
          : { diagnostic: safeDiagnostic(details.safeReason) }),
      });
    } catch (error: unknown) {
      throw new DesktopSwitchError(
        "RECOVERY_REQUIRED",
        "desktop switch journal could not be advanced",
        { cause: error },
      );
    }
  }

  async recovery(plan: ReadySwitchPlan, diagnostic: string): Promise<void> {
    try {
      await this.#store.advanceDesktopSwitchJournal({
        idempotencyKey: plan.idempotencyKey,
        switchGeneration: plan.switchGeneration,
        stage: "recovery-required",
        diagnostic: diagnosticCodeSchema.parse(diagnostic),
      });
    } catch {
      // The last durable stage is already effect-adjacent. Its next resolution
      // must remain fail-closed even if this best-effort annotation is lost.
    }
  }
}

async function acquireSwitchLock(path: string): Promise<SwitchLockOwnership> {
  const parent = await lstat(dirname(path)).catch((error: unknown) => {
    throw new DesktopSwitchError("CAPABILITY_MISSING", "desktop switch runtime is unavailable", {
      cause: error,
    });
  });
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    (parent.mode & 0o077) !== 0
  ) {
    throw new DesktopSwitchError(
      "CAPABILITY_MISSING",
      "desktop switch runtime must be a user-only real directory",
    );
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await open(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(
          JSON.stringify({ version: 1, pid: process.pid, nonce: crypto.randomUUID() }),
          "utf8",
        );
        await handle.sync();
        const metadata = await handle.stat();
        return new SwitchLockOwnership(path, handle, metadata.dev, metadata.ino);
      } catch (error: unknown) {
        await handle.close();
        await unlink(path).catch(() => undefined);
        throw error;
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const metadata = await lstat(path);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.nlink !== 1 ||
        (metadata.mode & 0o777) !== 0o600 ||
        metadata.size > 256
      ) {
        throw new DesktopSwitchError(
          "RECOVERY_REQUIRED",
          "desktop switch lock is unsafe and requires manual recovery",
        );
      }
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let payload: z.infer<typeof lockPayloadSchema>;
      try {
        payload = lockPayloadSchema.parse(JSON.parse(await handle.readFile("utf8")) as unknown);
      } finally {
        await handle.close();
      }
      if (processIsAlive(payload.pid)) {
        throw new DesktopSwitchError(
          "PROCESS_AMBIGUOUS",
          "another HRA process owns the desktop switch",
        );
      }
      await quarantineStaleLock(path);
    }
  }
  throw new DesktopSwitchError(
    "RECOVERY_REQUIRED",
    "desktop switch lock changed repeatedly during acquisition",
  );
}

async function quarantineStaleLock(path: string): Promise<void> {
  const quarantine = `${path}.stale.${crypto.randomUUID()}`;
  const before = await lstat(path);
  await link(path, quarantine);
  try {
    const [current, linked] = await Promise.all([lstat(path), lstat(quarantine)]);
    if (
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      linked.dev !== before.dev ||
      linked.ino !== before.ino
    ) {
      throw new DesktopSwitchError(
        "RECOVERY_REQUIRED",
        "desktop switch lock changed during stale recovery",
      );
    }
    await unlink(path);
  } finally {
    await unlink(quarantine).catch(() => undefined);
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function controllerRequest(
  plan: ReadySwitchPlan,
  stateRoot: string,
  baseEnvironment: Readonly<Record<string, string | undefined>>,
) {
  return {
    idempotencyKey: plan.idempotencyKey,
    switchGeneration: plan.switchGeneration,
    sourceProfileId: plan.sourceProfileId,
    sourceProcessGeneration: plan.sourceProcessGeneration,
    targetProfileId: plan.targetProfileId,
    targetProcessGeneration: plan.targetProcessGeneration,
    expectedAccountKey: plan.expectedAccountKey,
    stateRoot,
    baseEnvironment,
  } as const;
}

function assertPlanBinding(
  plan: SwitchPlan,
  idempotencyKey: string,
  source: ProfileAuthority | undefined,
  target: ProfileAuthority,
): void {
  if (
    plan.idempotencyKey !== idempotencyKey ||
    plan.targetProfileId !== target.id ||
    plan.targetProcessGeneration !== target.generation
  ) {
    throw new DesktopSwitchError(
      "RECOVERY_REQUIRED",
      "desktop switch store returned a mismatched request binding",
    );
  }
  if (
    (plan.sourceProfileId === null) !== (plan.sourceProcessGeneration === null) ||
    (source !== undefined &&
      (plan.sourceProfileId !== source.id ||
        plan.sourceProcessGeneration !== source.generation))
  ) {
    throw new DesktopSwitchError(
      "RECOVERY_REQUIRED",
      "desktop switch store returned a mismatched source authority",
    );
  }
}

function assertProfileAuthority(stateRoot: string, authority: ProfileAuthority): void {
  authorityBindingSchema.parse({
    profileId: authority.id,
    processGeneration: authority.generation,
  });
  const expected = deriveDesktopProfilePaths(stateRoot, authority.id);
  if (
    expected.codexHome !== authority.codexHome ||
    expected.desktopUserData !== authority.desktopUserData
  ) {
    throw new DesktopSwitchError(
      "INVALID_PROFILE",
      "desktop profile paths do not match the local authority",
    );
  }
}

function assertLocalSwitchPaths(paths: Pick<StatePaths, "root" | "switchLock">): void {
  if (
    !isAbsolute(paths.root) ||
    resolve(paths.root) !== paths.root ||
    !isAbsolute(paths.switchLock) ||
    resolve(paths.switchLock) !== paths.switchLock ||
    paths.switchLock !== join(paths.root, "runtime", "desktop-switch.lock")
  ) {
    throw new DesktopSwitchError("CAPABILITY_MISSING", "desktop switch paths are invalid");
  }
}

async function assertPrivateProfileAuthority(authority: ProfileAuthority): Promise<void> {
  for (const [label, path] of [
    ["Codex home", authority.codexHome],
    ["desktop user-data", authority.desktopUserData],
  ] as const) {
    const [metadata, canonical] = await Promise.all([
      lstat(path).catch((error: unknown) => {
        throw new DesktopSwitchError("INVALID_PROFILE", `${label} is unavailable`, {
          cause: error,
        });
      }),
      realpath(path).catch((error: unknown) => {
        throw new DesktopSwitchError("INVALID_PROFILE", `${label} is unavailable`, {
          cause: error,
        });
      }),
    ]);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      metadata.nlink < 1 ||
      (metadata.mode & 0o077) !== 0 ||
      canonical !== path
    ) {
      throw new DesktopSwitchError(
        "INVALID_PROFILE",
        `${label} must be a user-only real directory`,
      );
    }
  }
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function safeDiagnostic(reason: string): string {
  const upper = reason
    .normalize("NFKC")
    .toLocaleUpperCase("en-US")
    .replaceAll(/[^A-Z0-9]+/gu, "_")
    .replaceAll(/^_+|_+$/gu, "")
    .slice(0, 80);
  return diagnosticCodeSchema.parse(upper === "" ? "RECOVERY_REQUIRED" : upper);
}
