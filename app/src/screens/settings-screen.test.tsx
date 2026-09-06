import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { AccountRowView } from "../model/settings-view";
import { AccountBrowserLoginControls } from "./settings-screen";

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
