/**
 * The per-device settings projection.
 *
 * Each daemon publishes one encrypted `DeviceRegistryPayload` to
 * `devices:updateRegistry`; `devices:listRegistries` returns every row on the
 * account. The envelope is bound to `cloudPayloadAad` over
 * `{kind: "device_registry", userPublicId, entityPublicId: devicePublicId,
 * keyVersion}`, so the authority is rebuilt from the row and the reader's own
 * identity before a decrypt is attempted, exactly as `chunkAuthority` does for
 * session chunks.
 */
import { useQuery } from "convex/react";
import { useEffect, useMemo, useState } from "react";

import { useCustody } from "../custody/custody-context";
import {
  cloudLimits,
  cloudPayloadAad,
  decryptDeviceRegistry,
  decryptMemorySummary,
  decryptNotificationEmail,
  decryptNotificationHours,
  decryptProfileBinding,
  isFiniteTimestamp,
  isOpaqueIdentifier,
  isRecord,
  isSafePositiveInteger,
  parseEncryptedEnvelope,
  profileBindingRegistryDigest,
  snapshotForeignJson,
  type CloudPayloadAuthority,
  type DeviceRegistryPayload,
  type EncryptedEnvelope,
  type MemorySummaryPayload,
  type NotificationEmailPolicy,
  type NotificationHoursPolicy,
  type ProfileBindingPayload,
} from "../oompa/cloud";
import { createCancellation } from "../lib/cancellation";
import {
  sortMachines,
  toMachineView,
  type MachineDeviceState,
  type MachineView,
} from "../model/settings-view";
import { useDeviceRows, useServerClock } from "./devices";
import { listRegistries } from "./functions";

export type RegistryRow = Readonly<{
  devicePublicId: string;
  envelope: EncryptedEnvelope;
  keyVersion: number;
  /** Optional read-only memory/peer supervision, never part of registry v1. */
  memorySummaryEnvelope: EncryptedEnvelope | null;
  memorySummaryEnvelopeStatus: "absent" | "invalid" | "present";
  memorySummaryRevision: number | null;
  memorySummaryUpdatedAt: number | null;
  /** Optional companion projection so the broad registry stays v1-compatible. */
  notificationEmailEnvelope: EncryptedEnvelope | null;
  notificationEmailEnvelopeStatus: "absent" | "invalid" | "present";
  /** Optional and independently encrypted so old daemons remain readable. */
  notificationHoursEnvelope: EncryptedEnvelope | null;
  notificationHoursEnvelopeStatus: "absent" | "invalid" | "present";
  /** Server-visible freshness fence; never consent on its own. */
  notificationPolicyRevision: number | null;
  notificationPolicyRevisionStatus: "absent" | "invalid" | "present";
  /** Read-only exact default observation, never a selector or registry-v1 field. */
  profileBindingEnvelope: EncryptedEnvelope | null;
  profileBindingEnvelopeStatus: "absent" | "invalid" | "present";
  revision: number;
  updatedAt: number;
}>;

