import {
  HRA_HUMAN_KEYCHAIN_SERVICE,
  HRA_RUNNER_KEYCHAIN_SERVICE,
} from "@hraness/hra-human-client";
import { z } from "@hra-internal/schema";
import {
  constants,
  type Stats,
} from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { userInfo } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  localDataRemovalConfirmationTokenSchema,
  localDataRemovalPreviewIdSchema,
  operationIdSchema,
  runtimeLocalDataRemovalConfirmation,
  runtimeLocalDataRemovalPreviewSchema,
  type RuntimeLocalDataRemovalCommand,
  type RuntimeLocalDataRemovalPreview,
} from "../../../contracts/runtime";
import {
  HRA_SESSION_SYNC_KEYCHAIN_NAME,
  HRA_SESSION_SYNC_KEYCHAIN_SERVICE,
  HRA_SESSION_SYNC_RECOVERY_KEYCHAIN_NAME,
} from "../cloud/session-sync-key-custody";
import {
  HRA_HARNESS_KEYCHAIN_NAME,
  HRA_HARNESS_KEYCHAIN_SERVICE,
  HRA_HARNESS_LEGACY_KEYCHAIN_SERVICE,
} from "../harness/key-custody";
import { CHAT_ATTACHMENT_VAULT_DIRECTORY_NAME } from "../attachments/root";
import { applicationSupportPaths } from "../state/application-support";
import { controlPlaneLifetimeLockPath } from "../state/control-plane-lock";
import {
  controlPlaneRestoreDatabaseRollbackFileName,
  controlPlaneRestoreDatabaseStageFileName,
  controlPlaneRestoreJournalCandidateFileName,
  controlPlaneRestoreJournalFileName,
  controlPlaneRestoreKeyRollbackFileName,
  controlPlaneRestoreKeyStageFileName,
  controlPlaneRestoreVaultRollbackDirectoryName,
  controlPlaneRestoreVaultStageDirectoryName,
  legacyControlPlaneRestoreV1DatabaseRollbackFileName,
  legacyControlPlaneRestoreV1DatabaseStageFileName,
  legacyControlPlaneRestoreV1JournalCandidateFileName,
  legacyControlPlaneRestoreV1JournalFileName,
  legacyControlPlaneRestoreV1KeyRollbackFileName,
  legacyControlPlaneRestoreV1KeyStageFileName,
} from "../state/control-plane-restore-state";
import {
  operationReceiptKeyCandidatePath,
  operationReceiptKeyPath,
} from "../state/operation-receipt-key";
import { controlPlaneReleaseFencePath } from "../state/release-compatibility";

export const packagedLocalDataRemoverRelativePath =
  "runtime/bin/oprte-data-remover" as const;
export const packagedLocalDataRemoverBundlePath =
  "Contents/Resources/runtime/bin/oprte-data-remover" as const;

const helperRequestKind = "hraness-kitchen-local-data-removal" as const;
const helperRequestVersion = 1 as const;
// These v1 request identifiers are signed wire data shared with already-shipped
// native helpers. Keep their pre-HRA spelling until a versioned v2 protocol
// performs an explicit dual-reader migration.
const predecessorCodexProfileCategory =
  "kitchen_codex_profile_data" as const;
const predecessorCodexProfileDataField =
  "kitchenCodexProfileData" as const;
const maximumTargets = 4_096;
const maximumOwnedRootsPerCategory = 64;
export const maximumLocalDataRemovalHelperRequestBytes =
  64 * 1_024 * 1_024;

export function isLocalDataRemovalHelperRequestByteLengthAllowed(
  byteLength: number,
): boolean {
  return (
    Number.isSafeInteger(byteLength) &&
    byteLength >= 0 &&
    byteLength <= maximumLocalDataRemovalHelperRequestBytes
  );
}
const minimumSigningKeyBytes = 32;
const defaultPreviewLifetimeMs = 5 * 60 * 1_000;
const privateDirectoryMode = 0o700;
const privateFileMode = 0o600;

const absolutePathSchema = z
  .string()
  .min(2)
  .max(4_096)
  .refine(isAbsolute, "path must be absolute");
const sha256DigestSchema = z
  .string()
  .regex(/^sha256_[a-f0-9]{64}$/u);
const hmacSignatureSchema = z
  .string()
  .regex(/^hmac_sha256_[a-f0-9]{64}$/u);
const targetIdSchema = z
  .string()
  .regex(/^target_[a-f0-9]{32}$/u);

export const localDataRemovalFilesystemCategorySchema = z.enum([
  "control_plane",
  predecessorCodexProfileCategory,
  "release_update_artifact",
  "application_state",
  "managed_worktree",
]);
export type LocalDataRemovalFilesystemCategory = z.infer<
  typeof localDataRemovalFilesystemCategorySchema
>;

const ordinaryFilesystemTargetSchema = z
  .object({
    category: z.enum([
      "control_plane",
      predecessorCodexProfileCategory,
      "release_update_artifact",
      "application_state",
    ]),
    path: absolutePathSchema,
    kind: z.enum(["file", "directory"]),
  })
  .strict();

const managedWorktreeRegistrationSchema = z
  .object({
    repositoryPath: absolutePathSchema,
    gitCommonDirectory: absolutePathSchema,
    administrativeDirectory: absolutePathSchema,
  })
  .strict();
export type LocalDataRemovalManagedWorktreeRegistration = z.infer<
  typeof managedWorktreeRegistrationSchema
>;

const managedWorktreeTargetSchema = z
  .object({
    category: z.literal("managed_worktree"),
    path: absolutePathSchema,
    kind: z.literal("directory"),
    dirty: z.boolean(),
    registration: managedWorktreeRegistrationSchema,
  })
  .strict();

export const localDataRemovalFilesystemTargetSchema = z.discriminatedUnion(
  "category",
  [
    ordinaryFilesystemTargetSchema,
    managedWorktreeTargetSchema,
  ],
);
export type LocalDataRemovalFilesystemTarget = z.infer<
  typeof localDataRemovalFilesystemTargetSchema
>;

export const localDataRemovalKeychainTargetSchema = z
  .object({
    category: z.enum([
      "human_credential_generation",
      "runner_pairing_secret",
      "harness_context_heap_key",
      "session_sync_key_material",
    ]),
    service: z.string().min(1).max(240),
    name: z
      .string()
      .min(1)
      .max(512)
      .refine(
        (value) => [...value].every((character) => {
          const codePoint = character.codePointAt(0);
          return (
            codePoint !== undefined &&
            codePoint > 0x1f &&
            codePoint !== 0x7f &&
            !"*?[]{}".includes(character)
          );
        }),
        "invalid Keychain target name",
      ),
  })
  .strict()
  .superRefine((target, context) => {
    const expectedService = {
      human_credential_generation: HRA_HUMAN_KEYCHAIN_SERVICE,
      runner_pairing_secret: HRA_RUNNER_KEYCHAIN_SERVICE,
      harness_context_heap_key: null,
      session_sync_key_material: HRA_SESSION_SYNC_KEYCHAIN_SERVICE,
    }[target.category];
    const serviceMatches = target.category === "harness_context_heap_key"
      ? target.service === HRA_HARNESS_LEGACY_KEYCHAIN_SERVICE
        || target.service === HRA_HARNESS_KEYCHAIN_SERVICE
      : target.service === expectedService;
    if (!serviceMatches) {
      context.addIssue({
        code: "custom",
        message: "Keychain target does not belong to its HRA credential service",
        path: ["service"],
      });
    }
    if (
      target.category === "harness_context_heap_key" &&
      target.name !== HRA_HARNESS_KEYCHAIN_NAME
    ) {
      context.addIssue({
        code: "custom",
        message: "Context Heap Keychain target is not the fixed install key",
        path: ["name"],
      });
    }
    if (
      target.category === "session_sync_key_material" &&
      target.name !== HRA_SESSION_SYNC_KEYCHAIN_NAME &&
      target.name !== HRA_SESSION_SYNC_RECOVERY_KEYCHAIN_NAME
    ) {
      context.addIssue({
        code: "custom",
        message: "Session sync Keychain target is not fixed key material",
        path: ["name"],
      });
    }
  });
export type LocalDataRemovalKeychainTarget = z.infer<
  typeof localDataRemovalKeychainTargetSchema
>;

const nativeRemovalCapabilitySchema = z.string().regex(/^[a-f0-9]{64}$/u);

export type AuthenticatedLocalDataRemovalKeychainAuthorization = Readonly<{
  operationId: string;
  previewId: string;
  nativeRemovalCapability: string;
  receiptAuthentication: string;
}>;

export interface AuthenticatedLocalDataRemovalSecretStore {
  delete(
    input: LocalDataRemovalKeychainTarget,
    authorization: AuthenticatedLocalDataRemovalKeychainAuthorization,
  ): Promise<boolean>;
}

const localDataRemovalInventorySchema = z
  .object({
    filesystemTargets: z
      .array(localDataRemovalFilesystemTargetSchema)
      .max(maximumTargets),
    keychainTargets: z
      .array(localDataRemovalKeychainTargetSchema)
      .max(maximumTargets),
    preservedCredentialEvidenceRecords: z
      .number()
      .int()
      .nonnegative()
      .max(maximumTargets)
      .default(0),
    userRepositories: z.array(absolutePathSchema).max(maximumTargets),
  })
  .strict();
export type LocalDataRemovalInventory = z.input<
  typeof localDataRemovalInventorySchema
>;

const rootListSchema = z
  .array(absolutePathSchema)
  .min(1)
  .max(maximumOwnedRootsPerCategory);
const localDataRemovalOwnedRootsSchema = z
  .object({
    controlPlane: rootListSchema,
    // Signed v1 JSON field; deliberately retains its compatibility spelling.
    [predecessorCodexProfileDataField]: rootListSchema,
    releaseUpdateArtifacts: rootListSchema,
    applicationState: rootListSchema,
    managedWorktrees: rootListSchema,
    helperStateRoot: absolutePathSchema,
  })
  .strict();
export type LocalDataRemovalOwnedRoots = z.input<
  typeof localDataRemovalOwnedRootsSchema
>;

interface CanonicalOwnedRoots {
  readonly controlPlane: readonly string[];
  readonly [predecessorCodexProfileDataField]: readonly string[];
  readonly releaseUpdateArtifacts: readonly string[];
  readonly applicationState: readonly string[];
  readonly managedWorktrees: readonly string[];
  readonly helperStateRoot: string;
}

interface CanonicalFilesystemTarget {
  readonly id: string;
  readonly category: LocalDataRemovalFilesystemCategory;
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly dirty?: boolean;
  readonly registration?: LocalDataRemovalManagedWorktreeRegistration;
}

interface CanonicalLocalDataRemovalPlan {
  readonly inventoryDigest: string;
  readonly ownedRoots: CanonicalOwnedRoots;
  readonly filesystemTargets: readonly CanonicalFilesystemTarget[];
  readonly keychainTargets: readonly LocalDataRemovalKeychainTarget[];
  readonly preservedCredentialEvidenceRecords: number;
  readonly userRepositories: readonly string[];
}

export interface PreparedLocalDataRemovalPlan {
  readonly preview: RuntimeLocalDataRemovalPreview;
  /** Private gateway/native data. Never serialize this object to the renderer. */
  readonly privatePlan: CanonicalLocalDataRemovalPlan;
}

export class UnsafeLocalDataRemovalTargetError extends Error {
  readonly targetPath: string | null;
  readonly reason: string;

  constructor(targetPath: string | null, reason: string) {
    super(
      targetPath === null
        ? `Unsafe local-data removal target: ${reason}`
        : `Unsafe local-data removal target (${reason}): ${targetPath}`,
    );
    this.name = "UnsafeLocalDataRemovalTargetError";
    this.targetPath = targetPath;
    this.reason = reason;
  }
}

export class LocalDataRemovalConfirmationError extends Error {
  readonly code:
    | "blocked"
    | "dirty_worktree_acknowledgement_required"
    | "expired_preview"
    | "inventory_changed"
    | "invalid_confirmation"
    | "maintenance_fence_not_held"
    | "operation_conflict";

  constructor(
    code: LocalDataRemovalConfirmationError["code"],
    message: string,
  ) {
    super(message);
    this.name = "LocalDataRemovalConfirmationError";
    this.code = code;
  }
}

export type LocalDataRemovalPublicFailure = Readonly<{
  code:
    | "confirmation_required"
    | "inventory_changed"
    | "maintenance_unavailable"
    | "removal_conflict"
    | "unsafe_local_state"
    | "unexpected_failure";
  message: string;
}>;

/** Maps every private/path-bearing failure to fixed renderer-safe text. */
export function localDataRemovalPublicFailure(
  error: unknown,
): LocalDataRemovalPublicFailure {
  if (error instanceof UnsafeLocalDataRemovalTargetError) {
    return {
      code: "unsafe_local_state",
      message: "HRA found local state that cannot be removed safely.",
    };
  }
  if (error instanceof LocalDataRemovalConfirmationError) {
    switch (error.code) {
      case "dirty_worktree_acknowledgement_required":
      case "expired_preview":
      case "invalid_confirmation":
        return {
          code: "confirmation_required",
          message: "Create a fresh preview and confirm local-data removal.",
        };
      case "inventory_changed":
        return {
          code: "inventory_changed",
          message: "HRA local data changed. Create a fresh preview.",
        };
      case "blocked":
      case "maintenance_fence_not_held":
        return {
          code: "maintenance_unavailable",
          message: "HRA cannot safely start local-data removal right now.",
        };
      case "operation_conflict":
        return {
          code: "removal_conflict",
          message: "HRA found another local-data removal operation.",
        };
    }
  }
  return {
    code: "unexpected_failure",
    message: "HRA could not remove local data.",
  };
}

export interface CreateLocalDataRemovalPlanOptions {
  readonly inventory: LocalDataRemovalInventory;
  readonly ownedRoots: LocalDataRemovalOwnedRoots;
  readonly signingKey: Uint8Array;
  readonly previewId: string;
  readonly now?: Date;
  readonly previewLifetimeMs?: number;
  readonly helperAvailable?: boolean;
  readonly operationInProgress?: boolean;
}

export interface LocalDataRemovalArtifactCandidate {
  readonly path: string;
  readonly kind: "file" | "directory";
}

export function controlPlaneRestoreRemovalArtifacts(
  applicationSupportRoot: string,
): readonly LocalDataRemovalArtifactCandidate[] {
  const root = absoluteNormalizedPath(applicationSupportRoot);
  return [
    ...[
      controlPlaneRestoreJournalFileName,
      controlPlaneRestoreJournalCandidateFileName,
      controlPlaneRestoreDatabaseStageFileName,
      controlPlaneRestoreDatabaseRollbackFileName,
      controlPlaneRestoreKeyStageFileName,
      controlPlaneRestoreKeyRollbackFileName,
      legacyControlPlaneRestoreV1JournalFileName,
      legacyControlPlaneRestoreV1JournalCandidateFileName,
      legacyControlPlaneRestoreV1DatabaseStageFileName,
      legacyControlPlaneRestoreV1DatabaseRollbackFileName,
      legacyControlPlaneRestoreV1KeyStageFileName,
      legacyControlPlaneRestoreV1KeyRollbackFileName,
    ].map((fileName) => ({
      path: join(root, fileName),
      kind: "file" as const,
    })),
    ...[
      CHAT_ATTACHMENT_VAULT_DIRECTORY_NAME,
      controlPlaneRestoreVaultStageDirectoryName,
      controlPlaneRestoreVaultRollbackDirectoryName,
    ].map((directoryName) => ({
      path: join(root, directoryName),
      kind: "directory" as const,
    })),
  ];
}

export type LocalDataRemovalMetadataKind =
  | "missing"
  | "file"
  | "directory"
  | "symbolic_link"
  | "special";

export interface LocalDataRemovalMetadataInspector {
  inspect(path: string): Promise<LocalDataRemovalMetadataKind>;
}

export interface LocalDataRemovalGitInspector {
  isDirty(worktreePath: string): Promise<boolean>;
}

export interface LocalDataRemovalManagedWorktreeCandidate {
  readonly path: string;
  readonly dirty?: boolean;
  readonly registration: LocalDataRemovalManagedWorktreeRegistration;
}

