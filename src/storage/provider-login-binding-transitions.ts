import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

import { z } from "zod";

import { providerAccountAuthoritySchema, type ProviderAccountAuthority } from "../domain/provider-accounts";
import { attemptIdSchema, profileIdSchema, type AttemptId, type ProfileId } from "../domain/values";
import { readMutationEffectEvidenceProvenance } from "./effect-evidence-provenance";
import { normalizeSchemaSql, schemaCohortObjects } from "./schema-cohort";

const invalid = (): never => { throw new Error("PROVIDER_LOGIN_BINDING_PROOF_INVALID"); };
const protect = <T>(read: () => T): T => { try { return read(); } catch { return invalid(); } };
const transaction = (database: Database): void => { if (!database.inTransaction) invalid(); };
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const positive = z.number().int().positive().safe();
const time = z.number().int().nonnegative().safe();
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const loginIdSchema = z.string().min(1).max(512).refine((value) => !/\p{Cc}/u.test(value));
const boundedText = (column: string, bytes: number): string =>
  `CASE WHEN length(CAST(${column} AS BLOB))<=${bytes} THEN ${column} ELSE NULL END`;
const causeSchema = z.enum(["cancellation_quarantined", "cancellation_reconciled_pending"]);
type Cause = z.infer<typeof causeSchema>;
const transitionSchema = z.object({
  login_attempt_id: attemptIdSchema,
  cancellation_attempt_id: attemptIdSchema,
  cancellation_key: z.string().uuid(),
  provider_account_id: profileIdSchema,
  profile_id: profileIdSchema,
  from_binding_generation: positive,
  to_binding_generation: positive,
  process_generation: positive,
  cause: causeSchema,
  recorded_at: time,
}).strict();
const columns = Object.keys(transitionSchema.shape).join(",");
const rowSchema = transitionSchema.extend({ transition_digest: digest, anchor_digest: digest }).strict();
const terminalResolutionSchema = z.object({
  resolution_kind: z.literal("provider_state_reconciled"),
  evidence_json: z.enum(['{"source":"account/read","signedIn":false}', '{"source":"account/read","signedIn":true}']),
  receipt_json: z.null(),
}).strict();
type Original = Readonly<{
  id: AttemptId; key: string; state: string; authority: ProviderAccountAuthority;
  evidenceDigest: string; loginId: string | null; result: unknown; resultJson: string | null;
  canonicalImport: boolean;
}>;

// Exact retained provider-account guards. Only the joined installer replaces
// them; the original same-binding conditions below remain byte-derived here.
export const PROVIDER_LOGIN_BINDING_PREDECESSOR_GUARDS = [
  {
    "name": "session_mutation_provider_successor_insert_guard",
    "table": "session_mutation_authority_rebinds",
    "sql": "CREATE TRIGGER IF NOT EXISTS session_mutation_provider_successor_insert_guard\nBEFORE INSERT ON session_mutation_authority_rebinds\nWHEN NEW.provider!='codex' OR NOT EXISTS(\n  WITH RECURSIVE origins(provider_account_id,binding_generation,generation) AS (\n    SELECT provider_account_id,binding_generation,process_generation\n    FROM mutation_provider_authorities\n    WHERE attempt_id=NEW.attempt_id AND profile_id=NEW.profile_id AND provider=NEW.provider\n    UNION\n    SELECT provider_account_id,binding_generation,process_generation\n    FROM account_scoped_provider_authorities\n    WHERE scope_kind='provider_login' AND scope_id=NEW.attempt_id\n      AND profile_id=NEW.profile_id AND provider=NEW.provider\n  ), chain(provider_account_id,binding_generation,generation) AS (\n    SELECT * FROM origins\n    UNION\n    SELECT chain.provider_account_id,chain.binding_generation,successor.to_generation\n    FROM session_mutation_authority_rebinds successor\n    JOIN chain ON successor.from_generation=chain.generation\n    WHERE successor.attempt_id=NEW.attempt_id AND successor.profile_id=NEW.profile_id\n      AND successor.provider=NEW.provider\n  )\n  SELECT 1 FROM chain\n  JOIN provider_accounts current ON current.id=chain.provider_account_id\n  WHERE chain.generation=NEW.from_generation\n    AND current.profile_id=NEW.profile_id AND current.provider=NEW.provider\n    AND current.binding_generation=chain.binding_generation\n    AND current.process_generation=NEW.from_generation AND current.readiness!='removed'\n)\nBEGIN SELECT RAISE(ABORT, 'session mutation provider successor authority mismatch'); END;"
  },
  {
    "name": "session_mutation_provider_successor_v39_insert_guard",
    "table": "session_mutation_authority_rebinds_v39",
    "sql": "CREATE TRIGGER IF NOT EXISTS session_mutation_provider_successor_v39_insert_guard\nBEFORE INSERT ON session_mutation_authority_rebinds_v39\nWHEN NOT EXISTS(\n  SELECT 1 FROM session_mutation_authority_rebinds_v39 existing\n  WHERE existing.attempt_id=NEW.attempt_id AND existing.profile_id=NEW.profile_id\n    AND existing.provider=NEW.provider AND existing.from_generation=NEW.from_generation\n    AND existing.to_generation=NEW.to_generation AND existing.recorded_at=NEW.recorded_at\n) AND (NEW.provider!='codex' OR NOT EXISTS(\n  WITH RECURSIVE origins(provider_account_id,binding_generation,generation) AS (\n    SELECT provider_account_id,binding_generation,process_generation\n    FROM mutation_provider_authorities\n    WHERE attempt_id=NEW.attempt_id AND profile_id=NEW.profile_id AND provider=NEW.provider\n    UNION\n    SELECT provider_account_id,binding_generation,process_generation\n    FROM account_scoped_provider_authorities\n    WHERE scope_kind='provider_login' AND scope_id=NEW.attempt_id\n      AND profile_id=NEW.profile_id AND provider=NEW.provider\n  ), chain(provider_account_id,binding_generation,generation) AS (\n    SELECT * FROM origins\n    UNION\n    SELECT chain.provider_account_id,chain.binding_generation,successor.to_generation\n    FROM session_mutation_authority_rebinds_v39 successor\n    JOIN chain ON successor.from_generation=chain.generation\n    WHERE successor.attempt_id=NEW.attempt_id AND successor.profile_id=NEW.profile_id\n      AND successor.provider=NEW.provider\n  )\n  SELECT 1 FROM chain\n  JOIN provider_accounts current ON current.id=chain.provider_account_id\n  WHERE chain.generation=NEW.from_generation\n    AND current.profile_id=NEW.profile_id AND current.provider=NEW.provider\n    AND current.binding_generation=chain.binding_generation\n    AND current.process_generation=NEW.from_generation AND current.readiness!='removed'\n))\nBEGIN SELECT RAISE(ABORT, 'session mutation provider successor authority mismatch'); END;"
  }
] as const;

