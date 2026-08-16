import { Database } from "bun:sqlite";
import { appendFileSync, realpathSync } from "node:fs";
import { taskWorkspaceViewValues } from "@hraness/agent-tasks-protocol";

import { AccountService } from "../../src/accounts/account-service";
import { NativeAccountProfileFileSystem } from "../../src/accounts/local-data-remover";
import { CodexJsonlWriter } from "../../src/codex";
import { DispatchTransferStore } from "../../src/dispatch-transfer";
import {
  RuntimeProjection,
  type ProjectionEvent,
} from "../../src/projection";
import { SnapshotTransferStore } from "../../src/snapshot-transfer";
import {
  acquireControlPlaneLifetimeLock,
  ControlPlaneLifetimeLockError,
} from "../../src/state/control-plane-lock";
import {
  LocalTaskChangeCoordinator,
  type PortableTaskChangeRecord,
} from "../../src/tasks/local-task-change-coordinator";

function requiredTracePath(): string {
  const value = process.env.HRA_GATEWAY_TEST_SHUTDOWN_TRACE_PATH;
  if (value === undefined || value.length === 0) {
    throw new Error("The shutdown cleanup trace path is required.");
  }
  return value;
}

function requiredControlPlanePath(): string {
  const value = process.env.HRA_GATEWAY_TEST_CONTROL_PLANE_PATH;
  if (value === undefined || value.length === 0) {
    throw new Error("The shutdown control-plane path is required.");
  }
  return value;
}

const tracePath = requiredTracePath();
const controlPlanePath = requiredControlPlanePath();
const failDatabaseClose =
  process.env.HRA_GATEWAY_TEST_FAIL_DATABASE_CLOSE === "1";
let finalInvalidationFailed = false;

function trace(step: string): void {
  appendFileSync(tracePath, `${step}\n`, "utf8");
}

function traceAfterFinalInvalidation(step: string): void {
  if (finalInvalidationFailed) trace(step);
}

function isTerminalControlPlane(database: Database): boolean {
  const filename: unknown = Reflect.get(database, "filename");
  if (typeof filename !== "string") return false;
  try {
    return realpathSync(filename) === realpathSync(controlPlanePath);
  } catch {
    return false;
  }
}

function ownMethod<Instance, Arguments extends unknown[], Result>(
  prototype: object,
  name: string,
): (instance: Instance, ...arguments_: Arguments) => Result {
  const candidate: unknown = Reflect.get(prototype, name);
  if (typeof candidate !== "function") {
    throw new TypeError(`The ${name} test seam is not a method.`);
  }
  return (instance, ...arguments_) =>
    Reflect.apply(candidate, instance, arguments_) as Result;
}

const callOriginalProjectionPublish = ownMethod<
  RuntimeProjection,
  [event: ProjectionEvent],
  void
>(RuntimeProjection.prototype, "publish");
RuntimeProjection.prototype.publish = function publishWithFinalFault(
  this: RuntimeProjection,
  event: ProjectionEvent,
): void {
  if (event.type === "task.invalidated" && !finalInvalidationFailed) {
    finalInvalidationFailed = true;
    trace("local-task-invalidation.publish.failed");
    throw new Error("Final local task invalidation publication failed.");
  }
  callOriginalProjectionPublish(this, event);
};

const callOriginalProjectionDrain = ownMethod<
  RuntimeProjection,
  [limit?: number],
  ReturnType<RuntimeProjection["drainEvents"]>
>(RuntimeProjection.prototype, "drainEvents");
RuntimeProjection.prototype.drainEvents = function tracedProjectionDrain(
  this: RuntimeProjection,
  limit?: number,
) {
  const events = callOriginalProjectionDrain(this, limit);
  traceAfterFinalInvalidation("projection.drain");
  return events;
};

const finalTaskChange: PortableTaskChangeRecord = {
  workspaceId: "wsp_00000000000000000000000001",
  projectionRevision: 1,
  scope: "task_change",
  taskId: "tsk_00000000000000000000000001",
  runId: "run_shutdown_0001",
  changeKind: "run.display_changed",
  affectedProjections: [
    {
      projection: "task_list",
      views: [...taskWorkspaceViewValues],
    },
    { projection: "task_detail" },
  ],
};

