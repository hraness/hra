import type { AccountSummary } from "../../../contracts/runtime";
import type { ArchiveAdmissionHandle } from "../accounts/archive-admission-gate";
import type {
  PinnedCodexRequestInput,
  PinnedCodexRequestKey,
  PinnedCodexRequestOutput,
  PinnedCodexResponseAtPosition,
} from "../codex";

export type SessionCodexRequestKey = Extract<PinnedCodexRequestKey,
  | "threadList"
  | "threadStart"
  | "scheduleInterpreterThreadStart"
  | "threadResume"
  | "threadArchive"
  | "threadRead"
  | "threadHistoryRead"
  | "threadTurnsList"
  | "threadItemsList"
  | "threadFork"
  | "threadGoalSet"
  | "threadGoalGet"
  | "threadGoalClear"
  | "threadSetName"
  | "threadInjectItems"
  | "modelList"
  | "configRequirementsRead"
  | "mcpServerStatusList"
  | "turnStart"
  | "turnSteer"
  | "turnInterrupt">;

export interface SessionAccountRuntimePort {
  ensureSessionRuntime(
    accountProfileId: AccountSummary["id"],
  ): Promise<Readonly<{ generation: number }>>;
  requestSession<Key extends SessionCodexRequestKey>(
    accountProfileId: AccountSummary["id"],
    key: Key,
    input: PinnedCodexRequestInput<Key>,
    expectedGeneration?: number,
  ): Promise<PinnedCodexRequestOutput<Key>>;
  requestSessionWithResponsePosition<Key extends SessionCodexRequestKey>(
    accountProfileId: AccountSummary["id"],
    key: Key,
    input: PinnedCodexRequestInput<Key>,
    expectedGeneration?: number,
  ): Promise<PinnedCodexResponseAtPosition<PinnedCodexRequestOutput<Key>>>;
  /**
   * Closed recovery lane for the provider-thread archive state machine. The
   * production account authority keeps every other request quarantined while
   * these two operations prove or complete the exact durable archive intent.
   */
  ensureArchiveRecoveryRuntime(
    accountProfileId: AccountSummary["id"],
    archiveHandle: ArchiveAdmissionHandle,
  ): Promise<Readonly<{ generation: number }>>;
  requestArchiveRecoveryWithResponsePosition<
    Key extends "threadArchive" | "threadList"
  >(
    accountProfileId: AccountSummary["id"],
    archiveHandle: ArchiveAdmissionHandle,
    key: Key,
    input: PinnedCodexRequestInput<Key>,
    expectedGeneration: number,
  ): Promise<PinnedCodexResponseAtPosition<PinnedCodexRequestOutput<Key>>>;
}

/** The only session component that executes typed Codex operations. */
export class SessionCommandExecutor {
  readonly #accounts: SessionAccountRuntimePort;

  constructor(accounts: SessionAccountRuntimePort) {
    this.#accounts = accounts;
  }