export interface DiscoverLocalDataRemovalInventoryOptions {
  readonly homeDirectory: string;
  readonly applicationSupportRoot: string;
  readonly controlPlanePath: string;
  readonly helperStateRoot: string;
  readonly hraCodexProfileRoots: readonly string[];
  readonly managedWorktreeRoots: readonly string[];
  readonly managedWorktrees:
    readonly LocalDataRemovalManagedWorktreeCandidate[];
  readonly userRepositories: readonly string[];
  readonly keychainTargets: readonly LocalDataRemovalKeychainTarget[];
  readonly preservedCredentialEvidenceRecords?: number;
  readonly gitInspector: LocalDataRemovalGitInspector;
  readonly metadata?: LocalDataRemovalMetadataInspector;
  readonly additionalControlPlaneArtifacts?:
    readonly LocalDataRemovalArtifactCandidate[];
  readonly additionalReleaseUpdateArtifacts?:
    readonly LocalDataRemovalArtifactCandidate[];
  readonly additionalApplicationStateArtifacts?:
    readonly LocalDataRemovalArtifactCandidate[];
}

export interface DiscoveredLocalDataRemovalInventory {
  readonly inventory: LocalDataRemovalInventory;
  readonly ownedRoots: LocalDataRemovalOwnedRoots;
}

export function controlPlaneSqliteRemovalArtifacts(
  controlPlanePathValue: string,
): readonly LocalDataRemovalArtifactCandidate[] {
  const controlPlanePath = absoluteNormalizedPath(controlPlanePathValue);
  return [
    { path: controlPlanePath, kind: "file" },
    { path: `${controlPlanePath}-wal`, kind: "file" },
    { path: `${controlPlanePath}-shm`, kind: "file" },
    { path: `${controlPlanePath}-journal`, kind: "file" },
  ];
}

export const localDataRemovalSigningKeyFileName =
  "removal-signing.key" as const;

export interface LocalDataRemovalHelperState {
  readonly helperStateRoot: string;
  readonly signingKeyPath: string;
  readonly signingKey: Uint8Array;
}

export async function loadOrCreateLocalDataRemovalHelperState(
  helperStateRootValue: string,
): Promise<LocalDataRemovalHelperState> {
  const helperStateRoot = absoluteNormalizedPath(helperStateRootValue);
  const parent = await requireCanonicalAnchorDirectory(
    dirname(helperStateRoot),
  );
  if (!isDirectChild(parent, helperStateRoot)) {
    throw new UnsafeLocalDataRemovalTargetError(
      helperStateRoot,
      "helper state is not an exact child of its canonical parent",
    );
  }
  await mkdir(helperStateRoot, { mode: privateDirectoryMode }).catch(
    (error: unknown) => {
      if (!isFileSystemError(error, "EEXIST")) throw error;
    },
  );
  const canonicalRoot = await requireCanonicalDirectory(helperStateRoot);
  await chmod(canonicalRoot, privateDirectoryMode);
  const signingKeyPath = exactDirectChild(
    canonicalRoot,
    localDataRemovalSigningKeyFileName,
  );
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    try {
      handle = await open(
        signingKeyPath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        privateFileMode,
      );
      await handle.writeFile(randomBytes(minimumSigningKeyBytes));
      await handle.sync();
      await handle.close();
      handle = null;
      await syncDirectory(canonicalRoot);
    } catch (error: unknown) {
      if (!isFileSystemError(error, "EEXIST")) throw error;
    }
    handle = await open(
      signingKeyPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const value = await handle.stat();
    const currentUser = process.getuid?.();
    if (
      !value.isFile() ||
      value.isSymbolicLink() ||
      value.nlink !== 1 ||
      value.size !== minimumSigningKeyBytes ||
      (value.mode & 0o777) !== privateFileMode ||
      (currentUser !== undefined && value.uid !== currentUser)
    ) {
      throw new UnsafeLocalDataRemovalTargetError(
        signingKeyPath,
        "removal signing key has an unsafe filesystem identity",
      );
    }
    const signingKey = new Uint8Array(await handle.readFile());
    requireSigningKey(signingKey);
    return {
      helperStateRoot: canonicalRoot,
      signingKeyPath,
      signingKey,
    };
  } finally {
    await handle?.close();
  }
}

const migrationReceiptDiscoverySchema = z
  .union([
    z.object({
      version: z.literal(2),
      kind: z.literal("oprte-application-support-migration"),
      source: z.enum([
        "none",
        "oprte",
        "operateDevelopment",
        "kitchen",
        "kitchenDevelopment",
        "hranessKitchen",
        "v1Stage",
      ]),
      phase: z.enum(["prepared", "staged", "published", "activated"]),
    }).strict(),
    z.object({
      version: z.literal(1),
      kind: z.literal("hraness-kitchen-application-support-migration"),
      source: z.enum([
        "none",
        "oprte",
        "operateDevelopment",
        "kitchen",
        "kitchenDevelopment",
      ]),
      phase: z.enum(["prepared", "staged", "published", "activated"]),
    }).strict(),
  ])
  .superRefine((receipt, context) => {
    if (receipt.source === "none" && receipt.phase !== "activated") {
      context.addIssue({
        code: "custom",
        message: "a no-source migration receipt must be activated",
      });
    }
  });

const downgradeGuardDiscoverySchema = z
  .union([
    z.object({
      version: z.literal(2),
      kind: z.literal("oprte-application-support-downgrade-guard"),
      target: z.literal("OPRTE"),
    }).strict(),
    z.object({
      version: z.literal(1),
      kind: z.literal("hraness-kitchen-downgrade-guard"),
      target: z.literal("Hraness Kitchen"),
    }).strict(),
  ]);

/**
 * Produces the private, exact inventory consumed by the preview builder.
 * Every returned path is revalidated again when the signed plan is created.
 */
export async function discoverLocalDataRemovalInventory(
  options: DiscoverLocalDataRemovalInventoryOptions,
): Promise<DiscoveredLocalDataRemovalInventory> {
  const homeDirectory = await requireCanonicalAnchorDirectory(
    options.homeDirectory,
  );
  const effectiveUserHome = await requireCanonicalAnchorDirectory(
    userInfo().homedir,
  );
  if (homeDirectory !== effectiveUserHome) {
    throw new UnsafeLocalDataRemovalTargetError(
      homeDirectory,
      "home directory does not match the effective user account",
    );
  }
  const cutover = applicationSupportPaths(homeDirectory);
  const applicationSupportRoot = await requireCanonicalDirectory(
    options.applicationSupportRoot,
  );
  if (applicationSupportRoot !== cutover.target) {
    throw new UnsafeLocalDataRemovalTargetError(
      applicationSupportRoot,
      "Application Support root is not the fixed OPRTE root",
    );
  }
  const controlPlanePath = absoluteNormalizedPath(options.controlPlanePath);
  if (
    controlPlanePath !== join(applicationSupportRoot, "control-plane.sqlite")
  ) {
    throw new UnsafeLocalDataRemovalTargetError(
      controlPlanePath,
      "control-plane path is not the fixed OPRTE database",
    );
  }
  const helperStateRoot = await requireCanonicalDirectory(
    options.helperStateRoot,
  );
  const metadataInspector = options.metadata ?? localMetadataInspector;

  const coreControlPlaneArtifacts: LocalDataRemovalArtifactCandidate[] = [
    ...controlPlaneSqliteRemovalArtifacts(controlPlanePath),
    { path: operationReceiptKeyPath(controlPlanePath), kind: "file" },
    {
      path: operationReceiptKeyCandidatePath(
        operationReceiptKeyPath(controlPlanePath),
      ),
      kind: "file",
    },
    { path: controlPlaneLifetimeLockPath(controlPlanePath), kind: "file" },
    { path: controlPlaneReleaseFencePath(controlPlanePath), kind: "file" },
    {
      path: `${controlPlaneReleaseFencePath(controlPlanePath)}.tmp`,
      kind: "file",
    },
    ...controlPlaneRestoreRemovalArtifacts(applicationSupportRoot),
    {
      path: join(
        applicationSupportRoot,
        ".hraness-kitchen-managed-worktree-repair-v1.json",
      ),
      kind: "file",
    },
    {
      path: join(
        applicationSupportRoot,
        ".hraness-kitchen-managed-worktree-repair-v1.json.tmp",
      ),
      kind: "file",
    },
    ...(options.additionalControlPlaneArtifacts ?? []),
  ];

  const applicationStateArtifacts: LocalDataRemovalArtifactCandidate[] = [
    { path: cutover.lock, kind: "file" },
    { path: `${cutover.lock}-wal`, kind: "file" },
    { path: `${cutover.lock}-shm`, kind: "file" },
    { path: `${cutover.lock}-journal`, kind: "file" },
    { path: cutover.stage, kind: "directory" },
    { path: `${cutover.receipt}.tmp`, kind: "file" },
    ...[
      cutover.legacy,
      cutover.developmentFallback,
      cutover.historicalOprte,
      cutover.historicalOperateDevelopment,
      cutover.predecessor,
    ].flatMap((path) => [
      { path: `${path}.tmp`, kind: "file" as const },
      { path: `${path}.swap`, kind: "directory" as const },
    ]),
    ...defaultMacosApplicationStateArtifacts(homeDirectory),
    ...(options.additionalApplicationStateArtifacts ?? []),
  ];
  if (
    await validatedOwnedJsonFile(
      cutover.receipt,
      migrationReceiptDiscoverySchema,
    )
  ) {
    applicationStateArtifacts.push({
      path: cutover.receipt,
      kind: "file",
    });
  }
  if (
    await validatedOwnedJsonFile(
      cutover.legacyV1Receipt,
      migrationReceiptDiscoverySchema,
    )
  ) {
    applicationStateArtifacts.push({
      path: cutover.legacyV1Receipt,
      kind: "file",
    });
  }
  for (const guardPath of [
    cutover.legacy,
    cutover.developmentFallback,
    cutover.historicalOprte,
    cutover.historicalOperateDevelopment,
    cutover.predecessor,
    cutover.legacyV1Stage,
  ]) {
    if (
      await validatedOwnedJsonFile(
        guardPath,
        downgradeGuardDiscoverySchema,
        { ignoreNonMatching: true },
      )
    ) {
      applicationStateArtifacts.push({ path: guardPath, kind: "file" });
    }
  }

  const controlPlaneTargets = await discoverExistingArtifacts(
    coreControlPlaneArtifacts,
    "control_plane",
    metadataInspector,
  );
  const releaseUpdateTargets = await discoverExistingArtifacts(
    [
      ...defaultMacosReleaseUpdateArtifacts(homeDirectory),
      ...(options.additionalReleaseUpdateArtifacts ?? []),
    ],
    "release_update_artifact",
    metadataInspector,
  );
  const applicationStateTargets = await discoverExistingArtifacts(
    applicationStateArtifacts,
    "application_state",
    metadataInspector,
  );
  const hraCodexTargets = await discoverExistingArtifacts(
    options.hraCodexProfileRoots.map((path) => ({
      path,
      kind: "directory" as const,
    })),
    predecessorCodexProfileCategory,
    metadataInspector,
  );

  const managedWorktreeRoots = await Promise.all(
    options.managedWorktreeRoots.map((path) =>
      requireCanonicalOrExpectedOwnedDirectory(path)
    ),
  );
  if (managedWorktreeRoots.length === 0) {
    throw new UnsafeLocalDataRemovalTargetError(
      null,
      "at least one managed-worktree root is required",
    );
  }
  const userRepositories = await Promise.all(
    options.userRepositories.map((path) =>
      requireCanonicalOrExpectedOwnedDirectory(path)
    ),
  );
  const managedWorktreeTargets = (
    await Promise.all(options.managedWorktrees.map(async (candidate) => {
      const expectedPath = absoluteNormalizedPath(candidate.path);
      const observed = await metadataInspector.inspect(expectedPath);
      if (observed === "missing") {
        const registration = await canonicalizeManagedWorktreeRegistration(
          candidate.registration,
          expectedPath,
          userRepositories,
        ).catch(async (error: unknown) => {
          if (
            error instanceof UnsafeLocalDataRemovalTargetError &&
            await metadata(candidate.registration.administrativeDirectory) ===
              null
          ) {
            return null;
          }
          throw error;
        });
        if (registration === null) return null;
        return {
          category: "managed_worktree" as const,
          path: expectedPath,
          kind: "directory" as const,
          dirty: false,
          registration,
        };
      }
      if (observed !== "directory") {
        throw new UnsafeLocalDataRemovalTargetError(
          expectedPath,
          observed === "symbolic_link"
            ? "discovered worktree is a symbolic link"
            : "discovered worktree is not a directory",
        );
      }
      const path = await requireCanonicalTarget(expectedPath, "directory");
      if (!managedWorktreeRoots.some((root) => isDirectChild(root, path))) {
        throw new UnsafeLocalDataRemovalTargetError(
          path,
          "discovered worktree is not an exact child of a managed root",
        );
      }
      const registration = await canonicalizeManagedWorktreeRegistration(
        candidate.registration,
        path,
        userRepositories,
      );
      const administrationExists = await metadata(
        registration.administrativeDirectory,
      ) !== null;
      return {
        category: "managed_worktree" as const,
        path,
        kind: "directory" as const,
        // Without its exact admin record Git cannot prove cleanliness. Treat
        // the checkout as dirty so removal still requires the separate ack.
        dirty: candidate.dirty ??
          (administrationExists
            ? await options.gitInspector.isDirty(path)
            : true),
        registration,
      };
    }))
  ).filter((target): target is NonNullable<typeof target> => target !== null);

  const keychainTargets = options.keychainTargets.map((target) =>
    localDataRemovalKeychainTargetSchema.parse(target)
  );
  const filesystemTargets: LocalDataRemovalFilesystemTarget[] = [
    ...controlPlaneTargets,
    ...hraCodexTargets,
    ...releaseUpdateTargets,
    ...applicationStateTargets,
    ...managedWorktreeTargets,
  ];
  rejectDuplicateOrOverlappingTargets(filesystemTargets);
  for (const repository of userRepositories) {
    for (const target of filesystemTargets) {
      if (pathsOverlap(repository, target.path)) {
        throw new UnsafeLocalDataRemovalTargetError(
          target.path,
          "discovered target overlaps a preserved user repository",
        );
      }
    }
  }

  return {
    inventory: {
      filesystemTargets,
      keychainTargets,
      preservedCredentialEvidenceRecords:
        options.preservedCredentialEvidenceRecords ?? 0,
      userRepositories,
    },
    ownedRoots: {
      controlPlane: categoryOwnedRoots(
        controlPlaneTargets,
        applicationSupportRoot,
      ),
      [predecessorCodexProfileDataField]: categoryOwnedRoots(
        hraCodexTargets,
        applicationSupportRoot,
      ),
      releaseUpdateArtifacts: categoryOwnedRoots(
        releaseUpdateTargets,
        applicationSupportRoot,
      ),
      applicationState: categoryOwnedRoots(
        applicationStateTargets,
        applicationSupportRoot,
      ),
      managedWorktrees: managedWorktreeRoots,
      helperStateRoot,
    },
  };
}

const localMetadataInspector: LocalDataRemovalMetadataInspector = {
  async inspect(path) {
    const value = await metadata(path);
    if (value === null) return "missing";
    if (value.isSymbolicLink()) return "symbolic_link";
    if (value.isFile()) return "file";
    if (value.isDirectory()) return "directory";
    return "special";
  },
};

export function defaultMacosApplicationStateArtifacts(
  homeDirectory: string,
): readonly LocalDataRemovalArtifactCandidate[] {
  const identifiers = [
    "kitchen.hraness",
    "com.jungle.oprte",
    "com.jungle.kitchen",
  ] as const;
  return [
    ...identifiers.flatMap((identifier) => [
      {
        path: join(
          homeDirectory,
          "Library",
          "Application Support",
          identifier,
        ),
        kind: "directory" as const,
      },
      {
        path: join(homeDirectory, "Library", "Logs", identifier),
        kind: "directory" as const,
      },
      {
        path: join(
          homeDirectory,
          "Library",
          "Preferences",
          `${identifier}.plist`,
        ),
        kind: "file" as const,
      },
      {
        path: join(
          homeDirectory,
          "Library",
          "Saved Application State",
          `${identifier}.savedState`,
        ),
        kind: "directory" as const,
      },
      {
        path: join(homeDirectory, "Library", "WebKit", identifier),
        kind: "directory" as const,
      },
      {
        path: join(homeDirectory, "Library", "HTTPStorages", identifier),
        kind: "directory" as const,
      },
      {
        path: join(
          homeDirectory,
          "Library",
          "HTTPStorages",
          `${identifier}.binarycookies`,
        ),
        kind: "file" as const,
      },
      {
        path: join(
          homeDirectory,
          "Library",
          "Cookies",
          `${identifier}.binarycookies`,
        ),
        kind: "file" as const,
      },
    ]),
    {
      path: join(homeDirectory, "Library", "Logs", "OPRTE"),
      kind: "directory",
    },
    ...[
      "Oprte",
      "OPeRaTE",
      "Kitchen",
      "Hraness Kitchen",
      "Hraness Kitchen Development",
    ].map((name) => ({
        path: join(homeDirectory, "Library", "Logs", name),
        kind: "directory" as const,
    })),
    {
      path: join(
        homeDirectory,
        "Library",
        "Application Support",
        "Hraness Kitchen Removal",
      ),
      kind: "directory",
    },
  ];
}

