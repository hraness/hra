import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AccountLoginRelay } from "./account-login-relay";

describe("account login relay", () => {
  test("shows the separate one-time code before the provider verification link", () => {
    const markup = renderToStaticMarkup(
      <AccountLoginRelay
        expiresAt={2}
        loginUrl="https://auth.example.test/device"
        now={1}
        userCode="ABCD-EFGH"
      />,
    );
    const codeAt = markup.indexOf("ABCD-EFGH");
    const linkAt = markup.indexOf("https://auth.example.test/device");
    expect(codeAt).toBeGreaterThan(-1);
    expect(linkAt).toBeGreaterThan(codeAt);
    expect(markup).toContain("Copy code");
    expect(markup).toContain('rel="noreferrer noopener"');
    expect(markup).not.toContain("style=");
  });

  test("renders nothing once the one-time handoff reaches its expiry", () => {
    expect(renderToStaticMarkup(
      <AccountLoginRelay
        expiresAt={2}
        loginUrl="https://auth.example.test/device"
        now={2}
        userCode="ABCD-EFGH"
      />,
    )).toBe("");
  });
});
