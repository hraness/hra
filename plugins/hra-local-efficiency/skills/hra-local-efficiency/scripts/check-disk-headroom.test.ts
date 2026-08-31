import { describe, expect, test } from "bun:test";

import {
  decideDiskHeadroom,
  formatGibibytes,
  renderDiskHeadroomDecision,
  requiredDiskReserveBytes,
} from "./check-disk-headroom";

const GiB = 1_073_741_824n;

describe("repository disk-headroom preflight", () => {
  test("uses a bounded two-percent reserve", () => {
    expect(requiredDiskReserveBytes(512n * GiB)).toBe(12n * GiB);
    expect(requiredDiskReserveBytes(1_000n * GiB)).toBe(20n * GiB);
    expect(requiredDiskReserveBytes(2_000n * GiB)).toBe(24n * GiB);
  });

  test("passes equality and fails one byte below the reserve", () => {
    expect(decideDiskHeadroom({
      availableBytes: 20n * GiB,
      totalBytes: 1_000n * GiB,
    })).toEqual({
      kind: "pass",
      availableBytes: 20n * GiB,
      requiredBytes: 20n * GiB,
    });
    expect(decideDiskHeadroom({
      availableBytes: 20n * GiB - 1n,
      totalBytes: 1_000n * GiB,
    }).kind).toBe("fail");
  });

  test("reports the cleanup command only on failure", () => {
    const passing = renderDiskHeadroomDecision(decideDiskHeadroom({
      availableBytes: 40n * GiB,
      totalBytes: 1_000n * GiB,
    }));
    const failing = renderDiskHeadroomDecision(decideDiskHeadroom({
      availableBytes: 4n * GiB,
      totalBytes: 1_000n * GiB,
    }));

    expect(passing).toBe(
      "Disk headroom clean: 40.0 GiB available; 20.0 GiB reserved for heavyweight local work.",
    );
    expect(failing).toContain("hra-workspace-audit --fetch");
    expect(failing).toContain("hra-local-efficiency skill");
  });

  test("rejects impossible byte counts and formats without floating-point loss", () => {
    expect(formatGibibytes(3n * GiB + GiB / 4n)).toBe("3.3 GiB");
    expect(() => formatGibibytes(-1n)).toThrow("bytes must be nonnegative");
    expect(() => requiredDiskReserveBytes(0n)).toThrow("totalBytes must be positive");
    expect(() => decideDiskHeadroom({
      availableBytes: -1n,
      totalBytes: 1n,
    })).toThrow("availableBytes must be nonnegative");
  });
});
