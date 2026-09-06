import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AccountLoginRelay } from "./account-login-relay";

describe("account login relay", () => {
  test("shows the separate one-time code without offering a clipboard effect", async () => {
    const markup = renderToStaticMarkup(
      <AccountLoginRelay
        expiresAt={2}
        loginUrl="https://auth.openai.com/codex/device"
        now={1}
        userCode="ABCD-EFGH"
      />,
    );
    const codeAt = markup.indexOf("ABCD-EFGH");
    const linkAt = markup.indexOf("https://auth.openai.com/codex/device");
    expect(codeAt).toBeGreaterThan(-1);
    expect(linkAt).toBeGreaterThan(codeAt);
    expect(markup).not.toContain("Copy code");
    expect(markup).toContain('rel="noreferrer noopener"');
    expect(markup).not.toContain("style=");
    const source = await Bun.file(new URL("./account-login-relay.tsx", import.meta.url)).text();
    expect(source).not.toContain("navigator.clipboard");
    expect(source).not.toContain("localStorage");
    expect(source).not.toContain("sessionStorage");
    expect(source).not.toContain("indexedDB");
  });

  test("renders nothing once the one-time handoff reaches its expiry", () => {
    expect(renderToStaticMarkup(
      <AccountLoginRelay
        expiresAt={2}
        loginUrl="https://auth.openai.com/codex/device"
        now={2}
        userCode="ABCD-EFGH"
      />,
    )).toBe("");
  });
});
