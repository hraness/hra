import { z } from "@hra-internal/schema";

import {
  contextValueLifecycleRecordSchema,
  type ContextValueRecord,
  type EncryptedContextValueStore,
} from "./context-value-store";

const DEFAULT_PAGE_SIZE = 128;
const DEFAULT_MAX_RECORDS = 100_000;

const optionsSchema = z.object({
  pageSize: z.number().int().min(1).max(128),
  maxRecords: z.number().int().min(1).max(1_000_000),
}).strict();

const recoveryResultSchema = z.object({
  state: z.enum([
    "prepared",
    "replayRequired",
    "recoveryRequired",
    "active",
  ]),
  value: contextValueLifecycleRecordSchema,
}).strict();

type RecoveryState = z.infer<typeof recoveryResultSchema>["state"];

export interface HarnessContextRecoveryStoreV2 {
  scanRecovery(input: Readonly<{
    afterOperationId: string | null;
    limit: number;
  }>): Promise<unknown>;
  recover(operationId: string): Promise<unknown>;
}

export interface HarnessContextRecoveryReportV2 {
  readonly inspectedOperationIds: readonly string[];
  readonly activeOperationIds: readonly string[];
  readonly preparedOperationIds: readonly string[];
  readonly replayRequiredOperationIds: readonly string[];
  readonly recoveryRequiredOperationIds: readonly string[];
}

export class HarnessContextRecoveryV2Error extends Error {
  readonly code: "bound_exceeded" | "corrupt_state";

  constructor(
    code: HarnessContextRecoveryV2Error["code"],
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "HarnessContextRecoveryV2Error";
    this.code = code;
  }
}

/**
 * Boot-only reconciliation for encrypted context publications. It never
 * invents plaintext or deletes partial immutable objects. Missing effects are
 * left replay-required for the owning immutable program; verified complete
 * effects may become active, and corrupt evidence remains quarantined.
 */
export class HarnessContextRecoveryV2 {
  readonly #store: HarnessContextRecoveryStoreV2;
  readonly #pageSize: number;
  readonly #maxRecords: number;

  constructor(input: Readonly<{
    store: HarnessContextRecoveryStoreV2;
    pageSize?: number;
    maxRecords?: number;
  }>) {
    const options = optionsSchema.parse({
      pageSize: input.pageSize ?? DEFAULT_PAGE_SIZE,
      maxRecords: input.maxRecords ?? DEFAULT_MAX_RECORDS,
    });
    this.#store = input.store;
    this.#pageSize = options.pageSize;
    this.#maxRecords = options.maxRecords;
  }

  async recover(): Promise<HarnessContextRecoveryReportV2> {
    const inspected: string[] = [];
    const outcomes: Record<RecoveryState, string[]> = {
      active: [],
      prepared: [],
      replayRequired: [],
      recoveryRequired: [],
    };
    let afterOperationId: string | null = null;

    while (true) {
      const page = this.#parsePage(
        await this.#store.scanRecovery({
          afterOperationId,
          limit: this.#pageSize,
        }),
        afterOperationId,
      );
      if (inspected.length + page.length > this.#maxRecords) {
        throw new HarnessContextRecoveryV2Error(
          "bound_exceeded",
          "encrypted context recovery exceeded its boot scan bound",
        );
      }
      for (const value of page) {
        const result = recoveryResultSchema.parse(
          await this.#store.recover(value.operationId),
        );
        if (
          result.value.operationId !== value.operationId ||
          result.value.valueId !== value.valueId ||
          recoveryStateFor(result.value) !== result.state
        ) {
          throw new HarnessContextRecoveryV2Error(
            "corrupt_state",
            "encrypted context recovery returned another immutable value",
          );
        }
        inspected.push(value.operationId);
        outcomes[result.state].push(value.operationId);
      }
      if (page.length < this.#pageSize) break;
      afterOperationId = page.at(-1)!.operationId;
    }

    return Object.freeze({
      inspectedOperationIds: Object.freeze(inspected),
      activeOperationIds: Object.freeze(outcomes.active),
      preparedOperationIds: Object.freeze(outcomes.prepared),
      replayRequiredOperationIds: Object.freeze(outcomes.replayRequired),
      recoveryRequiredOperationIds: Object.freeze(outcomes.recoveryRequired),
    });
  }

  #parsePage(
    value: unknown,
    afterOperationId: string | null,
  ): readonly ContextValueRecord[] {
    let page: readonly ContextValueRecord[];
    try {
      page = z.array(contextValueLifecycleRecordSchema)
        .max(this.#pageSize)
        .parse(value);
    } catch (cause: unknown) {
      throw new HarnessContextRecoveryV2Error(
        "corrupt_state",
        "encrypted context recovery returned an invalid page",
        cause,
      );
    }
    let previous = afterOperationId;
    for (const record of page) {
      if (
        record.state === "active" ||
        (previous !== null && record.operationId <= previous)
      ) {
        throw new HarnessContextRecoveryV2Error(
          "corrupt_state",
          "encrypted context recovery page is duplicated or out of order",
        );
      }
      previous = record.operationId;
    }
    return page;
  }
}

export function contextRecoveryStoreV2(
  store: Pick<EncryptedContextValueStore, "scanRecovery" | "recover">,
): HarnessContextRecoveryStoreV2 {
  return store;
}

function recoveryStateFor(value: ContextValueRecord): RecoveryState {
  if (value.state === "active") return "active";
  if (value.state === "prepared") return "prepared";
  if (value.state === "replayRequired" || value.state === "effectStarted") {
    return "replayRequired";
  }
  return "recoveryRequired";
}
