import { z } from "@hra-internal/schema";
import {
  canonicalScheduledChatRRuleSchema,
  MAX_SCHEDULED_CHAT_RRULE_UTF8_BYTES,
  MAX_SCHEDULED_CHAT_TIME_ZONE_UTF8_BYTES,
  organizationIdSchema,
  organizationNameSchema,
  organizationRoleSchema,
  hraWorkspaceCapabilitiesSchema,
  portableInvalidationSchema,
  parseCanonicalScheduledChatRRule,
  portableProjectionCursorSchema,
  revisionSchema as workspaceProjectionRevisionSchema,
  taskWorkspaceMutationIntentSchema,
  taskWorkspaceMutationResultSchema,
  taskWorkspaceViewerSchema,
  taskDetailProjectionSchema,
  taskDomain,
  taskListPageSchema,
  taskPublicIdSchema,
  taskWorkspaceViewSchema,
  workspaceIdSchema,
  workspacePublicIdSchema,
  workspaceSummarySchema,
  workspaceViewSchema,
  workosOrganizationIdSchema,
  workosUserIdSchema,
  runnerPresenceViewSchema,
  sessionPublicIdSchema as syncedSessionPublicIdSchema,
  sessionSyncEnrollmentRequestIdSchema,
  scheduledChatTimeZoneSchema,
  syncEnrollmentPairingCodeSchema,
  syncDeviceIdSchema,
  type OperationReceipt,
  type PortableInvalidation,
  type TaskWorkspaceMutationIntent,
  type TaskWorkspaceMutationResult,
  type TaskDetailProjection,
  type TaskListPage,
  type WorkspaceSummary,
} from "@hraness/agent-tasks-protocol";

export const runtimeProtocolVersion = 3 as const;
export const runtimeSnapshotCommand = "hra.runtime.snapshot" as const;
export const runtimeDispatchCommand = "hra.runtime.dispatch" as const;
/** Pathless Native chooser request; private onboarding remains host-only. */
export const runtimeProjectAddCommand = "hra.project.add" as const;
/** Pathless Native chooser for the one folder shared by every local chat. */
export const runtimeFolderAccessSelectCommand = "hra.folderAccess.select" as const;
export const runtimeEventName = "hra:runtime-event" as const;
/** Pathless Native-owned gateway lifecycle recovery command. */
export const runtimeTransportRetryCommand = "hra.runtime.retryTransport" as const;
export const runtimeTransportHealthCommand = "hra.runtime.confirmTransportHealth" as const;
/** Separate from gateway projection events so each process generation has its own sequence floor. */
export const runtimeTransportLifecycleEventName = "hra:runtime-transport" as const;
export const runtimeSnapshotChunkByteLimit = 512 * 1024;
export const runtimeSnapshotChunkBase64Limit =
  Math.ceil(runtimeSnapshotChunkByteLimit / 3) * 4;
export const runtimeDispatchChunkByteLimit = runtimeSnapshotChunkByteLimit;
export const runtimeDispatchChunkBase64Limit =
  Math.ceil(runtimeDispatchChunkByteLimit / 3) * 4;
/** 64 MiB serialized ceiling, above the escaped worst-case 64-pane snapshot. */
export const runtimeSnapshotChunkCountLimit = 128;
export const runtimeDispatchChunkCountLimit = 64;
export const runtimeTaskWorkspaceSummaryLimit = 64;
export const runtimeTaskRepositorySummaryLimit = 128;
export const runtimeTaskListPageLimit = 100;
export const runtimeTaskMutationAttemptListLimit = 32;
export const runtimeChatPaneLimit = 64;
export const runtimeAccountProfileLimit = 64;
export const runtimeRetainedAccountLocalDataLimit = 64;
export const runtimeSessionSyncDeviceHistoryLimit = 64;
export const runtimeSessionSyncPendingEnrollmentLimit = 8;
export const runtimeSessionSyncRemoteSessionLimit = 512;
export const runtimeSessionSyncRecoveryKitUtf8ByteLimit = 64 * 1_024;
export interface RuntimeSessionSyncCapabilities {
  readonly enable: boolean;
  readonly disable: boolean;
  readonly retry: boolean;
  readonly recoveryReveal: boolean;
  readonly recoveryAcknowledgement: boolean;
  readonly enrollmentApproval: boolean;
  readonly deviceRevocation: boolean;
  readonly recoveryImport: boolean;
  readonly recoveryRotation: boolean;
  readonly vaultReset: boolean;
}

/**
 * Shipping desktop command availability. The protocol keeps future command
 * shapes parseable so older and newer processes fail closed, but the renderer
 * must expose only operations backed by a complete coordinator path.
 */
export const runtimeSessionSyncCapabilities: RuntimeSessionSyncCapabilities =
  Object.freeze({
    enable: true,
    disable: true,
    retry: true,
    recoveryReveal: true,
    recoveryAcknowledgement: true,
    enrollmentApproval: false,
    deviceRevocation: false,
    recoveryImport: false,
    recoveryRotation: false,
    vaultReset: false,
  });
export const runtimeChatToolLimit = 32;
export const runtimeChatProviderSubagentLimit = 8;
export const runtimeChatProviderSubagentTrackedLimit = 128;
export const runtimeChatPaletteIndexLimit = Number.MAX_SAFE_INTEGER - 1;
export const runtimeChatContinuationLimit = 63;
export const runtimeHarnessChildProjectionLimit = 8;
export const runtimeHarnessProposalProjectionLimit = 32;
export const runtimeHarnessContextQuotaMinimumBytes = 1024 * 1024;
export const runtimeHarnessContextQuotaMaximumBytes = 64 * 1024 * 1024;
export const runtimeChatResponseTailUtf8ByteLimit = 256 * 1024;
export const runtimeChatReasoningTailUtf8ByteLimit = 64 * 1024;
export const runtimeChatTurnPromptUtf8ByteLimit = 128 * 1024;
export const runtimeChatQueuedMessageLimit = 32;
export const runtimeChatMessageAttachmentLimit = 8;
export const runtimeChatAttachmentDraftLimit = 8;
export const runtimeChatAttachmentReferencedLimit = 256;
export const runtimeChatAttachmentDisplayNameUtf8ByteLimit = 160;
export const runtimeChatAttachmentMediaTypeByteLimit = 127;
export const runtimeChatAttachmentInputByteLimit = 24 * 1024 * 1024;
export const runtimeChatAttachmentChunkByteLimit = 512 * 1024;
export const runtimeChatAttachmentPreviewByteLimit = 512 * 1024;
export const runtimeChatMessageUtf8ByteLimit = runtimeChatTurnPromptUtf8ByteLimit;
export const runtimeChatScheduleRruleUtf8ByteLimit = MAX_SCHEDULED_CHAT_RRULE_UTF8_BYTES;
export const runtimeChatScheduleTimeZoneUtf8ByteLimit =
  MAX_SCHEDULED_CHAT_TIME_ZONE_UTF8_BYTES;
export const runtimeChatQueueUtf8ByteLimit = 512 * 1024;
export const runtimeNativeBridgeRequestUtf8ByteLimit = 1024 * 1024;
export const runtimeChatDeltaUtf8ByteLimit = 4 * 1024;
export const runtimeEventUtf8ByteLimit = 7_168;

const opaqueId = (prefix: string) =>
  z
    .string()
    .min(prefix.length + 8)
    .max(96)
    .regex(new RegExp(`^${prefix}_[A-Za-z0-9_-]+$`, "u"));

export const operationIdSchema = opaqueId("op");
export const accountProfileIdSchema = opaqueId("acct");
export const chatPaneIdSchema = opaqueId("pane");
export const chatTurnIdSchema = opaqueId("chatturn");
export const chatToolIdSchema = opaqueId("chattool");
export const chatProviderSubagentIdSchema = opaqueId("provideragent");
export const chatMessageIdSchema = opaqueId("chatmsg");
export const chatMessageAttachmentIdSchema = opaqueId("attachment");
export const chatAttachmentUploadIdSchema = opaqueId("upload");
export const harnessActorIdSchema = opaqueId("hactor");
export const harnessProposalIdSchema = opaqueId("hproposal");
export const snapshotTransferIdSchema = opaqueId("snapshot");
export const dispatchTransferIdSchema = opaqueId("response");
export const localDataRemovalPreviewIdSchema = opaqueId("removal");
export const localDataRemovalConfirmationTokenSchema = opaqueId("confirm");
export const revisionSchema = z.number().int().positive();
/** Native delivery order. It is not a per-workspace SQLite event sequence. */
export const nativeTransportSequenceSchema = z.number().int().nonnegative().safe();
export const sequenceSchema = nativeTransportSequenceSchema;

export const runtimeTransportLifecycleSchema = z.discriminatedUnion("state", [
  z
    .object({
      version: z.literal(1),
      state: z.literal("starting"),
      generation: z.number().int().positive().safe(),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      state: z.literal("ready"),
      generation: z.number().int().positive().safe(),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      state: z.literal("backingOff"),
      generation: z.number().int().positive().safe(),
      attempt: z.number().int().positive().safe(),
      retryAtUnixMilliseconds: z.number().int().nonnegative().safe(),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      state: z.literal("failed"),
      generation: z.number().int().positive().safe(),
      canRetry: z.boolean(),
      message: z.string().min(1).max(240),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      state: z.literal("stopping"),
      generation: z.number().int().positive().safe(),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      state: z.literal("stopped"),
      generation: z.number().int().positive().safe(),
    })
    .strict(),
]);

export const runtimeTransportRetryResponseSchema = z
  .object({
    version: z.literal(1),
    status: z.enum(["accepted", "alreadyReady", "unavailable"]),
  })
  .strict();
/** Exact JavaScript `Date#toISOString()` form, including millisecond precision. */
export const chatIsoDateTimeSchema = z.string()
  .length(24, "chat timestamp must use canonical YYYY-MM-DDTHH:mm:ss.sssZ form")
  .datetime()
  .refine(
    (value) => {
      const milliseconds = Date.parse(value);
      return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
    },
    "chat timestamp must use canonical YYYY-MM-DDTHH:mm:ss.sssZ form",
  );

const runtimeStatusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("starting"), generation: z.number().int().nonnegative() }).strict(),
  z.object({ state: z.literal("ready"), generation: z.number().int().positive() }).strict(),
  z
    .object({
      state: z.literal("backingOff"),
      generation: z.number().int().positive(),
      retryAt: z.string().datetime(),
      attempt: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      state: z.literal("failed"),
      generation: z.number().int().nonnegative(),
      message: z.string().min(1).max(240),
      canRestart: z.boolean(),
    })
    .strict(),
  z.object({ state: z.literal("stopped"), generation: z.number().int().nonnegative() }).strict(),
]);

const runnerConnectionStatusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("notPaired") }).strict(),
  z.object({ state: z.literal("recovering") }).strict(),
  z.object({ state: z.literal("connecting") }).strict(),
  z.object({ state: z.literal("connected") }).strict(),
  z
    .object({
      state: z.literal("attention"),
      reason: z.enum(["configuration", "connection", "noRepository"]),
    })
    .strict(),
]);

const accountLoginStateSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("idle") }).strict(),
  z
    .object({
      state: z.literal("starting"),
      mode: z.enum(["browser", "deviceCode"]),
      startedAt: z.string().datetime(),
    })
    .strict(),
  z.object({ state: z.literal("waitingForBrowser"), startedAt: z.string().datetime() }).strict(),
  z
    .object({
      state: z.literal("waitingForDeviceCode"),
      userCode: z.string().min(1).max(128),
      startedAt: z.string().datetime(),
    })
    .strict(),
  z
    .object({
      state: z.literal("canceling"),
      mode: z.enum(["browser", "deviceCode"]),
    })
    .strict(),
  z.object({ state: z.literal("failed"), message: z.string().min(1).max(240) }).strict(),
]);

const accountSummarySchema = z
  .object({
    id: accountProfileIdSchema,
    revision: revisionSchema,
    label: z.string().min(1).max(80),
    selected: z.boolean(),
    identityLabel: z.string().min(1).max(160).nullable(),
    planLabel: z.string().min(1).max(80).nullable(),
    usageRemainingPercent: z.number().min(0).max(100).nullable().default(null),
    authState: z.enum([
      "signedOut",
      "signingIn",
      "signingOut",
      "signedIn",
      "expired",
      "unknown",
    ]),
    login: accountLoginStateSchema,
    runtime: runtimeStatusSchema,
  })
  .strict();

const accountRemovalPreviewSchema = z
  .object({
    accountProfileId: accountProfileIdSchema,
    accountRevision: revisionSchema,
    label: z.string().min(1).max(80),
    threadCount: z.number().int().safe().nonnegative(),
    workspaceLaneCount: z.number().int().safe().nonnegative(),
    loginActive: z.boolean(),
    runtimeActive: z.boolean(),
    localDataState: z.enum(["present", "deleted"]),
    blockers: z
      .array(z.enum([
        "activeTurn",
        "pendingInteraction",
        "loginActive",
        "runtimeStopping",
        "retainedLocalDataCapacity",
      ]))
      .max(5),
    canRemove: z.boolean(),
  })
  .strict();

const retainedAccountLocalDataSchema = z
  .object({
    id: accountProfileIdSchema,
    revision: revisionSchema,
    label: z.string().min(1).max(80),
    removedAt: z.string().datetime(),
  })
  .strict();

const accountLocalDataDeletionPreviewSchema = z
  .object({
    accountProfileId: accountProfileIdSchema,
    accountRevision: revisionSchema,
    label: z.string().min(1).max(80),
    removedAt: z.string().datetime(),
    deletes: z
      .object({
        credentials: z.literal(true),
        sessionsAndHistory: z.literal(true),
        configuration: z.literal(true),
        logs: z.literal(true),
      })
      .strict(),
  })
  .strict();

export const runtimeLocalDataRemovalConfirmation =
  "REMOVE HRA LOCAL DATA" as const;
export const runtimeSessionSyncResetConfirmation =
  "RESET SYNCED SESSION DATA" as const;
export const runtimeHumanCredentialReconnectConfirmation =
  "PRESERVE UNREADABLE CREDENTIALS AND SIGN IN AGAIN" as const;
export const sessionSyncRecoveryRevealIdSchema = z.string().regex(
  /^syncreveal_[A-Za-z0-9_-]{32}$/u,
  "invalid session sync recovery reveal ID",
);

const rendererSafeItemCountSchema = z.number().int().safe().nonnegative();

/**
 * This is intentionally category-only. Filesystem paths, Keychain item names,
 * helper request locations, and other privileged target details must never
 * cross into the renderer.
 */
export const runtimeLocalDataRemovalPreviewSchema = z
  .object({
    previewId: localDataRemovalPreviewIdSchema,
    confirmationToken: localDataRemovalConfirmationTokenSchema,
    expiresAt: z.string().datetime(),
    removes: z
      .object({
        controlPlaneItems: rendererSafeItemCountSchema,
        hraCodexProfileDataItems: rendererSafeItemCountSchema,
        humanCredentialGenerations: rendererSafeItemCountSchema,
        runnerPairingSecrets: rendererSafeItemCountSchema,
        harnessContextHeapKeys: rendererSafeItemCountSchema.max(2),
        sessionSyncKeyMaterials: rendererSafeItemCountSchema.max(2),
        releaseUpdateArtifacts: rendererSafeItemCountSchema,
        applicationStateItems: rendererSafeItemCountSchema,
        managedWorktrees: rendererSafeItemCountSchema,
        dirtyManagedWorktrees: rendererSafeItemCountSchema,
      })
      .strict(),
    preserves: z
      .object({
        userRepositories: rendererSafeItemCountSchema,
        externalCodexData: z.literal(true),
        taskctlCredentials: z.literal(true),
        credentialRecoveryEvidenceRecords: rendererSafeItemCountSchema,
        unrelatedData: z.literal(true),
      })
      .strict(),
    dirtyWorktreeAcknowledgementRequired: z.boolean(),
    blockers: z
      .array(
        z.enum([
          "helperUnavailable",
          "operationInProgress",
          "targetValidationFailed",
        ]),
      )
      .max(3),
    canRemove: z.boolean(),
  })
  .strict()
  .superRefine((preview, context) => {
    if (
      preview.dirtyWorktreeAcknowledgementRequired !==
        (preview.removes.dirtyManagedWorktrees > 0)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "dirty-worktree acknowledgement must match the preserved dirty-worktree count",
        path: ["dirtyWorktreeAcknowledgementRequired"],
      });
    }
    if (
      preview.removes.dirtyManagedWorktrees >
        preview.removes.managedWorktrees
    ) {
      context.addIssue({
        code: "custom",
        message:
          "dirty managed worktrees must be a subset of all managed worktrees",
        path: ["removes", "dirtyManagedWorktrees"],
      });
    }
    if (preview.canRemove !== (preview.blockers.length === 0)) {
      context.addIssue({
        code: "custom",
        message: "removal availability must match the blocker set",
        path: ["canRemove"],
      });
    }
  });

const humanAccountErrorCodeSchema = z.enum([
  "AUTHENTICATION_FAILED",
  "AUTH_REFRESH_INDETERMINATE",
  "CONFIGURATION_UNAVAILABLE",
  "CREDENTIAL_RECOVERY_REQUIRED",
  "NOT_FOUND",
  "PROVISIONING_FAILED",
  "PROVISIONING_IN_PROGRESS",
  "SERVICE_UNAVAILABLE",
  "SIGNED_OUT",
  "VALIDATION_ERROR",
]);

const runtimeHumanUserSchema = z
  .object({
    id: workosUserIdSchema,
    email: z.string().email(),
    name: z.string().min(1).max(240).nullable(),
  })
  .strict();

const runtimeHumanOrganizationSchema = z
  .object({
    id: organizationIdSchema,
    name: organizationNameSchema,
    role: organizationRoleSchema,
    status: z.enum(["provisioning", "active", "failed"]),
    workosOrganizationId: workosOrganizationIdSchema.nullable(),
  })
  .strict()
  .superRefine((organization, context) => {
    if (
      organization.status === "active" &&
      organization.workosOrganizationId === null
    ) {
      context.addIssue({
        code: "custom",
        message: "active organization requires a WorkOS organization ID",
        path: ["workosOrganizationId"],
      });
    }
  });

const humanAccountProfileSchema = z
  .object({
    user: runtimeHumanUserSchema,
    organization: runtimeHumanOrganizationSchema.nullable(),
    workspace: workspaceViewSchema.nullable(),
  })
  .strict()
  .superRefine((profile, context) => {
    if (
      profile.workspace !== null &&
      (
        profile.organization === null ||
        profile.workspace.organizationId !== profile.organization.id
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "selected cloud workspace must belong to the selected organization",
        path: ["workspace"],
      });
    }
  });

export const humanAccountSnapshotSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("unavailable"),
      revision: z.number().int().nonnegative().safe(),
      reason: z.enum([
        "configuration_missing",
        "configuration_invalid",
        "initializing",
      ]),
    })
    .strict(),
  z
    .object({
      state: z.literal("signedOut"),
      revision: z.number().int().nonnegative().safe(),
    })
    .strict(),
  z
    .object({
      state: z.literal("recoveryRequired"),
      revision: z.number().int().nonnegative().safe(),
      reason: z.literal("legacyCredentialAccessDenied"),
    })
    .strict(),
  z
    .object({
      state: z.literal("signingIn"),
      revision: z.number().int().nonnegative().safe(),
      userCode: z.string().min(1).max(128).nullable(),
      expiresAt: taskDomain.epochMsSchema.nullable(),
    })
    .strict(),
  z
    .object({
      state: z.literal("signedIn"),
      revision: z.number().int().nonnegative().safe(),
      profile: humanAccountProfileSchema,
    })
    .strict(),
  z
    .object({
      state: z.literal("error"),
      revision: z.number().int().nonnegative().safe(),
      code: humanAccountErrorCodeSchema,
      message: z.string().min(1).max(240),
      retryable: z.boolean(),
      profile: humanAccountProfileSchema.nullable(),
    })
    .strict(),
]);

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function utf8ByteLength(value: string): number {
  return utf8Encoder.encode(value).byteLength;
}

