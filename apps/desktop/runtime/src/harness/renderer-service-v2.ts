import { z } from "@hra-internal/schema";

import {
  chatPaneHarnessProjectionSchema,
  chatPaneIdSchema,
  chatPaneProjectionSchema,
  harnessChildProjectionSchema,
  harnessSettingsProjectionSchema,
  harnessSnapshotSchema,
  runtimeHarnessDomainCommandSchema,
  type ChatPaneHarnessProjection,
  type HarnessSnapshot,
  type RuntimeHarnessDomainCommand,
} from "../../../contracts/runtime";

const revisionSchema = z.number().int().positive().safe();
const rendererProjectionSchema = z.object({
  harness: harnessSnapshotSchema,
  panes: z.array(z.object({
    paneId: chatPaneIdSchema,
    harness: chatPaneHarnessProjectionSchema.nullable(),
  }).strict()).max(64),
}).strict().superRefine((projection, context) => {
  const paneIds = new Set<string>();
  projection.panes.forEach((pane, index) => {
    if (paneIds.has(pane.paneId)) {
      context.addIssue({
        code: "custom",
        message: "harness pane projections must be unique",
        path: ["panes", index, "paneId"],
      });
    }
    paneIds.add(pane.paneId);
  });
});

const settingsResultSchema = z.object({
  type: z.literal("harnessSettings"),
  harnessRevision: revisionSchema,
  settings: harnessSettingsProjectionSchema,
}).strict();
const childResultSchema = z.object({
  type: z.literal("harnessChild"),
  parentPaneId: chatPaneIdSchema,
  parentRevision: revisionSchema,
  child: harnessChildProjectionSchema,
}).strict();
const childOpenedResultSchema = z.object({
  type: z.literal("harnessChildOpened"),
  parentPaneId: chatPaneIdSchema,
  parentRevision: revisionSchema,
  child: harnessChildProjectionSchema,
  pane: chatPaneProjectionSchema,
}).strict().superRefine((result, context) => {
  if (result.child.openedPaneId !== result.pane.id) {
    context.addIssue({
      code: "custom",
      message: "opened harness child must reference its returned pane",
      path: ["child", "openedPaneId"],
    });
  }
});
const harnessResultSchema = z.discriminatedUnion("type", [
  settingsResultSchema,
  childResultSchema,
  childOpenedResultSchema,
]);

export type HarnessRendererProjection = z.infer<typeof rendererProjectionSchema>;
export type HarnessRendererResult = z.infer<typeof harnessResultSchema>;

export interface HarnessRendererAuthorityPort {
  readProjection(): Promise<unknown>;
  execute(command: RuntimeHarnessDomainCommand): Promise<unknown>;
}

export interface HarnessRendererProjectionPort {
  installHarnessState(input: Readonly<{
    harness: HarnessSnapshot | null;
    panes: readonly Readonly<{
      paneId: string;
      harness: ChatPaneHarnessProjection | null;
    }>[];
  }>): void | Promise<void>;
}

export class HarnessRendererServiceError extends Error {
  readonly code:
    | "authority_conflict"
    | "invalid_state"
    | "not_found"
    | "stale_revision";
  readonly retryable: boolean;
  readonly action: "none" | "retry";

