import { describe, expect, test } from "bun:test";

import {
  dispatchClaimRequiredScopes,
  firstMissingDispatchClaimScope,
} from "./dispatchAuthorization";

describe("dispatch authorization", () => {
  test("requires dispatcher execution, task claim, and run reporting as one authority bundle", () => {
    expect(dispatchClaimRequiredScopes).toEqual([
      "dispatch:execute",
      "tasks:claim",
      "runs:report",
    ]);
    expect(firstMissingDispatchClaimScope([...dispatchClaimRequiredScopes])).toBeNull();
    expect(firstMissingDispatchClaimScope(["tasks:claim", "runs:report"])).toBe(
      "dispatch:execute",
    );
    expect(firstMissingDispatchClaimScope(["dispatch:execute", "runs:report"])).toBe(
      "tasks:claim",
    );
    expect(firstMissingDispatchClaimScope(["dispatch:execute", "tasks:claim"])).toBe(
      "runs:report",
    );
  });
});