function utf8StringSchema(options: {
  readonly minBytes?: number;
  readonly maxBytes: number;
}) {
  const minBytes = options.minBytes ?? 0;
  return z.string().refine(
    (value) => {
      const encoded = utf8Encoder.encode(value);
      return encoded.byteLength >= minBytes &&
        encoded.byteLength <= options.maxBytes &&
        !value.includes("\0") &&
        utf8Decoder.decode(encoded) === value;
    },
    `text must be NUL-free valid Unicode containing ${minBytes}..${options.maxBytes} UTF-8 bytes`,
  );
}

const chatPaneTitleSchema = z
  .string()
  .min(1)
  .max(160)
  .refine(
    (value) => {
      const encoded = utf8Encoder.encode(value);
      return value === value.trim()
        && !value.includes("\0")
        && utf8Decoder.decode(encoded) === value;
    },
    "chat pane title must be trimmed, NUL-free, and valid Unicode",
  );

export const chatModelSchema = z.literal("gpt-5.6-sol");
export const chatReasoningEffortSchema = z.enum(["ultra", "max"]);
export const chatServiceTierSchema = z.enum(["standard", "fast"]);
export const chatScheduleProjectionSchema = z
  .object({
    revision: revisionSchema,
    rrule: canonicalScheduledChatRRuleSchema,
    timeZone: scheduledChatTimeZoneSchema,
    nextRunAt: chatIsoDateTimeSchema,
  })
  .strict()
  .superRefine((schedule, context) => {
    if (parseCanonicalScheduledChatRRule(schedule.rrule)?.timeZone !== schedule.timeZone) {
      context.addIssue({
        code: "custom",
        message: "chat schedule RRULE and time zone must match",
        path: ["timeZone"],
      });
    }
  });
export const chatRootTurnWorkClassSchema = z.enum([
  "boundedLeaf",
  "standard",
  "largeChange",
  "wideResearch",
]);
export const chatRootTurnProfileSchema = z.enum([
  "lunaMax",
  "solMax",
  "solUltra",
]);
export const chatRootTurnRoutingProfileFallbackReasonSchema =
  z.literal("lunaUnavailable");
export const chatRootTurnRoutingServiceTierSchema = chatServiceTierSchema;
export const chatRootTurnRoutingServiceTierFallbackReasonSchema =
  z.literal("fastUnavailable");
export const chatRootTurnRoutingClassificationReasonSchema = z.enum([
  "wideResearchCue",
  "largeChangeCue",
  "boundedLeafCue",
  "continuationInherited",
  "continuationOrAmbiguous",
  "conservativeDefault",
]);
export const chatRootTurnRoutingProjectionSchema = z
  .object({
    policyVersion: z.literal(1),
    classificationReason: chatRootTurnRoutingClassificationReasonSchema,
    workClass: chatRootTurnWorkClassSchema,
    requestedProfile: chatRootTurnProfileSchema,
    selectedProfile: chatRootTurnProfileSchema.nullable(),
    profileFallbackReason:
      chatRootTurnRoutingProfileFallbackReasonSchema.nullable(),
    requestedServiceTier: chatRootTurnRoutingServiceTierSchema,
    selectedServiceTier: chatRootTurnRoutingServiceTierSchema.nullable(),
    serviceTierFallbackReason:
      chatRootTurnRoutingServiceTierFallbackReasonSchema.nullable(),
  })
  .strict()
  .superRefine((routing, context) => {
    if (
      (routing.selectedProfile === null) !==
        (routing.selectedServiceTier === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "root-turn profile and tier must resolve together",
        path: routing.selectedProfile === null
          ? ["selectedProfile"]
          : ["selectedServiceTier"],
      });
    }
    const expectedRequestedProfile = routing.workClass === "boundedLeaf"
      ? "lunaMax"
      : routing.workClass === "standard"
        ? "solMax"
        : "solUltra";
    if (routing.requestedProfile !== expectedRequestedProfile) {
      context.addIssue({
        code: "custom",
        message: "root-turn work class must map to its exact requested profile",
        path: ["requestedProfile"],
      });
    }
    const requestedTierMatchesWorkClass = routing.workClass === "boundedLeaf"
      ? routing.requestedServiceTier === "fast"
      : routing.workClass === "standard"
        ? true
        : routing.requestedServiceTier === "standard";
    if (!requestedTierMatchesWorkClass) {
      context.addIssue({
        code: "custom",
        message: "root-turn work class must map to an allowed requested tier",
        path: ["requestedServiceTier"],
      });
    }
    if (
      routing.selectedProfile !== null &&
      routing.selectedProfile !== routing.requestedProfile &&
      !(
        routing.requestedProfile === "lunaMax" &&
        routing.selectedProfile === "solMax"
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "root-turn selected profile must be requested or the Luna fallback",
        path: ["selectedProfile"],
      });
    }
    const fellBack = routing.requestedProfile === "lunaMax" &&
      routing.selectedProfile === "solMax";
    if (fellBack !== (routing.profileFallbackReason === "lunaUnavailable")) {
      context.addIssue({
        code: "custom",
        message: "root-turn fallback reason must exactly describe a Luna-to-Sol fallback",
        path: ["profileFallbackReason"],
      });
    }
    if (
      routing.selectedServiceTier !== null &&
      routing.selectedServiceTier !== routing.requestedServiceTier &&
      !(
        routing.requestedServiceTier === "fast" &&
        routing.selectedServiceTier === "standard"
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "root-turn selected tier must be requested or the Fast fallback",
        path: ["selectedServiceTier"],
      });
    }
    const tierFellBack = routing.requestedServiceTier === "fast" &&
      routing.selectedServiceTier === "standard";
    if (
      tierFellBack !==
        (routing.serviceTierFallbackReason === "fastUnavailable")
    ) {
      context.addIssue({
        code: "custom",
        message: "root-turn tier fallback reason must exactly describe a Fast-to-Standard fallback",
        path: ["serviceTierFallbackReason"],
      });
    }
    const reasonWorkClass = routing.classificationReason === "wideResearchCue"
      ? "wideResearch"
      : routing.classificationReason === "largeChangeCue"
        ? "largeChange"
        : routing.classificationReason === "boundedLeafCue"
          ? "boundedLeaf"
          : routing.classificationReason === "continuationInherited"
            ? null
            : "standard";
    if (
      reasonWorkClass !== null &&
      routing.workClass !== reasonWorkClass
    ) {
      context.addIssue({
        code: "custom",
        message: "automatic classification reason must agree with its work class",
        path: ["classificationReason"],
      });
    }
    const reasonServiceTier = routing.classificationReason === "boundedLeafCue" ||
        routing.classificationReason === "continuationOrAmbiguous"
      ? "fast"
      : routing.classificationReason === "continuationInherited"
        ? null
        : "standard";
    if (
      reasonServiceTier !== null &&
      routing.requestedServiceTier !== reasonServiceTier
    ) {
      context.addIssue({
        code: "custom",
        message: "root-turn classification reason must map to its requested service tier",
        path: ["requestedServiceTier"],
      });
    }
  });
export const chatPaneInteractionModeSchema = z.enum(["chat", "harnessObserver"]);
export const chatPaneActivityKindSchema = z.enum([
  "idle",
  "messageSent",
  "thinkingCompleted",
  "toolStarted",
  "responseCompleted",
]);
export const chatPaneActivitySchema = z
  .object({
    ordinal: z.number().int().nonnegative().safe(),
    kind: chatPaneActivityKindSchema,
  })
  .strict()
  .superRefine((activity, context) => {
    if (activity.kind === "idle" && activity.ordinal !== 0) {
      context.addIssue({
        code: "custom",
        message: "idle activity must have ordinal zero",
        path: ["ordinal"],
      });
    }
    if (activity.kind !== "idle" && activity.ordinal === 0) {
      context.addIssue({
        code: "custom",
        message: "non-idle activity must have a positive ordinal",
        path: ["ordinal"],
      });
    }
  });
export const chatPaneStateSchema = z.enum([
  "ready",
  "starting",
  "streaming",
  "continuing",
  "attention",
]);
export const chatTurnStatusSchema = z.enum([
  "starting",
  "streaming",
  "continuing",
  "completed",
  "failed",
]);
export const chatToolCategorySchema = z.enum([
  "command",
  "filesystem",
  "network",
  "search",
  "other",
]);
export const chatToolStatusSchema = z.enum(["running", "completed"]);
export const chatAttentionCodeSchema = z.enum([
  "account_required",
  "account_unavailable",
  "usage_limit_reached",
  "all_accounts_exhausted",
  "continuation_failed",
  "approval_required",
  "runtime_unavailable",
  "turn_failed",
]);

export const chatMessageQueuePauseReasonSchema = z.enum([
  "stop",
  "runtimeRestart",
  "attention",
  "ambiguousEffect",
]);

export const chatMessageContentSchema = z
  .object({
    text: utf8StringSchema({ maxBytes: runtimeChatMessageUtf8ByteLimit }),
    attachmentRefs: z
      .array(chatMessageAttachmentIdSchema)
      .max(runtimeChatMessageAttachmentLimit),
  })
  .strict()
  .superRefine((content, context) => {
    if (content.text.trim().length === 0 && content.attachmentRefs.length === 0) {
      context.addIssue({
        code: "custom",
        message: "a chat message requires nonblank text or a ready attachment reference",
        path: ["text"],
      });
    }
    if (new Set(content.attachmentRefs).size !== content.attachmentRefs.length) {
      context.addIssue({
        code: "custom",
        message: "chat message attachment references must be unique",
        path: ["attachmentRefs"],
      });
    }
  });

export const chatAttachmentMetadataSchema = z
  .object({
    id: chatMessageAttachmentIdSchema,
    revision: revisionSchema,
    kind: z.enum(["image", "file"]),
    displayName: utf8StringSchema({
      minBytes: 1,
      maxBytes: runtimeChatAttachmentDisplayNameUtf8ByteLimit,
    }),
    mediaType: z
      .string()
      .min(1)
      .max(runtimeChatAttachmentMediaTypeByteLimit)
      .regex(/^[\x21-\x7e]+$/u),
    bytes: z.number().int().nonnegative().safe().max(runtimeChatAttachmentInputByteLimit),
    state: z.enum(["uploading", "processing", "ready", "corrupt"]),
    previewAvailable: z.boolean(),
  })
  .strict()
  .superRefine((attachment, context) => {
    if (attachment.previewAvailable && attachment.kind !== "image") {
      context.addIssue({
        code: "custom",
        message: "only normalized image attachments can expose a preview",
        path: ["previewAvailable"],
      });
    }
    if (attachment.previewAvailable && attachment.mediaType !== "image/png") {
      context.addIssue({
        code: "custom",
        message: "attachment previews must be normalized image/png",
        path: ["mediaType"],
      });
    }
  });

export const chatAttachmentPaneProjectionSchema = z
  .object({
    drafts: z.array(chatAttachmentMetadataSchema).max(runtimeChatAttachmentDraftLimit),
    referenced: z
      .array(chatAttachmentMetadataSchema)
      .max(runtimeChatAttachmentReferencedLimit),
  })
  .strict()
  .superRefine((projection, context) => {
    const ids = new Set<string>();
    for (const [collection, attachments] of [
      ["drafts", projection.drafts],
      ["referenced", projection.referenced],
    ] as const) {
      attachments.forEach((attachment, index) => {
        if (ids.has(attachment.id)) {
          context.addIssue({
            code: "custom",
            message: "attachment projection IDs must be unique",
            path: [collection, index, "id"],
          });
        }
        ids.add(attachment.id);
      });
    }
  });

export const chatQueuedMessageProjectionSchema = chatMessageContentSchema
  .extend({
    id: chatMessageIdSchema,
    ordinal: z.number().int().positive().safe(),
    revision: revisionSchema,
  })
  .strict();

export const chatBlockedMessageProjectionSchema =
  chatQueuedMessageProjectionSchema.extend({
    deliveryOutcome: z.literal("deliveryOutcomeUnknown"),
  }).strict();

export const chatMessageQueueProjectionSchema = z
  .object({
    revision: revisionSchema,
    pauseReason: chatMessageQueuePauseReasonSchema.nullable(),
    blockedMessage: chatBlockedMessageProjectionSchema.nullable(),
    messages: z
      .array(chatQueuedMessageProjectionSchema)
      .max(runtimeChatQueuedMessageLimit),
  })
  .strict()
  .superRefine((queue, context) => {
    const ids = new Set<string>();
    let previousOrdinal = 0;
    let totalUtf8Bytes = 0;
    if ((queue.pauseReason === "ambiguousEffect") !== (queue.blockedMessage !== null)) {
      context.addIssue({
        code: "custom",
        message: "an ambiguous queue pause requires exactly one blocked message receipt",
        path: ["blockedMessage"],
      });
    }
    if (queue.blockedMessage !== null) {
      ids.add(queue.blockedMessage.id);
      previousOrdinal = queue.blockedMessage.ordinal;
      totalUtf8Bytes += utf8ByteLength(queue.blockedMessage.text);
    }
    queue.messages.forEach((message, index) => {
      if (ids.has(message.id)) {
        context.addIssue({
          code: "custom",
          message: "queued chat message IDs must be unique",
          path: ["messages", index, "id"],
        });
      }
      if (message.ordinal <= previousOrdinal) {
        context.addIssue({
          code: "custom",
          message: "queued chat messages must be in strict FIFO ordinal order",
          path: ["messages", index, "ordinal"],
        });
      }
      ids.add(message.id);
      previousOrdinal = message.ordinal;
      totalUtf8Bytes += utf8ByteLength(message.text);
    });
    if (totalUtf8Bytes > runtimeChatQueueUtf8ByteLimit) {
      context.addIssue({
        code: "custom",
        message: "queued chat message text exceeds the per-pane projection limit",
        path: ["messages"],
      });
    }
  });

function chatUtf8TailSchema(maxTailUtf8Bytes: number) {
  return z
    .object({
      tail: utf8StringSchema({ maxBytes: maxTailUtf8Bytes }),
      totalUtf8Bytes: z.number().int().nonnegative().safe(),
      truncatedPrefix: z.boolean(),
    })
    .strict()
    .superRefine((value, context) => {
      const tailUtf8Bytes = utf8ByteLength(value.tail);
      if (value.totalUtf8Bytes < tailUtf8Bytes) {
        context.addIssue({
          code: "custom",
          message: "UTF-8 tail cannot exceed its total byte count",
          path: ["totalUtf8Bytes"],
        });
      }
      if (value.truncatedPrefix !== (value.totalUtf8Bytes > tailUtf8Bytes)) {
        context.addIssue({
          code: "custom",
          message: "truncatedPrefix must exactly describe an omitted UTF-8 prefix",
          path: ["truncatedPrefix"],
        });
      }
    });
}

export const chatResponseMarkdownSchema = chatUtf8TailSchema(
  runtimeChatResponseTailUtf8ByteLimit,
);
export const chatReasoningSummarySchema = chatUtf8TailSchema(
  runtimeChatReasoningTailUtf8ByteLimit,
);

export const chatToolProjectionSchema = z
  .object({
    id: chatToolIdSchema,
    category: chatToolCategorySchema,
    status: chatToolStatusSchema,
  })
  .strict();

export const chatProviderSubagentProjectionSchema = z.object({
  id: chatProviderSubagentIdSchema,
  label: z.string().min(1).max(32).refine(
    (value) => !value.includes("\0"),
    "provider subagent label cannot contain NUL",
  ),
  status: z.enum(["starting", "running"]),
}).strict();

export const chatProviderSubagentsProjectionSchema = z.object({
  agents: z.array(chatProviderSubagentProjectionSchema)
    .max(runtimeChatProviderSubagentLimit),
  overflowCount: z.number().int().nonnegative().max(
    runtimeChatProviderSubagentTrackedLimit - runtimeChatProviderSubagentLimit,
  ),
}).strict().superRefine((projection, context) => {
  const ids = new Set<string>();
  const labels = new Set<string>();
  projection.agents.forEach((agent, index) => {
    if (ids.has(agent.id)) {
      context.addIssue({
        code: "custom",
        message: "provider subagent IDs must be unique",
        path: ["agents", index, "id"],
      });
    }
    if (labels.has(agent.label)) {
      context.addIssue({
        code: "custom",
        message: "provider subagent labels must be unique",
        path: ["agents", index, "label"],
      });
    }
    ids.add(agent.id);
    labels.add(agent.label);
  });
});

export const chatTurnProjectionSchema = z
  .object({
    id: chatTurnIdSchema,
    status: chatTurnStatusSchema,
    startedAt: chatIsoDateTimeSchema,
    completedAt: chatIsoDateTimeSchema.nullable(),
    continuationCount: z
      .number()
      .int()
      .nonnegative()
      .max(runtimeChatContinuationLimit),
    responseMarkdown: chatResponseMarkdownSchema,
    reasoningSummary: chatReasoningSummarySchema,
    reasoningSummaryVerified: z.boolean(),
    tools: z.array(chatToolProjectionSchema).max(runtimeChatToolLimit),
    providerSubagents: chatProviderSubagentsProjectionSchema,
    routing: chatRootTurnRoutingProjectionSchema.nullable(),
  })
  .strict()
  .superRefine((turn, context) => {
    const terminal = turn.status === "completed" || turn.status === "failed";
    if (terminal !== (turn.completedAt !== null)) {
      context.addIssue({
        code: "custom",
        message: "completedAt must exist exactly for a terminal chat turn",
        path: ["completedAt"],
      });
    }
    if (
      terminal && turn.reasoningSummary.totalUtf8Bytes > 0 &&
      turn.reasoningSummaryVerified !== true
    ) {
      context.addIssue({
        code: "custom",
        message: "terminal reasoning requires an exact completion proof",
        path: ["reasoningSummaryVerified"],
      });
    }
    if (
      turn.completedAt !== null &&
      Date.parse(turn.completedAt) < Date.parse(turn.startedAt)
    ) {
      context.addIssue({
        code: "custom",
        message: "chat turn completion cannot precede its start",
        path: ["completedAt"],
      });
    }
    const toolIds = new Set<string>();
    turn.tools.forEach((tool, index) => {
      if (toolIds.has(tool.id)) {
        context.addIssue({
          code: "custom",
          message: "chat tool IDs must be unique within a turn",
          path: ["tools", index, "id"],
        });
      }
      if (terminal && tool.status !== "completed") {
        context.addIssue({
          code: "custom",
          message: "terminal chat turns cannot retain running tools",
          path: ["tools", index, "status"],
        });
      }
      toolIds.add(tool.id);
    });
    if (
      terminal &&
      (turn.providerSubagents.agents.length > 0 ||
        turn.providerSubagents.overflowCount > 0)
    ) {
      context.addIssue({
        code: "custom",
        message: "terminal chat turns cannot retain active provider subagents",
        path: ["providerSubagents"],
      });
    }
  });

export const chatAttentionSchema = z
  .object({
    code: chatAttentionCodeSchema,
    message: z.string().min(1).max(240),
    retryable: z.boolean(),
  })
  .strict();

export const harnessRefinementModeSchema = z.enum(["off", "suggest"]);
export const harnessChildStateSchema = z.enum([
  "starting",
  "running",
  "waiting",
  "idle",
  "failed",
  "stopped",
  "quarantined",
]);

export const harnessSettingsProjectionSchema = z
  .object({
    revision: revisionSchema,
    recursiveSessionsEnabled: z.boolean(),
    contextQuotaBytes: z
      .number()
      .int()
      .min(runtimeHarnessContextQuotaMinimumBytes)
      .max(runtimeHarnessContextQuotaMaximumBytes)
      .refine(
        (value) => value % runtimeHarnessContextQuotaMinimumBytes === 0,
        "context quota must use whole MiB increments",
      ),
    refinementMode: harnessRefinementModeSchema,
  })
  .strict();

