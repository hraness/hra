import type { Database } from "bun:sqlite";
import {
  canonicalSessionSyncJson,
  sessionPublicIdSchema,
  syncSha256DigestSchema,
  type SessionPublicId,
  type SessionSyncBackendRequest,
  type SyncSha256Digest,
} from "@hraness/agent-tasks-protocol";
import { z } from "@hra-internal/schema";

const MAX_ACTIVE_SESSION_OPERATIONS = 64;
const MAX_JOURNAL_ROWS = 512;
const RETAINED_TERMINAL_ROWS = 256;

type ReplayPolicy = "exact_replay" | "deterministic_reconcile";
type OperationScopeKind = "global" | "heartbeat" | "observer" | "session";

interface ReadPolicyDefinition {
  readonly access: "read";
  readonly replay: "fresh_retry";
}

interface MutationPolicyDefinition {
  readonly access: "mutation";
  readonly replay: ReplayPolicy;
  readonly scope: OperationScopeKind;
}

type OperationPolicyDefinition = ReadPolicyDefinition | MutationPolicyDefinition;

/**
 * Exhaustive against the protocol union. A new wire operation fails
 * typechecking until its crash policy is consciously classified here.
 */
export const sessionSyncWireOperationPolicies = {
  admit_membership_proposal: {
    access: "mutation",
    replay: "deterministic_reconcile",
    scope: "global",
  },
  update_membership: {
    access: "mutation",
    replay: "exact_replay",
    scope: "global",
  },
  read_membership: { access: "read", replay: "fresh_retry" },
  list_enrollment_requests: { access: "read", replay: "fresh_retry" },
  approve_enrollment: {
    access: "mutation",
    replay: "exact_replay",
    scope: "global",
  },
  root_key_link_page: { access: "read", replay: "fresh_retry" },
  establish_boot: {
    access: "mutation",
    replay: "deterministic_reconcile",
    scope: "global",
  },
  heartbeat: {
    access: "mutation",
    replay: "deterministic_reconcile",
    scope: "heartbeat",
  },
  reserve_session: {
    access: "mutation",
    replay: "deterministic_reconcile",
    scope: "session",
  },
  acquire_writer: {
    access: "mutation",
    replay: "deterministic_reconcile",
    scope: "session",
  },
  publish_session: {
    access: "mutation",
    replay: "exact_replay",
    scope: "session",
  },
  delete_session: {
    access: "mutation",
    replay: "deterministic_reconcile",
    scope: "session",
  },
  put_scheduled_chat: {
    access: "mutation",
    replay: "exact_replay",
    scope: "session",
  },
  clear_scheduled_chat: {
    access: "mutation",
    replay: "exact_replay",
    scope: "session",
  },
  clear_orphaned_scheduled_chat: {
    access: "mutation",
    replay: "deterministic_reconcile",
    scope: "session",
  },
  scheduled_chat_inventory: { access: "read", replay: "fresh_retry" },
  scheduled_run_page: { access: "read", replay: "fresh_retry" },
  ack_scheduled_run: {
    access: "mutation",
    replay: "exact_replay",
    scope: "session",
  },
  begin_snapshot: {
    access: "mutation",
    replay: "deterministic_reconcile",
    scope: "observer",
  },
  snapshot_page: { access: "read", replay: "fresh_retry" },
  change_page: { access: "read", replay: "fresh_retry" },
} as const satisfies Record<
  SessionSyncBackendRequest["operation"],
  OperationPolicyDefinition
>;

export type SessionSyncHumanOperation =
  | "negotiate"
  | "bootstrap_vault"
  | "submit_enrollment"
  | "claim_enrollment"
  | "recovery_context"
  | "recover_vault";

