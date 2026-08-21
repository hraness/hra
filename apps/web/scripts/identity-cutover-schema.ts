import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const schemaPath = join(import.meta.dir, "..", "convex", "schema.ts");
const backupPath = join(
  import.meta.dir,
  "..",
  ".convex",
  "identity-cutover-final-schema.ts",
);

const strictOrganizations = `  organizations: defineTable({
    publicId: v.string(),
    name: v.string(),
    status: v.union(v.literal("active"), v.literal("disabled")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_public_id", ["publicId"]),`;

const compatibilityOrganizations = `  organizations: defineTable({
    publicId: v.string(),
    workosOrganizationId: v.optional(v.string()),
    workosExternalId: v.optional(v.string()),
    name: v.string(),
    status: v.union(
      v.literal("provisioning"),
      v.literal("active"),
      v.literal("failed"),
      v.literal("disabled"),
    ),
    failureCode: v.optional(v.string()),
    workosUpdatedAt: v.optional(v.number()),
    workosObservedAt: v.optional(v.number()),
    workosHardDeletedAt: v.optional(v.number()),
    workosQuarantinedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_public_id", ["publicId"])
    .index("by_workos_organization_id", ["workosOrganizationId"])
    .index("by_workos_external_id", ["workosExternalId"]),`;

const strictUsers = `  users: defineTable({
    publicId: v.string(),
    name: v.string(),
    image: v.optional(v.string()),
    email: v.optional(v.string()),
    emailVerificationTime: v.optional(v.number()),
    phone: v.optional(v.string()),
    phoneVerificationTime: v.optional(v.number()),
    isAnonymous: v.optional(v.boolean()),
    status: v.union(v.literal("active"), v.literal("disabled")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("email", ["email"])
    .index("phone", ["phone"])
    .index("by_public_id", ["publicId"]),`;

const compatibilityUsers = `  users: defineTable({
    publicId: v.string(),
    workosUserId: v.optional(v.string()),
    name: v.string(),
    image: v.optional(v.string()),
    email: v.optional(v.string()),
    emailVerificationTime: v.optional(v.number()),
    phone: v.optional(v.string()),
    phoneVerificationTime: v.optional(v.number()),
    isAnonymous: v.optional(v.boolean()),
    status: v.union(v.literal("active"), v.literal("disabled")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("email", ["email"])
    .index("phone", ["phone"])
    .index("by_public_id", ["publicId"])
    .index("by_workos_user_id", ["workosUserId"]),`;

const strictMemberships = `  organizationMemberships: defineTable({
    organizationId: v.id("organizations"),
    userId: v.id("users"),
    role: v.union(v.literal("owner"), v.literal("admin"), v.literal("member")),
    status: v.union(
      v.literal("active"),
      v.literal("inactive"),
      v.literal("pending"),
      v.literal("removed"),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organization_and_user", ["organizationId", "userId"])
    .index("by_organization_status_and_user", ["organizationId", "status", "userId"])
    .index("by_user_and_organization", ["userId", "organizationId"]),`;

const compatibilityMemberships = `  organizationMemberships: defineTable({
    organizationId: v.id("organizations"),
    userId: v.id("users"),
    workosMembershipId: v.optional(v.string()),
    workosRoleSlugs: v.optional(v.array(v.string())),
    role: v.union(v.literal("owner"), v.literal("admin"), v.literal("member")),
    status: v.union(
      v.literal("active"),
      v.literal("inactive"),
      v.literal("pending"),
      v.literal("removed"),
    ),
    workosUpdatedAt: v.optional(v.number()),
    workosObservedAt: v.optional(v.number()),
    workosHardDeletedAt: v.optional(v.number()),
    workosHardDeletedMembershipId: v.optional(v.string()),
    workosQuarantinedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organization_and_user", ["organizationId", "userId"])
    .index("by_organization_status_and_user", ["organizationId", "status", "userId"])
    .index("by_user_and_organization", ["userId", "organizationId"])
    .index("by_workos_membership_id", ["workosMembershipId"]),

  workosMembershipRetirements: defineTable({
    workosMembershipId: v.string(),
    organizationId: v.id("organizations"),
    userId: v.id("users"),
    replacementWorkosMembershipId: v.string(),
    hardDeletedAt: v.optional(v.number()),
    retiredAt: v.number(),
  }).index("by_workos_membership_id", ["workosMembershipId"]),`;

const compatibilityProjectionTables = `  identityWebhookReceipts: defineTable({
    providerEventId: v.string(),
    eventType: v.string(),
    payloadDigest: v.bytes(),
    eventCreatedAt: v.number(),
    resourceKind: v.union(
      v.literal("organization"),
      v.literal("organization_membership"),
      v.literal("ignored"),
    ),
    resourceId: v.string(),
    result: v.union(v.literal("applied"), v.literal("stale"), v.literal("ignored")),
    createdAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_provider_event_id", ["providerEventId"])
    .index("by_expiry", ["expiresAt"]),

  identityReconciliationState: defineTable({
    key: v.union(v.literal("workos_memberships"), v.literal("workos_organizations")),
    version: v.optional(v.number()),
    runId: v.optional(v.string()),
    leaseUntil: v.optional(v.number()),
    cursor: v.optional(v.string()),
    providerOrganizationId: v.optional(v.string()),
    providerCursor: v.optional(v.string()),
    lastStartedAt: v.optional(v.number()),
    lastCompletedAt: v.optional(v.number()),
    lastErrorAt: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  identityReconciliationQuarantines: defineTable({
    resourceKey: v.string(),
    resourceKind: v.union(v.literal("organization"), v.literal("organization_membership")),
    resourceId: v.string(),
    reason: v.union(
      v.literal("provider_locator_mismatch"),
      v.literal("invalid_provider_record"),
      v.literal("projection_collision"),
    ),
    occurrences: v.number(),
    firstSeenAt: v.number(),
    lastSeenAt: v.number(),
    resolvedAt: v.optional(v.number()),
  })
    .index("by_resource_key", ["resourceKey"])
    .index("by_last_seen", ["lastSeenAt"]),

`;

