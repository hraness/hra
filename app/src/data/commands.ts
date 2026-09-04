import { useConvex, useQuery } from "convex/react";
import { useCallback } from "react";

import { useCustody } from "../custody/custody-context";
import {
  commandPayloadAuthority,
  enqueueRequest,
  enqueueRequestDigest,
} from "../custody/registration";
import { commandLifetimeMs } from "../env";
import { createCloudUuidV7, encryptRemoteCommand, type RemoteCommandPayload } from "../hra/cloud";
import { commandGet, enqueueCommand } from "./functions";
import { parseCommandRecord, type CommandRecord } from "./wire";

export type SubmitCommandInput = Readonly<{
  /** The head's `executionDevicePublicId`: the custodian this command binds to. */
  executionDevicePublicId: string;
  payload: RemoteCommandPayload;
  sessionPublicId: string;
}>;

export type SubmitCommand = (input: SubmitCommandInput) => Promise<string>;

/**
 * Encrypts a remote command under the account key and enqueues it.
 *
 * The submission binds the expected custodian device, so a session that moved
 * to another machine between render and submit fails closed instead of running
 * somewhere the browser did not intend. The deadline is five minutes: a command
 * the daemon never picked up expires rather than replaying later.
 */
export function useSubmitCommand(): SubmitCommand {
  const custody = useCustody();
  const convex = useConvex();
  const unlocked = custody.state === "unlocked" ? custody : null;
  const report = custody.reportAuthorityFailure;

  return useCallback(async (input: SubmitCommandInput) => {
    if (unlocked === null) throw new Error("The account key is locked.");
    const now = Date.now();
    const commandPublicId = createCloudUuidV7(now);
    const idempotencyKey = createCloudUuidV7(now);
    const payload = await encryptRemoteCommand(input.payload, unlocked.key, commandPayloadAuthority({
      commandPublicId,
      keyVersion: unlocked.identity.keyVersion,
      userPublicId: unlocked.identity.userPublicId,
    }));
    const request = enqueueRequest({
      deadline: now + commandLifetimeMs,
      expectedTargetDevicePublicId: input.executionDevicePublicId,
      kind: input.payload.kind,
      payload,
      publicId: commandPublicId,
      sessionPublicId: input.sessionPublicId,
    });
    const requestDigest = await enqueueRequestDigest(unlocked.key, request);
    try {
      await convex.mutation(enqueueCommand, { ...request, idempotencyKey, requestDigest });
    } catch (failure: unknown) {
      report(failure);
      throw failure;
    }
    return commandPublicId;
  }, [convex, report, unlocked]);
}

export function useCommandState(commandPublicId: string | null): CommandRecord | null {
  const value = useQuery(
    commandGet,
    commandPublicId === null ? "skip" : { commandPublicId },
  );
  if (value === undefined || value === null) return null;
  return parseCommandRecord(value);
}
