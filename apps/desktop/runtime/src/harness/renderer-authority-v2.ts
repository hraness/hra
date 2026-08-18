import { createHash } from "node:crypto";

import { z } from "@hra-internal/schema";

import {
  chatPaneHarnessProjectionSchema,
  chatPaneIdSchema,
  chatPaneProjectionSchema,
  harnessChildProjectionSchema,
  harnessProposalSummaryProjectionSchema,
  harnessSettingsProjectionSchema,
  harnessSnapshotSchema,
  runtimeChatPaneLimit,
  runtimeHarnessChildProjectionLimit,
  runtimeHarnessDomainCommandSchema,
  runtimeHarnessProposalProjectionLimit,
  type ChatPaneProjection,
  type HarnessChildProjection,
  type RuntimeHarnessDomainCommand,
} from "../../../contracts/runtime";
import {
  actorSchema,
  actorTurnSchema,
  type Actor,
  type ActorTurn,
} from "./actor-domain";
import {
  actorIncarnationRecordSchema,
  actorPaneBindingSchema,
  type ActorIncarnationRecord,
  type ActorPaneBinding,
} from "./sqlite-authority-v2";
import type {
  HarnessRendererAuthorityPort,
  HarnessRendererProjection,
  HarnessRendererResult,
} from "./renderer-service-v2";

const PANE_PAGE_SIZE = 16;
const CHILD_PAGE_SIZE = 16;
const PROPOSAL_PAGE_SIZE = runtimeHarnessProposalProjectionLimit;
const MAX_DURABLE_CHILDREN = 50;

const revisionSchema = z.number().int().positive().safe();
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);

const settingsStateSchema = z.object({
  settings: harnessSettingsProjectionSchema,
  harnessRevision: revisionSchema,
}).strict();

const projectionWitnessSchema = z.object({
  actorId: harnessChildProjectionSchema.shape.id,
  revision: revisionSchema,
  semanticDigest: digestSchema,
}).strict();

const openOutcomeSchema = z.object({
  parentPaneId: chatPaneIdSchema,
  parentActorId: harnessChildProjectionSchema.shape.id,
  parentRevision: revisionSchema,
  childActorId: harnessChildProjectionSchema.shape.id,
  childWitness: projectionWitnessSchema,
  binding: actorPaneBindingSchema,
  pane: chatPaneProjectionSchema,
}).strict();

const stopOutcomeSchema = z.object({
  parentPaneId: chatPaneIdSchema,
  parentActorId: harnessChildProjectionSchema.shape.id,
  parentRevision: revisionSchema,
  child: actorSchema,
  childWitness: projectionWitnessSchema,
}).strict();

const rendererProjectionSchema = z.object({
  harness: harnessSnapshotSchema,
  panes: z.array(z.object({
    paneId: chatPaneIdSchema,
    harness: chatPaneHarnessProjectionSchema.nullable(),
  }).strict()).max(runtimeChatPaneLimit),
}).strict();

type MaybePromise<T> = T | Promise<T>;

export interface HarnessRendererSettingsAuthorityPort {
  read(): MaybePromise<unknown>;
  update(input: Readonly<{
    expectedHarnessRevision: number;
    expectedSettingsRevision: number;
    recursiveSessionsEnabled: boolean;
    contextQuotaBytes: number;
    refinementMode: "off" | "suggest";
  }>): MaybePromise<unknown>;
}

export interface HarnessRendererProposalReadPort {
  list(input: Readonly<{
    afterProposalId: string | null;
    limit: number;
  }>): MaybePromise<unknown>;
}

export interface HarnessRendererActorReadPort {
  readActorForPane(paneId: string): MaybePromise<unknown>;
  listActorChildren(input: Readonly<{
    parentActorId: string;
    afterActorId: string | null;
    limit: number;
  }>): MaybePromise<unknown>;
  readActiveIncarnationForActor(actorId: string): MaybePromise<unknown>;
  readLatestActorTurnForActor(actorId: string): MaybePromise<unknown>;
  readPaneBindingForActor(actorId: string): MaybePromise<unknown>;
  readProjectionWitness(actorId: string): MaybePromise<unknown>;
}

