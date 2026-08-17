import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  HRA_HUMAN_HTTP_VERSION,
  RUNNER_PRESENCE_LEASE_MS,
  createRunInteractionReplyKeyPair,
  hraHumanMutationIntentSchema,
  materializeLocalOwnerTaskCommand,
  type HRAProjectionCursor,
  type TaskWorkspaceView,
} from "@hraness/agent-tasks-protocol";
import { z } from "@hra-internal/schema";

import {
  parseRuntimeDispatchRequest,
  parseRuntimeSnapshotRequest,
  runtimeChatDomainCommandSchema,
  runtimeHarnessDomainCommandSchema,
  runtimeSessionSyncDomainCommandSchema,
  runtimeDispatchCommand,
  runtimeProtocolVersion,
  runtimeSnapshotCommand,
  runtimeTaskDispatchRequestSchema,
  type ChatPaneProjection,
  type RuntimeDispatchRequest,
  type RuntimeDispatchResponse,
  type RuntimeError,
  type HumanAccountSnapshot as RendererHumanAccountSnapshot,
  type RuntimeHumanOrganization,
  type RuntimeHumanWorkspace,
  type RuntimeLocalDataRemovalCommand,
  type RuntimeLocalPromotionProgress,
  type RuntimeSnapshot,
  type RuntimeTaskDispatchRequest,
  type RuntimeTaskDispatchResponse,
} from "../../contracts/runtime";
import {
  runtimeChatPaneStateChangedEvent,
  runtimeChatPaneStateProjection,
  runtimeChatPaneUpsertEventOrInvalidation,
} from "../../contracts/runtime-delivery";
import runtimeVersions from "../runtime-versions.json";
import { packageSmokeRoot, runPackageSmoke } from "./package-smoke";
import { optionalRenamedEnvironmentValue } from "./security/renamed-environment";
import {
  AccountService,
  AccountServiceError,
} from "./accounts/account-service";
import { NativeAccountProfileFileSystem } from "./accounts/local-data-remover";
import { AccountProfileStore } from "./accounts/profile-store";
import { AccountRuntimeRouter } from "./accounts/runtime-router";
import {
  CodexFactRouter,
  CodexJsonlWriter,
  type CodexServerRequest,
} from "./codex";
import { DispatchTransferStore } from "./dispatch-transfer";
import {
  hostLocalDataRemovalNativeLaunch,
  hostLocalDataRemovalNativeTerminationRequired,
  hostLocalDataRemovalRecoveryCommand,
  hostAccountProfileNativeResultCommand,
  hostHarnessCustodyNativeResultCommand,
  hostProjectOnboardingCommand,
  hostFailure,
  hostSuccess,
  parseHostDispatchPayload,
  parseHostAccountProfileNativeResultPayload,
  parseHostHarnessCustodyNativeResultPayload,
  parseHostDevelopmentReloadPayload,
  parseHostLocalDataRemovalRecoveryPayload,
  parseHostNativeRemovalCapability,
  parseHostProjectOnboardingPayload,
  parseHostRequest,
  type HostLocalDataRemovalNativeLaunch,
  type HostLocalDataRemovalNativeTerminationRequired,
  type HostProjectOnboardingPayload,
} from "./host-protocol";
import {
  DevelopmentReloadAdmission,
  hostDevelopmentReloadCommand,
  hostDevelopmentReloadDecision,
  parseRuntimeBridgeProfile,
} from "./development-reload";
import { DispatchActivityAdapter } from "./dispatch/activity-adapter";
import { DispatchAccountReservationArbiter } from "./dispatch/account-reservations";
import { HRADispatchHttpClient } from "./dispatch/cloud-client";
import { DispatchCompletionAdapter } from "./dispatch/completion-adapter";
import { DispatchCoordinator } from "./dispatch/coordinator";
import { DispatchInteractionAdapter } from "./dispatch/interaction-adapter";
import {
  configureDispatchRepositories,
  LocalDispatchCapabilities,
} from "./dispatch/local-capabilities";
import {
  createHumanAccountRuntime,
  parseHRACloudConfiguration,
  WorkOsExternalUrlOpener,
  type CloudAttachmentAvailability,
  CloudInvalidationCoordinator,
  type CloudWorkspaceClient,
  CloudWorkspaceSummaryCache,
  type CloudWorkspaceSummaryScope,
  type HumanAccountSafeError,
  type HumanAccountService,
  HRAInteractionGateway,
  type HumanAccountSnapshot as InternalHumanAccountSnapshot,
  type HRACloudSessionResult,
} from "./cloud";
import {
  parseDispatchRepositoryMappings,
  recoverPairedDispatchAuthorization,
  type DispatchRepositoryMapping,
} from "./dispatch/pairing";
import {
  SessionSyncCoordinator,
  SessionSyncCoordinatorError,
} from "./cloud/session-sync-coordinator";
import {
  SessionSyncBearerClient,
  SessionSyncHttpTransport,
} from "./cloud/session-sync-http-client";
import {
  SessionSyncKeyCustody,
  SessionSyncRecoveryKeyCustody,
} from "./cloud/session-sync-key-custody";
import {
  createDispatchRevocationCoordinator,
  DispatchRevocationCoordinator,
} from "./dispatch/revocation";
import { HRADispatchRunner } from "./dispatch/runner";
import type { DispatchRevocationReason } from "./dispatch/runner";
import { SessionDispatchLauncher } from "./dispatch/session-launcher";
import { ChatService, CodexChatProvider } from "./chat";
import {
  createHarnessProductionCompositionV2,
  type HarnessProductionCompositionV2,
} from "./harness/production-composition-v2";
import { createHarnessProductionGraphV2 } from
  "./harness/production-graph-v2";
import {
  HarnessInstallKeyCustody,
  harnessInstallKeyDescriptor,
  harnessLegacyInstallKeyDescriptor,
} from "./harness/key-custody";
import { NativeHarnessKeyCustody } from "./harness/native-key-custody";
import { HarnessRendererServiceError } from
  "./harness/renderer-service-v2";
import { createLocalTaskDueWorkHandlers } from "./tasks/handler-adapter";
import { LocalRunCompletionAdapter } from "./tasks/local-run-completion-adapter";
import { LocalRunInteractionAdapter } from "./tasks/local-run-interaction-adapter";
import { LocalQueuedRunExecutor } from "./tasks/local-run-executor";
import { LocalTaskChangeCoordinator } from "./tasks/local-task-change-coordinator";
import { LocalTaskReconciler } from "./tasks/reconciler";
import {
  ProjectionCommitCoordinator,
  ProjectionCoordinatorClosedError,
  ProjectionPayloadLimitError,
  RuntimeProjection,
  unsupportedServerRequestError,
} from "./projection";
import {
  HRAPromotionHttpTransport,
  HRARunnerPairingCoordinator,
  HRARunnerPairingInspectionCache,
  LocalPromotionCoordinator,
  LocalPromotionError,
  runnerPairingFailureMayRequireCredentialRecovery,
  type HRARunnerAuthorization,
  type HRARunnerPairingFailureCode,
  type HRARunnerPairingInput,
  type LocalPromotionProgress,
} from "./promotion";
import {
  accountPaths,
  resolvePortableRuntimeAssets,
  type PortableRuntimeAssets,
  type RuntimePaths,
} from "./runtime-paths";
import { hraReleaseIdentity } from "../release-identity";
import { SnapshotTransferStore } from "./snapshot-transfer";
import {
  prepareApplicationSupportMigration,
  type ApplicationSupportStartup,
} from "./state/application-support";
import {
  ApplicationSupportWorktreeRepairError,
  inspectApplicationSupportWorktreeRepair,
  repairMovedApplicationSupportWorktrees,
  reverseMovedApplicationSupportWorktreeRepair,
  type ApplicationSupportWorktreeRepairOptions,
} from "./state/application-support-worktree-repair";
import {
  checkpointControlPlaneForApplicationSupportCutover,
  controlPlanePathFromApplicationSupportRoot,
  defaultControlPlanePath,
  openControlPlane,
} from "./state/database";
import { recoverInterruptedControlPlaneRestore } from "./state/control-plane-backup";
import {
  acquireControlPlaneLifetimeLock,
  type ControlPlaneLifetimeLock,
} from "./state/control-plane-lock";
import { preflightControlPlaneRelease } from "./state/release-compatibility";
import {
  loadOrCreateOperationReceiptKey,
  operationReceiptKeyPath,
} from "./state/operation-receipt-key";
import { HumanAccountMetadataStore } from "./state/human-account-metadata-store";
import { SessionSyncOperationJournal } from
  "./state/session-sync-operation-journal";
import { SessionSyncStore } from "./state/session-sync-store";
import {
  HumanOrganizationOperationConflict,
  HumanOrganizationOperationStore,
  type HumanOrganizationOperationCursor,
} from "./state/human-organization-operation-store";
import {
  OperationReceiptConflict,
  OperationReceiptStore,
} from "./state/operation-receipts";
import {
  CloudHumanOperationConflict,
  CloudHumanOperationStore,
} from "./state/cloud-human-operation-store";
import { CloudInvalidationHeadStore } from "./state/cloud-invalidation-head-store";
import { DispatchStore } from "./state/dispatch-store";
import { ChatPaneStore, ChatPaneStoreError } from "./state/chat-pane-store";
import {
  ChatWorkspaceStore,
  ManagedChatWorkspaceService,
} from "./state/chat-workspace-store";
import { DispatchInteractionStore } from "./state/dispatch-interaction-store";
import {
  DispatchRunnerInstallationStore,
  scopedDispatchRunnerId,
} from "./state/dispatch-runner-installation";
import { LocalTaskAuthorityCommandStore } from "./state/local-task-authority-command-store";
import {
  createLocalRuntimeBootId,
  LocalDueWorkStore,
} from "./state/local-task-due-work-store";
import { LocalRepositoryReadiness } from "./state/local-repository-readiness";
import { LocalRunExecutionStore } from "./state/local-run-execution-store";
import {
  LocalMutationAttemptConflict,
  LocalOperationConflict,
  LocalProjectionRevisionConflict,
  LocalTaskStore,
  LocalTaskStoreError,
} from "./state/local-task-store";
import {
  LocalPromotionV2Store,
  type LocalRunnerPairingRecord,
} from "./state/local-promotion-v2-store";
import { SessionDispatchCallbackRouter } from "./sessions/dispatch-callback-router";
import { SessionService } from "./sessions/session-service";
import { BundledGitRunner } from "./workspaces/git-runner";
import {
  LocalTaskStoreProjectOnboardingAdapter,
  ProjectOnboardingService,
  type ProjectOnboardingOutcome,
} from "./workspaces/onboarding-service";
import { WorkspaceBroker } from "./workspaces/workspace-broker";
import { bunHumanKeychain } from "./cloud/keychain-custody";
import {
  FileLocalDataRemovalReceiptStore,
  createLocalDataRemovalPlan,
  loadOrCreateLocalDataRemovalHelperState,
  localDataRemovalPublicFailure,
  prepareLocalDataRemovalHelperLaunch,
  type AuthenticatedLocalDataRemovalSecretStore,
  type LocalDataRemovalHelperState,
  type PreparedLocalDataRemovalPlan,
} from "./maintenance/local-data-removal";
import {
  discoverGatewayLocalDataRemovalInventory,
  fixedLocalDataRemovalPaths,
  verifiedLocalDataRemoverPath,
} from "./maintenance/local-data-removal-inventory";
import {
  runStartupLocalDataRemovalRecovery,
  startupLocalDataRemovalRecoveryRequested,
} from "./maintenance/local-data-removal-recovery";

const initialSnapshot: RuntimeSnapshot = {
  revision: 1,
  lastSequence: 0,
  runtime: { state: "starting", generation: 0 },
  runner: { state: "recovering" },
  accounts: [],
  retainedAccountLocalData: [],
  humanAccount: { state: "signedOut", revision: 0 },
  chat: { revision: 1, panes: [] },
  sessionSync: {
    status: {
      state: "unavailable",
      reason: "cloudConfigurationMissing",
      retryable: false,
    },
    localGridSlots: [],
    remoteSessions: [],
  },
  harness: null,
};
const hostWriter = new CodexJsonlWriter({
  write: async (bytes) => await Bun.write(Bun.stdout, bytes),
});
let hostWriteTail: Promise<void> = Promise.resolve();
let projectionDrain: Promise<void> | null = null;

function writeHost(value: unknown): Promise<void> {
  const write = hostWriteTail.then(async () => {
    await hostWriter.write(value);
  });
  hostWriteTail = write.catch(() => undefined);
  return write;
}

function requestProjectionDrain(): void {
  if (projectionDrain !== null) return;
  const task = drainProjectionEvents();
  projectionDrain = task;
  void task.finally(() => {
    if (projectionDrain === task) projectionDrain = null;
    if (projection.queuedEventCount > 0) requestProjectionDrain();
  }).catch(() => undefined);
}

async function drainProjectionEvents(): Promise<void> {
  while (true) {
    const events = projection.drainEvents();
    if (events.length === 0) return;
    for (const event of events) await writeHost(event);
  }
}

const projection = new RuntimeProjection(initialSnapshot, {
  onEventsAvailable: requestProjectionDrain,
});

function requestGatewayGenerationRecovery(error: Error): void {
  // Native owns the bounded restart policy. Throwing on a microtask exits only
  // this gateway generation and lets durable startup recovery fence ambiguity
  // before any new provider effect is admitted.
  queueMicrotask(() => { throw error; });
}

let projectionCapacityRecoveryScheduled = false;
const projectionCommits = new ProjectionCommitCoordinator(projection, {
  onCapacityTimeout: (error) => {
    if (projectionCapacityRecoveryScheduled) return;
    projectionCapacityRecoveryScheduled = true;
    // A stalled renderer/Native drain makes the live projection unknowable.
    // Exit this gateway generation so Native's bounded supervisor restart can
    // rehydrate the renderer from durable state instead of pinning commands or
    // shutdown behind an unbounded capacity wait.
    requestGatewayGenerationRecovery(error);
  },
});
let projectionCommitAdmissionClosing = false;
const developmentReloadAdmission = new DevelopmentReloadAdmission();
let gatewayReadyForDevelopmentReload = false;
let ordinaryHostRequestsInFlight = 0;
let developmentReloadInternalAdmissionsClosed = false;

function developmentReloadHasInMemoryWork(): boolean {
  const human = humanAccountService;
  return projectionDrain !== null ||
    projection.queuedEventCount > 0 ||
    projectionCommits.pendingCommitCount > 0 ||
    human?.hasActiveOperation() === true ||
    human?.snapshot().state === "signing_in" ||
    humanOrganizationTasks.size > 0 ||
    humanOrganizationRefilling ||
    humanOrganizationProvisioningStopping ||
    hraRunnerPairingTask !== null ||
    hraRunnerPairingRecoveryActive ||
    sessionSyncCoordinator?.hasUnsettledWork() === true ||
    localPromotionCoordinator?.hasUnsettledWork() === true ||
    localTaskReconciler?.hasUnsettledWork() === true ||
    localQueuedRunExecutor?.hasUnsettledWork() === true ||
    localRunCompletionAdapter?.hasUnsettledWork() === true ||
    dispatchActivityAdapter?.hasUnsettledWork() === true ||
    dispatchCompletionAdapter?.hasUnsettledWork() === true ||
    chatService?.hasUnsettledWork() === true ||
    harnessProductionComposition?.hasUnsettledWork() === true ||
    localDataRemovalMaintenanceState !== "open";
}

function sealInternalDevelopmentReloadAdmissions(): void {
  developmentReloadInternalAdmissionsClosed = true;
  humanAccountService?.closeAdmission();
  for (const { coordinator } of cloudInvalidationCoordinators.values()) {
    coordinator.closeAdmission();
  }
  chatService?.closeAdmission();
  harnessProductionComposition?.closeAdmissions();
  localTaskReconciler?.closeAdmission();
  localQueuedRunExecutor?.closeAdmission();
  localPromotionCoordinator?.closeAdmission();
  sessionSyncCoordinator?.closeAdmission();
  dispatchRunnerController?.abort();
  humanOrganizationProvisioningStopping = true;
  for (const timer of humanOrganizationRetryTimers.values()) {
    clearTimeout(timer);
  }
  humanOrganizationRetryTimers.clear();
  if (localCompletionRetryTimer !== null) {
    clearInterval(localCompletionRetryTimer);
  }
  if (localClaimRenewalTimer !== null) clearInterval(localClaimRenewalTimer);
  if (dispatchCompletionRetryTimer !== null) {
    clearInterval(dispatchCompletionRetryTimer);
  }
  if (hraRunnerPairingTimer !== null) clearInterval(hraRunnerPairingTimer);
  localTaskChanges.close();
  projectionCommits.closeAdmission();
}
const localTaskChanges = new LocalTaskChangeCoordinator({
  onChange: (invalidation) => {
    publishWithDrainRetry({
      type: "task.invalidated",
      invalidation,
    });
  },
});
const snapshotTransfers = new SnapshotTransferStore();
const dispatchTransfers = new DispatchTransferStore();

let accountService: AccountService | null = null;
let chatService: ChatService | null = null;
let harnessProductionComposition: HarnessProductionCompositionV2 | null = null;
let accountProfileFileSystem: NativeAccountProfileFileSystem | null = null;
const nativeHarnessKeyCustody = new NativeHarnessKeyCustody({
  writeRequest: writeHost,
});
const localDataRemovalKeychain: AuthenticatedLocalDataRemovalSecretStore = {
  delete: async (input, authorization) => {
    const isHarnessInstallKey = input.name === harnessInstallKeyDescriptor.name
      && (
        input.service === harnessInstallKeyDescriptor.service
        || input.service === harnessLegacyInstallKeyDescriptor.service
    );
    return isHarnessInstallKey
      ? await nativeHarnessKeyCustody.deleteBothForAuthenticatedRemoval(
        authorization,
      )
      : await bunHumanKeychain.delete(input);
  },
};
Object.freeze(localDataRemovalKeychain);
let humanAccountService: HumanAccountService | null = null;
let humanOrganizationOperations: HumanOrganizationOperationStore | null = null;
const humanOrganizationRetryTimers = new Map<
  string,
  ReturnType<typeof setTimeout>
>();
const humanOrganizationTasks = new Map<string, Promise<void>>();
const humanOrganizationDeferredUntilWake = new Set<string>();
const HUMAN_ORGANIZATION_PROVISIONING_CONCURRENCY = 4;
let humanOrganizationRefilling = false;
let humanOrganizationProvisioningStopping = false;
let cloudAttachmentAvailability: CloudAttachmentAvailability | null = null;
let cloudWorkspaceClient: CloudWorkspaceClient | null = null;
let cloudHumanOperations: CloudHumanOperationStore | null = null;
let cloudInvalidationHeads: CloudInvalidationHeadStore | null = null;
const cloudWorkspaceSummaries = new CloudWorkspaceSummaryCache({
  onInvalidated: (invalidation) => {
    publishWithDrainRetry({
      type: "task.invalidated",
      invalidation,
    });
  },
});
const cloudInvalidationCoordinators = new Map<
  string,
  Readonly<{
    accountGeneration: number;
    accountOrganizationId: string | null;
    accountUserId: string;
    coordinator: CloudInvalidationCoordinator;
  }>
>();
let currentHumanCredentialGeneration: number | null = null;
let currentHumanOrganizationId: string | null = null;
let currentHumanUserId: string | null = null;
let database: ReturnType<typeof openControlPlane> | null = null;
let lifetimeLock: ControlPlaneLifetimeLock | null = null;
let localProjectOnboardingService: ProjectOnboardingService | null = null;
let localProjectOnboardingInstallationId: string | null = null;
let localTaskReconciler: LocalTaskReconciler | null = null;
let localTaskStore: LocalTaskStore | null = null;
let sessionSyncCoordinator: SessionSyncCoordinator | null = null;
let localPromotionStore: LocalPromotionV2Store | null = null;
let localPromotionCoordinator: LocalPromotionCoordinator | null = null;
let localRepositoryReadiness: LocalRepositoryReadiness | null = null;
let dispatchAccountReservations: DispatchAccountReservationArbiter | null = null;
let localRunExecutionStore: LocalRunExecutionStore | null = null;
let localQueuedRunExecutor: LocalQueuedRunExecutor | null = null;
let localDispatchActivityAdapter: DispatchActivityAdapter | null = null;
let localRunCompletionAdapter: LocalRunCompletionAdapter | null = null;
let localRunInteractionAdapter: LocalRunInteractionAdapter | null = null;
let localDispatchRevocations: DispatchRevocationCoordinator | null = null;
let localCompletionRetryTimer: ReturnType<typeof setInterval> | null = null;
let localClaimRenewalTimer: ReturnType<typeof setInterval> | null = null;
let operationReceipts: OperationReceiptStore | null = null;
let portableRuntimeAssets: PortableRuntimeAssets | null = null;

function bundledGitRunner(paths: RuntimePaths): BundledGitRunner {
  const sourceTestPathExecution = basename(process.execPath) === "bun"
    && optionalRenamedEnvironmentValue(
      process.env,
      "HRA_SOURCE_TEST_ALLOW_PATH_GIT",
    ) === "1";
  return new BundledGitRunner(
    paths,
    process.env,
    sourceTestPathExecution
      ? { unsafeTestOnlyAllowPathExecution: true }
      : {},
  );
}
let activeControlPlanePath: string | null = null;
let localDataRemovalHelperState: LocalDataRemovalHelperState | null = null;
const localDataRemovalPreviews = new Map<
  string,
  PreparedLocalDataRemovalPlan
>();
let localDataRemovalMaintenanceState:
  | "open"
  | "quiescing"
  | "held" = "open";
const localDataRemovalMaintenanceFence = {
  isHeld: () => localDataRemovalMaintenanceState === "held",
};
let dispatchRunnerController: AbortController | null = null;
let dispatchRunnerTask: Promise<void> | null = null;
let dispatchActivityAdapter: DispatchActivityAdapter | null = null;
let dispatchInteractionAdapter: DispatchInteractionAdapter | null = null;
let dispatchCompletionAdapter: DispatchCompletionAdapter | null = null;
let dispatchCompletionRetryTimer: ReturnType<typeof setInterval> | null = null;
type DispatchRunnerBinding =
  | Readonly<{ kind: "taskctl" }>
  | Readonly<{
      kind: "hra";
      promotionId: string;
      cloudWorkspaceId: string;
    }>;