export const sessionSyncHumanOperationPolicies = {
  negotiate: { access: "read", replay: "fresh_retry" },
  bootstrap_vault: {
    access: "mutation",
    replay: "exact_replay",
    scope: "global",
  },
  submit_enrollment: {
    access: "mutation",
    replay: "deterministic_reconcile",
    scope: "global",
  },
  claim_enrollment: {
    access: "mutation",
    replay: "deterministic_reconcile",
    scope: "global",
  },
  recovery_context: { access: "read", replay: "fresh_retry" },
  recover_vault: {
    access: "mutation",
    replay: "exact_replay",
    scope: "global",
  },
} as const satisfies Record<SessionSyncHumanOperation, OperationPolicyDefinition>;

type MutationKeys<Registry> = {
  [Key in keyof Registry]: Registry[Key] extends MutationPolicyDefinition
    ? Key
    : never;
}[keyof Registry];

export type SessionSyncMutationKind =
  | MutationKeys<typeof sessionSyncWireOperationPolicies>
  | MutationKeys<typeof sessionSyncHumanOperationPolicies>;

export const sessionSyncOperationIdSchema = z.string()
  .min(11)
  .max(96)
  .regex(/^syncop_[A-Za-z0-9_-]+$/u);
const safeIntegerSchema = z.number().int().nonnegative().safe();
const keychainReferenceSchema = z.object({
  service: z.string().min(1).max(240),
  name: z.string().min(1).max(512),
}).strict();
const recoverySupersedeEvidenceSchema = z.object({
  serverMembershipDigest: syncSha256DigestSchema,
  recoveryAuthorityDigest: syncSha256DigestSchema,
  recoveryIntentDigest: syncSha256DigestSchema,
  observedAt: safeIntegerSchema,
}).strict();

const operationRowSchema = z.object({
  operation_id: sessionSyncOperationIdSchema,
  operation_kind: z.string().min(3).max(64),
  replay_policy: z.enum(["exact_replay", "deterministic_reconcile"]),
  scope_kind: z.enum(["global", "heartbeat", "observer", "session"]),
  scope_id: sessionPublicIdSchema.nullable(),
  state: z.enum(["prepared", "dispatched", "ambiguous", "terminal"]),
  request_digest: syncSha256DigestSchema,
  canonical_request_json: z.string().min(2).max(131_072),
  keychain_references_json: z.string().min(2).max(4_096),
  response_digest: syncSha256DigestSchema.nullable(),
  outcome_json: z.string().min(2).max(32_768).nullable(),
  created_at: safeIntegerSchema,
  updated_at: safeIntegerSchema,
  terminal_at: safeIntegerSchema.nullable(),
}).strict();

export interface SessionSyncOperationJournalEntry {
  readonly operationId: string;
  readonly kind: SessionSyncMutationKind;
  readonly replayPolicy: ReplayPolicy;
  readonly scope: Readonly<{
    kind: OperationScopeKind;
    sessionId: SessionPublicId | null;
  }>;
  readonly state: "prepared" | "dispatched" | "ambiguous" | "terminal";
  readonly requestDigest: SyncSha256Digest;
  readonly request: unknown;
  readonly keychainReferences: readonly Readonly<{
    service: string;
    name: string;
  }>[];
  readonly responseDigest: SyncSha256Digest | null;
  readonly outcome: unknown;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly terminalAt: number | null;
}

/**
 * The only restart actions the coordinator may take for a durable mutation.
 * A request is replayable only when the journal proves it never crossed the
 * dispatch fence, or when the operation's protocol contract is exactly
 * idempotent. Ambiguous reconcile-only effects are never sent automatically.
 */
export type SessionSyncOperationRestartDisposition =
  | "dispatch_prepared"
  | "replay_exact"
  | "reconcile_only";

export interface SessionSyncOperationRestartWork {
  readonly entry: SessionSyncOperationJournalEntry;
  readonly disposition: SessionSyncOperationRestartDisposition;
}

export class SessionSyncOperationJournalError extends Error {
  readonly code: "conflict" | "corrupt_state" | "limit" | "not_found";

