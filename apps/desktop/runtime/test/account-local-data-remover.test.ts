import { describe, expect, test } from "bun:test";

import {
  AccountProfileFileSystemError,
  NativeAccountProfileFileSystem,
  type NativeAccountProfileRequestEnvelope,
  type NativeAccountProfileResult,
} from "../src/accounts/local-data-remover";

const controlPlanePath =
  "/Users/example/Library/Application Support/OPRTE/control-plane.sqlite";
const authority = {
  controlPlanePath,
  stateRoot: { device: "1", inode: "2" },
  controlPlane: { device: "1", inode: "3" },
} as const;
const deletionKey = new TextEncoder().encode(
  "0123456789abcdef0123456789abcdef",
);

describe("NativeAccountProfileFileSystem", () => {
  test("sends a bound private ensure request and accepts only its exact result", async () => {
    const requests: NativeAccountProfileRequestEnvelope[] = [];
    const fileSystem = new NativeAccountProfileFileSystem({
      authority,
      deletionKey,
      writeRequest: (request) => {
        requests.push(request);
        queueMicrotask(() => {
          fileSystem.complete(resultFor(request, true));
        });
        return Promise.resolve();
      },
    });

    await fileSystem.ensureAccountProfile("acct_fixture01");

    expect(requests).toHaveLength(1);
    const observed = requests[0];
    if (observed === undefined) throw new Error("expected a native request");
    expect(observed.request.id).toMatch(/^native-profile-[a-f0-9]{24}$/u);
    expect(observed.request.binding).toMatch(/^binding_[a-f0-9]{48}$/u);
    expect(observed).toEqual({
      kind: "accountProfileNativeRequest",
      version: 1,
      request: {
        id: observed.request.id,
        binding: observed.request.binding,
        action: "ensure",
        controlPlanePath,
        accountProfileId: "acct_fixture01",
        stateRootDevice: "1",
        stateRootInode: "2",
        controlPlaneDevice: "1",
        controlPlaneInode: "3",
      },
    });
    fileSystem.close();
  });

  test("binds deletion authorization to authority, account, and expected revision", async () => {
    const requests: NativeAccountProfileRequestEnvelope[] = [];
    const fileSystem = new NativeAccountProfileFileSystem({
      authority,
      deletionKey,
      writeRequest: (request) => {
        requests.push(request);
        queueMicrotask(() => {
          fileSystem.complete(resultFor(request, true));
        });
        return Promise.resolve();
      },
    });

    await fileSystem.deleteAccountHome("acct_fixture01", 7);

    expect(requests[0]?.request).toMatchObject({
      action: "delete",
      accountProfileId: "acct_fixture01",
      expectedRevision: 7,
      deletionNonce:
        "deletion_b8c57f52ad5424f0241f132382335a9ecddf89b01b316b5b23e0092c6861ecac",
    });
    fileSystem.close();
  });

  test("rejects mismatched and replayed results without completing the operation", async () => {
    const writes: NativeAccountProfileRequestEnvelope[] = [];
    const fileSystem = new NativeAccountProfileFileSystem({
      authority,
      deletionKey,
      timeoutMs: 250,
      writeRequest: (request) => {
        writes.push(request);
        return Promise.resolve();
      },
    });
    const operation = fileSystem.ensureAccountProfile("acct_fixture01");
    await Bun.sleep(0);
    const request = writes[0];
    if (request === undefined) throw new Error("expected a native request");

    expect(fileSystem.complete({
      ...resultFor(request, true),
      binding: "binding_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    })).toBeFalse();
    expect(fileSystem.complete({
      ...resultFor(request, true),
      accountProfileId: "acct_other0001",
    })).toBeFalse();
    expect(fileSystem.complete(resultFor(request, true))).toBeTrue();
    await operation;
    expect(fileSystem.complete(resultFor(request, true))).toBeFalse();
    fileSystem.close();
  });

  test("the hard deadline includes a writer that never settles", async () => {
    const fileSystem = new NativeAccountProfileFileSystem({
      authority,
      deletionKey,
      timeoutMs: 5,
      writeRequest: () => new Promise(() => undefined),
    });

    expect(await rejection(
      fileSystem.ensureAccountProfile("acct_fixture01"),
    )).toEqual(new AccountProfileFileSystemError("timeout"));
    fileSystem.close();
  });

  test("serializes Native operations before starting each deadline", async () => {
    const requests: NativeAccountProfileRequestEnvelope[] = [];
    const fileSystem = new NativeAccountProfileFileSystem({
      authority,
      deletionKey,
      timeoutMs: 250,
      writeRequest: (request) => {
        requests.push(request);
        return Promise.resolve();
      },
    });
    const operations = [
      fileSystem.ensureAccountProfile("acct_fixture01"),
      fileSystem.ensureAccountProfile("acct_fixture02"),
      fileSystem.ensureAccountProfile("acct_fixture03"),
    ];
    await Bun.sleep(0);
    expect(requests.map(({ request }) => request.accountProfileId)).toEqual([
      "acct_fixture01",
    ]);
    expect(fileSystem.complete(resultFor(requests[0]!, true))).toBeTrue();
    await Bun.sleep(0);
    expect(requests.map(({ request }) => request.accountProfileId)).toEqual([
      "acct_fixture01",
      "acct_fixture02",
    ]);
    expect(fileSystem.complete(resultFor(requests[1]!, true))).toBeTrue();
    await Bun.sleep(0);
    expect(requests.map(({ request }) => request.accountProfileId)).toEqual([
      "acct_fixture01",
      "acct_fixture02",
      "acct_fixture03",
    ]);
    expect(fileSystem.complete(resultFor(requests[2]!, true))).toBeTrue();
    await Promise.all(operations);
    fileSystem.close();
  });

  test("uses a short ensure deadline without shortening destructive deletion", async () => {
    const requests: NativeAccountProfileRequestEnvelope[] = [];
    const fileSystem = new NativeAccountProfileFileSystem({
      authority,
      deletionKey,
      ensureTimeoutMs: 5,
      deleteTimeoutMs: 250,
      writeRequest: (request) => {
        requests.push(request);
        return Promise.resolve();
      },
    });

    const ensure = fileSystem.ensureAccountProfile("acct_fixture01");
    const deletion = fileSystem.deleteAccountHome("acct_fixture02", 7);
    expect(await rejection(ensure)).toEqual(
      new AccountProfileFileSystemError("timeout"),
    );
    await Bun.sleep(0);
    expect(requests.map(({ request }) => request.action)).toEqual([
      "ensure",
      "delete",
    ]);
    const deletionRequest = requests.find(({ request }) => request.action === "delete");
    if (deletionRequest === undefined) throw new Error("expected deletion request");
    expect(fileSystem.complete(resultFor(deletionRequest, true))).toBeTrue();
    await deletion;
    fileSystem.close();
  });

  test("redacts transport/native failures and rejects malformed configuration", async () => {
    const transport = new NativeAccountProfileFileSystem({
      authority,
      deletionKey,
      writeRequest: () => Promise.reject(
        new Error("/Users/example/private"),
      ),
    });
    expect(await rejection(
      transport.ensureAccountProfile("acct_fixture01"),
    )).toEqual(new AccountProfileFileSystemError("transport_failed"));

    const native = new NativeAccountProfileFileSystem({
      authority,
      deletionKey,
      writeRequest: (request) => {
        queueMicrotask(() => native.complete(resultFor(request, false)));
        return Promise.resolve();
      },
    });
    expect(await rejection(
      native.deleteAccountHome("acct_fixture01", 1),
    )).toEqual(new AccountProfileFileSystemError("native_rejected"));
    expect(await rejection(
      native.deleteAccountHome("acct_fixture01", 0),
    )).toEqual(
      new AccountProfileFileSystemError("invalid_configuration"),
    );
    expect(() => new NativeAccountProfileFileSystem({
      authority: {
        ...authority,
        controlPlanePath: "/Users/example/../victim/control-plane.sqlite",
      },
      deletionKey,
      writeRequest: () => Promise.resolve(),
    })).toThrow(new AccountProfileFileSystemError("invalid_configuration"));
    transport.close();
    native.close();
  });
});

async function rejection(operation: Promise<unknown>): Promise<Error> {
  try {
    await operation;
  } catch (error: unknown) {
    if (error instanceof Error) return error;
    throw new Error("Expected a rejected Error");
  }
  throw new Error("Expected the operation to reject");
}

function resultFor(
  envelope: NativeAccountProfileRequestEnvelope,
  ok: boolean,
): NativeAccountProfileResult {
  return {
    kind: "accountProfileNativeResult",
    version: 1,
    nativeRequestId: envelope.request.id,
    binding: envelope.request.binding,
    action: envelope.request.action,
    accountProfileId: envelope.request.accountProfileId,
    ok,
  };
}
