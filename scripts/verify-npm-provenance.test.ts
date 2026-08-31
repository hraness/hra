import { describe, expect, test } from "bun:test";

import {
  assertNpmPublishAttestation,
  assertNpmProvenanceBuildIdentity,
  assertNpmProvenanceSubject,
  canonicalAsciiDerUtf8String,
  npmProvenanceSignerPolicy,
  npmRegistryKeySelector,
  selectNpmProvenanceAttestations,
} from "./verify-npm-provenance";

const sha = "a".repeat(40);
const tag = "v0.1.5";

function predicate(
  runId = "123",
  runAttempt = "2",
  options: Readonly<{ commit?: string; invocationSuffix?: string }> = {},
): unknown {
  return {
    buildDefinition: {
      buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
      externalParameters: {
        workflow: {
          path: ".github/workflows/release.yml",
          ref: `refs/tags/${tag}`,
          repository: "https://github.com/hraness/hra",
        },
      },
      internalParameters: {
        github: {
          event_name: "push",
          repository_id: "1343008607",
          repository_owner_id: "307125679",
        },
      },
      resolvedDependencies: [{
        digest: { gitCommit: options.commit ?? sha },
        uri: `git+https://github.com/hraness/hra@refs/tags/${tag}`,
      }],
    },
    runDetails: {
      builder: { id: "https://github.com/actions/runner/github-hosted" },
      metadata: {
        invocationId:
          `https://github.com/hraness/hra/actions/runs/${runId}/attempts/${runAttempt}${options.invocationSuffix ?? ""}`,
      },
    },
  };
}

const identity = {
  runAttempt: "2",
  runId: "123",
  sha,
  tag,
} as const;

describe("npm provenance workflow attempt admission", () => {
  test("requires the current attempt for a first publication", () => {
    expect(assertNpmProvenanceBuildIdentity(predicate(), {
      ...identity,
      attemptPolicy: "exact",
    })).toBe("2");
    expect(() => assertNpmProvenanceBuildIdentity(predicate("123", "1"), {
      ...identity,
      attemptPolicy: "exact",
    })).toThrow("inadmissible workflow attempt");
  });

  test("admits an earlier positive attempt only within the same workflow run", () => {
    expect(assertNpmProvenanceBuildIdentity(predicate("123", "1"), {
      ...identity,
      attemptPolicy: "same_run_not_later",
    })).toBe("1");
    expect(() => assertNpmProvenanceBuildIdentity(predicate("123", "3"), {
      ...identity,
      attemptPolicy: "same_run_not_later",
    })).toThrow("inadmissible workflow attempt");
    expect(() => assertNpmProvenanceBuildIdentity(predicate("3123", "2"), {
      ...identity,
      attemptPolicy: "same_run_not_later",
    })).toThrow("workflow-run identity");
    expect(() => assertNpmProvenanceBuildIdentity(predicate("123", "2"), {
      ...identity,
      attemptPolicy: "same_run_not_later",
      maximumAttempt: "1",
      runAttempt: "3",
    })).toThrow("inadmissible workflow attempt");
  });

  test("keeps the release workflow, ref, commit, and invocation coordinates exact", () => {
    expect(() => assertNpmProvenanceBuildIdentity(predicate("123", "2", {
      commit: "b".repeat(40),
    }), {
      ...identity,
      attemptPolicy: "same_run_not_later",
    })).toThrow("exact release ref and commit");

    expect(() => assertNpmProvenanceBuildIdentity(predicate("123", "2", {
      invocationSuffix: "/jobs/7",
    }), {
      ...identity,
      attemptPolicy: "same_run_not_later",
    })).toThrow("workflow-run identity");

    const wrongOwner = predicate() as {
      buildDefinition: { internalParameters: { github: { repository_owner_id: string } } };
    };
    wrongOwner.buildDefinition.internalParameters.github.repository_owner_id = "1";
    expect(() => assertNpmProvenanceBuildIdentity(wrongOwner, {
      ...identity,
      attemptPolicy: "exact",
    })).toThrow("wrong release workflow identity");
  });
});

