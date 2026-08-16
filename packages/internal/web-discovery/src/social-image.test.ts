import { describe, expect, test } from "bun:test";

import {
  createSocialImageResponse,
  plainSocialImageTheme,
} from "./social-image";

describe("shared social images", () => {
  test("defaults to the neutral plain-site palette", () => {
    expect(plainSocialImageTheme).toEqual({
      accent: "#2457A6",
      background: "#FFFFFF",
      foreground: "#171717",
      muted: "#666666",
    });
  });

  test("rejects malformed theme overrides before rendering", () => {
    expect(() => createSocialImageResponse({
      description: "A deterministic preview",
      domain: "example.com",
      theme: { background: "white" },
      title: "Plain content",
    })).toThrow("background must be a six-digit hex color");
  });
});
