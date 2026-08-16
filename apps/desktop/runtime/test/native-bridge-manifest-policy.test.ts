import { describe, expect, test } from "bun:test";

import {
  runtimeTransportHealthCommand,
  runtimeTransportRetryCommand,
} from "../../contracts/runtime";

const lifecycleCommands = [
  runtimeTransportRetryCommand,
  runtimeTransportHealthCommand,
] as const;

describe("Native transport lifecycle bridge policy", () => {
  test("app.zon admits both lifecycle commands only from the bundled app", async () => {
    const manifest = await Bun.file(
      new URL("../../app.zon", import.meta.url),
    ).text();
    const runtimeHost = await Bun.file(
      new URL("../../src/runtime_host.zig", import.meta.url),
    ).text();

    for (const command of lifecycleCommands) {
      const escapedCommand = command.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      const manifestDeclaration = new RegExp(
        `\\.\\{\\s*\\.name = "${escapedCommand}",\\s*\\.origins = \\.\\{"zero://app"\\},\\s*\\}`,
        "gu",
      );

      expect(manifest.match(manifestDeclaration)).toHaveLength(1);
      expect(runtimeHost).toContain(`"${command}"`);
    }
  });

  test("owns and fences the complete gateway/Codex process group before recovery", async () => {
    const runtimeHost = await Bun.file(
      new URL("../../src/runtime_host.zig", import.meta.url),
    ).text();

    expect(runtimeHost).toContain(".pgid = 0");
    expect(runtimeHost).toContain("std.posix.kill(-process_id, .KILL)");
    expect(runtimeHost).toContain("generation_process_tree_contained");
    expect(runtimeHost).not.toMatch(/\.kill\(self\.io\)/gu);
    expect(runtimeHost).toContain(
      "The prior Codex process tree could not be fenced. Restart HRA before sending another message.",
    );
    const termination = runtimeHost.slice(
      runtimeHost.indexOf("fn terminateGatewayProcessTree("),
      runtimeHost.indexOf("fn recordGenerationHealthEvidence("),
    );
    expect(termination.match(/std\.posix\.kill\(-process_id, \.KILL\)/gu))
      .toHaveLength(1);
    expect(termination).toContain("gatewayGroupMatchesUnreapedChild(");
    expect(termination.indexOf("std.posix.kill(-process_id, .KILL)"))
      .toBeLessThan(termination.indexOf("child.kill(io)"));
    expect(termination.slice(termination.indexOf("child.kill(io)")))
      .not.toContain(".KILL");
  });

  test("keeps packaged Git in the generation PGID and makes uncertainty fatal", async () => {
    const gitRunner = await Bun.file(
      new URL("../src/workspaces/git-runner.ts", import.meta.url),
    ).text();
    const gitExecutor = await Bun.file(
      new URL("../../src/git_executor.zig", import.meta.url),
    ).text();

    expect(gitRunner).toContain('containment: "gateway_generation"');
    expect(gitRunner).toContain(
      'detached: this.#processContainment === "command_process_group"',
    );
    expect(gitRunner).toContain("fatalGatewayGeneration();");
    expect(gitRunner).toContain("process.exit(86)");
    expect(gitRunner).toMatch(
      /unsafeTestOnlyAllowPathExecution[\s\S]+containment: "command_process_group"/u,
    );
    expect(gitRunner).not.toContain(
      'detached: process.platform !== "win32"',
    );
    expect(gitExecutor).toContain("std.process.replace");
    expect(gitExecutor).not.toMatch(/setpgid|setsid/u);
  });

  test("explicit update checks either start Sparkle or expose the fixed manual recovery route", async () => {
    const main = await Bun.file(
      new URL("../../src/main.zig", import.meta.url),
    ).text();
    const updater = await Bun.file(
      new URL("../../src/macos_updater.m", import.meta.url),
    ).text();

    expect(main).toMatch(
      /hra_macos_updater_check_for_updates\(\s*!self\.removal_recovery_required,\s*\)/u,
    );
    expect(updater).toMatch(
      /if \(updater_allowed &&\s+HRAUpdaterStartOnMainThread\(\) ==\s+HRAMacosUpdaterStarted\)/u,
    );
    expect(updater).toContain("HRAShowManualUpdateFallbackOnMainThread();");
    expect(updater).toContain(
      'NSURL URLWithString:@"https://hra.sh/download"',
    );

    const automaticStart = updater.slice(
      updater.indexOf("bool hra_macos_updater_start(void)"),
      updater.indexOf("bool hra_macos_updater_check_for_updates"),
    );
    expect(automaticStart).not.toContain("HRAShowManualUpdateFallbackOnMainThread");
  });

  test("publishes the updater only after Sparkle accepts production initialization", async () => {
    const updater = await Bun.file(
      new URL("../../src/macos_updater.m", import.meta.url),
    ).text();
    const start = updater.slice(
      updater.indexOf("static HRAMacosUpdaterStartResult HRAUpdaterStartOnMainThread"),
      updater.indexOf("static void HRAShowManualUpdateFallbackOnMainThread"),
    );

    expect(start).toContain("initWithStartingUpdater:NO");
    expect(start).not.toContain("initWithStartingUpdater:YES");
    expect(start).toContain("controller.updater");
    expect(start).toContain("[updater startUpdater:&startError]");
    expect(start.indexOf("[updater startUpdater:&startError]")).toBeLessThan(
      start.indexOf("hraUpdaterController = controller"),
    );
    for (const failure of [
      "HRAMacosUpdaterMissingReleaseMetadata",
      "HRAMacosUpdaterHazardPreparationFailed",
      "HRAMacosUpdaterFrameworkLoadFailed",
      "HRAMacosUpdaterControllerClassMissing",
      "HRAMacosUpdaterControllerInitializationFailed",
      "HRAMacosUpdaterObjectMissing",
      "HRAMacosUpdaterStartFailed",
    ]) {
      expect(start).toContain(failure);
    }
  });
});
