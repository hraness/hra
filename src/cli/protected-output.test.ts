import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  closeSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEVICE_LOGIN_DOCUMENT_MAXIMUM_BYTES,
  inspectProtectedOutputDarwinDescriptorAcl,
  loadProtectedOutputNativeAclLibrary,
  loadProtectedOutputNativeOpenAtLibrary,
  parseAccountLoginResponse,
  parseProtectedOutputDarwinAclResult,
  parseProtectedInteractionDetailResponse,
  protectedOutputAclLibrariesForPlatform,
  protectedOutputAclPolicyForPlatform,
  protectedOutputOpenAtLibrariesForPlatform,
  ProtectedOutputError,
  ProtectedOutputFile,
  type DeviceLoginDocument,
  type ProtectedOutputAclInspection,
  type ProtectedOutputNativeAclLibrary,
} from "./protected-output";
import {
  PROTECTED_INTERACTION_DETAIL_MAXIMUM_BYTES,
  encodeProtectedInteractionDetailDocument,
  type ProtectedInteractionDetailDocument,
} from "../domain/interactions";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

const protectedFile = (): Readonly<{ path: string; root: string }> => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "hra-protected-output-"));
  roots.push(root);
  chmodSync(root, 0o700);
  const path = join(root, "login.json");
  const descriptor = openSync(path, "wx", 0o600);
  closeSync(descriptor);
  return { path, root };
};

const document = (label = "Personal"): DeviceLoginDocument => ({
  accountId: `acct_${"1".repeat(32)}`,
  accountLabel: label,
  cancelCommand: `hra account login-cancel acct_${"1".repeat(32)}`,
  method: "device_code",
  type: "codex_device_login",
  userCode: "PRIVATE-CODE",
  verificationUrl: "https://example.test/device?secret=private",
  version: 1,
});

const approvalDocument = (): ProtectedInteractionDetailDocument => ({
  type: "hra_protected_interaction_detail",
  version: 1,
  binding: {
    interactionId: "40000000-0000-4000-8000-000000000001",
    revision: 3,
    kind: "command_approval",
    sessionId: `sess_${"2".repeat(32)}`,
    profileId: `acct_${"1".repeat(32)}`,
    processGeneration: 4,
    connectionId: "40000000-0000-4000-8000-000000000002",
  },
  authority: {
    kind: "command_approval",
    command: "git reset --hard PRIVATE-APPROVAL-SENTINEL",
    reason: "Apply the reviewed reset",
    availableDecisions: ["accept", "decline", "cancel"],
    workingDirectory: "/private/workspace",
    environmentId: "environment-1",
    commandActions: [{ type: "unknown", command: "git reset --hard PRIVATE-APPROVAL-SENTINEL" }],
    networkApprovalContext: null,
    additionalPermissions: null,
    proposedExecpolicyAmendment: null,
    proposedNetworkPolicyAmendments: null,
  },
});

const approvalDocumentAtBytes = (targetBytes: number): ProtectedInteractionDetailDocument => {
  const base = approvalDocument();
  const empty = {
    ...base,
    authority: { ...base.authority, additionalPermissions: "" },
  } as ProtectedInteractionDetailDocument;
  const emptyBytes = encodeProtectedInteractionDetailDocument(empty);
  const fillerBytes = targetBytes - emptyBytes.byteLength;
  emptyBytes.fill(0);
  if (fillerBytes < 0) throw new Error("Protected document target is too small.");
  return {
    ...empty,
    authority: { ...empty.authority, additionalPermissions: "a".repeat(fillerBytes) },
  } as ProtectedInteractionDetailDocument;
};

type FakeDarwinAclState = Readonly<{
  inspection: ProtectedOutputAclInspection | ((probe: number) => ProtectedOutputAclInspection);
}>;

const fakeDarwinAcl = (
  initial: Partial<FakeDarwinAclState> = {},
): Readonly<{
  calls: { descriptors: number[] };
  inspect: (descriptor: number) => ProtectedOutputAclInspection;
  state: { inspection: FakeDarwinAclState["inspection"] };
}> => {
  const state: { inspection: FakeDarwinAclState["inspection"] } = {
    inspection: "clear",
    ...initial,
  };
  const calls = { descriptors: [] as number[] };
  const inspect = (descriptor: number): ProtectedOutputAclInspection => {
    calls.descriptors.push(descriptor);
    const probe = calls.descriptors.length;
    return typeof state.inspection === "function"
      ? state.inspection(probe)
      : state.inspection;
  };
  return { calls, inspect, state };
};