export function defaultMacosReleaseUpdateArtifacts(
  homeDirectory: string,
): readonly LocalDataRemovalArtifactCandidate[] {
  const applicationCaches = [
    "kitchen.hraness",
    "com.jungle.oprte",
    "com.jungle.kitchen",
    "OPRTE",
    "Oprte",
    "OPeRaTE",
    "Kitchen",
    "Hraness Kitchen",
  ].map((name) => ({
    path: join(homeDirectory, "Library", "Caches", name),
    kind: "directory" as const,
  }));
  const sparkleCaches = [
    "kitchen.hraness",
    "com.jungle.oprte",
    "com.jungle.kitchen",
  ].flatMap((identifier) =>
    ["PersistentDownloads", "Launcher"].map((directory) => ({
      path: join(
        homeDirectory,
        "Library",
        "Caches",
        identifier,
        "org.sparkle-project.Sparkle",
        directory,
      ),
      kind: "directory" as const,
    }))
  );
  return [...applicationCaches, ...sparkleCaches];
}

async function validatedOwnedJsonFile(
  pathValue: string,
  schema: {
    safeParse(value: unknown): { readonly success: boolean };
  },
  options: { readonly ignoreNonMatching?: boolean } = {},
): Promise<boolean> {
  const path = absoluteNormalizedPath(pathValue);
  const value = await metadata(path);
  if (value === null) return false;
  if (
    value.isSymbolicLink() ||
    !value.isFile() ||
    value.nlink !== 1 ||
    value.size <= 0 ||
    value.size > 4_096
  ) {
    if (options.ignoreNonMatching === true) return false;
    throw new UnsafeLocalDataRemovalTargetError(
      path,
      "owned metadata file has an unsafe filesystem identity",
    );
  }
  const currentUser = process.getuid?.();
  if (currentUser !== undefined && value.uid !== currentUser) {
    if (options.ignoreNonMatching === true) return false;
    throw new UnsafeLocalDataRemovalTargetError(
      path,
      "owned metadata file belongs to another user",
    );
  }
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const observed = await handle.stat();
    if (
      !observed.isFile() ||
      observed.dev !== value.dev ||
      observed.ino !== value.ino ||
      observed.size !== value.size
    ) {
      throw new UnsafeLocalDataRemovalTargetError(
        path,
        "owned metadata file changed during validation",
      );
    }
    const source = await handle.readFile("utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(source) as unknown;
    } catch {
      if (options.ignoreNonMatching === true) return false;
      throw new UnsafeLocalDataRemovalTargetError(
        path,
        "owned metadata file is not valid JSON",
      );
    }
    if (!schema.safeParse(parsed).success) {
      if (options.ignoreNonMatching === true) return false;
      throw new UnsafeLocalDataRemovalTargetError(
        path,
        "owned metadata file has an unexpected schema",
      );
    }
    return true;
  } finally {
    await handle?.close();
  }
}

async function discoverExistingArtifacts(
  candidates: readonly LocalDataRemovalArtifactCandidate[],
  category: Exclude<
    LocalDataRemovalFilesystemCategory,
    "managed_worktree"
  >,
  inspector: LocalDataRemovalMetadataInspector,
): Promise<LocalDataRemovalFilesystemTarget[]> {
  const unique = new Map<string, "file" | "directory">();
  for (const candidate of candidates) {
    const path = absoluteNormalizedPath(candidate.path);
    const existing = unique.get(path);
    if (existing !== undefined && existing !== candidate.kind) {
      throw new UnsafeLocalDataRemovalTargetError(
        path,
        "artifact discovery assigned conflicting filesystem kinds",
      );
    }
    unique.set(path, candidate.kind);
  }

  const targets: LocalDataRemovalFilesystemTarget[] = [];
  for (const [path, kind] of unique) {
    const observed = await inspector.inspect(path);
    if (observed === "missing") {
      await requireCanonicalOrExpectedTarget(path, kind);
      targets.push({ category, path, kind });
      continue;
    }
    if (observed !== kind) {
      throw new UnsafeLocalDataRemovalTargetError(
        path,
        observed === "symbolic_link"
          ? "discovered artifact is a symbolic link"
          : "discovered artifact has an unexpected filesystem kind",
      );
    }
    targets.push({
      category,
      path: await requireCanonicalTarget(path, kind),
      kind,
    });
  }
  return targets.filter((target, index) =>
    !targets.some((candidate, candidateIndex) =>
      candidateIndex !== index &&
      candidate.kind === "directory" &&
      candidate.path !== target.path &&
      isPathWithinExactOwnedRoot(candidate.path, target.path)
    )
  );
}

function categoryOwnedRoots(
  targets: readonly LocalDataRemovalFilesystemTarget[],
  fallbackRoot: string,
): string[] {
  const roots = new Set<string>([fallbackRoot]);
  for (const target of targets) {
    if (!isPathWithinExactOwnedRoot(fallbackRoot, target.path)) {
      roots.add(target.path);
    }
  }
  return [...roots].sort();
}

function absoluteNormalizedPath(pathValue: string): string {
  const path = absolutePathSchema.parse(pathValue);
  if (resolve(path) !== path) {
    throw new UnsafeLocalDataRemovalTargetError(path, "path is not normalized");
  }
  rejectBroadPath(path);
  return path;
}

export async function createLocalDataRemovalPlan(
  options: CreateLocalDataRemovalPlanOptions,
): Promise<PreparedLocalDataRemovalPlan> {
  const signingKey = requireSigningKey(options.signingKey);
  const inventory = localDataRemovalInventorySchema.parse(options.inventory);
  const previewId = localDataRemovalPreviewIdSchema.parse(options.previewId);
  const ownedRoots = await canonicalizeOwnedRoots(
    options.ownedRoots,
    { allowMissing: true },
  );
  const privatePlan = await canonicalizeInventory(inventory, ownedRoots);
  const now = options.now ?? new Date();
  const lifetime = options.previewLifetimeMs ?? defaultPreviewLifetimeMs;
  if (!Number.isSafeInteger(lifetime) || lifetime <= 0 || lifetime > 15 * 60 * 1_000) {
    throw new RangeError("Local-data removal preview lifetime is invalid.");
  }
  const expiresAt = new Date(now.getTime() + lifetime).toISOString();
  const confirmationToken = localDataRemovalConfirmationTokenSchema.parse(
    `confirm_${createHmac("sha256", signingKey)
      .update(canonicalJson({
        version: 1,
        previewId,
        inventoryDigest: privatePlan.inventoryDigest,
        expiresAt,
      }))
      .digest("base64url")}`,
  );
  const blockers: Array<
    "helperUnavailable" | "operationInProgress" | "targetValidationFailed"
  > = [];
  if (options.helperAvailable === false) blockers.push("helperUnavailable");
  if (options.operationInProgress === true) blockers.push("operationInProgress");

  const dirtyManagedWorktrees = privatePlan.filesystemTargets.filter(
    (target) =>
      target.category === "managed_worktree" && target.dirty === true,
  ).length;
  const countCategory = (
    category: LocalDataRemovalFilesystemCategory,
  ): number => privatePlan.filesystemTargets.filter(
    (target) => target.category === category,
  ).length;
  const preview = runtimeLocalDataRemovalPreviewSchema.parse({
    previewId,
    confirmationToken,
    expiresAt,
    removes: {
      controlPlaneItems: countCategory("control_plane"),
      hraCodexProfileDataItems: countCategory(
        predecessorCodexProfileCategory,
      ),
      humanCredentialGenerations: privatePlan.keychainTargets.filter(
        ({ category }) => category === "human_credential_generation",
      ).length,
      runnerPairingSecrets: privatePlan.keychainTargets.filter(
        ({ category }) => category === "runner_pairing_secret",
      ).length,
      harnessContextHeapKeys: privatePlan.keychainTargets.filter(
        ({ category }) => category === "harness_context_heap_key",
      ).length,
      sessionSyncKeyMaterials: privatePlan.keychainTargets.filter(
        ({ category }) => category === "session_sync_key_material",
      ).length,
      releaseUpdateArtifacts: countCategory("release_update_artifact"),
      applicationStateItems: countCategory("application_state"),
      managedWorktrees: countCategory("managed_worktree"),
      dirtyManagedWorktrees,
    },
    preserves: {
      userRepositories: privatePlan.userRepositories.length,
      externalCodexData: true,
      taskctlCredentials: true,
      credentialRecoveryEvidenceRecords:
        privatePlan.preservedCredentialEvidenceRecords,
      unrelatedData: true,
    },
    dirtyWorktreeAcknowledgementRequired: dirtyManagedWorktrees > 0,
    blockers,
    canRemove: blockers.length === 0,
  });
  return { preview, privatePlan };
}

const ordinaryHelperFilesystemTargetSchema = z
  .object({
    id: targetIdSchema,
    category: z.enum([
      "control_plane",
      predecessorCodexProfileCategory,
      "release_update_artifact",
      "application_state",
    ]),
    path: absolutePathSchema,
    kind: z.enum(["file", "directory"]),
  })
  .strict();

const managedHelperFilesystemTargetSchema = z
  .object({
    id: targetIdSchema,
    category: z.literal("managed_worktree"),
    path: absolutePathSchema,
    kind: z.literal("directory"),
    dirty: z.boolean(),
    registration: managedWorktreeRegistrationSchema,
  })
  .strict();

const helperFilesystemTargetSchema = z.discriminatedUnion("category", [
  ordinaryHelperFilesystemTargetSchema,
  managedHelperFilesystemTargetSchema,
]);

const helperOwnedRootsSchema = z
  .object({
    controlPlane: z
      .array(absolutePathSchema)
      .min(1)
      .max(maximumOwnedRootsPerCategory),
    [predecessorCodexProfileDataField]: z
      .array(absolutePathSchema)
      .min(1)
      .max(maximumOwnedRootsPerCategory),
    releaseUpdateArtifacts: z
      .array(absolutePathSchema)
      .min(1)
      .max(maximumOwnedRootsPerCategory),
    applicationState: z
      .array(absolutePathSchema)
      .min(1)
      .max(maximumOwnedRootsPerCategory),
    managedWorktrees: z
      .array(absolutePathSchema)
      .min(1)
      .max(maximumOwnedRootsPerCategory),
    helperStateRoot: absolutePathSchema,
  })
  .strict();

export const localDataRemovalHelperPayloadSchema = z
  .object({
    version: z.literal(helperRequestVersion),
    kind: z.literal(helperRequestKind),
    operationId: operationIdSchema,
    previewId: localDataRemovalPreviewIdSchema,
    inventoryDigest: sha256DigestSchema,
    allowlistDigest: sha256DigestSchema,
    issuedAt: z.number().int().safe().nonnegative(),
    expiresAt: z.number().int().safe().positive(),
    parentProcessId: z.number().int().safe().min(2),
    waitForParentExit: z.literal(true),
    acknowledgeDirtyWorktrees: z.boolean(),
    helperStateRoot: absolutePathSchema,
    exclusionPath: absolutePathSchema,
    executionLockPath: absolutePathSchema,
    ownedRoots: helperOwnedRootsSchema,
    stageRoot: absolutePathSchema,
    receiptPath: absolutePathSchema,
    targets: z.array(helperFilesystemTargetSchema).max(maximumTargets),
    preservedUserRepositories: z.array(absolutePathSchema).max(maximumTargets),
  })
  .strict()
  .superRefine((payload, context) => {
    if (payload.expiresAt <= payload.issuedAt) {
      context.addIssue({
        code: "custom",
        message: "helper request must expire after it is issued",
        path: ["expiresAt"],
      });
    }
    const ids = new Set(payload.targets.map(({ id }) => id));
    if (ids.size !== payload.targets.length) {
      context.addIssue({
        code: "custom",
        message: "helper target IDs must be unique",
        path: ["targets"],
      });
    }
  });
export type LocalDataRemovalHelperPayload = z.infer<
  typeof localDataRemovalHelperPayloadSchema
>;

export const signedLocalDataRemovalHelperRequestSchema = z
  .object({
    payload: localDataRemovalHelperPayloadSchema,
    signature: hmacSignatureSchema,
  })
  .strict();
export type SignedLocalDataRemovalHelperRequest = z.infer<
  typeof signedLocalDataRemovalHelperRequestSchema
>;

export function signLocalDataRemovalHelperPayload(
  value: unknown,
  signingKeyValue: Uint8Array,
): SignedLocalDataRemovalHelperRequest {
  const payload = localDataRemovalHelperPayloadSchema.parse(value);
  const signingKey = requireSigningKey(signingKeyValue);
  return signedLocalDataRemovalHelperRequestSchema.parse({
    payload,
    signature: `hmac_sha256_${createHmac("sha256", signingKey)
      .update(canonicalJson(payload))
      .digest("hex")}`,
  });
}

export function verifyLocalDataRemovalHelperRequest(
  value: unknown,
  signingKeyValue: Uint8Array,
): SignedLocalDataRemovalHelperRequest {
  const request = signedLocalDataRemovalHelperRequestSchema.parse(value);
  const signingKey = requireSigningKey(signingKeyValue);
  const expected = Buffer.from(
    createHmac("sha256", signingKey)
      .update(canonicalJson(request.payload))
      .digest("hex"),
    "hex",
  );
  const observed = Buffer.from(
    request.signature.slice("hmac_sha256_".length),
    "hex",
  );
  if (
    expected.byteLength !== observed.byteLength ||
    !timingSafeEqual(expected, observed)
  ) {
    throw new LocalDataRemovalConfirmationError(
      "invalid_confirmation",
      "The native helper request signature is invalid.",
    );
  }
  return request;
}

const canonicalPrivatePlanSchema = z
  .object({
    inventoryDigest: sha256DigestSchema,
    ownedRoots: helperOwnedRootsSchema,
    filesystemTargets: z.array(helperFilesystemTargetSchema).max(
      maximumTargets,
    ),
    keychainTargets: z.array(localDataRemovalKeychainTargetSchema).max(
      maximumTargets,
    ),
    preservedCredentialEvidenceRecords: z.number().int().nonnegative().max(
      maximumTargets,
    ).default(0),
    userRepositories: z.array(absolutePathSchema).max(maximumTargets),
  })
  .strict();

const confirmedRemovalCommandSchema = z
  .object({
    type: z.literal("maintenance.localDataRemoval.remove"),
    previewId: localDataRemovalPreviewIdSchema,
    confirmationToken: localDataRemovalConfirmationTokenSchema,
    confirmation: z.literal(runtimeLocalDataRemovalConfirmation),
    acknowledgeDirtyWorktrees: z.boolean(),
  })
  .strict();

const unauthenticatedGatewayReceiptSchema = z
  .object({
    version: z.literal(1),
    operationId: operationIdSchema,
    nativeRemovalCapability: nativeRemovalCapabilitySchema,
    requestDigest: sha256DigestSchema,
    previewId: localDataRemovalPreviewIdSchema,
    parentProcessId: z.number().int().safe().min(2),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    preview: runtimeLocalDataRemovalPreviewSchema,
    privatePlan: canonicalPrivatePlanSchema,
    confirmedCommand: confirmedRemovalCommandSchema,
    keychainTargets: z.array(
      z.object({
        category: z.enum([
          "human_credential_generation",
          "runner_pairing_secret",
          "harness_context_heap_key",
          "session_sync_key_material",
        ]),
        service: z.string().min(1).max(240),
        name: z.string().min(1).max(512),
        completed: z.boolean(),
      }).strict(),
    ).max(maximumTargets),
    requestPath: absolutePathSchema.nullable(),
    signingKeyPath: absolutePathSchema.nullable(),
    signedRequest: signedLocalDataRemovalHelperRequestSchema.nullable(),
  })
  .strict();

const gatewayReceiptSchema = unauthenticatedGatewayReceiptSchema.extend({
  authentication: hmacSignatureSchema,
}).strict();
export type GatewayRemovalReceipt = z.infer<typeof gatewayReceiptSchema>;

function gatewayReceiptBody(
  value: unknown,
): z.infer<typeof unauthenticatedGatewayReceiptSchema> {
  if (typeof value !== "object" || value === null) {
    return unauthenticatedGatewayReceiptSchema.parse(value);
  }
  const body: Record<string, unknown> = { ...value };
  delete body.authentication;
  return unauthenticatedGatewayReceiptSchema.parse(body);
}

