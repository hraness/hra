import { readFile, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import {
  assertAuthoritySupervisorArtifactPublicFile,
  authoritySupervisorArtifactManifest,
} from "./authority-supervisor-artifact";

export type AuthoritySupervisorBuildVerificationErrorCode =
  | "authority_supervisor_build_artifact_mismatch"
  | "authority_supervisor_build_compiler_failed"
  | "authority_supervisor_build_compiler_version_invalid"
  | "authority_supervisor_build_nondeterministic"
  | "authority_supervisor_build_usage_invalid";

export class AuthoritySupervisorBuildVerificationError extends Error {
  constructor(readonly code: AuthoritySupervisorBuildVerificationErrorCode) {
    super(`Authority supervisor build verification failed (${code}).`);
    this.name = "AuthoritySupervisorBuildVerificationError";
  }
}

const verificationError = (code: AuthoritySupervisorBuildVerificationErrorCode): never => {
  throw new AuthoritySupervisorBuildVerificationError(code);
};

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength && Buffer.compare(left, right) === 0;

const compilerOutput = async (
  arguments_: readonly string[],
  workingDirectory: string,
): Promise<string> => {
  try {
    const child = Bun.spawn([...arguments_], {
      cwd: workingDirectory,
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stdout] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) return verificationError("authority_supervisor_build_compiler_failed");
    return stdout;
  } catch {
    return verificationError("authority_supervisor_build_compiler_failed");
  }
};

export const authoritySupervisorBuildCommand = (
  zigExecutable: string,
  target: "x86_64-linux-musl" | "aarch64-linux-musl",
  sourcePath: string,
  outputPath: string,
): readonly string[] => [
  zigExecutable,
  "build-exe",
  "-O",
  "ReleaseSafe",
  "-fstrip",
  "-target",
  target,
  sourcePath,
  `-femit-bin=${outputPath}`,
];

export const parseAuthoritySupervisorBuildVerifierArguments = (
  arguments_: readonly string[],
): Readonly<{ zigExecutable: string }> => {
  if (
    arguments_.length !== 2
    || arguments_[0] !== "--zig"
    || arguments_[1] === undefined
    || !isAbsolute(arguments_[1])
  ) return verificationError("authority_supervisor_build_usage_invalid");
  return { zigExecutable: arguments_[1] };
};

export async function verifyAuthoritySupervisorBuild(
  zigExecutable: string,
  repositoryRoot = resolve(import.meta.dir, ".."),
): Promise<void> {
  if (!isAbsolute(zigExecutable)) {
    return verificationError("authority_supervisor_build_usage_invalid");
  }
  let compilerPath: string;
  try {
    compilerPath = await realpath(zigExecutable);
  } catch {
    return verificationError("authority_supervisor_build_usage_invalid");
  }
  const root = await realpath(repositoryRoot).catch(() =>
    verificationError("authority_supervisor_build_usage_invalid"));
  const version = await compilerOutput([compilerPath, "version"], root);
  if (version.trim() !== authoritySupervisorArtifactManifest.compiler.version) {
    return verificationError("authority_supervisor_build_compiler_version_invalid");
  }

  const artifacts = Object.values(authoritySupervisorArtifactManifest.artifacts);
  for (const artifact of artifacts) {
    await assertAuthoritySupervisorArtifactPublicFile(root, artifact.relativePath);
  }

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "hra-authority-supervisor-build-"));
  try {
    const sourcePath = join(root, authoritySupervisorArtifactManifest.source.relativePath);
    for (const artifact of artifacts) {
      const firstOutput = join(temporaryDirectory, `${artifact.target}.first`);
      const secondOutput = join(temporaryDirectory, `${artifact.target}.second`);
      const command = (outputPath: string): readonly string[] => authoritySupervisorBuildCommand(
        compilerPath,
        artifact.target,
        sourcePath,
        outputPath,
      );
      await compilerOutput(command(firstOutput), root);
      await compilerOutput(command(secondOutput), root);
      const [first, second, tracked] = await Promise.all([
        readFile(firstOutput),
        readFile(secondOutput),
        readFile(join(root, artifact.relativePath)),
      ]).catch(() => verificationError("authority_supervisor_build_compiler_failed"));
      if (!sameBytes(first, second)) {
        return verificationError("authority_supervisor_build_nondeterministic");
      }
      if (!sameBytes(first, tracked)) {
        return verificationError("authority_supervisor_build_artifact_mismatch");
      }
    }
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

if (import.meta.main) {
  let exitCode = 0;
  try {
    const arguments_ = parseAuthoritySupervisorBuildVerifierArguments(process.argv.slice(2));
    await verifyAuthoritySupervisorBuild(arguments_.zigExecutable);
  } catch (error: unknown) {
    exitCode = 1;
    process.stderr.write(`${error instanceof Error ? error.message : "Authority supervisor build verification failed."}\n`);
  }
  process.exitCode = exitCode;
}
