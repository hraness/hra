import type { Database } from "bun:sqlite";
import {
  promotionEntityFamilyValues,
  taskDomain,
  type PromotionEntity,
  type PromotionManifestV2,
} from "@hraness/agent-tasks-protocol";
import { z } from "@hra-internal/schema";

import { LocalPromotionError } from "./contracts";

const encoder = new TextEncoder();
const MAX_PROMOTION_ENTITY_BYTES = 512 * 1_024;
const OMITTED_TEST_EVIDENCE_NOTE =
  "Local verification evidence was recorded; its command was omitted during promotion.";

const workspaceRowSchema = z.object({
  workspace_id: taskDomain.workspacePublicIdSchema,
  name: taskDomain.workspaceNameSchema,
  slug: taskDomain.workspaceSlugSchema,
  key_prefix: taskDomain.taskKeyPrefixSchema,
  revision: taskDomain.revisionSchema,
  event_sequence: taskDomain.workspaceEventSequenceSchema,
  authority_kind: z.enum(["local", "promoting", "cloud"]),
  owner_installation_id: taskDomain.runnerInstallationIdSchema,
}).strict();

const terminalWorkRowSchema = z.object({
  queued_intents: z.number().int().nonnegative().safe(),
  active_claims: z.number().int().nonnegative().safe(),
  nonterminal_runs: z.number().int().nonnegative().safe(),
  open_interactions: z.number().int().nonnegative().safe(),
  in_progress_tasks: z.number().int().nonnegative().safe(),
}).strict();

const repositoryRowSchema = z.object({
  repository_id: taskDomain.repositoryIdSchema,
  name: taskDomain.repositoryNameSchema,
  provider: taskDomain.repositoryProviderSchema.nullable(),
  public_url: z.string().nullable(),
}).strict();

const executorRowSchema = z.object({
  agent_id: taskDomain.agentIdSchema,
  enabled: z.number().int().min(0).max(1),
}).strict();

const taskRowSchema = z.object({
  task_id: taskDomain.taskPublicIdSchema,
  task_key: taskDomain.taskKeySchema,
  title: taskDomain.taskTitleSchema,
  task_type: taskDomain.taskTypeSchema,
  priority: taskDomain.taskPrioritySchema,
  status: taskDomain.taskStatusSchema,
  available_at: taskDomain.epochMsSchema,
  assignee_agent_id: taskDomain.agentIdSchema.nullable(),
  parent_task_id: taskDomain.taskPublicIdSchema.nullable(),
  repository_id: taskDomain.repositoryIdSchema.nullable(),
  revision: taskDomain.revisionSchema,
  review_revision: taskDomain.revisionSchema,
  completed_at: taskDomain.epochMsSchema.nullable(),
  cancelled_at: taskDomain.epochMsSchema.nullable(),
}).strict();

const bodyRowSchema = z.object({
  task_id: taskDomain.taskPublicIdSchema,
  description: taskDomain.taskDescriptionSchema,
}).strict();

const dependencyRowSchema = z.object({
  blocker_task_id: taskDomain.taskPublicIdSchema,
  blocked_task_id: taskDomain.taskPublicIdSchema,
}).strict();

const labelRowSchema = z.object({
  task_id: taskDomain.taskPublicIdSchema,
  label: taskDomain.taskLabelSchema,
}).strict();

const commentRowSchema = z.object({
  task_id: taskDomain.taskPublicIdSchema,
  comment_id: taskDomain.taskCommentIdSchema,
  actor_json: z.string().min(2).max(16 * 1_024),
  body: taskDomain.taskCommentBodySchema,
  created_at: taskDomain.epochMsSchema,
}).strict();

const referenceRowSchema = z.object({
  task_id: taskDomain.taskPublicIdSchema,
  reference_json: z.string().min(2).max(16 * 1_024),
}).strict();

const submissionRowSchema = z.object({
  task_id: taskDomain.taskPublicIdSchema,
  submission_id: taskDomain.taskSubmissionIdSchema,
  review_revision: taskDomain.revisionSchema,
  summary: taskDomain.submissionSummarySchema,
  evidence_json: z.string().min(2).max(256 * 1_024),
  status: z.enum(["pending", "accepted", "rejected", "cancelled"]),
  reviewed_at: taskDomain.epochMsSchema.nullable(),
}).strict();

