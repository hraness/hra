import type { RuntimeSnapshot } from "../../../contracts/runtime";
import { RuntimeProjection } from "../../src/projection";

const eventCount = 512;
const mode = process.env.HRA_REACTIVE_BASELINE_QUEUE_MODE;
if (mode !== "drained" && mode !== "retained") {
  throw new Error("The reactive baseline queue mode must be drained or retained.");
}

const initialSnapshot: RuntimeSnapshot = {
  revision: 1,
  lastSequence: 0,
  runtime: { state: "ready", generation: 1 },
  runner: { state: "connected" },
  accounts: [],
  retainedAccountLocalData: [],
  humanAccount: { state: "signedOut", revision: 0 },
  chat: { revision: 1, panes: [] },
  sessionSync: {
    status: {
      state: "unavailable",
      reason: "cloudConfigurationMissing",
      retryable: false,
    },
    localGridSlots: [],
    remoteSessions: [],
  },
  harness: null,
};
const projection = new RuntimeProjection(initialSnapshot);
for (let index = 0; index < eventCount; index += 1) {
  projection.publish({
    type: "task.invalidated",
    invalidation: {
      workspaceId: "wsp_00000000000000000000000000",
      projectionRevision: index + 1,
      scope: "workspace",
    },
  });
}
if (mode === "drained") projection.drainEvents();

Bun.gc(true);
const heap = Bun.generateHeapSnapshot();
if (heap.nodes.length % 4 !== 0) {
  throw new Error("The Bun Inspector heap node table has an unknown layout.");
}
let heapNodeSelfSizeBytes = 0;
for (let index = 1; index < heap.nodes.length; index += 4) {
  heapNodeSelfSizeBytes += heap.nodes[index] ?? 0;
}

console.log(JSON.stringify({
  heapNodeCount: heap.nodes.length / 4,
  heapNodeSelfSizeBytes,
  queuedEventCount: projection.queuedEventCount,
  serializedQueueBytes: projection.queuedByteCount,
}));
