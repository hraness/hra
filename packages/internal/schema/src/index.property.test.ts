import { expect, test } from "bun:test";
import { assertProperty, fc } from "@hra-internal/test";
import { parseOption, parseResult, z } from "./index";

const envelopeSchema = z.strictObject({ id: z.string(), count: z.number().int() });

test("property: boundary parsing is total over arbitrary JSON", () => {
  assertProperty(fc.property(fc.jsonValue(), (value) => {
    expect(() => parseOption(envelopeSchema, value)).not.toThrow();
    expect(() => parseResult(envelopeSchema, value)).not.toThrow();
    const option = parseOption(envelopeSchema, value);
    const result = parseResult(envelopeSchema, value);
    expect(result.ok).toBe(option !== null);
  }));
});