  constructor(
    code: SessionSyncOperationJournalError["code"],
    message: string,
  ) {
    super(message);
    this.name = "SessionSyncOperationJournalError";
    this.code = code;
  }
}

function policyFor(kind: SessionSyncMutationKind): MutationPolicyDefinition {
  const policy: OperationPolicyDefinition = {
    ...sessionSyncWireOperationPolicies,
    ...sessionSyncHumanOperationPolicies,
  }[kind];
  if (policy.access !== "mutation") {
    throw new TypeError("Read-only session sync operations are never journaled.");
  }
  return policy;
}

const forbiddenSecretFields = new Set([
  "accessToken",
  "access_token",
  "bearerToken",
  "bearer_token",
  "password",
  "passphrase",
  "refreshToken",
  "refresh_token",
  "signingPkcs8",
  "agreementPkcs8",
  "recoverySigningPkcs8",
  "recoveryAgreementPkcs8",
  "recoveryKit",
  "rootKey",
  "privateKey",
  "privateKeyMaterial",
  "secret",
  "credential",
]);

function assertJournalSafe(value: unknown, path = "request"): void {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      assertJournalSafe(value[index], `${path}[${String(index)}]`);
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (
      forbiddenSecretFields.has(key)
      || /pkcs8/iu.test(key)
      || /(?:password|passphrase|credential|secret)$/iu.test(key)
      || /^(?:access|refresh|bearer|id)[_-]?token$/iu.test(key)
      || /^(?:private[_-]?key(?:[_-]?material)?|root[_-]?key|recovery[_-]?kit)$/iu.test(key)
    ) {
      throw new TypeError(`Session sync journal cannot persist ${path}.${key}.`);
    }
    assertJournalSafe(child, `${path}.${key}`);
  }
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new SessionSyncOperationJournalError(
      "corrupt_state",
      `${label} is invalid.`,
    );
  }
}

function operationKind(value: string): SessionSyncMutationKind {
  const policies: Readonly<Record<string, OperationPolicyDefinition>> = {
    ...sessionSyncWireOperationPolicies,
    ...sessionSyncHumanOperationPolicies,
  };
  const policy = policies[value];
  if (policy?.access !== "mutation") {
    throw new SessionSyncOperationJournalError(
      "corrupt_state",
      "Session sync journal operation kind is invalid.",
    );
  }
  return value as SessionSyncMutationKind;
}

function fromRow(value: unknown): SessionSyncOperationJournalEntry {
  try {
    const row = operationRowSchema.parse(value);
    const kind = operationKind(row.operation_kind);
    const policy = policyFor(kind);
    const references = z.array(keychainReferenceSchema).max(16).parse(
      parseJson(row.keychain_references_json, "Session sync Keychain references"),
    );
    const request = parseJson(row.canonical_request_json, "Session sync request");
    const outcome = row.outcome_json === null
      ? null
      : parseJson(row.outcome_json, "Session sync outcome");
    const canonicalRequest = canonical(request, 131_072, "request");
    const canonicalReferences = canonical(references, 4_096, "Keychain references");
    const canonicalOutcome = outcome === null
      ? null
      : canonical(outcome, 32_768, "outcome");
    if (
      row.replay_policy !== policy.replay
      || row.scope_kind !== policy.scope
      || (row.scope_kind === "session") !== (row.scope_id !== null)
      || row.canonical_request_json !== canonicalRequest
      || row.request_digest !== digestCanonicalJson(canonicalRequest)
      || row.keychain_references_json !== canonicalReferences
      || row.outcome_json !== canonicalOutcome
      || (row.state === "terminal") !== (
        row.response_digest !== null
        && canonicalOutcome !== null
        && row.terminal_at !== null
      )
      || (row.state !== "terminal" && (
        row.response_digest !== null
        || row.outcome_json !== null
        || row.terminal_at !== null
      ))
      || (
        canonicalOutcome !== null
        && row.response_digest !== digestCanonicalJson(canonicalOutcome)
      )
      || row.updated_at < row.created_at
      || (row.terminal_at !== null && row.terminal_at !== row.updated_at)
    ) {
      throw new SessionSyncOperationJournalError(
        "corrupt_state",
        "Session sync journal integrity check failed.",
      );
    }
    return {
      operationId: row.operation_id,
      kind,
      replayPolicy: row.replay_policy,
      scope: { kind: row.scope_kind, sessionId: row.scope_id },
      state: row.state,
      requestDigest: row.request_digest,
      request,
      keychainReferences: references,
      responseDigest: row.response_digest,
      outcome,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      terminalAt: row.terminal_at,
    };
  } catch (error) {
    if (error instanceof SessionSyncOperationJournalError) throw error;
    throw new SessionSyncOperationJournalError(
      "corrupt_state",
      "Session sync journal row is invalid.",
    );
  }
}

