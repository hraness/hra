import { describe, expect, test } from "bun:test";

import {
  HarnessProposalService,
  proposalBodyOperationId,
  proposalId,
  proposalValueId,
  type HarnessProposalAuthorityPort,
  type HarnessProposalRecord,
  type HarnessProposalServiceError,
  type HarnessProposalValuePort,
} from "../src/harness/proposal-service";

const now = "2026-08-06T12:00:00.000Z";
const receiptId = `rlmop_${"a".repeat(64)}`;

class Authority implements HarnessProposalAuthorityPort {
  mode: "off" | "suggest" = "suggest";
  readonly records = new Map<string, HarnessProposalRecord>();
  afterPrepare: (() => void) | null = null;
  capacityExhausted = false;
  activationCapacityExhausted = false;

  refinementMode(): Promise<"off" | "suggest"> {
    return Promise.resolve(this.mode);
  }

  prepare(input: Omit<HarnessProposalRecord,
    "state" | "recoveryReason" | "revision" | "createdAt" | "updatedAt" |
    "activatedAt"
  >): Promise<unknown> {
    if (this.mode !== "suggest") {
      return Promise.reject(Object.assign(new Error("disabled"), { code: "disabled" }));
    }
    if (this.capacityExhausted) {
      return Promise.reject(Object.assign(new Error("capacity"), {
        code: "capacity_exhausted",
      }));
    }
    const current = this.records.get(input.id);
    if (current !== undefined) {
      this.afterPrepare?.();
      return Promise.resolve(current);
    }
    const record: HarnessProposalRecord = {
      ...input,
      state: "prepared",
      recoveryReason: null,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      activatedAt: null,
    };
    this.records.set(record.id, record);
    this.afterPrepare?.();
    return Promise.resolve(record);
  }

  activate(input: Readonly<{ id: string; expectedRevision: number }>): Promise<unknown> {
    if (this.mode !== "suggest") {
      return Promise.reject(Object.assign(new Error("disabled"), { code: "disabled" }));
    }
    const current = this.records.get(input.id)!;
    if (current.revision !== input.expectedRevision) return Promise.resolve(current);
    if (this.activationCapacityExhausted) {
      const recovery: HarnessProposalRecord = {
        ...current,
        state: "recoveryRequired",
        recoveryReason: "capacity_exhausted",
        revision: current.revision + 1,
        updatedAt: now,
      };
      this.records.set(recovery.id, recovery);
      return Promise.resolve(recovery);
    }
    const active: HarnessProposalRecord = {
      ...current,
      state: "active",
      revision: current.revision + 1,
      updatedAt: now,
      activatedAt: now,
    };
    this.records.set(active.id, active);
    return Promise.resolve(active);
  }

  read(id: string): Promise<unknown> {
    return Promise.resolve(this.records.get(id) ?? null);
  }

  list(input: Readonly<{ afterProposalId: string | null; limit: number }>): Promise<unknown> {
    return Promise.resolve([...this.records.values()]
      .filter(({ state, id }) => state === "active" &&
        (input.afterProposalId === null || id > input.afterProposalId))
      .sort((left, right) => left.id.localeCompare(right.id))
      .slice(0, input.limit));
  }
}

class Values implements HarnessProposalValuePort {
  readonly values = new Map<string, string>();
  readonly reads: Array<Readonly<{
    epochId: string;
    ownerActorId: string;
    sourceTurnId: string;
    valueId: string;
  }>> = [];
  writes = 0;
  afterPut: (() => void) | null = null;

  put(input: Readonly<{
    operationId: string;
    epochId: string;
    ownerActorId: string;
    sourceTurnId: string;
    valueId: string;
    kind: "json";
    purpose: "proposal";
    plaintext: string;
    quotaLimitBytes: number;
  }>): Promise<unknown> {
    this.writes += 1;
    const current = this.values.get(input.valueId);
    if (current !== undefined && current !== input.plaintext) {
      return Promise.reject(new Error("conflict"));
    }
    this.values.set(input.valueId, input.plaintext);
    this.afterPut?.();
    return Promise.resolve({ valueId: input.valueId });
  }

  get(input: Readonly<{
    epochId: string;
    ownerActorId: string;
    sourceTurnId: string;
    valueId: string;
  }>): Promise<Readonly<{ plaintext: string }>> {
    this.reads.push(input);
    return Promise.resolve({ plaintext: this.values.get(input.valueId)! });
  }
}

function input(body: unknown = { instruction: "Prefer exact context slices" }) {
  return {
    receiptId,
    epochId: "hepoch_proposalfixture1",
    actorId: "hactor_proposalfixture1",
    turnId: "hturn_proposalfixture01",
    title: "Prefer exact context slices",
    body,
    contextQuotaBytes: 16 * 1024 * 1024,
  };
}