function readOriginal(database: Database, id: AttemptId, kind: "account.login" | "account.login-cancel"): Original {
  const row = z.object({ id: attemptIdSchema, idempotency_key: z.string().uuid(),
    authority_id: profileIdSchema, authority_generation: positive, kind: z.literal(kind),
    state: z.enum(["applied", "effect_started", "ambiguous"]), request_digest: digest,
    result_json: z.string().max(4_096).nullable(),
  }).strict().parse(database.query(`SELECT ${boundedText("id", 80)} AS id,
    ${boundedText("idempotency_key", 36)} AS idempotency_key,${boundedText("authority_id", 80)} AS authority_id,
    authority_generation,${boundedText("kind", 80)} AS kind,${boundedText("state", 32)} AS state,
    ${boundedText("request_digest", 64)} AS request_digest,
    CASE WHEN result_json IS NULL OR length(CAST(result_json AS BLOB))<=4096 THEN result_json ELSE NULL END AS result_json
    FROM mutation_attempts WHERE id=?`).get(id));
  const selected = readMutationEffectEvidenceProvenance(database, id);
  if (selected.kind !== "parsed" || selected.evidence.kind !== kind) return invalid();
  const evidence = selected.evidence;
  if (kind === "account.login-cancel" && row.state === "applied") invalid();
  const request = evidence.kind === "account.login" ? { deviceCode: evidence.method === "device_code" }
    : { loginId: evidence.loginId };
  if (hash({ kind, authorityId: row.authority_id, authorityGeneration: row.authority_generation, request }) !== row.request_digest) invalid();
  const roles = database.query(`SELECT ${boundedText("role", 16)} AS role,
    ${boundedText("provider_account_id", 80)} AS provider_account_id,${boundedText("profile_id", 80)} AS profile_id,
    ${boundedText("provider", 16)} AS provider,binding_generation,process_generation,
    ${boundedText("provenance", 80)} AS provenance
    FROM mutation_provider_authorities WHERE attempt_id=? ORDER BY role LIMIT 3`).all(id)
    .map((raw) => z.object({ role: z.enum(["primary", "source"]), provider_account_id: profileIdSchema,
      profile_id: profileIdSchema, provider: z.literal("codex"), binding_generation: positive,
      process_generation: time, provenance: z.string().max(80) }).strict().parse(raw));
  const primary = roles.find((role) => role.role === "primary");
  if (primary === undefined || primary.profile_id !== row.authority_id
    || primary.process_generation !== row.authority_generation) return invalid();
  // Canonical predecessor adoption captured one Codex account tuple, not the
  // later retirement source/target pair. Only its selected historical format
  // and exact retained provenance admit that older representation.
  const historicalLogin = kind === "account.login" && selected.format !== "joined_v1"
    && roles.length === 1 && primary.provenance === "legacy_account_codex";
  const canonicalImport = selected.format === "canonical_sol43_v1" && roles.length === 1
    && primary.provenance === "legacy_account_codex" && primary.binding_generation === 1;
  if (kind === "account.login") {
    const source = roles.find((role) => role.role === "source");
    if (!historicalLogin && (primary.provenance !== "account_login_target"
      || roles.length !== 2 || source === undefined || source.provenance !== "account_login_source"
      || source.provider_account_id !== primary.provider_account_id || source.profile_id !== primary.profile_id
      || source.binding_generation + 1 !== primary.binding_generation
      || source.process_generation + 1 !== primary.process_generation)) invalid();
  } else if (!canonicalImport && (roles.length !== 1 || primary.provenance !== "account_login_cancel")) invalid();
  return { id: row.id, key: row.idempotency_key, state: row.state,
    authority: providerAccountAuthoritySchema.parse({ providerAccountId: primary.provider_account_id,
      profileId: primary.profile_id, provider: "codex", bindingGeneration: primary.binding_generation,
      processGeneration: primary.process_generation }), evidenceDigest: selected.digest,
    loginId: evidence.kind === "account.login-cancel" ? evidence.loginId : null,
    result: row.result_json === null ? null : JSON.parse(row.result_json) as unknown,
    resultJson: row.result_json, canonicalImport };
}

function proveProcess(database: Database, original: Original, target: number, kind: "login" | "cancel",
  start = original.authority.processGeneration): void {
  if (start < original.authority.processGeneration || target < start) invalid();
  const tables = kind === "login"
    ? ["session_mutation_authority_rebinds", "session_mutation_authority_rebinds_v39"] as const
    : ["account_mutation_authority_rebinds"] as const;
  for (const table of tables) {
    let generation = start;
    while (generation < target) {
      const rows = database.query(`SELECT from_generation,to_generation FROM ${table}
        WHERE attempt_id=? AND profile_id=? AND from_generation>=? AND to_generation<=?
          AND ${kind === "login" ? "provider='codex'" : "kind='account.login-cancel' AND evidence_digest=?"}
        ORDER BY from_generation LIMIT 100`).all(original.id, original.authority.profileId, generation, target,
          ...(kind === "login" ? [] : [original.evidenceDigest]));
      if (rows.length === 0) invalid();
      for (const raw of rows) {
        const row = z.object({ from_generation: positive, to_generation: positive }).strict().parse(raw);
        if (row.from_generation !== generation || row.to_generation !== generation + 1) invalid();
        generation = row.to_generation;
      }
    }
  }
}

function resolution(database: Database, id: AttemptId): z.infer<typeof terminalResolutionSchema> | null {
  const row = database.query(`SELECT resolution_kind,
    CASE WHEN length(CAST(evidence_json AS BLOB))<=128 THEN evidence_json ELSE NULL END AS evidence_json,
    CASE WHEN receipt_json IS NULL THEN NULL ELSE 'not_null' END AS receipt_json
    FROM mutation_resolutions WHERE attempt_id=?`).get(id);
  return row === null ? null : terminalResolutionSchema.parse(row);
}

function proveCancellationProcess(database: Database, cancel: Original, generation: number,
  currentGeneration = generation): void {
  if (resolution(database, cancel.id) === null) { proveProcess(database, cancel, generation, "cancel"); return; }
  // Resolution freezes the cancellation's own chain. Later login-process
  // retirement does not fabricate successors for an already resolved effect.
  const last = database.query(`SELECT to_generation FROM account_mutation_authority_rebinds
    WHERE attempt_id=? ORDER BY from_generation DESC LIMIT 1`).get(cancel.id);
  const endpoint = last === null ? cancel.authority.processGeneration
    : z.object({ to_generation: positive }).strict().parse(last).to_generation;
  if (endpoint > currentGeneration) invalid();
  // A retained transition can precede resolution. Its earlier process lies
  // inside the cancellation chain, while later login-only steps lie beyond
  // that chain's frozen endpoint.
  proveProcess(database, cancel, Math.min(endpoint, generation), "cancel");
  proveProcess(database, cancel, endpoint, "cancel");
}

type Login = Readonly<{ original: Original; loginId: string; processGeneration: number;
  baselineGeneration: number; importedCancellation: Original | null; state: "active" | "settled" }>;