function authenticateGatewayReceipt(
  value: unknown,
  signingKeyValue: Uint8Array,
): GatewayRemovalReceipt {
  const body = gatewayReceiptBody(value);
  const signingKey = requireSigningKey(signingKeyValue);
  return gatewayReceiptSchema.parse({
    ...body,
    authentication: `hmac_sha256_${createHmac("sha256", signingKey)
      .update(canonicalJson(body))
      .digest("hex")}`,
  });
}

function verifyGatewayReceipt(
  value: unknown,
  signingKeyValue: Uint8Array,
): GatewayRemovalReceipt {
  const receipt = gatewayReceiptSchema.parse(value);
  const expected = authenticateGatewayReceipt(receipt, signingKeyValue);
  if (!safeStringEqual(expected.authentication, receipt.authentication)) {
    throw new LocalDataRemovalConfirmationError(
      "operation_conflict",
      "The durable local-data removal receipt authentication is invalid.",
    );
  }
  return receipt;
}

export interface LocalDataRemovalReceiptStore {
  read(operationId: string): Promise<GatewayRemovalReceipt | null>;
  list(): Promise<readonly GatewayRemovalReceipt[]>;
  write(receipt: GatewayRemovalReceipt): Promise<void>;
}

export class FileLocalDataRemovalReceiptStore
implements LocalDataRemovalReceiptStore {
  readonly #helperStateRoot: string;

  constructor(helperStateRoot: string) {
    this.#helperStateRoot = absolutePathSchema.parse(helperStateRoot);
  }

  async read(operationIdValue: string): Promise<GatewayRemovalReceipt | null> {
    const operationId = operationIdSchema.parse(operationIdValue);
    const path = await this.#receiptPath(operationId);
    const source = await readFile(path, "utf8").catch((error: unknown) => {
      if (isFileSystemError(error, "ENOENT")) return null;
      throw error;
    });
    if (source === null) return null;
    return gatewayReceiptSchema.parse(parseJson(source, "gateway receipt"));
  }

  async write(receiptValue: GatewayRemovalReceipt): Promise<void> {
    const receipt = gatewayReceiptSchema.parse(receiptValue);
    const path = await this.#receiptPath(receipt.operationId);
    await atomicWritePrivateJson(path, receipt);
  }

  async list(): Promise<readonly GatewayRemovalReceipt[]> {
    const root = await requireCanonicalDirectory(this.#helperStateRoot);
    const receiptsRoot = await ensurePrivateDirectChildDirectory(
      root,
      "gateway-receipts",
    );
    const entries = await readdir(receiptsRoot, { withFileTypes: true });
    const receipts: GatewayRemovalReceipt[] = [];
    for (const entry of entries) {
      if (
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        !entry.name.endsWith(".json")
      ) {
        throw new UnsafeLocalDataRemovalTargetError(
          exactDirectChild(receiptsRoot, entry.name),
          "gateway receipt directory contains an unexpected entry",
        );
      }
      const operationIdResult = operationIdSchema.safeParse(
        entry.name.slice(0, -".json".length),
      );
      if (!operationIdResult.success) {
        throw new UnsafeLocalDataRemovalTargetError(
          exactDirectChild(receiptsRoot, entry.name),
          "gateway receipt has an invalid operation identity",
        );
      }
      const receipt = await this.read(operationIdResult.data);
      if (receipt === null) {
        throw new LocalDataRemovalConfirmationError(
          "operation_conflict",
          "A gateway receipt vanished during startup recovery.",
        );
      }
      receipts.push(receipt);
    }
    return receipts.sort((left, right) =>
      left.operationId.localeCompare(right.operationId)
    );
  }

  async #receiptPath(operationId: string): Promise<string> {
    const root = await requireCanonicalDirectory(this.#helperStateRoot);
    const receiptsRoot = await ensurePrivateDirectChildDirectory(
      root,
      "gateway-receipts",
    );
    return exactDirectChild(receiptsRoot, `${operationId}.json`);
  }
}

export interface LocalDataRemovalHelperLaunch {
  readonly executable: {
    readonly relativeToSignedBundleResources:
      typeof packagedLocalDataRemoverRelativePath;
    readonly packagedBundlePath: typeof packagedLocalDataRemoverBundlePath;
    readonly requireSignedBundleResource: true;
    readonly permitPathOrEnvironmentOverrideInPackagedBuild: false;
  };
  readonly spawnBeforeApplicationQuit: true;
  readonly quitApplicationAfterSuccessfulLaunch: true;
  readonly waitForParentExit: true;
  readonly parentProcessId: number;
  readonly requestPath: string;
  readonly signingKeyPath: string;
  readonly signedRequest: SignedLocalDataRemovalHelperRequest;
}

export type LocalDataRemovalFaultCheckpoint =
  | "after_exclusion_before_gateway_receipt"
  | "after_gateway_receipt"
  | "after_keychain_delete"
  | "after_keychain_receipt"
  | "after_request_file"
  | "after_launch_receipt"
  | "after_helper_receipt_initialized"
  | "before_target_stage"
  | "after_target_stage"
  | "after_target_stage_receipt"
  | "after_worktree_registration_remove"
  | "after_target_remove"
  | "after_target_remove_receipt"
  | "after_helper_completion"
  | "before_helper_state_cleanup"
  | "after_helper_state_staged"
  | "after_helper_state_cleanup_before_exclusion"
  | "after_helper_state_cleanup";

export interface LocalDataRemovalMaintenanceFence {
  /** True only while every HRA writer remains quiesced for app exit. */
  isHeld(): boolean;
}

export interface PrepareLocalDataRemovalLaunchOptions {
  readonly plan: PreparedLocalDataRemovalPlan;
  readonly command: Extract<
    RuntimeLocalDataRemovalCommand,
    { readonly type: "maintenance.localDataRemoval.remove" }
  >;
  readonly operationId: string;
  readonly nativeRemovalCapability: string;
  readonly parentProcessId: number;
  readonly signingKey: Uint8Array;
  readonly signingKeyPath: string;
  readonly secrets: AuthenticatedLocalDataRemovalSecretStore;
  readonly receipts: LocalDataRemovalReceiptStore;
  readonly maintenanceFence: LocalDataRemovalMaintenanceFence;
  readonly revalidateInventory:
    () => Promise<DiscoveredLocalDataRemovalInventory>;
  readonly now?: Date;
  readonly faultInjector?: (
    checkpoint: LocalDataRemovalFaultCheckpoint,
    targetId: string | null,
  ) => void;
}

export async function prepareLocalDataRemovalHelperLaunch(
  options: PrepareLocalDataRemovalLaunchOptions,
): Promise<LocalDataRemovalHelperLaunch> {
  const operationId = operationIdSchema.parse(options.operationId);
  const nativeRemovalCapability = nativeRemovalCapabilitySchema.parse(
    options.nativeRemovalCapability,
  );
  const parentProcessId = z.number().int().safe().min(2).parse(
    options.parentProcessId,
  );
  const command = options.command;
  const signingKey = requireSigningKey(options.signingKey);
  const now = options.now ?? new Date();
  assertConfirmedPlan(options.plan, command, signingKey, now);
  const requestDigest = sha256({
    version: 1,
    operationId,
    nativeRemovalCapability,
    parentProcessId,
    previewId: command.previewId,
    inventoryDigest: options.plan.privatePlan.inventoryDigest,
    confirmationToken: command.confirmationToken,
    acknowledgeDirtyWorktrees: command.acknowledgeDirtyWorktrees,
  });
  let receipt = await options.receipts.read(operationId);
  if (receipt !== null) {
    verifyGatewayReceipt(receipt, signingKey);
    if (
      receipt.requestDigest !== requestDigest ||
      canonicalJson(receipt.privatePlan) !==
        canonicalJson(options.plan.privatePlan) ||
      canonicalJson(receipt.confirmedCommand) !== canonicalJson(command) ||
      receipt.parentProcessId !== parentProcessId
    ) {
      throw new LocalDataRemovalConfirmationError(
        "operation_conflict",
        "The operation ID is already bound to a different removal request.",
      );
    }
  }
  if (receipt === null) {
    if (
      await metadata(
        localDataRemovalExclusionPath(
          options.plan.privatePlan.ownedRoots.helperStateRoot,
        ),
      ) !== null
    ) {
      throw new LocalDataRemovalConfirmationError(
        "operation_conflict",
        "A local-data removal exclusion already exists.",
      );
    }
    assertMaintenanceFenceHeld(options.maintenanceFence);
    const current = await options.revalidateInventory();
    const currentRoots = await canonicalizeOwnedRoots(
      current.ownedRoots,
      { allowMissing: true },
    );
    const currentPrivatePlan = await canonicalizeInventory(
      localDataRemovalInventorySchema.parse(current.inventory),
      currentRoots,
    );
    assertMaintenanceFenceHeld(options.maintenanceFence);
    if (
      canonicalJson(currentPrivatePlan) !==
        canonicalJson(options.plan.privatePlan)
    ) {
      throw new LocalDataRemovalConfirmationError(
        "inventory_changed",
        "HRA local data changed after the preview; create a fresh preview.",
      );
    }
    const timestamp = now.toISOString();
    const preparedReceipt = authenticateGatewayReceipt({
      version: 1,
      operationId,
      nativeRemovalCapability,
      requestDigest,
      previewId: command.previewId,
      parentProcessId,
      createdAt: timestamp,
      updatedAt: timestamp,
      preview: options.plan.preview,
      privatePlan: options.plan.privatePlan,
      confirmedCommand: command,
      keychainTargets: options.plan.privatePlan.keychainTargets.map(
        (target) => ({ ...target, completed: false }),
      ),
      requestPath: null,
      signingKeyPath: null,
      signedRequest: null,
    }, signingKey);
    await ensureLocalDataRemovalExclusion(
      options.plan.privatePlan.ownedRoots.helperStateRoot,
    );
    options.faultInjector?.(
      "after_exclusion_before_gateway_receipt",
      null,
    );
    await options.receipts.write(preparedReceipt);
    options.faultInjector?.("after_gateway_receipt", null);
    receipt = preparedReceipt;
  } else {
    await ensureLocalDataRemovalExclusion(
      options.plan.privatePlan.ownedRoots.helperStateRoot,
    );
  }
  return await continueLocalDataRemovalHelperLaunch({
    receipt,
    signingKey,
    signingKeyPath: options.signingKeyPath,
    secrets: options.secrets,
    receipts: options.receipts,
    maintenanceFence: options.maintenanceFence,
    now,
    ...(options.faultInjector === undefined
      ? {}
      : { faultInjector: options.faultInjector }),
  });
}

export interface ResumeLocalDataRemovalLaunchOptions {
  readonly operationId: string;
  readonly nativeRemovalCapability: string;
  readonly parentProcessId: number;
  readonly command: Extract<
    RuntimeLocalDataRemovalCommand,
    { readonly type: "maintenance.localDataRemoval.remove" }
  >;
  readonly signingKey: Uint8Array;
  readonly signingKeyPath: string;
  readonly secrets: AuthenticatedLocalDataRemovalSecretStore;
  readonly receipts: LocalDataRemovalReceiptStore;
  readonly maintenanceFence: LocalDataRemovalMaintenanceFence;
  readonly now?: Date;
  readonly faultInjector?: (
    checkpoint: LocalDataRemovalFaultCheckpoint,
    targetId: string | null,
  ) => void;
}

export async function resumeLocalDataRemovalHelperLaunch(
  options: ResumeLocalDataRemovalLaunchOptions,
): Promise<LocalDataRemovalHelperLaunch> {
  const operationId = operationIdSchema.parse(options.operationId);
  const nativeRemovalCapability = nativeRemovalCapabilitySchema.parse(
    options.nativeRemovalCapability,
  );
  const parentProcessId = z.number().int().safe().min(2).parse(
    options.parentProcessId,
  );
  const signingKey = requireSigningKey(options.signingKey);
  const receipt = await options.receipts.read(operationId);
  if (receipt === null) {
    throw new LocalDataRemovalConfirmationError(
      "operation_conflict",
      "No durable confirmed local-data removal exists for this operation.",
    );
  }
  verifyGatewayReceipt(receipt, signingKey);
  assertMaintenanceFenceHeld(options.maintenanceFence);
  if (
    receipt.parentProcessId !== parentProcessId ||
    receipt.nativeRemovalCapability !== nativeRemovalCapability ||
    canonicalJson(receipt.confirmedCommand) !==
      canonicalJson(options.command)
  ) {
    throw new LocalDataRemovalConfirmationError(
      "operation_conflict",
      "The resume request does not match the durable confirmed operation.",
    );
  }
  return await continueLocalDataRemovalHelperLaunch({
    receipt,
    signingKey,
    signingKeyPath: options.signingKeyPath,
    secrets: options.secrets,
    receipts: options.receipts,
    maintenanceFence: options.maintenanceFence,
    now: options.now ?? new Date(),
    ...(options.faultInjector === undefined
      ? {}
      : { faultInjector: options.faultInjector }),
  });
}

export interface ResumePendingLocalDataRemovalLaunchOptions {
  readonly parentProcessId: number;
  readonly signingKey: Uint8Array;
  readonly signingKeyPath: string;
  readonly nativeRemovalCapability: string;
  readonly secrets: AuthenticatedLocalDataRemovalSecretStore;
  readonly receipts: LocalDataRemovalReceiptStore;
  readonly maintenanceFence: LocalDataRemovalMaintenanceFence;
  readonly now?: Date;
}

/**
 * Fresh-process recovery for the one durable confirmed removal operation.
 * The authenticated plan/command are loaded privately; no renderer state is
 * accepted. A new parent PID is rebound only while the maintenance fence is
 * held.
 */
export async function resumePendingLocalDataRemovalHelperLaunch(
  options: ResumePendingLocalDataRemovalLaunchOptions,
): Promise<LocalDataRemovalHelperLaunch | null> {
  assertMaintenanceFenceHeld(options.maintenanceFence);
  const signingKey = requireSigningKey(options.signingKey);
  const nativeRemovalCapability = nativeRemovalCapabilitySchema.parse(
    options.nativeRemovalCapability,
  );
  const parentProcessId = z.number().int().safe().min(2).parse(
    options.parentProcessId,
  );
  const receipts = await options.receipts.list();
  if (receipts.length === 0) return null;
  if (receipts.length !== 1) {
    throw new LocalDataRemovalConfirmationError(
      "operation_conflict",
      "Multiple durable local-data removal operations require intervention.",
    );
  }
  const stored = receipts[0];
  if (stored === undefined) return null;
  verifyGatewayReceipt(stored, signingKey);
  await ensureLocalDataRemovalExclusion(
    stored.privatePlan.ownedRoots.helperStateRoot,
  );
  const requestDigest = sha256({
    version: 1,
    operationId: stored.operationId,
    nativeRemovalCapability,
    parentProcessId,
    previewId: stored.confirmedCommand.previewId,
    inventoryDigest: stored.privatePlan.inventoryDigest,
    confirmationToken: stored.confirmedCommand.confirmationToken,
    acknowledgeDirtyWorktrees:
      stored.confirmedCommand.acknowledgeDirtyWorktrees,
  });
  const rebound = authenticateGatewayReceipt({
    ...stored,
    authentication: undefined,
    nativeRemovalCapability,
    requestDigest,
    parentProcessId,
    updatedAt: (options.now ?? new Date()).toISOString(),
    requestPath: null,
    signingKeyPath: null,
    signedRequest: null,
  }, signingKey);
  await options.receipts.write(rebound);
  assertMaintenanceFenceHeld(options.maintenanceFence);
  return await continueLocalDataRemovalHelperLaunch({
    receipt: rebound,
    signingKey,
    signingKeyPath: options.signingKeyPath,
    secrets: options.secrets,
    receipts: options.receipts,
    maintenanceFence: options.maintenanceFence,
    now: options.now ?? new Date(),
  });
}

interface ContinueLocalDataRemovalLaunchOptions {
  readonly receipt: GatewayRemovalReceipt;
  readonly signingKey: Uint8Array;
  readonly signingKeyPath: string;
  readonly secrets: AuthenticatedLocalDataRemovalSecretStore;
  readonly receipts: LocalDataRemovalReceiptStore;
  readonly maintenanceFence: LocalDataRemovalMaintenanceFence;
  readonly now: Date;
  readonly faultInjector?: (
    checkpoint: LocalDataRemovalFaultCheckpoint,
    targetId: string | null,
  ) => void;
}

async function continueLocalDataRemovalHelperLaunch(
  options: ContinueLocalDataRemovalLaunchOptions,
): Promise<LocalDataRemovalHelperLaunch> {
  const signingKey = requireSigningKey(options.signingKey);
  assertMaintenanceFenceHeld(options.maintenanceFence);
  let receipt = options.receipt;
  verifyGatewayReceipt(receipt, signingKey);
  const plan: PreparedLocalDataRemovalPlan = {
    preview: receipt.preview,
    privatePlan: receipt.privatePlan,
  };
  const helperStateRoot = plan.privatePlan.ownedRoots.helperStateRoot;
  await ensureLocalDataRemovalExclusion(helperStateRoot);
  const signingKeyPath = await requireCanonicalFileWithin(
    options.signingKeyPath,
    helperStateRoot,
  );
  if (receipt.signedRequest !== null) {
    verifyLocalDataRemovalHelperRequest(receipt.signedRequest, signingKey);
    assertLocalDataRemovalHelperRequestSize(receipt.signedRequest);
    if (
      receipt.requestPath === null ||
      receipt.signingKeyPath !== signingKeyPath
    ) {
      throw new LocalDataRemovalConfirmationError(
        "operation_conflict",
        "The completed launch receipt does not match the helper launch paths.",
      );
    }
    return helperLaunch(
      receipt.requestPath,
      signingKeyPath,
      receipt.signedRequest,
    );
  }
  const signedRequest = createSignedLocalDataRemovalHelperRequest(
    receipt,
    plan,
    signingKey,
    options.now,
  );
  assertLocalDataRemovalHelperRequestSize(signedRequest);
  assertSameKeychainTargets(
    receipt.keychainTargets,
    plan.privatePlan.keychainTargets,
  );
  for (let index = 0; index < receipt.keychainTargets.length; index += 1) {
    const target = receipt.keychainTargets[index];
    if (target === undefined || target.completed) continue;
    assertMaintenanceFenceHeld(options.maintenanceFence);
    verifyGatewayReceipt(receipt, signingKey);
    await options.secrets.delete(target, {
      operationId: receipt.operationId,
      previewId: receipt.previewId,
      nativeRemovalCapability: receipt.nativeRemovalCapability,
      receiptAuthentication: receipt.authentication,
    });
    assertMaintenanceFenceHeld(options.maintenanceFence);
    options.faultInjector?.("after_keychain_delete", keychainTargetId(target));
    // v1 and v2 are one Native custody unit. The one-shot capability deletes
    // both fixed descriptors, then this single authenticated transition marks
    // the entire group complete. A restart can only observe neither completed
    // (and safely retry) or both completed.
    const completesHarnessGroup =
      target.category === "harness_context_heap_key";
    const nextTargets = receipt.keychainTargets.map((entry, entryIndex) =>
      entryIndex === index ||
          (completesHarnessGroup &&
            entry.category === "harness_context_heap_key")
        ? { ...entry, completed: true }
        : entry
    );
    receipt = authenticateGatewayReceipt({
      ...receipt,
      authentication: undefined,
      updatedAt: options.now.toISOString(),
      keychainTargets: nextTargets,
    }, signingKey);
    await options.receipts.write(receipt);
    options.faultInjector?.("after_keychain_receipt", keychainTargetId(target));
  }

  const requestsRoot = await ensurePrivateDirectChildDirectory(
    helperStateRoot,
    "requests",
  );
  const requestPath = exactDirectChild(
    requestsRoot,
    `${receipt.operationId}.json`,
  );
  assertMaintenanceFenceHeld(options.maintenanceFence);
  await atomicWritePrivateJson(requestPath, signedRequest);
  options.faultInjector?.("after_request_file", null);

  receipt = authenticateGatewayReceipt({
    ...receipt,
    authentication: undefined,
    updatedAt: options.now.toISOString(),
    requestPath,
    signingKeyPath,
    signedRequest,
  }, signingKey);
  await options.receipts.write(receipt);
  options.faultInjector?.("after_launch_receipt", null);
  return helperLaunch(requestPath, signingKeyPath, signedRequest);
}

function createSignedLocalDataRemovalHelperRequest(
  receipt: GatewayRemovalReceipt,
  plan: PreparedLocalDataRemovalPlan,
  signingKey: Uint8Array,
  now: Date,
): SignedLocalDataRemovalHelperRequest {
  const helperStateRoot = plan.privatePlan.ownedRoots.helperStateRoot;
  const stagingParent = exactDirectChild(helperStateRoot, "staging");
  const helperReceiptsParent = exactDirectChild(
    helperStateRoot,
    "helper-receipts",
  );
  const payload = localDataRemovalHelperPayloadSchema.parse({
    version: helperRequestVersion,
    kind: helperRequestKind,
    operationId: receipt.operationId,
    previewId: receipt.confirmedCommand.previewId,
    inventoryDigest: plan.privatePlan.inventoryDigest,
    allowlistDigest: allowlistDigest(plan.privatePlan.ownedRoots),
    issuedAt: now.getTime(),
    expiresAt: Math.max(
      Date.parse(plan.preview.expiresAt),
      now.getTime() + defaultPreviewLifetimeMs,
    ),
    parentProcessId: receipt.parentProcessId,
    waitForParentExit: true,
    acknowledgeDirtyWorktrees:
      receipt.confirmedCommand.acknowledgeDirtyWorktrees,
    helperStateRoot,
    exclusionPath: localDataRemovalExclusionPath(helperStateRoot),
    executionLockPath: localDataRemovalExecutionLockPath(helperStateRoot),
    ownedRoots: rootsForDigest(plan.privatePlan.ownedRoots),
    stageRoot: exactDirectChild(stagingParent, receipt.operationId),
    receiptPath: exactDirectChild(
      helperReceiptsParent,
      `${receipt.operationId}.json`,
    ),
    targets: plan.privatePlan.filesystemTargets.map((target) =>
      target.category === "managed_worktree"
        ? {
          id: target.id,
          category: target.category,
          path: target.path,
          kind: target.kind,
          dirty: target.dirty ?? false,
          registration: target.registration,
        }
        : {
          id: target.id,
          category: target.category,
          path: target.path,
          kind: target.kind,
        }
    ),
    preservedUserRepositories: plan.privatePlan.userRepositories,
  });
  return signLocalDataRemovalHelperPayload(payload, signingKey);
}

function assertLocalDataRemovalHelperRequestSize(
  request: SignedLocalDataRemovalHelperRequest,
): void {
  if (
    !isLocalDataRemovalHelperRequestByteLengthAllowed(
      Buffer.byteLength(JSON.stringify(request), "utf8") + 1,
    )
  ) {
    throw new LocalDataRemovalConfirmationError(
      "blocked",
      "The native helper request exceeds its fixed byte limit.",
    );
  }
}

const helperTargetProgressSchema = z
  .object({
    id: targetIdSchema,
    state: z.enum([
      "pending",
      "staged",
      "administration_staged",
      "removed",
    ]),
  })
  .strict();
const helperReceiptSchema = z
  .object({
    version: z.literal(1),
    operationId: operationIdSchema,
    requestDigest: sha256DigestSchema,
    state: z.enum(["running", "completed"]),
    targets: z.array(helperTargetProgressSchema).max(maximumTargets),
  })
  .strict();
type HelperRemovalReceipt = z.infer<typeof helperReceiptSchema>;

export interface ExecuteLocalDataRemovalOptions {
  readonly request: unknown;
  readonly signingKey: Uint8Array;
  readonly ownedRoots: LocalDataRemovalOwnedRoots;
  readonly gitInspector?: LocalDataRemovalGitInspector;
  readonly now?: Date;
  readonly faultInjector?: (
    checkpoint: LocalDataRemovalFaultCheckpoint,
    targetId: string | null,
  ) => void;
}

/**
 * Reference implementation of the native helper state machine. Production
 * packaging launches the Zig helper; this implementation keeps gateway tests
 * deterministic and documents the same crash/retry contract.
 */
export async function executeLocalDataRemovalFilesystemRequest(
  options: ExecuteLocalDataRemovalOptions,
): Promise<{ readonly state: "completed"; readonly alreadyCompleted: boolean }> {
  const signingKey = requireSigningKey(options.signingKey);
  const request = verifyLocalDataRemovalHelperRequest(
    options.request,
    signingKey,
  );
  const ownedRoots = await canonicalizeOwnedRoots(
    options.ownedRoots,
    { allowMissing: true },
  );
  await validateHelperPayload(request.payload, ownedRoots);
  const helperCleanupRoot = helperCleanupPath(
    request.payload.helperStateRoot,
    request.payload.operationId,
  );
  for (const deletionRoot of allDeletionRoots(ownedRoots)) {
    if (pathsOverlap(deletionRoot, helperCleanupRoot)) {
      throw new UnsafeLocalDataRemovalTargetError(
        helperCleanupRoot,
        "staged helper state overlaps a deletion root",
      );
    }
  }
  const helperStateMetadata = await metadata(
    request.payload.helperStateRoot,
  );
  const helperCleanupMetadata = await metadata(helperCleanupRoot);
  if (helperStateMetadata !== null && helperCleanupMetadata !== null) {
    throw new LocalDataRemovalConfirmationError(
      "operation_conflict",
      "Both live and staged helper state exist.",
    );
  }
  if (helperStateMetadata === null) {
    if (helperCleanupMetadata === null) {
      await assertEverySignedTargetAbsent(request.payload.targets);
      await removeLocalDataRemovalExclusion(
        request.payload.helperStateRoot,
      );
      return { state: "completed", alreadyCompleted: true };
    }
    await requireCanonicalDirectory(request.payload.exclusionPath);
    if (
      helperCleanupMetadata.isSymbolicLink() ||
      !helperCleanupMetadata.isDirectory() ||
      await realpath(helperCleanupRoot) !== helperCleanupRoot
    ) {
      throw new UnsafeLocalDataRemovalTargetError(
        helperCleanupRoot,
        "staged helper state is not a canonical directory",
      );
    }
    const relocatedReceiptPath = relocatedHelperPath(
      request.payload.helperStateRoot,
      helperCleanupRoot,
      request.payload.receiptPath,
    );
    const stagedReceipt = await readHelperReceipt(relocatedReceiptPath);
    if (
      stagedReceipt === null ||
      stagedReceipt.state !== "completed" ||
      stagedReceipt.requestDigest !== sha256(request)
    ) {
      throw new LocalDataRemovalConfirmationError(
        "operation_conflict",
        "Staged helper state has no matching completed receipt.",
      );
    }
    await assertEverySignedTargetAbsent(request.payload.targets);
    options.faultInjector?.("before_helper_state_cleanup", null);
    await assertSingleDeviceRemovalTree(helperCleanupRoot);
    await rm(helperCleanupRoot, {
      recursive: true,
      force: false,
      maxRetries: 0,
    });
    await syncDirectory(dirname(helperCleanupRoot));
    options.faultInjector?.(
      "after_helper_state_cleanup_before_exclusion",
      null,
    );
    await removeLocalDataRemovalExclusion(request.payload.helperStateRoot);
    options.faultInjector?.("after_helper_state_cleanup", null);
    return { state: "completed", alreadyCompleted: false };
  }
  await requireCanonicalDirectory(request.payload.exclusionPath);
  await ensurePrivateExecutionLockFile(
    request.payload.executionLockPath,
    request.payload.helperStateRoot,
  );
  await ensurePrivateDirectChildDirectory(
    request.payload.helperStateRoot,
    "helper-receipts",
  );
  const stagingParent = await ensurePrivateDirectChildDirectory(
    request.payload.helperStateRoot,
    "staging",
  );
  const stageRoot = await ensurePrivateDirectChildDirectory(
    stagingParent,
    request.payload.operationId,
  );
  if (stageRoot !== request.payload.stageRoot) {
    throw new UnsafeLocalDataRemovalTargetError(
      request.payload.stageRoot,
      "stage root changed after validation",
    );
  }

  const requestDigest = sha256(request);
  let receipt = await readHelperReceipt(request.payload.receiptPath);
  if (receipt === null) {
    if ((options.now ?? new Date()).getTime() > request.payload.expiresAt) {
      throw new LocalDataRemovalConfirmationError(
        "expired_preview",
        "The signed native helper request expired before its first execution.",
      );
    }
    receipt = helperReceiptSchema.parse({
      version: 1,
      operationId: request.payload.operationId,
      requestDigest,
      state: "running",
      targets: request.payload.targets.map(({ id }) => ({
        id,
        state: "pending",
      })),
    });
    await atomicWritePrivateJson(request.payload.receiptPath, receipt);
    options.faultInjector?.("after_helper_receipt_initialized", null);
  } else if (
    receipt.targets.map(({ id }) => id).join("\u0000") !==
      request.payload.targets.map(({ id }) => id).join("\u0000")
  ) {
    throw new LocalDataRemovalConfirmationError(
      "operation_conflict",
      "The helper target receipt does not match the signed request.",
    );
  } else if (receipt.requestDigest !== requestDigest) {
    receipt = helperReceiptSchema.parse({
      ...receipt,
      requestDigest,
    });
    await atomicWritePrivateJson(request.payload.receiptPath, receipt);
  }

  for (let index = 0; index < request.payload.targets.length; index += 1) {
    const target = request.payload.targets[index];
    const progress = receipt.targets[index];
    if (target === undefined || progress === undefined) {
      throw new Error("Helper target receipt is incomplete.");
    }
    const stagedPath = exactDirectChild(stageRoot, target.id);
    if (progress.state === "pending") {
      options.faultInjector?.("before_target_stage", target.id);
      const sourceMetadata = await metadata(target.path);
      const stagedMetadata = await metadata(stagedPath);
      if (sourceMetadata !== null && stagedMetadata !== null) {
        throw new LocalDataRemovalConfirmationError(
          "operation_conflict",
          "Both source and staged copies exist for a removal target.",
        );
      }
      if (sourceMetadata !== null) {
        assertTargetKind(target, sourceMetadata);
        await assertSingleDeviceRemovalTree(target.path);
        if (target.category === "managed_worktree") {
          const dirty = await (
            options.gitInspector?.isDirty(target.path) ??
              Promise.resolve(target.dirty)
          );
          if (dirty && !request.payload.acknowledgeDirtyWorktrees) {
            throw new LocalDataRemovalConfirmationError(
              "dirty_worktree_acknowledgement_required",
              "A managed worktree became dirty after confirmation.",
            );
          }
          await validateManagedWorktreeRegistration(
            target,
            target.path,
            false,
          );
        }
        await rename(target.path, stagedPath);
        options.faultInjector?.("after_target_stage", target.id);
      }
      receipt = updateHelperTargetState(receipt, index, "staged");
      await atomicWritePrivateJson(request.payload.receiptPath, receipt);
      options.faultInjector?.("after_target_stage_receipt", target.id);
    }

    const current = receipt.targets[index];
    if (current?.state === "staged") {
      const sourceMetadata = await metadata(target.path);
      if (sourceMetadata !== null) {
        throw new LocalDataRemovalConfirmationError(
          "operation_conflict",
          "A removal target reappeared after it was staged.",
        );
      }
      if (target.category === "managed_worktree") {
        await validateManagedWorktreeRegistration(
          target,
          stagedPath,
          true,
        );
        if (await metadata(target.registration.administrativeDirectory) !== null) {
          await assertSingleDeviceRemovalTree(
            target.registration.administrativeDirectory,
          );
          await rm(target.registration.administrativeDirectory, {
            recursive: true,
            force: false,
            maxRetries: 0,
          });
          await syncDirectory(
            dirname(target.registration.administrativeDirectory),
          );
          options.faultInjector?.(
            "after_worktree_registration_remove",
            target.id,
          );
        }
      }
      if (await metadata(stagedPath) !== null) {
        await assertSingleDeviceRemovalTree(stagedPath);
        await rm(stagedPath, { recursive: true, force: false, maxRetries: 0 });
        options.faultInjector?.("after_target_remove", target.id);
      }
      receipt = updateHelperTargetState(receipt, index, "removed");
      await atomicWritePrivateJson(request.payload.receiptPath, receipt);
      options.faultInjector?.("after_target_remove_receipt", target.id);
    }
  }

  receipt = helperReceiptSchema.parse({ ...receipt, state: "completed" });
  await atomicWritePrivateJson(request.payload.receiptPath, receipt);
  options.faultInjector?.("after_helper_completion", null);
  options.faultInjector?.("before_helper_state_cleanup", null);
  await assertSingleDeviceRemovalTree(request.payload.helperStateRoot);
  await rename(request.payload.helperStateRoot, helperCleanupRoot);
  await syncDirectory(dirname(helperCleanupRoot));
  options.faultInjector?.("after_helper_state_staged", null);
  await rm(helperCleanupRoot, {
    recursive: true,
    force: false,
    maxRetries: 0,
  });
  await syncDirectory(dirname(helperCleanupRoot));
  options.faultInjector?.(
    "after_helper_state_cleanup_before_exclusion",
    null,
  );
  await removeLocalDataRemovalExclusion(request.payload.helperStateRoot);
  options.faultInjector?.("after_helper_state_cleanup", null);
  return { state: "completed", alreadyCompleted: false };
}

export interface RecoverStagedLocalDataRemovalHelperStateOptions {
  /**
   * The fixed app-owned helper-state root. Recovery scans only deterministic
   * sibling tombstones for this exact root.
   */
  readonly helperStateRoot: string;
  readonly executionLock: LocalDataRemovalExecutionLockProbe;
}

export interface LocalDataRemovalExecutionLockProbe {
  isLocked(lockPath: string): Promise<boolean>;
}

export interface RecoveredStagedLocalDataRemovalHelperState {
  readonly state: "completed";
  readonly recoveredOperationIds: readonly string[];
}

/**
 * Startup-only finalization for a helper that crashed after atomically
 * renaming its private state root. It never reads or acts on a removal target:
 * only exact, completed helper-state tombstones are eligible.
 */
export async function recoverStagedLocalDataRemovalHelperState(
  options: RecoverStagedLocalDataRemovalHelperStateOptions,
): Promise<RecoveredStagedLocalDataRemovalHelperState> {
  const helperStateRoot = await requireCanonicalOrExpectedDirectory(
    options.helperStateRoot,
  );
  const parent = await requireCanonicalDirectory(dirname(helperStateRoot));
  const prefix = `.${basename(helperStateRoot)}.removing-`;
  const recoveredOperationIds: string[] = [];
  const entries = await readdir(parent, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.name.startsWith(prefix)) continue;
    const operationIdResult = operationIdSchema.safeParse(
      entry.name.slice(prefix.length),
    );
    if (!operationIdResult.success) continue;
    const operationId = operationIdResult.data;
    const tombstone = exactDirectChild(parent, entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new UnsafeLocalDataRemovalTargetError(
        tombstone,
        "staged helper state is not a no-follow directory",
      );
    }
    const relocatedLockPath = relocatedHelperPath(
      helperStateRoot,
      tombstone,
      localDataRemovalExecutionLockPath(helperStateRoot),
    );
    if (await options.executionLock.isLocked(relocatedLockPath)) {
      throw new LocalDataRemovalConfirmationError(
        "operation_conflict",
        "The local-data removal helper is still active.",
      );
    }
    await assertPrivateHelperStateTree(tombstone);
    await assertSingleDeviceRemovalTree(tombstone);
    const receiptPath = exactDirectChild(
      exactDirectChild(tombstone, "helper-receipts"),
      `${operationId}.json`,
    );
    const receipt = await readHelperReceipt(receiptPath);
    if (
      receipt === null ||
      receipt.operationId !== operationId ||
      receipt.state !== "completed"
    ) {
      throw new LocalDataRemovalConfirmationError(
        "operation_conflict",
        "Staged helper state has no matching completed receipt.",
      );
    }
    await rm(tombstone, { recursive: true, force: false, maxRetries: 0 });
    await syncDirectory(parent);
    recoveredOperationIds.push(operationId);
  }

  if (await metadata(helperStateRoot) === null) {
    await removeLocalDataRemovalExclusion(helperStateRoot);
  }
  recoveredOperationIds.sort();
  return { state: "completed", recoveredOperationIds };
}

