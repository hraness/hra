import {
  accessSync,
  constants,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "@hra-internal/schema";

import type { PinnedCodexMcpServerStatusList } from "./pinned-codecs";
import type { CodexStreamPosition } from "./rpc-core";

const openAiTeamIdentifier = "2DC432GLL2";
const maximumInstructionsUtf8Bytes = 256 * 1_024;
const maximumSignatureOutputBytes = 64 * 1_024;
const computerUseAdmissionReceiptBrand: unique symbol = Symbol(
  "hra.computer-use-admission-receipt",
);

const skyPackageSchema = z.object({
  name: z.literal("@oai/sky"),
  exports: z.object({
    ".": z.string().min(1),
    "./service": z.string().min(1),
  }).passthrough(),
}).passthrough();

export class ComputerUseProvisioningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComputerUseProvisioningError";
  }
}

export interface ComputerUseProvisioning {
  readonly serverName: "node_repl";
  readonly requiredToolName: "js";
  readonly threadConfig: Readonly<Record<string, unknown>>;
  readonly developerInstructions: string;
}

export type ComputerUseAdmissionReceipt = Readonly<{
  readonly generation: number;
  readonly threadId: string;
  readonly streamPosition: CodexStreamPosition;
  readonly [computerUseAdmissionReceiptBrand]: true;
}>;

export interface ComputerUseProvisioningOptions {
  readonly homeDirectory: string;
  readonly chatGptApplicationPath?: string;
  readonly codesignPath?: string;
}

/**
 * Resolves, authenticates, and references the user's separately installed
 * official ChatGPT Computer Use runtime. HRA never redistributes these assets.
 */
export function provisionOfficialComputerUse(
  options: ComputerUseProvisioningOptions,
): ComputerUseProvisioning {
  const chatGptApplicationPath = canonicalExpectedPath(
    options.chatGptApplicationPath ?? "/Applications/ChatGPT.app",
  );
  const globalCodexHome = canonicalExpectedPath(join(options.homeDirectory, ".codex"));
  const computerUseApplicationPath = canonicalExpectedPath(
    join(globalCodexHome, "computer-use", "Codex Computer Use.app"),
  );
  const computerUseClientPath = canonicalExpectedPath(join(
    computerUseApplicationPath,
    "Contents",
    "SharedSupport",
    "SkyComputerUseClient.app",
  ));
  const nodeRuntimeRoot = canonicalExpectedPath(join(
    chatGptApplicationPath,
    "Contents",
    "Resources",
    "cua_node",
  ));
  const nodeReplPath = canonicalExpectedPath(join(nodeRuntimeRoot, "bin", "node_repl"));
  const nodePath = canonicalExpectedPath(join(nodeRuntimeRoot, "bin", "node"));
  const nodeModulesPath = canonicalExpectedPath(join(nodeRuntimeRoot, "lib", "node_modules"));
  const skyPackageRoot = canonicalExpectedPath(join(nodeModulesPath, "@oai", "sky"));
  const skyPackagePath = canonicalExpectedPath(join(skyPackageRoot, "package.json"));
  const computerUseInstructionsPath = canonicalExpectedPath(join(
    chatGptApplicationPath,
    "Contents",
    "Resources",
    "plugins",
    "openai-bundled",
    "plugins",
    "computer-use",
    ".codex-plugin",
    "computer-use-node-repl.md",
  ));
  const bundledCodexPath = canonicalExpectedPath(join(
    chatGptApplicationPath,
    "Contents",
    "Resources",
    "codex",
  ));

  requireWithin(chatGptApplicationPath, nodeRuntimeRoot);
  requireWithin(chatGptApplicationPath, computerUseInstructionsPath);
  requireWithin(globalCodexHome, computerUseApplicationPath);
  requireExecutable(nodeReplPath);
  requireExecutable(nodePath);
  requireExecutable(bundledCodexPath);
  requireExecutable(join(
    computerUseClientPath,
    "Contents",
    "MacOS",
    "SkyComputerUseClient",
  ));

  const codesignPath = options.codesignPath ?? "/usr/bin/codesign";
  verifyOfficialSignature(codesignPath, chatGptApplicationPath, "com.openai.codex", true);
  verifyOfficialSignature(
    codesignPath,
    computerUseApplicationPath,
    "com.openai.sky.CUAService",
    true,
  );
  verifyOfficialSignature(
    codesignPath,
    computerUseClientPath,
    "com.openai.sky.CUAService.cli",
    true,
  );
  verifyOfficialSignature(codesignPath, nodeReplPath, null, false);
  verifyOfficialSignature(codesignPath, nodePath, null, false);
  verifyOfficialSignature(codesignPath, bundledCodexPath, null, false);

  const packageValue = parseJsonFile(skyPackagePath, "@oai/sky package metadata");
  const skyPackage = skyPackageSchema.parse(packageValue);
  requireWithin(skyPackageRoot, join(skyPackageRoot, skyPackage.exports["."]));
  requireWithin(skyPackageRoot, join(skyPackageRoot, skyPackage.exports["./service"]));

  const developerInstructions = readBoundedUtf8File(
    computerUseInstructionsPath,
    "Computer Use developer instructions",
  );
  if (
    !developerInstructions.includes("node_repl + @oai/sky")
    || !developerInstructions.includes('await import("@oai/sky")')
  ) {
    throw new ComputerUseProvisioningError(
      "The installed ChatGPT Computer Use instructions are incompatible with HRA.",
    );
  }

  const trustedServices = JSON.stringify({ sky: "@oai/sky/service" });
  return Object.freeze({
    serverName: "node_repl",
    requiredToolName: "js",
    threadConfig: Object.freeze({
      "mcp_servers.node_repl": Object.freeze({
        command: nodeReplPath,
        args: Object.freeze([]),
        startup_timeout_sec: 120,
        env: Object.freeze({
          NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS: "1000",
          NODE_REPL_NODE_MODULE_DIRS: nodeModulesPath,
          NODE_REPL_NODE_PATH: nodePath,
          NODE_REPL_TRUSTED_CODE_PATHS: `${globalCodexHome}:${nodeModulesPath}`,
          CODEX_HOME: globalCodexHome,
          NODE_REPL_INSTRUCTIONS_USE_CASE_COMPUTER_USE:
            "Control desktop apps on macOS through Computer Use.",
          NODE_REPL_TRUSTED_SERVICES: trustedServices,
          SKY_CUA_SERVICE_PATH: computerUseApplicationPath,
          CODEX_CLI_PATH: bundledCodexPath,
        }),
      }),
    }),
    developerInstructions,
  });
}