// Exact canonical v45 imported the already advanced pending-login scope. Its
// cancellation ledger, not either later login ledger, proves that historical
// prefix. Enumerate raw candidates before selected proof; missing or ambiguous
// history cannot silently become an import baseline. Pages bound allocation,
// while the transaction's initial count bounds traversal without a lifetime cap.
function historicalCancellation(database: Database, original: Original, loginId: string, baseline: number): Original {
  if (!original.canonicalImport || original.authority.bindingGeneration !== 1) return invalid();
  const predicate = "authority_id=? AND kind='account.login-cancel' AND state IN ('effect_started','ambiguous') AND authority_generation BETWEEN ? AND ?";
  const args = [original.authority.profileId, original.authority.processGeneration, baseline] as const;
  const count = z.object({ n: time }).strict().parse(database.query(
    `SELECT count(*) AS n FROM mutation_attempts WHERE ${predicate}`,
  ).get(...args)).n;
  let cursor = "";
  let seen = 0;
  let selected: Original | null = null;
  while (seen < count) {
    const rows = database.query(`SELECT ${boundedText("id", 80)} AS id FROM mutation_attempts
      WHERE ${predicate} AND id>? ORDER BY id LIMIT 100`).all(...args, cursor);
    if (rows.length === 0 || seen + rows.length > count) invalid();
    for (const raw of rows) {
      const id = z.object({ id: attemptIdSchema }).strict().parse(raw).id;
      if (id <= cursor) invalid();
      const candidate = readOriginal(database, id, "account.login-cancel");
      if (candidate.loginId === loginId && candidate.authority.bindingGeneration === 1) {
        if (!candidate.canonicalImport || selected !== null
          || candidate.authority.providerAccountId !== original.authority.providerAccountId
          || candidate.authority.profileId !== original.authority.profileId) invalid();
        proveProcess(database, candidate, baseline, "cancel");
        selected = candidate;
      }
      cursor = id;
      seen += 1;
    }
  }
  return selected ?? invalid();
}

function proveLoginProcess(database: Database, login: Login, target: number): void {
  proveProcess(database, login.original, target, "login", login.baselineGeneration);
}

function readLogin(database: Database, id: AttemptId): Login {
  const original = readOriginal(database, id, "account.login");
  const pending = z.object({ profile_id: profileIdSchema, process_generation: positive, login_id: loginIdSchema,
    state: z.enum(["active", "settled"]), provider_account_id: profileIdSchema,
    binding_generation: positive, origin_generation: positive,
    provenance: z.enum(["provider_login", "legacy_codex_compatibility"]),
  }).strict().parse(database.query(`SELECT ${boundedText("a.profile_id", 80)} AS profile_id,a.process_generation,
    ${boundedText("a.login_id", 2_048)} AS login_id,${boundedText("a.state", 16)} AS state,
    ${boundedText("c.provider_account_id", 80)} AS provider_account_id,
    c.binding_generation,c.process_generation AS origin_generation,${boundedText("c.provenance", 80)} AS provenance
    FROM provider_login_authorities a
    LEFT JOIN account_scoped_provider_authorities c ON c.scope_kind='provider_login' AND c.scope_id=a.attempt_id
      AND c.profile_id=a.profile_id AND c.provider='codex' WHERE a.attempt_id=?`).get(id));
  const receipt = z.object({ status: z.literal("pending"), loginId: loginIdSchema }).strict().parse(original.result);
  if (original.state !== "applied" || pending.profile_id !== original.authority.profileId
    || pending.provider_account_id !== original.authority.providerAccountId
    || pending.binding_generation !== original.authority.bindingGeneration
    || pending.origin_generation < original.authority.processGeneration
    || pending.origin_generation > pending.process_generation || pending.login_id !== receipt.loginId) invalid();
  if (pending.provenance !== (original.canonicalImport ? "legacy_codex_compatibility" : "provider_login")) invalid();
  if (original.canonicalImport && original.resultJson !== JSON.stringify(receipt)) invalid();
  const importedCancellation = original.canonicalImport && pending.origin_generation > original.authority.processGeneration
    ? historicalCancellation(database, original, pending.login_id, pending.origin_generation) : null;
  const baselineGeneration = importedCancellation === null ? original.authority.processGeneration : pending.origin_generation;
  proveProcess(database, original, pending.process_generation, "login", baselineGeneration);
  return { original, loginId: pending.login_id, processGeneration: pending.process_generation,
    baselineGeneration, importedCancellation, state: pending.state };
}

function proveCancellation(database: Database, login: Login, id: AttemptId, binding: number, generation: number): Original {
  const cancel = readOriginal(database, id, "account.login-cancel");
  if (cancel.authority.profileId !== login.original.authority.profileId
    || cancel.authority.providerAccountId !== login.original.authority.providerAccountId
    || cancel.authority.bindingGeneration !== binding || cancel.loginId !== login.loginId) invalid();
  if (cancel.canonicalImport && login.original.canonicalImport && cancel.authority.processGeneration <= login.baselineGeneration) {
    const historical = login.importedCancellation
      ?? historicalCancellation(database, login.original, login.loginId, login.baselineGeneration);
    if (historical.id !== cancel.id) invalid();
  } else proveLoginProcess(database, login, cancel.authority.processGeneration);
  proveCancellationProcess(database, cancel, generation, login.processGeneration);
  return cancel;
}

function bindingChain(database: Database, login: Login, importedRecovery = false): { binding: number; pending: Original | null } {
  let binding = login.original.authority.bindingGeneration;
  let pending: Original | null = null;
  const count = z.object({ n: time }).strict().parse(database.query(
    "SELECT count(*) AS n FROM provider_login_binding_transitions WHERE login_attempt_id=?",
  ).get(login.original.id)).n;
  let seen = 0;
  let processGeneration = login.baselineGeneration;
  while (seen < count) {
    const rows = database.query(`SELECT ${columns.split(",").map((column) => `t.${column}`).join(",")},
      t.transition_digest,a.transition_digest AS anchor_digest FROM provider_login_binding_transitions t
      LEFT JOIN provider_login_binding_transition_anchors a ON a.login_attempt_id=t.login_attempt_id
        AND a.from_binding_generation=t.from_binding_generation
      WHERE t.login_attempt_id=? AND t.from_binding_generation>=? ORDER BY t.from_binding_generation LIMIT 100`)
      .all(login.original.id, binding);
    if (rows.length === 0 || seen + rows.length > count) invalid();
    for (const raw of rows) {
      const { transition_digest, anchor_digest, ...row } = rowSchema.parse(raw);
      if (hash(row) !== transition_digest || transition_digest !== anchor_digest
        || row.profile_id !== login.original.authority.profileId
        || row.provider_account_id !== login.original.authority.providerAccountId
        || row.from_binding_generation !== binding || row.to_binding_generation !== binding + 1
        || row.process_generation < processGeneration || row.process_generation > login.processGeneration) invalid();
      proveLoginProcess(database, login, row.process_generation);
      if (row.cause === "cancellation_quarantined") {
        if (pending !== null) invalid();
        pending = proveCancellation(database, login, row.cancellation_attempt_id, binding, row.process_generation);
      } else {
        if (seen === 0 && binding === 1 && login.original.canonicalImport) {
          pending = login.importedCancellation
            ?? historicalCancellation(database, login.original, login.loginId, login.baselineGeneration);
        }
        if (pending === null || pending.id !== row.cancellation_attempt_id
          || resolution(database, pending.id)?.evidence_json !== '{"source":"account/read","signedIn":false}') return invalid();
        proveCancellationProcess(database, pending, row.process_generation, login.processGeneration);
        pending = null;
      }
      const cancelKey = pending?.key ?? readOriginal(database, row.cancellation_attempt_id, "account.login-cancel").key;
      if (cancelKey !== row.cancellation_key) invalid();
      binding = row.to_binding_generation;
      processGeneration = row.process_generation;
      seen += 1;
    }
  }
  if (count === 0 && importedRecovery && login.original.canonicalImport) {
    pending = login.importedCancellation
      ?? historicalCancellation(database, login.original, login.loginId, login.baselineGeneration);
  }
  return { binding, pending };
}