describe("suggest-only harness proposals", () => {
  test("records one immutable encrypted proposal and replays idempotently", async () => {
    const authority = new Authority();
    const values = new Values();
    const service = new HarnessProposalService({ authority, values });

    const first = await service.propose(input());
    const replay = await service.propose(input());

    expect(replay).toEqual(first);
    expect(first.id).toBe(proposalId(receiptId));
    expect(values.writes).toBe(1);
    expect(values.values.has(proposalValueId(receiptId))).toBeTrue();
    expect(proposalBodyOperationId(receiptId)).toStartWith("proposalbody_");
    expect(await service.list({ limit: 32 })).toEqual([first]);
    expect(await service.get(first.id)).toEqual({
      summary: first,
      body: { instruction: "Prefer exact context slices" },
    });
    expect(values.reads).toEqual([{
      epochId: input().epochId,
      ownerActorId: input().actorId,
      sourceTurnId: input().turnId,
      valueId: proposalValueId(receiptId),
    }]);
  });

  test("fails closed when suggestion mode is off", async () => {
    const authority = new Authority();
    authority.mode = "off";
    const service = new HarnessProposalService({
      authority,
      values: new Values(),
    });
    expect(await rejection(service.propose(input()))).toMatchObject({
      code: "disabled",
    } satisfies Partial<HarnessProposalServiceError>);
    expect(authority.records.size).toBe(0);
  });

  test("returns a stable typed error when immutable proposal capacity is exhausted", async () => {
    const authority = new Authority();
    authority.capacityExhausted = true;
    const service = new HarnessProposalService({
      authority,
      values: new Values(),
    });
    expect(await rejection(service.propose(input()))).toMatchObject({
      code: "capacity_exhausted",
    } satisfies Partial<HarnessProposalServiceError>);
    expect(authority.records.size).toBe(0);
  });

  test("returns the same typed error when recovery discovers legacy overflow", async () => {
    const authority = new Authority();
    authority.activationCapacityExhausted = true;
    const values = new Values();
    const service = new HarnessProposalService({ authority, values });
    expect(await rejection(service.propose(input()))).toMatchObject({
      code: "capacity_exhausted",
    } satisfies Partial<HarnessProposalServiceError>);
    expect(values.writes).toBe(1);
    expect(authority.records.get(proposalId(receiptId))).toMatchObject({
      state: "recoveryRequired",
      recoveryReason: "capacity_exhausted",
    });
  });

  test("rechecks Suggest after prepare before publishing the encrypted body", async () => {
    const authority = new Authority();
    const values = new Values();
    authority.afterPrepare = () => {
      authority.mode = "off";
    };
    const service = new HarnessProposalService({ authority, values });

    expect(await rejection(service.propose(input()))).toMatchObject({
      code: "disabled",
    } satisfies Partial<HarnessProposalServiceError>);
    expect(values.writes).toBe(0);
    expect(authority.records.get(proposalId(receiptId))?.state).toBe("prepared");
  });

  test("never activates when Suggest becomes Off across body publication", async () => {
    const authority = new Authority();
    const values = new Values();
    values.afterPut = () => {
      authority.mode = "off";
    };
    const service = new HarnessProposalService({ authority, values });

    expect(await rejection(service.propose(input()))).toMatchObject({
      code: "disabled",
    } satisfies Partial<HarnessProposalServiceError>);
    expect(values.writes).toBe(1);
    expect(authority.records.get(proposalId(receiptId))?.state).toBe("prepared");
  });

  test("rejects conflicting replay content before another value effect", async () => {
    const authority = new Authority();
    const values = new Values();
    const service = new HarnessProposalService({ authority, values });
    await service.propose(input());

    expect(await rejection(service.propose(input({ instruction: "Different" }))))
      .toMatchObject({
        code: "identity_conflict",
      } satisfies Partial<HarnessProposalServiceError>);
    expect(values.writes).toBe(1);
  });

  test("rejects non-JSON, prototype-sensitive, and oversized bodies", async () => {
    const service = new HarnessProposalService({
      authority: new Authority(),
      values: new Values(),
    });
    for (const body of [
      Symbol("not-json"),
      Number.NaN,
      { constructor: "no" },
      { payload: "x".repeat(256 * 1024) },
    ]) {
      expect(await rejection(service.propose(input(body)))).toMatchObject({
        code: "invalid_body",
      } satisfies Partial<HarnessProposalServiceError>);
    }
  });
});

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error("expected promise to reject");
}
