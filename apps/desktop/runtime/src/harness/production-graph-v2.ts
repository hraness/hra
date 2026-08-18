import type { Database } from "bun:sqlite";

import { HRA_RLM_DYNAMIC_TOOL_SPEC_SHA256 } from "../codex";
import type { AccountService } from "../accounts/account-service";
import type { AccountRuntimeRouter } from "../accounts/runtime-router";
import type {
  ChatHarnessActorTurnPort,
  ChatHarnessRootPort,
  ChatProjectionSink,
  ChatRepositoryPort,
} from "../chat";
import type { ChatService } from "../chat";
import type { RuntimeProjection } from "../projection";
import { SessionCommandExecutor } from "../sessions/command-executor";
import type { SessionService } from "../sessions/session-service";
import type { ChatPaneStore } from "../state/chat-pane-store";
import type { ControlPlaneLifetimeLock } from "../state/control-plane-lock";
import type { GitRunner } from "../workspaces/git-runner";
import { WorkspaceBroker } from "../workspaces/workspace-broker";
import { HarnessActorProjectionReconcilerV2 } from
  "./actor-projection-reconciler-v2";
import { ActorResultTransferV2 } from "./actor-result-transfer-v2";
import { HarnessActorContinuationIntentIdentityV2 } from
  "./actor-continuation-intent-identity-v2";
import { PersistentActorContinuationSQLiteAuthorityV2 } from
  "./actor-continuation-intent-sqlite-v2";
import { HarnessActorTokenUsageIdentityV2 } from
  "./actor-token-usage-identity-v2";
import { HarnessActorSessionRecoveryV2 } from
  "./actor-session-recovery-v2";
import {
  HarnessActorWorkspaceIdentityStoreV2,
  PersistentActorWorkspaceRuntimeV2,
} from "./actor-workspace-runtime-v2";
import { HarnessBootAwareRootProjectionV2 } from
  "./boot-aware-root-projection-v2";
import {
  CodexPersistentActorAccountAdapter,
  CodexPersistentActorProvider,
} from "./codex-persistent-actor-provider";
import { ContextSnapshotAuthorityV2 } from
  "./context-snapshot-authority-v2";
import {
  HarnessContextValueNameDigesterV2,
  HarnessContextValueQuotaAuthorityV2,
} from "./production-context-adapters-v2";
import { ContextValueSQLiteAdapterV2 } from
  "./context-value-sqlite-adapter-v2";
import { HarnessContextValuePortsV2 } from "./context-value-ports-v2";
import {
  HarnessContextRecoveryV2,
  contextRecoveryStoreV2,
} from "./context-recovery-v2";
import { EncryptedContextValueStore } from "./context-value-store";
import { RlmV2ContextOperationService } from
  "./context-operation-service-v2";
import { HarnessDynamicToolContextMaterializerV2 } from
  "./dynamic-tool-context-materializer-v2";
import { HarnessDynamicToolEvidenceSettingsAuthorityV2 } from
  "./dynamic-tool-evidence-settings-v2";
import { HarnessDynamicToolServiceV2 } from "./dynamic-tool-service-v2";
import { HarnessDynamicToolStableCallerAuthorityV2 } from
  "./dynamic-tool-stable-caller-v2";
import { HarnessInstallKeyCustody } from "./key-custody";
import { HarnessLongitudinalRoutingShadowAnalyzerV1 } from
  "./longitudinal-routing-shadow-analyzer-v1";
import { LongitudinalRoutingSQLiteAuthorityV1 } from
  "./longitudinal-routing-sqlite-v1";
import { HarnessImmutableObjectStore } from "./object-store";
import {
  PersistentActorCoordinator,
  PersistentActorTokenUsageFactConsumer,
} from "./persistent-actors";
import { PersistentActorLivenessBindingV2 } from
  "./persistent-actor-liveness-binding-v2";
import { PersistentActorLivenessPumpV2 } from
  "./persistent-actor-liveness-v2";
import {
  HarnessActorMutationFenceV2,
  HarnessActorWorkspaceLookupV2,
} from "./production-adapters-v2";
import type {
  HarnessProductionCompositionV2,
  HarnessProductionCompositionV2Parts,
} from "./production-composition-v2";
import { HarnessProductionLifecycleKernelV2 } from
  "./production-lifecycle-kernel-v2";
import {
  ProgramAdmissionIntentAuthorityV2,
  ProgramAdmissionIntentRecoveryV2,
} from "./program-admission-intent-v2";
import { ProgramAdmissionRlmRunRecoveryV2 } from
  "./program-admission-run-recovery-v2";
