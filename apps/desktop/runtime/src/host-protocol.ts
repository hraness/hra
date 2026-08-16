import { z } from "@hra-internal/schema";
import { taskDomain } from "@hraness/agent-tasks-protocol";
import {
  localDataRemovalPreviewIdSchema,
  operationIdSchema,
  parseRuntimeDispatchTransportRequest,
  runtimeDispatchCommand,
  runtimeDispatchResponseSchema,
  runtimeProtocolVersion,
  runtimeSnapshotCommand,
  type RuntimeDispatchResponse,
  type RuntimeDispatchTransportRequest,
} from "../../contracts/runtime";
import {
  nativeAccountProfileResultSchema,
  type NativeAccountProfileResult,
} from "./accounts/local-data-remover";
import {
  nativeHarnessCustodyResultSchema,
  type NativeHarnessCustodyResult,
} from "./harness/native-key-custody";

export const hostProjectOnboardingCommand =
  "hra.runtime.onboardProject" as const;
export const hostLocalDataRemovalRecoveryCommand =
  "hra.runtime.recoverLocalDataRemoval" as const;
export const hostAccountProfileNativeResultCommand =
  "hra.runtime.accountProfileNativeResult" as const;
export const hostHarnessCustodyNativeResultCommand =
  "hra.runtime.harnessCustodyNativeResult" as const;

const hostRequestIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._:-]+$/u);
const nativeRemovalCapabilitySchema = z.string().regex(/^[a-f0-9]{64}$/u);

export const hostRequestSchema = z
  .object({
    id: hostRequestIdSchema,
    command: z.enum([
      runtimeSnapshotCommand,
      runtimeDispatchCommand,
      hostProjectOnboardingCommand,
      hostLocalDataRemovalRecoveryCommand,
      hostAccountProfileNativeResultCommand,
      hostHarnessCustodyNativeResultCommand,
    ]),
    payload: z.unknown(),
    nativeRemovalCapability: nativeRemovalCapabilitySchema.optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if (
      request.nativeRemovalCapability !== undefined
      && request.command !== runtimeDispatchCommand
      && request.command !== hostLocalDataRemovalRecoveryCommand
    ) {
      context.addIssue({
        code: "custom",
        message: "Native removal capability is not valid for this command",
        path: ["nativeRemovalCapability"],
      });
    }
    if (
      request.command === hostLocalDataRemovalRecoveryCommand
      && request.nativeRemovalCapability === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "Native recovery requires its one-shot removal capability",
        path: ["nativeRemovalCapability"],
      });
    }
  });

const hostProjectOnboardingPayloadSchema = z.object({
  version: z.literal(runtimeProtocolVersion),
  trustedDirectoryPath: z.string().min(1).max(4_096),
  repositoryName: taskDomain.repositoryNameSchema.optional(),
  workspaceName: taskDomain.workspaceNameSchema.optional(),
  provider: taskDomain.repositoryProviderSchema.optional(),
  publicUrl: taskDomain.absoluteHttpsUrlSchema.optional(),
}).strict();

const hostLocalDataRemovalRecoveryPayloadSchema = z
  .object({
    version: z.literal(1),
    nativeRecoveryPrepared: z.literal(true),
  })
  .strict();

const hostLocalDataRemovalPublicResponseSchema = runtimeDispatchResponseSchema
  .superRefine((response, context) => {
    if (
      !response.ok ||
      response.result.type !== "localDataRemovalScheduled"
    ) {
      context.addIssue({
        code: "custom",
        message: "private launch requires a scheduled public response",
      });
    }
  });

export const hostLocalDataRemovalNativeLaunchSchema = z
  .object({
    kind: z.literal("localDataRemovalNativeLaunch"),
    version: z.literal(1),
    operationId: operationIdSchema,
    previewId: localDataRemovalPreviewIdSchema,
    parentProcessId: z.number().int().safe().min(2),
    requestPath: z.string().min(2).max(4_096),
    signingKeyPath: z.string().min(2).max(4_096),
    publicResponse: hostLocalDataRemovalPublicResponseSchema,
  })
  .strict()
  .superRefine((launch, context) => {
    if (
      launch.publicResponse.operationId !== launch.operationId ||
      !launch.publicResponse.ok ||
      launch.publicResponse.result.type !== "localDataRemovalScheduled" ||
      launch.publicResponse.result.previewId !== launch.previewId
    ) {
      context.addIssue({
        code: "custom",
        message: "private launch correlation does not match its public response",
      });
    }
  });

export const hostLocalDataRemovalRecoveryResultSchema = z
  .object({
    kind: z.literal("localDataRemovalRecoveryResult"),
    version: z.literal(1),
    state: z.enum(["clear", "active"]),
    recoveredOperationCount: z.number().int().safe().nonnegative(),
  })
  .strict();

const hostLocalDataRemovalTerminationPublicResponseSchema =
  runtimeDispatchResponseSchema.superRefine((response, context) => {
    if (response.ok) {
      context.addIssue({
        code: "custom",
        message: "termination-required requires a public failure response",
      });
    }
  });