export const harnessChildProjectionSchema = z
  .object({
    id: harnessActorIdSchema,
    revision: revisionSchema,
    title: chatPaneTitleSchema,
    state: harnessChildStateSchema,
    openedPaneId: chatPaneIdSchema.nullable(),
    canOpen: z.boolean(),
    canMessage: z.boolean(),
    canStop: z.boolean(),
  })
  .strict()
  .superRefine((child, context) => {
    const terminal = child.state === "stopped" || child.state === "quarantined";
    if (child.canStop === terminal) {
      context.addIssue({
        code: "custom",
        message: "only a nonterminal persistent actor can be stopped",
        path: ["canStop"],
      });
    }
    if (child.canOpen && child.canMessage) {
      context.addIssue({
        code: "custom",
        message: "a harness child cannot be opened and messaged at the same time",
        path: ["canMessage"],
      });
    }
    if (child.canOpen && child.openedPaneId !== null) {
      context.addIssue({
        code: "custom",
        message: "only an unattached harness child can be opened",
        path: ["canOpen"],
      });
    }
    if (child.canMessage && child.openedPaneId === null) {
      context.addIssue({
        code: "custom",
        message: "only an attached harness child can receive a message",
        path: ["canMessage"],
      });
    }
    if (
      (child.canOpen || child.canMessage) &&
      child.state !== "idle" && child.state !== "failed"
    ) {
      context.addIssue({
        code: "custom",
        message: "only a proven-idle terminal turn can authorize a child action",
        path: [child.canOpen ? "canOpen" : "canMessage"],
      });
    }
    if (terminal && (child.canOpen || child.canMessage)) {
      context.addIssue({
        code: "custom",
        message: "terminal harness children expose no interactive action",
        path: [child.canOpen ? "canOpen" : "canMessage"],
      });
    }
  });

export const harnessDescendantsProjectionSchema = z
  .object({
    count: z.number().int().positive().max(50),
    truncated: z.boolean(),
    children: z
      .array(harnessChildProjectionSchema)
      .min(1)
      .max(runtimeHarnessChildProjectionLimit),
  })
  .strict()
  .superRefine((projection, context) => {
    if (projection.count < projection.children.length) {
      context.addIssue({
        code: "custom",
        message: "descendant count cannot be smaller than its bounded projection",
        path: ["count"],
      });
    }
    if (projection.truncated !== (projection.count > projection.children.length)) {
      context.addIssue({
        code: "custom",
        message: "truncated must exactly describe omitted descendants",
        path: ["truncated"],
      });
    }
    const childIds = new Set<string>();
    const openedPaneIds = new Set<string>();
    projection.children.forEach((child, index) => {
      if (childIds.has(child.id)) {
        context.addIssue({
          code: "custom",
          message: "harness child IDs must be unique",
          path: ["children", index, "id"],
        });
      }
      childIds.add(child.id);
      if (child.openedPaneId === null) return;
      if (openedPaneIds.has(child.openedPaneId)) {
        context.addIssue({
          code: "custom",
          message: "one opened pane cannot represent two harness children",
          path: ["children", index, "openedPaneId"],
        });
      }
      openedPaneIds.add(child.openedPaneId);
    });
  });

export const chatPaneHarnessProjectionSchema = z
  .object({
    revision: revisionSchema,
    descendants: harnessDescendantsProjectionSchema,
  })
  .strict();

export const chatPaneWorkspaceRecoveryKindSchema = z.enum([
  "legacyUnbound",
  "capacityUnavailable",
  "insufficientDisk",
  "baseMismatch",
  "bindingMismatch",
  "branchWithoutLane",
  "checkoutMismatch",
  "dirtyCheckout",
  "invalidManifest",
  "manifestMissing",
  "pathEscape",
  "repositoryMismatch",
  "provisionInterrupted",
  "laneMissing",
  "unknown",
]);

export const chatPaneWorkspaceProjectionSchema = z
  .object({
    mode: z.enum(["legacyUnbound", "managedWorktree"]),
    state: z.enum([
      "preparing",
      "waitingCapacity",
      "ready",
      "preserved",
      "recoveryRequired",
    ]),
    revision: revisionSchema,
    recoveryKind: chatPaneWorkspaceRecoveryKindSchema.nullable(),
  })
  .strict()
  .superRefine((workspace, context) => {
    const needsRecovery = workspace.state === "waitingCapacity" ||
      workspace.state === "recoveryRequired";
    if (needsRecovery !== (workspace.recoveryKind !== null)) {
      context.addIssue({
        code: "custom",
        message: "workspace recovery kind must exist exactly for a recovery state",
        path: ["recoveryKind"],
      });
    }
    if (
      workspace.mode === "legacyUnbound" &&
      (
        workspace.state !== "recoveryRequired" ||
        workspace.recoveryKind !== "legacyUnbound"
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "legacy panes must fail closed until an isolated workspace is created",
        path: ["mode"],
      });
    }
  });

export const harnessProposalSummaryProjectionSchema = z
  .object({
    id: harnessProposalIdSchema,
    revision: revisionSchema,
    title: chatPaneTitleSchema,
  })
  .strict();

export const harnessSnapshotSchema = z
  .object({
    revision: revisionSchema,
    settings: harnessSettingsProjectionSchema,
    proposals: z
      .array(harnessProposalSummaryProjectionSchema)
      .max(runtimeHarnessProposalProjectionLimit),
  })
  .strict()
  .superRefine((harness, context) => {
    const proposalIds = new Set<string>();
    harness.proposals.forEach((proposal, index) => {
      if (proposalIds.has(proposal.id)) {
        context.addIssue({
          code: "custom",
          message: "harness proposal IDs must be unique",
          path: ["proposals", index, "id"],
        });
      }
      proposalIds.add(proposal.id);
    });
  });

export const chatPaneProjectionSchema = z
  .object({
    id: chatPaneIdSchema,
    paletteIndex: z.number().int().nonnegative().max(runtimeChatPaletteIndexLimit),
    revision: revisionSchema,
    title: chatPaneTitleSchema,
    repository: z
      .object({
        id: taskDomain.repositoryIdSchema,
        name: taskDomain.repositoryNameSchema,
      })
      .strict(),
    accountProfileId: accountProfileIdSchema.nullable(),
    interactionMode: chatPaneInteractionModeSchema.default("chat"),
    state: chatPaneStateSchema,
    activity: chatPaneActivitySchema,
    // Harness observers already execute inside their actor-owned workspace.
    // Ordinary panes always carry a pathless managed-workspace state; `null`
    // is therefore reserved for harness observers and remains JSON-safe.
    workspace: chatPaneWorkspaceProjectionSchema.nullable(),
    turn: chatTurnProjectionSchema.nullable(),
    attention: chatAttentionSchema.nullable(),
    recoverablePrompt: z.boolean().default(false),
    canStartFreshContext: z.boolean().default(false),
    schedule: chatScheduleProjectionSchema.nullable().default(null),
    messageQueue: chatMessageQueueProjectionSchema,
    attachments: chatAttachmentPaneProjectionSchema.default({
      drafts: [],
      referenced: [],
    }),
    harness: chatPaneHarnessProjectionSchema.nullable().default(null),
  })
  .strict()
  .superRefine((pane, context) => {
    if ((pane.interactionMode === "chat") !== (pane.workspace !== null)) {
      context.addIssue({
        code: "custom",
        message: "chat panes require a workspace and harness observers cannot own one",
        path: ["workspace"],
      });
    }
    if (pane.interactionMode !== "chat" && pane.schedule !== null) {
      context.addIssue({
        code: "custom",
        message: "only ordinary chat panes can own a schedule",
        path: ["schedule"],
      });
    }
    if (
      pane.turn !== null &&
      ((pane.interactionMode === "chat") !== (pane.turn.routing !== null))
    ) {
      context.addIssue({
        code: "custom",
        message: "ordinary root turns require routing and harness observer turns forbid it",
        path: ["turn", "routing"],
      });
    }
    if ((pane.state === "attention") !== (pane.attention !== null)) {
      context.addIssue({
        code: "custom",
        message: "chat attention must exist exactly while the pane needs attention",
        path: ["attention"],
      });
    }
    if (
      pane.recoverablePrompt &&
      (
        pane.interactionMode !== "chat" || pane.state !== "attention" ||
        pane.attention?.retryable !== true || pane.turn?.status !== "failed"
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "recoverable prompt capability requires an exact retryable failed chat turn",
        path: ["recoverablePrompt"],
      });
    }
    if (
      pane.canStartFreshContext === true &&
      (
        pane.interactionMode !== "chat" || pane.state !== "attention" ||
        pane.attention?.code !== "runtime_unavailable" ||
        pane.attention.retryable
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "fresh provider context requires exact nonretryable runtime attention",
        path: ["canStartFreshContext"],
      });
    }

    const activeState = pane.state === "starting" ||
      pane.state === "streaming" || pane.state === "continuing";
    if (activeState && pane.turn?.status !== pane.state) {
      context.addIssue({
        code: "custom",
        message: "active pane and turn states must match",
        path: ["turn"],
      });
    }
    if (
      (pane.state === "ready" || pane.state === "attention") &&
      pane.turn !== null &&
      pane.turn.status !== "completed" &&
      pane.turn.status !== "failed"
    ) {
      context.addIssue({
        code: "custom",
        message: "settled panes may retain only a terminal latest turn",
        path: ["turn", "status"],
      });
    }
  });

/**
 * Pane-local mutable state that can be delivered without repeating the large
 * assistant and reasoning tails already owned by the renderer projection.
 */
export const chatPaneStateProjectionSchema = z
  .object({
    id: chatPaneIdSchema,
    paletteIndex: z.number().int().nonnegative().max(runtimeChatPaletteIndexLimit),
    revision: revisionSchema,
    title: chatPaneTitleSchema,
    accountProfileId: accountProfileIdSchema.nullable(),
    interactionMode: chatPaneInteractionModeSchema.default("chat"),
    state: chatPaneStateSchema,
    activity: chatPaneActivitySchema,
    workspace: chatPaneWorkspaceProjectionSchema.nullable(),
    turn: z
      .object({
        id: chatTurnIdSchema,
        status: chatTurnStatusSchema,
        startedAt: chatIsoDateTimeSchema,
        completedAt: chatIsoDateTimeSchema.nullable(),
        continuationCount: z
          .number()
          .int()
          .nonnegative()
          .max(runtimeChatContinuationLimit),
        tools: z.array(chatToolProjectionSchema).max(runtimeChatToolLimit),
        providerSubagents: chatProviderSubagentsProjectionSchema,
        routing: chatRootTurnRoutingProjectionSchema.nullable(),
      })
      .strict()
      .superRefine((turn, context) => {
        const terminal = turn.status === "completed" || turn.status === "failed";
        if (terminal !== (turn.completedAt !== null)) {
          context.addIssue({
            code: "custom",
            message: "completedAt must exist exactly for a terminal chat turn",
            path: ["completedAt"],
          });
        }
        if (
          turn.completedAt !== null &&
          Date.parse(turn.completedAt) < Date.parse(turn.startedAt)
        ) {
          context.addIssue({
            code: "custom",
            message: "chat turn completion cannot precede its start",
            path: ["completedAt"],
          });
        }
        const toolIds = new Set<string>();
        turn.tools.forEach((tool, index) => {
          if (toolIds.has(tool.id)) {
            context.addIssue({
              code: "custom",
              message: "chat tool IDs must be unique within a turn",
              path: ["tools", index, "id"],
            });
          }
          if (terminal && tool.status !== "completed") {
            context.addIssue({
              code: "custom",
              message: "terminal chat turns cannot retain running tools",
              path: ["tools", index, "status"],
            });
          }
          toolIds.add(tool.id);
        });
        if (
          terminal &&
          (turn.providerSubagents.agents.length > 0 ||
            turn.providerSubagents.overflowCount > 0)
        ) {
          context.addIssue({
            code: "custom",
            message: "terminal chat turns cannot retain active provider subagents",
            path: ["providerSubagents"],
          });
        }
      })
      .nullable(),
    attention: chatAttentionSchema.nullable(),
    recoverablePrompt: z.boolean().default(false),
    canStartFreshContext: z.boolean().default(false),
    schedule: chatScheduleProjectionSchema.nullable().default(null),
  })
  .strict()
  .superRefine((pane, context) => {
    if ((pane.interactionMode === "chat") !== (pane.workspace !== null)) {
      context.addIssue({
        code: "custom",
        message: "chat panes require a workspace and harness observers cannot own one",
        path: ["workspace"],
      });
    }
    if (pane.interactionMode !== "chat" && pane.schedule !== null) {
      context.addIssue({
        code: "custom",
        message: "only ordinary chat panes can own a schedule",
        path: ["schedule"],
      });
    }
    if (
      pane.turn !== null &&
      ((pane.interactionMode === "chat") !== (pane.turn.routing !== null))
    ) {
      context.addIssue({
        code: "custom",
        message: "ordinary root turns require routing and harness observer turns forbid it",
        path: ["turn", "routing"],
      });
    }
    if ((pane.state === "attention") !== (pane.attention !== null)) {
      context.addIssue({
        code: "custom",
        message: "chat attention must exist exactly while the pane needs attention",
        path: ["attention"],
      });
    }
    if (
      pane.recoverablePrompt &&
      (
        pane.interactionMode !== "chat" || pane.state !== "attention" ||
        pane.attention?.retryable !== true || pane.turn?.status !== "failed"
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "recoverable prompt capability requires an exact retryable failed chat turn",
        path: ["recoverablePrompt"],
      });
    }
    if (
      pane.canStartFreshContext === true &&
      (
        pane.interactionMode !== "chat" || pane.state !== "attention" ||
        pane.attention?.code !== "runtime_unavailable" ||
        pane.attention.retryable
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "fresh provider context requires exact nonretryable runtime attention",
        path: ["canStartFreshContext"],
      });
    }
    const activeState = pane.state === "starting" ||
      pane.state === "streaming" || pane.state === "continuing";
    if (activeState && pane.turn?.status !== pane.state) {
      context.addIssue({
        code: "custom",
        message: "active pane and turn states must match",
        path: ["turn"],
      });
    }
    if (
      (pane.state === "ready" || pane.state === "attention") &&
      pane.turn !== null &&
      pane.turn.status !== "completed" &&
      pane.turn.status !== "failed"
    ) {
      context.addIssue({
        code: "custom",
        message: "settled panes may retain only a terminal latest turn",
        path: ["turn", "status"],
      });
    }
  });

export const chatSnapshotSchema = z
  .object({
    revision: revisionSchema,
    panes: z.array(chatPaneProjectionSchema).max(runtimeChatPaneLimit),
  })
  .strict()
  .superRefine((chat, context) => {
    const paneIds = new Set<string>();
    chat.panes.forEach((pane, index) => {
      if (paneIds.has(pane.id)) {
        context.addIssue({
          code: "custom",
          message: "chat pane IDs must be unique",
          path: ["panes", index, "id"],
        });
      }
      paneIds.add(pane.id);
      for (const child of pane.harness?.descendants?.children ?? []) {
        if (
          child.openedPaneId !== null &&
          !chat.panes.some((candidate) => candidate.id === child.openedPaneId)
        ) {
          context.addIssue({
            code: "custom",
            message: "opened harness children must reference a projected chat pane",
            path: ["panes", index, "harness", "descendants", "children"],
          });
        }
      }
    });
  });

const sessionSyncRevisionSchema = z.number().int().nonnegative().safe();
const sessionSyncTimestampSchema = z.number().int().nonnegative().safe();
export const sessionSyncScheduledChatOrphanIdSchema = z.string()
  .min(25)
  .max(96)
  .regex(/^syncscheduleorphan_[a-f0-9]{32}$/u);

function isSafeSessionSyncDisplayText(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined
      && (codePoint <= 31
        || (codePoint >= 127 && codePoint <= 159)
        || codePoint === 0x00ad
        || codePoint === 0x061c
        || codePoint === 0x180e
        || codePoint === 0x200b
        || codePoint === 0x200e
        || codePoint === 0x200f
        || (codePoint >= 0x2028 && codePoint <= 0x202e)
        || (codePoint >= 0x2060 && codePoint <= 0x2069)
        || codePoint === 0xfeff)
    ) return false;
  }
  return true;
}

const sessionSyncDeviceNameSchema = utf8StringSchema({
  minBytes: 1,
  maxBytes: 80,
}).refine(
  (value) => value === value.trim() && isSafeSessionSyncDisplayText(value),
  "session sync device names must be trimmed display text",
);

export const sessionSyncDeviceProjectionSchema = z.object({
  id: syncDeviceIdSchema,
  name: sessionSyncDeviceNameSchema,
  status: z.enum(["active", "revoked"]),
  current: z.boolean(),
  connection: z.enum(["online", "offline", "unknown"]),
}).strict().superRefine((device, context) => {
  if (device.status === "revoked" && device.connection === "online") {
    context.addIssue({
      code: "custom",
      message: "a revoked sync device cannot be online",
      path: ["connection"],
    });
  }
});

export const sessionSyncEnrollmentProjectionSchema = z.object({
  requestId: sessionSyncEnrollmentRequestIdSchema,
  deviceId: syncDeviceIdSchema,
  name: sessionSyncDeviceNameSchema,
  pairingCode: syncEnrollmentPairingCodeSchema,
  requestedAt: sessionSyncTimestampSchema,
  expiresAt: sessionSyncTimestampSchema,
}).strict().refine(
  ({ expiresAt, requestedAt }) => expiresAt > requestedAt,
  { message: "session sync enrollment expiry must follow its request" },
);

export const sessionSyncStatusProjectionSchema = z.discriminatedUnion(
  "state",
  [
    z.object({
      state: z.literal("unavailable"),
      reason: z.enum([
        "cloudConfigurationMissing",
        "signedOut",
        "keychainUnavailable",
        "serviceUnavailable",
        "updateRequired",
      ]),
      retryable: z.boolean(),
    }).strict(),
    z.object({
      state: z.literal("disabled"),
      revision: sessionSyncRevisionSchema,
      deviceName: sessionSyncDeviceNameSchema,
    }).strict(),
    z.object({
      state: z.literal("enrolling"),
      revision: sessionSyncRevisionSchema,
      deviceId: syncDeviceIdSchema,
      deviceName: sessionSyncDeviceNameSchema,
      requestId: sessionSyncEnrollmentRequestIdSchema,
      pairingCode: syncEnrollmentPairingCodeSchema,
      phase: z.enum(["awaitingApproval", "claiming"]),
      retryable: z.boolean(),
    }).strict(),
    z.object({
      state: z.literal("active"),
      revision: sessionSyncRevisionSchema,
      /** Local, monotonic fence for human/vault authority replacement. */
      scopeGeneration: z.number().int().positive().safe(),
      currentDeviceId: syncDeviceIdSchema,
      deviceName: sessionSyncDeviceNameSchema,
      health: z.enum(["current", "syncing", "offline", "attention"]),
      retryable: z.boolean(),
      notice: utf8StringSchema({ minBytes: 1, maxBytes: 240 }).nullable(),
      recovery: z.enum(["exportRequired", "ready"]),
      devices: z.array(sessionSyncDeviceProjectionSchema)
        .max(runtimeSessionSyncDeviceHistoryLimit),
      pendingEnrollments: z.array(sessionSyncEnrollmentProjectionSchema)
        .max(runtimeSessionSyncPendingEnrollmentLimit),
      scheduledChatRecovery: z.object({
        state: z.literal("clearRequired"),
        orphans: z.array(z.object({
          orphanId: sessionSyncScheduledChatOrphanIdSchema,
        }).strict()).min(1).max(runtimeChatPaneLimit),
      }).strict().nullable(),
    }).strict().superRefine((status, context) => {
      const deviceIds = new Set<string>();
      let currentCount = 0;
      let activeCount = 0;
      for (const [index, device] of status.devices.entries()) {
        if (deviceIds.has(device.id)) {
          context.addIssue({
            code: "custom",
            message: "session sync device IDs must be unique",
            path: ["devices", index, "id"],
          });
        }
        deviceIds.add(device.id);
        if (device.current) currentCount += 1;
        if (device.status === "active") activeCount += 1;
      }
      if (
        currentCount !== 1
        || !status.devices.some((device) =>
          device.current
          && device.id === status.currentDeviceId
          && device.status === "active"
        )
      ) {
        context.addIssue({
          code: "custom",
          message: "session sync must identify one active current device",
          path: ["currentDeviceId"],
        });
      }
      if (activeCount > 8) {
        context.addIssue({
          code: "custom",
          message: "session sync active device count exceeds its limit",
          path: ["devices"],
        });
      }
      const requestIds = status.pendingEnrollments.map(({ requestId }) =>
        requestId
      );
      const pendingDeviceIds = status.pendingEnrollments.map(({ deviceId }) =>
        deviceId
      );
      if (
        new Set(requestIds).size !== requestIds.length
        || new Set(pendingDeviceIds).size !== pendingDeviceIds.length
      ) {
        context.addIssue({
          code: "custom",
          message: "session sync pending enrollments must be unique",
          path: ["pendingEnrollments"],
        });
      }
    }),
  ],
);