interface DispatchRunnerRuntimeContext {
  readonly accountReservations: DispatchAccountReservationArbiter;
  readonly accounts: AccountService;
  readonly assets: PortableRuntimeAssets;
  readonly controlPlane: Database;
  readonly controlPlanePath: string;
  readonly sessions: SessionService;
}
let dispatchRunnerBinding: DispatchRunnerBinding | null = null;
let dispatchRunnerRunning = false;
let hraRunnerPairingCoordinator: HRARunnerPairingCoordinator | null =
  null;
let hraRunnerPairingInstallationId: string | null = null;
let hraRunnerPairingRuntime: DispatchRunnerRuntimeContext | null = null;
let hraRunnerPairingTimer: ReturnType<typeof setInterval> | null = null;
let hraRunnerPairingTask: Promise<void> | null = null;
let hraRunnerPairingWakeQueued = false;
let hraRunnerPairingRecoveryActive = false;
let hraRunnerPairingRecoveryState:
  "initializing" | "ready" | "configuration_required" = "initializing";
const hraRunnerPairingInspections =
  new HRARunnerPairingInspectionCache();

function currentCloudWorkspaceScope(): CloudWorkspaceSummaryScope | null {
  if (
    currentHumanCredentialGeneration === null ||
    currentHumanUserId === null
  ) {
    return null;
  }
  return {
    credentialGeneration: currentHumanCredentialGeneration,
    organizationId: currentHumanOrganizationId,
    userId: currentHumanUserId,
  };
}

function rendererHumanOrganization(
  organization: {
    readonly id: string;
    readonly name: string;
    readonly role: "owner" | "admin" | "member";
    readonly status: "provisioning" | "active" | "failed";
    readonly workosOrganizationId?: string | undefined;
  },
): RuntimeHumanOrganization {
  return {
    id: organization.id,
    name: organization.name,
    role: organization.role,
    status: organization.status,
    workosOrganizationId: organization.workosOrganizationId ?? null,
  };
}

function rendererHumanWorkspace(
  workspace: RuntimeHumanWorkspace,
): RuntimeHumanWorkspace {
  return {
    id: workspace.id,
    organizationId: workspace.organizationId,
    name: workspace.name,
    slug: workspace.slug,
    taskKeyPrefix: workspace.taskKeyPrefix,
    roles: [...workspace.roles],
  };
}

function rendererHumanProfile(
  profile: Extract<
    InternalHumanAccountSnapshot,
    { readonly state: "signed_in" }
  >["profile"],
): Extract<
  RendererHumanAccountSnapshot,
  { readonly state: "signedIn" }
>["profile"] {
  return {
    user: {
      id: profile.user.id,
      email: profile.user.email,
      name: profile.user.name ?? null,
    },
    organization: profile.organization === undefined
      ? null
      : rendererHumanOrganization(profile.organization),
    workspace: profile.workspace === undefined
      ? null
      : rendererHumanWorkspace(profile.workspace),
  };
}

function rendererHumanAccountSnapshot(
  snapshot: InternalHumanAccountSnapshot,
  availability: CloudAttachmentAvailability,
): RendererHumanAccountSnapshot {
  if (
    availability.state === "disabled" &&
    (
      snapshot.state === "signed_out" ||
      (
        snapshot.state === "error" &&
        snapshot.error.code === "CONFIGURATION_UNAVAILABLE" &&
        snapshot.profile === undefined
      )
    )
  ) {
    return {
      state: "unavailable",
      revision: snapshot.revision,
      reason: availability.reason.endsWith("_missing")
        ? "configuration_missing"
        : "configuration_invalid",
    };
  }
  switch (snapshot.state) {
    case "initializing":
      return {
        state: "unavailable",
        revision: snapshot.revision,
        reason: "initializing",
      };
    case "signed_out":
      return { state: "signedOut", revision: snapshot.revision };
    case "recovery_required":
      return {
        state: "recoveryRequired",
        revision: snapshot.revision,
        reason: "legacyCredentialAccessDenied",
      };
    case "signing_in":
      return {
        state: "signingIn",
        revision: snapshot.revision,
        userCode: snapshot.verification?.userCode ?? null,
        expiresAt: snapshot.verification?.expiresAt ?? null,
      };
    case "signed_in":
      return {
        state: "signedIn",
        revision: snapshot.revision,
        profile: rendererHumanProfile(snapshot.profile),
      };
    case "error":
      return {
        state: "error",
        revision: snapshot.revision,
        code: snapshot.error.code,
        message: snapshot.error.message,
        retryable: snapshot.error.retryable,
        profile: snapshot.profile === undefined
          ? null
          : rendererHumanProfile(snapshot.profile),
      };
  }
}

function publishHumanAccountSnapshot(
  snapshot: InternalHumanAccountSnapshot,
  availability: CloudAttachmentAvailability,
): void {
  const previousGeneration = currentHumanCredentialGeneration;
  const previousOrganizationId = currentHumanOrganizationId;
  const previousUserId = currentHumanUserId;
  currentHumanCredentialGeneration = snapshot.state === "signed_in"
    ? snapshot.credentialGeneration
    : null;
  currentHumanOrganizationId = snapshot.state === "signed_in"
    ? snapshot.profile.organization?.id ?? null
    : null;
  currentHumanUserId = snapshot.state === "signed_in"
    ? snapshot.profile.user.id
    : null;
  cloudWorkspaceSummaries.replaceScope(currentCloudWorkspaceScope());
  if (
    previousGeneration !== currentHumanCredentialGeneration ||
    previousOrganizationId !== currentHumanOrganizationId ||
    previousUserId !== currentHumanUserId
  ) {
    void stopCloudInvalidations();
    void sessionSyncCoordinator?.authenticationChanged().catch(() => undefined);
  }
  publishWithDrainRetry({
    type: "humanAccount.changed",
    humanAccount: rendererHumanAccountSnapshot(snapshot, availability),
  });
  if (snapshot.state === "signed_in") {
    wakeHumanOrganizationProvisioning();
    wakeHRARunnerPairing();
  }
}

async function stopCloudInvalidations(): Promise<void> {
  const active = [...cloudInvalidationCoordinators.values()];
  cloudInvalidationCoordinators.clear();
  await Promise.allSettled(
    active.map(async ({ coordinator }) => await coordinator.stop()),
  );
}

function ensureCloudInvalidations(workspaceId: string): void {
  if (developmentReloadInternalAdmissionsClosed) return;
  const client = cloudWorkspaceClient;
  const heads = cloudInvalidationHeads;
  const accountGeneration = currentHumanCredentialGeneration;
  const accountOrganizationId = currentHumanOrganizationId;
  const accountUserId = currentHumanUserId;
  if (
    client === null ||
    heads === null ||
    accountGeneration === null ||
    accountUserId === null
  ) {
    return;
  }
  const existing = cloudInvalidationCoordinators.get(workspaceId);
  if (
    existing?.accountGeneration === accountGeneration &&
    existing.accountOrganizationId === accountOrganizationId &&
    existing.accountUserId === accountUserId
  ) {
    return;
  }
  if (existing !== undefined) {
    cloudInvalidationCoordinators.delete(workspaceId);
    void existing.coordinator.stop();
  }
  while (cloudInvalidationCoordinators.size >= 8) {
    const oldest = cloudInvalidationCoordinators.entries().next().value;
    if (oldest === undefined) break;
    const [oldestWorkspaceId, oldestEntry] = oldest;
    cloudInvalidationCoordinators.delete(oldestWorkspaceId);
    void oldestEntry.coordinator.stop();
  }
  const coordinator = new CloudInvalidationCoordinator({
    client,
    onFatalFailure: requestGatewayGenerationRecovery,
    isAccountGenerationCurrent: (generation) =>
      currentHumanCredentialGeneration === generation &&
      currentHumanOrganizationId === accountOrganizationId &&
      currentHumanUserId === accountUserId,
    onDelivery: (delivery) => {
      if (
        currentHumanCredentialGeneration !== delivery.accountGeneration ||
        currentHumanOrganizationId !== accountOrganizationId ||
        currentHumanUserId !== accountUserId
      ) {
        return;
      }
      for (const invalidation of delivery.invalidations) {
        publishWithDrainRetry({
          type: "task.invalidated",
          invalidation,
        });
      }
      if (
        delivery.invalidations.length === 0 &&
        delivery.projectionHead > delivery.previousProjectionHead
      ) {
        publishWithDrainRetry({
          type: "task.invalidated",
          invalidation: {
            workspaceId: delivery.workspaceId,
            projectionRevision: delivery.projectionHead,
            scope: "workspace",
          },
        });
      }
      if (delivery.pageComplete) {
        heads.advance({
          workspaceId: delivery.workspaceId,
          accountUserId,
          credentialGeneration: delivery.accountGeneration,
          projectionHead: delivery.projectionHead,
        });
      }
    },
  });
  cloudInvalidationCoordinators.set(workspaceId, {
    accountGeneration,
    accountOrganizationId,
    accountUserId,
    coordinator,
  });
  coordinator.start({
    accountGeneration,
    workspaceId,
    afterProjectionHead: heads.read(workspaceId, accountUserId),
  });
}

function humanAccountFailure(
  operationId: string,
  error: HumanAccountSafeError,
): RuntimeDispatchResponse {
  const authenticationFailure =
    error.code === "SIGNED_OUT" ||
    error.code === "AUTHENTICATION_FAILED" ||
    error.code === "AUTH_REFRESH_INDETERMINATE";
  const code: RuntimeError["code"] = authenticationFailure
    ? "policy_denied"
    : error.code === "NOT_FOUND"
      ? "not_found"
      : error.code === "VALIDATION_ERROR"
        ? "invalid_request"
        : error.code === "PROVISIONING_IN_PROGRESS"
          ? "conflict"
          : error.code === "CONFIGURATION_UNAVAILABLE"
            ? "capability_unavailable"
            : "operation_failed";
  return operationFailure(
    operationId,
    code,
    error.message,
    error.retryable,
    authenticationFailure
      ? "signIn"
      : error.retryable
        ? "retry"
        : "none",
  );
}

function scheduleHumanOrganizationRetry(
  operationId: string,
  delayMs: number,
): void {
  if (
    humanOrganizationProvisioningStopping ||
    humanOrganizationRetryTimers.has(operationId)
  ) {
    return;
  }
  const timer = setTimeout(() => {
    humanOrganizationRetryTimers.delete(operationId);
    if (!startHumanOrganizationProvisioning(operationId)) {
      refillHumanOrganizationProvisioning();
    }
  }, delayMs);
  humanOrganizationRetryTimers.set(operationId, timer);
}

function startHumanOrganizationProvisioning(operationId: string): boolean {
  if (
    humanOrganizationProvisioningStopping ||
    humanOrganizationTasks.has(operationId) ||
    humanOrganizationRetryTimers.has(operationId) ||
    humanOrganizationDeferredUntilWake.has(operationId) ||
    humanOrganizationTasks.size >= HUMAN_ORGANIZATION_PROVISIONING_CONCURRENCY
  ) {
    return false;
  }
  const store = humanOrganizationOperations;
  const service = humanAccountService;
  if (store === null || service === null) return false;
  const operation = store.startedById(operationId);
  if (operation === null) return false;
  const task = (async () => {
    try {
      const result = await service.createOrganization({
        name: operation.name,
        idempotencyKey: operation.idempotencyKey,
      });
      if (result.ok) {
        store.complete(operation.operationId, {
          ok: true,
          organization: result.data.organization,
        });
        return;
      }
      if (
        result.error.code === "PROVISIONING_IN_PROGRESS" ||
        result.error.code === "SERVICE_UNAVAILABLE"
      ) {
        scheduleHumanOrganizationRetry(
          operation.operationId,
          result.error.code === "PROVISIONING_IN_PROGRESS" ? 1_000 : 5_000,
        );
        return;
      }
      if (
        result.error.code === "SIGNED_OUT" ||
        result.error.code === "AUTHENTICATION_FAILED" ||
        result.error.code === "AUTH_REFRESH_INDETERMINATE" ||
        result.error.code === "CONFIGURATION_UNAVAILABLE" ||
        result.error.code === "CREDENTIAL_RECOVERY_REQUIRED"
      ) {
        humanOrganizationDeferredUntilWake.add(operation.operationId);
        return;
      }
      store.complete(operation.operationId, {
        ok: false,
        error: result.error,
      });
    } catch {
      scheduleHumanOrganizationRetry(operation.operationId, 5_000);
    }
  })();
  humanOrganizationTasks.set(operationId, task);
  void task.finally(() => {
    if (humanOrganizationTasks.get(operationId) === task) {
      humanOrganizationTasks.delete(operationId);
    }
    refillHumanOrganizationProvisioning();
  }).catch(() => undefined);
  return true;
}

function refillHumanOrganizationProvisioning(): void {
  if (
    humanOrganizationRefilling ||
    humanOrganizationProvisioningStopping ||
    humanOrganizationOperations === null ||
    humanAccountService === null ||
    currentHumanCredentialGeneration === null
  ) {
    return;
  }
  humanOrganizationRefilling = true;
  try {
    let after: HumanOrganizationOperationCursor | undefined;
    while (
      humanOrganizationTasks.size < HUMAN_ORGANIZATION_PROVISIONING_CONCURRENCY
    ) {
      const page = humanOrganizationOperations.startedPage({
        ...(after === undefined ? {} : { after }),
        limit: 100,
      });
      for (const operation of page.operations) {
        if (
          humanOrganizationTasks.size >=
            HUMAN_ORGANIZATION_PROVISIONING_CONCURRENCY
        ) {
          return;
        }
        startHumanOrganizationProvisioning(operation.operationId);
      }
      if (page.nextCursor === null) return;
      after = page.nextCursor;
    }
  } finally {
    humanOrganizationRefilling = false;
  }
}

function wakeHumanOrganizationProvisioning(): void {
  humanOrganizationDeferredUntilWake.clear();
  refillHumanOrganizationProvisioning();
}

async function stopHumanOrganizationProvisioning(): Promise<void> {
  humanOrganizationProvisioningStopping = true;
  for (const timer of humanOrganizationRetryTimers.values()) {
    clearTimeout(timer);
  }
  humanOrganizationRetryTimers.clear();
  await Promise.allSettled([...humanOrganizationTasks.values()]);
  humanOrganizationTasks.clear();
  humanOrganizationDeferredUntilWake.clear();
}

function releaseLocalRunCapacity(runId: string): boolean {
  const store = localRunExecutionStore;
  if (store !== null && !store.releaseCapacity(runId)) return false;
  dispatchAccountReservations?.releaseRun(runId);
  return true;
}

async function revokeLocalRun(
  runId: string,
  reason: DispatchRevocationReason,
): Promise<void> {
  const revocations = localDispatchRevocations;
  if (revocations === null) return;
  await revocations.revoke(runId, reason);
  const binding = localRunExecutionStore?.read(runId);
  if (
    binding !== null
    && binding !== undefined
    && (
      binding.stage === "completed"
      || binding.stage === "failed"
      || binding.stage === "cancelled"
      || binding.stage === "lease_lost"
    )
  ) {
    releaseLocalRunCapacity(runId);
  }
}

async function initializeDispatchRunner(
  options: DispatchRunnerRuntimeContext & {
    readonly authorization?: HRARunnerAuthorization;
    readonly repositoryMappings?: readonly DispatchRepositoryMapping[];
    readonly binding: DispatchRunnerBinding;
    readonly onHeartbeatAccepted?: () => void | Promise<void>;
  },
): Promise<void> {
  publishWithDrainRetry({ type: "runner.changed", runner: { state: "connecting" } });
  try {
    const authorization = options.authorization ??
      await recoverPairedDispatchAuthorization();
    if (authorization === null) {
      publishWithDrainRetry({ type: "runner.changed", runner: { state: "notPaired" } });
      return;
    }

    const store = new DispatchStore(options.controlPlane);
    const interactionStore = new DispatchInteractionStore(options.controlPlane);
    const dispatcherPaths = accountPaths(
      options.assets,
      join(dirname(options.controlPlanePath), "dispatch", "codex-home"),
    );
    const broker = new WorkspaceBroker({
      git: bundledGitRunner(dispatcherPaths),
      identityStore: store,
      lanesRoot: join(dirname(options.controlPlanePath), "dispatch", "worktrees"),
    });
    const mappings = await configureDispatchRepositories({
      database: options.controlPlane,
      broker,
      store,
      mappings: options.repositoryMappings ??
        parseDispatchRepositoryMappings(),
    });
    if (mappings.length === 0) {
      publishWithDrainRetry({
        type: "runner.changed",
        runner: { state: "attention", reason: "noRepository" },
      });
    }
    const capabilities = new LocalDispatchCapabilities({
      accountReservations: options.accountReservations,
      accounts: options.accounts,
      onRunReleased: (runId) => {
        store.releaseDispatchCapacity(runId);
        interactionStore.deleteRun(runId);
      },
      recoveredReservations: store.dispatchCapacityReservations(),
      repositories: mappings,
    });
    const installation = new DispatchRunnerInstallationStore(options.controlPlane);
    const boot = installation.startBoot();
    const runnerPublicId = options.binding.kind === "hra"
      ? scopedDispatchRunnerId(
          boot.installationId,
          `promotion:${options.binding.promotionId}`,
        )
      : boot.runnerId;
    const interactionReplyKey = await createRunInteractionReplyKeyPair();
    const cloud = new HRADispatchHttpClient(authorization);
    const revocations = createDispatchRevocationCoordinator({
      capabilities,
      sessions: {
        interruptGatewayThread: (threadId) => options.sessions.interruptGatewayThread(threadId),
        stopGatewayAccount: (accountProfileId) => options.accounts.stopDispatchAccount(accountProfileId),
      },
      store,
    });
    const launcher = new SessionDispatchLauncher(options.sessions);
    let coordinator: DispatchCoordinator | null = null;
    const runner = new HRADispatchRunner({
      identity: {
        runnerId: runnerPublicId,
        installationId: boot.installationId,
        bootId: boot.bootId,
        bootGeneration: boot.bootGeneration,
        clientVersion: hraReleaseIdentity.version,
      },
      cloud,
      capabilities,
      heartbeatJournal: installation,
      outbox: store,
      interactions: {
        syncOnce: (runIds, signal) => dispatchInteractionAdapter?.syncOnce(runIds, signal) ?? Promise.resolve("ok"),
      },
      revocations,
      executor: {
        execute: async (assignment, signal) => {
          if (coordinator === null) throw new Error("Dispatch coordinator is unavailable");
          return await coordinator.execute(assignment, signal);
        },
      },
      initialHeartbeatSequence: boot.initialHeartbeatSequence,
      onRunnerStatus: (status) => {
        if (status === "contended" || status === "unavailable") {
          publishWithDrainRetry({
            type: "runner.changed",
            runner: { state: "attention", reason: "connection" },
          });
        }
      },
      onHeartbeatAccepted: async (input) => {
        installation.acknowledgeHeartbeat(input);
        await options.onHeartbeatAccepted?.();
        publishWithDrainRetry({
          type: "runner.changed",
          runner: mappings.length === 0
            ? { state: "attention", reason: "noRepository" }
            : { state: "connected" },
        });
      },
      onRunTerminalAcknowledged: (runId) => {
        capabilities.releaseRun(runId);
      },
    });
    coordinator = new DispatchCoordinator({
      fence: runner.fence,
      launcher,
      publication: runner,
      store,
      workspaces: broker,
    });
    const completion = new DispatchCompletionAdapter({
      cloud,
      fence: runner.fence,
      publication: runner,
      store,
    });
    const activity = new DispatchActivityAdapter({
      fence: runner.fence,
      store,
    });
    dispatchActivityAdapter = activity;
    dispatchInteractionAdapter = new DispatchInteractionAdapter({
      activity,
      bindings: store,
      cloud,
      fence: runner.fence,
      identity: {
        runnerId: runnerPublicId,
        bootId: boot.bootId,
        bootGeneration: boot.bootGeneration,
      },
      interactions: interactionStore,
      replyKey: interactionReplyKey,
      sessions: options.sessions,
    });
    dispatchCompletionAdapter = completion;
    dispatchCompletionRetryTimer = setInterval(() => completion.retryPending(), 5_000);

    const controller = new AbortController();
    dispatchRunnerController = controller;
    dispatchRunnerBinding = options.binding;
    dispatchRunnerRunning = true;
    const runnerTask = runner.run(controller.signal)
      .then((exit) => {
        if (!controller.signal.aborted && exit.kind === "halted") {
          publishWithDrainRetry({
            type: "runner.changed",
            runner: { state: "attention", reason: "configuration" },
          });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          publishWithDrainRetry({
            type: "runner.changed",
            runner: { state: "attention", reason: "connection" },
          });
        }
      });
    dispatchRunnerTask = runnerTask;
    void runnerTask.finally(() => {
      if (dispatchRunnerTask !== runnerTask) return;
      dispatchRunnerRunning = false;
      if (!controller.signal.aborted && options.binding.kind === "hra") {
        wakeHRARunnerPairing();
      }
    });
  } catch {
    // Dispatch is an optional outbound capability. Invalid or absent pairing
    // leaves the local account connector available and cloud readiness
    // expires naturally instead of failing the entire desktop control plane.
    dispatchRunnerController = null;
    dispatchRunnerTask = null;
    dispatchRunnerBinding = null;
    dispatchRunnerRunning = false;
    dispatchActivityAdapter = null;
    dispatchInteractionAdapter = null;
    dispatchCompletionAdapter = null;
    if (dispatchCompletionRetryTimer !== null) clearInterval(dispatchCompletionRetryTimer);
    dispatchCompletionRetryTimer = null;
    publishWithDrainRetry({
      type: "runner.changed",
      runner: { state: "attention", reason: "configuration" },
    });
  }
}

async function shutdownDispatchRunner(): Promise<void> {
  if (dispatchCompletionRetryTimer !== null) clearInterval(dispatchCompletionRetryTimer);
  dispatchCompletionRetryTimer = null;
  const completion = dispatchCompletionAdapter;
  const activity = dispatchActivityAdapter;
  dispatchCompletionAdapter = null;
  dispatchActivityAdapter = null;
  dispatchInteractionAdapter = null;
  completion?.retryPending();
  await activity?.settled();
  await completion?.settled();
  const controller = dispatchRunnerController;
  const task = dispatchRunnerTask;
  dispatchRunnerController = null;
  dispatchRunnerTask = null;
  dispatchRunnerBinding = null;
  dispatchRunnerRunning = false;
  controller?.abort();
  if (task !== null) await task;
}

