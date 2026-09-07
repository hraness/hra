import { afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";

const sessionProof = {
  idempotencyKey: "018bcfe5-6800-7000-8000-000000000002",
  publicId: "018bcfe5-6800-7000-8000-000000000001",
  requestDigest: "a".repeat(64),
};
const deviceProof = {
  idempotencyKey: "018bcfe5-6800-7000-8000-000000000004",
  publicId: "018bcfe5-6800-7000-8000-000000000003",
  requestDigest: "b".repeat(64),
};
const queryCalls: Readonly<{ args: unknown; reference: unknown }>[] = [];
const mutationCalls: Readonly<{ args: unknown; reference: unknown }>[] = [];
const reportedFailures: unknown[] = [];
let sessionValue: unknown = [sessionProof];
let deviceValue: unknown = [deviceProof];
let queryFailure: Error | null = null;
let mutationFailure: Error | null = null;
let holdSessionAcknowledgement = false;
let settleSessionAcknowledgement: ((value: unknown) => void) | null = null;

const functions = await import("./functions");
const reportAuthorityFailure = (failure: unknown) => { reportedFailures.push(failure); };

const convexClient = {
  query: async (reference: unknown, args: unknown) => {
    queryCalls.push({ args, reference });
    if (queryFailure !== null) throw queryFailure;
    return reference === functions.commandListUnacknowledged ? sessionValue : deviceValue;
  },
  mutation: async (reference: unknown, args: unknown) => {
    mutationCalls.push({ args, reference });
    if (mutationFailure !== null) throw mutationFailure;
    const proof = args as { commandPublicId: string };
    if (reference === functions.acknowledgeCommandReceipt && holdSessionAcknowledgement) {
      holdSessionAcknowledgement = false;
      return await new Promise<unknown>((resolve) => { settleSessionAcknowledgement = resolve; });
    }
    return {
      acknowledgedAt: 1_760_000_000_000,
      publicId: proof.commandPublicId,
      replay: false,
    };
  },
};

await mock.module("convex/react", () => ({ useConvex: () => convexClient }));

await mock.module("../custody/custody-context", () => ({
  useCustody: () => ({
    reportAuthorityFailure,
    state: "unlocked",
  }),
}));

const { CommandReceiptRecovery } = await import("./command-receipt-recovery");

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
  deviceValue = [deviceProof];
  holdSessionAcknowledgement = false;
  mutationFailure = null;
  queryFailure = null;
  queryCalls.length = 0;
  mutationCalls.length = 0;
  reportedFailures.length = 0;
  sessionValue = [sessionProof];
  settleSessionAcknowledgement = null;
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

async function renderRecovery(strict = false): Promise<void> {
  const container = document.getElementById("root");
  if (!(container instanceof HTMLElement)) throw new Error("missing test root");
  mountedRoot ??= createRoot(container);
  await act(async () => {
    mountedRoot?.render(strict
      ? <StrictMode><CommandReceiptRecovery /></StrictMode>
      : <CommandReceiptRecovery />);
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("mounted command receipt recovery", () => {
  test("acknowledges both requester-observed proof families without enqueueing", async () => {
    await renderRecovery();
    expect(queryCalls.slice(0, 2)).toEqual([
      { args: { limit: 100 }, reference: functions.commandListUnacknowledged },
      { args: { limit: 100 }, reference: functions.deviceCommandListUnacknowledged },
    ]);
    expect(queryCalls.every((call) => (call.args as { limit?: unknown }).limit === 100)).toBe(true);
    expect(mutationCalls).toContainEqual({
      args: {
        commandPublicId: sessionProof.publicId,
        idempotencyKey: sessionProof.idempotencyKey,
        requestDigest: sessionProof.requestDigest,
      },
      reference: functions.acknowledgeCommandReceipt,
    });
    expect(mutationCalls).toContainEqual({
      args: {
        commandPublicId: deviceProof.publicId,
        idempotencyKey: deviceProof.idempotencyKey,
        requestDigest: deviceProof.requestDigest,
      },
      reference: functions.acknowledgeDeviceCommandReceipt,
    });
    expect(mutationCalls).toHaveLength(2);
    expect(reportedFailures).toEqual([]);
  });

  test("does nothing until the recovery reads have produced proof", async () => {
    sessionValue = undefined;
    deviceValue = undefined;
    await renderRecovery();
    expect(mutationCalls).toEqual([]);
  });

  test("reports a failed exact acknowledgement without issuing another command", async () => {
    deviceValue = [];
    const failure = new Error("Cloud authority is not current.");
    mutationFailure = failure;
    await renderRecovery();
    expect(mutationCalls).toEqual([{
      args: {
        commandPublicId: sessionProof.publicId,
        idempotencyKey: sessionProof.idempotencyKey,
        requestDigest: sessionProof.requestDigest,
      },
      reference: functions.acknowledgeCommandReceipt,
    }]);
    expect(reportedFailures).toEqual([failure]);
  });

  test("retries a failed exact acknowledgement only after bounded backoff", async () => {
    deviceValue = [];
    const failure = new Error("Cloud authority is temporarily unavailable.");
    mutationFailure = failure;
    jest.useFakeTimers();
    try {
      await renderRecovery();
      expect(mutationCalls).toHaveLength(1);
      mutationFailure = null;

      await act(async () => {
        jest.advanceTimersByTime(999);
        await Promise.resolve();
      });
      expect(mutationCalls).toHaveLength(1);

      await act(async () => {
        jest.advanceTimersByTime(1);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mutationCalls).toHaveLength(2);
      expect(mutationCalls[1]).toEqual(mutationCalls[0]);
      expect(reportedFailures).toEqual([failure]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("keeps each family sequential while a reactive page advances", async () => {
    const nextProof = {
      idempotencyKey: "018bcfe5-6800-7000-8000-000000000006",
      publicId: "018bcfe5-6800-7000-8000-000000000005",
      requestDigest: "c".repeat(64),
    };
    deviceValue = [];
    sessionValue = [sessionProof, nextProof];
    holdSessionAcknowledgement = true;
    await renderRecovery();
    expect(mutationCalls).toHaveLength(1);

    // The index may rerender with the next row exposed before the first
    // mutation promise settles. It must not start a second acknowledgement.
    sessionValue = [nextProof];
    await renderRecovery();
    expect(mutationCalls).toHaveLength(1);

    await act(async () => {
      settleSessionAcknowledgement?.({
        acknowledgedAt: 1_760_000_000_000,
        publicId: sessionProof.publicId,
        replay: false,
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mutationCalls).toHaveLength(2);
    expect(mutationCalls[1]).toEqual({
      args: {
        commandPublicId: nextProof.publicId,
        idempotencyKey: nextProof.idempotencyKey,
        requestDigest: nextProof.requestDigest,
      },
      reference: functions.acknowledgeCommandReceipt,
    });
  });

  test("keeps draining a static page after StrictMode replays effect setup", async () => {
    const nextProof = {
      idempotencyKey: "018bcfe5-6800-7000-8000-000000000006",
      publicId: "018bcfe5-6800-7000-8000-000000000005",
      requestDigest: "c".repeat(64),
    };
    deviceValue = [];
    sessionValue = [sessionProof, nextProof];
    await renderRecovery(true);
    expect(mutationCalls).toEqual([
      {
        args: {
          commandPublicId: sessionProof.publicId,
          idempotencyKey: sessionProof.idempotencyKey,
          requestDigest: sessionProof.requestDigest,
        },
        reference: functions.acknowledgeCommandReceipt,
      },
      {
        args: {
          commandPublicId: nextProof.publicId,
          idempotencyKey: nextProof.idempotencyKey,
          requestDigest: nextProof.requestDigest,
        },
        reference: functions.acknowledgeCommandReceipt,
      },
    ]);
  });

  test("keeps routed content mounted until predecessor deployments gain recovery queries", async () => {
    const missing = new Error("Could not find public function for command receipt recovery.");
    queryFailure = missing;
    jest.useFakeTimers();
    try {
      const container = document.getElementById("root");
      if (!(container instanceof HTMLElement)) throw new Error("missing test root");
      mountedRoot = createRoot(container);
      await act(async () => {
        mountedRoot?.render(
          <>
            <CommandReceiptRecovery />
            <p>Routed screen remains available.</p>
          </>,
        );
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(container.textContent).toContain("Routed screen remains available.");
      expect(queryCalls).toHaveLength(2);
      expect(mutationCalls).toEqual([]);
      expect(reportedFailures).toEqual([missing, missing]);

      queryFailure = null;
      await act(async () => {
        jest.advanceTimersByTime(1_000);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mutationCalls).toHaveLength(2);
    } finally {
      jest.useRealTimers();
    }
  });
});