export const remoteSessionSummaryProjectionSchema = z.object({
  sessionId: syncedSessionPublicIdSchema,
  originDeviceId: syncDeviceIdSchema,
  originDeviceName: sessionSyncDeviceNameSchema,
  gridPosition: z.number().int().min(0).max(
    runtimeSessionSyncRemoteSessionLimit - 1,
  ),
  sourceRevision: z.number().int().positive().safe(),
  title: utf8StringSchema({ minBytes: 1, maxBytes: 256 }).refine(
    isSafeSessionSyncDisplayText,
    "remote session title contains a display control character",
  ),
  repositoryDisplayName: utf8StringSchema({
    minBytes: 1,
    maxBytes: 160,
  }).refine(
    isSafeSessionSyncDisplayText,
    "remote repository name contains a display control character",
  ).nullable(),
  state: z.enum([
    "ready",
    "working",
    "attention",
    "error",
    "offline",
    "revoked",
    "updateRequired",
  ]),
  updatedAt: sessionSyncTimestampSchema.nullable(),
}).strict();

export const localSessionGridSlotProjectionSchema = z.object({
  paneId: chatPaneIdSchema,
  gridPosition: z.number().int().min(0).max(
    runtimeSessionSyncRemoteSessionLimit - 1,
  ),
}).strict();

export const sessionSyncSnapshotSchema = z.object({
  status: sessionSyncStatusProjectionSchema,
  localGridSlots: z.array(localSessionGridSlotProjectionSchema)
    .max(runtimeChatPaneLimit)
    .default([]),
  remoteSessions: z.array(remoteSessionSummaryProjectionSchema)
    .max(runtimeSessionSyncRemoteSessionLimit),
}).strict().superRefine((snapshot, context) => {
  if (snapshot.status.state !== "active" && snapshot.remoteSessions.length > 0) {
    context.addIssue({
      code: "custom",
      message: "remote sessions must stay hidden while sync is not active",
      path: ["remoteSessions"],
    });
  }
  const sessionIds = snapshot.remoteSessions.map(({ sessionId }) => sessionId);
  const localPaneIds = (snapshot.localGridSlots ?? []).map(({ paneId }) => paneId);
  const positions = [
    ...(snapshot.localGridSlots ?? []).map(({ gridPosition }) => gridPosition),
    ...snapshot.remoteSessions.map(({ gridPosition }) => gridPosition),
  ];
  if (
    new Set(sessionIds).size !== sessionIds.length
    || new Set(localPaneIds).size !== localPaneIds.length
    || new Set(positions).size !== positions.length
  ) {
    context.addIssue({
      code: "custom",
      message: "session sync grid slots require unique identities and positions",
      path: ["remoteSessions"],
    });
  }
}).default({
  status: {
    state: "unavailable",
    reason: "cloudConfigurationMissing",
    retryable: false,
  },
  localGridSlots: [],
  remoteSessions: [],
});

export const executionFolderAccessProjectionSchema = z.object({
  revision: revisionSchema,
  displayName: utf8StringSchema({ minBytes: 1, maxBytes: 160 }).refine(
    isSafeSessionSyncDisplayText,
    "execution folder display name contains a display control character",
  ),
  availability: z.enum(["ready", "missing"]),
}).strict();

export const executionProjectionSchema = z.object({
  folderAccess: executionFolderAccessProjectionSchema,
  approvalPolicy: z.literal("never"),
  approvalsReviewer: z.literal("auto_review"),
  sandbox: z.literal("danger-full-access"),
  /** Required policy; usable capability is proven again for each provider thread. */
  computerUse: z.literal("required"),
}).strict();

/**
 * This is the complete global renderer snapshot. Scoped task pages/details,
 * worktrees, usage, raw provider sessions/interactions, and diagnostics never
 * enter it. Chat is an app-owned, bounded projection of only the latest turn.
 */
export const runtimeSnapshotSchema = z
  .object({
    revision: revisionSchema,
    lastSequence: sequenceSchema,
    runtime: runtimeStatusSchema,
    runner: runnerConnectionStatusSchema,
    accounts: z.array(accountSummarySchema).max(runtimeAccountProfileLimit),
    retainedAccountLocalData: z
      .array(retainedAccountLocalDataSchema)
      .max(runtimeRetainedAccountLocalDataLimit),
    humanAccount: humanAccountSnapshotSchema,
    execution: executionProjectionSchema,
    chat: chatSnapshotSchema,
    sessionSync: sessionSyncSnapshotSchema,
    harness: harnessSnapshotSchema.nullable().default(null),
  })
  .strict();

const runtimeSnapshotStartRequestSchema = z
  .object({ version: z.literal(runtimeProtocolVersion) })
  .strict();

const runtimeSnapshotContinuationRequestSchema = z
  .object({
    version: z.literal(runtimeProtocolVersion),
    transferId: snapshotTransferIdSchema,
    index: z.number().int().positive().max(1_000_000),
  })
  .strict();

export const runtimeSnapshotRequestSchema = z.union([
  runtimeSnapshotStartRequestSchema,
  runtimeSnapshotContinuationRequestSchema,
]);

export const runtimeSnapshotResponseSchema = z
  .object({ version: z.literal(runtimeProtocolVersion), snapshot: runtimeSnapshotSchema })
  .strict();

const base64ChunkSchema = z
  .string()
  .min(1)
  .max(runtimeSnapshotChunkBase64Limit)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u);

export const runtimeSnapshotChunkResponseSchema = z
  .object({
    version: z.literal(runtimeProtocolVersion),
    transferId: snapshotTransferIdSchema,
    index: z.number().int().nonnegative().max(
      runtimeSnapshotChunkCountLimit - 1,
    ),
    count: z.number().int().positive().max(runtimeSnapshotChunkCountLimit),
    base64: base64ChunkSchema,
  })
  .strict()
  .refine(({ count, index }) => index < count, "snapshot chunk index is out of range");

export const runtimeSnapshotTransportResponseSchema = z.union([
  runtimeSnapshotResponseSchema,
  runtimeSnapshotChunkResponseSchema,
]);

export const runtimeTaskWorkspaceSummariesSchema = z
  .array(workspaceSummarySchema)
  .max(runtimeTaskWorkspaceSummaryLimit)
  .superRefine((workspaces, context) => {
    const ids = new Set<string>();
    workspaces.forEach((workspace, index) => {
      if (ids.has(workspace.id)) {
        context.addIssue({
          code: "custom",
          message: "task workspace summary IDs must be unique",
          path: [index, "id"],
        });
      }
      ids.add(workspace.id);
    });
  });

export const runtimeTaskRepositorySummarySchema = z
  .object({
    id: taskDomain.repositoryIdSchema,
    name: taskDomain.repositoryNameSchema,
    ready: z.boolean(),
  })
  .strict();

export const runtimeTaskRepositoryListSchema = z
  .object({
    workspaceId: workspacePublicIdSchema,
    projectionRevision: workspaceProjectionRevisionSchema,
    repositories: z
      .array(runtimeTaskRepositorySummarySchema)
      .max(runtimeTaskRepositorySummaryLimit),
  })
  .strict()
  .superRefine((page, context) => {
    const ids = new Set<string>();
    page.repositories.forEach((repository, index) => {
      if (ids.has(repository.id)) {
        context.addIssue({
          code: "custom",
          message: "task repository summary IDs must be unique",
          path: ["repositories", index, "id"],
        });
      }
      ids.add(repository.id);
    });
  });

export const runtimeLocalPromotionProgressSchema = z
  .object({
    promotionId: taskDomain.promotionIdSchema,
    sourceWorkspaceId: workspacePublicIdSchema,
    destinationWorkspaceId: workspacePublicIdSchema.nullable(),
    phase: z.enum([
      "snapshot_frozen",
      "starting",
      "receiving",
      "validating",
      "projecting",
      "ready",
      "activating",
      "outcome_unknown",
      "aborting",
      "activated",
      "aborted",
    ]),
    frozenAt: taskDomain.epochMsSchema,
    updatedAt: taskDomain.epochMsSchema,
    preparedEntityCount: z.number().int().nonnegative().max(500_000),
    acceptedEntityCount: z.number().int().nonnegative().max(500_000),
    acceptedBatchCount: z.number().int().nonnegative().max(1_000_001),
    nextAttemptAt: taskDomain.epochMsSchema.nullable(),
    fault: z.object({
      code: z.string().min(1).max(80),
      message: z.string().min(1).max(240),
      retryable: z.boolean(),
    }).strict().nullable(),
    canAbort: z.boolean(),
    localWritable: z.boolean(),
    recoveryCopyAvailable: z.boolean(),
    runnerPairing: z.enum([
      "not_applicable",
      "pending",
      "pairing",
      "paired",
      "blocked",
    ]),
  })
  .strict();

export const runtimeLocalPromotionRecoveryCopySchema = z
  .object({
    promotionId: taskDomain.promotionIdSchema,
    localWorkspaceId: workspacePublicIdSchema,
    cloudWorkspaceId: workspacePublicIdSchema,
    access: z.literal("read_only"),
    createdAt: taskDomain.epochMsSchema,
    lastOpenedAt: taskDomain.epochMsSchema.nullable(),
  })
  .strict();

const runtimeRecoveryScopedCommandFields = {
  recovery: runtimeLocalPromotionRecoveryCopySchema.optional(),
} as const;

const runtimeTaskWorkspaceListCommandSchema = z
  .object({ type: z.literal("task.workspaces.list") })
  .strict();

const runtimeTaskRepositoryListCommandSchema = z
  .object({
    type: z.literal("task.repositories.list"),
    workspaceId: workspacePublicIdSchema,
    ...runtimeRecoveryScopedCommandFields,
  })
  .strict();

const runtimeTaskWorkspaceContextCommandSchema = z
  .object({
    type: z.literal("task.workspace.context"),
    workspaceId: workspacePublicIdSchema,
    ...runtimeRecoveryScopedCommandFields,
  })
  .strict();

const runtimeTaskLookupCommandSchema = z
  .object({
    type: z.literal("task.lookup"),
    workspaceId: workspacePublicIdSchema,
    taskKey: taskDomain.taskKeySchema,
    ...runtimeRecoveryScopedCommandFields,
  })
  .strict();

const runtimeTaskListCommandSchema = z
  .object({
    type: z.literal("task.list"),
    workspaceId: workspacePublicIdSchema,
    view: taskWorkspaceViewSchema,
    assignedAgentId: taskDomain.agentIdSchema.optional(),
    cursor: portableProjectionCursorSchema.nullable(),
    continuationRevision: workspaceProjectionRevisionSchema.optional(),
    limit: z.number().int().positive().max(runtimeTaskListPageLimit),
    ...runtimeRecoveryScopedCommandFields,
  })
  .strict()
  .superRefine((command, context) => {
    if (command.view !== "assigned" && command.assignedAgentId !== undefined) {
      context.addIssue({
        code: "custom",
        message: "only assigned task-list commands may carry an assigned agent",
        path: ["assignedAgentId"],
      });
    }
    if ((command.cursor !== null) !== (command.continuationRevision !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "task-list cursor and immutable continuation revision must be supplied together",
        path: command.cursor === null ? ["cursor"] : ["continuationRevision"],
      });
    }
  });

const runtimeTaskWorkspaceProjectionCommandSchema = z
  .object({
    type: z.literal("task.workspace.projection"),
    workspaceId: workspacePublicIdSchema,
    view: taskWorkspaceViewSchema,
    assignedAgentId: taskDomain.agentIdSchema.optional(),
    selectedTaskId: taskPublicIdSchema.nullable(),
    minimumRevision: workspaceProjectionRevisionSchema.nullable(),
    limit: z.number().int().positive().max(runtimeTaskListPageLimit),
    ...runtimeRecoveryScopedCommandFields,
  })
  .strict()
  .superRefine((command, context) => {
    if (command.view !== "assigned" && command.assignedAgentId !== undefined) {
      context.addIssue({
        code: "custom",
        message:
          "only assigned task-workspace projections may carry an assigned agent",
        path: ["assignedAgentId"],
      });
    }
  });

const runtimeTaskDetailCommandSchema = z
  .object({
    type: z.literal("task.detail"),
    workspaceId: workspacePublicIdSchema,
    taskId: taskPublicIdSchema,
    ...runtimeRecoveryScopedCommandFields,
  })
  .strict();

export type RuntimeTaskMutation = Exclude<
  TaskWorkspaceMutationIntent,
  { readonly kind: "task.submit" | "interaction.settle" }
>;

export const runtimeRendererTaskMutationIntentSchema: z.ZodType<
  RuntimeTaskMutation
> = taskWorkspaceMutationIntentSchema.refine(
  (intent): intent is RuntimeTaskMutation =>
    intent.kind !== "task.submit" &&
    intent.kind !== "interaction.settle",
  "renderer task mutations cannot submit agent work or settle provider interactions",
);

export type RuntimeTaskMutationKind = RuntimeTaskMutation["kind"];

export const runtimeRendererTaskMutationKindSchema: z.ZodType<
  RuntimeTaskMutationKind
> = taskDomain.portableTaskCommandKindSchema.refine(
  (kind): kind is RuntimeTaskMutationKind =>
    kind !== "task.submit" &&
    kind !== "interaction.settle",
  "renderer mutation attempts cannot name host-only task commands",
);

export const runtimeTaskMutationFingerprintSchema = z
  .string()
  .regex(/^sha256_[a-f0-9]{64}$/u);

const runtimeTaskMutationFenceFields = new Set<string>(
  taskDomain.taskWorkspaceMutationFenceFieldValues,
);

function canonicalRuntimeTaskMutationValue(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
    case "boolean":
      return String(value);
    case "undefined":
      return "undefined";
    case "object":
      if (Array.isArray(value)) {
        return `[${value.map(canonicalRuntimeTaskMutationValue).join(",")}]`;
      }
      return `{${Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0
        )
        .map(
          ([key, entry]) =>
            `${JSON.stringify(key)}:${canonicalRuntimeTaskMutationValue(entry)}`,
        )
        .join(",")}}`;
    case "bigint":
    case "function":
    case "symbol":
      throw new TypeError("Mutation attempt inputs must be JSON-compatible.");
    default:
      throw new TypeError("Unsupported mutation attempt input.");
  }
}

/**
 * Compares only schema-owned immutable mutation-result data. Canonical key
 * ordering keeps independently decoded bridge and receipt values equivalent
 * without relying on object insertion order.
 */
export function runtimeTaskMutationResultsEqual(
  leftValue: unknown,
  rightValue: unknown,
): boolean {
  const left = taskWorkspaceMutationResultSchema.safeParse(leftValue);
  const right = taskWorkspaceMutationResultSchema.safeParse(rightValue);
  return left.success &&
    right.success &&
    canonicalRuntimeTaskMutationValue(left.data) ===
      canonicalRuntimeTaskMutationValue(right.data);
}

/**
 * Canonical semantic identity shared by the renderer and trusted gateway.
 * Optimistic fences may refresh before an effect starts; all other values
 * remain part of the prepared action's identity.
 */
export function runtimeTaskMutationSemanticKey(
  action: string,
  input: unknown,
): string {
  const semanticInput = (
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input)
  )
    ? taskDomain.normalizeTaskWorkspaceSemanticValue(Object.fromEntries(
      Object.entries(input).filter(
        ([key, value]) =>
          value !== undefined && !runtimeTaskMutationFenceFields.has(key),
      ),
    ))
    : input;
  return `${action}:${canonicalRuntimeTaskMutationValue(semanticInput)}`;
}

const runtimeTaskMutationAttemptBaseFields = {
  attemptId: operationIdSchema,
  workspaceId: workspacePublicIdSchema,
  commandKind: runtimeRendererTaskMutationKindSchema,
  revision: revisionSchema,
  preparedAt: taskDomain.epochMsSchema,
} as const;

export const runtimeTaskMutationAttemptSchema = z.discriminatedUnion("state", [
  z
    .object({
      ...runtimeTaskMutationAttemptBaseFields,
      state: z.literal("prepared"),
    })
    .strict(),
  z
    .object({
      ...runtimeTaskMutationAttemptBaseFields,
      state: z.literal("effect_started"),
      effectStartedAt: taskDomain.epochMsSchema,
    })
    .strict(),
  z
    .object({
      ...runtimeTaskMutationAttemptBaseFields,
      state: z.literal("settled"),
      effectStartedAt: taskDomain.epochMsSchema.nullable(),
      settledAt: taskDomain.epochMsSchema,
      terminalOutcome: z.enum(["committed", "rejected", "not_applied"]),
    })
    .strict(),
]);

const runtimeTaskMutationAttemptPrepareCommandSchema = z
  .object({
    type: z.literal("task.mutation.attempt.prepare"),
    workspaceId: workspacePublicIdSchema,
    attemptId: operationIdSchema,
    commandKind: runtimeRendererTaskMutationKindSchema,
    fingerprint: runtimeTaskMutationFingerprintSchema,
  })
  .strict();

const runtimeTaskMutationAttemptStartCommandSchema = z
  .object({
    type: z.literal("task.mutation.attempt.start"),
    workspaceId: workspacePublicIdSchema,
    attemptId: operationIdSchema,
    expectedRevision: revisionSchema,
    intent: runtimeRendererTaskMutationIntentSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.intent.operationId !== value.attemptId) {
      context.addIssue({
        code: "custom",
        message: "started mutation intent must own the prepared attempt ID",
        path: ["intent", "operationId"],
      });
    }
  });

const runtimeTaskMutationAttemptListCommandSchema = z
  .object({
    type: z.literal("task.mutation.attempt.list"),
    workspaceId: workspacePublicIdSchema,
    limit: z.number().int().positive().max(runtimeTaskMutationAttemptListLimit),
  })
  .strict();

const runtimeTaskMutationAttemptInspectCommandSchema = z
  .object({
    type: z.literal("task.mutation.attempt.inspect"),
    workspaceId: workspacePublicIdSchema,
    attemptId: operationIdSchema,
    expectedRevision: revisionSchema,
  })
  .strict();

const runtimeTaskMutationAttemptReconcileCommandSchema = z
  .object({
    type: z.literal("task.mutation.attempt.reconcile"),
    workspaceId: workspacePublicIdSchema,
    attemptId: operationIdSchema,
    expectedRevision: revisionSchema,
  })
  .strict();

const runtimeTaskMutationCommandSchema = z
  .object({
    type: z.literal("task.mutate"),
    workspaceId: workspacePublicIdSchema,
    intent: runtimeRendererTaskMutationIntentSchema,
    ...runtimeRecoveryScopedCommandFields,
  })
  .strict();

const runtimeTaskPromotionStartCommandSchema = z.object({
  type: z.literal("task.promotion.start"),
  workspaceId: workspacePublicIdSchema,
  destinationOrganizationId: organizationIdSchema,
}).strict();

const runtimeTaskPromotionStatusCommandSchema = z.object({
  type: z.literal("task.promotion.status"),
  workspaceId: workspacePublicIdSchema,
}).strict();

const runtimeTaskPromotionAbortCommandSchema = z.object({
  type: z.literal("task.promotion.abort"),
  workspaceId: workspacePublicIdSchema,
  promotionId: taskDomain.promotionIdSchema,
}).strict();

const runtimeTaskPromotionRecoveryCommandSchema = z.object({
  type: z.literal("task.promotion.recovery.open"),
  workspaceId: workspacePublicIdSchema,
  promotionId: taskDomain.promotionIdSchema,
}).strict();

