import { expect, test } from "bun:test";
import { assertAsyncProperty, fc } from "@hra-internal/test";

import {
  runtimeProtocolVersion,
  type RuntimeDispatchResponse,
  type RuntimeEvent,
  type RuntimeSnapshot,
  type RuntimeTaskDispatchResponse,
  type RuntimeTransportLifecycle,
} from "../../../contracts/runtime";
import type { RuntimeBridge, RuntimeBridgeListener } from "../runtime-bridge";
import { createRuntimeShell } from "./shell";
import { emptyRuntimeSnapshot } from "./test-fixtures";

class GenerationBridge implements RuntimeBridge {
  snapshotCalls = 0;
  listener: RuntimeBridgeListener | null = null;

  snapshot(): Promise<RuntimeSnapshot> {
    this.snapshotCalls += 1;
    return Promise.resolve({
      ...emptyRuntimeSnapshot(),
      revision: this.snapshotCalls,
    });
  }

  dispatch(): Promise<RuntimeDispatchResponse> {
    return Promise.resolve({
      version: runtimeProtocolVersion,
      operationId: "op_generationproperty1",
      ok: true,
      result: { type: "accepted" },
    });
  }

  dispatchTask(): Promise<RuntimeTaskDispatchResponse> {
    return Promise.reject(new Error("The generation property has no task authority."));
  }

  addProject() {
    return Promise.resolve({ version: runtimeProtocolVersion, status: "cancelled" } as const);
  }

  retryTransport() {
    return Promise.resolve({ version: 1, status: "accepted" } as const);
  }

  subscribe(listener: RuntimeBridgeListener): () => void {
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = null;
    };
  }

  emit(lifecycle: RuntimeTransportLifecycle): void {
    this.listener?.onTransportLifecycle(lifecycle);
  }
}

class BoundaryBridge extends GenerationBridge {
  readonly #sources: Array<Promise<RuntimeSnapshot> | RuntimeSnapshot>;

  constructor(...sources: Array<Promise<RuntimeSnapshot> | RuntimeSnapshot>) {
    super();
    this.#sources = sources;
  }

  override snapshot(): Promise<RuntimeSnapshot> {
    this.snapshotCalls += 1;
    const source = this.#sources.shift();
    if (source === undefined) return Promise.reject(new Error("No boundary snapshot is queued."));
    return Promise.resolve(source);
  }

  emitEvent(event: RuntimeEvent): void {
    this.listener?.onEvent(event);
  }
}

function deferred<Value>(): Readonly<{
  promise: Promise<Value>;
  resolve: (value: Value) => void;
}> {
  let resolver: ((value: Value) => void) | null = null;
  const promise = new Promise<Value>((resolve) => {
    resolver = resolve;
  });
  return {
    promise,
    resolve(value) {
      if (resolver === null) throw new Error("Deferred resolver was not initialized.");
      resolver(value);
    },
  };
}

function taskInvalidation(sequence: number): RuntimeEvent {
  return {
    version: runtimeProtocolVersion,
    sequence,
    event: {
      type: "task.invalidated",
      invalidation: {
        workspaceId: "wsp_generationproperty00000001",
        projectionRevision: 2,
        scope: "workspace",
      },
    },
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

test("only strictly newer Native generations replace sequence-scoped renderer authority", async () => {
  await assertAsyncProperty(
    fc.asyncProperty(
      fc.array(fc.integer({ min: 1, max: 32 }), { minLength: 1, maxLength: 40 }),
      async (generations) => {
        const bridge = new GenerationBridge();
        const shell = createRuntimeShell(bridge);
        await shell.connect();
        let highest = 0;
        let accepted = 0;

        for (const generation of generations) {
          bridge.emit({ version: 1, state: "ready", generation });
          if (generation > highest) {
            highest = generation;
            accepted += 1;
          }
          await settle();
          expect(shell.getState().state).toBe("ready");
        }

        expect(bridge.snapshotCalls).toBe(1 + accepted);
        const state = shell.getState();
        expect(state.state).toBe("ready");
        if (state.state === "ready") {
          expect(state.snapshot.revision).toBe(bridge.snapshotCalls);
          expect(state.snapshot.lastSequence).toBe(0);
        }
        shell.dispose();
      },
    ),
  );
});

test("every generation boundary accepts protected deliveries before resetting sequence authority", async () => {
  await assertAsyncProperty(
    fc.asyncProperty(fc.integer({ min: 1, max: 32 }), async (eventCount) => {
      const oldSnapshot = deferred<RuntimeSnapshot>();
      const bridge = new BoundaryBridge(oldSnapshot.promise, emptyRuntimeSnapshot());
      const shell = createRuntimeShell(bridge);
      const accepted: number[] = [];
      shell.subscribeTaskInvalidations(() => accepted.push(accepted.length + 1));
      const staleConnection = shell.connect();

      for (let sequence = 1; sequence <= eventCount; sequence += 1) {
        bridge.emitEvent(taskInvalidation(sequence));
      }
      bridge.emit({ version: 1, state: "starting", generation: 2 });
      expect(accepted).toHaveLength(eventCount);

      oldSnapshot.resolve(emptyRuntimeSnapshot(eventCount));
      await staleConnection;
      expect(shell.getState().state).toBe("reconnecting");

      bridge.emit({ version: 1, state: "ready", generation: 2 });
      await settle();
      for (let sequence = 1; sequence <= eventCount; sequence += 1) {
        bridge.emitEvent(taskInvalidation(sequence));
      }
      expect(accepted).toHaveLength(eventCount * 2);
      expect(bridge.snapshotCalls).toBe(2);
      expect(shell.getState().state).toBe("ready");
      shell.dispose();
    }),
  );
});