  threadList(
    accountProfileId: AccountSummary["id"],
    input: PinnedCodexRequestInput<"threadList">,
    expectedGeneration?: number,
  ): Promise<PinnedCodexResponseAtPosition<PinnedCodexRequestOutput<"threadList">>> {
    return this.#positioned(
      accountProfileId,
      "threadList",
      input,
      expectedGeneration,
    );
  }

  threadRead(
    accountProfileId: AccountSummary["id"],
    input: PinnedCodexRequestInput<"threadRead">,
    expectedGeneration?: number,
  ): Promise<PinnedCodexResponseAtPosition<PinnedCodexRequestOutput<"threadRead">>> {
    return this.#positioned(
      accountProfileId,
      "threadRead",
      input,
      expectedGeneration,
    );
  }

  threadHistoryRead(
    accountProfileId: AccountSummary["id"],
    input: PinnedCodexRequestInput<"threadHistoryRead">,
    expectedGeneration?: number,
  ): Promise<PinnedCodexResponseAtPosition<PinnedCodexRequestOutput<"threadHistoryRead">>> {
    return this.#positioned(
      accountProfileId,
      "threadHistoryRead",
      input,
      expectedGeneration,
    );
  }

  threadTurnsList(
    accountProfileId: AccountSummary["id"],
    input: PinnedCodexRequestInput<"threadTurnsList">,
    expectedGeneration?: number,
  ): Promise<PinnedCodexResponseAtPosition<PinnedCodexRequestOutput<"threadTurnsList">>> {
    return this.#positioned(
      accountProfileId,
      "threadTurnsList",
      input,
      expectedGeneration,
    );
  }

  threadItemsList(
    accountProfileId: AccountSummary["id"],
    input: PinnedCodexRequestInput<"threadItemsList">,
    expectedGeneration?: number,
  ): Promise<PinnedCodexResponseAtPosition<PinnedCodexRequestOutput<"threadItemsList">>> {
    return this.#positioned(
      accountProfileId,
      "threadItemsList",
      input,
      expectedGeneration,
    );
  }

  threadFork(
    accountProfileId: AccountSummary["id"],
    input: PinnedCodexRequestInput<"threadFork">,
    expectedGeneration?: number,
  ): Promise<PinnedCodexResponseAtPosition<PinnedCodexRequestOutput<"threadFork">>> {
    return this.#positioned(accountProfileId, "threadFork", input, expectedGeneration);
  }

  threadGoalSet(
    accountProfileId: AccountSummary["id"],
    input: PinnedCodexRequestInput<"threadGoalSet">,
    expectedGeneration?: number,
  ): Promise<PinnedCodexResponseAtPosition<PinnedCodexRequestOutput<"threadGoalSet">>> {
    return this.#positioned(accountProfileId, "threadGoalSet", input, expectedGeneration);
  }

  threadGoalGet(
    accountProfileId: AccountSummary["id"],
    input: PinnedCodexRequestInput<"threadGoalGet">,
    expectedGeneration?: number,
  ): Promise<PinnedCodexResponseAtPosition<PinnedCodexRequestOutput<"threadGoalGet">>> {
    return this.#positioned(accountProfileId, "threadGoalGet", input, expectedGeneration);
  }

  threadGoalClear(
    accountProfileId: AccountSummary["id"],
    input: PinnedCodexRequestInput<"threadGoalClear">,
    expectedGeneration?: number,
  ): Promise<PinnedCodexResponseAtPosition<PinnedCodexRequestOutput<"threadGoalClear">>> {
    return this.#positioned(accountProfileId, "threadGoalClear", input, expectedGeneration);
  }

  threadSetName(
    accountProfileId: AccountSummary["id"],
    input: PinnedCodexRequestInput<"threadSetName">,
    expectedGeneration?: number,
  ): Promise<PinnedCodexResponseAtPosition<PinnedCodexRequestOutput<"threadSetName">>> {
    return this.#positioned(
      accountProfileId,
      "threadSetName",
      input,
      expectedGeneration,
    );
  }

  threadInjectItems(
    accountProfileId: AccountSummary["id"],
    input: PinnedCodexRequestInput<"threadInjectItems">,
    expectedGeneration?: number,
  ): Promise<PinnedCodexResponseAtPosition<PinnedCodexRequestOutput<"threadInjectItems">>> {
    return this.#positioned(
      accountProfileId,
      "threadInjectItems",
      input,
      expectedGeneration,
    );
  }

  modelList(
    accountProfileId: AccountSummary["id"],
    input: PinnedCodexRequestInput<"modelList">,
    expectedGeneration?: number,
  ): Promise<PinnedCodexResponseAtPosition<PinnedCodexRequestOutput<"modelList">>> {
    return this.#positioned(
      accountProfileId,
      "modelList",
      input,
      expectedGeneration,
    );
  }

  configRequirementsRead(
    accountProfileId: AccountSummary["id"],
    expectedGeneration?: number,
  ): Promise<PinnedCodexResponseAtPosition<
    PinnedCodexRequestOutput<"configRequirementsRead">
  >> {
    return this.#positioned(
      accountProfileId,
      "configRequirementsRead",
      undefined,
      expectedGeneration,
    );
  }

  mcpServerStatusList(
    accountProfileId: AccountSummary["id"],
    input: PinnedCodexRequestInput<"mcpServerStatusList">,
    expectedGeneration?: number,
  ): Promise<PinnedCodexResponseAtPosition<
    PinnedCodexRequestOutput<"mcpServerStatusList">
  >> {
    return this.#positioned(
      accountProfileId,
      "mcpServerStatusList",
      input,
      expectedGeneration,
    );
  }

  threadStart(
    accountProfileId: AccountSummary["id"],
    input: PinnedCodexRequestInput<"threadStart">,
    expectedGeneration?: number,
  ): Promise<PinnedCodexResponseAtPosition<PinnedCodexRequestOutput<"threadStart">>> {
    return this.#positioned(
      accountProfileId,
      "threadStart",
      input,
      expectedGeneration,
    );
  }

  scheduleInterpreterThreadStart(
    accountProfileId: AccountSummary["id"],
    input: PinnedCodexRequestInput<"scheduleInterpreterThreadStart">,
    expectedGeneration?: number,
  ): Promise<PinnedCodexResponseAtPosition<
    PinnedCodexRequestOutput<"scheduleInterpreterThreadStart">
  >> {
    return this.#positioned(
      accountProfileId,
      "scheduleInterpreterThreadStart",
      input,
      expectedGeneration,
    );
  }

  threadResume(
    accountProfileId: AccountSummary["id"],
    input: PinnedCodexRequestInput<"threadResume">,
    expectedGeneration?: number,
  ): Promise<PinnedCodexResponseAtPosition<PinnedCodexRequestOutput<"threadResume">>> {
    return this.#positioned(
      accountProfileId,
      "threadResume",
      input,
      expectedGeneration,
    );
  }

  threadArchive(
    accountProfileId: AccountSummary["id"],
    input: PinnedCodexRequestInput<"threadArchive">,
    expectedGeneration?: number,
  ): Promise<PinnedCodexResponseAtPosition<PinnedCodexRequestOutput<"threadArchive">>> {
    return this.#positioned(
      accountProfileId,
      "threadArchive",
      input,
      expectedGeneration,
    );
  }

  turnStart(
    accountProfileId: AccountSummary["id"],
    input: PinnedCodexRequestInput<"turnStart">,
    expectedGeneration?: number,
  ): Promise<PinnedCodexResponseAtPosition<PinnedCodexRequestOutput<"turnStart">>> {
    return this.#positioned(
      accountProfileId,
      "turnStart",
      input,
      expectedGeneration,
    );
  }

  turnSteer(
    accountProfileId: AccountSummary["id"],
    input: PinnedCodexRequestInput<"turnSteer">,
    expectedGeneration: number,
  ): Promise<PinnedCodexResponseAtPosition<PinnedCodexRequestOutput<"turnSteer">>> {
    return this.#positioned(
      accountProfileId,
      "turnSteer",
      input,
      expectedGeneration,
    );
  }

  turnInterrupt(
    accountProfileId: AccountSummary["id"],
    input: PinnedCodexRequestInput<"turnInterrupt">,
    expectedGeneration?: number,
  ): Promise<PinnedCodexResponseAtPosition<PinnedCodexRequestOutput<"turnInterrupt">>> {
    return this.#positioned(
      accountProfileId,
      "turnInterrupt",
      input,
      expectedGeneration,
    );
  }

  #positioned<Key extends SessionCodexRequestKey>(
    accountProfileId: AccountSummary["id"],
    key: Key,
    input: PinnedCodexRequestInput<Key>,
    expectedGeneration?: number,
  ): Promise<PinnedCodexResponseAtPosition<PinnedCodexRequestOutput<Key>>> {
    return this.#accounts.requestSessionWithResponsePosition(
      accountProfileId,
      key,
      input,
      expectedGeneration,
    );
  }
}