export const runtimeTaskDomainCommandSchema = z.discriminatedUnion("type", [
  runtimeTaskWorkspaceListCommandSchema,
  runtimeTaskRepositoryListCommandSchema,
  runtimeTaskWorkspaceContextCommandSchema,
  runtimeTaskLookupCommandSchema,
  runtimeTaskWorkspaceProjectionCommandSchema,
  runtimeTaskListCommandSchema,
  runtimeTaskDetailCommandSchema,
  runtimeTaskMutationAttemptPrepareCommandSchema,
  runtimeTaskMutationAttemptStartCommandSchema,
  runtimeTaskMutationAttemptListCommandSchema,
  runtimeTaskMutationAttemptInspectCommandSchema,
  runtimeTaskMutationAttemptReconcileCommandSchema,
  runtimeTaskMutationCommandSchema,
  runtimeTaskPromotionStartCommandSchema,
  runtimeTaskPromotionStatusCommandSchema,
  runtimeTaskPromotionAbortCommandSchema,
  runtimeTaskPromotionRecoveryCommandSchema,
]);

const runtimeChatPaneCreateCommandSchema = z
  .object({
    type: z.literal("chat.pane.create"),
    paneId: chatPaneIdSchema,
    repositoryId: taskDomain.repositoryIdSchema,
  })
  .strict();

const runtimeChatPaneRenameCommandSchema = z
  .object({
    type: z.literal("chat.pane.rename"),
    paneId: chatPaneIdSchema,
    expectedRevision: revisionSchema,
    title: chatPaneTitleSchema,
  })
  .strict();

const runtimeChatPaneScheduleConfigureCommandSchema = z
  .object({
    type: z.literal("chat.pane.schedule.configure"),
    paneId: chatPaneIdSchema,
    expectedRevision: revisionSchema,
    instruction: utf8StringSchema({
      minBytes: 1,
      maxBytes: runtimeChatMessageUtf8ByteLimit,
    }).refine(
      (value) => value.trim().length > 0,
      "chat schedule instruction must contain non-whitespace text",
    ),
  })
  .strict();

const runtimeChatPaneScheduleRemoveCommandSchema = z
  .object({
    type: z.literal("chat.pane.schedule.remove"),
    paneId: chatPaneIdSchema,
    expectedRevision: revisionSchema,
  })
  .strict();

const runtimeChatPaneWorkspaceRecoverCommandSchema = z
  .object({
    type: z.literal("chat.pane.workspace.recover"),
    paneId: chatPaneIdSchema,
    expectedRevision: revisionSchema,
  })
  .strict();

const runtimeChatPaneRepositorySelectCommandSchema = z
  .object({
    type: z.literal("chat.pane.repository.select"),
    paneId: chatPaneIdSchema,
    repositoryId: taskDomain.repositoryIdSchema,
    expectedRevision: revisionSchema,
  })
  .strict();

const runtimeChatPaneRemoveCommandSchema = z
  .object({
    type: z.literal("chat.pane.remove"),
    paneId: chatPaneIdSchema,
    expectedRevision: revisionSchema,
  })
  .strict();

const runtimeChatPanesReorderCommandSchema = z
  .object({
    type: z.literal("chat.panes.reorder"),
    expectedOrderedPaneIds: z.array(chatPaneIdSchema).min(1).max(runtimeChatPaneLimit),
    orderedPaneIds: z.array(chatPaneIdSchema).min(1).max(runtimeChatPaneLimit),
  })
  .strict()
  .superRefine((command, context) => {
    if (
      new Set(command.expectedOrderedPaneIds).size !==
        command.expectedOrderedPaneIds.length
    ) {
      context.addIssue({
        code: "custom",
        message: "expected chat pane reorder IDs must be unique",
        path: ["expectedOrderedPaneIds"],
      });
    }
    if (new Set(command.orderedPaneIds).size !== command.orderedPaneIds.length) {
      context.addIssue({
        code: "custom",
        message: "chat pane reorder IDs must be unique",
        path: ["orderedPaneIds"],
      });
    }
    const expectedPaneIds = new Set(command.expectedOrderedPaneIds);
    if (
      command.expectedOrderedPaneIds.length !== command.orderedPaneIds.length ||
      command.orderedPaneIds.some((paneId) => !expectedPaneIds.has(paneId))
    ) {
      context.addIssue({
        code: "custom",
        message: "chat pane reorder must preserve the expected pane set",
        path: ["orderedPaneIds"],
      });
    }
  });

const runtimeChatTurnStopCommandSchema = z
  .object({
    type: z.literal("chat.turn.stop"),
    paneId: chatPaneIdSchema,
    expectedRevision: revisionSchema,
    turnId: chatTurnIdSchema,
  })
  .strict();

const runtimeChatMessageEnqueueCommandSchema = z
  .object({
    type: z.literal("chat.message.enqueue"),
    paneId: chatPaneIdSchema,
    expectedQueueRevision: revisionSchema,
    messageId: chatMessageIdSchema,
    content: chatMessageContentSchema,
    delivery: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("queue") }).strict(),
      z.object({
        kind: z.literal("steerHead"),
        expectedTurnId: chatTurnIdSchema,
      }).strict(),
    ]),
  })
  .strict();

const runtimeChatMessageEditCommandSchema = z
  .object({
    type: z.literal("chat.message.edit"),
    paneId: chatPaneIdSchema,
    expectedQueueRevision: revisionSchema,
    messageId: chatMessageIdSchema,
    expectedMessageRevision: revisionSchema,
    content: chatMessageContentSchema,
  })
  .strict();

const runtimeChatMessageRemoveCommandSchema = z
  .object({
    type: z.literal("chat.message.remove"),
    paneId: chatPaneIdSchema,
    expectedQueueRevision: revisionSchema,
    messageId: chatMessageIdSchema,
    expectedMessageRevision: revisionSchema,
  })
  .strict();

const runtimeChatMessageQueueResumeCommandSchema = z
  .object({
    type: z.literal("chat.messageQueue.resume"),
    paneId: chatPaneIdSchema,
    expectedQueueRevision: revisionSchema,
  })
  .strict();

const runtimeChatPaneStartFreshContextCommandSchema = z
  .object({
    type: z.literal("chat.pane.startFreshContext"),
    paneId: chatPaneIdSchema,
    expectedRevision: revisionSchema,
    expectedQueueRevision: revisionSchema,
  })
  .strict();

const runtimeChatMessageDiscardAmbiguousCommandSchema = z
  .object({
    type: z.literal("chat.message.discardAmbiguous"),
    paneId: chatPaneIdSchema,
    expectedQueueRevision: revisionSchema,
    messageId: chatMessageIdSchema,
    expectedMessageRevision: revisionSchema,
  })
  .strict();

const runtimeChatMessageSteerHeadCommandSchema = z
  .object({
    type: z.literal("chat.message.steerHead"),
    paneId: chatPaneIdSchema,
    expectedQueueRevision: revisionSchema,
    messageId: chatMessageIdSchema,
    expectedMessageRevision: revisionSchema,
    expectedTurnId: chatTurnIdSchema,
  })
  .strict();

const chatAttachmentCommandBaseSchema = {
  paneId: chatPaneIdSchema,
  attachmentId: chatMessageAttachmentIdSchema,
} as const;

const runtimeChatAttachmentBeginCommandSchema = z
  .object({
    type: z.literal("chat.attachment.begin"),
    ...chatAttachmentCommandBaseSchema,
    uploadId: chatAttachmentUploadIdSchema,
    kind: z.enum(["image", "file"]),
    displayName: utf8StringSchema({
      minBytes: 1,
      maxBytes: runtimeChatAttachmentDisplayNameUtf8ByteLimit,
    }),
    declaredMediaType: z
      .string()
      .min(1)
      .max(runtimeChatAttachmentMediaTypeByteLimit)
      .regex(/^[\x21-\x7e]+$/u),
    expectedBytes: z
      .number()
      .int()
      .positive()
      .safe()
      .max(runtimeChatAttachmentInputByteLimit),
  })
  .strict();

const runtimeChatAttachmentAppendCommandSchema = z
  .object({
    type: z.literal("chat.attachment.append"),
    ...chatAttachmentCommandBaseSchema,
    uploadId: chatAttachmentUploadIdSchema,
    expectedRevision: revisionSchema,
    chunkOrdinal: z.number().int().nonnegative().safe().max(47),
    base64: z
      .string()
      .min(4)
      .max(Math.ceil(runtimeChatAttachmentChunkByteLimit / 3) * 4)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u),
  })
  .strict();

const runtimeChatAttachmentFinalizeCommandSchema = z
  .object({
    type: z.literal("chat.attachment.finalize"),
    ...chatAttachmentCommandBaseSchema,
    uploadId: chatAttachmentUploadIdSchema,
    expectedRevision: revisionSchema,
    inputSha256: z.string().length(64).regex(/^[0-9a-f]{64}$/u),
  })
  .strict();

const runtimeChatAttachmentCancelCommandSchema = z
  .object({
    type: z.literal("chat.attachment.cancel"),
    ...chatAttachmentCommandBaseSchema,
    uploadId: chatAttachmentUploadIdSchema,
    expectedRevision: revisionSchema,
  })
  .strict();

const runtimeChatAttachmentRemoveCommandSchema = z
  .object({
    type: z.literal("chat.attachment.remove"),
    ...chatAttachmentCommandBaseSchema,
    expectedRevision: revisionSchema,
  })
  .strict();

const runtimeChatAttachmentPreviewCommandSchema = z
  .object({
    type: z.literal("chat.attachment.preview"),
    ...chatAttachmentCommandBaseSchema,
    expectedRevision: revisionSchema,
    relationship: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("draft") }).strict(),
      z.object({ kind: z.literal("message"), messageId: chatMessageIdSchema }).strict(),
    ]),
  })
  .strict();

export const runtimeChatAttachmentCommandSchema = z.discriminatedUnion("type", [
  runtimeChatAttachmentBeginCommandSchema,
  runtimeChatAttachmentAppendCommandSchema,
  runtimeChatAttachmentFinalizeCommandSchema,
  runtimeChatAttachmentCancelCommandSchema,
  runtimeChatAttachmentRemoveCommandSchema,
  runtimeChatAttachmentPreviewCommandSchema,
]);

/** The renderer's complete durable message mutation surface. */
export const runtimeChatMessageLedgerCommandSchema = z.discriminatedUnion(
  "type",
  [
    runtimeChatMessageEnqueueCommandSchema,
    runtimeChatMessageEditCommandSchema,
    runtimeChatMessageRemoveCommandSchema,
    runtimeChatMessageQueueResumeCommandSchema,
    runtimeChatPaneStartFreshContextCommandSchema,
    runtimeChatMessageDiscardAmbiguousCommandSchema,
    runtimeChatMessageSteerHeadCommandSchema,
  ],
);

export const runtimeChatMessageQueueResultSchema = z
  .object({
    type: z.literal("chatMessageQueue"),
    paneId: chatPaneIdSchema,
    queue: chatMessageQueueProjectionSchema,
    disposition: z.enum(["applied", "notApplied", "replayed"]),
    messageId: chatMessageIdSchema.nullable(),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.disposition !== "applied" && result.messageId === null) {
      context.addIssue({
        code: "custom",
        message: "a replayed queue outcome requires its exact message ID",
        path: ["messageId"],
      });
    }
  });

export const runtimeChatPaneResultSchema = z.object({
  type: z.literal("chatPane"),
  pane: chatPaneProjectionSchema,
  disposition: z.literal("applied"),
  appliedRevision: revisionSchema,
}).strict().superRefine((result, context) => {
  if (result.pane.revision !== result.appliedRevision) {
    context.addIssue({
      code: "custom",
      message: "an applied chat pane result must carry its exact revision",
      path: ["appliedRevision"],
    });
  }
});

const runtimeChatPaneReplayCommandTypeSchema = z.enum([
  "chat.pane.create",
  "chat.pane.rename",
  "chat.pane.schedule.configure",
  "chat.pane.schedule.remove",
  "chat.pane.workspace.recover",
  "chat.pane.repository.select",
  "chat.turn.stop",
]);

/**
 * Content-free proof of an exact operation-receipt replay. The gateway emits
 * this only after the operation ID, command type, and keyed command fingerprint
 * match the durable receipt. Current pane state comes from the authoritative
 * projection and is never misrepresented as the historical mutation result.
 */
export const runtimeChatPaneReplayResultSchema = z.object({
  type: z.literal("chatPaneReplay"),
  paneId: chatPaneIdSchema,
  commandType: runtimeChatPaneReplayCommandTypeSchema,
  appliedRevision: revisionSchema,
}).strict();

export const runtimeChatMessageQueueChangedEventSchema = z
  .object({
    type: z.literal("chat.messageQueue.changed"),
    paneId: chatPaneIdSchema,
    revision: revisionSchema,
  })
  .strict();

const runtimeHarnessSettingsUpdateCommandSchema = z
  .object({
    type: z.literal("harness.settings.update"),
    expectedHarnessRevision: revisionSchema,
    expectedRevision: revisionSchema,
    recursiveSessionsEnabled: z.boolean(),
    contextQuotaBytes: harnessSettingsProjectionSchema.shape.contextQuotaBytes,
    refinementMode: harnessRefinementModeSchema,
  })
  .strict();

const runtimeHarnessChildOpenCommandSchema = z
  .object({
    type: z.literal("harness.child.open"),
    parentPaneId: chatPaneIdSchema,
    childId: harnessActorIdSchema,
    expectedParentRevision: revisionSchema,
    expectedChildRevision: revisionSchema,
  })
  .strict();

const runtimeHarnessChildStopCommandSchema = z
  .object({
    type: z.literal("harness.child.stop"),
    parentPaneId: chatPaneIdSchema,
    childId: harnessActorIdSchema,
    expectedParentRevision: revisionSchema,
    expectedChildRevision: revisionSchema,
  })
  .strict();

export const runtimeChatDomainCommandSchema = z.discriminatedUnion("type", [
  runtimeChatPaneCreateCommandSchema,
  runtimeChatPaneRenameCommandSchema,
  runtimeChatPaneScheduleConfigureCommandSchema,
  runtimeChatPaneScheduleRemoveCommandSchema,
  runtimeChatPaneWorkspaceRecoverCommandSchema,
  runtimeChatPaneRepositorySelectCommandSchema,
  runtimeChatPaneRemoveCommandSchema,
  runtimeChatPanesReorderCommandSchema,
  runtimeChatTurnStopCommandSchema,
  ...runtimeChatMessageLedgerCommandSchema.options,
  ...runtimeChatAttachmentCommandSchema.options,
]);

export const runtimeHarnessDomainCommandSchema = z.discriminatedUnion("type", [
  runtimeHarnessSettingsUpdateCommandSchema,
  runtimeHarnessChildOpenCommandSchema,
  runtimeHarnessChildStopCommandSchema,
]);

const sessionSyncExpectedRevisionField = {
  expectedRevision: sessionSyncRevisionSchema,
} as const;

export const runtimeSessionSyncDomainCommandSchema = z.discriminatedUnion(
  "type",
  [
    z.object({
      type: z.literal("sessionSync.enable"),
      ...sessionSyncExpectedRevisionField,
      deviceName: sessionSyncDeviceNameSchema,
    }).strict(),
    z.object({
      type: z.literal("sessionSync.disable"),
      ...sessionSyncExpectedRevisionField,
    }).strict(),
    z.object({ type: z.literal("sessionSync.retry") }).strict(),
    z.object({
      type: z.literal("sessionSync.scheduledChat.orphan.clear"),
      ...sessionSyncExpectedRevisionField,
      orphanId: sessionSyncScheduledChatOrphanIdSchema,
    }).strict(),
    z.object({
      type: z.literal("sessionSync.enrollment.approve"),
      ...sessionSyncExpectedRevisionField,
      requestId: sessionSyncEnrollmentRequestIdSchema,
      pairingCode: syncEnrollmentPairingCodeSchema,
    }).strict(),
    z.object({
      type: z.literal("sessionSync.device.revoke"),
      ...sessionSyncExpectedRevisionField,
      deviceId: syncDeviceIdSchema,
    }).strict(),
    z.object({
      type: z.literal("sessionSync.recovery.reveal"),
      ...sessionSyncExpectedRevisionField,
    }).strict(),
    z.object({
      type: z.literal("sessionSync.recovery.import"),
      ...sessionSyncExpectedRevisionField,
      recoveryKit: utf8StringSchema({
        minBytes: 64,
        maxBytes: runtimeSessionSyncRecoveryKitUtf8ByteLimit,
      }),
    }).strict(),
    z.object({
      type: z.literal("sessionSync.recoveryKitSavedOffline"),
      ...sessionSyncExpectedRevisionField,
      revealId: sessionSyncRecoveryRevealIdSchema,
    }).strict(),
    z.object({
      type: z.literal("sessionSync.recovery.rotate"),
      ...sessionSyncExpectedRevisionField,
    }).strict(),
    z.object({
      type: z.literal("sessionSync.reset"),
      ...sessionSyncExpectedRevisionField,
      confirmation: z.literal(runtimeSessionSyncResetConfirmation),
    }).strict(),
  ],
);

export const runtimeDomainCommandSchema = z.discriminatedUnion("type", [
  runtimeChatPaneCreateCommandSchema,
  runtimeChatPaneRenameCommandSchema,
  runtimeChatPaneScheduleConfigureCommandSchema,
  runtimeChatPaneScheduleRemoveCommandSchema,
  runtimeChatPaneWorkspaceRecoverCommandSchema,
  runtimeChatPaneRepositorySelectCommandSchema,
  runtimeChatPaneRemoveCommandSchema,
  runtimeChatPanesReorderCommandSchema,
  runtimeChatTurnStopCommandSchema,
  ...runtimeChatMessageLedgerCommandSchema.options,
  ...runtimeChatAttachmentCommandSchema.options,
  runtimeHarnessSettingsUpdateCommandSchema,
  runtimeHarnessChildOpenCommandSchema,
  runtimeHarnessChildStopCommandSchema,
  ...runtimeSessionSyncDomainCommandSchema.options,
  z.object({ type: z.literal("runtime.restartAccount"), accountProfileId: accountProfileIdSchema }).strict(),
  z.object({ type: z.literal("account.create"), label: z.string().min(1).max(80) }).strict(),
  z
    .object({
      type: z.literal("account.login.start"),
      accountProfileId: accountProfileIdSchema,
      mode: z.enum(["browser", "deviceCode"]),
    })
    .strict(),
  z.object({ type: z.literal("account.login.cancel"), accountProfileId: accountProfileIdSchema }).strict(),
  z.object({ type: z.literal("account.login.open"), accountProfileId: accountProfileIdSchema }).strict(),
  z.object({ type: z.literal("account.logout"), accountProfileId: accountProfileIdSchema }).strict(),
  z.object({ type: z.literal("account.refresh"), accountProfileId: accountProfileIdSchema }).strict(),
  z.object({ type: z.literal("account.remove.preview"), accountProfileId: accountProfileIdSchema }).strict(),
  z
    .object({
      type: z.literal("account.remove"),
      accountProfileId: accountProfileIdSchema,
      expectedRevision: revisionSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("account.localData.delete.preview"),
      accountProfileId: accountProfileIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("account.localData.delete"),
      accountProfileId: accountProfileIdSchema,
      expectedRevision: revisionSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("maintenance.localDataRemoval.preview"),
    })
    .strict(),
  z
    .object({
      type: z.literal("maintenance.localDataRemoval.remove"),
      previewId: localDataRemovalPreviewIdSchema,
      confirmationToken: localDataRemovalConfirmationTokenSchema,
      confirmation: z.literal(runtimeLocalDataRemovalConfirmation),
      acknowledgeDirtyWorktrees: z.boolean(),
    })
    .strict(),
  z.object({ type: z.literal("account.select"), accountProfileId: accountProfileIdSchema }).strict(),
  z.object({ type: z.literal("human.signIn.start") }).strict(),
  z.object({ type: z.literal("human.signIn.cancel") }).strict(),
  z.object({ type: z.literal("human.signOut") }).strict(),
  z
    .object({
      type: z.literal("human.credentials.retry"),
      expectedRevision: revisionSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("human.credentials.reconnect"),
      expectedRevision: revisionSchema,
      confirmation: z.literal(runtimeHumanCredentialReconnectConfirmation),
    })
    .strict(),
  z
    .object({
      type: z.literal("human.organizations.list"),
      cursor: z.string().min(1).max(8_192).nullable().default(null),
      limit: z.number().int().min(1).max(100).default(100),
    })
    .strict(),
  z
    .object({
      type: z.literal("human.organization.create"),
      name: organizationNameSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("human.organization.select"),
      organizationId: organizationIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("human.workspaces.list"),
      cursor: z.string().min(1).max(8_192).nullable().default(null),
      limit: z.number().int().min(1).max(100).default(100),
    })
    .strict(),
  z
    .object({
      type: z.literal("human.workspace.select"),
      workspaceId: workspaceIdSchema,
    })
    .strict(),
]);

