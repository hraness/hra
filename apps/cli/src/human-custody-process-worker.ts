import { stat, writeFile } from "node:fs/promises";

import { webCryptoRandomBytes } from "./config";
import {
  compareAndSwapHumanAuthentication,
  preserveHumanAuthenticationIfCredentialMatches,
  type HumanAuthentication,
  type HumanAuthenticationObservation,
  type HumanSecretStore,
  type HumanStoragePaths,
} from "./human-config";

interface WorkerInput {
  readonly action: "compare_and_swap" | "preserve";
  readonly paths: HumanStoragePaths;
  readonly expected: HumanAuthenticationObservation;
  readonly next?: HumanAuthentication;
  readonly readyFile: string;
  readonly gateFile: string;
}

const unavailableKeychain: HumanSecretStore = {
  get: () => Promise.reject(new Error("test worker Keychain must not be used")),
  set: () => Promise.reject(new Error("test worker Keychain must not be used")),
  delete: () => Promise.reject(new Error("test worker Keychain must not be used")),
};

function parseInput(value: unknown): WorkerInput {
  if (
    typeof value !== "object" ||
    value === null ||
    !("action" in value) ||
    (value.action !== "compare_and_swap" && value.action !== "preserve") ||
    !("paths" in value) ||
    typeof value.paths !== "object" ||
    value.paths === null ||
    !("expected" in value) ||
    typeof value.expected !== "object" ||
    value.expected === null ||
    !("readyFile" in value) ||
    typeof value.readyFile !== "string" ||
    !("gateFile" in value) ||
    typeof value.gateFile !== "string"
  ) {
    throw new Error("invalid human custody worker input");
  }
  return value as unknown as WorkerInput;
}

async function waitForGate(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await stat(path);
      return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
    await Bun.sleep(2);
  }
  throw new Error("human custody worker gate timed out");
}

const input = parseInput(JSON.parse(await Bun.stdin.text()) as unknown);
await writeFile(input.readyFile, "ready\n", { flag: "wx", mode: 0o600 });
await waitForGate(input.gateFile);

const replaced = input.action === "compare_and_swap"
  ? input.next === undefined
    ? false
    : (await compareAndSwapHumanAuthentication(
        input.paths,
        input.expected,
        input.next,
        webCryptoRandomBytes,
        unavailableKeychain,
      )) !== null
  : await preserveHumanAuthenticationIfCredentialMatches(
      input.paths,
      {
        expectedGeneration: input.expected.generation,
        candidates: [input.expected.authentication],
      },
      webCryptoRandomBytes,
      unavailableKeychain,
    );

process.stdout.write(`${JSON.stringify({ replaced })}\n`);
