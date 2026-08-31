import { statfsSync } from "node:fs";

const gibibyte = 1_073_741_824n;
const minimumReserveBytes = 12n * gibibyte;
const maximumReserveBytes = 24n * gibibyte;

export type DiskHeadroom = {
  readonly availableBytes: bigint;
  readonly totalBytes: bigint;
};

export type DiskHeadroomDecision =
  | {
      readonly kind: "pass";
      readonly availableBytes: bigint;
      readonly requiredBytes: bigint;
    }
  | {
      readonly kind: "fail";
      readonly availableBytes: bigint;
      readonly requiredBytes: bigint;
    };

function assertByteCount(value: bigint, label: string): void {
  if (value < 0n) throw new Error(`${label} must be nonnegative`);
}

export function requiredDiskReserveBytes(totalBytes: bigint): bigint {
  if (totalBytes <= 0n) throw new Error("totalBytes must be positive");
  const twoPercent = (totalBytes * 2n + 99n) / 100n;
  return twoPercent < minimumReserveBytes
    ? minimumReserveBytes
    : twoPercent > maximumReserveBytes
      ? maximumReserveBytes
      : twoPercent;
}

export function decideDiskHeadroom(headroom: DiskHeadroom): DiskHeadroomDecision {
  assertByteCount(headroom.availableBytes, "availableBytes");
  const requiredBytes = requiredDiskReserveBytes(headroom.totalBytes);
  return {
    kind: headroom.availableBytes >= requiredBytes ? "pass" : "fail",
    availableBytes: headroom.availableBytes,
    requiredBytes,
  };
}

export function formatGibibytes(bytes: bigint): string {
  assertByteCount(bytes, "bytes");
  const roundedTenths = (bytes * 10n + gibibyte / 2n) / gibibyte;
  return `${roundedTenths / 10n}.${roundedTenths % 10n} GiB`;
}

export function readDiskHeadroom(path: string): DiskHeadroom {
  const statistics = statfsSync(path, { bigint: true });
  return {
    availableBytes: statistics.bavail * statistics.bsize,
    totalBytes: statistics.blocks * statistics.bsize,
  };
}

export function renderDiskHeadroomDecision(decision: DiskHeadroomDecision): string {
  const available = formatGibibytes(decision.availableBytes);
  const required = formatGibibytes(decision.requiredBytes);
  return decision.kind === "pass"
    ? `Disk headroom clean: ${available} available; ${required} reserved for heavyweight local work.`
    : `Disk headroom too low: ${available} available; ${required} reserved for heavyweight local work. Run \`hra-workspace-audit --fetch\`, then review and use the exact guarded worktree-removal flow in the hra-local-efficiency skill.`;
}

if (import.meta.main) {
  const decision = decideDiskHeadroom(readDiskHeadroom(process.cwd()));
  const message = renderDiskHeadroomDecision(decision);
  if (decision.kind === "fail") {
    console.error(message);
    process.exitCode = 1;
  } else {
    console.log(message);
  }
}
