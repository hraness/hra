/**
 * The device key fingerprint an operator compares before approving a browser
 * device from a machine that has hra installed.
 *
 * Definition (shared with the daemon-side `deviceKeyFingerprint` landing in the
 * browser-devices package): SHA-256 over
 *
 *   canonicalDevicePublicKeyJson(signing) + "\n" + canonicalDevicePublicKeyJson(wrapping)
 *
 * then the first 32 hex characters written as 8 hyphen-separated groups of 4.
 * Both inputs are re-canonicalized here, so a caller may pass either the exact
 * output of `exportDevicePublicKey` or any equivalent JSON encoding and get the
 * same fingerprint.
 */
import {
  canonicalDevicePublicKeyJson,
  parseDevicePublicKeyJson,
  sha256Hex,
} from "../hra/cloud";

export const fingerprintGroupCount = 8;
export const fingerprintGroupSize = 4;
export const fingerprintHexCharacters = fingerprintGroupCount * fingerprintGroupSize;

export function groupFingerprintDigest(digest: string): string {
  const head = digest.slice(0, fingerprintHexCharacters);
  if (head.length !== fingerprintHexCharacters || !/^[0-9a-f]+$/u.test(head)) {
    throw new Error("Device key fingerprint digest is invalid.");
  }
  const groups: string[] = [];
  for (let index = 0; index < fingerprintHexCharacters; index += fingerprintGroupSize) {
    groups.push(head.slice(index, index + fingerprintGroupSize));
  }
  return groups.join("-");
}

function canonical(publicKeyJson: string, role: "signing" | "wrapping"): string {
  const parsed = parseDevicePublicKeyJson(publicKeyJson);
  if (parsed === null) throw new Error(`Device ${role} public key is invalid.`);
  return canonicalDevicePublicKeyJson(parsed);
}

export async function deviceKeyFingerprint(
  signingPublicKey: string,
  wrappingPublicKey: string,
): Promise<string> {
  const material = `${canonical(signingPublicKey, "signing")}\n${canonical(wrappingPublicKey, "wrapping")}`;
  return groupFingerprintDigest(await sha256Hex(material));
}
