import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";

import {
  HarnessProposalRecoveryV2,
  type HarnessProposalRecord,
  type HarnessProposalRecoveryAuthorityPort,
  type HarnessProposalValuePort,
} from "../src/harness/proposal-service";

const at = "2030-01-01T00:00:00.000Z";
const later = "2030-01-01T00:00:01.000Z";
const exactBody = '{"idea":"safe"}';

class RecoveryAuthority implements HarnessProposalRecoveryAuthorityPort {
  readonly records = new Map<string, HarnessProposalRecord>();
  readonly bodyStates = new Map<string, "missing" | "exact" | "conflict">();

  listPrepared(input: Readonly<{
    afterProposalId: string | null;
    limit: number;
  }>): Promise<unknown> {
    return Promise.resolve([...this.records.values()]
      .filter((record) => record.state === "prepared" &&
        (input.afterProposalId === null || record.id > input.afterProposalId))
      .sort((left, right) => left.id.localeCompare(right.id))
      .slice(0, input.limit));
  }

  inspectPreparedBody(id: string): Promise<"missing" | "exact" | "conflict"> {
    return Promise.resolve(this.bodyStates.get(id) ?? "missing");
  }

  activateRecovered(input: Readonly<{
    id: string;
    expectedRevision: number;
  }>): Promise<unknown> {
    const current = this.records.get(input.id)!;
    if (current.state === "active") return Promise.resolve(current);
    if (current.state !== "prepared" || current.revision !== input.expectedRevision) {
      return Promise.reject(new Error("stale proposal"));
    }
    const active: HarnessProposalRecord = Object.freeze({
      ...current,
      state: "active",
      recoveryReason: null,
      revision: current.revision + 1,
      updatedAt: later,
      activatedAt: later,
    });
    this.records.set(active.id, active);
    return Promise.resolve(active);
  }

  markRecoveryRequired(input: Readonly<{
    id: string;
    expectedRevision: number;
    reason:
      | "body_missing"
      | "body_conflict"
      | "body_content_mismatch"
      | "capacity_exhausted";
  }>): Promise<unknown> {
    const current = this.records.get(input.id)!;
    if (current.state === "recoveryRequired") return Promise.resolve(current);
    if (current.state !== "prepared" || current.revision !== input.expectedRevision) {
      return Promise.reject(new Error("stale proposal"));
    }
    const recovery: HarnessProposalRecord = Object.freeze({
      ...current,
      state: "recoveryRequired",
      recoveryReason: input.reason,
      revision: current.revision + 1,
      updatedAt: later,
      activatedAt: null,
    });
    this.records.set(recovery.id, recovery);
    return Promise.resolve(recovery);
  }
}

class RecoveryValues implements HarnessProposalValuePort {
  readonly plaintext = new Map<string, string>();
  readonly failures = new Map<string, Error>();

  put(): Promise<unknown> {
    return Promise.reject(new Error("unexpected put"));
  }

  get(input: Readonly<{ valueId: string }>): Promise<Readonly<{
    plaintext: string;
  }>> {
    const failure = this.failures.get(input.valueId);
    if (failure !== undefined) return Promise.reject(failure);
    const plaintext = this.plaintext.get(input.valueId);
    return plaintext === undefined
      ? Promise.reject(Object.assign(new Error("missing"), {
          code: "value_missing",
        }))
      : Promise.resolve({ plaintext });
  }
}

function proposal(marker: string, bodyDigest = digestBody(exactBody)):
  HarnessProposalRecord {
  return Object.freeze({
    id: `hproposal_${marker.repeat(48)}`,
    epochId: "hepoch_proposalrecovery1",
    actorId: "hactor_proposalrecovery1",
    sourceTurnId: "hturn_proposalrecovery01",
    operationId: `proposalrecovery_${marker.repeat(24)}`,
    title: `Proposal ${marker}`,
    bodyValueId: `ctxval_${marker.repeat(48)}`,
    bodyDigest,
    state: "prepared",
    recoveryReason: null,
    revision: 1,
    createdAt: at,
    updatedAt: at,
    activatedAt: null,
  });
}

function digestBody(value: string): string {
  return createHash("sha256")
    .update("oprte.harness.body.v1\0", "utf8")
    .update(value, "utf8")
    .digest("hex");
}

describe("harness proposal restart recovery", () => {
  test("activates exact bodies and quarantines absent or mismatched bodies", async () => {
    const authority = new RecoveryAuthority();
    const values = new RecoveryValues();
    const exact = proposal("a");
    const missing = proposal("b");
    const mismatch = proposal("c");
    for (const record of [exact, missing, mismatch]) {
      authority.records.set(record.id, record);
    }
    authority.bodyStates.set(exact.id, "exact");
    authority.bodyStates.set(missing.id, "missing");
    authority.bodyStates.set(mismatch.id, "exact");
    values.plaintext.set(exact.bodyValueId, exactBody);
    values.plaintext.set(mismatch.bodyValueId, '{"idea":"wrong"}');
    const recovery = new HarnessProposalRecoveryV2({
      authority,
      values,
      pageLimit: 2,
    });

    expect(await recovery.recover()).toEqual({
      inspectedProposalIds: [exact.id, missing.id, mismatch.id],
      activatedProposalIds: [exact.id],
      recoveryRequiredProposalIds: [missing.id, mismatch.id],
    });
    expect(authority.records.get(exact.id)?.state).toBe("active");
    expect(authority.records.get(missing.id)).toMatchObject({
      state: "recoveryRequired",
      recoveryReason: "body_missing",
    });
    expect(authority.records.get(mismatch.id)).toMatchObject({
      state: "recoveryRequired",
      recoveryReason: "body_content_mismatch",
    });
    expect(await recovery.recover()).toEqual({
      inspectedProposalIds: [],
      activatedProposalIds: [],
      recoveryRequiredProposalIds: [],
    });
  });

  test("leaves transient key custody failures prepared for a later boot", async () => {
    const authority = new RecoveryAuthority();
    const values = new RecoveryValues();
    const record = proposal("d");
    authority.records.set(record.id, record);
    authority.bodyStates.set(record.id, "exact");
    const transient = Object.assign(new Error("keychain unavailable"), {
      code: "custody_unavailable",
    });
    values.failures.set(record.bodyValueId, transient);

    expect(await rejected(new HarnessProposalRecoveryV2({
      authority,
      values,
    }).recover())).toBe(transient);
    expect(authority.records.get(record.id)).toEqual(record);
  });
});

async function rejected<T>(promise: Promise<T>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error("expected promise to reject");
}