export function parseRegistryRow(input: unknown): RegistryRow | null {
  const snapshot = snapshotForeignJson(input);
  if (!snapshot.ok) return null;
  const value = snapshot.value;
  if (
    !isRecord(value)
    || !isOpaqueIdentifier(value.devicePublicId)
    || !isSafePositiveInteger(value.keyVersion)
    || !isSafePositiveInteger(value.revision)
    || !isFiniteTimestamp(value.updatedAt)
  ) return null;
  const envelope = parseEncryptedEnvelope(
    value.envelope,
    cloudLimits.registryCiphertextCharacters,
  );
  if (envelope === null || envelope.keyVersion !== value.keyVersion) return null;
  const hasMemorySummaryEnvelope = Object.hasOwn(value, "memorySummaryEnvelope");
  const hasMemorySummaryRevision = Object.hasOwn(value, "memorySummaryRevision");
  const hasMemorySummaryUpdatedAt = Object.hasOwn(value, "memorySummaryUpdatedAt");
  const memorySummaryEnvelope = !hasMemorySummaryEnvelope
    ? null
    : parseEncryptedEnvelope(
        value.memorySummaryEnvelope,
        cloudLimits.memorySummaryCiphertextCharacters,
      );
  const memorySummaryRevisionValid = hasMemorySummaryRevision
    && isSafePositiveInteger(value.memorySummaryRevision);
  const memorySummaryUpdatedAtValid = hasMemorySummaryUpdatedAt
    && isSafePositiveInteger(value.memorySummaryUpdatedAt);
  const memorySummaryMetadataValid = hasMemorySummaryRevision === hasMemorySummaryUpdatedAt
    && (!hasMemorySummaryRevision
      || (memorySummaryRevisionValid && memorySummaryUpdatedAtValid));
  const memorySummaryEnvelopeValid = hasMemorySummaryEnvelope
    && memorySummaryEnvelope !== null
    && memorySummaryEnvelope.keyVersion === value.keyVersion
    && memorySummaryRevisionValid
    && memorySummaryUpdatedAtValid;
  const notificationEmailEnvelope = value.notificationEmailEnvelope === undefined
    ? null
    : parseEncryptedEnvelope(
        value.notificationEmailEnvelope,
        cloudLimits.notificationEmailCiphertextCharacters,
      );
  const notificationEmailEnvelopeValid = notificationEmailEnvelope !== null
    && notificationEmailEnvelope.keyVersion === value.keyVersion;
  const notificationHoursEnvelope = value.notificationHoursEnvelope === undefined
    ? null
    : parseEncryptedEnvelope(value.notificationHoursEnvelope, cloudLimits.notificationHoursCiphertextCharacters);
  const notificationHoursEnvelopeValid = notificationHoursEnvelope !== null
    && notificationHoursEnvelope.keyVersion === value.keyVersion;
  const hasNotificationPolicyRevision = Object.hasOwn(value, "notificationPolicyRevision");
  const notificationPolicyRevisionValid = hasNotificationPolicyRevision
    && isSafePositiveInteger(value.notificationPolicyRevision);
  const hasProfileBindingEnvelope = Object.hasOwn(value, "profileBindingEnvelope");
  const profileBindingEnvelope = hasProfileBindingEnvelope
    ? parseEncryptedEnvelope(value.profileBindingEnvelope, cloudLimits.profileBindingCiphertextCharacters)
    : null;
  const profileBindingEnvelopeValid = profileBindingEnvelope !== null
    && profileBindingEnvelope.keyVersion === value.keyVersion;
  let memorySummaryEnvelopeStatus: RegistryRow["memorySummaryEnvelopeStatus"] = "absent";
  if (!memorySummaryMetadataValid || (hasMemorySummaryEnvelope && !memorySummaryEnvelopeValid)) {
    memorySummaryEnvelopeStatus = "invalid";
  } else if (hasMemorySummaryEnvelope) {
    memorySummaryEnvelopeStatus = "present";
  }
  return {
    devicePublicId: value.devicePublicId,
    envelope,
    keyVersion: value.keyVersion,
    memorySummaryEnvelope: memorySummaryEnvelopeValid ? memorySummaryEnvelope : null,
    memorySummaryEnvelopeStatus,
    memorySummaryRevision: memorySummaryMetadataValid && memorySummaryRevisionValid
      ? value.memorySummaryRevision as number
      : null,
    memorySummaryUpdatedAt: memorySummaryMetadataValid && memorySummaryUpdatedAtValid
      ? value.memorySummaryUpdatedAt as number
      : null,
    notificationEmailEnvelope: notificationEmailEnvelopeValid
      ? notificationEmailEnvelope
      : null,
    notificationEmailEnvelopeStatus: value.notificationEmailEnvelope === undefined
      ? "absent"
      : notificationEmailEnvelopeValid
      ? "present"
      : "invalid",
    notificationHoursEnvelope: notificationHoursEnvelopeValid ? notificationHoursEnvelope : null,
    notificationHoursEnvelopeStatus: value.notificationHoursEnvelope === undefined
      ? "absent"
      : notificationHoursEnvelopeValid
      ? "present"
      : "invalid",
    notificationPolicyRevision: notificationPolicyRevisionValid
      ? value.notificationPolicyRevision as number
      : null,
    notificationPolicyRevisionStatus: !hasNotificationPolicyRevision
      ? "absent"
      : notificationPolicyRevisionValid
      ? "present"
      : "invalid",
    profileBindingEnvelope: profileBindingEnvelopeValid ? profileBindingEnvelope : null,
    profileBindingEnvelopeStatus: !hasProfileBindingEnvelope
      ? "absent"
      : profileBindingEnvelopeValid ? "present" : "invalid",
    revision: value.revision,
    updatedAt: value.updatedAt,
  };
}

