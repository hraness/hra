import {
  cloudLimits,
  hasExactKeys,
  isDigest,
  isFiniteTimestamp,
  isRecord,
  isUuidV7,
  type CommandState,
} from "../hra/cloud";
import type {
  WireCommandReceiptProofArgs,
  WireDeviceEnqueueArgs,
  WireEnqueueArgs,
} from "./functions";
import { WireShapeError } from "./wire";

const commandStates = new Set<CommandState>([
  "pending",
  "prepared",
  "effect_started",
  "applied",
  "failed",
  "ambiguous",
  "cancelled",
  "expired",
]);

export type CommandReceiptProof = Readonly<{
  idempotencyKey: string;
  publicId: string;
  requestDigest: string;
}>;

function isCommandState(value: unknown): value is CommandState {
  return typeof value === "string" && commandStates.has(value as CommandState);
}

function parseProof(value: unknown): CommandReceiptProof | null {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["idempotencyKey", "publicId", "requestDigest"])
    || !isUuidV7(value.idempotencyKey)
    || !isUuidV7(value.publicId)
    || !isDigest(value.requestDigest)
  ) return null;
  return {
    idempotencyKey: value.idempotencyKey,
    publicId: value.publicId,
    requestDigest: value.requestDigest,
  };
}

/** Parse the bounded requester-only recovery query without trusting its wire shape. */
export function parseCommandReceiptProofPage(value: unknown): readonly CommandReceiptProof[] | null {
  if (!Array.isArray(value) || value.length > cloudLimits.pageSize) return null;
  const proofs: CommandReceiptProof[] = [];
  const publicIds = new Set<string>();
  for (const candidate of value) {
    const proof = parseProof(candidate);
    if (proof === null || publicIds.has(proof.publicId)) return null;
    publicIds.add(proof.publicId);
    proofs.push(proof);
  }
  return proofs;
}

/**
 * Keep the established marker-2 success shape exact across a server-first
 * rollout. Once that response proves the generated command and its authority,
 * acknowledgement uses the idempotency key and digest from the exact request
 * this process submitted; durable lost-response recovery still reads those
 * proof fields from the authoritative hosted row.
 */
export function parseSessionCommandEnqueueReceipt(
  value: unknown,
  request: WireEnqueueArgs,
): CommandReceiptProof | null {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      "publicId",
      "requestCommitmentVersion",
      "replay",
      "requestingDevicePublicId",
      "sessionPublicId",
      "state",
      "targetDevicePublicId",
    ])
    || value.publicId !== request.publicId
    || value.requestCommitmentVersion !== 2
    || typeof value.replay !== "boolean"
    || value.requestingDevicePublicId !== request.expectedRequestingDevicePublicId
    || value.sessionPublicId !== request.sessionPublicId
    || !isCommandState(value.state)
    || value.targetDevicePublicId !== request.expectedTargetDevicePublicId
  ) return null;
  return {
    idempotencyKey: request.idempotencyKey,
    publicId: request.publicId,
    requestDigest: request.requestDigest,
  };
}

/** Device commands carry the same exact proof but no session identity. */
export function parseDeviceCommandEnqueueReceipt(
  value: unknown,
  request: WireDeviceEnqueueArgs,
): CommandReceiptProof | null {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      "publicId",
      "requestCommitmentVersion",
      "replay",
      "requestingDevicePublicId",
      "state",
      "targetDevicePublicId",
    ])
    || value.publicId !== request.publicId
    || value.requestCommitmentVersion !== 2
    || typeof value.replay !== "boolean"
    || value.requestingDevicePublicId !== request.expectedRequestingDevicePublicId
    || !isCommandState(value.state)
    || value.targetDevicePublicId !== request.expectedTargetDevicePublicId
  ) return null;
  return {
    idempotencyKey: request.idempotencyKey,
    publicId: request.publicId,
    requestDigest: request.requestDigest,
  };
}

export function commandReceiptProofArgs(
  proof: CommandReceiptProof,
): WireCommandReceiptProofArgs {
  return {
    commandPublicId: proof.publicId,
    idempotencyKey: proof.idempotencyKey,
    requestDigest: proof.requestDigest,
  };
}

export function commandReceiptAcknowledgementMatches(
  value: unknown,
  proof: CommandReceiptProof,
): boolean {
  return isRecord(value)
    && hasExactKeys(value, ["acknowledgedAt", "publicId", "replay"])
    && isFiniteTimestamp(value.acknowledgedAt)
    && value.publicId === proof.publicId
    && typeof value.replay === "boolean";
}

export async function acknowledgeObservedCommandReceipt(
  proof: CommandReceiptProof,
  mutate: (args: WireCommandReceiptProofArgs) => Promise<unknown>,
): Promise<void> {
  const acknowledgement = await mutate(commandReceiptProofArgs(proof));
  if (!commandReceiptAcknowledgementMatches(acknowledgement, proof)) {
    throw new WireShapeError("command receipt acknowledgement");
  }
}
