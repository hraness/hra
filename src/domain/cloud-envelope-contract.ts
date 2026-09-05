/** Browser-safe size contract shared by clients and the hosted validator. */

const aesGcmTagBytes = 16;
const maximumCiphertextCharacters = 350_000;

export const cloudEnvelopeLimits = Object.freeze({
  ciphertextCharacters: maximumCiphertextCharacters,
  plaintextBytes: Math.floor(maximumCiphertextCharacters * 3 / 4) - aesGcmTagBytes,
} as const);

const utf8Encoder = new TextEncoder();

/** Whether AES-GCM plus unpadded base64url fits the hosted ciphertext bound. */
export function jsonValueFitsCloudEnvelope(value: unknown): boolean {
  try {
    const serialized: unknown = JSON.stringify(value);
    return typeof serialized === "string"
      && utf8Encoder.encode(serialized).byteLength <= cloudEnvelopeLimits.plaintextBytes;
  } catch {
    return false;
  }
}
