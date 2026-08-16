import { normalizeApiOrigin } from "@hraness/hra-human-client";
import { z } from "@hra-internal/schema";
import { renamedEnvironmentValue } from "../security/renamed-environment";

export const HRA_CLOUD_API_URL_ENV = "HRA_CLOUD_API_URL";
export const HRA_WORKOS_CLIENT_ID_ENV = "HRA_WORKOS_CLIENT_ID";

const workosClientIdSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !/\s/u.test(value), "WorkOS client ID cannot contain whitespace");

export type CloudConfigurationComponent<Value> =
  | { readonly state: "enabled"; readonly value: Value }
  | {
      readonly state: "disabled";
      readonly reason: "missing" | "invalid" | "conflicting";
    };

export interface HRACloudConfiguration {
  readonly api: CloudConfigurationComponent<Readonly<{ origin: string }>>;
  readonly workos: CloudConfigurationComponent<Readonly<{ clientId: string }>>;
}

export type CloudAttachmentAvailability =
  | {
      readonly state: "enabled";
      readonly apiOrigin: string;
      readonly workosClientId: string;
    }
  | {
      readonly state: "disabled";
      readonly reason:
        | "api_missing"
        | "api_invalid"
        | "api_conflicting"
        | "workos_missing"
        | "workos_invalid"
        | "workos_conflicting";
    };

type Environment = Readonly<Record<string, string | undefined>>;

function configuredValues(
  environment: Environment,
  names: readonly string[],
): string[] {
  return names
    .map((name) => environment[name])
    .filter((value): value is string => value !== undefined && value.length > 0);
}

function parseApi(
  environment: Environment,
): HRACloudConfiguration["api"] {
  const renamed = renamedEnvironmentValue(environment, HRA_CLOUD_API_URL_ENV);
  if (renamed.state === "conflicting") {
    return { state: "disabled", reason: "conflicting" };
  }
  const values = configuredValues(environment, [
    "TASKCTL_API_URL",
  ]);
  if (renamed.state === "value") values.push(renamed.value);
  if (values.length === 0) return { state: "disabled", reason: "missing" };
  const normalized = values.map(normalizeApiOrigin);
  if (normalized.some((value) => value === null)) {
    return { state: "disabled", reason: "invalid" };
  }
  const origins = new Set(normalized as readonly string[]);
  if (origins.size !== 1) return { state: "disabled", reason: "conflicting" };
  return {
    state: "enabled",
    value: { origin: [...origins][0] as string },
  };
}

function parseWorkos(
  environment: Environment,
): HRACloudConfiguration["workos"] {
  const renamed = renamedEnvironmentValue(environment, HRA_WORKOS_CLIENT_ID_ENV);
  if (renamed.state === "conflicting") {
    return { state: "disabled", reason: "conflicting" };
  }
  const values = configuredValues(environment, [
    "TASKCTL_WORKOS_CLIENT_ID",
    "WORKOS_CLIENT_ID",
  ]);
  if (renamed.state === "value") values.push(renamed.value);
  if (values.length === 0) return { state: "disabled", reason: "missing" };
  const parsed = values.map((value) => workosClientIdSchema.safeParse(value));
  if (parsed.some((value) => !value.success)) {
    return { state: "disabled", reason: "invalid" };
  }
  const clientIds = new Set(parsed.map((value) => value.success ? value.data : ""));
  if (clientIds.size !== 1) return { state: "disabled", reason: "conflicting" };
  return {
    state: "enabled",
    value: { clientId: [...clientIds][0] as string },
  };
}

/**
 * Parse optional desktop attachment configuration without throwing. HTTP is
 * accepted only for exact loopback hosts; every non-loopback origin is HTTPS.
 */
export function parseHRACloudConfiguration(
  environment: Environment,
): HRACloudConfiguration {
  return {
    api: parseApi(environment),
    workos: parseWorkos(environment),
  };
}

export function cloudAttachmentAvailability(
  configuration: HRACloudConfiguration,
): CloudAttachmentAvailability {
  if (configuration.api.state === "disabled") {
    return {
      state: "disabled",
      reason: `api_${configuration.api.reason}`,
    };
  }
  if (configuration.workos.state === "disabled") {
    return {
      state: "disabled",
      reason: `workos_${configuration.workos.reason}`,
    };
  }
  return {
    state: "enabled",
    apiOrigin: configuration.api.value.origin,
    workosClientId: configuration.workos.value.clientId,
  };
}
