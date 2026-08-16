import {
  agentIdSchema,
  positiveGenerationSchema,
  taskKeySchema,
  taskViewSchema,
  workspaceIdSchema,
} from "@hraness/agent-tasks-protocol";
import { ConvexClient } from "convex/browser";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { api } from "../convex/_generated/api";

const REALTIME_MARKER_FILE = "taskctl-ready.json";
const REALTIME_SUBSCRIPTION_ACK_FILE = "subscription-ready";
const REALTIME_OBSERVED_ACK_FILE = "mutation-observed";
const REALTIME_PROOF_TIMEOUT_MS = 30_000;
const MAX_MARKER_BYTES = 8_192;

export interface RealtimeCliMarker {
  readonly schemaVersion: 1;
  readonly workspaceId: string;
  readonly taskKey: string;
  readonly expectedAgentId: string;
  readonly initialStatus: "open";
  readonly initialRevision: number;
}

export type RealtimeDetailObservation =
  | { readonly kind: "initial"; readonly revision: number }
  | {
      readonly kind: "claimed";
      readonly revision: number;
      readonly claimId: string;
      readonly eventId: string;
      readonly agentId: string;
    };

export interface SignedRealtimeCliProof {
  readonly workspaceId: string;
  readonly taskKey: string;
  readonly agentId: string;
  readonly initialRevision: number;
  readonly claimedRevision: number;
  readonly claimId: string;
  readonly eventId: string;
  readonly callbackCount: number;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  assert(
    typeof value === "object" && value !== null && !Array.isArray(value),
    `${label} was not an object.`,
  );
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && expected.every((key, index) => actual[index] === key);
}

export function parseRealtimeCliMarker(source: string): RealtimeCliMarker {
  assert(new TextEncoder().encode(source).length <= MAX_MARKER_BYTES, "Realtime marker exceeded 8 KiB.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    throw new Error("Realtime marker was not valid JSON.");
  }
  const marker = asRecord(parsed, "Realtime marker");
  assert(
    exactKeys(marker, [
      "expectedAgentId",
      "initialRevision",
      "initialStatus",
      "schemaVersion",
      "taskKey",
      "workspaceId",
    ]),
    "Realtime marker fields did not match schema version 1.",
  );
  const workspaceId = workspaceIdSchema.safeParse(marker["workspaceId"]);
  const taskKey = taskKeySchema.safeParse(marker["taskKey"]);
  const expectedAgentId = agentIdSchema.safeParse(marker["expectedAgentId"]);
  const initialRevision = positiveGenerationSchema.safeParse(marker["initialRevision"]);
  assert(
    marker["schemaVersion"] === 1 &&
      marker["initialStatus"] === "open" &&
      workspaceId.success &&
      taskKey.success &&
      expectedAgentId.success &&
      initialRevision.success,
    "Realtime marker contained an invalid selector, identity, status, or revision.",
  );
  return {
    schemaVersion: 1,
    workspaceId: workspaceId.data,
    taskKey: taskKey.data,
    expectedAgentId: expectedAgentId.data,
    initialStatus: "open",
    initialRevision: initialRevision.data,
  };
}

/**
 * Validates the authoritative task projection and persisted event actor exposed
 * by the signed-human detail query. No display label is accepted as identity.
 */
export function inspectRealtimeDetailUpdate(
  value: unknown,
  marker: RealtimeCliMarker,
): RealtimeDetailObservation {
  const envelope = asRecord(value, "Realtime task detail");
  if (envelope["ok"] !== true) {
    const error = asRecord(envelope["error"], "Realtime task detail error");
    const code = typeof error["code"] === "string" ? error["code"] : "UNKNOWN";
    throw new Error(`Signed realtime task detail failed with ${code}.`);
  }
  const data = asRecord(envelope["data"], "Realtime task detail data");
  const parsedTask = taskViewSchema.safeParse(data["task"]);
  assert(parsedTask.success, "Realtime task detail returned an invalid task projection.");
  const task = parsedTask.data;
  assert(task.key === marker.taskKey, "Realtime task detail returned another task.");
  const truncatedCollections = data["truncatedCollections"];
  assert(
    Array.isArray(truncatedCollections) && !truncatedCollections.includes("events"),
    "Realtime task detail did not expose the complete event window.",
  );
  const events = data["events"];
  assert(Array.isArray(events), "Realtime task detail omitted events.");

  if (task.status === "open") {
    assert(
      task.revision === marker.initialRevision,
      "Realtime subscription did not start from the advertised open revision.",
    );
    assert(
      !events.some(
        (event) =>
          typeof event === "object" &&
          event !== null &&
          !Array.isArray(event) &&
          (event as Record<string, unknown>)["type"] === "task.claimed",
      ),
      "Realtime subscription started after the claim event already existed.",
    );
    return { kind: "initial", revision: task.revision };
  }

  assert(task.status === "in_progress", "Realtime task skipped the claimed state.");
  assert(
    task.revision > marker.initialRevision &&
      task.currentClaim.agentId === marker.expectedAgentId,
    "Realtime claim projection did not carry the enrolled agent identity.",
  );
  const claimedEvent = events.find((candidate) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return false;
    const event = candidate as Record<string, unknown>;
    if (event["type"] !== "task.claimed" || event["taskRevision"] !== task.revision) return false;
    const actor = event["actor"];
    return (
      typeof actor === "object" &&
      actor !== null &&
      !Array.isArray(actor) &&
      (actor as Record<string, unknown>)["kind"] === "agent" &&
      (actor as Record<string, unknown>)["id"] === marker.expectedAgentId
    );
  });
  assert(claimedEvent !== undefined, "Persisted claim event did not carry the enrolled agent actor.");
  const event = asRecord(claimedEvent, "Claim event");
  assert(typeof event["id"] === "string" && event["id"].length > 0, "Claim event omitted its ID.");
  return {
    kind: "claimed",
    revision: task.revision,
    claimId: task.currentClaim.id,
    eventId: event["id"],
    agentId: task.currentClaim.agentId,
  };
}

