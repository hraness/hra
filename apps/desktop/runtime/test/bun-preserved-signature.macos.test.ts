import { describe, expect, test } from "bun:test";
import { lstat, realpath } from "node:fs/promises";

import { parseCodexSignatureNormalizationEntitlements } from "../codex-signature-normalization";
import {
  exactPreservedThirdPartySignatures,
  isExactPreservedThirdPartySignature,
  trustedThirdPartyTeams,
} from "../macos-package-config";
import runtimeVersions from "../runtime-versions.json";
import { sha256File } from "../verify-macos-package";

type CommandResult = Readonly<{
  exitCode: number;
  stderr: string;
  stdout: string;
}>;

async function run(argv: readonly string[]): Promise<CommandResult> {
  const child = Bun.spawn([...argv], {
    env: { LC_ALL: "C", PATH: "/usr/bin:/bin" },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stderr, stdout };
}

function value(details: string, pattern: RegExp): string | null {
  return pattern.exec(details)?.[1]?.trim() ?? null;
}

const describeMacOS = process.platform === "darwin" && process.arch === "arm64"
  ? describe
  : describe.skip;

describeMacOS("pinned Bun upstream signature on macOS", () => {
  test("is strict-valid only at the exact reviewed identity", async () => {
    const path = await realpath(process.execPath);
    const policyPath = "Contents/Resources/runtime/bin/bun";
    const policy = exactPreservedThirdPartySignatures.get(policyPath);
    expect(policy).toBeDefined();
    expect(trustedThirdPartyTeams.has("7FRXF46ZSN")).toBeFalse();
    expect(Bun.version).toBe(runtimeVersions.bun.version);
    expect(policy?.sha256).toBe(runtimeVersions.bun.binarySha256);

    const status = await lstat(path);
    const signatureResult = await run([
      "/usr/bin/codesign",
      "--display",
      "--verbose=4",
      path,
    ]);
    const entitlementResult = await run([
      "/usr/bin/codesign",
      "--display",
      "--entitlements",
      ":-",
      path,
    ]);
    const strictResult = await run([
      "/usr/bin/codesign",
      "--verify",
      "--strict",
      "--verbose=6",
      path,
    ]);
    const architecture = await run(["/usr/bin/lipo", "-archs", path]);
    expect(strictResult).toMatchObject({ exitCode: 0, stdout: "" });
    expect(architecture).toMatchObject({ exitCode: 0, stdout: "arm64\n" });
    expect(signatureResult.exitCode).toBe(0);
    expect(entitlementResult.exitCode).toBe(0);

    const signature = `${signatureResult.stdout}\n${signatureResult.stderr}`;
    const entitlementText = `${entitlementResult.stdout}\n${entitlementResult.stderr}`;
    expect(isExactPreservedThirdPartySignature({
      cdHash: value(signature, /^CDHash=([0-9a-fA-F]+)$/mu)?.toLowerCase() ?? null,
      entitlements: parseCodexSignatureNormalizationEntitlements(entitlementText),
      identifier: value(signature, /^Identifier=(.+)$/mu),
      path: policyPath,
      sha256: await sha256File(path),
      size: status.size,
      teamIdentifier: value(signature, /^TeamIdentifier=(.+)$/mu),
    })).toBeTrue();
  });
});
