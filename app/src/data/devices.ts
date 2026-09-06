/**
 * The account's devices, as the settings screen reads them.
 *
 * `devices:list` returns one row per device with its class, status, presence,
 * and both public keys. The label is encrypted under the account key with the
 * daemon's device-label AAD, so it decrypts here only for devices registered at
 * the reader's own key version; a browser device registers its label under a
 * provisional key and therefore shows as its public id, which is what the
 * revoke instruction needs anyway.
 *
 * A browser device may not administer the account: `devices:revoke` refuses it
 * with `BROWSER_DEVICE_CANNOT_ADMINISTER`, so this module exposes no revoke
 * call and the screen prints the CLI instruction instead.
 */
import { useQuery } from "convex/react";
import { useEffect, useMemo, useState } from "react";

import { useCustody } from "../custody/custody-context";
import { deviceKeyFingerprint } from "../custody/fingerprint";
import { deviceLabelAad } from "../custody/registration";
import {
  decryptBytes,
  isFiniteTimestamp,
  isOpaqueIdentifier,
  isRecord,
  isSafePositiveInteger,
  parseDevicePublicKeyJson,
  parseEncryptedEnvelope,
  type EncryptedEnvelope,
} from "../hra/cloud";
import { createCancellation } from "../lib/cancellation";
import { listDevices, presenceCurrent } from "./functions";
import { parsePresenceResponse, type DeviceStatus } from "./wire";

export type DeviceClass = "browser" | "daemon";

const deviceClasses = new Set<DeviceClass>(["browser", "daemon"]);
const deviceStatuses = new Set<DeviceStatus>(["pending", "active", "revoked"]);

/** The daemon's own bound on a decrypted device label (`local-control.ts`). */
export const deviceLabelPlaintextBytes = 640;

export type DeviceRow = Readonly<{
  activatedAt: number | null;
  deviceClass: DeviceClass;
  encryptedLabel: EncryptedEnvelope;
  keyVersion: number;
  lastSeenAt: number | null;
  online: boolean;
  publicId: string;
  revision: number;
  signingPublicKey: string | null;
  status: DeviceStatus;
  wrappingPublicKey: string | null;
}>;

function publicKeyOrNull(value: unknown): string | null {
  return typeof value === "string" && parseDevicePublicKeyJson(value) !== null ? value : null;
}

export function parseDeviceRow(value: unknown): DeviceRow | null {
  if (
    !isRecord(value)
    || !isOpaqueIdentifier(value.publicId)
    || !isSafePositiveInteger(value.keyVersion)
    || !isSafePositiveInteger(value.revision)
    || typeof value.online !== "boolean"
    || typeof value.status !== "string"
    || !deviceStatuses.has(value.status as DeviceStatus)
    || (value.deviceClass !== undefined
      && (typeof value.deviceClass !== "string"
        || !deviceClasses.has(value.deviceClass as DeviceClass)))
    || (value.activatedAt !== undefined && !isFiniteTimestamp(value.activatedAt))
    || (value.lastSeenAt !== null && !isFiniteTimestamp(value.lastSeenAt))
  ) return null;
  const encryptedLabel = parseEncryptedEnvelope(value.encryptedLabel);
  if (encryptedLabel === null) return null;
  return {
    activatedAt: typeof value.activatedAt === "number" ? value.activatedAt : null,
    deviceClass: typeof value.deviceClass === "string"
      ? value.deviceClass as DeviceClass
      : "daemon",
    encryptedLabel,
    keyVersion: value.keyVersion,
    lastSeenAt: typeof value.lastSeenAt === "number" ? value.lastSeenAt : null,
    online: value.online,
    publicId: value.publicId,
    revision: value.revision,
    signingPublicKey: publicKeyOrNull(value.signingPublicKey),
    status: value.status as DeviceStatus,
    wrappingPublicKey: publicKeyOrNull(value.wrappingPublicKey),
  };
}

export function parseDeviceRows(value: unknown): readonly DeviceRow[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => parseDeviceRow(entry))
    .filter((entry): entry is DeviceRow => entry !== null);
}

export function useDeviceRows(): Readonly<{ loading: boolean; rows: readonly DeviceRow[] }> {
  const value = useQuery(listDevices, {});
  const rows = useMemo(() => (value === undefined ? [] : parseDeviceRows(value)), [value]);
  return { loading: value === undefined, rows };
}

/** How often the settings screen re-reads its own clock for relative times. */
export const serverClockTickMs = 30_000;

/**
 * A clock anchored on the hosted deployment.
 *
 * Every relative time on this screen compares a timestamp written by another
 * machine against "now", so a browser whose clock is minutes out would report a
 * live machine as offline. `presence:current` carries the server's own `now`
 * with the reader's presence row, which gives the offset to correct by.
 */
