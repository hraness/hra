import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { z } from "zod";

import {
  assertPublicSensitiveText,
  assertPublicText,
  assertPublicTree,
} from "./public-text-policy";

const packageSchema = z.object({
  bin: z.object({ hra: z.literal("./src/cli.ts") }).strict(),
  bugs: z.object({ url: z.literal("https://github.com/hraness/hra/issues") }).strict(),
  engines: z.object({ bun: z.literal("1.3.14") }).strict(),
  exports: z.object({ ".": z.literal("./src/index.ts") }).strict(),
  files: z.array(z.string()).min(1),
  homepage: z.literal("https://hra.sh"),
  name: z.literal("hra"),
  repository: z.object({
    type: z.literal("git"),
    url: z.literal("git+https://github.com/hraness/hra.git"),
  }).strict(),
  version: z.literal("0.1.0"),
}).passthrough();

type ProcessResult = Readonly<{
  exitCode: number;
  stderr: string;
  stdout: string;
}>;

const run = async (
  executable: string,
  arguments_: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<ProcessResult> =>
  await new Promise<ProcessResult>((resolvePromise, reject) => {
    const child = spawn(executable, arguments_, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolvePromise({
        exitCode: exitCode ?? 1,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
      });
    });
  });

const requireSuccess = (label: string, result: ProcessResult): ProcessResult => {
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed with exit ${String(result.exitCode)}:\n${result.stderr}${result.stdout}`);
  }
  return result;
};

const assertExactlyOneJsonValue = (value: string): unknown => {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error("Expected one JSON value on stdout.");
  try {
    return JSON.parse(trimmed) as unknown;
  } catch (error: unknown) {
    throw new Error("CLI stdout was not exactly one JSON value.", { cause: error });
  }
};

const assertProductionPackageOnly = async (root: string): Promise<void> => {
  const visit = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (
        entry.isFile()
        && (entry.name === "AGENTS.md" || entry.name.endsWith(".test.ts") || entry.name === "testAssertions.ts")
      ) {
        throw new Error("The install artifact contains development-only source.");
      }
    }
  };
  await visit(root);
};

const repositoryRoot = resolve(import.meta.dir, "..");
const packageJson = packageSchema.parse(
  JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")) as unknown,
);
if (!packageJson.files.includes("src")) throw new Error("The package must include src.");

await assertPublicTree(repositoryRoot);
const completeHistory = requireSuccess(
  "Git history sensitive-text check",
  await run("git", ["log", "--all", "--format=", "--patch", "--no-ext-diff", "--no-textconv"], { cwd: repositoryRoot }),
);
assertPublicSensitiveText(completeHistory.stdout, "Git history");
const authoredHistory = requireSuccess(
  "Git history public-text check",
  await run(
    "git",
    [
      "log",
      "--all",
      "--format=",
      "--patch",
      "--no-ext-diff",
      "--no-textconv",
      "--",
      ".",
      ":(exclude)bun.lock",
    ],
    { cwd: repositoryRoot },
  ),
);
assertPublicText(authoredHistory.stdout, "Git history");

const generated = requireSuccess(
  "generated public tree check",
  await run(process.execPath, ["run", "build:site", "--", "--check"], { cwd: repositoryRoot }),
);
if (generated.stdout.trim().length > 0) process.stdout.write(generated.stdout);

const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), "hra-package-")));
try {
  const packageDirectory = join(temporaryRoot, "package");
  const consumerDirectory = join(temporaryRoot, "consumer");
  const consumerHome = join(temporaryRoot, "home");
  const consumerTemporaryDirectory = join(temporaryRoot, "tmp");
  const globalInstallRoot = join(temporaryRoot, "bun-global");
  await mkdir(packageDirectory, { recursive: true, mode: 0o700 });
  await mkdir(consumerDirectory, { recursive: true, mode: 0o700 });
  await mkdir(consumerHome, { recursive: true, mode: 0o700 });
  await mkdir(consumerTemporaryDirectory, { recursive: true, mode: 0o700 });
  await mkdir(globalInstallRoot, { recursive: true, mode: 0o700 });

  requireSuccess(
    "package archive creation",
    await run(process.execPath, ["pm", "pack", "--destination", packageDirectory], { cwd: repositoryRoot }),
  );
  const archive = join(packageDirectory, `${packageJson.name}-${packageJson.version}.tgz`);
  const inspectionDirectory = join(temporaryRoot, "inspection");
  await mkdir(inspectionDirectory, { recursive: true, mode: 0o700 });
  requireSuccess(
    "package archive extraction",
    await run("tar", ["-xzf", archive, "-C", inspectionDirectory], { cwd: repositoryRoot }),
  );
  await assertPublicTree(inspectionDirectory);
  await assertProductionPackageOnly(inspectionDirectory);
  await writeFile(
    join(consumerDirectory, "package.json"),
    `${JSON.stringify({ name: "hra-package-smoke", private: true, type: "module" }, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  const isolatedEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    BUN_INSTALL: globalInstallRoot,
    HOME: consumerHome,
    TMPDIR: consumerTemporaryDirectory,
  };
  requireSuccess(
    "clean consumer install",
    await run(process.execPath, ["add", "--ignore-scripts", archive], {
      cwd: consumerDirectory,
      env: isolatedEnvironment,
    }),
  );
  requireSuccess(
    "side-effect-free package import",
    await run(process.execPath, ["-e", "await import('hra')"], {
      cwd: consumerDirectory,
      env: isolatedEnvironment,
    }),
  );

  const executable = join(consumerDirectory, "node_modules", ".bin", "hra");
  const help = requireSuccess(
    "installed CLI help",
    await run(executable, ["--help"], { cwd: consumerDirectory, env: isolatedEnvironment }),
  );
  if (!help.stdout.startsWith("HRA\n")) throw new Error("Installed CLI help has an unexpected header.");
  if (help.stderr !== "") throw new Error("Installed CLI help wrote diagnostics.");

  const version = requireSuccess(
    "installed CLI version",
    await run(executable, ["--version"], { cwd: consumerDirectory, env: isolatedEnvironment }),
  );
  if (version.stdout !== `hra ${packageJson.version}\n` || version.stderr !== "") {
    throw new Error("Installed CLI version does not match package.json.");
  }

  const doctor = await run(executable, ["doctor", "--offline", "--json"], {
    cwd: consumerDirectory,
    env: isolatedEnvironment,
  });
  const doctorValue = assertExactlyOneJsonValue(doctor.stdout);
  const doctorSchema = z.object({
    data: z.object({ offline: z.literal(true) }).passthrough(),
    ok: z.literal(true),
    version: z.literal(1),
  }).passthrough();
  doctorSchema.parse(doctorValue);
  if (doctor.stderr !== "") throw new Error("JSON doctor wrote diagnostics to stderr.");
  if (doctor.exitCode !== 0) throw new Error("Offline doctor failed in the clean consumer.");

  requireSuccess(
    "clean global consumer install",
    await run(process.execPath, ["add", "--global", "--ignore-scripts", archive], {
      cwd: consumerDirectory,
      env: isolatedEnvironment,
    }),
  );
  const globalExecutable = join(globalInstallRoot, "bin", "hra");
  const globalHelp = requireSuccess(
    "global CLI help",
    await run(globalExecutable, ["--help"], { cwd: consumerDirectory, env: isolatedEnvironment }),
  );
  if (!globalHelp.stdout.startsWith("HRA\n") || globalHelp.stderr !== "") {
    throw new Error("Globally installed CLI help is invalid.");
  }
  const globalDoctor = await run(globalExecutable, ["doctor", "--offline", "--json"], {
    cwd: consumerDirectory,
    env: isolatedEnvironment,
  });
  doctorSchema.parse(assertExactlyOneJsonValue(globalDoctor.stdout));
  if (globalDoctor.stderr !== "" || globalDoctor.exitCode !== 0) {
    throw new Error("Globally installed CLI offline doctor failed.");
  }

  process.stdout.write(`Verified ${basename(archive)} in isolated local and global consumers.\n`);
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}
