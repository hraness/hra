import { describe, expect, test } from "bun:test";

import type { ClaudeHostToolResponseWritten } from "../src/claude/index";
import { digestClaudeHostToolInvocation } from "../src/claude/index";
import type { HraHostToolCall } from "../src/codex/protocol";
import type { ProfileAuthority } from "../src/daemon/ports";
import { HRA_VERSION } from "../src/version";
import type { LiveAcceptanceCandidate } from "./live-acceptance-installation";
import {
  ClaudeLiveAcceptanceProofCollector,
  ClaudeLiveAcceptanceProofError,
  parseClaudeLiveAcceptanceFreshSessionScope,
  parseClaudeLiveAcceptancePrivateReceipt,
  parseClaudeLiveAcceptanceProvisionalPrivateReceipt,
  parseClaudeLiveAcceptanceSendCorroboration,
} from "./claude-live-acceptance-proof";

const runId = "00000000-0000-4000-8000-000000000801";
const profileId = `acct_${"1".repeat(32)}` as const;
const providerAccountId = `pact_${"1".repeat(32)}` as const;
const sessionId = `sess_${"2".repeat(32)}` as const;
const profileAuthority = {
  codexHome: "/tmp/claude-proof-synthetic/codex",
  desktopUserData: "/tmp/claude-proof-synthetic/desktop",
  generation: 7,
  id: profileId,
  provider: "claude",
  providerAccountId,
  bindingGeneration: 1,
} satisfies ProfileAuthority;
const candidate: LiveAcceptanceCandidate = {
  cloudTargetDigest: "3".repeat(64),
  packageVersion: HRA_VERSION,
  sourceRevision: "4".repeat(40),
};
const memory = {
  body: `Claude retained acceptance nonce ${runId}.`,
  key: "acceptance.claude.one_shot",
  summary: "One managed Claude callback reached durable memory.",
  title: "Claude one-shot acceptance",
} as const;
const request = { input: memory, tool: "memory_remember" } as const;
const callId = "acceptance-call-one";
const requestDigest = digestClaudeHostToolInvocation(callId, request);
const call: HraHostToolCall = {
  authority: { processGeneration: 7, profileId, provider: "claude", providerAccountId, bindingGeneration: 1 },
  callId,
  connectionId: "acceptance-connection-one",
  input: memory,
  requestDigest,
  requestId: { type: "string", value: callId },
  threadId: "acceptance-thread-one",
  tool: "memory_remember",
  turnId: "acceptance-turn-one",
};
const response: Readonly<Record<string, unknown>> = {
  idempotencyRetainedUntil: "2026-09-07T00:00:00.000Z",
  ok: true,
  page: {
    key: memory.key,
    operationSha256: "5".repeat(64),
    recordSha256: "6".repeat(64),
  },
  receiptSha256: "7".repeat(64),
  replay: false,
  submission: {
    id: `memsub_${"8".repeat(32)}`,
    kind: "remember",
    state: "applied",
  },
  version: 1,
  workingHead: {
    digest: "9".repeat(64),
    operationSha256: "5".repeat(64),
    sequence: 1,
  },
};
const written: ClaudeHostToolResponseWritten = {
  bindingId: "acceptance-binding-one",
  callId,
  processGeneration: 7,
  profileId,
  provider: "claude",
  providerThreadId: call.threadId,
  request,
  requestDigest,
};
const scope = {
  daemonGeneration: 11,
  memory,
  profileGeneration: 7,
  profileId,
  providerThreadId: call.threadId,
  sendIdempotencyKey: "00000000-0000-4000-8000-000000000802",
  sessionId,
} as const;

const collector = (): ClaudeLiveAcceptanceProofCollector =>
  new ClaudeLiveAcceptanceProofCollector({ candidate, runId });

const arm = (value: ClaudeLiveAcceptanceProofCollector, corroborate = true): void => {
  value.beginDaemonGeneration(scope.daemonGeneration);
  value.armFreshSession(scope);
  if (corroborate) {
    value.corroborateAppliedSend({
      daemonGeneration: scope.daemonGeneration,
      idempotencyKey: scope.sendIdempotencyKey,
      sessionId,
      turnId: call.turnId,
    });
  }
};

const capture = async (
  value: ClaudeLiveAcceptanceProofCollector,
  inputCall: HraHostToolCall = call,
  result: unknown = response,
): Promise<unknown> => await value.handleManagedHostToolCall({
  authority: profileAuthority,
  call: inputCall,
  dispatch: async () => result as Readonly<Record<string, unknown>>,
});

