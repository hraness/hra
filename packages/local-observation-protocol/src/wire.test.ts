import { describe, expect, test } from "bun:test";

import {
  localObservationCapabilitySchema,
  localObservationRequestByteLimit,
  localObservationRequestSchema,
  localObservationResponseByteLimit,
  localObservationResponseSchema,
  parseLocalObservationRequest,
  parseLocalObservationResponse,
  type LocalObservationResponse,
} from "./wire";

const capability = "A".repeat(43);

describe("local observation wire protocol", () => {
  test("accepts only the two capability-bound read operations", () => {
    expect(parseLocalObservationRequest({
      version: 1,
      capability,
      operation: "attention.list",
    }).operation).toBe("attention.list");
    expect(parseLocalObservationRequest({
      version: 1,
      capability,
      operation: "panes.list",
    }).operation).toBe("panes.list");
    expect(localObservationRequestSchema.safeParse({
      version: 1,
      capability,
      operation: "pane.send",
    }).success).toBe(false);
  });

  test("rejects unknown fields and invalid capabilities", () => {
    expect(localObservationRequestSchema.safeParse({
      version: 1,
      capability,
      operation: "panes.list",
      endpoint: "/tmp/override.sock",
    }).success).toBe(false);
    expect(localObservationCapabilitySchema.safeParse("short").success).toBe(false);
    expect(localObservationCapabilitySchema.safeParse("+".repeat(43)).success).toBe(false);
  });

  test("strictly parses bounded success and closed error responses", () => {
    const success = {
      version: 1,
      ok: true,
      result: {
        type: "panes",
        projection: { version: 1, panes: [], truncated: false },
      },
    } satisfies LocalObservationResponse;
    expect(parseLocalObservationResponse(success)).toEqual(success);
    expect(parseLocalObservationResponse({
      version: 1,
      ok: false,
      error: { code: "unauthorized" },
    }).ok).toBe(false);
    expect(localObservationResponseSchema.safeParse({
      ...success,
      capability,
    }).success).toBe(false);
  });

  test("publishes conservative byte ceilings", () => {
    expect(localObservationRequestByteLimit).toBe(1_024);
    expect(localObservationResponseByteLimit).toBe(256 * 1_024);
    expect(localObservationRequestByteLimit).toBeLessThan(localObservationResponseByteLimit);
  });
});