export const runtimeDispatchRequestSchema = z
  .object({
    version: z.literal(runtimeProtocolVersion),
    operationId: operationIdSchema,
    command: runtimeDomainCommandSchema,
  })
  .strict();

export const runtimeTaskDispatchRequestSchema = z
  .object({
    version: z.literal(runtimeProtocolVersion),
    operationId: operationIdSchema,
    command: runtimeTaskDomainCommandSchema,
  })
  .strict();

export const runtimeDispatchContinuationRequestSchema = z
  .object({
    version: z.literal(runtimeProtocolVersion),
    operationId: operationIdSchema,
    transferId: dispatchTransferIdSchema,
    index: z.number().int().positive().max(runtimeDispatchChunkCountLimit - 1),
  })
  .strict();

export const runtimeDispatchTransportRequestSchema = z.union([
  runtimeDispatchRequestSchema,
  runtimeTaskDispatchRequestSchema,
  runtimeDispatchContinuationRequestSchema,
]);

export const runtimeProjectAddRequestSchema = z
  .object({ version: z.literal(runtimeProtocolVersion) })
  .strict();

export const runtimeFolderAccessSelectRequestSchema = z
  .object({ version: z.literal(runtimeProtocolVersion) })
  .strict();

const runtimeFolderAccessSelectErrorSchema = z.object({
  code: z.enum([
    "invalid_directory",
    "invalid_request",
    "persistence_failed",
    "runtime_unavailable",
  ]),
  message: utf8StringSchema({ minBytes: 1, maxBytes: 240 }),
}).strict();

export const runtimeFolderAccessSelectResultSchema = z.discriminatedUnion(
  "status",
  [
    z.object({
      version: z.literal(runtimeProtocolVersion),
      status: z.literal("cancelled"),
    }).strict(),
    z.object({
      version: z.literal(runtimeProtocolVersion),
      status: z.literal("selected"),
      folderAccess: executionFolderAccessProjectionSchema,
    }).strict(),
    z.object({
      version: z.literal(runtimeProtocolVersion),
      status: z.literal("failed"),
      error: runtimeFolderAccessSelectErrorSchema,
    }).strict(),
  ],
);

const runtimeProjectAddRepositorySchema = z
  .object({
    id: taskDomain.repositoryIdSchema,
    name: taskDomain.repositoryNameSchema,
    createdAt: taskDomain.epochMsSchema,
  })
  .strict();

const runtimeProjectAddErrorSchema = z
  .object({
    code: z.enum([
      "identifier_exhausted",
      "identity_conflict",
      "installation_not_registered",
      "invalid_repository",
      "invalid_request",
      "persistence_failed",
    ]),
    message: z.string().min(1).max(240),
  })
  .strict();

export const runtimeProjectAddResultSchema = z.discriminatedUnion("status", [
  z.object({ version: z.literal(runtimeProtocolVersion), status: z.literal("cancelled") }).strict(),
  z
    .object({
      version: z.literal(runtimeProtocolVersion),
      status: z.literal("created"),
      repository: runtimeProjectAddRepositorySchema,
      workspace: workspaceSummarySchema,
    })
    .strict(),
  z
    .object({
      version: z.literal(runtimeProtocolVersion),
      status: z.literal("failed"),
      error: runtimeProjectAddErrorSchema,
    })
    .strict(),
]);

/** The private host forwards this already-redacted onboarding outcome only to
 * this adapter, which normalizes it into RuntimeProjectAddResult. */
const runtimeProjectOnboardingOutcomeSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      value: z
        .object({
          repository: runtimeProjectAddRepositorySchema,
          workspace: workspaceSummarySchema,
        })
        .strict(),
    })
    .strict(),
  z.object({ ok: z.literal(false), error: runtimeProjectAddErrorSchema }).strict(),
]);

export const runtimeErrorSchema = z
  .object({
    code: z.enum([
      "invalid_request",
      "runtime_unavailable",
      "not_found",
      "conflict",
      "stale_revision",
      "policy_denied",
      "capability_unavailable",
      "protocol_error",
      "upstream_ambiguous",
      "not_implemented",
      "operation_failed",
      "authority_mismatch",
      "revision_conflict",
      "invalid_state",
      "graph_cycle",
      "graph_limit",
      "terminal",
      "capacity_full",
      "operation_conflict",
    ]),
    message: z.string().min(1).max(500),
    retryable: z.boolean(),
    action: z.enum(["none", "retry", "restartRuntime", "signIn", "resolveAttention"]),
  })
  .strict();

const runtimeCommandResultSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("accepted") }).strict(),
  runtimeChatPaneResultSchema,
  runtimeChatPaneReplayResultSchema,
  runtimeChatMessageQueueResultSchema,
  z.object({
    type: z.literal("chatAttachment"),
    paneId: chatPaneIdSchema,
    uploadId: chatAttachmentUploadIdSchema,
    attachment: chatAttachmentMetadataSchema,
    changed: z.boolean(),
  }).strict(),
  z.object({
    type: z.literal("chatAttachmentRemoved"),
    paneId: chatPaneIdSchema,
    attachmentId: chatMessageAttachmentIdSchema,
    removed: z.literal(true),
    changed: z.boolean(),
  }).strict(),
  z.object({
    type: z.literal("chatAttachmentPreview"),
    paneId: chatPaneIdSchema,
    attachmentId: chatMessageAttachmentIdSchema,
    revision: revisionSchema,
    mediaType: z.literal("image/png"),
    base64: z
      .string()
      .min(4)
      .max(Math.ceil(runtimeChatAttachmentPreviewByteLimit / 3) * 4)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u),
  }).strict(),
  z.object({ type: z.literal("chatPaneRemoved"), paneId: chatPaneIdSchema }).strict(),
  z.object({
    type: z.literal("sessionSyncRecoveryKit"),
    revealId: sessionSyncRecoveryRevealIdSchema,
    recoveryKit: utf8StringSchema({
      minBytes: 64,
      maxBytes: runtimeSessionSyncRecoveryKitUtf8ByteLimit,
    }),
    expiresAt: sessionSyncTimestampSchema,
  }).strict(),
  z
    .object({
      type: z.literal("harnessSettings"),
      harnessRevision: revisionSchema,
      settings: harnessSettingsProjectionSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("harnessChild"),
      parentPaneId: chatPaneIdSchema,
      parentRevision: revisionSchema,
      child: harnessChildProjectionSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("harnessChildOpened"),
      parentPaneId: chatPaneIdSchema,
      parentRevision: revisionSchema,
      child: harnessChildProjectionSchema,
      pane: chatPaneProjectionSchema,
    })
    .strict()
    .superRefine((result, context) => {
      if (result.child.openedPaneId !== result.pane.id) {
        context.addIssue({
          code: "custom",
          message: "opened harness child must reference the returned pane",
          path: ["child", "openedPaneId"],
        });
      }
    }),
  z.object({ type: z.literal("account"), account: accountSummarySchema }).strict(),
  z.object({ type: z.literal("accountRemovalPreview"), preview: accountRemovalPreviewSchema }).strict(),
  z
    .object({
      type: z.literal("accountLocalDataDeletionPreview"),
      preview: accountLocalDataDeletionPreviewSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("localDataRemovalPreview"),
      preview: runtimeLocalDataRemovalPreviewSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("localDataRemovalScheduled"),
      previewId: localDataRemovalPreviewIdSchema,
      state: z.literal("scheduled"),
      willQuitApplication: z.literal(true),
    })
    .strict(),
  z
    .object({
      type: z.literal("humanOrganizations"),
      organizations: z.array(runtimeHumanOrganizationSchema).max(100),
      cursor: z.string().min(1).max(8_192).nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal("humanOrganization"),
      organization: runtimeHumanOrganizationSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("humanWorkspaces"),
      workspaces: z.array(workspaceViewSchema).max(100),
      cursor: z.string().min(1).max(8_192).nullable(),
    })
    .strict(),
]);

export const runtimeDispatchResponseSchema = z.discriminatedUnion("ok", [
  z
    .object({
      version: z.literal(runtimeProtocolVersion),
      operationId: operationIdSchema,
      ok: z.literal(true),
      result: runtimeCommandResultSchema,
    })
    .strict(),
  z
    .object({
      version: z.literal(runtimeProtocolVersion),
      operationId: operationIdSchema,
      ok: z.literal(false),
      error: runtimeErrorSchema,
    })
    .strict(),
]);

export const runtimeTaskWorkspaceContextSchema = z
  .object({
    workspaceId: workspacePublicIdSchema,
    projectionRevision: workspaceProjectionRevisionSchema,
    viewer: taskWorkspaceViewerSchema,
    capabilities: hraWorkspaceCapabilitiesSchema,
    agents: z
      .array(z.object({
        id: taskDomain.agentIdSchema,
        name: z.string().min(1).max(160),
        status: z.enum(["active", "disabled"]),
      }).strict())
      .max(500),
    runner: runnerPresenceViewSchema,
  })
  .strict();

export const runtimeTaskWorkspaceProjectionPresentationSchema = z
  .object({
    agents: z
      .array(z.object({
        id: taskDomain.agentIdSchema,
        name: z.string().min(1).max(160),
        status: z.enum(["active", "disabled"]),
      }).strict())
      .max(500),
    capabilities: hraWorkspaceCapabilitiesSchema,
    counts: taskDomain.taskWorkspaceCountsSchema,
    now: taskDomain.epochMsSchema,
    runner: z.object({
      presence: runnerPresenceViewSchema,
      repositories: z
        .array(z.object({
          id: taskDomain.repositoryIdSchema,
          name: taskDomain.repositoryNameSchema,
          ready: z.boolean(),
        }).strict())
        .max(runtimeTaskRepositorySummaryLimit),
    }).strict(),
    viewer: taskWorkspaceViewerSchema,
    workspace: z.object({
      id: workspacePublicIdSchema,
      keyPrefix: taskDomain.taskKeyPrefixSchema,
      name: taskDomain.workspaceNameSchema,
      slug: taskDomain.workspaceSlugSchema,
    }).strict(),
  })
  .strict();

const runtimeTaskMutationReceiptRejectionCodeSchema = z.enum([
  "authority_mismatch",
  "revision_conflict",
  "invalid_state",
  "graph_cycle",
  "graph_limit",
  "not_found",
  "terminal",
  "capacity_full",
  "operation_conflict",
]);

export const runtimeTaskMutationReconciliationSchema = z
  .object({
    attemptId: operationIdSchema,
    workspaceId: workspacePublicIdSchema,
    commandKind: runtimeRendererTaskMutationKindSchema,
    resolution: z.discriminatedUnion("outcome", [
      z
        .object({
          outcome: z.literal("committed"),
          mutation: taskWorkspaceMutationResultSchema,
        })
        .strict(),
      z
        .object({
          outcome: z.literal("rejected"),
          code: runtimeTaskMutationReceiptRejectionCodeSchema,
        })
        .strict(),
      z
        .object({
          outcome: z.literal("not_applied"),
        })
        .strict(),
      z
        .object({
          outcome: z.literal("ambiguous"),
          reason: z.literal("legacy_unbound_receipt"),
        })
        .strict(),
    ]),
  })
  .strict();

const runtimeTaskCommandResultSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("taskWorkspaceSummaries"),
      workspaces: runtimeTaskWorkspaceSummariesSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("taskRepositoryList"),
      page: runtimeTaskRepositoryListSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("taskWorkspaceContext"),
      context: runtimeTaskWorkspaceContextSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("taskLookup"),
      workspaceId: workspacePublicIdSchema,
      taskKey: taskDomain.taskKeySchema,
      task: z
        .object({
          id: taskPublicIdSchema,
          key: taskDomain.taskKeySchema,
          revision: workspaceProjectionRevisionSchema,
          status: taskDomain.taskStatusSchema,
          title: taskDomain.taskTitleSchema,
          priority: taskDomain.taskPrioritySchema,
        })
        .strict()
        .nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal("taskListPage"),
      page: taskListPageSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("taskDetail"),
      detail: taskDetailProjectionSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("taskWorkspaceProjection"),
      consistency: z.literal("atomic"),
      presentation: runtimeTaskWorkspaceProjectionPresentationSchema,
      projection: taskDomain.taskWorkspaceProjectionBundleSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("taskMutationAttempt"),
      attempt: runtimeTaskMutationAttemptSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("taskMutationAttemptList"),
      workspaceId: workspacePublicIdSchema,
      attempts: z
        .array(runtimeTaskMutationAttemptSchema)
        .max(runtimeTaskMutationAttemptListLimit),
    })
    .strict(),
  z
    .object({
      type: z.literal("taskMutationAttemptInspection"),
      inspection: runtimeTaskMutationReconciliationSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("taskMutationReconciliation"),
      reconciliation: runtimeTaskMutationReconciliationSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("taskMutation"),
      mutation: taskWorkspaceMutationResultSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("taskPromotionProgress"),
      progress: runtimeLocalPromotionProgressSchema.nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal("taskPromotionRecovery"),
      recovery: runtimeLocalPromotionRecoveryCopySchema.nullable(),
    })
    .strict(),
]);

export const runtimeTaskDispatchResponseSchema = z.discriminatedUnion("ok", [
  z
    .object({
      version: z.literal(runtimeProtocolVersion),
      operationId: operationIdSchema,
      ok: z.literal(true),
      result: runtimeTaskCommandResultSchema,
    })
    .strict(),
  z
    .object({
      version: z.literal(runtimeProtocolVersion),
      operationId: operationIdSchema,
      ok: z.literal(false),
      error: runtimeErrorSchema,
    })
    .strict(),
]);

const dispatchBase64ChunkSchema = z
  .string()
  .min(1)
  .max(runtimeDispatchChunkBase64Limit)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u);

export const runtimeDispatchChunkResponseSchema = z
  .object({
    version: z.literal(runtimeProtocolVersion),
    operationId: operationIdSchema,
    transferId: dispatchTransferIdSchema,
    index: z.number().int().nonnegative().max(runtimeDispatchChunkCountLimit - 1),
    count: z.number().int().positive().max(runtimeDispatchChunkCountLimit),
    base64: dispatchBase64ChunkSchema,
  })
  .strict()
  .refine(({ count, index }) => index < count, "dispatch chunk index is out of range");

export const runtimeDispatchTransportResponseSchema = z.union([
  runtimeDispatchResponseSchema,
  runtimeTaskDispatchResponseSchema,
  runtimeDispatchChunkResponseSchema,
]);

export const runtimeDomainEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("runtime.changed"), runtime: runtimeStatusSchema }).strict(),
  z.object({ type: z.literal("runner.changed"), runner: runnerConnectionStatusSchema }).strict(),
  z.object({
    type: z.literal("execution.changed"),
    execution: executionProjectionSchema,
  }).strict(),
  z.object({ type: z.literal("account.upserted"), account: accountSummarySchema }).strict(),
  z.object({ type: z.literal("account.removed"), accountProfileId: accountProfileIdSchema }).strict(),
  z
    .object({
      type: z.literal("chat.pane.upserted"),
      revision: revisionSchema,
      pane: chatPaneProjectionSchema,
    })
    .strict()
    .superRefine((event, context) => {
      if (event.revision !== event.pane.revision) {
        context.addIssue({
          code: "custom",
          message: "chat pane event revision must match the pane projection",
          path: ["revision"],
        });
      }
    }),
  z
    .object({
      type: z.literal("chat.pane.stateChanged"),
      revision: revisionSchema,
      pane: chatPaneStateProjectionSchema,
    })
    .strict()
    .superRefine((event, context) => {
      if (event.revision !== event.pane.revision) {
        context.addIssue({
          code: "custom",
          message: "chat pane event revision must match the pane state projection",
          path: ["revision"],
        });
      }
    }),
  z
    .object({
      type: z.literal("chat.pane.removed"),
      paneId: chatPaneIdSchema,
      revision: revisionSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("chat.panes.reordered"),
      orderedPaneIds: z.array(chatPaneIdSchema).min(1).max(runtimeChatPaneLimit),
    })
    .strict()
    .superRefine((event, context) => {
      if (new Set(event.orderedPaneIds).size !== event.orderedPaneIds.length) {
        context.addIssue({
          code: "custom",
          message: "reordered chat pane IDs must be unique",
          path: ["orderedPaneIds"],
        });
      }
    }),
  z
    .object({
      type: z.literal("chat.turn.delta"),
      paneId: chatPaneIdSchema,
      turnId: chatTurnIdSchema,
      revision: revisionSchema,
      channel: z.enum(["reasoningSummary", "responseMarkdown"]),
      startUtf8Offset: z.number().int().nonnegative().safe(),
      delta: utf8StringSchema({
        minBytes: 1,
        maxBytes: runtimeChatDeltaUtf8ByteLimit,
      }),
    })
    .strict(),
  runtimeChatMessageQueueChangedEventSchema,
  z
    .object({ type: z.literal("accountLocalData.upserted"), localData: retainedAccountLocalDataSchema })
    .strict(),
  z
    .object({ type: z.literal("accountLocalData.removed"), accountProfileId: accountProfileIdSchema })
    .strict(),
  z
    .object({
      type: z.literal("humanAccount.changed"),
      humanAccount: humanAccountSnapshotSchema,
    })
    .strict(),
  z.object({
    type: z.literal("sessionSync.statusChanged"),
    status: sessionSyncStatusProjectionSchema,
  }).strict(),
  z.object({
    type: z.literal("sessionSync.localGrid.changed"),
    slots: z.array(localSessionGridSlotProjectionSchema).max(runtimeChatPaneLimit),
  }).strict(),
  z.object({
    type: z.literal("sessionSync.remote.upserted"),
    session: remoteSessionSummaryProjectionSchema,
  }).strict(),
  z.object({
    type: z.literal("sessionSync.remote.removed"),
    sessionId: syncedSessionPublicIdSchema,
  }).strict(),
  z.object({ type: z.literal("sessionSync.remote.cleared") }).strict(),
  z
    .object({
      type: z.literal("task.invalidated"),
      invalidation: portableInvalidationSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("snapshot.invalidated"),
      reason: z.enum([
        "projectionOverflow",
        "harnessChanged",
        "sessionSyncChanged",
        "chatAttachmentsChanged",
      ]),
    })
    .strict(),
  z
    .object({
      type: z.literal("operation.completed"),
      operationId: operationIdSchema,
      outcome: z.discriminatedUnion("ok", [
        z.object({ ok: z.literal(true) }).strict(),
        z.object({ ok: z.literal(false), error: runtimeErrorSchema }).strict(),
      ]),
    })
    .strict(),
]);

export const runtimeEventSchema = z
  .object({
    version: z.literal(runtimeProtocolVersion),
    sequence: nativeTransportSequenceSchema.refine(
      (value) => value > 0,
      "native transport event sequence must be positive",
    ),
    event: runtimeDomainEventSchema,
  })
  .strict()
  .superRefine((envelope, context) => {
    if (utf8ByteLength(JSON.stringify(envelope)) > runtimeEventUtf8ByteLimit) {
      context.addIssue({
        code: "custom",
        message: `runtime event exceeds ${runtimeEventUtf8ByteLimit} UTF-8 bytes`,
      });
    }
  });

