import { expect, test } from "bun:test";
import { assertProperty, fc } from "@hra-internal/test";

import type { RuntimeEvent, RuntimeSnapshot } from "../../../contracts/runtime";
import { advanceRuntimeProjection } from "../../../contracts/runtime-projection";
import { applyRuntimeEvent } from "./projection";
import {
  accountUpsertEvent,
  emptyRuntimeSnapshot,
  fixtureAccount,
} from "./test-fixtures";

function applyAll(
  snapshot: RuntimeSnapshot,
  events: readonly RuntimeEvent[],
): RuntimeSnapshot {
  return events.reduce((current, event) => {
    const result = applyRuntimeEvent(current, event);
    if (result.kind === "gap" || result.kind === "invalidated") {
      throw new Error("Generated public event stream must remain continuous");
    }
    return result.snapshot;
  }, snapshot);
}

test("renderer event delivery is idempotent and matches the portable reducer", () => {
  assertProperty(fc.property(
    fc.array(fc.boolean(), { maxLength: 48 }),
    (selectedValues) => {
      const events = selectedValues.map((selected, index) => accountUpsertEvent(
        index + 1,
        fixtureAccount({
          id: `acct_generated${String(index).padStart(8, "0")}`,
          selected,
        }),
      ));
      const duplicated = events.flatMap((event) => [event, event]);
      const initial = emptyRuntimeSnapshot();

      expect(applyAll(initial, duplicated)).toEqual(applyAll(initial, events));
      expect(applyAll(initial, events)).toEqual(
        events.reduce(advanceRuntimeProjection, initial),
      );
    },
  ));
});
