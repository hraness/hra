import { describe, expect, test } from "bun:test";

import { parseConvexDeployment } from "./index";

describe("parseConvexDeployment", () => {
  test("keeps absent configuration as an explicit missing state", () => {
    expect(parseConvexDeployment(undefined)).toEqual({ kind: "missing" });
    expect(parseConvexDeployment(null)).toEqual({ kind: "missing" });
    expect(parseConvexDeployment(3210)).toEqual({ kind: "missing" });
    expect(parseConvexDeployment(" \t\n ")).toEqual({ kind: "missing" });
  });

  test("canonicalizes hosted and loopback deployment origins", () => {
    expect(parseConvexDeployment(" https://calm-otter-123.convex.cloud/ ")).toEqual({
      kind: "ready",
      origin: "https://calm-otter-123.convex.cloud",
      transport: "cloud",
      url: "https://calm-otter-123.convex.cloud",
    });
    expect(parseConvexDeployment("HTTP://LOCALHOST:3210/")).toEqual({
      kind: "ready",
      origin: "http://localhost:3210",
      transport: "local",
      url: "http://localhost:3210",
    });
    expect(parseConvexDeployment("http://[::1]:3210")).toEqual({
      kind: "ready",
      origin: "http://[::1]:3210",
      transport: "local",
      url: "http://[::1]:3210",
    });
  });

  test("reports malformed URLs and embedded credentials precisely", () => {
    expect(parseConvexDeployment("calm-otter-123.convex.cloud")).toEqual({
      input: "calm-otter-123.convex.cloud",
      kind: "invalid",
      message: "Use a complete Convex deployment URL.",
      reason: "not-a-url",
    });
    expect(parseConvexDeployment("https://user:pass@example.com")).toMatchObject({
      kind: "invalid",
      reason: "credentials",
    });
  });

  test("rejects every non-origin component", () => {
    for (const value of [
      "https://example.com/functions",
      "https://example.com?preview=true",
      "https://example.com#preview",
    ]) {
      expect(parseConvexDeployment(value)).toMatchObject({
        kind: "invalid",
        reason: "not-an-origin",
      });
    }
  });

  test("allows HTTP only for exact loopback hostnames", () => {
    for (const value of [
      "http://example.com",
      "http://localhost.example.com:3210",
      "http://0.0.0.0:3210",
    ]) {
      expect(parseConvexDeployment(value)).toMatchObject({
        kind: "invalid",
        reason: "insecure-remote",
      });
    }
  });
});
