import {
  absoluteHttpsUrlSchema,
  agentNameSchema,
  agentCredentialLifetimeMsSchema,
  agentIdSchema,
  agentPresetSchema,
  agentPresetScopes,
  agentScopeSchema,
  bearerSecretSchema,
  locatorSchema,
  organizationIdSchema,
  organizationNameSchema,
  repositoryIdSchema,
  repositoryProviderSchema,
  redactSecretsInText,
  reviewReasonSchema,
  submissionEvidenceInputSchema,
  submissionSummarySchema,
  taskCommentBodySchema,
  taskDescriptionSchema,
  taskKeyPrefixSchema,
  taskKeySchema,
  taskLabelSchema,
  taskPrioritySchema,
  taskReferenceIdSchema,
  taskReferenceInputSchema,
  taskStatusSchema,
  taskSubmissionIdSchema,
  taskTitleSchema,
  taskTypeSchema,
  uuidV7Schema,
  workspaceIdSchema,
  workspaceNameSchema,
  workspaceSlugSchema,
  type AgentPreset,
  type AgentScope,
  type IdempotencyKey,
  type RepositoryProvider,
  type SubmissionEvidenceInput,
  type TaskKey,
  type TaskPriority,
  type TaskReferenceInput,
  type TaskStatus,
  type TaskType,
} from "@hraness/agent-tasks-protocol";
import { isAbsolute } from "node:path";

export const USAGE = `usage: taskctl <command> [options]

commands:
  auth login [--secret-store keychain|file] [--no-browser] [--json]
  auth enroll [--secret-store keychain|file] [--json] [--idempotency-key UUIDV7]
  auth migrate-agent-credential [--secret-store keychain|file] [--json]
  auth status [--json]
  auth logout [--json]
  organization list [--cursor CURSOR] [--limit 1-100] [--json]
  organization create --name NAME [--json] [--idempotency-key UUIDV7]
  organization use ORGANIZATION_ID [--json]
  workspace list [--cursor CURSOR] [--limit 1-100] [--json]
  workspace create --name NAME --slug SLUG --task-key-prefix PREFIX [--json] [--idempotency-key UUIDV7]
  workspace use WORKSPACE_ID [--json]
  agent create --name NAME --preset PRESET --enrollment-out ABSOLUTE_PATH [--scopes CSV] [--credential-lifetime-ms N] [--json] [--idempotency-key UUIDV7]
  agent list [--cursor CURSOR] [--limit 1-100] [--json]
  agent show AGENT_ID [--json]
  agent enrollment create AGENT_ID --enrollment-out ABSOLUTE_PATH [--scopes CSV] [--credential-lifetime-ms N] [--json] [--idempotency-key UUIDV7]
  agent credential list AGENT_ID [--cursor CURSOR] [--limit 1-100] [--json]
  agent credential revoke AGENT_ID CREDENTIAL_ID [--json] [--idempotency-key UUIDV7]
  agent session list AGENT_ID [--cursor CURSOR] [--limit 1-100] [--json]
  agent disable AGENT_ID [--json] [--idempotency-key UUIDV7]
  context [--json]
  task create --title TITLE [--description TEXT] [--type TYPE] [--priority 0-4] [--available-at EPOCH_MS] [--parent TASK_KEY] [--labels CSV] [--json]
  task show TASK_KEY [--json]
  task list [--status STATUS] [--type TYPE] [--priority 0-4] [--assignee AGENT_ID] [--label LABEL] [--parent TASK_KEY] [--updated-after EPOCH_MS] [--cursor CURSOR] [--limit 1-100] [--json]
  task ready [--cursor CURSOR] [--limit 1-100] [--json]
  task blocked [--attention-only] [--cursor CURSOR] [--limit 1-100] [--json]
  task update TASK_KEY --revision N [--title TITLE] [--description TEXT] [--type TYPE] [--priority 0-4] [--fence N] [--json] [--idempotency-key UUIDV7]
  task cancel TASK_KEY --revision N --reason TEXT [--json] [--idempotency-key UUIDV7]
  task reopen TASK_KEY --revision N [--json] [--idempotency-key UUIDV7]
  task assign TASK_KEY --revision N (--agent AGENT_ID | --clear) [--fence N] [--json] [--idempotency-key UUIDV7]
  task defer TASK_KEY --revision N --available-at EPOCH_MS [--fence N] [--json] [--idempotency-key UUIDV7]
  task label add|remove TASK_KEY --revision N --label LABEL [--fence N] [--json] [--idempotency-key UUIDV7]
  task label list TASK_KEY [--json]
  task comment add TASK_KEY --body TEXT [--json] [--idempotency-key UUIDV7]
  task comment list TASK_KEY [--cursor CURSOR] [--limit 1-100] [--json]
  task dep add|remove TASK_KEY --blocker TASK_KEY --revision N [--fence N] [--json] [--idempotency-key UUIDV7]
  task dep list TASK_KEY [--direction blockers|dependents|both] [--cursor CURSOR] [--limit 1-100] [--json]
  task parent set TASK_KEY PARENT_KEY --revision N [--fence N] [--json] [--idempotency-key UUIDV7]
  task parent clear TASK_KEY --revision N [--fence N] [--json] [--idempotency-key UUIDV7]
  task graph TASK_KEY --depth 1-100 --limit 1-500 [--json]
  task ref add TASK_KEY --revision N --kind KIND [kind-specific options] [--json] [--idempotency-key UUIDV7]
  task ref remove TASK_KEY REFERENCE_ID --revision N [--json] [--idempotency-key UUIDV7]
  task ref list TASK_KEY [--cursor CURSOR] [--limit 1-100] [--json]
  task events TASK_KEY [--cursor CURSOR] [--limit 1-100] [--json]
  task claim TASK_KEY [--json] [--idempotency-key UUIDV7]
  task claim renew TASK_KEY --fence N [--json] [--idempotency-key UUIDV7]
  task release TASK_KEY --fence N [--json] [--idempotency-key UUIDV7]
  task submit TASK_KEY --fence N --summary TEXT --evidence-json JSON [--json] [--idempotency-key UUIDV7]
  task accept TASK_KEY --submission SUBMISSION_ID --review-revision N [--json] [--idempotency-key UUIDV7]
  task reject TASK_KEY --submission SUBMISSION_ID --review-revision N --reason TEXT [--json] [--idempotency-key UUIDV7]
  review queue [--cursor CURSOR] [--limit 1-100] [--json]
  workspace repo add --name NAME --provider github|gitlab|bitbucket|other --url HTTPS_URL [--json] [--idempotency-key UUIDV7]
  workspace repo list [--cursor CURSOR] [--limit 1-100] [--json]
  workspace repo remove REPOSITORY_ID [--json] [--idempotency-key UUIDV7]

Human login pairs once through the browser and uses the OS keychain by default.
Agent enrollment uses the OS keychain by default; file storage is an explicit fallback.
Enrollment tokens are accepted only through stdin or TASKCTL_ENROLLMENT_TOKEN.`;

interface CommandBase {
  readonly json: boolean;
}

interface MutationCommandBase extends CommandBase {
  readonly idempotencyKey?: IdempotencyKey;
}

