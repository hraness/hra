import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  ComputerUseProvisioningError,
  provisionOfficialComputerUse,
  requireComputerUseAdmissionReceipt,
  verifyComputerUseServerStatus,
  withComputerUseDeveloperInstructions,
  withComputerUseThreadConfig,
  type ComputerUseProvisioning,
} from "../src/codex/computer-use-provisioning";
import { pinnedCodexRequests } from "../src/codex";

const provisioning: ComputerUseProvisioning = Object.freeze({
  serverName: "node_repl",
  requiredToolName: "js",
  threadConfig: Object.freeze({
    "mcp_servers.node_repl": Object.freeze({ command: "/signed/node_repl" }),
  }),
  developerInstructions: "Use node_repl + @oai/sky through the signed service.",
});

function officialInstallationFixture(): Readonly<{
  chatGptApplicationPath: string;
  codesignPath: string;
  homeDirectory: string;
  remove(): void;
}> {
  const root = mkdtempSync(join(tmpdir(), "hra-computer-use-installation-"));
  const homeDirectory = join(root, "home");
  const chatGptApplicationPath = join(root, "ChatGPT.app");
  const computerUseApplicationPath = join(
    homeDirectory,
    ".codex",
    "computer-use",
    "Codex Computer Use.app",
  );
  const computerUseClientPath = join(
    computerUseApplicationPath,
    "Contents",
    "SharedSupport",
    "SkyComputerUseClient.app",
  );
  const resources = join(chatGptApplicationPath, "Contents", "Resources");
  const nodeRoot = join(resources, "cua_node");
  const nodeModules = join(nodeRoot, "lib", "node_modules");
  const skyRoot = join(nodeModules, "@oai", "sky");
  const executablePaths = [
    join(nodeRoot, "bin", "node_repl"),
    join(nodeRoot, "bin", "node"),
    join(resources, "codex"),
    join(computerUseClientPath, "Contents", "MacOS", "SkyComputerUseClient"),
  ];
  for (const path of executablePaths) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    chmodSync(path, 0o700);
  }
  mkdirSync(join(skyRoot, "dist"), { recursive: true });
  writeFileSync(join(skyRoot, "dist", "index.js"), "export {};\n");
  writeFileSync(join(skyRoot, "dist", "service.js"), "export {};\n");
  writeFileSync(join(skyRoot, "package.json"), JSON.stringify({
    name: "@oai/sky",
    exports: { ".": "./dist/index.js", "./service": "./dist/service.js" },
  }));
  const instructionsPath = join(
    resources,
    "plugins",
    "openai-bundled",
    "plugins",
    "computer-use",
    ".codex-plugin",
    "computer-use-node-repl.md",
  );
  mkdirSync(dirname(instructionsPath), { recursive: true });
  writeFileSync(
    instructionsPath,
    "Use node_repl + @oai/sky. Load it with await import(\"@oai/sky\").\n",
  );
  const codesignPath = join(root, "codesign-fixture");
  writeFileSync(codesignPath, [
    "#!/bin/sh",
    "target=''",
    "for argument in \"$@\"; do target=\"$argument\"; done",
    "case \"$target\" in",
    "  *'/ChatGPT.app') identifier='com.openai.codex' ;;",
    "  *'/Codex Computer Use.app') identifier='com.openai.sky.CUAService' ;;",
    "  *'/SkyComputerUseClient.app') identifier='com.openai.sky.CUAService.cli' ;;",
    "  *) identifier='' ;;",
    "esac",
    "if [ \"$1\" = '--display' ]; then",
    "  [ -z \"$identifier\" ] || printf 'Identifier=%s\\n' \"$identifier\" >&2",
    "  printf 'TeamIdentifier=2DC432GLL2\\n' >&2",
    "fi",
    "exit 0",
    "",
  ].join("\n"), { mode: 0o700 });
  chmodSync(codesignPath, 0o700);
  return {
    chatGptApplicationPath,
    codesignPath,
    homeDirectory,
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}

function status(toolName = "js") {
  return pinnedCodexRequests.mcpServerStatusList.outputCodec.parse({
    data: [{
      name: "node_repl",
      serverInfo: null,
      tools: {
        [toolName]: {
          name: toolName,
          description: "Trusted JavaScript execution.",
          inputSchema: { type: "object" },
        },
      },
      resources: [],
      resourceTemplates: [],
      authStatus: "unsupported",
    }],
    nextCursor: null,
  });
}

test("Computer Use thread policy cannot be shadowed by caller configuration", () => {
  expect(withComputerUseThreadConfig(provisioning, { model_provider: "openai" }))
    .toEqual({
      model_provider: "openai",
      "mcp_servers.node_repl": { command: "/signed/node_repl" },
    });
  expect(() => withComputerUseThreadConfig(provisioning, {
    "mcp_servers.node_repl": { command: "/untrusted/replacement" },
  })).toThrow(ComputerUseProvisioningError);
  expect(withComputerUseDeveloperInstructions(provisioning, "Existing policy."))
    .toBe(`${"Existing policy."}\n\n${provisioning.developerInstructions}`);
});

test("Computer Use admission requires the thread-scoped node_repl js tool", () => {
  const receipt = verifyComputerUseServerStatus({
    provisioning,
    generation: 7,
    threadId: "provider-thread-7",
    streamPosition: 11,
    output: status(),
  });
  expect(() => requireComputerUseAdmissionReceipt({
    receipt,
    generation: 7,
    threadId: "provider-thread-7",
  })).not.toThrow();
  expect(() => requireComputerUseAdmissionReceipt({
    receipt,
    generation: 8,
    threadId: "provider-thread-7",
  })).toThrow(ComputerUseProvisioningError);
  expect(() => verifyComputerUseServerStatus({
    provisioning,
    generation: 7,
    threadId: "provider-thread-7",
    streamPosition: 12,
    output: status("not_js"),
  })).toThrow(ComputerUseProvisioningError);
});

test("official Computer Use provisioning derives only verified external assets", () => {
  const fixture = officialInstallationFixture();
  try {
    const result = provisionOfficialComputerUse(fixture);
    expect(result).toMatchObject({
      serverName: "node_repl",
      requiredToolName: "js",
      threadConfig: {
        "mcp_servers.node_repl": {
          args: [],
          startup_timeout_sec: 120,
        },
      },
    });
    expect(result.developerInstructions).toContain("node_repl + @oai/sky");
    expect(JSON.stringify(result.threadConfig)).toContain(fixture.homeDirectory);
  } finally {
    fixture.remove();
  }
});

test("official Computer Use provisioning rejects signature and containment drift", () => {
  const unsigned = officialInstallationFixture();
  try {
    writeFileSync(unsigned.codesignPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    expect(() => provisionOfficialComputerUse(unsigned)).toThrow(
      ComputerUseProvisioningError,
    );
  } finally {
    unsigned.remove();
  }

  const escaped = officialInstallationFixture();
  try {
    const nodeRoot = join(
      escaped.chatGptApplicationPath,
      "Contents",
      "Resources",
      "cua_node",
    );
    const outsideNodeRoot = join(escaped.homeDirectory, "outside-node-runtime");
    renameSync(nodeRoot, outsideNodeRoot);
    symlinkSync(outsideNodeRoot, nodeRoot, "dir");
    expect(() => provisionOfficialComputerUse(escaped)).toThrow(
      ComputerUseProvisioningError,
    );
  } finally {
    escaped.remove();
  }
});
