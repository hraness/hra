import { describe, expect, test } from "bun:test";

import {
  HRA_EXPECTED_CONVEX_DEPLOY_URL,
  HRA_RESOLVED_CONVEX_DEPLOY_URL,
  resolvedConvexDeployTargetMatches,
} from "./assert-convex-deploy-target";

const expected = "https://steady-otter-321.convex.cloud";

describe("resolved Convex deploy target assertion", () => {
  test("accepts only the exact generated deployment URL Convex resolved", () => {
    expect(resolvedConvexDeployTargetMatches({
      [HRA_EXPECTED_CONVEX_DEPLOY_URL]: expected,
      [HRA_RESOLVED_CONVEX_DEPLOY_URL]: expected,
    })).toBeTrue();
  });

  test("refuses a default switch, missing value, custom origin, or URL decoration", () => {
    for (const resolved of [
      undefined,
      "https://other-otter-999.convex.cloud",
      "https://convex.example.com",
      `${expected}/path`,
      `${expected}?query=1`,
    ]) {
      expect(resolvedConvexDeployTargetMatches({
        [HRA_EXPECTED_CONVEX_DEPLOY_URL]: expected,
        ...(resolved === undefined
          ? {}
          : { [HRA_RESOLVED_CONVEX_DEPLOY_URL]: resolved }),
      })).toBeFalse();
    }
  });

  test("refuses a malformed expected target even when both values match", () => {
    expect(resolvedConvexDeployTargetMatches({
      [HRA_EXPECTED_CONVEX_DEPLOY_URL]: "https://convex.example.com",
      [HRA_RESOLVED_CONVEX_DEPLOY_URL]: "https://convex.example.com",
    })).toBeFalse();
  });
});