export function withComputerUseThreadConfig(
  provisioning: ComputerUseProvisioning,
  existing: Readonly<Record<string, unknown>> | null | undefined,
): Record<string, unknown> {
  const result = { ...(existing ?? {}) };
  for (const [key, value] of Object.entries(provisioning.threadConfig)) {
    if (Object.hasOwn(result, key)) {
      throw new ComputerUseProvisioningError(
        `Thread configuration attempts to replace HRA's required ${key} server.`,
      );
    }
    result[key] = value;
  }
  return result;
}

export function withComputerUseDeveloperInstructions(
  provisioning: ComputerUseProvisioning,
  existing: string | null | undefined,
): string {
  return existing === undefined || existing === null || existing.length === 0
    ? provisioning.developerInstructions
    : `${existing}\n\n${provisioning.developerInstructions}`;
}

export function verifyComputerUseServerStatus(input: Readonly<{
  readonly provisioning: ComputerUseProvisioning;
  readonly generation: number;
  readonly threadId: string;
  readonly streamPosition: CodexStreamPosition;
  readonly output: PinnedCodexMcpServerStatusList;
}>): ComputerUseAdmissionReceipt {
  if (
    !Number.isSafeInteger(input.generation)
    || input.generation <= 0
    || !Number.isSafeInteger(input.streamPosition)
    || input.streamPosition <= 0
    || input.threadId.length === 0
  ) {
    throw new ComputerUseProvisioningError(
      "Computer Use admission evidence has an invalid runtime identity.",
    );
  }
  const server = input.output.data.find(
    ({ name }) => name === input.provisioning.serverName,
  );
  const tool = server?.tools[input.provisioning.requiredToolName];
  if (
    server === undefined
    || tool === undefined
    || tool.name !== input.provisioning.requiredToolName
  ) {
    throw new ComputerUseProvisioningError(
      "Computer Use did not become ready. Update ChatGPT, open it once, then restart HRA.",
    );
  }
  return Object.freeze({
    generation: input.generation,
    threadId: input.threadId,
    streamPosition: input.streamPosition,
    [computerUseAdmissionReceiptBrand]: true as const,
  });
}

