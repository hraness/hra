import { describe, expect, test } from "bun:test";

import {
  runtimeDispatchRequestSchema,
  runtimeProtocolVersion,
} from "../../contracts/runtime";
import {
  HostRequestLaneScheduler,
  runtimeDispatchHostRequestLane,
} from "./host-request-lanes";

describe("gateway host request lanes", () => {
  test("an attention read completes while an earlier serialized mutation is unresolved", async () => {
    const attention = runtimeDispatchRequestSchema.parse({
      version: runtimeProtocolVersion,
      operationId: "op_attentionlane01",
      command: { type: "observation.attention.list" },
    });
    expect(runtimeDispatchHostRequestLane(attention)).toBe("independent");

    const scheduler = new HostRequestLaneScheduler();
    let markMutationEntered!: () => void;
    const mutationEntered = new Promise<void>((resolve) => {
      markMutationEntered = resolve;
    });
    let releaseMutation!: () => void;
    const mutationReleased = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    const mutation = scheduler.run("serialized", async () => {
      markMutationEntered();
      await mutationReleased;
    });
    await mutationEntered;
    let attentionReplied = false;
    const read = scheduler.run(
      runtimeDispatchHostRequestLane(attention),
      () => {
        attentionReplied = true;
        return Promise.resolve();
      },
    );

    await read;
    expect(attentionReplied).toBeTrue();
    releaseMutation();
    await mutation;
  });
});