async function assertOwnedFile(path: string, label: string): Promise<void> {
  const metadata = await lstat(path);
  assert(metadata.isFile(), `${label} was not a real file.`);
  assert((metadata.mode & 0o777) === 0o600, `${label} was not mode 0600.`);
  if (typeof process.getuid === "function") {
    assert(metadata.uid === process.getuid(), `${label} was not owned by the current user.`);
  }
}

async function waitForMarker(root: string): Promise<RealtimeCliMarker> {
  const path = join(root, REALTIME_MARKER_FILE);
  const deadline = Date.now() + REALTIME_PROOF_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await assertOwnedFile(path, "Realtime marker");
      return parseRealtimeCliMarker(await readFile(path, "utf8"));
    } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await Bun.sleep(50);
  }
  throw new Error("taskctl did not publish its realtime proof marker before the timeout.");
}

async function writeAck(root: string, filename: string, contents: string): Promise<void> {
  const path = join(root, filename);
  await writeFile(path, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await assertOwnedFile(path, filename);
}

function exactLoopbackConvexOrigin(value: string): string {
  const url = new URL(value);
  assert(
    url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.username === "" &&
      url.password === "" &&
      (url.pathname === "" || url.pathname === "/") &&
      url.search === "" &&
      url.hash === "",
    "The realtime proof requires an exact loopback Convex deployment origin.",
  );
  return url.origin;
}

export async function proveSignedHumanReceivesTaskctlMutation(args: {
  readonly convexOrigin: string;
  readonly proofRoot: string;
  readonly issueOrganizationAccessToken: () => Promise<string>;
}): Promise<SignedRealtimeCliProof> {
  const marker = await waitForMarker(args.proofRoot);
  const accessToken = await args.issueOrganizationAccessToken();
  assert(accessToken.length > 0, "The signed realtime proof received no human access token.");
  const client = new ConvexClient(exactLoopbackConvexOrigin(args.convexOrigin));
  let resolveAuthenticated: (() => void) | undefined;
  const authenticated = new Promise<void>((resolve) => {
    resolveAuthenticated = resolve;
  });
  client.setAuth(
    () => Promise.resolve(accessToken),
    (isAuthenticated) => {
      if (isAuthenticated) resolveAuthenticated?.();
    },
  );
  try {
    await Promise.race([
      authenticated,
      Bun.sleep(REALTIME_PROOF_TIMEOUT_MS).then(() => {
        throw new Error("The signed human Convex client did not authenticate in time.");
      }),
    ]);
  } catch (error: unknown) {
    await client.close();
    throw error;
  }

  let callbackCount = 0;
  let stage: "initial" | "claimed" | "complete" = "initial";
  let settled = false;
  let resolveProof: ((proof: SignedRealtimeCliProof) => void) | undefined;
  let rejectProof: ((error: Error) => void) | undefined;
  const proof = new Promise<SignedRealtimeCliProof>((resolve, reject) => {
    resolveProof = resolve;
    rejectProof = reject;
  });
  const fail = (error: unknown) => {
    if (settled) return;
    settled = true;
    rejectProof?.(error instanceof Error ? error : new Error("Signed realtime proof failed."));
  };
  let callbackChain = Promise.resolve();
  const unsubscribe = client.onUpdate(
    api.humanTaskDetail.detail,
    { workspaceId: marker.workspaceId, key: marker.taskKey },
    (value) => {
      callbackCount += 1;
      callbackChain = callbackChain
        .then(async () => {
          if (settled) return;
          const observation = inspectRealtimeDetailUpdate(value, marker);
          if (stage === "initial") {
            assert(observation.kind === "initial", "Realtime proof did not observe the initial task state.");
            await writeAck(
              args.proofRoot,
              REALTIME_SUBSCRIPTION_ACK_FILE,
              "ready\n",
            );
            stage = "claimed";
            return;
          }
          if (stage === "claimed" && observation.kind === "claimed") {
            await writeAck(args.proofRoot, REALTIME_OBSERVED_ACK_FILE, "observed\n");
            stage = "complete";
            settled = true;
            resolveProof?.({
              workspaceId: marker.workspaceId,
              taskKey: marker.taskKey,
              agentId: observation.agentId,
              initialRevision: marker.initialRevision,
              claimedRevision: observation.revision,
              claimId: observation.claimId,
              eventId: observation.eventId,
              callbackCount,
            });
          }
        })
        .catch(fail);
    },
    () => fail(new Error("The signed realtime Convex subscription failed.")),
  );

  try {
    return await Promise.race([
      proof,
      Bun.sleep(REALTIME_PROOF_TIMEOUT_MS).then(() => {
        throw new Error("The signed realtime Convex subscription did not observe taskctl in time.");
      }),
    ]);
  } finally {
    unsubscribe();
    await client.close();
  }
}
