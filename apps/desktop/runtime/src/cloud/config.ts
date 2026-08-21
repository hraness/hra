import { normalizeApiOrigin } from "@hraness/hra-human-client";
import { renamedEnvironmentValue } from "../security/renamed-environment";

export const HRA_CLOUD_API_URL_ENV = "HRA_CLOUD_API_URL";
export const HRA_CLOUD_WEB_URL_ENV = "HRA_CLOUD_WEB_URL";

export type CloudConfigurationComponent<Value> =
  | { readonly state: "enabled"; readonly value: Value }
  | {
      readonly state: "disabled";
      readonly reason: "missing" | "invalid" | "conflicting";
    };

export interface HRACloudConfiguration {
  readonly api: CloudConfigurationComponent<Readonly<{ origin: string }>>;
  readonly web: CloudConfigurationComponent<Readonly<{ origin: string }>>;
}

export type CloudAttachmentAvailability =
  | {
      readonly state: "enabled";
      readonly apiOrigin: string;
      readonly webOrigin: string;
    }
  | {
      readonly state: "disabled";
      readonly reason:
        | "api_missing"
        | "api_invalid"
        | "api_conflicting"
        | "web_missing"
        | "web_invalid"
        | "web_conflicting";
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

function parseWeb(
  environment: Environment,
): HRACloudConfiguration["web"] {
  const renamed = renamedEnvironmentValue(environment, HRA_CLOUD_WEB_URL_ENV);
  if (renamed.state === "conflicting") {
    return { state: "disabled", reason: "conflicting" };
  }
  const values: string[] = [];
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

/**
 * Parse optional desktop attachment configuration without throwing. HTTP is
 * accepted only for exact loopback hosts; every non-loopback origin is HTTPS.
 */
export function parseHRACloudConfiguration(
  environment: Environment,
): HRACloudConfiguration {
  return {
    api: parseApi(environment),
    web: parseWeb(environment),
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
  if (configuration.web.state === "disabled") {
    return {
      state: "disabled",
      reason: `web_${configuration.web.reason}`,
    };
  }
  return {
    state: "enabled",
    apiOrigin: configuration.api.value.origin,
    webOrigin: configuration.web.value.origin,
  };
}
