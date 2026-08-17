import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  createReadStream,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { parsePersistentActorInstructionPolicy } from
  "../src/harness/actor-instruction-policy-schema-v1.ts";
import { parseDevCandidateId } from "./status-protocol.ts";
import type {
  GatewayCandidateBuilder,
  StagedGatewayArtifact,
} from "./gateway-coordinator.ts";

export interface GatewayCandidateBuilderOptions {
  readonly bunExecutable?: string;
  readonly desktopRoot: string;
}

export function gatewayCandidatePath(
  stableGatewayPath: string,
  candidateId: ReturnType<typeof parseDevCandidateId>,
): string {
  return `${stableGatewayPath}.candidate-${candidateId}`;
}

function discardCandidate(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (
      typeof error !== "object"
      || error === null
      || !("code" in error)
      || error.code !== "ENOENT"
    ) throw error;
  }
}

async function sha256File(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    const bytes: unknown = chunk;
    if (!(bytes instanceof Uint8Array)) {
      throw new Error("HRA development gateway candidate yielded non-binary bytes.");
    }
    digest.update(bytes);
  }
  return digest.digest("hex");
}

export async function stageGatewayCandidateFile(
  candidatePath: string,
  stableGatewayPath: string,
): Promise<StagedGatewayArtifact> {
  if (dirname(candidatePath) !== dirname(stableGatewayPath)) {
    throw new Error("HRA development gateway candidates must share the stable gateway directory.");
  }
  const metadata = lstatSync(candidatePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("HRA development gateway candidate was not a regular file.");
  }
  const candidateId = parseDevCandidateId(await sha256File(candidatePath));
  const stagedPath = gatewayCandidatePath(stableGatewayPath, candidateId);
  discardCandidate(stagedPath);
  renameSync(candidatePath, stagedPath);
  let adopted = false;
  return {
    candidateId,
    adopt: () => {
      if (adopted) return;
      renameSync(stagedPath, stableGatewayPath);
      adopted = true;
    },
    discard: () => {
      if (!adopted) discardCandidate(stagedPath);
    },
  };
}

export function createGatewayCandidateBuilder(
  options: GatewayCandidateBuilderOptions,
): GatewayCandidateBuilder {
  const outputDirectory = join(options.desktopRoot, "runtime", "dist");
  const stableGatewayPath = join(outputDirectory, "oprte-gateway-dev");
  const gatewayEntryPath = join(options.desktopRoot, "runtime", "src", "main.ts");
  const bunExecutable = options.bunExecutable ?? process.execPath;

  return async (sourceRevision): Promise<StagedGatewayArtifact> => {
    const policyPath = join(
      options.desktopRoot,
      "runtime",
      "src",
      "harness",
      "actor-instruction-policy-v1.json",
    );
    parsePersistentActorInstructionPolicy(
      JSON.parse(readFileSync(policyPath, "utf8")) as unknown,
    );
    mkdirSync(outputDirectory, { recursive: true });
    const candidatePath = join(
      outputDirectory,
      `.oprte-gateway-dev.${process.pid}.${sourceRevision}.candidate`,
    );
    discardCandidate(candidatePath);

    const child = spawn(bunExecutable, [
      "build",
      "--compile",
      "--sourcemap=inline",
      gatewayEntryPath,
      "--outfile",
      candidatePath,
    ], {
      cwd: options.desktopRoot,
      stdio: ["ignore", "inherit", "inherit"],
    });
    const exitCode = await new Promise<number>((resolveExit, rejectExit) => {
      child.once("error", rejectExit);
      child.once("exit", (code) => resolveExit(code ?? -1));
    });
    if (exitCode !== 0) {
      discardCandidate(candidatePath);
      throw new Error("HRA development gateway candidate did not compile.");
    }

    try {
      return await stageGatewayCandidateFile(candidatePath, stableGatewayPath);
    } catch (error) {
      discardCandidate(candidatePath);
      throw error;
    }
  };
}