export type RuntimeStatus = z.infer<typeof runtimeStatusSchema>;
export type RunnerConnectionStatus = z.infer<typeof runnerConnectionStatusSchema>;
export type AccountSummary = z.infer<typeof accountSummarySchema>;
export type AccountRemovalPreview = z.infer<typeof accountRemovalPreviewSchema>;
export type RetainedAccountLocalData = z.infer<typeof retainedAccountLocalDataSchema>;
export type AccountLocalDataDeletionPreview = z.infer<typeof accountLocalDataDeletionPreviewSchema>;
export type RuntimeLocalDataRemovalPreview = z.infer<
  typeof runtimeLocalDataRemovalPreviewSchema
>;
export type AccountLoginState = z.infer<typeof accountLoginStateSchema>;
export type HumanAccountSnapshot = z.infer<typeof humanAccountSnapshotSchema>;
export type SessionSyncDeviceProjection = z.infer<
  typeof sessionSyncDeviceProjectionSchema
>;
export type SessionSyncEnrollmentProjection = z.infer<
  typeof sessionSyncEnrollmentProjectionSchema
>;
export type SessionSyncStatusProjection = z.infer<
  typeof sessionSyncStatusProjectionSchema
>;
export type RemoteSessionSummaryProjection = z.infer<
  typeof remoteSessionSummaryProjectionSchema
>;
export type LocalSessionGridSlotProjection = z.infer<
  typeof localSessionGridSlotProjectionSchema
>;
export type SessionSyncSnapshot = z.infer<typeof sessionSyncSnapshotSchema>;
export type ChatModel = z.infer<typeof chatModelSchema>;
export type ChatReasoningEffort = z.infer<typeof chatReasoningEffortSchema>;
export type ChatServiceTier = z.infer<typeof chatServiceTierSchema>;
export type ChatRootTurnWorkClass = z.infer<typeof chatRootTurnWorkClassSchema>;
export type ChatRootTurnProfile = z.infer<typeof chatRootTurnProfileSchema>;
export type ChatRootTurnRoutingProfileFallbackReason = z.infer<
  typeof chatRootTurnRoutingProfileFallbackReasonSchema
>;
export type ChatRootTurnRoutingServiceTier = z.infer<
  typeof chatRootTurnRoutingServiceTierSchema
>;
export type ChatRootTurnRoutingServiceTierFallbackReason = z.infer<
  typeof chatRootTurnRoutingServiceTierFallbackReasonSchema
>;
export type ChatRootTurnRoutingClassificationReason = z.infer<
  typeof chatRootTurnRoutingClassificationReasonSchema
>;
export type ChatRootTurnRoutingProjection = z.infer<
  typeof chatRootTurnRoutingProjectionSchema
>;
export type ChatPaneActivityKind = z.infer<typeof chatPaneActivityKindSchema>;
export type ChatPaneActivity = z.infer<typeof chatPaneActivitySchema>;
export type ChatScheduleProjection = z.infer<typeof chatScheduleProjectionSchema>;
export type ChatPaneState = z.infer<typeof chatPaneStateSchema>;
export type ChatPaneInteractionMode = z.infer<typeof chatPaneInteractionModeSchema>;
export type ChatTurnStatus = z.infer<typeof chatTurnStatusSchema>;
export type ChatMessageId = z.infer<typeof chatMessageIdSchema>;
export type ChatMessageAttachmentId = z.infer<typeof chatMessageAttachmentIdSchema>;
export type ChatAttachmentUploadId = z.infer<typeof chatAttachmentUploadIdSchema>;
export type ChatAttachmentMetadata = z.infer<typeof chatAttachmentMetadataSchema>;
export type ChatAttachmentPaneProjection = z.infer<
  typeof chatAttachmentPaneProjectionSchema
>;
export type ChatMessageContent = z.infer<typeof chatMessageContentSchema>;
export type ChatQueuedMessageProjection = z.infer<
  typeof chatQueuedMessageProjectionSchema
>;
export type ChatBlockedMessageProjection = z.infer<
  typeof chatBlockedMessageProjectionSchema
>;
export type ChatMessageQueuePauseReason = z.infer<
  typeof chatMessageQueuePauseReasonSchema
>;
export type ChatMessageQueueProjection = z.infer<
  typeof chatMessageQueueProjectionSchema
>;
export type ChatToolCategory = z.infer<typeof chatToolCategorySchema>;
export type ChatToolStatus = z.infer<typeof chatToolStatusSchema>;
export type ChatAttentionCode = z.infer<typeof chatAttentionCodeSchema>;
export type ChatUtf8Tail = z.infer<typeof chatResponseMarkdownSchema>;
export type ChatToolProjection = z.infer<typeof chatToolProjectionSchema>;
export type ChatProviderSubagentProjection = z.infer<
  typeof chatProviderSubagentProjectionSchema
>;
export type ChatProviderSubagentsProjection = z.infer<
  typeof chatProviderSubagentsProjectionSchema
>;
export type ChatTurnProjection = z.infer<typeof chatTurnProjectionSchema>;
export type ChatAttention = z.infer<typeof chatAttentionSchema>;
export type ChatPaneProjection = z.infer<typeof chatPaneProjectionSchema>;
export type ChatPaneStateProjection = z.infer<typeof chatPaneStateProjectionSchema>;
export type ChatSnapshot = z.infer<typeof chatSnapshotSchema>;
export type ChatPaneHarnessProjection = z.infer<typeof chatPaneHarnessProjectionSchema>;
export type HarnessRefinementMode = z.infer<typeof harnessRefinementModeSchema>;
export type HarnessChildState = z.infer<typeof harnessChildStateSchema>;
export type HarnessSettingsProjection = z.infer<typeof harnessSettingsProjectionSchema>;
export type HarnessChildProjection = z.infer<typeof harnessChildProjectionSchema>;
export type HarnessProposalSummaryProjection = z.infer<
  typeof harnessProposalSummaryProjectionSchema
>;
export type HarnessSnapshot = z.infer<typeof harnessSnapshotSchema>;
export type RuntimeHumanOrganization = z.infer<
  typeof runtimeHumanOrganizationSchema
>;
export type RuntimeHumanWorkspace = z.infer<typeof workspaceViewSchema>;
export type ExecutionFolderAccessProjection = z.infer<
  typeof executionFolderAccessProjectionSchema
>;
export type ExecutionProjection = z.infer<typeof executionProjectionSchema>;
export type RuntimeSnapshot = z.infer<typeof runtimeSnapshotSchema>;
export type RuntimeSnapshotRequest = z.infer<typeof runtimeSnapshotRequestSchema>;
export type RuntimeSnapshotResponse = z.infer<typeof runtimeSnapshotResponseSchema>;
export type RuntimeSnapshotChunkResponse = z.infer<typeof runtimeSnapshotChunkResponseSchema>;
export type RuntimeSnapshotTransportResponse = z.infer<typeof runtimeSnapshotTransportResponseSchema>;
export type RuntimeDomainCommand = z.infer<typeof runtimeDomainCommandSchema>;
export type RuntimeChatDomainCommand = z.infer<typeof runtimeChatDomainCommandSchema>;
export type RuntimeChatAttachmentCommand = z.infer<
  typeof runtimeChatAttachmentCommandSchema
>;
export type RuntimeChatMessageLedgerCommand = z.infer<
  typeof runtimeChatMessageLedgerCommandSchema
>;
export type RuntimeChatMessageQueueResult = z.infer<
  typeof runtimeChatMessageQueueResultSchema
>;
export type RuntimeChatMessageQueueChangedEvent = z.infer<
  typeof runtimeChatMessageQueueChangedEventSchema
>;
export type RuntimeHarnessDomainCommand = z.infer<
  typeof runtimeHarnessDomainCommandSchema
>;
export type RuntimeSessionSyncDomainCommand = z.infer<
  typeof runtimeSessionSyncDomainCommandSchema
>;
export type RuntimeChatDispatchRequest = Omit<
  RuntimeDispatchRequest,
  "command"
> & {
  readonly command: RuntimeChatDomainCommand;
};
export type RuntimeHarnessDispatchRequest = Omit<
  RuntimeDispatchRequest,
  "command"
> & {
  readonly command: RuntimeHarnessDomainCommand;
};
export type RuntimeSessionSyncDispatchRequest = Omit<
  RuntimeDispatchRequest,
  "command"
> & {
  readonly command: RuntimeSessionSyncDomainCommand;
};
export type RuntimeLocalDataRemovalCommand = Extract<
  RuntimeDomainCommand,
  {
    readonly type:
      | "maintenance.localDataRemoval.preview"
      | "maintenance.localDataRemoval.remove";
  }
>;
export type RuntimeTaskDomainCommand = z.infer<typeof runtimeTaskDomainCommandSchema>;
export type RuntimeTaskMutationAttempt = z.infer<
  typeof runtimeTaskMutationAttemptSchema
>;
export type RuntimeTaskMutationReconciliation = z.infer<
  typeof runtimeTaskMutationReconciliationSchema
>;
export type RuntimeProjectAddRequest = z.infer<typeof runtimeProjectAddRequestSchema>;
export type RuntimeProjectAddResult = z.infer<typeof runtimeProjectAddResultSchema>;
export type RuntimeFolderAccessSelectRequest = z.infer<
  typeof runtimeFolderAccessSelectRequestSchema
>;
export type RuntimeFolderAccessSelectResult = z.infer<
  typeof runtimeFolderAccessSelectResultSchema
>;
export type RuntimeDispatchRequest = z.infer<typeof runtimeDispatchRequestSchema>;
export type RuntimeTaskDispatchRequest = z.infer<typeof runtimeTaskDispatchRequestSchema>;
export type RuntimeDispatchContinuationRequest = z.infer<
  typeof runtimeDispatchContinuationRequestSchema
>;
export type RuntimeDispatchTransportRequest = z.infer<
  typeof runtimeDispatchTransportRequestSchema
>;
export type RuntimeDispatchResponse = z.infer<typeof runtimeDispatchResponseSchema>;
export type RuntimeTaskDispatchResponse = z.infer<typeof runtimeTaskDispatchResponseSchema>;
export type RuntimeDispatchChunkResponse = z.infer<typeof runtimeDispatchChunkResponseSchema>;
export type RuntimeDispatchTransportResponse = z.infer<
  typeof runtimeDispatchTransportResponseSchema
>;
export type RuntimeError = z.infer<typeof runtimeErrorSchema>;
export type RuntimeEvent = z.infer<typeof runtimeEventSchema>;
export type NativeTransportSequence = RuntimeEvent["sequence"];
export type RuntimeTransportLifecycle = z.infer<
  typeof runtimeTransportLifecycleSchema
>;
export type RuntimeTransportRetryResponse = z.infer<
  typeof runtimeTransportRetryResponseSchema
>;
export type WorkspaceDatabaseSequence = Extract<
  OperationReceipt,
  { outcome: "committed" }
>["eventSequence"];
export type RuntimeTaskWorkspaceSummaries = readonly WorkspaceSummary[];
export type RuntimeTaskRepositorySummary = z.infer<
  typeof runtimeTaskRepositorySummarySchema
>;
export type RuntimeTaskRepositoryList = z.infer<typeof runtimeTaskRepositoryListSchema>;
export type RuntimeTaskWorkspaceContext = Extract<
  Extract<RuntimeTaskDispatchResponse, { readonly ok: true }>['result'],
  { readonly type: "taskWorkspaceContext" }
>["context"];
export type RuntimeTaskLookup = Extract<
  Extract<RuntimeTaskDispatchResponse, { readonly ok: true }>['result'],
  { readonly type: "taskLookup" }
>["task"];
export type RuntimeTaskListPage = TaskListPage;
export type RuntimeTaskDetail = TaskDetailProjection;
export type RuntimeTaskMutationResult = TaskWorkspaceMutationResult;
export type RuntimeTaskInvalidation = PortableInvalidation;
export type RuntimeLocalPromotionProgress = z.infer<
  typeof runtimeLocalPromotionProgressSchema
>;
export type RuntimeLocalPromotionRecoveryCopy = z.infer<
  typeof runtimeLocalPromotionRecoveryCopySchema
>;
export type RuntimeLocalDataRemovalDispatchRequest = Omit<
  RuntimeDispatchRequest,
  "command"
> & {
  readonly command: RuntimeLocalDataRemovalCommand;
};

export function parseRuntimeSnapshotRequest(value: unknown): RuntimeSnapshotRequest {
  return runtimeSnapshotRequestSchema.parse(value);
}

export function parseRuntimeSnapshotResponse(value: unknown): RuntimeSnapshotResponse {
  return runtimeSnapshotResponseSchema.parse(value);
}

export function parseRuntimeSnapshotTransportResponse(
  value: unknown,
): RuntimeSnapshotTransportResponse {
  return runtimeSnapshotTransportResponseSchema.parse(value);
}

export function parseRuntimeDispatchRequest(value: unknown): RuntimeDispatchRequest {
  return runtimeDispatchRequestSchema.parse(value);
}

export function parseRuntimeTaskDispatchRequest(value: unknown): RuntimeTaskDispatchRequest {
  return runtimeTaskDispatchRequestSchema.parse(value);
}

export function parseRuntimeDispatchTransportRequest(
  value: unknown,
): RuntimeDispatchTransportRequest {
  return runtimeDispatchTransportRequestSchema.parse(value);
}

export function parseRuntimeProjectAddRequest(value: unknown): RuntimeProjectAddRequest {
  return runtimeProjectAddRequestSchema.parse(value);
}

export function parseRuntimeFolderAccessSelectRequest(
  value: unknown,
): RuntimeFolderAccessSelectRequest {
  return runtimeFolderAccessSelectRequestSchema.parse(value);
}

export function parseRuntimeFolderAccessSelectResult(
  value: unknown,
): RuntimeFolderAccessSelectResult {
  return runtimeFolderAccessSelectResultSchema.parse(value);
}

export function parseRuntimeProjectAddResult(value: unknown): RuntimeProjectAddResult {
  const direct = runtimeProjectAddResultSchema.safeParse(value);
  if (direct.success) return direct.data;
  const outcome = runtimeProjectOnboardingOutcomeSchema.parse(value);
  return outcome.ok
    ? {
      version: runtimeProtocolVersion,
      status: "created",
      repository: outcome.value.repository,
      workspace: outcome.value.workspace,
    }
    : {
      version: runtimeProtocolVersion,
      status: "failed",
      error: outcome.error,
    };
}

export function parseRuntimeDispatchResponse(value: unknown): RuntimeDispatchResponse {
  return runtimeDispatchResponseSchema.parse(value);
}

function chatResponseMismatch(subject: string): never {
  throw new Error(`Chat ${subject} response does not match its request.`);
}

/**
 * Correlate a renderer-safe chat result with the exact command that requested
 * it. A structurally valid response for another pane, revision, or turn is not
 * authority to mutate renderer state.
 */
export function parseRuntimeChatDispatchResponseForRequest(
  value: unknown,
  request: RuntimeChatDispatchRequest,
): RuntimeDispatchResponse {
  const response = parseRuntimeDispatchResponse(value);
  if (response.operationId !== request.operationId) {
    throw new Error(
      `Expected native operation ${request.operationId}, received ${response.operationId}.`,
    );
  }
  if (!response.ok) return response;

  switch (request.command.type) {
    case "chat.pane.create": {
      if (response.result.type === "chatPaneReplay") {
        if (
          response.result.paneId !== request.command.paneId ||
          response.result.commandType !== request.command.type ||
          response.result.appliedRevision !== 1
        ) {
          chatResponseMismatch("pane creation replay");
        }
        return response;
      }
      if (response.result.type !== "chatPane") chatResponseMismatch("pane creation");
      const { pane, appliedRevision } = response.result;
      if (
        pane.id !== request.command.paneId ||
        appliedRevision !== 1 ||
        pane.revision !== 1 ||
        pane.repository.id !== request.command.repositoryId ||
        pane.turn !== null
      ) {
        chatResponseMismatch("pane creation");
      }
      return response;
    }
    case "chat.pane.rename": {
      if (response.result.type === "chatPaneReplay") {
        if (
          response.result.paneId !== request.command.paneId ||
          response.result.commandType !== request.command.type ||
          response.result.appliedRevision !== request.command.expectedRevision + 1
        ) {
          chatResponseMismatch("pane rename replay");
        }
        return response;
      }
      if (response.result.type !== "chatPane") chatResponseMismatch("pane rename");
      const { pane, appliedRevision } = response.result;
      const expectedAppliedRevision = request.command.expectedRevision + 1;
      if (
        pane.id !== request.command.paneId ||
        appliedRevision !== expectedAppliedRevision ||
        pane.revision !== expectedAppliedRevision ||
        pane.title !== request.command.title
      ) {
        chatResponseMismatch("pane rename");
      }
      return response;
    }
    case "chat.pane.schedule.configure": {
      if (response.result.type === "chatPaneReplay") {
        if (
          response.result.paneId !== request.command.paneId ||
          response.result.commandType !== request.command.type ||
          response.result.appliedRevision !== request.command.expectedRevision + 1
        ) {
          chatResponseMismatch("schedule configuration replay");
        }
        return response;
      }
      if (response.result.type !== "chatPane") {
        chatResponseMismatch("schedule configuration");
      }
      const { pane, appliedRevision } = response.result;
      const expectedAppliedRevision = request.command.expectedRevision + 1;
      if (
        pane.id !== request.command.paneId ||
        appliedRevision !== expectedAppliedRevision ||
        pane.revision !== expectedAppliedRevision ||
        pane.schedule === null ||
        pane.interactionMode !== "chat"
      ) {
        chatResponseMismatch("schedule configuration");
      }
      return response;
    }
    case "chat.pane.schedule.remove": {
      if (response.result.type === "chatPaneReplay") {
        if (
          response.result.paneId !== request.command.paneId ||
          response.result.commandType !== request.command.type ||
          response.result.appliedRevision !== request.command.expectedRevision + 1
        ) {
          chatResponseMismatch("schedule removal replay");
        }
        return response;
      }
      if (response.result.type !== "chatPane") chatResponseMismatch("schedule removal");
      const { pane, appliedRevision } = response.result;
      const expectedAppliedRevision = request.command.expectedRevision + 1;
      if (
        pane.id !== request.command.paneId ||
        appliedRevision !== expectedAppliedRevision ||
        pane.revision !== expectedAppliedRevision ||
        pane.schedule !== null ||
        pane.interactionMode !== "chat"
      ) {
        chatResponseMismatch("schedule removal");
      }
      return response;
    }
    case "chat.pane.workspace.recover": {
      if (response.result.type === "chatPaneReplay") {
        if (
          response.result.paneId !== request.command.paneId ||
          response.result.commandType !== request.command.type ||
          response.result.appliedRevision !== request.command.expectedRevision + 1
        ) {
          chatResponseMismatch("workspace recovery replay");
        }
        return response;
      }
      if (response.result.type !== "chatPane") chatResponseMismatch("workspace recovery");
      const { pane, appliedRevision } = response.result;
      const expectedAppliedRevision = request.command.expectedRevision + 1;
      if (
        pane.id !== request.command.paneId ||
        appliedRevision !== expectedAppliedRevision ||
        pane.revision !== expectedAppliedRevision
      ) {
        chatResponseMismatch("workspace recovery");
      }
      return response;
    }
    case "chat.pane.repository.select": {
      if (response.result.type === "chatPaneReplay") {
        if (
          response.result.paneId !== request.command.paneId ||
          response.result.commandType !== request.command.type ||
          response.result.appliedRevision !== request.command.expectedRevision + 1
        ) {
          chatResponseMismatch("repository selection replay");
        }
        return response;
      }
      if (response.result.type !== "chatPane") {
        chatResponseMismatch("repository selection");
      }
      const { pane, appliedRevision } = response.result;
      const expectedAppliedRevision = request.command.expectedRevision + 1;
      if (
        pane.id !== request.command.paneId ||
        appliedRevision !== expectedAppliedRevision ||
        pane.revision !== expectedAppliedRevision ||
        pane.repository.id !== request.command.repositoryId ||
        pane.turn !== null
      ) {
        chatResponseMismatch("repository selection");
      }
      return response;
    }
    case "chat.pane.remove":
      if (
        response.result.type !== "chatPaneRemoved" ||
        response.result.paneId !== request.command.paneId
      ) {
        chatResponseMismatch("pane removal");
      }
      return response;
    case "chat.panes.reorder":
      if (response.result.type !== "accepted") {
        chatResponseMismatch("pane reorder");
      }
      return response;
    case "chat.turn.stop": {
      if (response.result.type === "chatPaneReplay") {
        if (
          response.result.paneId !== request.command.paneId ||
          response.result.commandType !== request.command.type ||
          response.result.appliedRevision <= request.command.expectedRevision
        ) {
          chatResponseMismatch("turn stop replay");
        }
        return response;
      }
      if (response.result.type !== "chatPane") chatResponseMismatch("turn stop");
      const { pane, appliedRevision } = response.result;
      const reusableTerminal =
        (pane.state === "ready" && pane.turn?.status === "completed" &&
          pane.attention === null) ||
        (pane.state === "attention" && pane.turn?.status === "failed" &&
          pane.attention?.retryable === true);
      if (
        pane.id !== request.command.paneId ||
        appliedRevision <= request.command.expectedRevision ||
        pane.revision !== appliedRevision ||
        pane.interactionMode !== "chat" ||
        pane.turn?.id !== request.command.turnId ||
        !reusableTerminal
      ) {
        chatResponseMismatch("turn stop");
      }
      return response;
    }
    case "chat.message.enqueue":
    case "chat.message.edit":
    case "chat.message.remove":
    case "chat.messageQueue.resume":
    case "chat.pane.startFreshContext":
    case "chat.message.discardAmbiguous":
    case "chat.message.steerHead": {
      const commandMessageId = "messageId" in request.command
        ? request.command.messageId
        : null;
      const replayed = response.result.type === "chatMessageQueue" &&
        response.result.disposition !== "applied";
      if (
        response.result.type !== "chatMessageQueue" ||
        response.result.paneId !== request.command.paneId ||
        response.result.messageId !== commandMessageId ||
        (replayed
          ? request.command.type !== "chat.message.enqueue" ||
            response.result.queue.revision < request.command.expectedQueueRevision
          : response.result.disposition !== "applied" ||
            response.result.queue.revision <= request.command.expectedQueueRevision)
      ) {
        chatResponseMismatch("message queue mutation");
      }
      return response;
    }
    case "chat.attachment.begin":
    case "chat.attachment.append":
    case "chat.attachment.finalize": {
      if (
        response.result.type !== "chatAttachment" ||
        response.result.paneId !== request.command.paneId ||
        response.result.attachment.id !== request.command.attachmentId ||
        response.result.uploadId !== request.command.uploadId
      ) {
        chatResponseMismatch("attachment mutation");
      }
      const expectedRevision = "expectedRevision" in request.command
        ? request.command.expectedRevision
        : 1;
      const minimumRevision = request.command.type === "chat.attachment.append"
        ? expectedRevision + 2
        : expectedRevision + 1;
      if (
        response.result.attachment.revision < minimumRevision ||
        (request.command.type === "chat.attachment.append" &&
          response.result.changed &&
          response.result.attachment.revision !== minimumRevision)
      ) {
        chatResponseMismatch("attachment revision");
      }
      return response;
    }
    case "chat.attachment.cancel":
    case "chat.attachment.remove": {
      if (
        response.result.type !== "chatAttachmentRemoved" ||
        response.result.paneId !== request.command.paneId ||
        response.result.attachmentId !== request.command.attachmentId
      ) {
        chatResponseMismatch("attachment removal");
      }
      return response;
    }
    case "chat.attachment.preview": {
      if (
        response.result.type !== "chatAttachmentPreview" ||
        response.result.paneId !== request.command.paneId ||
        response.result.attachmentId !== request.command.attachmentId ||
        response.result.revision !== request.command.expectedRevision
      ) {
        chatResponseMismatch("attachment preview");
      }
      return response;
    }
  }
}

