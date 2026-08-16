import { appendFileSync } from "node:fs";

interface SecretDescriptor {
  readonly name: string;
  readonly service: string;
}

interface SecretSeed extends SecretDescriptor {
  readonly value: string;
}

type SecretTraceResult =
  | "deleted"
  | "missing"
  | "present"
  | "rejected"
  | "stored";

interface SecretTraceEntry extends SecretDescriptor {
  readonly operation: "delete" | "get" | "set";
  readonly result: SecretTraceResult;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(
  value: unknown,
  description: string,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${description} must be a non-empty string.`);
  }
  return value;
}

function descriptor(value: unknown): SecretDescriptor {
  if (!isRecord(value)) {
    throw new TypeError("A test secret descriptor must be an object.");
  }
  return {
    name: requiredString(value.name, "The test secret name"),
    service: requiredString(value.service, "The test secret service"),
  };
}

function seed(value: unknown): SecretSeed {
  const parsed = descriptor(value);
  if (!isRecord(value) || Object.keys(value).length !== 3) {
    throw new TypeError(
      "A test secret seed must contain only service, name, and value.",
    );
  }
  return {
    ...parsed,
    value: requiredString(value.value, "The test secret value"),
  };
}

function configuredSeeds(): readonly SecretSeed[] {
  const source = process.env.HRA_GATEWAY_TEST_SECRET_SEEDS;
  if (source === undefined) return [];
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw new TypeError("The test secret seeds must be valid JSON.");
  }
  if (!Array.isArray(value)) {
    throw new TypeError("The test secret seeds must be an array.");
  }
  return value.map(seed);
}

function configuredDeleteRejection(): SecretDescriptor | null {
  const source = process.env.HRA_GATEWAY_TEST_SECRET_REJECT_DELETE;
  if (source === undefined) return null;
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw new TypeError(
      "The test secret deletion rejection must be valid JSON.",
    );
  }
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join("\0") !== "name\0service"
  ) {
    throw new TypeError(
      "The test secret deletion rejection must contain only name and service.",
    );
  }
  return descriptor(value);
}

function descriptorKey(value: SecretDescriptor): string {
  return JSON.stringify([value.service, value.name]);
}

const tracePath = process.env.HRA_GATEWAY_TEST_SECRET_TRACE_PATH;
const deleteRejection = configuredDeleteRejection();
const values = new Map<string, string>();
for (const configured of configuredSeeds()) {
  const key = descriptorKey(configured);
  if (values.has(key)) {
    throw new TypeError("The test secret seeds contain a duplicate descriptor.");
  }
  values.set(key, configured.value);
}

function trace(entry: SecretTraceEntry): void {
  if (tracePath === undefined) return;
  appendFileSync(tracePath, `${JSON.stringify(entry)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

const inMemorySecrets: typeof Bun.secrets = Object.freeze({
  delete(input) {
    const parsed = descriptor(input);
    if (
      deleteRejection !== null &&
      descriptorKey(parsed) === descriptorKey(deleteRejection)
    ) {
      trace({
        ...parsed,
        operation: "delete",
        result: "rejected",
      });
      return Promise.reject(
        new Error("Injected gateway-test secret deletion rejection."),
      );
    }
    const deleted = values.delete(descriptorKey(parsed));
    trace({
      ...parsed,
      operation: "delete",
      result: deleted ? "deleted" : "missing",
    });
    return Promise.resolve(deleted);
  },
  get(input) {
    const parsed = descriptor(input);
    const value = values.get(descriptorKey(parsed)) ?? null;
    trace({
      ...parsed,
      operation: "get",
      result: value === null ? "missing" : "present",
    });
    return Promise.resolve(value);
  },
  set(input) {
    const parsed = descriptor(input);
    const key = descriptorKey(parsed);
    if (input.value.length === 0) {
      const deleted = values.delete(key);
      trace({
        ...parsed,
        operation: "set",
        result: deleted ? "deleted" : "missing",
      });
      return Promise.resolve();
    }
    values.set(key, input.value);
    trace({ ...parsed, operation: "set", result: "stored" });
    return Promise.resolve();
  },
});

const bunSecretsDescriptor = Object.getOwnPropertyDescriptor(Bun, "secrets");
if (bunSecretsDescriptor?.writable !== true) {
  throw new Error("The gateway test Bun.secrets seam is unavailable.");
}
Object.defineProperty(Bun, "secrets", {
  ...bunSecretsDescriptor,
  value: inMemorySecrets,
});
if (Bun.secrets !== inMemorySecrets) {
  throw new Error("The gateway test did not retain in-memory secret custody.");
}
