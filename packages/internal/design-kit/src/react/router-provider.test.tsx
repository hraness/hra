import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { IconLink, LinkButton, LinkCard } from "./link-button";
import {
  DesignKitRouterProvider,
  isPrefetchableAppHref,
} from "./router-provider";

test("router prefetch accepts owned paths and rejects external or protocol-relative hrefs", () => {
  expect(isPrefetchableAppHref("/account")).toBe(true);
  expect(isPrefetchableAppHref("/inbox?view=open#latest")).toBe(true);
  expect(isPrefetchableAppHref("//cdn.example.com/asset")).toBe(false);
  expect(isPrefetchableAppHref("https://example.com/account")).toBe(false);
  expect(isPrefetchableAppHref("#main-content")).toBe(false);
  expect(isPrefetchableAppHref(undefined)).toBe(false);
});

test("router-backed link recipes retain semantic anchors and Jelly surfaces on the server", () => {
  const html = renderToStaticMarkup(
    <DesignKitRouterProvider
      navigate={() => undefined}
      prefetch={() => undefined}
    >
      <LinkButton href="/account" routerOptions={{ scroll: false }}>Account</LinkButton>
      <LinkCard href="/inbox/item-1">Inbox item</LinkCard>
      <IconLink aria-label="Back to inbox" href="/inbox">←</IconLink>
    </DesignKitRouterProvider>,
  );

  expect(html.match(/<a\b/g)).toHaveLength(3);
  expect(html.match(/<jelly-card\b/g)).toHaveLength(3);
  expect(html).toContain('href="/account"');
  expect(html).toContain("jungle-link-card__control");
  expect(html).toContain("jungle-icon-link__control");
  expect(html).toContain('aria-label="Back to inbox"');
});
