declare const operationTypes: unique symbol;

export type OperationConcurrency =
  | "parallel"
  | "per-source"
  | "per-thread"
  | "global";

export const MIN_OPERATION_TIMEOUT_MS = 1;
export const MAX_OPERATION_TIMEOUT_MS = 600_000;

export type AutomaticOperationReconciliation = Readonly<{
  kind: "automatic";
  strategy: string;
}>;

export type ManualOperationReconciliation = Readonly<{
  kind: "manual";
  strategy: string;
}>;

export type UnsupportedOperationReconciliation = Readonly<{
  kind: "unsupported";
  strategy: string;
}>;

export type ReconcilableOperationReconciliation =
  | AutomaticOperationReconciliation
  | ManualOperationReconciliation;

export type OperationReconciliation =
  | ReconcilableOperationReconciliation
  | UnsupportedOperationReconciliation;

export type ReadOperationSemantics = Readonly<{
  effect: "read";
  lostResponse: "safe-to-retry";
  timeoutMs: number;
  concurrency: OperationConcurrency;
  reconciliation: "not-required";
}>;

export type IdempotentMutationOperationSemantics = Readonly<{
  effect: "idempotent-mutation";
  lostResponse: "safe-to-retry";
  timeoutMs: number;
  concurrency: OperationConcurrency;
  reconciliation: "not-required";
}>;

export type NonIdempotentMutationOperationSemantics<
  Reconciliation extends OperationReconciliation = OperationReconciliation,
> = Readonly<{
  effect: "non-idempotent-mutation";
  lostResponse: "ambiguous";
  timeoutMs: number;
  concurrency: OperationConcurrency;
  reconciliation: Reconciliation;
}>;

export type ReconcilableOperationSemantics =
  NonIdempotentMutationOperationSemantics<ReconcilableOperationReconciliation>;

export type OperationSemantics =
  | ReadOperationSemantics
  | IdempotentMutationOperationSemantics
  | NonIdempotentMutationOperationSemantics;

export interface OperationDefinition<
  Input,
  Output,
  Semantics extends OperationSemantics = OperationSemantics,
> {
  readonly semantics: Semantics;
  readonly [operationTypes]?: readonly [Input, Output];
}

export interface OperationDescriptor<
  Name extends string,
  Input,
  Output,
  Semantics extends OperationSemantics = OperationSemantics,
> {
  readonly name: Name;
  readonly semantics: Semantics;
  readonly [operationTypes]?: readonly [Input, Output];
}

type AnyOperationDefinition = OperationDefinition<
  unknown,
  unknown,
  OperationSemantics
>;

export type OperationRegistry = Readonly<
  Record<
    string,
    OperationDescriptor<string, unknown, unknown, OperationSemantics>
  >
>;

export type OperationName<Registry extends OperationRegistry> =
  Extract<keyof Registry, string>;

export type OperationInput<Descriptor> =
  Descriptor extends OperationDescriptor<string, infer Input, unknown>
    ? Input
    : never;

export type OperationOutput<Descriptor> =
  Descriptor extends OperationDescriptor<
    string,
    unknown,
    infer Output,
    OperationSemantics
  >
    ? Output
    : never;

export type OperationDescriptorSemantics<Descriptor> =
  Descriptor extends OperationDescriptor<
    string,
    unknown,
    unknown,
    infer Semantics
  >
    ? Semantics
    : never;

export type ReconciliationOperationName<
  Registry extends OperationRegistry,
> = {
  [Name in OperationName<Registry>]: Extract<
    OperationDescriptorSemantics<Registry[Name]>,
    ReconcilableOperationSemantics
  > extends never
    ? never
    : Name;
}[OperationName<Registry>];

export type DefinedOperationRegistry<
  Definitions extends Readonly<Record<string, AnyOperationDefinition>>,
> = Readonly<{
  [Name in keyof Definitions]: Definitions[Name] extends OperationDefinition<
    infer Input,
    infer Output,
    infer Semantics
  >
    ? OperationDescriptor<Name & string, Input, Output, Semantics>
    : never;
}>;

function assertConcurrency(value: OperationConcurrency): void {
  if (
    value !== "parallel" &&
    value !== "per-source" &&
    value !== "per-thread" &&
    value !== "global"
  ) {
    throw new TypeError("operation concurrency is invalid");
  }
}

function assertTimeout(timeoutMs: number): void {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < MIN_OPERATION_TIMEOUT_MS ||
    timeoutMs > MAX_OPERATION_TIMEOUT_MS
  ) {
    throw new RangeError(
      `operation timeout must be an integer from ${String(MIN_OPERATION_TIMEOUT_MS)} to ${String(MAX_OPERATION_TIMEOUT_MS)} milliseconds`,
    );
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return false;
  }
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

function ownDataProperty(
  value: Readonly<Record<string, unknown>>,
  key: string,
  label: string,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor)) {
    throw new TypeError(`${label} must be an own data property`);
  }
  return descriptor.value as unknown;
}

function copyReconciliation(value: unknown): OperationReconciliation {
  if (!isRecord(value)) {
    throw new TypeError("operation reconciliation must be an object");
  }
  const kind = ownDataProperty(
    value,
    "kind",
    "operation reconciliation kind",
  );
  const strategy = ownDataProperty(
    value,
    "strategy",
    "operation reconciliation strategy",
  );
  if (
    kind !== "automatic" &&
    kind !== "manual" &&
    kind !== "unsupported"
  ) {
    throw new TypeError("operation reconciliation kind is invalid");
  }
  if (
    typeof strategy !== "string" ||
    strategy.length === 0 ||
    strategy.length > 128 ||
    !/^[A-Za-z][A-Za-z0-9._:-]*$/u.test(strategy)
  ) {
    throw new TypeError(
      "operation reconciliation strategy must be a portable identifier",
    );
  }
  return Object.freeze({
    kind,
    strategy,
  });
}