export interface InspectLocalDataRemovalStartupOptions {
  readonly helperStateRoot: string;
  readonly executionLock: LocalDataRemovalExecutionLockProbe;
}

export type LocalDataRemovalStartupStatus = Readonly<{
  state: "clear" | "active" | "recovery_required";
  pendingOperations: number;
}>;

export async function inspectLocalDataRemovalStartup(
  options: InspectLocalDataRemovalStartupOptions,
): Promise<LocalDataRemovalStartupStatus> {
  const helperStateRoot = absoluteNormalizedPath(options.helperStateRoot);
  const parent = await requireCanonicalAnchorDirectory(
    dirname(helperStateRoot),
  );
  const prefix = `.${basename(helperStateRoot)}.removing-`;
  const tombstones = (await readdir(parent, { withFileTypes: true }))
    .filter((entry) =>
      entry.name.startsWith(prefix) &&
      operationIdSchema.safeParse(entry.name.slice(prefix.length)).success
    )
    .map((entry) => exactDirectChild(parent, entry.name));
  const lockCandidates: string[] = [];
  if (await metadata(helperStateRoot) !== null) {
    lockCandidates.push(localDataRemovalExecutionLockPath(helperStateRoot));
  }
  for (const tombstone of tombstones) {
    lockCandidates.push(relocatedHelperPath(
      helperStateRoot,
      tombstone,
      localDataRemovalExecutionLockPath(helperStateRoot),
    ));
  }
  for (const lockPath of lockCandidates) {
    if (
      await metadata(lockPath) !== null &&
      await options.executionLock.isLocked(lockPath)
    ) {
      return {
        state: "active",
        pendingOperations: Math.max(1, tombstones.length),
      };
    }
  }

  let gatewayReceiptCount = 0;
  const gatewayReceiptsRoot = join(helperStateRoot, "gateway-receipts");
  const receiptRootMetadata = await metadata(gatewayReceiptsRoot);
  if (receiptRootMetadata !== null) {
    if (
      receiptRootMetadata.isSymbolicLink() ||
      !receiptRootMetadata.isDirectory()
    ) {
      throw new UnsafeLocalDataRemovalTargetError(
        gatewayReceiptsRoot,
        "gateway receipt root is unsafe during startup preflight",
      );
    }
    const receiptEntries = await readdir(gatewayReceiptsRoot, {
      withFileTypes: true,
    });
    gatewayReceiptCount = receiptEntries.filter((entry) =>
      entry.isFile() &&
      operationIdSchema.safeParse(
        entry.name.endsWith(".json")
          ? entry.name.slice(0, -".json".length)
          : "",
      ).success
    ).length;
  }
  const exclusionExists = await metadata(
    localDataRemovalExclusionPath(helperStateRoot),
  ) !== null;
  const pendingOperations = Math.max(
    gatewayReceiptCount,
    tombstones.length,
    exclusionExists ? 1 : 0,
  );
  return {
    state: pendingOperations === 0 ? "clear" : "recovery_required",
    pendingOperations,
  };
}

