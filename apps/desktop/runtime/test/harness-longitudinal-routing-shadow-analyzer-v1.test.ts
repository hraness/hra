import { describe, expect, test } from "bun:test";

import {
  HarnessLongitudinalRoutingShadowAnalyzerV1,
  type LongitudinalRoutingDirtyPaneHeadV1,
  type LongitudinalRoutingShadowAnalysisAuthorityPortV1,
  type LongitudinalRoutingShadowAnalysisSchedulerV1,
  type LongitudinalRoutingShadowAnalysisTimerV1,
} from "../src/harness/longitudinal-routing-shadow-analyzer-v1";
import {
  HRA_LONGITUDINAL_ROUTING_EVIDENCE_COVERAGE_V1,
  type LongitudinalRoutingInspectionV1,
} from "../src/harness/longitudinal-routing-v1";

const unavailableInspection: LongitudinalRoutingInspectionV1 = Object.freeze({
  schemaVersion: 1,
  mode: "shadow",
  policyAuthorization: "none",
  coverage: HRA_LONGITUDINAL_ROUTING_EVIDENCE_COVERAGE_V1,
  kind: "unavailable",
  reason: "paneLineageUnavailable",
});

interface ScheduledTimer {
  readonly delayMilliseconds: number;
  cancelled: boolean;
  fire(): void;
}

class ManualScheduler implements LongitudinalRoutingShadowAnalysisSchedulerV1 {
  readonly scheduled: ScheduledTimer[] = [];

  schedule(
    callback: () => void,
    delayMilliseconds: number,
  ): LongitudinalRoutingShadowAnalysisTimerV1 {
    const timer: ScheduledTimer = {
      delayMilliseconds,
      cancelled: false,
      fire: () => {
        if (timer.cancelled) return;
        timer.cancelled = true;
        callback();
      },
    };
    this.scheduled.push(timer);
    return Object.freeze({
      cancel: () => {
        timer.cancelled = true;
      },
    });
  }

  fireNext(): void {
    const timer = this.scheduled.find((candidate) => !candidate.cancelled);
    if (timer === undefined) throw new Error("no pending analysis timer");
    timer.fire();
  }

  pending(): readonly ScheduledTimer[] {
    return this.scheduled.filter((timer) => !timer.cancelled);
  }
}

class MemoryAuthority implements LongitudinalRoutingShadowAnalysisAuthorityPortV1 {
  readonly heads: LongitudinalRoutingDirtyPaneHeadV1[];
  readonly calls: string[] = [];
  listFailures = 0;
  acknowledgeResult = true;
  onInspect: (() => void) | null = null;

  constructor(heads: readonly LongitudinalRoutingDirtyPaneHeadV1[]) {
    this.heads = [...heads];
  }

  listDirtyPaneHeads(input: Readonly<{
    limit: 1;
    afterPaneId?: string;
  }>) {
    this.calls.push(
      `list:${String(input.limit)}:${input.afterPaneId ?? "start"}`,
    );
    if (this.listFailures > 0) {
      this.listFailures -= 1;
      throw new Error("SQLite temporarily busy");
    }
    const afterIndex = input.afterPaneId === undefined
      ? -1
      : this.heads.findIndex((head) => head.paneId === input.afterPaneId);
    const nextIndex = afterIndex >= 0 && afterIndex + 1 < this.heads.length
      ? afterIndex + 1
      : 0;
    return this.heads.slice(nextIndex, nextIndex + input.limit);
  }

  inspectPane(paneId: string): LongitudinalRoutingInspectionV1 {
    this.calls.push(`inspect:${paneId}`);
    this.onInspect?.();
    return unavailableInspection;
  }

  acknowledgeAnalyzedPane(input: Readonly<{
    paneId: string;
    expectedObservationRevision: number;
    inspection: LongitudinalRoutingInspectionV1;
  }>): boolean {
    this.calls.push(
      `ack:${input.paneId}:${String(input.expectedObservationRevision)}`,
    );
    if (!this.acknowledgeResult) return false;
    const headIndex = this.heads.findIndex((head) =>
      head.paneId === input.paneId &&
      head.observationRevision === input.expectedObservationRevision
    );
    const head = this.heads[headIndex];
    if (
      head?.paneId === input.paneId &&
      head.observationRevision === input.expectedObservationRevision
    ) {
      this.heads.splice(headIndex, 1);
      return true;
    }
    return false;
  }
}

