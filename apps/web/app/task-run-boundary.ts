import {
  portableRunInteractionRequestSchema,
  portableRunProjectionSchema,
  type PortableRunInteractionRequest,
  type PortableRunProjection,
} from "@hraness/agent-tasks-domain";
import {
  taskRunViewSchema,
  type RunInteractionRequest,
} from "@hraness/agent-tasks-protocol";

export function toPortableRunInteractionRequest(
  request: RunInteractionRequest,
) {
  if (request.kind === "file_change_approval") {
    return {
      id: request.id,
      createdAt: request.createdAt,
      expiresAt: request.expiresAt,
      kind: request.kind,
      scope: request.scope,
    };
  }
  return {
    id: request.id,
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
    kind: request.kind,
    questions: request.questions.map((question) => ({
      id: question.id,
      header: question.header,
      prompt: question.prompt,
      allowOther: question.allowOther,
      options: question.options.map((option) => ({
        id: option.id,
        label: option.label,
        ...(option.description === undefined
          ? {}
          : { description: option.description }),
      })),
    })),
  };
}

/** Converts provider-shaped run views into the exact renderer-safe contract. */
export function normalizeTaskRuns(
  values: readonly unknown[],
  taskKey: string,
): readonly PortableRunProjection[] | null {
  const runs: PortableRunProjection[] = [];
  const runIds = new Set<string>();
  for (const value of values) {
    const providerRun = taskRunViewSchema.safeParse(value);
    if (
      !providerRun.success ||
      providerRun.data.taskKey !== taskKey ||
      runIds.has(providerRun.data.id)
    ) {
      return null;
    }
    const portableRun = portableRunProjectionSchema.safeParse({
      id: providerRun.data.id,
      taskKey: providerRun.data.taskKey,
      phase: providerRun.data.phase,
      repositoryId: providerRun.data.repositoryId,
      desiredState: providerRun.data.desiredState,
      updatedAt: providerRun.data.updatedAt,
      events: providerRun.data.events,
      interactions: providerRun.data.interactions.map((interaction) => ({
        runId: interaction.runId,
        request: toPortableRunInteractionRequest(interaction.request),
        state: interaction.state,
        ...(interaction.responseRevision === undefined
          ? {}
          : { responseRevision: interaction.responseRevision }),
        ...(interaction.respondedAt === undefined
          ? {}
          : { respondedAt: interaction.respondedAt }),
        ...(interaction.resolvedAt === undefined
          ? {}
          : { resolvedAt: interaction.resolvedAt }),
      })),
    });
    if (!portableRun.success) return null;
    runIds.add(portableRun.data.id);
    runs.push(portableRun.data);
  }
  return runs;
}

/**
 * Looks up provider-only reply metadata after the UI returns a portable request.
 * Exact request equality prevents a stale or fabricated UI value from selecting
 * another provider binding.
 */
export function resolveRunInteractionRequest(
  values: readonly unknown[],
  input: Readonly<{
    interactionId: string;
    request: PortableRunInteractionRequest;
    runId: string;
  }>,
): RunInteractionRequest | null {
  const portableRequest = portableRunInteractionRequestSchema.safeParse(input.request);
  if (
    !portableRequest.success ||
    portableRequest.data.id !== input.interactionId
  ) {
    return null;
  }
  let match: RunInteractionRequest | null = null;
  for (const value of values) {
    const run = taskRunViewSchema.safeParse(value);
    if (!run.success || run.data.id !== input.runId) continue;
    for (const interaction of run.data.interactions) {
      if (interaction.request.id !== input.interactionId) continue;
      if (
        match !== null ||
        JSON.stringify(toPortableRunInteractionRequest(interaction.request)) !==
          JSON.stringify(portableRequest.data)
      ) {
        return null;
      }
      match = interaction.request;
    }
  }
  return match;
}