describe("npm provenance package subject admission", () => {
  const archiveDigest = Buffer.alloc(64, 0xab);
  const integrity = `sha512-${archiveDigest.toString("base64")}`;
  const exactStatement = {
    subject: [{
      digest: { sha512: archiveDigest.toString("hex") },
      name: "pkg:npm/%40hraness/hra@0.1.5",
    }],
  };

  test("binds the versioned npm PURL to the hex SHA-512 of dist.integrity", () => {
    expect(() => assertNpmProvenanceSubject(exactStatement, { integrity, tag }))
      .not.toThrow();
    expect(() => assertNpmProvenanceSubject({
      subject: [{
        digest: { sha512: archiveDigest.toString("base64") },
        name: "pkg:npm/%40hraness/hra@0.1.5",
      }],
    }, { integrity, tag })).toThrow("exact package bytes");
    expect(() => assertNpmProvenanceSubject({
      subject: [{
        digest: { sha512: archiveDigest.toString("hex") },
        name: "pkg:npm/%40hraness/hra",
      }],
    }, { integrity, tag })).toThrow("exact package bytes");
    expect(() => assertNpmProvenanceSubject(exactStatement, {
      integrity,
      tag: "v0.1.6",
    })).toThrow("exact package bytes");
  });
});

describe("npm provenance attestation-set and signer admission", () => {
  const archiveDigest = Buffer.alloc(64, 0xab);
  const integrity = `sha512-${archiveDigest.toString("base64")}`;
  const bundle = (statement: unknown) => ({
    dsseEnvelope: {
      payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
      payloadType: "application/vnd.in-toto+json",
    },
  });
  const provenance = {
    bundle: bundle({ predicateType: "https://slsa.dev/provenance/v1" }),
    predicateType: "https://slsa.dev/provenance/v1",
    signedAccessSignatureUrl: "",
  };
  const publishStatement = {
    _type: "https://in-toto.io/Statement/v0.1",
    predicate: {
      name: "@hraness/hra",
      registry: "https://registry.npmjs.org",
      version: "0.1.5",
    },
    predicateType: "https://github.com/npm/attestation/tree/main/specs/publish/v0.1",
    subject: [{
      digest: { sha512: archiveDigest.toString("hex") },
      name: "pkg:npm/%40hraness/hra@0.1.5",
    }],
  };
  const publish = {
    bundle: bundle(publishStatement),
    predicateType: "https://github.com/npm/attestation/tree/main/specs/publish/v0.1",
    signedAccessSignatureUrl: "",
  };

  test("selects one SLSA v1 bundle from npm's real two-attestation shape", () => {
    const selected = selectNpmProvenanceAttestations({ attestations: [publish, provenance] });
    expect(selected.provenance.bundle).toBe(provenance.bundle);
    expect(selected.publish?.bundle).toBe(publish.bundle);
    expect(() => assertNpmPublishAttestation(selected.publish!.bundle, { integrity, tag }))
      .not.toThrow();
  });

  test("rejects missing, duplicate, unexpected, and unbounded provenance sets", () => {
    expect(() => selectNpmProvenanceAttestations({ attestations: [publish] }))
      .toThrow("exactly one SLSA");
    expect(() => selectNpmProvenanceAttestations({ attestations: [provenance, provenance] }))
      .toThrow("exactly one SLSA");
    expect(() => selectNpmProvenanceAttestations({
      attestations: [{
        bundle: {},
        predicateType: "https://example.invalid/other",
        signedAccessSignatureUrl: "",
      }],
    })).toThrow("unexpected attestation predicate");
    expect(() => selectNpmProvenanceAttestations({
      attestations: [{ ...provenance, signedAccessSignatureUrl: "https://private.invalid" }],
    })).toThrow("unexpected attestation predicate");
    expect(() => selectNpmProvenanceAttestations({ attestations: [publish, provenance, publish] }))
      .toThrow("bounded expected attestation set");
  });

  test("binds the Fulcio certificate to the exact public workflow run", () => {
    const invocation = "https://github.com/hraness/hra/actions/runs/123/attempts/2";
    const repositorySubject = [
      "repo:hraness",
      "307125679/hra",
      "1343008607:ref:refs/tags/v0.1.5",
    ].join("@");
    const der = canonicalAsciiDerUtf8String;
    const policy = npmProvenanceSignerPolicy(tag, sha, invocation);
    expect(policy.certificateIdentityURI).toBe(
      "^https://github\\.com/hraness/hra/\\.github/workflows/release\\.yml@refs/tags/v0\\.1\\.5$",
    );
    expect(policy.certificateOIDs).toEqual({
      "1.3.6.1.4.1.57264.1.2": "push",
      "1.3.6.1.4.1.57264.1.3": sha,
      "1.3.6.1.4.1.57264.1.5": "hraness/hra",
      "1.3.6.1.4.1.57264.1.6": "refs/tags/v0.1.5",
      "1.3.6.1.4.1.57264.1.11": der("github-hosted"),
      "1.3.6.1.4.1.57264.1.12": der("https://github.com/hraness/hra"),
      "1.3.6.1.4.1.57264.1.13": der(sha),
      "1.3.6.1.4.1.57264.1.14": der("refs/tags/v0.1.5"),
      "1.3.6.1.4.1.57264.1.15": der("1343008607"),
      "1.3.6.1.4.1.57264.1.18": der(
        "https://github.com/hraness/hra/.github/workflows/release.yml@refs/tags/v0.1.5",
      ),
      "1.3.6.1.4.1.57264.1.19": der(sha),
      "1.3.6.1.4.1.57264.1.20": der("push"),
      "1.3.6.1.4.1.57264.1.21": der(invocation),
      "1.3.6.1.4.1.57264.1.22": der("public"),
      "1.3.6.1.4.1.57264.1.24": der(
        repositorySubject,
      ),
    });
    expect(policy.certificateOIDs["1.3.6.1.4.1.57264.1.1"]).toBeUndefined();
    expect(npmProvenanceSignerPolicy(tag, sha,
      "https://github.com/hraness/hra/actions/runs/123/attempts/1").certificateOIDs["1.3.6.1.4.1.57264.1.21"])
      .not.toBe(der(invocation));
    expect(npmProvenanceSignerPolicy(tag, sha,
      "https://github.com/hraness/hra/actions/runs/123/attempts/1").certificateIdentityURI)
      .toBe(policy.certificateIdentityURI);
    expect(() => npmProvenanceSignerPolicy(tag, sha,
      "https://github.com/hraness/other/actions/runs/123/attempts/2")).toThrow();
  });

  test("encodes only bounded canonical ASCII as one short-form DER UTF8String", () => {
    expect(Buffer.from(canonicalAsciiDerUtf8String("public"))).toEqual(
      Buffer.from([0x0c, 0x06, 0x70, 0x75, 0x62, 0x6c, 0x69, 0x63]),
    );
    const boundary = Buffer.from(canonicalAsciiDerUtf8String("a".repeat(127)));
    expect(boundary.subarray(0, 2)).toEqual(Buffer.from([0x0c, 0x7f]));
    expect(boundary.byteLength).toBe(129);
    for (const invalid of ["", "a".repeat(128), "non-ascii-é", "line\nbreak"]) {
      expect(() => canonicalAsciiDerUtf8String(invalid)).toThrow("bounded nonempty canonical ASCII");
    }
  });

  test("admits only bounded canonical npm registry signing keys", () => {
    const primaryKey = {
      expires: null,
      key: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEf/5ebeb9dBZGvx5YfFUJWEEupUUQOnHm5W9R4cR4C4hCZyzhUIIogRvuJaNhTZJQYS4lYREspR1QYNLgJQ==",
      keyid: "SHA256:jl3bwswu80Pjj5ZJnD8B+seCt9U5TxOsS0UjfVWo7UQ",
      keytype: "ecdsa-sha2-nistp256",
      scheme: "ecdsa-sha2-nistp256",
    } as const;
    const liveShape = {
      keys: [
        primaryKey,
        {
          expires: "2027-01-29T00:00:00.000Z",
          key: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAErM/WDadDQZ+f7saNiAr5Oan7t7cl6XNlJbHCaWWtnje4yhlfX7XQDJ5uYjqbpLtNhGN3p4jZWYqQmDLvQw==",
          keyid: "SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U",
          keytype: "ecdsa-sha2-nistp256",
          scheme: "ecdsa-sha2-nistp256",
        },
      ],
    };
    const select = npmRegistryKeySelector(liveShape);
    const keyId = primaryKey.keyid;
    expect(select(keyId)).toContain("BEGIN PUBLIC KEY");
    expect(select("SHA256:unknown")).toBeUndefined();
    expect(() => npmRegistryKeySelector({ keys: [{
      ...primaryKey,
      keyid: `${primaryKey.keyid}=`,
    }] })).toThrow("invalid or duplicated");
  });
});
