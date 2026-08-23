import { createHash } from "node:crypto";

import { z } from "zod";

import type {
  CodexAccountProjection,
  CodexRuntimePort,
  ProfileAuthority,
} from "../daemon/ports.ts";
import { profileIdSchema } from "../domain/values.ts";
import type { BoundedCommandRunner } from "./bundle.ts";
import { BunBoundedCommandRunner, CODEX_ELECTRON_USER_DATA_PATH, CODEX_HOME } from "./bundle.ts";
import { DesktopSwitchError } from "./errors.ts";
import type {
  LocalDesktopAccountRuntimePort,
} from "./local-switch.ts";
import type { DesktopBundlePort } from "./switch.ts";

const MAX_PROCARGS_BYTES = 2 * 1024 * 1024;
const CTL_KERN = 1;
const KERN_PROCARGS2 = 49;

const accountProjectionSchema = z
  .object({
    signedIn: z.boolean(),
    email: z.string().trim().email().max(320).optional(),
    plan: z.string().trim().min(1).max(160).optional(),
  })
  .strict();

const inspectedEnvironmentEntrySchema = z
  .object({
    name: z.enum([CODEX_HOME, CODEX_ELECTRON_USER_DATA_PATH]),
    value: z.string().min(1).max(4096),
  })
  .strict();

const inspectedDesktopInstanceSchema = z
  .object({
    pid: z.number().int().positive(),
    uid: z.number().int().nonnegative(),
    executablePath: z.string().min(1).max(4096),
    identityToken: z.string().regex(/^[a-f0-9]{64}$/u),
    environment: z.array(inspectedEnvironmentEntrySchema).max(4),
  })
  .strict();

export interface DesktopInstanceInspectorPort {
  supported(): boolean | Promise<boolean>;
  inspect(pid: number): Promise<unknown>;
}

export interface PidBoundDesktopAccountRuntimeInput {
  readonly codex: Pick<CodexRuntimePort, "readAccount">;
  readonly bundle: DesktopBundlePort;
  readonly inspector?: DesktopInstanceInspectorPort;
  readonly currentUid?: number;
}

/**
 * Account observation bound to the exact launched desktop process. The account
 * still comes from the pinned Codex runtime, but only between two same-UID PID
 * observations that prove the reviewed executable and both isolated-profile
 * environment variables. A target-home read without these fences is refused.
 */
export class PidBoundDesktopAccountRuntime implements LocalDesktopAccountRuntimePort {
  readonly #codex: Pick<CodexRuntimePort, "readAccount">;
  readonly #bundle: DesktopBundlePort;
  readonly #inspector: DesktopInstanceInspectorPort;
  readonly #currentUid: number | undefined;

  constructor(input: PidBoundDesktopAccountRuntimeInput) {
    this.#codex = input.codex;
    this.#bundle = input.bundle;
    this.#inspector = input.inspector ?? new MacOsDesktopInstanceInspector();
    this.#currentUid = input.currentUid ?? process.getuid?.();
  }

