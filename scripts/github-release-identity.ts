type JsonRecord = Record<string, unknown>;

const schema = "https://hra.hraness.com/release-identity/v1";
const repository = "hraness/hra";
const repositoryId = "1343008607";
const sha = /^[0-9a-f]{40}$/u;
const positiveDecimal = /^[1-9][0-9]*$/u;

function record(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new Error(`${label} has unexpected fields.`);
  }
}

function attempt(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`${label} is invalid.`);
  return Number(value);
}

export type GitHubReleaseRun = Readonly<{
  attempt: number;
  id: string;
  workflowRef: string;
}>;

export function githubReleaseRun(tag: string, source: Readonly<Record<string, string | undefined>>): GitHubReleaseRun {
  const id = source.GITHUB_RUN_ID;
  const attemptText = source.GITHUB_RUN_ATTEMPT;
  const workflowRef = `${repository}/.github/workflows/release.yml@refs/tags/${tag}`;
  if (
    id === undefined
    || !positiveDecimal.test(id)
    || attemptText === undefined
    || !positiveDecimal.test(attemptText)
    || source.GITHUB_REPOSITORY !== repository
    || source.GITHUB_REPOSITORY_ID !== repositoryId
    || source.GITHUB_WORKFLOW_REF !== workflowRef
    || source.GITHUB_EVENT_NAME !== "push"
    || source.GITHUB_REF !== `refs/tags/${tag}`
    || source.GITHUB_REF_NAME !== tag
    || source.GITHUB_REF_TYPE !== "tag"
  ) throw new Error("GitHub Release recovery is not bound to this exact tag workflow run.");
  const runAttempt = Number(attemptText);
  if (!Number.isSafeInteger(runAttempt)) throw new Error("GitHub Release run attempt is outside its safe bound.");
  return Object.freeze({ attempt: runAttempt, id, workflowRef });
}

export type GitHubReleaseIdentityInput = Readonly<{
  artifacts: readonly Readonly<{ name: string; sha256: string; size: number }>[];
  commitSha: string;
  run: GitHubReleaseRun;
  tag: string;
  tagObjectSha: string;
}>;

function identity(input: GitHubReleaseIdentityInput, createdAttempt: number, publishedAttempt: number | null) {
  if (!sha.test(input.commitSha) || !sha.test(input.tagObjectSha)) {
    throw new Error("GitHub Release identity requires exact tag and commit objects.");
  }
  return {
    artifacts: input.artifacts,
    commitSha: input.commitSha,
    createdAttempt,
    publishedAttempt,
    repository,
    repositoryId,
    runId: input.run.id,
    schema,
    tag: input.tag,
    tagObjectSha: input.tagObjectSha,
    workflowRef: input.run.workflowRef,
  };
}

function render(value: unknown): string {
  return `<!-- hra-release-identity:v1\n${JSON.stringify(value)}\n-->`;
}

export function draftReleaseBody(input: GitHubReleaseIdentityInput): string {
  return render(identity(input, input.run.attempt, null));
}

export function publishedReleaseBody(input: GitHubReleaseIdentityInput, createdAttempt: number): string {
  return render(identity(input, createdAttempt, input.run.attempt));
}

export function parseReleaseBody(
  value: unknown,
  input: GitHubReleaseIdentityInput,
  state: "draft" | "published",
): Readonly<{ createdAttempt: number; publishedAttempt: number | null }> {
  if (typeof value !== "string" || value.length > 4_096) throw new Error("GitHub Release identity body is invalid.");
  const prefix = "<!-- hra-release-identity:v1\n";
  const suffix = "\n-->";
  if (!value.startsWith(prefix) || !value.endsWith(suffix)) throw new Error("GitHub Release identity body is missing or edited.");
  let parsed: unknown;
  try { parsed = JSON.parse(value.slice(prefix.length, -suffix.length)) as unknown; }
  catch { throw new Error("GitHub Release identity body is malformed."); }
  const body = record(parsed, "GitHub Release identity");
  exactKeys(body, [
    "artifacts", "commitSha", "createdAttempt", "publishedAttempt", "repository",
    "repositoryId", "runId", "schema", "tag", "tagObjectSha", "workflowRef",
  ], "GitHub Release identity");
  const createdAttempt = attempt(body.createdAttempt, "GitHub Release creation attempt");
  const publishedAttempt = body.publishedAttempt === null
    ? null
    : attempt(body.publishedAttempt, "GitHub Release publication attempt");
  if (
    createdAttempt > input.run.attempt
    || (state === "draft" && publishedAttempt !== null)
    || (state === "published" && (
      publishedAttempt === null
      || publishedAttempt < createdAttempt
      || publishedAttempt > input.run.attempt
    ))
  ) throw new Error("GitHub Release identity has invalid workflow-attempt ordering.");
  if (
    body.repository !== repository
    || body.repositoryId !== repositoryId
    || body.runId !== input.run.id
    || body.workflowRef !== input.run.workflowRef
    || body.schema !== schema
    || body.tag !== input.tag
    || body.tagObjectSha !== input.tagObjectSha
    || body.commitSha !== input.commitSha
    || JSON.stringify(body.artifacts) !== JSON.stringify(input.artifacts)
  ) throw new Error("GitHub Release identity belongs to another release authority or artifact manifest.");
  if (value !== render(identity(input, createdAttempt, publishedAttempt))) {
    throw new Error("GitHub Release identity body is not canonical.");
  }
  return Object.freeze({ createdAttempt, publishedAttempt });
}