export interface HarnessRendererChatAttachmentPort {
  listPaneIds(input: Readonly<{
    afterPaneId: string | null;
    limit: number;
  }>): MaybePromise<unknown>;
  /** Creates the chat pane, attachment, and both projection CAS advances atomically. */
  openChild(input: Readonly<{
    parentPaneId: string;
    parentActorId: string;
    childActorId: string;
    expectedParentRevision: number;
    expectedChildRevision: number;
  }>): MaybePromise<unknown>;
}

export interface HarnessRendererActorCoordinatorPort {
  /**
   * Persists stop intent before provider cleanup, settles the actor, and
   * coalesces that one renderer-visible transition into one witness advance.
   */
  requestAndSettleStop(input: Readonly<{
    parentPaneId: string;
    parentActorId: string;
    childActorId: string;
    expectedParentRevision: number;
    expectedChildRevision: number;
  }>): MaybePromise<unknown>;
}

export interface HarnessRendererAuthorityV2Options {
  readonly settings: HarnessRendererSettingsAuthorityPort;
  readonly proposals: HarnessRendererProposalReadPort;
  readonly actors: HarnessRendererActorReadPort;
  readonly chat: HarnessRendererChatAttachmentPort;
  readonly coordinator: HarnessRendererActorCoordinatorPort;
}

export class HarnessRendererAuthorityV2Error extends Error {
  readonly code:
    | "authority_conflict"
    | "invalid_state"
    | "not_found"
    | "stale_revision";

  constructor(
    code: HarnessRendererAuthorityV2Error["code"],
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "HarnessRendererAuthorityV2Error";
    this.code = code;
  }
}

interface ProjectedChildEvidence {
  readonly actor: Actor;
  readonly incarnation: ActorIncarnationRecord | null;
  readonly latestTurn: ActorTurn | null;
  readonly binding: ActorPaneBinding | null;
  readonly witness: z.infer<typeof projectionWitnessSchema>;
  readonly projection: HarnessChildProjection;
}

interface ProjectedParentEvidence {
  readonly paneId: string;
  readonly actor: Actor;
  readonly revision: number;
  readonly children: readonly ProjectedChildEvidence[];
}

interface CollectedProjection {
  readonly projection: HarnessRendererProjection;
  readonly evidenceJson: string;
  readonly parents: ReadonlyMap<string, ProjectedParentEvidence>;
}

/**
 * Provider-neutral authority for the three renderer harness commands.
 *
 * Revisions are semantic CAS witnesses, not sums of mutable provider rows.
 * Each child witness is durably advanced exactly once when the projected tuple
 * `(id,title,state,openedPaneId,canOpen,canMessage,canStop)` changes, and its
 * digest binds that
 * counter to the tuple. A parent's revision is the checked sum of its direct
 * child witnesses. The global revision is the checked sum of the settings
 * revision and immutable active-proposal revisions. Thus one Settings, Open,
 * or Stop command advances every revision named by that command exactly once,
 * while internal retries and provider cleanup remain projection-invisible.
 */
