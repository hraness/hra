import { describe, expect, test } from "bun:test";

import { canonicalSha256 } from "@hraness/oh";

import { cloudEnvelopeLimits } from "./cloud-envelope-contract";
import {
  createPortableProjectMemoryCanonicalIdentity,
  deriveProjectMemoryCanonicalIdentity,
  OOMPA_CANONICAL_MEMORY_OPERATION_MAX_BYTES,
  legacyProjectMemorySpaceId,
  PROJECT_MEMORY_DESTINATION_PURPOSE,
} from "./project-memory";

const projectId = "proj_0123456789abcdef0123456789abcdef" as const;

describe("project memory canonical identity", () => {
  test("keeps one encrypted canonical operation inside the hosted envelope", () => {
    const encryptedBytes = OOMPA_CANONICAL_MEMORY_OPERATION_MAX_BYTES + 16;
    const unpaddedBase64UrlCharacters = Math.floor((4 * encryptedBytes + 2) / 3);
    expect(unpaddedBase64UrlCharacters).toBeLessThan(
      cloudEnvelopeLimits.ciphertextCharacters,
    );
    expect(cloudEnvelopeLimits.ciphertextCharacters - unpaddedBase64UrlCharacters)
      .toBeGreaterThan(22_000);
  });

  test("reconstructs the exact legacy project-derived identity", () => {
    const canonicalSpaceId = legacyProjectMemorySpaceId(projectId);
    const identity = deriveProjectMemoryCanonicalIdentity({
      canonicalSpaceId,
      identityContract: 1,
      projectId,
    });

    expect(identity.canonicalRealmId).toBe(
      `oompa:project-memory:${canonicalSpaceId.slice("oompa:project:".length)}`,
    );
    expect(identity.canonicalAuthorityId).toBe(
      `oompa.memory.canonical.${canonicalSpaceId.slice("oompa:project:".length)}`,
    );
    expect(identity.authorityDigest).toBe(canonicalSha256({
      bindingDigest: identity.bindingDigest,
      projectId,
      purpose: PROJECT_MEMORY_DESTINATION_PURPOSE,
      v: 1,
    }));
  });

  test("creates a portable identity independent of the local project id", () => {
    const identity = createPortableProjectMemoryCanonicalIdentity(projectId);
    expect(identity.identityContract).toBe(2);
    expect(identity.canonicalSpaceId).toMatch(/^oompa:project:space-[a-f0-9]{32}$/u);
    expect(identity.authorityDigest).toBe(canonicalSha256({
      bindingDigest: identity.bindingDigest,
      purpose: PROJECT_MEMORY_DESTINATION_PURPOSE,
      spaceId: identity.canonicalSpaceId,
      v: 2,
    }));

    const attachedElsewhere = deriveProjectMemoryCanonicalIdentity({
      canonicalSpaceId: identity.canonicalSpaceId,
      identityContract: 2,
      projectId: "proj_ffffffffffffffffffffffffffffffff",
    });
    expect(attachedElsewhere).toEqual(identity);
  });

  test("rejects mismatched identity contracts and legacy project identities", () => {
    expect(() => deriveProjectMemoryCanonicalIdentity({
      canonicalSpaceId: legacyProjectMemorySpaceId(projectId),
      identityContract: 2,
      projectId,
    })).toThrow("PROJECT_MEMORY_IDENTITY_INVALID");
    expect(() => deriveProjectMemoryCanonicalIdentity({
      canonicalSpaceId: legacyProjectMemorySpaceId(
        "proj_ffffffffffffffffffffffffffffffff",
      ),
      identityContract: 1,
      projectId,
    })).toThrow("PROJECT_MEMORY_IDENTITY_INVALID");
  });
});