export type ProviderLoginBindingAuthority = Readonly<{
  attemptId: AttemptId; idempotencyKey: string; profileId: ProfileId;
  processGeneration: number; loginId: string; authority: ProviderAccountAuthority;
  pendingCancellationId: AttemptId | null;
}>;
export const readProviderLoginBindingAuthority = (database: Database, profileId: ProfileId,
  processGeneration: number): ProviderLoginBindingAuthority | null => protect(() => {
  transaction(database);
  const rows = database.query(`SELECT ${boundedText("attempt_id", 80)} AS attempt_id
    FROM provider_login_authorities WHERE profile_id=? AND state='active' LIMIT 2`)
    .all(profileIdSchema.parse(profileId));
  if (rows.length === 0) return null;
  if (rows.length !== 1) return invalid();
  const login = readLogin(database, z.object({ attempt_id: attemptIdSchema }).strict().parse(rows[0]).attempt_id);
  if (login.processGeneration !== positive.parse(processGeneration)) invalid();
  const current = z.object({ binding_generation: positive, process_generation: positive,
    readiness: z.enum(["login_pending", "recovery_required"]), profile_state: z.enum(["login_pending", "recovery_required"]),
    profile_generation: positive, provider_email: z.null(), profile_email: z.null(),
  }).strict().parse(database.query(`SELECT a.binding_generation,a.process_generation,a.readiness,p.state AS profile_state,
    p.process_generation AS profile_generation,
    CASE WHEN a.provider_email IS NULL THEN NULL ELSE 'not_null' END AS provider_email,
    CASE WHEN p.provider_email IS NULL THEN NULL ELSE 'not_null' END AS profile_email
    FROM provider_accounts a JOIN profiles p ON p.id=a.profile_id
    WHERE a.id=? AND a.profile_id=? AND a.provider='codex'`).get(login.original.authority.providerAccountId, profileId));
  const chain = bindingChain(database, login, current.readiness === "recovery_required");
  if (chain.binding !== current.binding_generation || current.process_generation !== processGeneration
    || current.profile_generation !== processGeneration || current.profile_state !== current.readiness
    || current.readiness !== (chain.pending === null ? "login_pending" : "recovery_required")) invalid();
  if (chain.pending !== null) proveCancellationProcess(database, chain.pending, processGeneration);
  return { attemptId: login.original.id, idempotencyKey: login.original.key, profileId,
    processGeneration, loginId: login.loginId,
    authority: { ...login.original.authority, bindingGeneration: chain.binding, processGeneration },
    pendingCancellationId: chain.pending?.id ?? null };
});

export const assertProviderLoginCancellationBinding = (database: Database, profileId: ProfileId,
  processGeneration: number, cancellationAttemptId: AttemptId): void => protect(() => {
  transaction(database);
  const proof = readProviderLoginBindingAuthority(database, profileId, processGeneration);
  if (proof === null) return invalid();
  const login = readLogin(database, proof.attemptId);
  const cancel = readOriginal(database, attemptIdSchema.parse(cancellationAttemptId), "account.login-cancel");
  proveCancellation(database, login, cancel.id, cancel.authority.bindingGeneration, processGeneration);
  if (proof.pendingCancellationId === null) {
    if (proof.authority.bindingGeneration !== cancel.authority.bindingGeneration) invalid();
  } else if (proof.pendingCancellationId !== cancel.id
    || (proof.authority.bindingGeneration !== cancel.authority.bindingGeneration + 1
      && !(login.original.canonicalImport && cancel.canonicalImport
        && proof.authority.bindingGeneration === 1 && cancel.authority.bindingGeneration === 1))) invalid();
});

export const prepareProviderLoginBindingTransition = (database: Database, input: {
  profileId: ProfileId; cancellationAttemptId: AttemptId; cause: Cause; recordedAt: number;
}): void => protect(() => {
  transaction(database);
  const profile = z.object({ process_generation: positive }).strict().parse(database.query(
    "SELECT process_generation FROM profiles WHERE id=?",
  ).get(input.profileId));
  const proof = readProviderLoginBindingAuthority(database, input.profileId, profile.process_generation);
  if (proof === null) return invalid();
  const login = readLogin(database, proof.attemptId);
  const cause = causeSchema.parse(input.cause);
  const cancel = cause === "cancellation_quarantined"
    ? proveCancellation(database, login, input.cancellationAttemptId, proof.authority.bindingGeneration, proof.processGeneration)
    : readOriginal(database, attemptIdSchema.parse(input.cancellationAttemptId), "account.login-cancel");
  if (cause === "cancellation_quarantined") {
    if (proof.pendingCancellationId !== null || resolution(database, cancel.id) !== null) invalid();
    const pending = database.query(`SELECT id FROM mutation_attempts m WHERE authority_id=?
      AND kind IN ('account.login','account.logout','account.login-cancel') AND state IN ('prepared','effect_started','ambiguous')
      AND NOT EXISTS(SELECT 1 FROM mutation_resolutions r WHERE r.attempt_id=m.id) LIMIT 2`).all(input.profileId);
    if (pending.length !== 1 || z.object({ id: attemptIdSchema }).strict().parse(pending[0]).id !== cancel.id) invalid();
  } else if (proof.pendingCancellationId !== cancel.id
    || resolution(database, cancel.id)?.evidence_json !== '{"source":"account/read","signedIn":false}') invalid();
  const row = transitionSchema.parse({ login_attempt_id: proof.attemptId, cancellation_attempt_id: cancel.id,
    cancellation_key: cancel.key, provider_account_id: proof.authority.providerAccountId, profile_id: proof.profileId,
    from_binding_generation: proof.authority.bindingGeneration, to_binding_generation: proof.authority.bindingGeneration + 1,
    process_generation: proof.processGeneration, cause, recorded_at: input.recordedAt });
  database.query(`INSERT INTO provider_login_binding_transitions(${columns},transition_digest)
    VALUES (${Array.from({ length: 11 }, () => "?").join(",")})`).run(...Object.values(row), hash(row));
});

const oldState = "CASE t.cause WHEN 'cancellation_quarantined' THEN 'login_pending' ELSE 'recovery_required' END";
const newState = "CASE t.cause WHEN 'cancellation_quarantined' THEN 'recovery_required' ELSE 'login_pending' END";
const pendingIntent = `SELECT t.* FROM provider_login_binding_transitions t
  LEFT JOIN provider_login_binding_transition_anchors a ON a.login_attempt_id=t.login_attempt_id
    AND a.from_binding_generation=t.from_binding_generation WHERE a.login_attempt_id IS NULL`;
