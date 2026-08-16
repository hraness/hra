import { describe, expect, test } from "bun:test";
import { z } from "@hra-internal/schema";
import {
  createExactScriptedTransport,
  type ExactScriptedTransport,
} from "@hraness/direct/testing";

import {
  runtimeDispatchResponseSchema,
  runtimeEventName,
  runtimeEventSchema,
  runtimeProtocolVersion,
  runtimeSnapshotTransportResponseSchema,
  runtimeTransportLifecycleEventName,
  type RuntimeDispatchResponse,
  type RuntimeEvent,
  type RuntimeSnapshotTransportResponse,
} from "../../contracts/runtime";
import {
  createRuntimeBridge,
  type RuntimeTransport,
} from "../src/runtime-bridge";
import { createRuntimeShell } from "../src/runtime";
import { hraDirectDefinition } from "./scenarios";
import { createHRADirectTransport } from "./transport";
import { fixtureAccount } from "./world";

const requestSchema = z.strictObject({
  command: z.string().min(1),
  payload: z.json(),
});
const responseSchema = z.union([
  runtimeSnapshotTransportResponseSchema,
  runtimeDispatchResponseSchema,
]);
const failureSchema = z.strictObject({ message: z.string().min(1) });

type ScriptRequest = z.infer<typeof requestSchema>;
type ScriptResponse = RuntimeSnapshotTransportResponse | RuntimeDispatchResponse;
type ScriptFailure = z.infer<typeof failureSchema>;

function required<T>(result: {
  readonly ok: true;
  readonly value: T;
} | {
  readonly ok: false;
  readonly error: { readonly message: string };
}): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function toRuntimeTransport(
  scripted: ExactScriptedTransport<ScriptResponse, RuntimeEvent, ScriptFailure>,
): RuntimeTransport {
  return {
    async invoke(command, payload) {
      const result = await scripted.request({ command, payload: payload ?? null });
      if (result.ok) return result.value;
      if (result.error.kind === "scripted") throw new Error(result.error.failure.message);
      throw new Error(result.error.error.message);
    },
    on(name, listener) {
      if (name === runtimeTransportLifecycleEventName) return () => undefined;
      if (name !== runtimeEventName) throw new Error(`Unexpected event name: ${name}`);
      return scripted.subscribe((event): undefined => {
        listener(event);
        return undefined;
      });
    },
  };
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (reason: unknown) {
    return reason;
  }
  throw new Error("Expected the promise to reject.");
}

describe("shared exact transport at the HRA seam", () => {
  test("preserves response/event ordering and retained state across a scripted link failure", async () => {
    const scenario = required(hraDirectDefinition.scenarios.resolve("empty-ready"));
    const initial = scenario.world.gateway.snapshots[0];
    if (initial === undefined) throw new Error("The empty-ready snapshot is missing.");
    const accounting = createHRADirectTransport(scenario.world, scenario.runtime);
    const signedOut = fixtureAccount({
      id: "acct_scripted01",
      label: "Scripted",
      selected: true,
    });
    const signedIn = fixtureAccount({
      ...signedOut,
      revision: 2,
      authState: "signedIn",
      identityLabel: "scripted@example.test",
    });
    const scripted = required(createExactScriptedTransport<
      ScriptRequest,
      ScriptResponse,
      RuntimeEvent,
      ScriptFailure
    >({
      runtime: accounting.logical,
      activity: accounting.activity,
      parseRequest: (input) => requestSchema.parse(input),
      parseResponse: (input) => responseSchema.parse(input),
      parseEvent: (input) => runtimeEventSchema.parse(input),
      parseFailure: (input) => failureSchema.parse(input),
      steps: [
        {
          request: {
            command: "hra.runtime.snapshot",
            payload: { version: runtimeProtocolVersion },
          },
          outcome: {
            kind: "response",
            value: { version: runtimeProtocolVersion, snapshot: initial },
          },
          eventsAfter: [{
            version: runtimeProtocolVersion,
            sequence: 1,
            event: { type: "account.upserted", account: signedOut },
          }],
        },
        {
          request: {
            command: "hra.runtime.dispatch",
            payload: {
              version: runtimeProtocolVersion,
              operationId: "op_scripted01",
              command: { type: "account.refresh", accountProfileId: signedOut.id },
            },
          },
          outcome: {
            kind: "response",
            value: {
              version: runtimeProtocolVersion,
              operationId: "op_scripted01",
              ok: true,
              result: { type: "accepted" },
            },
          },
          eventsBefore: [{
            version: runtimeProtocolVersion,
            sequence: 2,
            event: { type: "account.upserted", account: signedIn },
          }],
        },
        {
          request: {
            command: "hra.runtime.dispatch",
            payload: {
              version: runtimeProtocolVersion,
              operationId: "op_scripted02",
              command: { type: "account.refresh", accountProfileId: signedOut.id },
            },
          },
          outcome: { kind: "failure", error: { message: "The fixture link dropped." } },
        },
      ],
    }));
    const operationIds = ["op_scripted01", "op_scripted02"];
    const bridge = createRuntimeBridge(toRuntimeTransport(scripted), {
      createOperationId: () => {
        const operationId = operationIds.shift();
        if (operationId === undefined) throw new Error("Operation fixture exhausted.");
        return operationId;
      },
    });
    const shell = createRuntimeShell(bridge);

    await shell.connect();
    expect(required(await scripted.whenIdle())).toBe(true);
    expect(shell.getState()).toMatchObject({
      state: "ready",
      snapshot: { lastSequence: 1, accounts: [{ authState: "signedOut" }] },
    });

    expect(await shell.dispatch({
      type: "account.refresh",
      accountProfileId: signedOut.id,
    })).toMatchObject({ ok: true, operationId: "op_scripted01" });
    expect(shell.getState()).toMatchObject({
      state: "ready",
      snapshot: {
        lastSequence: 2,
        accounts: [{ authState: "signedIn", identityLabel: "scripted@example.test" }],
      },
    });

    expect(await rejectionOf(shell.dispatch({
      type: "account.refresh",
      accountProfileId: signedOut.id,
    }))).toMatchObject({ message: "The fixture link dropped." });
    expect(shell.getState()).toMatchObject({
      state: "ready",
      snapshot: { lastSequence: 2, accounts: [{ authState: "signedIn" }] },
    });
    expect(required(scripted.assertDrained())).toBe(true);
    expect(accounting.store.getSnapshot().activity).toMatchObject({ active: 0, started: 3, settled: 3 });
    shell.dispose();
  });
});
