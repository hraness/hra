import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { AccountRowView, MachineView } from "../model/settings-view";
import { AccountBrowserLoginControls, MemorySupervision } from "./settings-screen";

function account(
  accountLinkingAllowed: boolean,
  deviceCommandsAllowed: boolean,
): AccountRowView {
  return {
    accountLinkingAllowed,
    deviceCommandsAllowed,
    label: "work",
    machineLabel: "studio",
    provider: "codex",
    publicId: "acct_one",
    status: "signed_out",
    targetDevicePublicId: "device_daemon01",
  };
}

describe("browser account login controls", () => {
  test("renders Link and Check only when both machine gates are enabled", () => {
    for (const deviceCommandsAllowed of [false, true]) {
      for (const accountLinkingAllowed of [false, true]) {
        const markup = renderToStaticMarkup(
          <AccountBrowserLoginControls
            account={account(accountLinkingAllowed, deviceCommandsAllowed)}
            busy={false}
            onStart={() => undefined}
            onStatus={() => undefined}
          />,
        );
        if (accountLinkingAllowed && deviceCommandsAllowed) {
          expect(markup).toContain("Link here");
          expect(markup).toContain("Check status");
        } else {
          expect(markup).toBe("");
        }
      }
    }
  });

  test("keeps both admitted actions disabled while their mutation is outstanding", () => {
    const markup = renderToStaticMarkup(
      <AccountBrowserLoginControls
        account={account(true, true)}
        busy
        onStart={() => undefined}
        onStatus={() => undefined}
      />,
    );
    expect(markup.match(/disabled=""/gu)).toHaveLength(2);
  });

  test("never renders browser login actions for provider-owned CLI login", () => {
    for (const provider of ["claude", "devin"] as const) {
      const markup = renderToStaticMarkup(
        <AccountBrowserLoginControls
          account={{ ...account(true, true), provider }}
          busy={false}
          onStart={() => undefined}
          onStatus={() => undefined}
        />,
      );
      expect(markup).toBe("");
      expect(markup).not.toContain("Link here");
      expect(markup).not.toContain("Check status");
    }
  });
});

describe("read-only memory supervision", () => {
  const now = 1_760_000_000_000;
  const digest = (scalar: string) => scalar.repeat(64);
  const summary = (head: string) => ({
    coverage: { peerActions: "complete" as const, peerPolicies: "complete" as const, spaces: "complete" as const },
    observedAt: now,
    peerActions: [{
      actor: { label: "Planner", ref: digest("a") },
      createdAt: now - 2_000,
      delivery: "steer" as const,
      state: "applied" as const,
      target: { label: "Planner", ref: digest("b") },
      updatedAt: now - 1_000,
    }],
    peerPolicies: [{
      mode: "coordinate" as const,
      projectLabel: "HRA",
      session: { label: "Planner", ref: digest("a") },
      updatedAt: now - 3_000,
    }],
    spaces: [{
      bindingDigest: digest("c"),
      canonicalSpaceId: `hra:project:space-${"d".repeat(32)}`,
      enrollment: "attached" as const,
      head: { digest: digest(head), operationSha256: digest(head), sequence: 2 },
      lastExchangeAt: now,
      projectLabel: "HRA",
      recentRecords: [{ key: "release-policy", kind: "memory_page" as const, updatedAt: now }],
      recordCount: 1,
      remoteHead: { digest: digest(head), operationSha256: digest(head), sequence: 2 },
      syncStatus: "settled" as const,
    }],
    version: 1 as const,
  });
  const machine = (id: string, label: string, head: string): MachineView => ({
    accountLinkingAllowed: false,
    accounts: [],
    attentionEmailEnabled: null,
    daemonVersion: "0.6.0",
    defaultApprovalMode: "auto:all",
    defaultPreset: "ultra",
    deviceCommandsAllowed: true,
    devicePublicId: id,
    deviceStatus: "active",
    heartbeatAt: now,
    label,
    memorySummary: summary(head),
    memorySummaryFreshness: "current",
    notificationHours: null,
    notificationHoursStatus: "unsupported",
    notificationPolicyFreshness: "unsupported",
    notificationPolicyRevision: null,
    online: true,
    projects: [],
    proseAutorespondConfigured: false,
    revision: 1,
    scheduledTasks: [],
    showThinkingDefault: false,
    updatedAt: now,
  });

  test("renders disagreement and explicit actor/target roles without mutation controls", () => {
    const markup = renderToStaticMarkup(
      <MemorySupervision
        machines={[
          machine("device_studio01", "Studio", "e"),
          machine("device_laptop01", "Laptop", "f"),
        ]}
        now={now}
      />,
    );
    expect(markup).toContain("Memory and peer activity");
    expect(markup).toContain("heads disagree");
    expect(markup).toContain("Exact head 2:eeeeeeeeeeee");
    expect(markup).toContain("Exact head 2:ffffffffffff");
    expect(markup).toContain("Actor Planner (aaaaaaaaaaaa) → target Planner (bbbbbbbbbbbb)");
    expect(markup).toContain("Messages and reasons are not uploaded.");
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain("private reason");
  });

  test("labels a single current observation as insufficient evidence", () => {
    const markup = renderToStaticMarkup(
      <MemorySupervision machines={[machine("device_studio01", "Studio", "e")]} now={now} />,
    );
    expect(markup).toContain("insufficient evidence");
    expect(markup).not.toContain("one current head");
  });

  test("surfaces capped coverage without turning an omitted space into non-enrollment", () => {
    const studio = machine("device_studio01", "Studio", "e");
    const laptop = machine("device_laptop01", "Laptop", "e");
    const boundedLaptop: MachineView = {
      ...laptop,
      memorySummary: {
        ...summary("e"),
        coverage: {
          peerActions: "bounded",
          peerPolicies: "complete",
          spaces: "bounded",
        },
        spaces: [],
      },
    };
    const markup = renderToStaticMarkup(
      <MemorySupervision machines={[studio, boundedLaptop]} now={now} />,
    );
    expect(markup).toContain("Summary coverage on Laptop");
    expect(markup).toContain("spaces, peer actions");
    expect(markup).toContain("absence does not prove non-enrollment");
    expect(markup).not.toContain("Laptop did not report enrollment");
  });
});