const reviewRowSchema = z.object({
  task_id: taskDomain.taskPublicIdSchema,
  submission_id: taskDomain.taskSubmissionIdSchema,
  decision: z.enum(["accepted", "rejected", "cancelled"]),
  reviewer_json: z.string().min(2).max(16 * 1_024),
  reason: z.string().nullable(),
  reviewed_at: taskDomain.epochMsSchema,
}).strict();

export interface LocalPromotionSnapshotDraft {
  readonly manifest: PromotionManifestV2;
  readonly entities: readonly PromotionEntity[];
  readonly ownerInstallationId: string;
  readonly serializedEntityBytes: number;
}

/**
 * This function deliberately has no transaction boundary of its own. The
 * store invokes it only from the same immediate transaction that persists the
 * rows and freezes workspace authority.
 */
export function buildLocalPromotionSnapshotWithinTransaction(
  database: Database,
  inputValue: unknown,
): LocalPromotionSnapshotDraft {
  const input = z.object({
    workspaceId: taskDomain.workspacePublicIdSchema,
    promotionId: taskDomain.promotionIdSchema,
    now: taskDomain.epochMsSchema,
  }).strict().parse(inputValue);

  let workspace: z.infer<typeof workspaceRowSchema>;
  try {
    const value: unknown = database.query(`
      SELECT workspace_id, name, slug, key_prefix, revision, event_sequence,
        authority_kind, owner_installation_id
      FROM local_workspaces
      WHERE workspace_id = ?1 AND tombstoned_at IS NULL
    `).get(input.workspaceId);
    if (value === null) throw new LocalPromotionError("workspace_not_found");
    workspace = workspaceRowSchema.parse(value);
  } catch (error: unknown) {
    if (error instanceof LocalPromotionError) throw error;
    throw new LocalPromotionError("snapshot_invalid");
  }
  if (workspace.authority_kind !== "local") {
    throw new LocalPromotionError("authority_conflict");
  }

  const terminalWork = terminalWorkRowSchema.parse(database.query(`
    SELECT
      (SELECT count(*) FROM local_queued_run_intents
        WHERE workspace_id = ?1 AND state IN ('queued', 'claimed', 'started'))
        AS queued_intents,
      (SELECT count(*) FROM local_task_claims
        WHERE workspace_id = ?1 AND state = 'active') AS active_claims,
      (SELECT count(*) FROM local_task_runs
        WHERE workspace_id = ?1 AND phase IN (
          'queued', 'leased', 'provisioning', 'starting', 'running',
          'waiting', 'cancel_requested', 'ambiguous'
        )) AS nonterminal_runs,
      (SELECT count(*) FROM local_run_interactions
        WHERE workspace_id = ?1 AND state IN ('pending', 'answered'))
        AS open_interactions,
      (SELECT count(*) FROM local_tasks
        WHERE workspace_id = ?1 AND status = 'in_progress')
        AS in_progress_tasks
  `).get(input.workspaceId));
  if (
    terminalWork.queued_intents !== 0 ||
    terminalWork.active_claims !== 0 ||
    terminalWork.nonterminal_runs !== 0 ||
    terminalWork.open_interactions !== 0
  ) {
    throw new LocalPromotionError("live_local_work");
  }
  if (terminalWork.in_progress_tasks !== 0) {
    throw new LocalPromotionError("nonportable_task_state");
  }

  const rawCount = z.object({
    count: z.number().int().nonnegative().safe(),
  }).strict().parse(database.query(`
    SELECT
      2
      + (
        SELECT count(*)
        FROM local_workspace_repositories AS membership
        JOIN local_repositories AS repository
          ON repository.repository_id = membership.repository_id
        WHERE membership.workspace_id = ?1
          AND repository.tombstoned_at IS NULL
      )
      + (SELECT count(*) FROM local_tasks WHERE workspace_id = ?1)
      + (SELECT count(*) FROM local_task_bodies WHERE workspace_id = ?1)
      + (
        SELECT count(*) FROM local_tasks
        WHERE workspace_id = ?1 AND repository_id IS NOT NULL
      )
      + (
        SELECT count(*) FROM local_tasks
        WHERE workspace_id = ?1 AND parent_task_id IS NOT NULL
      )
      + (
        SELECT count(*) FROM local_tasks
        WHERE workspace_id = ?1 AND status IN ('done', 'cancelled')
      )
      + (SELECT count(*) FROM local_task_dependencies WHERE workspace_id = ?1)
      + (SELECT count(*) FROM local_task_labels WHERE workspace_id = ?1)
      + (SELECT count(*) FROM local_task_comments WHERE workspace_id = ?1)
      + (SELECT count(*) FROM local_task_references WHERE workspace_id = ?1)
      + (SELECT count(*) FROM local_task_submissions WHERE workspace_id = ?1)
      + (SELECT count(*) FROM local_task_reviews WHERE workspace_id = ?1)
      + (
        SELECT count(*)
        FROM local_task_submissions AS submission
        WHERE submission.workspace_id = ?1
          AND submission.status = 'cancelled'
          AND NOT EXISTS (
            SELECT 1
            FROM local_task_reviews AS review
            WHERE review.workspace_id = submission.workspace_id
              AND review.submission_id = submission.submission_id
          )
      )
      AS count
  `).get(input.workspaceId)).count;
  if (rawCount > taskDomain.MAX_PROMOTION_SNAPSHOT_ENTITIES) {
    throw new LocalPromotionError("snapshot_capacity_exceeded");
  }

  const entities: PromotionEntity[] = [];
  entities.push(parseEntity({
    family: "workspace_metadata",
    workspaceId: workspace.workspace_id,
    name: workspace.name,
    slug: workspace.slug,
    keyPrefix: workspace.key_prefix,
  }));

  const executorValues: unknown[] = database.query(`
    SELECT agent_id, enabled FROM local_builtin_executors
    WHERE workspace_id = ?1 ORDER BY agent_id
  `).all(input.workspaceId);
  const executors = executorValues.map((value) => executorRowSchema.parse(value));
  if (
    executors.length !== 1 ||
    executors[0]?.agent_id !== "builtin_local_codex" ||
    executors[0]?.enabled !== 1
  ) {
    throw new LocalPromotionError("nonportable_executor");
  }
  entities.push(parseEntity({
    family: "executors",
    workspaceId: workspace.workspace_id,
    executor: "local_codex",
    enabled: true,
  }));

  const repositoryValues: unknown[] = database.query(`
    SELECT repository.repository_id, repository.name, repository.provider,
      repository.public_url
    FROM local_workspace_repositories AS membership
    JOIN local_repositories AS repository
      ON repository.repository_id = membership.repository_id
    WHERE membership.workspace_id = ?1 AND repository.tombstoned_at IS NULL
    ORDER BY repository.repository_id
  `).all(input.workspaceId);
  const repositories = repositoryValues.map((value) =>
    repositoryRowSchema.parse(value));
  for (const repository of repositories) {
    if (repository.provider === null || repository.public_url === null) {
      throw new LocalPromotionError("unsafe_repository");
    }
    try {
      entities.push(parseEntity({
        family: "repositories",
        id: repository.repository_id,
        name: repository.name,
        provider: repository.provider,
        url: repository.public_url,
      }));
    } catch {
      throw new LocalPromotionError("unsafe_repository");
    }
  }

  const taskValues: unknown[] = database.query(`
    SELECT task_id, task_key, title, task_type, priority, status, available_at,
      assignee_agent_id, parent_task_id, repository_id, revision,
      review_revision, completed_at, cancelled_at
    FROM local_tasks
    WHERE workspace_id = ?1
    ORDER BY task_id
  `).all(input.workspaceId);
  const tasks = taskValues.map((value) => taskRowSchema.parse(value));
  for (const task of tasks) {
    if (task.status === "in_progress") {
      throw new LocalPromotionError("nonportable_task_state");
    }
    if (
      task.assignee_agent_id !== null &&
      task.assignee_agent_id !== "builtin_local_codex"
    ) {
      throw new LocalPromotionError("nonportable_executor");
    }
    entities.push(parseEntity({
      family: "tasks",
      id: task.task_id,
      key: task.task_key,
      title: task.title,
      type: task.task_type,
      priority: task.priority,
      status: task.status,
      availableAt: task.available_at,
      revision: task.revision,
      reviewRevision: task.review_revision,
      ...(task.assignee_agent_id === null
        ? {}
        : { assignee: { kind: "builtin_executor" as const } }),
    }));
    if (task.repository_id !== null) {
      entities.push(parseEntity({
        family: "task_repository_links",
        relationKey: taskDomain.taskRepositoryRelationKey(
          task.task_id,
          task.repository_id,
        ),
        taskId: task.task_id,
        repositoryId: task.repository_id,
      }));
    }
    if (task.parent_task_id !== null) {
      entities.push(parseEntity({
        family: "parent_edges",
        relationKey: taskDomain.parentRelationKey(
          task.task_id,
          task.parent_task_id,
        ),
        taskId: task.task_id,
        parentTaskId: task.parent_task_id,
      }));
    }
  }

  const bodyValues: unknown[] = database.query(`
    SELECT task_id, description FROM local_task_bodies
    WHERE workspace_id = ?1 ORDER BY task_id
  `).all(input.workspaceId);
  for (const value of bodyValues) {
    const body = bodyRowSchema.parse(value);
    entities.push(parseEntity({
      family: "task_bodies",
      taskId: body.task_id,
      description: body.description,
    }));
  }

  const dependencyValues: unknown[] = database.query(`
    SELECT blocker_task_id, blocked_task_id FROM local_task_dependencies
    WHERE workspace_id = ?1 ORDER BY blocker_task_id, blocked_task_id
  `).all(input.workspaceId);
  for (const value of dependencyValues) {
    const dependency = dependencyRowSchema.parse(value);
    entities.push(parseEntity({
      family: "dependencies",
      relationKey: taskDomain.dependencyRelationKey(
        dependency.blocker_task_id,
        dependency.blocked_task_id,
      ),
      blockerTaskId: dependency.blocker_task_id,
      blockedTaskId: dependency.blocked_task_id,
    }));
  }

  const labelValues: unknown[] = database.query(`
    SELECT task_id, label FROM local_task_labels
    WHERE workspace_id = ?1 ORDER BY task_id, label
  `).all(input.workspaceId);
  for (const value of labelValues) {
    const label = labelRowSchema.parse(value);
    entities.push(parseEntity({
      family: "labels",
      relationKey: taskDomain.taskLabelRelationKey(label.task_id, label.label),
      taskId: label.task_id,
      label: label.label,
    }));
  }

  const commentValues: unknown[] = database.query(`
    SELECT task_id, comment_id, actor_json, body, created_at
    FROM local_task_comments
    WHERE workspace_id = ?1 ORDER BY comment_id
  `).all(input.workspaceId);
  for (const value of commentValues) {
    const comment = commentRowSchema.parse(value);
    entities.push(parseEntity({
      family: "comments",
      id: comment.comment_id,
      taskId: comment.task_id,
      body: comment.body,
      authorProvenance: actorProvenance(comment.actor_json),
      createdAt: comment.created_at,
    }));
  }

  const referenceValues: unknown[] = database.query(`
    SELECT task_id, reference_json FROM local_task_references
    WHERE workspace_id = ?1 ORDER BY reference_id
  `).all(input.workspaceId);
  for (const value of referenceValues) {
    const reference = referenceRowSchema.parse(value);
    try {
      entities.push(parseEntity({
        family: "references",
        taskId: reference.task_id,
        reference: taskDomain.taskReferenceViewSchema.parse(
          parseJson(reference.reference_json),
        ),
      }));
    } catch {
      throw new LocalPromotionError("nonportable_reference");
    }
  }

  const submissionValues: unknown[] = database.query(`
    SELECT task_id, submission_id, review_revision, summary, evidence_json,
      status, reviewed_at
    FROM local_task_submissions
    WHERE workspace_id = ?1 ORDER BY submission_id
  `).all(input.workspaceId);
  const submissions = submissionValues.map((value) =>
    submissionRowSchema.parse(value));
  for (const submission of submissions) {
    entities.push(parseEntity({
      family: "submissions",
      taskId: submission.task_id,
      submissionId: submission.submission_id,
      reviewRevision: submission.review_revision,
      status: submission.status,
      summary: submission.summary,
      evidence: sanitizedEvidence(submission.evidence_json),
    }));
  }

  const reviewValues: unknown[] = database.query(`
    SELECT submission.task_id, review.submission_id, review.decision,
      review.reviewer_json, review.reason, review.reviewed_at
    FROM local_task_reviews AS review
    JOIN local_task_submissions AS submission
      ON submission.workspace_id = review.workspace_id
      AND submission.submission_id = review.submission_id
    WHERE review.workspace_id = ?1
    ORDER BY review.submission_id
  `).all(input.workspaceId);
  const reviewedSubmissions = new Set<string>();
  for (const value of reviewValues) {
    const review = reviewRowSchema.parse(value);
    reviewedSubmissions.add(review.submission_id);
    const base = {
      family: "reviews" as const,
      taskId: review.task_id,
      submissionId: review.submission_id,
      reviewerProvenance: actorProvenance(review.reviewer_json),
      reviewedAt: review.reviewed_at,
    };
    entities.push(parseEntity(
      review.decision === "accepted"
        ? { ...base, decision: "accepted" }
        : {
            ...base,
            decision: review.decision,
            reason: review.reason ??
              "The source review did not retain a portable reason.",
          },
    ));
  }
  for (const submission of submissions) {
    if (
      submission.status !== "cancelled" ||
      reviewedSubmissions.has(submission.submission_id)
    ) {
      continue;
    }
    if (submission.reviewed_at === null) {
      throw new LocalPromotionError("snapshot_invalid");
    }
    entities.push(parseEntity({
      family: "reviews",
      taskId: submission.task_id,
      submissionId: submission.submission_id,
      reviewerProvenance: "system",
      reviewedAt: submission.reviewed_at,
      decision: "cancelled",
      reason: "Cancelled with the source task before promotion.",
    }));
  }

  const submissionsByTask = new Map<string, typeof submissions>();
  for (const submission of submissions) {
    const current = submissionsByTask.get(submission.task_id);
    if (current === undefined) {
      submissionsByTask.set(submission.task_id, [submission]);
    } else {
      current.push(submission);
    }
  }
  for (const task of tasks) {
    if (task.status === "done") {
      const accepted = (submissionsByTask.get(task.task_id) ?? []).filter(
        (submission) =>
          submission.status === "accepted" &&
          submission.review_revision === task.review_revision,
      );
      if (accepted.length !== 1 || task.completed_at === null) {
        throw new LocalPromotionError("snapshot_invalid");
      }
      entities.push(parseEntity({
        family: "terminal_states",
        taskId: task.task_id,
        terminalAt: task.completed_at,
        status: "done",
        acceptedSubmissionId: accepted[0]?.submission_id,
      }));
    } else if (task.status === "cancelled") {
      if (task.cancelled_at === null) {
        throw new LocalPromotionError("snapshot_invalid");
      }
      entities.push(parseEntity({
        family: "terminal_states",
        taskId: task.task_id,
        terminalAt: task.cancelled_at,
        status: "cancelled",
      }));
    }
  }

  if (entities.length > taskDomain.MAX_PROMOTION_SNAPSHOT_ENTITIES) {
    throw new LocalPromotionError("snapshot_capacity_exceeded");
  }
  entities.sort((left, right) => {
    const familyOrder = promotionEntityFamilyValues.indexOf(left.family) -
      promotionEntityFamilyValues.indexOf(right.family);
    if (familyOrder !== 0) return familyOrder;
    return compareText(
      taskDomain.promotionEntityIdentity(left),
      taskDomain.promotionEntityIdentity(right),
    );
  });

  const counts = taskDomain.promotionEntityCountsSchema.parse(
    Object.fromEntries(
      promotionEntityFamilyValues.map((family) => [
        family,
        entities.filter((entity) => entity.family === family).length,
      ]),
    ),
  );
  const v1ManifestBase = {
    schemaVersion: 1 as const,
    promotionId: input.promotionId,
    sourceWorkspaceId: workspace.workspace_id,
    sourceWorkspaceRevision: workspace.revision,
    sourceEventSequence: workspace.event_sequence,
    createdAt: input.now,
    rootDigest: `sha256_${"0".repeat(64)}`,
    counts,
    repositoryIds: repositories.map(({ repository_id: repositoryId }) =>
      repositoryId),
    taskIds: tasks.map(({ task_id: taskId }) => taskId),
    terminalLocalWork: {
      queuedIntents: 0 as const,
      activeClaims: 0 as const,
      nonterminalRuns: 0 as const,
      openInteractions: 0 as const,
    },
  };
  try {
    const digestInputManifest = taskDomain.promotionManifestSchema.parse(
      v1ManifestBase,
    );
    const v1Root = taskDomain.promotionSnapshotRootDigest({
      manifest: digestInputManifest,
      entities,
    });
    taskDomain.promotionSnapshotSchema.parse({
      manifest: { ...v1ManifestBase, rootDigest: v1Root },
      entities,
    });
  } catch {
    throw new LocalPromotionError("snapshot_invalid");
  }

  const familyDigests = taskDomain.promotionSnapshotFamilyDigests(entities);
  const v2ManifestBase = {
    schemaVersion: 2 as const,
    promotionId: input.promotionId,
    sourceWorkspaceId: workspace.workspace_id,
    sourceWorkspaceRevision: workspace.revision,
    sourceEventSequence: workspace.event_sequence,
    createdAt: input.now,
    rootDigest: `sha256_${"0".repeat(64)}`,
    counts,
    familyDigests,
    terminalLocalWork: {
      queuedIntents: 0 as const,
      activeClaims: 0 as const,
      nonterminalRuns: 0 as const,
      openInteractions: 0 as const,
    },
  };
  const manifest = taskDomain.promotionManifestV2Schema.parse({
    ...v2ManifestBase,
    rootDigest: taskDomain.promotionManifestV2RootDigest(v2ManifestBase),
  });
  let serializedEntityBytes = 0;
  for (const entity of entities) {
    const bytes = encoder.encode(taskDomain.canonicalPromotionJson(entity)).length;
    if (bytes > MAX_PROMOTION_ENTITY_BYTES) {
      throw new LocalPromotionError("snapshot_capacity_exceeded");
    }
    serializedEntityBytes += bytes;
    if (!Number.isSafeInteger(serializedEntityBytes)) {
      throw new LocalPromotionError("snapshot_capacity_exceeded");
    }
  }
  return {
    manifest,
    entities,
    ownerInstallationId: workspace.owner_installation_id,
    serializedEntityBytes,
  };
}