import {
  HarnessProposalRecoveryV2,
  HarnessProposalService,
} from "./proposal-service";
import { HarnessProposalSQLiteAuthorityV2 } from
  "./proposal-sqlite-authority-v2";
import { HarnessProviderCapabilityReconcilerV2 } from
  "./provider-capability-reconciler-v2";
import { HarnessRendererAuthorityV2 } from "./renderer-authority-v2";
import { HarnessRendererEffectsV2 } from "./renderer-effects-v2";
import { HarnessRendererService } from "./renderer-service-v2";
import type { HarnessRendererProjectionPort } from "./renderer-service-v2";
import { HarnessRendererSQLiteAdapterV2 } from
  "./renderer-sqlite-adapter-v2";
import { RlmCallerAuthorityV2 } from "./rlm-caller-authority-v2";
import { RlmV2OperationRouter } from "./rlm-operation-router-v2";
import { RlmRunAuthorityV2 } from "./rlm-run-authority-v2";
import { RlmRuntimeV2 } from "./rlm-runtime-v2";
import { HarnessRootActorAuthorityV2 } from "./root-actor-authority-v2";
import { HarnessRootChatAdmissionV2 } from "./root-chat-admission-v2";
import { HarnessSQLiteRootProjectResolverV2 } from
  "./root-project-resolver-v2";
import { HarnessRootSessionLifecycleV2 } from
  "./root-session-lifecycle-v2";
import { HarnessRootSessionSQLiteLookupV2 } from
  "./root-session-sqlite-lookup-v2";
import { HarnessSQLiteAuthorityV2 } from "./sqlite-authority-v2";
import {
  assertHarnessDirectoryIdentity,
  prepareHarnessStorageLayout,
} from "./storage-layout";

export interface HarnessProductionGraphV2Options {
  readonly accounts: AccountService;
  readonly composition: HarnessProductionCompositionV2;
  readonly controlPlanePath: string;
  readonly chatProjection: Pick<ChatProjectionSink, "paneChanged">;
  readonly database: Database;
  readonly git: GitRunner;
  readonly lifetimeLock: ControlPlaneLifetimeLock;
  readonly panes: ChatPaneStore;
  readonly projection: RuntimeProjection;
  readonly rendererProjection: HarnessRendererProjectionPort;
  readonly repositories: ChatRepositoryPort;
  readonly runtimes: AccountRuntimeRouter;
  readonly sessions: SessionService;
  readonly isForegroundIdle: () => boolean;
  readonly onShadowRoutingAnalysisFault: (error: Error) => void;
  readonly onActorSessionRecoveryFatalFailure: (error: Error) => void;
  readonly createChat: (ports: Readonly<{
    harnessActors: ChatHarnessActorTurnPort;
    harnessRoots: ChatHarnessRootPort;
  }>) => ChatService;
  readonly keyCustody?: HarnessInstallKeyCustody;
}

export interface HarnessProductionGraphV2 {
  readonly chat: ChatService;
  readonly parts: HarnessProductionCompositionV2Parts;
  readonly workspaces: WorkspaceBroker;
}

/**
 * Constructs the complete provider-dependent v2 graph and binds it once.
 * Nothing returned by this function is optional. The caller still owns the
 * single boot boundary by invoking `composition.initialize()` only after all
 * gateway callback closures point at the returned ChatService.
 */