function copySemantics(value: unknown): OperationSemantics {
  if (!isRecord(value)) {
    throw new TypeError("operation semantics must be an object");
  }
  const effect = ownDataProperty(
    value,
    "effect",
    "operation effect",
  );
  const lostResponse = ownDataProperty(
    value,
    "lostResponse",
    "operation lost-response policy",
  );
  const timeoutMs = ownDataProperty(
    value,
    "timeoutMs",
    "operation timeout",
  );
  const concurrency = ownDataProperty(
    value,
    "concurrency",
    "operation concurrency",
  );
  const reconciliation = ownDataProperty(
    value,
    "reconciliation",
    "operation reconciliation",
  );
  assertConcurrency(concurrency as OperationConcurrency);
  assertTimeout(timeoutMs as number);
  switch (effect) {
    case "read":
    case "idempotent-mutation": {
      if (
        lostResponse !== "safe-to-retry" ||
        reconciliation !== "not-required"
      ) {
        throw new TypeError(
          "read and idempotent operations must be safe to retry",
        );
      }
      return Object.freeze({
        effect,
        lostResponse: "safe-to-retry",
        timeoutMs: timeoutMs as number,
        concurrency: concurrency as OperationConcurrency,
        reconciliation: "not-required",
      });
    }
    case "non-idempotent-mutation": {
      if (lostResponse !== "ambiguous") {
        throw new TypeError(
          "non-idempotent operations must treat lost responses as ambiguous",
        );
      }
      return Object.freeze({
        effect: "non-idempotent-mutation",
        lostResponse: "ambiguous",
        timeoutMs: timeoutMs as number,
        concurrency: concurrency as OperationConcurrency,
        reconciliation: copyReconciliation(reconciliation),
      });
    }
    default:
      throw new TypeError("operation effect is invalid");
  }
}

export function defineOperation<Input, Output>(
  semantics: ReadOperationSemantics,
): OperationDefinition<Input, Output, ReadOperationSemantics>;
export function defineOperation<Input, Output>(
  semantics: IdempotentMutationOperationSemantics,
): OperationDefinition<
  Input,
  Output,
  IdempotentMutationOperationSemantics
>;
export function defineOperation<Input, Output>(
  semantics: ReconcilableOperationSemantics,
): OperationDefinition<Input, Output, ReconcilableOperationSemantics>;
export function defineOperation<Input, Output>(
  semantics: NonIdempotentMutationOperationSemantics<
    UnsupportedOperationReconciliation
  >,
): OperationDefinition<
  Input,
  Output,
  NonIdempotentMutationOperationSemantics<UnsupportedOperationReconciliation>
>;
export function defineOperation<Input, Output>(
  semantics: OperationSemantics,
): OperationDefinition<Input, Output, OperationSemantics>;
export function defineOperation<Input, Output>(
  semantics: OperationSemantics,
): OperationDefinition<Input, Output, OperationSemantics> {
  return Object.freeze({ semantics: copySemantics(semantics) });
}

export function defineOperationRegistry<
  const Definitions extends Readonly<Record<string, AnyOperationDefinition>>,
>(
  definitions: Definitions,
): DefinedOperationRegistry<Definitions> {
  if (!isRecord(definitions)) {
    throw new TypeError("operation registry definitions must be an object");
  }
  const names = Object.keys(definitions);
  if (names.length === 0) {
    throw new TypeError(
      "an operation registry must define at least one operation",
    );
  }

  const entries = names.map((name) => {
    if (!/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u.test(name)) {
      throw new TypeError(
        "operation names must be portable identifiers with 1 to 128 characters",
      );
    }
    const definition = ownDataProperty(
      definitions,
      name,
      `operation ${name} definition`,
    );
    if (!isRecord(definition)) {
      throw new TypeError(`operation ${name} is missing its definition`);
    }
    return [
      name,
      Object.freeze({
        name,
        semantics: copySemantics(
          ownDataProperty(
            definition,
            "semantics",
            `operation ${name} semantics`,
          ),
        ),
      }),
    ] as const;
  });

  return Object.freeze(
    Object.fromEntries(entries),
  ) as DefinedOperationRegistry<Definitions>;
}

/**
 * Validates and snapshots a registry before it crosses into a long-lived host.
 * This is intentionally module-internal to the package's public root surface.
 */
export function snapshotOperationRegistry<
  const Registry extends OperationRegistry,
>(registry: Registry): Registry {
  if (!isRecord(registry)) {
    throw new TypeError("operation registry must be an object");
  }
  const names = Object.keys(registry);
  if (names.length === 0) {
    throw new TypeError(
      "an operation registry must define at least one operation",
    );
  }

  const entries = names.map((name) => {
    if (!/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u.test(name)) {
      throw new TypeError(
        "operation names must be portable identifiers with 1 to 128 characters",
      );
    }
    const descriptor = ownDataProperty(
      registry,
      name,
      `operation ${name} descriptor`,
    );
    if (!isRecord(descriptor)) {
      throw new TypeError(`operation ${name} is missing its descriptor`);
    }
    const descriptorName = ownDataProperty(
      descriptor,
      "name",
      `operation ${name} descriptor name`,
    );
    const semantics = ownDataProperty(
      descriptor,
      "semantics",
      `operation ${name} descriptor semantics`,
    );
    if (descriptorName !== name) {
      throw new TypeError(
        `operation descriptor ${name} must repeat its registry name`,
      );
    }
    return [
      name,
      Object.freeze({
        name,
        semantics: copySemantics(semantics),
      }),
    ] as const;
  });

  return Object.freeze(Object.fromEntries(entries)) as Registry;
}