export class HarnessRendererAuthorityV2
  implements HarnessRendererAuthorityPort {
  readonly #settings: HarnessRendererSettingsAuthorityPort;
  readonly #proposals: HarnessRendererProposalReadPort;
  readonly #actors: HarnessRendererActorReadPort;
  readonly #chat: HarnessRendererChatAttachmentPort;
  readonly #coordinator: HarnessRendererActorCoordinatorPort;

  constructor(options: HarnessRendererAuthorityV2Options) {
    this.#settings = options.settings;
    this.#proposals = options.proposals;
    this.#actors = options.actors;
    this.#chat = options.chat;
    this.#coordinator = options.coordinator;
  }

  async readProjection(): Promise<unknown> {
    return (await this.#collectStable()).projection;
  }

  async execute(commandValue: RuntimeHarnessDomainCommand): Promise<unknown> {
    const command = runtimeHarnessDomainCommandSchema.parse(commandValue);
    try {
      switch (command.type) {
        case "harness.settings.update":
          return await this.#updateSettings(command);
        case "harness.child.open":
          return await this.#openChild(command);
        case "harness.child.stop":
          return await this.#stopChild(command);
      }
    } catch (error: unknown) {
      throw normalizeAuthorityError(error);
    }
  }

  async #updateSettings(
    command: Extract<RuntimeHarnessDomainCommand, {
      type: "harness.settings.update";
    }>,
  ): Promise<Readonly<{
    result: HarnessRendererResult;
    projection: HarnessRendererProjection;
  }>> {
    const before = await this.#collectStable();
    assertRevision(before.projection.harness.revision, command.expectedHarnessRevision);
    assertRevision(before.projection.harness.settings.revision, command.expectedRevision);
    if (command.refinementMode === "suggest" && !command.recursiveSessionsEnabled) {
      invalidState("suggest mode requires recursive sessions");
    }

    const outcome = settingsStateSchema.parse(await this.#settings.update({
      expectedHarnessRevision: command.expectedHarnessRevision,
      expectedSettingsRevision: command.expectedRevision,
      recursiveSessionsEnabled: command.recursiveSessionsEnabled,
      contextQuotaBytes: command.contextQuotaBytes,
      refinementMode: command.refinementMode,
    }));
    if (
      outcome.harnessRevision !== command.expectedHarnessRevision + 1 ||
      outcome.settings.revision !== command.expectedRevision + 1 ||
      outcome.settings.recursiveSessionsEnabled !== command.recursiveSessionsEnabled ||
      outcome.settings.contextQuotaBytes !== command.contextQuotaBytes ||
      outcome.settings.refinementMode !== command.refinementMode
    ) authorityConflict("settings authority returned an incoherent CAS result");

    const after = await this.#collectStable();
    assertProjectionAtLeast(after.projection.harness.revision, outcome.harnessRevision);
    assertProjectionAtLeast(
      after.projection.harness.settings.revision,
      outcome.settings.revision,
    );
    const result: HarnessRendererResult = {
      type: "harnessSettings",
      harnessRevision: outcome.harnessRevision,
      settings: outcome.settings,
    };
    return { result, projection: after.projection };
  }

  async #openChild(
    command: Extract<RuntimeHarnessDomainCommand, {
      type: "harness.child.open";
    }>,
  ): Promise<Readonly<{
    result: HarnessRendererResult;
    projection: HarnessRendererProjection;
  }>> {
    const before = await this.#collectStable();
    const parent = requireParent(before, command.parentPaneId);
    assertRevision(parent.revision, command.expectedParentRevision);
    const child = requireChild(parent, command.childId);
    assertRevision(child.projection.revision, command.expectedChildRevision);
    if (!child.projection.canOpen) {
      invalidState("only a proven-idle unattached child can be opened");
    }

    const outcome = openOutcomeSchema.parse(await this.#chat.openChild({
      parentPaneId: command.parentPaneId,
      parentActorId: parent.actor.id,
      childActorId: child.actor.id,
      expectedParentRevision: command.expectedParentRevision,
      expectedChildRevision: command.expectedChildRevision,
    }));
    if (
      outcome.parentPaneId !== command.parentPaneId ||
      outcome.parentActorId !== parent.actor.id ||
      outcome.childActorId !== child.actor.id ||
      outcome.parentRevision !== command.expectedParentRevision + 1 ||
      outcome.childWitness.actorId !== child.actor.id ||
      outcome.childWitness.revision !== command.expectedChildRevision + 1 ||
      outcome.binding.actorId !== child.actor.id ||
      outcome.binding.paneId !== outcome.pane.id ||
      outcome.binding.state !== "attached" ||
      outcome.pane.id === command.parentPaneId
    ) authorityConflict("chat attachment returned an incoherent CAS result");

    const openedChild = harnessChildProjectionSchema.parse({
      ...child.projection,
      revision: outcome.childWitness.revision,
      openedPaneId: outcome.pane.id,
      canOpen: false,
      canMessage: true,
    });
    assertWitness(outcome.childWitness, openedChild);

    const after = await this.#collectStable();
    const afterParent = requireParent(after, command.parentPaneId);
    const afterChild = requireChild(afterParent, command.childId);
    assertProjectionAtLeast(afterParent.revision, outcome.parentRevision);
    assertProjectionAtLeast(
      afterChild.projection.revision,
      outcome.childWitness.revision,
    );
    if (
      afterChild.projection.openedPaneId !== outcome.pane.id ||
      afterChild.projection.canOpen ||
      !afterChild.projection.canMessage
    ) {
      authorityConflict("the committed child attachment is absent from the projection");
    }
    const decoration = after.projection.panes.find(
      ({ paneId }) => paneId === outcome.pane.id,
    );
    if (decoration === undefined) {
      authorityConflict("the opened chat pane is absent from the projection");
    }
    const pane: ChatPaneProjection = chatPaneProjectionSchema.parse({
      ...outcome.pane,
      harness: decoration.harness,
    });
    const result: HarnessRendererResult = {
      type: "harnessChildOpened",
      parentPaneId: command.parentPaneId,
      parentRevision: outcome.parentRevision,
      child: openedChild,
      pane,
    };
    return { result, projection: after.projection };
  }

  async #stopChild(
    command: Extract<RuntimeHarnessDomainCommand, {
      type: "harness.child.stop";
    }>,
  ): Promise<Readonly<{
    result: HarnessRendererResult;
    projection: HarnessRendererProjection;
  }>> {
    const before = await this.#collectStable();
    const parent = requireParent(before, command.parentPaneId);
    assertRevision(parent.revision, command.expectedParentRevision);
    const child = requireChild(parent, command.childId);
    assertRevision(child.projection.revision, command.expectedChildRevision);
    if (!child.projection.canStop) invalidState("the child is already terminal");

    const outcome = stopOutcomeSchema.parse(
      await this.#coordinator.requestAndSettleStop({
        parentPaneId: command.parentPaneId,
        parentActorId: parent.actor.id,
        childActorId: child.actor.id,
        expectedParentRevision: command.expectedParentRevision,
        expectedChildRevision: command.expectedChildRevision,
      }),
    );
    if (
      outcome.parentPaneId !== command.parentPaneId ||
      outcome.parentActorId !== parent.actor.id ||
      outcome.parentRevision !== command.expectedParentRevision + 1 ||
      outcome.child.id !== child.actor.id ||
      outcome.child.state !== "stopped" ||
      outcome.childWitness.actorId !== child.actor.id ||
      outcome.childWitness.revision !== command.expectedChildRevision + 1
    ) authorityConflict("actor coordinator returned an incoherent stop result");

    const stoppedChild = harnessChildProjectionSchema.parse({
      ...child.projection,
      revision: outcome.childWitness.revision,
      state: "stopped",
      canOpen: false,
      canMessage: false,
      canStop: false,
    });
    assertWitness(outcome.childWitness, stoppedChild);

    const after = await this.#collectStable();
    const afterParent = requireParent(after, command.parentPaneId);
    const afterChild = requireChild(afterParent, command.childId);
    assertProjectionAtLeast(afterParent.revision, outcome.parentRevision);
    assertProjectionAtLeast(
      afterChild.projection.revision,
      outcome.childWitness.revision,
    );
    if (
      afterChild.projection.state !== "stopped" ||
      afterChild.projection.canOpen ||
      afterChild.projection.canMessage ||
      afterChild.projection.canStop
    ) {
      authorityConflict("the settled stop is absent from the projection");
    }
    const result: HarnessRendererResult = {
      type: "harnessChild",
      parentPaneId: command.parentPaneId,
      parentRevision: outcome.parentRevision,
      child: stoppedChild,
    };
    return { result, projection: after.projection };
  }

  async #collectStable(): Promise<CollectedProjection> {
    const first = await this.#collectOnce();
    const second = await this.#collectOnce();
    if (first.evidenceJson !== second.evidenceJson) {
      authorityConflict("the renderer authority changed during its bounded read");
    }
    return second;
  }

  async #collectOnce(): Promise<CollectedProjection> {
    const [settingsValue, proposals, paneIds] = await Promise.all([
      this.#settings.read(),
      this.#listAllProposals(),
      this.#listAllPaneIds(),
    ]);
    const settings = settingsStateSchema.parse(settingsValue);
    const derivedHarnessRevision = deriveHarnessProjectionRevision(
      settings.settings.revision,
      proposals.map(({ revision }) => revision),
    );
    if (settings.harnessRevision !== derivedHarnessRevision) {
      authorityConflict("the global revision is not derived from its visible sources");
    }

    const parentValues = await Promise.all(paneIds.map(async (paneId) => {
      const actorValue = await this.#actors.readActorForPane(paneId);
      if (actorValue === null) return null;
      const actor = actorSchema.parse(actorValue);
      const children = await this.#listAllChildren(actor);
      if (children.length === 0) return null;
      const projectedChildren = await Promise.all(children.map(
        async (child) => await this.#projectChild(actor, child),
      ));
      return {
        paneId,
        actor,
        revision: deriveHarnessParentProjectionRevision(
          projectedChildren.map(({ projection }) => projection.revision),
        ),
        children: projectedChildren,
      } satisfies ProjectedParentEvidence;
    }));

    const parents = new Map<string, ProjectedParentEvidence>();
    const actorPaneIds = new Map<string, string>();
    const childIds = new Set<string>();
    const openedPaneIds = new Set<string>();
    for (const parent of parentValues) {
      if (parent === null) continue;
      const previousPane = actorPaneIds.get(parent.actor.id);
      if (previousPane !== undefined) {
        authorityConflict("one actor is attached to multiple parent panes");
      }
      actorPaneIds.set(parent.actor.id, parent.paneId);
      for (const child of parent.children) {
        if (childIds.has(child.actor.id)) {
          authorityConflict("one actor appears under multiple parents");
        }
        childIds.add(child.actor.id);
        const openedPaneId = child.projection.openedPaneId;
        if (openedPaneId !== null) {
          if (!paneIds.includes(openedPaneId) || openedPaneIds.has(openedPaneId)) {
            authorityConflict("an opened child pane is absent or multiply attached");
          }
          openedPaneIds.add(openedPaneId);
        }
      }
      parents.set(parent.paneId, parent);
    }

    const harness = harnessSnapshotSchema.parse({
      revision: derivedHarnessRevision,
      settings: settings.settings,
      proposals,
    });
    const panes = paneIds.map((paneId) => {
      const parent = parents.get(paneId);
      if (parent === undefined) return { paneId, harness: null };
      const shown = parent.children.slice(0, runtimeHarnessChildProjectionLimit)
        .map(({ projection }) => projection);
      return {
        paneId,
        harness: chatPaneHarnessProjectionSchema.parse({
          revision: parent.revision,
          descendants: {
            count: parent.children.length,
            truncated: parent.children.length > shown.length,
            children: shown,
          },
        }),
      };
    });
    const projection = rendererProjectionSchema.parse({ harness, panes });
    const evidenceJson = JSON.stringify({
      settings,
      proposals,
      paneIds,
      parents: parentValues.map((parent) => parent === null ? null : {
        paneId: parent.paneId,
        actor: parent.actor,
        revision: parent.revision,
        children: parent.children,
      }),
    });
    return { projection, evidenceJson, parents };
  }

  async #listAllPaneIds(): Promise<readonly string[]> {
    const paneIds: string[] = [];
    let afterPaneId: string | null = null;
    for (;;) {
      const value = await this.#chat.listPaneIds({
        afterPaneId,
        limit: PANE_PAGE_SIZE,
      });
      const page = z.array(chatPaneIdSchema).max(PANE_PAGE_SIZE).parse(value);
      assertStrictPage(page, afterPaneId, "chat pane");
      for (const paneId of page) {
        paneIds.push(paneId);
        if (paneIds.length > runtimeChatPaneLimit) {
          authorityConflict("chat pane enumeration exceeds its renderer bound");
        }
      }
      if (page.length < PANE_PAGE_SIZE) return Object.freeze(paneIds);
      afterPaneId = page.at(-1) ?? null;
    }
  }

  async #listAllProposals(): Promise<readonly z.infer<
    typeof harnessProposalSummaryProjectionSchema
  >[]> {
    const proposals: z.infer<typeof harnessProposalSummaryProjectionSchema>[] = [];
    let afterProposalId: string | null = null;
    for (;;) {
      const value = await this.#proposals.list({
        afterProposalId,
        limit: PROPOSAL_PAGE_SIZE,
      });
      const page = z.array(harnessProposalSummaryProjectionSchema)
        .max(PROPOSAL_PAGE_SIZE).parse(value);
      assertStrictPage(page.map(({ id }) => id), afterProposalId, "proposal");
      proposals.push(...page);
      if (proposals.length > runtimeHarnessProposalProjectionLimit) {
        authorityConflict("active proposal enumeration exceeds its renderer bound");
      }
      if (page.length < PROPOSAL_PAGE_SIZE) return Object.freeze(proposals);
      afterProposalId = page.at(-1)?.id ?? null;
    }
  }

  async #listAllChildren(parent: Actor): Promise<readonly Actor[]> {
    const children: Actor[] = [];
    let afterActorId: string | null = null;
    for (;;) {
      const value = await this.#actors.listActorChildren({
        parentActorId: parent.id,
        afterActorId,
        limit: CHILD_PAGE_SIZE,
      });
      const page = z.array(actorSchema).max(CHILD_PAGE_SIZE).parse(value);
      assertStrictPage(page.map(({ id }) => id), afterActorId, "child actor");
      for (const child of page) {
        if (
          child.parentActorId !== parent.id || child.epochId !== parent.epochId ||
          child.depth !== parent.depth + 1
        ) authorityConflict("child actor lineage is incoherent");
        children.push(child);
        if (children.length > MAX_DURABLE_CHILDREN) {
          authorityConflict("child enumeration exceeds the durable actor bound");
        }
      }
      if (page.length < CHILD_PAGE_SIZE) return Object.freeze(children);
      afterActorId = page.at(-1)?.id ?? null;
    }
  }

  async #projectChild(
    parent: Actor,
    actor: Actor,
  ): Promise<ProjectedChildEvidence> {
    const [incarnationValue, turnValue, bindingValue, witnessValue] =
      await Promise.all([
        this.#actors.readActiveIncarnationForActor(actor.id),
        this.#actors.readLatestActorTurnForActor(actor.id),
        this.#actors.readPaneBindingForActor(actor.id),
        this.#actors.readProjectionWitness(actor.id),
      ]);
    const incarnation = actorIncarnationRecordSchema.nullable()
      .parse(incarnationValue);
    const latestTurn = actorTurnSchema.nullable().parse(turnValue);
    const binding = actorPaneBindingSchema.nullable().parse(bindingValue);
    const witness = projectionWitnessSchema.parse(witnessValue);
    if (
      actor.parentActorId !== parent.id || actor.epochId !== parent.epochId ||
      (incarnation !== null && incarnation.actorId !== actor.id) ||
      (latestTurn !== null &&
        (latestTurn.actorId !== actor.id || latestTurn.epochId !== actor.epochId)) ||
      (binding !== null &&
        (binding.actorId !== actor.id || binding.state !== "attached")) ||
      witness.actorId !== actor.id
    ) authorityConflict("child actor projection sources are incoherent");
    if (
      (actor.nextTurnOrdinal === 1) !== (latestTurn === null) ||
      (latestTurn !== null && latestTurn.ordinal !== actor.nextTurnOrdinal - 1)
    ) authorityConflict("latest actor turn does not match its durable ordinal");

    const state = deriveHarnessChildState({ actor, incarnation, latestTurn });
    const actions = deriveHarnessChildActions({
      actor,
      incarnation,
      latestTurn,
      binding,
    });
    const projection = harnessChildProjectionSchema.parse({
      id: actor.id,
      revision: witness.revision,
      title: actor.title,
      state,
      openedPaneId: binding?.paneId ?? null,
      ...actions,
      canStop: state !== "stopped" && state !== "quarantined",
    });
    assertWitness(witness, projection);
    return { actor, incarnation, latestTurn, binding, witness, projection };
  }
}