export function notificationHoursAuthority(input: Parameters<typeof registryAuthority>[0]): CloudPayloadAuthority {
  return { ...registryAuthority(input), kind: "notification_hours" };
}

export function notificationEmailAuthority(input: Parameters<typeof registryAuthority>[0]): CloudPayloadAuthority {
  return { ...registryAuthority(input), kind: "notification_email" };
}

export function memorySummaryAuthority(input: Parameters<typeof registryAuthority>[0]): CloudPayloadAuthority {
  return { ...registryAuthority(input), kind: "memory_summary" };
}

export function profileBindingAuthority(input: Parameters<typeof registryAuthority>[0]): CloudPayloadAuthority {
  return { ...registryAuthority(input), kind: "profile_binding" };
}

export function parseRegistryRows(value: unknown): readonly RegistryRow[] {
  const snapshot = snapshotForeignJson(value);
  if (!snapshot.ok || !Array.isArray(snapshot.value)) return [];
  return snapshot.value
    .map((entry) => parseRegistryRow(entry))
    .filter((entry): entry is RegistryRow => entry !== null);
}

export function registryAuthority(input: Readonly<{
  devicePublicId: string;
  keyVersion: number;
  userPublicId: string;
}>): CloudPayloadAuthority {
  return {
    entityPublicId: input.devicePublicId,
    keyVersion: input.keyVersion,
    kind: "device_registry",
    userPublicId: input.userPublicId,
  };
}

/** Proves the reconstruction is well formed before a decrypt is attempted. */
export function registryAad(input: Parameters<typeof registryAuthority>[0]): Uint8Array {
  return cloudPayloadAad(registryAuthority(input));
}

export function notificationHoursAad(input: Parameters<typeof registryAuthority>[0]): Uint8Array {
  return cloudPayloadAad(notificationHoursAuthority(input));
}

export function notificationEmailAad(input: Parameters<typeof registryAuthority>[0]): Uint8Array {
  return cloudPayloadAad(notificationEmailAuthority(input));
}

export function memorySummaryAad(input: Parameters<typeof registryAuthority>[0]): Uint8Array {
  return cloudPayloadAad(memorySummaryAuthority(input));
}

export function profileBindingAad(input: Parameters<typeof registryAuthority>[0]): Uint8Array {
  return cloudPayloadAad(profileBindingAuthority(input));
}

export type DeviceRegistries = Readonly<{
  error: string | null;
  loading: boolean;
  memorySummaryReady: boolean;
  machines: readonly MachineView[];
  /** Hosted-time projection from the same clock that gates memory summaries. */
  now: number;
}>;

export type RegistryProjection = Readonly<{
  attentionEmailEnabled: boolean | null;
  notificationHours: NotificationHoursPolicy | null;
  notificationHoursStatus: "available" | "unreadable" | "unsupported";
  notificationPolicyFreshness: "current" | "stale" | "unreadable" | "unsupported";
  notificationPolicyRevision: number | null;
  memorySummary: MemorySummaryPayload | null;
  memorySummaryStatus: "available" | "unreadable" | "unsupported";
  profileBinding: ProfileBindingPayload | null;
  profileBindingStatus: "available" | "unreadable" | "unsupported";
  registry: DeviceRegistryPayload;
}>;

/**
 * Treat the encrypted switch as displayable consent only when the separately
 * encrypted hours and the server-visible composite revision agree. The outer
 * number is a freshness fence, not authority, and no incomplete combination
 * can render an enabled state.
 */
export function notificationEmailProjection(input: Readonly<{
  notificationEmail: NotificationEmailPolicy | null;
  notificationEmailStatus: "available" | "unreadable" | "unsupported";
  notificationHours: NotificationHoursPolicy | null;
  notificationHoursStatus: RegistryProjection["notificationHoursStatus"];
  row: RegistryRow;
}>): Pick<
  RegistryProjection,
  "attentionEmailEnabled" | "notificationPolicyFreshness" | "notificationPolicyRevision"
