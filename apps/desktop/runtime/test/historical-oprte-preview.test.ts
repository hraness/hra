import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

import {
  assertHistoricalOprteCmsSigningTimeWithinLeaf,
  assertHistoricalOprteBoundarySamples,
  assertHistoricalOprtePreviewInspection,
  classifyHistoricalOprteStrictVerification,
  expectedHistoricalOprtePreviewIdentity,
  expectedHistoricalOprtePreviewSignature,
  expectedHistoricalOprtePreviewTree,
  inspectHistoricalOprteSideband,
  parseHistoricalOprteCertificateChain,
  parseHistoricalOprteCmsSigningTime,
  parseHistoricalOprteMachOSignature,
  parseHistoricalOprteSidebandOutputs,
  verifyHistoricalOprteCmsAndCertificates,
  withHistoricalOprteBoundaryProof,
  type HistoricalOprteBoundaryObservation,
  type HistoricalOprteCapturedCommand,
  type HistoricalOprtePreviewInspection,
  type HistoricalOprteSidebandExpectation,
  type HistoricalOprteSidebandOutputs,
} from "../historical-oprte-preview";

const path = "/Applications/OPRTE.app";
const rootCertificate = `-----BEGIN CERTIFICATE-----
MIICCTCCAa+gAwIBAgIUPGuxlF3KUSwo725XmFb9nI5NO38wCgYIKoZIzj0EAwIw
YTEoMCYGA1UEAwwfT1BSVEUgUHJldmlldyBPZmZsaW5lIFJvb3QgMjAyNjERMA8G
A1UECgwIMHRoZXJuZXQxIjAgBgNVBAsMGVByb3RlY3RlZCBQcmV2aWV3IFJlbGVh
c2UwHhcNMjYwODEwMDMzNzI1WhcNNDYwODA1MDMzNzI1WjBhMSgwJgYDVQQDDB9P
UFJURSBQcmV2aWV3IE9mZmxpbmUgUm9vdCAyMDI2MREwDwYDVQQKDAgwdGhlcm5l
dDEiMCAGA1UECwwZUHJvdGVjdGVkIFByZXZpZXcgUmVsZWFzZTBZMBMGByqGSM49
AgEGCCqGSM49AwEHA0IABFJQp3FiHv51DT9a1CUxdNaWgQiQmKDcxXQwk5tntayF
86tTL5ksTqY5dP/7aMKY6w4ZdsU4W/01TolljqTstJ+jRTBDMBIGA1UdEwEB/wQI
MAYBAf8CAQAwDgYDVR0PAQH/BAQDAgEGMB0GA1UdDgQWBBTIIO8ygG6UHD/SDzYn
Tz4ZXbfDzzAKBggqhkjOPQQDAgNIADBFAiEA4Ltz7wJ2gSdH6yjKLfn+1aG6NABZ
+lPOudBN0zp7jocCIFPEp17qE8wy2/kTGYtpMV4NClt/MspmXgalR82nRcHA
-----END CERTIFICATE-----`;
const leafCertificate = `-----BEGIN CERTIFICATE-----
MIICNjCCAd2gAwIBAgIUTlUixIui/3t76SYIXfm1QK53auUwCgYIKoZIzj0EAwIw
YTEoMCYGA1UEAwwfT1BSVEUgUHJldmlldyBPZmZsaW5lIFJvb3QgMjAyNjERMA8G
A1UECgwIMHRoZXJuZXQxIjAgBgNVBAsMGVByb3RlY3RlZCBQcmV2aWV3IFJlbGVh
c2UwHhcNMjYwODEwMDMzNzI1WhcNMzYwODA3MDMzNzI1WjBcMSMwIQYDVQQDDBpP
UFJURSBQcmV2aWV3IENvZGUgU2lnbmluZzERMA8GA1UECgwIMHRoZXJuZXQxIjAg
BgNVBAsMGVByb3RlY3RlZCBQcmV2aWV3IFJlbGVhc2UwWTATBgcqhkjOPQIBBggq
hkjOPQMBBwNCAASUjCER0uxPyHQay/F38ERPVu/VEZ7Y1byq8Qro2yQ9YG6Ek45G
OQOQ6h4+cyEsvmCs1jJz2Fl9UjUmOOExULfXo3gwdjAMBgNVHRMBAf8EAjAAMA4G
A1UdDwEB/wQEAwIHgDAWBgNVHSUBAf8EDDAKBggrBgEFBQcDAzAdBgNVHQ4EFgQU
f27m0FRv2ZDpfDzKjJ2lQ+Ol90gwHwYDVR0jBBgwFoAUyCDvMoBulBw/0g82J08+
GV23w88wCgYIKoZIzj0EAwIDRwAwRAIgc1aJmT+jGegxtGryA894PH9QXqFW1wdV
ZccGs3jI+xgCICZvgkhWZ7yPH+/k1rfEpXh1MjM6RC6mojfdPWfxHTnw
-----END CERTIFICATE-----`;
const certificateChain = `${rootCertificate}\n${leafCertificate}\n`;

