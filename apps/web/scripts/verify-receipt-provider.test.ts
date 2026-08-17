import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { createSuiteReceiptProviderProof } from "../suite-account-receipts";

import {
  hraOnlyReceiptKeyringFromSecret,
  parseReceiptProviderVerification,
  readReceiptCandidateSecret,
  verifyReceiptProvider,
  type ReceiptProviderVerificationLauncher,
} from "./verify-receipt-provider";

const temporaryDirectories: string[] = [];
const secret = Buffer.alloc(32, 0x68).toString("base64url");
const ready = {
  candidateSecretMatch: true,
  hraProductionV1Count: 1,
  keyCount: 1,
  otherKeyCount: 0,
  selectorV1: true,
  status: "ready",
} as const;

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

function candidate(mode = 0o600, value = secret): string {
  const directory = mkdtempSync(join(tmpdir(), "hra-receipt-candidate-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "receipt-secret");
  writeFileSync(path, value, { encoding: "utf8", mode });
  chmodSync(path, mode);
  return realpathSync.native(path);
}

function stream(value: string): ReadableStream<Uint8Array> {
  return new Blob([value]).stream();
}

describe("receipt candidate custody", () => {
  test("reads one mode-0600 canonical secret and derives an HRA-only keyring", () => {
    expect(readReceiptCandidateSecret(candidate())).toBe(secret);
    expect(JSON.parse(hraOnlyReceiptKeyringFromSecret(secret))).toEqual({
      keys: [{
        environment: "production",
        keyVersion: "v1",
        product: "hra",
        secret,
      }],
      version: 1,
    });
  });

  test("rejects relaxed custody, newlines, aliases, and malformed secrets", () => {
    expect(() => readReceiptCandidateSecret(candidate(0o644)))
      .toThrow("receipt-candidate-custody-invalid");
    expect(() => readReceiptCandidateSecret(candidate(0o600, `${secret}\n`)))
      .toThrow("receipt-candidate-secret-invalid");
    expect(() => readReceiptCandidateSecret(candidate(0o600, "h".repeat(43))))
      .toThrow("receipt-candidate-secret-invalid");
  });
});

describe("receipt provider equality", () => {
  test("accepts only exact count/status/match output", () => {
    expect(parseReceiptProviderVerification(ready)).toEqual(ready);
    for (const changed of [
      { ...ready, candidateSecretMatch: false },
      { ...ready, keyCount: 2 },
      { ...ready, extra: "field" },
    ]) {
      expect(() => parseReceiptProviderVerification(changed))
        .toThrow("receipt-provider-verification-failed");
    }
  });

  test("sends only a fresh challenge and returns only match/count status", async () => {
    const challenge = Buffer.alloc(32, 0x63).toString("base64url");
    const candidateProof = await createSuiteReceiptProviderProof(
      secret,
      challenge,
    );
    if (candidateProof === null) throw new Error("Expected candidate proof.");
    const providerResponse = {
      candidateProof,
      hraProductionV1Count: 1,
      keyCount: 1,
      otherKeyCount: 0,
      selectorV1: true,
      status: "ready",
    } as const;
    const calls: Array<readonly string[]> = [];
    const launch: ReceiptProviderVerificationLauncher = (command) => {
      calls.push(command);
      return {
        exited: Promise.resolve(0),
        stderr: stream(""),
        stdout: stream(JSON.stringify(providerResponse)),
      };
    };
    const result = await verifyReceiptProvider({
      createChallenge: () => challenge,
      environment: {
        CONVEX_PROVIDER_AUTHORITY: "prod:benevolent-akita-439|hidden",
      },
      launch,
      secretFile: candidate(),
    });
    expect(result).toEqual(ready);
    const argv = calls[0]?.join(" ") ?? "";
    const stableDigest = createHash("sha256").update(secret).digest("hex");
    expect(argv).toContain("suiteIdentityAudit:audit");
    expect(argv).toContain("--deployment benevolent-akita-439");
    expect(argv).toContain(challenge);
    expect(argv).not.toContain(secret);
    expect(argv).not.toContain(stableDigest);
    expect(argv).not.toContain("hidden");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(stableDigest);
    expect(JSON.stringify(result)).not.toContain(candidateProof);
    expect(JSON.stringify(providerResponse)).not.toContain(stableDigest);
  });

  test("rejects a proof made by a different candidate secret", async () => {
    const challenge = Buffer.alloc(32, 0x63).toString("base64url");
    const otherSecret = Buffer.alloc(32, 0x6f).toString("base64url");
    const candidateProof = await createSuiteReceiptProviderProof(
      otherSecret,
      challenge,
    );
    if (candidateProof === null) throw new Error("Expected candidate proof.");
    const launch: ReceiptProviderVerificationLauncher = () => ({
      exited: Promise.resolve(0),
      stderr: stream(""),
      stdout: stream(JSON.stringify({
        candidateProof,
        hraProductionV1Count: 1,
        keyCount: 1,
        otherKeyCount: 0,
        selectorV1: true,
        status: "ready",
      })),
    });
    expect(verifyReceiptProvider({
      createChallenge: () => challenge,
      launch,
      secretFile: candidate(),
    })).rejects.toThrow("receipt-provider-verification-failed");
  });
});