function canonical(value: unknown, maximumBytes: number, label: string): string {
  assertJournalSafe(value, label);
  let serialized: string;
  try {
    serialized = canonicalSessionSyncJson(value);
  } catch {
    throw new TypeError(`${label} must be canonical JSON.`);
  }
  if (new TextEncoder().encode(serialized).byteLength > maximumBytes) {
    throw new TypeError(`${label} is too large.`);
  }
  return serialized;
}

export function digestSessionSyncJournalValue(value: unknown): SyncSha256Digest {
  const serialized = canonical(value, 131_072, "request");
  return digestCanonicalJson(serialized);
}

function digestCanonicalJson(serialized: string): SyncSha256Digest {
  const digest = new Bun.CryptoHasher("sha256").update(serialized).digest("hex");
  return syncSha256DigestSchema.parse(`sha256_${digest}`);
}

export function createSessionSyncOperationId(
  randomBytes: (target: Uint8Array) => void = (target) => crypto.getRandomValues(target),
): string {
  const bytes = new Uint8Array(16);
  randomBytes(bytes);
  return sessionSyncOperationIdSchema.parse(
    `syncop_${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`,
  );
}

export function classifySessionSyncOperationRestart(
  entry: SessionSyncOperationJournalEntry,
): SessionSyncOperationRestartDisposition | null {
  if (entry.state === "terminal") return null;
  if (entry.state === "prepared") return "dispatch_prepared";
  return entry.replayPolicy === "exact_replay"
    ? "replay_exact"
    : "reconcile_only";
}