const compatibilityProvisioningTable = `  accountProvisioningOperations: defineTable({
    userId: v.id("users"),
    principalId: v.string(),
    organizationId: v.id("organizations"),
    externalId: v.string(),
    name: v.string(),
    idempotencyKey: v.string(),
    requestDigest: v.union(v.bytes(), v.string()),
    requestId: v.string(),
    status: v.union(
      v.literal("reserved"),
      v.literal("provider_organization_ready"),
      v.literal("provider_membership_ready"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    workosOrganizationId: v.optional(v.string()),
    workosMembershipId: v.optional(v.string()),
    membershipProvisioningLeaseId: v.optional(v.string()),
    membershipProvisioningLeaseUntil: v.optional(v.number()),
    membershipCreateDispatchedAt: v.optional(v.number()),
    membershipCreateDispatchLeaseId: v.optional(v.string()),
    failureCode: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_principal_and_key", ["principalId", "idempotencyKey"])
    .index("by_external_id", ["externalId"]),

`;

const strictPromotionActorFields = `    startedByUserId: v.id("users"),
    startedByUserPublicId: v.string(),`;

const compatibilityPromotionActorFields = `    startedByUserId: v.id("users"),
    startedByWorkosUserId: v.optional(v.string()),
    startedByUserPublicId: v.optional(v.string()),`;

function replaceExact(source: string, from: string, to: string, label: string): string {
  const first = source.indexOf(from);
  if (first < 0 || source.indexOf(from, first + from.length) >= 0) {
    throw new Error(`Identity cutover expected one exact ${label} schema block.`);
  }
  return `${source.slice(0, first)}${to}${source.slice(first + from.length)}`;
}

export function renderIdentityCutoverCompatibilitySchema(source: string): string {
  let result = replaceExact(
    source,
    strictOrganizations,
    compatibilityOrganizations,
    "organization",
  );
  result = replaceExact(result, strictUsers, compatibilityUsers, "user");
  result = replaceExact(
    result,
    strictMemberships,
    compatibilityMemberships,
    "organization membership",
  );
  result = replaceExact(
    result,
    "  apiRateLimitBuckets: defineTable({",
    `${compatibilityProjectionTables}  apiRateLimitBuckets: defineTable({`,
    "rate-limit insertion marker",
  );
  result = replaceExact(
    result,
    "  workspaceProjectionHeads: defineTable({",
    `${compatibilityProvisioningTable}  workspaceProjectionHeads: defineTable({`,
    "workspace projection insertion marker",
  );
  return replaceExact(
    result,
    strictPromotionActorFields,
    compatibilityPromotionActorFields,
    "promotion session actor",
  );
}

async function optionalRead(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (
      typeof error === "object" && error !== null && "code" in error &&
      error.code === "ENOENT"
    ) return null;
    throw error;
  }
}

async function prepare(): Promise<void> {
  if (await optionalRead(backupPath) !== null) {
    throw new Error("Identity cutover backup already exists; restore or inspect it first.");
  }
  const strict = await readFile(schemaPath, "utf8");
  const compatibility = renderIdentityCutoverCompatibilitySchema(strict);
  await mkdir(dirname(backupPath), { recursive: true });
  await writeFile(backupPath, strict, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await writeFile(schemaPath, compatibility, "utf8");
  console.log("prepared compatibility schema; final schema is in ignored mode-0600 custody");
}

async function restore(): Promise<void> {
  const strict = await optionalRead(backupPath);
  if (strict === null) throw new Error("Identity cutover backup is missing.");
  const current = await readFile(schemaPath, "utf8");
  if (current !== renderIdentityCutoverCompatibilitySchema(strict)) {
    throw new Error("Compatibility schema changed after preparation; refusing to overwrite it.");
  }
  await writeFile(schemaPath, strict, "utf8");
  await unlink(backupPath);
  console.log("restored final strict schema");
}

async function status(): Promise<void> {
  const [current, backup] = await Promise.all([
    readFile(schemaPath, "utf8"),
    optionalRead(backupPath),
  ]);
  if (backup === null) {
    renderIdentityCutoverCompatibilitySchema(current);
    console.log("strict");
    return;
  }
  console.log(current === renderIdentityCutoverCompatibilitySchema(backup)
    ? "compatibility-prepared"
    : "diverged-refuse-restore");
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "prepare") return await prepare();
  if (command === "restore") return await restore();
  if (command === "status") return await status();
  throw new Error("Usage: bun run scripts/identity-cutover-schema.ts prepare|restore|status");
}

if (import.meta.main) await main();
