import { describe, expect, test } from "bun:test";

import { HRA_RLM_DYNAMIC_TOOL_SPEC } from "../src/codex/dynamic-tool";
import {
  parseRlmV2Program,
  rlmV2CapabilitySchema,
  rlmV2OperationSchema,
} from "../src/harness/rlm-v2";

function containsObjectKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsObjectKey(item, key));
  }
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(([entryKey, entryValue]) =>
    entryKey === key || containsObjectKey(entryValue, key)
  );
}

describe("model-visible RLM v2 contract", () => {
  test("exposes a parser-valid recursive orchestration program without hidden syntax", () => {
    const inputSchema = HRA_RLM_DYNAMIC_TOOL_SPEC.tools[0].inputSchema;
    const definitions = inputSchema.$defs;
    const example = definitions.rlmProgram.examples[0];
    if (example === undefined) {
      throw new Error("RLM v2 schema example is missing");
    }

    const parsed = parseRlmV2Program(example);
    expect(parsed.steps.map((step) => step.kind)).toEqual([
      "call",
      "call",
      "call",
      "call",
      "call",
    ]);
    expect(parsed.steps.map((step) =>
      step.kind === "call" ? step.operation : null
    )).toEqual([
      "context.snapshot",
      "context.materialize",
      "agent.spawn",
      "agent.waitAny",
      "agent.result",
    ]);
    expect(inputSchema.properties.program.$ref).toBe("#/$defs/rlmProgram");
    expect(definitions.rlmProgram.required).toEqual([
      "version",
      "capabilities",
      "steps",
      "result",
    ]);
  });

  test("enumerates the complete closed operation set and relative spawn allocation", () => {
    const definitions = HRA_RLM_DYNAMIC_TOOL_SPEC.tools[0].inputSchema.$defs;
    const operation = definitions.rlmStep.properties.operation;
    const expected = rlmV2OperationSchema.options;

    expect([...operation.enum]).toEqual([...expected]);
    expect(new Set(operation.enum).size).toBe(operation.enum.length);
    expect(operation.description).toContain(
      "workClass:largeChange|wideResearch|standard|boundedLeaf",
    );
    expect(operation.description).toContain(
      "bottleneck:reasoning|fileGeneration",
    );
    expect(operation.description).toContain(
      "omitted acceleration is Standard",
    );
    expect(operation.description).toContain("agent.result/agent.cancel {turnId}");
    const example = definitions.rlmProgram.examples[0];
    if (example === undefined) {
      throw new Error("RLM v2 schema example is missing");
    }
    const spawn = example.steps.find((step) => step.operation === "agent.spawn");
    expect(spawn?.arguments.workClass).toEqual({
      kind: "literal",
      value: "wideResearch",
    });
    expect(spawn?.arguments.acceleration).toEqual({
      kind: "object",
      entries: { mode: { kind: "literal", value: "standard" } },
    });
  });

  test("does not expose proposal enumeration or preview authority in recursive v1", () => {
    const definitions = HRA_RLM_DYNAMIC_TOOL_SPEC.tools[0].inputSchema.$defs;
    expect(definitions.rlmProgram.properties.capabilities.items.enum)
      .not.toContain("harness.read");
    expect(definitions.rlmStep.properties.operation.enum).not.toContain(
      "harness.list",
    );
    expect(definitions.rlmStep.properties.operation.enum).not.toContain(
      "harness.get",
    );
    expect(rlmV2CapabilitySchema.safeParse("harness.read").success).toBeFalse();
    expect(rlmV2OperationSchema.safeParse("harness.list").success).toBeFalse();
    expect(rlmV2OperationSchema.safeParse("harness.get").success).toBeFalse();
  });

  test("documents every recursive AST family without unsupported JSON Schema combinators", () => {
    const inputSchema = HRA_RLM_DYNAMIC_TOOL_SPEC.tools[0].inputSchema;
    const definitions = inputSchema.$defs;

    expect(definitions.rlmExpression.properties.kind.enum).toEqual([
      "literal",
      "variable",
      "list",
      "object",
      "field",
      "index",
      "equals",
      "not",
      "and",
      "or",
      "add",
      "concat",
      "length",
    ]);
    expect(definitions.rlmStep.properties.kind.enum).toEqual([
      "let",
      "call",
      "if",
      "map",
      "reduce",
      "parallel",
    ]);
    expect(containsObjectKey(inputSchema, "oneOf")).toBeFalse();
    expect(containsObjectKey(inputSchema, "anyOf")).toBeFalse();
    expect(containsObjectKey(inputSchema, "allOf")).toBeFalse();
    expect(containsObjectKey(inputSchema, "not")).toBeFalse();
  });
});
