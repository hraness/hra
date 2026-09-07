import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const mutationCalls: Readonly<{ args: unknown; reference: unknown }>[] = [];
const reportedFailures: unknown[] = [];
let acknowledgementFailure: Error | null = null;
let malformedEnqueueResponse = false;
const functions = await import("./functions");

await mock.module("convex/react", () => ({
  useConvex: () => ({
    mutation: async (reference: unknown, args: unknown) => {
      mutationCalls.push({ args, reference });
      const request = args as Record<string, unknown>;
      if (reference === functions.enqueueCommand) {
        if (malformedEnqueueResponse) return { publicId: request.publicId };
        return {
          publicId: request.publicId,
          requestCommitmentVersion: 2,
          replay: false,
          requestingDevicePublicId: request.expectedRequestingDevicePublicId,
          sessionPublicId: request.sessionPublicId,
          state: "pending",
          targetDevicePublicId: request.expectedTargetDevicePublicId,
        };
      }
      if (reference === functions.acknowledgeCommandReceipt) {
        if (acknowledgementFailure !== null) throw acknowledgementFailure;
        return { acknowledgedAt: Date.now(), publicId: request.commandPublicId, replay: false };
      }
      throw new Error("unexpected mutation reference");
    },
  }),
  useQuery: () => undefined,
}));

await mock.module("../custody/custody-context", () => ({
  useCustody: () => ({
    identity: {
      authEpoch: 1,
      credentialGeneration: 1,
      devicePublicId: "device_browser1",
      keyVersion: 1,
      userPublicId: "user_0000000000000001",
    },
    key: new Uint8Array(32),
    reportAuthorityFailure: (failure: unknown) => { reportedFailures.push(failure); },
    state: "unlocked",
  }),
}));

const { useSubmitCommand } = await import("./commands");

const installedGlobals = [
  "document",
  "Document",
  "DocumentFragment",
  "Element",
  "Event",
  "HTMLElement",
  "Node",
  "navigator",
  "window",
] as const;
const globalRecord = globalThis as unknown as Record<string, unknown>;
const originalDescriptors = new Map(
  installedGlobals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
);
let mountedRoot: Root | null = null;
let mountedSubmit: ReturnType<typeof useSubmitCommand> | undefined;

function MountedSubmission() {
  mountedSubmit = useSubmitCommand();
  return null;
}

beforeEach(() => {
  const parsed = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  const { document, window } = parsed;
  const windowRecord = window as unknown as Record<string, unknown>;
  for (const name of installedGlobals) {
    globalRecord[name] = name === "window"
      ? window
      : name === "document"
        ? document
        : windowRecord[name];
  }
  globalRecord.IS_REACT_ACT_ENVIRONMENT = true;
  acknowledgementFailure = null;
  malformedEnqueueResponse = false;
  mountedSubmit = undefined;
  mutationCalls.length = 0;
  reportedFailures.length = 0;
});

afterEach(() => {
  if (mountedRoot !== null) {
    act(() => { mountedRoot?.unmount(); });
    mountedRoot = null;
  }
  for (const name of installedGlobals) {
    const descriptor = originalDescriptors.get(name);
    if (descriptor === undefined) Reflect.deleteProperty(globalRecord, name);
    else Object.defineProperty(globalThis, name, descriptor);
  }
  Reflect.deleteProperty(globalRecord, "IS_REACT_ACT_ENVIRONMENT");
});

async function mountSubmission(): Promise<void> {
  const container = document.getElementById("root");
  if (!(container instanceof HTMLElement)) throw new Error("missing test root");
  mountedRoot = createRoot(container);
  await act(async () => {
    mountedRoot?.render(<MountedSubmission />);
    await Promise.resolve();
  });
}

describe("session command submission receipts", () => {
  test("acknowledges the exact server receipt after enqueue commits", async () => {
    await mountSubmission();
    if (mountedSubmit === undefined) throw new Error("submission hook did not mount");
    const publicId = await mountedSubmit({
      executionDevicePublicId: "device_daemon01",
      payload: { kind: "stop" },
      sessionPublicId: "session_00000001",
    });
    expect(mutationCalls).toHaveLength(2);
    const enqueueArgs = mutationCalls[0]?.args as {
      idempotencyKey: string;
      publicId: string;
      requestDigest: string;
    };
    expect(publicId).toBe(enqueueArgs.publicId);
    expect(mutationCalls[1]).toEqual({
      args: {
        commandPublicId: publicId,
        idempotencyKey: enqueueArgs.idempotencyKey,
        requestDigest: enqueueArgs.requestDigest,
      },
      reference: functions.acknowledgeCommandReceipt,
    });
  });

  test("returns the committed identity when acknowledgement must recover later", async () => {
    acknowledgementFailure = new Error("acknowledgement unavailable");
    await mountSubmission();
    if (mountedSubmit === undefined) throw new Error("submission hook did not mount");
    const publicId = await mountedSubmit({
      executionDevicePublicId: "device_daemon01",
      payload: { kind: "stop" },
      sessionPublicId: "session_00000001",
    });
    expect(publicId).toBe((mutationCalls[0]?.args as { publicId: string }).publicId);
    expect(mutationCalls).toHaveLength(2);
    expect(reportedFailures).toEqual([acknowledgementFailure]);
  });

  test("keeps a committed identity but does not acknowledge an incompatible success", async () => {
    malformedEnqueueResponse = true;
    await mountSubmission();
    if (mountedSubmit === undefined) throw new Error("submission hook did not mount");
    const publicId = await mountedSubmit({
      executionDevicePublicId: "device_daemon01",
      payload: { kind: "stop" },
      sessionPublicId: "session_00000001",
    });
    expect(publicId).toBe((mutationCalls[0]?.args as { publicId: string }).publicId);
    expect(mutationCalls).toHaveLength(1);
    expect(reportedFailures).toEqual([]);
  });
});