describe("HarnessLongitudinalRoutingShadowAnalyzerV1", () => {
  test("starts after recovery without reading while foreground work is busy", () => {
    const scheduler = new ManualScheduler();
    const authority = new MemoryAuthority([head("pane_busy001", 1)]);
    let idleReads = 0;
    const analyzer = new HarnessLongitudinalRoutingShadowAnalyzerV1({
      authority,
      idle: {
        isIdle: () => {
          idleReads += 1;
          return false;
        },
      },
      scheduler,
      analysisIntervalMs: 11,
    });

    expect(authority.calls).toEqual([]);
    analyzer.startAfterRecovery();
    expect(authority.calls).toEqual([]);
    expect(scheduler.pending()).toHaveLength(1);
    expect(scheduler.pending()[0]?.delayMilliseconds).toBe(11);

    scheduler.fireNext();
    expect(idleReads).toBe(1);
    expect(authority.calls).toEqual([]);
    expect(scheduler.pending()).toHaveLength(1);
  });

  test("analyzes at most one dirty pane per tick across repeated ticks", () => {
    const scheduler = new ManualScheduler();
    const authority = new MemoryAuthority([
      head("pane_first001", 3),
      head("pane_second01", 5),
    ]);
    const analyzer = fixtureAnalyzer(authority, scheduler);
    analyzer.startAfterRecovery();

    scheduler.fireNext();
    expect(authority.calls).toEqual([
      "list:1:start",
      "inspect:pane_first001",
      "ack:pane_first001:3",
    ]);
    expect(authority.heads.map((value) => value.paneId)).toEqual([
      "pane_second01",
    ]);
    expect(scheduler.pending()).toHaveLength(1);

    scheduler.fireNext();
    expect(authority.calls.slice(3)).toEqual([
      "list:1:pane_first001",
      "inspect:pane_second01",
      "ack:pane_second01:5",
    ]);
    expect(authority.heads).toEqual([]);
    expect(scheduler.pending()).toHaveLength(1);
  });

  test("retains CAS-lost work for a later tick", () => {
    const scheduler = new ManualScheduler();
    const authority = new MemoryAuthority([head("pane_casloss1", 8)]);
    authority.acknowledgeResult = false;
    const analyzer = fixtureAnalyzer(authority, scheduler);
    analyzer.startAfterRecovery();

    scheduler.fireNext();
    expect(authority.heads).toHaveLength(1);
    authority.acknowledgeResult = true;
    scheduler.fireNext();
    expect(authority.calls.filter(
      (call) => call === "inspect:pane_casloss1",
    )).toHaveLength(2);
    expect(authority.heads).toEqual([]);
  });

  test("retains failures and rearms with bounded exponential backoff", () => {
    const scheduler = new ManualScheduler();
    const authority = new MemoryAuthority([head("pane_retry001", 13)]);
    authority.listFailures = 3;
    const faults: Error[] = [];
    const analyzer = new HarnessLongitudinalRoutingShadowAnalyzerV1({
      authority,
      idle: { isIdle: () => true },
      scheduler,
      analysisIntervalMs: 11,
      retryBackoffMs: 7,
      maximumRetryBackoffMs: 20,
      onFault: (error) => faults.push(error),
    });
    analyzer.startAfterRecovery();

    expect(nextDelay(scheduler)).toBe(11);
    scheduler.fireNext();
    expect(nextDelay(scheduler)).toBe(7);
    scheduler.fireNext();
    expect(nextDelay(scheduler)).toBe(14);
    scheduler.fireNext();
    expect(nextDelay(scheduler)).toBe(20);
    expect(authority.heads).toHaveLength(1);
    expect(faults).toHaveLength(3);

    scheduler.fireNext();
    expect(authority.heads).toEqual([]);
    expect(nextDelay(scheduler)).toBe(11);
  });

  test("rotates past a persistently malformed pane and reports bounded faults", () => {
    const scheduler = new ManualScheduler();
    const authority = new MemoryAuthority([
      head("pane_bad00001", 1),
      head("pane_good0001", 2),
    ]);
    const originalInspect = authority.inspectPane.bind(authority);
    authority.inspectPane = (paneId: string) => {
      if (paneId === "pane_bad00001") {
        authority.calls.push(`inspect:${paneId}`);
        throw new Error("malformed pane evidence");
      }
      return originalInspect(paneId);
    };
    const faults: Error[] = [];
    const analyzer = new HarnessLongitudinalRoutingShadowAnalyzerV1({
      authority,
      idle: { isIdle: () => true },
      scheduler,
      analysisIntervalMs: 11,
      retryBackoffMs: 7,
      onFault: (error) => faults.push(error),
    });
    analyzer.startAfterRecovery();

    scheduler.fireNext();
    expect(faults).toHaveLength(1);
    expect(authority.heads.map((value) => value.paneId)).toEqual([
      "pane_bad00001",
      "pane_good0001",
    ]);

    scheduler.fireNext();
    expect(authority.calls.slice(-3)).toEqual([
      "list:1:pane_bad00001",
      "inspect:pane_good0001",
      "ack:pane_good0001:2",
    ]);
    expect(authority.heads.map((value) => value.paneId)).toEqual([
      "pane_bad00001",
    ]);
  });

  test("closes admission and joins the one already-admitted tick", async () => {
    const scheduler = new ManualScheduler();
    const authority = new MemoryAuthority([head("pane_drain001", 21)]);
    const analyzer = fixtureAnalyzer(authority, scheduler);
    let joined = false;
    let settlement: Promise<void> | null = null;
    authority.onInspect = () => {
      analyzer.closeAdmission();
      settlement = analyzer.settled();
      void settlement.then(() => {
        joined = true;
      });
      expect(joined).toBeFalse();
    };
    analyzer.startAfterRecovery();

    scheduler.fireNext();
    expect(authority.calls).toEqual([
      "list:1:start",
      "inspect:pane_drain001",
      "ack:pane_drain001:21",
    ]);
    expect(scheduler.pending()).toEqual([]);
    expect(settlement).not.toBeNull();
    await settlement!;
    expect(joined).toBeTrue();
    expect(await analyzer.settled()).toBeUndefined();
  });
});

function fixtureAnalyzer(
  authority: LongitudinalRoutingShadowAnalysisAuthorityPortV1,
  scheduler: LongitudinalRoutingShadowAnalysisSchedulerV1,
) {
  return new HarnessLongitudinalRoutingShadowAnalyzerV1({
    authority,
    idle: { isIdle: () => true },
    scheduler,
    analysisIntervalMs: 11,
  });
}

function head(
  paneId: string,
  observationRevision: number,
): LongitudinalRoutingDirtyPaneHeadV1 {
  return Object.freeze({ paneId, observationRevision });
}

function nextDelay(scheduler: ManualScheduler): number | undefined {
  return scheduler.pending()[0]?.delayMilliseconds;
}
