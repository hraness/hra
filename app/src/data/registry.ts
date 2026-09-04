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
  isFiniteTimestamp,
  isOpaqueIdentifier,
  isRecord,
  isSafePositiveInteger,
  parseEncryptedEnvelope,
  type CloudPayloadAuthority,
  type DeviceRegistryPayload,
  type EncryptedEnvelope,
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
  revision: number;
  updatedAt: number;
}>;

export function parseRegistryRow(value: unknown): RegistryRow | null {
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
  return {
    devicePublicId: value.devicePublicId,
    envelope,
    keyVersion: value.keyVersion,
    revision: value.revision,
    updatedAt: value.updatedAt,
  };
}

export function parseRegistryRows(value: unknown): readonly RegistryRow[] {
  if (!Array.isArray(value)) return [];
  return value
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

export type DeviceRegistries = Readonly<{
  error: string | null;
  loading: boolean;
  machines: readonly MachineView[];
}>;

function cacheKey(row: RegistryRow): string {
  return `${row.devicePublicId}:${row.revision}`;
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
  const [payloads, setPayloads] = useState<ReadonlyMap<string, DeviceRegistryPayload>>(new Map());
  const [error, setError] = useState<string | null>(null);

  const rows = useMemo(() => (value === undefined ? [] : parseRegistryRows(value)), [value]);

  useEffect(() => {
    if (key === null || userPublicId === null || keyVersion === null) {
      setPayloads(new Map());
      return;
    }
    const run = createCancellation();
    void (async () => {
      const next = new Map<string, DeviceRegistryPayload>();
      let failures = 0;
      for (const row of rows) {
        if (row.keyVersion !== keyVersion) continue;
        try {
          next.set(cacheKey(row), await decryptDeviceRegistry(
            row.envelope,
            key,
            registryAuthority({
              devicePublicId: row.devicePublicId,
              keyVersion: row.keyVersion,
              userPublicId,
            }),
          ));
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
      const payload = payloads.get(cacheKey(row));
      if (payload === undefined) return [];
      return [toMachineView({
        device: devices.get(row.devicePublicId) ?? null,
        devicePublicId: row.devicePublicId,
        now,
        payload,
        revision: row.revision,
        updatedAt: row.updatedAt,
      })];
    }));
  }, [deviceRows, now, payloads, rows]);

  return { error, loading: value === undefined, machines };
}
