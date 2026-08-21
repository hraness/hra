import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type {
  AccountSummary,
  HumanAccountSnapshot,
} from "../../../../contracts/runtime";
import type { RuntimeShell } from "../../runtime";
import {
  SubscriptionsSettings,
  accountStatus,
  canClearHumanCredential,
  canStartHumanSignIn,
  humanAccountDescription,
  humanAccountStatus,
  weeklyUsageStatus,
} from "./SubscriptionsSettings";

test("settings stays lean and limits account setup to the browser sign-in flow", async () => {
  const shell = {
    getSnapshot: () => ({ state: "connecting" as const }),
    subscribe: () => () => undefined,
  } as unknown as RuntimeShell;
  const html = renderToStaticMarkup(createElement(SubscriptionsSettings, {
    shell,
  }));
  const source = await Bun.file(new URL("./SubscriptionsSettings.tsx", import.meta.url)).text();

  expect(html).toContain("Codex subscriptions");
  expect(html).toContain("Add subscription");
  expect(html).not.toContain(">Add subscription<");
  expect(html).toContain("HRA Cloud");
  expect(html).toContain("Pair this Mac");
  expect(html).toContain("This build does not have an HRA Cloud endpoint configured.");
  expect(html).toMatch(
    /<button(?=[^>]*aria-label="Pair this Mac with HRA Cloud")(?=[^>]*disabled="")[^>]*>/u,
  );
  expect(source).toContain("<Button");
  expect(html).not.toContain("Text size");
  expect(html).not.toContain("Organization");
  expect(html).not.toContain("Workspace");
  expect(source).toContain('type: "account.login.start"');
  expect(source).toContain('mode: "browser"');
  expect(source).toContain('type: "account.login.open"');
  expect(source).toContain('type: "account.login.cancel"');
  expect(source).toContain('type: "account.logout"');
  expect(source).not.toContain('type: "account.remove"');
  expect(source).toContain('type: "human.signIn.start"');
  expect(source).not.toContain('mode: "deviceCode"');
  expect(source).not.toContain("userCode");
  expect(source).not.toContain("<code>");
  expect(source).toContain("Comparison code");
  expect(source).toContain("Continue in browser");
  expect(source).toContain("Pair this Mac");
});

test("signed-in subscription item shows weekly remaining usage and its reset time", async () => {
  const account = {
    id: "acct_example01",
    revision: 1,
    label: "Personal",
    selected: true,
    identityLabel: "builder@example.test",
    planLabel: "Pro",
    weeklyUsage: {
      remainingPercent: 42.6,
      resetsAt: "2026-08-21T20:00:00.000Z",
    },
    authState: "signedIn",
    login: { state: "idle" },
    runtime: { state: "ready", generation: 1 },
  } satisfies AccountSummary;

  const formatter = {
    format: () => "Fri, Aug 21, 8:00 PM UTC",
  } satisfies Pick<Intl.DateTimeFormat, "format">;
  expect(accountStatus(account)).toBe("builder@example.test");
  expect(weeklyUsageStatus(account.weeklyUsage, formatter)).toBe(
    "43% weekly remaining · Resets Fri, Aug 21, 8:00 PM UTC",
  );
  expect(weeklyUsageStatus(null, formatter)).toBeNull();

  const source = await Bun.file(new URL("./SubscriptionsSettings.tsx", import.meta.url)).text();
  expect(source).toContain("weeklyUsageStatus(account.weeklyUsage)");
  expect(source).not.toContain("windowDurationMins");
  expect(source).not.toContain("codex_other");
  expect(accountStatus({
    authState: account.authState,
    identityLabel: account.identityLabel,
  })).toBe("builder@example.test");
});

test("HRA Cloud explains unavailable and usable endpoint states", () => {
  expect(humanAccountStatus({
    state: "unavailable",
    revision: 0,
    reason: "configuration_missing",
  })).toBe("Unavailable in this build");
  expect(humanAccountDescription({
    state: "unavailable",
    revision: 0,
    reason: "configuration_invalid",
  })).toBe("This build cannot use its configured HRA Cloud endpoint.");
  expect(humanAccountDescription({ state: "signedOut", revision: 1 })).toContain(
    "Sign in to connect this Mac to HRA Cloud",
  );
});

