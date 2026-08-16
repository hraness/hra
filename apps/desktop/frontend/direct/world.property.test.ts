import { expect, test } from "bun:test";
import { assertProperty, fc } from "@hra-internal/test";

import {
  createHRADirectWorld,
  emptySnapshot,
  fixtureAccount,
  parseHRADirectWorld,
} from "./world";

test("generated fixture controls survive JSON round trips", () => {
  assertProperty(fc.property(
    fc.nat({ max: 1_000_000 }),
    fc.integer({ min: 32, max: 4_096 }),
    fc.string({ minLength: 1, maxLength: 40 }),
    fc.boolean(),
    (lastSequence, chunkBytes, label, direct) => {
      const world = createHRADirectWorld({
        gateway: {
          snapshots: [{
            ...emptySnapshot(undefined, lastSequence),
            accounts: [fixtureAccount({ id: "acct_property01", label, selected: true })],
          }],
          encoding: direct ? { kind: "direct" } : { kind: "chunked", chunkBytes },
          events: [],
        },
      });
      const roundTripped = parseHRADirectWorld(
        JSON.parse(JSON.stringify(world)) as unknown,
      );

      expect(roundTripped).toEqual(world);
      expect(roundTripped).not.toBe(world);
    },
  ));
});