  async desktopInstanceObservationCapability(): Promise<unknown> {
    const supported =
      this.#currentUid !== undefined &&
      Number.isSafeInteger(this.#currentUid) &&
      this.#currentUid >= 0 &&
      (await this.#inspector.supported());
    return supported
      ? { status: "supported", mechanism: "pid-bound-desktop-account-v1" }
      : { status: "unsupported" };
  }

  async observeDesktopInstanceAccount(input: {
    readonly authority: ProfileAuthority;
    readonly instance: {
      readonly pid: number;
      readonly executablePath: string;
      readonly bundleCdHash: string;
      readonly codexHome: string;
      readonly desktopUserData: string;
    };
    readonly signal: AbortSignal;
  }): Promise<unknown> {
    if ((await this.desktopInstanceObservationCapability() as { status: string }).status !== "supported") {
      throw new DesktopSwitchError(
        "CAPABILITY_MISSING",
        "desktop-instance account observation is unavailable",
      );
    }
    const currentUid = this.#currentUid;
    if (currentUid === undefined) {
      throw new DesktopSwitchError(
        "CAPABILITY_MISSING",
        "same-user desktop process inspection is unavailable",
      );
    }
    if (input.signal.aborted) {
      throw input.signal.reason ?? new DOMException("The operation was aborted", "AbortError");
    }
    profileIdSchema.parse(input.authority.id);
    if (
      input.authority.codexHome !== input.instance.codexHome ||
      input.authority.desktopUserData !== input.instance.desktopUserData
    ) {
      throw recovery("desktop launch context does not match the target authority");
    }

    const reviewedBundle = await this.#bundle.inspect();
    if (
      reviewedBundle.executablePath !== input.instance.executablePath ||
      reviewedBundle.cdHash !== input.instance.bundleCdHash
    ) {
      throw recovery("desktop launch context does not match the reviewed bundle");
    }

    const before = inspectedDesktopInstanceSchema.parse(
      await this.inspectDesktopInstance(input.instance.pid),
    );
    assertInstance(before, input.instance, currentUid);

    const account = parseAccountProjection(
      await this.#codex.readAccount({
        authority: input.authority,
        signal: input.signal,
      }),
    );

    const after = inspectedDesktopInstanceSchema.parse(
      await this.inspectDesktopInstance(input.instance.pid),
    );
    assertInstance(after, input.instance, currentUid);
    if (
      before.identityToken !== after.identityToken ||
      JSON.stringify(before.environment) !== JSON.stringify(after.environment)
    ) {
      throw recovery("desktop process identity changed during account observation");
    }

    return {
      status: "observed",
      desktopPid: input.instance.pid,
      uid: after.uid,
      identityToken: after.identityToken,
      executablePath: input.instance.executablePath,
      bundleCdHash: input.instance.bundleCdHash,
      codexHome: input.instance.codexHome,
      desktopUserData: input.instance.desktopUserData,
      account,
    };
  }

  /**
   * Bounded same-user process evidence for switch recovery. This is read-only
   * and deliberately exposes only the reviewed executable identity and the two
   * isolated-profile environment bindings.
   */
  async inspectDesktopInstance(pid: number): Promise<unknown> {
    if ((await this.desktopInstanceObservationCapability() as { status: string }).status !== "supported") {
      throw new DesktopSwitchError(
        "CAPABILITY_MISSING",
        "desktop-instance inspection is unavailable",
      );
    }
    const currentUid = this.#currentUid;
    if (currentUid === undefined) {
      throw new DesktopSwitchError(
        "CAPABILITY_MISSING",
        "same-user desktop process inspection is unavailable",
      );
    }
    const observed = inspectedDesktopInstanceSchema.parse(await this.#inspector.inspect(pid));
    if (observed.uid !== currentUid) {
      throw recovery("desktop process belongs to a different user");
    }
    return observed;
  }
}

export interface DarwinProcArgsReaderPort {
  supported(): boolean;
  read(pid: number): Promise<Uint8Array>;
}

/** Production same-user inspector. It reads KERN_PROCARGS2 directly, without a shell. */
export class MacOsDesktopInstanceInspector implements DesktopInstanceInspectorPort {
  readonly #runner: BoundedCommandRunner;
  readonly #procArgs: DarwinProcArgsReaderPort;

  constructor(
    runner: BoundedCommandRunner = new BunBoundedCommandRunner(),
    procArgs: DarwinProcArgsReaderPort = new DarwinSysctlProcArgsReader(),
  ) {
    this.#runner = runner;
    this.#procArgs = procArgs;
  }

  supported(): boolean {
    return process.platform === "darwin" && process.getuid !== undefined && this.#procArgs.supported();
  }