export const hostLocalDataRemovalNativeTerminationRequiredSchema = z
  .object({
    kind: z.literal("localDataRemovalNativeTerminationRequired"),
    version: z.literal(1),
    publicResponse: hostLocalDataRemovalTerminationPublicResponseSchema,
  })
  .strict();

export type HostRequest = z.infer<typeof hostRequestSchema>;
export type HostProjectOnboardingPayload = z.infer<
  typeof hostProjectOnboardingPayloadSchema
>;
export type HostLocalDataRemovalNativeLaunch = z.infer<
  typeof hostLocalDataRemovalNativeLaunchSchema
>;
export type HostLocalDataRemovalRecoveryResult = z.infer<
  typeof hostLocalDataRemovalRecoveryResultSchema
>;
export type HostLocalDataRemovalNativeTerminationRequired = z.infer<
  typeof hostLocalDataRemovalNativeTerminationRequiredSchema
>;

export type HostResponse =
  | Readonly<{ id: string; ok: true; result: unknown }>
  | Readonly<{
      id: string;
      ok: false;
      error: Readonly<{ code: "invalid_request" | "internal_error"; message: string }>;
    }>;

export function parseHostRequest(value: unknown): HostRequest {
  return hostRequestSchema.parse(value);
}

export function parseHostNativeRemovalCapability(
  request: HostRequest,
): string {
  return nativeRemovalCapabilitySchema.parse(
    request.nativeRemovalCapability,
  );
}

/**
 * The host identifies the Native capability; the gateway contract parser then
 * separates account commands, scoped task commands, and immutable response
 * continuations before any stateful handler is selected.
 */
export function parseHostDispatchPayload(
  request: HostRequest,
): RuntimeDispatchTransportRequest {
  if (request.command !== runtimeDispatchCommand) {
    throw new TypeError("Host request is not a runtime dispatch command");
  }
  return parseRuntimeDispatchTransportRequest(request.payload);
}

/**
 * This path-bearing capability is private to the Native host. It is
 * deliberately absent from renderer contracts and Native bridge policies;
 * Phase 4's trusted chooser invokes it from native code after user selection.
 */
export function parseHostProjectOnboardingPayload(
  request: HostRequest,
): HostProjectOnboardingPayload {
  if (request.command !== hostProjectOnboardingCommand) {
    throw new TypeError("Host request is not a project onboarding command");
  }
  return hostProjectOnboardingPayloadSchema.parse(request.payload);
}

export function parseHostLocalDataRemovalRecoveryPayload(
  request: HostRequest,
): z.infer<typeof hostLocalDataRemovalRecoveryPayloadSchema> {
  if (request.command !== hostLocalDataRemovalRecoveryCommand) {
    throw new TypeError(
      "Host request is not a local-data removal recovery command",
    );
  }
  return hostLocalDataRemovalRecoveryPayloadSchema.parse(request.payload);
}

export function parseHostAccountProfileNativeResultPayload(
  request: HostRequest,
): NativeAccountProfileResult {
  if (request.command !== hostAccountProfileNativeResultCommand) {
    throw new TypeError(
      "Host request is not an account-profile native result.",
    );
  }
  return nativeAccountProfileResultSchema.parse(request.payload);
}

export function parseHostHarnessCustodyNativeResultPayload(
  request: HostRequest,
): NativeHarnessCustodyResult {
  if (request.command !== hostHarnessCustodyNativeResultCommand) {
    throw new TypeError(
      "Host request is not a Harness custody native result.",
    );
  }
  return nativeHarnessCustodyResultSchema.parse(request.payload);
}

export function hostLocalDataRemovalNativeLaunch(input: {
  readonly operationId: string;
  readonly previewId: string;
  readonly parentProcessId: number;
  readonly requestPath: string;
  readonly signingKeyPath: string;
  readonly publicResponse: RuntimeDispatchResponse;
}): HostLocalDataRemovalNativeLaunch {
  return hostLocalDataRemovalNativeLaunchSchema.parse({
    kind: "localDataRemovalNativeLaunch",
    version: 1,
    ...input,
  });
}

export function hostLocalDataRemovalRecoveryResult(
  state: "clear" | "active",
  recoveredOperationCount: number,
): HostLocalDataRemovalRecoveryResult {
  return hostLocalDataRemovalRecoveryResultSchema.parse({
    kind: "localDataRemovalRecoveryResult",
    version: 1,
    state,
    recoveredOperationCount,
  });
}

export function hostLocalDataRemovalNativeTerminationRequired(
  publicResponse: RuntimeDispatchResponse,
): HostLocalDataRemovalNativeTerminationRequired {
  return hostLocalDataRemovalNativeTerminationRequiredSchema.parse({
    kind: "localDataRemovalNativeTerminationRequired",
    version: 1,
    publicResponse,
  });
}

export function hostSuccess(id: string, result: unknown): HostResponse {
  return { id, ok: true, result };
}

export function hostFailure(
  id: string,
  code: "invalid_request" | "internal_error",
  message: string,
): HostResponse {
  return { id, ok: false, error: { code, message } };
}