function hraRunnerInput(
  pairing: LocalRunnerPairingRecord,
): HRARunnerPairingInput {
  return {
    promotionId: pairing.promotionId,
    destinationWorkspaceId: pairing.cloudWorkspaceId,
    importedAgentId: `imported_local_codex_${pairing.promotionId}`,
  };
}

function hraPairingRetryDue(
  pairing: LocalRunnerPairingRecord,
  now: number,
): boolean {
  if (pairing.state !== "blocked") return true;
  const exponent = Math.min(pairing.attemptCount, 6);
  const delay = Math.min(60_000, 1_000 * (2 ** exponent));
  return now >= pairing.updatedAt + delay;
}

async function projectHRARunnerCredentialRecovery(
  pairing: LocalRunnerPairingRecord,
  code: HRARunnerPairingFailureCode,
): Promise<boolean> {
  if (!runnerPairingFailureMayRequireCredentialRecovery(code)) return false;
  // A stable-process inspection cache is only an optimization. Exact terminal
  // custody failures can indicate that Keychain material changed after the
  // cached observation. Reinspect to distinguish local corruption from the
  // same code used for remote response-binding failures.
  hraRunnerPairingInspections.evict(pairing);
  const coordinator = hraRunnerPairingCoordinator;
  if (coordinator === null) return false;
  const inspection = await coordinator.inspectCredentialReconnect(
    hraRunnerInput(pairing),
  );
  if (!inspection.ok || inspection.state !== "required") return false;
  await humanAccountService?.requireLegacyCredentialReconnect();
  return true;
}

async function reconcileHRARunnerPairing(): Promise<void> {
  const coordinator = hraRunnerPairingCoordinator;
  const installationId = hraRunnerPairingInstallationId;
  const runtime = hraRunnerPairingRuntime;
  const promotionStore = localPromotionStore;
  const tasks = localTaskStore;
  if (
    coordinator === null ||
    installationId === null ||
    runtime === null ||
    promotionStore === null ||
    tasks === null
  ) {
    return;
  }

  const pairings = promotionStore.runnerPairingsForInstallation(
    installationId,
  );
  for (const pairing of pairings) {
    if (hraRunnerPairingInspections.hasCurrent(pairing)) continue;
    const inspection = await coordinator.inspectLegacyCredentialReconnect(
      hraRunnerInput(pairing),
    );
    if (!inspection.ok) {
      await projectHRARunnerCredentialRecovery(
        pairing,
        inspection.error.code,
      );
      return;
    }
    if (inspection.state === "required") {
      await humanAccountService?.requireLegacyCredentialReconnect();
      return;
    }
    hraRunnerPairingInspections.record(pairing);
  }
  const target = pairings[0];
  for (const conflict of pairings.slice(1)) {
    if (
      conflict.state === "blocked" &&
      conflict.faultCode === "installation_runner_already_bound"
    ) {
      continue;
    }
    promotionStore.markPairingState({
      cloudWorkspaceId: conflict.cloudWorkspaceId,
      promotionId: conflict.promotionId,
      state: "blocked",
      faultCode: "installation_runner_already_bound",
      now: Date.now(),
    });
  }

  if (target === undefined) {
    if (dispatchRunnerBinding === null && !dispatchRunnerRunning) {
      await initializeDispatchRunner({
        ...runtime,
        binding: { kind: "taskctl" },
      });
    }
    return;
  }

  const targetBinding: DispatchRunnerBinding = {
    kind: "hra",
    promotionId: target.promotionId,
    cloudWorkspaceId: target.cloudWorkspaceId,
  };
  if (
    dispatchRunnerRunning &&
    dispatchRunnerBinding?.kind === "hra" &&
    dispatchRunnerBinding.promotionId === target.promotionId &&
    dispatchRunnerBinding.cloudWorkspaceId === target.cloudWorkspaceId
  ) {
    return;
  }
  if (!hraPairingRetryDue(target, Date.now())) return;

  const input = hraRunnerInput(target);
  let recovered = await coordinator.recoverAuthorization(input, {
    abandonMissingPending: true,
  });
  if (
    !recovered.ok &&
    await projectHRARunnerCredentialRecovery(target, recovered.error.code)
  ) {
    return;
  }
  if (!recovered.ok && recovered.error.code === "not_paired") {
    const paired = await coordinator.pair(input);
    if (!paired.ok) {
      await projectHRARunnerCredentialRecovery(target, paired.error.code);
      return;
    }
    recovered = await coordinator.readAuthorization(input);
  }
  if (!recovered.ok) {
    await projectHRARunnerCredentialRecovery(target, recovered.error.code);
    return;
  }

  const mappings = tasks
    .workspaceRepositoryProbeCandidates(target.sourceWorkspaceId)
    .map((candidate) => ({
      repositoryId: candidate.repositoryId,
      repositoryPath: candidate.canonicalRepositoryPath,
    }));
  await shutdownDispatchRunner();
  await initializeDispatchRunner({
    ...runtime,
    authorization: recovered.authorization,
    binding: targetBinding,
    repositoryMappings: mappings,
    onHeartbeatAccepted: () => {
      const active = dispatchRunnerBinding;
      if (
        active?.kind !== "hra" ||
        active.promotionId !== target.promotionId ||
        active.cloudWorkspaceId !== target.cloudWorkspaceId
      ) {
        return;
      }
      promotionStore.markPairingState({
        cloudWorkspaceId: target.cloudWorkspaceId,
        promotionId: target.promotionId,
        state: "paired",
        faultCode: null,
        now: Date.now(),
      });
      publishWithDrainRetry({
        type: "task.invalidated",
        invalidation: {
          workspaceId: target.cloudWorkspaceId,
          projectionRevision: 1,
          scope: "workspace",
        },
      });
    },
  });
}

function wakeHRARunnerPairing(): void {
  if (hraRunnerPairingRuntime === null) return;
  if (hraRunnerPairingRecoveryActive) {
    hraRunnerPairingWakeQueued = true;
    return;
  }
  if (hraRunnerPairingTask !== null) {
    hraRunnerPairingWakeQueued = true;
    return;
  }
  hraRunnerPairingWakeQueued = false;
  const task = reconcileHRARunnerPairing().catch(() => undefined);
  hraRunnerPairingTask = task;
  void task.finally(() => {
    if (hraRunnerPairingTask !== task) return;
    hraRunnerPairingTask = null;
    if (hraRunnerPairingWakeQueued) wakeHRARunnerPairing();
  });
}

async function confirmLegacyRunnerCredentialReconnect(): Promise<
  | Readonly<{ ok: true; deferred: boolean }>
  | Readonly<{
      ok: false;
      message: string;
      retryable: boolean;
    }>
> {
  if (hraRunnerPairingRecoveryActive) {
    return {
      ok: false,
      message: "Runner credential recovery is already in progress.",
      retryable: true,
    };
  }
  if (hraRunnerPairingRecoveryState === "initializing") {
    return {
      ok: false,
      message: "Runner credential recovery is still initializing.",
      retryable: true,
    };
  }
  if (hraRunnerPairingRecoveryState === "configuration_required") {
    return { ok: true, deferred: true };
  }
  const coordinator = hraRunnerPairingCoordinator;
  const installationId = hraRunnerPairingInstallationId;
  const promotionStore = localPromotionStore;
  if (coordinator === null) {
    return { ok: true, deferred: false };
  }
  if (installationId === null || promotionStore === null) {
    return {
      ok: false,
      message: "Runner credential recovery is still initializing.",
      retryable: true,
    };
  }
  hraRunnerPairingRecoveryActive = true;
  try {
    await hraRunnerPairingTask;
    const pairings = promotionStore.runnerPairingsForInstallation(
      installationId,
    );
    const required: LocalRunnerPairingRecord[] = [];
    for (const pairing of pairings) {
      const inspection = await coordinator.inspectLegacyCredentialReconnect(
        hraRunnerInput(pairing),
      );
      if (!inspection.ok) {
        return {
          ok: false,
          message: inspection.error.message,
          retryable: inspection.error.retryable,
        };
      }
      if (inspection.state === "required") required.push(pairing);
    }
    if (
      required.some((pairing) =>
        dispatchRunnerBinding?.kind === "hra" &&
        dispatchRunnerBinding.promotionId === pairing.promotionId &&
        dispatchRunnerBinding.cloudWorkspaceId === pairing.cloudWorkspaceId
      )
    ) {
      await shutdownDispatchRunner();
      hraRunnerPairingWakeQueued = true;
    }
    for (const pairing of required) {
      const recovered = await coordinator.confirmLegacyCredentialReconnect(
        hraRunnerInput(pairing),
      );
      if (!recovered.ok) {
        return {
          ok: false,
          message: recovered.error.message,
          retryable: recovered.error.retryable,
        };
      }
    }
    return { ok: true, deferred: false };
  } finally {
    hraRunnerPairingRecoveryActive = false;
    if (hraRunnerPairingWakeQueued) wakeHRARunnerPairing();
  }
}

function startHRARunnerPairing(options: {
  readonly coordinator: HRARunnerPairingCoordinator;
  readonly installationId: string;
  readonly runtime: DispatchRunnerRuntimeContext;
}): void {
  hraRunnerPairingCoordinator = options.coordinator;
  hraRunnerPairingInstallationId = options.installationId;
  hraRunnerPairingRuntime = options.runtime;
  hraRunnerPairingRecoveryState = "ready";
  hraRunnerPairingInspections.clear();
  if (hraRunnerPairingTimer !== null) {
    clearInterval(hraRunnerPairingTimer);
  }
  hraRunnerPairingTimer = setInterval(wakeHRARunnerPairing, 2_000);
  wakeHRARunnerPairing();
}

async function shutdownHRARunnerPairing(): Promise<void> {
  if (hraRunnerPairingTimer !== null) {
    clearInterval(hraRunnerPairingTimer);
  }
  hraRunnerPairingTimer = null;
  hraRunnerPairingRuntime = null;
  hraRunnerPairingCoordinator = null;
  hraRunnerPairingInstallationId = null;
  hraRunnerPairingWakeQueued = false;
  hraRunnerPairingRecoveryActive = false;
  hraRunnerPairingRecoveryState = "initializing";
  hraRunnerPairingInspections.clear();
  const task = hraRunnerPairingTask;
  hraRunnerPairingTask = null;
  await task;
}

async function shutdownLocalTaskAuthority(): Promise<void> {
  if (localCompletionRetryTimer !== null) clearInterval(localCompletionRetryTimer);
  if (localClaimRenewalTimer !== null) clearInterval(localClaimRenewalTimer);
  localCompletionRetryTimer = null;
  localClaimRenewalTimer = null;
  const reconciler = localTaskReconciler;
  const executor = localQueuedRunExecutor;
  const activity = localDispatchActivityAdapter;
  const completion = localRunCompletionAdapter;
  localTaskReconciler = null;
  localQueuedRunExecutor = null;
  localDispatchActivityAdapter = null;
  localRunCompletionAdapter = null;
  localRunInteractionAdapter = null;
  localDispatchRevocations = null;
  localProjectOnboardingService = null;
  localProjectOnboardingInstallationId = null;
  try {
    await reconciler?.stop(() => executor?.stop());
  } catch {
    // A later boot recovers every unsettled durable claim under a new fence.
  }
  // This is intentionally idempotent. It also covers partial initialization
  // where an executor exists without a reconciler or the stop hook faulted.
  await executor?.stop();
  await activity?.settled();
  await completion?.settled();
  localRunExecutionStore = null;
  localRepositoryReadiness = null;
  dispatchAccountReservations = null;
  localTaskStore = null;
}

async function shutdownLocalPromotions(): Promise<void> {
  const coordinator = localPromotionCoordinator;
  localPromotionCoordinator = null;
  try {
    await coordinator?.stop();
  } finally {
    localPromotionStore = null;
  }
}

async function shutdownSessionSync(): Promise<void> {
  const coordinator = sessionSyncCoordinator;
  sessionSyncCoordinator = null;
  await coordinator?.stop();
}

function publishWithDrainRetry(event: Parameters<RuntimeProjection['publish']>[0]): void {
  // Capacity is a waitable condition, not a reason to synchronously retry.
  // In particular, snapshot capture intentionally pauses the drain; a second
  // direct publish there could still throw and lose the caller's event. The
  // coordinator preserves admission order and waits until real capacity is
  // available without adding another unbounded event buffer.
  void projectionCommits.publish(event).catch((error: unknown) => {
    if (
      projectionCommitAdmissionClosing &&
      error instanceof ProjectionCoordinatorClosedError
    ) return;

    // A non-capacity commit failure means the renderer projection can no
    // longer be trusted. Crash the gateway so the native supervisor performs
    // its bounded restart and rehydrates the projection from durable state.
    queueMicrotask(() => {
      throw error;
    });
  });
}

async function publishChatPane(pane: ChatPaneProjection): Promise<void> {
  const delivery = runtimeChatPaneUpsertEventOrInvalidation(
    projection.lastSequence + 1,
    pane,
  );
  if (delivery.type === "chat.pane.upserted") {
    await projectionCommits.publish(delivery);
    return;
  }
  await projectionCommits.installRecoverableState({
    type: "chat.pane.upserted",
    revision: pane.revision,
    pane,
  });
}

async function publishChatPaneState(pane: ChatPaneProjection): Promise<void> {
  const delivery = runtimeChatPaneStateChangedEvent(
    projection.lastSequence + 1,
    pane,
  );
  if (delivery.type === "chat.pane.stateChanged") {
    await projectionCommits.publish(delivery);
    return;
  }
  await projectionCommits.installRecoverableState({
    type: "chat.pane.stateChanged",
    revision: pane.revision,
    pane: runtimeChatPaneStateProjection(pane),
  });
}

async function publishChatDelta(
  event: Extract<
    Parameters<RuntimeProjection["publish"]>[0],
    { readonly type: "chat.turn.delta" }
  >,
): Promise<void> {
  try {
    await projectionCommits.publish(event);
  } catch (error: unknown) {
    if (!(error instanceof ProjectionPayloadLimitError)) throw error;
    await projectionCommits.installRecoverableState(event);
  }
}

async function rejectUnsupportedServerRequest(
  router: AccountRuntimeRouter,
  accountProfileId: string,
  request: CodexServerRequest,
): Promise<void> {
  await router.respond(accountProfileId, request, {
    type: "error",
    ...unsupportedServerRequestError,
  });
}