export type CliCommand =
  | ({ readonly kind: "help" } & CommandBase)
  | ({
      readonly kind: "auth_login";
      readonly secretStore: "keychain" | "file";
      readonly openBrowser: boolean;
    } & CommandBase)
  | ({
      readonly kind: "auth_enroll";
      readonly secretStore: "keychain" | "file";
    } & MutationCommandBase)
  | ({
      readonly kind: "auth_migrate_agent_credential";
      readonly secretStore: "keychain" | "file";
    } & CommandBase)
  | ({ readonly kind: "auth_status" } & CommandBase)
  | ({ readonly kind: "auth_logout" } & CommandBase)
  | ({ readonly kind: "context" } & CommandBase)
  | ({
      readonly kind: "organization_list";
      readonly cursor?: string;
      readonly limit: number;
    } & CommandBase)
  | ({ readonly kind: "organization_create"; readonly name: string } & MutationCommandBase)
  | ({ readonly kind: "organization_use"; readonly organizationId: string } & CommandBase)
  | ({
      readonly kind: "workspace_list";
      readonly cursor?: string;
      readonly limit: number;
    } & CommandBase)
  | ({
      readonly kind: "workspace_create";
      readonly name: string;
      readonly slug: string;
      readonly taskKeyPrefix: string;
    } & MutationCommandBase)
  | ({ readonly kind: "workspace_use"; readonly workspaceId: string } & CommandBase)
  | ({
      readonly kind: "agent_create";
      readonly name: string;
      readonly preset: AgentPreset;
      readonly scopes?: readonly AgentScope[];
      readonly credentialLifetimeMs?: number;
      readonly enrollmentOut: string;
    } & MutationCommandBase)
  | ({ readonly kind: "agent_list"; readonly cursor?: string; readonly limit: number } & CommandBase)
  | ({ readonly kind: "agent_show"; readonly agentId: string } & CommandBase)
  | ({
      readonly kind: "agent_enrollment_create";
      readonly agentId: string;
      readonly scopes?: readonly AgentScope[];
      readonly credentialLifetimeMs?: number;
      readonly enrollmentOut: string;
    } & MutationCommandBase)
  | ({
      readonly kind: "agent_credential_list" | "agent_session_list";
      readonly agentId: string;
      readonly cursor?: string;
      readonly limit: number;
    } & CommandBase)
  | ({
      readonly kind: "agent_credential_revoke";
      readonly agentId: string;
      readonly credentialId: string;
    } & MutationCommandBase)
  | ({ readonly kind: "agent_disable"; readonly agentId: string } & MutationCommandBase)
  | ({
      readonly kind: "task_create";
      readonly title: string;
      readonly description?: string;
      readonly type: TaskType;
      readonly priority: TaskPriority;
      readonly availableAt?: number;
      readonly parentKey?: TaskKey;
      readonly labels?: readonly string[];
    } & MutationCommandBase)
  | ({ readonly kind: "task_show"; readonly key: TaskKey } & CommandBase)
  | ({
      readonly kind: "task_list";
      readonly cursor?: string;
      readonly limit: number;
      readonly status?: TaskStatus;
      readonly type?: TaskType;
      readonly priority?: TaskPriority;
      readonly assigneeAgentId?: string;
      readonly label?: string;
      readonly parentKey?: TaskKey;
      readonly updatedAfter?: number;
    } & CommandBase)
  | ({
      readonly kind: "task_ready";
      readonly cursor?: string;
      readonly limit: number;
    } & CommandBase)
  | ({ readonly kind: "task_blocked"; readonly cursor?: string; readonly limit: number; readonly attentionOnly: boolean } & CommandBase)
  | ({
      readonly kind: "task_update";
      readonly key: TaskKey;
      readonly revision: number;
      readonly fence?: number;
      readonly title?: string;
      readonly description?: string;
      readonly type?: TaskType;
      readonly priority?: TaskPriority;
    } & MutationCommandBase)
  | ({ readonly kind: "task_cancel"; readonly key: TaskKey; readonly revision: number; readonly reason: string } & MutationCommandBase)
  | ({ readonly kind: "task_reopen"; readonly key: TaskKey; readonly revision: number } & MutationCommandBase)
  | ({ readonly kind: "task_assign"; readonly key: TaskKey; readonly revision: number; readonly assigneeAgentId: string | null; readonly fence?: number } & MutationCommandBase)
  | ({ readonly kind: "task_defer"; readonly key: TaskKey; readonly revision: number; readonly availableAt: number; readonly fence?: number } & MutationCommandBase)
  | ({ readonly kind: "task_label_add" | "task_label_remove"; readonly key: TaskKey; readonly revision: number; readonly label: string; readonly fence?: number } & MutationCommandBase)
  | ({ readonly kind: "task_label_list"; readonly key: TaskKey } & CommandBase)
  | ({ readonly kind: "task_comment_add"; readonly key: TaskKey; readonly body: string } & MutationCommandBase)
  | ({ readonly kind: "task_comment_list" | "task_events" | "task_ref_list"; readonly key: TaskKey; readonly cursor?: string; readonly limit: number } & CommandBase)
  | ({ readonly kind: "task_dep_add" | "task_dep_remove"; readonly key: TaskKey; readonly blockerKey: TaskKey; readonly revision: number; readonly fence?: number } & MutationCommandBase)
  | ({ readonly kind: "task_dep_list"; readonly key: TaskKey; readonly direction: "blockers" | "dependents" | "both"; readonly cursor?: string; readonly limit: number } & CommandBase)
  | ({ readonly kind: "task_parent_set"; readonly key: TaskKey; readonly parentKey: TaskKey; readonly revision: number; readonly fence?: number } & MutationCommandBase)
  | ({ readonly kind: "task_parent_clear"; readonly key: TaskKey; readonly revision: number; readonly fence?: number } & MutationCommandBase)
  | ({ readonly kind: "task_graph"; readonly key: TaskKey; readonly depth: number; readonly limit: number } & CommandBase)
  | ({ readonly kind: "task_ref_add"; readonly key: TaskKey; readonly revision: number; readonly reference: TaskReferenceInput; readonly fence?: number } & MutationCommandBase)
  | ({ readonly kind: "task_ref_remove"; readonly key: TaskKey; readonly referenceId: string; readonly revision: number; readonly fence?: number } & MutationCommandBase)
  | ({ readonly kind: "task_claim"; readonly key: TaskKey } & MutationCommandBase)
  | ({
      readonly kind: "task_claim_renew" | "task_release";
      readonly key: TaskKey;
      readonly fence: number;
    } & MutationCommandBase)
  | ({
      readonly kind: "task_submit";
      readonly key: TaskKey;
      readonly fence: number;
      readonly summary: string;
      readonly evidence: readonly SubmissionEvidenceInput[];
    } & MutationCommandBase)
  | ({
      readonly kind: "task_accept" | "task_reject";
      readonly key: TaskKey;
      readonly submissionId: string;
      readonly reviewRevision: number;
      readonly reason?: string;
    } & MutationCommandBase)
  | ({ readonly kind: "review_queue"; readonly cursor?: string; readonly limit: number } & CommandBase)
  | ({
      readonly kind: "workspace_repo_add";
      readonly name: string;
      readonly provider: RepositoryProvider;
      readonly url: string;
    } & MutationCommandBase)
  | ({ readonly kind: "workspace_repo_list"; readonly cursor?: string; readonly limit: number } & CommandBase)
  | ({ readonly kind: "workspace_repo_remove"; readonly repositoryId: string } & MutationCommandBase);

export type ParseArgsResult =
  | { readonly ok: true; readonly command: CliCommand }
  | { readonly ok: false; readonly json: boolean; readonly message: string };

interface ParsedOptions {
  readonly values: ReadonlyMap<string, string | true>;
  readonly positionals: readonly string[];
}

function containsSecret(value: string): boolean {
  return redactSecretsInText(value) !== value || bearerSecretSchema.safeParse(value).success;
}

function failure(json: boolean, message: string): ParseArgsResult {
  return { ok: false, json, message };
}

function parseOptions(
  tokens: readonly string[],
  valueOptions: ReadonlySet<string>,
  booleanOptions: ReadonlySet<string>,
): ParsedOptions | null {
  const values = new Map<string, string | true>();
  const positionals: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) return null;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    if (booleanOptions.has(token)) {
      if (values.has(token)) return null;
      values.set(token, true);
      continue;
    }
    if (!valueOptions.has(token) || values.has(token)) return null;
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith("--")) return null;
    values.set(token, value);
    index += 1;
  }
  return { values, positionals };
}

function optionString(options: ParsedOptions, name: string): string | undefined {
  const value = options.values.get(name);
  return typeof value === "string" ? value : undefined;
}

function optionFlag(options: ParsedOptions, name: string): boolean {
  return options.values.get(name) === true;
}