export function createHarnessProductionGraphV2(
  options: HarnessProductionGraphV2Options,
): HarnessProductionGraphV2 {
  const storage = prepareHarnessStorageLayout(options.controlPlanePath);
  const keys = options.keyCustody ?? new HarnessInstallKeyCustody();
  const objects = new HarnessImmutableObjectStore({
    directory: storage.contextValues,
  });
  const contextMetadata = new ContextValueSQLiteAdapterV2(options.database);
  const encryptedValues = new EncryptedContextValueStore({
    keys,
    metadata: contextMetadata,
    objects,
  });
  const names = new HarnessContextValueNameDigesterV2(keys);
  const values = new HarnessContextValuePortsV2(
    encryptedValues,
    names,
    new HarnessContextValueQuotaAuthorityV2(options.database),
  );
  const contextRecovery = new HarnessContextRecoveryV2({
    store: contextRecoveryStoreV2(encryptedValues),
  });
  const snapshots = new ContextSnapshotAuthorityV2(options.database);

  const actors = new HarnessSQLiteAuthorityV2(options.database, {
    tokenUsageIdentities: new HarnessActorTokenUsageIdentityV2(keys),
  });
  const rootActors = new HarnessRootActorAuthorityV2(options.database, {
    actors,
  });
  const workspaceIdentities = new HarnessActorWorkspaceIdentityStoreV2(
    options.database,
  );
  const workspaces = new WorkspaceBroker({
    git: options.git,
    identityStore: workspaceIdentities,
    readOnlyIdentityStore: workspaceIdentities,
    lanesRoot: storage.lanesRoot,
    lanesRootGuard: {
      assertCurrent: (path) => {
        if (path !== storage.lanesRoot) {
          throw new Error("Harness worktree root identity changed.");
        }
        assertHarnessDirectoryIdentity(storage.lanesRootIdentity);
      },
    },
  });
  const actorWorkspaces = new PersistentActorWorkspaceRuntimeV2({
    database: options.database,
    authority: actors,
    broker: workspaces,
    identities: workspaceIdentities,
  });
  const continuationIntents =
    new PersistentActorContinuationSQLiteAuthorityV2(options.database, {
      identities: new HarnessActorContinuationIntentIdentityV2(keys),
    });
  const liveness = new PersistentActorLivenessBindingV2();
  const actorProvider = new CodexPersistentActorProvider({
    commands: new SessionCommandExecutor(options.accounts),
    sessions: options.sessions,
    sessionRuntimes: options.accounts,
    workspaces: new HarnessActorWorkspaceLookupV2(options.database),
    values,
    mutationFences: new HarnessActorMutationFenceV2({
      runtimes: options.runtimes,
      lifetimeLock: options.lifetimeLock,
    }),
    continuationIntents,
    tokenUsage: {
      readTurnUsage: (input) => Promise.resolve(
        actors.readActorTurnUsageForObservation(input),
      ),
    },
    toolsetDigest: HRA_RLM_DYNAMIC_TOOL_SPEC_SHA256,
  });
  const actorSessions = new HarnessActorSessionRecoveryV2({
    accounts: {
      ensureExactActorAccountRuntime: async ({ accountProfileId }) =>
        await options.accounts.ensureSessionRuntime(accountProfileId),
    },
    authority: actors,
    sessions: options.sessions,
    onIncarnationReady: (incarnationId) => liveness.requestReconciliation({
      incarnationIds: [incarnationId],
    }),
    onFatalFailure: options.onActorSessionRecoveryFatalFailure,
  });
  const actorCoordinator = new PersistentActorCoordinator({
    authority: actors,
    provider: actorProvider,
    accounts: new CodexPersistentActorAccountAdapter({
      accounts: options.accounts,
      authority: actors,
      runtimes: options.runtimes,
      sessions: options.sessions,
    }),
    workspaces: actorWorkspaces,
    values,
    toolsetDigest: HRA_RLM_DYNAMIC_TOOL_SPEC_SHA256,
    liveness,
    sessionReadiness: actorSessions,
  });

  const proposalAuthority = new HarnessProposalSQLiteAuthorityV2(
    options.database,
  );
  const proposals = new HarnessProposalService({
    authority: proposalAuthority,
    values,
  });
  const proposalRecovery = new HarnessProposalRecoveryV2({
    authority: proposalAuthority,
    values,
  });
  const rendererStore = new HarnessRendererSQLiteAdapterV2(options.database, {
    actors,
  });
  const rendererEffects = new HarnessRendererEffectsV2({
    database: options.database,
    actors,
    renderer: rendererStore,
    panes: options.panes,
    sessions: options.sessions,
    repositories: options.repositories,
    coordinator: actorCoordinator,
    liveness,
    values,
    responses: values,
    projection: options.chatProjection,
  });
  const rendererAuthority = new HarnessRendererAuthorityV2({
    settings: rendererStore,
    proposals: rendererStore,
    actors: rendererStore,
    chat: rendererEffects,
    coordinator: rendererEffects,
  });
  const renderer = new HarnessRendererService({
    authority: rendererAuthority,
    projection: options.rendererProjection,
  });
  const actorProjections = new HarnessActorProjectionReconcilerV2({
    authority: rendererStore,
    refresh: () => renderer.refresh(),
  });
  const chat = options.createChat({
    harnessActors: rendererEffects,
    harnessRoots: options.composition.rootChat,
  });
  const bootProjection = new HarnessBootAwareRootProjectionV2({
    authority: rendererStore,
    reconciler: actorProjections,
    chat,
    projection: options.projection,
    liveness,
    createLiveness: () => new PersistentActorLivenessPumpV2({
      actors: actorCoordinator,
      eventRoutes: options.sessions,
      projections: actorProjections,
    }),
  });
  const rootSessions = new HarnessRootSessionLifecycleV2({
    authority: rootActors,
    lookup: new HarnessRootSessionSQLiteLookupV2(options.database, {
      actors,
      roots: rootActors,
    }),
    projections: bootProjection,
  });
  const rootAdmission = new HarnessRootChatAdmissionV2({
    projects: new HarnessSQLiteRootProjectResolverV2({
      database: options.database,
      workspaces,
    }),
    roots: rootSessions,
    values,
  });

  const runs = new RlmRunAuthorityV2(options.database);
  const runCallers = new RlmCallerAuthorityV2(options.database);
  const programAdmissions = new ProgramAdmissionIntentAuthorityV2(
    options.database,
    { runRecovery: new ProgramAdmissionRlmRunRecoveryV2(runs) },
  );
  const programAdmissionRecovery = new ProgramAdmissionIntentRecoveryV2({
    authority: programAdmissions,
  });
  const contextOperations = new RlmV2ContextOperationService({
    snapshots,
    values,
    names,
  });
  const routing = new LongitudinalRoutingSQLiteAuthorityV1(options.database);
  const shadowRoutingAnalyzer =
    new HarnessLongitudinalRoutingShadowAnalyzerV1({
      authority: routing,
      idle: {
        isIdle: () => !chat.hasUnsettledWork()
          && !options.composition.hasUnsettledWork()
          && options.isForegroundIdle(),
      },
      onFault: options.onShadowRoutingAnalysisFault,
    });
  const operationRouter = new RlmV2OperationRouter({
    bindings: runCallers,
    context: contextOperations,
    actors: actorCoordinator,
    actorOperationContracts: {
      readForActor: ({ actorId }) => {
        // Policy version selects only the actor argument shape. The admitted
        // operation set is separately bound to the incarnation toolset digest
        // by HarnessDynamicToolEvidenceSettingsAuthorityV2.
        const policy = actors.readActorDispatchPolicy(actorId);
        if (policy === null) {
          throw new Error("RLM actor operation contract lacks durable policy");
        }
        return policy.policyVersion === 0
          ? "predecessorRecoveryOnly"
          : "current";
      },
    },
    actorResults: new ActorResultTransferV2({
      authority: actors,
      values,
    }),
    routing,
    proposals,
  });
  const rlm = new RlmRuntimeV2({
    authority: runs,
    values,
    callers: runCallers,
    operations: operationRouter,
  });
  const stableCallers = new HarnessDynamicToolStableCallerAuthorityV2({
    sessions: options.sessions,
    actors: rootActors,
    contexts: new HarnessDynamicToolContextMaterializerV2({
      admissions: programAdmissions,
      snapshots,
      values,
    }),
    evidence: new HarnessDynamicToolEvidenceSettingsAuthorityV2({
      database: options.database,
      runtimes: options.runtimes,
      actors,
    }),
    runs: {
      readRun: (runId) => runs.readRun(runId),
      readContextSnapshot: (snapshotId) => snapshots.read(snapshotId),
    },
  });
  const dynamicTools = new HarnessDynamicToolServiceV2({
    admissions: programAdmissions,
    callers: stableCallers,
    router: options.runtimes,
    runtime: rlm,
  });
  const providerCapabilities = new HarnessProviderCapabilityReconcilerV2({
    initialEnabled: rendererStore.read().settings.recursiveSessionsEnabled,
    runtimes: options.runtimes,
    sessions: options.sessions,
    settleChat: () => chat.settled(),
  });
  const lifecycle = new HarnessProductionLifecycleKernelV2({
    contexts: contextRecovery,
    proposals: proposalRecovery,
    rootSessions,
    chat: bootProjection,
    actorSessions,
    actors: actorCoordinator,
    programAdmissions: programAdmissionRecovery,
    rlm,
    projections: {
      rendererRefresh: "included",
      reconcileAll: () => actorProjections.reconcileAll(),
      settled: () => actorProjections.settled(),
    },
    renderer,
    shadowRoutingAnalyzer,
    dynamicTools,
    liveness,
    keyCustody: keys,
  });
  const parts: HarnessProductionCompositionV2Parts = Object.freeze({
    settings: {
      read: () => rendererStore.read().settings,
    },
    renderer,
    dynamicTools,
    roots: rootSessions,
    rootAdmission,
    providerCapabilities,
    liveness,
    harnessFactConsumer: new PersistentActorTokenUsageFactConsumer(
      actors,
      actorCoordinator,
    ),
    chat: {
      closeAdmission: () => chat.closeAdmission(),
      settled: () => chat.settled(),
    },
    lifecycle,
  });
  options.composition.bind(parts);
  return Object.freeze({ chat, parts, workspaces });
}
