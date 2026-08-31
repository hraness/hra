import { publicRepository } from "./release-distribution-policy";

type JsonRecord = Record<string, unknown>;

const SHA = /^[0-9a-f]{40}$/u;
const POSITIVE_DECIMAL = /^[1-9][0-9]{0,19}$/u;
const MAXIMUM_RELEASE_INVENTORY_PAGE = 100;
const GITHUB_RELEASE_JOB_NAME = "Publish exact npm and GitHub artifacts";
const GITHUB_RELEASE_STEP_NAME = "Create immutable GitHub Release from the same bytes";

function record(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as JsonRecord;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return Number(value);
}

function decimal(value: unknown, label: string): string {
  if (typeof value !== "string" || !POSITIVE_DECIMAL.test(value) || BigInt(value) <= 0n) {
    throw new Error(`${label} must be a positive decimal string.`);
  }
  return value;
}

function exactKeys(value: JsonRecord, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new Error(`${label} has unexpected fields.`);
  }
}

export type ReleaseInventoryPage = Readonly<{
  candidateIds: readonly number[];
  complete: boolean;
}>;

export function parseReleaseInventoryPage(value: unknown, tag: string): ReleaseInventoryPage {
  if (!Array.isArray(value) || value.length > MAXIMUM_RELEASE_INVENTORY_PAGE) {
    throw new Error("GitHub Release inventory page is not bounded.");
  }
  const candidateIds: number[] = [];
  for (const item of value) {
    const release = record(item, "GitHub Release inventory item");
    exactKeys(release, ["draft", "id", "tag_name"], "GitHub Release inventory item");
    if (typeof release.draft !== "boolean" || typeof release.tag_name !== "string") {
      throw new Error("GitHub Release inventory item is malformed.");
    }
    const id = positiveInteger(release.id, "GitHub Release inventory identifier");
    if (release.draft && release.tag_name === tag) candidateIds.push(id);
  }
  return Object.freeze({
    candidateIds: Object.freeze(candidateIds),
    complete: value.length < MAXIMUM_RELEASE_INVENTORY_PAGE,
  });
}

function exactIdentifiers(value: readonly number[]): readonly number[] {
  const identifiers = value.map((id) => positiveInteger(id, "GitHub Release draft identifier"));
  if (new Set(identifiers).size !== identifiers.length) {
    throw new Error("GitHub Release draft inventory contains duplicate identifiers.");
  }
  return identifiers;
}

export function classifyCreatedDraftInventory(
  draftIds: readonly number[],
  createdId: number,
): "exact" | "pending" {
  const expected = positiveInteger(createdId, "Created GitHub Release draft identifier");
  const identifiers = exactIdentifiers(draftIds);
  if (identifiers.length === 0) return "pending";
  if (identifiers.length === 1 && identifiers[0] === expected) return "exact";
  throw new Error("Created GitHub Release draft is not uniquely identified by inventory.");
}

export function classifyPublishedDraftInventory(
  draftIds: readonly number[],
  publishedId: number,
): "exact" | "pending" {
  const expected = positiveInteger(publishedId, "Published GitHub Release identifier");
  const identifiers = exactIdentifiers(draftIds);
  if (identifiers.length === 0) return "exact";
  if (identifiers.length === 1 && identifiers[0] === expected) return "pending";
  throw new Error("Published GitHub Release has an ambiguous residual draft inventory.");
}

export type LaterAttemptDraftInventory = Readonly<
  | { state: "pending" }
  | { draftId: number; state: "recover" }
>;

export function classifyLaterAttemptDraftInventory(
  draftIds: readonly number[],
): LaterAttemptDraftInventory {
  const identifiers = exactIdentifiers(draftIds);
  if (identifiers.length === 0) return Object.freeze({ state: "pending" });
  if (identifiers.length === 1) {
    return Object.freeze({ draftId: identifiers[0] as number, state: "recover" });
  }
  throw new Error("GitHub Release has ambiguous residual drafts.");
}

export function priorAttemptProvesNoDraftCreation(
  value: unknown,
  input: Readonly<{ attempt: number; commitSha: string; runId: string }>,
): boolean {
  const expectedAttempt = positiveInteger(input.attempt, "Prior GitHub workflow attempt");
  if (!SHA.test(input.commitSha)) throw new Error("Prior GitHub workflow commit is invalid.");
  const expectedRunId = decimal(input.runId, "Prior GitHub workflow run ID");
  const expectedRunUrl = `https://api.github.com/repos/${publicRepository}/actions/runs/${expectedRunId}`;
  const response = record(value, "Prior GitHub workflow jobs");
  exactKeys(response, ["jobs", "total_count"], "Prior GitHub workflow jobs");
  if (!Array.isArray(response.jobs) || response.jobs.length > 32) {
    throw new Error("Prior GitHub workflow jobs are incomplete or unbounded.");
  }
  if (!Number.isSafeInteger(response.total_count) || response.total_count !== response.jobs.length) {
    throw new Error("Prior GitHub workflow job count is inconsistent.");
  }

  const writers: JsonRecord[] = [];
  for (const value of response.jobs) {
    const job = record(value, "Prior GitHub workflow job");
    exactKeys(job, [
      "conclusion", "head_sha", "id", "name", "run_attempt", "run_id", "run_url",
      "status", "steps", "workflow_name",
    ], "Prior GitHub workflow job");
    if (
      !Number.isSafeInteger(job.id)
      || Number(job.id) <= 0
      || typeof job.name !== "string"
      || job.run_attempt !== expectedAttempt
      || !Number.isSafeInteger(job.run_id)
      || String(job.run_id) !== expectedRunId
      || job.run_url !== expectedRunUrl
      || job.workflow_name !== "Release"
      || job.head_sha !== input.commitSha
      || typeof job.status !== "string"
      || (typeof job.conclusion !== "string" && job.conclusion !== null)
      || !Array.isArray(job.steps)
      || job.steps.length > 100
    ) throw new Error("Prior GitHub workflow job is malformed.");
    for (const stepValue of job.steps) {
      const step = record(stepValue, "Prior GitHub workflow step");
      exactKeys(step, ["conclusion", "name", "status"], "Prior GitHub workflow step");
      if (
        typeof step.name !== "string"
        || typeof step.status !== "string"
        || (typeof step.conclusion !== "string" && step.conclusion !== null)
      ) throw new Error("Prior GitHub workflow step is malformed.");
    }
    if (job.name === GITHUB_RELEASE_JOB_NAME) writers.push(job);
  }
  if (writers.length !== 1) {
    throw new Error("Prior GitHub workflow does not contain one exact Release writer job.");
  }
  const writer = writers[0] as JsonRecord;
  if (writer.status !== "completed") throw new Error("Prior GitHub Release writer is not complete.");
  const steps = writer.steps as JsonRecord[];
  if (writer.conclusion === "skipped") {
    if (steps.length !== 0) {
      throw new Error("Skipped prior GitHub Release writer unexpectedly contains steps.");
    }
    return true;
  }
  if (!["cancelled", "failure", "timed_out"].includes(String(writer.conclusion))) return false;
  const publicationSteps = steps.filter((step) => step.name === GITHUB_RELEASE_STEP_NAME);
  if (publicationSteps.length !== 1) {
    throw new Error("Prior GitHub Release writer does not contain one exact publication step.");
  }
  const publication = publicationSteps[0] as JsonRecord;
  return publication.status === "completed" && publication.conclusion === "skipped";
}