  async inspect(pid: number): Promise<unknown> {
    if (!this.supported() || !Number.isSafeInteger(pid) || pid < 1) {
      throw new DesktopSwitchError(
        "CAPABILITY_MISSING",
        "desktop process inspection is unavailable",
      );
    }
    const processResult = await this.#runner.run(
      ["/bin/ps", "-p", String(pid), "-o", "pid=,uid=,lstart=,command="],
      10_000,
    );
    if (processResult.exitCode !== 0) {
      throw recovery("the launched desktop process is no longer observable");
    }
    const processRow = parseProcessRow(processResult.stdout, pid);
    const procArgs = parseDarwinProcArgs(await this.#procArgs.read(pid));
    if (procArgs.executablePath !== processRow.executablePath) {
      throw recovery("desktop process identity changed during inspection");
    }
    return {
      pid,
      uid: processRow.uid,
      executablePath: procArgs.executablePath,
      identityToken: createHash("sha256")
        .update(`${pid}\0${processRow.uid}\0${processRow.startTime}\0${procArgs.executablePath}`)
        .digest("hex"),
      environment: procArgs.environment,
    };
  }
}

/** KERN_PROCARGS2 reader using Bun FFI against libSystem. */
export class DarwinSysctlProcArgsReader implements DarwinProcArgsReaderPort {
  supported(): boolean {
    return process.platform === "darwin";
  }