  constructor(
    code: HarnessRendererServiceError["code"],
    options: Readonly<{ retryable?: boolean; cause?: unknown }> = {},
  ) {
    super({
      authority_conflict: "The local harness authority conflicts.",
      invalid_state: "The harness action is not valid in the current state.",
      not_found: "The harness child is unavailable.",
      stale_revision: "The harness view changed before the action completed.",
    }[code], options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "HarnessRendererServiceError";
    this.code = code;
    this.retryable = options.retryable ?? code === "stale_revision";
    this.action = this.retryable ? "retry" : "none";
  }
}

/** Minimal renderer boundary: settings plus per-child Open and Stop only. */
export class HarnessRendererService {
  readonly #authority: HarnessRendererAuthorityPort;
  readonly #projection: HarnessRendererProjectionPort;
  #tail: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(input: Readonly<{
    authority: HarnessRendererAuthorityPort;
    projection: HarnessRendererProjectionPort;
  }>) {
    this.#authority = input.authority;
    this.#projection = input.projection;
  }

  async initialize(): Promise<void> {
    await this.refresh();
  }

  /**
   * Serializes an authority refresh behind renderer commands. Provider and
   * reconciliation callbacks use this path so an older read can never
   * overwrite a just-committed Open, Stop, or Settings projection.
   */
  refresh(): Promise<void> {
    if (this.#closed) {
      return Promise.reject(new HarnessRendererServiceError("invalid_state"));
    }
    let resolveRefresh!: () => void;
    let rejectRefresh!: (reason: unknown) => void;
    const result = new Promise<void>((resolve, reject) => {
      resolveRefresh = resolve;
      rejectRefresh = reject;
    });
    const operation = this.#tail.then(async () => {
      try {
        const projection = rendererProjectionSchema.parse(
          await this.#authority.readProjection(),
        );
        await this.#projection.installHarnessState(projection);
        resolveRefresh();
      } catch (error: unknown) {
        rejectRefresh(normalizeError(error));
      }
    });
    this.#tail = operation.catch(() => undefined);
    return result;
  }

  execute(commandValue: RuntimeHarnessDomainCommand): Promise<HarnessRendererResult> {
    if (this.#closed) {
      return Promise.reject(new HarnessRendererServiceError("invalid_state"));
    }
    const command = runtimeHarnessDomainCommandSchema.parse(commandValue);
    let resolveResult!: (value: HarnessRendererResult) => void;
    let rejectResult!: (reason: unknown) => void;
    const result = new Promise<HarnessRendererResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const operation = this.#tail.then(async () => {
      try {
        const outcome = z.object({
          result: harnessResultSchema,
          projection: rendererProjectionSchema,
        }).strict().parse(await this.#authority.execute(command));
        correlate(command, outcome.result);
        await this.#projection.installHarnessState(outcome.projection);
        resolveResult(outcome.result);
      } catch (error: unknown) {
        rejectResult(normalizeError(error));
      }
    });
    this.#tail = operation.catch(() => undefined);
    return result;
  }

  async settled(): Promise<void> {
    this.#closed = true;
    await this.#tail;
  }
}

function correlate(
  command: RuntimeHarnessDomainCommand,
  result: HarnessRendererResult,
): void {
  switch (command.type) {
    case "harness.settings.update":
      if (
        result.type !== "harnessSettings" ||
        result.harnessRevision !== command.expectedHarnessRevision + 1 ||
        result.settings.revision !== command.expectedRevision + 1 ||
        result.settings.recursiveSessionsEnabled !== command.recursiveSessionsEnabled ||
        result.settings.contextQuotaBytes !== command.contextQuotaBytes ||
        result.settings.refinementMode !== command.refinementMode
      ) throw new HarnessRendererServiceError("authority_conflict");
      return;
    case "harness.child.open":
      if (
        result.type !== "harnessChildOpened" ||
        result.parentPaneId !== command.parentPaneId ||
        result.parentRevision !== command.expectedParentRevision + 1 ||
        result.child.id !== command.childId ||
        result.child.revision !== command.expectedChildRevision + 1 ||
        result.child.openedPaneId !== result.pane.id
      ) throw new HarnessRendererServiceError("authority_conflict");
      return;
    case "harness.child.stop":
      if (
        result.type !== "harnessChild" ||
        result.parentPaneId !== command.parentPaneId ||
        result.parentRevision !== command.expectedParentRevision + 1 ||
        result.child.id !== command.childId ||
        result.child.revision !== command.expectedChildRevision + 1 ||
        result.child.state !== "stopped" || result.child.canStop
      ) throw new HarnessRendererServiceError("authority_conflict");
  }
}

function normalizeError(error: unknown): HarnessRendererServiceError {
  if (error instanceof HarnessRendererServiceError) return error;
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (
      code === "invalid_state" || code === "not_found" ||
      code === "stale_revision"
    ) return new HarnessRendererServiceError(code, { cause: error });
  }
  return new HarnessRendererServiceError("authority_conflict", { cause: error });
}