export function deriveHarnessChildState(input: Readonly<{
  actor: Actor;
  incarnation: ActorIncarnationRecord | null;
  latestTurn: ActorTurn | null;
}>): HarnessChildProjection["state"] {
  if (input.actor.state === "quarantined") return "quarantined";
  if (input.actor.state === "stopped") return "stopped";
  const turn = input.latestTurn;
  if (turn === null) {
    if (input.actor.state === "stopRequested" && input.incarnation === null) {
      return "idle";
    }
    return input.incarnation?.state === "idle" ? "idle" : "starting";
  }
  switch (turn.state) {
    case "prepared":
    case "starting":
      return "starting";
    case "running":
      return "running";
    case "reconciling":
      return "waiting";
    case "succeeded":
    case "cancelled":
      return "idle";
    case "failed":
    case "quotaRejected":
      return "failed";
    case "ambiguous":
      return "quarantined";
  }
}

export interface HarnessChildActions {
  readonly canOpen: boolean;
  readonly canMessage: boolean;
}

/**
 * Derives the complete renderer action set from durable actor authority.
 *
 * A provider thread alone is insufficient. The actor and incarnation must be
 * active and idle, and the latest logical turn must have one definitive
 * terminal outcome. Ambiguous work and every live/cleanup state fail closed.
 */
