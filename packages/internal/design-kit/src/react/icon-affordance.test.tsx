import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { IconButton, type IconButtonProps } from "./button";
import { Pressable, type PressableProps } from "./card";
import {
  iconAffordanceTooltipLabel,
  pointIsInsideRectangle,
} from "./icon-affordance";
import { IconLink, type IconLinkProps } from "./link-button";

test("icon affordances derive or explicitly own non-blank tooltip copy", () => {
  expect(iconAffordanceTooltipLabel({ "aria-label": "Copy link" })).toBe("Copy link");
  expect(iconAffordanceTooltipLabel({
    "aria-label": "Copy link",
    tooltip: "Copy a stable link",
  })).toBe("Copy a stable link");
  expect(iconAffordanceTooltipLabel({
    "aria-labelledby": "copy-label",
    tooltip: "Copy link",
  })).toBe("Copy link");
  expect(iconAffordanceTooltipLabel({ "aria-label": "Profile" }, "Open profile"))
    .toBe("Open profile");

  expect(() => iconAffordanceTooltipLabel({ "aria-label": " " })).toThrow("aria-label");
  expect(() => iconAffordanceTooltipLabel({
    "aria-labelledby": "label",
    tooltip: "\n",
  })).toThrow("tooltip");
  expect(() => iconAffordanceTooltipLabel({})).toThrow("aria-label or aria-labelledby");
});

test("pointer-transparent tooltip rectangles include their visual edges", () => {
  const rectangle = { bottom: 25, left: 10, right: 30, top: 5 };

  expect(pointIsInsideRectangle({ x: 10, y: 5 }, rectangle)).toBe(true);
  expect(pointIsInsideRectangle({ x: 30, y: 25 }, rectangle)).toBe(true);
  expect(pointIsInsideRectangle({ x: 20, y: 15 }, rectangle)).toBe(true);
  expect(pointIsInsideRectangle({ x: 9.99, y: 15 }, rectangle)).toBe(false);
  expect(pointIsInsideRectangle({ x: 30.01, y: 15 }, rectangle)).toBe(false);
  expect(pointIsInsideRectangle({ x: 20, y: 4.99 }, rectangle)).toBe(false);
  expect(pointIsInsideRectangle({ x: 20, y: 25.01 }, rectangle)).toBe(false);
});

test("legacy IconLink title becomes shared tooltip copy instead of a native title", () => {
  const html = renderToStaticMarkup(
    <IconLink aria-label="Ben on X" href="https://example.com" title="@ben on X">X</IconLink>,
  );

  expect(html).toContain('aria-label="Ben on X"');
  expect(html).not.toContain('title="@ben on X"');
});

test("external accessible names cannot create untooled icon affordances", () => {
  // @ts-expect-error An external labelled-by relationship cannot supply visible tooltip copy.
  const invalidButton: IconButtonProps = { "aria-labelledby": "button-label" };
  // @ts-expect-error An external labelled-by relationship cannot supply visible tooltip copy.
  const invalidLink: IconLinkProps = { "aria-labelledby": "link-label", href: "/" };
  // @ts-expect-error An external labelled-by relationship cannot supply visible tooltip copy.
  const invalidPressable: PressableProps = { "aria-labelledby": "pressable-label" };

  expect(invalidButton["aria-labelledby"]).toBe("button-label");
  expect(invalidLink["aria-labelledby"]).toBe("link-label");
  expect(invalidPressable["aria-labelledby"]).toBe("pressable-label");

  const validButton: IconButtonProps = {
    "aria-labelledby": "button-label",
    tooltip: "Run",
  };
  const validLink: IconLinkProps = {
    "aria-labelledby": "link-label",
    href: "/",
    tooltip: "Open",
  };
  const validPressable: PressableProps = {
    "aria-labelledby": "pressable-label",
    tooltip: "Decrease",
  };
  expect(validButton.tooltip).toBe("Run");
  expect(validLink.tooltip).toBe("Open");
  expect(validPressable.tooltip).toBe("Decrease");

  // @ts-expect-error Static repeated icon controls intentionally use the quiet recipe.
  const invalidStaticVariant: IconButtonProps = {
    "aria-label": "Delete",
    surfaceMotion: "static",
    variant: "danger",
  };
  expect(invalidStaticVariant.variant).toBe("danger");
});

test("automatic icon tooltips preserve the semantic controls", () => {
  const button = renderToStaticMarkup(<IconButton aria-label="Close">×</IconButton>);
  const disabledButton = renderToStaticMarkup(
    <IconButton aria-label="Unavailable action" isDisabled>×</IconButton>,
  );
  const link = renderToStaticMarkup(<IconLink aria-label="Back" href="/">←</IconLink>);
  const disabledLink = renderToStaticMarkup(
    <IconLink aria-label="Unavailable destination" href="/" isDisabled>←</IconLink>,
  );
  const pressable = renderToStaticMarkup(<Pressable aria-label="Decrease value">−</Pressable>);
  const disabledPressable = renderToStaticMarkup(
    <Pressable aria-label="Unavailable compact action" isDisabled>−</Pressable>,
  );

  expect(button).toContain("<button");
  expect(button).toContain('aria-label="Close"');
  expect(disabledButton).toContain('aria-label="Unavailable action"');
  expect(disabledButton).toContain('disabled=""');
  expect(link).toContain("<a");
  expect(link).toContain('aria-label="Back"');
  expect(disabledLink).toContain('role="link"');
  expect(disabledLink).toContain('aria-disabled="true"');
  expect(disabledLink).not.toContain("<a");
  expect(pressable).toContain("<button");
  expect(pressable).toContain('aria-label="Decrease value"');
  expect(disabledPressable).toContain('disabled=""');
});