export function requireComputerUseAdmissionReceipt(input: Readonly<{
  readonly receipt: ComputerUseAdmissionReceipt;
  readonly generation: number;
  readonly threadId: string;
}>): void {
  if (
    input.receipt[computerUseAdmissionReceiptBrand] !== true
    || input.receipt.generation !== input.generation
    || input.receipt.threadId !== input.threadId
    || !Number.isSafeInteger(input.receipt.streamPosition)
    || input.receipt.streamPosition <= 0
  ) {
    throw new ComputerUseProvisioningError(
      "The chat no longer has verified Computer Use capability in this runtime generation.",
    );
  }
}

function canonicalExpectedPath(path: string): string {
  const absolute = resolve(path);
  let canonical: string;
  try {
    canonical = realpathSync.native(absolute);
  } catch {
    throw new ComputerUseProvisioningError(
      "Computer Use is unavailable. Install or update the official ChatGPT app and open it once.",
    );
  }
  if (canonical.includes("\0")) {
    throw new ComputerUseProvisioningError("A Computer Use asset path is invalid.");
  }
  return canonical;
}

function requireWithin(root: string, candidate: string): void {
  const canonicalRoot = realpathSync.native(root);
  const canonicalCandidate = realpathSync.native(candidate);
  const child = relative(canonicalRoot, canonicalCandidate);
  if (child === "" || (!child.startsWith(`..${sep}`) && child !== "..")) return;
  throw new ComputerUseProvisioningError(
    "A Computer Use asset resolves outside its signed installation root.",
  );
}

function requireExecutable(path: string): void {
  try {
    if (!statSync(path).isFile()) throw new Error("not a file");
    accessSync(path, constants.R_OK | constants.X_OK);
  } catch {
    throw new ComputerUseProvisioningError(
      "The official ChatGPT Computer Use executable set is incomplete.",
    );
  }
}

function verifyOfficialSignature(
  codesignPath: string,
  path: string,
  expectedIdentifier: string | null,
  deep: boolean,
): void {
  const verification = spawnSync(
    codesignPath,
    ["--verify", ...(deep ? ["--deep"] : []), "--strict", path],
    { encoding: "utf8", maxBuffer: maximumSignatureOutputBytes },
  );
  if (verification.status !== 0 || verification.error !== undefined) {
    throw new ComputerUseProvisioningError(
      "The official ChatGPT Computer Use installation failed code-signature verification.",
    );
  }
  const details = spawnSync(
    codesignPath,
    ["--display", "--verbose=4", path],
    { encoding: "utf8", maxBuffer: maximumSignatureOutputBytes },
  );
  const output = `${details.stdout ?? ""}\n${details.stderr ?? ""}`;
  if (
    details.status !== 0
    || details.error !== undefined
    || !output.includes(`TeamIdentifier=${openAiTeamIdentifier}`)
    || (expectedIdentifier !== null && !output.includes(`Identifier=${expectedIdentifier}\n`))
  ) {
    throw new ComputerUseProvisioningError(
      "Computer Use is unavailable because an installed asset is not signed by OpenAI.",
    );
  }
}

function parseJsonFile(path: string, label: string): unknown {
  const value = readBoundedUtf8File(path, label);
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new ComputerUseProvisioningError(`${label} is not valid JSON.`);
  }
}

function readBoundedUtf8File(path: string, label: string): string {
  const bytes = readFileSync(path);
  if (bytes.byteLength === 0 || bytes.byteLength > maximumInstructionsUtf8Bytes) {
    throw new ComputerUseProvisioningError(`${label} exceeds HRA's safety bound.`);
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    return decoder.decode(bytes);
  } catch {
    throw new ComputerUseProvisioningError(`${label} is not valid UTF-8.`);
  }
}
