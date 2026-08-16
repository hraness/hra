import { expect, test } from "bun:test";

import { selectRuntimeAvailability } from "./model";

test("terminal Native transport states never expose a retry loop", () => {
  expect(selectRuntimeAvailability({
    state: "failed",
    snapshot: null,
    failure: {
      kind: "transport",
      message: "The local runtime has stopped.",
      canRetry: false,
      generation: 4,
    },
  })).toEqual({
    kind: "unavailable",
    message: "The local runtime has stopped.",
    reconnectable: false,
  });
});

test("exhausted but restartable and protocol failures preserve recovery", () => {
  expect(selectRuntimeAvailability({
    state: "failed",
    snapshot: null,
    failure: {
      kind: "transport",
      message: "Automatic recovery was exhausted.",
      canRetry: true,
      generation: 4,
    },
  })).toMatchObject({ reconnectable: true });
  expect(selectRuntimeAvailability({
    state: "failed",
    snapshot: null,
    failure: {
      kind: "malformedTransportValue",
      boundary: "transportLifecycle",
      message: "The native runtime returned an invalid lifecycle.",
    },
  })).toMatchObject({ reconnectable: true });
});