export class SessionSyncOperationJournal {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  prepare(input: {
    readonly operationId: string;
    readonly kind: SessionSyncMutationKind;
    readonly sessionId?: SessionPublicId;
    readonly request: unknown;
    readonly requestDigest?: SyncSha256Digest;
    readonly keychainReferences?: readonly Readonly<{
      service: string;
      name: string;
    }>[];
    readonly now: number;
  }): SessionSyncOperationJournalEntry {
    const operationId = sessionSyncOperationIdSchema.parse(input.operationId);
    const policy = policyFor(input.kind);
    const sessionId = policy.scope === "session"
      ? sessionPublicIdSchema.parse(input.sessionId)
      : null;
    if (policy.scope !== "session" && input.sessionId !== undefined) {
      throw new TypeError("Only session-scoped operations accept a session ID.");
    }
    const requestJson = canonical(input.request, 131_072, "request");
    const requestDigest = digestCanonicalJson(requestJson);
    if (
      input.requestDigest !== undefined
      && syncSha256DigestSchema.parse(input.requestDigest) !== requestDigest
    ) throw new TypeError("Session sync journal request digest does not match its canonical request.");
    const references = z.array(keychainReferenceSchema).max(16).parse(
      input.keychainReferences ?? [],
    );
    const referencesJson = canonicalSessionSyncJson(references);
    const now = safeIntegerSchema.parse(input.now);

    return this.#database.transaction(() => {
      const current = this.get(operationId);
      if (current !== null) {
        if (
          current.kind !== input.kind
          || current.replayPolicy !== policy.replay
          || current.scope.kind !== policy.scope
          || current.scope.sessionId !== sessionId
          || current.requestDigest !== requestDigest
          || canonicalSessionSyncJson(current.request) !== requestJson
          || canonicalSessionSyncJson(current.keychainReferences) !== referencesJson
        ) {
          throw new SessionSyncOperationJournalError(
            "conflict",
            "Session sync operation ID was reused with different intent.",
          );
        }
        return current;
      }
      this.#pruneTerminal();
      const total = z.object({ count: safeIntegerSchema }).strict().parse(
        this.#database.query(`
          SELECT COUNT(*) AS count FROM session_sync_operation_journal
        `).get(),
      ).count;
      if (total >= MAX_JOURNAL_ROWS) {
        throw new SessionSyncOperationJournalError(
          "limit",
          "Session sync operation journal is full.",
        );
      }
      if (policy.scope === "session") {
        const active = z.object({ count: safeIntegerSchema }).strict().parse(
          this.#database.query(`
            SELECT COUNT(*) AS count FROM session_sync_operation_journal
            WHERE scope_kind = 'session' AND state != 'terminal'
          `).get(),
        ).count;
        if (active >= MAX_ACTIVE_SESSION_OPERATIONS) {
          throw new SessionSyncOperationJournalError(
            "limit",
            "Session sync session-operation capacity is full.",
          );
        }
      }
      try {
        this.#database.query(`
          INSERT INTO session_sync_operation_journal(
            operation_id, operation_kind, replay_policy, scope_kind,
            scope_id, state, request_digest, canonical_request_json,
            keychain_references_json, response_digest, outcome_json,
            created_at, updated_at, terminal_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, 'prepared', ?6, ?7, ?8,
            NULL, NULL, ?9, ?9, NULL)
        `).run(
          operationId,
          input.kind,
          policy.replay,
          policy.scope,
          sessionId,
          requestDigest,
          requestJson,
          referencesJson,
          now,
        );
      } catch {
        throw new SessionSyncOperationJournalError(
          "conflict",
          "Another session sync operation already owns this scope.",
        );
      }
      return this.get(operationId) as SessionSyncOperationJournalEntry;
    })();
  }

  get(operationIdValue: string): SessionSyncOperationJournalEntry | null {
    const operationId = sessionSyncOperationIdSchema.parse(operationIdValue);
    const value: unknown = this.#database.query(`
      SELECT operation_id, operation_kind, replay_policy, scope_kind,
        scope_id, state, request_digest, canonical_request_json,
        keychain_references_json, response_digest, outcome_json,
        created_at, updated_at, terminal_at
      FROM session_sync_operation_journal WHERE operation_id = ?1
    `).get(operationId);
    return value === null ? null : fromRow(value);
  }

  listRecoverable(): readonly SessionSyncOperationJournalEntry[] {
    const values: unknown[] = this.#database.query(`
      SELECT operation_id, operation_kind, replay_policy, scope_kind,
        scope_id, state, request_digest, canonical_request_json,
        keychain_references_json, response_digest, outcome_json,
        created_at, updated_at, terminal_at
      FROM session_sync_operation_journal
      WHERE state != 'terminal'
      ORDER BY created_at, operation_id
      LIMIT 67
    `).all();
    return values.map(fromRow);
  }

  listRestartWork(): readonly SessionSyncOperationRestartWork[] {
    return this.listRecoverable().map((entry) => {
      const disposition = classifySessionSyncOperationRestart(entry);
      if (disposition === null) {
        throw new SessionSyncOperationJournalError(
          "corrupt_state",
          "Terminal session sync operation appeared in restart work.",
        );
      }
      return { entry, disposition };
    });
  }

  markDispatched(operationId: string, now: number): SessionSyncOperationJournalEntry {
    return this.#advance(operationId, ["prepared"], "dispatched", now);
  }

  markAmbiguous(operationId: string, now: number): SessionSyncOperationJournalEntry {
    return this.#advance(
      operationId,
      ["prepared", "dispatched", "ambiguous"],
      "ambiguous",
      now,
    );
  }

  settle(input: {
    readonly operationId: string;
    readonly responseDigest?: SyncSha256Digest;
    readonly outcome: unknown;
    readonly now: number;
  }): SessionSyncOperationJournalEntry {
    const operationId = sessionSyncOperationIdSchema.parse(input.operationId);
    const current = this.get(operationId);
    if (current === null) {
      throw new SessionSyncOperationJournalError(
        "not_found",
        "Session sync operation is missing.",
      );
    }
    if (input.outcome === null) {
      throw new TypeError("Session sync terminal outcome cannot be null.");
    }
    const outcomeJson = canonical(input.outcome, 32_768, "outcome");
    const responseDigest = digestCanonicalJson(outcomeJson);
    if (
      input.responseDigest !== undefined
      && syncSha256DigestSchema.parse(input.responseDigest) !== responseDigest
    ) throw new TypeError("Session sync journal response digest does not match its canonical outcome.");
    if (current.state === "terminal") {
      if (
        current.responseDigest !== responseDigest
        || canonicalSessionSyncJson(current.outcome) !== outcomeJson
      ) {
        throw new SessionSyncOperationJournalError(
          "conflict",
          "Session sync terminal operation outcome changed.",
        );
      }
      return current;
    }
    const now = safeIntegerSchema.parse(input.now);
    if (now < current.updatedAt) {
      throw new SessionSyncOperationJournalError(
        "conflict",
        "Session sync operation time cannot move backward.",
      );
    }
    this.#database.query(`
      UPDATE session_sync_operation_journal
      SET state = 'terminal', response_digest = ?2, outcome_json = ?3,
        updated_at = ?4, terminal_at = ?4
      WHERE operation_id = ?1 AND state != 'terminal'
    `).run(operationId, responseDigest, outcomeJson, now);
    return this.get(operationId) as SessionSyncOperationJournalEntry;
  }

  /**
   * Commits a terminal remote result and its same-database local postimage as
   * one SQLite unit. This is required for encrypted schedule writes: a crash
   * may leave the exact cloud request replayable, but it must never leave a
   * terminal journal row without the corresponding local pane state.
   */
  settleAtomically<Value>(
    input: Parameters<SessionSyncOperationJournal["settle"]>[0],
    applyLocalPostimage: () => Value,
  ): Readonly<{
    entry: SessionSyncOperationJournalEntry;
    value: Value;
  }> {
    return this.#database.transaction(() => {
      const entry = this.settle(input);
      const value = applyLocalPostimage();
      return { entry, value };
    })();
  }

  /**
   * Explicit recovery escape hatch for a lost ordinary device authority. The
   * caller must have stopped the dispatcher, freshly read server membership,
   * and verified the recovery authority. The old ambiguous global mutation is
   * terminally fenced in the same transaction that admits the recovery intent.
   */
  supersedeGlobalForRecovery(input: {
    readonly supersededOperationId: string;
    readonly expectedSupersededRequestDigest: SyncSha256Digest;
    readonly operationId: string;
    readonly request: unknown;
    readonly keychainReferences?: readonly Readonly<{
      service: string;
      name: string;
    }>[];
    readonly evidence: Readonly<{
      serverMembershipDigest: SyncSha256Digest;
      recoveryAuthorityDigest: SyncSha256Digest;
      recoveryIntentDigest: SyncSha256Digest;
      observedAt: number;
    }>;
    readonly now: number;
  }): SessionSyncOperationJournalEntry {
    const supersededOperationId = sessionSyncOperationIdSchema.parse(
      input.supersededOperationId,
    );
    const operationId = sessionSyncOperationIdSchema.parse(input.operationId);
    if (operationId === supersededOperationId) {
      throw new TypeError("Recovery replacement operation ID must be fresh.");
    }
    const expectedDigest = syncSha256DigestSchema.parse(
      input.expectedSupersededRequestDigest,
    );
    const requestDigest = digestSessionSyncJournalValue(input.request);
    const evidence = recoverySupersedeEvidenceSchema.parse(input.evidence);
    const now = safeIntegerSchema.parse(input.now);
    if (
      evidence.recoveryIntentDigest !== requestDigest
      || evidence.observedAt > now
      || now - evidence.observedAt > 60_000
    ) {
      throw new TypeError(
        "Recovery supersession requires a fresh verified server observation bound to the exact intent.",
      );
    }
    return this.#database.transaction(() => {
      const current = this.get(supersededOperationId);
      if (current === null) {
        throw new SessionSyncOperationJournalError(
          "not_found",
          "Superseded session sync operation is missing.",
        );
      }
      const replacement = this.get(operationId);
      if (current.state === "terminal") {
        if (
          replacement?.kind !== "recover_vault"
          || canonicalSessionSyncJson(current.outcome) !== canonicalSessionSyncJson({
            kind: "superseded_for_recovery",
            replacementOperationId: operationId,
            ...evidence,
          })
        ) {
          throw new SessionSyncOperationJournalError(
            "conflict",
            "Recovery supersession conflicts with its terminal fence.",
          );
        }
        return replacement;
      }
      if (
        current.scope.kind !== "global"
        || current.state !== "ambiguous"
        || current.requestDigest !== expectedDigest
      ) {
        throw new SessionSyncOperationJournalError(
          "conflict",
          "Only the exact stopped ambiguous global operation can be superseded for recovery.",
        );
      }
      this.settle({
        operationId: supersededOperationId,
        outcome: {
          kind: "superseded_for_recovery",
          replacementOperationId: operationId,
          ...evidence,
        },
        now,
      });
      return this.prepare({
        operationId,
        kind: "recover_vault",
        request: input.request,
        requestDigest,
        ...(input.keychainReferences === undefined
          ? {}
          : { keychainReferences: input.keychainReferences }),
        now,
      });
    })();
  }

  #advance(
    operationIdValue: string,
    allowed: readonly SessionSyncOperationJournalEntry["state"][],
    state: "dispatched" | "ambiguous",
    nowValue: number,
  ): SessionSyncOperationJournalEntry {
    const operationId = sessionSyncOperationIdSchema.parse(operationIdValue);
    const current = this.get(operationId);
    if (current === null) {
      throw new SessionSyncOperationJournalError(
        "not_found",
        "Session sync operation is missing.",
      );
    }
    if (current.state === state) return current;
    if (!allowed.includes(current.state)) {
      throw new SessionSyncOperationJournalError(
        "conflict",
        "Session sync operation cannot make that transition.",
      );
    }
    const now = safeIntegerSchema.parse(nowValue);
    if (now < current.updatedAt) {
      throw new SessionSyncOperationJournalError(
        "conflict",
        "Session sync operation time cannot move backward.",
      );
    }
    this.#database.query(`
      UPDATE session_sync_operation_journal
      SET state = ?2, updated_at = ?3
      WHERE operation_id = ?1 AND state = ?4
    `).run(operationId, state, now, current.state);
    return this.get(operationId) as SessionSyncOperationJournalEntry;
  }

  #pruneTerminal(): void {
    this.#database.query(`
      DELETE FROM session_sync_operation_journal
      WHERE state = 'terminal' AND operation_id NOT IN (
        SELECT operation_id FROM session_sync_operation_journal
        WHERE state = 'terminal'
        ORDER BY terminal_at DESC, operation_id DESC
        LIMIT ${String(RETAINED_TERMINAL_ROWS)}
      )
    `).run();
  }
}