export function deriveHarnessChildActions(input: Readonly<{
  actor: Actor;
  incarnation: ActorIncarnationRecord | null;
  latestTurn: ActorTurn | null;
  binding: ActorPaneBinding | null;
}>): HarnessChildActions {
  const terminal = input.latestTurn?.state;
  const definitiveTerminal = terminal === "succeeded" ||
    terminal === "cancelled" || terminal === "failed" ||
    terminal === "quotaRejected";
  const provenIdle = input.actor.state === "active" &&
    input.incarnation?.state === "idle" &&
    input.incarnation.providerThreadId !== null &&
    definitiveTerminal;
  if (!provenIdle) return { canOpen: false, canMessage: false };
  if (input.binding === null) return { canOpen: true, canMessage: false };
  if (input.binding.state !== "attached") {
    return { canOpen: false, canMessage: false };
  }
  return { canOpen: false, canMessage: true };
}

export function harnessChildSemanticDigest(
  childValue: Omit<HarnessChildProjection, "revision">,
): string {
  const child = harnessChildProjectionSchema.parse({
    ...childValue,
    revision: 1,
  });
  return createHash("sha256")
    .update("oprte.harness.renderer-child.v2\0", "utf8")
    .update(JSON.stringify([
      child.id,
      child.title,
      child.state,
      child.openedPaneId,
      child.canOpen,
      child.canMessage,
      child.canStop,
    ]), "utf8")
    .digest("hex");
}

