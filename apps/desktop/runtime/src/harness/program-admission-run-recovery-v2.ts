import {
  type ProgramAdmissionRunRecoveryPortV2,
  ProgramAdmissionIntentV2Error,
} from "./program-admission-intent-v2";
import type { RlmRunAuthorityV2 } from "./rlm-run-authority-v2";

/**
 * Fences only the exact active RLM run revision identified by admission
 * recovery. A concurrent transition is accepted solely when it already put
 * that run into the same terminal recovery state.
 */
export class ProgramAdmissionRlmRunRecoveryV2
implements ProgramAdmissionRunRecoveryPortV2 {
  readonly #runs: RlmRunAuthorityV2;

  constructor(runs: RlmRunAuthorityV2) {
    this.#runs = runs;
  }

  markRecoveryRequired(input: Readonly<{
    runId: string;
    expectedRevision: number;
    expectedState: "prepared" | "running" | "suspended";
    now: string;
  }>): void {
    const current = this.#runs.readRun(input.runId);
    if (current === null) {
      throw new ProgramAdmissionIntentV2Error(
        "conflict",
        "program admission run disappeared before recovery fencing",
      );
    }
    if (
      current.state === "recoveryRequired" &&
      current.terminalCode === "program_admission_recovery"
    ) return;
    if (
      current.revision !== input.expectedRevision ||
      current.state !== input.expectedState
    ) {
      throw new ProgramAdmissionIntentV2Error(
        "revision_conflict",
        "program admission run changed before recovery fencing",
      );
    }
    try {
      this.#runs.transitionRun({
        runId: input.runId,
        expectedRevision: input.expectedRevision,
        expectedState: input.expectedState,
        nextState: "recoveryRequired",
        terminalCode: "program_admission_recovery",
        now: input.now,
      });
    } catch (cause: unknown) {
      const winner = this.#runs.readRun(input.runId);
      if (
        winner?.state === "recoveryRequired" &&
        winner.terminalCode === "program_admission_recovery"
      ) return;
      throw new ProgramAdmissionIntentV2Error(
        "revision_conflict",
        "program admission run changed during recovery fencing",
        cause,
      );
    }
  }
}