export function isPathWithinExactOwnedRoot(
  ownedRoot: string,
  candidate: string,
): boolean {
  if (!isAbsolute(ownedRoot) || !isAbsolute(candidate)) return false;
  const normalizedRoot = resolve(ownedRoot);
  const normalizedCandidate = resolve(candidate);
  if (normalizedRoot !== ownedRoot || normalizedCandidate !== candidate) {
    return false;
  }
  const suffix = relative(normalizedRoot, normalizedCandidate);
  return suffix === "" || (
    suffix !== ".." &&
    !suffix.startsWith(`..${sep}`) &&
    !isAbsolute(suffix)
  );
}

async function canonicalizeOwnedRoots(
  input: LocalDataRemovalOwnedRoots,
  options: { readonly allowMissing?: boolean } = {},
): Promise<CanonicalOwnedRoots> {
  const parsed = localDataRemovalOwnedRootsSchema.parse(input);
  const canonicalizeList = async (
    values: readonly string[],
    directoriesOnly: boolean,
  ): Promise<readonly string[]> => {
    const canonical = await Promise.all(values.map((path) =>
      directoriesOnly
        ? options.allowMissing === true
          ? requireCanonicalOrExpectedDirectory(path)
          : requireCanonicalDirectory(path)
        : requireCanonicalOrExpectedOwnedPath(
          path,
          options.allowMissing === true,
        )
    ));
    if (new Set(canonical).size !== canonical.length) {
      throw new UnsafeLocalDataRemovalTargetError(
        null,
        "owned roots contain duplicates",
      );
    }
    return canonical.slice().sort();
  };
  const roots: CanonicalOwnedRoots = {
    controlPlane: await canonicalizeList(parsed.controlPlane, false),
    [predecessorCodexProfileDataField]: await canonicalizeList(
      parsed[predecessorCodexProfileDataField],
      false,
    ),
    releaseUpdateArtifacts: await canonicalizeList(
      parsed.releaseUpdateArtifacts,
      false,
    ),
    applicationState: await canonicalizeList(
      parsed.applicationState,
      false,
    ),
    managedWorktrees: await canonicalizeList(parsed.managedWorktrees, true),
    helperStateRoot: options.allowMissing === true
      ? await requireCanonicalOrExpectedDirectory(parsed.helperStateRoot)
      : await requireCanonicalDirectory(parsed.helperStateRoot),
  };
  for (const ownedRoot of allDeletionRoots(roots)) {
    if (
      pathsOverlap(ownedRoot, roots.helperStateRoot) ||
      pathsOverlap(
        ownedRoot,
        localDataRemovalExclusionPath(roots.helperStateRoot),
      )
    ) {
      throw new UnsafeLocalDataRemovalTargetError(
        roots.helperStateRoot,
        "helper state or its exclusion overlaps a deletion root",
      );
    }
  }
  return roots;
}

async function canonicalizeInventory(
  inventory: z.output<typeof localDataRemovalInventorySchema>,
  roots: CanonicalOwnedRoots,
): Promise<CanonicalLocalDataRemovalPlan> {
  const helperStateMetadata = await metadata(roots.helperStateRoot);
  if (
    helperStateMetadata === null ||
    helperStateMetadata.isSymbolicLink() ||
    !helperStateMetadata.isDirectory()
  ) {
    throw new UnsafeLocalDataRemovalTargetError(
      roots.helperStateRoot,
      "helper state is unavailable for staging preflight",
    );
  }
  const filesystemTargets = await Promise.all(
    inventory.filesystemTargets.map(async (target) => {
      const canonical = await requireCanonicalOrExpectedTarget(
        target.path,
        target.kind,
      );
      const allowedRoots = rootsForCategory(roots, target.category);
      if (!allowedRoots.some((root) => isPathWithinExactOwnedRoot(root, canonical))) {
        throw new UnsafeLocalDataRemovalTargetError(
          canonical,
          "target is outside its category allowlist",
        );
      }
      if (
        target.category === "managed_worktree" &&
        !allowedRoots.some((root) => isDirectChild(root, canonical))
      ) {
        throw new UnsafeLocalDataRemovalTargetError(
          canonical,
          "managed worktree is not a direct child of its owned root",
        );
      }
      if (
        await expectedPathDevice(canonical) !== helperStateMetadata.dev
      ) {
        throw new UnsafeLocalDataRemovalTargetError(
          canonical,
          "target cannot be atomically staged on the helper-state device",
        );
      }
      if (await metadata(canonical) !== null) {
        await assertSingleDeviceRemovalTree(canonical);
      }
      return {
        id: targetId(target.category, canonical),
        category: target.category,
        path: canonical,
        kind: target.kind,
        ...(target.category === "managed_worktree"
          ? {
            dirty: target.dirty,
            registration: await canonicalizeManagedWorktreeRegistration(
              target.registration,
              canonical,
              inventory.userRepositories,
            ),
          }
          : {}),
      } satisfies CanonicalFilesystemTarget;
    }),
  );
  filesystemTargets.sort(compareTarget);
  rejectDuplicateOrOverlappingTargets(filesystemTargets);
  rejectDuplicateOrOverlappingTargets(
    filesystemTargets.flatMap((target) =>
      target.category === "managed_worktree" &&
        target.registration !== undefined
        ? [{ path: target.registration.administrativeDirectory }]
        : []
    ),
  );

  const userRepositories = await Promise.all(
    inventory.userRepositories.map((path) =>
      requireCanonicalOrExpectedOwnedDirectory(path)
    ),
  );
  userRepositories.sort();
  if (new Set(userRepositories).size !== userRepositories.length) {
    throw new UnsafeLocalDataRemovalTargetError(
      null,
      "user repository list contains duplicates",
    );
  }
  for (const repository of userRepositories) {
    for (const target of filesystemTargets) {
      if (pathsOverlap(repository, target.path)) {
        throw new UnsafeLocalDataRemovalTargetError(
          target.path,
          "target overlaps a preserved user repository",
        );
      }
    }
  }

  const keychainTargets = inventory.keychainTargets.slice().sort(
    (left, right) =>
      `${left.service}\u0000${left.name}`.localeCompare(
        `${right.service}\u0000${right.name}`,
      ),
  );
  const keychainKeys = keychainTargets.map(
    ({ service, name }) => `${service}\u0000${name}`,
  );
  if (new Set(keychainKeys).size !== keychainKeys.length) {
    throw new UnsafeLocalDataRemovalTargetError(
      null,
      "Keychain target list contains duplicates",
    );
  }

  const inventoryDigest = sha256({
    version: 1,
    roots: rootsForDigest(roots),
    filesystemTargets,
    keychainTargets,
    preservedCredentialEvidenceRecords:
      inventory.preservedCredentialEvidenceRecords,
    userRepositories,
  });
  return {
    inventoryDigest,
    ownedRoots: roots,
    filesystemTargets,
    keychainTargets,
    preservedCredentialEvidenceRecords:
      inventory.preservedCredentialEvidenceRecords,
    userRepositories,
  };
}

async function validateHelperPayload(
  payload: LocalDataRemovalHelperPayload,
  roots: CanonicalOwnedRoots,
): Promise<void> {
  if (payload.allowlistDigest !== allowlistDigest(roots)) {
    throw new UnsafeLocalDataRemovalTargetError(
      null,
      "signed allowlist digest does not match native-owned roots",
    );
  }
  if (
    canonicalJson(payload.ownedRoots) !== canonicalJson(rootsForDigest(roots))
  ) {
    throw new UnsafeLocalDataRemovalTargetError(
      null,
      "signed owned roots do not match native-owned roots",
    );
  }
  if (payload.helperStateRoot !== roots.helperStateRoot) {
    throw new UnsafeLocalDataRemovalTargetError(
      payload.helperStateRoot,
      "helper state root does not match native-owned state",
    );
  }
  if (
    payload.exclusionPath !==
      localDataRemovalExclusionPath(roots.helperStateRoot) ||
    payload.executionLockPath !==
      localDataRemovalExecutionLockPath(roots.helperStateRoot)
  ) {
    throw new UnsafeLocalDataRemovalTargetError(
      null,
      "helper exclusion or execution-lock path is not fixed",
    );
  }
  const expectedStageRoot = exactDirectChild(
    exactDirectChild(roots.helperStateRoot, "staging"),
    payload.operationId,
  );
  const expectedReceiptPath = exactDirectChild(
    exactDirectChild(roots.helperStateRoot, "helper-receipts"),
    `${payload.operationId}.json`,
  );
  if (
    payload.stageRoot !== expectedStageRoot ||
    payload.receiptPath !== expectedReceiptPath
  ) {
    throw new UnsafeLocalDataRemovalTargetError(
      null,
      "helper operation paths are not exact owned children",
    );
  }
  const repositories = await Promise.all(
    payload.preservedUserRepositories.map((path) =>
      requireCanonicalOrExpectedOwnedDirectory(path)
    ),
  );
  const administrativeTargets: Array<{ readonly path: string }> = [];
  for (const target of payload.targets) {
    rejectBroadPath(target.path);
    const allowedRoots = rootsForCategory(roots, target.category);
    if (!allowedRoots.some((root) => isPathWithinExactOwnedRoot(root, target.path))) {
      throw new UnsafeLocalDataRemovalTargetError(
        target.path,
        "helper target is outside its native category allowlist",
      );
    }
    if (
      target.category === "managed_worktree" &&
      !allowedRoots.some((root) => isDirectChild(root, target.path))
    ) {
      throw new UnsafeLocalDataRemovalTargetError(
        target.path,
        "helper managed-worktree target is not an exact owned child",
      );
    }
    if (target.category === "managed_worktree") {
      const registration = target.registration;
      if (!repositories.includes(registration.repositoryPath)) {
        throw new UnsafeLocalDataRemovalTargetError(
          registration.repositoryPath,
          "helper worktree registration is not in the preserved repository set",
        );
      }
      const administrativeParent = join(
        registration.gitCommonDirectory,
        "worktrees",
      );
      if (
        !isDirectChild(
          administrativeParent,
          registration.administrativeDirectory,
        )
      ) {
        throw new UnsafeLocalDataRemovalTargetError(
          registration.administrativeDirectory,
          "helper worktree administration is not one exact registered child",
        );
      }
      administrativeTargets.push({
        path: registration.administrativeDirectory,
      });
    }
    const sourceMetadata = await metadata(target.path);
    if (sourceMetadata !== null) {
      if (sourceMetadata.isSymbolicLink()) {
        throw new UnsafeLocalDataRemovalTargetError(
          target.path,
          "helper target is a symbolic link",
        );
      }
      const canonical = await realpath(target.path);
      if (canonical !== target.path) {
        throw new UnsafeLocalDataRemovalTargetError(
          target.path,
          "helper target is not canonical",
        );
      }
      assertTargetKind(target, sourceMetadata);
    }
    for (const repository of repositories) {
      if (pathsOverlap(target.path, repository)) {
        throw new UnsafeLocalDataRemovalTargetError(
          target.path,
          "helper target overlaps a preserved user repository",
        );
      }
    }
  }
  rejectDuplicateOrOverlappingTargets(payload.targets);
  rejectDuplicateOrOverlappingTargets(administrativeTargets);
}