export function deriveHarnessProjectionRevision(
  settingsRevision: number,
  activeProposalRevisions: readonly number[],
): number {
  return checkedRevisionSum([settingsRevision, ...activeProposalRevisions]);
}

export function deriveHarnessParentProjectionRevision(
  childRevisions: readonly number[],
): number {
  return checkedRevisionSum(childRevisions);
}

function assertWitness(
  witness: z.infer<typeof projectionWitnessSchema>,
  child: HarnessChildProjection,
): void {
  const semanticDigest = harnessChildSemanticDigest({
    id: child.id,
    title: child.title,
    state: child.state,
    openedPaneId: child.openedPaneId,
    canOpen: child.canOpen,
    canMessage: child.canMessage,
    canStop: child.canStop,
  });
  if (
    witness.actorId !== child.id || witness.revision !== child.revision ||
    witness.semanticDigest !== semanticDigest
  ) authorityConflict("child projection witness does not bind its semantic state");
}

function checkedRevisionSum(values: readonly number[]): number {
  if (values.length === 0) authorityConflict("a projection revision needs a source");
  let total = 0;
  for (const value of values) {
    total += revisionSchema.parse(value);
    if (!Number.isSafeInteger(total) || total <= 0) {
      authorityConflict("projection revision overflowed its safe integer bound");
    }
  }
  return total;
}