> {
  const revision = input.row.notificationPolicyRevision;
  if (
    input.notificationEmailStatus === "unsupported"
    && input.row.notificationPolicyRevisionStatus === "absent"
  ) {
    return {
      attentionEmailEnabled: null,
      notificationPolicyFreshness: "unsupported",
      notificationPolicyRevision: null,
    };
  }
  if (
    input.row.notificationPolicyRevisionStatus === "invalid"
    || input.notificationEmailStatus === "unreadable"
    || input.notificationHoursStatus === "unreadable"
  ) {
    return {
      attentionEmailEnabled: null,
      notificationPolicyFreshness: "unreadable",
      notificationPolicyRevision: revision,
    };
  }
  if (
    input.row.notificationPolicyRevisionStatus !== "present"
    || input.notificationEmailStatus !== "available"
    || input.notificationHoursStatus !== "available"
    || input.notificationEmail === null
    || input.notificationHours === null
    || revision !== input.notificationEmail.revision
    || revision !== input.notificationHours.revision
  ) {
    return {
      attentionEmailEnabled: null,
      notificationPolicyFreshness: "stale",
      notificationPolicyRevision: revision,
    };
  }
  return {
    attentionEmailEnabled: input.notificationEmail.enabled,
    notificationPolicyFreshness: "current",
    notificationPolicyRevision: revision,
  };
}

/**
 * Exact registry/binding envelopes and the memory companion fences participate
 * in cache identity. Replacements are cache misses even at an unchanged broad
 * revision, so an old exact-profile label cannot survive a pending decrypt.
 */
export function registryProjectionCacheKey(row: RegistryRow): string {
  const envelopeIdentity = (envelope: EncryptedEnvelope | null) => envelope === null
    ? null
    : [envelope.algorithm, envelope.ciphertext, envelope.keyVersion, envelope.nonce];
  return JSON.stringify([
    row.devicePublicId,
    row.keyVersion,
    row.revision,
    envelopeIdentity(row.envelope),
    row.profileBindingEnvelopeStatus,
    envelopeIdentity(row.profileBindingEnvelope),
    row.memorySummaryEnvelopeStatus,
    row.memorySummaryRevision ?? 0,
    row.memorySummaryUpdatedAt ?? 0,
  ]);
}

export type RegistryProjectionCache = Readonly<{
  key: Uint8Array;
  /** Owned copy, wiped when the decrypt effect loses custody. */
  keyBytes: Uint8Array;
  live: () => boolean;
  projections: ReadonlyMap<string, RegistryProjection>;
  userPublicId: string;
}>;

function registryCacheKeyCurrent(cache: RegistryProjectionCache, key: Uint8Array | null): boolean {
  return key !== null && cache.live() && cache.key === key
    && cache.keyBytes.length === key.length
    && cache.keyBytes.every((byte, index) => byte === key[index]);
}

/** Fail closed during the render before a changed authority's effect cleans up. */
export function registryProjectionFromCache(
  cache: RegistryProjectionCache | null,
  input: Readonly<{ key: Uint8Array | null; row: RegistryRow; userPublicId: string | null }>,
): RegistryProjection | undefined {
  return cache !== null && registryCacheKeyCurrent(cache, input.key) && cache.userPublicId === input.userPublicId
    ? cache.projections.get(registryProjectionCacheKey(input.row))
    : undefined;
}

/**
 * Decrypts the independently versioned projections without conflating an old
 * daemon's absent field with a present field that fails its closed contract.
 */