// `login` is the retained provider_login_authorities row in each caller.
// SQL proves exact immutable correspondence; TS additionally recomputes the
// chosen codec, cryptographic preimages and both independent process chains.
const originalLoginSql = `SELECT 1 FROM mutation_attempts lm
  JOIN mutation_effect_evidence le ON le.attempt_id=lm.id
  JOIN mutation_effect_evidence_provenance lp ON lp.attempt_id=le.attempt_id
  JOIN mutation_effect_evidence_provenance_anchors la
    ON la.attempt_id=lp.attempt_id AND la.provenance_digest=lp.provenance_digest
  JOIN mutation_provider_authorities primary_origin ON primary_origin.attempt_id=lm.id AND primary_origin.role='primary'
  JOIN account_scoped_provider_authorities scoped ON scoped.scope_kind='provider_login' AND scoped.scope_id=lm.id
  WHERE lm.id=login.attempt_id AND lm.kind='account.login' AND lm.state='applied'
    AND lm.authority_id=login.profile_id AND le.kind=lm.kind
    AND lp.opaque_reason IS NULL AND lp.projection_json IS NOT NULL
    AND CAST(lp.projection_json AS BLOB)=CAST(le.evidence_json AS BLOB)
    AND lp.parent_kind=lm.kind AND lp.parent_authority_id=lm.authority_id
    AND lp.parent_authority_generation_decimal=CAST(lm.authority_generation AS TEXT)
    AND lp.evidence_kind=le.kind AND lp.stored_digest=le.evidence_digest AND lp.raw_sha256=le.evidence_digest
    AND lp.raw_byte_length=length(CAST(le.evidence_json AS BLOB))
    AND lp.recorded_at_decimal=CAST(le.recorded_at AS TEXT)
    AND length(CAST(lm.result_json AS BLOB))<=4096
    AND CAST(lm.result_json AS BLOB)=CAST(json_object('status','pending','loginId',login.login_id) AS BLOB)
    AND primary_origin.profile_id=lm.authority_id AND primary_origin.provider='codex'
    AND primary_origin.process_generation=lm.authority_generation
    AND scoped.provider_account_id=primary_origin.provider_account_id AND scoped.profile_id=lm.authority_id
    AND scoped.provider='codex'
    AND scoped.provenance=CASE WHEN lp.format='canonical_sol43_v1'
      AND primary_origin.provenance='legacy_account_codex' AND primary_origin.binding_generation=1
      THEN 'legacy_codex_compatibility' ELSE 'provider_login' END
    AND scoped.binding_generation=primary_origin.binding_generation
    AND scoped.process_generation>=primary_origin.process_generation
    AND scoped.process_generation<=login.process_generation
    AND ((primary_origin.provenance='account_login_target'
      AND (SELECT count(*) FROM mutation_provider_authorities a WHERE a.attempt_id=lm.id)=2
      AND EXISTS(SELECT 1 FROM mutation_provider_authorities source WHERE source.attempt_id=lm.id
        AND source.role='source' AND source.provenance='account_login_source' AND source.provider='codex'
        AND source.provider_account_id=primary_origin.provider_account_id AND source.profile_id=lm.authority_id
        AND source.binding_generation+1=primary_origin.binding_generation
        AND source.process_generation+1=primary_origin.process_generation))
      OR (lp.format!='joined_v1' AND primary_origin.provenance='legacy_account_codex'
        AND (SELECT count(*) FROM mutation_provider_authorities a WHERE a.attempt_id=lm.id)=1))`;
// Only an exactly selected Sol43/v45 import can begin after historical
// quarantine without a joined quarantine edge. The scoped tuple is the import
// baseline, not a rewritten original effect or a synthetic process successor.
// The surrounding intent guard proves both selected payloads/anchors and the
// actual old account state; this clause pins the unique historical cancellation
// and its independent contiguous prefix to that immutable baseline.
const historicalImportSql = `SELECT 1 FROM account_scoped_provider_authorities scoped
  JOIN mutation_provider_authorities origin ON origin.attempt_id=scoped.scope_id AND origin.role='primary'
  JOIN mutation_effect_evidence_provenance lp ON lp.attempt_id=origin.attempt_id
  WHERE scoped.scope_kind='provider_login' AND scoped.scope_id=login.attempt_id
    AND scoped.provenance='legacy_codex_compatibility' AND scoped.provider='codex' AND scoped.binding_generation=1
    AND scoped.provider_account_id=NEW.provider_account_id AND scoped.profile_id=NEW.profile_id
    AND origin.provenance='legacy_account_codex' AND origin.binding_generation=1
    AND origin.provider='codex' AND origin.provider_account_id=scoped.provider_account_id
    AND origin.profile_id=scoped.profile_id AND lp.format='canonical_sol43_v1'
    AND proof.format='canonical_sol43_v1' AND authority.provenance='legacy_account_codex'
    AND authority.binding_generation=1
    AND cancel.authority_generation BETWEEN origin.process_generation AND scoped.process_generation
    AND scoped.process_generation<=NEW.process_generation
    AND (SELECT count(*) FROM mutation_provider_authorities a WHERE a.attempt_id=cancel.id)=1
    AND EXISTS(WITH RECURSIVE chain(generation) AS (
      SELECT cancel.authority_generation UNION
      SELECT r.to_generation FROM account_mutation_authority_rebinds r
      JOIN chain ON r.from_generation=chain.generation
      WHERE r.attempt_id=cancel.id AND r.profile_id=scoped.profile_id AND r.kind='account.login-cancel'
        AND r.evidence_digest=effect.evidence_digest AND r.to_generation=r.from_generation+1
        AND r.to_generation<=scoped.process_generation
    ) SELECT 1 FROM chain WHERE generation=scoped.process_generation)
    AND (SELECT count(*) FROM mutation_attempts candidate
      LEFT JOIN mutation_provider_authorities cp ON cp.attempt_id=candidate.id AND cp.role='primary'
      LEFT JOIN mutation_effect_evidence ce ON ce.attempt_id=candidate.id
      LEFT JOIN mutation_effect_evidence_provenance candidate_proof ON candidate_proof.attempt_id=candidate.id
      LEFT JOIN mutation_effect_evidence_provenance_anchors candidate_anchor ON candidate_anchor.attempt_id=candidate.id
        AND candidate_anchor.provenance_digest=candidate_proof.provenance_digest
      WHERE candidate.authority_id=scoped.profile_id AND candidate.kind='account.login-cancel'
        AND candidate.state IN ('effect_started','ambiguous')
        AND candidate.authority_generation BETWEEN origin.process_generation AND scoped.process_generation
        AND CASE WHEN candidate_anchor.attempt_id IS NOT NULL
          AND candidate_proof.opaque_reason IS NULL AND candidate_proof.projection_json IS NOT NULL
          AND CAST(candidate_proof.projection_json AS BLOB)=CAST(ce.evidence_json AS BLOB)
          AND candidate_proof.parent_kind=candidate.kind AND candidate_proof.parent_authority_id=candidate.authority_id
          AND candidate_proof.parent_authority_generation_decimal=CAST(candidate.authority_generation AS TEXT)
          AND candidate_proof.evidence_kind=ce.kind AND ce.kind='account.login-cancel'
          AND candidate_proof.stored_digest=ce.evidence_digest AND candidate_proof.raw_sha256=ce.evidence_digest
          AND candidate_proof.raw_byte_length=length(CAST(ce.evidence_json AS BLOB))
          AND candidate_proof.raw_byte_length BETWEEN 2 AND 262144
          AND candidate_proof.recorded_at_decimal=CAST(ce.recorded_at AS TEXT)
          AND cp.provider='codex' AND cp.profile_id=candidate.authority_id
          AND cp.provider_account_id=NEW.provider_account_id
          AND cp.process_generation=candidate.authority_generation
          AND cp.binding_generation BETWEEN 1 AND 9007199254740991
          AND (cp.provenance='account_login_cancel' OR (cp.provenance='legacy_account_codex'
            AND cp.binding_generation=1 AND candidate_proof.format='canonical_sol43_v1'))
          AND (SELECT count(*) FROM mutation_provider_authorities a WHERE a.attempt_id=candidate.id)=1
          AND CASE WHEN json_valid(candidate_proof.projection_json) THEN
            json_extract(candidate_proof.projection_json,'$.kind')='account.login-cancel'
            AND json_type(candidate_proof.projection_json,'$.loginId')='text' ELSE 0 END IS 1
          THEN cp.binding_generation=1 AND json_extract(candidate_proof.projection_json,'$.loginId')=login.login_id
          ELSE 1 END)=1`;
