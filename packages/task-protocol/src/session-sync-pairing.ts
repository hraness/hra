import { z } from "@hra-internal/schema";

import { digestSyncRequestBody } from "./session-sync-crypto";
import {
  positiveSyncUint64Schema,
  syncDeviceIdSchema,
  syncProofNonceSchema,
  syncSha256DigestSchema,
  syncVaultIdSchema,
  sessionSyncEnrollmentRequestIdSchema,
} from "./session-sync";

export const syncEnrollmentPairingTranscriptSchema = z.object({
  version: z.literal(1),
  vaultId: syncVaultIdSchema,
  vaultGeneration: positiveSyncUint64Schema,
  requestId: sessionSyncEnrollmentRequestIdSchema,
  deviceId: syncDeviceIdSchema,
  candidateNonce: syncProofNonceSchema,
  candidateIntentDigest: syncSha256DigestSchema,
  currentMembershipDigest: syncSha256DigestSchema,
  candidateSigningKeyDigest: syncSha256DigestSchema,
  candidateAgreementKeyDigest: syncSha256DigestSchema,
  expiresAt: positiveSyncUint64Schema,
}).strict();
export type SyncEnrollmentPairingTranscript = z.infer<
  typeof syncEnrollmentPairingTranscriptSchema
>;

export const syncEnrollmentPairingCodeSchema = z.string()
  .regex(/^\d{6}$/u, "invalid sync enrollment pairing code");

export async function deriveSyncEnrollmentPairing(
  transcriptValue: SyncEnrollmentPairingTranscript,
): Promise<Readonly<{
  transcript: SyncEnrollmentPairingTranscript;
  pairingDigest: z.infer<typeof syncSha256DigestSchema>;
  pairingCode: z.infer<typeof syncEnrollmentPairingCodeSchema>;
}>> {
  const transcript = syncEnrollmentPairingTranscriptSchema.parse(transcriptValue);
  const pairingDigest = await digestSyncRequestBody({
    protocol: "oprte.session-sync/v1",
    purpose: "enrollment_pairing_sas",
    transcript,
  });
  const codeValue = Number(BigInt(`0x${pairingDigest.slice("sha256_".length, "sha256_".length + 12)}`)
    % 1_000_000n);
  return {
    transcript,
    pairingDigest,
    pairingCode: syncEnrollmentPairingCodeSchema.parse(codeValue.toString().padStart(6, "0")),
  };
}