async function gitVersionFor(assets: PortableRuntimeAssets): Promise<string> {
  const child = Bun.spawn([assets.gitBinary, "--version"], {
    env: { PATH: `${assets.gitRoot}/bin:/usr/bin:/bin` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error("Bundled Git failed its version probe");
  const match = /^git version (?<version>\S+)\s*$/u.exec(stdout);
  if (match?.groups?.version !== runtimeVersions.git.version) {
    throw new Error("Bundled Git version does not match the pin");
  }
  return match.groups.version;
}

type WorktreeRepairContext = Omit<
  ApplicationSupportWorktreeRepairOptions,
  "database" | "onCheckpoint"
>;

function openWorktreeRepairDatabase(databasePath: string): Database {
  const repairDatabase = new Database(databasePath, {
    create: false,
    readwrite: true,
    strict: true,
  });
  try {
    repairDatabase.exec("PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;");
    return repairDatabase;
  } catch (error: unknown) {
    repairDatabase.close();
    throw error;
  }
}

function finalizeWorktreeRepairDatabase(repairDatabase: Database): void {
  try {
    checkpointControlPlaneForApplicationSupportCutover(repairDatabase);
  } finally {
    repairDatabase.close();
  }
}

async function worktreeRepairRollbackIsSafe(
  error: unknown,
  targetRoot: string,
): Promise<boolean> {
  if (
    error instanceof ApplicationSupportWorktreeRepairError
    && !error.rollbackSafe
  ) {
    return false;
  }
  try {
    return (await inspectApplicationSupportWorktreeRepair(targetRoot)).rollbackSafe;
  } catch {
    return false;
  }
}

const registeredChatRepositoryIdentitySchema = z.object({
  canonical_git_common_dir: z.string().min(1).max(4_096),
  canonical_repository_path: z.string().min(1).max(4_096),
}).strict().nullable();

type ChatRepositoryInspector = Pick<WorkspaceBroker, "inspectRepository">;

function registeredChatRepositoryIdentity(
  controlPlane: Database,
  repositoryId: string,
): z.infer<typeof registeredChatRepositoryIdentitySchema> {
  const value: unknown = controlPlane.query(`
    SELECT canonical_repository_path, canonical_git_common_dir
    FROM local_repositories
    WHERE repository_id = ?1 AND tombstoned_at IS NULL
    LIMIT 1
  `).get(repositoryId);
  return registeredChatRepositoryIdentitySchema.parse(value);
}

async function resolveChatRepository(
  store: LocalTaskStore,
  controlPlane: Database,
  inspector: ChatRepositoryInspector,
  repositoryId: string,
): Promise<Readonly<{
  id: string;
  name: string;
  workingDirectory: string;
}> | null> {
  const repository = store.chatRepositoryRuntime(repositoryId);
  if (repository === null) return null;
  const registered = registeredChatRepositoryIdentity(
    controlPlane,
    repository.id,
  );
  if (
    registered === null
    || registered.canonical_repository_path !==
      repository.canonicalRepositoryPath
  ) return null;
  try {
    const inspected = await inspector.inspectRepository(
      repository.canonicalRepositoryPath,
    );
    if (
      inspected.canonicalRepositoryPath !==
        registered.canonical_repository_path
      || inspected.canonicalGitCommonDir !==
        registered.canonical_git_common_dir
    ) return null;

    const currentRepository = store.chatRepositoryRuntime(repository.id);
    const currentRegistered = registeredChatRepositoryIdentity(
      controlPlane,
      repository.id,
    );
    if (
      currentRepository === null
      || currentRegistered === null
      || currentRepository.canonicalRepositoryPath !==
        repository.canonicalRepositoryPath
      || currentRegistered.canonical_repository_path !==
        registered.canonical_repository_path
      || currentRegistered.canonical_git_common_dir !==
        registered.canonical_git_common_dir
    ) return null;
  } catch {
    return null;
  }
  return {
    id: repository.id,
    name: repository.name,
    workingDirectory: repository.canonicalRepositoryPath,
  };
}

async function initializeGateway(): Promise<void> {
  let initializingService: AccountService | null = null;
  let initializingSessionService: SessionService | null = null;
  let initializingChatService: ChatService | null = null;
  let initializingHarness: HarnessProductionCompositionV2 | null = null;
  let initializingHarnessBound = false;
  let applicationSupport: ApplicationSupportStartup | null = null;
  let assets: PortableRuntimeAssets | null = null;
  let worktreeRepairContext: WorktreeRepairContext | null = null;
  let worktreeRepairDatabase: Database | null = null;
  let worktreeRepairNeedsReverse = false;
  let preserveForwardOnlyCutover = false;
  try {
    // Native v2 custody must resolve any fixed v1 migration before the Harness
    // graph can initialize or generate a replacement installation master.
    await nativeHarnessKeyCustody.ensureMigrated();
    const initializingHarnessKeyCustody = new HarnessInstallKeyCustody({
      secrets: nativeHarnessKeyCustody,
    });
    const effectiveHome = userInfo().homedir;
    const expectedDatabasePath = defaultControlPlanePath();
    preflightControlPlaneRelease(
      expectedDatabasePath,
      hraReleaseIdentity,
    );
    applicationSupport = prepareApplicationSupportMigration({
      environment: { HOME: effectiveHome },
    });
    const databasePath = controlPlanePathFromApplicationSupportRoot(applicationSupport.root);
    if (databasePath !== expectedDatabasePath) {
      throw new Error(
        "Application Support resolved a different control-plane database path.",
      );
    }
    preflightControlPlaneRelease(databasePath, hraReleaseIdentity);
    applicationSupport.prepareTargetRoot();

    const migratedFromRoot = applicationSupport.migratedFromRoot;
    if (
      migratedFromRoot !== null
      && !applicationSupport.activated
      && applicationSupport.hasControlPlaneDatabase()
    ) {
      assets = resolvePortableRuntimeAssets();
      await gitVersionFor(assets);
      worktreeRepairContext = {
        legacyRoot: migratedFromRoot,
        targetRoot: applicationSupport.root,
        git: bundledGitRunner({
          ...assets,
          codexHome: join(applicationSupport.root, "dispatch", "codex-home"),
        }),
      };
      worktreeRepairDatabase = openWorktreeRepairDatabase(databasePath);
      try {
        const result = await repairMovedApplicationSupportWorktrees({
          ...worktreeRepairContext,
          database: worktreeRepairDatabase,
        });
        preserveForwardOnlyCutover = result.irreversibleForward;
        worktreeRepairNeedsReverse = !result.irreversibleForward;
      } catch (error: unknown) {
        if (
          await worktreeRepairRollbackIsSafe(
            error,
            applicationSupport.root,
          )
        ) {
          worktreeRepairNeedsReverse = true;
        } else {
          preserveForwardOnlyCutover = true;
        }
        throw error;
      }
      try {
        finalizeWorktreeRepairDatabase(worktreeRepairDatabase);
      } catch (error: unknown) {
        worktreeRepairNeedsReverse = false;
        preserveForwardOnlyCutover = true;
        throw error;
      } finally {
        worktreeRepairDatabase = null;
      }
    }

    applicationSupport.activate();
    worktreeRepairContext = null;
    worktreeRepairNeedsReverse = false;
    preserveForwardOnlyCutover = false;
    lifetimeLock = acquireControlPlaneLifetimeLock(databasePath);
    recoverInterruptedControlPlaneRestore(databasePath);
    database = openControlPlane(databasePath, {
      releaseIdentity: hraReleaseIdentity,
    });
    const accountFileSystemAuthority =
      lifetimeLock.bindControlPlane();
    const operationReceiptKey = loadOrCreateOperationReceiptKey(
      operationReceiptKeyPath(databasePath),
    );
    operationReceipts = new OperationReceiptStore(database, operationReceiptKey);
    operationReceipts.purgeTransientSecretReceipts();
    operationReceipts.recoverInterrupted();
    cloudHumanOperations = new CloudHumanOperationStore(
      database,
      operationReceiptKey,
    );
    cloudInvalidationHeads = new CloudInvalidationHeadStore(database);
    humanOrganizationOperations = new HumanOrganizationOperationStore(database);
    humanOrganizationProvisioningStopping = false;
    const humanMetadata = new HumanAccountMetadataStore({ database });
    const humanRuntime = createHumanAccountRuntime({
      configuration: parseHRACloudConfiguration(process.env),
      metadata: humanMetadata,
      emit: (snapshot) => {
        const availability = cloudAttachmentAvailability;
        if (availability !== null) {
          publishHumanAccountSnapshot(snapshot, availability);
        }
      },
      openBrowser: async (url) => {
        await new WorkOsExternalUrlOpener().open(url);
      },
    });
    cloudAttachmentAvailability = humanRuntime.availability;
    cloudWorkspaceClient = humanRuntime.cloud;
    humanAccountService = humanRuntime.account;
    if (
      humanRuntime.availability.state === "enabled"
      && humanRuntime.session !== null
    ) {
      const syncStore = new SessionSyncStore(database);
      const syncCoordinator = new SessionSyncCoordinator({
        store: syncStore,
        journal: new SessionSyncOperationJournal(database),
        keyCustody: new SessionSyncKeyCustody(),
        recoveryCustody: new SessionSyncRecoveryKeyCustody(),
        client: new SessionSyncBearerClient({
          session: humanRuntime.session,
          transport: new SessionSyncHttpTransport({
            apiUrl: humanRuntime.availability.apiOrigin,
          }),
          calibration: {
            load: () => {
              const value = syncStore.clockCalibration();
              return value === null
                ? null
                : {
                    serverObservedAt: value.serverObservedAt,
                    clientObservedAt: value.clientObservedAt,
                    uncertaintyMs: value.uncertaintyMs,
                  };
            },
            save: (value) => {
              const current = syncStore.clockCalibration();
              syncStore.recordClockCalibration({
                expectedRevision: current?.revision ?? null,
                ...value,
                now: Date.now(),
              });
            },
          },
        }),
        projection: {
          publish: (event) => {
            publishWithDrainRetry(
              event as Parameters<RuntimeProjection["publish"]>[0],
            );
          },
        },
        cloudConfigured: true,
        humanScope: () => ({
          credentialGeneration: currentHumanCredentialGeneration ?? 0,
          signedIn: currentHumanCredentialGeneration !== null,
          userId: currentHumanUserId,
          organizationId: currentHumanOrganizationId,
        }),
      });
      sessionSyncCoordinator = syncCoordinator;
    }
    const localInstallation =
      new DispatchRunnerInstallationStore(database).startBoot();
    const initializingLocalTaskStore =
      new LocalTaskStore(database, operationReceiptKey);
    localTaskStore = initializingLocalTaskStore;
    const initializingPromotionStore = new LocalPromotionV2Store(database);
    localPromotionStore = initializingPromotionStore;
    if (
      humanRuntime.availability.state === "enabled" &&
      humanRuntime.cloud !== null
    ) {
      hraRunnerPairingCoordinator =
        new HRARunnerPairingCoordinator({
          apiOrigin: humanRuntime.availability.apiOrigin,
          cloud: humanRuntime.cloud,
          metadata: humanMetadata,
          nameKey: operationReceiptKey,
          status: initializingPromotionStore,
        });
    }
    hraRunnerPairingInstallationId = localInstallation.installationId;
    hraRunnerPairingRecoveryState =
      hraRunnerPairingCoordinator !== null ||
        initializingPromotionStore.runnerPairingsForInstallation(
            localInstallation.installationId,
          ).length === 0
        ? "ready"
        : "configuration_required";
    if (
      humanRuntime.availability.state === "enabled" &&
      humanRuntime.session !== null
    ) {
      const transport = new HRAPromotionHttpTransport({
        apiUrl: humanRuntime.availability.apiOrigin,
        session: humanRuntime.session,
        idempotencyKeys: initializingPromotionStore,
      });
      const coordinator = new LocalPromotionCoordinator({
        store: initializingPromotionStore,
        transport,
      });
      localPromotionCoordinator = coordinator;
      coordinator.start();
    }
    initializingLocalTaskStore.registerInstallation(localInstallation.installationId);
    localProjectOnboardingInstallationId = localInstallation.installationId;
    const localDueWork = new LocalDueWorkStore(database);
    const localRuntimeBootId = createLocalRuntimeBootId();
    const localAuthorityCommands = new LocalTaskAuthorityCommandStore({
      database,
      tasks: initializingLocalTaskStore,
      onCommitted: ({ workspaceId, projectionRevision }) => {
        publishWithDrainRetry({
          type: "task.invalidated",
          invalidation: {
            workspaceId,
            projectionRevision,
            scope: "workspace",
          },
        });
      },
    });

    if (assets === null) {
      assets = resolvePortableRuntimeAssets();
      await gitVersionFor(assets);
    }
    portableRuntimeAssets = assets;
    activeControlPlanePath = databasePath;
    const localRepositoryInspector = new WorkspaceBroker({
      git: bundledGitRunner({
        ...assets,
        codexHome: join(dirname(databasePath), "onboarding", "codex-home"),
      }),
      lanesRoot: join(dirname(databasePath), "local-task-worktrees"),
    });
    localProjectOnboardingService = new ProjectOnboardingService({
      repositories: localRepositoryInspector,
      persistence:
        new LocalTaskStoreProjectOnboardingAdapter(initializingLocalTaskStore),
    });
    const initializingHarnessComposition =
      createHarnessProductionCompositionV2();
    initializingHarness = initializingHarnessComposition;
    let responseRouter: AccountRuntimeRouter | null = null;
    const sessionFactConsumer = {
      consumeCodexFacts: (facts: Parameters<
        SessionService["consumeCodexFacts"]
      >[0]): void => {
        initializingSessionService?.consumeCodexFacts(facts);
      },
    };
    const codexFactRouter = new CodexFactRouter({
      account: () => initializingService,
      session: () => initializingSessionService === null
        ? null
        : sessionFactConsumer,
      harness: () => initializingHarnessComposition.harnessFactConsumer,
    });
    const router = new AccountRuntimeRouter({
      dynamicToolCapability:
        initializingHarnessComposition.dynamicToolCapabilityResolver,
      callbacks: {
        onState: (accountProfileId, state, cause) => {
          if (
            (state.type === "stopped" || state.type === "failed") &&
            cause !== "capacity_evicted" && cause !== "router_shutdown"
          ) {
            void initializingChatService
              ?.handleAccountUnavailable(accountProfileId)
              .catch(() => undefined);
          }
          initializingService?.handleRuntimeState(accountProfileId, state);
          initializingSessionService?.handleRuntimeState(accountProfileId, state);
        },
        onNotification: async (accountProfileId, notification) => {
          await codexFactRouter.routeNotification(accountProfileId, notification);
        },
        onDiagnostic: () => undefined,
        onServerRequestExpired: async (accountProfileId, fault) => {
          initializingHarnessComposition.expireDynamicToolRequest(
            accountProfileId,
            fault,
          );
          await initializingSessionService?.handleServerRequestExpired(accountProfileId, fault);
        },
        onDynamicToolRequest: async (accountProfileId, request) => {
          await initializingHarnessComposition.handleDynamicToolRequest(
            accountProfileId,
            request,
          );
        },
        onServerRequest: async (accountProfileId, request) => {
          if (responseRouter === null) throw new Error("Account router is not ready");
          const handled = await initializingSessionService?.handleServerRequest(accountProfileId, request) ?? false;
          if (!handled) {
            await rejectUnsupportedServerRequest(responseRouter, accountProfileId, request);
          }
        },
      },
    });
    responseRouter = router;
    const profileStore = new AccountProfileStore(database);
    const initializingAccountProfileFileSystem =
      new NativeAccountProfileFileSystem({
        authority: accountFileSystemAuthority,
        deletionKey: operationReceiptKey,
        writeRequest: writeHost,
      });
    accountProfileFileSystem = initializingAccountProfileFileSystem;
    const initializedAccountService = new AccountService({
      assets,
      controlPlanePath: databasePath,
      emit: (event) => {
        if (event.type === "account.removed") {
          void initializingChatService
            ?.handleAccountUnavailable(event.accountProfileId)
            .catch(() => undefined);
          initializingSessionService?.purgeAccount(event.accountProfileId);
        }
        publishWithDrainRetry(event);
      },
      profileFileSystem: initializingAccountProfileFileSystem,
      router,
      store: profileStore,
    });
    initializingService = initializedAccountService;
    const sessionDispatchCallbacks = new SessionDispatchCallbackRouter({
      cloud: {
        activity: () => dispatchActivityAdapter,
        completion: () => dispatchCompletionAdapter,
        interactions: () => dispatchInteractionAdapter,
      },
      local: {
        activity: () => localDispatchActivityAdapter,
        completion: () => localRunCompletionAdapter,
        interactions: () => localRunInteractionAdapter,
      },
    });
    initializingSessionService = new SessionService({
      accounts: initializedAccountService,
      // Session/worktree/transcript state is gateway-internal. Its semantic
      // dispatch hooks remain live, but no session event enters the renderer
      // projection or native event transport.
      emit: () => undefined,
      onTurnActivity: async (event) => {
        await Promise.all([
          initializingChatService?.observeSessionActivity(event),
          sessionDispatchCallbacks.observeActivity(event),
        ]);
      },
      onAssistantItemCompletion: async (event) => {
        await initializingChatService?.observeSessionAssistantCompletion(event);
      },
      onToolItemStarted: async (event) => {
        await initializingChatService?.observeSessionToolItemStarted(event);
      },
      onReasoningItemCompletion: async (event) => {
        await initializingChatService?.observeSessionReasoningCompletion(event);
      },
      onTurnLifecycle: (event) => {
        initializingHarnessComposition.observeActorLifecycle(event);
        void initializingChatService?.observeSessionLifecycle(event)
          .catch(() => undefined);
        sessionDispatchCallbacks.observeLifecycle(event);
      },
      onInteractionRequest: async (event) => {
        if (
          await initializingChatService?.observeSessionInteractionRequest(event)
            === true
        ) {
          return null;
        }
        return await sessionDispatchCallbacks.observeInteractionRequest(event);
      },
      onInteractionExpired: (event) =>
        sessionDispatchCallbacks.observeInteractionExpired(event),
      onHydrationFailure: async ({ accountProfileId }) => {
        await initializedAccountService.execute({
          type: "runtime.restartAccount",
          accountProfileId,
        });
      },
      respondToServerRequest: async (accountProfileId, request, response) => {
        if (responseRouter === null) throw new Error("Account router is not ready");
        return await responseRouter.respond(accountProfileId, request, response);
      },
    });
    const initializedSessionService = initializingSessionService;
    const chatControlPlane = database;
    const initializingChatPaneStore = new ChatPaneStore(database);
    const initializingChatWorkspaceStore = new ChatWorkspaceStore(database);
    const initializingChatWorkspaceBroker = new WorkspaceBroker({
      git: bundledGitRunner({
        ...assets,
        codexHome: join(
          dirname(databasePath),
          "chat",
          "git-codex-home",
        ),
      }),
      identityStore: initializingChatWorkspaceStore,
      lanesRoot: join(dirname(databasePath), "chat-worktrees"),
    });
    const initializingChatWorkspaces = new ManagedChatWorkspaceService({
      broker: initializingChatWorkspaceBroker,
      store: initializingChatWorkspaceStore,
      panes: initializingChatPaneStore,
    });
    const chatProjection = Object.freeze({
      paneChanged: publishChatPane,
      paneStateChanged: publishChatPaneState,
      paneRemoved: async (paneId: string, revision: number) => {
        await projectionCommits.publish({
          type: "chat.pane.removed",
          paneId,
          revision,
        });
      },
      panesReordered: async (orderedPaneIds: readonly string[]) => {
        await projectionCommits.publish({
          type: "chat.panes.reordered",
          orderedPaneIds: [...orderedPaneIds],
        });
      },
      delta: publishChatDelta,
    });
    const chatRepositories = Object.freeze({
      resolve: (repositoryId: string) =>
        resolveChatRepository(
          initializingLocalTaskStore,
          chatControlPlane,
          localRepositoryInspector,
          repositoryId,
        ),
    });
    const harnessLifetimeLock = lifetimeLock;
    if (harnessLifetimeLock === null) {
      throw new Error("Harness lifetime authority is unavailable.");
    }
    const harnessGraph = createHarnessProductionGraphV2({
      accounts: initializedAccountService,
      chatProjection,
      composition: initializingHarnessComposition,
      controlPlanePath: databasePath,
      database,
      git: bundledGitRunner({
        ...assets,
        codexHome: join(
          dirname(databasePath),
          "harness",
          "v1",
          "scratch",
        ),
      }),
      lifetimeLock: harnessLifetimeLock,
      panes: initializingChatPaneStore,
      projection,
      rendererProjection: projectionCommits,
      repositories: chatRepositories,
      runtimes: router,
      sessions: initializedSessionService,
      keyCustody: initializingHarnessKeyCustody,
      onActorSessionRecoveryFatalFailure: requestGatewayGenerationRecovery,
      createChat: ({ harnessActors, harnessRoots }) => new ChatService({
        accounts: {
          refreshCandidates: async () =>
            await initializedAccountService.refreshChatAccountCandidates(),
          hasRateLimitProofSince: (accountProfileId, floor) =>
            initializedAccountService.hasRateLimitProofSince(
              accountProfileId,
              floor,
            ),
          containAmbiguousEffect: (accountProfileId) =>
            initializedAccountService.containAmbiguousChatEffect(
              accountProfileId,
            ),
        },
        harnessActors,
        harnessRoots,
        projection: chatProjection,
        provider: new CodexChatProvider(initializedSessionService),
        repositories: chatRepositories,
        runtimeRecovery: {
          requestRecovery: () => {
            // Both the provider interrupt and its account-generation fence
            // failed. The gateway can no longer prove that the old Codex
            // process is contained, so terminate this generation without
            // replaying the ambiguous turn. Native applies the bounded restart
            // policy and the fresh gateway rehydrates the durable attention
            // state before accepting an explicit next user message.
            requestGatewayGenerationRecovery(new Error(
              "Gateway recovery requested after an unfenced provider effect.",
            ));
          },
        },
        store: initializingChatPaneStore,
        workspaces: initializingChatWorkspaces,
      }),
    });
    initializingHarnessBound = true;
    harnessProductionComposition = initializingHarnessComposition;
    initializingChatService = harnessGraph.chat;
    await initializedAccountService.initialize();
    await initializingHarnessComposition.initialize();
    chatService = harnessGraph.chat;
    if (initializingSessionService === null) {
      throw new Error("Session service did not initialize");
    }
    const localAccounts = initializedAccountService;
    const localSessions = initializingSessionService;
    const localSessionLauncher = new SessionDispatchLauncher(localSessions);
    accountService = initializedAccountService;

    const initializingLocalExecutionStore = new LocalRunExecutionStore({
      database,
      onChanged: (change) => localTaskChanges.accept(change),
    });
    localRunExecutionStore = initializingLocalExecutionStore;
    initializingLocalExecutionStore.recoverAnsweredInteractionsOnRestart();
    initializingLocalExecutionStore.reconcileRetainedTerminalCapacityOnRestart();

    const recoveredCloudReservations =
      new DispatchStore(database).dispatchCapacityReservations();
    const initializingReservations = new DispatchAccountReservationArbiter({
      accounts: initializingService,
      recoveredReservations: [
        ...recoveredCloudReservations,
        ...initializingLocalExecutionStore.capacityReservations(),
      ],
    });
    dispatchAccountReservations = initializingReservations;
    const localDispatchPaths = accountPaths(
      assets,
      join(dirname(databasePath), "local-task-dispatch", "codex-home"),
    );
    const localWorkspaceBroker = new WorkspaceBroker({
      git: bundledGitRunner(localDispatchPaths),
      identityStore: initializingLocalExecutionStore,
      lanesRoot: join(dirname(databasePath), "local-task-worktrees"),
    });
    localRepositoryReadiness = new LocalRepositoryReadiness({
      inspector: localWorkspaceBroker,
      store: initializingLocalTaskStore,
    });
    const localCoordinator = new DispatchCoordinator({
      fence: initializingLocalExecutionStore,
      launcher: localSessionLauncher,
      publication: initializingLocalExecutionStore,
      store: initializingLocalExecutionStore,
      workspaces: localWorkspaceBroker,
    });
    const initializingLocalCompletion = new LocalRunCompletionAdapter({
      accounts: initializingReservations,
      store: initializingLocalExecutionStore,
    });
    localRunCompletionAdapter = initializingLocalCompletion;
    localDispatchActivityAdapter = new DispatchActivityAdapter({
      fence: initializingLocalExecutionStore,
      store: initializingLocalExecutionStore,
    });
    localDispatchRevocations = new DispatchRevocationCoordinator({
      capabilities: {
        releaseRun: (runId) => releaseLocalRunCapacity(runId),
      },
      sessions: {
        interruptGatewayThread: (threadId) =>
          localSessions.interruptGatewayThread(threadId),
        stopGatewayAccount: (accountProfileId) =>
          localAccounts.stopDispatchAccount(accountProfileId),
      },
      store: initializingLocalExecutionStore,
    });
    const initializingLocalExecutor = new LocalQueuedRunExecutor({
      accounts: initializingReservations,
      coordinator: localCoordinator,
      runtimeBootId: localRuntimeBootId,
      runtimePublicId: localInstallation.runnerId,
      store: initializingLocalExecutionStore,
      workspaces: localWorkspaceBroker,
      onTurnBound: () => initializingLocalCompletion.retryPending(),
    });
    localQueuedRunExecutor = initializingLocalExecutor;
    const initializingReconciler = new LocalTaskReconciler({
      installationId: localInstallation.installationId,
      bootId: localRuntimeBootId,
      dueWork: localDueWork,
      handlers: createLocalTaskDueWorkHandlers({
        authorityCommands: localAuthorityCommands,
        queuedRuns: initializingLocalExecutor,
      }),
    });
    localTaskReconciler = initializingReconciler;
    const localBootGeneration = initializingReconciler.begin();
    const localInteractionReplyKey =
      await createRunInteractionReplyKeyPair();
    localRunInteractionAdapter = new LocalRunInteractionAdapter({
      identity: {
        runnerId: localInstallation.runnerId,
        bootId: localRuntimeBootId,
        bootGeneration: localBootGeneration,
      },
      onAmbiguous: async (runId) => {
        await revokeLocalRun(runId, "interaction_resolution_ambiguous");
      },
      onCommitted: (change) => localTaskChanges.accept(change),
      replyKey: localInteractionReplyKey,
      sessions: localSessions,
      store: initializingLocalExecutionStore,
      tasks: initializingLocalTaskStore,
    });
    const localTaskReadiness = initializingReconciler.start();
    localCompletionRetryTimer = setInterval(
      () => initializingLocalCompletion.retryPending(),
      1_000,
    );
    localClaimRenewalTimer = setInterval(() => {
      initializingLocalExecutionStore.renewClaims({
        bootGeneration: localBootGeneration,
        now: Date.now(),
      });
    }, 20_000);

    const dispatchRuntime: DispatchRunnerRuntimeContext = {
      accountReservations: initializingReservations,
      accounts: initializingService,
      assets,
      controlPlane: database,
      controlPlanePath: databasePath,
      sessions: localSessions,
    };
    const pairingCoordinator = hraRunnerPairingCoordinator;
    await projectionCommits.publish({
      type: "runtime.changed",
      runtime: {
        state: "ready",
        generation: 1,
      },
    });
    sessionSyncCoordinator?.start();
    void humanRuntime.account.initialize()
      .then(async () => {
        await sessionSyncCoordinator?.authenticationChanged();
      })
      .catch(() => undefined);
    void localTaskReadiness.then(() => {
      if (
        localTaskReconciler !== initializingReconciler ||
        initializingReconciler.state !== "running" ||
        developmentReloadInternalAdmissionsClosed
      ) return;
      publishWithDrainRetry({
        type: "runner.changed",
        runner: { state: "connecting" },
      });
      if (pairingCoordinator === null) {
        hraRunnerPairingRecoveryState = initializingPromotionStore
              .runnerPairingsForInstallation(localInstallation.installationId)
              .length === 0
            ? "ready"
            : "configuration_required";
        void initializeDispatchRunner({
          ...dispatchRuntime,
          binding: { kind: "taskctl" },
        }).catch(() => undefined);
        return;
      }
      startHRARunnerPairing({
        coordinator: pairingCoordinator,
        installationId: localInstallation.installationId,
        runtime: dispatchRuntime,
      });
    }, async (error: unknown) => {
      // The durable boot is valid and already visible, so only an actual store
      // or scheduler fault can reject this tail. Wait until Native can observe
      // the authoritative recovering snapshot, then terminate this generation
      // for its bounded, fenced recovery policy.
      await gatewayInitialization;
      if (localTaskReconciler !== initializingReconciler) return;
      queueMicrotask(() => {
        throw error;
      });
    });
  } catch (initializationError: unknown) {
    if (
      worktreeRepairContext !== null
      && applicationSupport?.activated === true
    ) {
      worktreeRepairNeedsReverse = false;
      preserveForwardOnlyCutover = true;
    }
    if (
      worktreeRepairNeedsReverse
      && worktreeRepairContext !== null
    ) {
      try {
        worktreeRepairDatabase ??= openWorktreeRepairDatabase(
          controlPlanePathFromApplicationSupportRoot(
            worktreeRepairContext.targetRoot,
          ),
        );
        await reverseMovedApplicationSupportWorktreeRepair({
          ...worktreeRepairContext,
          database: worktreeRepairDatabase,
        });
        try {
          finalizeWorktreeRepairDatabase(worktreeRepairDatabase);
        } finally {
          worktreeRepairDatabase = null;
        }
        worktreeRepairNeedsReverse = false;
      } catch {
        preserveForwardOnlyCutover = true;
      }
    }
    if (worktreeRepairDatabase !== null) {
      try {
        finalizeWorktreeRepairDatabase(worktreeRepairDatabase);
      } catch {
        preserveForwardOnlyCutover = true;
      } finally {
        worktreeRepairDatabase = null;
      }
    }
    try {
      if (preserveForwardOnlyCutover) {
        applicationSupport?.preserveForwardOnlyForRetry();
      } else {
        applicationSupport?.rollbackBeforeActivation();
      }
    } catch {
      // Durable migration and repair journals remain fail-closed for retry;
      // never guess at authority after cleanup itself fails.
    }

    await shutdownSessionSync();
    await shutdownHRARunnerPairing();
    await shutdownDispatchRunner();
    await shutdownLocalPromotions();
    await shutdownLocalTaskAuthority();
    await stopCloudInvalidations();
    await stopHumanOrganizationProvisioning();
    await humanAccountService?.cancelSignIn();
    humanAccountService = null;
    humanOrganizationOperations = null;
    cloudAttachmentAvailability = null;
    cloudWorkspaceClient = null;
    cloudHumanOperations = null;
    cloudInvalidationHeads = null;
    cloudWorkspaceSummaries.replaceScope(null, {
      invalidatePrevious: false,
    });
    currentHumanCredentialGeneration = null;
    currentHumanOrganizationId = null;
    currentHumanUserId = null;
    const failedChatService = initializingChatService;
    failedChatService?.closeAdmission();
    let harnessProviderStopPermitted = !initializingHarnessBound;
    if (initializingHarnessBound && initializingHarness !== null) {
      try {
        await initializingHarness.preProviderStop();
        harnessProviderStopPermitted = true;
      } catch {
        // Provider runtimes must remain live when any effect producer cannot be
        // joined. The retained database and lifetime lock preserve recovery.
        harnessProviderStopPermitted = false;
      }
    }
    await failedChatService?.settled();
    let providerSourcesStopped = initializingService === null;
    if (harnessProviderStopPermitted) {
      try {
        await initializingService?.shutdown();
        providerSourcesStopped = true;
      } catch {
        providerSourcesStopped = false;
      }
    }
    // Account stop notifications deliberately retain provider-fact routing
    // after command admission closes. Join those exact pane tails before any
    // database close or migration rollback can proceed.
    await failedChatService?.settled();
    chatService = null;
    accountService = providerSourcesStopped ? null : initializingService;
    let harnessDatabaseClosePermitted =
      !initializingHarnessBound && providerSourcesStopped;
    if (
      initializingHarnessBound && initializingHarness !== null &&
      harnessProviderStopPermitted && providerSourcesStopped
    ) {
      try {
        initializingHarness.providerSourcesStopped();
        const report = await initializingHarness.shutdown();
        harnessDatabaseClosePermitted = report.databaseClosePermitted;
      } catch {
        harnessDatabaseClosePermitted = false;
      }
    }
    if (harnessDatabaseClosePermitted) {
      harnessProductionComposition = null;
    }
    accountProfileFileSystem?.close();
    accountProfileFileSystem = null;
    operationReceipts = null;
    portableRuntimeAssets = null;
    activeControlPlanePath = null;
    localDataRemovalHelperState = null;
    localDataRemovalPreviews.clear();
    if (harnessDatabaseClosePermitted) {
      database?.close();
      database = null;
      lifetimeLock?.release();
      lifetimeLock = null;
    }
    // A live gateway with a terminal failed snapshot cannot be repaired by
    // the Native supervisor: it still looks healthy and every renderer retry
    // reaches the same half-initialized generation. Exit after bounded cleanup
    // instead. Native fences this generation, applies its bounded backoff, and
    // launches a fresh process; persistent failures exhaust visibly and retain
    // an explicit retry action without replaying any mutation.
    throw initializationError;
  }
}

async function quiesceGatewayForLocalDataRemoval(): Promise<void> {
  if (localDataRemovalMaintenanceState === "held") return;
  if (localDataRemovalMaintenanceState !== "open") {
    throw new Error("HRA removal maintenance is already starting.");
  }
  localDataRemovalMaintenanceState = "quiescing";
  await shutdownSessionSync();
  await shutdownHRARunnerPairing();
  await shutdownDispatchRunner();
  await shutdownLocalPromotions();
  await shutdownLocalTaskAuthority();
  await stopCloudInvalidations();
  await stopHumanOrganizationProvisioning();
  await humanAccountService?.cancelSignIn();
  humanAccountService = null;
  humanOrganizationOperations = null;
  cloudAttachmentAvailability = null;
  cloudWorkspaceClient = null;
  cloudHumanOperations = null;
  cloudInvalidationHeads = null;
  cloudWorkspaceSummaries.replaceScope(null, {
    invalidatePrevious: false,
  });
  currentHumanCredentialGeneration = null;
  currentHumanOrganizationId = null;
  currentHumanUserId = null;
  const quiescingChatService = chatService;
  quiescingChatService?.closeAdmission();
  const harness = harnessProductionComposition;
  await harness?.preProviderStop();
  await quiescingChatService?.settled();
  try {
    await accountService?.shutdown();
  } finally {
    await quiescingChatService?.settled();
  }
  chatService = null;
  accountService = null;
  if (harness !== null) {
    harness.providerSourcesStopped();
    const report = await harness.shutdown();
    if (!report.databaseClosePermitted) {
      throw new Error("Harness shutdown did not permit local-data removal.");
    }
  }
  harnessProductionComposition = null;
  operationReceipts = null;
  requestProjectionDrain();
  const drain = projectionDrain;
  if (drain !== null) await drain;
  localDataRemovalMaintenanceState = "held";
}

function currentRemovalInventoryContext(): {
  readonly assets: PortableRuntimeAssets;
  readonly controlPlane: ReturnType<typeof openControlPlane>;
  readonly controlPlanePath: string;
  readonly effectiveHome: string;
  readonly helperState: LocalDataRemovalHelperState;
} {
  const assets = portableRuntimeAssets;
  const controlPlane = database;
  const controlPlanePath = activeControlPlanePath;
  const helperState = localDataRemovalHelperState;
  if (
    assets === null ||
    controlPlane === null ||
    controlPlanePath === null ||
    helperState === null
  ) {
    throw new Error("HRA local-data inventory is unavailable.");
  }
  return {
    assets,
    controlPlane,
    controlPlanePath,
    effectiveHome: userInfo().homedir,
    helperState,
  };
}

async function discoverCurrentGatewayRemovalInventory() {
  const context = currentRemovalInventoryContext();
  return await discoverGatewayLocalDataRemovalInventory({
    database: context.controlPlane,
    effectiveHome: context.effectiveHome,
    controlPlanePath: context.controlPlanePath,
    helperStateRoot: context.helperState.helperStateRoot,
    assets: context.assets,
    git: bundledGitRunner(accountPaths(
      context.assets,
      join(
        dirname(context.controlPlanePath),
        "local-task-dispatch",
        "codex-home",
      ),
    )),
  });
}

function localDataRemovalFailureResponse(
  operationId: string,
  error: unknown,
): RuntimeDispatchResponse {
  const failure = localDataRemovalPublicFailure(error);
  switch (failure.code) {
    case "confirmation_required":
      return operationFailure(
        operationId,
        "invalid_request",
        failure.message,
        true,
        "retry",
      );
    case "inventory_changed":
    case "removal_conflict":
      return operationFailure(
        operationId,
        "conflict",
        failure.message,
        true,
        "retry",
      );
    case "maintenance_unavailable":
      return operationFailure(
        operationId,
        "runtime_unavailable",
        failure.message,
        true,
        "restartRuntime",
      );
    case "unsafe_local_state":
    case "unexpected_failure":
      return operationFailure(
        operationId,
        "operation_failed",
        failure.message,
        false,
        "none",
      );
  }
}

async function previewLocalDataRemoval(
  request: RuntimeDispatchRequest & {
    readonly command: Extract<
      RuntimeLocalDataRemovalCommand,
      { readonly type: "maintenance.localDataRemoval.preview" }
    >;
  },
): Promise<RuntimeDispatchResponse> {
  if (localDataRemovalMaintenanceState !== "open") {
    return operationFailure(
      request.operationId,
      "runtime_unavailable",
      "HRA local-data removal is already in progress.",
      false,
      "none",
    );
  }
  try {
    const effectiveHome = userInfo().homedir;
    const fixed = fixedLocalDataRemovalPaths(effectiveHome);
    if (activeControlPlanePath !== fixed.controlPlanePath) {
      throw new Error("The active control plane does not use the fixed path.");
    }
    localDataRemovalHelperState ??=
      await loadOrCreateLocalDataRemovalHelperState(fixed.helperStateRoot);
    const inventory = await discoverCurrentGatewayRemovalInventory();
    const helperAvailable = await verifiedLocalDataRemoverPath(
      optionalRenamedEnvironmentValue(process.env, "HRA_DATA_REMOVER_PATH"),
    ).then(
      () => true,
      () => false,
    );
    const receipts = new FileLocalDataRemovalReceiptStore(
      fixed.helperStateRoot,
    );
    const operationInProgress = (await receipts.list()).length > 0;
    const plan = await createLocalDataRemovalPlan({
      ...inventory,
      signingKey: localDataRemovalHelperState.signingKey,
      previewId: `removal_${randomBytes(24).toString("base64url")}`,
      helperAvailable,
      operationInProgress,
    });
    const now = Date.now();
    for (const [previewId, candidate] of localDataRemovalPreviews) {
      if (Date.parse(candidate.preview.expiresAt) <= now) {
        localDataRemovalPreviews.delete(previewId);
      }
    }
    while (localDataRemovalPreviews.size >= 8) {
      const oldest = localDataRemovalPreviews.keys().next().value;
      if (oldest === undefined) break;
      localDataRemovalPreviews.delete(oldest);
    }
    localDataRemovalPreviews.set(plan.preview.previewId, plan);
    return {
      version: runtimeProtocolVersion,
      operationId: request.operationId,
      ok: true,
      result: {
        type: "localDataRemovalPreview",
        preview: plan.preview,
      },
    };
  } catch (error: unknown) {
    return localDataRemovalFailureResponse(request.operationId, error);
  }
}

async function removeLocalData(
  request: RuntimeDispatchRequest & {
    readonly command: Extract<
      RuntimeLocalDataRemovalCommand,
      { readonly type: "maintenance.localDataRemoval.remove" }
    >;
    readonly nativeRemovalCapability: string;
  },
): Promise<
  | RuntimeDispatchResponse
  | HostLocalDataRemovalNativeLaunch
  | HostLocalDataRemovalNativeTerminationRequired
> {
  const plan = localDataRemovalPreviews.get(request.command.previewId);
  if (plan === undefined) {
    return operationFailure(
      request.operationId,
      "invalid_request",
      "Create a fresh preview and confirm local-data removal.",
      true,
      "retry",
    );
  }
  try {
    await verifiedLocalDataRemoverPath(
      optionalRenamedEnvironmentValue(process.env, "HRA_DATA_REMOVER_PATH"),
    );
    await quiesceGatewayForLocalDataRemoval();
    const context = currentRemovalInventoryContext();
    const launch = await prepareLocalDataRemovalHelperLaunch({
      plan,
      command: request.command,
      operationId: request.operationId,
      nativeRemovalCapability: request.nativeRemovalCapability,
      parentProcessId: process.ppid,
      signingKey: context.helperState.signingKey,
      signingKeyPath: context.helperState.signingKeyPath,
      secrets: localDataRemovalKeychain,
      receipts: new FileLocalDataRemovalReceiptStore(
        context.helperState.helperStateRoot,
      ),
      maintenanceFence: localDataRemovalMaintenanceFence,
      revalidateInventory: discoverCurrentGatewayRemovalInventory,
    });
    const publicResponse: RuntimeDispatchResponse = {
      version: runtimeProtocolVersion,
      operationId: request.operationId,
      ok: true,
      result: {
        type: "localDataRemovalScheduled",
        previewId: request.command.previewId,
        state: "scheduled",
        willQuitApplication: true,
      },
    };
    database?.close();
    database = null;
    lifetimeLock?.release();
    lifetimeLock = null;
    activeControlPlanePath = null;
    portableRuntimeAssets = null;
    localDataRemovalPreviews.clear();
    return hostLocalDataRemovalNativeLaunch({
      operationId: request.operationId,
      previewId: request.command.previewId,
      parentProcessId: launch.parentProcessId,
      requestPath: launch.requestPath,
      signingKeyPath: launch.signingKeyPath,
      publicResponse,
    });
  } catch (error: unknown) {
    const publicResponse = localDataRemovalFailureResponse(
      request.operationId,
      error,
    );
    return localDataRemovalMaintenanceState === "open"
      ? publicResponse
      : hostLocalDataRemovalNativeTerminationRequired(publicResponse);
  }
}

function operationFailure(
  operationId: string,
  code: RuntimeError['code'],
  message: string,
  retryable: boolean,
  action: RuntimeError['action'],
): RuntimeDispatchResponse {
  return {
    version: runtimeProtocolVersion,
    operationId,
    ok: false,
    error: { code, message, retryable, action },
  };
}

function taskOperationFailure(
  operationId: string,
  code: RuntimeError["code"],
  message: string,
  retryable: boolean,
  action: RuntimeError["action"],
): RuntimeTaskDispatchResponse {
  return {
    version: runtimeProtocolVersion,
    operationId,
    ok: false,
    error: { code, message, retryable, action },
  };
}

async function onboardLocalProject(
  payload: HostProjectOnboardingPayload,
): Promise<ProjectOnboardingOutcome> {
  const service = localProjectOnboardingService;
  const installationId = localProjectOnboardingInstallationId;
  if (service === null || installationId === null) {
    return {
      ok: false,
      error: {
        code: "persistence_failed",
        message: "The project could not be saved locally.",
      },
    };
  }
  const outcome = await service.onboard({
    trustedDirectoryPath: payload.trustedDirectoryPath,
    installationId,
    ...(payload.repositoryName === undefined
      ? {}
      : { repositoryName: payload.repositoryName }),
    ...(payload.workspaceName === undefined
      ? {}
      : { workspaceName: payload.workspaceName }),
    ...(payload.provider === undefined ? {} : { provider: payload.provider }),
    ...(payload.publicUrl === undefined ? {} : { publicUrl: payload.publicUrl }),
  });
  if (outcome.ok) {
    publishWithDrainRetry({
      type: "task.invalidated",
      invalidation: {
        workspaceId: outcome.value.workspace.id,
        projectionRevision: outcome.value.workspace.revision,
        scope: "workspace",
      },
    });
  }
  return outcome;
}

type CloudFailureResult = Exclude<
  HRACloudSessionResult<unknown>,
  { readonly ok: true }
>;

function cloudRuntimeError(
  result: CloudFailureResult,
  write: boolean,
): RuntimeError {
  if (
    write &&
    result.kind === "operation" &&
    result.error.requestId === undefined
  ) {
    return {
      code: "upstream_ambiguous",
      message: "The cloud write outcome is unknown. Retry the same operation.",
      retryable: true,
      action: "retry",
    };
  }
  const code = result.error.code;
  const authentication =
    code === "AUTHENTICATION_FAILED" ||
    code === "AUTH_REFRESH_INDETERMINATE" ||
    code === "SIGNED_OUT" ||
    code === "SESSION_REQUIRED" ||
    code === "SESSION_INVALID" ||
    code === "ORGANIZATION_REQUIRED" ||
    code === "ORGANIZATION_MISMATCH" ||
    code === "MEMBERSHIP_INACTIVE";
  const authorization =
    code === "AUTHORIZATION_DENIED" ||
    code === "SCOPE_REQUIRED" ||
    code === "WORKSPACE_ROLE_REQUIRED";
  const stale =
    code === "TASK_STATE_CONFLICT" ||
    code === "TASK_NOT_READY" ||
    code === "TASK_BLOCKED" ||
    code === "TASK_IN_REVIEW" ||
    code === "DEPENDENCY_DUPLICATE" ||
    code === "CLAIM_STALE" ||
    code === "PROJECTION_MISMATCH" ||
    code === "SUBMISSION_STALE";
  const retryable =
    stale ||
    code === "PROVISIONING_IN_PROGRESS" ||
    code === "RATE_LIMITED" ||
    code === "SERVICE_UNAVAILABLE";
  return {
    code: authentication || authorization
      ? "policy_denied"
      : code === "NOT_FOUND"
        ? "not_found"
        : stale
          ? "stale_revision"
          : code === "IDEMPOTENCY_CONFLICT" ||
              code === "ENROLLMENT_CONFLICT"
            ? "operation_conflict"
            : code === "GRAPH_VALIDATION_LIMIT"
              ? "graph_limit"
              : code === "DEPENDENCY_CYCLE" ||
                  code === "HIERARCHY_CYCLE"
                ? "graph_cycle"
                : code === "TASK_ALREADY_CLAIMED"
                  ? "capacity_full"
                  : code === "VALIDATION_ERROR" ||
                      code === "IDEMPOTENCY_REQUIRED" ||
                      code === "IDEMPOTENCY_EXPIRED"
                    ? "invalid_request"
                    : "operation_failed",
    message: result.error.message,
    retryable,
    action: authentication
      ? "signIn"
      : retryable
        ? "retry"
        : "none",
  };
}

function cloudTaskOperationFailure(
  operationId: string,
  result: CloudFailureResult,
  write = false,
): RuntimeTaskDispatchResponse {
  const error = cloudRuntimeError(result, write);
  return {
    version: runtimeProtocolVersion,
    operationId,
    ok: false,
    error,
  };
}

type WorkspaceTaskAuthority =
  | Readonly<{ kind: "local"; revision: number }>
  | Readonly<{
      kind: "cloud";
      client: CloudWorkspaceClient;
      scope: CloudWorkspaceSummaryScope;
    }>
  | Readonly<{ kind: "failure"; error: RuntimeError }>;

async function resolveWorkspaceTaskAuthority(
  workspaceId: string,
  store: LocalTaskStore,
): Promise<WorkspaceTaskAuthority> {
  const localSummary = store.listWorkspaceSummaries().find(
    (workspace) => workspace.id === workspaceId,
  );
  if (localSummary !== undefined) {
    switch (localSummary.authority.kind) {
      case "local":
        return { kind: "local", revision: localSummary.revision };
      case "promoting":
        return {
          kind: "failure",
          error: {
            code: "authority_mismatch",
            message: localSummary.authority.phase === "outcome_unknown"
              ? "Cloud activation must be reconciled before this workspace can change."
              : "This workspace is read-only while cloud sync is being prepared.",
            retryable: false,
            action: "resolveAttention",
          },
        };
      case "cloud": {
        const client = cloudWorkspaceClient;
        const scope = currentCloudWorkspaceScope();
        if (client === null || scope === null) {
          return {
            kind: "failure",
            error: {
              code: "policy_denied",
              message: "Sign in to open this synced workspace.",
              retryable: false,
              action: "signIn",
            },
          };
        }
        ensureCloudInvalidations(workspaceId);
        return { kind: "cloud", client, scope };
      }
    }
  }
  const client = cloudWorkspaceClient;
  const scope = currentCloudWorkspaceScope();
  if (client === null || scope === null) {
    return {
      kind: "failure",
      error: {
        code: "not_found",
        message: "The requested workspace was not found locally.",
        retryable: false,
        action: "none",
      },
    };
  }
  if (cloudWorkspaceSummaries.has(scope, workspaceId)) {
    ensureCloudInvalidations(workspaceId);
    return { kind: "cloud", client, scope };
  }
  const result = await client.getWorkspace(workspaceId);
  if (!cloudWorkspaceSummaries.isCurrent(scope)) {
    return {
      kind: "failure",
      error: {
        code: "policy_denied",
        message: "The cloud account changed while opening this workspace.",
        retryable: true,
        action: "retry",
      },
    };
  }
  if (!result.ok) {
    return {
      kind: "failure",
      error: cloudRuntimeError(result, false),
    };
  }
  cloudWorkspaceSummaries.remember(scope, result.data.workspace);
  ensureCloudInvalidations(workspaceId);
  return { kind: "cloud", client, scope };
}

function authorityFailure(
  operationId: string,
  error: RuntimeError,
): RuntimeTaskDispatchResponse {
  return {
    version: runtimeProtocolVersion,
    operationId,
    ok: false,
    error,
  };
}

function cloudTaskCursor(input: {
  readonly workspaceId: string;
  readonly token: string | null;
  readonly projectionHead?: number;
  readonly view: TaskWorkspaceView;
  readonly assignedAgentId?: string;
}): HRAProjectionCursor | undefined {
  if (input.token === null || input.projectionHead === undefined) {
    return undefined;
  }
  return {
    version: HRA_HUMAN_HTTP_VERSION,
    token: input.token,
    workspaceId: input.workspaceId,
    projectionHead: input.projectionHead,
    scope: {
      kind: "task_list",
      view: input.view,
      ...(input.assignedAgentId === undefined
        ? {}
        : { assignedAgentId: input.assignedAgentId }),
    },
  };
}

function rendererPromotionProgress(
  progress: LocalPromotionProgress,
): RuntimeLocalPromotionProgress {
  return {
    promotionId: progress.promotionId,
    sourceWorkspaceId: progress.sourceWorkspaceId,
    destinationWorkspaceId: progress.destinationWorkspaceId,
    phase: progress.phase,
    frozenAt: progress.frozenAt,
    updatedAt: progress.updatedAt,
    preparedEntityCount: progress.preparedEntityCount,
    acceptedEntityCount: progress.acceptedEntityCount,
    acceptedBatchCount: progress.acceptedBatchCount,
    nextAttemptAt: progress.nextAttemptAt,
    fault: progress.fault,
    canAbort: progress.canAbort,
    localWritable: progress.localWritable,
    recoveryCopyAvailable: progress.recoveryCopyAvailable,
    runnerPairing: progress.runnerPairing,
  };
}

function promotionIdForOperation(operationId: string): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let value = BigInt(
    `0x${createHash("sha256").update(operationId).digest("hex").slice(0, 32)}`,
  );
  let locator = "";
  for (let index = 0; index < 26; index += 1) {
    locator = (alphabet[Number(value & 31n)] ?? "0") + locator;
    value >>= 5n;
  }
  return `promotion_${locator}`;
}

async function cloudTaskMutation(
  request: RuntimeTaskDispatchRequest & {
    readonly command: Extract<
      RuntimeTaskDispatchRequest["command"],
      { readonly type: "task.mutate" }
    >;
  },
  client: CloudWorkspaceClient,
): Promise<RuntimeTaskDispatchResponse> {
  const receipts = cloudHumanOperations;
  if (receipts === null) {
    return taskOperationFailure(
      request.operationId,
      "runtime_unavailable",
      "The cloud operation journal is unavailable.",
      true,
      "restartRuntime",
    );
  }
  let receipt: ReturnType<CloudHumanOperationStore["begin"]>;
  try {
    receipt = receipts.begin({
      workspaceId: request.command.workspaceId,
      intent: request.command.intent,
    });
  } catch (error: unknown) {
    if (!(error instanceof CloudHumanOperationConflict)) throw error;
    return taskOperationFailure(
      request.operationId,
      "operation_conflict",
      "The operation ID was already used for another cloud command.",
      false,
      "none",
    );
  }
  if (receipt.state === "ambiguous") {
    return taskOperationFailure(
      request.operationId,
      "upstream_ambiguous",
      "The cloud write outcome requires attention.",
      false,
      "resolveAttention",
    );
  }
  if (receipt.state === "recorded") {
    return receipt.outcome.ok
      ? {
          version: runtimeProtocolVersion,
          operationId: request.operationId,
          ok: true,
          result: {
            type: "taskMutation",
            mutation: receipt.outcome.mutation,
          },
        }
      : {
          version: runtimeProtocolVersion,
          operationId: request.operationId,
          ok: false,
          error: receipt.outcome.error,
        };
  }

  const { intent, workspaceId } = request.command;
  if (intent.kind === "interaction.respond") {
    const result = await new HRAInteractionGateway({ client }).respond({
      operationId: intent.operationId,
      workspaceId,
      runId: intent.runId,
      expectedWorkspaceRevision: intent.expectedWorkspaceRevision,
      expectedProjectionHead: intent.expectedWorkspaceRevision,
      request: intent.request,
      response: intent.response,
      idempotencyKey: receipt.idempotencyKey,
    });
    if (!result.ok) {
      const error = cloudRuntimeError(result, true);
      if (error.code !== "upstream_ambiguous") {
        receipts.complete(intent.operationId, { ok: false, error });
      }
      return {
        version: runtimeProtocolVersion,
        operationId: request.operationId,
        ok: false,
        error,
      };
    }
    receipts.complete(intent.operationId, {
      ok: true,
      mutation: result.data,
    });
    publishWithDrainRetry({
      type: "task.invalidated",
      invalidation: {
        workspaceId,
        projectionRevision: result.data.projectionRevision,
        scope: "workspace",
      },
    });
    return {
      version: runtimeProtocolVersion,
      operationId: request.operationId,
      ok: true,
      result: { type: "taskMutation", mutation: result.data },
    };
  }
  const result = await client.mutate(workspaceId, {
    expectedProjectionHead: intent.expectedWorkspaceRevision,
    intent: hraHumanMutationIntentSchema.parse(intent),
    idempotencyKey: receipt.idempotencyKey,
  });
  if (!result.ok) {
    const error = cloudRuntimeError(result, true);
    if (error.code !== "upstream_ambiguous") {
      receipts.complete(intent.operationId, { ok: false, error });
    }
    return {
      version: runtimeProtocolVersion,
      operationId: request.operationId,
      ok: false,
      error,
    };
  }
  receipts.complete(intent.operationId, {
    ok: true,
    mutation: result.data,
  });
  publishWithDrainRetry({
    type: "task.invalidated",
    invalidation: {
      workspaceId,
      projectionRevision: result.data.projectionRevision,
      scope: "workspace",
    },
  });
  return {
    version: runtimeProtocolVersion,
    operationId: request.operationId,
    ok: true,
    result: { type: "taskMutation", mutation: result.data },
  };
}

async function cloudTaskDispatch(
  request: RuntimeTaskDispatchRequest,
  client: CloudWorkspaceClient,
  scope: CloudWorkspaceSummaryScope,
): Promise<RuntimeTaskDispatchResponse> {
  const { command } = request;
  switch (command.type) {
    case "task.workspaces.list":
      throw new Error("Cloud workspace lists are merged before authority routing.");
    case "task.mutation.attempt.prepare":
    case "task.mutation.attempt.start":
    case "task.mutation.attempt.list":
    case "task.mutation.attempt.inspect":
    case "task.mutation.attempt.reconcile":
      throw new Error(
        "Local renderer mutation attempts are resolved before authority routing.",
      );
    case "task.workspace.projection":
      return taskOperationFailure(
        request.operationId,
        "protocol_error",
        "Cloud task workspaces still use revision-joined reads.",
        true,
        "retry",
      );
    case "task.workspace.context": {
      const result = await client.getContext(command.workspaceId);
      if (!result.ok) {
        return cloudTaskOperationFailure(request.operationId, result);
      }
      cloudWorkspaceSummaries.remember(scope, result.data.workspace);
      return {
        version: runtimeProtocolVersion,
        operationId: request.operationId,
        ok: true,
        result: {
          type: "taskWorkspaceContext",
          context: {
            workspaceId: result.data.workspace.id,
            projectionRevision: result.data.projectionHead,
            viewer: result.data.viewer,
            capabilities: result.data.capabilities,
            agents: [...result.data.agents],
            runner: result.data.runner,
          },
        },
      };
    }
    case "task.lookup": {
      const result = await client.lookupTask(command.workspaceId, {
        key: command.taskKey,
      });
      if (!result.ok) {
        return cloudTaskOperationFailure(request.operationId, result);
      }
      return {
        version: runtimeProtocolVersion,
        operationId: request.operationId,
        ok: true,
        result: {
          type: "taskLookup",
          workspaceId: result.data.workspaceId,
          taskKey: result.data.key,
          task: result.data.task,
        },
      };
    }
    case "task.repositories.list": {
      const repositories: {
        id: string;
        name: string;
        ready: boolean;
      }[] = [];
      let cursor: HRAProjectionCursor | undefined;
      let projectionRevision: number | null = null;
      while (repositories.length < 128) {
        const result = await client.listRepositories(command.workspaceId, {
          ...(cursor === undefined ? {} : { cursor }),
          limit: Math.min(100, 128 - repositories.length),
        });
        if (!result.ok) {
          return cloudTaskOperationFailure(request.operationId, result);
        }
        if (
          projectionRevision !== null &&
          projectionRevision !== result.data.projectionHead
        ) {
          return taskOperationFailure(
            request.operationId,
            "protocol_error",
            "Cloud repository pages changed projection mid-read.",
            true,
            "retry",
          );
        }
        projectionRevision = result.data.projectionHead;
        repositories.push(
          ...result.data.repositories.map(({ repository, ready }) => ({
            id: repository.id,
            name: repository.name,
            ready,
          })),
        );
        if (result.data.cursor === null) break;
        cursor = result.data.cursor;
      }
      if (projectionRevision === null) {
        return taskOperationFailure(
          request.operationId,
          "protocol_error",
          "Cloud repository projection was empty.",
          true,
          "retry",
        );
      }
      return {
        version: runtimeProtocolVersion,
        operationId: request.operationId,
        ok: true,
        result: {
          type: "taskRepositoryList",
          page: {
            workspaceId: command.workspaceId,
            projectionRevision,
            repositories,
          },
        },
      };
    }
    case "task.list": {
      const cursor = cloudTaskCursor({
        workspaceId: command.workspaceId,
        token: command.cursor,
        ...(command.continuationRevision === undefined
          ? {}
          : { projectionHead: command.continuationRevision }),
        view: command.view,
        ...(command.assignedAgentId === undefined
          ? {}
          : { assignedAgentId: command.assignedAgentId }),
      });
      const result = await client.listTasks(command.workspaceId, {
        view: command.view,
        ...(command.assignedAgentId === undefined
          ? {}
          : { assignedAgentId: command.assignedAgentId }),
        ...(cursor === undefined ? {} : { cursor }),
        limit: command.limit,
      });
      if (!result.ok) {
        return cloudTaskOperationFailure(request.operationId, result);
      }
      return {
        version: runtimeProtocolVersion,
        operationId: request.operationId,
        ok: true,
        result: {
          type: "taskListPage",
          page: result.data.page,
        },
      };
    }
    case "task.detail": {
      const result = await client.getTask(
        command.workspaceId,
        command.taskId,
      );
      if (!result.ok) {
        return cloudTaskOperationFailure(request.operationId, result);
      }
      return {
        version: runtimeProtocolVersion,
        operationId: request.operationId,
        ok: true,
        result: {
          type: "taskDetail",
          detail: result.data.detail,
        },
      };
    }
    case "task.mutate":
      return await cloudTaskMutation(
        { ...request, command },
        client,
      );
    case "task.promotion.start":
    case "task.promotion.status":
    case "task.promotion.abort":
    case "task.promotion.recovery.open":
      throw new Error("Promotion commands are routed before cloud authority.");
  }
}

async function promotionTaskDispatch(
  request: RuntimeTaskDispatchRequest & {
    readonly command: Extract<
      RuntimeTaskDispatchRequest["command"],
      {
        readonly type:
          | "task.promotion.start"
          | "task.promotion.status"
          | "task.promotion.abort"
          | "task.promotion.recovery.open";
      }
    >;
  },
): Promise<RuntimeTaskDispatchResponse> {
  const store = localPromotionStore;
  if (store === null) {
    return taskOperationFailure(
      request.operationId,
      "runtime_unavailable",
      "The local promotion journal is unavailable.",
      true,
      "restartRuntime",
    );
  }
  try {
    switch (request.command.type) {
      case "task.promotion.start": {
        const account = humanAccountService?.snapshot();
        if (
          account?.state !== "signed_in" ||
          account.profile.organization?.id !==
            request.command.destinationOrganizationId
        ) {
          return taskOperationFailure(
            request.operationId,
            "policy_denied",
            "Select the signed-in destination organization before syncing.",
            false,
            "signIn",
          );
        }
        const coordinator = localPromotionCoordinator;
        if (coordinator === null) {
          return taskOperationFailure(
            request.operationId,
            "capability_unavailable",
            "Cloud promotion is not configured on this installation.",
            false,
            "none",
          );
        }
        const progress = coordinator.beginPromotion({
          workspaceId: request.command.workspaceId,
          promotionId: promotionIdForOperation(request.operationId),
          destinationOrganizationId:
            request.command.destinationOrganizationId,
        });
        publishWithDrainRetry({
          type: "task.invalidated",
          invalidation: {
            workspaceId: request.command.workspaceId,
            projectionRevision: 1,
            scope: "workspace",
          },
        });
        return {
          version: runtimeProtocolVersion,
          operationId: request.operationId,
          ok: true,
          result: {
            type: "taskPromotionProgress",
            progress: rendererPromotionProgress(progress),
          },
        };
      }
      case "task.promotion.status": {
        const progress = store.progressForWorkspace(
          request.command.workspaceId,
        );
        return {
          version: runtimeProtocolVersion,
          operationId: request.operationId,
          ok: true,
          result: {
            type: "taskPromotionProgress",
            progress: progress === null
              ? null
              : rendererPromotionProgress(progress),
          },
        };
      }
      case "task.promotion.abort": {
        const existing = store.progress(request.command.promotionId);
        if (existing.sourceWorkspaceId !== request.command.workspaceId) {
          return taskOperationFailure(
            request.operationId,
            "authority_mismatch",
            "The promotion belongs to another workspace.",
            false,
            "none",
          );
        }
        const coordinator = localPromotionCoordinator;
        if (coordinator === null) {
          return taskOperationFailure(
            request.operationId,
            "runtime_unavailable",
            "Cloud promotion is unavailable.",
            true,
            "retry",
          );
        }
        const progress = await coordinator.abortPromotion(
          request.command.promotionId,
        );
        return {
          version: runtimeProtocolVersion,
          operationId: request.operationId,
          ok: true,
          result: {
            type: "taskPromotionProgress",
            progress: rendererPromotionProgress(progress),
          },
        };
      }
      case "task.promotion.recovery.open": {
        const recovery = store.recoveryCopy(request.command.promotionId);
        if (
          recovery === null ||
          recovery.localWorkspaceId !== request.command.workspaceId
        ) {
          return taskOperationFailure(
            request.operationId,
            "not_found",
            "The read-only local recovery copy was not found.",
            false,
            "none",
          );
        }
        const opened = store.markRecoveryOpened(
          request.command.promotionId,
          Date.now(),
        );
        return {
          version: runtimeProtocolVersion,
          operationId: request.operationId,
          ok: true,
          result: {
            type: "taskPromotionRecovery",
            recovery: opened,
          },
        };
      }
    }
  } catch (error: unknown) {
    if (error instanceof LocalPromotionError) {
      return taskOperationFailure(
        request.operationId,
        error.code === "live_local_work"
          ? "invalid_state"
          : error.code === "state_conflict"
            ? "conflict"
            : "operation_failed",
        error.message,
        error.retryable,
        error.retryable ? "retry" : "none",
      );
    }
    return taskOperationFailure(
      request.operationId,
      "operation_failed",
      "The local workspace could not change sync authority.",
      false,
      "none",
    );
  }
}

function recoveryReadTaskDispatch(
  request: RuntimeTaskDispatchRequest,
  store: LocalTaskStore,
): RuntimeTaskDispatchResponse {
  const promotions = localPromotionStore;
  if (promotions === null) {
    return taskOperationFailure(
      request.operationId,
      "runtime_unavailable",
      "The local recovery authority is unavailable.",
      true,
      "restartRuntime",
    );
  }
  try {
    if (
      !("recovery" in request.command) ||
      request.command.recovery === undefined
    ) {
      throw new LocalPromotionError("authority_conflict");
    }
    const recovery = promotions.recoveryReadAuthority(
      request.command.recovery,
    );
    if (request.command.workspaceId !== recovery.cloudWorkspaceId) {
      return taskOperationFailure(
        request.operationId,
        "authority_mismatch",
        "The recovery selection does not match its cloud workspace.",
        false,
        "none",
      );
    }
    const now = Date.now();
    const recoverySummary = store.recoveryWorkspaceSummary(
      recovery.localWorkspaceId,
      recovery.cloudWorkspaceId,
      now,
    );
    switch (request.command.type) {
      case "task.mutate":
        return taskOperationFailure(
          request.operationId,
          "policy_denied",
          "The retained local recovery copy is read-only.",
          false,
          "none",
        );
      case "task.workspace.projection": {
        const projection = store.recoveryTaskWorkspaceProjection({
          localWorkspaceId: recovery.localWorkspaceId,
          presentedWorkspaceId: recovery.cloudWorkspaceId,
          expectedWorkspaceRevision: recoverySummary.revision,
          view: request.command.view,
          ...(request.command.assignedAgentId === undefined
            ? {}
            : { assignedAgentId: request.command.assignedAgentId }),
          selectedTaskId: request.command.selectedTaskId,
          minimumRevision: request.command.minimumRevision,
          limit: request.command.limit,
        }, now);
        return {
          version: runtimeProtocolVersion,
          operationId: request.operationId,
          ok: true,
          result: {
            type: "taskWorkspaceProjection",
            consistency: "atomic",
            presentation: {
              agents: [...projection.agents],
              capabilities: {
                canAssign: false,
                canCancel: false,
                canComment: false,
                canCreate: false,
                canEdit: false,
                canManageGraph: false,
                canManageLabels: false,
                canManageReferences: false,
                canReopen: false,
                canReview: false,
              },
              counts: projection.workspace.counts,
              now: projection.now,
              runner: {
                presence: {
                  state: "offline",
                  serverTime: projection.now,
                },
                repositories: [...projection.repositories],
              },
              viewer: projection.viewer,
              workspace: {
                id: projection.workspace.id,
                keyPrefix: projection.workspace.keyPrefix,
                name: projection.workspace.name,
                slug: projection.workspace.slug,
              },
            },
            projection: projection.projection,
          },
        };
      }
      case "task.workspace.context": {
        const baseContext = store.recoveryTaskWorkspaceContextBase(
          recovery.localWorkspaceId,
          recovery.cloudWorkspaceId,
        );
        const context = {
          agents: baseContext.agents,
          projectionRevision: baseContext.projectionRevision,
          viewer: baseContext.viewer,
          workspaceId: baseContext.workspaceId,
        };
        return {
          version: runtimeProtocolVersion,
          operationId: request.operationId,
          ok: true,
          result: {
            type: "taskWorkspaceContext",
            context: {
              ...context,
              agents: [...context.agents],
              capabilities: {
                canAssign: false,
                canCancel: false,
                canComment: false,
                canCreate: false,
                canEdit: false,
                canManageGraph: false,
                canManageLabels: false,
                canManageReferences: false,
                canReopen: false,
                canReview: false,
              },
              runner: {
                state: "offline",
                serverTime: now,
              },
            },
          },
        };
      }
      case "task.lookup":
        return {
          version: runtimeProtocolVersion,
          operationId: request.operationId,
          ok: true,
          result: {
            type: "taskLookup",
            workspaceId: recovery.cloudWorkspaceId,
            taskKey: request.command.taskKey,
            task: store.recoveryLookupTask(
              recovery.localWorkspaceId,
              request.command.taskKey,
            ),
          },
        };
      case "task.repositories.list": {
        const page = store.recoveryWorkspaceRepositories(
          recovery.localWorkspaceId,
          recovery.cloudWorkspaceId,
        );
        return {
          version: runtimeProtocolVersion,
          operationId: request.operationId,
          ok: true,
          result: {
            type: "taskRepositoryList",
            page: {
              ...page,
              repositories: [...page.repositories],
            },
          },
        };
      }
      case "task.list":
        return {
          version: runtimeProtocolVersion,
          operationId: request.operationId,
          ok: true,
          result: {
            type: "taskListPage",
            page: store.recoveryListTasks({
              localWorkspaceId: recovery.localWorkspaceId,
              presentedWorkspaceId: recovery.cloudWorkspaceId,
              view: request.command.view,
              ...(request.command.assignedAgentId === undefined
                ? {}
                : { assignedAgentId: request.command.assignedAgentId }),
              cursor: request.command.cursor,
              ...(request.command.continuationRevision === undefined
                ? {}
                : {
                    continuationRevision:
                      request.command.continuationRevision,
                  }),
              limit: request.command.limit,
              now,
            }),
          },
        };
      case "task.detail":
        return {
          version: runtimeProtocolVersion,
          operationId: request.operationId,
          ok: true,
          result: {
            type: "taskDetail",
            detail: store.recoveryTaskDetail(
              recovery.localWorkspaceId,
              recovery.cloudWorkspaceId,
              request.command.taskId,
              now,
            ),
          },
        };
    }
  } catch (error: unknown) {
    if (
      error instanceof LocalPromotionError ||
      error instanceof LocalTaskStoreError
    ) {
      return taskOperationFailure(
        request.operationId,
        "authority_mismatch",
        "The retained recovery selection is no longer valid.",
        false,
        "none",
      );
    }
    return taskOperationFailure(
      request.operationId,
      "operation_failed",
      "The retained local recovery copy could not be read.",
      false,
      "none",
    );
  }
}

async function taskDispatch(
  request: RuntimeTaskDispatchRequest,
): Promise<RuntimeTaskDispatchResponse> {
  const store = localTaskStore;
  if (store === null) {
    return taskOperationFailure(
      request.operationId,
      "runtime_unavailable",
      "The local task authority is unavailable.",
      true,
      "restartRuntime",
    );
  }
  const localRecoveryPending = localTaskReconciler?.state === "recovering";
  const recoveryPending = (): RuntimeTaskDispatchResponse =>
    taskOperationFailure(
      request.operationId,
      "runtime_unavailable",
      "Local task recovery is still finishing. Retry when the runner is ready.",
      true,
      "retry",
    );
  try {
    if (
      localRecoveryPending &&
      (
        request.command.type === "task.promotion.start" ||
        request.command.type === "task.promotion.abort" ||
        request.command.type === "task.mutation.attempt.prepare" ||
        request.command.type === "task.mutation.attempt.start" ||
        request.command.type === "task.mutation.attempt.reconcile"
      )
    ) {
      return recoveryPending();
    }
    if (
      request.command.type === "task.promotion.start" ||
      request.command.type === "task.promotion.status" ||
      request.command.type === "task.promotion.abort" ||
      request.command.type === "task.promotion.recovery.open"
    ) {
      return await promotionTaskDispatch({
        ...request,
        command: request.command,
      });
    }
    if (
      "recovery" in request.command &&
      request.command.recovery !== undefined
    ) {
      return recoveryReadTaskDispatch({
        ...request,
      }, store);
    }
    if (request.command.type === "task.workspaces.list") {
      const local = [...store.listWorkspaceSummaries()];
      const client = cloudWorkspaceClient;
      const scope = currentCloudWorkspaceScope();
      const workspaces = cloudWorkspaceSummaries.listAndRefresh({
        client,
        local,
        scope,
      });
      return {
        version: runtimeProtocolVersion,
        operationId: request.operationId,
        ok: true,
        result: {
          type: "taskWorkspaceSummaries",
          workspaces,
        },
      };
    }
    if (request.command.type === "task.mutation.attempt.prepare") {
      const attempt = store.prepareRendererMutationAttempt({
        attemptId: request.command.attemptId,
        workspaceId: request.command.workspaceId,
        commandKind: request.command.commandKind,
        fingerprint: request.command.fingerprint,
      });
      return {
        version: runtimeProtocolVersion,
        operationId: request.operationId,
        ok: true,
        result: {
          type: "taskMutationAttempt",
          attempt,
        },
      };
    }
    if (request.command.type === "task.mutation.attempt.start") {
      const installationId = localProjectOnboardingInstallationId;
      if (installationId === null) {
        return taskOperationFailure(
          request.operationId,
          "runtime_unavailable",
          "The local task authority is unavailable.",
          true,
          "restartRuntime",
        );
      }
      const command = materializeLocalOwnerTaskCommand(
        request.command.intent,
        {
          kind: "local_owner",
          workspaceId: request.command.workspaceId,
          installationId,
        },
      );
      const attempt = store.startRendererMutationAttempt({
        attemptId: request.command.attemptId,
        workspaceId: request.command.workspaceId,
        expectedRevision: request.command.expectedRevision,
        command,
      });
      return {
        version: runtimeProtocolVersion,
        operationId: request.operationId,
        ok: true,
        result: {
          type: "taskMutationAttempt",
          attempt,
        },
      };
    }
    if (request.command.type === "task.mutation.attempt.list") {
      const attempts = store.listOpenRendererMutationAttempts({
        workspaceId: request.command.workspaceId,
        limit: request.command.limit,
      });
      return {
        version: runtimeProtocolVersion,
        operationId: request.operationId,
        ok: true,
        result: {
          type: "taskMutationAttemptList",
          workspaceId: request.command.workspaceId,
          attempts: [...attempts],
        },
      };
    }
    if (request.command.type === "task.mutation.attempt.inspect") {
      const inspection =
        store.inspectSerializedRendererMutationAttempt({
          attemptId: request.command.attemptId,
          workspaceId: request.command.workspaceId,
          expectedRevision: request.command.expectedRevision,
        });
      return {
        version: runtimeProtocolVersion,
        operationId: request.operationId,
        ok: true,
        result: {
          type: "taskMutationAttemptInspection",
          inspection: {
            attemptId: inspection.attempt.attemptId,
            workspaceId: inspection.attempt.workspaceId,
            commandKind: inspection.attempt.commandKind,
            resolution: inspection.resolution,
          },
        },
      };
    }
    if (request.command.type === "task.mutation.attempt.reconcile") {
      const reconciliation =
        store.reconcileSerializedRendererMutationAttempt({
          attemptId: request.command.attemptId,
          workspaceId: request.command.workspaceId,
          expectedRevision: request.command.expectedRevision,
        });
      return {
        version: runtimeProtocolVersion,
        operationId: request.operationId,
        ok: true,
        result: {
          type: "taskMutationReconciliation",
          reconciliation: {
            attemptId: reconciliation.attempt.attemptId,
            workspaceId: reconciliation.attempt.workspaceId,
            commandKind: reconciliation.attempt.commandKind,
            resolution: reconciliation.resolution,
          },
        },
      };
    }
    const authority = await resolveWorkspaceTaskAuthority(
      request.command.workspaceId,
      store,
    );
    if (authority.kind === "failure") {
      return authorityFailure(request.operationId, authority.error);
    }
    if (authority.kind === "cloud") {
      return await cloudTaskDispatch(
        request,
        authority.client,
        authority.scope,
      );
    }
    if (localRecoveryPending && request.command.type === "task.mutate") {
      return recoveryPending();
    }
    switch (request.command.type) {
      case "task.workspace.projection": {
        const readyRepositoryIds =
          await localRepositoryReadiness?.readyRepositoryIds(
            request.command.workspaceId,
          ) ?? new Set<string>();
        const observedAt = Date.now();
        const projection = store.taskWorkspaceProjection({
          workspaceId: request.command.workspaceId,
          expectedWorkspaceRevision: authority.revision,
          view: request.command.view,
          ...(request.command.assignedAgentId === undefined
            ? {}
            : { assignedAgentId: request.command.assignedAgentId }),
          selectedTaskId: request.command.selectedTaskId,
          minimumRevision: request.command.minimumRevision,
          limit: request.command.limit,
        }, readyRepositoryIds, observedAt);
        const reservations = dispatchAccountReservations;
        const runner = reservations === null
          ? { state: "offline" as const, serverTime: observedAt }
          : !projection.hasReadyRepository
          ? {
              state: "blocked" as const,
              reason: "no_repository" as const,
              serverTime: observedAt,
              leaseUntil: observedAt + RUNNER_PRESENCE_LEASE_MS,
            }
          : (() => {
              const capacity = reservations.currentSnapshot();
              if (capacity.state === "no_account") {
                return {
                  state: "blocked" as const,
                  reason: "no_account" as const,
                  serverTime: observedAt,
                  leaseUntil: observedAt + RUNNER_PRESENCE_LEASE_MS,
                };
              }
              if (capacity.state === "capacity_full") {
                return {
                  state: "busy" as const,
                  serverTime: observedAt,
                  leaseUntil: observedAt + RUNNER_PRESENCE_LEASE_MS,
                };
              }
              return {
                state: "ready" as const,
                availableCapacity: capacity.availableCapacity,
                serverTime: observedAt,
                leaseUntil: observedAt + RUNNER_PRESENCE_LEASE_MS,
              };
            })();
        return {
          version: runtimeProtocolVersion,
          operationId: request.operationId,
          ok: true,
          result: {
            type: "taskWorkspaceProjection",
            consistency: "atomic",
            presentation: {
              agents: [...projection.agents],
              capabilities: {
                canAssign: projection.agents.some(
                  ({ status }) => status === "active",
                ),
                canCancel: true,
                canComment: true,
                canCreate: true,
                canEdit: true,
                canManageGraph: true,
                canManageLabels: true,
                canManageReferences: true,
                canReopen: true,
                canReview: true,
              },
              counts: projection.workspace.counts,
              now: projection.now,
              runner: {
                presence: runner,
                repositories: [...projection.repositories],
              },
              viewer: projection.viewer,
              workspace: {
                id: projection.workspace.id,
                keyPrefix: projection.workspace.keyPrefix,
                name: projection.workspace.name,
                slug: projection.workspace.slug,
              },
            },
            projection: projection.projection,
          },
        };
      }
      case "task.workspace.context": {
        const baseContext = store.taskWorkspaceContextBase(
          request.command.workspaceId,
        );
        const context = {
          agents: baseContext.agents,
          projectionRevision: baseContext.projectionRevision,
          viewer: baseContext.viewer,
          workspaceId: baseContext.workspaceId,
        };
        const readyRepositoryIds =
          await localRepositoryReadiness?.readyRepositoryIds(
            request.command.workspaceId,
          ) ?? new Set<string>();
        const hasRepository = readyRepositoryIds.size > 0;
        const observedAt = Date.now();
        const reservations = dispatchAccountReservations;
        const runner = reservations === null
          ? { state: "offline" as const, serverTime: observedAt }
          : !hasRepository
          ? {
              state: "blocked" as const,
              reason: "no_repository" as const,
              serverTime: observedAt,
              leaseUntil: observedAt + RUNNER_PRESENCE_LEASE_MS,
            }
          : (() => {
              const capacity = reservations.currentSnapshot();
              if (capacity.state === "no_account") {
                return {
                  state: "blocked" as const,
                  reason: "no_account" as const,
                  serverTime: observedAt,
                  leaseUntil: observedAt + RUNNER_PRESENCE_LEASE_MS,
                };
              }
              if (capacity.state === "capacity_full") {
                return {
                  state: "busy" as const,
                  serverTime: observedAt,
                  leaseUntil: observedAt + RUNNER_PRESENCE_LEASE_MS,
                };
              }
              return {
                state: "ready" as const,
                availableCapacity: capacity.availableCapacity,
                serverTime: observedAt,
                leaseUntil: observedAt + RUNNER_PRESENCE_LEASE_MS,
              };
            })();
        return {
          version: runtimeProtocolVersion,
          operationId: request.operationId,
          ok: true,
          result: {
            type: "taskWorkspaceContext",
            context: {
              ...context,
              agents: [...context.agents],
              capabilities: {
                canAssign: context.agents.some(
                  ({ status }) => status === "active",
                ),
                canCancel: true,
                canComment: true,
                canCreate: true,
                canEdit: true,
                canManageGraph: true,
                canManageLabels: true,
                canManageReferences: true,
                canReopen: true,
                canReview: true,
              },
              runner,
            },
          },
        };
      }
      case "task.lookup":
        return {
          version: runtimeProtocolVersion,
          operationId: request.operationId,
          ok: true,
          result: {
            type: "taskLookup",
            workspaceId: request.command.workspaceId,
            taskKey: request.command.taskKey,
            task: store.lookupTask(
              request.command.workspaceId,
              request.command.taskKey,
            ),
          },
        };
      case "task.repositories.list": {
        const readyRepositoryIds =
          await localRepositoryReadiness?.readyRepositoryIds(
            request.command.workspaceId,
          ) ?? new Set<string>();
        const page = store.listWorkspaceRepositories(
          request.command.workspaceId,
          readyRepositoryIds,
        );
        return {
          version: runtimeProtocolVersion,
          operationId: request.operationId,
          ok: true,
          result: {
            type: "taskRepositoryList",
            page: {
              ...page,
              repositories: [...page.repositories],
            },
          },
        };
      }
      case "task.list":
        return {
          version: runtimeProtocolVersion,
          operationId: request.operationId,
          ok: true,
          result: {
            type: "taskListPage",
            page: store.listTasks({
              workspaceId: request.command.workspaceId,
              view: request.command.view,
              ...(request.command.assignedAgentId === undefined
                ? {}
                : { assignedAgentId: request.command.assignedAgentId }),
              cursor: request.command.cursor,
              ...(request.command.continuationRevision === undefined
                ? {}
                : {
                    continuationRevision:
                      request.command.continuationRevision,
                  }),
              limit: request.command.limit,
            }),
          },
        };
      case "task.detail":
        return {
          version: runtimeProtocolVersion,
          operationId: request.operationId,
          ok: true,
          result: {
            type: "taskDetail",
            detail: store.taskDetail(
              request.command.workspaceId,
              request.command.taskId,
            ),
          },
        };
      case "task.mutate": {
        const installationId = localProjectOnboardingInstallationId;
        if (installationId === null) {
          return taskOperationFailure(
            request.operationId,
            "runtime_unavailable",
            "The local task authority is unavailable.",
            true,
            "restartRuntime",
          );
        }
        const command = materializeLocalOwnerTaskCommand(
          request.command.intent,
          {
            kind: "local_owner",
            workspaceId: request.command.workspaceId,
            installationId,
          },
        );
        store.assertRendererMutationEffectStarted(command);
        const { receipt, replayed } = store.executeWithDisposition(
          command,
        );
        if (receipt.outcome === "rejected") {
          const code = receipt.code === "not_found"
            ? "not_found"
            : receipt.code === "revision_conflict"
              ? "stale_revision"
              : receipt.code === "authority_mismatch"
                ? "policy_denied"
                : receipt.code === "operation_conflict"
                  ? "conflict"
                  : receipt.code === "capacity_full"
                    ? "capacity_full"
                  : "operation_failed";
          return taskOperationFailure(
            request.operationId,
            code,
            "The task mutation was rejected by the current workspace state.",
            code === "stale_revision",
            code === "stale_revision" ? "retry" : "none",
          );
        }
        if (receipt.outcome === "committed" && !replayed) {
          publishWithDrainRetry({
            type: "task.invalidated",
            invalidation: {
              workspaceId: receipt.workspaceId,
              projectionRevision: receipt.workspaceRevision,
              scope: "workspace",
            },
          });
          localTaskReconciler?.wake("explicit");
          switch (command.kind) {
            case "interaction.respond": {
              const adapter = localRunInteractionAdapter;
              if (adapter !== null) {
                void adapter.respond(command).catch(async () => {
                  await revokeLocalRun(
                    command.runId,
                    "interaction_resolution_ambiguous",
                  );
                });
              }
              break;
            }
            case "dispatch.stop":
              void revokeLocalRun(command.runId, "stop_requested")
                .catch(() => undefined);
              break;
            case "task.cancel":
              for (
                const runId
                of localRunExecutionStore?.runIdsForTaskNeedingStop(
                  receipt.workspaceId,
                  command.taskId,
                ) ?? []
              ) {
                void revokeLocalRun(runId, "stop_requested")
                  .catch(() => undefined);
              }
              break;
            case "dispatch.retry":
            case "dispatch.resolve_ambiguity":
              break;
            case "workspace.rename":
            case "task.create":
            case "task.create_and_run":
            case "task.update":
            case "task.reopen":
            case "task.assign":
            case "task.defer":
            case "task.parent_set":
            case "task.parent_clear":
            case "task.label_add":
            case "task.label_remove":
            case "task.comment_add":
            case "task.reference_add":
            case "task.reference_remove":
            case "dependency.add":
            case "dependency.remove":
            case "task.submit":
            case "review.accept":
            case "review.reject":
            case "interaction.settle":
              break;
          }
        }
        if (
          (
            command.kind === "dispatch.retry"
            || command.kind === "dispatch.resolve_ambiguity"
          )
          && localRunExecutionStore?.markHumanResolved(command.sourceRunId)
        ) {
          dispatchAccountReservations?.releaseRun(command.sourceRunId);
        }
        return {
          version: runtimeProtocolVersion,
          operationId: request.operationId,
          ok: true,
          result: {
            type: "taskMutation",
            mutation: {
              operationId: receipt.operationId,
              workspaceId: receipt.workspaceId,
              commandKind: command.kind,
              workspaceRevision: receipt.workspaceRevision,
              projectionRevision: receipt.workspaceRevision,
              result: receipt.result,
            },
          },
        };
      }
    }
  } catch (error: unknown) {
    if (error instanceof LocalProjectionRevisionConflict) {
      return taskOperationFailure(
        request.operationId,
        "stale_revision",
        "The task projection changed. Refresh and try again.",
        true,
        "retry",
      );
    }
    if (
      error instanceof LocalOperationConflict ||
      error instanceof LocalMutationAttemptConflict
    ) {
      return taskOperationFailure(
        request.operationId,
        "conflict",
        "The task operation ID was already used for another command.",
        false,
        "none",
      );
    }
    if (error instanceof LocalTaskStoreError) {
      const code = error.code === "not_found"
        ? "not_found"
        : error.code === "revision_conflict"
        ? "stale_revision"
        : error.code === "authority_mismatch"
        ? "policy_denied"
        : error.code === "capacity_full"
        ? "capacity_full"
        : "operation_failed";
      return taskOperationFailure(
        request.operationId,
        code,
        error.message,
        code === "stale_revision",
        code === "stale_revision" ? "retry" : "none",
      );
    }
    return taskOperationFailure(
      request.operationId,
      "operation_failed",
      "The local task operation could not be completed.",
      false,
      "none",
    );
  }
}

async function executeDomainCommand(
  request: RuntimeDispatchRequest,
): Promise<RuntimeDispatchResponse> {
  if (
    request.command.type === "maintenance.localDataRemoval.preview" ||
    request.command.type === "maintenance.localDataRemoval.remove"
  ) {
    return operationFailure(
      request.operationId,
      "invalid_request",
      "The maintenance command bypassed its private gateway handler.",
      false,
      "none",
    );
  }
  const sessionSyncCommand = runtimeSessionSyncDomainCommandSchema.safeParse(
    request.command,
  );
  if (sessionSyncCommand.success) {
    const coordinator = sessionSyncCoordinator;
    if (coordinator === null) {
      return operationFailure(
        request.operationId,
        "capability_unavailable",
        "Cloud session sync is not configured.",
        false,
        "none",
      );
    }
    try {
      return {
        version: runtimeProtocolVersion,
        operationId: request.operationId,
        ok: true,
        result: await coordinator.execute(sessionSyncCommand.data),
      };
    } catch (error: unknown) {
      if (error instanceof SessionSyncCoordinatorError) {
        return operationFailure(
          request.operationId,
          error.code,
          error.message,
          error.retryable,
          error.retryable ? "retry" : "none",
        );
      }
      return operationFailure(
        request.operationId,
        "operation_failed",
        "The session sync operation could not be completed.",
        false,
        "none",
      );
    }
  }
  const harnessCommand = runtimeHarnessDomainCommandSchema.safeParse(
    request.command,
  );
  if (harnessCommand.success) {
    const service = harnessProductionComposition;
    if (service === null) {
      return operationFailure(
        request.operationId,
        "runtime_unavailable",
        "The local harness service is unavailable.",
        true,
        "restartRuntime",
      );
    }
    try {
      return {
        version: runtimeProtocolVersion,
        operationId: request.operationId,
        ok: true,
        result: await service.rendererCommands.execute(harnessCommand.data),
      };
    } catch (error: unknown) {
      if (error instanceof HarnessRendererServiceError) {
        return operationFailure(
          request.operationId,
          error.code === "authority_conflict"
            ? "authority_mismatch"
            : error.code,
          error.message,
          error.retryable,
          error.action,
        );
      }
      return operationFailure(
        request.operationId,
        "operation_failed",
        "The harness operation could not be completed.",
        false,
        "none",
      );
    }
  }
  const chatCommand = runtimeChatDomainCommandSchema.safeParse(request.command);
  if (chatCommand.success) {
    const service = chatService;
    if (service === null) {
      return operationFailure(
        request.operationId,
        "runtime_unavailable",
        "The local chat service is unavailable.",
        true,
        "restartRuntime",
      );
    }
    try {
      const result = await service.execute(chatCommand.data);
      return {
        version: runtimeProtocolVersion,
        operationId: request.operationId,
        ok: true,
        result: result.type === "pane"
          ? { type: "chatPane", pane: result.pane }
          : result.type === "removed"
            ? { type: "chatPaneRemoved", paneId: result.paneId }
            : { type: "accepted" },
      };
    } catch (error: unknown) {
      if (error instanceof ChatPaneStoreError) {
        switch (error.code) {
          case "not_found":
            return operationFailure(
              request.operationId,
              "not_found",
              error.message,
              false,
              "none",
            );
          case "conflict":
            return operationFailure(
              request.operationId,
              "conflict",
              error.message,
              false,
              "none",
            );
          case "revision_conflict":
            return operationFailure(
              request.operationId,
              "revision_conflict",
              error.message,
              true,
              "retry",
            );
          case "limit":
            return operationFailure(
              request.operationId,
              "capacity_full",
              error.message,
              false,
              "none",
            );
          case "invalid_state":
            return operationFailure(
              request.operationId,
              "invalid_state",
              error.message,
              false,
              "none",
            );
          case "corrupt_state":
            return operationFailure(
              request.operationId,
              "runtime_unavailable",
              "Stored chat state could not be opened safely.",
              false,
              "restartRuntime",
            );
        }
      }
      return operationFailure(
        request.operationId,
        "operation_failed",
        "The chat operation could not be completed.",
        false,
        "none",
      );
    }
  }
  // Every harness-prefixed command must terminate at the parsed renderer
  // service boundary above. Keep this prefix guard broader than the current
  // three-command contract so removed or future privileged commands can never
  // fall through to an unrelated runtime handler.
  if (request.command.type.startsWith("harness.")) {
    throw new Error("A harness command escaped its dedicated service boundary.");
  }
  const human = humanAccountService;
  switch (request.command.type) {
    case "harness.settings.update":
    case "harness.child.open":
    case "harness.child.stop":
      throw new Error("A harness command escaped its dedicated service boundary.");
    case "human.signIn.start": {
      if (human === null) {
        return operationFailure(
          request.operationId,
          "runtime_unavailable",
          "Cloud account attachment is still starting.",
          true,
          "retry",
        );
      }
      human.startSignIn();
      return {
        version: runtimeProtocolVersion,
        operationId: request.operationId,
        ok: true,
        result: { type: "accepted" },
      };
    }
    case "human.signIn.cancel": {
      if (human === null) {
        return operationFailure(
          request.operationId,
          "runtime_unavailable",
          "Cloud account attachment is still starting.",
          true,
          "retry",
        );
      }
      await human.cancelSignIn();
      return {
        version: runtimeProtocolVersion,
        operationId: request.operationId,
        ok: true,
        result: { type: "accepted" },
      };
    }
    case "human.signOut": {
      if (human === null) {
        return operationFailure(
          request.operationId,
          "runtime_unavailable",
          "Cloud account attachment is still starting.",
          true,
          "retry",
        );
      }
      const snapshot = await human.signOut();
      if (snapshot.state === "error") {
        return humanAccountFailure(request.operationId, snapshot.error);
      }
      return {
        version: runtimeProtocolVersion,
        operationId: request.operationId,
        ok: true,
        result: { type: "accepted" },
      };
    }
    case "human.credentials.retry": {
      if (human === null) {
        return operationFailure(
          request.operationId,
          "runtime_unavailable",
          "Cloud account attachment is still starting.",
          true,
          "retry",
        );
      }
      const retried = await human.retryCredentialRecovery(
        request.command.expectedRevision,
      );
      if (!retried.ok) {
        return operationFailure(
          request.operationId,
          retried.kind === "revision_conflict"
            ? "revision_conflict"
            : "invalid_state",
          retried.kind === "revision_conflict"
            ? "Cloud account recovery changed before retry."
            : "Cloud account recovery retry is not required.",
          retried.kind === "revision_conflict",
          retried.kind === "revision_conflict" ? "retry" : "none",
        );
      }
      return {
        version: runtimeProtocolVersion,
        operationId: request.operationId,
        ok: true,
        result: { type: "accepted" },
      };
    }
    case "human.credentials.reconnect": {
      if (human === null) {
        return operationFailure(
          request.operationId,
          "runtime_unavailable",
          "Cloud account attachment is still starting.",
          true,
          "retry",
        );
      }
      const before = human.snapshot();
      if (before.revision !== request.command.expectedRevision) {
        return operationFailure(
          request.operationId,
          "revision_conflict",
          "Cloud account recovery changed before confirmation.",
          true,
          "retry",
        );
      }
      if (before.state !== "recovery_required") {
        return operationFailure(
          request.operationId,
          "invalid_state",
          "Cloud account recovery is not required.",
          false,
          "none",
        );
      }
      const runnerFailure: {
        current: Readonly<{ message: string; retryable: boolean }> | null;
      } = { current: null };
      const runnerDeferred = { current: false };
      const recovered = await human.confirmLegacyCredentialReconnect(
        request.command.expectedRevision,
        async () => {
          const runner = await confirmLegacyRunnerCredentialReconnect();
          if (runner.ok) {
            runnerDeferred.current = runner.deferred;
            return;
          }
          runnerFailure.current = runner;
          throw new Error("runner credential recovery prerequisite failed");
        },
      );
      if (!recovered.ok) {
        const prerequisiteFailure = runnerFailure.current;
        if (prerequisiteFailure !== null) {
          return operationFailure(
            request.operationId,
            "operation_failed",
            prerequisiteFailure.message,
            prerequisiteFailure.retryable,
            prerequisiteFailure.retryable ? "retry" : "none",
          );
        }
        if (recovered.kind === "revision_conflict") {
          return operationFailure(
            request.operationId,
            "revision_conflict",
            "Cloud account recovery changed before confirmation.",
            true,
            "retry",
          );
        }
        if (recovered.kind === "invalid_state") {
          return operationFailure(
            request.operationId,
            "invalid_state",
            "Cloud account recovery is not required.",
            false,
            "none",
          );
        }
        return humanAccountFailure(request.operationId, recovered.error);
      }
      if (runnerDeferred.current) {
        await human.requireLegacyCredentialReconnect();
        return operationFailure(
          request.operationId,
          "operation_failed",
          "Local account recovery completed. Configure cloud attachment to reconnect the preserved runner credential.",
          false,
          "none",
        );
      }
      return {
        version: runtimeProtocolVersion,
        operationId: request.operationId,
        ok: true,
        result: { type: "accepted" },
      };
    }
    case "human.organizations.list": {
      if (human === null) {
        return operationFailure(
          request.operationId,
          "runtime_unavailable",
          "Cloud account attachment is still starting.",
          true,
          "retry",
        );
      }
      const result = await human.listOrganizations({
        ...(request.command.cursor === null
          ? {}
          : { cursor: request.command.cursor }),
        limit: request.command.limit,
      });
      if (!result.ok) {
        return humanAccountFailure(request.operationId, result.error);
      }
      return {
        version: runtimeProtocolVersion,
        operationId: request.operationId,
        ok: true,
        result: {
          type: "humanOrganizations",
          organizations: result.data.organizations.map(
            rendererHumanOrganization,
          ),
          cursor: result.data.cursor,
        },
      };
    }
    case "human.organization.create": {
      const store = humanOrganizationOperations;
      if (human === null || store === null) {
        return operationFailure(
          request.operationId,
          "runtime_unavailable",
          "Cloud account attachment is still starting.",
          true,
          "retry",
        );
      }
      let operation: ReturnType<HumanOrganizationOperationStore["begin"]>;
      try {
        operation = store.begin({
          operationId: request.operationId,
          name: request.command.name,
        });
      } catch (error: unknown) {
        if (!(error instanceof HumanOrganizationOperationConflict)) throw error;
        return operationFailure(
          request.operationId,
          "operation_conflict",
          "The operation ID was already used for another organization.",
          false,
          "none",
        );
      }
      if (operation.state === "started") {
        startHumanOrganizationProvisioning(operation.operationId);
        return {
          version: runtimeProtocolVersion,
          operationId: request.operationId,
          ok: true,
          result: { type: "accepted" },
        };
      }
      if (!operation.outcome.ok) {
        return humanAccountFailure(
          request.operationId,
          operation.outcome.error,
        );
      }
      return {
        version: runtimeProtocolVersion,
        operationId: request.operationId,
        ok: true,
        result: {
          type: "humanOrganization",
          organization: rendererHumanOrganization(
            operation.outcome.organization,
          ),
        },
      };
    }
    case "human.organization.select": {
      if (human === null) {
        return operationFailure(
          request.operationId,
          "runtime_unavailable",
          "Cloud account attachment is still starting.",
          true,
          "retry",
        );
      }
      const result = await human.selectOrganization(
        request.command.organizationId,
      );
      if (!result.ok) {
        return humanAccountFailure(request.operationId, result.error);
      }
      return {
        version: runtimeProtocolVersion,
        operationId: request.operationId,
        ok: true,
        result: { type: "accepted" },
      };
    }
    case "human.workspaces.list": {
      if (human === null) {
        return operationFailure(
          request.operationId,
          "runtime_unavailable",
          "Cloud account attachment is still starting.",
          true,
          "retry",
        );
      }
      const result = await human.listWorkspaces({
        ...(request.command.cursor === null
          ? {}
          : { cursor: request.command.cursor }),
        limit: request.command.limit,
      });
      if (!result.ok) {
        return humanAccountFailure(request.operationId, result.error);
      }
      return {
        version: runtimeProtocolVersion,
        operationId: request.operationId,
        ok: true,
        result: {
          type: "humanWorkspaces",
          workspaces: result.data.workspaces.map(rendererHumanWorkspace),
          cursor: result.data.cursor,
        },
      };
    }
    case "human.workspace.select": {
      if (human === null) {
        return operationFailure(
          request.operationId,
          "runtime_unavailable",
          "Cloud account attachment is still starting.",
          true,
          "retry",
        );
      }
      const result = await human.selectWorkspace(request.command.workspaceId);
      if (!result.ok) {
        return humanAccountFailure(request.operationId, result.error);
      }
      return {
        version: runtimeProtocolVersion,
        operationId: request.operationId,
        ok: true,
        result: { type: "accepted" },
      };
    }
    case "chat.pane.create":
    case "chat.pane.rename":
    case "chat.pane.configure":
    case "chat.pane.repository.select":
    case "chat.pane.remove":
    case "chat.panes.reorder":
    case "chat.turn.start":
    case "chat.turn.stop":
    case "chat.turn.retry":
      throw new Error("A chat command escaped its dedicated service boundary.");
    case "sessionSync.enable":
    case "sessionSync.disable":
    case "sessionSync.retry":
    case "sessionSync.enrollment.approve":
    case "sessionSync.device.revoke":
    case "sessionSync.recovery.reveal":
    case "sessionSync.recovery.import":
    case "sessionSync.recoveryKitSavedOffline":
    case "sessionSync.recovery.rotate":
    case "sessionSync.reset":
      throw new Error("A session sync command escaped its dedicated service boundary.");
    case "runtime.restartAccount":
    case "account.create":
    case "account.login.start":
    case "account.login.cancel":
    case "account.login.open":
    case "account.logout":
    case "account.refresh":
    case "account.remove.preview":
    case "account.remove":
    case "account.localData.delete.preview":
    case "account.localData.delete":
    case "account.select":
      break;
  }
  const service = accountService;
  if (service === null) {
    return operationFailure(
      request.operationId,
      "runtime_unavailable",
      "The local control plane is unavailable.",
      true,
      "restartRuntime",
    );
  }
  try {
    const result = await service.execute(request.command);
    return {
      version: runtimeProtocolVersion,
      operationId: request.operationId,
      ok: true,
      result,
    };
  } catch (error: unknown) {
    if (error instanceof AccountServiceError) {
      return operationFailure(
        request.operationId,
        error.code,
        error.message,
        error.retryable,
        error.action,
      );
    }
    return operationFailure(
      request.operationId,
      "operation_failed",
      "The local operation could not be completed.",
      false,
      "none",
    );
  }
}

async function dispatch(request: RuntimeDispatchRequest): Promise<RuntimeDispatchResponse> {
  if (request.command.type === "maintenance.localDataRemoval.preview") {
    return await previewLocalDataRemoval({
      ...request,
      command: request.command,
    });
  }
  if (request.command.type === "maintenance.localDataRemoval.remove") {
    return operationFailure(
      request.operationId,
      "invalid_request",
      "The removal command requires the private Native launch path.",
      false,
      "none",
    );
  }
  if (localDataRemovalMaintenanceState !== "open") {
    return operationFailure(
      request.operationId,
      "runtime_unavailable",
      "HRA is preparing to remove local data.",
      false,
      "none",
    );
  }
  // Recovery material is an intentionally transient, non-idempotent reveal.
  // It must never enter the generic durable operation-receipt table.
  if (request.command.type === "sessionSync.recovery.reveal") {
    const response = await executeDomainCommand(request);
    publishWithDrainRetry({
      type: "operation.completed",
      operationId: request.operationId,
      outcome: response.ok ? { ok: true } : { ok: false, error: response.error },
    });
    return response;
  }
  const receipts = operationReceipts;
  if (receipts === null) {
    return operationFailure(
      request.operationId,
      "runtime_unavailable",
      "The local control plane is unavailable.",
      true,
      "restartRuntime",
    );
  }

  let receipt: ReturnType<OperationReceiptStore['begin']>;
  try {
    receipt = receipts.begin(request.operationId, request.command);
  } catch (error: unknown) {
    if (!(error instanceof OperationReceiptConflict)) throw error;
    return operationFailure(
      request.operationId,
      "conflict",
      "The operation ID was already used for another command.",
      false,
      "none",
    );
  }

  switch (receipt.state) {
    case "recorded":
      return receipt.response;
    case "inFlight":
      return operationFailure(
        request.operationId,
        "conflict",
        "The operation is already in progress.",
        true,
        "retry",
      );
    case "ambiguous":
      return operationFailure(
        request.operationId,
        "upstream_ambiguous",
        "The previous operation ended without a confirmed outcome.",
        false,
        "resolveAttention",
      );
    case "new": {
      const response = await executeDomainCommand(request);
      if (!response.ok && response.error.code === "upstream_ambiguous") {
        receipts.markAmbiguous(request.operationId);
      } else {
        const entityId = response.ok && response.result.type === "account"
          ? response.result.account.id
          : null;
        receipts.complete(response, entityId);
      }
      publishWithDrainRetry({
        type: "operation.completed",
        operationId: request.operationId,
        outcome: response.ok ? { ok: true } : { ok: false, error: response.error },
      });
      return response;
    }
  }
}

let snapshotRequestTail: Promise<void> = Promise.resolve();
let mutationRequestTail: Promise<void> = Promise.resolve();
let releaseGatewayInitialization!: () => void;
const gatewayInitialization = new Promise<void>((resolve) => {
  releaseGatewayInitialization = resolve;
});

async function respondToSnapshotRequest(
  request: ReturnType<typeof parseHostRequest>,
): Promise<void> {
  const snapshotRequest = parseRuntimeSnapshotRequest(request.payload);
  if ("transferId" in snapshotRequest) {
    await writeHost(
      hostSuccess(request.id, snapshotTransfers.continue(snapshotRequest)),
    );
    return;
  }
  const capture = projection.beginSnapshot();
  try {
    await writeHost(
      hostSuccess(request.id, snapshotTransfers.start(capture.response)),
    );
  } finally {
    capture.release();
  }
}

function queueSnapshotRequest(
  request: ReturnType<typeof parseHostRequest>,
): Promise<void> {
  const response = snapshotRequestTail.then(async () => {
    await respondToSnapshotRequest(request);
  });
  snapshotRequestTail = response.catch(() => undefined);
  return response;
}

function queueMutationRequest(task: () => Promise<void>): Promise<void> {
  const response = mutationRequestTail.then(task);
  mutationRequestTail = response.catch(() => undefined);
  return response;
}

function isIndependentChatMutationRequest(
  request: ReturnType<typeof parseHostRequest>,
): boolean {
  if (request.command !== runtimeDispatchCommand) return false;
  try {
    const payload = parseHostDispatchPayload(request);
    if ("transferId" in payload) return false;
    const parsed = parseRuntimeDispatchRequest(payload);
    return runtimeChatDomainCommandSchema.safeParse(parsed.command).success;
  } catch {
    return false;
  }
}

const startupRemovalRecovery =
  startupLocalDataRemovalRecoveryRequested();

async function respondToMutationRequest(
  request: ReturnType<typeof parseHostRequest>,
): Promise<void> {
  if (request.command === hostHarnessCustodyNativeResultCommand) {
    const result = parseHostHarnessCustodyNativeResultPayload(request);
    const accepted = nativeHarnessKeyCustody.complete(result);
    await writeHost(hostSuccess(request.id, {
      kind: "harnessCustodyNativeResultAccepted",
      version: 1,
      accepted,
    }));
    return;
  }
  if (request.command === hostAccountProfileNativeResultCommand) {
    const result = parseHostAccountProfileNativeResultPayload(request);
    const accepted = accountProfileFileSystem?.complete(result) ?? false;
    await writeHost(hostSuccess(request.id, {
      kind: "accountProfileNativeResultAccepted",
      version: 1,
      accepted,
    }));
    return;
  }
  if (request.command === hostLocalDataRemovalRecoveryCommand) {
    const payload = parseHostLocalDataRemovalRecoveryPayload(request);
    if (!startupRemovalRecovery) {
      throw new TypeError(
        "Local-data removal recovery is not active.",
      );
    }
    const result = await runStartupLocalDataRemovalRecovery({
      effectiveHome: userInfo().homedir,
      nativeRecoveryPrepared: payload.nativeRecoveryPrepared,
      nativeRemovalCapability: parseHostNativeRemovalCapability(request),
      parentProcessId: process.ppid,
      secrets: localDataRemovalKeychain,
    });
    await writeHost(hostSuccess(request.id, result));
    return;
  }
  if (startupRemovalRecovery) {
    throw new TypeError(
      "Recovery-only startup accepts only the private recovery request.",
    );
  }
  if (request.command === hostProjectOnboardingCommand) {
    if (localDataRemovalMaintenanceState !== "open") {
      throw new TypeError("HRA removal maintenance is active.");
    }
    await writeHost(hostSuccess(
      request.id,
      await onboardLocalProject(parseHostProjectOnboardingPayload(request)),
    ));
    return;
  }
  if (request.command !== runtimeDispatchCommand) return;
  const payload = parseHostDispatchPayload(request);
  if ("transferId" in payload) {
    await writeHost(
      hostSuccess(request.id, dispatchTransfers.continue(payload)),
    );
    return;
  }
  const taskRequest = runtimeTaskDispatchRequestSchema.safeParse(payload);
  if (taskRequest.success) {
    const response = localDataRemovalMaintenanceState === "open"
      ? await taskDispatch(taskRequest.data)
      : taskOperationFailure(
        taskRequest.data.operationId,
        "runtime_unavailable",
        "HRA is preparing to remove local data.",
        false,
        "none",
      );
    await writeHost(
      hostSuccess(request.id, dispatchTransfers.start(response)),
    );
    return;
  }
  const runtimeRequest = parseRuntimeDispatchRequest(payload);
  if (
    runtimeRequest.command.type ===
      "maintenance.localDataRemoval.remove"
  ) {
    const response = await removeLocalData({
      ...runtimeRequest,
      command: runtimeRequest.command,
      nativeRemovalCapability: parseHostNativeRemovalCapability(request),
    });
    await writeHost(hostSuccess(request.id, response));
    return;
  }
  const response = await dispatch(runtimeRequest);
  await writeHost(
    hostSuccess(request.id, dispatchTransfers.start(response)),
  );
}

async function respondToHost(line: string): Promise<void> {
  let raw: unknown;
  try {
    raw = JSON.parse(line) as unknown;
  } catch {
    await writeHost(hostFailure("", "invalid_request", "Malformed JSON"));
    return;
  }

  let request: ReturnType<typeof parseHostRequest>;
  try {
    request = parseHostRequest(raw);
  } catch {
    await writeHost(
      hostFailure("", "invalid_request", "Malformed host request"),
    );
    return;
  }

  if (request.command === hostDevelopmentReloadCommand) {
    try {
      const payload = parseHostDevelopmentReloadPayload(request);
      if (parseRuntimeBridgeProfile() !== "development") {
        throw new TypeError(
          "Development reload is unavailable outside the development bridge.",
        );
      }
      if (!developmentReloadAdmission.beginProbe()) {
        await writeHost(hostSuccess(
          request.id,
          hostDevelopmentReloadDecision(payload, "busy"),
        ));
        return;
      }
      await gatewayInitialization;
      const status = developmentReloadAdmission.decideProbe({
        gatewayReady: gatewayReadyForDevelopmentReload,
        ordinaryRequestsInFlight: ordinaryHostRequestsInFlight,
        inMemoryWorkActive: developmentReloadHasInMemoryWork(),
        database,
      });
      if (status === "accepted") sealInternalDevelopmentReloadAdmissions();
      await writeHost(hostSuccess(
        request.id,
        hostDevelopmentReloadDecision(payload, status),
      ));
    } catch {
      await writeHost(
        hostFailure(request.id, "invalid_request", "Invalid runtime request"),
      );
    }
    return;
  }

  if (!developmentReloadAdmission.allowsOrdinaryRequests) {
    await writeHost(
      hostFailure(request.id, "invalid_request", "Runtime admission is closed"),
    );
    return;
  }
  ordinaryHostRequestsInFlight += 1;

  try {
    if (
      request.command === hostAccountProfileNativeResultCommand
      || request.command === hostHarnessCustodyNativeResultCommand
    ) {
      // Both native reconciliation lanes participate in initialization. Their
      // exact private acknowledgements must bypass the barrier or startup can
      // deadlock waiting for a result that the gateway refuses to consume.
      await respondToMutationRequest(request);
      return;
    }
    await gatewayInitialization;
    if (request.command === runtimeSnapshotCommand) {
      if (startupRemovalRecovery) {
        throw new TypeError(
          "Recovery-only startup does not expose snapshots.",
        );
      }
      await queueSnapshotRequest(request);
      return;
    }
    if (isIndependentChatMutationRequest(request)) {
      await respondToMutationRequest(request);
    } else {
      await queueMutationRequest(async () => {
        await respondToMutationRequest(request);
      });
    }
  } catch {
    await writeHost(
      hostFailure(request.id, "invalid_request", "Invalid runtime request"),
    );
  } finally {
    ordinaryHostRequestsInFlight -= 1;
  }
}

const pendingHostRequests = new Set<Promise<void>>();
function trackHostRequest(task: Promise<void>): void {
  pendingHostRequests.add(task);
  void task.finally(() => pendingHostRequests.delete(task)).catch(() => undefined);
}

async function consumeHostInput(): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) trackHostRequest(respondToHost(line));
      newline = buffer.indexOf("\n");
    }
  }
  buffer += decoder.decode();
  if (buffer.trim().length > 0) {
    trackHostRequest(respondToHost(buffer.trim()));
  }
}