export type ServerClock = Readonly<{ now: number; ready: boolean }>;
export type ServerClockAnchor = Readonly<{ monotonicAt: number; serverNow: number }>;

export function projectServerClockNow(
  anchor: ServerClockAnchor,
  monotonicNow: number,
): number {
  const elapsed = Math.max(0, monotonicNow - anchor.monotonicAt);
  return Math.min(Number.MAX_SAFE_INTEGER, anchor.serverNow + elapsed);
}

export function useServerClock(): ServerClock {
  const value = useQuery(presenceCurrent, {});
  const [tick, setTick] = useState(() => performance.now());
  const [anchor, setAnchor] = useState<ServerClockAnchor | null>(null);

  useEffect(() => {
    const timer = setInterval(() => { setTick(performance.now()); }, serverClockTickMs);
    return () => { clearInterval(timer); };
  }, []);

  const presence = value === undefined || value === null ? null : parsePresenceResponse(value);
  const serverNow = presence?.serverNow ?? null;
  useEffect(() => {
    if (serverNow === null) return;
    const monotonicAt = performance.now();
    setAnchor({ monotonicAt, serverNow });
    setTick(monotonicAt);
  }, [serverNow]);

  return {
    now: anchor === null ? Date.now() : projectServerClockNow(anchor, tick),
    // Do not let a browser-clock-dependent effect run during the render where
    // the first hosted timestamp arrived but its offset is not anchored yet.
    ready: anchor !== null,
  };
}

export function useServerNow(): number {
  return useServerClock().now;
}

export type DeviceView = DeviceRow & Readonly<{
  current: boolean;
  fingerprint: string | null;
  label: string | null;
}>;

type DeviceDetail = Readonly<{ fingerprint: string | null; label: string | null }>;

const emptyDetail: DeviceDetail = { fingerprint: null, label: null };

/**
 * The device rows with what the reader can add locally: the decrypted label
 * where the account key covers it, and the key fingerprint an operator compares
 * before running `hra device approve`.
 */
export function useDevices(): Readonly<{ devices: readonly DeviceView[]; loading: boolean }> {
  const custody = useCustody();
  const { loading, rows } = useDeviceRows();
  const unlocked = custody.state === "unlocked" ? custody : null;
  const key = unlocked?.key ?? null;
  const keyVersion = unlocked?.identity.keyVersion ?? null;
  const userPublicId = unlocked?.identity.userPublicId ?? null;
  const currentDevicePublicId = unlocked?.identity.devicePublicId ?? null;
  const report = custody.reportAuthorityFailure;
  const [details, setDetails] = useState<ReadonlyMap<string, DeviceDetail>>(new Map());

  useEffect(() => {
    if (key === null || userPublicId === null || keyVersion === null) {
      setDetails(new Map());
      return;
    }
    const run = createCancellation();
    void (async () => {
      const next = new Map<string, DeviceDetail>();
      for (const row of rows) {
        const [fingerprint, label] = await Promise.all([
          row.signingPublicKey === null || row.wrappingPublicKey === null
            ? Promise.resolve(null)
            : deviceKeyFingerprint(row.signingPublicKey, row.wrappingPublicKey)
              .catch(() => null),
          decryptDeviceLabel({
            key,
            keyVersion,
            row,
            userPublicId,
          }),
        ]);
        next.set(row.publicId, { fingerprint, label });
      }
      if (run.live()) setDetails(next);
    })().catch((failure: unknown) => { report(failure); });
    return () => { run.cancel(); };
  }, [key, keyVersion, report, rows, userPublicId]);

  const devices = useMemo(() => rows.map((row) => ({
    ...row,
    ...(details.get(row.publicId) ?? emptyDetail),
    current: row.publicId === currentDevicePublicId,
  })), [currentDevicePublicId, details, rows]);

  return { devices, loading };
}

async function decryptDeviceLabel(input: Readonly<{
  key: Uint8Array;
  keyVersion: number;
  row: DeviceRow;
  userPublicId: string;
}>): Promise<string | null> {
  const { key, keyVersion, row, userPublicId } = input;
  if (row.keyVersion !== keyVersion || row.encryptedLabel.keyVersion !== keyVersion) return null;
  try {
    const plaintext = await decryptBytes(
      row.encryptedLabel,
      key,
      deviceLabelAad(userPublicId, row.publicId, row.encryptedLabel.keyVersion),
    );
    if (plaintext.byteLength > deviceLabelPlaintextBytes) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
  } catch {
    // A device registered under a provisional key, or under another key
    // version, is not decryptable here. That is expected, not an authority
    // failure, so the row falls back to its public id.
    return null;
  }
}
