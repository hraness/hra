"use server";

import { withAuth } from "@workos-inc/authkit-nextjs";
import { WorkOS } from "@workos-inc/node";

import {
  type OrganizationOptionsResult,
  sanitizeOrganizationOptions,
} from "./organization-options";
import { isNonEmptyEnvironmentValue } from "./workos-configuration";

export async function listOrganizationOptions(): Promise<OrganizationOptionsResult> {
  const { user } = await withAuth();
  if (user === null) return { kind: "signed-out" };

  const apiKey = process.env.WORKOS_API_KEY;
  const clientId = process.env.WORKOS_CLIENT_ID;
  if (!isNonEmptyEnvironmentValue(apiKey) || !isNonEmptyEnvironmentValue(clientId)) {
    return { kind: "unavailable" };
  }

  try {
    const workos = new WorkOS({ apiKey, clientId, maxRetries: 2, timeout: 10_000 });
    const page = await workos.userManagement.listOrganizationMemberships({
      limit: 100,
      statuses: ["active"],
      userId: user.id,
    });
    return {
      kind: "ready",
      organizations: sanitizeOrganizationOptions(page.data, user.id),
    };
  } catch {
    return { kind: "unavailable" };
  }
}