export async function decryptRegistryProjection(input: Readonly<{
  key: Uint8Array;
  memorySummaryReady?: boolean;
  row: RegistryRow;
  userPublicId: string;
}>): Promise<RegistryProjection> {
  const registry = await decryptDeviceRegistry(
    input.row.envelope,
    input.key,
    registryAuthority({
      devicePublicId: input.row.devicePublicId,
      keyVersion: input.row.keyVersion,
      userPublicId: input.userPublicId,
    }),
  );
  let profileBinding: ProfileBindingPayload | null = null;
  let profileBindingStatus: RegistryProjection["profileBindingStatus"] = "unsupported";
  if (input.row.profileBindingEnvelopeStatus === "invalid") {
    profileBindingStatus = "unreadable";
  } else if (
    input.row.profileBindingEnvelopeStatus === "present"
    && input.row.profileBindingEnvelope !== null
  ) {
    try {
      const observation = await decryptProfileBinding(
        input.row.profileBindingEnvelope,
        input.key,
        profileBindingAuthority({
          devicePublicId: input.row.devicePublicId,
          keyVersion: input.row.keyVersion,
          userPublicId: input.userPublicId,
        }),
      );
      if (
        observation.registryRevision !== input.row.revision
        || observation.observedAt !== registry.heartbeatAt
        || observation.preset !== registry.defaultPreset
        || observation.registryEnvelopeDigest !== await profileBindingRegistryDigest(input.row.envelope)
      ) throw new Error("Profile binding does not match its registry.");
      profileBinding = observation;
      profileBindingStatus = "available";
    } catch {
      profileBindingStatus = "unreadable";
    }
  }
  let memorySummary: MemorySummaryPayload | null = null;
  let memorySummaryStatus: RegistryProjection["memorySummaryStatus"] = "unsupported";
  // Summary timestamps come from another machine. Until `presence:current`
  // anchors this browser to hosted time, do not decrypt or expose a value that
  // downstream code could misclassify using the browser's local wall clock.
  if (input.memorySummaryReady === true) {
    if (input.row.memorySummaryEnvelopeStatus === "invalid") {
      memorySummaryStatus = "unreadable";
    } else if (
      input.row.memorySummaryEnvelopeStatus === "present"
      && input.row.memorySummaryEnvelope !== null
    ) {
      try {
        memorySummary = await decryptMemorySummary(
          input.row.memorySummaryEnvelope,
          input.key,
          memorySummaryAuthority({
            devicePublicId: input.row.devicePublicId,
            keyVersion: input.row.keyVersion,
            userPublicId: input.userPublicId,
          }),
        );
        memorySummaryStatus = "available";
      } catch {
        memorySummaryStatus = "unreadable";
      }
    }
  }
  let notificationEmail: NotificationEmailPolicy | null = null;
  let notificationEmailStatus: "available" | "unreadable" | "unsupported" = "unsupported";
  if (input.row.notificationEmailEnvelopeStatus === "invalid") {
    notificationEmailStatus = "unreadable";
  } else if (
    input.row.notificationEmailEnvelopeStatus === "present"
    && input.row.notificationEmailEnvelope !== null
  ) {
    try {
      notificationEmail = await decryptNotificationEmail(
        input.row.notificationEmailEnvelope,
        input.key,
        notificationEmailAuthority({
          devicePublicId: input.row.devicePublicId,
          keyVersion: input.row.keyVersion,
          userPublicId: input.userPublicId,
        }),
      );
      notificationEmailStatus = "available";
    } catch {
      notificationEmailStatus = "unreadable";
    }
  }
  let notificationHours: NotificationHoursPolicy | null = null;
  let notificationHoursStatus: RegistryProjection["notificationHoursStatus"] = "unsupported";
  if (input.row.notificationHoursEnvelopeStatus === "invalid") {
    notificationHoursStatus = "unreadable";
  } else if (
    input.row.notificationHoursEnvelopeStatus === "present"
    && input.row.notificationHoursEnvelope !== null
  ) {
    try {
      notificationHours = await decryptNotificationHours(
        input.row.notificationHoursEnvelope,
        input.key,
        notificationHoursAuthority({
          devicePublicId: input.row.devicePublicId,
          keyVersion: input.row.keyVersion,
          userPublicId: input.userPublicId,
        }),
      );
      notificationHoursStatus = "available";
    } catch {
      notificationHoursStatus = "unreadable";
    }
  }
  return {
    ...notificationEmailProjection({
      notificationEmail,
      notificationEmailStatus,
      notificationHours,
      notificationHoursStatus,
      row: input.row,
    }),
    notificationHours,
    notificationHoursStatus,
    memorySummary,
    memorySummaryStatus,
    profileBinding,
    profileBindingStatus,
    registry,
  };
}

