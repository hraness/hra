/**
 * Provider usage, read from the hosted projection.
 *
 * Every daemon uploads one encrypted usage projection per account per source
 * revision; the server keeps the winner per account, so an account seen from
 * two machines is one row here. The account's label, email and plan ride in a
 * separately encrypted metadata envelope bound to the same private-JSON
 * authority the daemon used (`hra-control-plane-private-json:v1`). Both are
 * decrypted with the account key and never leave this tab.
 */
import { useConvex, useQueries, useQuery } from "convex/react";
import { useEffect, useMemo, useState } from "react";

import { useCustody } from "../custody/custody-context";
import { createCancellation } from "../lib/cancellation";
import {
  accountUsageSummary,
  providerUsageRollup,
  type AccountUsageSummary,
  type ProviderUsageRollup,
  type UsageObservation,
} from "../model/usage-meter";
import {
  cloudLimits,
  decryptBytes,
  decryptUsageProjection,
  isFiniteTimestamp,
  isOpaqueIdentifier,
  isRecord,
  isSafeNonNegativeInteger,
  parseEncryptedEnvelope,
  parseUsageEncryptedEnvelope,
  snapshotForeignJson,
  type EncryptedEnvelope,
  type UsageProjection,
} from "../oompa/cloud";
import { useServerClock } from "./devices";
import { usageListAccounts, usageListSnapshots } from "./functions";

/** How many observations per account feed the rate and the breakdown chart. */
export const usageHistoryLimit = 24;

export type UsageAccountRow = Readonly<{
  encryptedMetadata: EncryptedEnvelope;
  publicId: string;
  updatedAt: number;
}>;

export type UsageAccountMetadata = Readonly<{
  email: string;
  label: string;
  plan: string | null;
}>;

export type UsageSnapshotRow = Readonly<{
  digest: string;
  envelope: EncryptedEnvelope;
  observedAt: number;
  sourceRevision: number;
}>;

export function parseUsageAccountRow(input: unknown): UsageAccountRow | null {
  const snapshot = snapshotForeignJson(input);
  if (!snapshot.ok) return null;
  const value = snapshot.value;
  if (
    !isRecord(value)
    || !isOpaqueIdentifier(value.publicId)
    || !isFiniteTimestamp(value.updatedAt)
  ) return null;
  const encryptedMetadata = parseEncryptedEnvelope(
    value.encryptedMetadata,
    cloudLimits.metadataCiphertextCharacters,
  );
  if (encryptedMetadata === null) return null;
  return { encryptedMetadata, publicId: value.publicId, updatedAt: value.updatedAt };
}

export function parseUsageAccountRows(input: unknown): readonly UsageAccountRow[] {
  const snapshot = snapshotForeignJson(input);
  if (!snapshot.ok || !Array.isArray(snapshot.value)) return [];
  return snapshot.value
    .map(parseUsageAccountRow)
    .filter((row): row is UsageAccountRow => row !== null);
}

export function parseUsageAccountMetadata(input: unknown): UsageAccountMetadata | null {
  const snapshot = snapshotForeignJson(input);
  if (!snapshot.ok || !isRecord(snapshot.value)) return null;
  const value = snapshot.value;
  if (
    typeof value.label !== "string" || value.label.length > 160
    || typeof value.email !== "string" || value.email.length > 320
    || (value.plan !== null && (typeof value.plan !== "string" || value.plan.length > 160))
  ) return null;
  return { email: value.email, label: value.label, plan: value.plan };
}

export function parseUsageSnapshotRow(input: unknown): UsageSnapshotRow | null {
  const snapshot = snapshotForeignJson(input);
  if (!snapshot.ok) return null;
  const value = snapshot.value;
  if (
    !isRecord(value)
    || typeof value.digest !== "string"
    || !isFiniteTimestamp(value.observedAt)
    || !isSafeNonNegativeInteger(value.sourceRevision)
  ) return null;
  const envelope = parseUsageEncryptedEnvelope(value.envelope);
  if (envelope === null) return null;
  return {
    digest: value.digest,
    envelope,
    observedAt: value.observedAt,
    sourceRevision: value.sourceRevision,
  };
}

export function parseUsageSnapshotRows(input: unknown): readonly UsageSnapshotRow[] {
  const snapshot = snapshotForeignJson(input);
  if (!snapshot.ok || !Array.isArray(snapshot.value)) return [];
  return snapshot.value
    .map(parseUsageSnapshotRow)
    .filter((row): row is UsageSnapshotRow => row !== null);
}

/** The daemon's private-JSON authority for an account's metadata envelope. */
export function usageAccountMetadataAad(input: Readonly<{
  accountPublicId: string;
  keyVersion: number;
  userPublicId: string;
}>): Uint8Array {
  return new TextEncoder().encode([
    "hra-control-plane-private-json:v1",
    "account_metadata",
    input.userPublicId,
    input.accountPublicId,
    String(input.keyVersion),
  ].join("\n"));
}

