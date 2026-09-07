import type { Value } from "convex/values";

import {
  adjustQuotaForPatch,
  logicalDocumentBytes,
} from "./quota";
import type { DataModel, MutationCtx } from "./server";
import {
  durableJobCapacityReservation,
  maximumDurableJobCapacityCharacters,
} from "./validators";

type AccountDeletionJob = DataModel["accountDeletionJobs"]["document"];
type DeviceRevocationJob = DataModel["deviceRevocationJobs"]["document"];
type JobPatch = Readonly<Record<string, Value | undefined>>;

function corrupt(): never {
  throw new Error("DURABLE_JOB_CAPACITY_CORRUPT");
}

function validCapacity(value: string): boolean {
  return value.length <= maximumDurableJobCapacityCharacters
    && !/[^0]/u.test(value);
}

function requiredCapacity(
  job: AccountDeletionJob | DeviceRevocationJob,
  initialShape: JobPatch,
): string {
  const target = {
    ...job,
    ...initialShape,
    capacityReservation: durableJobCapacityReservation,
  };
  const withoutCapacity = { ...job, capacityReservation: "" };
  const requiredCharacters = logicalDocumentBytes(target)
    - logicalDocumentBytes(withoutCapacity);
  if (
    !Number.isSafeInteger(requiredCharacters)
    || requiredCharacters < 0
    || requiredCharacters > maximumDurableJobCapacityCharacters
  ) return corrupt();
  return "0".repeat(requiredCharacters);
}

function hasExactCapacity(
  job: AccountDeletionJob | DeviceRevocationJob,
  initialShape: JobPatch,
): boolean {
  const capacity = job.capacityReservation;
  if (capacity === undefined || !validCapacity(capacity)) return false;
  const expected = requiredCapacity(job, initialShape);
  return capacity === expected
    && logicalDocumentBytes(job) === logicalDocumentBytes({
      ...job,
      ...initialShape,
      capacityReservation: durableJobCapacityReservation,
    });
}

export function hasExactAccountDeletionJobCapacity(job: AccountDeletionJob): boolean {
  return hasExactCapacity(job, {
    category: "commands_and_leases",
    state: "pending",
    updatedAt: job.createdAt,
  });
}

export function hasExactDeviceRevocationJobCapacity(job: DeviceRevocationJob): boolean {
  return hasExactCapacity(job, {
    category: "sessions",
    state: "pending",
    updatedAt: job.createdAt,
  });
}

function resizedPatch(
  job: AccountDeletionJob | DeviceRevocationJob,
  patch: JobPatch,
  initialShape: JobPatch,
): JobPatch {
  const currentCapacity = job.capacityReservation;
  // Jobs accepted before this additive schema existed remain drainable with
  // the old exact-delta accounting. The rollout runbook drains those jobs
  // before admitting capacity-backed work; every new job takes the branch
  // below.
  if (currentCapacity === undefined) return patch;
  if (!hasExactCapacity(job, initialShape)) return corrupt();
  const target = { ...job, ...initialShape, capacityReservation: durableJobCapacityReservation };
  const next = { ...job, ...patch };
  const resized = {
    ...patch,
    capacityReservation: requiredCapacity(next, initialShape),
  };
  if (
    logicalDocumentBytes({ ...job, ...resized })
      !== logicalDocumentBytes(target)
  ) corrupt();
  return resized;
}

export async function patchAccountDeletionJobWithCapacity(
  ctx: MutationCtx,
  job: AccountDeletionJob,
  patch: JobPatch,
): Promise<void> {
  const resized = resizedPatch(job, patch, {
    category: "commands_and_leases",
    state: "pending",
    updatedAt: job.createdAt,
  });
  await adjustQuotaForPatch(ctx, job.userId, "job", job, resized);
  await ctx.db.patch(job._id, resized as never);
}

export async function patchDeviceRevocationJobWithCapacity(
  ctx: MutationCtx,
  job: DeviceRevocationJob,
  patch: JobPatch,
): Promise<void> {
  const resized = resizedPatch(job, patch, {
    category: "sessions",
    state: "pending",
    updatedAt: job.createdAt,
  });
  await adjustQuotaForPatch(ctx, job.userId, "job", job, resized);
  await ctx.db.patch(job._id, resized as never);
}