const callOriginalTaskChangeClose = ownMethod<
  LocalTaskChangeCoordinator,
  [],
  void
>(LocalTaskChangeCoordinator.prototype, "close");
LocalTaskChangeCoordinator.prototype.close = function closeWithPendingChange(
  this: LocalTaskChangeCoordinator,
): void {
  this.accept(finalTaskChange);
  try {
    callOriginalTaskChangeClose(this);
  } finally {
    traceAfterFinalInvalidation("local-task-changes.close.failed");
  }
};

const callOriginalAccountShutdown = ownMethod<
  AccountService,
  [],
  Promise<void>
>(AccountService.prototype, "shutdown");
AccountService.prototype.shutdown = async function tracedAccountShutdown(
  this: AccountService,
): Promise<void> {
  await callOriginalAccountShutdown(this);
  traceAfterFinalInvalidation("account-service.shutdown");
};

const callOriginalProfileFileSystemClose = ownMethod<
  NativeAccountProfileFileSystem,
  [],
  void
>(NativeAccountProfileFileSystem.prototype, "close");
NativeAccountProfileFileSystem.prototype.close =
  function tracedProfileFileSystemClose(
    this: NativeAccountProfileFileSystem,
  ): void {
    callOriginalProfileFileSystemClose(this);
    traceAfterFinalInvalidation("account-profile-filesystem.close");
  };

const callOriginalSnapshotTransferDispose = ownMethod<
  SnapshotTransferStore,
  [],
  void
>(SnapshotTransferStore.prototype, "dispose");
SnapshotTransferStore.prototype.dispose = function tracedSnapshotTransferDispose(
  this: SnapshotTransferStore,
): void {
  callOriginalSnapshotTransferDispose(this);
  traceAfterFinalInvalidation("snapshot-transfers.dispose");
};

const callOriginalDispatchTransferDispose = ownMethod<
  DispatchTransferStore,
  [],
  void
>(DispatchTransferStore.prototype, "dispose");
DispatchTransferStore.prototype.dispose = function tracedDispatchTransferDispose(
  this: DispatchTransferStore,
): void {
  callOriginalDispatchTransferDispose(this);
  traceAfterFinalInvalidation("dispatch-transfers.dispose");
};

const callOriginalDatabaseClose = ownMethod<Database, [], void>(
  Database.prototype,
  "close",
);
Database.prototype.close = function tracedDatabaseClose(this: Database): void {
  if (
    failDatabaseClose &&
    finalInvalidationFailed &&
    isTerminalControlPlane(this)
  ) {
    traceAfterFinalInvalidation("database.close.failed");
    throw new Error("Final control-plane database close failed.");
  }
  callOriginalDatabaseClose(this);
  traceAfterFinalInvalidation("database.close");
};

const callOriginalWriterClose = ownMethod<
  CodexJsonlWriter,
  [],
  Promise<void>
>(CodexJsonlWriter.prototype, "close");
CodexJsonlWriter.prototype.close = async function tracedWriterClose(
  this: CodexJsonlWriter,
): Promise<void> {
  if (finalInvalidationFailed) {
    if (failDatabaseClose) {
      try {
        const unexpectedlyReacquired =
          acquireControlPlaneLifetimeLock(controlPlanePath);
        unexpectedlyReacquired.release();
        throw new Error(
          "The lifetime lock was released after database close failed.",
        );
      } catch (error: unknown) {
        if (
          !(error instanceof ControlPlaneLifetimeLockError) ||
          error.code !== "already_running"
        ) {
          throw error;
        }
        trace("lifetime-lock.retained");
      }
    } else {
      const reacquired = acquireControlPlaneLifetimeLock(controlPlanePath);
      reacquired.release();
      trace("lifetime-lock.reacquired");
    }
  }
  await callOriginalWriterClose(this);
  traceAfterFinalInvalidation("writer.close");
};
