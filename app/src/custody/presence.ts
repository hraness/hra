/**
 * Device presence, expressed without React so the fingerprint and the sequence
 * discipline test directly.
 *
 * The fingerprint string is the daemon's
 * (`src/cloud/daemon-bridge.ts:presenceRequest`), byte for byte: the server
 * stores it and refuses a heartbeat whose fingerprint does not match the
 * sequence it claims, so this is a wire contract rather than a local choice.
 */
import { sha256Hex } from "../hra/cloud";
import type { WirePresenceArgs } from "../data/functions";

export type PresenceIdentity = Readonly<{
  authEpoch: number;
  credentialGeneration: number;
  devicePublicId: string;
  userPublicId: string;
}>;

export type PresenceKind = "connect" | "heartbeat";

export async function presenceFingerprint(input: Readonly<{
  connectionId: string;
  identity: PresenceIdentity;
  kind: PresenceKind;
  sequence: number;
}>): Promise<string> {
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) {
    throw new Error("Cloud presence sequence is exhausted.");
  }
  return await sha256Hex([
    "hra-control-plane-cloud-presence:v1",
    input.identity.userPublicId,
    String(input.identity.authEpoch),
    input.identity.devicePublicId,
    String(input.identity.credentialGeneration),
    input.connectionId,
    input.kind,
    String(input.sequence),
  ].join("\n"));
}

export async function presenceArgs(input: Readonly<{
  connectionId: string;
  identity: PresenceIdentity;
  kind: PresenceKind;
  sequence: number;
}>): Promise<WirePresenceArgs> {
  return {
    connectionId: input.connectionId,
    credentialGeneration: input.identity.credentialGeneration,
    fingerprint: await presenceFingerprint(input),
    sequence: input.sequence,
  };
}

/**
 * A connect is always sequence 0; every heartbeat is exactly one more than the
 * last acknowledged sequence, and a disconnect replays the last acknowledged
 * one. The server rejects any other progression.
 */
export function nextPresenceSequence(acknowledged: number | null): number {
  return acknowledged === null ? 0 : acknowledged + 1;
}

export function newConnectionId(): string {
  return crypto.randomUUID();
}
