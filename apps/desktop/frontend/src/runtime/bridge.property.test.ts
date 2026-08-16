import { expect, test } from "bun:test";
import { assertAsyncProperty, fc } from "@hra-internal/test";

import { createRuntimeBridge, RuntimeBridgeProtocolError, type RuntimeTransport } from "../runtime-bridge";

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (reason: unknown) {
    return reason;
  }
  throw new Error("Expected the promise to reject.");
}

test("all wrong-version JSON snapshot values fail closed", async () => {
  await assertAsyncProperty(
    fc.asyncProperty(fc.jsonValue(), async (payload) => {
      const transport: RuntimeTransport = {
        invoke() {
          return Promise.resolve({ version: 1, payload });
        },
        on() {
          return () => undefined;
        },
      };

      expect(await rejectionOf(createRuntimeBridge(transport).snapshot())).toBeInstanceOf(
        RuntimeBridgeProtocolError,
      );
    }),
  );
});