test("a credential from another configured cloud has an exact clear path", async () => {
  const foreignCredential = {
    state: "error",
    revision: 7,
    code: "CONFIGURATION_UNAVAILABLE",
    message: "HRA Cloud configuration is unavailable.",
    retryable: false,
    profile: {
      user: {
        id: "usr_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        email: "builder@example.test",
        name: null,
      },
      organization: null,
      workspace: null,
    },
  } as const satisfies HumanAccountSnapshot;
  expect(canClearHumanCredential(foreignCredential)).toBeTrue();
  expect(canStartHumanSignIn(foreignCredential)).toBeTrue();
  expect(humanAccountDescription(foreignCredential)).toContain(
    "Sign in to this build's configured cloud",
  );
  expect(canClearHumanCredential({
    ...foreignCredential,
    profile: null,
  })).toBeFalse();
  const source = await Bun.file(
    new URL("./SubscriptionsSettings.tsx", import.meta.url),
  ).text();
  expect(source).toContain('aria-label={storedCredentialRecovery');
  expect(source).toContain('"Remove stored HRA Cloud credential"');
  expect(source).toContain('type: "human.signOut"');
});

test("failed account and transport recovery stay reachable through compact icon buttons", async () => {
  const source = await Bun.file(new URL("./SubscriptionsSettings.tsx", import.meta.url)).text();
  const retrySource = await Bun.file(
    new URL("../RuntimeRetryButton.tsx", import.meta.url),
  ).text();
  expect(source).toContain("<RuntimeRetryButton shell={shell} />");
  expect(retrySource).toContain('aria-label="Retry local runtime"');
  expect(retrySource).toContain("createRuntimeRetryCoordinator");
  expect(source).toMatch(/aria-label=\{`Restart \$\{account\.label\}`\}/);
  expect(source).toContain('type: "runtime.restartAccount"');
  expect(retrySource).toContain('<HRAIcon name="refresh" />');
  expect(source).toMatch(/tooltip=\{`Restart \$\{account\.label\}`\}/u);
  expect(source).not.toContain(">Log out<");
  expect(source).not.toContain(">Open sign-in<");
  expect(source).not.toContain(">Connect<");
  expect(source).not.toContain(">Reconnect<");
});

test("credential recovery uses revision-scoped two-step consent and a non-destructive retry", async () => {
  const source = await Bun.file(
    new URL("./SubscriptionsSettings.tsx", import.meta.url),
  ).text();
  expect(humanAccountStatus({
    state: "recoveryRequired",
    revision: 4,
    reason: "legacyCredentialAccessDenied",
  })).toBe("Reconnect after update");
  expect(humanAccountStatus({
    state: "signedIn",
    revision: 5,
    profile: {
      user: {
        id: "usr_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        email: "builder@example.test",
        name: null,
      },
      organization: null,
      workspace: null,
    },
  })).toBe("builder@example.test");
  expect(source).toContain('type: "human.credentials.reconnect"');
  expect(source).toContain("expectedRevision: humanAccount.revision");
  expect(source).toContain("runtimeHumanCredentialReconnectConfirmation");
  expect(source).toContain('type: "human.credentials.retry"');
  expect(source).toContain("humanAccount.retryable");
  expect(source).toContain("reconnectConsentRevision === humanAccount.revision");
  expect(source).toContain('aria-label="Review HRA Cloud reconnect"');
  expect(source).toContain('aria-label="Confirm HRA Cloud reconnect"');
  expect(source).toContain('aria-label="Cancel HRA Cloud reconnect"');
  expect(source).toContain("autoFocus");
  expect(source).toContain("stays protected in Keychain");
  expect(source).toContain('aria-label="Retry HRA Cloud credential check"');
  expect(source).toContain('<HRAIcon name="refresh" />');
  expect(source).toContain('<HRAIcon name="check" />');
  expect(source).not.toContain("legacyCredentialAccessDenied}");
  expect(source).not.toContain("Keychain slot");
  expect(source).not.toContain("credential generation");
});
