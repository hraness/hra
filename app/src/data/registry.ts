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
  decryptNotificationEmail,
  decryptNotificationHours,
  isFiniteTimestamp,
  isOpaqueIdentifier,
  isRecord,
  isSafePositiveInteger,
  parseEncryptedEnvelope,
  snapshotForeignJson,
  type CloudPayloadAuthority,
  type DeviceRegistryPayload,
  type EncryptedEnvelope,
  type NotificationEmailPolicy,
  type NotificationHoursPolicy,
} from "../hra/cloud";
import { createCancellation } from "../lib/cancellation";
import {
  sortMachines,
  toMachineView,
  type MachineDeviceState,
  type MachineView,
} from "../model/settings-view";
import { useDeviceRows, useServerNow } from "./devices";
import { listRegistries } from "./functions";

export type RegistryRow = Readonly<{
  devicePublicId: string;
  envelope: EncryptedEnvelope;
  keyVersion: number;
  /** Optional companion projection so the broad registry stays v1-compatible. */
  notificationEmailEnvelope: EncryptedEnvelope | null;
  notificationEmailEnvelopeStatus: "absent" | "invalid" | "present";
  /** Optional and independently encrypted so old daemons remain readable. */
  notificationHoursEnvelope: EncryptedEnvelope | null;
  notificationHoursEnvelopeStatus: "absent" | "invalid" | "present";
  /** Server-visible freshness fence; never consent on its own. */
  notificationPolicyRevision: number | null;
  notificationPolicyRevisionStatus: "absent" | "invalid" | "present";
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
  return {
    devicePublicId: value.devicePublicId,
    envelope,
    keyVersion: value.keyVersion,
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

export type DeviceRegistries = Readonly<{
  error: string | null;
  loading: boolean;
  machines: readonly MachineView[];
}>;

export type RegistryProjection = Readonly<{
  attentionEmailEnabled: boolean | null;
  notificationHours: NotificationHoursPolicy | null;
  notificationHoursStatus: "available" | "unreadable" | "unsupported";
  notificationPolicyFreshness: "current" | "stale" | "unreadable" | "unsupported";
  notificationPolicyRevision: number | null;
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

function cacheKey(row: RegistryRow): string {
  return `${row.devicePublicId}:${row.revision}`;
}

/**
 * Decrypts the independently versioned projections without conflating an old
 * daemon's absent field with a present field that fails its closed contract.
 */
export async function decryptRegistryProjection(input: Readonly<{
  key: Uint8Array;
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
  const now = useServerNow();
  const unlocked = custody.state === "unlocked" ? custody : null;
  const key = unlocked?.key ?? null;
  const keyVersion = unlocked?.identity.keyVersion ?? null;
  const userPublicId = unlocked?.identity.userPublicId ?? null;
  const report = custody.reportAuthorityFailure;
  const [payloads, setPayloads] = useState<ReadonlyMap<string, RegistryProjection>>(new Map());
  const [error, setError] = useState<string | null>(null);

  const rows = useMemo(() => (value === undefined ? [] : parseRegistryRows(value)), [value]);

  useEffect(() => {
    if (key === null || userPublicId === null || keyVersion === null) {
      setPayloads(new Map());
      return;
    }
    const run = createCancellation();
    void (async () => {
      const next = new Map<string, RegistryProjection>();
      let failures = 0;
      for (const row of rows) {
        if (row.keyVersion !== keyVersion) continue;
        try {
          const projection = await decryptRegistryProjection({
            key,
            row,
            userPublicId,
          });
          if (
            projection.notificationHoursStatus === "unreadable"
            || projection.notificationPolicyFreshness === "unreadable"
          ) failures += 1;
          next.set(cacheKey(row), projection);
        } catch (failure: unknown) {
          report(failure);
          failures += 1;
        }
      }
      if (!run.live()) return;
      setPayloads(next);
      setError(failures === 0
        ? null
        : `${failures} machine setting${failures === 1 ? "" : "s"} could not be read.`);
    })();
    return () => { run.cancel(); };
  }, [key, keyVersion, report, rows, userPublicId]);

  const machines = useMemo(() => {
    const devices = new Map<string, MachineDeviceState>(deviceRows.map((row) => [
      row.publicId,
      { online: row.online, status: row.status },
    ]));
    return sortMachines(rows.flatMap((row) => {
      const projection = payloads.get(cacheKey(row));
      if (projection === undefined) return [];
      return [toMachineView({
        device: devices.get(row.devicePublicId) ?? null,
        devicePublicId: row.devicePublicId,
        now,
        notificationHours: projection.notificationHours,
        notificationHoursStatus: projection.notificationHoursStatus,
        notificationPolicyFreshness: projection.notificationPolicyFreshness,
        notificationPolicyRevision: projection.notificationPolicyRevision,
        attentionEmailEnabled: projection.attentionEmailEnabled,
        payload: projection.registry,
        revision: row.revision,
        updatedAt: row.updatedAt,
      })];
    }));
  }, [deviceRows, now, payloads, rows]);

  return { error, loading: value === undefined, machines };
}