const darwinAclResult = (words: readonly number[]): Uint8Array => {
  const result = new Uint8Array(32);
  new Uint32Array(result.buffer).set(words);
  return result;
};

describe("protected login output", () => {
  test("selects glibc and musl openat authorities and fails closed after bounded loader attempts", () => {
    expect(protectedOutputAclPolicyForPlatform("darwin")).toBe(
      "darwin_descriptor_extended_acl",
    );
    expect(protectedOutputAclPolicyForPlatform("linux")).toBe("linux_mode_acl_mask");
    expect(protectedOutputAclPolicyForPlatform("win32")).toBeNull();
    expect(protectedOutputAclLibrariesForPlatform("darwin")).toEqual([
      "/usr/lib/libSystem.B.dylib",
    ]);
    expect(protectedOutputAclLibrariesForPlatform("linux")).toEqual([]);
    expect(protectedOutputOpenAtLibrariesForPlatform("darwin", "arm64")).toEqual([
      "/usr/lib/libSystem.B.dylib",
    ]);
    expect(protectedOutputOpenAtLibrariesForPlatform("linux", "x64")).toEqual([
      "libc.so.6",
      "libc.musl-x86_64.so.1",
      "/lib/libc.musl-x86_64.so.1",
      "/usr/lib/libc.musl-x86_64.so.1",
    ]);
    expect(protectedOutputOpenAtLibrariesForPlatform("linux", "arm64")).toEqual([
      "libc.so.6",
      "libc.musl-aarch64.so.1",
      "/lib/libc.musl-aarch64.so.1",
      "/usr/lib/libc.musl-aarch64.so.1",
    ]);
    expect(protectedOutputOpenAtLibrariesForPlatform("linux", "riscv64")).toEqual([
      "libc.so.6",
    ]);
    expect(protectedOutputOpenAtLibrariesForPlatform("win32", "x64")).toEqual([]);

    const attempts: string[] = [];
    expect(loadProtectedOutputNativeOpenAtLibrary("linux", "x64", (library) => {
      attempts.push(library);
      throw new Error("not installed");
    })).toBeNull();
    expect(attempts).toEqual([
      ...protectedOutputOpenAtLibrariesForPlatform("linux", "x64"),
    ]);
    const aclAttempts: string[] = [];
    expect(loadProtectedOutputNativeAclLibrary("darwin", (library) => {
      aclAttempts.push(library);
      throw new Error("not installed");
    })).toBeNull();
    expect(aclAttempts).toEqual(["/usr/lib/libSystem.B.dylib"]);

    const target = protectedFile();
    let protectedRequests = 0;
    expect(() => new ProtectedOutputFile(target.path, {
      loadNativeOpenAtLibrary: () => {
        protectedRequests += 1;
        return null;
      },
    })).toThrow(new ProtectedOutputError("unsupported"));
    expect(protectedRequests).toBe(1);
    expect(readFileSync(target.path, "utf8")).toBe("");
  });

  test("uses descriptor ACLs on Darwin and Linux mode-mask semantics explicitly", () => {
    for (const value of [document(), approvalDocument()]) {
      const target = protectedFile();
      const acl = fakeDarwinAcl();
      const output = new ProtectedOutputFile(target.path, {
        inspectDescriptorExtendedAcl: acl.inspect,
        platform: "darwin",
      });
      try {
        output.write(value);
      } finally {
        output.close();
      }
      expect(acl.calls.descriptors).toHaveLength(6);
      expect(JSON.parse(readFileSync(target.path, "utf8"))).toEqual(value);
    }

    const linuxTarget = protectedFile();
    let aclInspections = 0;
    const linuxOutput = new ProtectedOutputFile(linuxTarget.path, {
      inspectDescriptorExtendedAcl: () => {
        aclInspections += 1;
        return "indeterminate";
      },
      platform: "linux",
    });
    try {
      linuxOutput.write(document());
    } finally {
      linuxOutput.close();
    }
    expect(aclInspections).toBe(0);
    expect(JSON.parse(readFileSync(linuxTarget.path, "utf8"))).toEqual(document());
  });

  test("parses the closed Darwin fgetattrlist ACL result and request shape", () => {
    const clear32 = darwinAclResult([32, 0x80000000, 0, 0, 0, 0, 0, 0]);
    const clear24 = darwinAclResult([24, 0x80000000, 0, 0, 0, 0, 0, 0]);
    const present = darwinAclResult([100, 0x80400000, 0, 0, 0, 0, 8, 68]);
    expect(parseProtectedOutputDarwinAclResult(0, clear32)).toBe("clear");
    expect(parseProtectedOutputDarwinAclResult(0, clear24)).toBe("indeterminate");
    expect(parseProtectedOutputDarwinAclResult(0, present)).toBe("present");
    for (const [returnCode, result] of [
      [-1, clear32],
      [0, new Uint8Array(28)],
      [0, darwinAclResult([23, 0x80000000, 0, 0, 0, 0, 0, 0])],
      [0, darwinAclResult([32, 0, 0, 0, 0, 0, 0, 0])],
      [0, darwinAclResult([32, 0x80000000, 1, 0, 0, 0, 0, 0])],
      [0, darwinAclResult([32, 0x80000000, 0, 0, 0, 0, 1, 0])],
    ] as const) {
      expect(parseProtectedOutputDarwinAclResult(returnCode, result)).toBe("indeterminate");
    }

    const calls: unknown[] = [];
    const library: ProtectedOutputNativeAclLibrary = {
      symbols: {
        fgetattrlist: (descriptor, attributes, result, resultSize, options) => {
          calls.push({
            descriptor,
            groups: [...new Uint32Array(attributes.buffer, attributes.byteOffset + 4, 5)],
            header: [...new Uint16Array(attributes.buffer, attributes.byteOffset, 2)],
            options,
            resultSize,
          });
          new Uint32Array(result.buffer, result.byteOffset, 8).set([
            32,
            0x80000000,
            0,
            0,
            0,
            0,
            0,
            0,
          ]);
          return 0;
        },
      },
    };
    expect(inspectProtectedOutputDarwinDescriptorAcl(17, () => library)).toBe("clear");
    expect(calls).toEqual([{
      descriptor: 17,
      groups: [0x80400000, 0, 0, 0, 0],
      header: [5, 0],
      options: 4,
      resultSize: 32,
    }]);
    expect(inspectProtectedOutputDarwinDescriptorAcl(17, () => null)).toBe(
      "indeterminate",
    );
    expect(inspectProtectedOutputDarwinDescriptorAcl(17, () => ({
      symbols: { fgetattrlist: () => { throw new Error("native failure"); } },
    }))).toBe("indeterminate");
  });

  test("rejects Darwin extended ACLs and incomplete native proofs before admission", () => {
    const parentAcl = protectedFile();
    const parentNative = fakeDarwinAcl({ inspection: "present" });
    expect(() => new ProtectedOutputFile(parentAcl.path, {
      inspectDescriptorExtendedAcl: parentNative.inspect,
      platform: "darwin",
    })).toThrow(new ProtectedOutputError("parent_invalid"));
    expect(parentNative.calls.descriptors).toHaveLength(1);
    expect(readFileSync(parentAcl.path, "utf8")).toBe("");

    const documentAcl = protectedFile();
    const documentNative = fakeDarwinAcl({
      inspection: (probe) => probe === 2 ? "present" : "clear",
    });
    expect(() => new ProtectedOutputFile(documentAcl.path, {
      inspectDescriptorExtendedAcl: documentNative.inspect,
      platform: "darwin",
    })).toThrow(new ProtectedOutputError("file_invalid"));
    expect(documentNative.calls.descriptors).toHaveLength(2);
    expect(readFileSync(documentAcl.path, "utf8")).toBe("");

    for (const inspect of [
      () => "indeterminate" as const,
      () => { throw new Error("native failure"); },
    ]) {
      const target = protectedFile();
      expect(() => new ProtectedOutputFile(target.path, {
        inspectDescriptorExtendedAcl: inspect,
        platform: "darwin",
      })).toThrow(new ProtectedOutputError("unsupported"));
      expect(readFileSync(target.path, "utf8")).toBe("");
    }
  });

  test("re-proves Darwin ACL absence immediately before and after private writes", () => {
    const prewrite = protectedFile();
    const prewriteNative = fakeDarwinAcl();
    const prewriteOutput = new ProtectedOutputFile(prewrite.path, {
      beforeWrite: () => { prewriteNative.state.inspection = "present"; },
      inspectDescriptorExtendedAcl: prewriteNative.inspect,
      platform: "darwin",
    });
    try {
      expect(() => prewriteOutput.write(document())).toThrow(
        new ProtectedOutputError("binding_changed"),
      );
    } finally {
      prewriteOutput.close();
    }
    expect(prewriteNative.calls.descriptors).toHaveLength(3);
    expect(readFileSync(prewrite.path, "utf8")).toBe("");

    const postwrite = protectedFile();
    const postwriteNative = fakeDarwinAcl();
    const postwriteOutput = new ProtectedOutputFile(postwrite.path, {
      beforePostflight: () => { postwriteNative.state.inspection = "present"; },
      inspectDescriptorExtendedAcl: postwriteNative.inspect,
      platform: "darwin",
    });
    try {
      expect(() => postwriteOutput.write(approvalDocument())).toThrow(
        new ProtectedOutputError("write_unproven"),
      );
    } finally {
      postwriteOutput.close();
    }
    expect(postwriteNative.calls.descriptors).toHaveLength(5);
    expect(readFileSync(postwrite.path, "utf8")).toContain("PRIVATE-APPROVAL-SENTINEL");
  });

  test("strictly classifies one-time handoffs and secret-free same-key replays", () => {
    const idempotencyKey = "00000000-0000-4000-8000-000000000101";
    const account = {
      id: `acct_${"1".repeat(32)}`,
      label: "Personal",
      processGeneration: 1,
      state: "login_pending" as const,
      updatedAt: 1,
    };
    expect(parseAccountLoginResponse({
      account,
      idempotencyKey,
      login: {
        loginId: "provider-login",
        next: `hra account login-cancel ${account.id}`,
        status: "pending",
        userCode: "PRIVATE-CODE",
        verificationUrl: "https://example.test/device?private=1",
      },
    }, { accountId: account.id, deviceCode: true, idempotencyKey })).toMatchObject({
      document: { type: "codex_device_login", userCode: "PRIVATE-CODE", version: 1 },
      kind: "handoff",
    });
    expect(parseAccountLoginResponse({
      account,
      idempotencyKey,
      login: {
        loginId: "provider-login",
        next: `hra account login-cancel ${account.id}`,
        status: "pending",
      },
    }, { accountId: account.id, deviceCode: true, idempotencyKey })).toMatchObject({ kind: "pending_replay" });
    expect(parseAccountLoginResponse({
      account: { ...account, state: "signed_out" },
      idempotencyKey,
      login: { outcome: "signed_out", status: "settled" },
    }, { accountId: account.id, deviceCode: true, idempotencyKey })).toMatchObject({
      kind: "settled",
    });
    expect(() => parseAccountLoginResponse({
      account,
      idempotencyKey,
      login: {
        loginId: "provider-login",
        next: "cancel",
        status: "pending",
        verificationUrl: "https://example.test/device",
      },
    }, { accountId: account.id, deviceCode: true, idempotencyKey })).toThrow(ProtectedOutputError);

    for (const invalid of [
      {
        account: { ...account, id: `acct_${"2".repeat(32)}` },
        login: {
          loginId: "provider-login",
          next: `hra account login-cancel acct_${"2".repeat(32)}`,
          status: "pending" as const,
          userCode: "ABCD-EFGH",
          verificationUrl: "https://example.test/device",
        },
      },
      {
        account: { ...account, state: "signed_out" as const },
        login: {
          loginId: "provider-login",
          next: `hra account login-cancel ${account.id}`,
          status: "pending" as const,
          userCode: "ABCD-EFGH",
          verificationUrl: "https://example.test/device",
        },
      },
      {
        account,
        login: {
          loginId: "provider-login",
          next: "hra account login-cancel acct_22222222222222222222222222222222",
          status: "pending" as const,
          userCode: "ABCD-EFGH",
          verificationUrl: "https://example.test/device",
        },
      },
      {
        account,
        login: {
          loginId: "provider-login",
          next: `hra account login-cancel ${account.id}`,
          status: "pending" as const,
          userCode: "not a device code",
          verificationUrl: "https://example.test/device",
        },
      },
      {
        account,
        login: {
          loginId: "provider-login",
          next: `hra account login-cancel ${account.id}`,
          status: "pending" as const,
          userCode: "ABCD-EFGH",
          verificationUrl: "http://attacker.example/device",
        },
      },
    ]) {
      expect(() => parseAccountLoginResponse({
        account: invalid.account,
        idempotencyKey,
        login: invalid.login,
      }, { accountId: account.id, deviceCode: true, idempotencyKey })).toThrow(
        ProtectedOutputError,
      );
    }
  });

  test("writes, fsyncs, reads back, and preserves one bounded versioned document", () => {
    const target = protectedFile();
    const output = new ProtectedOutputFile(target.path);
    try {
      output.write(document());
    } finally {
      output.close();
    }
    expect(JSON.parse(readFileSync(target.path, "utf8"))).toEqual(document());
  });

  test("binds and writes complete private interaction authority without a generic projection", () => {
    const protectedDocument = approvalDocument();
    expect(parseProtectedInteractionDetailResponse(protectedDocument, {
      interactionId: protectedDocument.binding.interactionId,
      revision: protectedDocument.binding.revision,
    })).toEqual(protectedDocument);
    expect(() => parseProtectedInteractionDetailResponse(protectedDocument, {
      interactionId: protectedDocument.binding.interactionId,
      revision: protectedDocument.binding.revision + 1,
    })).toThrow(ProtectedOutputError);
    expect(() => parseProtectedInteractionDetailResponse({
      ...protectedDocument,
      binding: { ...protectedDocument.binding, kind: "permission_approval" },
    }, {
      interactionId: protectedDocument.binding.interactionId,
      revision: protectedDocument.binding.revision,
    })).toThrow(ProtectedOutputError);

    const target = protectedFile();
    const output = new ProtectedOutputFile(target.path);
    try {
      output.write(protectedDocument);
    } finally {
      output.close();
    }
    expect(JSON.parse(readFileSync(target.path, "utf8"))).toEqual(protectedDocument);
  });

  test("uses one newline-inclusive exact byte limit for parsing and protected files", () => {
    const exact = approvalDocumentAtBytes(PROTECTED_INTERACTION_DETAIL_MAXIMUM_BYTES);
    const oversized = approvalDocumentAtBytes(PROTECTED_INTERACTION_DETAIL_MAXIMUM_BYTES + 1);
    const exactBytes = encodeProtectedInteractionDetailDocument(exact);
    const oversizedBytes = encodeProtectedInteractionDetailDocument(oversized);
    expect(exactBytes.byteLength).toBe(PROTECTED_INTERACTION_DETAIL_MAXIMUM_BYTES);
    expect(oversizedBytes.byteLength).toBe(PROTECTED_INTERACTION_DETAIL_MAXIMUM_BYTES + 1);
    exactBytes.fill(0);
    oversizedBytes.fill(0);
    expect(parseProtectedInteractionDetailResponse(exact, {
      interactionId: exact.binding.interactionId,
      revision: exact.binding.revision,
    })).toEqual(exact);
    expect(() => parseProtectedInteractionDetailResponse(oversized, {
      interactionId: oversized.binding.interactionId,
      revision: oversized.binding.revision,
    })).toThrow(ProtectedOutputError);

    const accepted = protectedFile();
    const acceptedOutput = new ProtectedOutputFile(accepted.path);
    try {
      expect(() => acceptedOutput.write(exact)).not.toThrow();
    } finally {
      acceptedOutput.close();
    }
    expect(Buffer.byteLength(readFileSync(accepted.path))).toBe(
      PROTECTED_INTERACTION_DETAIL_MAXIMUM_BYTES,
    );

    const rejected = protectedFile();
    const rejectedOutput = new ProtectedOutputFile(rejected.path);
    try {
      expect(() => rejectedOutput.write(oversized)).toThrow(ProtectedOutputError);
    } finally {
      rejectedOutput.close();
    }
    expect(readFileSync(rejected.path, "utf8")).toBe("");
  });

  test("rejects unsafe parents and children before accepting an output descriptor", () => {
    const nonempty = protectedFile();
    writeFileSync(nonempty.path, "occupied");
    expect(() => new ProtectedOutputFile(nonempty.path)).toThrow(ProtectedOutputError);

    const wrongMode = protectedFile();
    chmodSync(wrongMode.path, 0o644);
    expect(() => new ProtectedOutputFile(wrongMode.path)).toThrow(ProtectedOutputError);

    const linked = protectedFile();
    linkSync(linked.path, join(linked.root, "second-link"));
    expect(() => new ProtectedOutputFile(linked.path)).toThrow(ProtectedOutputError);

    const symbolic = protectedFile();
    const real = join(symbolic.root, "real.json");
    renameSync(symbolic.path, real);
    symlinkSync(real, symbolic.path);
    expect(() => new ProtectedOutputFile(symbolic.path)).toThrow(ProtectedOutputError);

    const parentMode = protectedFile();
    chmodSync(parentMode.root, 0o755);
    expect(() => new ProtectedOutputFile(parentMode.path)).toThrow(ProtectedOutputError);
    expect(() => new ProtectedOutputFile("relative/login.json")).toThrow(ProtectedOutputError);
  });

  test("detects parent and child substitution without writing to the rebound path", () => {
    const parentRace = protectedFile();
    const movedParent = `${parentRace.root}-moved`;
    roots.push(movedParent);
    const parentOutput = new ProtectedOutputFile(parentRace.path, {
      beforeWrite: () => {
        renameSync(parentRace.root, movedParent);
        mkdirSync(parentRace.root, { mode: 0o700 });
        const replacement = openSync(parentRace.path, "wx", 0o600);
        closeSync(replacement);
      },
    });
    try {
      expect(() => parentOutput.write(document())).toThrow(ProtectedOutputError);
    } finally {
      parentOutput.close();
    }
    expect(readFileSync(parentRace.path, "utf8")).toBe("");
    expect(readFileSync(join(movedParent, "login.json"), "utf8")).toBe("");

    const childRace = protectedFile();
    const movedChild = join(childRace.root, "moved.json");
    const childOutput = new ProtectedOutputFile(childRace.path, {
      beforePostflight: () => {
        renameSync(childRace.path, movedChild);
        const replacement = openSync(childRace.path, "wx", 0o600);
        closeSync(replacement);
      },
    });
    try {
      expect(() => childOutput.write(document())).toThrow(ProtectedOutputError);
    } finally {
      childOutput.close();
    }
    expect(readFileSync(childRace.path, "utf8")).toBe("");
    expect(readFileSync(movedChild, "utf8")).toContain("PRIVATE-CODE");
  });

  test("accepts the exact document byte bound and rejects one byte more", () => {
    const baseline = document("");
    const baselineBytes = Buffer.byteLength(`${JSON.stringify(baseline)}\n`, "utf8");
    const exact = document("a".repeat(DEVICE_LOGIN_DOCUMENT_MAXIMUM_BYTES - baselineBytes));
    expect(Buffer.byteLength(`${JSON.stringify(exact)}\n`, "utf8")).toBe(
      DEVICE_LOGIN_DOCUMENT_MAXIMUM_BYTES,
    );
    const accepted = protectedFile();
    const acceptedOutput = new ProtectedOutputFile(accepted.path);
    try {
      expect(() => acceptedOutput.write(exact)).not.toThrow();
    } finally {
      acceptedOutput.close();
    }

    const rejected = protectedFile();
    const rejectedOutput = new ProtectedOutputFile(rejected.path);
    try {
      expect(() => rejectedOutput.write({
        ...exact,
        accountLabel: `${exact.accountLabel}a`,
      })).toThrow(ProtectedOutputError);
    } finally {
      rejectedOutput.close();
    }
    expect(readFileSync(rejected.path, "utf8")).toBe("");
  });
});