const activePackageSmokeRoot = packageSmokeRoot();
if (activePackageSmokeRoot === null) {
  const hostInput = consumeHostInput();
  try {
    if (!startupRemovalRecovery) {
      await initializeGateway();
      gatewayReadyForDevelopmentReload = true;
    }
  } finally {
    // Initialization publishes either ready or a closed failed projection.
    // Releasing in both cases lets already-admitted requests observe that exact
    // terminal startup state instead of racing partially constructed services.
    releaseGatewayInitialization();
  }
  await hostInput;
  await Promise.allSettled([...pendingHostRequests]);
} else {
  await runPackageSmoke(activePackageSmokeRoot);
}
function currentAccountService(): AccountService | null {
  return accountService;
}

function currentChatService(): ChatService | null {
  return chatService;
}

function currentHarnessProductionComposition():
  HarnessProductionCompositionV2 | null {
  return harnessProductionComposition;
}

function currentAccountProfileFileSystem():
  NativeAccountProfileFileSystem | null {
  return accountProfileFileSystem;
}

function currentHumanAccountService(): HumanAccountService | null {
  return humanAccountService;
}

function currentDatabase(): ReturnType<typeof openControlPlane> | null {
  return database;
}

function currentProjectionDrain(): Promise<void> | null {
  return projectionDrain;
}