describe("Claude live-acceptance one-shot proof", () => {
  test.each(["provider", "account", "binding"] as const)("refuses a mismatched full %s authority before dispatch", async (field) => {
    const value = collector(); arm(value);
    const foreign = structuredClone(call);
    if (field === "provider") Object.assign(foreign.authority, { provider: "codex" });
    if (field === "account") Object.assign(foreign.authority, { providerAccountId: `pact_${"f".repeat(32)}` });
    if (field === "binding") Object.assign(foreign.authority, { bindingGeneration: 2 });
    let dispatches = 0;
    await expect(value.handleManagedHostToolCall({ authority: profileAuthority, call: foreign,
      dispatch: async () => { dispatches += 1; return response; } })).rejects.toThrow("call_mismatch");
    expect(dispatches).toBe(0);
  });

  test("detaches the admitted call before dispatch without extending the V1 receipt", async () => {
    const value = collector(); arm(value);
    const mutableCall = structuredClone(call);
    const mutableAuthority = { ...profileAuthority };
    await value.handleManagedHostToolCall({ authority: mutableAuthority, call: mutableCall, dispatch: async () => {
      Object.assign(mutableCall, { callId: "changed-after-admission", turnId: "changed-after-admission" });
      Object.assign(mutableCall.authority, { bindingGeneration: 2 });
      mutableAuthority.bindingGeneration += 1;
      await Promise.resolve();
      return response;
    } });
    value.handleManagedHostToolResponseWritten(written);
    const receipt = value.readProvisionalPrivateReceipt();
    expect(receipt).toMatchObject({ callId, turnId: call.turnId, profileGeneration: 7 });
    expect(receipt).not.toHaveProperty("providerAccountId");
    expect(receipt).not.toHaveProperty("bindingGeneration");
  });

  test("retains one immutable private receipt only after response-written and lifecycle close", async () => {
    const value = collector();
    arm(value);
    let dispatches = 0;
    const result = await value.handleManagedHostToolCall({
      authority: profileAuthority,
      call,
      dispatch: async () => {
        dispatches += 1;
        return response;
      },
    });
    expect(result).toBe(response);
    expect(dispatches).toBe(1);
    expect(() => value.readPrivateReceipt()).toThrow("proof_incomplete");

    value.handleManagedHostToolResponseWritten(written);
    const provisional = value.readProvisionalPrivateReceipt();
    expect(parseClaudeLiveAcceptanceProvisionalPrivateReceipt(provisional))
      .toMatchObject({ lifecycleInvalidated: false, requestDigest });
    expect(() => value.readPrivateReceipt()).toThrow("proof_incomplete");
    value.closeDaemonGeneration(scope.daemonGeneration);

    const receipt = value.readPrivateReceipt();
    expect(receipt).toMatchObject({
      bindingId: written.bindingId,
      callId,
      candidate,
      connectionId: call.connectionId,
      daemonGeneration: scope.daemonGeneration,
      memory,
      profileGeneration: scope.profileGeneration,
      profileId,
      providerThreadId: call.threadId,
      requestDigest,
      result: response,
      runId,
      sendIdempotencyKey: scope.sendIdempotencyKey,
      sessionId,
      turnId: call.turnId,
      lifecycleInvalidated: true,
    });
    expect(receipt.candidateBindingDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(Object.isFrozen(receipt)).toBeTrue();
    expect(Object.isFrozen(receipt.memory)).toBeTrue();
    expect(Object.isFrozen(receipt.result)).toBeTrue();
    expect(Object.isFrozen(receipt.result.page)).toBeTrue();
    expect(value.readPrivateReceipt()).toBe(receipt);
    expect(parseClaudeLiveAcceptancePrivateReceipt(receipt)).toEqual(receipt);
    expect(() => parseClaudeLiveAcceptancePrivateReceipt({
      ...receipt,
      candidateBindingDigest: "a".repeat(64),
    })).toThrow("candidate_invalid");
    expect(() => parseClaudeLiveAcceptanceProvisionalPrivateReceipt(receipt)).toThrow();
  });

  test("allows a fast callback before the applied send receipt is corroborated", async () => {
    const value = collector();
    arm(value, false);
    await capture(value);
    value.handleManagedHostToolResponseWritten(written);
    expect(() => value.readProvisionalPrivateReceipt()).toThrow("proof_incomplete");
    value.corroborateAppliedSend({
      daemonGeneration: scope.daemonGeneration,
      idempotencyKey: scope.sendIdempotencyKey,
      sessionId,
      turnId: call.turnId,
    });
    expect(value.readProvisionalPrivateReceipt()).toMatchObject({
      lifecycleInvalidated: false,
      turnId: call.turnId,
    });
    value.closeDaemonGeneration(scope.daemonGeneration);
    expect(value.readPrivateReceipt().lifecycleInvalidated).toBeTrue();
  });

  test("binds every memory and result field in a parsed private receipt", async () => {
    const value = collector();
    arm(value);
    await capture(value);
    value.handleManagedHostToolResponseWritten(written);
    value.closeDaemonGeneration(scope.daemonGeneration);
    const receipt = value.readPrivateReceipt();
    for (const changed of [
      { ...receipt, memory: { ...receipt.memory, summary: "Changed summary" } },
      { ...receipt, memory: { ...receipt.memory, title: "Changed title" } },
      { ...receipt, memory: { ...receipt.memory, language: "fr" } },
      { ...receipt, result: { ...receipt.result, workingHead: { ...receipt.result.workingHead, sequence: 2 } } },
      { ...receipt, result: { ...receipt.result, workingHead: { ...receipt.result.workingHead, digest: "a".repeat(64) } } },
      { ...receipt, result: { ...receipt.result, idempotencyRetainedUntil: "2027-09-07T00:00:00.000Z" } },
      { ...receipt, result: { ...receipt.result, page: { ...receipt.result.page, key: "acceptance.changed" } } },
    ]) expect(() => parseClaudeLiveAcceptancePrivateReceipt(changed)).toThrow();
  });

  test("does not accept a different generation when close is repeated", async () => {
    const value = collector();
    arm(value);
    await capture(value);
    value.handleManagedHostToolResponseWritten(written);
    value.closeDaemonGeneration(scope.daemonGeneration);
    value.closeDaemonGeneration(scope.daemonGeneration);
    expect(value.readPrivateReceipt().lifecycleInvalidated).toBeTrue();
    expect(() => value.closeDaemonGeneration(scope.daemonGeneration + 1)).toThrow("generation_invalid");
    expect(() => value.readPrivateReceipt()).toThrow("generation_invalid");
  });

  test("rejects a mismatched call before dispatch and keeps the first failure closed", async () => {
    const value = collector();
    arm(value);
    let dispatches = 0;
    const mismatch = { ...call, turnId: "acceptance-turn-two" };
    await expect(value.handleManagedHostToolCall({
      authority: profileAuthority,
      call: mismatch,
      dispatch: async () => {
        dispatches += 1;
        return response;
      },
    })).rejects.toMatchObject({ code: "call_mismatch" });
    expect(dispatches).toBe(0);
    expect(() => value.closeDaemonGeneration(scope.daemonGeneration))
      .toThrow("claude_live_acceptance_proof_call_mismatch");
    expect(() => value.readPrivateReceipt()).toThrow("call_mismatch");
  });

  test("permits exactly one dispatch while refusing a concurrent extra call", async () => {
    const value = collector();
    arm(value);
    let dispatches = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = value.handleManagedHostToolCall({
      authority: profileAuthority,
      call,
      dispatch: async () => {
        dispatches += 1;
        await gate;
        return response;
      },
    });
    await expect(capture(value)).rejects.toMatchObject({ code: "call_extra" });
    release();
    await expect(first).rejects.toMatchObject({ code: "call_extra" });
    expect(dispatches).toBe(1);
    expect(() => value.closeDaemonGeneration(scope.daemonGeneration)).toThrow("call_extra");
  });

  test("does not admit a dispatch completion after lifecycle invalidation", async () => {
    const value = collector();
    arm(value);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const pending = value.handleManagedHostToolCall({
      authority: profileAuthority,
      call,
      dispatch: async () => {
        await gate;
        return response;
      },
    });
    expect(() => value.closeDaemonGeneration(scope.daemonGeneration)).toThrow("proof_incomplete");
    release();
    await expect(pending).rejects.toMatchObject({ code: "proof_incomplete" });
    expect(() => value.readPrivateReceipt()).toThrow("proof_incomplete");
  });

  test("rechecks turn corroboration that arrives while dispatch is pending", async () => {
    const value = collector();
    arm(value, false);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const pending = value.handleManagedHostToolCall({
      authority: profileAuthority,
      call,
      dispatch: async () => { await gate; return response; },
    });
    value.corroborateAppliedSend({
      daemonGeneration: scope.daemonGeneration,
      idempotencyKey: scope.sendIdempotencyKey,
      sessionId,
      turnId: "acceptance-wrong-turn",
    });
    release();
    await expect(pending).rejects.toMatchObject({ code: "turn_corroboration_invalid" });
    expect(() => value.handleManagedHostToolResponseWritten(written)).toThrow("turn_corroboration_invalid");
  });

  test("rejects malformed or replayed results after the single real dispatch", async () => {
    for (const malformed of [
      { ...response, replay: true },
      { ...response, unexpected: true },
      { ...response, page: { ...(response.page as object), key: "acceptance.other" } },
      { ...response, workingHead: { ...(response.workingHead as object), operationSha256: "a".repeat(64) } },
    ]) {
      const value = collector();
      arm(value);
      await expect(capture(value, call, malformed)).rejects.toMatchObject({ code: "response_invalid" });
      expect(() => value.closeDaemonGeneration(scope.daemonGeneration)).toThrow("response_invalid");
    }
  });

  test("preserves a dispatch failure and refuses to manufacture a receipt", async () => {
    const value = collector();
    arm(value);
    const providerFailure = new Error("bounded provider refusal");
    await expect(value.handleManagedHostToolCall({
      authority: profileAuthority,
      call,
      dispatch: async () => { throw providerFailure; },
    })).rejects.toBe(providerFailure);
    expect(() => value.closeDaemonGeneration(scope.daemonGeneration)).toThrow("dispatch_failed");
    expect(() => value.readPrivateReceipt()).toThrow("dispatch_failed");
  });

  test("requires the exact managed response-written receipt", async () => {
    const value = collector();
    arm(value);
    await capture(value);
    expect(() => value.handleManagedHostToolResponseWritten({
      ...written,
      bindingId: "acceptance-binding-two",
      requestDigest: "b".repeat(64),
    })).toThrow("response_written_mismatch");
    expect(() => value.closeDaemonGeneration(scope.daemonGeneration))
      .toThrow("response_written_mismatch");
  });

  test("invalidates an otherwise complete proof on an extra or late callback", async () => {
    const extra = collector();
    arm(extra);
    await capture(extra);
    extra.handleManagedHostToolResponseWritten(written);
    expect(() => extra.handleManagedHostToolResponseWritten(written))
      .toThrow("response_written_extra");
    expect(() => extra.closeDaemonGeneration(scope.daemonGeneration))
      .toThrow("response_written_extra");

    const late = collector();
    arm(late);
    await capture(late);
    late.handleManagedHostToolResponseWritten(written);
    late.closeDaemonGeneration(scope.daemonGeneration);
    await expect(capture(late)).rejects.toMatchObject({ code: "lifecycle_closed" });
    expect(() => late.readPrivateReceipt()).toThrow("lifecycle_closed");
  });

  test("binds the exact daemon generation and one fresh-session scope", () => {
    expect(parseClaudeLiveAcceptanceFreshSessionScope(scope)).toEqual(scope);
    expect(() => parseClaudeLiveAcceptanceFreshSessionScope({
      ...scope,
      unexpected: true,
    })).toThrow();
    const send = {
      daemonGeneration: scope.daemonGeneration,
      idempotencyKey: scope.sendIdempotencyKey,
      sessionId,
      turnId: call.turnId,
    } as const;
    expect(parseClaudeLiveAcceptanceSendCorroboration(send)).toEqual(send);
    expect(() => parseClaudeLiveAcceptanceSendCorroboration({
      ...send,
      unexpected: true,
    })).toThrow();

    const wrongGeneration = collector();
    wrongGeneration.beginDaemonGeneration(scope.daemonGeneration);
    expect(() => wrongGeneration.armFreshSession({
      ...scope,
      daemonGeneration: scope.daemonGeneration + 1,
    })).toThrow("session_scope_invalid");

    const duplicate = collector();
    arm(duplicate);
    expect(() => duplicate.armFreshSession(scope)).toThrow("session_scope_invalid");

    const repeatedGeneration = collector();
    repeatedGeneration.beginDaemonGeneration(scope.daemonGeneration);
    expect(() => repeatedGeneration.beginDaemonGeneration(scope.daemonGeneration))
      .toThrow("generation_invalid");

    const wrongSend = collector();
    wrongSend.beginDaemonGeneration(scope.daemonGeneration);
    wrongSend.armFreshSession(scope);
    expect(() => wrongSend.corroborateAppliedSend({
      daemonGeneration: scope.daemonGeneration,
      idempotencyKey: "00000000-0000-4000-8000-000000000803",
      sessionId,
      turnId: call.turnId,
    })).toThrow("turn_corroboration_invalid");
  });

  test("rejects a candidate that is not the running package version", () => {
    expect(() => new ClaudeLiveAcceptanceProofCollector({
      candidate: { ...candidate, packageVersion: "99.99.99" },
      runId,
    })).toThrow(ClaudeLiveAcceptanceProofError);
  });
});
