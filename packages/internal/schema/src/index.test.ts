import { describe, expect, test } from "bun:test";
import { parseOption, parseResult, z } from "./index";

const pointSchema = z.strictObject({ x: z.number(), y: z.number() });

describe("schema boundary helpers", () => {
  test("returns typed values for valid input", () => {
    expect(parseOption(pointSchema, { x: 1, y: 2 })).toEqual({ x: 1, y: 2 });
  });

  test("retains structured failure detail", () => {
    const result = parseResult(pointSchema, { x: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.issues[0]?.path).toEqual(["y"]);
  });
});
