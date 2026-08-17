import { resolve, sep } from "node:path";

export type InstallationProcess = Readonly<{
  birth: string;
  command: string;
  parentPid: number;
  pid: number;
}>;

export type AppKitTerminationResult =
  | "identity_mismatch"
  | "missing"
  | "refused"
  | "requested";

export type InstallationProcessAuthorityDependencies = Readonly<{
  inventory: () => Promise<readonly InstallationProcess[]>;
  now: () => number;
  requestAppKitTermination: (
    process: InstallationProcess,
  ) => Promise<AppKitTerminationResult>;
  wait: (milliseconds: number) => Promise<void>;
}>;

export class InstallationProcessAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallationProcessAuthorityError";
  }
}

async function run(
  command: readonly string[],
): Promise<Readonly<{ code: number; stderr: string; stdout: string }>> {
  const child = Bun.spawn([...command], {
    env: {
      LANG: "C",
      LC_ALL: "C",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stderr, stdout };
}

export function parseProcessInventory(value: string): readonly InstallationProcess[] {
  const entries: InstallationProcess[] = [];
  for (const line of value.split("\n")) {
    const match = /^\s*([1-9][0-9]*)\s+([0-9]+)\s+(.{24})\s+(.+)$/u.exec(line);
    if (match === null) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    const birth = match[3]!.trim();
    const command = match[4]!.trim();
    if (
      !Number.isSafeInteger(pid)
      || !Number.isSafeInteger(parentPid)
      || birth.length === 0
      || command.length === 0
    ) {
      throw new InstallationProcessAuthorityError("Process inventory is malformed.");
    }
    entries.push({ birth, command, parentPid, pid });
  }
  return entries;
}

export async function macOSProcessInventory(): Promise<readonly InstallationProcess[]> {
  const result = await run([
    "/bin/ps",
    "-axo",
    "pid=,ppid=,lstart=,comm=",
  ]);
  if (result.code !== 0) {
    throw new InstallationProcessAuthorityError("Process inventory failed.");
  }
  return parseProcessInventory(result.stdout);
}

async function requestAppKitTermination(
  process: InstallationProcess,
): Promise<AppKitTerminationResult> {
  const launchEpochSeconds = Math.floor(Date.parse(process.birth) / 1_000);
  if (!Number.isSafeInteger(launchEpochSeconds)) {
    throw new InstallationProcessAuthorityError(
      "The application birth time cannot bind AppKit authority.",
    );
  }
  const source = [
    "ObjC.import('AppKit');",
    `const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${process.pid});`,
    "if (!app) { console.log('missing'); }",
    "else {",
    "const executable = ObjC.unwrap(app.executableURL.path);",
    "const launchEpochSeconds = Math.floor(Number(ObjC.unwrap(app.launchDate.timeIntervalSince1970)));",
    `if (executable !== ${JSON.stringify(process.command)} || launchEpochSeconds !== ${launchEpochSeconds}) { console.log('identity_mismatch'); }`,
    "else { const requested = ObjC.unwrap(app.terminate); console.log(requested ? 'requested' : 'refused'); }",
    "}",
  ].join(" ");
  const result = await run([
    "/usr/bin/osascript",
    "-l",
    "JavaScript",
    "-e",
    source,
  ]);
  const status = result.stdout.trim();
  return result.code === 0 && (
    status === "identity_mismatch"
    || status === "missing"
    || status === "refused"
    || status === "requested"
  )
    ? status
    : "refused";
}

const defaults: InstallationProcessAuthorityDependencies = {
  inventory: macOSProcessInventory,
  now: Date.now,
  requestAppKitTermination,
  wait: milliseconds => Bun.sleep(milliseconds),
};

function sameBirth(
  expected: InstallationProcess,
  actual: InstallationProcess,
): boolean {
  return expected.pid === actual.pid
    && expected.birth === actual.birth
    && expected.command === actual.command;
}

function descendants(
  root: InstallationProcess,
  inventory: readonly InstallationProcess[],
): ReadonlySet<number> {
  const result = new Set<number>([root.pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const process of inventory) {
      if (!result.has(process.pid) && result.has(process.parentPid)) {
        result.add(process.pid);
        changed = true;
      }
    }
  }
  return result;
}

/**
 * Requests AppKit termination only from each exact native application root.
 * The native root owns gateway and provider shutdown order; descendants never
 * receive an independent signal from the handoff operator.
 */
export async function quitInstalledApplicationRoots(
  bundles: readonly Readonly<{ executable: string; root: string }>[],
  dependencies: InstallationProcessAuthorityDependencies = defaults,
): Promise<void> {
  const normalized = bundles.map(bundle => ({
    executable: `${resolve(bundle.root)}${sep}Contents${sep}MacOS${sep}${bundle.executable}`,
    prefix: `${resolve(bundle.root)}${sep}`,
  }));
  const initial = await dependencies.inventory();
  const roots = initial.filter(process =>
    normalized.some(bundle => process.command === bundle.executable)
  );
  const owned = new Set<number>();
  for (const root of roots) {
    for (const pid of descendants(root, initial)) owned.add(pid);
  }
  const orphan = initial.find(process =>
    normalized.some(bundle => process.command.startsWith(bundle.prefix))
    && !owned.has(process.pid)
  );
  if (orphan !== undefined) {
    throw new InstallationProcessAuthorityError(
      "An orphaned installed-app helper is still running.",
    );
  }

  for (const root of roots) {
    const ownedBundle = normalized.find(bundle => bundle.executable === root.command);
    if (ownedBundle === undefined) {
      throw new InstallationProcessAuthorityError(
        "The native application root no longer matches its bundle authority.",
      );
    }
    const current = (await dependencies.inventory()).find(process =>
      process.pid === root.pid
    );
    if (current === undefined) continue;
    if (!sameBirth(root, current)) {
      throw new InstallationProcessAuthorityError(
        "An application PID was reused before termination.",
      );
    }
    const termination = await dependencies.requestAppKitTermination(root);
    if (termination === "identity_mismatch") {
      throw new InstallationProcessAuthorityError(
        "The AppKit application identity changed before termination.",
      );
    }
    if (termination === "refused") {
      throw new InstallationProcessAuthorityError(
        "The installed application refused graceful AppKit termination.",
      );
    }
    const deadline = dependencies.now() + 15_000;
    while (dependencies.now() < deadline) {
      const remaining = await dependencies.inventory();
      const liveRoot = remaining.find(process => process.pid === root.pid);
      if (liveRoot !== undefined && !sameBirth(root, liveRoot)) {
        throw new InstallationProcessAuthorityError(
          "An application PID was reused during shutdown.",
        );
      }
      const bundleProcesses = remaining.filter(process =>
        process.command.startsWith(ownedBundle.prefix)
      );
      if (liveRoot === undefined && bundleProcesses.length === 0) break;
      await dependencies.wait(50);
    }
    const remaining = await dependencies.inventory();
    if (
      remaining.some(process => process.pid === root.pid)
      || remaining.some(process => process.command.startsWith(ownedBundle.prefix))
    ) {
      throw new InstallationProcessAuthorityError(
        "The installed application did not complete ordered shutdown.",
      );
    }
  }
}