function harnessResponseMismatch(subject: string): never {
  throw new Error(`Harness ${subject} response does not match its request.`);
}

/** Correlate every sparse harness response to its exact fenced user action. */
export function parseRuntimeHarnessDispatchResponseForRequest(
  value: unknown,
  request: RuntimeHarnessDispatchRequest,
): RuntimeDispatchResponse {
  const response = parseRuntimeDispatchResponse(value);
  if (response.operationId !== request.operationId) {
    throw new Error(
      `Expected native operation ${request.operationId}, received ${response.operationId}.`,
    );
  }
  if (!response.ok) return response;

  switch (request.command.type) {
    case "harness.settings.update": {
      if (response.result.type !== "harnessSettings") {
        harnessResponseMismatch("settings update");
      }
      const { settings } = response.result;
      if (
        response.result.harnessRevision !== request.command.expectedHarnessRevision + 1 ||
        settings.revision !== request.command.expectedRevision + 1 ||
        settings.recursiveSessionsEnabled !== request.command.recursiveSessionsEnabled ||
        settings.contextQuotaBytes !== request.command.contextQuotaBytes ||
        settings.refinementMode !== request.command.refinementMode
      ) {
        harnessResponseMismatch("settings update");
      }
      return response;
    }
    case "harness.child.open": {
      if (response.result.type !== "harnessChildOpened") {
        harnessResponseMismatch("child open");
      }
      if (
        response.result.parentPaneId !== request.command.parentPaneId ||
        response.result.parentRevision !== request.command.expectedParentRevision + 1 ||
        response.result.child.id !== request.command.childId ||
        response.result.child.revision !== request.command.expectedChildRevision + 1 ||
        response.result.child.openedPaneId !== response.result.pane.id
      ) {
        harnessResponseMismatch("child open");
      }
      return response;
    }
    case "harness.child.stop": {
      if (response.result.type !== "harnessChild") {
        harnessResponseMismatch("child stop");
      }
      if (
        response.result.parentPaneId !== request.command.parentPaneId ||
        response.result.parentRevision !== request.command.expectedParentRevision + 1 ||
        response.result.child.id !== request.command.childId ||
        response.result.child.revision !== request.command.expectedChildRevision + 1 ||
        response.result.child.state !== "stopped" ||
        response.result.child.canStop
      ) {
        harnessResponseMismatch("child stop");
      }
      return response;
    }
  }
}

export function parseRuntimeLocalDataRemovalResponseForRequest(
  value: unknown,
  request: RuntimeLocalDataRemovalDispatchRequest,
): RuntimeDispatchResponse {
  const response = parseRuntimeDispatchResponse(value);
  if (response.operationId !== request.operationId) {
    throw new Error(
      `Expected native operation ${request.operationId}, received ${response.operationId}.`,
    );
  }
  if (!response.ok) return response;

  switch (request.command.type) {
    case "maintenance.localDataRemoval.preview":
      if (response.result.type !== "localDataRemovalPreview") {
        throw new Error("Local-data removal preview returned the wrong result kind.");
      }
      return response;
    case "maintenance.localDataRemoval.remove":
      if (
        response.result.type !== "localDataRemovalScheduled" ||
        response.result.previewId !== request.command.previewId
      ) {
        throw new Error(
          "Local-data removal scheduling response does not match its confirmed preview.",
        );
      }
      return response;
  }
}

export function parseRuntimeTaskDispatchResponse(value: unknown): RuntimeTaskDispatchResponse {
  return runtimeTaskDispatchResponseSchema.parse(value);
}

export function parseRuntimeDispatchTransportResponse(
  value: unknown,
): RuntimeDispatchTransportResponse {
  return runtimeDispatchTransportResponseSchema.parse(value);
}

function mutationResultTargetMismatch(subject: string): never {
  throw new Error(
    `Task mutation result ${subject} does not match its durable intent.`,
  );
}

function unreachableTaskWorkspaceMutationIntent(intent: never): never {
  throw new Error(`Unhandled task mutation intent: ${JSON.stringify(intent)}`);
}

function assertMutationResultTargets(
  mutation: TaskWorkspaceMutationResult,
  intent: TaskWorkspaceMutationIntent,
): void {
  const { result } = mutation;
  switch (intent.kind) {
    case "workspace.rename":
      if (result.kind !== "workspace") {
        mutationResultTargetMismatch("result");
      }
      return;
    case "task.create":
    case "task.create_and_run":
      if (
        result.kind !== "task_created" ||
        result.taskId !== intent.taskId
      ) {
        mutationResultTargetMismatch("task target");
      }
      return;
    case "task.update":
    case "task.cancel":
    case "task.reopen":
    case "task.assign":
    case "task.defer":
    case "task.parent_set":
    case "task.parent_clear":
    case "task.label_add":
    case "task.label_remove":
    case "dependency.add":
    case "dependency.remove":
      if (
        result.kind !== "task_updated" ||
        result.taskId !== intent.taskId
      ) {
        mutationResultTargetMismatch("task target");
      }
      return;
    case "task.comment_add":
      if (
        result.kind !== "comment_added" ||
        result.taskId !== intent.taskId
      ) {
        mutationResultTargetMismatch("task target");
      }
      return;
    case "task.reference_add":
      if (
        result.kind !== "reference_added" ||
        result.taskId !== intent.taskId
      ) {
        mutationResultTargetMismatch("task target");
      }
      return;
    case "task.reference_remove":
      if (
        result.kind !== "reference_removed" ||
        result.taskId !== intent.taskId ||
        result.referenceId !== intent.referenceId
      ) {
        mutationResultTargetMismatch("task or reference target");
      }
      return;
    case "task.submit":
      if (
        result.kind !== "submission_updated" ||
        result.taskId !== intent.taskId
      ) {
        mutationResultTargetMismatch("task target");
      }
      return;
    case "review.accept":
    case "review.reject":
      if (
        result.kind !== "submission_updated" ||
        result.taskId !== intent.taskId ||
        result.submissionId !== intent.submissionId
      ) {
        mutationResultTargetMismatch("task or submission target");
      }
      return;
    case "dispatch.stop":
      if (
        result.kind !== "run_updated" ||
        result.runId !== intent.runId
      ) {
        mutationResultTargetMismatch("run target");
      }
      return;
    case "dispatch.retry":
      if (
        result.kind !== "run_updated" ||
        result.runId === intent.sourceRunId
      ) {
        mutationResultTargetMismatch("new retry run");
      }
      return;
    case "dispatch.resolve_ambiguity": {
      const expectedPhase = intent.reason === "confirmed_cancelled"
        ? "cancelled"
        : "failed";
      if (
        result.kind !== "run_updated" ||
        result.runId !== intent.sourceRunId ||
        result.phase !== expectedPhase
      ) {
        mutationResultTargetMismatch("run target or ambiguity outcome");
      }
      return;
    }
    case "interaction.respond":
      if (
        result.kind !== "interaction_updated" ||
        result.runId !== intent.runId ||
        result.interactionId !== intent.interactionId
      ) {
        mutationResultTargetMismatch("run or interaction target");
      }
      return;
    case "interaction.settle": {
      const expectedState = intent.settlement.outcome === "applied"
        ? "resolved"
        : "expired";
      if (
        result.kind !== "interaction_updated" ||
        result.runId !== intent.runId ||
        result.interactionId !== intent.settlement.interactionId ||
        result.state !== expectedState
      ) {
        mutationResultTargetMismatch("run, interaction, or settlement outcome");
      }
      return;
    }
    default:
      return unreachableTaskWorkspaceMutationIntent(intent);
  }
}

/**
 * Correlates the native operation and the scoped task result. This is kept
 * beside the wire schemas so every renderer adapter rejects a valid response
 * for the wrong command, workspace, view, task, or durable operation.
 */
export function parseRuntimeTaskDispatchResponseForRequest(
  value: unknown,
  request: RuntimeTaskDispatchRequest,
): RuntimeTaskDispatchResponse {
  const response = parseRuntimeTaskDispatchResponse(value);
  if (response.operationId !== request.operationId) {
    throw new Error(
      `Expected native operation ${request.operationId}, received ${response.operationId}.`,
    );
  }
  if (!response.ok) return response;

  switch (request.command.type) {
    case "task.workspaces.list":
      if (response.result.type !== "taskWorkspaceSummaries") {
        throw new Error("Task workspace list command returned the wrong result kind.");
      }
      return response;
    case "task.repositories.list":
      if (
        response.result.type !== "taskRepositoryList" ||
        response.result.page.workspaceId !== request.command.workspaceId
      ) {
        throw new Error("Task repository list response does not match its workspace.");
      }
      return response;
    case "task.workspace.context":
      if (
        response.result.type !== "taskWorkspaceContext" ||
        response.result.context.workspaceId !== request.command.workspaceId
      ) {
        throw new Error("Task workspace context response does not match its workspace.");
      }
      return response;
    case "task.lookup":
      if (
        response.result.type !== "taskLookup" ||
        response.result.workspaceId !== request.command.workspaceId ||
        response.result.taskKey !== request.command.taskKey ||
        (response.result.task !== null && response.result.task.key !== request.command.taskKey)
      ) {
        throw new Error("Task lookup response does not match its requested task key.");
      }
      return response;
    case "task.workspace.projection": {
      if (
        response.result.type !== "taskWorkspaceProjection" ||
        response.result.consistency !== "atomic"
      ) {
        throw new Error(
          "Task workspace projection command returned the wrong result kind.",
        );
      }
      const { presentation, projection } = response.result;
      if (
        presentation.workspace.id !== request.command.workspaceId ||
        projection.workspaceId !== request.command.workspaceId ||
        projection.view !== request.command.view ||
        projection.assignedAgentId !== request.command.assignedAgentId ||
        projection.selectedTaskId !== request.command.selectedTaskId ||
        projection.firstPage.items.length > request.command.limit ||
        (
          request.command.minimumRevision !== null &&
          projection.projectionRevision < request.command.minimumRevision
        )
      ) {
        throw new Error(
          "Task workspace projection response does not match its atomic request scope.",
        );
      }
      return response;
    }
    case "task.list": {
      if (response.result.type !== "taskListPage") {
        throw new Error("Task list command returned the wrong result kind.");
      }
      const { page } = response.result;
      if (
        page.workspaceId !== request.command.workspaceId ||
        page.view !== request.command.view ||
        page.assignedAgentId !== request.command.assignedAgentId ||
        (
          request.command.continuationRevision !== undefined &&
          page.projectionRevision !== request.command.continuationRevision
        )
      ) {
        throw new Error("Task list response does not match its immutable request scope.");
      }
      return response;
    }
    case "task.detail":
      if (
        response.result.type !== "taskDetail" ||
        response.result.detail.workspaceId !== request.command.workspaceId ||
        response.result.detail.task.id !== request.command.taskId
      ) {
        throw new Error("Task detail response does not match its requested workspace and task.");
      }
      return response;
    case "task.mutation.attempt.prepare":
      if (
        response.result.type !== "taskMutationAttempt" ||
        response.result.attempt.workspaceId !== request.command.workspaceId ||
        response.result.attempt.commandKind !== request.command.commandKind ||
        (
          response.result.attempt.attemptId !== request.command.attemptId &&
          response.result.attempt.state === "settled"
        )
      ) {
        throw new Error("Prepared task mutation attempt does not match its request.");
      }
      return response;
    case "task.mutation.attempt.start":
      if (
        response.result.type !== "taskMutationAttempt" ||
        response.result.attempt.workspaceId !== request.command.workspaceId ||
        response.result.attempt.attemptId !== request.command.attemptId ||
        response.result.attempt.commandKind !== request.command.intent.kind ||
        response.result.attempt.state !== "effect_started"
      ) {
        throw new Error("Started task mutation attempt does not match its request.");
      }
      return response;
    case "task.mutation.attempt.list": {
      const workspaceId = request.command.workspaceId;
      if (
        response.result.type !== "taskMutationAttemptList" ||
        response.result.workspaceId !== workspaceId ||
        response.result.attempts.length > request.command.limit ||
        response.result.attempts.some(
          (attempt) =>
            attempt.workspaceId !== workspaceId ||
            attempt.state === "settled",
        )
      ) {
        throw new Error("Task mutation attempt list does not match its workspace.");
      }
      return response;
    }
    case "task.mutation.attempt.inspect": {
      if (
        response.result.type !== "taskMutationAttemptInspection" ||
        response.result.inspection.workspaceId !== request.command.workspaceId ||
        response.result.inspection.attemptId !== request.command.attemptId
      ) {
        throw new Error("Task mutation inspection does not match its attempt.");
      }
      const { inspection } = response.result;
      if (
        inspection.resolution.outcome === "committed" &&
        (
          inspection.resolution.mutation.workspaceId !== inspection.workspaceId ||
          inspection.resolution.mutation.operationId !== inspection.attemptId ||
          inspection.resolution.mutation.commandKind !== inspection.commandKind
        )
      ) {
        throw new Error("Task mutation inspection returned a mismatched receipt.");
      }
      return response;
    }
    case "task.mutation.attempt.reconcile": {
      if (
        response.result.type !== "taskMutationReconciliation" ||
        response.result.reconciliation.workspaceId !== request.command.workspaceId ||
        response.result.reconciliation.attemptId !== request.command.attemptId
      ) {
        throw new Error("Task mutation reconciliation does not match its attempt.");
      }
      const { reconciliation } = response.result;
      if (
        reconciliation.resolution.outcome === "committed" &&
        (
          reconciliation.resolution.mutation.workspaceId !==
            reconciliation.workspaceId ||
          reconciliation.resolution.mutation.operationId !==
            reconciliation.attemptId ||
          reconciliation.resolution.mutation.commandKind !==
            reconciliation.commandKind
        )
      ) {
        throw new Error("Task mutation reconciliation returned a mismatched receipt.");
      }
      return response;
    }
    case "task.mutate": {
      if (response.result.type !== "taskMutation") {
        throw new Error("Task mutation command returned the wrong result kind.");
      }
      const { mutation } = response.result;
      if (
        mutation.operationId !== request.command.intent.operationId ||
        mutation.workspaceId !== request.command.workspaceId ||
        mutation.commandKind !== request.command.intent.kind
      ) {
        throw new Error("Task mutation result does not match its durable intent.");
      }
      assertMutationResultTargets(mutation, request.command.intent);
      return response;
    }
    case "task.promotion.start":
      if (
        response.result.type !== "taskPromotionProgress" ||
        response.result.progress === null ||
        response.result.progress.sourceWorkspaceId !==
          request.command.workspaceId
      ) {
        throw new Error("Promotion start response does not match its workspace.");
      }
      return response;
    case "task.promotion.status":
      if (
        response.result.type !== "taskPromotionProgress" ||
        (
          response.result.progress !== null &&
          response.result.progress.sourceWorkspaceId !==
            request.command.workspaceId &&
          response.result.progress.destinationWorkspaceId !==
            request.command.workspaceId
        )
      ) {
        throw new Error("Promotion status response does not match its workspace.");
      }
      return response;
    case "task.promotion.abort":
      if (
        response.result.type !== "taskPromotionProgress" ||
        response.result.progress === null ||
        response.result.progress.sourceWorkspaceId !==
          request.command.workspaceId ||
        response.result.progress.promotionId !== request.command.promotionId
      ) {
        throw new Error("Promotion abort response does not match its operation.");
      }
      return response;
    case "task.promotion.recovery.open":
      if (
        response.result.type !== "taskPromotionRecovery" ||
        (
          response.result.recovery !== null &&
          (
            response.result.recovery.localWorkspaceId !==
              request.command.workspaceId ||
            response.result.recovery.promotionId !== request.command.promotionId
          )
        )
      ) {
        throw new Error("Promotion recovery response does not match its copy.");
      }
      return response;
  }
}

export function parseRuntimeEvent(value: unknown): RuntimeEvent {
  return runtimeEventSchema.parse(value);
}

export function parseRuntimeTransportLifecycle(
  value: unknown,
): RuntimeTransportLifecycle {
  return runtimeTransportLifecycleSchema.parse(value);
}

export function parseRuntimeTransportRetryResponse(
  value: unknown,
): RuntimeTransportRetryResponse {
  return runtimeTransportRetryResponseSchema.parse(value);
}