function parseEntity(value: unknown): PromotionEntity {
  return taskDomain.promotionEntitySchema.parse(value);
}

function actorProvenance(
  actorJson: string,
): "local_owner" | "local_agent" | "system" {
  const actor = taskDomain.projectionActorSchema.parse(parseJson(actorJson));
  switch (actor.kind) {
    case "human":
    case "local_owner":
      return "local_owner";
    case "agent":
      return "local_agent";
    case "system":
      return "system";
  }
}

function sanitizedEvidence(source: string): readonly unknown[] {
  let evidence: readonly z.infer<typeof taskDomain.submissionEvidenceInputSchema>[];
  try {
    evidence = z.array(taskDomain.submissionEvidenceInputSchema)
      .max(taskDomain.MAX_SUBMISSION_EVIDENCE)
      .parse(parseJson(source));
  } catch {
    throw new LocalPromotionError("nonportable_evidence");
  }
  return evidence.map((item) => {
    const candidate = item.kind === "test"
      ? { kind: "note" as const, text: OMITTED_TEST_EVIDENCE_NOTE }
      : item;
    const parsed = taskDomain.sanitizedImportedEvidenceSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new LocalPromotionError("nonportable_evidence");
    }
    return parsed.data;
  });
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new LocalPromotionError("snapshot_invalid");
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
