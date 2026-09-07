import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

const publicId = "018bcfe5-6800-7000-8000-000000000001";
const commandRecord = {
  createdAt: 1_760_000_000_000,
  deadline: 1_760_000_060_000,
  kind: "session_start",
  publicId,
  state: "pending",
  updatedAt: 1_760_000_000_000,
} as const;
const queryArgs: unknown[] = [];
const reportedFailures: unknown[] = [];
const unavailableCommands: string[] = [];
let queryResult: unknown = commandRecord;
let mutationCalls = 0;
const observedMutations: Readonly<{ args: unknown; reference: unknown }>[] = [];
let mutationImplementation: (reference: unknown, args: unknown) => Promise<unknown> = async () => {
  throw new Error("unexpected client mutation");
};
const functionReferences = await import("./functions");

await mock.module("convex/react", () => ({
  useConvex: () => ({
    mutation: async (reference: unknown, args: unknown) => {
      mutationCalls += 1;
      observedMutations.push({ args, reference });
      return await mutationImplementation(reference, args);
    },
  }),
  useQuery: (_reference: unknown, args: unknown) => {
    queryArgs.push(args);
    if (args === "skip") return undefined;
    return queryResult;
  },
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

const { useDeviceCommandTracker, useSubmitDeviceCommand } = await import("./device-commands");

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
  mountedSubmit = undefined;
  mountedSetHandle = undefined;
  mutationCalls = 0;
  mutationImplementation = async () => { throw new Error("unexpected client mutation"); };
  observedMutations.length = 0;
  queryArgs.length = 0;
  queryResult = commandRecord;
  reportedFailures.length = 0;
  unavailableCommands.length = 0;
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

async function renderMounted(node: ReactNode): Promise<HTMLElement> {
  const container = document.getElementById("root");
  if (!(container instanceof HTMLElement)) throw new Error("missing test root");
  mountedRoot ??= createRoot(container);
  await act(async () => {
    mountedRoot?.render(node);
    await Promise.resolve();
  });
  return container;
}

type TestCommandHandle = Readonly<{ publicId: string; responseValidated: boolean }>;
let mountedSetHandle: ((handle: TestCommandHandle | null) => void) | undefined;

function MountedObservation() {
  const { observation, setHandle } = useDeviceCommandTracker((commandPublicId) => {
    unavailableCommands.push(commandPublicId);
  });
  mountedSetHandle = setHandle;
  return (
    <div>
      <p data-testid="status">{observation.status}</p>
      <p data-testid="record">{observation.record?.publicId ?? "none"}</p>
      {observation.protocolWarning === null
        ? null
        : <p data-testid="protocol-warning">{observation.protocolWarning}</p>}
    </div>
  );
}

let mountedSubmit: ReturnType<typeof useSubmitDeviceCommand> | undefined;

function MountedSubmission() {
  mountedSubmit = useSubmitDeviceCommand();
  return null;
}

describe("mounted device command observation", () => {
  test("observes a resolved enqueue without running a client acknowledgement effect", async () => {
    const container = await renderMounted(<MountedObservation />);
    if (mountedSetHandle === undefined) throw new Error("command tracker did not mount");
    await act(async () => {
      mountedSetHandle?.({ publicId, responseValidated: true });
      await Promise.resolve();
    });
    expect(container.textContent).toContain(publicId);
    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe("present");
    expect(queryArgs).toContainEqual({ commandPublicId: publicId });
    expect(mutationCalls).toBe(0);
  });

  test("has no receipt recovery subscription before a valid enqueue response", async () => {
    const container = await renderMounted(<MountedObservation />);
    expect(container.textContent).toContain("none");
    expect(queryArgs).toEqual(["skip"]);
    expect(mutationCalls).toBe(0);
  });

  test("keeps loading inert then releases an authoritatively missing committed handle", async () => {
    queryResult = undefined;
    const container = await renderMounted(<MountedObservation />);
    if (mountedSetHandle === undefined) throw new Error("command tracker did not mount");
    await act(async () => {
      mountedSetHandle?.({ publicId, responseValidated: true });
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe("loading");
    expect(unavailableCommands).toEqual([]);

    queryResult = null;
    await renderMounted(<MountedObservation />);
    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe("idle");
    expect(unavailableCommands).toEqual([publicId]);
    expect(mutationCalls).toBe(0);
  });

  test("clears a committed protocol warning when the exact row becomes present", async () => {
    queryResult = undefined;
    const container = await renderMounted(<MountedObservation />);
    if (mountedSetHandle === undefined) throw new Error("command tracker did not mount");
    await act(async () => {
      mountedSetHandle?.({ publicId, responseValidated: false });
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe("loading");
    expect(container.querySelector('[data-testid="protocol-warning"]')?.textContent)
      .toContain("incompatible receipt");

    queryResult = commandRecord;
    await renderMounted(<MountedObservation />);
    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe("present");
    expect(container.querySelector('[data-testid="protocol-warning"]')).toBeNull();
    expect(unavailableCommands).toEqual([]);
    expect(mutationCalls).toBe(0);
  });

  test("reports a production plain authority abort through browser custody", async () => {
    const authorityFailure = new Error(
      "[CONVEX M(deviceCommands:enqueue)] Uncaught Error: Cloud authority is not current.\n"
        + "  Called by client",
    );
    mutationImplementation = async () => { throw authorityFailure; };
    await renderMounted(<MountedSubmission />);

    if (mountedSubmit === undefined) throw new Error("submission hook did not mount");
    await expect(mountedSubmit({
      payload: { kind: "usage_refresh" },
      targetDevicePublicId: "device_daemon01",
    })).rejects.toBe(authorityFailure);
    expect(mutationCalls).toBe(1);
    expect(reportedFailures).toEqual([authorityFailure]);
  });

  test("acknowledges the exact device receipt only after enqueue success", async () => {
    mutationImplementation = async (reference, args) => {
      const request = args as Record<string, unknown>;
      if (reference === functionReferences.enqueueDeviceCommand) {
        return {
          publicId: request.publicId,
          requestCommitmentVersion: 2,
          replay: false,
          requestingDevicePublicId: request.expectedRequestingDevicePublicId,
          state: "pending",
          targetDevicePublicId: request.expectedTargetDevicePublicId,
        };
      }
      if (reference === functionReferences.acknowledgeDeviceCommandReceipt) {
        return { acknowledgedAt: Date.now(), publicId: request.commandPublicId, replay: false };
      }
      throw new Error("unexpected mutation reference");
    };
    await renderMounted(<MountedSubmission />);
    if (mountedSubmit === undefined) throw new Error("submission hook did not mount");
    const submitted = await mountedSubmit({
      payload: { kind: "usage_refresh" },
      targetDevicePublicId: "device_daemon01",
    });
    expect(submitted).toBe((observedMutations[0]?.args as { publicId: string }).publicId);
    expect(observedMutations).toHaveLength(2);
    expect(observedMutations[1]).toEqual({
      args: {
        commandPublicId: submitted,
        idempotencyKey: (observedMutations[0]?.args as { idempotencyKey: string }).idempotencyKey,
        requestDigest: (observedMutations[0]?.args as { requestDigest: string }).requestDigest,
      },
      reference: functionReferences.acknowledgeDeviceCommandReceipt,
    });
  });

  test("returns the committed identity when post-receipt acknowledgement fails", async () => {
    const acknowledgementFailure = new Error("acknowledgement unavailable");
    mutationImplementation = async (reference, args) => {
      const request = args as Record<string, unknown>;
      if (reference === functionReferences.enqueueDeviceCommand) {
        return {
          publicId: request.publicId,
          requestCommitmentVersion: 2,
          replay: false,
          requestingDevicePublicId: request.expectedRequestingDevicePublicId,
          state: "pending",
          targetDevicePublicId: request.expectedTargetDevicePublicId,
        };
      }
      throw acknowledgementFailure;
    };
    await renderMounted(<MountedSubmission />);
    if (mountedSubmit === undefined) throw new Error("submission hook did not mount");
    const submitted = await mountedSubmit({
      payload: { kind: "usage_refresh" },
      targetDevicePublicId: "device_daemon01",
    });
    expect(submitted).toBe((observedMutations[0]?.args as { publicId: string }).publicId);
    expect(mutationCalls).toBe(2);
    expect(reportedFailures).toEqual([acknowledgementFailure]);
  });
});
