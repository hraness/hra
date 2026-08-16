import { describe, expect, test } from "bun:test";

import { readRelationTupleMatches, readTaskTenantMatches } from "./tasks";
import { activeTaskClaimTupleMatches } from "./workGraphLaws";

const localRelation = {
  authorizationOrganizationId: "organization-a",
  authorizationWorkspaceId: "workspace-a",
  taskOrganizationId: "organization-a",
  taskWorkspaceId: "workspace-a",
  taskId: "task-a",
  recordOrganizationId: "organization-a",
  recordWorkspaceId: "workspace-a",
  recordTaskId: "task-a",
} as const;

describe("task read relation integrity", () => {
  test("rejects an active compact claim that points at another tenant's durable claim", () => {
    expect(
      readRelationTupleMatches({
        ...localRelation,
        recordOrganizationId: "organization-b",
        recordWorkspaceId: "workspace-b",
        recordTaskId: "task-b",
      }),
    ).toBeFalse();
    expect(
      activeTaskClaimTupleMatches({
        taskStatus: "in_progress",
        taskOrganizationId: "organization-a",
        taskWorkspaceId: "workspace-a",
        taskId: "task-a",
        compactClaimId: "claim-b",
        compactClaimPublicId: "claim-public-a",
        compactAgentId: "agent-a",
        compactAgentPublicId: "agent-public-a",
        compactFence: 1,
        compactLeaseGeneration: 1,
        compactLeaseUntil: 10_000,
        claimId: "claim-b",
        claimOrganizationId: "organization-b",
        claimWorkspaceId: "workspace-b",
        claimTaskId: "task-b",
        claimPublicId: "claim-public-b",
        claimAgentId: "agent-b",
        claimAgentPublicId: "agent-public-b",
        claimState: "active",
        claimFence: 1,
        claimLeaseGeneration: 1,
        claimLeaseUntil: 10_000,
      }),
    ).toBeFalse();
  });

  test("rejects a pending submission whose task pointer crosses tenants", () => {
    expect(
      readRelationTupleMatches({
        ...localRelation,
        taskOrganizationId: "organization-b",
        taskWorkspaceId: "workspace-b",
        taskId: "task-b",
        recordTaskId: "task-b",
      }),
    ).toBeFalse();
  });

  test("rejects corrupt tenant tuples while traversing overdue ready-page claims", () => {
    expect(readRelationTupleMatches(localRelation)).toBeTrue();
    expect(
      readRelationTupleMatches({ ...localRelation, recordOrganizationId: "organization-b" }),
    ).toBeFalse();
    expect(
      readRelationTupleMatches({ ...localRelation, recordWorkspaceId: "workspace-b" }),
    ).toBeFalse();
    expect(readRelationTupleMatches({ ...localRelation, recordTaskId: "task-b" })).toBeFalse();
    expect(
      readTaskTenantMatches({
        authorizationOrganizationId: "organization-a",
        authorizationWorkspaceId: "workspace-a",
        taskOrganizationId: "organization-b",
        taskWorkspaceId: "workspace-a",
      }),
    ).toBeFalse();
  });
});
