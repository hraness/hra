import { useConvex, useQuery } from "convex/react";
import { useCallback, useEffect, useRef, useState } from "react";

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
import {
  consumeDeviceCommandResult,
  deviceCommandGet,
  enqueueDeviceCommand,
  type WireDeviceEnqueueArgs,
} from "./functions";
import { parseDeviceCommandRecord, type DeviceCommandRecord } from "./wire";

export type SubmitDeviceCommandInput = Readonly<{
  payload: DeviceCommandPayload;
  /** The machine that will run it: a daemon device from the registry. */
  targetDevicePublicId: string;
}>;

export type SubmitDeviceCommand =
  (input: SubmitDeviceCommandInput) => Promise<string>;

export type DeviceCommandHandle = Readonly<{
  publicId: string;
  responseValidated: boolean;
}>;

export class DeviceCommandConsumePrecommitError extends Error {
  constructor(readonly failure: unknown) {
    super("The login handoff was not consumed. It is safe to try reading it again.");
    this.name = "DeviceCommandConsumePrecommitError";
  }
}

export class DeviceCommandConsumedResultUnreadableError extends Error {
  constructor(readonly failure?: unknown) {
    super("The one-time login handoff was consumed but could not be read.");
    this.name = "DeviceCommandConsumedResultUnreadableError";
  }
}

/** Preserve the provider/auth error identity when adding UI-facing fencing semantics. */
export function deviceCommandMutationFailureCause(failure: unknown): unknown {
  if (failure instanceof DeviceCommandConsumePrecommitError) return failure.failure;
  return failure;
}

type EnqueueMutation = (args: WireDeviceEnqueueArgs) => Promise<unknown>;
type ConsumeMutation = (args: Readonly<{ commandPublicId: string }>) => Promise<unknown>;

export const deviceCommandProtocolInvalidMessage =
  "The cloud accepted the command but returned an incompatible receipt. Its generated command is still being tracked.";

export const deviceCommandCommittedRowUnavailableMessage =
  "The cloud accepted this command, but its committed row is unavailable. No retry was sent. Check the machine before trying again.";

export class DeviceCommandResponseInvalidError extends Error {
  constructor(readonly commandPublicId: string) {
    super(deviceCommandProtocolInvalidMessage);
    this.name = "DeviceCommandResponseInvalidError";
  }
}

function requireMatchingMutationResponse(value: unknown, publicId: string): void {
  if (
    typeof value !== "object"
    || value === null
    || (value as { publicId?: unknown }).publicId !== publicId
  ) throw new DeviceCommandResponseInvalidError(publicId);
}

/**
 * Submit once through Convex's sync mutation client. The client retains and
 * re-sends this one request id across disconnects, so a transport interruption
 * keeps this promise pending; it does not reject it. A rejection is a definite
 * server transaction abort (or a client-side preflight failure), and must never
 * trigger a second application-level enqueue.
 */
export async function submitPreparedDeviceCommand(
  request: WireDeviceEnqueueArgs,
  mutate: EnqueueMutation,
): Promise<string> {
  const response = await mutate(request);
  // Deliberately outside a mutation-rejection catch. An incompatible success
  // response is not proof that the transaction aborted and must not be retried.
  requireMatchingMutationResponse(response, request.publicId);
  return request.publicId;
}

/**
 * Read a single-use result through one Convex mutation promise. The sync client
 * retries that request id internally while disconnected and only rejects after
 * a definite server abort, so the caller may offer an explicit retry only for
 * this wrapped rejection. No application-level automatic retry can consume the
 * ciphertext twice.
 */
export async function consumeSingleUseDeviceCommandResult(
  commandPublicId: string,
  mutate: ConsumeMutation,
): Promise<unknown> {
  const args = { commandPublicId };
  try {
    return await mutate(args);
  } catch (failure: unknown) {
    throw new DeviceCommandConsumePrecommitError(failure);
  }
}

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
      return await submitPreparedDeviceCommand(
        { ...request, idempotencyKey, requestDigest },
        async (args) => await convex.mutation(enqueueDeviceCommand, args),
      );
    } catch (failure: unknown) {
      report(deviceCommandMutationFailureCause(failure));
      throw failure;
    }
  }, [convex, report, unlocked]);
}

