import { createHash, randomBytes } from "node:crypto";

import { canonicalSha256 } from "@hraness/oh";
import {
  createOhStoreBindingV1,
  emptyOhHeadV1,
  OH_CANONICAL_STORE_PROFILE_V1,
  type OhHeadV1,
} from "@hraness/oh/store";
import { z } from "zod";

import { projectIdSchema, type ProjectId } from "./values";

export { OOMPA_CANONICAL_MEMORY_OPERATION_MAX_BYTES } from "./canonical-memory-sync";

export const PROJECT_MEMORY_DESTINATION_PURPOSE = "oompa.project.canonical";
export const projectMemoryIdentityContractSchema = z.union([
  z.literal(1),
  z.literal(2),
]);
export type ProjectMemoryIdentityContract = z.infer<
  typeof projectMemoryIdentityContractSchema
>;

const legacyCanonicalSpaceIdSchema = z.string().regex(/^oompa:project:[a-f0-9]{64}$/u);
const portableCanonicalSpaceIdSchema = z.string().regex(
  /^oompa:project:space-[a-f0-9]{32}$/u,
);

export const projectMemoryCanonicalSpaceIdSchema = z.union([
  legacyCanonicalSpaceIdSchema,
  portableCanonicalSpaceIdSchema,
]);

export type ProjectMemoryCanonicalIdentity = Readonly<{
  identityContract: ProjectMemoryIdentityContract;
  canonicalSpaceId: string;
  canonicalRealmId: string;
  canonicalAuthorityId: string;
  bindingDigest: string;
  authorityDigest: string;
}>;

const digestParts = (domain: string, parts: readonly string[]): string => {
  const digest = createHash("sha256");
  digest.update(domain);
  for (const part of parts) {
    digest.update("\0");
    digest.update(part);
  }
  return digest.digest("hex");
};

export const digestProjectMemoryOhHead = (head: OhHeadV1): string =>
  digestParts("hra-oh-head-v1", [
    String(head.generation),
    head.graphRevisionSha256 ?? "empty",
    head.operationSha256 ?? "empty",
    head.recordsSha256,
    String(head.sequence),
    String(head.v),
  ]);

const emptyOhHead = emptyOhHeadV1();
export const PROJECT_MEMORY_EMPTY_HEAD = Object.freeze({
  headDigest: digestProjectMemoryOhHead(emptyOhHead),
  operationSha256: emptyOhHead.operationSha256,
  sequence: emptyOhHead.sequence,
});

export const legacyProjectMemorySpaceId = (projectId: ProjectId): string =>
  `oompa:project:${canonicalSha256({ projectId: projectIdSchema.parse(projectId), v: 1 })}`;

export const createPortableProjectMemorySpaceId = (): string =>
  `oompa:project:space-${randomBytes(16).toString("hex")}`;

export const deriveProjectMemoryCanonicalIdentity = (input: Readonly<{
  projectId: ProjectId;
  identityContract: ProjectMemoryIdentityContract;
  canonicalSpaceId: string;
}>): ProjectMemoryCanonicalIdentity => {
  const projectId = projectIdSchema.parse(input.projectId);
  const identityContract = projectMemoryIdentityContractSchema.parse(input.identityContract);
  const canonicalSpaceId = projectMemoryCanonicalSpaceIdSchema.parse(input.canonicalSpaceId);
  if (
    (identityContract === 1 && canonicalSpaceId !== legacyProjectMemorySpaceId(projectId))
    || (identityContract === 2 && !portableCanonicalSpaceIdSchema.safeParse(canonicalSpaceId).success)
  ) throw new Error("PROJECT_MEMORY_IDENTITY_INVALID");

  const identitySuffix = canonicalSpaceId.slice("oompa:project:".length);
  const canonicalRealmId = `oompa:project-memory:${identitySuffix}`;
  const canonicalAuthorityId = `oompa.memory.canonical.${identitySuffix}`;
  const binding = createOhStoreBindingV1({
    profile: OH_CANONICAL_STORE_PROFILE_V1,
    realmId: canonicalRealmId,
    spaceId: canonicalSpaceId,
    v: 1,
  });
  const authorityDigest = identityContract === 1
    ? canonicalSha256({
        bindingDigest: binding.bindingSha256,
        projectId,
        purpose: PROJECT_MEMORY_DESTINATION_PURPOSE,
        v: 1,
      })
    : canonicalSha256({
        bindingDigest: binding.bindingSha256,
        purpose: PROJECT_MEMORY_DESTINATION_PURPOSE,
        spaceId: canonicalSpaceId,
        v: 2,
      });
  return Object.freeze({
    authorityDigest,
    bindingDigest: binding.bindingSha256,
    canonicalAuthorityId,
    canonicalRealmId,
    canonicalSpaceId,
    identityContract,
  });
};

export const createPortableProjectMemoryCanonicalIdentity = (
  projectId: ProjectId,
): ProjectMemoryCanonicalIdentity => deriveProjectMemoryCanonicalIdentity({
  canonicalSpaceId: createPortableProjectMemorySpaceId(),
  identityContract: 2,
  projectId,
});