const schemaSql = `
CREATE TABLE provider_login_binding_transitions(
  login_attempt_id TEXT NOT NULL REFERENCES provider_login_authorities(attempt_id)
    CHECK(length(CAST(login_attempt_id AS BLOB))=40 AND substr(login_attempt_id,1,8)='attempt_'
      AND substr(login_attempt_id,9) NOT GLOB '*[^a-f0-9]*'),
  cancellation_attempt_id TEXT NOT NULL REFERENCES mutation_attempts(id)
    CHECK(length(CAST(cancellation_attempt_id AS BLOB))=40 AND substr(cancellation_attempt_id,1,8)='attempt_'
      AND substr(cancellation_attempt_id,9) NOT GLOB '*[^a-f0-9]*'),
  cancellation_key TEXT NOT NULL CHECK(length(cancellation_key)=36),
  provider_account_id TEXT NOT NULL REFERENCES provider_accounts(id)
    CHECK(length(CAST(provider_account_id AS BLOB))=37 AND substr(provider_account_id,1,5)='acct_'
      AND substr(provider_account_id,6) NOT GLOB '*[^a-f0-9]*'),
  profile_id TEXT NOT NULL REFERENCES profiles(id)
    CHECK(length(CAST(profile_id AS BLOB))=37 AND substr(profile_id,1,5)='acct_'
      AND substr(profile_id,6) NOT GLOB '*[^a-f0-9]*'),
  from_binding_generation INTEGER NOT NULL CHECK(from_binding_generation BETWEEN 1 AND 9007199254740990),
  to_binding_generation INTEGER NOT NULL CHECK(to_binding_generation=from_binding_generation+1),
  process_generation INTEGER NOT NULL CHECK(process_generation BETWEEN 1 AND 9007199254740991),
  cause TEXT NOT NULL CHECK(cause IN ('cancellation_quarantined','cancellation_reconciled_pending')),
  recorded_at INTEGER NOT NULL CHECK(recorded_at BETWEEN 0 AND 9007199254740991),
  transition_digest TEXT NOT NULL CHECK(length(transition_digest)=64 AND transition_digest NOT GLOB '*[^a-f0-9]*'),
  PRIMARY KEY(login_attempt_id,from_binding_generation),
  UNIQUE(login_attempt_id,from_binding_generation,transition_digest),
  UNIQUE(cancellation_attempt_id,cause),
  FOREIGN KEY(login_attempt_id,from_binding_generation,transition_digest)
    REFERENCES provider_login_binding_transition_anchors(login_attempt_id,from_binding_generation,transition_digest)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE provider_login_binding_transition_anchors(
  login_attempt_id TEXT NOT NULL,
  from_binding_generation INTEGER NOT NULL,
  transition_digest TEXT NOT NULL,
  PRIMARY KEY(login_attempt_id,from_binding_generation),
  UNIQUE(login_attempt_id,from_binding_generation,transition_digest),
  FOREIGN KEY(login_attempt_id,from_binding_generation,transition_digest)
    REFERENCES provider_login_binding_transitions(login_attempt_id,from_binding_generation,transition_digest)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE INDEX provider_login_binding_transitions_profile ON provider_login_binding_transitions(profile_id,from_binding_generation);
CREATE TRIGGER provider_login_binding_transitions_no_update BEFORE UPDATE ON provider_login_binding_transitions
BEGIN SELECT RAISE(ABORT,'PROVIDER_LOGIN_BINDING_PROOF_INVALID'); END;
CREATE TRIGGER provider_login_binding_transitions_no_delete BEFORE DELETE ON provider_login_binding_transitions
BEGIN SELECT RAISE(ABORT,'PROVIDER_LOGIN_BINDING_PROOF_INVALID'); END;
CREATE TRIGGER provider_login_binding_transition_anchors_no_update BEFORE UPDATE ON provider_login_binding_transition_anchors
BEGIN SELECT RAISE(ABORT,'PROVIDER_LOGIN_BINDING_PROOF_INVALID'); END;
CREATE TRIGGER provider_login_binding_transition_anchors_no_delete BEFORE DELETE ON provider_login_binding_transition_anchors
BEGIN SELECT RAISE(ABORT,'PROVIDER_LOGIN_BINDING_PROOF_INVALID'); END;
CREATE TRIGGER provider_login_binding_transition_intent_guard BEFORE INSERT ON provider_login_binding_transitions
WHEN NOT EXISTS(
  SELECT 1 FROM provider_accounts account JOIN profiles profile ON profile.id=account.profile_id
  JOIN provider_login_authorities login ON login.attempt_id=NEW.login_attempt_id AND login.profile_id=profile.id
  JOIN mutation_attempts cancel ON cancel.id=NEW.cancellation_attempt_id AND cancel.authority_id=profile.id
  JOIN mutation_provider_authorities authority ON authority.attempt_id=cancel.id AND authority.role='primary'
  JOIN mutation_effect_evidence effect ON effect.attempt_id=cancel.id AND effect.kind='account.login-cancel'
  JOIN mutation_effect_evidence_provenance proof ON proof.attempt_id=effect.attempt_id
  JOIN mutation_effect_evidence_provenance_anchors anchor
    ON anchor.attempt_id=proof.attempt_id AND anchor.provenance_digest=proof.provenance_digest
  WHERE account.id=NEW.provider_account_id AND account.profile_id=NEW.profile_id AND account.provider='codex'
    AND account.binding_generation=NEW.from_binding_generation AND account.process_generation=NEW.process_generation
    AND profile.process_generation=NEW.process_generation AND account.provider_email IS NULL AND profile.provider_email IS NULL
    AND account.readiness=CASE NEW.cause WHEN 'cancellation_quarantined' THEN 'login_pending' ELSE 'recovery_required' END
    AND profile.state=account.readiness AND login.state='active' AND login.process_generation=NEW.process_generation
    AND EXISTS(${originalLoginSql})
    AND cancel.kind='account.login-cancel' AND cancel.state IN ('effect_started','ambiguous')
    AND cancel.idempotency_key=NEW.cancellation_key AND authority.provider='codex'
    AND authority.provider_account_id=NEW.provider_account_id AND authority.profile_id=NEW.profile_id
    AND authority.process_generation=cancel.authority_generation
    AND (authority.provenance='account_login_cancel' OR EXISTS(${historicalImportSql}))
    AND proof.opaque_reason IS NULL AND proof.projection_json IS NOT NULL
    AND CAST(proof.projection_json AS BLOB)=CAST(effect.evidence_json AS BLOB)
    AND proof.parent_kind=cancel.kind AND proof.parent_authority_id=cancel.authority_id
    AND proof.parent_authority_generation_decimal=CAST(cancel.authority_generation AS TEXT)
    AND proof.evidence_kind=effect.kind AND proof.stored_digest=effect.evidence_digest
    AND proof.raw_sha256=effect.evidence_digest AND proof.raw_byte_length=length(CAST(effect.evidence_json AS BLOB))
    AND proof.recorded_at_decimal=CAST(effect.recorded_at AS TEXT)
    AND json_extract(proof.projection_json,'$.loginId')=login.login_id
    AND (
      (NEW.cause='cancellation_quarantined' AND authority.binding_generation=NEW.from_binding_generation
        AND NOT EXISTS(SELECT 1 FROM mutation_resolutions r WHERE r.attempt_id=cancel.id)
        AND (SELECT count(*) FROM mutation_attempts m WHERE m.authority_id=profile.id
          AND m.kind IN ('account.login','account.logout','account.login-cancel')
          AND m.state IN ('prepared','effect_started','ambiguous')
          AND NOT EXISTS(SELECT 1 FROM mutation_resolutions r WHERE r.attempt_id=m.id))=1)
      OR (NEW.cause='cancellation_reconciled_pending' AND EXISTS(
        SELECT 1 FROM mutation_resolutions r WHERE r.attempt_id=cancel.id
          AND r.resolution_kind='provider_state_reconciled' AND r.receipt_json IS NULL
          AND CAST(r.evidence_json AS BLOB)=CAST('{"source":"account/read","signedIn":false}' AS BLOB)
      ) AND ((NEW.from_binding_generation=1 AND EXISTS(${historicalImportSql})) OR EXISTS(
        SELECT 1 FROM provider_login_binding_transitions prior
        JOIN provider_login_binding_transition_anchors prior_anchor ON prior_anchor.login_attempt_id=prior.login_attempt_id
          AND prior_anchor.from_binding_generation=prior.from_binding_generation AND prior_anchor.transition_digest=prior.transition_digest
        JOIN mutation_resolutions r ON r.attempt_id=cancel.id
        WHERE prior.login_attempt_id=NEW.login_attempt_id AND prior.cancellation_attempt_id=cancel.id
          AND prior.cancellation_key=NEW.cancellation_key AND prior.cause='cancellation_quarantined'
          AND prior.provider_account_id=NEW.provider_account_id AND prior.profile_id=NEW.profile_id
          AND prior.from_binding_generation=authority.binding_generation AND prior.to_binding_generation=NEW.from_binding_generation
          AND r.resolution_kind='provider_state_reconciled' AND r.receipt_json IS NULL
          AND CAST(r.evidence_json AS BLOB)=CAST('{"source":"account/read","signedIn":false}' AS BLOB)
      )))
    )
)
BEGIN SELECT RAISE(ABORT,'PROVIDER_LOGIN_BINDING_PROOF_INVALID'); END;
CREATE TRIGGER provider_login_binding_profile_update_guard BEFORE UPDATE ON profiles
WHEN EXISTS(SELECT 1 FROM (${pendingIntent}) t WHERE t.profile_id=OLD.id AND NOT (
  NEW.id=OLD.id AND OLD.process_generation=t.process_generation AND NEW.process_generation=t.process_generation
  AND OLD.state=(${oldState}) AND NEW.state=(${newState}) AND OLD.provider_email IS NULL AND NEW.provider_email IS NULL
)) BEGIN SELECT RAISE(ABORT,'PROVIDER_LOGIN_BINDING_PROOF_INVALID'); END;
CREATE TRIGGER provider_login_binding_account_update_guard BEFORE UPDATE ON provider_accounts
WHEN EXISTS(SELECT 1 FROM (${pendingIntent}) t WHERE t.provider_account_id=OLD.id AND NOT (
  NEW.id=OLD.id AND OLD.profile_id=t.profile_id AND NEW.profile_id=t.profile_id
  AND OLD.provider='codex' AND NEW.provider='codex'
  AND OLD.process_generation=t.process_generation AND NEW.process_generation=t.process_generation
  AND OLD.binding_generation=t.from_binding_generation AND NEW.binding_generation=t.to_binding_generation
  AND OLD.readiness=(${oldState}) AND NEW.readiness=(${newState})
  AND OLD.provider_email IS NULL AND NEW.provider_email IS NULL
  AND EXISTS(SELECT 1 FROM profiles p WHERE p.id=t.profile_id AND p.process_generation=t.process_generation
    AND p.state=(${newState}) AND p.provider_email IS NULL)
)) BEGIN SELECT RAISE(ABORT,'PROVIDER_LOGIN_BINDING_PROOF_INVALID'); END;
CREATE TRIGGER provider_login_binding_anchor_insert_guard BEFORE INSERT ON provider_login_binding_transition_anchors
WHEN NOT EXISTS(SELECT 1 FROM provider_login_binding_transitions t
  JOIN provider_accounts account ON account.id=t.provider_account_id JOIN profiles profile ON profile.id=t.profile_id
  WHERE t.login_attempt_id=NEW.login_attempt_id AND t.from_binding_generation=NEW.from_binding_generation
    AND t.transition_digest=NEW.transition_digest AND account.profile_id=t.profile_id AND account.provider='codex'
    AND account.binding_generation=t.to_binding_generation AND account.process_generation=t.process_generation
    AND profile.process_generation=t.process_generation AND account.readiness=(${newState}) AND profile.state=account.readiness
    AND account.provider_email IS NULL AND profile.provider_email IS NULL)
BEGIN SELECT RAISE(ABORT,'PROVIDER_LOGIN_BINDING_PROOF_INVALID'); END;
CREATE TRIGGER provider_login_binding_account_update_anchor AFTER UPDATE ON provider_accounts
BEGIN INSERT INTO provider_login_binding_transition_anchors(login_attempt_id,from_binding_generation,transition_digest)
  SELECT t.login_attempt_id,t.from_binding_generation,t.transition_digest FROM (${pendingIntent}) t
  WHERE t.provider_account_id=NEW.id AND t.from_binding_generation=OLD.binding_generation
    AND t.to_binding_generation=NEW.binding_generation;
END;
`;