export type DeviceCommandObservation = Readonly<{
  protocolWarning: string | null;
  record: DeviceCommandRecord | null;
  status: "idle" | "loading" | "missing" | "invalid" | "present";
}>;

export type SetTrackedDeviceCommand = (handle: DeviceCommandHandle | null) => void;

export function useDeviceCommandState(
  handle: DeviceCommandHandle | null,
): DeviceCommandObservation {
  const value = useQuery(
    deviceCommandGet,
    handle === null ? "skip" : { commandPublicId: handle.publicId },
  );
  const protocolWarning = handle?.responseValidated === false
    ? deviceCommandProtocolInvalidMessage
    : null;
  if (handle === null) return { protocolWarning: null, record: null, status: "idle" };
  if (value === undefined) return { protocolWarning, record: null, status: "loading" };
  if (value === null) return { protocolWarning, record: null, status: "missing" };
  const record = parseDeviceCommandRecord(value);
  if (record === null || record.publicId !== handle.publicId) {
    return { protocolWarning, record: null, status: "invalid" };
  }
  // Seeing the exact row reconciles a malformed mutation response. The warning
  // is derived from this observation rather than latched in component state, so
  // it clears on the first authoritative present value without another write.
  return { protocolWarning: null, record, status: "present" };
}

/**
 * Owns one committed command identity until its exact hosted row is observed.
 * Loading is inert. An authoritative missing/invalid value releases the local
 * handle once and delegates fail-closed UI copy to the caller; it never
 * resubmits or acknowledges anything.
 */
export function useDeviceCommandTracker(
  onUnavailable: (commandPublicId: string) => void,
): Readonly<{
  observation: DeviceCommandObservation;
  setHandle: SetTrackedDeviceCommand;
}> {
  const [handle, setStoredHandle] = useState<DeviceCommandHandle | null>(null);
  const observation = useDeviceCommandState(handle);
  const currentHandle = useRef(handle);
  const unavailableCallback = useRef(onUnavailable);
  const releasedCommand = useRef<string | null>(null);
  currentHandle.current = handle;
  unavailableCallback.current = onUnavailable;

  const setHandle = useCallback<SetTrackedDeviceCommand>((next) => {
    releasedCommand.current = null;
    setStoredHandle(next);
  }, []);

  useEffect(() => {
    if (
      handle === null
      || (observation.status !== "missing" && observation.status !== "invalid")
      || currentHandle.current?.publicId !== handle.publicId
      || releasedCommand.current === handle.publicId
    ) return;
    releasedCommand.current = handle.publicId;
    setStoredHandle(null);
    unavailableCallback.current(handle.publicId);
  }, [handle, observation.status]);

  return { observation, setHandle };
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
      released = await consumeSingleUseDeviceCommandResult(
        commandPublicId,
        async (args) => await convex.mutation(consumeDeviceCommandResult, args),
      );
    } catch (failure: unknown) {
      report(deviceCommandMutationFailureCause(failure));
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
    if (record?.result == null) throw new DeviceCommandConsumedResultUnreadableError();
    try {
      const result = await decryptDeviceCommandResult(
        record.result,
        unlocked.key,
        deviceCommandResultAuthority({
          commandPublicId,
          keyVersion: unlocked.identity.keyVersion,
          userPublicId: unlocked.identity.userPublicId,
        }),
      );
      const bound = bindHostedLoginResultExpiry(
        result,
        returnedHostedExpiresAt,
        fallbackHostedExpiresAt,
      );
      if (bound === null) throw new DeviceCommandConsumedResultUnreadableError();
      return bound;
    } catch (failure: unknown) {
      if (failure instanceof DeviceCommandConsumedResultUnreadableError) throw failure;
      throw new DeviceCommandConsumedResultUnreadableError(failure);
    }
  }, [convex, report, unlocked]);
}