function assertConfirmedPlan(
  plan: PreparedLocalDataRemovalPlan,
  command: Extract<
    RuntimeLocalDataRemovalCommand,
    { readonly type: "maintenance.localDataRemoval.remove" }
  >,
  signingKey: Uint8Array,
  now: Date,
): void {
  if (
    command.confirmation !== runtimeLocalDataRemovalConfirmation ||
    command.previewId !== plan.preview.previewId
  ) {
    throw new LocalDataRemovalConfirmationError(
      "invalid_confirmation",
      "The removal confirmation does not match its preview.",
    );
  }
  const expectedToken = `confirm_${createHmac("sha256", signingKey)
    .update(canonicalJson({
      version: 1,
      previewId: plan.preview.previewId,
      inventoryDigest: plan.privatePlan.inventoryDigest,
      expiresAt: plan.preview.expiresAt,
    }))
    .digest("base64url")}`;
  if (!safeStringEqual(expectedToken, command.confirmationToken)) {
    throw new LocalDataRemovalConfirmationError(
      "invalid_confirmation",
      "The removal confirmation token is invalid.",
    );
  }
  if (now.getTime() > Date.parse(plan.preview.expiresAt)) {
    throw new LocalDataRemovalConfirmationError(
      "expired_preview",
      "The local-data removal preview has expired.",
    );
  }
  if (!plan.preview.canRemove) {
    throw new LocalDataRemovalConfirmationError(
      "blocked",
      "Local-data removal is blocked by the current preview.",
    );
  }
  if (
    plan.preview.dirtyWorktreeAcknowledgementRequired &&
    !command.acknowledgeDirtyWorktrees
  ) {
    throw new LocalDataRemovalConfirmationError(
      "dirty_worktree_acknowledgement_required",
      "Dirty managed worktrees require an explicit acknowledgement.",
    );
  }
}

function assertMaintenanceFenceHeld(
  fence: LocalDataRemovalMaintenanceFence,
): void {
  if (!fence.isHeld()) {
    throw new LocalDataRemovalConfirmationError(
      "maintenance_fence_not_held",
      "HRA writers must remain quiesced until the application exits.",
    );
  }
}

function helperLaunch(
  requestPath: string,
  signingKeyPath: string,
  signedRequest: SignedLocalDataRemovalHelperRequest,
): LocalDataRemovalHelperLaunch {
  return {
    executable: {
      relativeToSignedBundleResources: packagedLocalDataRemoverRelativePath,
      packagedBundlePath: packagedLocalDataRemoverBundlePath,
      requireSignedBundleResource: true,
      permitPathOrEnvironmentOverrideInPackagedBuild: false,
    },
    spawnBeforeApplicationQuit: true,
    quitApplicationAfterSuccessfulLaunch: true,
    waitForParentExit: true,
    parentProcessId: signedRequest.payload.parentProcessId,
    requestPath,
    signingKeyPath,
    signedRequest,
  };
}

function helperCleanupPath(
  helperStateRoot: string,
  operationId: string,
): string {
  return exactDirectChild(
    dirname(helperStateRoot),
    `.${basename(helperStateRoot)}.removing-${operationId}`,
  );
}

export function localDataRemovalExclusionPath(
  helperStateRoot: string,
): string {
  return exactDirectChild(
    dirname(helperStateRoot),
    `.${basename(helperStateRoot)}.removal-in-progress`,
  );
}

export function localDataRemovalExecutionLockPath(
  helperStateRoot: string,
): string {
  return exactDirectChild(helperStateRoot, "execution.lock");
}

function relocatedHelperPath(
  sourceRoot: string,
  destinationRoot: string,
  sourcePath: string,
): string {
  const suffix = relative(sourceRoot, sourcePath);
  if (
    suffix.length === 0 ||
    suffix === ".." ||
    suffix.startsWith(`..${sep}`) ||
    isAbsolute(suffix)
  ) {
    throw new UnsafeLocalDataRemovalTargetError(
      sourcePath,
      "helper path cannot be relocated safely",
    );
  }
  const relocated = join(destinationRoot, suffix);
  if (!isPathWithinExactOwnedRoot(destinationRoot, relocated)) {
    throw new UnsafeLocalDataRemovalTargetError(
      relocated,
      "relocated helper path escaped staged state",
    );
  }
  return relocated;
}

async function assertEverySignedTargetAbsent(
  targets: readonly {
    readonly path: string;
    readonly category?: LocalDataRemovalFilesystemCategory;
    readonly registration?: LocalDataRemovalManagedWorktreeRegistration;
  }[],
): Promise<void> {
  for (const target of targets) {
    if (await metadata(target.path) !== null) {
      throw new LocalDataRemovalConfirmationError(
        "operation_conflict",
        "A signed removal target exists after helper completion.",
      );
    }
    if (
      target.category === "managed_worktree" &&
      target.registration !== undefined &&
      await metadata(target.registration.administrativeDirectory) !== null
    ) {
      throw new LocalDataRemovalConfirmationError(
        "operation_conflict",
        "A signed Git worktree registration exists after helper completion.",
      );
    }
  }
}

function updateHelperTargetState(
  receipt: HelperRemovalReceipt,
  index: number,
  state: "staged" | "removed",
): HelperRemovalReceipt {
  return helperReceiptSchema.parse({
    ...receipt,
    targets: receipt.targets.map((target, targetIndex) =>
      targetIndex === index ? { ...target, state } : target
    ),
  });
}

async function readHelperReceipt(
  path: string,
): Promise<HelperRemovalReceipt | null> {
  const source = await readFile(path, "utf8").catch((error: unknown) => {
    if (isFileSystemError(error, "ENOENT")) return null;
    throw error;
  });
  return source === null
    ? null
    : helperReceiptSchema.parse(parseJson(source, "native helper receipt"));
}

async function assertPrivateHelperStateTree(rootValue: string): Promise<void> {
  const root = await requireCanonicalDirectory(rootValue);
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const child = exactDirectChild(root, entry.name);
    const value = await metadata(child);
    if (value === null || value.isSymbolicLink()) {
      throw new UnsafeLocalDataRemovalTargetError(
        child,
        "staged helper state contains a symbolic link or vanished entry",
      );
    }
    if (await realpath(child) !== child) {
      throw new UnsafeLocalDataRemovalTargetError(
        child,
        "staged helper state contains a non-canonical entry",
      );
    }
    if (value.isDirectory()) {
      await assertPrivateHelperStateTree(child);
    } else if (!value.isFile()) {
      throw new UnsafeLocalDataRemovalTargetError(
        child,
        "staged helper state contains a special filesystem entry",
      );
    }
  }
}

async function canonicalizeManagedWorktreeRegistration(
  value: LocalDataRemovalManagedWorktreeRegistration,
  worktreePath: string,
  preservedRepositories: readonly string[],
): Promise<LocalDataRemovalManagedWorktreeRegistration> {
  const parsed = managedWorktreeRegistrationSchema.parse(value);
  const repositoryPath = await requireCanonicalOrExpectedOwnedDirectory(
    parsed.repositoryPath,
  );
  const repositories = await Promise.all(
    preservedRepositories.map(requireCanonicalOrExpectedOwnedDirectory),
  );
  if (!repositories.includes(repositoryPath)) {
    throw new UnsafeLocalDataRemovalTargetError(
      repositoryPath,
      "managed worktree registration does not name a preserved repository",
    );
  }
  const repositoryMetadata = await metadata(repositoryPath);
  const checkoutMetadata = await metadata(worktreePath);
  const administrationMetadata = await metadata(
    parsed.administrativeDirectory,
  );
  if (
    (checkoutMetadata !== null || administrationMetadata !== null) &&
    repositoryMetadata === null
  ) {
    throw new UnsafeLocalDataRemovalTargetError(
      repositoryPath,
      "managed worktree registration names a missing preserved repository",
    );
  }
  const gitCommonDirectory = await requireCanonicalDirectory(
    parsed.gitCommonDirectory,
  );
  if (repositoryMetadata !== null) {
    const repositoryGitCommonDirectory =
      await resolveRepositoryGitCommonDirectory(repositoryPath);
    if (repositoryGitCommonDirectory !== gitCommonDirectory) {
      throw new UnsafeLocalDataRemovalTargetError(
        gitCommonDirectory,
        "managed worktree Git common directory does not belong to its preserved repository",
      );
    }
  }
  const administrativeParent = await requireCanonicalDirectory(
    join(gitCommonDirectory, "worktrees"),
  );
  const administrativeDirectory = await requireCanonicalOrExpectedOwnedDirectory(
    parsed.administrativeDirectory,
  );
  if (!isDirectChild(administrativeParent, administrativeDirectory)) {
    throw new UnsafeLocalDataRemovalTargetError(
      administrativeDirectory,
      "Git worktree administration is not one exact registered child",
    );
  }
  const registration = {
    repositoryPath,
    gitCommonDirectory,
    administrativeDirectory,
  };
  await validateManagedWorktreeRegistration({
    category: "managed_worktree",
    path: worktreePath,
    registration,
  }, worktreePath, false);
  return registration;
}

async function validateManagedWorktreeRegistration(
  target: {
    readonly category: "managed_worktree";
    readonly path: string;
    readonly registration: LocalDataRemovalManagedWorktreeRegistration;
  },
  checkoutPath: string,
  allowMissingAdministration: boolean,
): Promise<void> {
  const registration = managedWorktreeRegistrationSchema.parse(
    target.registration,
  );
  const administrativeParent = join(
    registration.gitCommonDirectory,
    "worktrees",
  );
  if (
    !isDirectChild(
      administrativeParent,
      registration.administrativeDirectory,
    )
  ) {
    throw new UnsafeLocalDataRemovalTargetError(
      registration.administrativeDirectory,
      "Git worktree administration escaped its exact parent",
    );
  }
  const administrativeMetadata = await metadata(
    registration.administrativeDirectory,
  );
  if (administrativeMetadata === null) {
    const checkoutMetadata = await metadata(checkoutPath);
    if (checkoutMetadata === null || allowMissingAdministration) return;
    await validateManagedCheckoutPointer(
      checkoutPath,
      registration.administrativeDirectory,
    );
    return;
  }
  if (
    administrativeMetadata.isSymbolicLink() ||
    !administrativeMetadata.isDirectory() ||
    await realpath(registration.administrativeDirectory) !==
      registration.administrativeDirectory
  ) {
    throw new UnsafeLocalDataRemovalTargetError(
      registration.administrativeDirectory,
      "Git worktree administration is not a canonical directory",
    );
  }
  const backlink = await readBoundedNoFollowTextFile(
    exactDirectChild(registration.administrativeDirectory, "gitdir"),
  );
  if (backlink.trimEnd() !== join(target.path, ".git")) {
    throw new UnsafeLocalDataRemovalTargetError(
      registration.administrativeDirectory,
      "Git worktree administration has a mismatched checkout backlink",
    );
  }
  const checkoutMetadata = await metadata(checkoutPath);
  if (checkoutMetadata === null) return;
  await validateManagedCheckoutPointer(
    checkoutPath,
    registration.administrativeDirectory,
  );
}

async function validateManagedCheckoutPointer(
  checkoutPath: string,
  administrativeDirectory: string,
): Promise<void> {
  const checkoutMetadata = await metadata(checkoutPath);
  if (
    checkoutMetadata === null ||
    checkoutMetadata.isSymbolicLink() ||
    !checkoutMetadata.isDirectory() ||
    await realpath(checkoutPath) !== checkoutPath
  ) {
    throw new UnsafeLocalDataRemovalTargetError(
      checkoutPath,
      "managed checkout is not a canonical directory",
    );
  }
  const pointer = await readBoundedNoFollowTextFile(
    exactDirectChild(checkoutPath, ".git"),
  );
  if (
    pointer.trimEnd() !==
      `gitdir: ${administrativeDirectory}`
  ) {
    throw new UnsafeLocalDataRemovalTargetError(
      checkoutPath,
      "managed checkout has a mismatched Git administration pointer",
    );
  }
}

async function resolveRepositoryGitCommonDirectory(
  repositoryPath: string,
): Promise<string> {
  await requireCanonicalDirectory(repositoryPath);
  const dotGitPath = exactDirectChild(repositoryPath, ".git");
  const dotGitMetadata = await metadata(dotGitPath);
  if (dotGitMetadata === null) {
    const headPath = exactDirectChild(repositoryPath, "HEAD");
    const headMetadata = await metadata(headPath);
    if (
      headMetadata === null ||
      headMetadata.isSymbolicLink() ||
      !headMetadata.isFile()
    ) {
      throw new UnsafeLocalDataRemovalTargetError(
        repositoryPath,
        "preserved repository has no verifiable Git common directory",
      );
    }
    return repositoryPath;
  }
  if (dotGitMetadata.isDirectory() && !dotGitMetadata.isSymbolicLink()) {
    return await requireCanonicalDirectory(dotGitPath);
  }
  if (dotGitMetadata.isSymbolicLink() || !dotGitMetadata.isFile()) {
    throw new UnsafeLocalDataRemovalTargetError(
      dotGitPath,
      "preserved repository Git pointer is unsafe",
    );
  }
  const pointer = (await readBoundedNoFollowTextFile(dotGitPath)).trimEnd();
  if (!pointer.startsWith("gitdir: ")) {
    throw new UnsafeLocalDataRemovalTargetError(
      dotGitPath,
      "preserved repository Git pointer is malformed",
    );
  }
  const gitDirectoryValue = pointer.slice("gitdir: ".length);
  const gitDirectory = await requireCanonicalDirectory(
    isAbsolute(gitDirectoryValue)
      ? gitDirectoryValue
      : resolve(repositoryPath, gitDirectoryValue),
  );
  const commonDirectoryPointer = exactDirectChild(gitDirectory, "commondir");
  const commonDirectoryMetadata = await metadata(commonDirectoryPointer);
  if (commonDirectoryMetadata === null) return gitDirectory;
  const commonDirectoryValue = (
    await readBoundedNoFollowTextFile(commonDirectoryPointer)
  ).trimEnd();
  if (commonDirectoryValue.length === 0) {
    throw new UnsafeLocalDataRemovalTargetError(
      commonDirectoryPointer,
      "preserved repository common-directory pointer is empty",
    );
  }
  return await requireCanonicalDirectory(
    isAbsolute(commonDirectoryValue)
      ? commonDirectoryValue
      : resolve(gitDirectory, commonDirectoryValue),
  );
}

async function readBoundedNoFollowTextFile(path: string): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const value = await handle.stat();
    if (
      !value.isFile() ||
      value.nlink !== 1 ||
      value.size <= 0 ||
      value.size > 4_096
    ) {
      throw new UnsafeLocalDataRemovalTargetError(
        path,
        "Git pointer is not a bounded singly linked regular file",
      );
    }
    return await handle.readFile("utf8");
  } catch (error: unknown) {
    if (error instanceof UnsafeLocalDataRemovalTargetError) throw error;
    throw new UnsafeLocalDataRemovalTargetError(
      path,
      "Git pointer could not be read without following links",
    );
  } finally {
    await handle?.close();
  }
}

function assertSameKeychainTargets(
  receiptTargets: readonly {
    readonly category:
      | "human_credential_generation"
      | "runner_pairing_secret"
      | "harness_context_heap_key"
      | "session_sync_key_material";
    readonly service: string;
    readonly name: string;
  }[],
  planTargets: readonly LocalDataRemovalKeychainTarget[],
): void {
  const receiptIdentity = receiptTargets.map(
    ({ category, service, name }) => `${category}\u0000${service}\u0000${name}`,
  );
  const planIdentity = planTargets.map(
    ({ category, service, name }) => `${category}\u0000${service}\u0000${name}`,
  );
  if (receiptIdentity.join("\u0001") !== planIdentity.join("\u0001")) {
    throw new LocalDataRemovalConfirmationError(
      "operation_conflict",
      "The Keychain removal receipt does not match the confirmed preview.",
    );
  }
}