  async read(pid: number): Promise<Uint8Array> {
    if (!this.supported() || !Number.isSafeInteger(pid) || pid < 1) {
      throw new DesktopSwitchError("CAPABILITY_MISSING", "KERN_PROCARGS2 is unavailable");
    }
    const { dlopen } = await import("bun:ffi");
    const library = dlopen("/usr/lib/libSystem.B.dylib", {
      sysctl: {
        args: ["ptr", "u32", "ptr", "ptr", "ptr", "usize"],
        returns: "i32",
      },
    });
    try {
      const mib = new Int32Array([CTL_KERN, KERN_PROCARGS2, pid]);
      const size = new BigUint64Array(1);
      if (library.symbols.sysctl(mib, mib.length, null, size, null, 0) !== 0) {
        throw recovery("could not size the desktop process environment");
      }
      const byteLength = Number(size[0]);
      if (!Number.isSafeInteger(byteLength) || byteLength < 5 || byteLength > MAX_PROCARGS_BYTES) {
        throw recovery("desktop process environment exceeded its bound");
      }
      const output = new Uint8Array(byteLength);
      if (library.symbols.sysctl(mib, mib.length, output, size, null, 0) !== 0) {
        throw recovery("could not read the desktop process environment");
      }
      const actualLength = Number(size[0]);
      if (!Number.isSafeInteger(actualLength) || actualLength < 5 || actualLength > byteLength) {
        throw recovery("desktop process environment changed while reading");
      }
      return output.slice(0, actualLength);
    } finally {
      library.close();
    }
  }
}

export function parseDarwinProcArgs(bytes: Uint8Array): {
  readonly executablePath: string;
  readonly environment: readonly {
    readonly name: typeof CODEX_HOME | typeof CODEX_ELECTRON_USER_DATA_PATH;
    readonly value: string;
  }[];
} {
  if (bytes.byteLength < 5 || bytes.byteLength > MAX_PROCARGS_BYTES) {
    throw recovery("desktop process arguments are malformed");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const argumentCount = view.getInt32(0, true);
  if (!Number.isSafeInteger(argumentCount) || argumentCount < 1 || argumentCount > 4_096) {
    throw recovery("desktop process argument count is malformed");
  }
  let offset = 4;
  const executable = readNullTerminated(bytes, offset);
  offset = executable.nextOffset;
  offset = skipNulls(bytes, offset);
  for (let index = 0; index < argumentCount; index += 1) {
    const argument = readNullTerminated(bytes, offset);
    offset = argument.nextOffset;
  }
  offset = skipNulls(bytes, offset);

  const environment: {
    name: typeof CODEX_HOME | typeof CODEX_ELECTRON_USER_DATA_PATH;
    value: string;
  }[] = [];
  while (offset < bytes.byteLength) {
    const entry = readNullTerminated(bytes, offset);
    offset = entry.nextOffset;
    if (entry.value === "") continue;
    const equals = entry.value.indexOf("=");
    if (equals < 1) throw recovery("desktop process environment is malformed");
    const name = entry.value.slice(0, equals);
    if (name === CODEX_HOME || name === CODEX_ELECTRON_USER_DATA_PATH) {
      environment.push({ name, value: entry.value.slice(equals + 1) });
      if (environment.length > 4) {
        throw recovery("desktop profile environment contains too many bindings");
      }
    }
  }
  return { executablePath: executable.value, environment };
}

function assertInstance(
  observed: z.infer<typeof inspectedDesktopInstanceSchema>,
  expected: {
    readonly pid: number;
    readonly executablePath: string;
    readonly codexHome: string;
    readonly desktopUserData: string;
  },
  currentUid: number,
): void {
  if (
    observed.pid !== expected.pid ||
    observed.uid !== currentUid ||
    observed.executablePath !== expected.executablePath
  ) {
    throw recovery("desktop process does not match the launched same-user instance");
  }
  const codexHomes = observed.environment.filter((entry) => entry.name === CODEX_HOME);
  const desktopRoots = observed.environment.filter(
    (entry) => entry.name === CODEX_ELECTRON_USER_DATA_PATH,
  );
  if (
    codexHomes.length !== 1 ||
    desktopRoots.length !== 1 ||
    codexHomes[0]?.value !== expected.codexHome ||
    desktopRoots[0]?.value !== expected.desktopUserData
  ) {
    throw recovery("desktop process profile environment does not match the reviewed launch");
  }
}

function parseProcessRow(source: string, expectedPid: number): {
  readonly uid: number;
  readonly startTime: string;
  readonly executablePath: string;
} {
  const lines = source.split("\n").filter((line) => line.trim() !== "");
  if (lines.length !== 1) throw recovery("desktop process observation is ambiguous");
  const [line] = lines;
  if (line === undefined) throw recovery("desktop process observation is unavailable");
  const match = /^\s*(\d+)\s+(\d+)\s+(.{24})\s+(.+)$/.exec(line);
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined || match[4] === undefined) {
    throw recovery("desktop process observation format changed");
  }
  const pid = Number(match[1]);
  const uid = Number(match[2]);
  if (pid !== expectedPid || !Number.isSafeInteger(uid) || uid < 0) {
    throw recovery("desktop process observation changed identity");
  }
  return { uid, startTime: match[3], executablePath: match[4] };
}

function readNullTerminated(
  bytes: Uint8Array,
  offset: number,
): { readonly value: string; readonly nextOffset: number } {
  const end = bytes.indexOf(0, offset);
  if (end < offset) throw recovery("desktop process arguments are truncated");
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(offset, end));
  } catch (error: unknown) {
    throw new DesktopSwitchError("RECOVERY_REQUIRED", "desktop process arguments are invalid", {
      cause: error,
    });
  }
  if (value.length > 65_536) throw recovery("desktop process argument exceeded its bound");
  return { value, nextOffset: end + 1 };
}

function skipNulls(bytes: Uint8Array, initialOffset: number): number {
  let offset = initialOffset;
  while (offset < bytes.byteLength && bytes[offset] === 0) offset += 1;
  return offset;
}

function parseAccountProjection(value: unknown): CodexAccountProjection {
  const parsed = accountProjectionSchema.parse(value);
  return {
    signedIn: parsed.signedIn,
    ...(parsed.email === undefined ? {} : { email: parsed.email }),
    ...(parsed.plan === undefined ? {} : { plan: parsed.plan }),
  };
}

function recovery(message: string): DesktopSwitchError {
  return new DesktopSwitchError("RECOVERY_REQUIRED", message);
}
