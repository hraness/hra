import { describe, expect, test } from "bun:test";

import fc from "fast-check";

import {
  commandEnvelopeSchema,
  LOCAL_COMMAND_REQUEST_VERSION,
  localCommandSchema,
} from "./contracts";
import { presetRequirements } from "./presets";
import { canTransitionMutation, mutationStateSchema } from "./transitions";
import { selectByIdOrLabel, utf8Bytes } from "./values";

describe("domain laws", () => {
  test("owns one exact reduced preset mapping", () => {
    expect(presetRequirements).toEqual({
      low: { model: "gpt-5.6-luna", effort: "max" },
      high: { model: "gpt-5.6-sol", effort: "max" },
      ultra: { model: "gpt-5.6-sol", effort: "ultra" },
      "fable-max": { model: "claude-fable-5-1", effort: "max" },
    });
  });

  test("command parsing is total for arbitrary JSON-like input", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        expect(() => localCommandSchema.safeParse(value)).not.toThrow();
      }),
      { numRuns: 1_000 },
    );
  });

  test("requires one UUIDv7 caller key for device mutations in commands and envelopes", () => {
    const capability = "a".repeat(43);
    const requestId = "00000000-0000-4000-8000-000000000001";
    const idempotencyKey = "018bcfe5-6800-7000-8000-000000000001";
    const command = {
      device: "device_target",
      fingerprint: "0000-1111-2222-3333-4444-5555-6666-7777",
      idempotencyKey,
      kind: "device.approve",
    };

    expect(localCommandSchema.safeParse(command).success).toBe(true);
    expect(commandEnvelopeSchema.safeParse({
      capability,
      command,
      requestId,
      version: LOCAL_COMMAND_REQUEST_VERSION,
    }).success)
      .toBe(true);
    expect(commandEnvelopeSchema.safeParse({ capability, command, requestId, version: 1 }).success)
      .toBe(false);
    for (const invalidCommand of [
      { device: "device_target", fingerprint: "0000-1111-2222-3333-4444-5555-6666-7777", kind: "device.approve" },
      {
        device: "device_target",
        idempotencyKey: "00000000-0000-4000-8000-000000000001",
        kind: "device.revoke",
      },
    ]) {
      expect(localCommandSchema.safeParse(invalidCommand).success).toBe(false);
      expect(commandEnvelopeSchema.safeParse({
        capability,
        command: invalidCommand,
        requestId,
        version: LOCAL_COMMAND_REQUEST_VERSION,
      }).success).toBe(false);
    }
  });

  test("terminal mutation states are absorbing", () => {
    fc.assert(
      fc.property(fc.constantFrom("applied", "failed", "ambiguous", "cancelled", "reconciled"), fc.constantFrom(...mutationStateSchema.options), (from, to) => {
        expect(canTransitionMutation(from, to)).toBe(false);
      }),
    );
  });

  test("selection is exact-id first and otherwise uses one canonical Unicode label key", () => {
    const values = [
      { id: "acct_a", label: "Work" },
      { id: "acct_b", label: "work" },
      { id: "acct_c", label: "Personal" },
      { id: "acct_d", label: "Café" },
    ];
    expect(selectByIdOrLabel(values, "acct_b")).toEqual({ kind: "found", value: values[1]! });
    expect(selectByIdOrLabel(values, "WORK").kind).toBe("ambiguous");
    expect(selectByIdOrLabel(values, "personal")).toEqual({ kind: "found", value: values[2]! });
    expect(selectByIdOrLabel(values, "CAFE\u0301")).toEqual({ kind: "found", value: values[3]! });
  });

  test("UTF-8 byte accounting does not confuse code points with bytes", () => {
    expect(utf8Bytes("🙂".repeat(40))).toBe(160);
  });
});