/**
 * Every machine on the account, decrypted and folded into the settings view.
 *
 * A registry written at another account key version cannot be read by this
 * device and is skipped rather than reported as a failure: rotating the account
 * key is a legitimate state, not a broken row.
 */
export function useDeviceRegistries(): DeviceRegistries {
  const custody = useCustody();
  const value = useQuery(listRegistries, {});
  const { rows: deviceRows } = useDeviceRows();
  const serverClock = useServerClock();
  const unlocked = custody.state === "unlocked" ? custody : null;
  const key = unlocked?.key ?? null;
  const keyVersion = unlocked?.identity.keyVersion ?? null;
  const userPublicId = unlocked?.identity.userPublicId ?? null;
  const report = custody.reportAuthorityFailure;
  const [payloads, setPayloads] = useState<RegistryProjectionCache | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rows = useMemo(() => (value === undefined ? [] : parseRegistryRows(value)), [value]);

  useEffect(() => {
    if (key === null || userPublicId === null || keyVersion === null) {
      setPayloads(null);
      return;
    }
    const run = createCancellation();
    const next = new Map<string, RegistryProjection>();
    const cache: RegistryProjectionCache = {
      key,
      keyBytes: new Uint8Array(key),
      live: run.live,
      projections: next,
      userPublicId,
    };
    const current = () => registryCacheKeyCurrent(cache, key);
    void (async () => {
      let failures = 0;
      for (const row of rows) {
        if (!current()) return;
        if (row.keyVersion !== keyVersion) continue;
        try {
          const projection = await decryptRegistryProjection({
            key: cache.keyBytes,
            memorySummaryReady: serverClock.ready,
            row,
            userPublicId,
          });
          if (!current()) return;
          if (
            projection.notificationHoursStatus === "unreadable"
            || projection.notificationPolicyFreshness === "unreadable"
            || projection.memorySummaryStatus === "unreadable"
            || projection.profileBindingStatus === "unreadable"
          ) failures += 1;
          next.set(registryProjectionCacheKey(row), projection);
        } catch (failure: unknown) {
          if (!current()) return;
          report(failure);
          failures += 1;
        }
      }
      if (!current()) return;
      setPayloads(cache);
      setError(failures === 0
        ? null
        : `${failures} machine projection${failures === 1 ? "" : "s"} could not be read.`);
    })();
    return () => {
      run.cancel();
      cache.keyBytes.fill(0);
    };
  }, [key, keyVersion, report, rows, serverClock.ready, userPublicId]);

  const machines = useMemo(() => {
    const devices = new Map<string, MachineDeviceState>(deviceRows.map((row) => [
      row.publicId,
      { deviceClass: row.deviceClass, keyVersion: row.keyVersion, online: row.online, status: row.status },
    ]));
    return sortMachines(rows.flatMap((row) => {
      if (row.keyVersion !== keyVersion) return [];
      const projection = registryProjectionFromCache(payloads, { key, row, userPublicId });
      if (projection === undefined) return [];
      return [toMachineView({
        device: devices.get(row.devicePublicId) ?? null,
        devicePublicId: row.devicePublicId,
        keyVersion: row.keyVersion,
        memorySummaryReady: serverClock.ready,
        now: serverClock.now,
        notificationHours: projection.notificationHours,
        notificationHoursStatus: projection.notificationHoursStatus,
        notificationPolicyFreshness: projection.notificationPolicyFreshness,
        notificationPolicyRevision: projection.notificationPolicyRevision,
        attentionEmailEnabled: projection.attentionEmailEnabled,
        memorySummary: projection.memorySummary,
        memorySummaryStatus: projection.memorySummaryStatus,
        profileBinding: projection.profileBinding,
        profileBindingReady: serverClock.ready,
        profileBindingStatus: projection.profileBindingStatus,
        payload: projection.registry,
        revision: row.revision,
        updatedAt: row.updatedAt,
      })];
    }));
  }, [deviceRows, key, keyVersion, payloads, rows, serverClock.now, serverClock.ready, userPublicId]);

  return {
    error,
    loading: value === undefined,
    memorySummaryReady: serverClock.ready,
    machines,
    now: serverClock.now,
  };
}