export type UsageAccountView = Readonly<{
  history: readonly UsageObservation[];
  metadata: UsageAccountMetadata | null;
  publicId: string;
  summary: AccountUsageSummary | null;
}>;

export type UsageOverview = Readonly<{
  accounts: readonly UsageAccountView[];
  /** Codex rollup; the only provider with a hosted usage projection today. */
  codex: ProviderUsageRollup;
  loading: boolean;
  now: number;
  /** False until hosted time is anchored; ages and resets are not comparable before. */
  ready: boolean;
}>;

type DecryptedAccount = Readonly<{
  history: readonly UsageObservation[];
  metadata: UsageAccountMetadata | null;
}>;

/**
 * Every usage account on the hosted account with its recent observations.
 *
 * Decryption happens in one effect keyed on the account key and the rows, so
 * a key that is dropped mid-decrypt cancels the work and wipes its copy. A
 * snapshot that fails to decrypt is skipped; an account whose metadata fails
 * is still shown by its public id.
 */
export function useUsageOverview(): UsageOverview {
  const custody = useCustody();
  const convex = useConvex();
  const serverClock = useServerClock();
  const unlocked = custody.state === "unlocked" ? custody : null;
  const key = unlocked?.key ?? null;
  const keyVersion = unlocked?.identity.keyVersion ?? null;
  const userPublicId = unlocked?.identity.userPublicId ?? null;
  const report = custody.reportAuthorityFailure;

  const accountsValue = useQuery(usageListAccounts, { limit: cloudLimits.pageSize });
  const accountRows = useMemo(
    () => (accountsValue === undefined ? [] : parseUsageAccountRows(accountsValue)),
    [accountsValue],
  );
  const snapshotQueries = useMemo(
    () => Object.fromEntries(accountRows.map((row) => [
      row.publicId,
      { args: { accountPublicId: row.publicId, limit: usageHistoryLimit }, query: usageListSnapshots },
    ])),
    [accountRows],
  );
  const snapshotValues = useQueries(snapshotQueries);
  const snapshotRows = useMemo(
    () => new Map(accountRows.map((row) => {
      const value: unknown = snapshotValues[row.publicId];
      return [row.publicId, value === undefined || value instanceof Error ? null : parseUsageSnapshotRows(value)];
    })),
    [accountRows, snapshotValues],
  );

  const [decrypted, setDecrypted] = useState<ReadonlyMap<string, DecryptedAccount>>(new Map());

  useEffect(() => {
    if (key === null || keyVersion === null || userPublicId === null) {
      setDecrypted(new Map());
      return;
    }
    const run = createCancellation();
    const keyBytes = new Uint8Array(key);
    void (async () => {
      const next = new Map<string, DecryptedAccount>();
      for (const row of accountRows) {
        if (!run.live()) return;
        let metadata: UsageAccountMetadata | null = null;
        if (row.encryptedMetadata.keyVersion === keyVersion) {
          try {
            const plaintext = await decryptBytes(row.encryptedMetadata, keyBytes, usageAccountMetadataAad({
              accountPublicId: row.publicId,
              keyVersion,
              userPublicId,
            }));
            metadata = parseUsageAccountMetadata(JSON.parse(new TextDecoder().decode(plaintext)));
          } catch (failure: unknown) {
            if (!run.live()) return;
            report(failure);
          }
        }
        const history: UsageObservation[] = [];
        for (const snapshot of snapshotRows.get(row.publicId) ?? []) {
          if (!run.live()) return;
          if (snapshot.envelope.keyVersion !== keyVersion) continue;
          try {
            const projection: UsageProjection = await decryptUsageProjection(snapshot.envelope, keyBytes, {
              entityPublicId: row.publicId,
              keyVersion,
              kind: "usage",
              userPublicId,
            });
            history.push({ observedAt: snapshot.observedAt, projection });
          } catch (failure: unknown) {
            if (!run.live()) return;
            report(failure);
          }
        }
        next.set(row.publicId, { history, metadata });
      }
      if (!run.live()) return;
      setDecrypted(next);
    })();
    return () => {
      run.cancel();
      keyBytes.fill(0);
    };
  }, [accountRows, convex, key, keyVersion, report, snapshotRows, userPublicId]);

  const accounts = useMemo<readonly UsageAccountView[]>(
    () => accountRows.map((row) => {
      const entry = decrypted.get(row.publicId);
      const history = entry?.history ?? [];
      return {
        history,
        metadata: entry?.metadata ?? null,
        publicId: row.publicId,
        summary: serverClock.ready ? accountUsageSummary(history, serverClock.now) : null,
      };
    }),
    [accountRows, decrypted, serverClock.now, serverClock.ready],
  );

  return {
    accounts,
    codex: useMemo(() => providerUsageRollup(accounts.map((account) => account.summary)), [accounts]),
    loading: accountsValue === undefined,
    now: serverClock.now,
    ready: serverClock.ready,
  };
}