function keychainTargetId(target: {
  readonly category: string;
  readonly service: string;
  readonly name: string;
}): string {
  return targetId(
    target.category,
    `${target.service}\u0000${target.name}`,
  );
}

function rootsForCategory(
  roots: CanonicalOwnedRoots,
  category: LocalDataRemovalFilesystemCategory,
): readonly string[] {
  switch (category) {
    case "control_plane":
      return roots.controlPlane;
    case predecessorCodexProfileCategory:
      return roots[predecessorCodexProfileDataField];
    case "release_update_artifact":
      return roots.releaseUpdateArtifacts;
    case "application_state":
      return roots.applicationState;
    case "managed_worktree":
      return roots.managedWorktrees;
  }
}

function allDeletionRoots(roots: CanonicalOwnedRoots): readonly string[] {
  return [
    ...roots.controlPlane,
    ...roots[predecessorCodexProfileDataField],
    ...roots.releaseUpdateArtifacts,
    ...roots.applicationState,
    ...roots.managedWorktrees,
  ];
}

function rootsForDigest(roots: CanonicalOwnedRoots): unknown {
  return {
    controlPlane: roots.controlPlane,
    [predecessorCodexProfileDataField]:
      roots[predecessorCodexProfileDataField],
    releaseUpdateArtifacts: roots.releaseUpdateArtifacts,
    applicationState: roots.applicationState,
    managedWorktrees: roots.managedWorktrees,
    helperStateRoot: roots.helperStateRoot,
  };
}

function allowlistDigest(roots: CanonicalOwnedRoots): string {
  return sha256({ version: 1, roots: rootsForDigest(roots) });
}

async function requireCanonicalDirectory(pathValue: string): Promise<string> {
  return await requireCanonicalTarget(pathValue, "directory");
}

async function requireCanonicalAnchorDirectory(
  pathValue: string,
): Promise<string> {
  const path = absolutePathSchema.parse(pathValue);
  if (resolve(path) !== path) {
    throw new UnsafeLocalDataRemovalTargetError(path, "path is not normalized");
  }
  const value = await metadata(path);
  if (
    value === null ||
    value.isSymbolicLink() ||
    !value.isDirectory() ||
    await realpath(path) !== path
  ) {
    throw new UnsafeLocalDataRemovalTargetError(
      path,
      "anchor is not a canonical no-follow directory",
    );
  }
  return path;
}

async function requireCanonicalOrExpectedDirectory(
  pathValue: string,
): Promise<string> {
  const path = absolutePathSchema.parse(pathValue);
  if (resolve(path) !== path) {
    throw new UnsafeLocalDataRemovalTargetError(path, "path is not normalized");
  }
  rejectBroadPath(path);
  const value = await metadata(path);
  if (value !== null) return await requireCanonicalDirectory(path);
  await validateCanonicalExistingAncestor(path);
  return path;
}

async function requireCanonicalOrExpectedOwnedDirectory(
  pathValue: string,
): Promise<string> {
  const path = absoluteNormalizedPath(pathValue);
  const value = await metadata(path);
  if (value !== null) return await requireCanonicalDirectory(path);
  await validateCanonicalExistingAncestor(path);
  return path;
}

async function requireCanonicalOrExpectedTarget(
  pathValue: string,
  kind: "file" | "directory",
): Promise<string> {
  const path = absoluteNormalizedPath(pathValue);
  const value = await metadata(path);
  if (value !== null) return await requireCanonicalTarget(path, kind);
  await validateCanonicalExistingAncestor(path);
  return path;
}

async function requireCanonicalOrExpectedOwnedPath(
  pathValue: string,
  allowMissing: boolean,
): Promise<string> {
  const path = absolutePathSchema.parse(pathValue);
  if (resolve(path) !== path) {
    throw new UnsafeLocalDataRemovalTargetError(path, "path is not normalized");
  }
  rejectBroadPath(path);
  const value = await metadata(path);
  if (value === null) {
    if (!allowMissing) {
      throw new UnsafeLocalDataRemovalTargetError(path, "path does not exist");
    }
    await validateCanonicalExistingAncestor(path);
    return path;
  }
  if (
    value.isSymbolicLink() ||
    (!value.isFile() && !value.isDirectory())
  ) {
    throw new UnsafeLocalDataRemovalTargetError(
      path,
      "owned path is a link or special filesystem entry",
    );
  }
  if (await realpath(path) !== path) {
    throw new UnsafeLocalDataRemovalTargetError(
      path,
      "owned path is not canonical",
    );
  }
  return path;
}

async function validateCanonicalExistingAncestor(
  pathValue: string,
): Promise<void> {
  let candidate = dirname(pathValue);
  while (true) {
    const value = await metadata(candidate);
    if (value !== null) {
      if (value.isSymbolicLink() || !value.isDirectory()) {
        throw new UnsafeLocalDataRemovalTargetError(
          candidate,
          "expected path has a linked or non-directory ancestor",
        );
      }
      if (await realpath(candidate) !== candidate) {
        throw new UnsafeLocalDataRemovalTargetError(
          candidate,
          "expected path has a non-canonical ancestor",
        );
      }
      return;
    }
    const parent = dirname(candidate);
    if (parent === candidate) {
      throw new UnsafeLocalDataRemovalTargetError(
        pathValue,
        "expected path has no canonical existing ancestor",
      );
    }
    candidate = parent;
  }
}

async function expectedPathDevice(pathValue: string): Promise<number> {
  let candidate = pathValue;
  while (true) {
    const value = await metadata(candidate);
    if (value !== null) {
      if (
        value.isSymbolicLink() ||
        (!value.isFile() && !value.isDirectory())
      ) {
        throw new UnsafeLocalDataRemovalTargetError(
          candidate,
          "staging preflight encountered a link or special entry",
        );
      }
      return value.dev;
    }
    const parent = dirname(candidate);
    if (parent === candidate) {
      throw new UnsafeLocalDataRemovalTargetError(
        pathValue,
        "staging preflight found no existing device anchor",
      );
    }
    candidate = parent;
  }
}

async function assertSingleDeviceRemovalTree(pathValue: string): Promise<void> {
  const root = await metadata(pathValue);
  if (root === null || root.isSymbolicLink()) {
    throw new UnsafeLocalDataRemovalTargetError(
      pathValue,
      "removal tree is missing or linked",
    );
  }
  const parent = await metadata(dirname(pathValue));
  if (
    parent === null ||
    parent.isSymbolicLink() ||
    !parent.isDirectory() ||
    parent.dev !== root.dev
  ) {
    throw new UnsafeLocalDataRemovalTargetError(
      pathValue,
      "removal target is a mount point or has an unsafe parent",
    );
  }
  if (root.isFile()) return;
  if (!root.isDirectory()) {
    throw new UnsafeLocalDataRemovalTargetError(
      pathValue,
      "removal target is a special filesystem entry",
    );
  }
  await assertSingleDeviceDescendants(pathValue, root.dev);
}

async function assertSingleDeviceDescendants(
  directory: string,
  device: number,
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const child = exactDirectChild(directory, entry.name);
    const value = await metadata(child);
    if (value === null || value.dev !== device) {
      throw new UnsafeLocalDataRemovalTargetError(
        child,
        "removal tree crosses a filesystem boundary",
      );
    }
    // A nested symlink is an unlink-only leaf. Production uses
    // fstatat(AT_SYMLINK_NOFOLLOW) and never opens or descends through it.
    if (value.isSymbolicLink()) continue;
    if (value.isDirectory()) {
      await assertSingleDeviceDescendants(child, device);
    } else if (!value.isFile()) {
      throw new UnsafeLocalDataRemovalTargetError(
        child,
        "removal tree contains a special filesystem entry",
      );
    }
  }
}

async function requireCanonicalFileWithin(
  pathValue: string,
  parent: string,
): Promise<string> {
  const canonical = await requireCanonicalTarget(pathValue, "file");
  if (!isPathWithinExactOwnedRoot(parent, canonical) || canonical === parent) {
    throw new UnsafeLocalDataRemovalTargetError(
      canonical,
      "signing key is outside helper state",
    );
  }
  return canonical;
}

async function requireCanonicalTarget(
  pathValue: string,
  kind: "file" | "directory",
): Promise<string> {
  const path = absolutePathSchema.parse(pathValue);
  if (resolve(path) !== path) {
    throw new UnsafeLocalDataRemovalTargetError(path, "path is not normalized");
  }
  rejectBroadPath(path);
  const value = await metadata(path);
  if (value === null) {
    throw new UnsafeLocalDataRemovalTargetError(path, "path does not exist");
  }
  if (value.isSymbolicLink()) {
    throw new UnsafeLocalDataRemovalTargetError(path, "symbolic link");
  }
  if (
    (kind === "file" && !value.isFile()) ||
    (kind === "directory" && !value.isDirectory())
  ) {
    throw new UnsafeLocalDataRemovalTargetError(path, `not a ${kind}`);
  }
  const canonical = await realpath(path);
  if (canonical !== path) {
    throw new UnsafeLocalDataRemovalTargetError(path, "path is not canonical");
  }
  return canonical;
}

function rejectBroadPath(path: string): void {
  const normalized = resolve(path);
  const home = resolve(userInfo().homedir);
  const broad = new Set([
    parse(normalized).root,
    home,
    dirname(home),
    join(home, "Library"),
    join(home, "Library", "Application Support"),
    join(home, "Library", "Caches"),
    "/Users",
    "/private",
    "/private/tmp",
    "/tmp",
  ]);
  if (broad.has(normalized)) {
    throw new UnsafeLocalDataRemovalTargetError(path, "broad root");
  }
}

async function ensurePrivateDirectChildDirectory(
  parentValue: string,
  name: string,
): Promise<string> {
  if (
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\u0000")
  ) {
    throw new UnsafeLocalDataRemovalTargetError(
      null,
      "invalid owned directory name",
    );
  }
  const parent = await requireCanonicalDirectory(parentValue);
  const child = exactDirectChild(parent, name);
  await mkdir(child, { mode: privateDirectoryMode }).catch((error: unknown) => {
    if (!isFileSystemError(error, "EEXIST")) throw error;
  });
  return await requireCanonicalDirectory(child);
}

async function ensureLocalDataRemovalExclusion(
  helperStateRoot: string,
): Promise<string> {
  await requireCanonicalDirectory(helperStateRoot);
  const exclusion = localDataRemovalExclusionPath(helperStateRoot);
  await mkdir(exclusion, { mode: privateDirectoryMode }).catch(
    (error: unknown) => {
      if (!isFileSystemError(error, "EEXIST")) throw error;
    },
  );
  const canonical = await requireCanonicalDirectory(exclusion);
  await chmod(canonical, privateDirectoryMode);
  await syncDirectory(canonical);
  await syncDirectory(dirname(canonical));
  return canonical;
}

async function ensurePrivateExecutionLockFile(
  lockPathValue: string,
  helperStateRoot: string,
): Promise<void> {
  const lockPath = exactDirectChild(helperStateRoot, "execution.lock");
  if (lockPathValue !== lockPath) {
    throw new UnsafeLocalDataRemovalTargetError(
      lockPathValue,
      "execution lock is not the fixed helper-state child",
    );
  }
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(
      lockPath,
      constants.O_RDWR |
        constants.O_CREAT |
        constants.O_NOFOLLOW,
      privateFileMode,
    );
    const value = await handle.stat();
    if (
      !value.isFile() ||
      value.nlink !== 1 ||
      (value.mode & 0o777) !== privateFileMode
    ) {
      throw new UnsafeLocalDataRemovalTargetError(
        lockPath,
        "execution lock file has an unsafe filesystem identity",
      );
    }
  } finally {
    await handle?.close();
  }
}

async function removeLocalDataRemovalExclusion(
  helperStateRoot: string,
): Promise<void> {
  const exclusion = localDataRemovalExclusionPath(helperStateRoot);
  const value = await metadata(exclusion);
  if (value === null) return;
  await assertSingleDeviceRemovalTree(exclusion);
  await rm(exclusion, { recursive: true, force: false, maxRetries: 0 });
  await syncDirectory(dirname(exclusion));
}

function exactDirectChild(parent: string, name: string): string {
  const child = join(parent, name);
  if (!isDirectChild(parent, child)) {
    throw new UnsafeLocalDataRemovalTargetError(
      child,
      "not an exact direct child",
    );
  }
  return child;
}

function isDirectChild(parent: string, child: string): boolean {
  const suffix = relative(parent, child);
  return (
    suffix.length > 0 &&
    suffix !== ".." &&
    !suffix.startsWith(`..${sep}`) &&
    !isAbsolute(suffix) &&
    !suffix.includes(sep)
  );
}

function pathsOverlap(left: string, right: string): boolean {
  return (
    isPathWithinExactOwnedRoot(left, right) ||
    isPathWithinExactOwnedRoot(right, left)
  );
}

function rejectDuplicateOrOverlappingTargets(
  targets: readonly {
    readonly id?: string;
    readonly path: string;
  }[],
): void {
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];
    if (target === undefined) continue;
    for (let otherIndex = index + 1; otherIndex < targets.length; otherIndex += 1) {
      const other = targets[otherIndex];
      if (other !== undefined && pathsOverlap(target.path, other.path)) {
        throw new UnsafeLocalDataRemovalTargetError(
          other.path,
          "removal targets overlap",
        );
      }
    }
  }
}

function assertTargetKind(
  target: { readonly path: string; readonly kind: "file" | "directory" },
  value: Stats,
): void {
  if (value.isSymbolicLink()) {
    throw new UnsafeLocalDataRemovalTargetError(
      target.path,
      "target is a symbolic link",
    );
  }
  if (
    (target.kind === "file" && !value.isFile()) ||
    (target.kind === "directory" && !value.isDirectory())
  ) {
    throw new UnsafeLocalDataRemovalTargetError(
      target.path,
      `target is not a ${target.kind}`,
    );
  }
}

function compareTarget(
  left: CanonicalFilesystemTarget,
  right: CanonicalFilesystemTarget,
): number {
  return `${left.category}\u0000${left.path}`.localeCompare(
    `${right.category}\u0000${right.path}`,
  );
}

function targetId(category: string, path: string): string {
  return `target_${createHash("sha256")
    .update(`${category}\u0000${path}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function requireSigningKey(value: Uint8Array): Buffer {
  const key = Buffer.from(value);
  if (key.byteLength < minimumSigningKeyBytes) {
    throw new RangeError(
      `Local-data removal signing key must contain at least ${minimumSigningKeyBytes} bytes.`,
    );
  }
  return key;
}

function sha256(value: unknown): string {
  return `sha256_${createHash("sha256")
    .update(canonicalJson(value))
    .digest("hex")}`;
}

export function canonicalLocalDataRemovalJson(value: unknown): string {
  return canonicalJson(value);
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
    case "number":
    case "string":
      return JSON.stringify(value);
    case "object":
      if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(",")}]`;
      }
      return `{${Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) =>
          `${JSON.stringify(key)}:${canonicalJson(entry)}`
        )
        .join(",")}}`;
    case "bigint":
    case "function":
    case "symbol":
    case "undefined":
      throw new TypeError("Canonical local-data JSON contains an unsupported value.");
  }
  throw new TypeError("Canonical local-data JSON contains an unsupported value.");
}

function safeStringEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.byteLength === rightBytes.byteLength &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

async function atomicWritePrivateJson(
  path: string,
  value: unknown,
): Promise<void> {
  const parent = await requireCanonicalDirectory(dirname(path));
  if (!isDirectChild(parent, path)) {
    throw new UnsafeLocalDataRemovalTargetError(
      path,
      "private JSON file is not a direct child",
    );
  }
  const temporaryPath = exactDirectChild(
    parent,
    `.${basename(path)}.${randomBytes(12).toString("hex")}.tmp`,
  );
  const descriptor = await open(
    temporaryPath,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    privateFileMode,
  );
  try {
    await descriptor.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await descriptor.sync();
  } finally {
    await descriptor.close();
  }
  try {
    await rename(temporaryPath, path);
    const parentDescriptor = await open(
      parent,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      await parentDescriptor.sync();
    } finally {
      await parentDescriptor.close();
    }
  } catch (error: unknown) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const descriptor = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    await descriptor.sync();
  } finally {
    await descriptor.close();
  }
}

async function metadata(path: string): Promise<Stats | null> {
  return await lstat(path).catch((error: unknown) => {
    if (isFileSystemError(error, "ENOENT")) return null;
    throw error;
  });
}

function parseJson(source: string, subject: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new Error(`Invalid ${subject} JSON.`);
  }
}

function isFileSystemError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
