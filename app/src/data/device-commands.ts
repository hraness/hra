import { useConvex, useQuery } from "convex/react";
import { useCallback } from "react";

import { useCustody } from "../custody/custody-context";
import {
  deviceCommandPayloadAuthority,
  deviceCommandResultAuthority,
  deviceEnqueueRequest,
  deviceEnqueueRequestDigest,
} from "../custody/registration";
import { commandLifetimeMs } from "../env";
import { bindHostedLoginResultExpiry } from "../model/device-commands";
import {
  createCloudUuidV7,
  decryptDeviceCommandResult,
  encryptDeviceCommand,
  type DeviceCommandPayload,
  type DeviceCommandResultPayload,
  type EncryptedEnvelope,
} from "../hra/cloud";
import { consumeDeviceCommandResult, deviceCommandGet, enqueueDeviceCommand } from "./functions";
import { parseDeviceCommandRecord, type DeviceCommandRecord } from "./wire";

export type SubmitDeviceCommandInput = Readonly<{
  payload: DeviceCommandPayload;
  /** The machine that will run it: a daemon device from the registry. */
  targetDevicePublicId: string;
}>;

export type SubmitDeviceCommand = (input: SubmitDeviceCommandInput) => Promise<string>;

/**
 * Encrypts a device command under the account key and enqueues it against one
 * machine. Unlike a session command it names no session, so the browser is
 * asking the machine to do something before any session exists.
 */
export function useSubmitDeviceCommand(): SubmitDeviceCommand {
  const custody = useCustody();
  const convex = useConvex();
  const unlocked = custody.state === "unlocked" ? custody : null;
  const report = custody.reportAuthorityFailure;

  return useCallback(async (input: SubmitDeviceCommandInput) => {
    if (unlocked === null) throw new Error("The account key is locked.");
    const now = Date.now();
    const commandPublicId = createCloudUuidV7(now);
    const idempotencyKey = createCloudUuidV7(now);
    const payload = await encryptDeviceCommand(
      input.payload,
      unlocked.key,
      deviceCommandPayloadAuthority({
        commandPublicId,
        keyVersion: unlocked.identity.keyVersion,
        userPublicId: unlocked.identity.userPublicId,
      }),
    );
    const request = deviceEnqueueRequest({
      deadline: now + commandLifetimeMs,
      expectedTargetDevicePublicId: input.targetDevicePublicId,
      kind: input.payload.kind,
      payload,
      publicId: commandPublicId,
    });
    const requestDigest = await deviceEnqueueRequestDigest(unlocked.key, request);
    try {
      await convex.mutation(enqueueDeviceCommand, { ...request, idempotencyKey, requestDigest });
    } catch (failure: unknown) {
      report(failure);
      throw failure;
    }
    return commandPublicId;
  }, [convex, report, unlocked]);
}

export function useDeviceCommandState(
  commandPublicId: string | null,
): DeviceCommandRecord | null {
  const value = useQuery(
    deviceCommandGet,
    commandPublicId === null ? "skip" : { commandPublicId },
  );
  if (value === undefined || value === null) return null;
  return parseDeviceCommandRecord(value);
}

export type ReadDeviceCommandResult = (
  commandPublicId: string,
  envelope: EncryptedEnvelope,
) => Promise<DeviceCommandResultPayload>;

export async function readDeviceCommandResult(input: Readonly<{
  commandPublicId: string;
  envelope: EncryptedEnvelope;
  key: Uint8Array;
  keyVersion: number;
  userPublicId: string;
}>, decrypt: typeof decryptDeviceCommandResult = decryptDeviceCommandResult): Promise<DeviceCommandResultPayload> {
  return await decrypt(
    input.envelope,
    input.key,
    deviceCommandResultAuthority({
      commandPublicId: input.commandPublicId,
      keyVersion: input.keyVersion,
      userPublicId: input.userPublicId,
    }),
  );
}

/**
 * Decrypts a reusable command result already returned by the exact command
 * query. Unlike the login-start exchange, this performs no hosted mutation and
 * does not consume the result.
 */
export function useReadDeviceCommandResult(): ReadDeviceCommandResult {
  const custody = useCustody();
  const unlocked = custody.state === "unlocked" ? custody : null;

  return useCallback(async (commandPublicId: string, envelope: EncryptedEnvelope) => {
    if (unlocked === null) throw new Error("The account key is locked.");
    return await readDeviceCommandResult({
      commandPublicId,
      envelope,
      key: unlocked.key,
      keyVersion: unlocked.identity.keyVersion,
      userPublicId: unlocked.identity.userPublicId,
    });
  }, [unlocked]);
}

export type ConsumeDeviceCommandResult =
  (
    commandPublicId: string,
    fallbackHostedExpiresAt: number,
  ) => Promise<DeviceCommandResultPayload | null>;

/**
 * Exchanges a single-use result for its plaintext, once. The hosted row erases
 * the ciphertext in the same transaction, so a second call resolves to null and
 * the relayed login URL and user code cannot be replayed from another tab.
 */
export function useConsumeDeviceCommandResult(): ConsumeDeviceCommandResult {
  const custody = useCustody();
  const convex = useConvex();
  const unlocked = custody.state === "unlocked" ? custody : null;
  const report = custody.reportAuthorityFailure;

  return useCallback(async (commandPublicId: string, fallbackHostedExpiresAt: number) => {
    if (unlocked === null) throw new Error("The account key is locked.");
    let released: unknown;
    try {
      released = await convex.mutation(consumeDeviceCommandResult, { commandPublicId });
    } catch (failure: unknown) {
      report(failure);
      throw failure;
    }
    if (
      typeof released !== "object"
      || released === null
      || (released as { status?: unknown }).status !== "released"
    ) return null;
    const envelope = (released as { result?: unknown }).result;
    const returnedHostedExpiresAt = (released as { expiresAt?: unknown }).expiresAt;
    const record = parseDeviceCommandRecord({
      createdAt: 0,
      deadline: 0,
      kind: "account_login_start",
      publicId: commandPublicId,
      result: envelope,
      resultSingleUse: true,
      state: "applied",
      updatedAt: 0,
    });
    if (record?.result == null) return null;
    const result = await decryptDeviceCommandResult(
      record.result,
      unlocked.key,
      deviceCommandResultAuthority({
        commandPublicId,
        keyVersion: unlocked.identity.keyVersion,
        userPublicId: unlocked.identity.userPublicId,
      }),
    );
    return bindHostedLoginResultExpiry(
      result,
      returnedHostedExpiresAt,
      fallbackHostedExpiresAt,
    );
  }, [convex, report, unlocked]);
}