function cmsDescription(
  time = "Aug 10 20:12:58 2026 GMT",
): string {
  return [
    "CMS_ContentInfo:",
    "            object: signingTime (1.2.840.113549.1.9.5)",
    "            value.set:",
    `              UTCTIME:${time}`,
    "",
  ].join("\n");
}

function exactInspection(): HistoricalOprtePreviewInspection {
  return {
    identity: expectedHistoricalOprtePreviewIdentity,
    signature: expectedHistoricalOprtePreviewSignature,
    strictVerification: "exact_historical_trust_failure",
    tree: expectedHistoricalOprtePreviewTree,
  };
}

function captured(
  stdout = "",
  overrides: Partial<HistoricalOprteCapturedCommand> = {},
): HistoricalOprteCapturedCommand {
  return { exitCode: 0, stderr: "", stdout, ...overrides };
}

interface MachOFixture {
  readonly cms: Buffer;
  readonly codeDirectory: Buffer;
  readonly executable: Buffer;
  readonly signatureOffset: number;
}

function signingBlob(magic: number, payload: Buffer): Buffer {
  const result = Buffer.alloc(8 + payload.byteLength);
  result.writeUInt32BE(magic, 0);
  result.writeUInt32BE(result.byteLength, 4);
  payload.copy(result, 8);
  return result;
}

function machoFixture(
  options: Readonly<{ duplicateLoadCommand?: boolean }> = {},
): MachOFixture {
  const cms = Buffer.from("fixture-cms", "utf8");
  const codeDirectory = signingBlob(
    0xfade0c02,
    Buffer.from("fixture-code-directory", "utf8"),
  );
  const cmsWrapper = signingBlob(0xfade0b01, cms);
  const superBlobHeaderLength = 28;
  const codeDirectoryOffset = superBlobHeaderLength;
  const cmsOffset = codeDirectoryOffset + codeDirectory.byteLength;
  const superBlob = Buffer.alloc(cmsOffset + cmsWrapper.byteLength);
  superBlob.writeUInt32BE(0xfade0cc0, 0);
  superBlob.writeUInt32BE(superBlob.byteLength, 4);
  superBlob.writeUInt32BE(2, 8);
  superBlob.writeUInt32BE(0, 12);
  superBlob.writeUInt32BE(codeDirectoryOffset, 16);
  superBlob.writeUInt32BE(0x10000, 20);
  superBlob.writeUInt32BE(cmsOffset, 24);
  codeDirectory.copy(superBlob, codeDirectoryOffset);
  cmsWrapper.copy(superBlob, cmsOffset);

  const loadCommandCount = options.duplicateLoadCommand === true ? 2 : 1;
  const loadCommandBytes = loadCommandCount * 16;
  const signatureOffset = 32 + loadCommandBytes;
  const executable = Buffer.alloc(signatureOffset + superBlob.byteLength);
  executable.writeUInt32LE(0xfeedfacf, 0);
  executable.writeUInt32LE(0x0100000c, 4);
  executable.writeUInt32LE(2, 12);
  executable.writeUInt32LE(loadCommandCount, 16);
  executable.writeUInt32LE(loadCommandBytes, 20);
  for (let index = 0; index < loadCommandCount; index += 1) {
    const offset = 32 + index * 16;
    executable.writeUInt32LE(0x1d, offset);
    executable.writeUInt32LE(16, offset + 4);
    executable.writeUInt32LE(signatureOffset, offset + 8);
    executable.writeUInt32LE(superBlob.byteLength, offset + 12);
  }
  superBlob.copy(executable, signatureOffset);
  return { cms, codeDirectory, executable, signatureOffset };
}

