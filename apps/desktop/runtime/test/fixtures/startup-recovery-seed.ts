import { join } from "node:path";

import { hraReleaseIdentity } from "../../release-identity";
import { DispatchRunnerInstallationStore } from
  "../../src/state/dispatch-runner-installation";
import { controlPlanePath, openControlPlane } from "../../src/state/database";
import { LocalTaskStore } from "../../src/state/local-task-store";
import {
  loadOrCreateOperationReceiptKey,
  operationReceiptKeyPath,
} from "../../src/state/operation-receipt-key";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function publicId(prefix: string, value: number): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let remaining = value;
  let locator = "";
  for (let index = 0; index < 26; index += 1) {
    locator = (alphabet[remaining % 32] ?? "0") + locator;
    remaining = Math.floor(remaining / 32);
  }
  return `${prefix}_${locator}`;
}

const root = requiredEnvironment("HRA_GATEWAY_TEST_STARTUP_SEED_HOME");
const workspaceId = requiredEnvironment(
  "HRA_GATEWAY_TEST_STARTUP_SEED_WORKSPACE_ID",
);
const repositoryId = requiredEnvironment(
  "HRA_GATEWAY_TEST_STARTUP_SEED_REPOSITORY_ID",
);
const repositoryPath = join(root, "private-startup-repository");
const databasePath = controlPlanePath(root);
const database = openControlPlane(databasePath, {
  releaseIdentity: hraReleaseIdentity,
});
try {
  const { installationId } =
    new DispatchRunnerInstallationStore(database).startBoot();
  const store = new LocalTaskStore(
    database,
    loadOrCreateOperationReceiptKey(operationReceiptKeyPath(databasePath)),
  );
  store.registerInstallation(installationId, 1);
  store.onboardProject({
    installationId,
    repository: {
      repositoryId,
      name: "Startup recovery fixture",
      canonicalRepositoryPath: repositoryPath,
      canonicalGitCommonDir: join(repositoryPath, ".git"),
    },
    workspace: {
      workspaceId,
      name: "Startup recovery",
      slug: "startup-recovery",
      keyPrefix: "RCV",
    },
  }, 1);
  for (let index = 0; index < 32; index += 1) {
    const receipt = store.execute({
      kind: "task.create_and_run",
      operationId: publicId("op", 3_200 + index),
      authority: {
        kind: "local_owner",
        workspaceId,
        installationId,
      },
      expectedWorkspaceRevision: index + 1,
      taskId: publicId("tsk", 3_200 + index),
      title: `Recover queued run ${String(index + 1)}`,
      description: "",
      type: "task",
      priority: 2,
      availableAt: 0,
      labels: [],
      repositoryId,
    }, undefined, index + 2);
    if (receipt.outcome !== "committed") {
      throw new Error("Startup recovery seed command did not commit.");
    }
  }
} finally {
  database.close();
}