function currentLifetimeLock(): ControlPlaneLifetimeLock | null {
  return lifetimeLock;
}

type TerminalCleanupStep = () => void | Promise<void>;

async function attemptTerminalCleanup(
  failures: unknown[],
  step: TerminalCleanupStep,
): Promise<void> {
  try {
    await step();
  } catch (error: unknown) {
    failures.push(error);
  }
}

const terminalCleanupFailures: unknown[] = [];
await attemptTerminalCleanup(terminalCleanupFailures, shutdownSessionSync);
await attemptTerminalCleanup(
  terminalCleanupFailures,
  shutdownHRARunnerPairing,
);
await attemptTerminalCleanup(terminalCleanupFailures, shutdownDispatchRunner);
await attemptTerminalCleanup(terminalCleanupFailures, shutdownLocalPromotions);
await attemptTerminalCleanup(
  terminalCleanupFailures,
  shutdownLocalTaskAuthority,
);
await attemptTerminalCleanup(
  terminalCleanupFailures,
  () => localTaskChanges.close(),
);
await attemptTerminalCleanup(terminalCleanupFailures, stopCloudInvalidations);
await attemptTerminalCleanup(
  terminalCleanupFailures,
  stopHumanOrganizationProvisioning,
);
const terminalHumanAccountService = currentHumanAccountService();
await attemptTerminalCleanup(
  terminalCleanupFailures,
  async () => {
    await terminalHumanAccountService?.cancelSignIn();
  },
);
humanAccountService = null;
humanOrganizationOperations = null;
cloudAttachmentAvailability = null;
cloudWorkspaceClient = null;
cloudHumanOperations = null;
cloudInvalidationHeads = null;
await attemptTerminalCleanup(terminalCleanupFailures, () => {
  cloudWorkspaceSummaries.replaceScope(null, {
    invalidatePrevious: false,
  });
});
currentHumanCredentialGeneration = null;
currentHumanOrganizationId = null;
currentHumanUserId = null;
const terminalChatService = currentChatService();
await attemptTerminalCleanup(
  terminalCleanupFailures,
  () => terminalChatService?.closeAdmission(),
);
const terminalHarness = currentHarnessProductionComposition();
let terminalHarnessPreProviderStopPermitted = terminalHarness === null;
await attemptTerminalCleanup(
  terminalCleanupFailures,
  async () => {
    await terminalHarness?.preProviderStop();
    terminalHarnessPreProviderStopPermitted = true;
  },
);
await attemptTerminalCleanup(
  terminalCleanupFailures,
  async () => await terminalChatService?.settled(),
);
const terminalAccountService = currentAccountService();
let terminalProviderSourcesStopped =
  terminalHarnessPreProviderStopPermitted && terminalAccountService === null;