function parseIdempotencyKey(options: ParsedOptions): IdempotencyKey | null | undefined {
  const value = optionString(options, "--idempotency-key");
  if (value === undefined) return undefined;
  const parsed = uuidV7Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseSafeInteger(value: string, minimum: number, maximum: number): number | null {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function parseSimple(
  kind: "auth_status" | "auth_logout" | "context",
  tokens: readonly string[],
  json: boolean,
): ParseArgsResult {
  const options = parseOptions(tokens, new Set(), new Set(["--json"]));
  if (options === null || options.positionals.length !== 0) {
    return failure(json, "this command accepts only --json");
  }
  return { ok: true, command: { kind, json: optionFlag(options, "--json") } };
}

function parseEnroll(tokens: readonly string[], json: boolean): ParseArgsResult {
  const options = parseOptions(
    tokens,
    new Set(["--idempotency-key", "--secret-store"]),
    new Set(["--json"]),
  );
  if (options === null || options.positionals.length !== 0) {
    return failure(json, "auth enroll accepts no secret or positional argument");
  }
  const idempotencyKey = parseIdempotencyKey(options);
  if (idempotencyKey === null) return failure(json, "--idempotency-key must be UUIDv7");
  const secretStore = optionString(options, "--secret-store") ?? "keychain";
  if (secretStore !== "keychain" && secretStore !== "file") {
    return failure(json, "--secret-store must be keychain or file");
  }
  return {
    ok: true,
    command: {
      kind: "auth_enroll",
      json: optionFlag(options, "--json"),
      secretStore,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    },
  };
}

function parseAgentCredentialMigration(tokens: readonly string[], json: boolean): ParseArgsResult {
  const options = parseOptions(tokens, new Set(["--secret-store"]), new Set(["--json"]));
  if (options === null || options.positionals.length !== 0) {
    return failure(json, "auth migrate-agent-credential accepts only --secret-store and --json");
  }
  const secretStore = optionString(options, "--secret-store") ?? "keychain";
  if (secretStore !== "keychain" && secretStore !== "file") {
    return failure(json, "--secret-store must be keychain or file");
  }
  return {
    ok: true,
    command: {
      kind: "auth_migrate_agent_credential",
      secretStore,
      json: optionFlag(options, "--json"),
    },
  };
}

function parseLogin(tokens: readonly string[], json: boolean): ParseArgsResult {
  const options = parseOptions(
    tokens,
    new Set(["--secret-store"]),
    new Set(["--json", "--no-browser"]),
  );
  if (options === null || options.positionals.length !== 0) {
    return failure(json, "auth login received an unknown, duplicate, or positional argument");
  }
  const secretStore = optionString(options, "--secret-store") ?? "keychain";
  if (secretStore !== "keychain" && secretStore !== "file") {
    return failure(json, "--secret-store must be keychain or file");
  }
  return {
    ok: true,
    command: {
      kind: "auth_login",
      json: optionFlag(options, "--json"),
      secretStore,
      openBrowser: !optionFlag(options, "--no-browser"),
    },
  };
}

function parseList(
  kind: "organization_list" | "workspace_list",
  tokens: readonly string[],
  json: boolean,
): ParseArgsResult {
  const options = parseOptions(tokens, new Set(["--cursor", "--limit"]), new Set(["--json"]));
  if (options === null || options.positionals.length !== 0) {
    return failure(json, `${kind.replace("_", " ")} received an unknown, duplicate, or positional argument`);
  }
  const cursor = optionString(options, "--cursor");
  if (cursor !== undefined && (cursor.length === 0 || cursor.length > 8_192)) {
    return failure(json, "--cursor must contain 1 through 8192 characters");
  }
  const limit = parseSafeInteger(optionString(options, "--limit") ?? "20", 1, 100);
  if (limit === null) return failure(json, "--limit must be an integer from 1 through 100");
  return {
    ok: true,
    command: {
      kind,
      limit,
      json: optionFlag(options, "--json"),
      ...(cursor === undefined ? {} : { cursor }),
    },
  };
}

function parseOrganizationCreate(tokens: readonly string[], json: boolean): ParseArgsResult {
  const options = parseOptions(
    tokens,
    new Set(["--name", "--idempotency-key"]),
    new Set(["--json"]),
  );
  if (options === null || options.positionals.length !== 0) {
    return failure(json, "organization create received an unknown, duplicate, or positional argument");
  }
  const name = organizationNameSchema.safeParse(optionString(options, "--name"));
  if (!name.success) return failure(json, "--name is required and must be a valid organization name");
  const key = parseIdempotencyKey(options);
  if (key === null) return failure(json, "--idempotency-key must be UUIDv7");
  return {
    ok: true,
    command: {
      kind: "organization_create",
      name: name.data,
      json: optionFlag(options, "--json"),
      ...(key === undefined ? {} : { idempotencyKey: key }),
    },
  };
}

function parseUse(
  kind: "organization_use" | "workspace_use",
  tokens: readonly string[],
  json: boolean,
): ParseArgsResult {
  const options = parseOptions(tokens, new Set(), new Set(["--json"]));
  if (options === null || options.positionals.length !== 1) {
    return failure(json, `${kind.replace("_", " ")} requires exactly one ID`);
  }
  const candidate = options.positionals[0];
  const parsed = (kind === "organization_use" ? organizationIdSchema : workspaceIdSchema).safeParse(candidate);
  if (!parsed.success) return failure(json, `${kind.replace("_", " ")} ID is invalid`);
  return {
    ok: true,
    command:
      kind === "organization_use"
        ? { kind, organizationId: parsed.data, json: optionFlag(options, "--json") }
        : { kind, workspaceId: parsed.data, json: optionFlag(options, "--json") },
  };
}

function parseWorkspaceCreate(tokens: readonly string[], json: boolean): ParseArgsResult {
  const options = parseOptions(
    tokens,
    new Set(["--name", "--slug", "--task-key-prefix", "--idempotency-key"]),
    new Set(["--json"]),
  );
  if (options === null || options.positionals.length !== 0) {
    return failure(json, "workspace create received an unknown, duplicate, or positional argument");
  }
  const name = workspaceNameSchema.safeParse(optionString(options, "--name"));
  if (!name.success) return failure(json, "--name is required and must be a valid workspace name");
  const slug = workspaceSlugSchema.safeParse(optionString(options, "--slug"));
  if (!slug.success) return failure(json, "--slug is required and must be lowercase URL-safe text");
  const taskKeyPrefix = taskKeyPrefixSchema.safeParse(optionString(options, "--task-key-prefix"));
  if (!taskKeyPrefix.success) {
    return failure(json, "--task-key-prefix must contain 2 through 8 uppercase letters or digits");
  }
  const key = parseIdempotencyKey(options);
  if (key === null) return failure(json, "--idempotency-key must be UUIDv7");
  return {
    ok: true,
    command: {
      kind: "workspace_create",
      name: name.data,
      slug: slug.data,
      taskKeyPrefix: taskKeyPrefix.data,
      json: optionFlag(options, "--json"),
      ...(key === undefined ? {} : { idempotencyKey: key }),
    },
  };
}

function parseAgentCreate(tokens: readonly string[], json: boolean): ParseArgsResult {
  const options = parseOptions(
    tokens,
    new Set([
      "--name",
      "--preset",
      "--scopes",
      "--credential-lifetime-ms",
      "--enrollment-out",
      "--idempotency-key",
    ]),
    new Set(["--json"]),
  );
  if (options === null || options.positionals.length !== 0) {
    return failure(json, "agent create received an unknown, duplicate, or positional argument");
  }
  const name = agentNameSchema.safeParse(optionString(options, "--name"));
  if (!name.success) return failure(json, "--name is required and must be a valid agent name");
  const preset = agentPresetSchema.safeParse(optionString(options, "--preset"));
  if (!preset.success) return failure(json, "--preset must be worker, planner, reviewer, or observer");
  const enrollmentOut = optionString(options, "--enrollment-out");
  if (enrollmentOut === undefined || !isAbsolute(enrollmentOut)) {
    return failure(json, "--enrollment-out is required and must be an absolute path");
  }
  const scopeSource = optionString(options, "--scopes");
  let scopes: AgentScope[] | undefined;
  if (scopeSource !== undefined) {
    const candidates = scopeSource.split(",");
    const parsed = candidates.map((scope) => agentScopeSchema.safeParse(scope));
    if (candidates.length === 0 || parsed.some((scope) => !scope.success)) {
      return failure(json, "--scopes must be a comma-separated list of valid agent scopes");
    }
    scopes = parsed.map((scope) => {
      if (!scope.success) throw new Error("scope parser invariant failed");
      return scope.data;
    });
    if (new Set(scopes).size !== scopes.length) {
      return failure(json, "--scopes must not contain duplicates");
    }
    const maximum = new Set<AgentScope>(agentPresetScopes[preset.data]);
    if (scopes.some((scope) => !maximum.has(scope))) {
      return failure(json, `--scopes cannot exceed the ${preset.data} preset`);
    }
  }
  const lifetimeSource = optionString(options, "--credential-lifetime-ms");
  const parsedLifetime =
    lifetimeSource === undefined
      ? undefined
      : parseSafeInteger(lifetimeSource, 0, Number.MAX_SAFE_INTEGER);
  const credentialLifetime = agentCredentialLifetimeMsSchema.safeParse(parsedLifetime);
  if (lifetimeSource !== undefined && !credentialLifetime.success) {
    return failure(json, "--credential-lifetime-ms must be between 3600000 and 7776000000");
  }
  const key = parseIdempotencyKey(options);
  if (key === null) return failure(json, "--idempotency-key must be UUIDv7");
  return {
    ok: true,
    command: {
      kind: "agent_create",
      name: name.data,
      preset: preset.data,
      enrollmentOut,
      json: optionFlag(options, "--json"),
      ...(scopes === undefined ? {} : { scopes }),
      ...(credentialLifetime.success && lifetimeSource !== undefined
        ? { credentialLifetimeMs: credentialLifetime.data }
        : {}),
      ...(key === undefined ? {} : { idempotencyKey: key }),
    },
  };
}

function parsedAgentId(value: string | undefined): string | null {
  const parsed = agentIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseAgentList(tokens: readonly string[], json: boolean): ParseArgsResult {
  const options = parseOptions(tokens, new Set(["--cursor", "--limit"]), new Set(["--json"]));
  if (options === null || options.positionals.length !== 0) {
    return failure(json, "agent list received an unknown, duplicate, or positional argument");
  }
  const cursor = optionString(options, "--cursor");
  if (cursor !== undefined && (cursor.length === 0 || cursor.length > 8_192)) {
    return failure(json, "--cursor must contain 1 through 8192 characters");
  }
  const limit = parseSafeInteger(optionString(options, "--limit") ?? "20", 1, 100);
  if (limit === null) return failure(json, "--limit must be an integer from 1 through 100");
  return {
    ok: true,
    command: {
      kind: "agent_list",
      limit,
      json: optionFlag(options, "--json"),
      ...(cursor === undefined ? {} : { cursor }),
    },
  };
}

function parseAgentShow(tokens: readonly string[], json: boolean): ParseArgsResult {
  const options = parseOptions(tokens, new Set(), new Set(["--json"]));
  const agentId = parsedAgentId(options?.positionals[0]);
  if (options === null || options.positionals.length !== 1 || agentId === null) {
    return failure(json, "agent show requires exactly one valid agent ID");
  }
  return {
    ok: true,
    command: { kind: "agent_show", agentId, json: optionFlag(options, "--json") },
  };
}

function parseDelegatedScopes(options: ParsedOptions): readonly AgentScope[] | null | undefined {
  const source = optionString(options, "--scopes");
  if (source === undefined) return undefined;
  const candidates = source.split(",");
  const parsed = candidates.map((scope) => agentScopeSchema.safeParse(scope));
  if (parsed.some((scope) => !scope.success)) return null;
  const scopes = parsed.map((scope) => {
    if (!scope.success) throw new Error("scope parser invariant failed");
    return scope.data;
  });
  return scopes.length > 0 && new Set(scopes).size === scopes.length ? scopes : null;
}

function parseCredentialLifetime(options: ParsedOptions): number | null | undefined {
  const source = optionString(options, "--credential-lifetime-ms");
  if (source === undefined) return undefined;
  const integer = parseSafeInteger(source, 0, Number.MAX_SAFE_INTEGER);
  const parsed = agentCredentialLifetimeMsSchema.safeParse(integer);
  return parsed.success ? parsed.data : null;
}

function parseAgentEnrollmentCreate(tokens: readonly string[], json: boolean): ParseArgsResult {
  const options = parseOptions(
    tokens,
    new Set([
      "--scopes",
      "--credential-lifetime-ms",
      "--enrollment-out",
      "--idempotency-key",
    ]),
    new Set(["--json"]),
  );
  const agentId = parsedAgentId(options?.positionals[0]);
  if (options === null || options.positionals.length !== 1 || agentId === null) {
    return failure(json, "agent enrollment create requires exactly one valid agent ID");
  }
  const enrollmentOut = optionString(options, "--enrollment-out");
  if (enrollmentOut === undefined || !isAbsolute(enrollmentOut)) {
    return failure(json, "--enrollment-out is required and must be an absolute path");
  }
  const scopes = parseDelegatedScopes(options);
  if (scopes === null) {
    return failure(json, "--scopes must be a unique comma-separated list of valid agent scopes");
  }
  const credentialLifetimeMs = parseCredentialLifetime(options);
  if (credentialLifetimeMs === null) {
    return failure(json, "--credential-lifetime-ms must be between 3600000 and 7776000000");
  }
  const key = parseIdempotencyKey(options);
  if (key === null) return failure(json, "--idempotency-key must be UUIDv7");
  return {
    ok: true,
    command: {
      kind: "agent_enrollment_create",
      agentId,
      enrollmentOut,
      json: optionFlag(options, "--json"),
      ...(scopes === undefined ? {} : { scopes }),
      ...(credentialLifetimeMs === undefined ? {} : { credentialLifetimeMs }),
      ...(key === undefined ? {} : { idempotencyKey: key }),
    },
  };
}

function parseAgentMetadataList(
  kind: "agent_credential_list" | "agent_session_list",
  tokens: readonly string[],
  json: boolean,
): ParseArgsResult {
  const options = parseOptions(tokens, new Set(["--cursor", "--limit"]), new Set(["--json"]));
  const agentId = parsedAgentId(options?.positionals[0]);
  if (options === null || options.positionals.length !== 1 || agentId === null) {
    return failure(json, `${kind.replaceAll("_", " ")} requires exactly one valid agent ID`);
  }
  const cursor = optionString(options, "--cursor");
  if (cursor !== undefined && (cursor.length === 0 || cursor.length > 8_192)) {
    return failure(json, "--cursor must contain 1 through 8192 characters");
  }
  const limit = parseSafeInteger(optionString(options, "--limit") ?? "20", 1, 100);
  if (limit === null) return failure(json, "--limit must be an integer from 1 through 100");
  return {
    ok: true,
    command: {
      kind,
      agentId,
      limit,
      json: optionFlag(options, "--json"),
      ...(cursor === undefined ? {} : { cursor }),
    },
  };
}

function parseAgentCredentialRevoke(tokens: readonly string[], json: boolean): ParseArgsResult {
  const options = parseOptions(
    tokens,
    new Set(["--idempotency-key"]),
    new Set(["--json"]),
  );
  const agentId = parsedAgentId(options?.positionals[0]);
  const credential = locatorSchema.safeParse(options?.positionals[1]);
  if (
    options === null ||
    options.positionals.length !== 2 ||
    agentId === null ||
    !credential.success
  ) {
    return failure(json, "agent credential revoke requires valid agent and credential IDs");
  }
  const key = parseIdempotencyKey(options);
  if (key === null) return failure(json, "--idempotency-key must be UUIDv7");
  return {
    ok: true,
    command: {
      kind: "agent_credential_revoke",
      agentId,
      credentialId: credential.data,
      json: optionFlag(options, "--json"),
      ...(key === undefined ? {} : { idempotencyKey: key }),
    },
  };
}

function parseAgentDisable(tokens: readonly string[], json: boolean): ParseArgsResult {
  const options = parseOptions(
    tokens,
    new Set(["--idempotency-key"]),
    new Set(["--json"]),
  );
  const agentId = parsedAgentId(options?.positionals[0]);
  if (options === null || options.positionals.length !== 1 || agentId === null) {
    return failure(json, "agent disable requires exactly one valid agent ID");
  }
  const key = parseIdempotencyKey(options);
  if (key === null) return failure(json, "--idempotency-key must be UUIDv7");
  return {
    ok: true,
    command: {
      kind: "agent_disable",
      agentId,
      json: optionFlag(options, "--json"),
      ...(key === undefined ? {} : { idempotencyKey: key }),
    },
  };
}

function parseTaskCreate(tokens: readonly string[], json: boolean): ParseArgsResult {
  const options = parseOptions(
    tokens,
    new Set([
      "--title",
      "--description",
      "--type",
      "--priority",
      "--available-at",
      "--parent",
      "--labels",
      "--idempotency-key",
    ]),
    new Set(["--json"]),
  );
  if (options === null || options.positionals.length !== 0) {
    return failure(json, "task create received an unknown, duplicate, or positional argument");
  }

  const titleResult = taskTitleSchema.safeParse(optionString(options, "--title"));
  if (!titleResult.success || titleResult.data.trim().length === 0) {
    return failure(json, "--title is required and must be at most 512 UTF-8 bytes");
  }
  const typeResult = taskTypeSchema.safeParse(optionString(options, "--type") ?? "task");
  if (!typeResult.success) return failure(json, "--type must be task, bug, feature, epic, or chore");

  const priorityValue = optionString(options, "--priority") ?? "2";
  const parsedPriority = parseSafeInteger(priorityValue, 0, 4);
  const priorityResult = taskPrioritySchema.safeParse(parsedPriority);
  if (!priorityResult.success) return failure(json, "--priority must be an integer from 0 through 4");

  const availableAtValue = optionString(options, "--available-at");
  const availableAt =
    availableAtValue === undefined
      ? undefined
      : parseSafeInteger(availableAtValue, 0, Number.MAX_SAFE_INTEGER);
  if (availableAtValue !== undefined && availableAt === null) {
    return failure(json, "--available-at must be a nonnegative epoch millisecond integer");
  }
  const descriptionResult = taskDescriptionSchema.safeParse(
    optionString(options, "--description") ?? "",
  );
  if (!descriptionResult.success) return failure(json, "--description must be at most 32768 UTF-8 bytes");
  const parentSource = optionString(options, "--parent");
  const parentResult = parentSource === undefined ? undefined : taskKeySchema.safeParse(parentSource);
  if (parentResult !== undefined && !parentResult.success) return failure(json, "--parent must be a valid task key");
  const labelsSource = optionString(options, "--labels");
  let labels: string[] | undefined;
  if (labelsSource !== undefined) {
    const candidates = labelsSource.split(",");
    const parsed = candidates.map((label) => taskLabelSchema.safeParse(label));
    if (parsed.some((label) => !label.success)) {
      return failure(json, "--labels must be a comma-separated list of valid labels");
    }
    labels = parsed.map((label) => {
      if (!label.success) throw new Error("label parser invariant failed");
      return label.data;
    });
    if (labels.length > 50 || new Set(labels).size !== labels.length) {
      return failure(json, "--labels must contain at most 50 unique labels");
    }
  }
  const idempotencyKey = parseIdempotencyKey(options);
  if (idempotencyKey === null) return failure(json, "--idempotency-key must be UUIDv7");

  return {
    ok: true,
    command: {
      kind: "task_create",
      json: optionFlag(options, "--json"),
      title: titleResult.data.trim(),
      ...(optionString(options, "--description") === undefined
        ? {}
        : { description: descriptionResult.data }),
      type: typeResult.data,
      priority: priorityResult.data,
      ...(availableAt === undefined || availableAt === null ? {} : { availableAt }),
      ...(parentResult === undefined || !parentResult.success ? {} : { parentKey: parentResult.data }),
      ...(labels === undefined ? {} : { labels }),
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    },
  };
}

function parseTaskReady(tokens: readonly string[], json: boolean): ParseArgsResult {
  const options = parseOptions(tokens, new Set(["--cursor", "--limit"]), new Set(["--json"]));
  if (options === null || options.positionals.length !== 0) {
    return failure(json, "task ready received an unknown, duplicate, or positional argument");
  }
  const cursor = optionString(options, "--cursor");
  if (cursor !== undefined && cursor.length === 0) return failure(json, "--cursor cannot be empty");
  const limit = parseSafeInteger(optionString(options, "--limit") ?? "20", 1, 100);
  if (limit === null) return failure(json, "--limit must be an integer from 1 through 100");
  return {
    ok: true,
    command: {
      kind: "task_ready",
      json: optionFlag(options, "--json"),
      limit,
      ...(cursor === undefined ? {} : { cursor }),
    },
  };
}

function validCursor(options: ParsedOptions): string | null | undefined {
  const cursor = optionString(options, "--cursor");
  if (cursor === undefined) return undefined;
  return cursor.length > 0 && cursor.length <= 8_192 ? cursor : null;
}

function validLimit(options: ParsedOptions, maximum = 100): number | null {
  return parseSafeInteger(optionString(options, "--limit") ?? "20", 1, maximum);
}

function validTaskKey(value: string | undefined): TaskKey | null {
  const parsed = taskKeySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function validPositiveOption(options: ParsedOptions, name: string): number | null {
  const value = optionString(options, name);
  return value === undefined ? null : parseSafeInteger(value, 1, Number.MAX_SAFE_INTEGER);
}

function validOptionalPositive(options: ParsedOptions, name: string): number | null | undefined {
  const value = optionString(options, name);
  return value === undefined ? undefined : parseSafeInteger(value, 1, Number.MAX_SAFE_INTEGER);
}

function validMutationKey(options: ParsedOptions): IdempotencyKey | null | undefined {
  return parseIdempotencyKey(options);
}

function parseTaskShow(tokens: readonly string[], json: boolean): ParseArgsResult {
  const options = parseOptions(tokens, new Set(), new Set(["--json"]));
  const key = validTaskKey(options?.positionals[0]);
  if (options === null || options.positionals.length !== 1 || key === null) {
    return failure(json, "task show requires exactly one valid task key");
  }
  return { ok: true, command: { kind: "task_show", key, json: optionFlag(options, "--json") } };
}

function parseTaskList(tokens: readonly string[], json: boolean): ParseArgsResult {
  const options = parseOptions(
    tokens,
    new Set([
      "--cursor",
      "--limit",
      "--status",
      "--type",
      "--priority",
      "--assignee",
      "--label",
      "--parent",
      "--updated-after",
    ]),
    new Set(["--json"]),
  );
  if (options === null || options.positionals.length !== 0) {
    return failure(json, "task list received an unknown, duplicate, or positional argument");
  }
  const cursor = validCursor(options);
  const limit = validLimit(options);
  if (cursor === null) return failure(json, "--cursor must contain 1 through 8192 characters");
  if (limit === null) return failure(json, "--limit must be an integer from 1 through 100");
  const statusSource = optionString(options, "--status");
  const status = statusSource === undefined ? undefined : taskStatusSchema.safeParse(statusSource);
  if (status !== undefined && !status.success) return failure(json, "--status is invalid");
  const typeSource = optionString(options, "--type");
  const type = typeSource === undefined ? undefined : taskTypeSchema.safeParse(typeSource);
  if (type !== undefined && !type.success) return failure(json, "--type is invalid");
  const prioritySource = optionString(options, "--priority");
  const priority = prioritySource === undefined ? undefined : parseSafeInteger(prioritySource, 0, 4);
  if (prioritySource !== undefined && priority === null) return failure(json, "--priority must be 0 through 4");
  const assigneeSource = optionString(options, "--assignee");
  const assignee = assigneeSource === undefined ? undefined : agentIdSchema.safeParse(assigneeSource);
  if (assignee !== undefined && !assignee.success) return failure(json, "--assignee is invalid");
  const labelSource = optionString(options, "--label");
  const label = labelSource === undefined ? undefined : taskLabelSchema.safeParse(labelSource);
  if (label !== undefined && !label.success) return failure(json, "--label is invalid");
  const parentSource = optionString(options, "--parent");
  const parent = parentSource === undefined ? undefined : taskKeySchema.safeParse(parentSource);
  if (parent !== undefined && !parent.success) return failure(json, "--parent is invalid");
  const updatedSource = optionString(options, "--updated-after");
  const updatedAfter = updatedSource === undefined ? undefined : parseSafeInteger(updatedSource, 0, Number.MAX_SAFE_INTEGER);
  if (updatedSource !== undefined && updatedAfter === null) return failure(json, "--updated-after must be an epoch millisecond integer");
  return {
    ok: true,
    command: {
      kind: "task_list",
      json: optionFlag(options, "--json"),
      limit,
      ...(cursor === undefined ? {} : { cursor }),
      ...(status === undefined || !status.success ? {} : { status: status.data }),
      ...(type === undefined || !type.success ? {} : { type: type.data }),
      ...(priority === undefined || priority === null ? {} : { priority }),
      ...(assignee === undefined || !assignee.success ? {} : { assigneeAgentId: assignee.data }),
      ...(label === undefined || !label.success ? {} : { label: label.data }),
      ...(parent === undefined || !parent.success ? {} : { parentKey: parent.data }),
      ...(updatedAfter === undefined || updatedAfter === null ? {} : { updatedAfter }),
    },
  };
}

function parseTaskBlocked(tokens: readonly string[], json: boolean): ParseArgsResult {
  const options = parseOptions(tokens, new Set(["--cursor", "--limit"]), new Set(["--json", "--attention-only"]));
  if (options === null || options.positionals.length !== 0) {
    return failure(json, "task blocked received an unknown, duplicate, or positional argument");
  }
  const cursor = validCursor(options);
  const limit = validLimit(options);
  if (cursor === null) return failure(json, "--cursor must contain 1 through 8192 characters");
  if (limit === null) return failure(json, "--limit must be an integer from 1 through 100");
  return {
    ok: true,
    command: {
      kind: "task_blocked",
      json: optionFlag(options, "--json"),
      limit,
      attentionOnly: optionFlag(options, "--attention-only"),
      ...(cursor === undefined ? {} : { cursor }),
    },
  };
}

function parseTaskUpdate(tokens: readonly string[], json: boolean): ParseArgsResult {
  const options = parseOptions(
    tokens,
    new Set(["--revision", "--fence", "--title", "--description", "--type", "--priority", "--idempotency-key"]),
    new Set(["--json"]),
  );
  const key = validTaskKey(options?.positionals[0]);
  if (options === null || options.positionals.length !== 1 || key === null) {
    return failure(json, "task update requires exactly one valid task key");
  }
  const revision = validPositiveOption(options, "--revision");
  if (revision === null) return failure(json, "--revision must be a positive integer");
  const fenceSource = optionString(options, "--fence");
  const fence = fenceSource === undefined ? undefined : parseSafeInteger(fenceSource, 1, Number.MAX_SAFE_INTEGER);
  if (fenceSource !== undefined && fence === null) return failure(json, "--fence must be a positive integer");
  const titleSource = optionString(options, "--title");
  const title = titleSource === undefined ? undefined : taskTitleSchema.safeParse(titleSource.trim());
  if (title !== undefined && !title.success) return failure(json, "--title is invalid");
  const descriptionSource = optionString(options, "--description");
  const description = descriptionSource === undefined ? undefined : taskDescriptionSchema.safeParse(descriptionSource);
  if (description !== undefined && !description.success) return failure(json, "--description is invalid");
  const typeSource = optionString(options, "--type");
  const type = typeSource === undefined ? undefined : taskTypeSchema.safeParse(typeSource);
  if (type !== undefined && !type.success) return failure(json, "--type is invalid");
  const prioritySource = optionString(options, "--priority");
  const priority = prioritySource === undefined ? undefined : parseSafeInteger(prioritySource, 0, 4);
  if (prioritySource !== undefined && priority === null) return failure(json, "--priority must be 0 through 4");
  if (title === undefined && description === undefined && type === undefined && priority === undefined) {
    return failure(json, "task update requires at least one field option");
  }
  const idempotencyKey = validMutationKey(options);
  if (idempotencyKey === null) return failure(json, "--idempotency-key must be UUIDv7");
  return {
    ok: true,
    command: {
      kind: "task_update",
      key,
      revision,
      json: optionFlag(options, "--json"),
      ...(fence === undefined || fence === null ? {} : { fence }),
      ...(title === undefined || !title.success ? {} : { title: title.data }),
      ...(description === undefined || !description.success ? {} : { description: description.data }),
      ...(type === undefined || !type.success ? {} : { type: type.data }),
      ...(priority === undefined || priority === null ? {} : { priority }),
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    },
  };
}

function parseTaskLifecycle(kind: "task_cancel" | "task_reopen", tokens: readonly string[], json: boolean): ParseArgsResult {
  const options = parseOptions(
    tokens,
    new Set(kind === "task_cancel" ? ["--revision", "--reason", "--idempotency-key"] : ["--revision", "--idempotency-key"]),
    new Set(["--json"]),
  );
  const key = validTaskKey(options?.positionals[0]);
  if (options === null || options.positionals.length !== 1 || key === null) return failure(json, `${kind.replaceAll("_", " ")} requires exactly one valid task key`);
  const revision = validPositiveOption(options, "--revision");
  if (revision === null) return failure(json, "--revision must be a positive integer");
  const idempotencyKey = validMutationKey(options);
  if (idempotencyKey === null) return failure(json, "--idempotency-key must be UUIDv7");
  if (kind === "task_cancel") {
    const reason = reviewReasonSchema.safeParse(optionString(options, "--reason"));
    if (!reason.success) return failure(json, "--reason is required and must be at most 16384 UTF-8 bytes");
    return { ok: true, command: { kind, key, revision, reason: reason.data, json: optionFlag(options, "--json"), ...(idempotencyKey === undefined ? {} : { idempotencyKey }) } };
  }
  return { ok: true, command: { kind, key, revision, json: optionFlag(options, "--json"), ...(idempotencyKey === undefined ? {} : { idempotencyKey }) } };
}

function parseTaskAssign(tokens: readonly string[], json: boolean): ParseArgsResult {
  const options = parseOptions(tokens, new Set(["--revision", "--agent", "--fence", "--idempotency-key"]), new Set(["--json", "--clear"]));
  const key = validTaskKey(options?.positionals[0]);
  if (options === null || options.positionals.length !== 1 || key === null) return failure(json, "task assign requires exactly one valid task key");
  const revision = validPositiveOption(options, "--revision");
  if (revision === null) return failure(json, "--revision must be a positive integer");
  const clear = optionFlag(options, "--clear");
  const agentSource = optionString(options, "--agent");
  if (clear === (agentSource !== undefined)) return failure(json, "pass exactly one of --agent or --clear");
  const agent = agentSource === undefined ? undefined : agentIdSchema.safeParse(agentSource);
  if (agent !== undefined && !agent.success) return failure(json, "--agent is invalid");
  const fence = validOptionalPositive(options, "--fence");
  if (fence === null) return failure(json, "--fence must be a positive integer");
  const idempotencyKey = validMutationKey(options);
  if (idempotencyKey === null) return failure(json, "--idempotency-key must be UUIDv7");
  return { ok: true, command: { kind: "task_assign", key, revision, assigneeAgentId: clear ? null : agent?.data ?? null, ...(fence === undefined ? {} : { fence }), json: optionFlag(options, "--json"), ...(idempotencyKey === undefined ? {} : { idempotencyKey }) } };
}

function parseTaskDefer(tokens: readonly string[], json: boolean): ParseArgsResult {
  const options = parseOptions(tokens, new Set(["--revision", "--available-at", "--fence", "--idempotency-key"]), new Set(["--json"]));
  const key = validTaskKey(options?.positionals[0]);
  if (options === null || options.positionals.length !== 1 || key === null) return failure(json, "task defer requires exactly one valid task key");
  const revision = validPositiveOption(options, "--revision");
  const availableSource = optionString(options, "--available-at");
  const availableAt = availableSource === undefined ? null : parseSafeInteger(availableSource, 0, Number.MAX_SAFE_INTEGER);
  if (revision === null) return failure(json, "--revision must be a positive integer");
  if (availableAt === null) return failure(json, "--available-at must be an epoch millisecond integer");
  const fence = validOptionalPositive(options, "--fence");
  if (fence === null) return failure(json, "--fence must be a positive integer");
  const idempotencyKey = validMutationKey(options);
  if (idempotencyKey === null) return failure(json, "--idempotency-key must be UUIDv7");
  return { ok: true, command: { kind: "task_defer", key, revision, availableAt, ...(fence === undefined ? {} : { fence }), json: optionFlag(options, "--json"), ...(idempotencyKey === undefined ? {} : { idempotencyKey }) } };
}

function parseTaskLabel(kind: "task_label_add" | "task_label_remove" | "task_label_list", tokens: readonly string[], json: boolean): ParseArgsResult {
  const mutation = kind !== "task_label_list";
  const options = parseOptions(tokens, new Set(mutation ? ["--revision", "--label", "--fence", "--idempotency-key"] : []), new Set(["--json"]));
  const key = validTaskKey(options?.positionals[0]);
  if (options === null || options.positionals.length !== 1 || key === null) return failure(json, `${kind.replaceAll("_", " ")} requires exactly one valid task key`);
  if (!mutation) return { ok: true, command: { kind, key, json: optionFlag(options, "--json") } };
  const revision = validPositiveOption(options, "--revision");
  const label = taskLabelSchema.safeParse(optionString(options, "--label"));
  if (revision === null) return failure(json, "--revision must be a positive integer");
  if (!label.success) return failure(json, "--label is required and invalid");
  const fence = validOptionalPositive(options, "--fence");
  if (fence === null) return failure(json, "--fence must be a positive integer");
  const idempotencyKey = validMutationKey(options);
  if (idempotencyKey === null) return failure(json, "--idempotency-key must be UUIDv7");
  return { ok: true, command: { kind, key, revision, label: label.data, ...(fence === undefined ? {} : { fence }), json: optionFlag(options, "--json"), ...(idempotencyKey === undefined ? {} : { idempotencyKey }) } };
}

function parseTaskPaged(kind: "task_comment_list" | "task_events" | "task_ref_list", tokens: readonly string[], json: boolean): ParseArgsResult {
  const options = parseOptions(tokens, new Set(["--cursor", "--limit"]), new Set(["--json"]));
  const key = validTaskKey(options?.positionals[0]);
  if (options === null || options.positionals.length !== 1 || key === null) return failure(json, `${kind.replaceAll("_", " ")} requires exactly one valid task key`);
  const cursor = validCursor(options);
  const limit = validLimit(options);
  if (cursor === null) return failure(json, "--cursor must contain 1 through 8192 characters");
  if (limit === null) return failure(json, "--limit must be an integer from 1 through 100");
  return { ok: true, command: { kind, key, limit, json: optionFlag(options, "--json"), ...(cursor === undefined ? {} : { cursor }) } };
}

function parseTaskCommentAdd(tokens: readonly string[], json: boolean): ParseArgsResult {
  const options = parseOptions(tokens, new Set(["--body", "--idempotency-key"]), new Set(["--json"]));
  const key = validTaskKey(options?.positionals[0]);
  if (options === null || options.positionals.length !== 1 || key === null) return failure(json, "task comment add requires exactly one valid task key");
  const body = taskCommentBodySchema.safeParse(optionString(options, "--body"));
  if (!body.success) return failure(json, "--body is required and must be at most 16384 UTF-8 bytes");
  const idempotencyKey = validMutationKey(options);
  if (idempotencyKey === null) return failure(json, "--idempotency-key must be UUIDv7");
  return { ok: true, command: { kind: "task_comment_add", key, body: body.data, json: optionFlag(options, "--json"), ...(idempotencyKey === undefined ? {} : { idempotencyKey }) } };
}

function parseTaskDependency(kind: "task_dep_add" | "task_dep_remove" | "task_dep_list", tokens: readonly string[], json: boolean): ParseArgsResult {
  const mutation = kind !== "task_dep_list";
  const options = parseOptions(tokens, new Set(mutation ? ["--blocker", "--revision", "--fence", "--idempotency-key"] : ["--direction", "--cursor", "--limit"]), new Set(["--json"]));
  const key = validTaskKey(options?.positionals[0]);
  if (options === null || options.positionals.length !== 1 || key === null) return failure(json, `${kind.replaceAll("_", " ")} requires exactly one valid task key`);
  if (!mutation) {
    const direction = optionString(options, "--direction") ?? "both";
    if (direction !== "blockers" && direction !== "dependents" && direction !== "both") return failure(json, "--direction must be blockers, dependents, or both");
    const cursor = validCursor(options);
    const limit = validLimit(options);
    if (cursor === null || limit === null) return failure(json, "invalid pagination options");
    return { ok: true, command: { kind, key, direction, limit, json: optionFlag(options, "--json"), ...(cursor === undefined ? {} : { cursor }) } };
  }
  const blockerKey = validTaskKey(optionString(options, "--blocker"));
  const revision = validPositiveOption(options, "--revision");
  if (blockerKey === null) return failure(json, "--blocker must be a valid task key");
  if (revision === null) return failure(json, "--revision must be a positive integer");
  const fence = validOptionalPositive(options, "--fence");
  if (fence === null) return failure(json, "--fence must be a positive integer");
  const idempotencyKey = validMutationKey(options);
  if (idempotencyKey === null) return failure(json, "--idempotency-key must be UUIDv7");
  return { ok: true, command: { kind, key, blockerKey, revision, ...(fence === undefined ? {} : { fence }), json: optionFlag(options, "--json"), ...(idempotencyKey === undefined ? {} : { idempotencyKey }) } };
}

function parseTaskParent(kind: "task_parent_set" | "task_parent_clear", tokens: readonly string[], json: boolean): ParseArgsResult {
  const options = parseOptions(tokens, new Set(["--revision", "--fence", "--idempotency-key"]), new Set(["--json"]));
  const requiredPositionals = kind === "task_parent_set" ? 2 : 1;
  const key = validTaskKey(options?.positionals[0]);
  const parentKey = kind === "task_parent_set" ? validTaskKey(options?.positionals[1]) : undefined;
  if (options === null || options.positionals.length !== requiredPositionals || key === null || parentKey === null) return failure(json, `${kind.replaceAll("_", " ")} received invalid task keys`);
  const revision = validPositiveOption(options, "--revision");
  if (revision === null) return failure(json, "--revision must be a positive integer");
  const fence = validOptionalPositive(options, "--fence");
  if (fence === null) return failure(json, "--fence must be a positive integer");
  const idempotencyKey = validMutationKey(options);
  if (idempotencyKey === null) return failure(json, "--idempotency-key must be UUIDv7");
  return kind === "task_parent_set"
    ? { ok: true, command: { kind, key, parentKey: parentKey as TaskKey, revision, ...(fence === undefined ? {} : { fence }), json: optionFlag(options, "--json"), ...(idempotencyKey === undefined ? {} : { idempotencyKey }) } }
    : { ok: true, command: { kind, key, revision, ...(fence === undefined ? {} : { fence }), json: optionFlag(options, "--json"), ...(idempotencyKey === undefined ? {} : { idempotencyKey }) } };
}

function parseTaskGraph(tokens: readonly string[], json: boolean): ParseArgsResult {
  const options = parseOptions(tokens, new Set(["--depth", "--limit"]), new Set(["--json"]));
  const key = validTaskKey(options?.positionals[0]);
  if (options === null || options.positionals.length !== 1 || key === null) return failure(json, "task graph requires exactly one valid task key");
  const depth = validPositiveOption(options, "--depth");
  const limit = optionString(options, "--limit") === undefined ? null : parseSafeInteger(optionString(options, "--limit") as string, 1, 500);
  if (depth === null || depth > 100) return failure(json, "--depth must be an integer from 1 through 100");
  if (limit === null) return failure(json, "--limit must be an integer from 1 through 500");
  return { ok: true, command: { kind: "task_graph", key, depth, limit, json: optionFlag(options, "--json") } };
}

function parseWorkspaceRepo(kind: "workspace_repo_add" | "workspace_repo_list" | "workspace_repo_remove", tokens: readonly string[], json: boolean): ParseArgsResult {
  if (kind === "workspace_repo_list") {
    const options = parseOptions(tokens, new Set(["--cursor", "--limit"]), new Set(["--json"]));
    if (options === null || options.positionals.length !== 0) return failure(json, "workspace repo list received invalid arguments");
    const cursor = validCursor(options);
    const limit = validLimit(options);
    if (cursor === null || limit === null) return failure(json, "invalid pagination options");
    return { ok: true, command: { kind, limit, json: optionFlag(options, "--json"), ...(cursor === undefined ? {} : { cursor }) } };
  }
  if (kind === "workspace_repo_remove") {
    const options = parseOptions(tokens, new Set(["--idempotency-key"]), new Set(["--json"]));
    const repositoryId = repositoryIdSchema.safeParse(options?.positionals[0]);
    if (options === null || options.positionals.length !== 1 || !repositoryId.success) return failure(json, "workspace repo remove requires one valid repository ID");
    const idempotencyKey = validMutationKey(options);
    if (idempotencyKey === null) return failure(json, "--idempotency-key must be UUIDv7");
    return { ok: true, command: { kind, repositoryId: repositoryId.data, json: optionFlag(options, "--json"), ...(idempotencyKey === undefined ? {} : { idempotencyKey }) } };
  }
  const options = parseOptions(tokens, new Set(["--name", "--provider", "--url", "--idempotency-key"]), new Set(["--json"]));
  if (options === null || options.positionals.length !== 0) return failure(json, "workspace repo add received invalid arguments");
  const name = optionString(options, "--name")?.trim();
  const provider = repositoryProviderSchema.safeParse(optionString(options, "--provider"));
  const url = absoluteHttpsUrlSchema.safeParse(optionString(options, "--url"));
  if (name === undefined || name.length === 0 || new TextEncoder().encode(name).length > 160) return failure(json, "--name is required and must be at most 160 UTF-8 bytes");
  if (!provider.success) return failure(json, "--provider is invalid");
  if (!url.success) return failure(json, "--url must be an absolute HTTPS URL");
  const idempotencyKey = validMutationKey(options);
  if (idempotencyKey === null) return failure(json, "--idempotency-key must be UUIDv7");
  return { ok: true, command: { kind, name, provider: provider.data, url: url.data, json: optionFlag(options, "--json"), ...(idempotencyKey === undefined ? {} : { idempotencyKey }) } };
}

function parseTaskReference(kind: "task_ref_add" | "task_ref_remove", tokens: readonly string[], json: boolean): ParseArgsResult {
  const options = parseOptions(tokens, new Set(["--revision", "--fence", "--kind", "--repository", "--url", "--sha", "--name", "--label", "--idempotency-key"]), new Set(["--json"]));
  const key = validTaskKey(options?.positionals[0]);
  const requiredPositionals = kind === "task_ref_remove" ? 2 : 1;
  if (options === null || options.positionals.length !== requiredPositionals || key === null) return failure(json, `${kind.replaceAll("_", " ")} received invalid task keys`);
  const revision = validPositiveOption(options, "--revision");
  if (revision === null) return failure(json, "--revision must be a positive integer");
  const fence = validOptionalPositive(options, "--fence");
  if (fence === null) return failure(json, "--fence must be a positive integer");
  const idempotencyKey = validMutationKey(options);
  if (idempotencyKey === null) return failure(json, "--idempotency-key must be UUIDv7");
  if (kind === "task_ref_remove") {
    const referenceId = taskReferenceIdSchema.safeParse(options.positionals[1]);
    if (!referenceId.success) return failure(json, "reference ID is invalid");
    if (["--kind", "--repository", "--url", "--sha", "--name", "--label"].some((name) => options.values.has(name))) return failure(json, "task ref remove does not accept reference fields");
    return { ok: true, command: { kind, key, referenceId: referenceId.data, revision, ...(fence === undefined ? {} : { fence }), json: optionFlag(options, "--json"), ...(idempotencyKey === undefined ? {} : { idempotencyKey }) } };
  }
  const referenceKind = optionString(options, "--kind");
  const repositoryId = optionString(options, "--repository");
  const url = optionString(options, "--url");
  const sha = optionString(options, "--sha");
  const name = optionString(options, "--name");
  const label = optionString(options, "--label");
  let candidate: unknown;
  switch (referenceKind) {
    case "repository": candidate = { kind: referenceKind, repositoryId }; break;
    case "pull_request": candidate = { kind: referenceKind, url, ...(repositoryId === undefined ? {} : { repositoryId }) }; break;
    case "commit": candidate = { kind: referenceKind, sha, ...(repositoryId === undefined ? {} : { repositoryId }), ...(url === undefined ? {} : { url }) }; break;
    case "artifact": candidate = { kind: referenceKind, name, url }; break;
    case "url": candidate = { kind: referenceKind, label, url }; break;
    case undefined:
    default:
      return failure(json, "--kind must be repository, pull_request, commit, artifact, or url");
  }
  const reference = taskReferenceInputSchema.safeParse(candidate);
  if (!reference.success) return failure(json, "reference kind-specific fields are invalid");
  return { ok: true, command: { kind, key, revision, reference: reference.data, ...(fence === undefined ? {} : { fence }), json: optionFlag(options, "--json"), ...(idempotencyKey === undefined ? {} : { idempotencyKey }) } };
}

function parseTaskSubmit(tokens: readonly string[], json: boolean): ParseArgsResult {
  const options = parseOptions(tokens, new Set(["--fence", "--summary", "--evidence-json", "--idempotency-key"]), new Set(["--json"]));
  const key = validTaskKey(options?.positionals[0]);
  if (options === null || options.positionals.length !== 1 || key === null) return failure(json, "task submit requires exactly one valid task key");
  const fence = validPositiveOption(options, "--fence");
  const summary = submissionSummarySchema.safeParse(optionString(options, "--summary"));
  if (fence === null) return failure(json, "--fence must be a positive integer");
  if (!summary.success) return failure(json, "--summary is required and must be at most 16384 UTF-8 bytes");
  let rawEvidence: unknown;
  try { rawEvidence = JSON.parse(optionString(options, "--evidence-json") ?? ""); } catch { return failure(json, "--evidence-json must be valid JSON"); }
  if (!Array.isArray(rawEvidence) || rawEvidence.length < 1 || rawEvidence.length > 50) return failure(json, "--evidence-json must be an array containing 1 through 50 entries");
  const evidence = rawEvidence.map((entry) => submissionEvidenceInputSchema.safeParse(entry));
  if (evidence.some((entry) => !entry.success)) return failure(json, "--evidence-json contains an invalid or unknown field");
  const parsedEvidence = evidence.map((entry) => {
    if (!entry.success) throw new Error("evidence parser invariant failed");
    return entry.data;
  });
  const idempotencyKey = validMutationKey(options);
  if (idempotencyKey === null) return failure(json, "--idempotency-key must be UUIDv7");
  return { ok: true, command: { kind: "task_submit", key, fence, summary: summary.data, evidence: parsedEvidence, json: optionFlag(options, "--json"), ...(idempotencyKey === undefined ? {} : { idempotencyKey }) } };
}

function parseReviewMutation(kind: "task_accept" | "task_reject", tokens: readonly string[], json: boolean): ParseArgsResult {
  const options = parseOptions(tokens, new Set(kind === "task_reject" ? ["--submission", "--review-revision", "--reason", "--idempotency-key"] : ["--submission", "--review-revision", "--idempotency-key"]), new Set(["--json"]));
  const key = validTaskKey(options?.positionals[0]);
  if (options === null || options.positionals.length !== 1 || key === null) return failure(json, `${kind.replaceAll("_", " ")} requires exactly one valid task key`);
  const submissionId = taskSubmissionIdSchema.safeParse(optionString(options, "--submission"));
  const reviewRevision = validPositiveOption(options, "--review-revision");
  if (!submissionId.success) return failure(json, "--submission is invalid");
  if (reviewRevision === null) return failure(json, "--review-revision must be a positive integer");
  const reason = kind === "task_reject" ? reviewReasonSchema.safeParse(optionString(options, "--reason")) : undefined;
  if (reason !== undefined && !reason.success) return failure(json, "--reason is required and invalid");
  const idempotencyKey = validMutationKey(options);
  if (idempotencyKey === null) return failure(json, "--idempotency-key must be UUIDv7");
  return { ok: true, command: { kind, key, submissionId: submissionId.data, reviewRevision, ...(reason === undefined || !reason.success ? {} : { reason: reason.data }), json: optionFlag(options, "--json"), ...(idempotencyKey === undefined ? {} : { idempotencyKey }) } };
}

function parseReviewQueue(tokens: readonly string[], json: boolean): ParseArgsResult {
  const options = parseOptions(tokens, new Set(["--cursor", "--limit"]), new Set(["--json"]));
  if (options === null || options.positionals.length !== 0) return failure(json, "review queue received invalid arguments");
  const cursor = validCursor(options);
  const limit = validLimit(options);
  if (cursor === null || limit === null) return failure(json, "invalid pagination options");
  return { ok: true, command: { kind: "review_queue", limit, json: optionFlag(options, "--json"), ...(cursor === undefined ? {} : { cursor }) } };
}

function parseTaskMutation(
  kind: "task_claim" | "task_claim_renew" | "task_release",
  tokens: readonly string[],
  json: boolean,
): ParseArgsResult {
  const needsFence = kind !== "task_claim";
  const options = parseOptions(
    tokens,
    new Set(needsFence ? ["--fence", "--idempotency-key"] : ["--idempotency-key"]),
    new Set(["--json"]),
  );
  if (options === null || options.positionals.length !== 1) {
    return failure(json, `${kind.replaceAll("_", " ")} requires exactly one task key`);
  }
  const keyResult = taskKeySchema.safeParse(options.positionals[0]);
  if (!keyResult.success) return failure(json, "task key is invalid");
  const idempotencyKey = parseIdempotencyKey(options);
  if (idempotencyKey === null) return failure(json, "--idempotency-key must be UUIDv7");
  if (!needsFence) {
    return {
      ok: true,
      command: {
        kind,
        key: keyResult.data,
        json: optionFlag(options, "--json"),
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      },
    };
  }

  const fenceValue = optionString(options, "--fence");
  const fence =
    fenceValue === undefined ? null : parseSafeInteger(fenceValue, 1, Number.MAX_SAFE_INTEGER);
  if (fence === null) return failure(json, "--fence must be a positive integer");
  return {
    ok: true,
    command: {
      kind,
      key: keyResult.data,
      fence,
      json: optionFlag(options, "--json"),
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    },
  };
}

export function parseArgs(argv: readonly string[]): ParseArgsResult {
  const json = argv.includes("--json");
  if (argv.some(containsSecret)) {
    return failure(json, "secret values are not accepted on the command line");
  }
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    return { ok: true, command: { kind: "help", json } };
  }

  const [first, second, third] = argv;
  if (first === "auth" && second === "login") return parseLogin(argv.slice(2), json);
  if (first === "auth" && second === "enroll") return parseEnroll(argv.slice(2), json);
  if (first === "auth" && second === "migrate-agent-credential") {
    return parseAgentCredentialMigration(argv.slice(2), json);
  }
  if (first === "auth" && second === "status") return parseSimple("auth_status", argv.slice(2), json);
  if (first === "auth" && second === "logout") return parseSimple("auth_logout", argv.slice(2), json);
  if (first === "context") return parseSimple("context", argv.slice(1), json);
  if (first === "organization" && second === "list") {
    return parseList("organization_list", argv.slice(2), json);
  }
  if (first === "organization" && second === "create") {
    return parseOrganizationCreate(argv.slice(2), json);
  }
  if (first === "organization" && second === "use") {
    return parseUse("organization_use", argv.slice(2), json);
  }
  if (first === "workspace" && second === "list") {
    return parseList("workspace_list", argv.slice(2), json);
  }
  if (first === "workspace" && second === "create") {
    return parseWorkspaceCreate(argv.slice(2), json);
  }
  if (first === "workspace" && second === "use") {
    return parseUse("workspace_use", argv.slice(2), json);
  }
  if (first === "workspace" && second === "repo" && third === "add") {
    return parseWorkspaceRepo("workspace_repo_add", argv.slice(3), json);
  }
  if (first === "workspace" && second === "repo" && third === "list") {
    return parseWorkspaceRepo("workspace_repo_list", argv.slice(3), json);
  }
  if (first === "workspace" && second === "repo" && third === "remove") {
    return parseWorkspaceRepo("workspace_repo_remove", argv.slice(3), json);
  }
  if (first === "agent" && second === "create") return parseAgentCreate(argv.slice(2), json);
  if (first === "agent" && second === "list") return parseAgentList(argv.slice(2), json);
  if (first === "agent" && second === "show") return parseAgentShow(argv.slice(2), json);
  if (first === "agent" && second === "enrollment" && third === "create") {
    return parseAgentEnrollmentCreate(argv.slice(3), json);
  }
  if (first === "agent" && second === "credential" && third === "list") {
    return parseAgentMetadataList("agent_credential_list", argv.slice(3), json);
  }
  if (first === "agent" && second === "credential" && third === "revoke") {
    return parseAgentCredentialRevoke(argv.slice(3), json);
  }
  if (first === "agent" && second === "session" && third === "list") {
    return parseAgentMetadataList("agent_session_list", argv.slice(3), json);
  }
  if (first === "agent" && second === "disable") return parseAgentDisable(argv.slice(2), json);
  if (first === "task" && second === "create") return parseTaskCreate(argv.slice(2), json);
  if (first === "task" && second === "show") return parseTaskShow(argv.slice(2), json);
  if (first === "task" && second === "list") return parseTaskList(argv.slice(2), json);
  if (first === "task" && second === "ready") return parseTaskReady(argv.slice(2), json);
  if (first === "task" && second === "blocked") return parseTaskBlocked(argv.slice(2), json);
  if (first === "task" && second === "update") return parseTaskUpdate(argv.slice(2), json);
  if (first === "task" && second === "cancel") return parseTaskLifecycle("task_cancel", argv.slice(2), json);
  if (first === "task" && second === "reopen") return parseTaskLifecycle("task_reopen", argv.slice(2), json);
  if (first === "task" && second === "assign") return parseTaskAssign(argv.slice(2), json);
  if (first === "task" && second === "defer") return parseTaskDefer(argv.slice(2), json);
  if (first === "task" && second === "label" && third === "add") return parseTaskLabel("task_label_add", argv.slice(3), json);
  if (first === "task" && second === "label" && third === "remove") return parseTaskLabel("task_label_remove", argv.slice(3), json);
  if (first === "task" && second === "label" && third === "list") return parseTaskLabel("task_label_list", argv.slice(3), json);
  if (first === "task" && second === "comment" && third === "add") return parseTaskCommentAdd(argv.slice(3), json);
  if (first === "task" && second === "comment" && third === "list") return parseTaskPaged("task_comment_list", argv.slice(3), json);
  if (first === "task" && second === "events") return parseTaskPaged("task_events", argv.slice(2), json);
  if (first === "task" && second === "dep" && third === "add") return parseTaskDependency("task_dep_add", argv.slice(3), json);
  if (first === "task" && second === "dep" && third === "remove") return parseTaskDependency("task_dep_remove", argv.slice(3), json);
  if (first === "task" && second === "dep" && third === "list") return parseTaskDependency("task_dep_list", argv.slice(3), json);
  if (first === "task" && second === "parent" && third === "set") return parseTaskParent("task_parent_set", argv.slice(3), json);
  if (first === "task" && second === "parent" && third === "clear") return parseTaskParent("task_parent_clear", argv.slice(3), json);
  if (first === "task" && second === "graph") return parseTaskGraph(argv.slice(2), json);
  if (first === "task" && second === "ref" && third === "add") return parseTaskReference("task_ref_add", argv.slice(3), json);
  if (first === "task" && second === "ref" && third === "remove") return parseTaskReference("task_ref_remove", argv.slice(3), json);
  if (first === "task" && second === "ref" && third === "list") return parseTaskPaged("task_ref_list", argv.slice(3), json);
  if (first === "task" && second === "claim" && third === "renew") {
    return parseTaskMutation("task_claim_renew", argv.slice(3), json);
  }
  if (first === "task" && second === "claim") {
    return parseTaskMutation("task_claim", argv.slice(2), json);
  }
  if (first === "task" && second === "release") {
    return parseTaskMutation("task_release", argv.slice(2), json);
  }
  if (first === "task" && second === "submit") return parseTaskSubmit(argv.slice(2), json);
  if (first === "task" && second === "accept") return parseReviewMutation("task_accept", argv.slice(2), json);
  if (first === "task" && second === "reject") return parseReviewMutation("task_reject", argv.slice(2), json);
  if (first === "review" && second === "queue") return parseReviewQueue(argv.slice(2), json);
  return failure(json, "unknown command");
}