function assertStrictPage(
  ids: readonly string[],
  after: string | null,
  label: string,
): void {
  let previous = after;
  for (const id of ids) {
    if (previous !== null && id <= previous) {
      authorityConflict(`${label} page is duplicated or out of order`);
    }
    previous = id;
  }
}

function requireParent(
  state: CollectedProjection,
  paneId: string,
): ProjectedParentEvidence {
  const parent = state.parents.get(paneId);
  if (parent === undefined) notFound("the parent pane has no recursive children");
  return parent;
}

function requireChild(
  parent: ProjectedParentEvidence,
  childId: string,
): ProjectedChildEvidence {
  const child = parent.children.find(({ actor }) => actor.id === childId);
  if (child === undefined) notFound("the recursive child is unavailable");
  return child;
}

function assertRevision(actual: number, expected: number): void {
  if (actual !== expected) staleRevision("the projection revision changed");
}

function assertProjectionAtLeast(actual: number, committed: number): void {
  if (actual < committed) {
    authorityConflict("the post-commit projection precedes its mutation receipt");
  }
}

function normalizeAuthorityError(error: unknown): HarnessRendererAuthorityV2Error {
  if (error instanceof HarnessRendererAuthorityV2Error) return error;
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (code === "stale_revision" || code === "revision_conflict") {
      return new HarnessRendererAuthorityV2Error(
        "stale_revision",
        "the projection revision changed",
        error,
      );
    }
    if (code === "not_found") {
      return new HarnessRendererAuthorityV2Error(
        "not_found",
        "the requested harness object is unavailable",
        error,
      );
    }
    if (code === "invalid_state" || code === "invalid_transition") {
      return new HarnessRendererAuthorityV2Error(
        "invalid_state",
        "the requested harness transition is unavailable",
        error,
      );
    }
  }
  return new HarnessRendererAuthorityV2Error(
    "authority_conflict",
    "the harness renderer authority is incoherent",
    error,
  );
}

function authorityConflict(message: string): never {
  throw new HarnessRendererAuthorityV2Error("authority_conflict", message);
}

function invalidState(message: string): never {
  throw new HarnessRendererAuthorityV2Error("invalid_state", message);
}

function notFound(message: string): never {
  throw new HarnessRendererAuthorityV2Error("not_found", message);
}

function staleRevision(message: string): never {
  throw new HarnessRendererAuthorityV2Error("stale_revision", message);
}