await attemptTerminalCleanup(
  terminalCleanupFailures,
  async () => {
    if (!terminalHarnessPreProviderStopPermitted) return;
    await terminalAccountService?.shutdown();
    terminalProviderSourcesStopped = true;
  },
);
accountService = terminalProviderSourcesStopped ? null : terminalAccountService;
await attemptTerminalCleanup(
  terminalCleanupFailures,
  async () => await terminalChatService?.settled(),
);
chatService = null;
let terminalHarnessDatabaseClosePermitted = terminalHarness === null;
await attemptTerminalCleanup(
  terminalCleanupFailures,
  async () => {
    if (terminalHarness === null) return;
    if (!terminalProviderSourcesStopped) {
      throw new Error(
        "Harness terminal sources cannot close before account runtimes stop.",
      );
    }
    terminalHarness.providerSourcesStopped();
    const report = await terminalHarness.shutdown();
    terminalHarnessDatabaseClosePermitted = report.databaseClosePermitted;
    if (!terminalHarnessDatabaseClosePermitted) {
      throw new Error("Harness shutdown did not permit database close.");
    }
  },
);
if (terminalHarnessDatabaseClosePermitted) {
  harnessProductionComposition = null;
}
const terminalAccountProfileFileSystem = currentAccountProfileFileSystem();
await attemptTerminalCleanup(
  terminalCleanupFailures,
  () => terminalAccountProfileFileSystem?.close(),
);
accountProfileFileSystem = null;
await attemptTerminalCleanup(
  terminalCleanupFailures,
  () => nativeHarnessKeyCustody.close(),
);
projectionCommitAdmissionClosing = true;
projectionCommits.closeAdmission();
await attemptTerminalCleanup(
  terminalCleanupFailures,
  async () => await projectionCommits.settled(),
);
await attemptTerminalCleanup(terminalCleanupFailures, async () => {
  requestProjectionDrain();
  const finalProjectionDrain = currentProjectionDrain();
  if (finalProjectionDrain !== null) await finalProjectionDrain;
});
await attemptTerminalCleanup(
  terminalCleanupFailures,
  () => snapshotTransfers.dispose(),
);
await attemptTerminalCleanup(
  terminalCleanupFailures,
  () => dispatchTransfers.dispose(),
);
const terminalDatabase = currentDatabase();
let terminalDatabaseClosed = terminalDatabase === null;
if (terminalHarnessDatabaseClosePermitted) {
  await attemptTerminalCleanup(
    terminalCleanupFailures,
    () => {
      terminalDatabase?.close();
      terminalDatabaseClosed = true;
    },
  );
}
if (terminalDatabaseClosed) {
  database = null;
  const terminalLifetimeLock = currentLifetimeLock();
  await attemptTerminalCleanup(
    terminalCleanupFailures,
    () => terminalLifetimeLock?.release(),
  );
  lifetimeLock = null;
}
await attemptTerminalCleanup(
  terminalCleanupFailures,
  async () => await hostWriter.close(),
);
if (terminalCleanupFailures.length > 0) {
  throw new AggregateError(
    terminalCleanupFailures,
    "HRA terminal cleanup failed.",
  );
}