interface SidebandFixture {
  readonly expected: HistoricalOprteSidebandExpectation;
  readonly outputs: HistoricalOprteSidebandOutputs;
}

function sidebandFixture(): SidebandFixture {
  const nodes = ["", "/Contents", "/Contents/link"] as const;
  const name = "com.apple.provenance";
  const value = "010200d21f6a44e8c32756";
  const inventory = nodes.map(node => `${node}: ${name}`).sort(compareUtf8);
  const expected = {
    xattrCount: nodes.length,
    xattrInventorySha256: createHash("sha256")
      .update(`${inventory.join("\n")}\n`, "utf8")
      .digest("hex"),
    xattrName: name,
    xattrValueHex: value,
  };
  return {
    expected,
    outputs: {
      acls: captured(nodes.map(node => `fixture metadata ${path}${node}`).join("\n")),
      flags: captured(nodes.map(() => "-").join("\n")),
      names: captured(nodes.map(node => `${path}${node}: ${name}`).join("\n")),
      values: captured(nodes.map(node =>
        `${path}${node}: \n01 02 00 D2 1F 6A 44 E8 C3 27 56`
      ).join("\n")),
    },
  };
}

function exactBoundary(): HistoricalOprteBoundaryObservation {
  return {
    rootGroup: expectedHistoricalOprtePreviewSignature.rootGroup,
    rootMode: expectedHistoricalOprtePreviewSignature.rootMode,
    rootOwner: expectedHistoricalOprtePreviewSignature.rootOwner,
    xattrCount: expectedHistoricalOprtePreviewSignature.xattrCount,
    xattrInventorySha256:
      expectedHistoricalOprtePreviewSignature.xattrInventorySha256,
    xattrName: expectedHistoricalOprtePreviewSignature.xattrName,
    xattrValueHex: expectedHistoricalOprtePreviewSignature.xattrValueHex,
  };
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

describe("historical OPRTE Preview compatibility evidence", () => {
  test("accepts only the exact frozen identity, tree, signature, and sideband proof", () => {
    expect(assertHistoricalOprtePreviewInspection(exactInspection())).toBe(
      expectedHistoricalOprtePreviewSignature,
    );
    expect(assertHistoricalOprtePreviewInspection({
      ...exactInspection(),
      strictVerification: "strict",
    })).toBe(expectedHistoricalOprtePreviewSignature);
  });

  test("rejects every identity and tree near miss", () => {
    for (const [field, value] of [
      ["build", "6"],
      ["bundleIdentifier", "foreign.bundle"],
      ["executable", "hra"],
      ["version", "0.1.5"],
    ] as const) {
      expect(() => assertHistoricalOprtePreviewInspection({
        ...exactInspection(),
        identity: { ...expectedHistoricalOprtePreviewIdentity, [field]: value },
      })).toThrow("identity evidence differs");
    }
    for (const [field, value] of [
      ["bytes", expectedHistoricalOprtePreviewTree.bytes + 1],
      ["directories", expectedHistoricalOprtePreviewTree.directories + 1],
      ["digest", `0${expectedHistoricalOprtePreviewTree.digest.slice(1)}`],
      ["entries", expectedHistoricalOprtePreviewTree.entries + 1],
      ["files", expectedHistoricalOprtePreviewTree.files + 1],
      ["symlinks", expectedHistoricalOprtePreviewTree.symlinks + 1],
    ] as const) {
      expect(() => assertHistoricalOprtePreviewInspection({
        ...exactInspection(),
        tree: { ...expectedHistoricalOprtePreviewTree, [field]: value },
      })).toThrow("tree evidence differs");
    }
  });

  test("rejects every cryptographic, validity, and sideband near miss", () => {
    const mutations: Readonly<Record<string, unknown>>[] = [
      { codeDirectorySha256: "0".repeat(64) },
      { codeDirectoryCdHash: "0".repeat(40) },
      {
        cmsSigningTimeMs:
          expectedHistoricalOprtePreviewSignature.cmsSigningTimeMs + 1,
      },
      { designatedRequirement: "identifier foreign.bundle" },
      { executableSha256: "0".repeat(64) },
      { infoPlistSha256: "0".repeat(64) },
      { codeResourcesSha256: "0".repeat(64) },
      { leafCertificateSha1: "0".repeat(40) },
      { leafCertificateSha256: "0".repeat(64) },
      { leafNotBeforeMs: expectedHistoricalOprtePreviewSignature.leafNotBeforeMs - 1 },
      { leafNotAfterMs: expectedHistoricalOprtePreviewSignature.leafNotAfterMs + 1 },
      { rootCertificateSha1: "0".repeat(40) },
      { rootCertificateSha256: "0".repeat(64) },
      { rootNotBeforeMs: expectedHistoricalOprtePreviewSignature.rootNotBeforeMs - 1 },
      { rootNotAfterMs: expectedHistoricalOprtePreviewSignature.rootNotAfterMs + 1 },
      { cmsByteLength: 1_864 },
      { codeDirectoryByteLength: 23_441 },
      { rootMode: 0o755 },
      { rootGroup: 0 },
      { rootOwner: "foreign" },
      { xattrCount: 694 },
      { xattrInventorySha256: "0".repeat(64) },
      { xattrName: "com.apple.quarantine" },
      { xattrValueHex: "01020a" },
    ];
    for (const mutation of mutations) {
      expect(() => assertHistoricalOprtePreviewInspection({
        ...exactInspection(),
        signature: {
          ...expectedHistoricalOprtePreviewSignature,
          ...mutation,
        },
      })).toThrow();
    }
  });

  test("classifies only strict success or the exact path-bound trust failure", () => {
    expect(classifyHistoricalOprteStrictVerification(path, captured())).toBe(
      "strict",
    );
    expect(classifyHistoricalOprteStrictVerification(path, captured("", {
      exitCode: 1,
      stderr: `${path}: CSSMERR_TP_NOT_TRUSTED\nIn architecture: arm64\n`,
    }))).toBe("exact_historical_trust_failure");

    for (const result of [
      captured("", { exitCode: 1, stderr: "CSSMERR_TP_NOT_TRUSTED\n" }),
      captured("", {
        exitCode: 1,
        stderr: `${path}: CSSMERR_TP_NOT_TRUSTED\nIn architecture: x86_64\n`,
      }),
      captured("", {
        exitCode: 1,
        stderr: `${path}: CSSMERR_TP_NOT_TRUSTED\nIn architecture: arm64\nextra\n`,
      }),
      captured("", { exitCode: 2 }),
      captured("", { stderr: "warning\n" }),
    ]) {
      expect(() => classifyHistoricalOprteStrictVerification(path, result))
        .toThrow("unrecognized result");
    }
  });
});

describe("historical OPRTE Mach-O and CMS proof", () => {
  test("extracts exactly one CodeDirectory and detached CMS from a thin arm64 fixture", () => {
    const fixture = machoFixture();
    const parsed = parseHistoricalOprteMachOSignature(fixture.executable);
    expect(parsed.codeDirectory).toEqual(fixture.codeDirectory);
    expect(parsed.cms).toEqual(fixture.cms);
  });

  test("rejects malformed, duplicate, overlapping, or substituted signature structures", () => {
    const mutate = (change: (fixture: MachOFixture, value: Buffer) => void): Buffer => {
      const fixture = machoFixture();
      const value = Buffer.from(fixture.executable);
      change(fixture, value);
      return value;
    };
    const malformed = [
      mutate((_fixture, value) => value.writeUInt32LE(0, 0)),
      mutate((_fixture, value) => value.writeUInt32LE(0, 4)),
      mutate((_fixture, value) => value.writeUInt32LE(1, 12)),
      mutate((_fixture, value) => value.writeUInt32LE(12, 36)),
      Buffer.from(machoFixture().executable.subarray(0, -1)),
      mutate((fixture, value) => value.writeUInt32BE(0, fixture.signatureOffset)),
      mutate((fixture, value) => value.writeUInt32BE(
        0,
        fixture.signatureOffset + 20,
      )),
      mutate((fixture, value) => {
        const firstOffset = value.readUInt32BE(fixture.signatureOffset + 16);
        value.writeUInt32BE(firstOffset, fixture.signatureOffset + 24);
      }),
      mutate((fixture, value) => {
        const offset = value.readUInt32BE(fixture.signatureOffset + 16);
        value.writeUInt32BE(0, fixture.signatureOffset + offset);
      }),
      mutate((fixture, value) => {
        const offset = value.readUInt32BE(fixture.signatureOffset + 24);
        value.writeUInt32BE(0, fixture.signatureOffset + offset);
      }),
      machoFixture({ duplicateLoadCommand: true }).executable,
    ];
    for (const executable of malformed) {
      expect(() => parseHistoricalOprteMachOSignature(executable)).toThrow();
    }
  });

  test("verifies the exact detached bytes and parses the exact embedded chain", async () => {
    const parsed = {
      cms: Buffer.from("fixture-cms", "utf8"),
      codeDirectory: Buffer.from("fixture-code-directory", "utf8"),
    };
    const commands: string[][] = [];
    const evidence = await verifyHistoricalOprteCmsAndCertificates(
      parsed,
      async command => {
        commands.push([...command]);
        const input = command.at(command.indexOf("-in") + 1);
        expect(input).toBeString();
        expect(await readFile(input!)).toEqual(parsed.cms);
        if (command.includes("-verify")) {
          const content = command.at(command.indexOf("-content") + 1);
          expect(content).toBeString();
          expect(await readFile(content!)).toEqual(parsed.codeDirectory);
          return captured("Verification successful\n");
        }
        if (command.includes("-cmsout")) return captured(cmsDescription());
        const output = command.at(command.indexOf("-out") + 1);
        expect(output).toBeString();
        await writeFile(output!, certificateChain, "utf8");
        return captured();
      },
    );
    expect(commands.map(command => command[1])).toEqual([
      "cms",
      "cms",
      "pkcs7",
    ]);
    expect(evidence).toEqual({
      leafCertificateSha1:
        expectedHistoricalOprtePreviewSignature.leafCertificateSha1,
      leafCertificateSha256:
        expectedHistoricalOprtePreviewSignature.leafCertificateSha256,
      leafNotAfterMs: expectedHistoricalOprtePreviewSignature.leafNotAfterMs,
      leafNotBeforeMs: expectedHistoricalOprtePreviewSignature.leafNotBeforeMs,
      rootCertificateSha1:
        expectedHistoricalOprtePreviewSignature.rootCertificateSha1,
      rootCertificateSha256:
        expectedHistoricalOprtePreviewSignature.rootCertificateSha256,
      rootNotAfterMs: expectedHistoricalOprtePreviewSignature.rootNotAfterMs,
      rootNotBeforeMs: expectedHistoricalOprtePreviewSignature.rootNotBeforeMs,
      cmsSigningTimeMs:
        expectedHistoricalOprtePreviewSignature.cmsSigningTimeMs,
    });
  });

  test("fails closed when CMS verification, attribute parsing, or extraction fails", () => {
    const parsed = {
      cms: Buffer.from("fixture-cms", "utf8"),
      codeDirectory: Buffer.from("fixture-code-directory", "utf8"),
    };
    expect(verifyHistoricalOprteCmsAndCertificates(
      parsed,
      () => Promise.resolve(captured("", { exitCode: 1, stderr: "invalid" })),
    )).rejects.toThrow("CMS signature is invalid");
    expect(verifyHistoricalOprteCmsAndCertificates(
      parsed,
      command => Promise.resolve(command.includes("-verify")
        ? captured("Verification successful\n")
        : captured("", { exitCode: 1, stderr: "invalid" })),
    )).rejects.toThrow("CMS attributes are unavailable");
    expect(verifyHistoricalOprteCmsAndCertificates(
      parsed,
      command => Promise.resolve(command.includes("-verify")
        ? captured("Verification successful\n")
        : command.includes("-cmsout")
          ? captured(cmsDescription())
          : captured("", { exitCode: 1, stderr: "invalid" })),
    )).rejects.toThrow("CMS certificates are unavailable");
  });

  test("parses one signed CMS time and binds it to leaf validity", () => {
    const certificates = parseHistoricalOprteCertificateChain(certificateChain);
    const signingTime = parseHistoricalOprteCmsSigningTime(cmsDescription());
    expect(signingTime).toBe(
      expectedHistoricalOprtePreviewSignature.cmsSigningTimeMs,
    );
    expect(() => assertHistoricalOprteCmsSigningTimeWithinLeaf(
      certificates.leafNotBeforeMs,
      certificates,
    )).not.toThrow();
    expect(() => assertHistoricalOprteCmsSigningTimeWithinLeaf(
      certificates.leafNotAfterMs,
      certificates,
    )).not.toThrow();
    for (const invalid of [
      certificates.leafNotBeforeMs - 1,
      certificates.leafNotAfterMs + 1,
    ]) {
      expect(() => assertHistoricalOprteCmsSigningTimeWithinLeaf(
        invalid,
        certificates,
      )).toThrow("outside leaf certificate validity");
    }
    for (const output of [
      "",
      cmsDescription().replace("signingTime", "foreignTime"),
      cmsDescription().replace("UTCTIME:", "GENERALIZEDTIME:"),
      `${cmsDescription()}${cmsDescription()}`,
    ]) {
      expect(() => parseHistoricalOprteCmsSigningTime(output)).toThrow();
    }
  });

  test("accepts either chain order but rejects missing, extra, or foreign certificates", () => {
    for (const pem of [
      certificateChain,
      `${leafCertificate}\n${rootCertificate}\n`,
    ]) {
      expect(parseHistoricalOprteCertificateChain(pem)).toMatchObject({
        leafNotAfterMs: expectedHistoricalOprtePreviewSignature.leafNotAfterMs,
        leafNotBeforeMs: expectedHistoricalOprtePreviewSignature.leafNotBeforeMs,
        rootNotAfterMs: expectedHistoricalOprtePreviewSignature.rootNotAfterMs,
        rootNotBeforeMs: expectedHistoricalOprtePreviewSignature.rootNotBeforeMs,
      });
    }
    for (const pem of [
      rootCertificate,
      `${rootCertificate}\n${rootCertificate}\n`,
      `${certificateChain}${rootCertificate}\n`,
    ]) {
      expect(() => parseHistoricalOprteCertificateChain(pem)).toThrow();
    }
  });
});

describe("historical OPRTE sideband proof", () => {
  test("double-samples the complete boundary around the supplied proof", async () => {
    const sequence: string[] = [];
    const result = await withHistoricalOprteBoundaryProof(
      path,
      () => {
        sequence.push("proof");
        return Promise.resolve("verified");
      },
      () => {
        sequence.push("boundary");
        return Promise.resolve(exactBoundary());
      },
    );
    expect(result).toBe("verified");
    expect(sequence).toEqual(["boundary", "proof", "boundary"]);
  });

  test("rejects any root or sideband mutation between boundary samples", async () => {
    const mutations: Readonly<Record<string, unknown>>[] = [
      { rootGroup: 0 },
      { rootMode: 0o755 },
      { rootOwner: "foreign" },
      { xattrCount: expectedHistoricalOprtePreviewSignature.xattrCount - 1 },
      { xattrInventorySha256: "0".repeat(64) },
      { xattrName: "com.apple.quarantine" },
      { xattrValueHex: "01020a" },
    ];
    for (const mutation of mutations) {
      let sample = 0;
      let failure: unknown;
      try {
        await withHistoricalOprteBoundaryProof(
          path,
          () => Promise.resolve("verified"),
          () => Promise.resolve(sample++ === 0
            ? exactBoundary()
            : { ...exactBoundary(), ...mutation }),
        );
      } catch (error: unknown) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("boundary after");
    }
  });

  test("rejects a non-exact first boundary before executing the proof", async () => {
    let proofRan = false;
    let failure: unknown;
    try {
      await withHistoricalOprteBoundaryProof(
        path,
        () => {
          proofRan = true;
          return Promise.resolve("verified");
        },
        () => Promise.resolve({ ...exactBoundary(), rootMode: 0o755 }),
      );
    } catch (error: unknown) {
      failure = error;
    }
    expect(proofRan).toBeFalse();
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("boundary before");
  });

  test("pure boundary comparison rejects mismatched samples", () => {
    expect(() => assertHistoricalOprteBoundarySamples(
      exactBoundary(),
      { ...exactBoundary(), rootMode: 0o755 },
    )).toThrow("boundary after");
  });

  test("accepts the exact node-local xattr inventory, values, flags, and ACL absence", () => {
    const fixture = sidebandFixture();
    expect(parseHistoricalOprteSidebandOutputs(
      path,
      fixture.outputs,
      fixture.expected,
    )).toEqual(fixture.expected);
  });

  test("uses no-follow xattr inspection for every node-local attribute", async () => {
    const fixture = sidebandFixture();
    const commands: string[][] = [];
    const result = await inspectHistoricalOprteSideband(
      path,
      command => {
        commands.push([...command]);
        if (command[0] === "/usr/bin/xattr") {
          return Promise.resolve(command.includes("-p")
            ? fixture.outputs.values
            : fixture.outputs.names);
        }
        return Promise.resolve(command.includes("%Sf")
          ? fixture.outputs.flags
          : fixture.outputs.acls);
      },
      fixture.expected,
    );
    expect(result).toEqual(fixture.expected);
    expect(commands).toHaveLength(4);
    for (const command of commands.filter(value =>
      value[0] === "/usr/bin/xattr"
    )) expect(command).toContain("-s");
  });

  test("rejects wrong, extra, missing, escaped, or command-failed xattrs", () => {
    const fixture = sidebandFixture();
    const mutations: HistoricalOprteSidebandOutputs[] = [
      {
        ...fixture.outputs,
        names: captured(fixture.outputs.names.stdout.replace(
          "com.apple.provenance",
          "com.apple.ResourceFork",
        )),
      },
      {
        ...fixture.outputs,
        names: captured(`${fixture.outputs.names.stdout}\n${path}: com.apple.quarantine`),
      },
      {
        ...fixture.outputs,
        names: captured(fixture.outputs.names.stdout.replace(
          `${path}/Contents/link: com.apple.provenance`,
          "",
        )),
      },
      {
        ...fixture.outputs,
        names: captured(fixture.outputs.names.stdout.replace(
          path,
          "/foreign/OPRTE.app",
        )),
      },
      {
        ...fixture.outputs,
        names: captured("", { exitCode: 1, stderr: "failed" }),
      },
      {
        ...fixture.outputs,
        values: captured(fixture.outputs.values.stdout.replace(
          "01 02 00 D2 1F 6A 44 E8 C3 27 56",
          "01 02 00 D2 1F 6A 44 E8 C3 27 57",
        )),
      },
      {
        ...fixture.outputs,
        values: captured(fixture.outputs.values.stdout.replace(
          `${path}/Contents/link: \n01 02 00 D2 1F 6A 44 E8 C3 27 56`,
          "",
        )),
      },
      {
        ...fixture.outputs,
        values: captured("", { exitCode: 1, stderr: "failed" }),
      },
    ];
    for (const outputs of mutations) {
      expect(() => parseHistoricalOprteSidebandOutputs(
        path,
        outputs,
        fixture.expected,
      )).toThrow();
    }
  });

  test("rejects any ACL, file flag, ResourceFork, FinderInfo, or quarantine evidence", () => {
    const fixture = sidebandFixture();
    const mutations: HistoricalOprteSidebandOutputs[] = [
      {
        ...fixture.outputs,
        acls: captured(`${fixture.outputs.acls.stdout}\n 0: group:everyone deny delete`),
      },
      {
        ...fixture.outputs,
        acls: captured("", { exitCode: 1, stderr: "failed" }),
      },
      {
        ...fixture.outputs,
        flags: captured(fixture.outputs.flags.stdout.replace("-", "uchg")),
      },
      {
        ...fixture.outputs,
        flags: captured("", { exitCode: 1, stderr: "failed" }),
      },
      ...["com.apple.ResourceFork", "com.apple.FinderInfo", "com.apple.quarantine"]
        .map(name => ({
          ...fixture.outputs,
          names: captured(fixture.outputs.names.stdout.replace(
            "com.apple.provenance",
            name,
          )),
        })),
    ];
    for (const outputs of mutations) {
      expect(() => parseHistoricalOprteSidebandOutputs(
        path,
        outputs,
        fixture.expected,
      )).toThrow();
    }
  });
});
