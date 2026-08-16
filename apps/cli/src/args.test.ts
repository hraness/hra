import { describe, expect, test } from "bun:test";
import { createBearerSecret, createLocator, formatCredentialToken } from "@hraness/agent-tasks-protocol";

import { parseArgs } from "./args";

const UUID_V7 = "018f22e2-7b44-7cc0-8e5d-657f31f9064a";

describe("argument parsing", () => {
  test("parses the human administration surface without accepting secrets", () => {
    expect(parseArgs(["auth", "login", "--secret-store", "file", "--no-browser", "--json"])).toEqual({
      ok: true,
      command: {
        kind: "auth_login",
        secretStore: "file",
        openBrowser: false,
        json: true,
      },
    });
    expect(parseArgs(["organization", "list", "--limit", "100", "--cursor", "next"])).toEqual({
      ok: true,
      command: {
        kind: "organization_list",
        limit: 100,
        cursor: "next",
        json: false,
      },
    });
    expect(
      parseArgs([
        "workspace",
        "create",
        "--name",
        "Core",
        "--slug",
        "core",
        "--task-key-prefix",
        "OPS",
        "--idempotency-key",
        UUID_V7,
      ]),
    ).toEqual({
      ok: true,
      command: {
        kind: "workspace_create",
        name: "Core",
        slug: "core",
        taskKeyPrefix: "OPS",
        idempotencyKey: UUID_V7,
        json: false,
      },
    });
    expect(
      parseArgs([
        "agent",
        "create",
        "--name",
        "Builder",
        "--preset",
        "worker",
        "--scopes",
        "tasks:read,tasks:claim",
        "--enrollment-out",
        "/tmp/builder.enrollment",
      ]),
    ).toEqual({
      ok: true,
      command: {
        kind: "agent_create",
        name: "Builder",
        preset: "worker",
        scopes: ["tasks:read", "tasks:claim"],
        enrollmentOut: "/tmp/builder.enrollment",
        json: false,
      },
    });

  });

  test("defaults agent enrollment and legacy migration to keychain custody", () => {
    expect(parseArgs(["auth", "enroll", "--json"])).toEqual({
      ok: true,
      command: { kind: "auth_enroll", secretStore: "keychain", json: true },
    });
    expect(
      parseArgs(["auth", "enroll", "--secret-store", "file", "--json"]),
    ).toEqual({
      ok: true,
      command: { kind: "auth_enroll", secretStore: "file", json: true },
    });
    expect(parseArgs(["auth", "migrate-agent-credential", "--json"])).toEqual({
      ok: true,
      command: {
        kind: "auth_migrate_agent_credential",
        secretStore: "keychain",
        json: true,
      },
    });
    expect(
      parseArgs(["auth", "migrate-agent-credential", "--secret-store", "memory"]),
    ).toMatchObject({ ok: false, message: "--secret-store must be keychain or file" });
  });

  test("requires explicit secure enrollment output and preset-bounded scopes", () => {
    expect(
      parseArgs([
        "agent",
        "create",
        "--name",
        "Watcher",
        "--preset",
        "observer",
        "--enrollment-out",
        "relative-token",
      ]),
    ).toMatchObject({ ok: false, message: "--enrollment-out is required and must be an absolute path" });
    expect(
      parseArgs([
        "agent",
        "create",
        "--name",
        "Watcher",
        "--preset",
        "observer",
        "--scopes",
        "tasks:claim",
        "--enrollment-out",
        "/tmp/watcher.enrollment",
      ]),
    ).toMatchObject({ ok: false, message: "--scopes cannot exceed the observer preset" });
  });

  test("parses the agent lifecycle administration surface with public IDs only", () => {
    const credentialId = createLocator(new Uint8Array(26));
    expect(parseArgs(["agent", "list", "--limit", "50", "--cursor", "next"])).toEqual({
      ok: true,
      command: { kind: "agent_list", limit: 50, cursor: "next", json: false },
    });
    expect(parseArgs(["agent", "show", "agent-1", "--json"])).toEqual({
      ok: true,
      command: { kind: "agent_show", agentId: "agent-1", json: true },
    });
    expect(
      parseArgs([
        "agent",
        "enrollment",
        "create",
        "agent-1",
        "--scopes",
        "tasks:read,tasks:claim",
        "--credential-lifetime-ms",
        "3600000",
        "--enrollment-out",
        "/tmp/agent-1.enrollment",
        "--idempotency-key",
        UUID_V7,
      ]),
    ).toEqual({
      ok: true,
      command: {
        kind: "agent_enrollment_create",
        agentId: "agent-1",
        scopes: ["tasks:read", "tasks:claim"],
        credentialLifetimeMs: 3_600_000,
        enrollmentOut: "/tmp/agent-1.enrollment",
        idempotencyKey: UUID_V7,
        json: false,
      },
    });
    expect(parseArgs(["agent", "credential", "list", "agent-1"])).toEqual({
      ok: true,
      command: {
        kind: "agent_credential_list",
        agentId: "agent-1",
        limit: 20,
        json: false,
      },
    });
    expect(
      parseArgs([
        "agent",
        "credential",
        "revoke",
        "agent-1",
        credentialId,
        "--idempotency-key",
        UUID_V7,
      ]),
    ).toEqual({
      ok: true,
      command: {
        kind: "agent_credential_revoke",
        agentId: "agent-1",
        credentialId,
        idempotencyKey: UUID_V7,
        json: false,
      },
    });
    expect(parseArgs(["agent", "session", "list", "agent-1"])).toEqual({
      ok: true,
      command: { kind: "agent_session_list", agentId: "agent-1", limit: 20, json: false },
    });
    expect(parseArgs(["agent", "disable", "agent-1", "--idempotency-key", UUID_V7])).toEqual({
      ok: true,
      command: {
        kind: "agent_disable",
        agentId: "agent-1",
        idempotencyKey: UUID_V7,
        json: false,
      },
    });

    const credential = formatCredentialToken(
      credentialId,
      createBearerSecret(Uint8Array.from({ length: 32 }, (_, index) => index)),
    );
    const rejected = parseArgs(["agent", "credential", "revoke", "agent-1", credential]);
    expect(rejected).toMatchObject({ ok: false, message: "secret values are not accepted on the command line" });
    expect(JSON.stringify(rejected)).not.toContain(credential);
  });

  test("parses the supported task mutations into closed commands", () => {
    expect(
      parseArgs([
        "task",
        "create",
        "--title",
        "Repair the claim race",
        "--type",
        "bug",
        "--priority",
        "1",
        "--available-at",
        "1720000000123",
        "--idempotency-key",
        UUID_V7,
        "--json",
      ]),
    ).toEqual({
      ok: true,
      command: {
        kind: "task_create",
        title: "Repair the claim race",
        type: "bug",
        priority: 1,
        availableAt: 1_720_000_000_123,
        idempotencyKey: UUID_V7,
        json: true,
      },
    });

    expect(
      parseArgs([
        "task",
        "claim",
        "renew",
        "OPS-7K2M4Q9",
        "--fence",
        "7",
        "--idempotency-key",
        UUID_V7,
      ]),
    ).toEqual({
      ok: true,
      command: {
        kind: "task_claim_renew",
        key: "OPS-7K2M4Q9",
        fence: 7,
        idempotencyKey: UUID_V7,
        json: false,
      },
    });

    expect(
      parseArgs([
        "task",
        "assign",
        "OPS-7K2M4Q9",
        "--revision",
        "4",
        "--agent",
        "agent-2",
        "--fence",
        "7",
      ]),
    ).toEqual({
      ok: true,
      command: {
        kind: "task_assign",
        key: "OPS-7K2M4Q9",
        revision: 4,
        assigneeAgentId: "agent-2",
        fence: 7,
        json: false,
      },
    });
  });

  test("accepts epic and enforces the title byte limit", () => {
    const epic = parseArgs(["task", "create", "--title", "Roadmap", "--type", "epic"]);
    expect(epic.ok).toBeTrue();

    const tooLarge = parseArgs(["task", "create", "--title", "🌴".repeat(129)]);
    expect(tooLarge).toEqual({
      ok: false,
      json: false,
      message: "--title is required and must be at most 512 UTF-8 bytes",
    });
  });

  test("never accepts a bearer token on argv", () => {
    const locator = createLocator(Uint8Array.from({ length: 26 }, (_, index) => index));
    const secret = createBearerSecret(Uint8Array.from({ length: 32 }, (_, index) => index));
    const token = formatCredentialToken(locator, secret);

    const parsed = parseArgs(["task", "create", "--title", token, "--json"]);
    expect(parsed).toEqual({
      ok: false,
      json: true,
      message: "secret values are not accepted on the command line",
    });
    expect(JSON.stringify(parsed)).not.toContain(token);
    expect(JSON.stringify(parsed)).not.toContain(secret);
  });

  test("rejects unknown flags, malformed keys, and missing fences without echoing input", () => {
    expect(parseArgs(["task", "ready", "--wat"])).toEqual({
      ok: false,
      json: false,
      message: "task ready received an unknown, duplicate, or positional argument",
    });
    expect(parseArgs(["task", "claim", "OPS-short"])).toEqual({
      ok: false,
      json: false,
      message: "task key is invalid",
    });
    expect(parseArgs(["task", "release", "OPS-7K2M4Q9"])).toEqual({
      ok: false,
      json: false,
      message: "--fence must be a positive integer",
    });
  });

  test("parses the complete graph, collaboration, reference, and repository surface", () => {
    expect(
      parseArgs([
        "task",
        "dep",
        "add",
        "OPS-7K2M4Q9",
        "--blocker",
        "OPS-0000001",
        "--revision",
        "4",
        "--fence",
        "9",
      ]),
    ).toMatchObject({
      ok: true,
      command: {
        kind: "task_dep_add",
        key: "OPS-7K2M4Q9",
        blockerKey: "OPS-0000001",
        revision: 4,
        fence: 9,
      },
    });
    expect(
      parseArgs([
        "task",
        "ref",
        "add",
        "OPS-7K2M4Q9",
        "--revision",
        "3",
        "--kind",
        "commit",
        "--sha",
        "a".repeat(40),
      ]),
    ).toMatchObject({
      ok: true,
      command: { kind: "task_ref_add", reference: { kind: "commit", sha: "a".repeat(40) } },
    });
    expect(
      parseArgs([
        "workspace",
        "repo",
        "add",
        "--name",
        "example",
        "--provider",
        "github",
        "--url",
        "https://github.com/example/project",
      ]),
    ).toMatchObject({ ok: true, command: { kind: "workspace_repo_add", provider: "github" } });
    expect(parseArgs(["task", "graph", "OPS-7K2M4Q9", "--depth", "2", "--limit", "100"]))
      .toMatchObject({ ok: true, command: { kind: "task_graph", depth: 2, limit: 100 } });
  });

  test("strictly parses submissions and reviews without accepting unknown evidence fields", () => {
    const evidence = JSON.stringify([
      { kind: "test", command: "bun test" },
      { kind: "commit", sha: "b".repeat(40) },
    ]);
    expect(
      parseArgs([
        "task",
        "submit",
        "OPS-7K2M4Q9",
        "--fence",
        "8",
        "--summary",
        "All checks pass",
        "--evidence-json",
        evidence,
      ]),
    ).toMatchObject({
      ok: true,
      command: { kind: "task_submit", fence: 8, evidence: [{ kind: "test" }, { kind: "commit" }] },
    });
    expect(
      parseArgs([
        "task",
        "submit",
        "OPS-7K2M4Q9",
        "--fence",
        "8",
        "--summary",
        "done",
        "--evidence-json",
        JSON.stringify([{ kind: "note", text: "done", credential: "forbidden" }]),
      ]),
    ).toMatchObject({ ok: false });
    expect(
      parseArgs([
        "task",
        "accept",
        "OPS-7K2M4Q9",
        "--submission",
        "sub_00000000000000000000000000",
        "--review-revision",
        "5",
      ]),
    ).toMatchObject({ ok: true, command: { kind: "task_accept", reviewRevision: 5 } });
  });
});