// SQL observes anchored correspondence; the source-selected TS reader above
// additionally proves SHA-256, complete closed shapes and both process ledgers.
const pendingSuccessor = `WITH RECURSIVE bindings(provider_account_id,generation) AS (
  SELECT origin.provider_account_id,origin.binding_generation FROM account_scoped_provider_authorities origin
  WHERE origin.scope_kind='provider_login' AND origin.scope_id=NEW.attempt_id
    AND origin.profile_id=NEW.profile_id AND origin.provider='codex'
  UNION
  SELECT t.provider_account_id,t.to_binding_generation FROM provider_login_binding_transitions t
  JOIN provider_login_binding_transition_anchors anchor ON anchor.login_attempt_id=t.login_attempt_id
    AND anchor.from_binding_generation=t.from_binding_generation AND anchor.transition_digest=t.transition_digest
  JOIN bindings ON bindings.generation=t.from_binding_generation AND bindings.provider_account_id=t.provider_account_id
  WHERE t.login_attempt_id=NEW.attempt_id AND t.profile_id=NEW.profile_id
), original(generation) AS (
  SELECT process_generation FROM account_scoped_provider_authorities
  WHERE scope_kind='provider_login' AND scope_id=NEW.attempt_id AND profile_id=NEW.profile_id AND provider='codex'
), old_chain(generation) AS (
  SELECT * FROM original UNION SELECT r.to_generation FROM session_mutation_authority_rebinds r
  JOIN old_chain c ON c.generation=r.from_generation WHERE r.attempt_id=NEW.attempt_id AND r.profile_id=NEW.profile_id AND r.provider='codex'
), current_chain(generation) AS (
  SELECT * FROM original UNION SELECT r.to_generation FROM session_mutation_authority_rebinds_v39 r
  JOIN current_chain c ON c.generation=r.from_generation WHERE r.attempt_id=NEW.attempt_id AND r.profile_id=NEW.profile_id AND r.provider='codex'
)
SELECT 1 FROM provider_login_authorities login
JOIN mutation_attempts m ON m.id=login.attempt_id
JOIN account_scoped_provider_authorities origin ON origin.scope_kind='provider_login' AND origin.scope_id=m.id
JOIN provider_accounts account ON account.id=origin.provider_account_id
JOIN profiles profile ON profile.id=login.profile_id
WHERE NEW.provider='codex' AND m.id=NEW.attempt_id AND m.kind='account.login' AND m.state='applied'
  AND EXISTS(${originalLoginSql})
  AND login.state='active' AND login.profile_id=NEW.profile_id AND login.process_generation=NEW.from_generation
  AND account.profile_id=NEW.profile_id AND account.provider='codex' AND origin.provider='codex'
  -- originalLoginSql proves this same scoped primary-key row's exact
  -- source-selected provenance, including the closed canonical import case.
  AND origin.profile_id=NEW.profile_id
  AND account.process_generation=NEW.from_generation AND profile.process_generation=NEW.from_generation
  AND account.readiness=profile.state AND account.readiness IN ('login_pending','recovery_required')
  AND account.provider_email IS NULL AND profile.provider_email IS NULL
  AND EXISTS(SELECT 1 FROM bindings WHERE provider_account_id=account.id AND generation=account.binding_generation)
  AND NEW.from_generation IN (SELECT generation FROM old_chain)
  AND NEW.from_generation IN (SELECT generation FROM current_chain)
  AND EXISTS(SELECT 1 FROM provider_login_binding_transitions t
    JOIN provider_login_binding_transition_anchors a ON a.login_attempt_id=t.login_attempt_id
      AND a.from_binding_generation=t.from_binding_generation AND a.transition_digest=t.transition_digest
    WHERE t.login_attempt_id=login.attempt_id AND t.to_binding_generation=account.binding_generation
      AND t.provider_account_id=account.id AND t.profile_id=profile.id
      AND account.readiness=CASE t.cause WHEN 'cancellation_quarantined' THEN 'recovery_required' ELSE 'login_pending' END)
`;
const replacementGuards = PROVIDER_LOGIN_BINDING_PREDECESSOR_GUARDS.map((guard) => {
  const when = guard.sql.indexOf("WHEN ");
  const body = guard.sql.indexOf("\nBEGIN ");
  return { ...guard, sql: guard.sql.slice(0, when) + `WHEN (${guard.sql.slice(when + 5, body)})
AND NOT EXISTS(${pendingSuccessor})` + guard.sql.slice(body) };
});
const definitions = [...schemaCohortObjects(schemaSql).map((value) => ({ ...value, table: value.tbl_name })), ...replacementGuards.map((guard) => ({
  type: "trigger" as const, name: guard.name, table: guard.table, sql: guard.sql,
}))];
const observed = (database: Database, name: string) => {
  const count = z.object({ n: time }).strict().parse(database.query(`SELECT count(*) AS n FROM (
    SELECT 1 FROM sqlite_master WHERE name=? COLLATE NOCASE
    UNION ALL SELECT 1 FROM sqlite_temp_master WHERE name=? COLLATE NOCASE)`).get(name, name)).n;
  if (count === 0) return [];
  if (count !== 1) return invalid();
  return [z.object({ type: z.string().max(16), name: z.literal(name), tbl_name: z.string().max(128),
    sql: z.string().max(131_072),
  }).strict().parse(database.query(`SELECT ${boundedText("type", 16)} AS type,${boundedText("name", 128)} AS name,
    ${boundedText("tbl_name", 128)} AS tbl_name,${boundedText("sql", 131_072)} AS sql
    FROM (SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name=? COLLATE NOCASE
      UNION ALL SELECT type,name,tbl_name,sql FROM sqlite_temp_master WHERE name=? COLLATE NOCASE) LIMIT 1`).get(name, name))];
};
function exact(database: Database, value: { name: string; table: string; sql: string; type?: string }): boolean {
  const rows = observed(database, value.name); const row = rows[0];
  return rows.length === 1 && row !== undefined && row.name === value.name && row.tbl_name === value.table
    && row.type === (value.type ?? "trigger") && normalizeSchemaSql(row.sql) === normalizeSchemaSql(value.sql);
}
export const assertProviderLoginBindingTransitionSchema = (database: Database): void => protect(() => {
  for (const value of definitions) if (!exact(database, value)) invalid();
  const count = z.object({ n: time }).strict().parse(database.query(
    `SELECT count(*) AS n FROM (
      SELECT name FROM sqlite_master WHERE name GLOB 'provider_login_binding_*' AND sql IS NOT NULL
      UNION ALL SELECT name FROM sqlite_temp_master WHERE name GLOB 'provider_login_binding_*' AND sql IS NOT NULL)`,
  ).get()).n;
  if (count !== definitions.length - replacementGuards.length) invalid();
});
export const applyProviderLoginBindingTransitions = (database: Database): void => protect(() => {
  transaction(database);
  if (definitions.every((value) => exact(database, value))) { assertProviderLoginBindingTransitionSchema(database); return; }
  if (database.query(`SELECT 1 FROM sqlite_master WHERE name GLOB 'provider_login_binding_*'
    UNION ALL SELECT 1 FROM sqlite_temp_master WHERE name GLOB 'provider_login_binding_*' LIMIT 1`).get() !== null
    || !PROVIDER_LOGIN_BINDING_PREDECESSOR_GUARDS.every((value) => exact(database, value))) invalid();
  database.exec(schemaSql);
  for (const guard of replacementGuards) { database.exec(`DROP TRIGGER ${guard.name}`); database.exec(guard.sql); }
  assertProviderLoginBindingTransitionSchema(database);
});
export const auditProviderLoginBindingTransitions = (database: Database): void => protect(() => {
  transaction(database); assertProviderLoginBindingTransitionSchema(database);
  const total = z.object({ n: time }).strict().parse(database.query(
    "SELECT count(DISTINCT login_attempt_id) AS n FROM provider_login_binding_transitions",
  ).get()).n;
  let after = ""; let seen = 0;
  while (seen < total) {
    const ids = database.query(`SELECT DISTINCT login_attempt_id FROM provider_login_binding_transitions
      WHERE login_attempt_id>? ORDER BY login_attempt_id LIMIT 100`).all(after);
    if (ids.length === 0 || seen + ids.length > total) invalid();
    for (const raw of ids) {
      const id = z.object({ login_attempt_id: attemptIdSchema }).strict().parse(raw).login_attempt_id;
      bindingChain(database, readLogin(database, id)); after = id; seen += 1;
    }
  }
  if (database.query(`SELECT 1 FROM provider_login_binding_transition_anchors a
    LEFT JOIN provider_login_binding_transitions t ON t.login_attempt_id=a.login_attempt_id
      AND t.from_binding_generation=a.from_binding_generation AND t.transition_digest=a.transition_digest
    WHERE t.login_attempt_id IS NULL LIMIT 1`).get() !== null) invalid();
});
